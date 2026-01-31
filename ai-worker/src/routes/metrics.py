"""Metrics endpoint for monitoring and observability."""

from datetime import datetime, timedelta
from typing import Optional
import logging

from fastapi import APIRouter, Depends

from src.queue import job_queue, QUEUE_CRAWL, QUEUE_CLASSIFY, QUEUE_SCORE, QUEUE_GEOCODE
from src.monitoring.ai_cost_tracker import AICostTracker, BudgetStatus
from src.config import get_settings

router = APIRouter(prefix="/metrics", tags=["metrics"])
logger = logging.getLogger(__name__)

# Global cost tracker (should be shared with worker)
_cost_tracker: Optional[AICostTracker] = None


def get_cost_tracker() -> AICostTracker:
    """Get or create cost tracker instance."""
    global _cost_tracker
    if _cost_tracker is None:
        settings = get_settings()
        _cost_tracker = AICostTracker(
            daily_limit_usd=settings.ai_daily_limit_usd,
            monthly_limit_usd=settings.ai_monthly_limit_usd
        )
    return _cost_tracker


@router.get("")
async def get_metrics():
    """
    Get current metrics for monitoring.
    
    Returns:
        Metrics including queue depths, DLQ count, budget status, etc.
    """
    try:
        await job_queue.connect()
        
        # Queue depths
        queue_depths = {
            "crawl": await job_queue.get_queue_length(QUEUE_CRAWL),
            "classify": await job_queue.get_queue_length(QUEUE_CLASSIFY),
            "score": await job_queue.get_queue_length(QUEUE_SCORE),
            "geocode": await job_queue.get_queue_length(QUEUE_GEOCODE),
        }
        
        # DLQ count
        dlq_count = await job_queue.get_dlq_count()
        
        # Budget status
        cost_tracker = get_cost_tracker()
        budget = cost_tracker.check_budget()
        
        # Usage summary
        usage = cost_tracker.get_usage_summary(days=7)
        
        return {
            "timestamp": datetime.utcnow().isoformat() + "Z",
            "queues": {
                "depths": queue_depths,
                "total_pending": sum(queue_depths.values()),
            },
            "dlq": {
                "count": dlq_count,
                "alert": dlq_count > 10,  # Alert threshold
            },
            "budget": {
                "status": budget.status.value,
                "can_proceed": budget.can_proceed,
                "daily": {
                    "used_usd": round(budget.daily_used, 4),
                    "limit_usd": budget.daily_limit,
                    "remaining_usd": round(budget.daily_remaining, 4),
                    "percent_used": round((budget.daily_used / budget.daily_limit * 100) if budget.daily_limit > 0 else 0, 1),
                },
                "monthly": {
                    "used_usd": round(budget.monthly_used, 4),
                    "limit_usd": budget.monthly_limit,
                    "remaining_usd": round(budget.monthly_remaining, 4),
                    "percent_used": round((budget.monthly_used / budget.monthly_limit * 100) if budget.monthly_limit > 0 else 0, 1),
                },
            },
            "usage_7d": {
                "total_calls": usage["total_calls"],
                "total_cost_usd": round(usage["total_cost_usd"], 4),
                "by_model": usage["by_model"],
                "by_operation": usage["by_operation"],
            },
        }
    except Exception as e:
        logger.error(f"Failed to get metrics: {e}")
        return {
            "timestamp": datetime.utcnow().isoformat() + "Z",
            "error": str(e),
            "queues": {"error": "Redis unavailable"},
            "dlq": {"error": "Redis unavailable"},
            "budget": {"error": "Unable to check"},
        }


@router.get("/prometheus")
async def get_prometheus_metrics():
    """
    Get metrics in Prometheus exposition format.
    
    Returns:
        Prometheus-compatible text format metrics
    """
    try:
        await job_queue.connect()
        
        lines = [
            "# HELP kiezling_queue_depth Number of jobs in queue",
            "# TYPE kiezling_queue_depth gauge",
            f'kiezling_queue_depth{{queue="crawl"}} {await job_queue.get_queue_length(QUEUE_CRAWL)}',
            f'kiezling_queue_depth{{queue="classify"}} {await job_queue.get_queue_length(QUEUE_CLASSIFY)}',
            f'kiezling_queue_depth{{queue="score"}} {await job_queue.get_queue_length(QUEUE_SCORE)}',
            f'kiezling_queue_depth{{queue="geocode"}} {await job_queue.get_queue_length(QUEUE_GEOCODE)}',
            "",
            "# HELP kiezling_dlq_count Number of jobs in dead letter queue",
            "# TYPE kiezling_dlq_count gauge",
            f"kiezling_dlq_count {await job_queue.get_dlq_count()}",
            "",
        ]
        
        # Budget metrics
        cost_tracker = get_cost_tracker()
        budget = cost_tracker.check_budget()
        
        lines.extend([
            "# HELP kiezling_ai_cost_daily_usd Daily AI cost in USD",
            "# TYPE kiezling_ai_cost_daily_usd gauge",
            f"kiezling_ai_cost_daily_usd {budget.daily_used:.4f}",
            "",
            "# HELP kiezling_ai_cost_monthly_usd Monthly AI cost in USD",
            "# TYPE kiezling_ai_cost_monthly_usd gauge",
            f"kiezling_ai_cost_monthly_usd {budget.monthly_used:.4f}",
            "",
            "# HELP kiezling_ai_budget_exceeded Whether AI budget is exceeded (1=yes, 0=no)",
            "# TYPE kiezling_ai_budget_exceeded gauge",
            f"kiezling_ai_budget_exceeded {1 if budget.status == BudgetStatus.EXCEEDED else 0}",
            "",
        ])
        
        return "\n".join(lines)
    except Exception as e:
        return f"# Error getting metrics: {e}\n"


@router.get("/health-summary")
async def get_health_summary():
    """
    Get a quick health summary for dashboards.
    
    Returns:
        Simple health status with key indicators
    """
    try:
        await job_queue.connect()
        
        dlq_count = await job_queue.get_dlq_count()
        total_pending = sum([
            await job_queue.get_queue_length(QUEUE_CRAWL),
            await job_queue.get_queue_length(QUEUE_CLASSIFY),
            await job_queue.get_queue_length(QUEUE_SCORE),
            await job_queue.get_queue_length(QUEUE_GEOCODE),
        ])
        
        cost_tracker = get_cost_tracker()
        budget = cost_tracker.check_budget()
        
        # Determine overall status
        status = "healthy"
        issues = []
        
        if dlq_count > 10:
            status = "degraded"
            issues.append(f"DLQ has {dlq_count} jobs")
        
        if budget.status == BudgetStatus.EXCEEDED:
            status = "degraded"
            issues.append("AI budget exceeded")
        elif budget.status == BudgetStatus.CRITICAL:
            issues.append("AI budget critical (>90%)")
        
        if total_pending > 100:
            issues.append(f"High queue backlog ({total_pending} jobs)")
        
        return {
            "status": status,
            "issues": issues,
            "indicators": {
                "queue_pending": total_pending,
                "dlq_count": dlq_count,
                "budget_status": budget.status.value,
                "ai_enabled": get_settings().enable_ai,
            },
            "timestamp": datetime.utcnow().isoformat() + "Z",
        }
    except Exception as e:
        return {
            "status": "unhealthy",
            "issues": [f"Failed to check health: {e}"],
            "indicators": {},
            "timestamp": datetime.utcnow().isoformat() + "Z",
        }
