"""Data normalization for events from various sources."""

from dataclasses import dataclass
from typing import Optional, Any
from datetime import datetime
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
    location_address: Optional[str]
    location_lat: Optional[float]
    location_lng: Optional[float]
    price_type: str  # free, paid, range, unknown
    price_min: Optional[float]
    price_max: Optional[float]
    age_min: Optional[int]
    age_max: Optional[int]
    is_indoor: Optional[bool]
    is_outdoor: Optional[bool]
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
        
        # Location
        location_address = self._normalize_address(
            raw_data.get('location_address') or raw_data.get('location', '')
        )
        location_lat = self._safe_float(raw_data.get('location_lat') or raw_data.get('lat'))
        location_lng = self._safe_float(raw_data.get('location_lng') or raw_data.get('lng'))
        
        # Price
        price_type, price_min, price_max = self._extract_price(raw_data)
        
        # Age range
        age_min, age_max = self._extract_age_range(raw_data, title, description)
        
        # Indoor/Outdoor
        is_indoor, is_outdoor = self._detect_indoor_outdoor(raw_data, title, description)
        
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
            price_type=price_type,
            price_min=price_min,
            price_max=price_max,
            age_min=age_min,
            age_max=age_max,
            is_indoor=is_indoor,
            is_outdoor=is_outdoor,
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
        """Extract price information."""
        # Check explicit price fields
        price_type = raw_data.get('price_type', 'unknown')
        price_min = self._safe_float(raw_data.get('price_min') or raw_data.get('price'))
        price_max = self._safe_float(raw_data.get('price_max'))
        
        if price_type not in ['free', 'paid', 'range', 'unknown']:
            price_type = 'unknown'
        
        # Try to detect from text
        text = f"{raw_data.get('title', '')} {raw_data.get('description', '')}".lower()
        
        if price_type == 'unknown':
            if 'kostenlos' in text or 'gratis' in text or 'eintritt frei' in text:
                price_type = 'free'
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
        
        # Pattern: "X-Y Jahre" or "X bis Y Jahre"
        range_pattern = r'(\d+)\s*[-–bis]\s*(\d+)\s*(?:jahre|j\.)'
        match = re.search(range_pattern, text)
        if match:
            return int(match.group(1)), int(match.group(2))
        
        # Pattern: "ab X Jahren"
        ab_pattern = r'ab\s*(\d+)\s*(?:jahre|j\.)'
        match = re.search(ab_pattern, text)
        if match:
            return int(match.group(1)), 99
        
        # Pattern: "bis X Jahre"
        bis_pattern = r'bis\s*(\d+)\s*(?:jahre|j\.)'
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
        """Extract email from data."""
        email = raw_data.get('contact_email') or raw_data.get('email')
        
        if email:
            return email.strip()[:200]
        
        # Try to find in text
        text = raw_data.get('description', '')
        email_pattern = r'[\w\.-]+@[\w\.-]+\.\w+'
        match = re.search(email_pattern, text)
        
        return match.group(0) if match else None
    
    def _extract_phone(self, raw_data: dict) -> Optional[str]:
        """Extract phone from data."""
        phone = raw_data.get('contact_phone') or raw_data.get('phone')
        
        if phone:
            # Basic normalization
            phone = re.sub(r'[^\d+\-\s()]', '', str(phone))
            return phone.strip()[:50] or None
        
        return None
    
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
