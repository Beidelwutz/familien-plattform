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


@router.post("/optimize-route")
async def optimize_route(slots: list[dict], start_location: dict):
    """
    Optimize the route between plan slots.
    
    Returns optimized order and travel times.
    """
    # TODO: Implement route optimization
    return {
        "optimized_order": [i for i in range(len(slots))],
        "total_travel_time_minutes": 45,
        "note": "Route optimization not yet implemented"
    }
