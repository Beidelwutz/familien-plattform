"""AI-based event classifier using LLM."""

from dataclasses import dataclass
from typing import Optional
import json
import hashlib

from src.config import get_settings


@dataclass
class ClassificationResult:
    """Result from AI classification."""
    categories: list[str]
    age_min: Optional[int]
    age_max: Optional[int]
    is_indoor: bool
    is_outdoor: bool
    description_short: Optional[str]
    family_reason: Optional[str]
    confidence: float


CLASSIFICATION_PROMPT = """Du bist ein Event-Klassifikator für Familien-Events in Deutschland.

Analysiere das folgende Event und klassifiziere es:

EVENT:
Titel: {title}
Beschreibung: {description}
Ort: {location}
Preis: {price}

AUFGABEN:
1. Kategorien zuweisen (max 3 aus dieser Liste):
   - museum, sport, natur, musik, theater, workshop, indoor-spielplatz, ferienlager, kino, zoo, schwimmen, klettern

2. Altersrange schätzen (min/max, 0-18):
   - Basierend auf Beschreibung und Art der Aktivität
   - Wenn unklar, verwende typische Altersrange für die Kategorie

3. Indoor/Outdoor bestimmen:
   - Kann auch beides sein

4. Kurzbeschreibung erstellen (max 150 Zeichen):
   - Für Card-Ansicht optimiert
   - Wichtigste Info zuerst

5. "Warum gut für Familien?" (1 Satz):
   - Was macht es familientauglich?

Antworte NUR mit folgendem JSON-Format:
{{
  "categories": ["kategorie1", "kategorie2"],
  "age_min": 4,
  "age_max": 12,
  "is_indoor": true,
  "is_outdoor": false,
  "description_short": "Kurze Beschreibung hier",
  "family_reason": "Warum gut für Familien",
  "confidence": 0.85
}}
"""


class EventClassifier:
    """AI-based event classifier."""
    
    def __init__(self):
        self.settings = get_settings()
        self._cache: dict[str, ClassificationResult] = {}
    
    async def classify(self, event: dict) -> ClassificationResult:
        """
        Classify an event using AI.
        
        Args:
            event: Event data dict
            
        Returns:
            ClassificationResult with categories, age range, etc.
        """
        # Check cache first
        cache_key = self._compute_cache_key(event)
        if cache_key in self._cache:
            return self._cache[cache_key]
        
        # Prepare prompt
        prompt = CLASSIFICATION_PROMPT.format(
            title=event.get("title", ""),
            description=event.get("description", "Keine Beschreibung"),
            location=event.get("location_address", "Unbekannt"),
            price=self._format_price(event)
        )
        
        # Call AI (try OpenAI first, fallback to Anthropic)
        try:
            if self.settings.openai_api_key:
                result = await self._call_openai(prompt)
            elif self.settings.anthropic_api_key:
                result = await self._call_anthropic(prompt)
            else:
                # No API key - return default
                result = self._default_classification(event)
        except Exception as e:
            print(f"AI classification error: {e}")
            result = self._default_classification(event)
        
        # Cache result
        self._cache[cache_key] = result
        
        return result
    
    async def _call_openai(self, prompt: str) -> ClassificationResult:
        """Call OpenAI API for classification."""
        import openai
        
        client = openai.AsyncOpenAI(api_key=self.settings.openai_api_key)
        
        response = await client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": "Du bist ein Event-Klassifikator. Antworte nur mit JSON."},
                {"role": "user", "content": prompt}
            ],
            temperature=0.3,
            max_tokens=500
        )
        
        content = response.choices[0].message.content
        data = json.loads(content)
        
        return ClassificationResult(
            categories=data.get("categories", []),
            age_min=data.get("age_min"),
            age_max=data.get("age_max"),
            is_indoor=data.get("is_indoor", False),
            is_outdoor=data.get("is_outdoor", False),
            description_short=data.get("description_short"),
            family_reason=data.get("family_reason"),
            confidence=data.get("confidence", 0.7)
        )
    
    async def _call_anthropic(self, prompt: str) -> ClassificationResult:
        """Call Anthropic API for classification."""
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
        # Extract JSON from response
        start = content.find("{")
        end = content.rfind("}") + 1
        data = json.loads(content[start:end])
        
        return ClassificationResult(
            categories=data.get("categories", []),
            age_min=data.get("age_min"),
            age_max=data.get("age_max"),
            is_indoor=data.get("is_indoor", False),
            is_outdoor=data.get("is_outdoor", False),
            description_short=data.get("description_short"),
            family_reason=data.get("family_reason"),
            confidence=data.get("confidence", 0.7)
        )
    
    def _default_classification(self, event: dict) -> ClassificationResult:
        """Return default classification when AI is unavailable."""
        return ClassificationResult(
            categories=["workshop"],  # Safe default
            age_min=6,
            age_max=12,
            is_indoor=True,
            is_outdoor=False,
            description_short=event.get("title", "")[:150],
            family_reason="Aktivität für Kinder",
            confidence=0.3
        )
    
    def _compute_cache_key(self, event: dict) -> str:
        """Compute cache key for event."""
        key_data = f"{event.get('title', '')}{event.get('description', '')}"
        return hashlib.md5(key_data.encode()).hexdigest()
    
    def _format_price(self, event: dict) -> str:
        """Format price for prompt."""
        price_type = event.get("price_type", "unknown")
        if price_type == "free":
            return "Kostenlos"
        price_min = event.get("price_min")
        price_max = event.get("price_max")
        if price_min and price_max:
            return f"{price_min}€ - {price_max}€"
        elif price_min:
            return f"ab {price_min}€"
        return "Unbekannt"
