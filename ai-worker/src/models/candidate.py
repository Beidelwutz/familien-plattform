"""Canonical Candidate model for batch ingest."""

from dataclasses import dataclass, field, asdict
from datetime import datetime
from typing import Optional, Any
import hashlib
import json


@dataclass
class CandidateData:
    """Normalized event data."""
    title: str
    description: Optional[str] = None
    start_at: Optional[str] = None  # ISO UTC
    end_at: Optional[str] = None
    timezone_original: Optional[str] = None
    
    # Location / Venue
    venue_name: Optional[str] = None
    address: Optional[str] = None
    city: Optional[str] = None
    postal_code: Optional[str] = None
    lat: Optional[float] = None
    lng: Optional[float] = None
    
    # Pricing
    price_min: Optional[float] = None
    price_max: Optional[float] = None
    price_details: Optional[dict] = None  # {adult: {min, max}, child: {min, max}, family: {min, max}, currency: "EUR"}
    
    # Ticket/Booking Status
    availability_status: Optional[str] = None  # available, sold_out, waitlist, registration_required, unknown
    registration_deadline: Optional[str] = None  # ISO UTC
    
    # Age
    age_min: Optional[int] = None
    age_max: Optional[int] = None
    age_recommendation_text: Optional[str] = None  # "Empfohlen ab 6 Jahren"
    sibling_friendly: Optional[bool] = None  # Für jüngere Geschwister okay?
    
    # Categories & Tags
    categories: Optional[list[str]] = None
    tags: Optional[list[str]] = None
    
    # Indoor/Outdoor
    is_indoor: Optional[bool] = None
    is_outdoor: Optional[bool] = None
    
    # Language & Comprehension
    language: Optional[str] = None  # "Deutsch", "Englisch"
    complexity_level: Optional[str] = None  # simple, moderate, advanced
    
    # Stressfree Details
    noise_level: Optional[str] = None  # quiet, moderate, loud
    has_seating: Optional[bool] = None
    typical_wait_minutes: Optional[int] = None
    food_drink_allowed: Optional[bool] = None
    
    # Capacity
    capacity: Optional[int] = None
    spots_limited: Optional[bool] = None
    early_arrival_hint: Optional[str] = None  # "Früh da sein empfohlen"
    
    # Series / Recurrence
    recurrence_rule: Optional[str] = None  # iCal RRULE or "jeden Samstag"
    next_occurrences: Optional[list[str]] = None  # Array of next dates (ISO)
    
    # Transit/Arrival Info
    transit_stop: Optional[str] = None
    transit_walk_minutes: Optional[int] = None
    has_parking: Optional[bool] = None
    
    # Media & Contact
    images: Optional[list[str]] = None
    booking_url: Optional[str] = None
    contact_email: Optional[str] = None
    contact_phone: Optional[str] = None
    
    def to_dict(self) -> dict:
        """Convert to dict, excluding None values."""
        result = {}
        for key, value in asdict(self).items():
            if value is not None:
                result[key] = value
        return result


@dataclass
class AIClassification:
    """AI classification results."""
    categories: list[str]
    age_min: Optional[int] = None
    age_max: Optional[int] = None
    age_recommendation_text: Optional[str] = None  # "Empfohlen ab 6 Jahren"
    sibling_friendly: Optional[bool] = None  # Für jüngere Geschwister okay?
    is_indoor: Optional[bool] = None
    is_outdoor: Optional[bool] = None
    
    # Language & Comprehension
    language: Optional[str] = None  # "Deutsch", "Englisch"
    complexity_level: Optional[str] = None  # simple, moderate, advanced
    
    # Stressfree Details (AI-inferred)
    noise_level: Optional[str] = None  # quiet, moderate, loud
    has_seating: Optional[bool] = None
    typical_wait_minutes: Optional[int] = None
    food_drink_allowed: Optional[bool] = None
    
    # AI-extracted datetime (from description text, e.g. "17 Uhr")
    extracted_start_datetime: Optional[str] = None  # ISO-8601 format
    extracted_end_datetime: Optional[str] = None    # ISO-8601 format
    datetime_confidence: float = 0.0
    
    # AI-extracted price (from description text)
    extracted_price_type: Optional[str] = None  # "free", "paid", "donation", null
    extracted_price_min: Optional[float] = None
    extracted_price_max: Optional[float] = None
    price_confidence: float = 0.0
    
    # AI-extracted location (from description text)
    extracted_location_address: Optional[str] = None
    extracted_location_district: Optional[str] = None
    location_confidence: float = 0.0
    
    # AI-extracted venue (separate from address)
    extracted_venue_name: Optional[str] = None
    extracted_address_line: Optional[str] = None
    extracted_city: Optional[str] = None
    extracted_postal_code: Optional[str] = None
    venue_confidence: float = 0.0
    
    # AI-extracted cancellation / availability
    is_cancelled_or_postponed: Optional[bool] = None
    
    # AI-generated summaries
    ai_summary_short: Optional[str] = None  # max 300 chars
    ai_summary_highlights: list[str] = field(default_factory=list)  # max 3 items
    ai_fit_blurb: Optional[str] = None  # max 150 chars
    summary_confidence: float = 0.0
    
    confidence: float = 0.0
    model: Optional[str] = None
    prompt_version: Optional[str] = None


@dataclass
class AIScores:
    """AI scoring results."""
    relevance: int
    quality: int
    family_fit: int
    stressfree: Optional[int] = None
    confidence: float = 0.0
    model: Optional[str] = None


@dataclass
class AIGeocode:
    """AI geocoding results."""
    lat: float
    lng: float
    confidence: float
    match_type: Optional[str] = None  # rooftop, street, city
    normalized_address: Optional[str] = None


@dataclass
class AISuggestions:
    """All AI suggestions for a candidate."""
    classification: Optional[AIClassification] = None
    scores: Optional[AIScores] = None
    geocode: Optional[AIGeocode] = None
    
    def to_dict(self) -> dict:
        """Convert to dict for JSON serialization."""
        result = {}
        if self.classification:
            result['classification'] = asdict(self.classification)
        if self.scores:
            result['scores'] = asdict(self.scores)
        if self.geocode:
            result['geocode'] = asdict(self.geocode)
        return result if result else None


@dataclass
class Versions:
    """Version tracking for reprocessing."""
    parser: str = "1.0.0"
    normalizer: str = "1.0.0"


@dataclass
class CanonicalCandidate:
    """
    Canonical Candidate for batch ingest to backend.
    
    This is the contract between AI-Worker and Backend.
    """
    source_type: str  # rss, ics, scraper, api, partner
    source_url: str
    fingerprint: str
    raw_hash: str
    extracted_at: str  # ISO timestamp
    data: CandidateData
    external_id: Optional[str] = None
    ai: Optional[AISuggestions] = None
    versions: Optional[Versions] = None
    
    def to_dict(self) -> dict:
        """Convert to dict for JSON serialization."""
        result = {
            'source_type': self.source_type,
            'source_url': self.source_url,
            'fingerprint': self.fingerprint,
            'raw_hash': self.raw_hash,
            'extracted_at': self.extracted_at,
            'data': self.data.to_dict() if isinstance(self.data, CandidateData) else self.data,
        }
        if self.external_id:
            result['external_id'] = self.external_id
        if self.ai:
            ai_dict = self.ai.to_dict() if isinstance(self.ai, AISuggestions) else self.ai
            if ai_dict:
                result['ai'] = ai_dict
        if self.versions:
            result['versions'] = asdict(self.versions) if isinstance(self.versions, Versions) else self.versions
        return result
    
    @staticmethod
    def compute_fingerprint(
        title: str,
        start_at: Optional[str],
        address: Optional[str] = None,
        external_id: Optional[str] = None,
        source_url: Optional[str] = None
    ) -> str:
        """
        Compute stable fingerprint for deduplication.
        
        Priority:
        1. external_id + start_date (if available)
        2. source_url + start_date
        3. normalized_title + start_date + address
        """
        import re
        
        # Normalize title
        title_norm = re.sub(r'[^\w\s]', '', title.lower().strip())
        title_norm = ' '.join(title_norm.split())
        
        # Extract date only from start_at
        date_str = ""
        if start_at:
            try:
                dt = datetime.fromisoformat(start_at.replace('Z', '+00:00'))
                date_str = dt.strftime("%Y-%m-%d")
            except:
                date_str = start_at[:10] if len(start_at) >= 10 else start_at
        
        # Normalize address
        addr_norm = ""
        if address:
            addr_norm = re.sub(r'[^\w\s]', '', address.lower().strip())[:50]
        
        # Build key based on available data
        if external_id:
            key = f"{external_id}|{date_str}"
        elif source_url:
            key = f"{source_url}|{date_str}"
        else:
            key = f"{title_norm}|{date_str}|{addr_norm}"
        
        return hashlib.sha256(key.encode()).hexdigest()[:32]
    
    @staticmethod
    def compute_raw_hash(data: dict) -> str:
        """Compute hash of extracted fields for change detection."""
        # Sort keys for deterministic hashing
        json_str = json.dumps(data, sort_keys=True, default=str)
        return hashlib.sha256(json_str.encode()).hexdigest()[:32]


@dataclass
class IngestBatchRequest:
    """Request payload for batch ingest endpoint."""
    run_id: Optional[str]
    source_id: str
    candidates: list[CanonicalCandidate]
    
    def to_dict(self) -> dict:
        return {
            'run_id': self.run_id,
            'source_id': self.source_id,
            'candidates': [c.to_dict() for c in self.candidates],
        }


@dataclass
class MergeReason:
    """Reason why a field was not updated."""
    field: str
    reason: str  # locked, source_priority_lower, stale_data, null_value, unchanged
    current_source: Optional[str] = None
    candidate_source: Optional[str] = None


@dataclass
class IngestItemResult:
    """Result for a single ingested item."""
    fingerprint: str
    status: str  # created, updated, unchanged, ignored, conflict
    event_id: Optional[str] = None
    raw_item_id: Optional[str] = None
    applied_fields: list[str] = field(default_factory=list)
    ignored_fields: list[str] = field(default_factory=list)
    merge_reasons: list[MergeReason] = field(default_factory=list)


@dataclass
class IngestBatchResponse:
    """Response from batch ingest endpoint."""
    run_id: str
    correlation_id: str
    results: list[IngestItemResult]
    summary: dict  # {created, updated, unchanged, ignored}
