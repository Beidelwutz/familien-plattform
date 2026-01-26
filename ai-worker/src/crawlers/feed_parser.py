"""Feed parser for RSS, ICS, and other structured formats."""

from dataclasses import dataclass
from typing import Optional
from datetime import datetime
import hashlib
import httpx
import feedparser
from icalendar import Calendar
from dateutil import parser as date_parser


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


class FeedParser:
    """Parser for RSS and ICS feeds."""
    
    def __init__(self):
        self.client = httpx.AsyncClient(
            timeout=30.0,
            follow_redirects=True,
            headers={
                "User-Agent": "FamilienLokal/1.0 (Event Aggregator)"
            }
        )
    
    async def parse_rss(self, url: str) -> list[ParsedEvent]:
        """Parse RSS/Atom feed."""
        response = await self.client.get(url)
        response.raise_for_status()
        
        feed = feedparser.parse(response.text)
        events = []
        
        for entry in feed.entries:
            try:
                event = self._parse_rss_entry(entry, url)
                if event:
                    events.append(event)
            except Exception as e:
                print(f"Error parsing RSS entry: {e}")
                continue
        
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
    
    async def parse_ics(self, url: str) -> list[ParsedEvent]:
        """Parse ICS calendar feed."""
        response = await self.client.get(url)
        response.raise_for_status()
        
        cal = Calendar.from_ical(response.text)
        events = []
        
        for component in cal.walk():
            if component.name == "VEVENT":
                try:
                    event = self._parse_ics_event(component, url)
                    if event:
                        events.append(event)
                except Exception as e:
                    print(f"Error parsing ICS event: {e}")
                    continue
        
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
