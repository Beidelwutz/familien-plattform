"""Redis-based job queue for background processing."""

import os
import json
import asyncio
from datetime import datetime, timedelta
from typing import Optional, Callable, Any
from enum import Enum
import redis.asyncio as redis
from pydantic import BaseModel
import logging

logger = logging.getLogger(__name__)

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")

# Queue names
QUEUE_CRAWL = "queue:crawl"
QUEUE_CLASSIFY = "queue:classify"
QUEUE_SCORE = "queue:score"
QUEUE_GEOCODE = "queue:geocode"

# Job status tracking
JOB_STATUS_PREFIX = "job:"
JOB_RESULT_PREFIX = "result:"


class JobStatus(str, Enum):
    """Job status states."""
    QUEUED = "queued"
    RUNNING = "running"
    SUCCESS = "success"
    FAILED = "failed"
    CANCELLED = "cancelled"


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
    attempts: int = 0
    max_attempts: int = 3


class JobQueue:
    """Redis-based async job queue."""
    
    def __init__(self, redis_url: str = REDIS_URL):
        self.redis_url = redis_url
        self._redis: Optional[redis.Redis] = None
        self._handlers: dict[str, Callable] = {}
        self._running = False
    
    async def connect(self) -> None:
        """Connect to Redis."""
        if self._redis is None:
            self._redis = redis.from_url(
                self.redis_url,
                encoding="utf-8",
                decode_responses=True
            )
            # Test connection
            await self._redis.ping()
            logger.info(f"Connected to Redis at {self.redis_url}")
    
    async def disconnect(self) -> None:
        """Disconnect from Redis."""
        if self._redis:
            await self._redis.close()
            self._redis = None
            logger.info("Disconnected from Redis")
    
    async def enqueue(
        self,
        job_type: str,
        payload: dict,
        queue: str = QUEUE_CRAWL,
        priority: int = 0,
        delay_seconds: int = 0
    ) -> Job:
        """
        Add a job to the queue.
        
        Args:
            job_type: Type of job (e.g., 'crawl', 'classify', 'score')
            payload: Job data
            queue: Queue name
            priority: Higher priority jobs are processed first
            delay_seconds: Delay before job becomes available
        
        Returns:
            Created Job object
        """
        await self.connect()
        
        job_id = f"{job_type}_{datetime.utcnow().strftime('%Y%m%d%H%M%S')}_{os.urandom(4).hex()}"
        
        job = Job(
            id=job_id,
            type=job_type,
            payload=payload,
            created_at=datetime.utcnow().isoformat()
        )
        
        # Store job data
        job_key = f"{JOB_STATUS_PREFIX}{job_id}"
        await self._redis.set(job_key, job.model_dump_json(), ex=86400)  # 24h TTL
        
        # Add to queue (using sorted set for priority)
        score = -priority + (datetime.utcnow().timestamp() + delay_seconds)
        await self._redis.zadd(queue, {job_id: score})
        
        logger.info(f"Enqueued job {job_id} to {queue}")
        return job
    
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
        """Mark a job as failed."""
        await self.connect()
        
        job.error = error
        job.finished_at = datetime.utcnow().isoformat()
        
        if retry and job.attempts < job.max_attempts:
            # Re-queue with exponential backoff
            delay = 60 * (2 ** (job.attempts - 1))  # 60s, 120s, 240s
            job.status = JobStatus.QUEUED
            
            job_key = f"{JOB_STATUS_PREFIX}{job.id}"
            await self._redis.set(job_key, job.model_dump_json(), ex=86400)
            
            # Re-add to queue
            queue = self._get_queue_for_type(job.type)
            score = datetime.utcnow().timestamp() + delay
            await self._redis.zadd(queue, {job.id: score})
            
            logger.warning(f"Job {job.id} failed, retry {job.attempts}/{job.max_attempts} in {delay}s")
        else:
            job.status = JobStatus.FAILED
            
            job_key = f"{JOB_STATUS_PREFIX}{job.id}"
            await self._redis.set(job_key, job.model_dump_json(), ex=86400)
            
            logger.error(f"Job {job.id} failed permanently: {error}")
    
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
        await self.connect()
        return await self._redis.zcard(queue)
    
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
    """Get the job queue instance (for dependency injection)."""
    await job_queue.connect()
    return job_queue
