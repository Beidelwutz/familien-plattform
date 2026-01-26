"""AI-powered family day plan generator."""

from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Optional
import json

from src.config import get_settings


@dataclass
class GeneratedPlan:
    """Generated plan result."""
    main_slots: list[dict]
    plan_b_slots: list[dict]
    estimated_cost: float
    tips: list[str]
    generated_at: str


PLAN_PROMPT = """Erstelle einen Tagesplan für eine Familie.

FAMILIE:
- Kinder Alter: {children_ages}
- Budget: {budget}€
- Datum: {date}
- Startort: Karlsruhe ({lat}, {lng})
- Präferenzen: {preferences}

VERFÜGBARE AKTIVITÄTEN:
{available_events}

ERSTELLE EINEN TAGESPLAN mit folgenden Regeln:
1. 2-4 Aktivitäten, passend zum Alter der Kinder
2. Genug Pausen einplanen (mind. 30min zwischen Aktivitäten)
3. Mittagspause um ca. 12-13 Uhr
4. Route optimieren (minimale Fahrzeit)
5. Budget nicht überschreiten
6. Abwechslung (nicht 2x gleiche Kategorie)

Erstelle auch einen Plan B mit Indoor-Alternativen für schlechtes Wetter.

Antworte NUR mit JSON:
{{
  "main_plan": [
    {{
      "event_id": "id-oder-null",
      "event_title": "Titel",
      "slot_type": "activity",
      "start_time": "10:00",
      "end_time": "11:30",
      "duration_minutes": 90,
      "notes": "Tipp oder Hinweis"
    }},
    {{
      "event_id": null,
      "event_title": "Mittagspause",
      "slot_type": "break",
      "start_time": "12:00",
      "end_time": "13:00",
      "duration_minutes": 60,
      "notes": "Empfehlung: Café XY in der Nähe"
    }}
  ],
  "plan_b": [
    // Indoor-Alternativen
  ],
  "estimated_cost": 35.00,
  "tips": [
    "Sonnencreme nicht vergessen",
    "Parkplatz am Schloss ist meist voll - besser ÖPNV"
  ]
}}
"""


class PlanGenerator:
    """AI-powered plan generator."""
    
    def __init__(self):
        self.settings = get_settings()
    
    async def generate(
        self,
        children_ages: list[int],
        target_date: date,
        budget: float,
        lat: float,
        lng: float,
        preferences: dict
    ) -> GeneratedPlan:
        """
        Generate a family day plan.
        
        Args:
            children_ages: Ages of children
            target_date: Target date for the plan
            budget: Maximum budget in EUR
            lat, lng: Starting location coordinates
            preferences: User preferences (indoor/outdoor, categories)
            
        Returns:
            GeneratedPlan with slots and tips
        """
        # For MVP, generate a simple plan without AI
        # TODO: Integrate with database to get actual events
        # TODO: Call AI for intelligent planning
        
        plan = self._generate_simple_plan(
            children_ages=children_ages,
            target_date=target_date,
            budget=budget,
            preferences=preferences
        )
        
        return plan
    
    def _generate_simple_plan(
        self,
        children_ages: list[int],
        target_date: date,
        budget: float,
        preferences: dict
    ) -> GeneratedPlan:
        """Generate a simple plan without AI (MVP fallback)."""
        
        # Determine best activity types based on age
        min_age = min(children_ages)
        max_age = max(children_ages)
        
        # Create time slots
        main_slots = []
        
        # Morning activity (10:00 - 11:30)
        main_slots.append({
            "event_id": None,
            "event_title": "Morgendliche Aktivität",
            "slot_type": "activity",
            "start_time": f"{target_date}T10:00:00",
            "end_time": f"{target_date}T11:30:00",
            "duration_minutes": 90,
            "notes": self._get_morning_suggestion(min_age, max_age, preferences)
        })
        
        # Lunch break (12:00 - 13:00)
        main_slots.append({
            "event_id": None,
            "event_title": "Mittagspause",
            "slot_type": "break",
            "start_time": f"{target_date}T12:00:00",
            "end_time": f"{target_date}T13:00:00",
            "duration_minutes": 60,
            "notes": "Zeit für ein Mittagessen - viele kinderfreundliche Restaurants in der Innenstadt"
        })
        
        # Afternoon activity (14:00 - 16:00)
        main_slots.append({
            "event_id": None,
            "event_title": "Nachmittags-Aktivität",
            "slot_type": "activity",
            "start_time": f"{target_date}T14:00:00",
            "end_time": f"{target_date}T16:00:00",
            "duration_minutes": 120,
            "notes": self._get_afternoon_suggestion(min_age, max_age, preferences)
        })
        
        # Plan B (indoor alternatives)
        plan_b_slots = [
            {
                "event_id": None,
                "event_title": "Indoor-Alternative Vormittag",
                "slot_type": "activity",
                "start_time": f"{target_date}T10:00:00",
                "end_time": f"{target_date}T12:00:00",
                "duration_minutes": 120,
                "notes": "ZKM Karlsruhe - Interaktive Medienkunst für alle Altersgruppen"
            },
            {
                "event_id": None,
                "event_title": "Mittagspause",
                "slot_type": "break",
                "start_time": f"{target_date}T12:00:00",
                "end_time": f"{target_date}T13:00:00",
                "duration_minutes": 60,
                "notes": "Café im ZKM oder Innenstadt"
            },
            {
                "event_id": None,
                "event_title": "Indoor-Alternative Nachmittag",
                "slot_type": "activity",
                "start_time": f"{target_date}T14:00:00",
                "end_time": f"{target_date}T16:00:00",
                "duration_minutes": 120,
                "notes": "Indoor-Spielplatz oder Naturkundemuseum"
            }
        ]
        
        # Generate tips
        tips = self._generate_tips(children_ages, preferences)
        
        # Estimate cost
        estimated_cost = min(budget, 30.0)  # Simple estimate
        
        return GeneratedPlan(
            main_slots=main_slots,
            plan_b_slots=plan_b_slots,
            estimated_cost=estimated_cost,
            tips=tips,
            generated_at=datetime.utcnow().isoformat()
        )
    
    def _get_morning_suggestion(self, min_age: int, max_age: int, preferences: dict) -> str:
        """Get morning activity suggestion."""
        if min_age < 4:
            return "Zoo Karlsruhe - Perfekt für kleine Kinder, Streichelzoo vorhanden"
        elif max_age <= 8:
            return "Spielplatz Günther-Klotz-Anlage - Großer Spielplatz mit viel Platz zum Toben"
        else:
            return "Turmbergbahn & Turmberg - Fahrt mit der Standseilbahn und tolle Aussicht"
    
    def _get_afternoon_suggestion(self, min_age: int, max_age: int, preferences: dict) -> str:
        """Get afternoon activity suggestion."""
        if min_age < 4:
            return "Schlossgarten - Entspannter Spaziergang mit Enten füttern"
        elif max_age <= 8:
            return "Naturkundemuseum - Dinosaurier und Vivarium (lebende Tiere!)"
        else:
            return "Europabad - Schwimmbad mit Rutschen und Wellenbad"
    
    def _generate_tips(self, children_ages: list[int], preferences: dict) -> list[str]:
        """Generate helpful tips."""
        tips = []
        
        min_age = min(children_ages)
        
        if min_age < 3:
            tips.append("Wickeltasche und Snacks nicht vergessen")
            tips.append("Pausen großzügig einplanen - Kleinkinder brauchen Zeit")
        
        if min_age < 6:
            tips.append("Buggy kann bei längeren Strecken hilfreich sein")
        
        tips.append("KVV-Tageskarte für Familien: Günstig für bis zu 5 Personen")
        tips.append("Viele Attraktionen bieten Familienrabatte - nachfragen lohnt sich!")
        
        outdoor = preferences.get("outdoor", True)
        if outdoor:
            tips.append("Sonnencreme und Wasser einpacken")
            tips.append("Wetter-App checken - bei Regen Plan B aktivieren")
        
        return tips
