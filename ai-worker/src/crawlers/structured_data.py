"""Structured data extractors for event pages.

Extracts events from JSON-LD, Microdata, and OpenGraph.
JSON-LD should be the first choice as it's the most reliable.
"""

import json
import logging
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
        3. None (fallback to CSS selectors)
        
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
        
        # 3. No structured data found
        logger.debug("No structured data found on page")
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
