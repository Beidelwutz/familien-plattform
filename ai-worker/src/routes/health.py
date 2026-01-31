"""Health check endpoints."""

from fastapi import APIRouter
from datetime import datetime
import asyncio
import logging

import redis.asyncio as redis
import httpx

from src.config import get_settings

router = APIRouter()
logger = logging.getLogger(__name__)
settings = get_settings()


@router.get("/")
async def health_check():
    """Basic health check - always returns ok if service is running."""
    return {
        "status": "ok",
        "timestamp": datetime.utcnow().isoformat(),
        "service": "ai-worker",
        "version": "0.1.0"
    }


@router.get("/ready")
async def readiness_check():
    """
    Readiness check including all dependencies.
    Returns detailed status of each service connection.
    """
    checks = {}
    overall_status = "ok"
    
    # Check Redis
    redis_status = await _check_redis()
    checks["redis"] = redis_status
    if redis_status["status"] != "ok":
        overall_status = "degraded"
    
    # Check Backend connectivity
    backend_status = await _check_backend()
    checks["backend"] = backend_status
    if backend_status["status"] != "ok":
        overall_status = "degraded"
    
    # Check OpenAI API (only if key is configured)
    if settings.openai_api_key:
        openai_status = await _check_openai()
        checks["openai"] = openai_status
        # OpenAI is optional, don't degrade status if unavailable
    else:
        checks["openai"] = {"status": "not_configured"}
    
    return {
        "status": overall_status,
        "timestamp": datetime.utcnow().isoformat(),
        "checks": checks,
        "config": {
            "backend_url": settings.backend_url,
            "redis_url": settings.redis_url.split("@")[-1] if "@" in settings.redis_url else settings.redis_url,
        }
    }


async def _check_redis() -> dict:
    """Check Redis connection."""
    try:
        client = redis.from_url(settings.redis_url, decode_responses=True)
        await asyncio.wait_for(client.ping(), timeout=5.0)
        await client.close()
        return {"status": "ok", "latency_ms": None}
    except asyncio.TimeoutError:
        return {"status": "timeout", "error": "Connection timed out"}
    except Exception as e:
        logger.warning(f"Redis health check failed: {e}")
        return {"status": "error", "error": str(e)}


async def _check_backend() -> dict:
    """Check Backend API connectivity."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.get(f"{settings.backend_url}/api/health")
            if response.status_code == 200:
                return {"status": "ok", "url": settings.backend_url}
            else:
                return {"status": "error", "http_status": response.status_code}
    except httpx.TimeoutException:
        return {"status": "timeout", "error": "Connection timed out"}
    except Exception as e:
        logger.warning(f"Backend health check failed: {e}")
        return {"status": "error", "error": str(e)}


async def _check_openai() -> dict:
    """Check OpenAI API connectivity."""
    try:
        import openai
        client = openai.AsyncOpenAI(api_key=settings.openai_api_key)
        # Just list models to verify API key works (minimal cost)
        models = await asyncio.wait_for(
            client.models.list(),
            timeout=10.0
        )
        return {"status": "ok", "models_available": True}
    except asyncio.TimeoutError:
        return {"status": "timeout", "error": "API request timed out"}
    except Exception as e:
        logger.warning(f"OpenAI health check failed: {e}")
        return {"status": "error", "error": str(e)[:100]}
