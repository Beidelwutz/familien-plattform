"""Event deduplication and merging logic.

Implements the Canonical Event Model:
- One canonical event per real-world event
- Multiple sources can contribute data
- Merging with priority rules
"""

from dataclasses import dataclass
from typing import Optional, Tuple
import hashlib
from datetime import datetime
from difflib import SequenceMatcher
import geohash2
import pytz
import re


@dataclass
class DedupeMatch:
    """Result of deduplication check."""
    canonical_event_id: Optional[str]
    match_type: str  # 'exact', 'fuzzy', 'none'
    confidence: float
    fingerprint: str
    matching_source_ids: list[str]


@dataclass
class MergeResult:
    """Result of merging event data."""
    merged_data: dict
    conflicts: list[dict]
    primary_source_id: str


# Source priority for merging (lower = higher priority)
SOURCE_PRIORITY = {
    'partner': 1,    # Partner uploads (highest priority)
    'api': 2,        # Official APIs
    'manual': 2,     # Admin manual entry
    'rss': 3,        # RSS feeds
    'ics': 3,        # ICS calendars
    'scraper': 4,    # Web scrapers (lowest priority)
}


class EventDeduplicator:
    """Handles event deduplication and merging."""
    
    def compute_fingerprint(
        self,
        title: str,
        start_datetime: Optional[datetime],
        lat: Optional[float] = None,
        lng: Optional[float] = None
    ) -> str:
        """
        Compute fingerprint for deduplication.
        
        Fingerprint is based on:
        - Normalized title
        - Date (without time)
        - Geo-hash (if location available)
        
        Args:
            title: Event title
            start_datetime: Event start time
            lat, lng: Event coordinates
            
        Returns:
            32-character fingerprint hash
        """
        # Normalize title
        title_norm = self._normalize_title(title)
        
        # Date+Time string (including hour for better dedup)
        # Normalize to Europe/Berlin timezone
        date_str = ""
        if start_datetime:
            berlin = pytz.timezone('Europe/Berlin')
            if start_datetime.tzinfo:
                local_dt = start_datetime.astimezone(berlin)
            else:
                local_dt = berlin.localize(start_datetime)
            date_str = local_dt.strftime("%Y-%m-%dT%H")  # Include hour
        
        # Geo-hash (precision 8 = ~38m x 19m for better accuracy)
        geo_str = ""
        if lat is not None and lng is not None:
            try:
                geo_str = geohash2.encode(lat, lng, precision=8)
            except Exception:
                pass
        
        # Combine and hash
        key = f"{title_norm}|{date_str}|{geo_str}"
        return hashlib.sha256(key.encode()).hexdigest()[:32]
    
    def find_match(
        self,
        fingerprint: str,
        title: str,
        start_datetime: Optional[datetime],
        existing_events: list[dict]
    ) -> DedupeMatch:
        """
        Find matching canonical event.
        
        Args:
            fingerprint: Computed fingerprint
            title: Event title
            start_datetime: Event start time
            existing_events: List of existing events to check against
            
        Returns:
            DedupeMatch with match info
        """
        # First, check exact fingerprint match
        for event in existing_events:
            if event.get('fingerprint') == fingerprint:
                return DedupeMatch(
                    canonical_event_id=event['id'],
                    match_type='exact',
                    confidence=1.0,
                    fingerprint=fingerprint,
                    matching_source_ids=event.get('source_ids', [])
                )
        
        # Fuzzy matching for similar events
        title_norm = self._normalize_title(title)
        
        for event in existing_events:
            existing_title = self._normalize_title(event.get('title', ''))
            
            # Same date?
            same_date = False
            if start_datetime and event.get('start_datetime'):
                event_date = datetime.fromisoformat(event['start_datetime'].replace('Z', '+00:00'))
                same_date = start_datetime.date() == event_date.date()
            
            if same_date:
                # Check title similarity
                similarity = self._title_similarity(title_norm, existing_title)
                
                if similarity > 0.85:
                    return DedupeMatch(
                        canonical_event_id=event['id'],
                        match_type='fuzzy',
                        confidence=similarity,
                        fingerprint=fingerprint,
                        matching_source_ids=event.get('source_ids', [])
                    )
        
        # No match found
        return DedupeMatch(
            canonical_event_id=None,
            match_type='none',
            confidence=0.0,
            fingerprint=fingerprint,
            matching_source_ids=[]
        )
    
    def merge_event_data(
        self,
        new_data: dict,
        new_source_type: str,
        existing_data: dict,
        existing_sources: list[dict]
    ) -> MergeResult:
        """
        Merge new event data with existing canonical event.
        
        Uses priority rules:
        1. Partner/API data wins over scraped data
        2. More complete data wins over less complete
        3. More recent data wins when priority equal
        
        Args:
            new_data: New event data from source
            new_source_type: Type of new source
            existing_data: Current canonical event data
            existing_sources: List of existing source records
            
        Returns:
            MergeResult with merged data and conflicts
        """
        merged = existing_data.copy()
        conflicts = []
        
        # Determine priority of new source
        new_priority = SOURCE_PRIORITY.get(new_source_type, 5)
        
        # Get best existing priority
        existing_priority = min(
            SOURCE_PRIORITY.get(s.get('source_type', 'scraper'), 5)
            for s in existing_sources
        ) if existing_sources else 5
        
        # Fields to potentially update
        merge_fields = [
            'title', 'description_short', 'description_long',
            'start_datetime', 'end_datetime',
            'location_address', 'location_lat', 'location_lng',
            'price_type', 'price_min', 'price_max',
            'age_min', 'age_max',
            'is_indoor', 'is_outdoor',
            'booking_url', 'contact_email', 'contact_phone',
            'image_urls'
        ]
        
        for field in merge_fields:
            new_value = new_data.get(field)
            existing_value = existing_data.get(field)
            
            # Skip if new value is empty
            if new_value is None or new_value == '' or new_value == []:
                continue
            
            # Check if we should update
            should_update = False
            
            if existing_value is None or existing_value == '' or existing_value == []:
                # Existing is empty, always use new
                should_update = True
            elif new_priority < existing_priority:
                # New source has higher priority
                should_update = True
            elif new_priority == existing_priority and new_value != existing_value:
                # Same priority, different values - log conflict
                conflicts.append({
                    'field': field,
                    'existing_value': existing_value,
                    'new_value': new_value,
                    'resolution': 'kept_existing'
                })
            
            if should_update:
                merged[field] = new_value
                if existing_value and new_value != existing_value:
                    conflicts.append({
                        'field': field,
                        'existing_value': existing_value,
                        'new_value': new_value,
                        'resolution': 'used_new'
                    })
        
        # Update completeness score
        merged['completeness_score'] = self._calculate_completeness(merged)
        
        # Determine primary source
        primary_source_id = existing_data.get('primary_source_id')
        if new_priority < existing_priority:
            primary_source_id = new_data.get('source_id')
        
        return MergeResult(
            merged_data=merged,
            conflicts=conflicts,
            primary_source_id=primary_source_id
        )
    
    def _normalize_title(self, title: str) -> str:
        """Normalize title for comparison.
        
        Removes date fragments, times, emojis, stopwords to reduce noise.
        """
        title = title.lower()
        
        # Remove date fragments: "15.03.", "2026", "15. März"
        title = re.sub(r'\d{1,2}\.\d{1,2}\.(\d{2,4})?', '', title)
        title = re.sub(r'\b\d{4}\b', '', title)
        
        # Remove times: "14:00", "14 Uhr", "14.30"
        title = re.sub(r'\d{1,2}[:.]\d{2}', '', title)
        title = re.sub(r'\d{1,2}\s*uhr', '', title)
        
        # Remove emojis and special characters
        title = re.sub(r'[^\w\s]', '', title)
        
        # Remove German stopwords
        stopwords = {
            'und', 'der', 'die', 'das', 'in', 'im', 'am', 'an',
            'fuer', 'für', 'mit', 'von', 'zu', 'zum', 'zur',
            'den', 'dem', 'des', 'ein', 'eine', 'einer', 'einem',
        }
        title = ' '.join(w for w in title.split() if w not in stopwords)
        
        return title.strip()
    
    def _title_similarity(self, title1: str, title2: str) -> float:
        """Calculate similarity between two titles using Levenshtein + Jaccard mix."""
        if not title1 or not title2:
            return 0.0
        
        # Jaccard (word-level overlap)
        words1 = set(title1.split())
        words2 = set(title2.split())
        jaccard = len(words1 & words2) / len(words1 | words2) if (words1 | words2) else 0.0
        
        # Levenshtein ratio (character-level, via SequenceMatcher)
        levenshtein = SequenceMatcher(None, title1, title2).ratio()
        
        # Weighted mix: 60% Levenshtein + 40% Jaccard
        return 0.6 * levenshtein + 0.4 * jaccard
    
    def _calculate_completeness(self, event: dict) -> int:
        """Calculate completeness score (0-100)."""
        # Required fields (50% weight)
        required_fields = [
            'title', 'start_datetime', 'location_address',
            'price_type', 'booking_url'
        ]
        required_score = sum(
            1 for f in required_fields 
            if event.get(f) not in [None, '', []]
        ) / len(required_fields) * 50
        
        # Optional fields (50% weight)
        optional_fields = [
            'description_short', 'description_long',
            'end_datetime', 'location_lat', 'location_lng',
            'age_min', 'age_max', 'is_indoor', 'is_outdoor',
            'contact_email', 'contact_phone', 'image_urls'
        ]
        optional_score = sum(
            1 for f in optional_fields 
            if event.get(f) not in [None, '', [], False]
        ) / len(optional_fields) * 50
        
        return int(required_score + optional_score)
