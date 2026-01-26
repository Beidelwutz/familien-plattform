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
    description_short: Optional[str]
    family_reason: Optional[str]
    confidence: float
    used_ai: bool


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
    
    Uses rule-based pre-filtering first, then AI if needed.
    """
    # Step 1: Rule-based pre-filter
    rule_result = rule_filter.check(event.dict())
    
    if rule_result.is_relevant is not None:
        # Rule made a decision
        return ClassificationResult(
            is_relevant=rule_result.is_relevant,
            rule_matched=rule_result.reason,
            categories=rule_result.suggested_categories or [],
            age_min=None,
            age_max=None,
            is_indoor=event.is_indoor or False,
            is_outdoor=event.is_outdoor or False,
            description_short=None,
            family_reason=None,
            confidence=0.9 if rule_result.is_relevant else 0.95,
            used_ai=False
        )
    
    # Step 2: AI classification needed
    try:
        ai_result = await classifier.classify(event.dict())
        return ClassificationResult(
            is_relevant=True,  # If AI classified it, assume relevant
            rule_matched=None,
            categories=ai_result.categories,
            age_min=ai_result.age_min,
            age_max=ai_result.age_max,
            is_indoor=ai_result.is_indoor,
            is_outdoor=ai_result.is_outdoor,
            description_short=ai_result.description_short,
            family_reason=ai_result.family_reason,
            confidence=ai_result.confidence,
            used_ai=True
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Classification failed: {str(e)}")


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
