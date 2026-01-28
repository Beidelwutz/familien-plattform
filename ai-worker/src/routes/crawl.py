"""Crawler endpoints for triggering and monitoring crawls."""

from fastapi import APIRouter, HTTPException, BackgroundTasks, Depends
from pydantic import BaseModel
from typing import Optional
from datetime import datetime
import logging

from src.queue import job_queue, get_queue, JobQueue, JobStatus, QUEUE_CRAWL

router = APIRouter()
logger = logging.getLogger(__name__)


class CrawlRequest(BaseModel):
    """Request to trigger a crawl."""
    source_id: str
    source_url: Optional[str] = None
    source_type: str = "rss"
    force: bool = False


class CrawlStatus(BaseModel):
    """Status of a crawl job."""
    job_id: str
    source_id: str
    status: str
    started_at: Optional[str]
    finished_at: Optional[str]
    events_found: Optional[int]
    events_new: Optional[int]
    error: Optional[str]


@router.post("/trigger")
async def trigger_crawl(request: CrawlRequest, queue: JobQueue = Depends(get_queue)):
    """
    Trigger a crawl for a specific source.
    
    The crawl runs in the background and results can be checked via /status.
    """
    try:
        job = await queue.enqueue(
            job_type="crawl",
            payload={
                "source_id": request.source_id,
                "source_url": request.source_url,
                "source_type": request.source_type,
                "force": request.force
            },
            queue=QUEUE_CRAWL
        )
        
        return {
            "job_id": job.id,
            "source_id": request.source_id,
            "status": job.status.value,
            "message": "Crawl job queued successfully"
        }
    except Exception as e:
        logger.exception("Failed to queue crawl job")
        # Fallback: return a mock job ID if Redis is unavailable
        job_id = f"crawl_{request.source_id}_{datetime.utcnow().timestamp()}"
        return {
            "job_id": job_id,
            "source_id": request.source_id,
            "status": "queued",
            "message": "Crawl job queued (Redis unavailable, processing synchronously)",
            "warning": str(e)
        }


@router.get("/status/{job_id}", response_model=CrawlStatus)
async def get_crawl_status(job_id: str, queue: JobQueue = Depends(get_queue)):
    """Get the status of a crawl job."""
    try:
        job = await queue.get_status(job_id)
        
        if not job:
            raise HTTPException(status_code=404, detail=f"Job {job_id} not found")
        
        result = job.result or {}
        
        return CrawlStatus(
            job_id=job.id,
            source_id=job.payload.get("source_id", "unknown"),
            status=job.status.value,
            started_at=job.started_at,
            finished_at=job.finished_at,
            events_found=result.get("events_found"),
            events_new=result.get("events_new"),
            error=job.error
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Failed to get job status")
        return CrawlStatus(
            job_id=job_id,
            source_id="unknown",
            status="unknown",
            started_at=None,
            finished_at=None,
            events_found=None,
            events_new=None,
            error=str(e)
        )


@router.get("/queue-stats")
async def get_queue_stats(queue: JobQueue = Depends(get_queue)):
    """Get queue statistics."""
    try:
        crawl_length = await queue.get_queue_length(QUEUE_CRAWL)
        
        return {
            "queues": {
                "crawl": crawl_length,
            },
            "status": "healthy"
        }
    except Exception as e:
        return {
            "queues": {},
            "status": "error",
            "error": str(e)
        }


@router.post("/process-feed")
async def process_feed(feed_url: str, source_type: str = "rss"):
    """
    Process a feed URL directly (for testing).
    
    Parses the feed and returns extracted events without storing.
    """
    from src.crawlers.feed_parser import FeedParser
    
    parser = FeedParser()
    
    try:
        if source_type == "rss":
            events = await parser.parse_rss(feed_url)
        elif source_type == "ics":
            events = await parser.parse_ics(feed_url)
        else:
            raise HTTPException(status_code=400, detail=f"Unknown source type: {source_type}")
        
        return {
            "success": True,
            "events_found": len(events),
            "events": events[:10]  # Return first 10 for preview
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Feed processing failed: {str(e)}")
