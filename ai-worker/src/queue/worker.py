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
from src.crawlers.rss_deep_fetch import selective_deep_fetch, DeepFetchConfig
from src.crawlers.content_type_detector import fetch_and_detect, get_mismatch_message
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

# #region agent log
def _agent_log(location: str, message: str, data: dict, hypothesis_id: str = ""):
    import json
    import os
    payload = {"id": f"log_{int(__import__('time').time()*1000)}", "timestamp": int(__import__('time').time()*1000), "location": location, "message": message, "data": data, "hypothesisId": hypothesis_id}
    line = json.dumps(payload, ensure_ascii=False) + "\n"
    try:
        log_path = os.environ.get("DEBUG_LOG_PATH")
        if not log_path:
            # Repo root = 3 levels up from this file (ai-worker/src/queue/worker.py)
            repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
            log_path = os.path.join(repo_root, ".cursor", "debug.log")
        os.makedirs(os.path.dirname(log_path), exist_ok=True)
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(line)
    except Exception:
        pass
    if settings.backend_url and settings.service_token:
        def _push():
            try:
                import httpx
                with httpx.Client(timeout=5.0) as client:
                    client.post(
                        f"{settings.backend_url}/api/admin/debug-log-push",
                        json={"line": line},
                        headers={"Authorization": f"Bearer {settings.service_token}", "Content-Type": "application/json"},
                    )
            except Exception:
                pass
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                loop.run_in_executor(None, _push)
            else:
                _push()
        except Exception:
            _push()
# #endregion

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
        # Increased timeout for large batch operations (329+ events can take a while)
        http_client = httpx.AsyncClient(timeout=httpx.Timeout(300.0, connect=30.0))
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
    
    # Build images list from deep-fetched image_url
    images = None
    if event.image_url:
        images = [event.image_url]
    
    # Build CandidateData with enriched fields from deep-fetch
    data = CandidateData(
        title=event.title,
        description=event.description,
        start_at=event.start_datetime.isoformat() if event.start_datetime else None,
        end_at=event.end_datetime.isoformat() if event.end_datetime else None,
        address=event.location_address,
        # Enriched from deep-fetch
        venue_name=event.location_name,
        city="Karlsruhe",  # Default for this region
        lat=event.lat,
        lng=event.lng,
        price_min=event.price,  # From deep-fetch
        price_max=event.price,  # Same as min for now
        age_min=None,
        age_max=None,
        categories=None,
        images=images,
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
    
    Pipeline:
    1. Rule-Filter: Hard/Soft exclude before AI to save costs
    2. AI Classification: For uncertain/included events
    3. AI Scoring: Quality, relevance, family_fit
    
    AI results are stored as suggestions - Backend decides final merge.
    """
    from src.rules.rule_filter import RuleBasedFilter
    rule_filter = RuleBasedFilter()
    
    if not settings.openai_api_key and not settings.anthropic_api_key:
        logger.warning("No AI API keys configured, skipping AI enrichment")
        return candidates
    
    rule_rejected = 0
    ai_called = 0
    
    for candidate in candidates:
        try:
            # Prepare event data for classifier/scorer
            event_data = {
                'title': candidate.data.title,
                'description': candidate.data.description,
                'location_address': candidate.data.address,
                'price_type': getattr(candidate.data, 'price_type', None),
            }
            
            # Step 1: Rule-Filter BEFORE AI
            rule_result = rule_filter.check(event_data)
            
            if rule_result.is_relevant is False and rule_result.is_hard_exclude:
                # Hard exclude -> skip AI entirely
                candidate.ai = AISuggestions(
                    classification=AIClassification(
                        categories=[], confidence=rule_result.confidence,
                        model='rule_filter', prompt_version='rule_v1',
                    ),
                    scores=AIScores(
                        relevance=10, quality=30, family_fit=10,
                        confidence=rule_result.confidence, model='rule_filter',
                    ),
                )
                rule_rejected += 1
                logger.info(f"Rule-Filter hard-rejected: {candidate.data.title} ({rule_result.reason})")
                continue
            
            if rule_result.is_relevant is False and not rule_result.is_hard_exclude:
                # Soft exclude without include hits -> skip AI
                candidate.ai = AISuggestions(
                    classification=AIClassification(
                        categories=rule_result.suggested_categories or [],
                        confidence=rule_result.confidence,
                        model='rule_filter', prompt_version='rule_v1',
                    ),
                    scores=AIScores(
                        relevance=20, quality=30, family_fit=20,
                        confidence=rule_result.confidence, model='rule_filter',
                    ),
                )
                rule_rejected += 1
                logger.info(f"Rule-Filter soft-rejected: {candidate.data.title} ({rule_result.reason})")
                continue
            
            # Step 2: AI Classification (uncertain or included events)
            ai_called += 1
            classification_result = await event_classifier.classify(event_data)
            
            classification = AIClassification(
                categories=classification_result.categories or [],
                age_min=classification_result.age_min,
                age_max=classification_result.age_max,
                age_recommendation_text=classification_result.age_recommendation_text,
                sibling_friendly=classification_result.sibling_friendly,
                is_indoor=classification_result.is_indoor,
                is_outdoor=classification_result.is_outdoor,
                language=classification_result.language,
                complexity_level=classification_result.complexity_level,
                noise_level=classification_result.noise_level,
                has_seating=classification_result.has_seating,
                typical_wait_minutes=classification_result.typical_wait_minutes,
                food_drink_allowed=classification_result.food_drink_allowed,
                # AI-extracted datetime
                extracted_start_datetime=classification_result.extracted_start_datetime,
                extracted_end_datetime=classification_result.extracted_end_datetime,
                datetime_confidence=classification_result.datetime_confidence or 0.0,
                # AI-extracted location
                extracted_location_address=classification_result.extracted_location_address,
                extracted_location_district=classification_result.extracted_location_district,
                location_confidence=classification_result.location_confidence or 0.0,
                # AI-extracted price
                extracted_price_type=classification_result.extracted_price_type,
                extracted_price_min=classification_result.extracted_price_min,
                extracted_price_max=classification_result.extracted_price_max,
                price_confidence=classification_result.price_confidence or 0.0,
                # AI-extracted venue (Location-Entity-Split)
                extracted_venue_name=classification_result.extracted_venue_name,
                extracted_address_line=classification_result.extracted_address_line,
                extracted_city=classification_result.extracted_city,
                extracted_postal_code=classification_result.extracted_postal_code,
                venue_confidence=classification_result.venue_confidence or 0.0,
                # Cancellation
                is_cancelled_or_postponed=classification_result.is_cancelled_or_postponed,
                # AI-generated summaries
                ai_summary_short=classification_result.ai_summary_short,
                ai_summary_highlights=classification_result.ai_summary_highlights or [],
                ai_fit_blurb=classification_result.ai_fit_blurb,
                summary_confidence=classification_result.summary_confidence or 0.0,
                confidence=classification_result.confidence or 0.0,
                model=classification_result.model or 'unknown',
                prompt_version=classification_result.prompt_version or "4.0.0",
            )
            
            # Step 3: Scoring
            scoring_result = await event_scorer.score(event_data)
            
            scores = AIScores(
                relevance=scoring_result.relevance_score,
                quality=scoring_result.quality_score,
                family_fit=scoring_result.family_fit_score,
                stressfree=scoring_result.stressfree_score,
                confidence=scoring_result.confidence or 0.0,
                model=scoring_result.model or 'unknown',
            )
            
            # Update candidate with AI suggestions
            candidate.ai = AISuggestions(
                classification=classification,
                scores=scores,
                geocode=None,
            )
            
        except Exception as e:
            logger.warning(f"AI enrichment failed for {candidate.data.title}: {e}")
            continue
    
    logger.info(f"AI enrichment complete: {ai_called} AI calls, {rule_rejected} rule-rejected (saved {rule_rejected} AI calls)")
    return candidates


BATCH_SIZE = 10
MAX_RETRIES = 3


async def _send_single_batch(
    client: httpx.AsyncClient,
    source_id: str,
    batch: list[CanonicalCandidate],
    run_id: Optional[str],
    headers: dict,
) -> dict:
    """Send a single batch to backend. Raises on failure."""
    request = IngestBatchRequest(
        run_id=run_id,
        source_id=source_id,
        candidates=batch,
    )
    
    target_url = f"{settings.backend_url}/api/events/ingest/batch"
    response = await client.post(target_url, json=request.to_dict(), headers=headers)
    
    if response.status_code in (200, 201):
        return response.json()
    else:
        raise RuntimeError(f"Backend returned {response.status_code}: {response.text[:500]}")


async def send_batch_to_backend(
    source_id: str,
    candidates: list[CanonicalCandidate],
    run_id: Optional[str] = None
) -> dict:
    """
    Send batch of candidates to backend for ingestion.
    Splits into sub-batches of BATCH_SIZE with retry logic.
    Failed candidates are stored in DLQ.
    
    Args:
        source_id: Source UUID
        candidates: List of CanonicalCandidate objects
        run_id: Optional existing IngestRun ID
    
    Returns:
        Backend response with results and summary
    """
    logger.info(f"[BATCH] send_batch_to_backend: source_id={source_id}, total={len(candidates)}, batch_size={BATCH_SIZE}")
    
    client = await get_http_client()
    
    headers = {"Content-Type": "application/json"}
    if settings.service_token:
        headers["Authorization"] = f"Bearer {settings.service_token}"
    
    all_results = {"created": 0, "updated": 0, "unchanged": 0, "ignored": 0}
    failed_candidates = []
    
    # Split into sub-batches
    for i in range(0, len(candidates), BATCH_SIZE):
        batch = candidates[i:i + BATCH_SIZE]
        batch_num = i // BATCH_SIZE + 1
        total_batches = (len(candidates) + BATCH_SIZE - 1) // BATCH_SIZE
        
        success = False
        for attempt in range(MAX_RETRIES):
            try:
                result = await _send_single_batch(client, source_id, batch, run_id, headers)
                summary = result.get("summary", {})
                for key in all_results:
                    all_results[key] += summary.get(key, 0)
                logger.info(f"[BATCH] Sub-batch {batch_num}/{total_batches} OK: +{summary.get('created', 0)} created")
                if run_id:
                    await update_ingest_run(run_id, progress_message=f"Importiere in Datenbank … Batch {batch_num}/{total_batches}")
                # #region agent log
                if batch_num == 1:
                    _agent_log("worker.py:first_batch_ok", "first batch response OK", {"batch_num": batch_num, "summary": summary, "status_code": 200}, "H2,H4")
                # #endregion
                success = True
                break
            except Exception as e:
                # #region agent log
                if batch_num == 1:
                    _agent_log("worker.py:first_batch_error", "first batch request failed", {"batch_num": 1, "error": str(e), "attempt": attempt + 1}, "H2,H4,H5")
                # #endregion
                if attempt < MAX_RETRIES - 1:
                    wait = 2 ** attempt
                    logger.warning(f"[BATCH] Sub-batch {batch_num} attempt {attempt+1} failed: {e}, retrying in {wait}s")
                    await asyncio.sleep(wait)
                else:
                    logger.error(f"[BATCH] Sub-batch {batch_num} failed after {MAX_RETRIES} retries: {e}")
        
        if not success:
            failed_candidates.extend(batch)
    
    # Store failed candidates in DLQ
    if failed_candidates:
        try:
            from .job_queue import store_in_dlq
            await store_in_dlq(source_id, failed_candidates)
            logger.warning(f"[BATCH] {len(failed_candidates)} candidates moved to DLQ")
        except Exception as e:
            logger.error(f"[BATCH] Failed to store in DLQ: {e}")
    
    total_summary = {**all_results}
    logger.info(
        f"Batch ingest complete: "
        f"created={total_summary['created']}, updated={total_summary['updated']}, "
        f"unchanged={total_summary['unchanged']}, ignored={total_summary['ignored']}, "
        f"failed={len(failed_candidates)}"
    )
    
    return {
        "success": len(failed_candidates) == 0,
        "summary": total_summary,
        "failed": len(failed_candidates),
        "run_id": run_id,
    }


async def update_ingest_run(
    ingest_run_id: str,
    status: str = None,
    events_found: int = None,
    events_created: int = None,
    events_updated: int = None,
    events_skipped: int = None,
    error_message: str = None,
    error_details: dict = None,
    progress_message: str = None,
):
    """Update the IngestRun status in the backend. Pass only the fields to update."""
    if not ingest_run_id:
        return

    client = await get_http_client()

    payload = {}
    if status is not None:
        payload["status"] = status
        payload["finished_at"] = None if status == "running" else "now"
    if events_found is not None:
        payload["events_found"] = events_found
    if events_created is not None:
        payload["events_created"] = events_created
    if events_updated is not None:
        payload["events_updated"] = events_updated
    if events_skipped is not None:
        payload["events_skipped"] = events_skipped
    if error_message is not None:
        payload["error_message"] = error_message
        payload["needs_attention"] = True
    if error_details is not None:
        payload["error_details"] = error_details
    if progress_message is not None:
        payload["progress_message"] = progress_message

    if not payload:
        return

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
    # #region agent log
    _agent_log(
        "worker.py:process_crawl_job_start",
        "job started",
        {"source_id": payload.get("source_id"), "source_url": payload.get("source_url"), "ingest_run_id": payload.get("ingest_run_id")},
        "H0",
    )
    # #endregion
    logger.info(f"[CRAWL] process_crawl_job STARTED with payload: {payload}")

    source_id = payload.get("source_id")
    source_url = payload.get("source_url")
    source_type = payload.get("source_type", "rss")
    ingest_run_id = payload.get("ingest_run_id")
    enable_ai = payload.get("enable_ai", False)
    fetch_event_pages = payload.get("fetch_event_pages", False)  # Selective Deep-Fetch
    detail_page_config = payload.get("detail_page_config")  # Source-specific selectors for RSS deep-fetch
    dry_run = payload.get("dry_run", False)
    
    logger.info(f"Processing crawl job for source {source_id} ({source_type})")
    
    if not source_url:
        error_msg = "source_url is required"
        if ingest_run_id:
            await update_ingest_run(ingest_run_id, "failed", error_message=error_msg)
        raise ValueError(error_msg)

    # Content-type detection (show mismatch when source type does not match what URL returns)
    content_type_detected = "unknown"
    try:
        detection = await fetch_and_detect(source_url)
        content_type_detected = detection.get("content_type_detected", "unknown")
    except Exception as e:
        logger.warning(f"Content-type detection failed for {source_url}: {e}")
    content_type_configured = source_type
    content_type_message = get_mismatch_message(content_type_detected, content_type_configured)
    content_type_mismatch = bool(content_type_message)

    def _content_type_result(base: dict) -> dict:
        base["content_type_detected"] = content_type_detected
        base["content_type_configured"] = content_type_configured
        base["content_type_mismatch"] = content_type_mismatch
        if content_type_message:
            base["content_type_message"] = content_type_message
        return base

    # Step 1: Crawl/Parse (RSS/ICS return (events, etag, last_modified, was_modified); scraper returns list)
    try:
        if source_type == "rss":
            parsed_events, _, _, _ = await feed_parser.parse_rss(source_url)
        elif source_type == "ics":
            parsed_events, _, _, _ = await feed_parser.parse_ics(source_url)
        elif source_type == "scraper":
            from src.crawlers.base_scraper import scrape_with_config
            scraper_config = {**payload.get("scraper_config", {}), "url": source_url}
            parsed_events = await scrape_with_config(scraper_config)
        else:
            error_msg = f"Unknown source type: {source_type}"
            if ingest_run_id:
                await update_ingest_run(ingest_run_id, "failed", error_message=error_msg)
            raise ValueError(error_msg)
    except Exception as e:
        error_msg = f"Feed parsing failed: {str(e)}"
        logger.error(error_msg)
        if dry_run:
            return _content_type_result({
                "source_id": source_id,
                "dry_run": True,
                "error": error_msg,
                "events_found": 0,
                "candidates": [],
            })
        if ingest_run_id:
            await update_ingest_run(ingest_run_id, "failed", error_message=error_msg)
        raise
    
    logger.info(f"Parsed {len(parsed_events)} events from {source_url}")
    
    if len(parsed_events) == 0:
        logger.warning(f"No events found in {source_url}")
        if ingest_run_id and not dry_run:
            await update_ingest_run(ingest_run_id, "success", events_found=0)
        result = {
            "source_id": source_id,
            "events_found": 0,
            "events_created": 0,
            "events_updated": 0,
            "events_unchanged": 0,
            "events_ignored": 0,
        }
        if dry_run:
            result["dry_run"] = True
            result["candidates"] = []
        return _content_type_result(result)
    
    # Progress: tell backend how many events we found (so UI can show "X Events gefunden")
    if ingest_run_id:
        await update_ingest_run(
            ingest_run_id, status="running",
            events_found=len(parsed_events),
            events_created=0, events_updated=0, events_skipped=0,
            progress_message="Events gefunden, bereite Import vor…",
        )
    # #region agent log
    _agent_log("worker.py:after_events_found", "ingest_run updated with events_found", {"events_found": len(parsed_events), "ingest_run_id": ingest_run_id, "source_id": source_id}, "H1")
    # #endregion

    # Step 2: In-Run Dedupe (remove duplicates within this fetch)
    deduplicator = create_parsed_event_deduplicator()
    unique_events = deduplicator.dedupe(parsed_events)
    
    logger.info(f"After in-run dedupe: {len(unique_events)} unique events (removed {deduplicator.stats.duplicates_removed})")
    
    # Step 2.5: Selective Deep-Fetch (enrich events by fetching their detail pages)
    # Only for RSS feeds (ICS usually has all data) and only if enabled
    if fetch_event_pages and source_type == "rss" and unique_events:
        if ingest_run_id:
            await update_ingest_run(ingest_run_id, progress_message="Anreichern (Detailseiten)…")
        logger.info("Running selective deep-fetch for RSS events...")
        try:
            # Configure deep-fetch (can be customized per source later)
            deep_fetch_config = DeepFetchConfig(
                require_location=True,
                require_end_datetime=True,
                require_image=True,
                require_price=False,  # Not all sources have price
                min_delay_per_domain_ms=1000,
                max_concurrent_requests=3,
            )
            unique_events = await selective_deep_fetch(
                unique_events,
                config=deep_fetch_config,
                max_fetches=50,  # Safety limit per run
                detail_page_config=detail_page_config,
            )
            # Count how many were enriched
            enriched_count = sum(1 for e in unique_events if e.deep_fetched)
            logger.info(f"Deep-fetch complete: {enriched_count}/{len(unique_events)} events enriched")
            # #region agent log
            _agent_log("worker.py:after_deep_fetch", "selective_deep_fetch done", {"enriched_count": enriched_count, "unique_events": len(unique_events)}, "H1")
            # #endregion
        except Exception as e:
            logger.warning(f"Deep-fetch failed (continuing with RSS data): {e}")
            # #region agent log
            _agent_log("worker.py:deep_fetch_error", "deep_fetch exception", {"error": str(e)}, "H1")
            # #endregion

    # Step 3: Convert to Candidates
    candidates = [
        parsed_event_to_candidate(event, source_type)
        for event in unique_events
    ]
    
    # Step 4: Optional AI Enrichment
    if enable_ai:
        if ingest_run_id:
            await update_ingest_run(ingest_run_id, progress_message="KI-Anreicherung…")
        logger.info("Running AI enrichment...")
        candidates = await enrich_with_ai(candidates)
    
    # Step 5: Dry-run → return candidates without ingesting
    if dry_run:
        logger.info("Dry-run: skipping batch ingest, returning candidates")
        return _content_type_result({
            "source_id": source_id,
            "dry_run": True,
            "events_found": len(parsed_events),
            "events_unique": len(unique_events),
            "duplicates_in_run": deduplicator.stats.duplicates_removed,
            "candidates": [c.to_dict() for c in candidates],
        })
    
    # Step 5 (normal): Batch Ingest to Backend
    if ingest_run_id:
        await update_ingest_run(ingest_run_id, progress_message="Importiere in Datenbank…")
    # #region agent log
    _agent_log("worker.py:before_send_batch", "calling send_batch_to_backend", {"candidates_count": len(candidates), "ingest_run_id": ingest_run_id}, "H2")
    # #endregion
    result = await send_batch_to_backend(source_id, candidates, ingest_run_id)
    summary = result.get("summary", {})

    if not result.get("success", True):
        err = result.get("error", "Batch ingest failed")
        if ingest_run_id:
            await update_ingest_run(
                ingest_run_id, "failed",
                events_found=len(parsed_events),
                events_created=0, events_updated=0, events_skipped=0,
                error_message=str(err)[:500],
            )
        raise RuntimeError(f"Backend batch ingest failed: {err}")

    # Finalize IngestRun with accumulated totals from ALL batches
    if ingest_run_id:
        await update_ingest_run(
            ingest_run_id, "success",
            events_found=len(parsed_events),
            events_created=summary.get("created", 0),
            events_updated=summary.get("updated", 0),
            events_skipped=summary.get("unchanged", 0) + summary.get("ignored", 0),
        )
        _agent_log("worker.py:final_ingest_run_update", "IngestRun finalized", {
            "ingest_run_id": ingest_run_id,
            "events_found": len(parsed_events),
            "created": summary.get("created", 0),
            "updated": summary.get("updated", 0),
            "unchanged": summary.get("unchanged", 0),
            "ignored": summary.get("ignored", 0),
        }, "H3")

    return _content_type_result({
        "source_id": source_id,
        "events_found": len(parsed_events),
        "events_unique": len(unique_events),
        "duplicates_in_run": deduplicator.stats.duplicates_removed,
        "events_created": summary.get("created", 0),
        "events_updated": summary.get("updated", 0),
        "events_unchanged": summary.get("unchanged", 0),
        "events_ignored": summary.get("ignored", 0),
        "run_id": result.get("run_id"),
    })


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
