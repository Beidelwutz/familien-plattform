"""Data normalization for events from various sources."""

from dataclasses import dataclass
from typing import Optional, Any
from datetime import datetime, timedelta
import re
from dateutil import parser as date_parser
import pytz


@dataclass
class NormalizedEvent:
    """Normalized event data."""
    title: str
    description_short: Optional[str]
    description_long: Optional[str]
    start_datetime: Optional[datetime]
    end_datetime: Optional[datetime]
    
    # Location / Venue
    location_address: Optional[str]
    location_lat: Optional[float]
    location_lng: Optional[float]
    venue_name: Optional[str]
    city: Optional[str]
    postal_code: Optional[str]
    
    # Pricing
    price_type: str  # free, paid, range, unknown
    price_min: Optional[float]
    price_max: Optional[float]
    price_details: Optional[dict]  # {adult: {min, max}, child: {min, max}, family: {min, max}, currency: "EUR"}
    
    # Ticket/Booking Status
    availability_status: Optional[str]  # available, sold_out, waitlist, registration_required, unknown
    registration_deadline: Optional[datetime]
    
    # Age
    age_min: Optional[int]
    age_max: Optional[int]
    
    # Indoor/Outdoor
    is_indoor: Optional[bool]
    is_outdoor: Optional[bool]
    
    # Language
    language: Optional[str]  # "Deutsch", "Englisch"
    
    # Capacity
    capacity: Optional[int]
    spots_limited: Optional[bool]
    
    # Series / Recurrence
    recurrence_rule: Optional[str]  # iCal RRULE or "jeden Samstag"
    
    # Transit
    transit_stop: Optional[str]
    has_parking: Optional[bool]
    
    # Contact
    booking_url: Optional[str]
    contact_email: Optional[str]
    contact_phone: Optional[str]
    image_urls: list[str]
    source_url: Optional[str]
    raw_data: dict


class EventNormalizer:
    """Normalize event data from various sources."""
    
    TIMEZONE = pytz.timezone('Europe/Berlin')
    
    def normalize(self, raw_data: dict, source_type: str) -> NormalizedEvent:
        """
        Normalize event data from any source.
        
        Args:
            raw_data: Raw event data
            source_type: Type of source (rss, ics, scraper, etc.)
            
        Returns:
            NormalizedEvent with standardized fields
        """
        # Extract and normalize each field
        title = self._normalize_title(raw_data.get('title', ''))
        
        description = raw_data.get('description') or raw_data.get('summary', '')
        description_short, description_long = self._split_description(description)
        
        start_dt = self._normalize_datetime(
            raw_data.get('start_datetime') or raw_data.get('dtstart')
        )
        end_dt = self._normalize_datetime(
            raw_data.get('end_datetime') or raw_data.get('dtend')
        )
        
        # If we have a date but no time (or wrong time), try to extract time from description
        # This handles cases like "17 Uhr" or "11 bis 12 Uhr" in the text
        if description:
            extracted_start, extracted_end = self._extract_time_from_text(description, start_dt)
            
            # Only use extracted time if:
            # 1. We have a start date but time seems like midnight/default (00:00)
            # 2. Or we have no start datetime at all
            if extracted_start:
                if start_dt is None:
                    start_dt = extracted_start
                elif start_dt.hour == 0 and start_dt.minute == 0:
                    # Combine existing date with extracted time
                    start_dt = start_dt.replace(
                        hour=extracted_start.hour, 
                        minute=extracted_start.minute,
                        second=0,
                        microsecond=0
                    )
            
            if extracted_end:
                if end_dt is None:
                    end_dt = extracted_end
                elif end_dt.hour == 0 and end_dt.minute == 0:
                    # Combine existing date with extracted time
                    end_dt = end_dt.replace(
                        hour=extracted_end.hour, 
                        minute=extracted_end.minute,
                        second=0,
                        microsecond=0
                    )
        
        # Location / Venue
        location_address = self._normalize_address(
            raw_data.get('location_address') or raw_data.get('location', '')
        )
        location_lat = self._safe_float(raw_data.get('location_lat') or raw_data.get('lat'))
        location_lng = self._safe_float(raw_data.get('location_lng') or raw_data.get('lng'))
        venue_name = raw_data.get('venue_name') or raw_data.get('location_name')
        city, postal_code = self._extract_city_postal(raw_data, location_address)
        
        # Smart venue/address separation
        if location_address and not self._is_street_address(location_address):
            # Text sieht nicht nach Strasse aus -> ist vermutlich Venue-Name
            if not venue_name:
                venue_name = location_address
                location_address = None
        elif location_address and not venue_name:
            # Zusammengesetzter String: "Prinz-Max-Palais, Karlstr. 10, 76133 Karlsruhe"
            parts = location_address.split(',')
            if len(parts) >= 2 and not self._is_street_address(parts[0].strip()):
                venue_name = parts[0].strip()
                location_address = ', '.join(parts[1:]).strip()
        
        # Price (basic + structured)
        price_type, price_min, price_max = self._extract_price(raw_data)
        price_details = self._extract_price_details(raw_data, description)
        
        # Ticket/Booking Status
        availability_status = self._extract_availability_status(raw_data, description)
        registration_deadline = self._normalize_datetime(raw_data.get('registration_deadline'))
        
        # Age range
        age_min, age_max = self._extract_age_range(raw_data, title, description)
        
        # Indoor/Outdoor
        is_indoor, is_outdoor = self._detect_indoor_outdoor(raw_data, title, description)
        
        # Language
        language = self._extract_language(raw_data, description)
        
        # Capacity
        capacity = self._safe_int(raw_data.get('capacity'))
        spots_limited = self._detect_spots_limited(raw_data, description)
        
        # Recurrence
        recurrence_rule = self._extract_recurrence(raw_data, description)
        
        # Transit
        transit_stop = raw_data.get('transit_stop')
        has_parking = self._detect_parking(raw_data, description)
        
        # Contact
        booking_url = self._normalize_url(raw_data.get('booking_url') or raw_data.get('url'))
        contact_email = self._extract_email(raw_data)
        contact_phone = self._extract_phone(raw_data)
        
        # Images
        image_urls = self._extract_images(raw_data)
        
        return NormalizedEvent(
            title=title,
            description_short=description_short,
            description_long=description_long,
            start_datetime=start_dt,
            end_datetime=end_dt,
            location_address=location_address,
            location_lat=location_lat,
            location_lng=location_lng,
            venue_name=venue_name,
            city=city,
            postal_code=postal_code,
            price_type=price_type,
            price_min=price_min,
            price_max=price_max,
            price_details=price_details,
            availability_status=availability_status,
            registration_deadline=registration_deadline,
            age_min=age_min,
            age_max=age_max,
            is_indoor=is_indoor,
            is_outdoor=is_outdoor,
            language=language,
            capacity=capacity,
            spots_limited=spots_limited,
            recurrence_rule=recurrence_rule,
            transit_stop=transit_stop,
            has_parking=has_parking,
            booking_url=booking_url,
            contact_email=contact_email,
            contact_phone=contact_phone,
            image_urls=image_urls,
            source_url=raw_data.get('source_url'),
            raw_data=raw_data
        )
    
    def _normalize_title(self, title: str) -> str:
        """Clean and normalize title."""
        if not title:
            return ""
        
        # Remove HTML tags
        title = re.sub(r'<[^>]+>', '', title)
        
        # Normalize whitespace
        title = ' '.join(title.split())
        
        # Truncate if too long
        if len(title) > 200:
            title = title[:197] + "..."
        
        return title.strip()
    
    def _split_description(self, description: str) -> tuple[Optional[str], Optional[str]]:
        """Split description into short and long versions."""
        if not description:
            return None, None
        
        # Clean HTML
        description = re.sub(r'<[^>]+>', ' ', description)
        description = ' '.join(description.split())
        
        if len(description) <= 500:
            return description, None
        
        # Find good break point for short description
        short = description[:500]
        last_period = short.rfind('.')
        last_space = short.rfind(' ')
        
        if last_period > 300:
            short = short[:last_period + 1]
        elif last_space > 300:
            short = short[:last_space] + "..."
        else:
            short = short[:497] + "..."
        
        return short, description
    
    def _normalize_datetime(self, dt_value: Any) -> Optional[datetime]:
        """Normalize datetime value."""
        if not dt_value:
            return None
        
        if isinstance(dt_value, datetime):
            dt = dt_value
        elif isinstance(dt_value, str):
            try:
                dt = date_parser.parse(dt_value)
            except Exception:
                return None
        else:
            return None
        
        # Ensure timezone
        if dt.tzinfo is None:
            dt = self.TIMEZONE.localize(dt)
        
        return dt
    
    def _normalize_address(self, address: str) -> Optional[str]:
        """Clean and normalize address."""
        if not address:
            return None
        
        # Remove extra whitespace
        address = ' '.join(address.split())
        
        # Truncate if too long
        if len(address) > 300:
            address = address[:300]
        
        return address.strip() or None
    
    def _extract_price(self, raw_data: dict) -> tuple[str, Optional[float], Optional[float]]:
        """Extract price information with free/donation/paid distinction."""
        # Check explicit price fields
        price_type = raw_data.get('price_type', 'unknown')
        price_min = self._safe_float(raw_data.get('price_min') or raw_data.get('price'))
        price_max = self._safe_float(raw_data.get('price_max'))
        
        VALID_PRICE_TYPES = ['free', 'paid', 'range', 'unknown', 'donation']
        if price_type not in VALID_PRICE_TYPES:
            price_type = 'unknown'
        
        # Try to detect from text
        text = f"{raw_data.get('title', '')} {raw_data.get('description', '')}".lower()
        
        FREE_KEYWORDS = [
            'kostenlos', 'kostenfrei', 'gratis', 'umsonst',
            'eintritt frei', 'freier eintritt', 'ohne eintritt',
            'kein eintritt', 'ohne kosten', '0 euro', '0€', '0,00', 'for free',
        ]
        DONATION_KEYWORDS = [
            'auf spendenbasis', 'spende erbeten', 'pay what you want',
            'gegen spende', 'hutsammlung', 'freiwilliger beitrag',
        ]
        
        if price_type == 'unknown':
            if any(kw in text for kw in FREE_KEYWORDS):
                price_type = 'free'
            elif any(kw in text for kw in DONATION_KEYWORDS):
                price_type = 'free'  # Treated as free, details in price_details
            elif price_min is not None:
                price_type = 'paid'
        
        # Try to extract price from text
        if price_min is None and price_type != 'free':
            price_pattern = r'(\d+(?:[,\.]\d{2})?)\s*(?:€|euro|eur)'
            match = re.search(price_pattern, text)
            if match:
                price_str = match.group(1).replace(',', '.')
                price_min = float(price_str)
                price_type = 'paid'
        
        # Ensure free events always have price_min = 0
        if price_type == 'free' and price_min is None:
            price_min = 0.0
        
        return price_type, price_min, price_max
    
    def _extract_age_range(
        self, 
        raw_data: dict, 
        title: str, 
        description: str
    ) -> tuple[Optional[int], Optional[int]]:
        """Extract age range from data."""
        age_min = self._safe_int(raw_data.get('age_min'))
        age_max = self._safe_int(raw_data.get('age_max'))
        
        if age_min is not None and age_max is not None:
            return age_min, age_max
        
        # Try to extract from text
        text = f"{title} {description}".lower()
        
        # Pattern: "X-Y Jahre" or "X bis Y Jahre" or "X-Y Jahren"
        range_pattern = r'(\d+)\s*[-–bis]\s*(\d+)\s*(?:jahren?|j\.?)'
        match = re.search(range_pattern, text)
        if match:
            return int(match.group(1)), int(match.group(2))
        
        # Pattern: "ab X Jahren" / "ab X Jahre" / "ab X J."
        ab_pattern = r'ab\s*(\d+)\s*(?:jahren?|j\.?)'
        match = re.search(ab_pattern, text)
        if match:
            return int(match.group(1)), 99
        
        # Pattern: "bis X Jahre" / "bis X Jahren"
        bis_pattern = r'bis\s*(\d+)\s*(?:jahren?|j\.?)'
        match = re.search(bis_pattern, text)
        if match:
            return 0, int(match.group(1))
        
        return age_min, age_max
    
    def _detect_indoor_outdoor(
        self, 
        raw_data: dict, 
        title: str, 
        description: str
    ) -> tuple[Optional[bool], Optional[bool]]:
        """Detect if event is indoor/outdoor."""
        is_indoor = raw_data.get('is_indoor')
        is_outdoor = raw_data.get('is_outdoor')
        
        if is_indoor is not None or is_outdoor is not None:
            return is_indoor, is_outdoor
        
        text = f"{title} {description}".lower()
        
        indoor_keywords = ['indoor', 'drinnen', 'halle', 'museum', 'theater', 'kino']
        outdoor_keywords = ['outdoor', 'draußen', 'garten', 'park', 'wald', 'spielplatz']
        
        is_indoor = any(kw in text for kw in indoor_keywords)
        is_outdoor = any(kw in text for kw in outdoor_keywords)
        
        return is_indoor or None, is_outdoor or None
    
    def _normalize_url(self, url: Any) -> Optional[str]:
        """Normalize and validate URL."""
        if not url or not isinstance(url, str):
            return None
        
        url = url.strip()
        
        if not url.startswith(('http://', 'https://')):
            url = 'https://' + url
        
        # Basic validation
        if len(url) > 500:
            return None
        
        return url
    
    def _extract_email(self, raw_data: dict) -> Optional[str]:
        """Extract email from data or description text."""
        email = raw_data.get('contact_email') or raw_data.get('email')
        
        if email:
            return email.strip()[:200]
        
        # Try to find in description text
        text = raw_data.get('description', '')
        # Standard email pattern
        email_pattern = r'[\w\.\-+]+@[\w\.-]+\.[a-zA-Z]{2,}'
        match = re.search(email_pattern, text)
        
        return match.group(0) if match else None
    
    def _extract_phone(self, raw_data: dict) -> Optional[str]:
        """Extract phone from data or description text."""
        phone = raw_data.get('contact_phone') or raw_data.get('phone')
        
        if phone:
            # Basic normalization
            phone = re.sub(r'[^\d+\-\s()]', '', str(phone))
            return phone.strip()[:50] or None
        
        # Try to find in description text
        text = raw_data.get('description', '')
        
        # German phone patterns:
        # - "0721 133 4401" (with spaces)
        # - "0721/1334401" (with slash)
        # - "(0721) 133-4401" (with parentheses and dash)
        # - "+49 721 1334401" (international)
        # - "0721-133-4401" (with dashes)
        phone_patterns = [
            # International format: +49 ...
            r'\+49[\s\-/]?\d{2,4}[\s\-/]?\d{2,4}[\s\-/]?\d{2,6}',
            # German format with area code: 0721 ...
            r'0\d{2,4}[\s\-/]?\d{2,4}[\s\-/]?\d{2,6}',
            # With parentheses: (0721) ...
            r'\(0\d{2,4}\)[\s\-/]?\d{2,4}[\s\-/]?\d{2,6}',
        ]
        
        for pattern in phone_patterns:
            match = re.search(pattern, text)
            if match:
                phone = match.group(0)
                # Basic normalization - keep digits and formatting chars
                phone = re.sub(r'[^\d+\-\s()/]', '', phone)
                return phone.strip()[:50] or None
        
        return None
    
    def _extract_time_from_text(
        self, 
        text: str, 
        base_date: Optional[datetime] = None
    ) -> tuple[Optional[datetime], Optional[datetime]]:
        """
        Extract time information from text.
        
        Patterns supported:
        - "11 Uhr" / "11:30 Uhr"
        - "11 bis 12 Uhr" / "11-12 Uhr" / "von 11 bis 12 Uhr"
        - "14:00 - 16:30 Uhr"
        - "ab 17 Uhr"
        
        Args:
            text: Text to search in
            base_date: Date to combine with extracted time (defaults to today)
            
        Returns:
            Tuple of (start_datetime, end_datetime), either can be None
        """
        if not text:
            return None, None
        
        text_lower = text.lower()
        
        if base_date is None:
            base_date = datetime.now(self.TIMEZONE)
        
        # Ensure base_date has timezone
        if base_date.tzinfo is None:
            base_date = self.TIMEZONE.localize(base_date)
        
        start_time = None
        end_time = None
        
        # Pattern 1: Time range - "Uhr" am Ende OPTIONAL wenn Minuten vorhanden
        # Matcht: "16 bis 16.15", "11 bis 12 Uhr", "von 14:00 bis 15:30", "14-16 Uhr", "14h-16h"
        time_range_pattern = r'(?:von\s+)?(\d{1,2})(?:[:\.]\s*(\d{2}))?\s*(?:uhr|h)?\s*(?:bis|[-–])\s*(\d{1,2})(?:[:\.]\s*(\d{2}))?\s*(?:uhr|h)?'
        match = re.search(time_range_pattern, text_lower)
        if match:
            start_hour = int(match.group(1))
            start_minute = int(match.group(2)) if match.group(2) else 0
            end_hour = int(match.group(3))
            end_minute = int(match.group(4)) if match.group(4) else 0
            
            # Plausibilitaetspruefung: Stunden 6-23 (keine versehentlichen Matches mit Datumsangaben)
            if 6 <= start_hour <= 23 and 0 <= end_hour <= 23 and 0 <= start_minute <= 59 and 0 <= end_minute <= 59:
                start_time = base_date.replace(hour=start_hour, minute=start_minute, second=0, microsecond=0)
                end_time = base_date.replace(hour=end_hour, minute=end_minute, second=0, microsecond=0)
                # Endzeit < Startzeit (z.B. 22-01 Uhr) -> naechster Tag
                if end_time <= start_time:
                    end_time = end_time + timedelta(days=1)
                return start_time, end_time
        
        # Pattern 2: Single time "11 Uhr" / "11:30 Uhr" / "um 14 Uhr"
        single_time_pattern = r'(?:um|gegen)\s*(\d{1,2})(?:[:\.]\s*(\d{2}))?\s*(?:uhr|h)'
        match = re.search(single_time_pattern, text_lower)
        if match:
            hour = int(match.group(1))
            minute = int(match.group(2)) if match.group(2) else 0
            
            if 6 <= hour <= 23 and 0 <= minute <= 59:
                start_time = base_date.replace(hour=hour, minute=minute, second=0, microsecond=0)
                return start_time, None
        
        # Pattern 3: "ab 14 Uhr" / "ab 14h" -> nur Start
        ab_pattern = r'\bab\s+(\d{1,2})(?:[:\.]\s*(\d{2}))?\s*(?:uhr|h)\b'
        match = re.search(ab_pattern, text_lower)
        if match:
            hour = int(match.group(1))
            minute = int(match.group(2)) if match.group(2) else 0
            if 6 <= hour <= 23 and 0 <= minute <= 59:
                start_time = base_date.replace(hour=hour, minute=minute, second=0, microsecond=0)
                return start_time, None
        
        # Pattern 4: "bis 16 Uhr" -> nur End
        bis_pattern = r'\bbis\s+(\d{1,2})(?:[:\.]\s*(\d{2}))?\s*(?:uhr|h)\b'
        match = re.search(bis_pattern, text_lower)
        if match:
            hour = int(match.group(1))
            minute = int(match.group(2)) if match.group(2) else 0
            if 6 <= hour <= 23 and 0 <= minute <= 59:
                end_time = base_date.replace(hour=hour, minute=minute, second=0, microsecond=0)
                return None, end_time
        
        # Pattern 5: Simple "14 Uhr" (without ab/um/gegen prefix)
        simple_time_pattern = r'\b(\d{1,2})(?:[:\.]\s*(\d{2}))?\s*uhr\b'
        match = re.search(simple_time_pattern, text_lower)
        if match:
            hour = int(match.group(1))
            minute = int(match.group(2)) if match.group(2) else 0
            if 6 <= hour <= 23 and 0 <= minute <= 59:
                start_time = base_date.replace(hour=hour, minute=minute, second=0, microsecond=0)
                return start_time, None
        
        # Pattern 6: Tageszeit-Woerter - NUR "morgens" (NICHT "morgen" = tomorrow)
        tageszeit_pattern = r'\b(vormittags?|nachmittags?|abends?|morgens)\b'
        match = re.search(tageszeit_pattern, text_lower)
        if match:
            tageszeit_map = {
                'vormittag': (10, 0), 'vormittags': (10, 0),
                'morgens': (9, 0),
                'nachmittag': (14, 0), 'nachmittags': (14, 0),
                'abend': (19, 0), 'abends': (19, 0),
            }
            word = match.group(1)
            if word in tageszeit_map:
                h, m = tageszeit_map[word]
                start_time = base_date.replace(hour=h, minute=m, second=0, microsecond=0)
                return start_time, None
        
        return None, None
    
    def _extract_images(self, raw_data: dict) -> list[str]:
        """Extract image URLs from data."""
        images = raw_data.get('image_urls') or raw_data.get('images') or []
        
        if isinstance(images, str):
            images = [images]
        
        # Filter and validate
        valid_images = []
        for img in images:
            if isinstance(img, str) and img.startswith(('http://', 'https://')):
                valid_images.append(img[:500])
        
        return valid_images[:10]  # Max 10 images
    
    def _is_street_address(self, text: str) -> bool:
        """Check if text looks like a street address (not a venue name)."""
        if not text:
            return False
        text_lower = text.lower()
        # Starkes Signal: PLZ (5 Ziffern)
        has_postal = bool(re.search(r'\b\d{5}\b', text))
        # Strassen-Suffix MIT Hausnummer = sicher Adresse
        street_with_nr = bool(re.search(
            r'(?:str\.|straße|strasse|weg|platz|allee|gasse|ring|damm|ufer)\s*\d+', text_lower
        ))
        # Strassen-Suffix OHNE Nummer = wahrscheinlich Adresse wenn PLZ dabei
        street_no_nr = bool(re.search(
            r'(?:str\.|straße|strasse|weg|allee|gasse|ring|damm|ufer)\b', text_lower
        ))
        return street_with_nr or (street_no_nr and has_postal) or has_postal
    
    def _extract_city_postal(
        self, 
        raw_data: dict, 
        location_address: Optional[str]
    ) -> tuple[Optional[str], Optional[str]]:
        """Extract city and postal code from data or address."""
        city = raw_data.get('city')
        postal_code = raw_data.get('postal_code')
        
        if city and postal_code:
            return city, postal_code
        
        # Try to extract from address (German format: "Straße 123, 12345 Stadt")
        if location_address:
            # Pattern: 5-digit postal code followed by city name
            postal_pattern = r'(\d{5})\s+([A-ZÄÖÜa-zäöüß][A-ZÄÖÜa-zäöüß\-\s]+)'
            match = re.search(postal_pattern, location_address)
            if match:
                postal_code = postal_code or match.group(1)
                city = city or match.group(2).strip()
        
        return city, postal_code
    
    def _extract_price_details(
        self, 
        raw_data: dict, 
        description: str
    ) -> Optional[dict]:
        """Extract structured price details (adult/child/family)."""
        price_details = raw_data.get('price_details')
        if price_details:
            return price_details
        
        text = description.lower()
        details = {}
        
        # Pattern for adult prices: "Erwachsene: 12€" or "Erwachsene 12 €"
        adult_pattern = r'erwachsene[:\s]*(\d+(?:[,\.]\d{2})?)\s*(?:€|euro)'
        match = re.search(adult_pattern, text)
        if match:
            price = float(match.group(1).replace(',', '.'))
            details['adult'] = {'min': price, 'max': price}
        
        # Pattern for child prices: "Kinder: 8€" or "Kind 8 €"
        child_pattern = r'kind(?:er)?[:\s]*(\d+(?:[,\.]\d{2})?)\s*(?:€|euro)'
        match = re.search(child_pattern, text)
        if match:
            price = float(match.group(1).replace(',', '.'))
            details['child'] = {'min': price, 'max': price}
        
        # Pattern for family prices: "Familienkarte: 30€"
        family_pattern = r'familien?(?:karte|ticket)?[:\s]*(\d+(?:[,\.]\d{2})?)\s*(?:€|euro)'
        match = re.search(family_pattern, text)
        if match:
            price = float(match.group(1).replace(',', '.'))
            details['family'] = {'min': price, 'max': price}
        
        # Donation detection
        if any(kw in text for kw in ['spendenbasis', 'spende erbeten', 'pay what you want',
                                      'gegen spende', 'hutsammlung', 'freiwilliger beitrag']):
            details['mode'] = 'donation'
            details['hint'] = 'Spendenbasis'
        
        if details:
            details['currency'] = 'EUR'
            return details
        
        return None
    
    def _extract_availability_status(
        self, 
        raw_data: dict, 
        description: str
    ) -> Optional[str]:
        """Extract ticket/booking availability status."""
        status = raw_data.get('availability_status')
        if status:
            return status
        
        text = description.lower()
        
        # Check for cancelled
        if any(kw in text for kw in ['abgesagt', 'entfällt', 'cancelled', 'fällt aus', 'findet nicht statt']):
            return 'cancelled'
        
        # Check for postponed
        if any(kw in text for kw in ['verschoben', 'postponed', 'neuer termin']):
            return 'postponed'
        
        # Check for sold out
        if any(kw in text for kw in ['ausverkauft', 'sold out', 'keine tickets', 'restlos vergriffen']):
            return 'sold_out'
        
        # Check for waitlist
        if any(kw in text for kw in ['warteliste', 'waitlist', 'warte-liste']):
            return 'waitlist'
        
        # Check for registration required
        if any(kw in text for kw in ['anmeldung erforderlich', 'anmeldung nötig', 'voranmeldung', 
                                      'registrierung erforderlich', 'nur mit anmeldung']):
            return 'registration_required'
        
        # Check for available
        if any(kw in text for kw in ['tickets verfügbar', 'tickets erhältlich', 'jetzt buchen',
                                      'noch plätze frei', 'restplätze']):
            return 'available'
        
        return None
    
    def _extract_language(self, raw_data: dict, description: str) -> Optional[str]:
        """Extract event language as ISO code."""
        language = raw_data.get('language')
        if language:
            # Normalize to ISO code if full name given
            lang_map = {
                'deutsch': 'de', 'german': 'de', 'de': 'de',
                'englisch': 'en', 'english': 'en', 'en': 'en',
                'französisch': 'fr', 'french': 'fr', 'fr': 'fr',
                'türkisch': 'tr', 'turkish': 'tr', 'tr': 'tr',
            }
            return lang_map.get(language.lower(), language)
        
        text = description.lower()
        
        # Check for explicit language mentions
        if any(kw in text for kw in ['auf englisch', 'in englisch', 'english', 'in english']):
            return 'en'
        if any(kw in text for kw in ['auf deutsch', 'in deutsch', 'auf deutscher sprache']):
            return 'de'
        
        # Default to German for German sources
        return 'de'
    
    def _detect_spots_limited(self, raw_data: dict, description: str) -> Optional[bool]:
        """Detect if event has limited spots."""
        spots_limited = raw_data.get('spots_limited')
        if spots_limited is not None:
            return spots_limited
        
        text = description.lower()
        
        if any(kw in text for kw in ['begrenzte plätze', 'begrenzte teilnehmerzahl', 
                                      'limited spots', 'nur noch wenige plätze',
                                      'max. teilnehmer', 'maximale teilnehmerzahl']):
            return True
        
        return None
    
    def _extract_recurrence(self, raw_data: dict, description: str) -> Optional[str]:
        """Extract recurrence rule from data."""
        rrule = raw_data.get('recurrence_rule') or raw_data.get('rrule')
        if rrule:
            return rrule
        
        text = description.lower()
        
        # Check for weekly patterns
        if 'jeden montag' in text:
            return 'jeden Montag'
        if 'jeden dienstag' in text:
            return 'jeden Dienstag'
        if 'jeden mittwoch' in text:
            return 'jeden Mittwoch'
        if 'jeden donnerstag' in text:
            return 'jeden Donnerstag'
        if 'jeden freitag' in text:
            return 'jeden Freitag'
        if 'jeden samstag' in text:
            return 'jeden Samstag'
        if 'jeden sonntag' in text:
            return 'jeden Sonntag'
        if 'täglich' in text or 'jeden tag' in text:
            return 'täglich'
        if 'wöchentlich' in text:
            return 'wöchentlich'
        if 'monatlich' in text:
            return 'monatlich'
        
        return None
    
    def _detect_parking(self, raw_data: dict, description: str) -> Optional[bool]:
        """Detect if parking is available."""
        has_parking = raw_data.get('has_parking')
        if has_parking is not None:
            return has_parking
        
        text = description.lower()
        
        if any(kw in text for kw in ['parkplätze vorhanden', 'parkplätze verfügbar', 
                                      'kostenlose parkplätze', 'parkhaus', 'tiefgarage',
                                      'parkmöglichkeiten']):
            return True
        
        if any(kw in text for kw in ['keine parkplätze', 'kein parkplatz']):
            return False
        
        return None
    
    def _safe_float(self, value: Any) -> Optional[float]:
        """Safely convert to float."""
        if value is None:
            return None
        try:
            return float(value)
        except (ValueError, TypeError):
            return None
    
    def _safe_int(self, value: Any) -> Optional[int]:
        """Safely convert to int."""
        if value is None:
            return None
        try:
            return int(float(value))
        except (ValueError, TypeError):
            return None
