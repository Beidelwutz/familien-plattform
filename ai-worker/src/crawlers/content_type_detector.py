"""
Detects what kind of content a URL returns (RSS/Atom, ICS, HTML, or unknown).
Used to show a clear warning when the source type (rss/ics/scraper) does not match
what the URL actually returns (e.g. HTML page instead of ICS feed).
"""

import logging
from typing import Optional

import httpx

from .ssrf_guard import validate_url_safe

logger = logging.getLogger(__name__)

SNIPPET_SIZE = 8192  # first 8 KB enough to detect format


def detect_content_type_from_response(
    content_type_header: Optional[str],
    body_snippet: str,
) -> str:
    """
    Detect content type from Content-Type header and body snippet.
    Returns: "rss" | "ics" | "html" | "unknown"
    """
    body = (body_snippet or "").strip()
    header = (content_type_header or "").lower()

    # Header hints
    if "text/calendar" in header or "application/ics" in header:
        return "ics"
    if "application/rss+xml" in header or "application/atom+xml" in header:
        return "rss"
    if "text/xml" in header or "application/xml" in header:
        if "<rss" in body[:500] or "<feed" in body[:500] or '<?xml' in body[:200]:
            return "rss"
    if "text/html" in header and ("<!doctype" in body[:200].lower() or "<html" in body[:200].lower()):
        return "html"

    # Sniff body
    body_lower = body[:2000].lower()
    if body.strip().startswith("BEGIN:VCALENDAR"):
        return "ics"
    if "<!doctype" in body_lower or "<html" in body_lower or "<!--" in body_lower[:500]:
        return "html"
    if body.lstrip().startswith("<?xml") or "<rss" in body_lower[:500] or "<feed" in body_lower[:500]:
        return "rss"

    return "unknown"


def get_mismatch_message(detected: str, configured: str) -> str:
    """Return a short German message when detected type does not match configured source type."""
    configured = (configured or "").lower()
    detected = (detected or "").lower()

    labels = {
        "rss": "RSS/Atom-Feed",
        "ics": "ICS-Kalender",
        "html": "HTML-Seite",
        "scraper": "HTML (Scraper)",
        "unknown": "unbekanntes Format",
    }
    det_label = labels.get(detected, detected)
    conf_label = labels.get(configured, configured)

    if detected == "html" and configured in ("rss", "ics"):
        return f"Die URL liefert eine HTML-Seite, kein {conf_label}. Bitte die richtige Feed-URL verwenden (z. B. .ics oder RSS-Link)."
    if detected == "ics" and configured == "rss":
        return f"Die URL liefert einen ICS-Kalender, aber die Quelle ist als RSS eingetragen. Quelle auf „ICS“ umstellen."
    if detected == "rss" and configured == "ics":
        return "Die URL liefert einen RSS/Atom-Feed, aber die Quelle ist als ICS eingetragen. Quelle auf „RSS“ umstellen."
    if detected == "html" and configured == "scraper":
        return ""  # Scraper expects HTML – no mismatch
    if detected == "unknown":
        return f"Der Inhaltstyp konnte nicht erkannt werden. Erwartet: {conf_label}."
    if detected != configured:
        return f"Die URL liefert {det_label}, die Quelle ist als {conf_label} eingetragen. Bitte anpassen."
    return ""


async def fetch_and_detect(url: str) -> dict:
    """
    Fetch first bytes of URL and detect content type.
    Returns dict with: content_type_detected, content_type_header (optional).
    Raises on SSRF or connection errors.
    """
    validate_url_safe(url)
    async with httpx.AsyncClient(
        timeout=10.0,
        follow_redirects=True,
        headers={"User-Agent": "Kiezling-Bot/1.0 (+https://kiezling.com/bot)"},
    ) as client:
        response = await client.get(url)
        response.raise_for_status()
        # Read only first SNIPPET_SIZE to avoid loading huge HTML
        raw = response.content[:SNIPPET_SIZE]
        if isinstance(raw, bytes):
            try:
                text = raw.decode("utf-8", errors="replace")
            except Exception:
                text = raw.decode("latin-1", errors="replace")
        else:
            text = raw
        content_type_header = response.headers.get("Content-Type") or ""
        detected = detect_content_type_from_response(content_type_header, text)
        return {
            "content_type_detected": detected,
            "content_type_header": content_type_header[:200],
        }
