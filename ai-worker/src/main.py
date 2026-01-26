"""Main entry point for AI Worker service."""

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from src.config import get_settings
from src.routes import health, classify, plan, crawl

settings = get_settings()

app = FastAPI(
    title="Familien-Lokal AI Worker",
    description="AI service for event classification, scoring, and plan generation",
    version="0.1.0",
)

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:4000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(health.router, prefix="/health", tags=["Health"])
app.include_router(classify.router, prefix="/classify", tags=["Classification"])
app.include_router(plan.router, prefix="/plan", tags=["Plan Generator"])
app.include_router(crawl.router, prefix="/crawl", tags=["Crawler"])


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
