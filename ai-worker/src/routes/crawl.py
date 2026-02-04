"""Crawler endpoints for triggering and monitoring crawls."""

from fastapi import APIRouter, HTTPException, BackgroundTasks, Depends
from pydantic import BaseModel
from typing import Optional
from datetime import datetime
import asyncio
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
    enable_ai: bool = False  # Enable AI classification/scoring
    ingest_run_id: Optional[str] = None  # Backend IngestRun ID for status updates


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


async def run_crawl_sync(payload: dict):
    """Run crawl job synchronously (fallback when Redis unavailable)."""
    from src.queue.worker import process_crawl_job
    try:
        logger.info(f"Running crawl synchronously for source {payload.get('source_id')}")
        result = await process_crawl_job(payload)
        logger.info(f"Sync crawl completed: {result}")
    except Exception as e:
        logger.error(f"Sync crawl failed: {e}")


@router.post("/trigger")
async def trigger_crawl(
    request: CrawlRequest, 
    background_tasks: BackgroundTasks,
    queue: JobQueue = Depends(get_queue)
):
    """
    Trigger a crawl for a specific source.
    
    The crawl runs in the background and results can be checked via /status.
    Uses batch ingest to send events to backend.
    
    If Redis is unavailable, falls back to synchronous background processing.
    """
    payload = {
        "source_id": request.source_id,
        "source_url": request.source_url,
        "source_type": request.source_type,
        "force": request.force,
        "enable_ai": request.enable_ai,
        "ingest_run_id": request.ingest_run_id,
    }
    
    try:
        job = await queue.enqueue(
            job_type="crawl",
            payload=payload,
            queue=QUEUE_CRAWL
        )
        
        return {
            "job_id": job.id,
            "source_id": request.source_id,
            "status": job.status.value,
            "message": "Crawl job queued successfully"
        }
    except Exception as e:
        logger.warning(f"Redis unavailable, falling back to sync processing: {e}")
        
        # Fallback: process synchronously in background
        job_id = f"sync_{request.source_id}_{datetime.utcnow().strftime('%Y%m%d%H%M%S')}"
        
        # Run the crawl in background (non-blocking)
        background_tasks.add_task(run_crawl_sync, payload)
        
        return {
            "job_id": job_id,
            "source_id": request.source_id,
            "status": "running",
            "message": "Crawl started (sync mode - Redis unavailable)",
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
        # parse_rss/parse_ics return (events, etag, last_modified, was_modified) tuple
        if source_type == "rss":
            events, _, _, _ = await parser.parse_rss(feed_url)
        elif source_type == "ics":
            events, _, _, _ = await parser.parse_ics(feed_url)
        else:
            raise HTTPException(status_code=400, detail=f"Unknown source type: {source_type}")
        
        # Convert ParsedEvent dataclasses to dicts for JSON serialization
        events_preview = [
            {
                "external_id": e.external_id,
                "title": e.title,
                "description": e.description[:200] if e.description else None,
                "start_datetime": e.start_datetime.isoformat() if e.start_datetime else None,
                "end_datetime": e.end_datetime.isoformat() if e.end_datetime else None,
                "location_address": e.location_address,
                "source_url": e.source_url,
                "fingerprint": e.fingerprint,
            }
            for e in events[:10]
        ]
        
        return {
            "success": True,
            "events_found": len(events),
            "events": events_preview
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Feed processing failed: {str(e)}")
