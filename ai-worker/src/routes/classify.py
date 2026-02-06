"""Event classification and scoring endpoints."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
from datetime import datetime

from src.classifiers.event_classifier import EventClassifier
from src.scorers.event_scorer import EventScorer
from src.rules.rule_filter import RuleBasedFilter

router = APIRouter()

# Initialize components
rule_filter = RuleBasedFilter()
classifier = EventClassifier()
scorer = EventScorer()


class EventInput(BaseModel):
    """Input for event classification."""
    title: str
    description: Optional[str] = None
    location_address: Optional[str] = None
    price_min: Optional[float] = None
    price_max: Optional[float] = None
    is_indoor: Optional[bool] = None
    is_outdoor: Optional[bool] = None


class ClassificationResult(BaseModel):
    """Result of event classification."""
    is_relevant: Optional[bool]
    rule_matched: Optional[str]
    categories: list[str]
    age_min: Optional[int]
    age_max: Optional[int]
    is_indoor: bool
    is_outdoor: bool
    confidence: float
    used_ai: bool
    
    # Legacy fields (kept for backward compatibility)
    description_short: Optional[str] = None
    family_reason: Optional[str] = None
    
    # Age rating (FSK-style)
    age_rating: Optional[str] = None
    
    # Age fit buckets (0-100 score per age group)
    age_fit_buckets: Optional[dict] = None
    
    # AI Summary fields
    ai_summary_short: Optional[str] = None
    ai_summary_highlights: Optional[list[str]] = None
    ai_fit_blurb: Optional[str] = None
    summary_confidence: Optional[float] = None
    
    # Extracted datetime/location
    extracted_start_datetime: Optional[str] = None
    extracted_end_datetime: Optional[str] = None
    extracted_location_address: Optional[str] = None
    extracted_location_district: Optional[str] = None
    datetime_confidence: Optional[float] = None
    location_confidence: Optional[float] = None
    
    # Flags
    flags: Optional[dict] = None


class ScoringResult(BaseModel):
    """Result of event scoring."""
    relevance_score: int
    quality_score: int
    family_fit_score: int
    stressfree_score: int
    confidence: float
    reasoning: dict


@router.post("/event", response_model=ClassificationResult)
async def classify_event(event: EventInput):
    """
    Classify an event for family suitability.
    
    Always runs AI to get summary and extraction; rule filter only overrides
    is_relevant / rule_matched when it has a clear decision.
    """
    # Always run AI for summary, extraction, categories, etc.
    try:
        ai_result = await classifier.classify(event.dict())
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Classification failed: {str(e)}")

    rule_result = rule_filter.check(event.dict())
    # Override only is_relevant and rule_matched when rule made a decision
    is_relevant = rule_result.is_relevant if rule_result.is_relevant is not None else True
    rule_matched = rule_result.reason if rule_result.is_relevant is not None else None
    categories = (rule_result.suggested_categories or ai_result.categories) if rule_result.is_relevant is not None else ai_result.categories
    confidence = (0.9 if rule_result.is_relevant else 0.95) if rule_result.is_relevant is not None else ai_result.confidence

    return ClassificationResult(
        is_relevant=is_relevant,
        rule_matched=rule_matched,
        categories=categories,
        age_min=ai_result.age_min,
        age_max=ai_result.age_max,
        is_indoor=ai_result.is_indoor,
        is_outdoor=ai_result.is_outdoor,
        confidence=confidence,
        used_ai=True,
        description_short=ai_result.description_short,
        family_reason=ai_result.family_reason,
        age_rating=ai_result.age_rating,
        age_fit_buckets=ai_result.age_fit_buckets,
        ai_summary_short=ai_result.ai_summary_short,
        ai_summary_highlights=ai_result.ai_summary_highlights,
        ai_fit_blurb=ai_result.ai_fit_blurb,
        summary_confidence=ai_result.summary_confidence,
        extracted_start_datetime=ai_result.extracted_start_datetime,
        extracted_end_datetime=ai_result.extracted_end_datetime,
        extracted_location_address=ai_result.extracted_location_address,
        extracted_location_district=ai_result.extracted_location_district,
        datetime_confidence=ai_result.datetime_confidence,
        location_confidence=ai_result.location_confidence,
        flags=ai_result.flags,
    )


@router.post("/score", response_model=ScoringResult)
async def score_event(event: EventInput):
    """
    Score an event for various quality metrics.
    """
    try:
        result = await scorer.score(event.dict())
        return ScoringResult(
            relevance_score=result.relevance_score,
            quality_score=result.quality_score,
            family_fit_score=result.family_fit_score,
            stressfree_score=result.stressfree_score,
            confidence=result.confidence,
            reasoning=result.reasoning
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Scoring failed: {str(e)}")


@router.post("/batch")
async def classify_batch(events: list[EventInput]):
    """
    Classify multiple events in batch.
    
    More efficient for processing many events at once.
    """
    results = []
    
    for event in events:
        try:
            result = await classify_event(event)
            results.append({"success": True, "data": result})
        except Exception as e:
            results.append({"success": False, "error": str(e)})
    
    return {
        "total": len(events),
        "successful": sum(1 for r in results if r["success"]),
        "results": results
    }
