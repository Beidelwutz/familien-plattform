"""Main entry point for AI Worker service."""

import asyncio
import logging
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from src.config import get_settings
from src.routes import health, classify, plan, crawl
from src.routes.metrics import router as metrics_router

logger = logging.getLogger(__name__)

# Configure logging based on settings
settings = get_settings()

if settings.log_format == "json":
    from src.lib.json_logger import setup_json_logging
    setup_json_logging(level=settings.log_level, redact_pii=True)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Start the background worker consumer alongside the HTTP server."""
    from src.queue.worker import run_worker
    from src.queue import job_queue

    worker_task = asyncio.create_task(run_worker())
    logger.info("Background worker consumer started")
    yield
    # Shutdown: stop the worker consumer gracefully
    job_queue.stop()
    worker_task.cancel()
    try:
        await worker_task
    except asyncio.CancelledError:
        pass
    logger.info("Background worker consumer stopped")


app = FastAPI(
    title="Kiezling AI Worker",
    description="AI service for event classification, scoring, and plan generation",
    version="0.2.0",
    lifespan=lifespan,
)

# CORS middleware - origins from environment variable
cors_origins = [origin.strip() for origin in settings.cors_origins.split(",") if origin.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(health.router, prefix="/health", tags=["Health"])
app.include_router(classify.router, prefix="/classify", tags=["Classification"])
app.include_router(plan.router, prefix="/plan", tags=["Plan Generator"])
app.include_router(crawl.router, prefix="/crawl", tags=["Crawler"])
app.include_router(metrics_router, tags=["Metrics"])


@app.get("/")
async def root():
    """Root endpoint."""
    return {
        "service": "Familien-Lokal AI Worker",
        "version": "0.1.0",
        "status": "running"
    }


if __name__ == "__main__":
    uvicorn.run(
        "src.main:app",
        host="0.0.0.0",
        port=settings.port,
        reload=settings.debug
    )
