"""Health check endpoints."""

from fastapi import APIRouter
from datetime import datetime

router = APIRouter()


@router.get("/")
async def health_check():
    """Basic health check."""
    return {
        "status": "ok",
        "timestamp": datetime.utcnow().isoformat(),
        "service": "ai-worker"
    }


@router.get("/ready")
async def readiness_check():
    """Readiness check including dependencies."""
    checks = {
        "database": "unknown",
        "redis": "unknown",
        "openai": "unknown",
    }
    
    # TODO: Implement actual checks
    
    return {
        "status": "ok",
        "checks": checks
    }
