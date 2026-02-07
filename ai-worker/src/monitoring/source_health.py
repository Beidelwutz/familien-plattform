"""Source health monitoring service."""

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Optional
from enum import Enum


class HealthStatus(Enum):
    HEALTHY = "healthy"
    DEGRADED = "degraded"
    FAILING = "failing"
    DEAD = "dead"
    UNKNOWN = "unknown"


@dataclass
class HealthEvaluation:
    """Result of health evaluation."""
    status: HealthStatus
    reason: str
    should_alert: bool
    recommended_action: Optional[str]


class SourceHealthMonitor:
    """Monitor and evaluate source health."""
    
    # Thresholds
    MAX_CONSECUTIVE_FAILURES = 3
    STALE_THRESHOLD_DAYS = 7
    EVENT_COUNT_DROP_THRESHOLD = 0.5  # 50% drop
    
    def evaluate(
        self,
        consecutive_failures: int,
        last_success_at: Optional[datetime],
        last_event_count: Optional[int],
        expected_event_count_min: Optional[int],
        last_fetch_status: Optional[str]
    ) -> HealthEvaluation:
        """
        Evaluate source health based on multiple factors.
        
        Args:
            consecutive_failures: Number of consecutive failed fetches
            last_success_at: Timestamp of last successful fetch
            last_event_count: Number of events from last successful fetch
            expected_event_count_min: Minimum expected events
            last_fetch_status: Status of last fetch (success, partial, error)
            
        Returns:
            HealthEvaluation with status and recommendations
        """
        # Check for consecutive failures
        if consecutive_failures >= self.MAX_CONSECUTIVE_FAILURES:
            return HealthEvaluation(
                status=HealthStatus.FAILING,
                reason=f"{consecutive_failures} consecutive failures",
                should_alert=True,
                recommended_action="Check source URL and parser configuration"
            )
        
        # Check for stale data
        if last_success_at:
            days_since_success = (datetime.utcnow() - last_success_at).days
            if days_since_success >= self.STALE_THRESHOLD_DAYS:
                return HealthEvaluation(
                    status=HealthStatus.FAILING,
                    reason=f"No successful fetch for {days_since_success} days",
                    should_alert=True,
                    recommended_action="Investigate source availability"
                )
        else:
            # Never succeeded
            if consecutive_failures > 0:
                return HealthEvaluation(
                    status=HealthStatus.FAILING,
                    reason="Source has never successfully fetched",
                    should_alert=True,
                    recommended_action="Verify source configuration"
                )
            else:
                return HealthEvaluation(
                    status=HealthStatus.UNKNOWN,
                    reason="Source not yet fetched",
                    should_alert=False,
                    recommended_action=None
                )
        
        # Check for unusual event count drop
        if last_event_count is not None and expected_event_count_min is not None:
            if last_event_count < expected_event_count_min * self.EVENT_COUNT_DROP_THRESHOLD:
                return HealthEvaluation(
                    status=HealthStatus.DEGRADED,
                    reason=f"Only {last_event_count} events (expected >= {expected_event_count_min})",
                    should_alert=True,
                    recommended_action="Check if source content changed"
                )
        
        # Check for partial success
        if last_fetch_status == "partial":
            return HealthEvaluation(
                status=HealthStatus.DEGRADED,
                reason="Last fetch was partial (some events failed)",
                should_alert=False,
                recommended_action="Review partial fetch logs"
            )
        
        # All checks passed
        return HealthEvaluation(
            status=HealthStatus.HEALTHY,
            reason="All checks passed",
            should_alert=False,
            recommended_action=None
        )
    
    def should_disable_source(self, evaluation: HealthEvaluation) -> bool:
        """
        Determine if source should be automatically disabled.
        
        Returns True only for persistent failures (DEAD status).
        """
        return evaluation.status == HealthStatus.DEAD
    
    def get_retry_delay(self, consecutive_failures: int) -> int:
        """
        Get recommended retry delay based on failure count.
        
        Uses exponential backoff.
        
        Returns:
            Delay in seconds
        """
        base_delay = 300  # 5 minutes
        max_delay = 86400  # 24 hours
        
        delay = base_delay * (2 ** min(consecutive_failures, 8))
        return min(delay, max_delay)


@dataclass
class SourceHealthSummary:
    """Summary of all sources health."""
    total: int
    healthy: int
    degraded: int
    failing: int
    dead: int
    unknown: int
    
    @property
    def health_percentage(self) -> float:
        """Percentage of healthy sources."""
        if self.total == 0:
            return 100.0
        return (self.healthy / self.total) * 100


def create_health_summary(source_statuses: list[HealthStatus]) -> SourceHealthSummary:
    """Create summary from list of health statuses."""
    return SourceHealthSummary(
        total=len(source_statuses),
        healthy=sum(1 for s in source_statuses if s == HealthStatus.HEALTHY),
        degraded=sum(1 for s in source_statuses if s == HealthStatus.DEGRADED),
        failing=sum(1 for s in source_statuses if s == HealthStatus.FAILING),
        dead=sum(1 for s in source_statuses if s == HealthStatus.DEAD),
        unknown=sum(1 for s in source_statuses if s == HealthStatus.UNKNOWN),
    )


# ==================== Source Quality Tracking ====================

# Field-specific emptiness checks (0 is valid for price_min!)
FIELD_RULES = {
    'title':            lambda v: isinstance(v, str) and v.strip() != '',
    'description':      lambda v: isinstance(v, str) and len(v.strip()) > 10,
    'start_datetime':   lambda v: v is not None,
    'end_datetime':     lambda v: v is not None,
    'location_address': lambda v: isinstance(v, str) and v.strip() != '',
    'venue_name':       lambda v: isinstance(v, str) and v.strip() != '',
    'price_type':       lambda v: v is not None and v != 'unknown',
    'price_min':        lambda v: v is not None,  # 0 is VALID (free)!
    'age_min':          lambda v: v is not None,
    'image_urls':       lambda v: isinstance(v, list) and len(v) > 0,
    'booking_url':      lambda v: isinstance(v, str) and v.startswith('http'),
}


class SourceQuality:
    """Track field-level quality per source."""
    
    def compute_field_coverage(self, events: list[dict]) -> dict[str, float]:
        """
        Compute per-field fill rate across a batch of events.
        
        Args:
            events: List of event dicts
            
        Returns:
            Dict of field -> percentage filled (0-100)
        """
        if not events:
            return {}
        
        coverage = {}
        for field, check_fn in FIELD_RULES.items():
            try:
                filled = sum(1 for e in events if check_fn(e.get(field)))
                coverage[field] = round(filled / len(events) * 100, 1)
            except Exception:
                coverage[field] = 0.0
        
        return coverage
    
    def compute_overall_quality(self, coverage: dict[str, float]) -> float:
        """Compute weighted overall quality score (0-100)."""
        if not coverage:
            return 0.0
        
        # Important fields have higher weight
        weights = {
            'title': 3.0,
            'description': 2.0,
            'start_datetime': 3.0,
            'location_address': 2.0,
            'venue_name': 1.0,
            'price_type': 1.5,
            'price_min': 1.0,
            'age_min': 1.0,
            'image_urls': 1.5,
            'booking_url': 1.0,
            'end_datetime': 1.0,
        }
        
        total_weight = sum(weights.get(f, 1.0) for f in coverage)
        weighted_sum = sum(
            coverage.get(f, 0.0) * weights.get(f, 1.0)
            for f in coverage
        )
        
        return round(weighted_sum / total_weight, 1) if total_weight > 0 else 0.0
