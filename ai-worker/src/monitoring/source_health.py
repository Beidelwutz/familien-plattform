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
