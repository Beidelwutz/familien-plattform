"""Rule-based pre-filter for events.

This filter runs BEFORE AI to save costs:
- Clearly irrelevant events are rejected without AI (hard exclude)
- Soft excludes can be overridden by strong include signals
- Clearly relevant events can be fast-tracked
- Uncertain events go to AI classification

Scoring logic:
- include_score: number of include keyword hits
- exclude_score: number of exclude keyword hits
- Hard excludes: always reject (erotik, casino, strip, etc.)
- Soft excludes: only reject if include_score == 0
"""

from dataclasses import dataclass, field
from typing import Optional
import re


@dataclass
class RuleResult:
    """Result of rule-based filtering."""
    is_relevant: Optional[bool]  # None = needs AI
    reason: str
    confidence: float
    is_hard_exclude: bool = False
    include_score: int = 0
    exclude_score: int = 0
    suggested_categories: Optional[list[str]] = None


class RuleBasedFilter:
    """Rule-based filter for events with scoring logic."""
    
    # HARD EXCLUDE: Always reject, no override possible
    HARD_EXCLUDE = [
        "erotik", "strip", "nightclub", "bordell",
        "poker", "casino", "glücksspiel",
        "18+", "ab 18", "nur erwachsene", "adults only",
        "fkk",
    ]
    
    # SOFT EXCLUDE: Reject only if no include hits
    SOFT_EXCLUDE = [
        "singles", "single-party", "speed dating",
        "senioren", "seniorentreff", "rentner",
        "business", "b2b", "networking", "geschäftlich", "unternehmer",
        "bier", "wein", "cocktail", "spirituosen", "whisky", "craft beer",
        "stammtisch", "after work", "afterwork",
        "firmenfeier", "firmenevent", "corporate",
        "meditation für erwachsene", "yoga für erwachsene",
        "blutspende", "impfaktion",
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
        "vorlesestunde", "bilderbuchkino", "bastelnachmittag",
        "kinderflohmarkt", "kinderfest", "kinderfasching",
        "familiensonntag", "familientag",
        "krabbeln", "krabbelgruppe",
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
        "bibliothek": ["bibliothek", "bücherei", "vorlesen", "lesung"],
    }
    
    def check(self, event: dict) -> RuleResult:
        """
        Check an event against rules with scoring.
        
        Args:
            event: Event data dict with title, description, etc.
            
        Returns:
            RuleResult with decision (or None if AI needed)
        """
        title = event.get("title", "").lower()
        description = (event.get("description") or "").lower()
        text = f"{title} {description}"
        
        # Count hits
        hard_exclude_hits = [kw for kw in self.HARD_EXCLUDE if kw in text]
        soft_exclude_hits = [kw for kw in self.SOFT_EXCLUDE if kw in text]
        include_hits = [kw for kw in self.INCLUDE_KEYWORDS if kw in text]
        
        categories = self._detect_categories(text)
        
        # 1. Hard exclude: always reject
        if hard_exclude_hits:
            return RuleResult(
                is_relevant=False,
                reason=f"Hard exclude: {hard_exclude_hits[0]}",
                confidence=0.98,
                is_hard_exclude=True,
                include_score=len(include_hits),
                exclude_score=len(hard_exclude_hits) + len(soft_exclude_hits),
            )
        
        # 2. Soft exclude: only reject if no include signal
        if soft_exclude_hits and not include_hits:
            return RuleResult(
                is_relevant=False,
                reason=f"Soft exclude: {soft_exclude_hits[0]}",
                confidence=0.80,
                is_hard_exclude=False,
                include_score=0,
                exclude_score=len(soft_exclude_hits),
            )
        
        # 3. Soft exclude + include hits: include overrides soft exclude
        if soft_exclude_hits and include_hits:
            return RuleResult(
                is_relevant=None,  # Let AI decide
                reason=f"Conflicting signals: exclude={soft_exclude_hits[0]}, include={include_hits[0]}",
                confidence=0.5,
                is_hard_exclude=False,
                include_score=len(include_hits),
                exclude_score=len(soft_exclude_hits),
                suggested_categories=categories,
            )
        
        # 4. Strong include signal
        if include_hits:
            return RuleResult(
                is_relevant=True,
                reason=f"Include keyword: {include_hits[0]}",
                confidence=0.9,
                include_score=len(include_hits),
                exclude_score=0,
                suggested_categories=categories,
            )
        
        # 5. Category match
        if categories:
            return RuleResult(
                is_relevant=True,
                reason=f"Category match: {', '.join(categories)}",
                confidence=0.8,
                include_score=0,
                exclude_score=0,
                suggested_categories=categories,
            )
        
        # 6. Age range checks (extended patterns)
        age_result = self._check_age_patterns(text, categories)
        if age_result:
            return age_result
        
        # No clear decision - needs AI
        return RuleResult(
            is_relevant=None,
            reason="Needs AI classification",
            confidence=0.0,
            include_score=0,
            exclude_score=0,
            suggested_categories=categories or [],
        )
    
    def _check_age_patterns(self, text: str, categories: list[str]) -> Optional[RuleResult]:
        """Check various age patterns."""
        # Pattern: "X-Y Jahre/Jahren"
        age_pattern = r'(\d+)\s*[-–]\s*(\d+)\s*(?:jahren?|j\.?)'
        age_match = re.search(age_pattern, text)
        if age_match:
            min_age = int(age_match.group(1))
            max_age = int(age_match.group(2))
            if min_age <= 14:
                return RuleResult(
                    is_relevant=True,
                    reason=f"Age range {min_age}-{max_age} includes children",
                    confidence=0.85,
                    suggested_categories=categories or [],
                )
        
        # Pattern: "ab X Jahren/Jahre/J."
        ab_pattern = r'ab\s*(\d+)\s*(?:jahren?|j\.?)'
        ab_match = re.search(ab_pattern, text)
        if ab_match:
            min_age = int(ab_match.group(1))
            if min_age >= 16:
                return RuleResult(
                    is_relevant=False,
                    reason=f"Minimum age {min_age} suggests adult event",
                    confidence=0.8,
                )
            elif min_age <= 6:
                return RuleResult(
                    is_relevant=True,
                    reason=f"Minimum age {min_age} suggests children's event",
                    confidence=0.9,
                    suggested_categories=categories or [],
                )
        
        # Pattern: "6+" / "8+"
        plus_pattern = r'\b(\d{1,2})\s*\+'
        plus_match = re.search(plus_pattern, text)
        if plus_match:
            min_age = int(plus_match.group(1))
            if min_age <= 14:
                return RuleResult(
                    is_relevant=True,
                    reason=f"Age {min_age}+ includes children",
                    confidence=0.85,
                    suggested_categories=categories or [],
                )
        
        # Pattern: "ab 12 Monaten" / "ab 6 Mon."
        monate_pattern = r'ab\s*(\d{1,2})\s*(?:monate?n?|mon\.?)'
        monate_match = re.search(monate_pattern, text)
        if monate_match:
            return RuleResult(
                is_relevant=True,
                reason=f"Age in months ({monate_match.group(1)} Mon.) = clearly for small children",
                confidence=0.95,
                suggested_categories=categories or [],
            )
        
        return None
    
    def _detect_categories(self, text: str) -> list[str]:
        """Detect likely categories from text."""
        detected = []
        
        for category, keywords in self.FAMILY_CATEGORIES.items():
            for keyword in keywords:
                if keyword in text:
                    detected.append(category)
                    break
        
        return list(set(detected))
