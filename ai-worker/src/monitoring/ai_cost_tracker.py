"""AI cost tracking and budget management."""

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Optional
from enum import Enum


class BudgetStatus(Enum):
    OK = "ok"
    WARNING = "warning"  # 70-90% used
    CRITICAL = "critical"  # 90-100% used
    EXCEEDED = "exceeded"  # >100%


@dataclass
class CostEntry:
    """Single AI API call cost entry."""
    timestamp: datetime
    model: str
    operation: str  # classify, score, enrich, plan
    input_tokens: int
    output_tokens: int
    estimated_cost_usd: float
    event_id: Optional[str] = None
    user_id: Optional[str] = None


@dataclass
class BudgetCheck:
    """Result of budget check."""
    status: BudgetStatus
    daily_used: float
    daily_limit: float
    daily_remaining: float
    monthly_used: float
    monthly_limit: float
    monthly_remaining: float
    can_proceed: bool
    message: str


# Cost per 1000 tokens (approximate, as of 2024)
MODEL_COSTS = {
    # OpenAI
    "gpt-4o": {"input": 0.005, "output": 0.015},
    "gpt-4o-mini": {"input": 0.00015, "output": 0.0006},
    "gpt-4-turbo": {"input": 0.01, "output": 0.03},
    
    # Anthropic
    "claude-3-opus": {"input": 0.015, "output": 0.075},
    "claude-3-sonnet": {"input": 0.003, "output": 0.015},
    "claude-3-haiku": {"input": 0.00025, "output": 0.00125},
}


class AICostTracker:
    """Track AI API costs and enforce budgets."""
    
    def __init__(
        self,
        daily_limit_usd: float = 10.0,
        monthly_limit_usd: float = 200.0
    ):
        self.daily_limit = daily_limit_usd
        self.monthly_limit = monthly_limit_usd
        self._entries: list[CostEntry] = []
    
    def log_usage(
        self,
        model: str,
        operation: str,
        input_tokens: int,
        output_tokens: int,
        event_id: Optional[str] = None,
        user_id: Optional[str] = None
    ) -> CostEntry:
        """
        Log an AI API call.
        
        Args:
            model: Model name (e.g., 'gpt-4o-mini')
            operation: Operation type (classify, score, etc.)
            input_tokens: Number of input tokens
            output_tokens: Number of output tokens
            event_id: Optional event ID
            user_id: Optional user ID
            
        Returns:
            CostEntry with calculated cost
        """
        cost = self._calculate_cost(model, input_tokens, output_tokens)
        
        entry = CostEntry(
            timestamp=datetime.utcnow(),
            model=model,
            operation=operation,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            estimated_cost_usd=cost,
            event_id=event_id,
            user_id=user_id
        )
        
        self._entries.append(entry)
        
        return entry
    
    def check_budget(self) -> BudgetCheck:
        """
        Check current budget status.
        
        Returns:
            BudgetCheck with status and remaining budget
        """
        now = datetime.utcnow()
        today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        
        # Calculate daily usage
        daily_entries = [e for e in self._entries if e.timestamp >= today_start]
        daily_used = sum(e.estimated_cost_usd for e in daily_entries)
        
        # Calculate monthly usage
        monthly_entries = [e for e in self._entries if e.timestamp >= month_start]
        monthly_used = sum(e.estimated_cost_usd for e in monthly_entries)
        
        # Determine status
        daily_pct = daily_used / self.daily_limit if self.daily_limit > 0 else 0
        monthly_pct = monthly_used / self.monthly_limit if self.monthly_limit > 0 else 0
        
        max_pct = max(daily_pct, monthly_pct)
        
        if max_pct >= 1.0:
            status = BudgetStatus.EXCEEDED
            can_proceed = False
            message = "Budget exceeded - AI operations paused"
        elif max_pct >= 0.9:
            status = BudgetStatus.CRITICAL
            can_proceed = True  # Allow essential operations only
            message = "Budget critical (>90%) - only essential operations"
        elif max_pct >= 0.7:
            status = BudgetStatus.WARNING
            can_proceed = True
            message = "Budget warning (>70%) - consider reducing usage"
        else:
            status = BudgetStatus.OK
            can_proceed = True
            message = "Budget OK"
        
        return BudgetCheck(
            status=status,
            daily_used=daily_used,
            daily_limit=self.daily_limit,
            daily_remaining=max(0, self.daily_limit - daily_used),
            monthly_used=monthly_used,
            monthly_limit=self.monthly_limit,
            monthly_remaining=max(0, self.monthly_limit - monthly_used),
            can_proceed=can_proceed,
            message=message
        )
    
    def can_run_operation(self, operation: str) -> bool:
        """
        Check if an operation can run given current budget.
        
        Essential operations (like plan_generator) may run even at warning level.
        """
        budget = self.check_budget()
        
        if budget.status == BudgetStatus.EXCEEDED:
            return False
        
        if budget.status == BudgetStatus.CRITICAL:
            # Only allow essential operations
            essential_ops = ["plan"]  # User-facing
            return operation in essential_ops
        
        return True
    
    def get_usage_summary(self, days: int = 7) -> dict:
        """
        Get usage summary for the last N days.
        
        Returns:
            Summary with totals by model and operation
        """
        cutoff = datetime.utcnow() - timedelta(days=days)
        recent = [e for e in self._entries if e.timestamp >= cutoff]
        
        by_model = {}
        by_operation = {}
        by_day = {}
        
        for entry in recent:
            # By model
            if entry.model not in by_model:
                by_model[entry.model] = {"calls": 0, "cost": 0}
            by_model[entry.model]["calls"] += 1
            by_model[entry.model]["cost"] += entry.estimated_cost_usd
            
            # By operation
            if entry.operation not in by_operation:
                by_operation[entry.operation] = {"calls": 0, "cost": 0}
            by_operation[entry.operation]["calls"] += 1
            by_operation[entry.operation]["cost"] += entry.estimated_cost_usd
            
            # By day
            day = entry.timestamp.strftime("%Y-%m-%d")
            if day not in by_day:
                by_day[day] = {"calls": 0, "cost": 0}
            by_day[day]["calls"] += 1
            by_day[day]["cost"] += entry.estimated_cost_usd
        
        return {
            "period_days": days,
            "total_calls": len(recent),
            "total_cost_usd": sum(e.estimated_cost_usd for e in recent),
            "by_model": by_model,
            "by_operation": by_operation,
            "by_day": by_day
        }
    
    def _calculate_cost(self, model: str, input_tokens: int, output_tokens: int) -> float:
        """Calculate cost for API call."""
        # Find model costs
        costs = MODEL_COSTS.get(model)
        
        if not costs:
            # Try to match partial model name
            for model_name, model_costs in MODEL_COSTS.items():
                if model_name in model.lower() or model.lower() in model_name:
                    costs = model_costs
                    break
        
        if not costs:
            # Default to cheap model pricing
            costs = MODEL_COSTS["gpt-4o-mini"]
        
        input_cost = (input_tokens / 1000) * costs["input"]
        output_cost = (output_tokens / 1000) * costs["output"]
        
        return input_cost + output_cost
