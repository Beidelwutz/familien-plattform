"""Background worker for processing queued jobs."""

import asyncio
import os
import signal
import logging
from typing import Any

from .job_queue import job_queue, QUEUE_CRAWL, QUEUE_CLASSIFY, QUEUE_SCORE
from src.crawlers.feed_parser import FeedParser
from src.classifiers.event_classifier import EventClassifier
from src.scorers.event_scorer import EventScorer

logger = logging.getLogger(__name__)

# Initialize processors
feed_parser = FeedParser()
event_classifier = EventClassifier()
event_scorer = EventScorer()


async def process_crawl_job(payload: dict) -> dict:
    """
    Process a crawl job.
    
    Args:
        payload: Job payload containing source_id, source_url, source_type
    
    Returns:
        Result dict with events_found, events_new, etc.
    """
    source_id = payload.get("source_id")
    source_url = payload.get("source_url")
    source_type = payload.get("source_type", "rss")
    
    logger.info(f"Processing crawl job for source {source_id}")
    
    if not source_url:
        # TODO: Fetch source URL from backend API
        raise ValueError("source_url is required")
    
    # Parse the feed
    if source_type == "rss":
        events = await feed_parser.parse_rss(source_url)
    elif source_type == "ics":
        events = await feed_parser.parse_ics(source_url)
    else:
        raise ValueError(f"Unknown source type: {source_type}")
    
    logger.info(f"Found {len(events)} events from {source_url}")
    
    # TODO: Send events to backend for ingestion
    # For now, just return the count
    
    return {
        "source_id": source_id,
        "events_found": len(events),
        "events_new": len(events),  # TODO: Track actual new vs updated
        "events": events[:5]  # Return first 5 for debugging
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
