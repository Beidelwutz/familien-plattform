"""AI-based event scorer for quality metrics."""

from dataclasses import dataclass
import json

from src.config import get_settings


@dataclass
class ScoringResult:
    """Result from AI scoring."""
    relevance_score: int  # 0-100
    quality_score: int  # 0-100
    family_fit_score: int  # 0-100
    stressfree_score: int  # 0-100
    confidence: float
    reasoning: dict


SCORING_PROMPT = """Bewerte dieses Event für Familien mit Kindern.

EVENT:
Titel: {title}
Beschreibung: {description}
Ort: {location}
Preis: {price}
Indoor/Outdoor: {indoor_outdoor}
Altersgruppe: {age_range}

BEWERTE FOLGENDE ASPEKTE (0-100):

1. relevance_score: Passt es zur Zielgruppe Familien mit Kindern?
   - 90-100: Explizit für Familien/Kinder konzipiert
   - 70-89: Gut für Familien geeignet
   - 50-69: Kann für Familien interessant sein
   - 0-49: Kaum relevant für Familien

2. quality_score: Wie vollständig und klar sind die Informationen?
   - Sind Zeit, Ort, Preis klar?
   - Gibt es eine gute Beschreibung?
   - Sind Buchungsmöglichkeiten angegeben?

3. family_fit_score: Wie gut für Kinder geeignet?
   - Altersgerechte Aktivität?
   - Sichere Umgebung?
   - Interessant für Kinder?

4. stressfree_score: Wie stressfrei ist der Besuch für Eltern?
   - Gute Erreichbarkeit?
   - Parkplätze/ÖPNV?
   - Wickelmöglichkeiten/Toiletten?
   - Essen vor Ort?
   - Kurze Wartezeiten?

Antworte NUR mit folgendem JSON:
{{
  "relevance_score": 85,
  "quality_score": 70,
  "family_fit_score": 90,
  "stressfree_score": 75,
  "confidence": 0.8,
  "reasoning": {{
    "relevance": "Kurze Begründung",
    "quality": "Kurze Begründung",
    "family_fit": "Kurze Begründung",
    "stressfree": "Kurze Begründung"
  }}
}}
"""


class EventScorer:
    """AI-based event scorer."""
    
    def __init__(self):
        self.settings = get_settings()
    
    async def score(self, event: dict) -> ScoringResult:
        """
        Score an event using AI.
        
        Args:
            event: Event data dict
            
        Returns:
            ScoringResult with all score metrics
        """
        # Prepare prompt
        prompt = SCORING_PROMPT.format(
            title=event.get("title", ""),
            description=event.get("description", "Keine Beschreibung"),
            location=event.get("location_address", "Unbekannt"),
            price=self._format_price(event),
            indoor_outdoor=self._format_indoor_outdoor(event),
            age_range=self._format_age_range(event)
        )
        
        try:
            if self.settings.openai_api_key:
                result = await self._call_openai(prompt)
            elif self.settings.anthropic_api_key:
                result = await self._call_anthropic(prompt)
            else:
                result = self._default_scoring(event)
        except Exception as e:
            print(f"AI scoring error: {e}")
            result = self._default_scoring(event)
        
        return result
    
    async def _call_openai(self, prompt: str) -> ScoringResult:
        """Call OpenAI for scoring."""
        import openai
        
        client = openai.AsyncOpenAI(api_key=self.settings.openai_api_key)
        
        response = await client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": "Du bewertest Events für Familien. Antworte nur mit JSON."},
                {"role": "user", "content": prompt}
            ],
            temperature=0.3,
            max_tokens=500
        )
        
        content = response.choices[0].message.content
        data = json.loads(content)
        
        return ScoringResult(
            relevance_score=data.get("relevance_score", 50),
            quality_score=data.get("quality_score", 50),
            family_fit_score=data.get("family_fit_score", 50),
            stressfree_score=data.get("stressfree_score", 50),
            confidence=data.get("confidence", 0.7),
            reasoning=data.get("reasoning", {})
        )
    
    async def _call_anthropic(self, prompt: str) -> ScoringResult:
        """Call Anthropic for scoring."""
        import anthropic
        
        client = anthropic.AsyncAnthropic(api_key=self.settings.anthropic_api_key)
        
        response = await client.messages.create(
            model="claude-3-haiku-20240307",
            max_tokens=500,
            messages=[
                {"role": "user", "content": prompt}
            ]
        )
        
        content = response.content[0].text
        start = content.find("{")
        end = content.rfind("}") + 1
        data = json.loads(content[start:end])
        
        return ScoringResult(
            relevance_score=data.get("relevance_score", 50),
            quality_score=data.get("quality_score", 50),
            family_fit_score=data.get("family_fit_score", 50),
            stressfree_score=data.get("stressfree_score", 50),
            confidence=data.get("confidence", 0.7),
            reasoning=data.get("reasoning", {})
        )
    
    def _default_scoring(self, event: dict) -> ScoringResult:
        """Return default scores when AI unavailable."""
        # Calculate basic scores based on completeness
        has_title = bool(event.get("title"))
        has_description = bool(event.get("description"))
        has_location = bool(event.get("location_address"))
        has_price = event.get("price_type") != "unknown"
        
        quality_score = 25 * sum([has_title, has_description, has_location, has_price])
        
        return ScoringResult(
            relevance_score=60,
            quality_score=quality_score,
            family_fit_score=60,
            stressfree_score=50,
            confidence=0.3,
            reasoning={
                "note": "Default scoring - AI unavailable"
            }
        )
    
    def _format_price(self, event: dict) -> str:
        price_type = event.get("price_type", "unknown")
        if price_type == "free":
            return "Kostenlos"
        price_min = event.get("price_min")
        if price_min:
            return f"ab {price_min}€"
        return "Unbekannt"
    
    def _format_indoor_outdoor(self, event: dict) -> str:
        indoor = event.get("is_indoor", False)
        outdoor = event.get("is_outdoor", False)
        if indoor and outdoor:
            return "Indoor & Outdoor"
        if indoor:
            return "Indoor"
        if outdoor:
            return "Outdoor"
        return "Unbekannt"
    
    def _format_age_range(self, event: dict) -> str:
        age_min = event.get("age_min")
        age_max = event.get("age_max")
        if age_min and age_max:
            return f"{age_min}-{age_max} Jahre"
        if age_min:
            return f"ab {age_min} Jahren"
        return "Nicht angegeben"
