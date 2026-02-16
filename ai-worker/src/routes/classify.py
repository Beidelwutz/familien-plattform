"""Event classification and scoring endpoints."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
from datetime import datetime
import json
import os
import logging

logger = logging.getLogger(__name__)

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
    
    # Model info – "fallback" when AI was unavailable (quota, network, etc.)
    model: Optional[str] = None
    
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

    # Extracted price (so backend can update price_type / price_min)
    extracted_price_type: Optional[str] = None  # "free", "paid", "donation"
    extracted_price_min: Optional[float] = None
    price_confidence: Optional[float] = None

    # Extracted contact / organizer (so backend can set organizer_website, contact_email, contact_phone, organizer_directions)
    extracted_organizer_website: Optional[str] = None
    extracted_contact_email: Optional[str] = None
    extracted_contact_phone: Optional[str] = None
    contact_confidence: Optional[float] = None
    extracted_organizer_directions: Optional[str] = None


class ScoringResult(BaseModel):
    """Result of event scoring."""
    relevance_score: int
    quality_score: int
    family_fit_score: int
    stressfree_score: int
    fun_score: Optional[int] = None
    confidence: float
    reasoning: Optional[dict] = None
    # Model info – "fallback" when AI was unavailable
    model: Optional[str] = None


@router.post("/event", response_model=ClassificationResult)
async def classify_event(event: EventInput):
    """
    Classify an event for family suitability.
    
    Always runs AI to get summary and extraction; rule filter only overrides
    is_relevant / rule_matched when it has a clear decision.
    """
    # #region agent log
    try:
        import json as _json, os as _os, time as _time
        _log_path = r"c:\02_Kiezling\.cursor\debug.log"
        _os.makedirs(_os.path.dirname(_log_path), exist_ok=True)
        from src.config import get_settings as _gs
        _s = _gs()
        _payload = {"id": f"log_{int(_time.time()*1000)}", "timestamp": int(_time.time()*1000), "location": "classify.py:before_classify", "message": "AI config check", "hypothesisId": "H1", "data": {"enable_ai": _s.enable_ai, "has_openai_key": bool(_s.openai_api_key), "openai_key_prefix": (_s.openai_api_key or "")[:10], "has_anthropic_key": bool(_s.anthropic_api_key), "cwd": _os.getcwd(), "title": (event.title or "")[:50]}}
        with open(_log_path, "a", encoding="utf-8") as _f:
            _f.write(_json.dumps(_payload, ensure_ascii=False) + "\n")
    except Exception:
        pass
    # #endregion

    # Always run AI for summary, extraction, categories, etc.
    try:
        ai_result = await classifier.classify(event.dict())
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Classification failed: {str(e)}")

    # #region agent log
    try:
        _payload2 = {"id": f"log_{int(_time.time()*1000)}", "timestamp": int(_time.time()*1000), "location": "classify.py:after_classify", "message": "ai_result after classify", "hypothesisId": "H1", "data": {"title": (event.title or "")[:50], "model": ai_result.model, "confidence": ai_result.confidence, "ai_summary_short": (ai_result.ai_summary_short or "")[:80], "categories": ai_result.categories, "has_price_type": ai_result.extracted_price_type is not None, "extracted_price_type": ai_result.extracted_price_type, "price_confidence": ai_result.price_confidence, "parse_error": ai_result.parse_error, "retry_count": ai_result.retry_count}}
        with open(_log_path, "a", encoding="utf-8") as _f:
            _f.write(_json.dumps(_payload2, ensure_ascii=False) + "\n")
    except Exception:
        pass
    # #endregion

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
        model=ai_result.model,
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
        extracted_price_type=ai_result.extracted_price_type,
        extracted_price_min=ai_result.extracted_price_min,
        price_confidence=ai_result.price_confidence,
        extracted_organizer_website=ai_result.extracted_organizer_website,
        extracted_contact_email=ai_result.extracted_contact_email,
        extracted_contact_phone=ai_result.extracted_contact_phone,
        contact_confidence=ai_result.contact_confidence,
        extracted_organizer_directions=ai_result.extracted_organizer_directions,
    )


@router.post("/score", response_model=ScoringResult)
async def score_event(event: EventInput):
    """
    Score an event for various quality metrics.
    """
    try:
        result = await scorer.score(event.dict())
        # #region agent log
        try:
            import json as _json, os as _os, time as _time
            _log_path = r"c:\02_Kiezling\.cursor\debug.log"
            _os.makedirs(_os.path.dirname(_log_path), exist_ok=True)
            _payload = {"id": f"log_{int(_time.time()*1000)}", "timestamp": int(_time.time()*1000), "location": "classify.py:score_event", "message": "scorer result", "hypothesisId": "H4", "data": {"title": (event.title or "")[:50], "family_fit": result.family_fit_score, "relevance": result.relevance_score, "quality": result.quality_score, "stressfree": result.stressfree_score, "fun": result.fun_score, "model": result.model, "reasoning_note": (result.reasoning or {}).get("note", "")[:80] if isinstance(result.reasoning, dict) else ""}}
            with open(_log_path, "a", encoding="utf-8") as _f:
                _f.write(_json.dumps(_payload, ensure_ascii=False) + "\n")
        except Exception:
            pass
        # #endregion
        return ScoringResult(
            relevance_score=result.relevance_score,
            quality_score=result.quality_score,
            family_fit_score=result.family_fit_score,
            stressfree_score=result.stressfree_score,
            fun_score=result.fun_score,
            confidence=result.confidence,
            reasoning=result.reasoning or {},
            model=result.model,
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


@router.post("/test-gold-standard")
async def test_gold_standard():
    """
    Test AI classifier against manually annotated gold-standard events.
    
    Gold events are loaded from tests/gold_standard_v1.json.
    Results include per-event accuracy + model/prompt version for regression tracking.
    """
    # Load gold standard file
    gold_path = os.path.join(os.path.dirname(__file__), '..', '..', 'tests', 'gold_standard_v1.json')
    
    if not os.path.exists(gold_path):
        raise HTTPException(status_code=404, detail=f"Gold standard file not found at {gold_path}")
    
    try:
        with open(gold_path, 'r', encoding='utf-8') as f:
            gold = json.load(f)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load gold standard: {e}")
    
    results = []
    correct = 0
    total = 0
    
    for event in gold.get("events", []):
        total += 1
        expected = event.get("expected", {})
        
        try:
            ai_result = await classifier.classify(event)
            
            # Check family_friendly match
            match = True
            if "is_family_friendly" in expected:
                match = ai_result.is_family_friendly == expected["is_family_friendly"]
            
            if match:
                correct += 1
            
            results.append({
                "title": event.get("title", "?"),
                "correct": match,
                "confidence": ai_result.confidence,
                "model": ai_result.model,
                "prompt_version": ai_result.prompt_version,
                "expected": expected,
                "actual": {
                    "is_family_friendly": ai_result.is_family_friendly,
                    "categories": ai_result.categories,
                    "age_min": ai_result.age_min,
                    "age_max": ai_result.age_max,
                },
            })
        except Exception as e:
            results.append({
                "title": event.get("title", "?"),
                "correct": False,
                "error": str(e),
            })
    
    accuracy = correct / total if total > 0 else 0.0
    
    return {
        "accuracy": round(accuracy, 3),
        "correct": correct,
        "total": total,
        "gold_version": gold.get("version", "unknown"),
        "timestamp": datetime.utcnow().isoformat() + "Z",
        "results": results,
    }
