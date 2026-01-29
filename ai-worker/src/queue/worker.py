"""Background worker for processing queued jobs."""

import asyncio
import os
import signal
import logging
from typing import Any, Optional

import httpx

from .job_queue import job_queue, QUEUE_CRAWL, QUEUE_CLASSIFY, QUEUE_SCORE
from src.crawlers.feed_parser import FeedParser
from src.classifiers.event_classifier import EventClassifier
from src.scorers.event_scorer import EventScorer
from src.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

# Initialize processors
feed_parser = FeedParser()
event_classifier = EventClassifier()
event_scorer = EventScorer()

# HTTP client for backend calls
http_client: Optional[httpx.AsyncClient] = None


async def get_http_client() -> httpx.AsyncClient:
    """Get or create HTTP client."""
    global http_client
    if http_client is None:
        http_client = httpx.AsyncClient(timeout=30.0)
    return http_client


async def close_http_client():
    """Close HTTP client."""
    global http_client
    if http_client:
        await http_client.aclose()
        http_client = None


async def send_event_to_backend(event: dict, source_id: str) -> dict:
    """
    Send a single event to the backend for ingestion.
    
    Args:
        event: Event data from feed parser
        source_id: Source ID for the event
    
    Returns:
        Backend response with action (created/updated/duplicate)
    """
    client = await get_http_client()
    
    # Prepare event payload for backend /api/events/ingest
    payload = {
        "source_id": source_id,
        "title": event.get("title", ""),
        "description": event.get("description", ""),
        "start_datetime": event.get("start_datetime"),
        "end_datetime": event.get("end_datetime"),
        "location_name": event.get("location_name", ""),
        "location_address": event.get("location_address", ""),
        "external_url": event.get("url", ""),
        "external_id": event.get("external_id", event.get("id", "")),
        "raw_data": event,
    }
    
    # Add optional fields if present
    if event.get("image_url"):
        payload["image_url"] = event["image_url"]
    if event.get("price_info"):
        payload["price_info"] = event["price_info"]
    if event.get("organizer_name"):
        payload["organizer_name"] = event["organizer_name"]
    
    headers = {"Content-Type": "application/json"}
    if settings.service_token:
        headers["Authorization"] = f"Bearer {settings.service_token}"
    
    try:
        response = await client.post(
            f"{settings.backend_url}/api/events/ingest",
            json=payload,
            headers=headers,
        )
        
        if response.status_code in (200, 201):
            return response.json()
        else:
            logger.warning(f"Ingest failed for event '{payload.get('title')}': {response.status_code} - {response.text[:200]}")
            return {"action": "error", "error": response.text[:200]}
    except Exception as e:
        logger.error(f"Failed to send event to backend: {e}")
        return {"action": "error", "error": str(e)}


async def update_ingest_run(
    ingest_run_id: str,
    status: str,
    events_found: int = 0,
    events_created: int = 0,
    events_updated: int = 0,
    events_skipped: int = 0,
    error_message: str = None,
    error_details: dict = None,
):
    """Update the IngestRun status in the backend."""
    if not ingest_run_id:
        return
    
    client = await get_http_client()
    
    payload = {
        "status": status,
        "events_found": events_found,
        "events_created": events_created,
        "events_updated": events_updated,
        "events_skipped": events_skipped,
        "finished_at": None if status == "running" else "now",
    }
    
    if error_message:
        payload["error_message"] = error_message
        payload["needs_attention"] = True
    if error_details:
        payload["error_details"] = error_details
    
    headers = {"Content-Type": "application/json"}
    if settings.service_token:
        headers["Authorization"] = f"Bearer {settings.service_token}"
    
    try:
        response = await client.patch(
            f"{settings.backend_url}/api/admin/ingest-runs/{ingest_run_id}",
            json=payload,
            headers=headers,
        )
        
        if response.status_code not in (200, 201):
            logger.warning(f"Failed to update ingest run {ingest_run_id}: {response.status_code}")
    except Exception as e:
        logger.error(f"Failed to update ingest run: {e}")


async def process_crawl_job(payload: dict) -> dict:
    """
    Process a crawl job.
    
    Args:
        payload: Job payload containing source_id, source_url, source_type, ingest_run_id
    
    Returns:
        Result dict with events_found, events_new, etc.
    """
    source_id = payload.get("source_id")
    source_url = payload.get("source_url")
    source_type = payload.get("source_type", "rss")
    ingest_run_id = payload.get("ingest_run_id")
    
    logger.info(f"Processing crawl job for source {source_id}")
    
    if not source_url:
        error_msg = "source_url is required"
        await update_ingest_run(ingest_run_id, "failed", error_message=error_msg)
        raise ValueError(error_msg)
    
    # Parse the feed
    try:
        if source_type == "rss":
            events = await feed_parser.parse_rss(source_url)
        elif source_type == "ics":
            events = await feed_parser.parse_ics(source_url)
        else:
            error_msg = f"Unknown source type: {source_type}"
            await update_ingest_run(ingest_run_id, "failed", error_message=error_msg)
            raise ValueError(error_msg)
    except Exception as e:
        error_msg = f"Feed parsing failed: {str(e)}"
        logger.error(error_msg)
        await update_ingest_run(ingest_run_id, "failed", error_message=error_msg)
        raise
    
    logger.info(f"Found {len(events)} events from {source_url}")
    
    # Send events to backend for ingestion
    events_created = 0
    events_updated = 0
    events_skipped = 0
    errors = []
    
    for event in events:
        result = await send_event_to_backend(event, source_id)
        action = result.get("action", "error")
        
        if action == "created":
            events_created += 1
        elif action == "updated":
            events_updated += 1
        elif action == "duplicate":
            events_skipped += 1
        elif action == "error":
            errors.append({"event": event.get("title", "Unknown"), "error": result.get("error", "Unknown error")})
            events_skipped += 1
        else:
            events_skipped += 1
        
        # Small delay to avoid overwhelming the backend
        await asyncio.sleep(0.1)
    
    # Determine final status
    if errors and len(errors) == len(events):
        status = "failed"
    elif errors:
        status = "partial"
    else:
        status = "success"
    
    # Update ingest run with final results
    await update_ingest_run(
        ingest_run_id,
        status=status,
        events_found=len(events),
        events_created=events_created,
        events_updated=events_updated,
        events_skipped=events_skipped,
        error_message=f"{len(errors)} events failed" if errors else None,
        error_details={"errors": errors[:10]} if errors else None,  # Limit to first 10 errors
    )
    
    logger.info(f"Crawl complete: {events_created} created, {events_updated} updated, {events_skipped} skipped, {len(errors)} errors")
    
    return {
        "source_id": source_id,
        "events_found": len(events),
        "events_created": events_created,
        "events_updated": events_updated,
        "events_skipped": events_skipped,
        "errors": len(errors),
    }


async def process_classify_job(payload: dict) -> dict:
    """
    Process a classification job.
    
    Args:
        payload: Job payload containing event data
    
    Returns:
        Classification result
    """
    event_data = payload.get("event")
    
    if not event_data:
        raise ValueError("event data is required")
    
    logger.info(f"Classifying event: {event_data.get('title', 'Unknown')}")
    
    result = await event_classifier.classify(event_data)
    
    return {
        "event_id": event_data.get("id"),
        "classification": result
    }


async def process_score_job(payload: dict) -> dict:
    """
    Process a scoring job.
    
    Args:
        payload: Job payload containing event data
    
    Returns:
        Scoring result
    """
    event_data = payload.get("event")
    
    if not event_data:
        raise ValueError("event data is required")
    
    logger.info(f"Scoring event: {event_data.get('title', 'Unknown')}")
    
    result = await event_scorer.score(event_data)
    
    return {
        "event_id": event_data.get("id"),
        "scores": result
    }


async def run_worker(queues: list[str] = None):
    """
    Run the background worker.
    
    Args:
        queues: List of queues to process. Defaults to all queues.
    """
    if queues is None:
        queues = [QUEUE_CRAWL, QUEUE_CLASSIFY, QUEUE_SCORE]
    
    # Register handlers
    job_queue.register_handler("crawl", process_crawl_job)
    job_queue.register_handler("classify", process_classify_job)
    job_queue.register_handler("score", process_score_job)
    
    # Connect to Redis
    await job_queue.connect()
    
    logger.info(f"Starting worker for queues: {queues}")
    
    # Handle shutdown signals
    loop = asyncio.get_event_loop()
    
    def shutdown():
        logger.info("Shutdown signal received")
        job_queue.stop()
    
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, shutdown)
        except NotImplementedError:
            # Windows doesn't support add_signal_handler
            pass
    
    # Process queues concurrently
    tasks = [
        asyncio.create_task(job_queue.process_queue(queue))
        for queue in queues
    ]
    
    try:
        await asyncio.gather(*tasks)
    except asyncio.CancelledError:
        logger.info("Worker tasks cancelled")
    finally:
        await close_http_client()
        await job_queue.disconnect()
        logger.info("Worker stopped")


if __name__ == "__main__":
    # Configure logging
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
    )
    
    # Run the worker
    asyncio.run(run_worker())
