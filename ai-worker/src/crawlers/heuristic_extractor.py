"""Heuristic extraction for event detail pages.

Extracts event data from visible HTML text using regex patterns and label matching.
Migrated from structured_data.py and extended with:
- Additional date formats (abbreviated months, ISO, weekday prefix, 2-digit year)
- Extended location labels (Adresse, Anfahrt, Treffpunkt, Venue, dl/dt/dd, table)
- Price recognition (EUR, Euro, kostenlos, Spende)
"""

import logging
import re
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Optional

from bs4 import BeautifulSoup

from .custom_selector_extractor import ExtractionResult

logger = logging.getLogger(__name__)


class HeuristicExtractor:
    """Extract event fields from visible HTML text using heuristics."""

    # German month names → month number (full + abbreviated)
    _GERMAN_MONTHS: dict[str, int] = {
        'januar': 1, 'februar': 2, 'märz': 3, 'april': 4,
        'mai': 5, 'juni': 6, 'juli': 7, 'august': 8,
        'september': 9, 'oktober': 10, 'november': 11, 'dezember': 12,
        # Abbreviated
        'jan': 1, 'feb': 2, 'mär': 3, 'apr': 4,
        'jun': 6, 'jul': 7, 'aug': 8, 'sep': 9,
        'okt': 10, 'nov': 11, 'dez': 12,
        # With dots
        'jan.': 1, 'feb.': 2, 'mär.': 3, 'apr.': 4,
        'mai.': 5, 'jun.': 6, 'jul.': 7, 'aug.': 8,
        'sep.': 9, 'okt.': 10, 'nov.': 11, 'dez.': 12,
    }

    # English month fallback
    _ENGLISH_MONTHS: dict[str, int] = {
        'january': 1, 'february': 2, 'march': 3, 'april': 4,
        'may': 5, 'june': 6, 'july': 7, 'august': 8,
        'september': 9, 'october': 10, 'november': 11, 'december': 12,
        'jan': 1, 'feb': 2, 'mar': 3, 'apr': 4,
        'jun': 6, 'jul': 7, 'aug': 8, 'sep': 9,
        'oct': 10, 'nov': 11, 'dec': 12,
    }

    # Street-type suffixes
    _STREET_SUFFIXES = (
        r'(?:[Ss]tra[ßs]e|[Ss]tr\.|[Pp]latz|[Ww]eg|[Aa]llee|[Rr]ing|'
        r'[Gg]asse|[Dd]amm|[Uu]fer|[Ss]teig|[Pp]fad|[Pp]romenade|'
        r'[Bb]rücke|[Cc]haussee|[Mm]arkt|[Hh]of)'
    )

    # ── Date patterns ──────────────────────────────────────────────

    # All German month names for regex (full + abbreviated)
    _ALL_MONTH_NAMES = [
        'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
        'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
        'Jan', 'Feb', 'Mär', 'Apr', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez',
        'Jan\\.', 'Feb\\.', 'Mär\\.', 'Apr\\.', 'Jun\\.', 'Jul\\.', 'Aug\\.', 'Sep\\.', 'Okt\\.', 'Nov\\.', 'Dez\\.',
    ]

    # "14. Februar 2026" / "14. Feb. 2026" / "14. Feb 2026"
    _RE_DATE_LONG = re.compile(
        r'(\d{1,2})\.\s*'
        r'(' + '|'.join(_ALL_MONTH_NAMES) + r')\.?\s+'
        r'(\d{4}|\d{2})',
        re.IGNORECASE,
    )

    # "Samstag, 14. Februar 2026" / "Sa, 14.02.2026" (weekday prefix, ignored)
    _RE_WEEKDAY_PREFIX = re.compile(
        r'(?:Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag|'
        r'Mo|Di|Mi|Do|Fr|Sa|So)[.,]?\s*',
        re.IGNORECASE,
    )

    # "14.02.2026" or "14.02.26"
    _RE_DATE_SHORT = re.compile(
        r'(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})',
    )

    # "2026-02-14" (ISO in text)
    _RE_DATE_ISO = re.compile(
        r'(\d{4})-(\d{2})-(\d{2})',
    )

    # Time patterns
    _RE_TIME = re.compile(
        r'(\d{1,2})[:\.](\d{2})\s*(?:Uhr)?|(\d{1,2})\s*Uhr',
        re.IGNORECASE,
    )

    _RE_TIME_RANGE = re.compile(
        r'(\d{1,2})[:\.]?(\d{2})?\s*'
        r'(?:bis|–|—|-)\s*'
        r'(\d{1,2})[:\.]?(\d{2})?\s*(?:Uhr)?',
        re.IGNORECASE,
    )

    # ── Address patterns ───────────────────────────────────────────

    _RE_ADDRESS = re.compile(
        r'([\wÄÖÜäöüß\-\.]+(?:\s[\wÄÖÜäöüß\-\.]+)*'
        + _STREET_SUFFIXES +
        r'\s+\d+\s*\w?)'
        r'[\s,]+(\d{5})\s+'
        r'([A-ZÄÖÜ][\wÄÖÜäöüß\-]+(?:\s(?:am|an\sder|im|bei|ob\sder)\s[\wÄÖÜäöüß\-]+)?)',
        re.UNICODE,
    )

    # ── Location label patterns (extended) ─────────────────────────

    _RE_ORT_LABEL = re.compile(
        r'(?:Ort|Veranstaltungsort|Location|Spielort|Spielstätte|Wo|'
        r'Adresse|Anfahrt|Treffpunkt|Venue|Wo\?)\s*[:]\s*(.+)',
        re.IGNORECASE,
    )

    # ── Price patterns (new) ───────────────────────────────────────

    _RE_PRICE_AMOUNT = re.compile(
        r'(?:Eintritt|Preis|Kosten|Tickets?|Karten?)\s*[:.]?\s*'
        r'(?:ab\s+)?(\d+(?:[.,]\d{1,2})?)\s*(?:EUR|Euro|€)',
        re.IGNORECASE,
    )

    _RE_PRICE_AMOUNT_SIMPLE = re.compile(
        r'(\d+(?:[.,]\d{1,2})?)\s*(?:EUR|Euro|€)',
        re.IGNORECASE,
    )

    _RE_PRICE_FREE = re.compile(
        r'(?:Eintritt\s+frei|kostenlos|kostenfrei|freier\s+Eintritt|kein\s+Eintritt)',
        re.IGNORECASE,
    )

    _RE_PRICE_DONATION = re.compile(
        r'(?:Spende|auf\s+Spendenbasis|pay\s+what\s+you\s+(?:can|want))',
        re.IGNORECASE,
    )

    def extract(
        self,
        html: str,
        fields_needed: list[str],
    ) -> dict[str, ExtractionResult]:
        """
        Extract event fields from visible HTML text using heuristics.

        Returns dict of field -> ExtractionResult for found fields.
        Confidence: 0.60 for weak matches, 0.75 for strong regex matches.
        """
        soup = BeautifulSoup(html, 'lxml')
        visible_text = self._get_visible_text(soup)
        results: dict[str, ExtractionResult] = {}

        if len(visible_text) < 30:
            return results

        # Title
        if "title" in fields_needed:
            title = self._extract_title(soup)
            if title:
                results["title"] = ExtractionResult(
                    value=title, confidence=0.70, source="heuristic", evidence="h1/og:title/title"
                )

        # Date/time
        if "start_datetime" in fields_needed or "end_datetime" in fields_needed:
            start_dt, end_dt = self._extract_german_datetime(visible_text)
            if start_dt and "start_datetime" in fields_needed:
                results["start_datetime"] = ExtractionResult(
                    value=start_dt.isoformat(), confidence=0.70, source="heuristic", evidence="date_regex"
                )
            if end_dt and "end_datetime" in fields_needed:
                results["end_datetime"] = ExtractionResult(
                    value=end_dt.isoformat(), confidence=0.65, source="heuristic", evidence="time_range_regex"
                )

        # Address
        if "location_address" in fields_needed:
            addr = self._extract_german_address(visible_text)
            if addr:
                results["location_address"] = ExtractionResult(
                    value=addr, confidence=0.75, source="heuristic", evidence="address_regex"
                )

        # Location/venue name
        if "location_name" in fields_needed:
            loc_name = self._extract_location_name(soup, visible_text)
            if loc_name:
                results["location_name"] = ExtractionResult(
                    value=loc_name, confidence=0.65, source="heuristic", evidence="ort_label"
                )

        # Image
        if "image" in fields_needed:
            img = self._extract_og_image(soup)
            if img:
                results["image"] = ExtractionResult(
                    value=img, confidence=0.70, source="heuristic", evidence="og:image"
                )

        # Description
        if "description" in fields_needed:
            desc = self._extract_description(soup)
            if desc:
                results["description"] = ExtractionResult(
                    value=desc, confidence=0.60, source="heuristic", evidence="og:description/longest_p"
                )

        # Price (new)
        if "price" in fields_needed or "price_type" in fields_needed:
            price_result = self._extract_price(visible_text)
            if price_result:
                for k, v in price_result.items():
                    if k in fields_needed:
                        results[k] = v

        logger.info(f"HeuristicExtractor: found {len(results)}/{len(fields_needed)} fields")
        return results

    # ── Text cleaning ──────────────────────────────────────────────

    def _get_visible_text(self, soup: BeautifulSoup) -> str:
        clone = BeautifulSoup(str(soup), 'lxml')
        for tag_name in ('script', 'style', 'nav', 'footer', 'aside', 'noscript',
                         'iframe', 'svg', 'form'):
            for el in clone.find_all(tag_name):
                el.decompose()
        for el in clone.find_all(True, attrs={
            'class': re.compile(r'cookie|consent|banner|popup|modal|gdpr', re.I),
        }):
            el.decompose()
        for el in clone.find_all(True, attrs={
            'id': re.compile(r'cookie|consent|banner|popup|modal|gdpr', re.I),
        }):
            el.decompose()
        text = clone.get_text(separator='\n', strip=True)
        text = re.sub(r'\n{3,}', '\n\n', text)
        return text

    # ── Title ──────────────────────────────────────────────────────

    def _extract_title(self, soup: BeautifulSoup) -> Optional[str]:
        h1 = soup.find('h1')
        if h1:
            text = h1.get_text(strip=True)
            if text and len(text) > 3:
                return text
        og = soup.find('meta', property='og:title')
        if og and og.get('content'):
            return og['content'].strip()
        title_tag = soup.find('title')
        if title_tag:
            text = title_tag.get_text(strip=True)
            text = re.split(r'\s*[|–—-]\s*', text)[0].strip()
            if text and len(text) > 3:
                return text
        return None

    # ── Date/Time ──────────────────────────────────────────────────

    def _extract_german_datetime(self, text: str) -> tuple[Optional[datetime], Optional[datetime]]:
        """Extract start and optional end datetime from German/ISO text."""
        start_dt: Optional[datetime] = None
        end_dt: Optional[datetime] = None
        year: Optional[int] = None
        month: Optional[int] = None
        day: Optional[int] = None
        date_end_pos: int = 0

        # Strip weekday prefix for matching
        clean_text = self._RE_WEEKDAY_PREFIX.sub('', text)

        # Try long German date: "14. Februar 2026" / "14. Feb. 2026"
        m_long = self._RE_DATE_LONG.search(clean_text)
        if m_long:
            day = int(m_long.group(1))
            month_name = m_long.group(2).lower().rstrip('.')
            month = self._GERMAN_MONTHS.get(month_name) or self._ENGLISH_MONTHS.get(month_name)
            year_str = m_long.group(3)
            year = int(year_str)
            if year < 100:
                year += 2000
            date_end_pos = m_long.end()
        else:
            # Try ISO date: "2026-02-14"
            m_iso = self._RE_DATE_ISO.search(clean_text)
            if m_iso:
                year = int(m_iso.group(1))
                month = int(m_iso.group(2))
                day = int(m_iso.group(3))
                date_end_pos = m_iso.end()
            else:
                # Try short date: "14.02.2026" / "14.02.26"
                m_short = self._RE_DATE_SHORT.search(clean_text)
                if m_short:
                    day = int(m_short.group(1))
                    month = int(m_short.group(2))
                    year_str = m_short.group(3)
                    year = int(year_str)
                    if year < 100:
                        year += 2000
                    date_end_pos = m_short.end()

        if not (year and month and day):
            return None, None

        if year < 2020 or year > 2030 or month < 1 or month > 12 or day < 1 or day > 31:
            return None, None

        # Search for time near the date (within ~120 chars after)
        time_window = clean_text[date_end_pos:date_end_pos + 120]

        m_range = self._RE_TIME_RANGE.search(time_window)
        if m_range:
            start_hour = int(m_range.group(1))
            start_min = int(m_range.group(2)) if m_range.group(2) else 0
            end_hour = int(m_range.group(3))
            end_min = int(m_range.group(4)) if m_range.group(4) else 0
            try:
                start_dt = datetime(year, month, day, start_hour, start_min)
                end_dt = datetime(year, month, day, end_hour, end_min)
                if end_dt <= start_dt:
                    end_dt += timedelta(days=1)
            except ValueError:
                start_dt = None
                end_dt = None
        else:
            m_time = self._RE_TIME.search(time_window)
            if m_time:
                if m_time.group(3):
                    hour, minute = int(m_time.group(3)), 0
                else:
                    hour, minute = int(m_time.group(1)), int(m_time.group(2))
                try:
                    start_dt = datetime(year, month, day, hour, minute)
                except ValueError:
                    start_dt = None

        if start_dt is None and year and month and day:
            try:
                start_dt = datetime(year, month, day)
            except ValueError:
                return None, None

        return start_dt, end_dt

    # ── Address ────────────────────────────────────────────────────

    def _extract_german_address(self, text: str) -> Optional[str]:
        m = self._RE_ADDRESS.search(text)
        if m:
            street = m.group(1).strip()
            plz = m.group(2)
            city = m.group(3).strip()
            return f"{street}, {plz} {city}"

        plz_match = re.search(r'(\d{5})\s+([A-ZÄÖÜ][\wÄÖÜäöüß\-]+)', text)
        if plz_match:
            plz = plz_match.group(1)
            city = plz_match.group(2)
            line_start = text.rfind('\n', 0, plz_match.start())
            line_text = text[line_start + 1:plz_match.start()].strip().rstrip(',').strip()
            if line_text and len(line_text) > 5:
                return f"{line_text}, {plz} {city}"
            return f"{plz} {city}"
        return None

    # ── Location name ──────────────────────────────────────────────

    def _extract_location_name(self, soup: BeautifulSoup, visible_text: str) -> Optional[str]:
        # 1. Label pattern in text
        m = self._RE_ORT_LABEL.search(visible_text)
        if m:
            loc = m.group(1).strip().split('\n')[0].strip()
            if loc and len(loc) <= 200:
                return loc

        # 2. <dt>/<th>/<label>/<strong>/<b>/<span> with location-like text
        location_labels = (
            'ort', 'ort:', 'veranstaltungsort', 'veranstaltungsort:',
            'spielort', 'spielort:', 'location', 'location:',
            'wo', 'wo:', 'wo?', 'adresse', 'adresse:',
            'anfahrt', 'anfahrt:', 'treffpunkt', 'treffpunkt:',
            'venue', 'venue:',
        )
        for label_tag in soup.find_all(['dt', 'th', 'label', 'strong', 'b', 'span']):
            label_text = label_tag.get_text(strip=True).lower()
            if label_text in location_labels:
                next_el = label_tag.find_next_sibling()
                if next_el:
                    val = next_el.get_text(strip=True)
                    if val and len(val) > 2:
                        return val[:200]
                if label_tag.parent:
                    next_el = label_tag.parent.find_next_sibling()
                    if next_el:
                        val = next_el.get_text(strip=True)
                        if val and len(val) > 2:
                            return val[:200]

        # 3. <dl>/<dd> pattern: find dd after dt with location label
        for dl in soup.find_all('dl'):
            for dt in dl.find_all('dt'):
                dt_text = dt.get_text(strip=True).lower()
                if dt_text in location_labels:
                    dd = dt.find_next_sibling('dd')
                    if dd:
                        val = dd.get_text(strip=True)
                        if val and len(val) > 2:
                            return val[:200]

        # 4. Table rows with location header
        for table in soup.find_all('table'):
            for row in table.find_all('tr'):
                cells = row.find_all(['td', 'th'])
                if len(cells) >= 2:
                    header_text = cells[0].get_text(strip=True).lower()
                    if header_text in location_labels:
                        val = cells[1].get_text(strip=True)
                        if val and len(val) > 2:
                            return val[:200]

        # 5. aria-label based search
        for el in soup.find_all(True, attrs={'aria-label': True}):
            aria = el.get('aria-label', '').lower()
            if any(lbl.rstrip(':') in aria for lbl in ('ort', 'veranstaltungsort', 'location', 'venue', 'adresse')):
                val = el.get_text(strip=True)
                if val and len(val) > 2:
                    return val[:200]

        return None

    # ── Image ──────────────────────────────────────────────────────

    def _extract_og_image(self, soup: BeautifulSoup) -> Optional[str]:
        og = soup.find('meta', property='og:image')
        if og and og.get('content'):
            url = og['content'].strip()
            if url.startswith(('http://', 'https://')):
                return url
        return None

    # ── Description ────────────────────────────────────────────────

    def _extract_description(self, soup: BeautifulSoup) -> Optional[str]:
        og = soup.find('meta', property='og:description')
        if og and og.get('content'):
            desc = og['content'].strip()
            if len(desc) > 20:
                return desc[:5000]
        meta = soup.find('meta', attrs={'name': 'description'})
        if meta and meta.get('content'):
            desc = meta['content'].strip()
            if len(desc) > 20:
                return desc[:5000]
        main = soup.find('main') or soup.find('article') or soup.find('body')
        if main:
            paragraphs = main.find_all('p')
            if paragraphs:
                longest = max(paragraphs, key=lambda p: len(p.get_text(strip=True)))
                text = longest.get_text(strip=True)
                if len(text) > 30:
                    return text[:5000]
        return None

    # ── Price (new) ────────────────────────────────────────────────

    def _extract_price(self, text: str) -> dict[str, ExtractionResult]:
        """Extract price information from visible text."""
        results: dict[str, ExtractionResult] = {}

        # Free admission
        if self._RE_PRICE_FREE.search(text):
            results["price_type"] = ExtractionResult(
                value="free", confidence=0.75, source="heuristic", evidence="price_free_regex"
            )
            results["price"] = ExtractionResult(
                value="0", confidence=0.75, source="heuristic", evidence="price_free_regex"
            )
            return results

        # Donation
        if self._RE_PRICE_DONATION.search(text):
            results["price_type"] = ExtractionResult(
                value="donation", confidence=0.70, source="heuristic", evidence="price_donation_regex"
            )
            return results

        # Price with label
        m = self._RE_PRICE_AMOUNT.search(text)
        if m:
            price_str = m.group(1).replace(',', '.')
            results["price"] = ExtractionResult(
                value=price_str, confidence=0.70, source="heuristic", evidence="price_labeled_regex"
            )
            results["price_type"] = ExtractionResult(
                value="paid", confidence=0.65, source="heuristic", evidence="price_labeled_regex"
            )
            return results

        # Price without label (less confident)
        m = self._RE_PRICE_AMOUNT_SIMPLE.search(text)
        if m:
            price_str = m.group(1).replace(',', '.')
            results["price"] = ExtractionResult(
                value=price_str, confidence=0.60, source="heuristic", evidence="price_simple_regex"
            )
            return results

        return results
