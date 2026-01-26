"""Crawler endpoints for triggering and monitoring crawls."""

from fastapi import APIRouter, HTTPException, BackgroundTasks
from pydantic import BaseModel
from typing import Optional
from datetime import datetime

router = APIRouter()


class CrawlRequest(BaseModel):
    """Request to trigger a crawl."""
    source_id: str
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
async def trigger_crawl(request: CrawlRequest, background_tasks: BackgroundTasks):
    """
    Trigger a crawl for a specific source.
    
    The crawl runs in the background and results can be checked via /status.
    """
    # TODO: Queue job to Redis
    job_id = f"crawl_{request.source_id}_{datetime.utcnow().timestamp()}"
    
    # For now, return immediately with job ID
    return {
        "job_id": job_id,
        "source_id": request.source_id,
        "status": "queued",
        "message": "Crawl job queued"
    }


@router.get("/status/{job_id}", response_model=CrawlStatus)
async def get_crawl_status(job_id: str):
    """Get the status of a crawl job."""
    # TODO: Get from Redis
    return CrawlStatus(
        job_id=job_id,
        source_id="unknown",
        status="unknown",
        started_at=None,
        finished_at=None,
        events_found=None,
        events_new=None,
        error=None
    )


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
