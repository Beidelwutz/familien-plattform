"""Tests for heuristic HTML text extraction in StructuredDataExtractor.

Tests German date/time parsing, address extraction, location name extraction,
and the full heuristic pipeline with realistic HTML snippets.
"""

import pytest
from datetime import datetime

from src.crawlers.structured_data import StructuredDataExtractor


@pytest.fixture
def extractor():
    return StructuredDataExtractor()


# ===================================================================== #
#  German Date/Time Extraction                                           #
# ===================================================================== #

class TestGermanDatetimeExtraction:
    """Tests for _extract_german_datetime()."""

    def test_long_date_with_time(self, extractor):
        """'14. Februar 2026, 19 Uhr' → 2026-02-14T19:00"""
        text = "Das Mädchen aus der Streichholzfabrik\n14. Februar 2026, 19 Uhr"
        start, end = extractor._extract_german_datetime(text)
        assert start == datetime(2026, 2, 14, 19, 0)
        assert end is None

    def test_long_date_with_minutes(self, extractor):
        """'5. März 2026, 19:30 Uhr' → 2026-03-05T19:30"""
        text = "Konzert am 5. März 2026, 19:30 Uhr im Schloss"
        start, end = extractor._extract_german_datetime(text)
        assert start == datetime(2026, 3, 5, 19, 30)
        assert end is None

    def test_short_date_format(self, extractor):
        """'14.02.2026' → 2026-02-14"""
        text = "Veranstaltung am 14.02.2026"
        start, end = extractor._extract_german_datetime(text)
        assert start == datetime(2026, 2, 14)
        assert end is None

    def test_short_date_with_time(self, extractor):
        """'14.02.2026 19:00' → 2026-02-14T19:00"""
        text = "Termin: 14.02.2026 19:00 Uhr"
        start, end = extractor._extract_german_datetime(text)
        assert start == datetime(2026, 2, 14, 19, 0)
        assert end is None

    def test_time_range(self, extractor):
        """'10 bis 14 Uhr' → start 10:00, end 14:00"""
        text = "Workshop am 20. März 2026, 10 bis 14 Uhr"
        start, end = extractor._extract_german_datetime(text)
        assert start == datetime(2026, 3, 20, 10, 0)
        assert end == datetime(2026, 3, 20, 14, 0)

    def test_time_range_with_minutes(self, extractor):
        """'19:00–21:30 Uhr' → start 19:00, end 21:30"""
        text = "Konzert: 15. April 2026, 19:00–21:30 Uhr"
        start, end = extractor._extract_german_datetime(text)
        assert start == datetime(2026, 4, 15, 19, 0)
        assert end == datetime(2026, 4, 15, 21, 30)

    def test_time_range_dash(self, extractor):
        """'10-12 Uhr' → start 10:00, end 12:00"""
        text = "Führung: 1. Mai 2026, 10-12 Uhr"
        start, end = extractor._extract_german_datetime(text)
        assert start == datetime(2026, 5, 1, 10, 0)
        assert end == datetime(2026, 5, 1, 12, 0)

    def test_overnight_time_range(self, extractor):
        """'22 bis 2 Uhr' → end is next day"""
        text = "Party: 30. Mai 2026, 22 bis 2 Uhr"
        start, end = extractor._extract_german_datetime(text)
        assert start == datetime(2026, 5, 30, 22, 0)
        assert end == datetime(2026, 5, 31, 2, 0)

    def test_date_only_no_time(self, extractor):
        """Date without time → date at midnight"""
        text = "Termin am 25. Dezember 2026"
        start, end = extractor._extract_german_datetime(text)
        assert start == datetime(2026, 12, 25, 0, 0)
        assert end is None

    def test_no_date_returns_none(self, extractor):
        """No date in text → (None, None)"""
        text = "Badisches Staatstheater Karlsruhe"
        start, end = extractor._extract_german_datetime(text)
        assert start is None
        assert end is None

    def test_case_insensitive_month(self, extractor):
        """Lowercase month name should work too."""
        text = "Am 3. februar 2026, 20 Uhr"
        start, end = extractor._extract_german_datetime(text)
        assert start == datetime(2026, 2, 3, 20, 0)

    def test_dot_time_format(self, extractor):
        """'19.30 Uhr' should parse correctly."""
        text = "Beginn: 10. Januar 2026, 19.30 Uhr"
        start, end = extractor._extract_german_datetime(text)
        assert start == datetime(2026, 1, 10, 19, 30)

    def test_ignores_opening_hours_further_in_text(self, extractor):
        """
        Should NOT pick up 'Montag bis Freitag 10:00–18:30 Uhr' (opening hours)
        when the actual event time '19 Uhr' is right after the date.
        """
        text = (
            "Das Mädchen aus der Streichholzfabrik\n"
            "14. Februar 2026, 19 Uhr\n"
            "Ort: Badisches Staatstheater\n"
            "Kartenverkauf:\n"
            "Öffnungszeiten\n"
            "Montag bis Freitag 10:00–18:30 Uhr\n"
            "Samstag 10:00–13:00 Uhr"
        )
        start, end = extractor._extract_german_datetime(text)
        assert start == datetime(2026, 2, 14, 19, 0)
        assert end is None  # Should NOT have picked up 18:30 as end time


# ===================================================================== #
#  German Address Extraction                                             #
# ===================================================================== #

class TestGermanAddressExtraction:
    """Tests for _extract_german_address()."""

    def test_standard_address(self, extractor):
        """Standard German address: street, PLZ, city."""
        text = "Veranstaltungsort: Hermann-Levi-Platz 1, 76137 Karlsruhe"
        result = extractor._extract_german_address(text)
        assert result is not None
        assert "76137" in result
        assert "Karlsruhe" in result

    def test_strasse_suffix(self, extractor):
        """Address with 'straße' suffix."""
        text = "Adresse: Kaiserstraße 42, 76133 Karlsruhe"
        result = extractor._extract_german_address(text)
        assert result is not None
        assert "Kaiserstraße 42" in result
        assert "76133" in result
        assert "Karlsruhe" in result

    def test_str_dot_abbreviation(self, extractor):
        """Address with abbreviated 'Str.' suffix."""
        text = "Ort: Waldstr. 10, 76133 Karlsruhe"
        result = extractor._extract_german_address(text)
        assert result is not None
        assert "76133" in result

    def test_weg_suffix(self, extractor):
        """Address with 'weg' suffix."""
        text = "Lindenweg 5, 76131 Karlsruhe"
        result = extractor._extract_german_address(text)
        assert result is not None
        assert "Lindenweg 5" in result

    def test_allee_suffix(self, extractor):
        """Address with 'allee' suffix."""
        text = "Schloßallee 12, 76131 Karlsruhe"
        result = extractor._extract_german_address(text)
        assert result is not None
        assert "76131" in result

    def test_house_number_with_letter(self, extractor):
        """Address with house number + letter: '10a'."""
        text = "Gartenstraße 10a, 76135 Karlsruhe"
        result = extractor._extract_german_address(text)
        assert result is not None
        assert "76135" in result

    def test_ettlinger_tor_platz(self, extractor):
        """Real address from the user's example."""
        text = "Ettlinger-Tor-Platz 1\n76137 Karlsruhe"
        result = extractor._extract_german_address(text)
        assert result is not None
        assert "76137" in result
        assert "Karlsruhe" in result

    def test_no_address_returns_none(self, extractor):
        """Text without address → None."""
        text = "Dies ist ein Theaterstück von Shakespeare"
        result = extractor._extract_german_address(text)
        assert result is None

    def test_fallback_plz_city_only(self, extractor):
        """Fallback: PLZ + city without clear street pattern."""
        text = "76137 Karlsruhe"
        result = extractor._extract_german_address(text)
        assert result is not None
        assert "76137" in result
        assert "Karlsruhe" in result


# ===================================================================== #
#  Location Name Extraction                                              #
# ===================================================================== #

class TestLocationNameExtraction:
    """Tests for _extract_location_name()."""

    def test_ort_label_in_text(self, extractor):
        """'Ort: Badisches Staatstheater, Kleines Haus' → name extracted."""
        from bs4 import BeautifulSoup
        html = "<html><body><p>Ort: Badisches Staatstheater, Kleines Haus</p></body></html>"
        soup = BeautifulSoup(html, 'lxml')
        text = "Ort: Badisches Staatstheater, Kleines Haus"
        result = extractor._extract_location_name(soup, text)
        assert result is not None
        assert "Badisches Staatstheater" in result

    def test_dt_dd_pattern(self, extractor):
        """<dt>Ort</dt><dd>ZKM</dd> → 'ZKM'"""
        from bs4 import BeautifulSoup
        html = "<html><body><dl><dt>Ort</dt><dd>ZKM | Zentrum für Kunst und Medien</dd></dl></body></html>"
        soup = BeautifulSoup(html, 'lxml')
        result = extractor._extract_location_name(soup, "")
        assert result is not None
        assert "ZKM" in result

    def test_strong_label_pattern(self, extractor):
        """<strong>Ort:</strong> <span>Bibliothek</span> → 'Bibliothek'"""
        from bs4 import BeautifulSoup
        html = "<html><body><div><strong>Ort:</strong><span>Stadtbibliothek</span></div></body></html>"
        soup = BeautifulSoup(html, 'lxml')
        result = extractor._extract_location_name(soup, "")
        assert result is not None
        assert "Stadtbibliothek" in result

    def test_no_location_returns_none(self, extractor):
        """No location label or pattern → None."""
        from bs4 import BeautifulSoup
        html = "<html><body><p>Keine Ortsangabe</p></body></html>"
        soup = BeautifulSoup(html, 'lxml')
        result = extractor._extract_location_name(soup, "Keine Ortsangabe")
        assert result is None


# ===================================================================== #
#  Title Extraction                                                      #
# ===================================================================== #

class TestTitleExtraction:
    """Tests for _extract_title()."""

    def test_h1_title(self, extractor):
        from bs4 import BeautifulSoup
        html = "<html><head><title>Page | Site</title></head><body><h1>Das Mädchen aus der Streichholzfabrik</h1></body></html>"
        soup = BeautifulSoup(html, 'lxml')
        result = extractor._extract_title(soup)
        assert result == "Das Mädchen aus der Streichholzfabrik"

    def test_og_title_fallback(self, extractor):
        from bs4 import BeautifulSoup
        html = '<html><head><meta property="og:title" content="Konzert im Park" /></head><body></body></html>'
        soup = BeautifulSoup(html, 'lxml')
        result = extractor._extract_title(soup)
        assert result == "Konzert im Park"

    def test_title_tag_strips_suffix(self, extractor):
        from bs4 import BeautifulSoup
        html = "<html><head><title>Theateraufführung | Staatstheater Karlsruhe</title></head><body></body></html>"
        soup = BeautifulSoup(html, 'lxml')
        result = extractor._extract_title(soup)
        assert result == "Theateraufführung"


# ===================================================================== #
#  Full Integration: Realistic HTML Pages                                #
# ===================================================================== #

class TestFullHeuristicExtraction:
    """End-to-end tests with realistic HTML (no JSON-LD, no Microdata)."""

    def test_staatstheater_event(self, extractor):
        """
        Realistic HTML from the user's Staatstheater example.
        Should extract title, date, address, location name.
        """
        html = """
        <html>
        <head>
            <title>Das Mädchen aus der Streichholzfabrik (Premiere) | Karlsruhe</title>
            <meta property="og:title" content="Das Mädchen aus der Streichholzfabrik (Premiere)" />
            <meta property="og:description" content="nach dem Film von Aki Kaurismäki" />
            <meta property="og:image" content="https://example.com/image.jpg" />
        </head>
        <body>
            <nav><a href="/">Home</a></nav>
            <main>
                <h1>Das Mädchen aus der Streichholzfabrik (Premiere)</h1>
                <p>nach dem Film von Aki Kaurismäki</p>
                <p>14. Februar 2026, 19 Uhr</p>
                <p>Ort: Badisches Staatstheater, Kleines Haus</p>
                <p>Badisches Staatstheater, Kleines Haus</p>
                <p>Hermann-Levi-Platz 1, 76137 Karlsruhe</p>
                <p>Kontakt: kartenservice@staatstheater.karlsruhe.de</p>
            </main>
            <footer>Impressum</footer>
        </body>
        </html>
        """
        events = extractor.extract(html)
        assert len(events) == 1

        e = events[0]
        assert "Mädchen" in e.title or "Streichholzfabrik" in e.title
        assert e.start_datetime == datetime(2026, 2, 14, 19, 0)
        assert e.location_address is not None
        assert "76137" in e.location_address
        assert "Karlsruhe" in e.location_address
        assert e.location_name is not None
        assert "Badisches Staatstheater" in e.location_name
        assert e.image_url == "https://example.com/image.jpg"
        assert e.description is not None

    def test_event_with_time_range(self, extractor):
        """Event with a time range: '10 bis 14 Uhr'."""
        html = """
        <html>
        <head><title>Kinderworkshop</title></head>
        <body>
            <h1>Kinderworkshop Basteln</h1>
            <p>22. März 2026, 10 bis 14 Uhr</p>
            <p>Stadtteilbibliothek Mühlburg</p>
            <p>Rheinstraße 6, 76185 Karlsruhe</p>
        </body>
        </html>
        """
        events = extractor.extract(html)
        assert len(events) == 1

        e = events[0]
        assert e.start_datetime == datetime(2026, 3, 22, 10, 0)
        assert e.end_datetime == datetime(2026, 3, 22, 14, 0)
        assert "76185" in e.location_address

    def test_event_with_short_date(self, extractor):
        """Event with short date format '14.02.2026'."""
        html = """
        <html>
        <head><title>Konzert</title></head>
        <body>
            <h1>Klassik im Schloss</h1>
            <p>Datum: 14.02.2026, 20:00 Uhr</p>
            <p>Schlossplatz 1, 76131 Karlsruhe</p>
        </body>
        </html>
        """
        events = extractor.extract(html)
        assert len(events) == 1
        assert events[0].start_datetime == datetime(2026, 2, 14, 20, 0)

    def test_jsonld_takes_priority_over_heuristic(self, extractor):
        """If JSON-LD is present, heuristic should not run."""
        html = """
        <html>
        <head>
            <script type="application/ld+json">
            {
                "@type": "Event",
                "name": "JSON-LD Event",
                "startDate": "2026-03-15T14:00:00"
            }
            </script>
        </head>
        <body>
            <h1>HTML Title</h1>
            <p>14. Februar 2026, 19 Uhr</p>
            <p>Kaiserstraße 42, 76133 Karlsruhe</p>
        </body>
        </html>
        """
        events = extractor.extract(html)
        assert len(events) == 1
        # Should be from JSON-LD, not heuristic
        assert events[0].title == "JSON-LD Event"

    def test_page_without_event_data(self, extractor):
        """Generic page without event data → empty result."""
        html = """
        <html>
        <head><title>Impressum</title></head>
        <body>
            <h1>Impressum</h1>
            <p>Diese Website wird betrieben von der Stadt Karlsruhe.</p>
        </body>
        </html>
        """
        events = extractor.extract(html)
        assert events == []

    def test_page_with_only_title_no_date_no_address(self, extractor):
        """Page with a title but no date and no address → should NOT extract."""
        html = """
        <html>
        <body>
            <h1>Schöner Blogartikel</h1>
            <p>Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>
        </body>
        </html>
        """
        events = extractor.extract(html)
        assert events == []
