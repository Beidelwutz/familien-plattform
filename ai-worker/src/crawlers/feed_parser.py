"""Feed parser for RSS, ICS, and other structured formats.

Supports:
- RSS/Atom feeds
- ICS calendar feeds
- Conditional requests (ETag, Last-Modified)
- Fingerprint computation for deduplication
"""

from dataclasses import dataclass
from typing import Optional, Tuple
from datetime import datetime
import hashlib
import logging
import httpx
import feedparser
from icalendar import Calendar
from dateutil import parser as date_parser

logger = logging.getLogger(__name__)


@dataclass
class ParsedEvent:
    """Parsed event from a feed."""
    external_id: str
    title: str
    description: Optional[str]
    start_datetime: Optional[datetime]
    end_datetime: Optional[datetime]
    location_address: Optional[str]
    source_url: Optional[str]
    raw_data: dict
    fingerprint: str
    # Extended fields (populated by deep-fetch from event page)
    image_url: Optional[str] = None
    location_name: Optional[str] = None
    lat: Optional[float] = None
    lng: Optional[float] = None
    organizer_name: Optional[str] = None
    price: Optional[float] = None
    currency: Optional[str] = None
    # Flag to track if deep-fetch was attempted/successful
    deep_fetched: bool = False


@dataclass
class FetchResult:
    """Result of a conditional fetch."""
    content: Optional[str]
    etag: Optional[str]
    last_modified: Optional[str]
    was_modified: bool  # False if 304 Not Modified


class FeedParser:
    """Parser for RSS and ICS feeds with conditional request support."""
    
    def __init__(self):
        self.client = httpx.AsyncClient(
            timeout=30.0,
            follow_redirects=True,
            headers={
                "User-Agent": "Kiezling/1.0 (Event Aggregator; +https://kiezling.com/bot)"
            }
        )
    
    async def fetch_with_conditional(
        self,
        url: str,
        etag: Optional[str] = None,
        last_modified: Optional[str] = None
    ) -> FetchResult:
        """
        Fetch URL with conditional request headers.
        
        Uses ETag and Last-Modified to avoid re-downloading unchanged content.
        
        Args:
            url: URL to fetch
            etag: Previous ETag header value
            last_modified: Previous Last-Modified header value
            
        Returns:
            FetchResult with content (None if 304), new headers, and was_modified flag
        """
        headers = {}
        
        if etag:
            headers["If-None-Match"] = etag
        if last_modified:
            headers["If-Modified-Since"] = last_modified
        
        response = await self.client.get(url, headers=headers)
        
        # Check for 304 Not Modified
        if response.status_code == 304:
            logger.info(f"Feed not modified: {url}")
            return FetchResult(
                content=None,
                etag=etag,
                last_modified=last_modified,
                was_modified=False
            )
        
        response.raise_for_status()
        
        # Get new cache headers
        new_etag = response.headers.get("ETag")
        new_last_modified = response.headers.get("Last-Modified")
        
        logger.debug(f"Feed fetched: {url}, ETag: {new_etag}, Last-Modified: {new_last_modified}")
        
        return FetchResult(
            content=response.text,
            etag=new_etag,
            last_modified=new_last_modified,
            was_modified=True
        )
    
    async def parse_rss(
        self, 
        url: str,
        etag: Optional[str] = None,
        last_modified: Optional[str] = None
    ) -> Tuple[list[ParsedEvent], Optional[str], Optional[str], bool]:
        """
        Parse RSS/Atom feed with conditional request support.
        
        Args:
            url: Feed URL
            etag: Previous ETag value
            last_modified: Previous Last-Modified value
            
        Returns:
            Tuple of (events, new_etag, new_last_modified, was_modified)
        """
        fetch_result = await self.fetch_with_conditional(url, etag, last_modified)
        
        if not fetch_result.was_modified:
            return [], fetch_result.etag, fetch_result.last_modified, False
        
        feed = feedparser.parse(fetch_result.content)
        events = []
        
        for entry in feed.entries:
            try:
                event = self._parse_rss_entry(entry, url)
                if event:
                    events.append(event)
            except Exception as e:
                logger.warning(f"Error parsing RSS entry: {e}")
                continue
        
        return events, fetch_result.etag, fetch_result.last_modified, True
    
    async def parse_rss_simple(self, url: str) -> list[ParsedEvent]:
        """Parse RSS/Atom feed without conditional request (backwards compatible)."""
        events, _, _, _ = await self.parse_rss(url)
        return events
    
    def _parse_rss_entry(self, entry: dict, source_url: str) -> Optional[ParsedEvent]:
        """Parse a single RSS entry."""
        title = entry.get("title", "").strip()
        if not title:
            return None
        
        # Try to get event date
        start_datetime = None
        if entry.get("published_parsed"):
            start_datetime = datetime(*entry.published_parsed[:6])
        elif entry.get("updated_parsed"):
            start_datetime = datetime(*entry.updated_parsed[:6])
        
        # Get description
        description = ""
        if entry.get("summary"):
            description = entry.summary
        elif entry.get("description"):
            description = entry.description
        
        # Clean HTML from description
        description = self._strip_html(description)
        
        # Get link
        link = entry.get("link", "")
        
        # Generate external ID
        external_id = entry.get("id") or entry.get("link") or hashlib.md5(title.encode()).hexdigest()
        
        # Compute fingerprint
        fingerprint = self._compute_fingerprint(title, start_datetime)
        
        return ParsedEvent(
            external_id=external_id[:255],
            title=title[:200],
            description=description[:5000] if description else None,
            start_datetime=start_datetime,
            end_datetime=None,
            location_address=None,  # RSS typically doesn't have location
            source_url=link[:500] if link else source_url[:500],
            raw_data=dict(entry),
            fingerprint=fingerprint
        )
    
    async def parse_ics(
        self,
        url: str,
        etag: Optional[str] = None,
        last_modified: Optional[str] = None
    ) -> Tuple[list[ParsedEvent], Optional[str], Optional[str], bool]:
        """
        Parse ICS calendar feed with conditional request support.
        
        Args:
            url: Feed URL
            etag: Previous ETag value
            last_modified: Previous Last-Modified value
            
        Returns:
            Tuple of (events, new_etag, new_last_modified, was_modified)
        """
        fetch_result = await self.fetch_with_conditional(url, etag, last_modified)
        
        if not fetch_result.was_modified:
            return [], fetch_result.etag, fetch_result.last_modified, False
        
        # icalendar chokes on empty or invalid lines ("Content line could not be parsed into parts: ''")
        raw = fetch_result.content or ""
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8", errors="replace")
        raw = raw.replace("\r\n", "\n").replace("\r", "\n")
        # Keep only lines that look valid: have "name:value" (contain ":") or are folding continuation (start with space/tab)
        lines = [
            line for line in raw.splitlines()
            if line.strip() and (":" in line or line.startswith((" ", "\t")))
        ]
        content = "\n".join(lines)
        cal = Calendar.from_ical(content)
        events = []
        
        for component in cal.walk():
            if component.name == "VEVENT":
                try:
                    event = self._parse_ics_event(component, url)
                    if event:
                        events.append(event)
                except Exception as e:
                    logger.warning(f"Error parsing ICS event: {e}")
                    continue
        
        return events, fetch_result.etag, fetch_result.last_modified, True
    
    async def parse_ics_simple(self, url: str) -> list[ParsedEvent]:
        """Parse ICS calendar feed without conditional request (backwards compatible)."""
        events, _, _, _ = await self.parse_ics(url)
        return events
    
    def _parse_ics_event(self, component, source_url: str) -> Optional[ParsedEvent]:
        """Parse a single ICS event."""
        title = str(component.get("SUMMARY", "")).strip()
        if not title:
            return None
        
        # Get dates
        start_datetime = None
        end_datetime = None
        
        dtstart = component.get("DTSTART")
        if dtstart:
            start_datetime = dtstart.dt
            if hasattr(start_datetime, 'date'):
                # It's a datetime
                pass
            else:
                # It's just a date, convert to datetime
                start_datetime = datetime.combine(start_datetime, datetime.min.time())
        
        dtend = component.get("DTEND")
        if dtend:
            end_datetime = dtend.dt
            if not hasattr(end_datetime, 'hour'):
                end_datetime = datetime.combine(end_datetime, datetime.min.time())
        
        # Get description
        description = str(component.get("DESCRIPTION", ""))
        
        # Get location
        location = str(component.get("LOCATION", ""))
        
        # Get URL
        url = str(component.get("URL", "")) or source_url
        
        # Generate external ID
        uid = str(component.get("UID", ""))
        external_id = uid or hashlib.md5(f"{title}{start_datetime}".encode()).hexdigest()
        
        # Compute fingerprint
        fingerprint = self._compute_fingerprint(title, start_datetime, location)
        
        return ParsedEvent(
            external_id=external_id[:255],
            title=title[:200],
            description=description[:5000] if description else None,
            start_datetime=start_datetime,
            end_datetime=end_datetime,
            location_address=location[:300] if location else None,
            source_url=url[:500] if url else source_url[:500],
            raw_data={
                "uid": uid,
                "summary": title,
                "description": description,
                "location": location,
                "dtstart": str(start_datetime) if start_datetime else None,
                "dtend": str(end_datetime) if end_datetime else None,
            },
            fingerprint=fingerprint
        )
    
    def _compute_fingerprint(
        self, 
        title: str, 
        start_datetime: Optional[datetime] = None,
        location: Optional[str] = None
    ) -> str:
        """Compute fingerprint for deduplication."""
        # Normalize title
        title_norm = title.lower().strip()
        
        # Date string
        date_str = ""
        if start_datetime:
            date_str = start_datetime.strftime("%Y-%m-%d")
        
        # Location simplified
        loc_norm = ""
        if location:
            loc_norm = location.lower().strip()[:50]
        
        # Compute hash
        key = f"{title_norm}|{date_str}|{loc_norm}"
        return hashlib.sha256(key.encode()).hexdigest()[:32]
    
    def _strip_html(self, text: str) -> str:
        """Remove HTML tags from text."""
        import re
        clean = re.compile('<.*?>')
        return re.sub(clean, '', text).strip()
    
    async def close(self):
        """Close HTTP client."""
        await self.client.aclose()
