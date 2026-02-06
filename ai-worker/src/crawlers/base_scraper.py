"""Base scraper with politeness and config-driven extraction.

Implements:
- robots.txt checking
- Rate limiting / throttling
- User-Agent header
- JSON-LD extraction as first priority
- CSS selector fallback
"""

import asyncio
import time
import logging
from dataclasses import dataclass, field
from typing import Optional, Callable, Any
from urllib.parse import urlparse, urljoin
from urllib.robotparser import RobotFileParser
from datetime import datetime
import hashlib

import httpx
from bs4 import BeautifulSoup

from .structured_data import StructuredDataExtractor, ExtractedEvent
from src.crawlers.feed_parser import ParsedEvent

logger = logging.getLogger(__name__)


@dataclass
class ScraperConfig:
    """
    Configuration for a scraper.
    
    Can be stored in database (Source.scraper_config) and loaded at runtime.
    """
    # Basic URL
    url: str
    page_type: str = "list"  # list, calendar, single
    
    # Sitemap-based discovery: if True, fetch event-like URLs from sitemap then scrape each
    use_sitemap: bool = False
    max_sitemap_urls: int = 50  # Max URLs to scrape when use_sitemap=True
    
    # Extraction strategy (in order of priority)
    strategies: list[str] = field(default_factory=lambda: ["jsonld", "microdata", "css"])
    
    # CSS/XPath Selectors (only used if jsonld/microdata fail)
    selectors: dict = field(default_factory=dict)
    # Expected keys: eventList, title, date, description, link, image
    
    # Date parsing
    date_format: Optional[str] = None  # e.g., "DD.MM.YYYY HH:mm"
    timezone: str = "Europe/Berlin"
    
    # Pagination
    pagination: Optional[dict] = None
    # Keys: type (next, loadmore, page-param), selector, maxPages
    
    # Politeness
    rate_limit_ms: int = 2000  # Minimum ms between requests
    respect_robots: bool = True
    user_agent: str = "Kiezling-Bot/1.0 (+https://kiezling.com/bot; contact@kiezling.com)"
    max_retries: int = 3
    timeout_seconds: int = 30


class PoliteScraper:
    """
    Base scraper with politeness features.
    
    Features:
    - robots.txt respect
    - Rate limiting
    - Proper User-Agent
    - Retry with backoff
    - JSON-LD extraction as default
    """
    
    def __init__(self, config: ScraperConfig):
        self.config = config
        self.robots: Optional[RobotFileParser] = None
        self.last_request_time: float = 0
        self.structured_extractor = StructuredDataExtractor()
        
        # Parse base URL
        parsed = urlparse(config.url)
        self.base_url = f"{parsed.scheme}://{parsed.netloc}"
        self.domain = parsed.netloc
    
    async def init(self):
        """Initialize scraper - load robots.txt if configured."""
        if self.config.respect_robots:
            await self._load_robots()
    
    async def _load_robots(self):
        """Load and parse robots.txt."""
        robots_url = f"{self.base_url}/robots.txt"
        
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.get(robots_url)
                if response.status_code == 200:
                    self.robots = RobotFileParser()
                    self.robots.parse(response.text.splitlines())
                    
                    # Check crawl-delay
                    crawl_delay = self.robots.crawl_delay(self.config.user_agent)
                    if crawl_delay:
                        # Use the larger of configured or robots.txt delay
                        self.config.rate_limit_ms = max(
                            self.config.rate_limit_ms,
                            int(crawl_delay * 1000)
                        )
                        logger.info(f"Using crawl-delay from robots.txt: {crawl_delay}s")
                    
                    logger.info(f"Loaded robots.txt for {self.domain}")
                else:
                    logger.debug(f"No robots.txt found at {robots_url}")
        except Exception as e:
            logger.warning(f"Failed to load robots.txt: {e}")
    
    def can_fetch(self, url: str) -> bool:
        """Check if URL is allowed by robots.txt."""
        if not self.robots:
            return True
        return self.robots.can_fetch(self.config.user_agent, url)
    
    async def _throttle(self):
        """Enforce rate limit between requests."""
        elapsed = time.time() - self.last_request_time
        wait = (self.config.rate_limit_ms / 1000) - elapsed
        
        if wait > 0:
            logger.debug(f"Throttling: waiting {wait:.2f}s")
            await asyncio.sleep(wait)
        
        self.last_request_time = time.time()
    
    async def fetch(self, url: str) -> Optional[str]:
        """
        Fetch a URL with politeness features.
        
        Args:
            url: URL to fetch
            
        Returns:
            HTML content or None if blocked/failed
        """
        # Check robots.txt
        if not self.can_fetch(url):
            logger.warning(f"Blocked by robots.txt: {url}")
            return None
        
        # Throttle
        await self._throttle()
        
        # Fetch with retries
        for attempt in range(self.config.max_retries):
            try:
                async with httpx.AsyncClient(
                    timeout=self.config.timeout_seconds,
                    follow_redirects=True
                ) as client:
                    response = await client.get(
                        url,
                        headers={
                            'User-Agent': self.config.user_agent,
                            'Accept': 'text/html,application/xhtml+xml',
                            'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
                        }
                    )
                    
                    if response.status_code == 429:
                        # Rate limited - wait and retry
                        wait = min(30, (attempt + 1) * 5)
                        logger.warning(f"Rate limited, waiting {wait}s")
                        await asyncio.sleep(wait)
                        continue
                    
                    if response.status_code == 403:
                        logger.error(f"Forbidden: {url}")
                        return None
                    
                    if response.status_code >= 400:
                        logger.warning(f"HTTP {response.status_code} for {url}")
                        return None
                    
                    return response.text
                    
            except httpx.TimeoutException:
                logger.warning(f"Timeout fetching {url} (attempt {attempt + 1})")
            except Exception as e:
                logger.error(f"Error fetching {url}: {e}")
                if attempt == self.config.max_retries - 1:
                    return None
        
        return None
    
    async def scrape(self) -> list[ParsedEvent]:
        """
        Scrape events from configured URL (or from sitemap-derived URLs if use_sitemap=True).
        
        Uses extraction strategies in order:
        1. JSON-LD / Microdata
        2. CSS Selectors (if configured)
        
        Returns:
            List of ParsedEvent objects
        """
        await self.init()
        
        if self.config.use_sitemap:
            return await self._scrape_via_sitemap()
        
        html = await self.fetch(self.config.url)
        if not html:
            return []
        
        events: list[ParsedEvent] = []
        
        # Try structured data first
        if "jsonld" in self.config.strategies or "microdata" in self.config.strategies:
            extracted = self.structured_extractor.extract(html)
            if extracted:
                events = [self._to_parsed_event(e) for e in extracted]
                logger.info(f"Extracted {len(events)} events via structured data")
                return events
        
        # Fall back to CSS selectors
        if "css" in self.config.strategies and self.config.selectors:
            events = await self._extract_with_css(html)
            if events:
                logger.info(f"Extracted {len(events)} events via CSS selectors")
                return events
        
        logger.warning(f"No events found on {self.config.url}")
        return []
    
    async def _scrape_via_sitemap(self) -> list[ParsedEvent]:
        """Discover URLs from sitemap, then fetch each page and extract events (structured data only)."""
        from .sitemap_parser import fetch_sitemap_urls
        
        urls = await fetch_sitemap_urls(
            self.config.url,
            sitemap_url=None,
            filter_event_like=True,
            max_urls=self.config.max_sitemap_urls,
            timeout=self.config.timeout_seconds,
        )
        if not urls:
            logger.warning("No event-like URLs found in sitemap")
            return []
        
        logger.info(f"Scraping {len(urls)} URLs from sitemap")
        all_events: list[ParsedEvent] = []
        seen_fingerprints: set[str] = set()
        
        for page_url in urls:
            await self._throttle()
            html = await self.fetch(page_url)
            if not html:
                continue
            if "jsonld" not in self.config.strategies and "microdata" not in self.config.strategies:
                continue
            extracted = self.structured_extractor.extract(html)
            for e in extracted:
                pe = self._to_parsed_event(e)
                if pe.fingerprint not in seen_fingerprints:
                    seen_fingerprints.add(pe.fingerprint)
                    all_events.append(pe)
        
        logger.info(f"Sitemap scrape: {len(all_events)} unique events from {len(urls)} pages")
        return all_events
    
    async def _extract_with_css(self, html: str) -> list[ParsedEvent]:
        """Extract events using CSS selectors."""
        soup = BeautifulSoup(html, 'lxml')
        events = []
        
        selectors = self.config.selectors
        event_list_selector = selectors.get('eventList', '.event')
        
        for item in soup.select(event_list_selector):
            try:
                # Title (required)
                title_el = item.select_one(selectors.get('title', 'h2, h3, .title'))
                if not title_el:
                    continue
                title = title_el.get_text(strip=True)
                
                # Date
                date_el = item.select_one(selectors.get('date', '.date, time'))
                start_datetime = None
                if date_el:
                    date_str = date_el.get('datetime') or date_el.get_text(strip=True)
                    start_datetime = self._parse_date(date_str)
                
                # Description
                desc_el = item.select_one(selectors.get('description', '.description, p'))
                description = desc_el.get_text(strip=True) if desc_el else None
                
                # Link
                link_el = item.select_one(selectors.get('link', 'a'))
                link = None
                if link_el:
                    href = link_el.get('href')
                    if href:
                        link = urljoin(self.config.url, href)
                
                # Image
                img_el = item.select_one(selectors.get('image', 'img'))
                image_url = None
                if img_el:
                    src = img_el.get('src') or img_el.get('data-src')
                    if src:
                        image_url = urljoin(self.config.url, src)
                
                # Create event
                fingerprint = self._compute_fingerprint(title, start_datetime)
                external_id = link or fingerprint
                
                events.append(ParsedEvent(
                    external_id=external_id[:255],
                    title=title[:200],
                    description=description[:5000] if description else None,
                    start_datetime=start_datetime,
                    end_datetime=None,
                    location_address=None,
                    source_url=link or self.config.url,
                    raw_data={
                        'title': title,
                        'description': description,
                        'date': str(start_datetime) if start_datetime else None,
                        'link': link,
                        'image': image_url,
                    },
                    fingerprint=fingerprint,
                ))
                
            except Exception as e:
                logger.debug(f"Error extracting event: {e}")
                continue
        
        return events
    
    def _to_parsed_event(self, extracted: ExtractedEvent) -> ParsedEvent:
        """Convert ExtractedEvent to ParsedEvent (full compatibility with feed_parser.ParsedEvent)."""
        fingerprint = self._compute_fingerprint(
            extracted.title,
            extracted.start_datetime,
            extracted.location_address
        )
        
        return ParsedEvent(
            external_id=(extracted.url or fingerprint)[:255],
            title=extracted.title[:200],
            description=extracted.description[:5000] if extracted.description else None,
            start_datetime=extracted.start_datetime,
            end_datetime=extracted.end_datetime,
            location_address=extracted.location_address,
            source_url=extracted.url or self.config.url,
            raw_data={
                'title': extracted.title,
                'description': extracted.description,
                'start': str(extracted.start_datetime) if extracted.start_datetime else None,
                'end': str(extracted.end_datetime) if extracted.end_datetime else None,
                'location_name': extracted.location_name,
                'location_address': extracted.location_address,
                'lat': extracted.lat,
                'lng': extracted.lng,
                'image': extracted.image_url,
                'organizer': extracted.organizer_name,
                'price': extracted.price,
                'currency': extracted.currency,
            },
            fingerprint=fingerprint,
            image_url=extracted.image_url,
            location_name=extracted.location_name,
            lat=extracted.lat,
            lng=extracted.lng,
            organizer_name=extracted.organizer_name,
            price=extracted.price,
            currency=extracted.currency,
        )
    
    def _compute_fingerprint(
        self,
        title: str,
        start_datetime: Optional[datetime] = None,
        location: Optional[str] = None
    ) -> str:
        """Compute fingerprint for deduplication."""
        title_norm = title.lower().strip()
        date_str = start_datetime.strftime("%Y-%m-%d") if start_datetime else ""
        loc_norm = location[:50].lower() if location else ""
        
        key = f"{title_norm}|{date_str}|{loc_norm}"
        return hashlib.sha256(key.encode()).hexdigest()[:32]
    
    def _parse_date(self, date_str: str) -> Optional[datetime]:
        """Parse date string to datetime."""
        if not date_str:
            return None
        
        # Try ISO format first
        try:
            return datetime.fromisoformat(date_str.replace('Z', '+00:00'))
        except ValueError:
            pass
        
        # Try common German formats
        import re
        from dateutil import parser as date_parser
        
        try:
            # Handle "DD.MM.YYYY" format
            if re.match(r'\d{1,2}\.\d{1,2}\.\d{4}', date_str):
                return date_parser.parse(date_str, dayfirst=True)
            return date_parser.parse(date_str)
        except Exception:
            return None


async def scrape_with_config(config: dict) -> list[ParsedEvent]:
    """
    Convenience function to scrape with a config dict.
    
    Args:
        config: Configuration dict (from database or JSON). Must contain 'url'.
        
    Returns:
        List of ParsedEvent objects
    """
    scraper_config = ScraperConfig(
        url=config['url'],
        page_type=config.get('page_type', 'list'),
        use_sitemap=config.get('use_sitemap', False),
        max_sitemap_urls=config.get('max_sitemap_urls', 50),
        strategies=config.get('strategies', ['jsonld', 'microdata', 'css']),
        selectors=config.get('selectors', {}),
        date_format=config.get('date_format'),
        timezone=config.get('timezone', 'Europe/Berlin'),
        pagination=config.get('pagination'),
        rate_limit_ms=config.get('rate_limit_ms', 2000),
        respect_robots=config.get('respect_robots', True),
    )
    
    scraper = PoliteScraper(scraper_config)
    return await scraper.scrape()
