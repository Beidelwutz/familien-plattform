"""Redis-based job queue for background processing.

Features:
- Priority queue using Redis sorted sets
- Retry with exponential backoff + jitter
- Dead Letter Queue (DLQ) for failed jobs
- Idempotency keys to prevent duplicate jobs
- Visibility timeout for crash recovery
- Concurrency limits per source/domain
- Cost guard integration (budget checks)
- Distributed locking for crawl jobs
"""

import os
import json
import asyncio
import random
import hashlib
from datetime import datetime, timedelta, date
from typing import Optional, Callable, Any
from enum import Enum
from dataclasses import dataclass
from urllib.parse import urlparse
import redis.asyncio as redis
from pydantic import BaseModel
import logging

from src.config import get_settings

logger = logging.getLogger(__name__)

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")

# Queue names
QUEUE_CRAWL = "queue:crawl"
QUEUE_CLASSIFY = "queue:classify"
QUEUE_SCORE = "queue:score"
QUEUE_GEOCODE = "queue:geocode"
QUEUE_DLQ = "queue:dlq"  # Dead Letter Queue

# Key prefixes
JOB_STATUS_PREFIX = "job:"
JOB_RESULT_PREFIX = "result:"
IDEMPOTENCY_PREFIX = "idem:"
PROCESSING_PREFIX = "processing:"
CONCURRENT_PREFIX = "concurrent:"  # For domain concurrency limiting
LOCK_PREFIX = "lock:crawl:"  # For distributed locking


@dataclass
class RetryPolicy:
    """Retry policy configuration."""
    max_attempts: int = 3
    base_delay_seconds: float = 60.0
    max_delay_seconds: float = 3600.0  # 1 hour
    exponential_base: float = 2.0
    jitter: bool = True  # Add randomness to prevent thundering herd
    
    def get_delay(self, attempt: int) -> float:
        """Calculate delay for a given attempt number."""
        delay = min(
            self.base_delay_seconds * (self.exponential_base ** (attempt - 1)),
            self.max_delay_seconds
        )
        if self.jitter:
            # Add 0-50% jitter
            delay *= (1 + random.random() * 0.5)
        return delay


# Default retry policies per job type
RETRY_POLICIES: dict[str, RetryPolicy] = {
    'crawl': RetryPolicy(max_attempts=3, base_delay_seconds=60),
    'classify': RetryPolicy(max_attempts=2, base_delay_seconds=30),  # AI is expensive
    'score': RetryPolicy(max_attempts=2, base_delay_seconds=30),
    'geocode': RetryPolicy(max_attempts=3, base_delay_seconds=10),
    'ingest': RetryPolicy(max_attempts=5, base_delay_seconds=5),
}


class JobStatus(str, Enum):
    """Job status states."""
    QUEUED = "queued"
    RUNNING = "running"
    SUCCESS = "success"
    FAILED = "failed"
    CANCELLED = "cancelled"
    DLQ = "dlq"  # Moved to dead letter queue


class Job(BaseModel):
    """A job in the queue."""
    id: str
    type: str
    payload: dict
    status: JobStatus = JobStatus.QUEUED
    created_at: str
    started_at: Optional[str] = None
    finished_at: Optional[str] = None
    result: Optional[dict] = None
    error: Optional[str] = None
    error_history: list[str] = []  # Track all errors
    attempts: int = 0
    max_attempts: int = 3
    idempotency_key: Optional[str] = None


class JobQueue:
    """Redis-based async job queue with DLQ, idempotency, retry policies, and reliability features."""
    
    def __init__(self, redis_url: str = REDIS_URL):
        self.redis_url = redis_url
        self._redis: Optional[redis.Redis] = None
        self._handlers: dict[str, Callable] = {}
        self._running = False
        self.visibility_timeout = 300  # 5 minutes
        self._settings = get_settings()
        self._cost_tracker = None  # Lazy loaded
        self._connected = False
    
    @property
    def is_connected(self) -> bool:
        """Check if Redis is connected."""
        return self._connected and self._redis is not None
    
    async def connect(self) -> bool:
        """Connect to Redis. Returns True if connected, False if unavailable."""
        if self._redis is None:
            try:
                self._redis = redis.from_url(
                    self.redis_url,
                    encoding="utf-8",
                    decode_responses=True
                )
                # Test connection
                await self._redis.ping()
                logger.info(f"Connected to Redis at {self.redis_url}")
                self._connected = True
                return True
            except Exception as e:
                logger.warning(f"Redis unavailable at {self.redis_url}: {e}")
                self._redis = None
                self._connected = False
                return False
        return self._connected
    
    # ==================== Concurrency Control ====================
    
    def _extract_domain(self, url: str) -> str:
        """Extract domain from URL for concurrency limiting."""
        try:
            parsed = urlparse(url)
            return parsed.netloc or "unknown"
        except Exception:
            return "unknown"
    
    async def acquire_domain_slot(self, domain: str) -> bool:
        """
        Acquire a concurrency slot for a domain.
        
        Returns True if slot acquired, False if domain is at max concurrent requests.
        """
        await self.connect()
        
        max_concurrent = self._settings.max_concurrent_per_domain
        key = f"{CONCURRENT_PREFIX}{domain}"
        
        # Increment counter
        current = await self._redis.incr(key)
        
        # Set TTL on first increment (auto-cleanup)
        if current == 1:
            await self._redis.expire(key, 300)  # 5 min TTL
        
        # Check if over limit
        if current > max_concurrent:
            await self._redis.decr(key)
            logger.warning(f"Domain {domain} at max concurrency ({max_concurrent})")
            return False
        
        logger.debug(f"Acquired slot for {domain} ({current}/{max_concurrent})")
        return True
    
    async def release_domain_slot(self, domain: str) -> None:
        """Release a concurrency slot for a domain."""
        await self.connect()
        
        key = f"{CONCURRENT_PREFIX}{domain}"
        await self._redis.decr(key)
        logger.debug(f"Released slot for {domain}")
    
    async def get_domain_concurrency(self, domain: str) -> int:
        """Get current concurrency count for a domain."""
        await self.connect()
        
        key = f"{CONCURRENT_PREFIX}{domain}"
        count = await self._redis.get(key)
        return int(count) if count else 0
    
    # ==================== Distributed Locking ====================
    
    async def acquire_crawl_lock(self, source_id: str) -> bool:
        """
        Acquire a distributed lock for crawling a source.
        
        Prevents multiple workers from crawling the same source simultaneously.
        Returns True if lock acquired, False if already locked.
        """
        await self.connect()
        
        lock_key = f"{LOCK_PREFIX}{source_id}"
        lock_ttl = self._settings.crawl_lock_ttl_seconds
        
        # Try to set lock (NX = only if not exists)
        acquired = await self._redis.set(
            lock_key,
            json.dumps({
                "locked_at": datetime.utcnow().isoformat(),
                "expires_at": (datetime.utcnow() + timedelta(seconds=lock_ttl)).isoformat()
            }),
            nx=True,
            ex=lock_ttl
        )
        
        if acquired:
            logger.info(f"Acquired crawl lock for source {source_id}")
        else:
            logger.info(f"Crawl lock for source {source_id} already held")
        
        return bool(acquired)
    
    async def release_crawl_lock(self, source_id: str) -> bool:
        """Release a crawl lock."""
        await self.connect()
        
        lock_key = f"{LOCK_PREFIX}{source_id}"
        deleted = await self._redis.delete(lock_key)
        
        if deleted:
            logger.info(f"Released crawl lock for source {source_id}")
        
        return bool(deleted)
    
    async def is_crawl_locked(self, source_id: str) -> bool:
        """Check if a source is currently locked for crawling."""
        await self.connect()
        
        lock_key = f"{LOCK_PREFIX}{source_id}"
        return bool(await self._redis.exists(lock_key))
    
    async def get_crawl_lock_info(self, source_id: str) -> Optional[dict]:
        """Get info about a crawl lock."""
        await self.connect()
        
        lock_key = f"{LOCK_PREFIX}{source_id}"
        data = await self._redis.get(lock_key)
        
        if data:
            return json.loads(data)
        return None
    
    # ==================== Cost Guard ====================
    
    def _get_cost_tracker(self):
        """Lazy load cost tracker to avoid circular imports."""
        if self._cost_tracker is None:
            from src.monitoring.ai_cost_tracker import AICostTracker
            self._cost_tracker = AICostTracker(
                daily_limit_usd=self._settings.ai_daily_limit_usd,
                monthly_limit_usd=self._settings.ai_monthly_limit_usd
            )
        return self._cost_tracker
    
    async def check_budget_for_ai_job(self) -> tuple[bool, bool, str]:
        """
        Check if budget allows AI job execution.
        
        Returns:
            Tuple of (can_proceed, use_low_cost_mode, message)
        """
        from src.monitoring.ai_cost_tracker import BudgetStatus
        
        cost_tracker = self._get_cost_tracker()
        budget = cost_tracker.check_budget()
        
        if budget.status == BudgetStatus.EXCEEDED:
            return False, False, f"Budget exceeded: {budget.message}"
        
        if budget.status == BudgetStatus.CRITICAL:
            return True, True, f"Budget critical, using low-cost mode: {budget.message}"
        
        if budget.status == BudgetStatus.WARNING:
            return True, False, f"Budget warning: {budget.message}"
        
        return True, False, "Budget OK"
    
    async def disconnect(self) -> None:
        """Disconnect from Redis."""
        if self._redis:
            await self._redis.close()
            self._redis = None
            logger.info("Disconnected from Redis")
    
    def _compute_idempotency_key(self, job_type: str, payload: dict) -> str:
        """
        Compute idempotency key for a job.
        
        This prevents duplicate jobs from being enqueued.
        Keys are based on job type and relevant payload fields.
        """
        if job_type == 'crawl':
            # For crawl jobs: source_id + date
            source_id = payload.get('source_id', '')
            return f"crawl:{source_id}:{date.today().isoformat()}"
        elif job_type == 'classify' or job_type == 'score':
            # For AI jobs: event_id
            event_id = payload.get('event_id') or payload.get('event', {}).get('id', '')
            return f"{job_type}:{event_id}"
        else:
            # Generic: hash of payload
            payload_str = json.dumps(payload, sort_keys=True, default=str)
            payload_hash = hashlib.sha256(payload_str.encode()).hexdigest()[:16]
            return f"{job_type}:{payload_hash}"
    
    async def enqueue(
        self,
        job_type: str,
        payload: dict,
        queue: str = QUEUE_CRAWL,
        priority: int = 0,
        delay_seconds: int = 0,
        idempotency_key: Optional[str] = None,
        skip_budget_check: bool = False,
    ) -> Optional[Job]:
        """
        Add a job to the queue.
        
        Args:
            job_type: Type of job (e.g., 'crawl', 'classify', 'score')
            payload: Job data
            queue: Queue name
            priority: Higher priority jobs are processed first
            delay_seconds: Delay before job becomes available
            idempotency_key: Custom idempotency key (auto-computed if None)
            skip_budget_check: Skip budget check for this job
        
        Returns:
            Created Job object, or None if budget exceeded for AI jobs
        
        Raises:
            ConnectionError: If Redis is unavailable
        """
        connected = await self.connect()
        if not connected:
            raise ConnectionError("Redis unavailable - cannot enqueue job")
        
        # Budget check for AI jobs
        if job_type in ['classify', 'score'] and not skip_budget_check:
            can_proceed, use_low_cost, msg = await self.check_budget_for_ai_job()
            
            if not can_proceed:
                logger.warning(f"Skipping {job_type} job due to budget: {msg}")
                return None
            
            if use_low_cost:
                payload['low_cost_mode'] = True
                logger.info(f"AI job {job_type} will use low-cost mode: {msg}")
        
        # Compute idempotency key
        idem_key = idempotency_key or self._compute_idempotency_key(job_type, payload)
        
        # Check if job with same idempotency key exists (within 24h)
        existing = await self._redis.get(f"{IDEMPOTENCY_PREFIX}{idem_key}")
        if existing:
            logger.info(f"Job with idempotency key {idem_key} already exists: {existing}")
            # Return the existing job
            existing_job = await self.get_status(existing)
            if existing_job:
                return existing_job
        
        job_id = f"{job_type}_{datetime.utcnow().strftime('%Y%m%d%H%M%S')}_{os.urandom(4).hex()}"
        
        # Get retry policy for this job type
        retry_policy = RETRY_POLICIES.get(job_type, RetryPolicy())
        
        job = Job(
            id=job_id,
            type=job_type,
            payload=payload,
            created_at=datetime.utcnow().isoformat(),
            max_attempts=retry_policy.max_attempts,
            idempotency_key=idem_key,
        )
        
        # Store job data
        job_key = f"{JOB_STATUS_PREFIX}{job_id}"
        await self._redis.set(job_key, job.model_dump_json(), ex=86400)  # 24h TTL
        
        # Store idempotency key -> job_id mapping
        await self._redis.set(f"{IDEMPOTENCY_PREFIX}{idem_key}", job_id, ex=86400)
        
        # Add to queue (using sorted set for priority)
        score = -priority + (datetime.utcnow().timestamp() + delay_seconds)
        await self._redis.zadd(queue, {job_id: score})
        
        logger.info(f"Enqueued job {job_id} to {queue} (idem_key: {idem_key})")
        return job
    
    async def enqueue_idempotent(
        self,
        job_type: str,
        payload: dict,
        queue: str = QUEUE_CRAWL,
        **kwargs
    ) -> Optional[Job]:
        """
        Enqueue a job only if no job with same idempotency key exists.
        
        Returns None if job already exists.
        """
        idem_key = self._compute_idempotency_key(job_type, payload)
        existing = await self._redis.get(f"{IDEMPOTENCY_PREFIX}{idem_key}")
        
        if existing:
            logger.debug(f"Skipping duplicate job: {idem_key}")
            return None
        
        return await self.enqueue(job_type, payload, queue, idempotency_key=idem_key, **kwargs)
    
    async def dequeue(self, queue: str = QUEUE_CRAWL, timeout: int = 5) -> Optional[Job]:
        """
        Get the next job from the queue.
        
        Args:
            queue: Queue name
            timeout: Block timeout in seconds
        
        Returns:
            Job object or None if no job available
        """
        await self.connect()
        
        # Get lowest score (highest priority, oldest)
        result = await self._redis.bzpopmin(queue, timeout=timeout)
        
        if not result:
            return None
        
        queue_name, job_id, score = result
        
        # Get job data
        job_key = f"{JOB_STATUS_PREFIX}{job_id}"
        job_data = await self._redis.get(job_key)
        
        if not job_data:
            logger.warning(f"Job {job_id} not found in storage")
            return None
        
        job = Job.model_validate_json(job_data)
        job.status = JobStatus.RUNNING
        job.started_at = datetime.utcnow().isoformat()
        job.attempts += 1
        
        # Update job status
        await self._redis.set(job_key, job.model_dump_json(), ex=86400)
        
        logger.info(f"Dequeued job {job_id} from {queue}")
        return job
    
    async def complete(self, job: Job, result: Optional[dict] = None) -> None:
        """Mark a job as completed successfully."""
        await self.connect()
        
        job.status = JobStatus.SUCCESS
        job.finished_at = datetime.utcnow().isoformat()
        job.result = result
        
        job_key = f"{JOB_STATUS_PREFIX}{job.id}"
        await self._redis.set(job_key, job.model_dump_json(), ex=86400)
        
        # Store result separately for quick access
        if result:
            result_key = f"{JOB_RESULT_PREFIX}{job.id}"
            await self._redis.set(result_key, json.dumps(result), ex=3600)  # 1h TTL
        
        logger.info(f"Job {job.id} completed successfully")
    
    async def fail(self, job: Job, error: str, retry: bool = True) -> None:
        """
        Mark a job as failed.
        
        If retry is enabled and attempts remain, re-queue with exponential backoff.
        Otherwise, move to Dead Letter Queue (DLQ).
        """
        await self.connect()
        
        job.error = error
        job.error_history.append(f"[{datetime.utcnow().isoformat()}] {error}")
        job.finished_at = datetime.utcnow().isoformat()
        
        # Get retry policy
        retry_policy = RETRY_POLICIES.get(job.type, RetryPolicy())
        
        if retry and job.attempts < job.max_attempts:
            # Re-queue with exponential backoff + jitter
            delay = retry_policy.get_delay(job.attempts)
            job.status = JobStatus.QUEUED
            
            job_key = f"{JOB_STATUS_PREFIX}{job.id}"
            await self._redis.set(job_key, job.model_dump_json(), ex=86400)
            
            # Re-add to queue
            queue = self._get_queue_for_type(job.type)
            score = datetime.utcnow().timestamp() + delay
            await self._redis.zadd(queue, {job.id: score})
            
            logger.warning(f"Job {job.id} failed, retry {job.attempts}/{job.max_attempts} in {delay:.0f}s: {error}")
        else:
            # Move to Dead Letter Queue
            await self._move_to_dlq(job, error)
    
    async def _move_to_dlq(self, job: Job, error: str) -> None:
        """Move a job to the Dead Letter Queue."""
        job.status = JobStatus.DLQ
        job.finished_at = datetime.utcnow().isoformat()
        
        # Update job status
        job_key = f"{JOB_STATUS_PREFIX}{job.id}"
        await self._redis.set(job_key, job.model_dump_json(), ex=604800)  # 7 days TTL for DLQ
        
        # Add to DLQ sorted set (by timestamp for ordering)
        await self._redis.zadd(QUEUE_DLQ, {job.id: datetime.utcnow().timestamp()})
        
        logger.error(f"Job {job.id} moved to DLQ after {job.attempts} attempts: {error}")
    
    async def get_dlq_jobs(self, limit: int = 100) -> list[Job]:
        """Get jobs from the Dead Letter Queue."""
        await self.connect()
        
        job_ids = await self._redis.zrange(QUEUE_DLQ, 0, limit - 1)
        jobs = []
        
        for job_id in job_ids:
            job = await self.get_status(job_id)
            if job:
                jobs.append(job)
        
        return jobs
    
    async def retry_dlq_job(self, job_id: str) -> Optional[Job]:
        """Retry a job from the DLQ."""
        await self.connect()
        
        job = await self.get_status(job_id)
        if not job or job.status != JobStatus.DLQ:
            return None
        
        # Reset job for retry
        job.status = JobStatus.QUEUED
        job.attempts = 0
        job.error = None
        job.finished_at = None
        job.started_at = None
        
        # Update job status
        job_key = f"{JOB_STATUS_PREFIX}{job.id}"
        await self._redis.set(job_key, job.model_dump_json(), ex=86400)
        
        # Remove from DLQ
        await self._redis.zrem(QUEUE_DLQ, job_id)
        
        # Add back to queue
        queue = self._get_queue_for_type(job.type)
        await self._redis.zadd(queue, {job.id: datetime.utcnow().timestamp()})
        
        logger.info(f"Job {job_id} retried from DLQ")
        return job
    
    async def clear_dlq(self) -> int:
        """Clear all jobs from the DLQ. Returns count of removed jobs."""
        await self.connect()
        count = await self._redis.zcard(QUEUE_DLQ)
        await self._redis.delete(QUEUE_DLQ)
        return count
    
    async def get_status(self, job_id: str) -> Optional[Job]:
        """Get the current status of a job."""
        await self.connect()
        
        job_key = f"{JOB_STATUS_PREFIX}{job_id}"
        job_data = await self._redis.get(job_key)
        
        if not job_data:
            return None
        
        return Job.model_validate_json(job_data)
    
    async def get_result(self, job_id: str) -> Optional[dict]:
        """Get the result of a completed job."""
        await self.connect()
        
        result_key = f"{JOB_RESULT_PREFIX}{job_id}"
        result_data = await self._redis.get(result_key)
        
        if not result_data:
            return None
        
        return json.loads(result_data)
    
    async def get_queue_length(self, queue: str = QUEUE_CRAWL) -> int:
        """Get the number of jobs in a queue."""
        connected = await self.connect()
        if not connected or self._redis is None:
            return 0
        return await self._redis.zcard(queue)
    
    async def get_dlq_count(self) -> int:
        """Get the number of jobs in the Dead Letter Queue."""
        connected = await self.connect()
        if not connected or self._redis is None:
            return 0
        return await self._redis.zcard(QUEUE_DLQ)
    
    async def get_queue_stats(self) -> dict:
        """Get statistics for all queues."""
        await self.connect()
        
        stats = {
            "queues": {
                "crawl": await self.get_queue_length(QUEUE_CRAWL),
                "classify": await self.get_queue_length(QUEUE_CLASSIFY),
                "score": await self.get_queue_length(QUEUE_SCORE),
                "geocode": await self.get_queue_length(QUEUE_GEOCODE),
            },
            "dlq_count": await self.get_dlq_count(),
            "total_pending": 0,
        }
        
        stats["total_pending"] = sum(stats["queues"].values())
        
        # Add budget info
        can_proceed, low_cost, msg = await self.check_budget_for_ai_job()
        stats["budget"] = {
            "can_proceed": can_proceed,
            "low_cost_mode": low_cost,
            "message": msg
        }
        
        return stats
    
    def register_handler(self, job_type: str, handler: Callable) -> None:
        """Register a handler function for a job type."""
        self._handlers[job_type] = handler
        logger.info(f"Registered handler for job type: {job_type}")
    
    async def process_queue(self, queue: str = QUEUE_CRAWL) -> None:
        """Process jobs from a queue continuously."""
        self._running = True
        logger.info(f"Starting queue processor for {queue}")
        
        while self._running:
            try:
                job = await self.dequeue(queue, timeout=5)
                
                if not job:
                    continue
                
                handler = self._handlers.get(job.type)
                if not handler:
                    await self.fail(job, f"No handler for job type: {job.type}", retry=False)
                    continue
                
                try:
                    result = await handler(job.payload)
                    await self.complete(job, result)
                except Exception as e:
                    logger.exception(f"Job {job.id} handler error")
                    await self.fail(job, str(e))
                    
            except asyncio.CancelledError:
                logger.info("Queue processor cancelled")
                break
            except Exception as e:
                logger.exception(f"Queue processor error: {e}")
                await asyncio.sleep(5)
        
        logger.info(f"Queue processor stopped for {queue}")
    
    def stop(self) -> None:
        """Stop the queue processor."""
        self._running = False
    
    def _get_queue_for_type(self, job_type: str) -> str:
        """Get the queue name for a job type."""
        type_to_queue = {
            'crawl': QUEUE_CRAWL,
            'classify': QUEUE_CLASSIFY,
            'score': QUEUE_SCORE,
            'geocode': QUEUE_GEOCODE,
        }
        return type_to_queue.get(job_type, QUEUE_CRAWL)


# Global queue instance
job_queue = JobQueue()


async def get_queue() -> JobQueue:
    """Get the job queue instance (for dependency injection).
    
    Note: This will NOT throw if Redis is unavailable - routes should
    check job_queue.is_connected() or handle None returns from enqueue().
    """
    await job_queue.connect()  # Returns False if unavailable, doesn't throw
    return job_queue
