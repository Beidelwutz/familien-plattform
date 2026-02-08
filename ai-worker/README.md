# Kiezling AI Worker

AI-Service für das Kiezling-Projekt: Event-Klassifikation, Scoring und Tagesplan-Generierung für familienfreundliche Events. Crawlt RSS/ICS-Feeds, normalisiert Events zu Kandidaten, reichert optional mit KI an und liefert sie per Batch an das Backend.

---

## Inhaltsverzeichnis

- [Übersicht](#übersicht)
- [Architektur](#architektur)
- [Voraussetzungen & Installation](#voraussetzungen--installation)
- [Konfiguration](#konfiguration)
- [Starten](#starten)
- [API-Referenz](#api-referenz)
- [Workflows im Detail](#workflows-im-detail)
- [Queues & Jobs](#queues--jobs)
- [Datenmodelle](#datenmodelle)
- [Deployment](#deployment)
- [Entwicklung](#entwicklung)

---

## Übersicht

Der **AI Worker** hat zwei Rollen:

| Komponente | Beschreibung |
|------------|--------------|
| **HTTP-API (FastAPI)** | Endpoints für Health, Klassifikation, Scoring, Crawl-Trigger und Plan-Generierung. Wird mit `python -m src.main` gestartet. |
| **Background Worker** | Verarbeitet Jobs aus Redis (Crawl, Classify, Score). Muss **separat** mit `python -m src.queue.worker` gestartet werden. |

**Wichtig:** `start.bat` startet nur den API-Server. Für die Verarbeitung von Crawl-Jobs muss zusätzlich der Worker laufen (oder Redis ist aus – dann wird beim Trigger synchron im Hintergrund gecrawlt).

---

## Architektur

```
                    ┌─────────────────────────────────────────┐
                    │           AI Worker (dieser Service)     │
                    │  ┌─────────────┐    ┌─────────────────┐   │
  Backend/Frontend  │  │  FastAPI    │    │  Queue Worker   │   │
  ──────────────────┼─►│  /health    │    │  (Redis Jobs)   │   │
                    │  │  /classify  │    │  - crawl        │   │
                    │  │  /crawl     │    │  - classify     │   │
                    │  │  /plan      │    │  - score        │   │
                    │  └──────┬──────┘    └────────┬────────┘   │
                    │         │                    │            │
                    │         │                    │ process_   │
                    │         │                    │ crawl_job  │
                    │         ▼                    ▼            │
                    │  ┌─────────────────────────────────────┐  │
                    │  │  Crawler (RSS/ICS) → Dedupe →       │  │
                    │  │  Candidates → [AI] → Batch Ingest   │  │
                    │  └──────────────────────┬──────────────┘  │
                    └─────────────────────────┼─────────────────┘
                                              │ POST /api/events/ingest/batch
                                              ▼
                                    ┌─────────────────┐
                                    │     Backend      │
                                    │  Dedupe, Merge,  │
                                    │  Persistenz      │
                                    └─────────────────┘
```

- **Worker-Pipeline (Crawl):** Feed parsen → In-Run-Dedupe → optional Deep-Fetch → zu `CanonicalCandidate` → optional AI (Classify + Score) → Batch-POST an Backend.
- **Backend** übernimmt finale Dedupe, Merge mit bestehenden Events und Speicherung.

---

## Voraussetzungen & Installation

- **Python 3.11+**
- **Redis** (optional): für Queue; ohne Redis läuft Crawl-Trigger synchron im Hintergrund.
- **Backend** erreichbar unter `BACKEND_URL` (für Batch-Ingest und optional Health-Check).

```bash
cd ai-worker
python -m venv .venv
.venv\Scripts\activate   # Windows
# source .venv/bin/activate  # Linux/macOS
pip install -r requirements.txt
cp .env.example .env
# .env anpassen (siehe Konfiguration)
```

---

## Konfiguration

Alle Einstellungen über Umgebungsvariablen bzw. `.env`. Wichtige Werte:

| Variable | Beschreibung | Standard |
|----------|--------------|----------|
| `PORT` | Server-Port | `5000` |
| `REDIS_URL` | Redis für Job-Queue | `redis://localhost:6379` |
| `BACKEND_URL` | Backend-API (Batch-Ingest, Health) | `http://localhost:4000` |
| `SERVICE_TOKEN` | Service-zu-Service-Auth (Bearer) | leer |
| `OPENAI_API_KEY` | OpenAI (Klassifikation/Scoring/Plan) | leer |
| `ANTHROPIC_API_KEY` | Optional, Alternative/Backup | leer |
| `ENABLE_AI` | Globaler AI-Kill-Switch | `true` |
| `AI_LOW_COST_MODE` | Günstigere Modelle (z. B. gpt-4o-mini) | `false` |
| `AI_DAILY_LIMIT_USD` | Tages-Budget für AI (USD) | `10.0` |
| `AI_MONTHLY_LIMIT_USD` | Monats-Budget (USD) | `200.0` |
| `LOG_FORMAT` | `json` oder `text` | `json` |
| `CORS_ORIGINS` | Komma-getrennte erlaubte Origins | `http://localhost:3000,http://localhost:4000` |
| `MAX_CONCURRENT_PER_DOMAIN` | Max parallele Requests pro Domain (Crawl) | `2` |
| `CRAWL_LOCK_TTL_SECONDS` | Lock-Dauer pro Source (kein doppelter Crawl) | `600` |

Vollständige Liste und Railway-Hinweise siehe `.env.example`.

---

## Starten

### Nur API-Server (HTTP-Endpoints)

```bash
python -m src.main
# oder unter Windows:
start.bat
```

- Server läuft auf `http://0.0.0.0:5000`.
- Keine Job-Verarbeitung aus Redis.

### Nur Background-Worker (Queue-Jobs)

```bash
python -m src.queue.worker
```

- Verbindet sich mit Redis, verarbeitet `queue:crawl`, `queue:classify`, `queue:score`.
- Kein HTTP-Server.

### API-Server + Worker (Produktion)

Zwei Prozesse starten, z. B.:

- Prozess 1: `python -m src.main`
- Prozess 2: `python -m src.queue.worker`

Oder zwei getrennte Services/Container (z. B. Railway/ Docker).

---

## API-Referenz

Basis-URL: `http://localhost:5000` (oder `PORT` aus `.env`).

### Root & Health

| Method | Pfad | Beschreibung |
|--------|------|--------------|
| `GET` | `/` | Service-Info (Name, Version, Status). |
| `GET` | `/health/` | Einfacher Health-Check; liefert `status: ok`. |
| `GET` | `/health/ready` | Readiness inkl. Redis, Backend, optional OpenAI; `status`: `ok` oder `degraded`. |

### Classification (`/classify`)

| Method | Pfad | Beschreibung |
|--------|------|--------------|
| `POST` | `/classify/event` | Ein Event klassifizieren. Body: `EventInput` (title, description, location_address, price_min/max, is_indoor, is_outdoor). Zuerst Regel-Filter, bei Unklarheit AI. Response: `ClassificationResult` (is_relevant, categories, age_min/max, is_indoor/outdoor, confidence, used_ai, ai_summary_*, extracted_*_datetime/address, etc.). |
| `POST` | `/classify/score` | Ein Event bewerten. Body: `EventInput`. Response: `ScoringResult` (relevance_score, quality_score, family_fit_score, stressfree_score, confidence, reasoning). |
| `POST` | `/classify/batch` | Mehrere Events klassifizieren. Body: Array von `EventInput`. Response: `{ total, successful, results }` (pro Event success/data oder success/error). |

### Crawl (`/crawl`)

| Method | Pfad | Beschreibung |
|--------|------|--------------|
| `POST` | `/crawl/trigger` | Crawl für eine Quelle auslösen. Body: `CrawlRequest` (source_id, source_url optional, source_type `rss`\|`ics`, force, enable_ai, fetch_event_pages, ingest_run_id). Job wird in Redis eingereiht (oder bei Redis-Ausfall: synchron im Hintergrund). Response: job_id, source_id, status, message. |
| `POST` | `/crawl/single-event` | **Einzelne Event-Detailseite** crawlen. Body: `url`, `fields_needed`, `use_ai`, optional `detail_page_config` (Quell-spezifische CSS-Selektoren), `source_id`. 4-Stufen-Pipeline: Custom Selectors → Structured Data (JSON-LD/Microdata) → Heuristik → AI-Fallback. Response: `fields_found`, `fields_missing`, `field_provenance`, `suggested_selectors`. Vor dem Abruf: SSRF-Guard (private IPs blockiert, max. Response-Größe). Siehe [docs/DETAIL_PAGE_CRAWL.md](../docs/DETAIL_PAGE_CRAWL.md). |
| `GET` | `/crawl/status/{job_id}` | Status eines Crawl-Jobs. Response: job_id, source_id, status, started_at, finished_at, events_found, events_new, error. |
| `GET` | `/crawl/queue-stats` | Queue-Längen (z. B. crawl). |
| `POST` | `/crawl/process-feed` | Feed-URL direkt parsen (Query: feed_url, source_type=rss\|ics). Kein Speichern, nur Test; liefert Anzahl Events und Preview der ersten 10. |

### Plan (`/plan`)

| Method | Pfad | Beschreibung |
|--------|------|--------------|
| `POST` | `/plan/generate` | Tagesplan für Familien generieren. Body: children_ages, date, budget, lat, lng, preferences. Response: date, children_ages, budget, estimated_cost, main_plan (TimeSlots), plan_b (Wetter-Alternative), tips, generated_at. |
| `POST` | `/plan/optimize` | Events für einen Tag auswählen/optimieren (Scores, Distanz, Budget, Kategorie-Vielfalt). Body: events, children_ages, date, budget, preferences, user_location. Response: selected_events, plan_b_events, reasoning. |
| `POST` | `/plan/optimize-route` | Reihenfolge/Route zwischen Slots (einfache Heuristik). Body: slots, start_location. Response: optimized_order, total_travel_time_minutes. |

### Metrics (`/metrics`)

| Method | Pfad | Beschreibung |
|--------|------|--------------|
| `GET` | `/metrics` | Queue-Tiefen (crawl, classify, score, geocode), DLQ-Anzahl, Budget-Status (can_proceed, low_cost_mode, message), optional AI-Kosten-Infos. |

---

## Workflows im Detail

### Crawl-Pipeline (process_crawl_job)

Wird ausgeführt, wenn ein Crawl-Job aus der Queue geholt wird (oder bei Sync-Fallback nach `/crawl/trigger`).

1. **Input:** `payload` mit source_id, source_url, source_type (`rss`\|`ics`), enable_ai, fetch_event_pages, optional ingest_run_id.
2. **Feed parsen:** `FeedParser.parse_rss(source_url)` oder `parse_ics(source_url)` → Liste `ParsedEvent`.
3. **In-Run-Dedupe:** Duplikate innerhalb dieses Laufes entfernen → `unique_events`.
4. **Optional – Deep-Fetch (nur RSS, wenn fetch_event_pages=True):** Detailseiten abrufen, fehlende Felder (Ort, Endzeit, Bild, ggf. Preis) anreichern; max. 50 Fetches pro Lauf, konfigurierbar (min_delay, max_concurrent).
5. **Zu Kandidaten:** Jedes `ParsedEvent` → `CanonicalCandidate` (source_type, source_url, fingerprint, raw_hash, extracted_at, data = `CandidateData`, external_id, ai = None, versions).
6. **Optional – AI-Anreicherung (wenn enable_ai=True):** Pro Kandidat: `EventClassifier.classify()` + `EventScorer.score()`; Ergebnis als `AISuggestions` (classification + scores, geocode optional) am Kandidaten. Backend entscheidet später über Übernahme.
7. **Batch an Backend:** `POST {BACKEND_URL}/api/events/ingest/batch` mit `IngestBatchRequest` (run_id, source_id, candidates). Backend antwortet mit summary (created, updated, unchanged, ignored).
8. **IngestRun-Update (wenn ingest_run_id gesetzt):** Vorher „running“ + events_found; bei Erfolg/Fehler finaler Status (success/failed) und Zähler.

**Rückgabe:** Dict mit source_id, events_found, events_unique, duplicates_in_run, events_created, events_updated, events_unchanged, events_ignored, run_id.

### Classify-Workflow (einzelnes Event)

- **POST /classify/event:**  
  1. `RuleBasedFilter.check(event)` – wenn Regel entscheidet → sofort Antwort (is_relevant, rule_matched, suggested_categories, used_ai=False).  
  2. Sonst `EventClassifier.classify(event)` (AI) → ClassificationResult mit categories, age_min/max, is_indoor/outdoor, confidence, ai_summary_*, extracted_*_datetime/address, etc.

### Plan-Workflow

- **generate:** `PlanGenerator.generate(children_ages, target_date, budget, lat, lng, preferences)` nutzt AI und ggf. Wetter-API, liefert Hauptplan + Plan B (Schlechtwetter) und Tipps.
- **optimize:** Heuristik auf Event-Liste (Scores, Distanz, Budget, Alterspassung, Kategorie-Vielfalt); wählt bis zu 3 Events für Hauptplan und bis zu 3 Indoor-Events für Plan B.
- **optimize-route:** Einfache Reihenfolgen-Optimierung; Hinweis im Code auf mögliche Google-Maps-Anbindung.

---

## Queues & Jobs

Redis-Queues (Key-Prefix siehe `job_queue.py`):

| Queue | Job-Typ | Handler | Beschreibung |
|-------|---------|--------|--------------|
| `queue:crawl` | crawl | process_crawl_job | Feed crawlen, Kandidaten erzeugen, optional AI, Batch an Backend. |
| `queue:classify` | classify | process_classify_job | Ein Event klassifizieren (AI). |
| `queue:score` | score | process_score_job | Ein Event bewerten (AI). |
| `queue:geocode` | geocode | (optional) | Geocoding-Jobs. |
| `queue:dlq` | – | – | Dead Letter Queue nach ausgeschöpften Retries. |

Eigenschaften der Queue (aus `job_queue.py`):

- Priorität über Redis Sorted Sets.
- Retry mit exponentiellem Backoff + Jitter (pro Job-Typ konfigurierbar).
- Idempotency Keys (z. B. crawl: source_id + Datum; classify/score: event_id).
- Visibility-Timeout, Budget-Check für AI-Jobs (daily/monthly limit).
- Distributed Lock pro Source für Crawl (`CRAWL_LOCK_TTL_SECONDS`).
- Domain-Concurrency (`MAX_CONCURRENT_PER_DOMAIN`).

---

## Datenmodelle

### CanonicalCandidate (Batch-Ingest)

- **source_type**, **source_url**, **fingerprint**, **raw_hash**, **extracted_at**, **external_id**, **versions**.
- **data:** `CandidateData` (title, description, start_at, end_at, venue_name, address, city, lat/lng, price_min/max, age_min/max, categories, is_indoor/outdoor, images, booking_url, …).
- **ai:** optional `AISuggestions` mit classification (`AIClassification`), scores (`AIScores`), geocode (`AIGeocode`).

### AIClassification / AIScores

- Classification: categories, age_min/max, age_recommendation_text, sibling_friendly, is_indoor/outdoor, language, complexity_level, noise_level, has_seating, typical_wait_minutes, food_drink_allowed, extracted_*_datetime/address/district, confidence, model, prompt_version.
- Scores: relevance, quality, family_fit, stressfree, confidence, model.

Backend erhält `IngestBatchRequest` (run_id, source_id, candidates als Liste serialisierter CanonicalCandidates) und übernimmt Dedupe, Merge und Persistenz.

---

## Deployment

- **Railway:** Siehe Kommentare in `.env.example` (DEBUG, LOG_FORMAT, BACKEND_URL, SERVICE_TOKEN, CORS_ORIGINS, AI-Keys, optional REDIS_URL). Zwei Services empfohlen: einer für `src.main`, einer für `src.queue.worker`.
- **Docker:** `Dockerfile` im Repo; typisch ein Image, zwei Start-Commands (API vs. Worker).
- **Umgebung:** `DEBUG=false`, `LOG_FORMAT=json`, `SERVICE_TOKEN` und `BACKEND_URL` für Produktion setzen.

---

## Entwicklung

- **Tests:** `pytest` (inkl. pytest-asyncio).
- **Linting:** `ruff`.
- **Struktur:**  
  - `src/main.py` – FastAPI-App, Router.  
  - `src/routes/` – health, classify, crawl, plan, metrics.  
  - `src/queue/` – job_queue (Redis), worker (process_crawl_job, process_classify_job, process_score_job).  
  - `src/crawlers/` – feed_parser, rss_deep_fetch, **custom_selector_extractor** (Detail-Page-Selektoren + SelectorSuggester), **heuristic_extractor** (Datums-/Adress-/Preis-Heuristik), **ssrf_guard** (URL-Validierung vor Fetch), structured_data (JSON-LD/Microdata).  
  - `src/classifiers/`, `src/scorers/`, `src/planner/` – AI-Logik.  
  - `src/ingestion/` – in_run_dedupe, normalizer.  
  - `src/models/candidate.py` – CanonicalCandidate, CandidateData, AISuggestions, IngestBatchRequest.

---

*Stand: Codebasis ai-worker (main.py, worker.py, routes, queue, models).*
