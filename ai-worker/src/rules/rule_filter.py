"""Rule-based pre-filter for events.

This filter runs BEFORE AI to save costs:
- Clearly irrelevant events are rejected without AI
- Clearly relevant events can be fast-tracked
- Uncertain events go to AI classification
"""

from dataclasses import dataclass
from typing import Optional
import re


@dataclass
class RuleResult:
    """Result of rule-based filtering."""
    is_relevant: Optional[bool]  # None = needs AI
    reason: str
    confidence: float
    suggested_categories: Optional[list[str]] = None


class RuleBasedFilter:
    """Rule-based filter for events."""
    
    # Keywords that strongly indicate NOT family-friendly
    EXCLUDE_KEYWORDS = [
        "18+", "ab 18", "nur erwachsene", "adults only",
        "singles", "single-party", "speed dating",
        "senioren", "seniorentreff", "rentner",
        "business", "b2b", "networking", "geschäftlich",
        "erotik", "strip", "nightclub",
        "poker", "casino", "glücksspiel",
        "bier", "wein", "cocktail", "spirituosen",  # Alcohol events
        "stammtisch", "after work",
    ]
    
    # Keywords that strongly indicate family-friendly
    INCLUDE_KEYWORDS = [
        "kinder", "kids", "kind",
        "familie", "familien", "family",
        "jugend", "jugendliche", "teen",
        "baby", "kleinkind", "säugling",
        "eltern", "mutter", "vater", "mama", "papa",
        "schüler", "schulkind",
        "kindergarten", "kita",
        "kindertheater", "kinderkino", "kindermuseum",
        "kinderworkshop", "kinderkurs",
        "ferienprogramm", "ferienbetreuung",
        "spielplatz", "spielen",
    ]
    
    # Categories that are typically family-friendly
    FAMILY_CATEGORIES = {
        "museum": ["museum", "ausstellung", "galerie"],
        "zoo": ["zoo", "tierpark", "tiergarten", "aquarium", "wildpark"],
        "spielplatz": ["spielplatz", "spielen", "hüpfburg", "klettern"],
        "theater": ["kindertheater", "puppentheater", "marionettentheater"],
        "natur": ["wald", "natur", "wandern", "bauernhof", "garten"],
        "sport": ["schwimmen", "fußball", "turnen", "tanzen", "sport"],
        "kreativ": ["basteln", "malen", "kreativ", "werkstatt", "töpfern"],
        "musik": ["musikschule", "kinderchor", "musikalische früherziehung"],
    }
    
    def check(self, event: dict) -> RuleResult:
        """
        Check an event against rules.
        
        Args:
            event: Event data dict with title, description, etc.
            
        Returns:
            RuleResult with decision (or None if AI needed)
        """
        title = event.get("title", "").lower()
        description = (event.get("description") or "").lower()
        text = f"{title} {description}"
        
        # Check exclude keywords first (high confidence rejection)
        for keyword in self.EXCLUDE_KEYWORDS:
            if keyword in text:
                return RuleResult(
                    is_relevant=False,
                    reason=f"Excluded keyword: {keyword}",
                    confidence=0.95
                )
        
        # Check include keywords (high confidence acceptance)
        for keyword in self.INCLUDE_KEYWORDS:
            if keyword in text:
                categories = self._detect_categories(text)
                return RuleResult(
                    is_relevant=True,
                    reason=f"Included keyword: {keyword}",
                    confidence=0.9,
                    suggested_categories=categories
                )
        
        # Check for category matches
        categories = self._detect_categories(text)
        if categories:
            return RuleResult(
                is_relevant=True,
                reason=f"Category match: {', '.join(categories)}",
                confidence=0.8,
                suggested_categories=categories
            )
        
        # Age range check
        age_pattern = r'(\d+)[-–](\d+)\s*(jahre|j\.|jahr)'
        age_match = re.search(age_pattern, text)
        if age_match:
            min_age = int(age_match.group(1))
            max_age = int(age_match.group(2))
            if min_age <= 14:  # Includes children
                return RuleResult(
                    is_relevant=True,
                    reason=f"Age range {min_age}-{max_age} includes children",
                    confidence=0.85,
                    suggested_categories=categories or []
                )
        
        # Check for "ab X Jahren" pattern
        ab_pattern = r'ab\s*(\d+)\s*(jahre|j\.|jahr)'
        ab_match = re.search(ab_pattern, text)
        if ab_match:
            min_age = int(ab_match.group(1))
            if min_age >= 16:  # Likely adult event
                return RuleResult(
                    is_relevant=False,
                    reason=f"Minimum age {min_age} suggests adult event",
                    confidence=0.8
                )
            elif min_age <= 6:  # Clearly for children
                return RuleResult(
                    is_relevant=True,
                    reason=f"Minimum age {min_age} suggests children's event",
                    confidence=0.9,
                    suggested_categories=categories or []
                )
        
        # No clear decision - needs AI
        return RuleResult(
            is_relevant=None,
            reason="Needs AI classification",
            confidence=0.0,
            suggested_categories=categories or []
        )
    
    def _detect_categories(self, text: str) -> list[str]:
        """Detect likely categories from text."""
        detected = []
        
        for category, keywords in self.FAMILY_CATEGORIES.items():
            for keyword in keywords:
                if keyword in text:
                    detected.append(category)
                    break
        
        return list(set(detected))
