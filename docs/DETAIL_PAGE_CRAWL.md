# Detail-Page Crawl-Regeln pro Quelle

**Stand:** Implementierung ab Plan „Detail-Page Crawl-Regeln pro Quelle“.  
Diese Funktion ermöglicht es, pro **Quelle (Source)** festzulegen, wie Event-**Detail-Seiten** gecrawlt werden – z. B. welche CSS-Selektoren für Titel, Datum, Ort oder Bild verwendet werden. Der AI-Worker wendet diese Regeln beim Single-Event-Crawl an und fällt nur bei fehlenden Feldern auf strukturierte Daten, Heuristik und AI zurück.

---

## Kurzüberblick

| Komponente | Rolle |
|------------|--------|
| **Source.detail_page_config** | JSON-Feld in der DB: Selektoren, Datumsformate, Notizen pro Quelle |
| **Backend** | PATCH/PUT `/api/sources/:id` mit `detail_page_config` und optional `detail_page_config_mode: "replace" \| "merge"`; per-Feld-Deep-Merge |
| **Trigger-AI / Bulk-Crawl** | Backend wählt die passende Source per **URL-Domain-Match** (nicht blind `event_sources[0]`) und sendet `detail_page_config` an den AI-Worker |
| **AI-Worker** | 4-Stufen-Pipeline: Custom Selectors → Structured Data (JSON-LD/Microdata) → Heuristik → AI-Fallback; SSRF-Guard vor jedem Fetch; optional `suggested_selectors` |
| **Admin-UI** | Quellen bearbeiten → Accordion „Detail-Seiten Selektoren“: pro Feld CSS + attr; Test-URL + „Selektoren testen“; Ampel (Ready/Partial/Broken); Vorschläge übernehmen |

---

## Datenmodell

### `Source.detail_page_config` (JSON, optional)

Beispiel:

```json
{
  "selectors": {
    "title":            { "css": ["h1.event-title", "h1"], "attr": "text" },
    "start_datetime":   { "css": ["time.event-start", ".date"], "attr": "datetime" },
    "location_address": { "css": [".venue-address", ".address"], "attr": "text" },
    "image":            { "css": [".event-hero img"], "attr": "src" }
  },
  "parsing": {
    "timezone": "Europe/Berlin",
    "date_formats": ["DD.MM.YYYY HH:mm", "DD.MM.YYYY", "YYYY-MM-DDTHH:mm"]
  },
  "notes": "Freitext für Admin"
}
```

- **selectors**: Pro Feld (`title`, `description`, `start_datetime`, `end_datetime`, `location_name`, `location_address`, `image`, `price`, `organizer`) optional `css` (Array von Fallback-Selektoren) und `attr`.
- **attr** ist strikt eine der Werte: `text`, `datetime`, `src`, `href`, `content` (überall im System identisch, keine Aliase wie „dtime“).
- **parsing.date_formats**: Optionale Liste von Format-Strings für die Datumsparsing im Custom-Selector-Schritt.

---

## Backend

### PATCH/PUT `/api/sources/:id`

- Body kann `detail_page_config` (Objekt oder `null`) enthalten.
- Optional: `detail_page_config_mode: "replace" | "merge"` (Default: `"merge"`).
- **Merge-Regel:** Pro Selektor-Feld wird nur dieses Feld gemergt; innerhalb eines Feldes ersetzen `css`/`attr` aus dem Request nur dann die bestehenden Werte, wenn sie gesendet werden. `parsing` und `notes` werden ebenfalls feldweise übernommen.
- Validierung: `attr` muss aus der Enum sein; `css` muss ein Array nicht-leerer Strings sein.

### Trigger-AI und Bulk-Crawl

An **drei Stellen** (z. B. in `admin.ts`):

1. Beim Einzel-Event „Trigger AI“ (`POST /api/admin/events/:id/trigger-ai`),
2. Beim „Process Pending AI“ mit `forceCrawlFirst`,
3. Bei der Bulk-Aktion „Crawl“

wird die **zur Crawl-URL passende Source** ermittelt:

- Domain der zu crawlenden URL (z. B. `booking_url` oder `source_url`) wird mit den `Source.url`-Domains der Event-Sources abgeglichen.
- Die so gefundene Source liefert `detail_page_config` und `source_id`; falls kein Match, Fallback auf die erste Event-Source.

Der Aufruf an den AI-Worker enthält:

- `url`, `fields_needed`, `detail_page_config`, `source_id`.

### Test-Selectors

- **POST /api/admin/test-selectors** (Admin): Body `{ "url", "detail_page_config" }`. Ruft den AI-Worker `POST /crawl/single-event` auf und gibt die Antwort (inkl. `fields_found`, `field_provenance`, `suggested_selectors`) zurück. Wird vom Frontend „Selektoren testen“ verwendet.

---

## AI-Worker

### Endpoint: POST `/crawl/single-event`

- **Request:** `url`, `fields_needed`, `use_ai`, **`detail_page_config`**, **`source_id`**.
- **Response:** `success`, `fields_found`, `fields_missing`, `extraction_method`, `error`, **`field_provenance`**, **`suggested_selectors`**.

### Pipeline (4 Stufen)

1. **Custom Selectors** – Wenn `detail_page_config.selectors` vorhanden: `CustomSelectorExtractor` wendet die CSS/attr-Regeln an; Datumsfelder werden mit `parsing.date_formats` geparst. Nicht parsebar = Feld gilt als fehlend.
2. **Structured Data** – JSON-LD / Microdata (wie bisher), nur für noch fehlende Felder.
3. **Heuristik** – `heuristic_extractor.py`: deutsche Datums-/Adress-/Preis-Muster, erweiterte Ort-Labels (Adresse, Treffpunkt, dl/dt/dd, Tabelle, aria-label).
4. **AI-Fallback** – Für verbleibende Felder; danach wird heuristisch ein **SelectorSuggester** ausgeführt, der `suggested_selectors` im Format `{ "field": { "css": ["..."], "attr": "text" } }` erzeugt.

**Merge-Regel:** Frühere Stufe gewinnt pro Feld. `fields_found` und `field_provenance` haben dasselbe Key-Set; `fields_missing = fields_needed \ fields_found.keys()`.

### Sicherheit (SSRF)

- Vor jedem Abruf einer URL: **`ssrf_guard.validate_url_safe(url)`** (in `ai-worker/src/crawlers/ssrf_guard.py`). Blockiert private IP-Bereiche, nur Scheme `http`/`https`, DNS-Auflösung gegen blockierte Netze. Zusätzlich: maximale Response-Größe (z. B. 5 MB), Timeout, fester User-Agent.

### Neue/angepasste Module

- **custom_selector_extractor.py**: `CustomSelectorExtractor`, `SelectorSuggester`, `ExtractionResult`, `AttrType`-Enum.
- **heuristic_extractor.py**: Heuristik aus strukturiertem Text (Datumsformate, Adressen, Ort-Labels, Preis).
- **ssrf_guard.py**: URL-Validierung gegen SSRF.
- **structured_data.py**: Heuristik aus `extract()` entfernt (wird nur noch von der Pipeline separat aufgerufen); optional `include_heuristic=True` für bestehende Caller (z. B. Deep-Fetch, Base-Scraper).

---

## Admin-UI (Quellen-Seite)

- Im **Edit-Modal** einer Quelle: Accordion **„Detail-Seiten Selektoren“**.
- Pro Feld: Label, CSS-Eingabe (komma-getrennt = Fallback-Reihenfolge), Dropdown **attr** (nur die Enum-Werte), optional Badge „Vorschlag“ (übernimmt AI-Vorschlag).
- Zusätzlich: Datumsformate, Notizen; **Test-URL** (Default: Quell-URL) und Button **„Selektoren testen“**.
- Nach Test: Vorschau der gefundenen Felder mit Provenance; **Ampel** für Pflichtfelder (title, start_datetime, mind. ein Ort): Ready (grün) / Partial (gelb) / Broken (rot).
- Wenn der Crawl **suggested_selectors** zurückgibt: Banner „AI-Selektor-Vorschläge“ mit „Alle übernehmen“; pro Feld Badge zum Übernehmen.
- Beim **Speichern** wird `detail_page_config` aus den Eingaben gebaut und per PATCH mit `detail_page_config_mode: "replace"` gesendet.

---

## Nachvollziehen / Debugging

- **Wo wird die Config gespeichert?** → `Source.detail_page_config` (Prisma, Feld in `schema.prisma`).
- **Wo wird sie beim Crawl verwendet?** → Backend ermittelt die Source per URL-Domain-Match und übergibt `detail_page_config` an `POST /crawl/single-event`; der AI-Worker wendet sie in Stufe 1 der Pipeline an.
- **Warum trifft die „richtige“ Source?** → Backend vergleicht die Domain der zu crawlenden URL mit `Source.url` aller dem Event zugeordneten Quellen; kein blindes `event_sources[0]`.
- **Wo ist die Ampel-Logik?** → Frontend: Nach „Selektoren testen“ werden Pflichtfelder (title, start_datetime, location_name oder location_address) ausgewertet; alle drei = Ready, sonst Partial/Broken.
- **Wo kommt SSRF ins Spiel?** → AI-Worker vor jedem `httpx.get` in `crawl_single_event`: `validate_url_safe(url)`; gleiche Prüfung sollte für jeden Aufruf mit Benutzer-URL (z. B. Test-Button) gelten.

---

## Siehe auch

- Plan-Datei (falls im Repo): `detail-page_crawl_regeln_*.plan.md`
- Backend: `backend/src/routes/sources.ts` (Merge, Validierung), `backend/src/routes/admin.ts` (trigger-ai, test-selectors, bulk crawl).
- AI-Worker: `ai-worker/src/routes/crawl.py` (Pipeline), `ai-worker/src/crawlers/custom_selector_extractor.py`, `heuristic_extractor.py`, `ssrf_guard.py`.
- Frontend: `frontend/src/pages/admin/sources.astro` (Accordion, Test, Vorschläge).
