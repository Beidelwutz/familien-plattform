"""Custom CSS-selector-based extraction for event detail pages.

Uses per-source detail_page_config to extract fields from HTML.
Also includes SelectorSuggester for heuristic selector generation.
"""

import logging
import re
from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from typing import Any, Optional
from urllib.parse import urljoin

from bs4 import BeautifulSoup, Tag

logger = logging.getLogger(__name__)


class AttrType(str, Enum):
    """Supported attribute extraction types (strict enum, no aliases)."""
    TEXT = "text"
    DATETIME = "datetime"
    SRC = "src"
    HREF = "href"
    CONTENT = "content"


@dataclass
class ExtractionResult:
    """Result per field with provenance tracking."""
    value: Any
    confidence: float       # Fixed defaults: custom_selector=0.95, jsonld=0.9, heuristic=0.6-0.75, ai=0.5-0.85
    source: str             # "custom_selector" | "jsonld" | "microdata" | "heuristic" | "ai"
    evidence: str           # e.g. "css:h1.event-title" or "jsonld:startDate"


# Attribute extraction functions per attr type
def _extract_text(el: Tag) -> Optional[str]:
    return el.get_text(strip=True) or None


def _extract_datetime_attr(el: Tag) -> Optional[str]:
    return el.get("datetime") or el.get("content") or el.get_text(strip=True) or None


def _extract_src(el: Tag) -> Optional[str]:
    return el.get("src") or el.get("data-src") or None


def _extract_href(el: Tag) -> Optional[str]:
    return el.get("href") or None


def _extract_content(el: Tag) -> Optional[str]:
    return el.get("content") or None


ATTR_EXTRACTORS = {
    AttrType.TEXT: _extract_text,
    AttrType.DATETIME: _extract_datetime_attr,
    AttrType.SRC: _extract_src,
    AttrType.HREF: _extract_href,
    AttrType.CONTENT: _extract_content,
}


# Date format patterns for parsing with detail_page_config.parsing.date_formats
_DATE_FORMAT_MAP = {
    "DD.MM.YYYY HH:mm": r"(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})",
    "DD.MM.YYYY": r"(\d{1,2})\.(\d{1,2})\.(\d{4})",
    "YYYY-MM-DDTHH:mm": r"(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})",
    "YYYY-MM-DD": r"(\d{4})-(\d{2})-(\d{2})",
    "DD.MM.YY HH:mm": r"(\d{1,2})\.(\d{1,2})\.(\d{2})\s+(\d{1,2}):(\d{2})",
    "DD.MM.YY": r"(\d{1,2})\.(\d{1,2})\.(\d{2})",
}


def _parse_date_with_formats(value: str, date_formats: list[str]) -> Optional[datetime]:
    """Try to parse a date string using configured formats."""
    value = value.strip()

    # Always try ISO 8601 first
    try:
        cleaned = value.replace('Z', '+00:00')
        if '+' in cleaned and 'T' in cleaned:
            cleaned = cleaned.split('+')[0]
        return datetime.fromisoformat(cleaned)
    except (ValueError, TypeError):
        pass

    for fmt in date_formats:
        pattern = _DATE_FORMAT_MAP.get(fmt)
        if not pattern:
            continue
        m = re.search(pattern, value)
        if not m:
            continue
        groups = m.groups()
        try:
            if fmt.startswith("YYYY"):
                year, month, day = int(groups[0]), int(groups[1]), int(groups[2])
                hour = int(groups[3]) if len(groups) > 3 else 0
                minute = int(groups[4]) if len(groups) > 4 else 0
            else:
                day, month = int(groups[0]), int(groups[1])
                year = int(groups[2])
                if year < 100:
                    year += 2000
                hour = int(groups[3]) if len(groups) > 3 else 0
                minute = int(groups[4]) if len(groups) > 4 else 0

            if 2020 <= year <= 2030 and 1 <= month <= 12 and 1 <= day <= 31:
                return datetime(year, month, day, hour, minute)
        except (ValueError, IndexError):
            continue

    return None


def _parse_date_flexible(value: str) -> Optional[datetime]:
    """Parse date with common formats as fallback when no config formats given."""
    return _parse_date_with_formats(value, list(_DATE_FORMAT_MAP.keys()))


class CustomSelectorExtractor:
    """Applies detail_page_config selectors to HTML to extract event fields."""

    DATETIME_FIELDS = {"start_datetime", "end_datetime"}

    def extract(
        self,
        html: str,
        config: dict,
        fields_needed: list[str],
        base_url: str = "",
    ) -> dict[str, ExtractionResult]:
        """
        Extract fields from HTML using configured CSS selectors.

        For each field in fields_needed:
        1. Look up config["selectors"][field]["css"] (list of fallback selectors)
        2. Try each selector, take first match
        3. Extract value using config["selectors"][field]["attr"]
        4. For datetime fields: parse with config["parsing"]["date_formats"]
        5. If value not parseable -> field NOT in result (= missing)

        Returns dict of field -> ExtractionResult for successfully found fields only.
        """
        selectors_config = config.get("selectors", {})
        parsing_config = config.get("parsing", {})
        date_formats = parsing_config.get("date_formats", [])
        # Aliases: UI may save as "image"/"organizer", pipeline may request "image_url"/"organizer_name"
        _ALIASES = {"image_url": "image", "organizer_name": "organizer"}

        if not selectors_config:
            return {}

        soup = BeautifulSoup(html, 'lxml')
        results: dict[str, ExtractionResult] = {}

        for field in fields_needed:
            field_config = selectors_config.get(field) or (
                selectors_config.get(_ALIASES[field]) if field in _ALIASES else None
            )
            if not field_config:
                continue

            css_selectors = field_config.get("css", [])
            attr_type_str = field_config.get("attr", "text")

            try:
                attr_type = AttrType(attr_type_str)
            except ValueError:
                logger.warning(f"Invalid attr type '{attr_type_str}' for field '{field}', defaulting to text")
                attr_type = AttrType.TEXT

            extractor_fn = ATTR_EXTRACTORS[attr_type]

            # Try each CSS selector in order (fallbacks)
            value = None
            matched_selector = None
            for css in css_selectors:
                try:
                    el = soup.select_one(css)
                    if el:
                        raw_value = extractor_fn(el)
                        if raw_value and str(raw_value).strip():
                            value = str(raw_value).strip()
                            matched_selector = css
                            break
                except Exception as e:
                    logger.debug(f"CSS selector '{css}' failed for field '{field}': {e}")
                    continue

            if value is None:
                continue

            # Post-process: parse dates, resolve URLs
            if field in self.DATETIME_FIELDS:
                parsed_dt = None
                if date_formats:
                    parsed_dt = _parse_date_with_formats(value, date_formats)
                if not parsed_dt:
                    parsed_dt = _parse_date_flexible(value)
                if not parsed_dt:
                    # Not parseable = missing, not found
                    logger.debug(f"Date not parseable for field '{field}': {value!r}")
                    continue
                value = parsed_dt.isoformat()

            elif field in ("image", "image_url") and base_url:
                value = urljoin(base_url, value)

            elif field in ("price",):
                # Keep raw text for now; price parsing happens downstream
                pass

            results[field] = ExtractionResult(
                value=value,
                confidence=0.95,
                source="custom_selector",
                evidence=f"css:{matched_selector}",
            )

        logger.info(f"CustomSelectorExtractor: found {len(results)}/{len(fields_needed)} fields")
        return results


class SelectorSuggester:
    """Generates CSS selector suggestions from extracted values (heuristic, no LLM).

    Output format always matches detail_page_config structure:
    { "field": { "css": ["best_selector"], "attr": "text|datetime|src|..." } }
    """

    def suggest(
        self,
        soup: BeautifulSoup,
        extracted_values: dict[str, Any],
    ) -> dict[str, dict]:
        """
        For each field: find the extracted value in the DOM, generate best selector.

        Strategies:
        1. For datetime fields: search time[datetime] or meta[content] first (preferred!)
        2. For src/href fields: find element with matching attribute
        3. For text fields: find least-ancestor node containing the text
        4. Check unique-match: selector must yield exactly 1 hit, else try to refine
        5. Selector priority: #id > [data-*] > .class > tag.class > tag path

        Returns only fields with reliable suggestions.
        """
        suggestions: dict[str, dict] = {}

        for field, value in extracted_values.items():
            if value is None:
                continue
            value_str = str(value).strip()
            if not value_str:
                continue

            suggestion = None

            # Strategy 1: datetime fields -- prefer time[datetime] or meta[content]
            if field in ("start_datetime", "end_datetime"):
                suggestion = self._suggest_datetime(soup, value_str)
            elif field == "image":
                suggestion = self._suggest_by_attr(soup, value_str, "src")
            elif field in ("booking_url", "url"):
                suggestion = self._suggest_by_attr(soup, value_str, "href")
            else:
                suggestion = self._suggest_by_text(soup, value_str)

            if suggestion:
                suggestions[field] = suggestion

        logger.info(f"SelectorSuggester: generated {len(suggestions)} suggestions")
        return suggestions

    def _suggest_datetime(self, soup: BeautifulSoup, value: str) -> Optional[dict]:
        """Find time[datetime] or meta[content] containing the date value."""
        # Extract date portion for partial matching (e.g. "2026-02-14" from ISO string)
        date_part = value[:10] if len(value) >= 10 else value

        # Search time elements with datetime attribute
        for time_el in soup.find_all('time', datetime=True):
            dt_val = time_el.get('datetime', '')
            if date_part in dt_val:
                selector = self._generate_selector(soup, time_el)
                if selector:
                    return {"css": [selector], "attr": "datetime"}

        # Search meta elements with content
        for meta in soup.find_all('meta', content=True):
            content = meta.get('content', '')
            if date_part in content:
                name = meta.get('property') or meta.get('name')
                if name:
                    selector = f'meta[property="{name}"]' if meta.get('property') else f'meta[name="{name}"]'
                    return {"css": [selector], "attr": "content"}

        # Fallback: text match
        return self._suggest_by_text(soup, value, attr_override="datetime")

    def _suggest_by_attr(self, soup: BeautifulSoup, value: str, attr: str) -> Optional[dict]:
        """Find element with matching attribute value (src, href)."""
        for el in soup.find_all(True, **{attr: True}):
            attr_val = el.get(attr, '')
            if value in attr_val or attr_val in value:
                selector = self._generate_selector(soup, el)
                if selector:
                    return {"css": [selector], "attr": attr}
        return None

    def _suggest_by_text(self, soup: BeautifulSoup, value: str, attr_override: str = "text") -> Optional[dict]:
        """Find least-ancestor node containing the text, generate selector."""
        # Normalize whitespace for matching
        norm_value = re.sub(r'\s+', ' ', value).strip().lower()
        if len(norm_value) < 3:
            return None

        best_el = None
        best_text_len = float('inf')

        # Find all text-containing elements (prefer smallest/most specific)
        for el in soup.find_all(True):
            if el.name in ('script', 'style', 'nav', 'footer', 'noscript'):
                continue
            el_text = re.sub(r'\s+', ' ', el.get_text(strip=True)).lower()
            if norm_value in el_text:
                # Least-ancestor: prefer element with shortest text (most specific)
                if len(el_text) < best_text_len:
                    best_text_len = len(el_text)
                    best_el = el

        if best_el:
            selector = self._generate_selector(soup, best_el)
            if selector:
                # Verify unique match
                matches = soup.select(selector)
                if len(matches) == 1:
                    return {"css": [selector], "attr": attr_override}
                # Try to refine with parent class
                refined = self._refine_selector(soup, best_el, selector)
                if refined:
                    return {"css": [refined], "attr": attr_override}

        return None

    def _generate_selector(self, soup: BeautifulSoup, el: Tag) -> Optional[str]:
        """Generate CSS selector for an element.

        Priority: #id > [data-*] > .class > tag.class > tag path
        """
        if not isinstance(el, Tag):
            return None

        # 1. ID selector (most specific)
        el_id = el.get('id')
        if el_id and isinstance(el_id, str):
            selector = f'#{el_id}'
            if len(soup.select(selector)) == 1:
                return selector

        # 2. data-* attribute selector
        for attr_name, attr_val in (el.attrs or {}).items():
            if attr_name.startswith('data-') and isinstance(attr_val, str):
                selector = f'{el.name}[{attr_name}="{attr_val}"]'
                if len(soup.select(selector)) == 1:
                    return selector

        # 3. Class-based selector
        classes = el.get('class', [])
        if classes and isinstance(classes, list):
            # Filter out generic classes
            specific_classes = [c for c in classes if len(c) > 2 and not c.startswith('js-')]
            if specific_classes:
                class_sel = '.'.join(specific_classes)
                selector = f'{el.name}.{class_sel}'
                if len(soup.select(selector)) == 1:
                    return selector
                # Try just the most specific class
                selector = f'.{specific_classes[0]}'
                if len(soup.select(selector)) == 1:
                    return selector

        # 4. Tag + itemprop
        itemprop = el.get('itemprop')
        if itemprop:
            selector = f'{el.name}[itemprop="{itemprop}"]'
            if len(soup.select(selector)) == 1:
                return selector

        # 5. Simple tag (only for unique tags like h1)
        selector = el.name
        if len(soup.select(selector)) == 1:
            return selector

        # 6. Parent context
        parent = el.parent
        if parent and isinstance(parent, Tag):
            parent_sel = self._generate_selector(soup, parent)
            if parent_sel:
                child_sel = el.name
                if classes and isinstance(classes, list) and classes:
                    child_sel = f'{el.name}.{classes[0]}'
                combined = f'{parent_sel} {child_sel}'
                try:
                    if len(soup.select(combined)) == 1:
                        return combined
                except Exception:
                    pass

        return None

    def _refine_selector(self, soup: BeautifulSoup, el: Tag, base_selector: str) -> Optional[str]:
        """Try to make a non-unique selector unique by adding parent context."""
        parent = el.parent
        if not parent or not isinstance(parent, Tag):
            return None

        for _ in range(3):  # Max 3 levels up
            parent_classes = parent.get('class', [])
            if parent_classes and isinstance(parent_classes, list):
                refined = f'.{parent_classes[0]} {base_selector}'
                try:
                    if len(soup.select(refined)) == 1:
                        return refined
                except Exception:
                    pass

            parent_id = parent.get('id')
            if parent_id:
                refined = f'#{parent_id} {base_selector}'
                try:
                    if len(soup.select(refined)) == 1:
                        return refined
                except Exception:
                    pass

            parent = parent.parent
            if not parent or not isinstance(parent, Tag):
                break

        return None
