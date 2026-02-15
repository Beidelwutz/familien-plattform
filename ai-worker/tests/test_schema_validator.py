"""Tests for classification JSON schema validation (integration of new prompt fields)."""

import pytest
from src.lib.schema_validator import validate_classification, CLASSIFICATION_SCHEMA


def test_classification_schema_allows_new_contact_and_description_fields():
    """Payload mit allen neuen Classifier-Feldern (organizer_website, improved_description, etc.) soll validieren."""
    data = {
        "categories": ["museum"],
        "is_family_friendly": True,
        "age_min": 4,
        "age_max": 12,
        "confidence": 0.85,
        "extracted_organizer_website": "https://example.de",
        "extracted_contact_email": "info@example.de",
        "extracted_contact_phone": None,
        "contact_confidence": 0.8,
        "extracted_organizer_directions": "Direkt am Marktplatz.",
        "improved_description": "<p>Text <strong>wichtig</strong>.</p>",
        "description_improvement_confidence": 0.85,
        "is_cancelled_or_postponed": False,
    }
    valid, err = validate_classification(data)
    assert valid, f"Validation failed: {err}"


def test_classification_schema_minimal_required():
    """Nur categories (und ggf. is_family_friendly im Fallback) nötig; neue Felder optional."""
    data = {"categories": [], "is_family_friendly": True}
    valid, err = validate_classification(data)
    assert valid, f"Validation failed: {err}"
