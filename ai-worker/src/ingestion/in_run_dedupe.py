"""In-run deduplication for batch processing.

This module handles deduplication ONLY within a single crawl run.
Final deduplication is handled by the Backend.
"""

from typing import TypeVar, Generic
from dataclasses import dataclass
import logging

logger = logging.getLogger(__name__)

T = TypeVar('T')


@dataclass
class DedupeStats:
    """Statistics from deduplication."""
    total_input: int
    unique_output: int
    duplicates_removed: int
    
    @property
    def duplicate_ratio(self) -> float:
        if self.total_input == 0:
            return 0.0
        return self.duplicates_removed / self.total_input


class InRunDeduplicator(Generic[T]):
    """
    Deduplicator that works ONLY within a single crawl run.
    
    This is NOT for cross-source deduplication - that's handled by the Backend.
    Purpose: Remove duplicates within a single feed/scrape to avoid sending
    redundant items to the backend.
    """
    
    def __init__(self, get_fingerprint):
        """
        Initialize deduplicator.
        
        Args:
            get_fingerprint: Function that extracts fingerprint from an item.
                            Signature: (item: T) -> str
        """
        self.get_fingerprint = get_fingerprint
        self._seen: set[str] = set()
        self._stats = DedupeStats(0, 0, 0)
    
    def dedupe(self, items: list[T]) -> list[T]:
        """
        Remove duplicates from a list of items.
        
        Only keeps the first occurrence of each fingerprint.
        
        Args:
            items: List of items to deduplicate
            
        Returns:
            List with duplicates removed
        """
        self._seen.clear()
        unique: list[T] = []
        duplicates = 0
        
        for item in items:
            fingerprint = self.get_fingerprint(item)
            
            if fingerprint not in self._seen:
                self._seen.add(fingerprint)
                unique.append(item)
            else:
                duplicates += 1
                logger.debug(f"Duplicate found: {fingerprint[:8]}...")
        
        self._stats = DedupeStats(
            total_input=len(items),
            unique_output=len(unique),
            duplicates_removed=duplicates
        )
        
        if duplicates > 0:
            logger.info(f"In-run dedupe: {duplicates} duplicates removed from {len(items)} items")
        
        return unique
    
    @property
    def stats(self) -> DedupeStats:
        """Get statistics from last deduplication."""
        return self._stats


def create_candidate_deduplicator():
    """Create a deduplicator for CanonicalCandidate objects."""
    from src.models.candidate import CanonicalCandidate
    
    def get_fingerprint(candidate: CanonicalCandidate) -> str:
        return candidate.fingerprint
    
    return InRunDeduplicator[CanonicalCandidate](get_fingerprint)


def create_parsed_event_deduplicator():
    """Create a deduplicator for ParsedEvent objects."""
    from src.crawlers.feed_parser import ParsedEvent
    
    def get_fingerprint(event: ParsedEvent) -> str:
        return event.fingerprint
    
    return InRunDeduplicator[ParsedEvent](get_fingerprint)
