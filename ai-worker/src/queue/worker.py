"""Background worker for processing queued jobs.

Implements Option A architecture:
- Worker: Extraction + Normalization + In-Run Dedupe + AI Suggestions
- Backend: Final Dedupe + Merge + Persistenz
"""

import asyncio
import signal
import logging
from typing import Any, Optional
from datetime import datetime

import httpx

from .job_queue import job_queue, QUEUE_CRAWL, QUEUE_CLASSIFY, QUEUE_SCORE
from src.crawlers.feed_parser import FeedParser, ParsedEvent
from src.classifiers.event_classifier import EventClassifier
from src.scorers.event_scorer import EventScorer
from src.ingestion.in_run_dedupe import create_parsed_event_deduplicator
from src.models.candidate import (
    CanonicalCandidate, 
    CandidateData, 
    AISuggestions,
    AIClassification,
    AIScores,
    AIGeocode,
    Versions,
    IngestBatchRequest,
)
from src.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

# Version tracking
VERSIONS = Versions(
    parser="1.0.0",
    normalizer="1.0.0",
)

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
        http_client = httpx.AsyncClient(timeout=60.0)
    return http_client


async def close_http_client():
    """Close HTTP client."""
    global http_client
    if http_client:
        await http_client.aclose()
        http_client = None


def parsed_event_to_candidate(
    event: ParsedEvent,
    source_type: str,
) -> CanonicalCandidate:
    """Convert ParsedEvent to CanonicalCandidate."""
    
    # Build CandidateData
    data = CandidateData(
        title=event.title,
        description=event.description,
        start_at=event.start_datetime.isoformat() if event.start_datetime else None,
        end_at=event.end_datetime.isoformat() if event.end_datetime else None,
        address=event.location_address,
        # These would be filled by normalizer
        venue_name=None,
        city="Karlsruhe",  # Default for this region
        lat=None,
        lng=None,
        price_min=None,
        price_max=None,
        age_min=None,
        age_max=None,
        categories=None,
        images=None,
        booking_url=event.source_url,
    )
    
    # Compute raw hash from data
    raw_hash = CanonicalCandidate.compute_raw_hash(data.to_dict())
    
    return CanonicalCandidate(
        source_type=source_type,
        source_url=event.source_url or "",
        fingerprint=event.fingerprint,
        raw_hash=raw_hash,
        extracted_at=datetime.utcnow().isoformat(),
        data=data,
        external_id=event.external_id,
        ai=None,  # Will be filled later if AI enabled
        versions=VERSIONS,
    )


async def enrich_with_ai(candidates: list[CanonicalCandidate]) -> list[CanonicalCandidate]:
    """
    Enrich candidates with AI classification and scoring.
    
    AI results are stored as suggestions - Backend decides final merge.
    """
    if not settings.openai_api_key and not settings.anthropic_api_key:
        logger.warning("No AI API keys configured, skipping AI enrichment")
        return candidates
    
    for candidate in candidates:
        try:
            # Prepare event data for classifier
            event_data = {
                'title': candidate.data.title,
                'description': candidate.data.description,
                'location': candidate.data.address,
            }
            
            # Classification
            classification_result = await event_classifier.classify(event_data)
            
            classification = AIClassification(
                categories=classification_result.get('categories', []),
                age_min=classification_result.get('age_min'),
                age_max=classification_result.get('age_max'),
                is_indoor=classification_result.get('is_indoor'),
                is_outdoor=classification_result.get('is_outdoor'),
                confidence=classification_result.get('confidence', 0.0),
                model=classification_result.get('model', 'unknown'),
                prompt_version="1.0.0",
            )
            
            # Scoring
            scoring_result = await event_scorer.score(event_data)
            
            scores = AIScores(
                relevance=scoring_result.get('relevance_score', 50),
                quality=scoring_result.get('quality_score', 50),
                family_fit=scoring_result.get('family_fit_score', 50),
                stressfree=scoring_result.get('stressfree_score'),
                confidence=scoring_result.get('confidence', 0.0),
                model=scoring_result.get('model', 'unknown'),
            )
            
            # Update candidate with AI suggestions
            candidate.ai = AISuggestions(
                classification=classification,
                scores=scores,
                geocode=None,  # TODO: Add geocoding if address present
            )
            
        except Exception as e:
            logger.warning(f"AI enrichment failed for {candidate.data.title}: {e}")
            continue
    
    return candidates


async def send_batch_to_backend(
    source_id: str,
    candidates: list[CanonicalCandidate],
    run_id: Optional[str] = None
) -> dict:
    """
    Send batch of candidates to backend for ingestion.
    
    Args:
        source_id: Source UUID
        candidates: List of CanonicalCandidate objects
        run_id: Optional existing IngestRun ID
    
    Returns:
        Backend response with results and summary
    """
    client = await get_http_client()
    
    # Build request payload
    request = IngestBatchRequest(
        run_id=run_id,
        source_id=source_id,
        candidates=candidates,
    )
    
    headers = {"Content-Type": "application/json"}
    if settings.service_token:
        headers["Authorization"] = f"Bearer {settings.service_token}"
    
    try:
        response = await client.post(
            f"{settings.backend_url}/api/events/ingest/batch",
            json=request.to_dict(),
            headers=headers,
        )
        
        if response.status_code in (200, 201):
            data = response.json()
            logger.info(
                f"Batch ingest successful: "
                f"created={data['summary']['created']}, "
                f"updated={data['summary']['updated']}, "
                f"unchanged={data['summary']['unchanged']}, "
                f"ignored={data['summary']['ignored']}"
            )
            return data
        else:
            logger.error(f"Batch ingest failed: {response.status_code} - {response.text[:500]}")
            return {
                "success": False,
                "error": response.text[:500],
                "summary": {"created": 0, "updated": 0, "unchanged": 0, "ignored": len(candidates)}
            }
    except Exception as e:
        logger.error(f"Failed to send batch to backend: {e}")
        return {
            "success": False,
            "error": str(e),
            "summary": {"created": 0, "updated": 0, "unchanged": 0, "ignored": len(candidates)}
        }


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
    """Update the IngestRun status in the backend (legacy endpoint)."""
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
    Process a crawl job using the new batch ingest system.
    
    Pipeline:
    1. Crawl (RSS/ICS)
    2. Convert to Candidates
    3. In-Run Dedupe
    4. Optional: AI Enrich
    5. Batch Ingest to Backend
    
    Args:
        payload: Job payload containing source_id, source_url, source_type
    
    Returns:
        Result dict with summary
    """
    source_id = payload.get("source_id")
    source_url = payload.get("source_url")
    source_type = payload.get("source_type", "rss")
    ingest_run_id = payload.get("ingest_run_id")
    enable_ai = payload.get("enable_ai", False)
    
    logger.info(f"Processing crawl job for source {source_id} ({source_type})")
    
    if not source_url:
        error_msg = "source_url is required"
        if ingest_run_id:
            await update_ingest_run(ingest_run_id, "failed", error_message=error_msg)
        raise ValueError(error_msg)
    
    # Step 1: Crawl/Parse the feed
    try:
        if source_type == "rss":
            parsed_events = await feed_parser.parse_rss(source_url)
        elif source_type == "ics":
            parsed_events = await feed_parser.parse_ics(source_url)
        else:
            error_msg = f"Unknown source type: {source_type}"
            if ingest_run_id:
                await update_ingest_run(ingest_run_id, "failed", error_message=error_msg)
            raise ValueError(error_msg)
    except Exception as e:
        error_msg = f"Feed parsing failed: {str(e)}"
        logger.error(error_msg)
        if ingest_run_id:
            await update_ingest_run(ingest_run_id, "failed", error_message=error_msg)
        raise
    
    logger.info(f"Parsed {len(parsed_events)} events from {source_url}")
    
    if len(parsed_events) == 0:
        logger.warning(f"No events found in {source_url}")
        return {
            "source_id": source_id,
            "events_found": 0,
            "events_created": 0,
            "events_updated": 0,
            "events_unchanged": 0,
            "events_ignored": 0,
        }
    
    # Step 2: In-Run Dedupe (remove duplicates within this fetch)
    deduplicator = create_parsed_event_deduplicator()
    unique_events = deduplicator.dedupe(parsed_events)
    
    logger.info(f"After in-run dedupe: {len(unique_events)} unique events (removed {deduplicator.stats.duplicates_removed})")
    
    # Step 3: Convert to Candidates
    candidates = [
        parsed_event_to_candidate(event, source_type)
        for event in unique_events
    ]
    
    # Step 4: Optional AI Enrichment
    if enable_ai:
        logger.info("Running AI enrichment...")
        candidates = await enrich_with_ai(candidates)
    
    # Step 5: Batch Ingest to Backend
    result = await send_batch_to_backend(source_id, candidates, ingest_run_id)
    
    summary = result.get("summary", {})
    
    return {
        "source_id": source_id,
        "events_found": len(parsed_events),
        "events_unique": len(unique_events),
        "duplicates_in_run": deduplicator.stats.duplicates_removed,
        "events_created": summary.get("created", 0),
        "events_updated": summary.get("updated", 0),
        "events_unchanged": summary.get("unchanged", 0),
        "events_ignored": summary.get("ignored", 0),
        "run_id": result.get("run_id"),
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
