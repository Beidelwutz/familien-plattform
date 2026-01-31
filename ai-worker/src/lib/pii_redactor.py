"""PII (Personally Identifiable Information) redaction utilities.

Removes sensitive data before sending to AI APIs and logging.
"""

import re
from typing import Optional


class PIIRedactor:
    """Redact PII from text before AI processing and logging."""
    
    # Patterns for German/European PII
    PATTERNS = {
        'email': r'\b[\w.-]+@[\w.-]+\.\w{2,}\b',
        'phone_de': r'\b(?:\+49|0049|0)\s?[\d\s/()-]{6,}\b',
        'phone_intl': r'\b\+\d{1,3}\s?[\d\s/()-]{6,}\b',
        'iban': r'\b[A-Z]{2}\d{2}\s?(?:[\dA-Z]{4}\s?){3,5}[\dA-Z]{0,4}\b',
        'credit_card': r'\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b',
        'postal_code_de': r'\b\d{5}\b',  # German postal codes (be careful, might match other numbers)
    }
    
    # Additional patterns that are more aggressive (optional)
    AGGRESSIVE_PATTERNS = {
        'street_de': r'\b[A-ZÄÖÜ][a-zäöüß]+(?:straße|str\.|weg|platz|gasse|allee)\s+\d+[a-z]?\b',
    }
    
    @classmethod
    def redact(cls, text: Optional[str], aggressive: bool = False) -> str:
        """
        Redact PII from text.
        
        Args:
            text: Text to redact
            aggressive: If True, also redact street addresses
            
        Returns:
            Redacted text with PII replaced by [TYPE_REDACTED]
        """
        if not text:
            return ""
        
        result = text
        
        # Apply standard patterns
        for name, pattern in cls.PATTERNS.items():
            # Skip postal codes by default (too many false positives)
            if name == 'postal_code_de':
                continue
            result = re.sub(pattern, f'[{name.upper()}_REDACTED]', result, flags=re.IGNORECASE)
        
        # Apply aggressive patterns if requested
        if aggressive:
            for name, pattern in cls.AGGRESSIVE_PATTERNS.items():
                result = re.sub(pattern, f'[{name.upper()}_REDACTED]', result, flags=re.IGNORECASE)
        
        return result
    
    @classmethod
    def redact_for_ai(cls, text: Optional[str]) -> str:
        """
        Redact PII specifically for AI API calls.
        
        Less aggressive - preserves location info needed for geocoding/context.
        """
        if not text:
            return ""
        
        result = text
        
        # Only redact truly sensitive data for AI
        sensitive_patterns = ['email', 'phone_de', 'phone_intl', 'iban', 'credit_card']
        for name in sensitive_patterns:
            pattern = cls.PATTERNS.get(name)
            if pattern:
                result = re.sub(pattern, f'[{name.upper()}_REDACTED]', result, flags=re.IGNORECASE)
        
        return result
    
    @classmethod
    def redact_for_logging(cls, text: Optional[str]) -> str:
        """
        Redact PII for logging purposes.
        
        More aggressive - remove all potentially sensitive data.
        """
        return cls.redact(text, aggressive=True)
    
    @classmethod
    def contains_pii(cls, text: Optional[str]) -> bool:
        """Check if text contains any PII patterns."""
        if not text:
            return False
        
        for pattern in cls.PATTERNS.values():
            if re.search(pattern, text, re.IGNORECASE):
                return True
        return False
