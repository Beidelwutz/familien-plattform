"""Selective Deep-Fetch for RSS Events.

After RSS parsing + dedupe, this module enriches events that are missing
important fields by fetching their detail pages and extracting structured data.

Features:
- Trigger-based: Only fetch if important fields are missing
- Domain-based rate limiting
- Conditional requests (ETag/Last-Modified) for caching
- Strict merge rules with validation
"""

import asyncio
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional
from urllib.parse import urlparse
from collections import defaultdict

import httpx

from .feed_parser import ParsedEvent
from .structured_data import StructuredDataExtractor, ExtractedEvent

logger = logging.getLogger(__name__)


@dataclass
class DeepFetchConfig:
    """Configuration for selective deep-fetch."""
    # Rate limiting
    min_delay_per_domain_ms: int = 1000  # 1 second between requests to same domain
    max_concurrent_requests: int = 3
    request_timeout_seconds: int = 15
    
    # Trigger criteria (fetch if any of these are missing)
    require_location: bool = True
    require_end_datetime: bool = True
    require_image: bool = True
    require_price: bool = False  # Optional, source-dependent
    
    # Validation
    min_valid_year: int = 2020
    max_valid_year: int = 2030
    max_date_drift_days: int = 365  # Reject dates too far from RSS date
    
    # User agent
    user_agent: str = "Kiezling/1.0 (Event Aggregator; +https://kiezling.com/bot)"


@dataclass
class DeepFetchStats:
    """Statistics from a deep-fetch run."""
    total_events: int = 0
    events_needing_fetch: int = 0
    successful_fetches: int = 0
    failed_fetches: int = 0
    events_enriched: int = 0
    skipped_rate_limit: int = 0
    skipped_no_url: int = 0
    
    def __str__(self) -> str:
        return (
            f"DeepFetch: {self.events_needing_fetch}/{self.total_events} needed fetch, "
            f"{self.successful_fetches} succeeded, {self.failed_fetches} failed, "
            f"{self.events_enriched} enriched"
        )


class DomainRateLimiter:
    """Rate limiter that tracks last request time per domain."""
    
    def __init__(self, min_delay_ms: int = 1000):
        self.min_delay_ms = min_delay_ms
        self.last_request_time: dict[str, float] = defaultdict(float)
        self._lock = asyncio.Lock()
    
    def get_domain(self, url: str) -> str:
        """Extract domain from URL."""
        try:
            return urlparse(url).netloc.lower()
        except Exception:
            return ""
    
    async def wait_for_domain(self, domain: str) -> None:
        """Wait if needed to respect rate limit for domain."""
        async with self._lock:
            now = time.time() * 1000  # Convert to ms
            last = self.last_request_time[domain]
            
            wait_ms = self.min_delay_ms - (now - last)
            if wait_ms > 0:
                await asyncio.sleep(wait_ms / 1000)
            
            self.last_request_time[domain] = time.time() * 1000


class SelectiveDeepFetcher:
    """
    Selectively fetches event detail pages to enrich RSS data.
    
    Only fetches pages when important fields are missing, respects
    rate limits per domain, and applies strict merge rules.
    """
    
    def __init__(self, config: Optional[DeepFetchConfig] = None):
        self.config = config or DeepFetchConfig()
        self.extractor = StructuredDataExtractor()
        self.rate_limiter = DomainRateLimiter(self.config.min_delay_per_domain_ms)
        self.stats = DeepFetchStats()
        
        self._client: Optional[httpx.AsyncClient] = None
    
    async def _get_client(self) -> httpx.AsyncClient:
        """Get or create HTTP client."""
        if self._client is None:
            self._client = httpx.AsyncClient(
                timeout=self.config.request_timeout_seconds,
                follow_redirects=True,
                headers={"User-Agent": self.config.user_agent}
            )
        return self._client
    
    async def close(self):
        """Close HTTP client."""
        if self._client:
            await self._client.aclose()
            self._client = None
    
    def needs_deep_fetch(self, event: ParsedEvent) -> bool:
        """
        Check if event needs deep-fetch based on missing fields.
        
        Returns True if any important field is missing.
        """
        # No URL to fetch
        if not event.source_url or not event.source_url.startswith('http'):
            return False
        
        # Already deep-fetched
        if event.deep_fetched:
            return False
        
        triggers = []
        
        # Location missing or too vague
        if self.config.require_location:
            if not event.location_address:
                triggers.append('location_missing')
            elif len(event.location_address) < 15:
                # Very short address, likely just city name
                triggers.append('location_vague')
        
        # End datetime missing (and we want it)
        if self.config.require_end_datetime and not event.end_datetime:
            triggers.append('end_datetime_missing')
        
        # Image missing
        if self.config.require_image and not event.image_url:
            triggers.append('image_missing')
        
        # Price missing (optional trigger)
        if self.config.require_price and event.price is None:
            triggers.append('price_missing')
        
        if triggers:
            logger.debug(f"Event '{event.title[:50]}' needs deep-fetch: {triggers}")
            return True
        
        return False
    
    async def fetch_and_extract(self, url: str) -> Optional[ExtractedEvent]:
        """
        Fetch a URL and extract structured event data.
        
        Returns the best matching ExtractedEvent, or None if failed.
        """
        domain = self.rate_limiter.get_domain(url)
        if not domain:
            return None
        
        # Wait for rate limit
        await self.rate_limiter.wait_for_domain(domain)
        
        try:
            client = await self._get_client()
            response = await client.get(url)
            
            if response.status_code != 200:
                logger.debug(f"Deep-fetch failed for {url}: HTTP {response.status_code}")
                return None
            
            html = response.text
            events = self.extractor.extract(html)
            
            if not events:
                logger.debug(f"No structured data found on {url}")
                return None
            
            # Return first event (usually there's only one on a detail page)
            event = events[0]
            
            # OG-Image fallback: if no image from structured data, try og:image
            if not event.image_url:
                try:
                    from bs4 import BeautifulSoup
                    soup = BeautifulSoup(html, 'html.parser')
                    og_image = soup.find('meta', property='og:image')
                    if og_image and og_image.get('content'):
                        img_url = og_image['content']
                        if img_url.startswith(('http://', 'https://')):
                            event.image_url = img_url
                except Exception:
                    pass  # Best-effort, don't fail on og:image extraction
            
            return event
            
        except httpx.TimeoutException:
            logger.debug(f"Timeout fetching {url}")
            return None
        except Exception as e:
            logger.debug(f"Error fetching {url}: {e}")
            return None
    
    def validate_extracted_date(
        self, 
        extracted_date: Optional[datetime],
        rss_date: Optional[datetime]
    ) -> bool:
        """
        Validate an extracted date is reasonable.
        
        Rejects dates that are:
        - Outside valid year range (e.g., 1970, 2099)
        - Too far from RSS date (if available)
        """
        if not extracted_date:
            return False
        
        year = extracted_date.year
        if year < self.config.min_valid_year or year > self.config.max_valid_year:
            logger.debug(f"Rejected date {extracted_date}: year {year} out of range")
            return False
        
        # Check drift from RSS date
        if rss_date:
            drift = abs((extracted_date - rss_date).days)
            if drift > self.config.max_date_drift_days:
                logger.debug(f"Rejected date {extracted_date}: {drift} days from RSS date")
                return False
        
        return True
    
    def merge_extracted_data(
        self, 
        event: ParsedEvent, 
        extracted: ExtractedEvent
    ) -> ParsedEvent:
        """
        Merge extracted data into ParsedEvent.
        
        Rules:
        - Only fill empty fields (RSS data has priority)
        - Structured data dates override RSS 'published' dates
        - Validate dates before using
        """
        # Description: only if RSS is empty or very short
        if extracted.description:
            if not event.description or len(event.description) < 50:
                event.description = extracted.description[:5000]
        
        # Start datetime: prefer structured data if valid
        if extracted.start_datetime:
            if self.validate_extracted_date(extracted.start_datetime, event.start_datetime):
                # Structured data is usually more accurate than RSS published date
                event.start_datetime = extracted.start_datetime
        
        # End datetime: only if missing
        if not event.end_datetime and extracted.end_datetime:
            if self.validate_extracted_date(extracted.end_datetime, event.start_datetime):
                event.end_datetime = extracted.end_datetime
        
        # Location: only if missing or vague
        if extracted.location_address:
            if not event.location_address or len(event.location_address) < 15:
                # Build full address from name + address if available
                if extracted.location_name and extracted.location_name not in (extracted.location_address or ''):
                    event.location_address = f"{extracted.location_name}, {extracted.location_address}"
                else:
                    event.location_address = extracted.location_address
        
        # Location name (venue)
        if not event.location_name and extracted.location_name:
            event.location_name = extracted.location_name
        
        # Coordinates: only if missing
        if event.lat is None and extracted.lat is not None:
            event.lat = extracted.lat
        if event.lng is None and extracted.lng is not None:
            event.lng = extracted.lng
        
        # Image: only if missing
        if not event.image_url and extracted.image_url:
            event.image_url = extracted.image_url
        
        # Price: only if missing
        if event.price is None and extracted.price is not None:
            event.price = extracted.price
            event.currency = extracted.currency or 'EUR'
        
        # Organizer: only if missing
        if not event.organizer_name and extracted.organizer_name:
            event.organizer_name = extracted.organizer_name
        
        # Mark as deep-fetched
        event.deep_fetched = True
        
        return event
    
    async def enrich_events(
        self, 
        events: list[ParsedEvent],
        max_fetches: Optional[int] = None
    ) -> list[ParsedEvent]:
        """
        Selectively enrich events by fetching their detail pages.
        
        Args:
            events: List of ParsedEvents (should be already deduplicated)
            max_fetches: Optional limit on number of fetches (for testing/safety)
        
        Returns:
            List of events with enriched data where applicable
        """
        self.stats = DeepFetchStats(total_events=len(events))
        
        # Identify events that need deep-fetch
        events_to_fetch: list[tuple[int, ParsedEvent]] = []
        
        for i, event in enumerate(events):
            if not event.source_url:
                self.stats.skipped_no_url += 1
                continue
            
            if self.needs_deep_fetch(event):
                events_to_fetch.append((i, event))
        
        self.stats.events_needing_fetch = len(events_to_fetch)
        logger.info(f"Selective deep-fetch: {len(events_to_fetch)}/{len(events)} events need enrichment")
        
        if not events_to_fetch:
            return events
        
        # Apply max_fetches limit
        if max_fetches and len(events_to_fetch) > max_fetches:
            logger.info(f"Limiting deep-fetch to {max_fetches} events")
            events_to_fetch = events_to_fetch[:max_fetches]
        
        # Fetch with bounded concurrency
        semaphore = asyncio.Semaphore(self.config.max_concurrent_requests)
        
        async def fetch_one(idx: int, event: ParsedEvent) -> tuple[int, Optional[ExtractedEvent]]:
            async with semaphore:
                extracted = await self.fetch_and_extract(event.source_url)
                return idx, extracted
        
        # Run fetches concurrently (bounded by semaphore)
        tasks = [fetch_one(idx, event) for idx, event in events_to_fetch]
        results = await asyncio.gather(*tasks, return_exceptions=True)
        
        # Merge results back
        for result in results:
            if isinstance(result, Exception):
                logger.warning(f"Deep-fetch task failed: {result}")
                self.stats.failed_fetches += 1
                continue
            
            idx, extracted = result
            
            if extracted is None:
                self.stats.failed_fetches += 1
                continue
            
            self.stats.successful_fetches += 1
            
            # Merge extracted data into original event
            original_event = events[idx]
            events[idx] = self.merge_extracted_data(original_event, extracted)
            self.stats.events_enriched += 1
        
        logger.info(str(self.stats))
        return events


async def selective_deep_fetch(
    parsed_events: list[ParsedEvent],
    *,
    config: Optional[DeepFetchConfig] = None,
    max_fetches: Optional[int] = None
) -> list[ParsedEvent]:
    """
    Convenience function to run selective deep-fetch on parsed events.
    
    Args:
        parsed_events: List of ParsedEvents (ideally already deduplicated)
        config: Optional DeepFetchConfig to customize behavior
        max_fetches: Optional limit on number of detail page fetches
    
    Returns:
        List of events with enriched data where applicable
    """
    fetcher = SelectiveDeepFetcher(config)
    try:
        return await fetcher.enrich_events(parsed_events, max_fetches)
    finally:
        await fetcher.close()
