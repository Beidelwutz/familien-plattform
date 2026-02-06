# AI Worker – Funktions- und Unterfunktionen-Checkliste

Stand: Code-Analyse (Laufzeittests erfordern Python/Umgebung).  
**Legende:** ✅ vermutlich OK (Code konsistent) | ⚠️ Bedingt / Konfiguration nötig | ❌ Fehler/Defizit erkannt | 🔲 Laufzeittest nötig

---

## 1. Einstieg & Routing (main.py)

| # | Funktion | Beschreibung | Status |
|---|----------|--------------|--------|
| 1.1 | `GET /` | Root – Service-Name, Version, status | ✅ |
| 1.2 | CORS-Middleware | Origins aus `cors_origins` (Env) | ✅ |
| 1.3 | Router: `/health` | Health-Checks | ✅ |
| 1.4 | Router: `/classify` | Klassifikation & Scoring | ✅ |
| 1.5 | Router: `/plan` | Plan-Generierung & Optimize | ✅ |
| 1.6 | Router: `/crawl` | Crawl-Trigger & Status | ✅ |
| 1.7 | Router: `/metrics` | Metriken & Health-Summary | ✅ |

---

## 2. Health (`/health`)

| # | Funktion | Unterfunktion | Status |
|---|----------|----------------|--------|
| 2.1 | `GET /health/` | Basis-Health (immer ok wenn Service läuft) | ✅ |
| 2.2 | `GET /health/ready` | Readiness inkl. Abhängigkeiten | ⚠️ |
| 2.2.1 | | `_check_redis()` – Redis Ping | 🔲 Redis-URL nötig |
| 2.2.2 | | `_check_backend()` – GET backend_url/api/health | 🔲 Backend-URL nötig |
| 2.2.3 | | `_check_openai()` – nur wenn openai_api_key gesetzt | 🔲 Optional |

**Backend nutzt:** `GET /health` (Admin-Health-Proxy), `GET /health/ready`, `GET /metrics/health-summary` für Dashboard.

---

## 3. Classify (`/classify`)

| # | Funktion | Unterfunktion | Status |
|---|----------|----------------|--------|
| 3.1 | `POST /classify/event` | Event klassifizieren (Familientauglichkeit) | ⚠️ |
| 3.1.1 | | Rule-Based Pre-Filter (`RuleBasedFilter.check`) | ✅ |
| 3.1.2 | | Bei Regel-Entscheidung: sofort zurück, kein AI | ✅ |
| 3.1.3 | | Sonst: `EventClassifier.classify()` (AI) | 🔲 OpenAI/Anthropic-Key nötig |
| 3.1.4 | | PII-Redaktion, Schema-Validierung, Retry/Eskalation (im Classifier) | ✅ |
| 3.2 | `POST /classify/score` | Event bewerten (Scores 0–100) | ⚠️ |
| 3.2.1 | | `EventScorer.score()` – relevance, quality, family_fit, stressfree | 🔲 API-Key nötig |
| 3.2.2 | | Fallback: `_default_scoring` wenn kein Key / AI aus | ✅ |
| 3.3 | `POST /classify/batch` | Mehrere Events nacheinander klassifizieren | ✅ (ruft 3.1 pro Event) |

**Backend nutzt:**  
- `POST /classify/event` und `POST /classify/score` in `process-pending-ai` (Batch-KI)  
- `POST /classify/event` und `POST /classify/score` im Cron `process-pending-ai` (sources.ts)

**Mögliche Fehlerquellen:**  
- Fehlender `OPENAI_API_KEY` oder `ANTHROPIC_API_KEY` → Classify/Score schlagen fehl oder nutzen Default.  
- `enable_ai: false` → Scorer nutzt Default, Classifier könnte trotzdem AI erwarten (Rule-Filter liefert oft None → AI-Pfad).

---

## 4. Crawl (`/crawl`)

| # | Funktion | Unterfunktion | Status |
|---|----------|----------------|--------|
| 4.1 | `POST /crawl/trigger` | Crawl-Job auslösen | ⚠️ |
| 4.1.1 | | Job in Redis-Queue einreihen (QUEUE_CRAWL) | 🔲 Redis nötig |
| 4.1.2 | | Fallback: Sync in BackgroundTasks (`run_crawl_sync`) | ✅ |
| 4.2 | `GET /crawl/status/{job_id}` | Job-Status abfragen | 🔲 Redis für echte Statusdaten |
| 4.3 | `GET /crawl/queue-stats` | Queue-Länge (crawl) | 🔲 Redis |
| 4.4 | `POST /crawl/process-feed` | Feed-URL direkt parsen (RSS/ICS), nur Vorschau | ✅ (kein Redis nötig) |

**Worker-Pipeline (bei Sync/Queue):**  
`process_crawl_job` → FeedParser → ggf. Deep-Fetch → Normalizer → In-Run-Dedupe → ggf. AI (Classifier+Scorer) → Batch an Backend `POST /api/sources/ingest/batch`.

**Mögliche Fehlerquellen:**  
- Redis nicht erreichbar: Trigger funktioniert mit Sync-Fallback, aber Status/Queue-Stats unzuverlässig.  
- Backend-URL/Service-Token falsch: Ingest-Batch schlägt fehl.  
- Feed-Parser/Deep-Fetch: Fehler bei kaputten Feeds oder Timeouts.

---

## 5. Plan (`/plan`)

| # | Funktion | Unterfunktion | Status |
|---|----------|----------------|--------|
| 5.1 | `POST /plan/generate` | Vollständigen Tagesplan mit AI erzeugen | 🔲 API-Key + Events nötig |
| 5.1.1 | | `PlanGenerator.generate()` – Wetter, AI-Slots, Plan B | ✅ Code |
| 5.2 | `POST /plan/optimize` | Events für einen Tag auswählen (Scores, Budget, Diversität) | ✅ (rein heuristisch, kein LLM) |
| 5.2.1 | | Scoring aus event.scores (family_fit, stressfree, quality) | ✅ |
| 5.2.2 | | Distanz, Preis, Alterspassung, Kategorie-Diversität | ✅ |
| 5.2.3 | | Plan B = Indoor-Alternativen | ✅ |
| 5.3 | `POST /plan/optimize-route` | Reihenfolge/Routen-Optimierung | ✅ (Platzhalter: Nearest-Neighbor, keine echte Routing-API) |

**Backend nutzt:** `POST /plan/optimize` (backend/src/routes/plan.ts) für KI-Planer.

---

## 6. Metrics (`/metrics`)

| # | Funktion | Unterfunktion | Status |
|---|----------|----------------|--------|
| 6.1 | `GET /metrics` | Queue-Tiefen, DLQ, Budget, Usage (7d) | 🔲 Redis + Cost-Tracker |
| 6.2 | `GET /metrics/prometheus` | Prometheus-Format | 🔲 |
| 6.3 | `GET /metrics/health-summary` | Kurz-Status (redis, dlq, budget, ai_enabled) | 🔲 |

**Hinweis:** Routes sind unter Prefix `/metrics` registriert; Aufruf vom Backend: `GET {AI_WORKER_URL}/metrics/health-summary` (laut admin.ts).

---

## 7. Abhängigkeiten (Module)

| Modul | Verwendung | Status |
|-------|------------|--------|
| **config** | Settings (Env), get_settings() | ✅ |
| **classifiers.event_classifier** | EventClassifier, ClassificationResult | ✅ |
| **scorers.event_scorer** | EventScorer, ScoringResult (inkl. fun_score intern) | ✅ |
| **rules.rule_filter** | RuleBasedFilter – Vorfilter vor AI | ✅ |
| **queue.job_queue** | Redis-Queues, enqueue, get_status, get_queue_length | 🔲 Redis |
| **queue.worker** | process_crawl_job, enrich_with_ai, Batch-Ingest an Backend | 🔲 |
| **crawlers.feed_parser** | RSS/ICS parsen | ✅ |
| **crawlers.rss_deep_fetch** | Optional Deep-Fetch | ✅ |
| **planner.plan_generator** | generate(), Wetter, AI-Pläne | 🔲 API-Key |
| **monitoring.ai_cost_tracker** | Budget, Usage | ✅ |
| **lib.pii_redactor** | PII vor AI | ✅ |
| **lib.schema_validator** | validate_classification, validate_scoring, validate_plan | ✅ |

---

## 8. Backend-Integration (Überblick)

| Backend-Endpoint | Ruft AI-Worker auf | Status |
|------------------|--------------------|--------|
| POST /api/admin/process-pending-ai | POST /classify/event, POST /classify/score | 🔲 AI_WORKER_URL + API-Keys |
| POST /api/sources/cron/process-pending-ai | POST /classify/event, POST /classify/score | 🔲 |
| GET /api/admin/ai-worker/health | GET /health | 🔲 |
| GET /api/admin/ai-worker/health/detailed | GET /health, /health/ready, /metrics/health-summary | 🔲 |
| GET /api/admin/ai-worker/stats | (eigene DB/Redis, nicht Worker) | – |
| GET /api/admin/ai-worker/queue-stats | GET /crawl/queue-stats | 🔲 |
| Crawl-Trigger (Sources) | POST /crawl/trigger | 🔲 |
| POST /api/plan/generate (mit use_ai) | POST /plan/optimize | 🔲 |

---

## 9. Bekannte Risiken / „Funktioniert nicht“

1. **Kein API-Key:**  
   - Classify/Score: Ohne `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` nutzt nur der Scorer Defaults; der Classifier hat keinen Fallback und wirft ggf. oder nutzt leere Keys → **500 oder leere/ungenügende Werte**.  
   - Plan Generate: Braucht AI → ohne Key fehleranfällig.

2. **AI_WORKER_URL in Produktion:**  
   - Backend (Vercel) muss `AI_WORKER_URL` auf die laufende Worker-Instanz setzen (z. B. Railway).  
   - Fehlt oder ist falsch → alle Aufrufe (Classify, Score, Health, Crawl, Plan) schlagen fehl.

3. **Redis:**  
   - Crawl-Trigger: Mit Redis Queue + Worker; ohne Redis nur Sync-Fallback (Status/Queue-Stats dann nicht aussagekräftig).  
   - Backend: Eigenes Redis für AI-Job-Status (ai_jobs); unabhängig vom Worker-Redis.

4. **Crawl/Ingest:**  
   - Worker sendet Batch an Backend `POST /api/sources/ingest/batch` mit SERVICE_TOKEN.  
   - Falscher backend_url oder falscher Service-Token → Events kommen nicht in die DB → keine pending_ai.

5. **Port/Konfiguration:**  
   - main.py: Port aus settings (default 5000). start.bat muss dieselbe Umgebung/Port nutzen.

---

## 10. Empfohlene Laufzeittests (zum Abhaken)

- [ ] `GET http://localhost:5000/` → 200, status running  
- [ ] `GET http://localhost:5000/health/` → 200, status ok  
- [ ] `GET http://localhost:5000/health/ready` → 200, checks redis/backend/openai  
- [ ] `POST http://localhost:5000/classify/event` mit minimalem JSON (title, description) → 200 + categories/confidence  
- [ ] `POST http://localhost:5000/classify/score` mit minimalem JSON → 200 + family_fit_score etc.  
- [ ] `POST http://localhost:5000/crawl/trigger` (source_id, source_type) → 200 + job_id  
- [ ] `GET http://localhost:5000/crawl/status/{job_id}` → 200 + status  
- [ ] `POST http://localhost:5000/plan/optimize` mit events=[], children_ages, date, budget → 200 + selected_events  
- [ ] `GET http://localhost:5000/metrics/health-summary` → 200 + status/indicators  

Wenn du willst, kann als Nächstes eine konkrete Fehlerquelle (z. B. „Classify liefert 500“ oder „Crawl startet nicht“) mit dir Schritt für Schritt eingegrenzt werden.
