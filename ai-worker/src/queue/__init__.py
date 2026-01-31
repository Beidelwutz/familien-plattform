"""Queue module for background job processing.

Features:
- Priority queue using Redis sorted sets
- Retry with exponential backoff + jitter
- Dead Letter Queue (DLQ) for failed jobs
- Idempotency keys to prevent duplicate jobs
"""

from .job_queue import (
    JobQueue, 
    Job, 
    JobStatus,
    RetryPolicy,
    job_queue, 
    get_queue,
    QUEUE_CRAWL, 
    QUEUE_CLASSIFY, 
    QUEUE_SCORE, 
    QUEUE_GEOCODE,
    QUEUE_DLQ,
    RETRY_POLICIES,
)

__all__ = [
    'JobQueue',
    'Job', 
    'JobStatus',
    'RetryPolicy',
    'job_queue',
    'get_queue',
    'QUEUE_CRAWL',
    'QUEUE_CLASSIFY', 
    'QUEUE_SCORE',
    'QUEUE_GEOCODE',
    'QUEUE_DLQ',
    'RETRY_POLICIES',
]
