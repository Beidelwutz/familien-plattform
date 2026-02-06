"""
Sitemap parser for URL discovery.

Fetches sitemap.xml or sitemap_index.xml, parses <loc> URLs,
and optionally filters by path patterns (e.g. /events, /veranstaltung).
"""

import re
import logging
from typing import Optional
from urllib.parse import urlparse
import xml.etree.ElementTree as ET

import httpx

logger = logging.getLogger(__name__)

# Common namespaces in sitemap XML
SITEMAP_NS = {"sm": "http://www.sitemaps.org/schemas/sitemap/0.9"}

# Path patterns that often indicate event detail pages (lowercase)
EVENT_PATH_PATTERNS = [
    r"/event[s]?/",
    r"/veranstaltung(en)?/",
    r"/termine?/",
    r"/kalender/",
    r"/programm/",
    r"/aktivitaet(en)?/",
    r"/angebot(e)?/",
]


def _matches_event_path(url: str, path_patterns: list[str]) -> bool:
    """Return True if URL path matches any of the given regex patterns."""
    parsed = urlparse(url)
    path_lower = (parsed.path or "/").lower()
    for pattern in path_patterns:
        if re.search(pattern, path_lower):
            return True
    return False


async def fetch_sitemap_urls(
    base_url: str,
    sitemap_url: Optional[str] = None,
    filter_event_like: bool = True,
    path_patterns: Optional[list[str]] = None,
    max_urls: int = 200,
    timeout: float = 15.0,
) -> list[str]:
    """
    Fetch sitemap (or sitemap index) and return list of URLs.

    Args:
        base_url: Base URL of the site (e.g. https://example.com).
        sitemap_url: Full URL to sitemap. If None, tries {base_url}/sitemap.xml and robots.txt.
        filter_event_like: If True, only include URLs whose path matches EVENT_PATH_PATTERNS (or path_patterns).
        path_patterns: Custom regex patterns for path filtering. If None, uses EVENT_PATH_PATTERNS when filter_event_like.
        max_urls: Maximum number of URLs to return.
        timeout: Request timeout in seconds.

    Returns:
        List of absolute URLs (may be empty if sitemap not found or no matches).
    """
    parsed_base = urlparse(base_url)
    origin = f"{parsed_base.scheme}://{parsed_base.netloc}"
    if not sitemap_url:
        sitemap_url = f"{origin}/sitemap.xml"

    all_locs: list[str] = []
    seen: set[str] = set()
    to_fetch: list[str] = [sitemap_url]

    patterns = path_patterns if path_patterns is not None else (EVENT_PATH_PATTERNS if filter_event_like else [])

    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        while to_fetch and len(all_locs) < max_urls:
            url = to_fetch.pop(0)
            if url in seen:
                continue
            seen.add(url)
            try:
                resp = await client.get(url)
                if resp.status_code != 200:
                    continue
                root = ET.fromstring(resp.content)
            except Exception as e:
                logger.debug("Sitemap parse error for %s: %s", url, e)
                continue

            # Handle both namespaced and non-namespaced sitemaps
            def iter_loc_elements():
                for el in root.iter():
                    tag = (el.tag or "").split("}")[-1]
                    if tag == "loc" and el.text:
                        yield el.text.strip()

            for loc_text in iter_loc_elements():
                if not loc_text:
                    continue
                # Sitemap index: loc points to another sitemap
                if loc_text.endswith(".xml") and "sitemap" in loc_text.lower():
                    if loc_text not in seen:
                        seen.add(loc_text)
                        to_fetch.append(loc_text)
                    continue
                if filter_event_like and patterns and not _matches_event_path(loc_text, patterns):
                    continue
                if loc_text not in seen:
                    seen.add(loc_text)
                    all_locs.append(loc_text)
                    if len(all_locs) >= max_urls:
                        break

    return all_locs[:max_urls]


async def get_sitemap_url_for_domain(base_url: str, timeout: float = 5.0) -> Optional[str]:
    """
    Try to find a sitemap URL for the domain (robots.txt or /sitemap.xml).

    Returns:
        Sitemap URL if found, else None.
    """
    parsed = urlparse(base_url)
    origin = f"{parsed.scheme}://{parsed.netloc}"
    async with httpx.AsyncClient(timeout=timeout) as client:
        try:
            r = await client.get(f"{origin}/robots.txt")
            if r.status_code == 200 and "sitemap:" in r.text.lower():
                for line in r.text.splitlines():
                    if line.strip().lower().startswith("sitemap:"):
                        return line.split(":", 1)[1].strip()
        except Exception:
            pass
        try:
            r = await client.get(f"{origin}/sitemap.xml")
            if r.status_code == 200:
                return f"{origin}/sitemap.xml"
        except Exception:
            pass
    return None
