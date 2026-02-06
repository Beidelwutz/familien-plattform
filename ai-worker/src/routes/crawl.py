"""Crawler endpoints for triggering and monitoring crawls."""

from fastapi import APIRouter, HTTPException, BackgroundTasks, Depends
from pydantic import BaseModel
from typing import Optional, Literal
from datetime import datetime
from urllib.parse import urljoin, urlparse
import asyncio
import logging
import re

import httpx
from bs4 import BeautifulSoup

from src.queue import job_queue, get_queue, JobQueue, JobStatus, QUEUE_CRAWL

router = APIRouter()
logger = logging.getLogger(__name__)


class CrawlRequest(BaseModel):
    """Request to trigger a crawl."""
    source_id: str
    source_url: Optional[str] = None
    source_type: str = "rss"  # rss | ics | scraper
    scraper_config: Optional[dict] = None  # For source_type=scraper (selectors, strategies, rate_limit_ms, etc.)
    force: bool = False
    dry_run: bool = False  # If True: crawl and extract but do not ingest; return candidates in response
    enable_ai: bool = False  # Enable AI classification/scoring
    fetch_event_pages: bool = False  # Selective Deep-Fetch for RSS events
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
    # #region agent log - Production debug logging
    logger.info(f"[SYNC] run_crawl_sync STARTED with payload: {payload}")
    # #endregion
    try:
        logger.info(f"Running crawl synchronously for source {payload.get('source_id')}")
        result = await process_crawl_job(payload)
        # #region agent log
        logger.info(f"[SYNC] run_crawl_sync COMPLETED: {result}")
        # #endregion
        logger.info(f"Sync crawl completed: {result}")
    except Exception as e:
        # #region agent log
        logger.error(f"[SYNC] run_crawl_sync FAILED: type={type(e).__name__}, message={str(e)}")
        # #endregion
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
    # #region agent log - Production debug logging
    logger.info(f"[TRIGGER] /crawl/trigger called: source_id={request.source_id}, source_type={request.source_type}, source_url={request.source_url}")
    # #endregion
    
    payload = {
        "source_id": request.source_id,
        "source_url": request.source_url,
        "source_type": request.source_type,
        "scraper_config": request.scraper_config,
        "force": request.force,
        "dry_run": request.dry_run,
        "enable_ai": request.enable_ai,
        "fetch_event_pages": request.fetch_event_pages,  # Selective Deep-Fetch
        "ingest_run_id": request.ingest_run_id,
    }
    
    # Dry-run: run pipeline synchronously and return candidates (no ingest, no queue)
    if request.dry_run:
        from src.queue.worker import process_crawl_job
        try:
            result = await process_crawl_job(payload)
            return result
        except Exception as e:
            logger.exception("Dry-run crawl failed")
            raise HTTPException(status_code=500, detail=f"Dry-run failed: {str(e)}")
    
    try:
        job = await queue.enqueue(
            job_type="crawl",
            payload=payload,
            queue=QUEUE_CRAWL
        )
        
        # #region agent log
        logger.info(f"[TRIGGER] Job queued via Redis: job_id={job.id}")
        # #endregion
        
        return {
            "job_id": job.id,
            "source_id": request.source_id,
            "status": job.status.value,
            "message": "Crawl job queued successfully"
        }
    except Exception as e:
        # #region agent log
        logger.warning(f"[TRIGGER] Redis failed, using sync fallback: {type(e).__name__}: {e}")
        # #endregion
        logger.warning(f"Redis unavailable, falling back to sync processing: {e}")
        
        # Fallback: process synchronously in background
        job_id = f"sync_{request.source_id}_{datetime.utcnow().strftime('%Y%m%d%H%M%S')}"
        
        # Run the crawl in background (non-blocking)
        background_tasks.add_task(run_crawl_sync, payload)
        
        # #region agent log
        logger.info(f"[TRIGGER] Sync job started: job_id={job_id}")
        # #endregion
        
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


class DetectRequest(BaseModel):
    """Request for URL detection."""
    url: str


class DetectResponse(BaseModel):
    """Response from URL detection."""
    detected_type: Literal["rss", "ics", "json_ld", "microdata", "unknown"]
    rss_url: Optional[str] = None
    ics_url: Optional[str] = None
    has_json_ld_events: bool = False
    has_microdata_events: bool = False
    sample_events: list = []  # 3-5 preview events
    recommendation: Literal["rss", "ics", "scraper", "unknown"] = "unknown"
    sitemap_url: Optional[str] = None


async def _detect_source_type(url: str) -> dict:
    """
    Detect how to get events from a URL: RSS, ICS, JSON-LD, Microdata, or unknown.
    Returns a dict suitable for DetectResponse.
    """
    result = {
        "detected_type": "unknown",
        "rss_url": None,
        "ics_url": None,
        "has_json_ld_events": False,
        "has_microdata_events": False,
        "sample_events": [],
        "recommendation": "unknown",
        "sitemap_url": None,
    }
    
    try:
        async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
            response = await client.get(
                url,
                headers={
                    "User-Agent": "Kiezling-Bot/1.0 (+https://kiezling.com/bot)",
                    "Accept": "text/html,application/xhtml+xml,application/xml",
                },
            )
            if response.status_code >= 400:
                return result
            
            content_type = (response.headers.get("content-type") or "").lower()
            html = response.text
            parsed = urlparse(url)
            base_url = f"{parsed.scheme}://{parsed.netloc}"
            
            # 1. Check for RSS/Atom link
            if "html" in content_type or not content_type:
                soup = BeautifulSoup(html, "lxml")
                for link in soup.find_all("link", rel="alternate"):
                    type_attr = (link.get("type") or "").lower()
                    href = link.get("href")
                    if not href:
                        continue
                    abs_url = urljoin(url, href)
                    if "rss" in type_attr or "atom" in type_attr or "xml" in type_attr:
                        result["rss_url"] = abs_url
                        result["detected_type"] = "rss"
                        result["recommendation"] = "rss"
                        break
                
                # 2. Check for ICS link
                for link in soup.find_all("link", rel="alternate"):
                    type_attr = (link.get("type") or "").lower()
                    href = link.get("href")
                    if not href:
                        continue
                    if "calendar" in type_attr or "ics" in type_attr:
                        result["ics_url"] = urljoin(url, href)
                        if not result["rss_url"]:
                            result["detected_type"] = "ics"
                            result["recommendation"] = "ics"
                        break
                
                # 3. Check for JSON-LD and Microdata events on page
                from src.crawlers.structured_data import StructuredDataExtractor
                extractor = StructuredDataExtractor()
                extracted = extractor.extract(html)
                if extracted:
                    result["has_json_ld_events"] = True  # extractor uses jsonld first
                    result["sample_events"] = [
                        {
                            "title": e.title,
                            "description": (e.description[:200] + "…") if e.description and len(e.description) > 200 else e.description,
                            "start_datetime": e.start_datetime.isoformat() if e.start_datetime else None,
                            "end_datetime": e.end_datetime.isoformat() if e.end_datetime else None,
                            "location_address": e.location_address,
                            "url": e.url,
                        }
                        for e in extracted[:5]
                    ]
                    if not result["rss_url"] and not result["ics_url"]:
                        result["detected_type"] = "json_ld"
                        result["recommendation"] = "scraper"
                    # If we have both RSS and JSON-LD, keep RSS as recommendation
                
                # 4. Sitemap: check robots.txt or common path
                try:
                    robots_resp = await client.get(f"{base_url}/robots.txt", timeout=5.0)
                    if robots_resp.status_code == 200 and "sitemap:" in robots_resp.text.lower():
                        for line in robots_resp.text.splitlines():
                            if line.lower().strip().startswith("sitemap:"):
                                result["sitemap_url"] = line.split(":", 1)[1].strip()
                                break
                except Exception:
                    pass
                if not result["sitemap_url"]:
                    sitemap_resp = await client.get(f"{base_url}/sitemap.xml", timeout=5.0)
                    if sitemap_resp.status_code == 200:
                        result["sitemap_url"] = f"{base_url}/sitemap.xml"
                        
    except Exception as e:
        logger.warning(f"Detection failed for {url}: {e}")
    
    return result


@router.post("/detect", response_model=DetectResponse)
async def detect_source(request: DetectRequest):
    """
    Auto-detect how to get events from a URL.
    
    Checks for RSS/Atom, ICS, JSON-LD/Microdata events, and sitemap.
    Returns recommendation (rss | ics | scraper | unknown) and sample events if any.
    """
    if not request.url or not request.url.strip().startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="Valid URL required")
    try:
        data = await _detect_source_type(request.url.strip())
        return DetectResponse(**data)
    except Exception as e:
        logger.exception("Detect failed")
        raise HTTPException(status_code=500, detail=str(e))


class SingleEventCrawlRequest(BaseModel):
    """Request to crawl a single event page URL for missing fields."""
    url: str
    fields_needed: Optional[list[str]] = None  # e.g. ["location_address", "end_datetime", "image_url"]


class SingleEventCrawlResponse(BaseModel):
    """Response from single-event crawl."""
    success: bool = True
    fields_found: dict = {}  # field name -> value (serializable)
    fields_missing: list[str] = []
    error: Optional[str] = None


@router.post("/single-event", response_model=SingleEventCrawlResponse)
async def crawl_single_event(request: SingleEventCrawlRequest):
    """
    Crawl a single event page URL to extract structured data (JSON-LD/Microdata).
    Used when an event has missing fields and we want to try filling them from the detail page.
    """
    if not request.url or not request.url.strip().startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="Valid URL required")
    url = request.url.strip()
    fields_needed = request.fields_needed or [
        "location_address", "location_name", "start_datetime", "end_datetime",
        "image_url", "description", "price", "organizer_name"
    ]
    try:
        async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
            response = await client.get(
                url,
                headers={
                    "User-Agent": "Kiezling-Bot/1.0 (+https://kiezling.com/bot)",
                    "Accept": "text/html,application/xhtml+xml",
                },
            )
            if response.status_code >= 400:
                return SingleEventCrawlResponse(
                    success=False,
                    fields_found={},
                    fields_missing=fields_needed,
                    error=f"HTTP {response.status_code}"
                )
            html = response.text
            from src.crawlers.structured_data import StructuredDataExtractor
            extractor = StructuredDataExtractor()
            extracted_list = extractor.extract(html)
            if not extracted_list:
                return SingleEventCrawlResponse(
                    success=True,
                    fields_found={},
                    fields_missing=fields_needed,
                    error="Keine strukturierten Event-Daten (JSON-LD/Microdata) auf der Seite gefunden"
                )
            # Use first extracted event
            e = extracted_list[0]
            fields_found = {}
            field_map = {
                "location_address": ("location_address", e.location_address),
                "location_name": ("location_name", e.location_name),
                "start_datetime": ("start_datetime", e.start_datetime.isoformat() if e.start_datetime else None),
                "end_datetime": ("end_datetime", e.end_datetime.isoformat() if e.end_datetime else None),
                "image_url": ("image_url", e.image_url),
                "description": ("description", e.description),
                "price": ("price", e.price),
                "organizer_name": ("organizer_name", e.organizer_name),
                "lat": ("lat", e.lat),
                "lng": ("lng", e.lng),
            }
            for name in fields_needed:
                if name in field_map:
                    _key, val = field_map[name]
                    if val is not None and val != "":
                        fields_found[name] = val
            fields_missing = [f for f in fields_needed if f not in fields_found]
            return SingleEventCrawlResponse(
                success=True,
                fields_found=fields_found,
                fields_missing=fields_missing,
            )
    except httpx.TimeoutException as e:
        return SingleEventCrawlResponse(
            success=False,
            fields_found={},
            fields_missing=fields_needed,
            error=f"Timeout: {str(e)}"
        )
    except Exception as e:
        logger.exception("Single-event crawl failed")
        return SingleEventCrawlResponse(
            success=False,
            fields_found={},
            fields_missing=fields_needed,
            error=str(e)
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
