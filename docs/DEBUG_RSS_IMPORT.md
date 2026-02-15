# Fehlersuche: RSS-Import (Karlsruhe Veranstaltungen)

Wenn beim Fetch der Karlsruhe-RSS-Quelle unter **Admin → Quellen** viele Events gefunden werden (z. B. 320), aber der Import „lädt ewig“ oder keine Events in der DB landen, helfen die folgenden Schritte.

## Voraussetzungen

- Backend und AI-Worker laufen (z. B. Backend: `npm run dev`, Worker: `python -m src.main` in `ai-worker/`).
- Ein Fetch wurde über **Admin → Quellen** für die RSS-Quelle (Karlsruhe) ausgelöst.

## Wo die Debug-Logs liegen

### 1. Backend (Batch-Ingest)

- **Pfad:** Keine Datei – Logs gehen per HTTP an den Debug-Server (nur lokal, schlägt im Live-Build still fehl).
- **Im Live-Build:** Backend-Logs in der Laufzeitumgebung prüfen (z. B. PM2, Docker, Server-Logs). Relevante Stellen: `events.ts:ingest/batch_start` und `events.ts:ingest/batch_after_processBatch` (falls dort weitere Log-Ausgaben ergänzt wurden).

### 2. AI-Worker (RSS-Parse + Batch-Send)

- **Pfad (lokal):** `<Repo-Root>/.cursor/debug.log`  
  Beispiel Windows: `c:\02_Kiezling\.cursor\debug.log`  
  Beispiel Linux/Mac: `<Projektordner>/.cursor/debug.log`
- **Live-Build:**  
  - Entweder dasselbe Verzeichnis, wenn der Worker im Repo-Root läuft (z. B. `ai-worker/` als Unterordner).  
  - Oder expliziter Pfad per Umgebungsvariable: **`DEBUG_LOG_PATH`** setzen (z. B. `/var/log/kiezling/debug.log` oder `C:\logs\kiezling-debug.log`), dann schreibt der Worker dorthin.

Log-Format: **NDJSON** (eine Zeile = ein JSON-Objekt) mit z. B. `location`, `message`, `data`, `hypothesisId`.

## Wichtige Log-Einträge (Hypothesen)

| hypothesisId | Bedeutung |
|--------------|-----------|
| H1 | Worker: Nach `events_found`, nach Deep-Fetch, ob überhaupt `send_batch_to_backend` erreicht wird |
| H2 | Batch-Requests: ob erste Batch-Anfrage vom Worker losgeht und ob Backend antwortet |
| H3 | Backend: ob IngestRun pro Batch überschrieben wird (z. B. nur 10 statt 320 „gefunden“) |
| H4 | Timeout/Langsamkeit beim ersten Batch-Request |
| H5 | Fehler in `processBatch` (Validierung/DB) |

Typische Stellen in `debug.log`:

- `worker.py:after_events_found` → Events gefunden, Run auf „running“ gesetzt
- `worker.py:after_deep_fetch` oder `worker.py:deep_fetch_error` → Deep-Fetch fertig oder abgebrochen
- `worker.py:before_send_batch` → Worker startet Versand an Backend
- `worker.py:first_batch_ok` → Erster Batch beim Backend angekommen und OK
- `worker.py:first_batch_error` → Erster Batch fehlgeschlagen (Timeout/4xx/5xx)

## Reproduktion (Live-Build)

1. Backend und AI-Worker starten.
2. **Admin → Quellen** öffnen.
3. Bei der Karlsruhe-RSS-Quelle auf **Jetzt abrufen** klicken.
4. 1–2 Minuten warten („320 gefunden“, ggf. ewig „läuft“).
5. **Worker:** `.cursor/debug.log` bzw. `DEBUG_LOG_PATH` auslesen.
6. **Backend:** Laufzeit-Logs auf Einträge zu `ingest/batch` prüfen.

## Optional: Log-Pfad im Live-Build setzen

Beim Start des AI-Workers:

```bash
# Linux/Mac
export DEBUG_LOG_PATH=/var/log/kiezling/debug.log
python -m src.main

# Windows (PowerShell)
$env:DEBUG_LOG_PATH = "C:\logs\kiezling-debug.log"
python -m src.main
```

So kann die Fehlersuche auch im Live-Build mit derselben Log-Datei durchgeführt werden.
