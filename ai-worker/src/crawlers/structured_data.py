"""Structured data extractors for event pages.

Extracts events from JSON-LD, Microdata, and OpenGraph.
JSON-LD should be the first choice as it's the most reliable.
Falls back to heuristic HTML text extraction when no structured data is found.
"""

import json
import logging
import re
from typing import Optional
from dataclasses import dataclass
from datetime import datetime

from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)


@dataclass
class ExtractedEvent:
    """Event extracted from structured data."""
    title: str
    description: Optional[str] = None
    start_datetime: Optional[datetime] = None
    end_datetime: Optional[datetime] = None
    location_name: Optional[str] = None
    location_address: Optional[str] = None
    lat: Optional[float] = None
    lng: Optional[float] = None
    url: Optional[str] = None
    image_url: Optional[str] = None
    organizer_name: Optional[str] = None
    price: Optional[float] = None
    currency: Optional[str] = None


class StructuredDataExtractor:
    """
    Extracts events from structured data on web pages.
    
    Supports:
    - JSON-LD (Schema.org Event, SocialEvent, ChildrensEvent)
    - Microdata (itemtype Event)
    - OpenGraph (og:event)
    
    Usage:
        extractor = StructuredDataExtractor()
        events = extractor.extract(html_content)
    """
    
    # Schema.org event types to look for
    EVENT_TYPES = [
        'Event', 
        'SocialEvent', 
        'ChildrensEvent', 
        'MusicEvent', 
        'TheaterEvent',
        'SportsEvent',
        'ExhibitionEvent',
        'Festival',
        'CourseInstance',
    ]
    
    def extract(self, html: str) -> list[ExtractedEvent]:
        """
        Extract events from HTML using all available methods.
        
        Priority:
        1. JSON-LD (most reliable)
        2. Microdata
        3. HTML text heuristic (German dates, addresses from visible text)
        
        Args:
            html: HTML content of the page
            
        Returns:
            List of extracted events, empty if none found
        """
        soup = BeautifulSoup(html, 'lxml')
        
        # 1. Try JSON-LD first
        events = self._extract_jsonld(soup)
        if events:
            logger.info(f"Extracted {len(events)} events from JSON-LD")
            return events
        
        # 2. Try Microdata
        events = self._extract_microdata(soup)
        if events:
            logger.info(f"Extracted {len(events)} events from Microdata")
            return events
        
        # 3. Try heuristic HTML text extraction (German dates, addresses)
        events = self._extract_from_html_text(soup)
        if events:
            logger.info(f"Extracted {len(events)} events from HTML text (heuristic)")
            return events
        
        # 4. No data found
        logger.debug("No structured or heuristic data found on page")
        return []
    
    def _extract_jsonld(self, soup: BeautifulSoup) -> list[ExtractedEvent]:
        """Extract events from JSON-LD scripts."""
        events = []
        
        for script in soup.find_all('script', type='application/ld+json'):
            try:
                content = script.string
                if not content:
                    continue
                
                data = json.loads(content)
                
                # Handle @graph container
                if isinstance(data, dict) and '@graph' in data:
                    items = data['@graph']
                elif isinstance(data, list):
                    items = data
                else:
                    items = [data]
                
                for item in items:
                    if not isinstance(item, dict):
                        continue
                    
                    item_type = item.get('@type', '')
                    
                    # Handle type as list
                    if isinstance(item_type, list):
                        item_type = item_type[0] if item_type else ''
                    
                    if item_type in self.EVENT_TYPES:
                        event = self._parse_jsonld_event(item)
                        if event:
                            events.append(event)
                            
            except json.JSONDecodeError as e:
                logger.debug(f"Failed to parse JSON-LD: {e}")
            except Exception as e:
                logger.debug(f"Error processing JSON-LD: {e}")
        
        return events
    
    def _parse_jsonld_event(self, data: dict) -> Optional[ExtractedEvent]:
        """Parse a single JSON-LD event."""
        title = data.get('name') or data.get('headline')
        if not title:
            return None
        
        # Parse dates
        start_datetime = self._parse_datetime(data.get('startDate'))
        end_datetime = self._parse_datetime(data.get('endDate'))
        
        # Parse location
        location = data.get('location', {})
        location_name = None
        location_address = None
        lat = None
        lng = None
        
        if isinstance(location, dict):
            location_name = location.get('name')
            
            # Address can be string or PostalAddress
            address = location.get('address')
            if isinstance(address, str):
                location_address = address
            elif isinstance(address, dict):
                parts = [
                    address.get('streetAddress'),
                    address.get('postalCode'),
                    address.get('addressLocality'),
                ]
                location_address = ', '.join(p for p in parts if p)
            
            # Geo coordinates
            geo = location.get('geo', {})
            if isinstance(geo, dict):
                lat = self._parse_float(geo.get('latitude'))
                lng = self._parse_float(geo.get('longitude'))
        elif isinstance(location, str):
            location_address = location
        
        # Parse price
        price = None
        currency = None
        offers = data.get('offers')
        if isinstance(offers, dict):
            price = self._parse_float(offers.get('price'))
            currency = offers.get('priceCurrency', 'EUR')
        elif isinstance(offers, list) and offers:
            price = self._parse_float(offers[0].get('price'))
            currency = offers[0].get('priceCurrency', 'EUR')
        
        # Parse organizer
        organizer = data.get('organizer', {})
        organizer_name = None
        if isinstance(organizer, dict):
            organizer_name = organizer.get('name')
        elif isinstance(organizer, str):
            organizer_name = organizer
        
        # Image
        image_url = None
        image = data.get('image')
        if isinstance(image, str):
            image_url = image
        elif isinstance(image, dict):
            image_url = image.get('url')
        elif isinstance(image, list) and image:
            first_img = image[0]
            image_url = first_img if isinstance(first_img, str) else first_img.get('url')
        
        return ExtractedEvent(
            title=title,
            description=data.get('description'),
            start_datetime=start_datetime,
            end_datetime=end_datetime,
            location_name=location_name,
            location_address=location_address,
            lat=lat,
            lng=lng,
            url=data.get('url'),
            image_url=image_url,
            organizer_name=organizer_name,
            price=price,
            currency=currency,
        )
    
    def _extract_microdata(self, soup: BeautifulSoup) -> list[ExtractedEvent]:
        """Extract events from Microdata (itemtype)."""
        events = []
        
        for item in soup.find_all(itemtype=True):
            itemtype = item.get('itemtype', '')
            
            # Check if it's an event type
            if not any(f'schema.org/{t}' in itemtype for t in self.EVENT_TYPES):
                continue
            
            try:
                event = self._parse_microdata_event(item)
                if event:
                    events.append(event)
            except Exception as e:
                logger.debug(f"Error parsing microdata: {e}")
        
        return events
    
    def _parse_microdata_event(self, item) -> Optional[ExtractedEvent]:
        """Parse a single Microdata event."""
        def get_prop(name: str) -> Optional[str]:
            el = item.find(itemprop=name)
            if not el:
                return None
            # Try content attribute first, then datetime, then text
            return el.get('content') or el.get('datetime') or el.get_text(strip=True)
        
        title = get_prop('name')
        if not title:
            return None
        
        return ExtractedEvent(
            title=title,
            description=get_prop('description'),
            start_datetime=self._parse_datetime(get_prop('startDate')),
            end_datetime=self._parse_datetime(get_prop('endDate')),
            location_name=get_prop('location'),
            location_address=get_prop('address'),
            url=get_prop('url'),
            image_url=get_prop('image'),
        )
    
    # ------------------------------------------------------------------ #
    #  Heuristic HTML text extraction (fallback when no structured data)  #
    # ------------------------------------------------------------------ #

    # German month names → month number
    _GERMAN_MONTHS: dict[str, int] = {
        'januar': 1, 'februar': 2, 'märz': 3, 'april': 4,
        'mai': 5, 'juni': 6, 'juli': 7, 'august': 8,
        'september': 9, 'oktober': 10, 'november': 11, 'dezember': 12,
        # Abbreviated forms
        'jan': 1, 'feb': 2, 'mär': 3, 'apr': 4,
        'jun': 6, 'jul': 7, 'aug': 8, 'sep': 9,
        'okt': 10, 'nov': 11, 'dez': 12,
    }

    # Street-type suffixes commonly found in German addresses
    _STREET_SUFFIXES = (
        r'(?:[Ss]tra[ßs]e|[Ss]tr\.|[Pp]latz|[Ww]eg|[Aa]llee|[Rr]ing|'
        r'[Gg]asse|[Dd]amm|[Uu]fer|[Ss]teig|[Pp]fad|[Pp]romenade|'
        r'[Bb]rücke|[Cc]haussee|[Mm]arkt|[Hh]of)'
    )

    # Regex: German address  –  "Straßenname 12, 76137 Karlsruhe" or "Straßenname 12a, 76137 Karlsruhe"
    _RE_ADDRESS = re.compile(
        r'([\wÄÖÜäöüß\-\.]+(?:\s[\wÄÖÜäöüß\-\.]+)*'  # Street name (one or more words)
        + _STREET_SUFFIXES +                              # Street-type suffix
        r'\s+\d+\s*\w?)'                                 # House number + optional letter
        r'[\s,]+(\d{5})\s+'                               # PLZ (5 digits)
        r'([A-ZÄÖÜ][\wÄÖÜäöüß\-]+(?:\s(?:am|an\sder|im|bei|ob\sder)\s[\wÄÖÜäöüß\-]+)?)',  # City
        re.UNICODE,
    )

    # Regex: "14. Februar 2026" (with optional time)
    _RE_DATE_LONG = re.compile(
        r'(\d{1,2})\.\s*'
        r'(' + '|'.join(
            m for m in [
                'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
                'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
            ]
        ) + r')\s+'
        r'(\d{4})',
        re.IGNORECASE,
    )

    # Regex: "14.02.2026"
    _RE_DATE_SHORT = re.compile(
        r'(\d{1,2})\.(\d{1,2})\.(\d{4})',
    )

    # Regex: time  –  "19 Uhr" / "19:30 Uhr" / "19:30" / "19.30 Uhr"
    _RE_TIME = re.compile(
        r'(\d{1,2})[:\.](\d{2})\s*(?:Uhr)?|(\d{1,2})\s*Uhr',
        re.IGNORECASE,
    )

    # Regex: end-time after start-time  –  "19 bis 21 Uhr" / "19-21 Uhr" / "19:00–21:30 Uhr"
    _RE_TIME_RANGE = re.compile(
        r'(\d{1,2})[:\.]?(\d{2})?\s*'
        r'(?:bis|–|—|-)\s*'
        r'(\d{1,2})[:\.]?(\d{2})?\s*(?:Uhr)?',
        re.IGNORECASE,
    )

    # Regex: "Ort:" label pattern  –  "Ort: Badisches Staatstheater, Kleines Haus"
    _RE_ORT_LABEL = re.compile(
        r'(?:Ort|Veranstaltungsort|Location|Spielort|Spielstätte|Wo)\s*[:]\s*(.+)',
        re.IGNORECASE,
    )

    def _extract_from_html_text(self, soup: BeautifulSoup) -> list[ExtractedEvent]:
        """
        Fallback extraction from visible HTML text using heuristics.

        Looks for:
        - Title from <h1>, og:title, or <title>
        - German addresses (street + PLZ + city)
        - German dates ("14. Februar 2026, 19 Uhr" / "14.02.2026")
        - Location/venue names (near address or "Ort: …" labels)
        - Image from og:image
        - Description from longest text block

        Returns at most one ExtractedEvent (single-event detail page assumption).
        """
        # --- Title ---
        title = self._extract_title(soup)
        if not title:
            logger.debug("Heuristic: no title found, skipping HTML text extraction")
            return []

        # --- Clean visible text ---
        visible_text = self._get_visible_text(soup)
        if len(visible_text) < 30:
            return []

        # --- Date / Time ---
        start_datetime, end_datetime = self._extract_german_datetime(visible_text)

        # --- Address ---
        location_address = self._extract_german_address(visible_text)

        # --- Location / Venue name ---
        location_name = self._extract_location_name(soup, visible_text)

        # --- Image (og:image) ---
        image_url = self._extract_og_image(soup)

        # --- Description ---
        description = self._extract_description(soup)

        # Only return if we found at least title + (date or address)
        if not start_datetime and not location_address:
            logger.debug("Heuristic: found title but no date and no address, skipping")
            return []

        return [ExtractedEvent(
            title=title,
            description=description,
            start_datetime=start_datetime,
            end_datetime=end_datetime,
            location_name=location_name,
            location_address=location_address,
            image_url=image_url,
        )]

    # --- Helper methods for heuristic extraction ---

    def _get_visible_text(self, soup: BeautifulSoup) -> str:
        """Extract visible text from HTML, removing nav/footer/script noise."""
        # Work on a copy so we don't mutate the original soup
        clone = BeautifulSoup(str(soup), 'lxml')

        # Remove noisy elements
        for tag_name in ('script', 'style', 'nav', 'footer', 'aside', 'noscript',
                         'iframe', 'svg', 'form'):
            for el in clone.find_all(tag_name):
                el.decompose()

        # Remove common cookie / banner divs by class/id patterns
        for el in clone.find_all(True, attrs={
            'class': re.compile(r'cookie|consent|banner|popup|modal|gdpr', re.I),
        }):
            el.decompose()
        for el in clone.find_all(True, attrs={
            'id': re.compile(r'cookie|consent|banner|popup|modal|gdpr', re.I),
        }):
            el.decompose()

        text = clone.get_text(separator='\n', strip=True)
        # Collapse excessive whitespace
        text = re.sub(r'\n{3,}', '\n\n', text)
        return text

    def _extract_title(self, soup: BeautifulSoup) -> Optional[str]:
        """Extract event title from h1, og:title, or <title>."""
        # 1. <h1> (most specific)
        h1 = soup.find('h1')
        if h1:
            text = h1.get_text(strip=True)
            if text and len(text) > 3:
                return text

        # 2. og:title
        og = soup.find('meta', property='og:title')
        if og and og.get('content'):
            return og['content'].strip()

        # 3. <title> tag (strip site name suffix if present)
        title_tag = soup.find('title')
        if title_tag:
            text = title_tag.get_text(strip=True)
            # Remove common suffixes like " | Site Name" or " - Site Name"
            text = re.split(r'\s*[|–—-]\s*', text)[0].strip()
            if text and len(text) > 3:
                return text

        return None

    def _extract_german_datetime(self, text: str) -> tuple[Optional[datetime], Optional[datetime]]:
        """
        Extract start and optional end datetime from German text.

        Handles:
        - "14. Februar 2026, 19 Uhr"
        - "14. Februar 2026, 19:30 Uhr"
        - "14.02.2026 19:00"
        - "von 19 bis 21 Uhr" / "19–21:30 Uhr"

        Time search is limited to a window around the date match to avoid
        picking up unrelated times (e.g., opening hours further down the page).
        """
        start_dt: Optional[datetime] = None
        end_dt: Optional[datetime] = None

        year: Optional[int] = None
        month: Optional[int] = None
        day: Optional[int] = None
        date_end_pos: int = 0

        # Try long German date first: "14. Februar 2026"
        m_long = self._RE_DATE_LONG.search(text)
        if m_long:
            day = int(m_long.group(1))
            month = self._GERMAN_MONTHS.get(m_long.group(2).lower())
            year = int(m_long.group(3))
            date_end_pos = m_long.end()
        else:
            # Try short date: "14.02.2026"
            m_short = self._RE_DATE_SHORT.search(text)
            if m_short:
                day = int(m_short.group(1))
                month = int(m_short.group(2))
                year = int(m_short.group(3))
                date_end_pos = m_short.end()

        if not (year and month and day):
            return None, None

        # Validate date components
        if year < 2020 or year > 2030 or month < 1 or month > 12 or day < 1 or day > 31:
            return None, None

        # Search for time only NEAR the date (within ~120 chars after date)
        # This avoids picking up opening hours or other unrelated times
        time_window = text[date_end_pos:date_end_pos + 120]

        # Extract time range first (has priority because it contains both start and end)
        m_range = self._RE_TIME_RANGE.search(time_window)
        if m_range:
            start_hour = int(m_range.group(1))
            start_min = int(m_range.group(2)) if m_range.group(2) else 0
            end_hour = int(m_range.group(3))
            end_min = int(m_range.group(4)) if m_range.group(4) else 0

            try:
                start_dt = datetime(year, month, day, start_hour, start_min)
                end_dt = datetime(year, month, day, end_hour, end_min)
                # If end is before start, it's the next day
                if end_dt <= start_dt:
                    from datetime import timedelta
                    end_dt += timedelta(days=1)
            except ValueError:
                start_dt = None
                end_dt = None
        else:
            # Try single time: "19 Uhr" / "19:30 Uhr"
            m_time = self._RE_TIME.search(time_window)
            if m_time:
                if m_time.group(3):
                    # Matched "19 Uhr" form
                    hour = int(m_time.group(3))
                    minute = 0
                else:
                    # Matched "19:30" form
                    hour = int(m_time.group(1))
                    minute = int(m_time.group(2))
                try:
                    start_dt = datetime(year, month, day, hour, minute)
                except ValueError:
                    start_dt = None

        # If we have a date but still no time, create date-only datetime
        if start_dt is None and year and month and day:
            try:
                start_dt = datetime(year, month, day)
            except ValueError:
                return None, None

        return start_dt, end_dt

    def _extract_german_address(self, text: str) -> Optional[str]:
        """
        Extract a German postal address from text.

        Looks for patterns like: "Hermann-Levi-Platz 1, 76137 Karlsruhe"
        """
        m = self._RE_ADDRESS.search(text)
        if m:
            street = m.group(1).strip()
            plz = m.group(2)
            city = m.group(3).strip()
            return f"{street}, {plz} {city}"

        # Fallback: look for standalone PLZ + City pattern near a street-like word
        plz_match = re.search(r'(\d{5})\s+([A-ZÄÖÜ][\wÄÖÜäöüß\-]+)', text)
        if plz_match:
            plz = plz_match.group(1)
            city = plz_match.group(2)
            # Look backwards in the same line for a street name
            line_start = text.rfind('\n', 0, plz_match.start())
            line_text = text[line_start + 1:plz_match.start()].strip().rstrip(',').strip()
            if line_text and len(line_text) > 5:
                return f"{line_text}, {plz} {city}"
            return f"{plz} {city}"

        return None

    def _extract_location_name(self, soup: BeautifulSoup, visible_text: str) -> Optional[str]:
        """
        Extract venue / location name.

        Strategies:
        1. "Ort: <value>" label pattern in text
        2. <dt>Ort</dt><dd>value</dd> pattern
        3. Text immediately before address in the visible text
        """
        # 1. "Ort: Badisches Staatstheater, Kleines Haus"
        m = self._RE_ORT_LABEL.search(visible_text)
        if m:
            loc = m.group(1).strip()
            # Truncate at newline or very long values
            loc = loc.split('\n')[0].strip()
            if len(loc) > 200:
                loc = loc[:200]
            if loc:
                return loc

        # 2. <dt>Ort</dt><dd>...</dd>  or  <th>Ort</th><td>...</td>
        for label_tag in soup.find_all(['dt', 'th', 'label', 'strong', 'b', 'span']):
            label_text = label_tag.get_text(strip=True).lower()
            if label_text in ('ort', 'ort:', 'veranstaltungsort', 'veranstaltungsort:',
                              'spielort', 'spielort:', 'location', 'location:', 'wo', 'wo:'):
                # Find the next sibling with content
                next_el = label_tag.find_next_sibling()
                if next_el:
                    val = next_el.get_text(strip=True)
                    if val and len(val) > 2:
                        return val[:200]
                # Try parent's next sibling (for cases where label is inside a <div>)
                if label_tag.parent:
                    next_el = label_tag.parent.find_next_sibling()
                    if next_el:
                        val = next_el.get_text(strip=True)
                        if val and len(val) > 2:
                            return val[:200]

        return None

    def _extract_og_image(self, soup: BeautifulSoup) -> Optional[str]:
        """Extract image URL from og:image meta tag."""
        og = soup.find('meta', property='og:image')
        if og and og.get('content'):
            url = og['content'].strip()
            if url.startswith(('http://', 'https://')):
                return url
        return None

    def _extract_description(self, soup: BeautifulSoup) -> Optional[str]:
        """Extract description from og:description or longest paragraph."""
        # 1. og:description
        og = soup.find('meta', property='og:description')
        if og and og.get('content'):
            desc = og['content'].strip()
            if len(desc) > 20:
                return desc[:5000]

        # 2. meta description
        meta = soup.find('meta', attrs={'name': 'description'})
        if meta and meta.get('content'):
            desc = meta['content'].strip()
            if len(desc) > 20:
                return desc[:5000]

        # 3. Longest <p> in main/article/body
        main = soup.find('main') or soup.find('article') or soup.find('body')
        if main:
            paragraphs = main.find_all('p')
            if paragraphs:
                longest = max(paragraphs, key=lambda p: len(p.get_text(strip=True)))
                text = longest.get_text(strip=True)
                if len(text) > 30:
                    return text[:5000]

        return None

    # ------------------------------------------------------------------ #
    #  Original helper methods                                             #
    # ------------------------------------------------------------------ #

    def _parse_datetime(self, value: Optional[str]) -> Optional[datetime]:
        """Parse datetime from various formats."""
        if not value:
            return None
        
        try:
            # Handle ISO format
            if 'T' in value:
                # Remove timezone for simplicity
                value = value.replace('Z', '+00:00')
                if '+' in value:
                    value = value.split('+')[0]
                return datetime.fromisoformat(value)
            
            # Handle date only
            return datetime.fromisoformat(value)
        except (ValueError, TypeError):
            return None
    
    def _parse_float(self, value) -> Optional[float]:
        """Parse float from various types."""
        if value is None:
            return None
        try:
            return float(value)
        except (ValueError, TypeError):
            return None
