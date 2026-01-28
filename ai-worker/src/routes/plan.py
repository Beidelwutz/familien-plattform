"""Plan generation endpoints."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
from datetime import date

from src.planner.plan_generator import PlanGenerator

router = APIRouter()

plan_generator = PlanGenerator()


class PlanRequest(BaseModel):
    """Request for plan generation."""
    children_ages: list[int]
    date: date
    budget: Optional[float] = 50.0
    lat: Optional[float] = 49.0069  # Karlsruhe
    lng: Optional[float] = 8.4037
    preferences: Optional[dict] = None


class TimeSlot(BaseModel):
    """A time slot in the plan."""
    event_id: Optional[str]
    event_title: Optional[str]
    slot_type: str  # activity, break, travel
    start_time: str
    end_time: str
    duration_minutes: int
    notes: Optional[str]


class PlanResponse(BaseModel):
    """Generated plan response."""
    date: str
    children_ages: list[int]
    budget: float
    estimated_cost: float
    main_plan: list[TimeSlot]
    plan_b: list[TimeSlot]
    tips: list[str]
    generated_at: str


@router.post("/generate", response_model=PlanResponse)
async def generate_plan(request: PlanRequest):
    """
    Generate a family day plan using AI.
    
    Takes into account:
    - Children's ages for suitable activities
    - Budget constraints
    - Location for route optimization
    - Preferences (indoor/outdoor, categories)
    
    Returns a main plan and a Plan B for bad weather.
    """
    try:
        result = await plan_generator.generate(
            children_ages=request.children_ages,
            target_date=request.date,
            budget=request.budget or 50.0,
            lat=request.lat or 49.0069,
            lng=request.lng or 8.4037,
            preferences=request.preferences or {}
        )
        
        return PlanResponse(
            date=str(request.date),
            children_ages=request.children_ages,
            budget=request.budget or 50.0,
            estimated_cost=result.estimated_cost,
            main_plan=[TimeSlot(**slot) for slot in result.main_slots],
            plan_b=[TimeSlot(**slot) for slot in result.plan_b_slots],
            tips=result.tips,
            generated_at=result.generated_at
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Plan generation failed: {str(e)}")


class OptimizeRequest(BaseModel):
    """Request for plan optimization."""
    events: list[dict]
    children_ages: list[int]
    date: str
    budget: float = 50.0
    preferences: Optional[dict] = None
    user_location: Optional[dict] = None


@router.post("/optimize")
async def optimize_plan(request: OptimizeRequest):
    """
    Select and optimize events for a family day plan.
    
    Uses scoring and heuristics to select the best combination of events.
    Returns selected event IDs for main plan and Plan B.
    """
    events = request.events
    children_ages = request.children_ages
    budget = request.budget
    preferences = request.preferences or {}
    
    if not events:
        return {
            "selected_events": [],
            "plan_b_events": [],
            "reasoning": "No events available"
        }
    
    # Score events based on multiple factors
    scored_events = []
    for event in events:
        score = 0.0
        
        # Base score from AI scoring (if available)
        if event.get('scores'):
            score += (event['scores'].get('family_fit_score', 50) or 50) * 0.3
            score += (event['scores'].get('stressfree_score', 50) or 50) * 0.2
            score += (event['scores'].get('quality_score', 50) or 50) * 0.1
        else:
            score += 50  # Default score
        
        # Distance penalty
        distance = event.get('distance_km', 10)
        score -= distance * 2  # -2 points per km
        
        # Price bonus for free events
        if event.get('price_type') == 'free':
            score += 15
        elif event.get('price_min') and float(event['price_min']) <= budget / 4:
            score += 10
        
        # Age suitability bonus
        age_range = (event.get('age_min', 0), event.get('age_max', 18))
        ages_suitable = sum(1 for age in children_ages if age_range[0] <= age <= age_range[1])
        score += ages_suitable * 5
        
        # Category diversity tracking
        categories = event.get('categories', [])
        
        scored_events.append({
            **event,
            'computed_score': score,
            'categories': categories
        })
    
    # Sort by score
    scored_events.sort(key=lambda e: e['computed_score'], reverse=True)
    
    # Select events with diversity in mind
    selected = []
    used_categories = set()
    total_cost = 0
    
    for event in scored_events:
        if len(selected) >= 3:
            break
        
        # Check budget
        event_cost = 0
        if event.get('price_type') != 'free' and event.get('price_min'):
            event_cost = float(event['price_min']) * (len(children_ages) + 2)
        
        if total_cost + event_cost > budget:
            continue
        
        # Prefer category diversity for first 2 events
        event_cats = set(event.get('categories', []))
        if len(selected) < 2:
            has_new_cat = not event_cats or not event_cats.issubset(used_categories)
            if not has_new_cat and len(scored_events) > len(selected) + 3:
                continue  # Skip if no new category and more options available
        
        selected.append(event['id'])
        used_categories.update(event_cats)
        total_cost += event_cost
    
    # Select Plan B events (indoor alternatives)
    plan_b = []
    for event in scored_events:
        if event['id'] in selected:
            continue
        if not event.get('is_indoor'):
            continue
        if len(plan_b) >= 3:
            break
        plan_b.append(event['id'])
    
    return {
        "selected_events": selected,
        "plan_b_events": plan_b,
        "reasoning": f"Selected {len(selected)} events optimized for family fit, distance, and budget. Plan B has {len(plan_b)} indoor alternatives."
    }


@router.post("/optimize-route")
async def optimize_route(slots: list[dict], start_location: dict):
    """
    Optimize the route between plan slots.
    
    Returns optimized order and travel times.
    """
    if not slots:
        return {
            "optimized_order": [],
            "total_travel_time_minutes": 0
        }
    
    # Simple nearest-neighbor optimization
    # For a full implementation, use Google Maps Directions API
    optimized_order = list(range(len(slots)))
    
    # Estimate travel time based on distance (rough: 3 min per km)
    total_travel = 0
    for i, slot in enumerate(slots):
        if i > 0:
            # Assume average 5km between locations
            total_travel += 15  # 15 min average
    
    return {
        "optimized_order": optimized_order,
        "total_travel_time_minutes": total_travel,
        "note": "Basic optimization. For better results, integrate Google Maps Directions API."
    }
