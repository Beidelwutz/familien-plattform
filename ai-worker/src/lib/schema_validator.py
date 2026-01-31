"""JSON Schema validation for AI responses.

Validates AI outputs to ensure consistent, parseable results.
"""

from typing import Tuple, Any
import json

try:
    from jsonschema import validate, ValidationError, Draft7Validator
    HAS_JSONSCHEMA = True
except ImportError:
    HAS_JSONSCHEMA = False
    ValidationError = Exception


# Schema for event classification results (v3.0)
CLASSIFICATION_SCHEMA = {
    "type": "object",
    "required": ["categories"],
    "properties": {
        "categories": {
            "type": "array",
            "items": {"type": "string"},
            "minItems": 0,
            "maxItems": 5
        },
        "is_family_friendly": {"type": "boolean"},
        "age_min": {"type": ["integer", "null"], "minimum": 0, "maximum": 99},
        "age_max": {"type": ["integer", "null"], "minimum": 0, "maximum": 99},
        "is_indoor": {"type": ["boolean", "null"]},
        "is_outdoor": {"type": ["boolean", "null"]},
        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
        # New v3.0 fields
        "age_rating": {"type": "string", "enum": ["0+", "3+", "6+", "10+", "13+", "16+", "18+"]},
        "age_fit_buckets": {
            "type": "object",
            "properties": {
                "0_2": {"type": "integer", "minimum": 0, "maximum": 100},
                "3_5": {"type": "integer", "minimum": 0, "maximum": 100},
                "6_9": {"type": "integer", "minimum": 0, "maximum": 100},
                "10_12": {"type": "integer", "minimum": 0, "maximum": 100},
                "13_15": {"type": "integer", "minimum": 0, "maximum": 100}
            }
        },
        "ai_summary_short": {"type": ["string", "null"], "maxLength": 300},
        "ai_summary_highlights": {
            "type": "array",
            "items": {"type": "string"},
            "maxItems": 5
        },
        "ai_fit_blurb": {"type": ["string", "null"], "maxLength": 150},
        "summary_confidence": {"type": "number", "minimum": 0, "maximum": 1},
        "flags": {
            "type": "object",
            "properties": {
                "sensitive_content": {"type": "boolean"},
                "needs_escalation": {"type": "boolean"}
            }
        }
    },
    "additionalProperties": True
}


# Schema for event scoring results (v2.1)
SCORING_SCHEMA = {
    "type": "object",
    "required": ["relevance_score", "quality_score", "family_fit_score"],
    "properties": {
        "relevance_score": {"type": "integer", "minimum": 0, "maximum": 100},
        "quality_score": {"type": "integer", "minimum": 0, "maximum": 100},
        "family_fit_score": {"type": "integer", "minimum": 0, "maximum": 100},
        "stressfree_score": {"type": ["integer", "null"], "minimum": 0, "maximum": 100},
        "fun_score": {"type": ["integer", "null"], "minimum": 0, "maximum": 100},
        "reasoning": {"type": ["object", "string", "null"]}
    },
    "additionalProperties": True
}


# Schema for plan generation results
PLAN_SCHEMA = {
    "type": "object",
    "required": ["main_plan"],
    "properties": {
        "main_plan": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["event_title", "slot_type", "start_time"],
                "properties": {
                    "event_id": {"type": ["string", "null"]},
                    "event_title": {"type": "string"},
                    "slot_type": {"type": "string", "enum": ["activity", "break", "travel"]},
                    "start_time": {"type": "string"},
                    "end_time": {"type": "string"},
                    "duration_minutes": {"type": "integer", "minimum": 0},
                    "notes": {"type": ["string", "null"]}
                }
            }
        },
        "plan_b": {
            "type": "array",
            "items": {"type": "object"}
        },
        "estimated_cost": {"type": "number", "minimum": 0},
        "tips": {
            "type": "array",
            "items": {"type": "string"}
        }
    },
    "additionalProperties": True
}


def validate_classification(data: Any) -> Tuple[bool, str]:
    """
    Validate classification result against schema.
    
    Args:
        data: Parsed JSON data to validate
        
    Returns:
        Tuple of (is_valid, error_message)
    """
    if not HAS_JSONSCHEMA:
        # Fallback validation without jsonschema
        return _validate_classification_fallback(data)
    
    try:
        validate(instance=data, schema=CLASSIFICATION_SCHEMA)
        return True, ""
    except ValidationError as e:
        return False, str(e.message)


def validate_scoring(data: Any) -> Tuple[bool, str]:
    """
    Validate scoring result against schema.
    
    Args:
        data: Parsed JSON data to validate
        
    Returns:
        Tuple of (is_valid, error_message)
    """
    if not HAS_JSONSCHEMA:
        return _validate_scoring_fallback(data)
    
    try:
        validate(instance=data, schema=SCORING_SCHEMA)
        return True, ""
    except ValidationError as e:
        return False, str(e.message)


def validate_plan(data: Any) -> Tuple[bool, str]:
    """
    Validate plan result against schema.
    
    Args:
        data: Parsed JSON data to validate
        
    Returns:
        Tuple of (is_valid, error_message)
    """
    if not HAS_JSONSCHEMA:
        return _validate_plan_fallback(data)
    
    try:
        validate(instance=data, schema=PLAN_SCHEMA)
        return True, ""
    except ValidationError as e:
        return False, str(e.message)


def _validate_classification_fallback(data: Any) -> Tuple[bool, str]:
    """Fallback validation without jsonschema library."""
    if not isinstance(data, dict):
        return False, "Response must be a JSON object"
    
    if "categories" not in data:
        return False, "Missing required field: categories"
    
    if not isinstance(data.get("categories"), list):
        return False, "categories must be an array"
    
    if "is_family_friendly" not in data:
        return False, "Missing required field: is_family_friendly"
    
    return True, ""


def _validate_scoring_fallback(data: Any) -> Tuple[bool, str]:
    """Fallback validation without jsonschema library."""
    if not isinstance(data, dict):
        return False, "Response must be a JSON object"
    
    required = ["relevance_score", "quality_score", "family_fit_score"]
    for field in required:
        if field not in data:
            return False, f"Missing required field: {field}"
        if not isinstance(data[field], (int, float)):
            return False, f"{field} must be a number"
        if not (0 <= data[field] <= 100):
            return False, f"{field} must be between 0 and 100"
    
    return True, ""


def _validate_plan_fallback(data: Any) -> Tuple[bool, str]:
    """Fallback validation without jsonschema library."""
    if not isinstance(data, dict):
        return False, "Response must be a JSON object"
    
    if "main_plan" not in data:
        return False, "Missing required field: main_plan"
    
    if not isinstance(data.get("main_plan"), list):
        return False, "main_plan must be an array"
    
    return True, ""


def try_parse_json(text: str) -> Tuple[bool, Any, str]:
    """
    Try to parse JSON from text, handling common AI response issues.
    
    Args:
        text: Raw text that should contain JSON
        
    Returns:
        Tuple of (success, parsed_data, error_message)
    """
    if not text:
        return False, None, "Empty response"
    
    # Try direct parse first
    try:
        data = json.loads(text)
        return True, data, ""
    except json.JSONDecodeError:
        pass
    
    # Try to extract JSON from markdown code blocks
    import re
    json_match = re.search(r'```(?:json)?\s*\n?(.*?)\n?```', text, re.DOTALL)
    if json_match:
        try:
            data = json.loads(json_match.group(1))
            return True, data, ""
        except json.JSONDecodeError:
            pass
    
    # Try to find JSON object/array in text
    for start_char, end_char in [('{', '}'), ('[', ']')]:
        start_idx = text.find(start_char)
        if start_idx >= 0:
            # Find matching closing bracket
            depth = 0
            for i, c in enumerate(text[start_idx:]):
                if c == start_char:
                    depth += 1
                elif c == end_char:
                    depth -= 1
                    if depth == 0:
                        try:
                            data = json.loads(text[start_idx:start_idx + i + 1])
                            return True, data, ""
                        except json.JSONDecodeError:
                            break
    
    return False, None, f"Could not parse JSON from response: {text[:200]}..."
