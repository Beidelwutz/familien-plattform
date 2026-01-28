# API Dokumentation

Vollständige Referenz aller Backend-API-Endpunkte.

## Basis-Information

- **Base URL:** `https://api.familien-lokal.de/api`
- **Format:** JSON
- **Authentifizierung:** JWT Bearer Token

## Authentifizierung

Die meisten Endpunkte erfordern einen gültigen JWT-Token im Authorization-Header:

```
Authorization: Bearer <token>
```

### Rollen

| Rolle | Beschreibung |
|-------|--------------|
| `parent` | Standard-Nutzer (Eltern) |
| `provider` | Anbieter (Events erstellen) |
| `admin` | Administrator (Vollzugriff) |

---

## Auth Endpoints

### POST /auth/register

Neuen Benutzer registrieren.

**Body:**
```json
{
  "email": "user@example.com",
  "password": "mindestens8zeichen"
}
```

**Response (201):**
```json
{
  "success": true,
  "message": "Registration successful",
  "data": {
    "user": { "id": "...", "email": "...", "role": "parent" },
    "token": "eyJhbG..."
  }
}
```

### POST /auth/login

Benutzer anmelden.

**Body:**
```json
{
  "email": "user@example.com",
  "password": "password123"
}
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "user": { "id": "...", "email": "...", "role": "parent" },
    "token": "eyJhbG..."
  }
}
```

### GET /auth/me

Aktuellen Benutzer abrufen. **Auth erforderlich.**

**Response (200):**
```json
{
  "success": true,
  "data": {
    "id": "...",
    "email": "user@example.com",
    "role": "parent",
    "created_at": "2026-01-27T..."
  }
}
```

### POST /auth/logout

Abmelden (Client entfernt Token).

---

## Events Endpoints

### GET /events

Events suchen mit Filtern.

**Query Parameter:**

| Parameter | Typ | Beschreibung |
|-----------|-----|--------------|
| `q` | string | Textsuche in Titel/Beschreibung |
| `lat` | float | Breitengrad für Geo-Suche |
| `lng` | float | Längengrad für Geo-Suche |
| `radius` | int | Radius in km (1-100, default: 20) |
| `dateFrom` | ISO8601 | Startdatum |
| `dateTo` | ISO8601 | Enddatum |
| `ageMin` | int | Minimales Alter |
| `ageMax` | int | Maximales Alter |
| `priceMax` | float | Maximaler Preis |
| `categories` | string | Kategorie-Slugs (kommasepariert) |
| `indoor` | boolean | Nur Indoor-Events |
| `outdoor` | boolean | Nur Outdoor-Events |
| `free` | boolean | Nur kostenlose Events |
| `tab` | string | Vordefinierte Filter: `heute`, `wochenende`, `ferien`, `nachmittags`, `regen`, `kostenlos` |
| `sort` | string | Sortierung: `soonest`, `nearest`, `newest`, `relevance` |
| `page` | int | Seitennummer (ab 1) |
| `limit` | int | Einträge pro Seite (max 100) |

**Response (200):**
```json
{
  "success": true,
  "data": [...events],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 150,
    "total_pages": 8
  },
  "meta": {
    "query_time_ms": 45,
    "sort": "soonest"
  }
}
```

### GET /events/top-picks

Top-bewertete Events.

### GET /events/available

Heute verfügbare Events.

### GET /events/new

Neu hinzugefügte Events (letzte 7 Tage).

### GET /events/trending

Trending Events.

### GET /events/featured

Featured Events (Startseite).

### GET /events/:id

Einzelnes Event abrufen.

**Response (200):**
```json
{
  "success": true,
  "data": {
    "id": "...",
    "title": "Kinderflohmarkt",
    "description_short": "...",
    "start_datetime": "2026-02-01T10:00:00Z",
    "location_address": "Marktplatz, Karlsruhe",
    "price_type": "free",
    "categories": [...],
    "scores": { "family_fit_score": 85 }
  }
}
```

### GET /events/:id/similar

Ähnliche Events.

### GET /events/:id/ical

Event als iCal-Datei exportieren.

### POST /events

Neues Event erstellen. **Auth optional** (Provider-Verknüpfung).

**Body:**
```json
{
  "title": "Kinderworkshop",
  "start_datetime": "2026-02-15T14:00:00Z",
  "end_datetime": "2026-02-15T16:00:00Z",
  "location_address": "Kreativhaus, Karlsruhe",
  "price_type": "paid",
  "price_min": 15,
  "age_min": 6,
  "age_max": 12,
  "is_indoor": true,
  "categories": ["workshop", "kreativ"]
}
```

### PUT /events/:id

Event aktualisieren. Für veröffentlichte Events wird eine Revision erstellt.

### POST /events/:id/cancel

Event absagen.

**Body:**
```json
{
  "reason": "Wegen schlechten Wetters"
}
```

### POST /events/:id/reschedule

Event verschieben. Erstellt ein neues Event und archiviert das alte.

**Body:**
```json
{
  "new_start_datetime": "2026-02-20T14:00:00Z",
  "reason": "Verschoben auf nächste Woche"
}
```

### POST /events/ingest

**Nur für AI-Worker.** Event einpflegen (idempotent).

---

## User Endpoints

Alle erfordern **Auth**.

### GET /user/profile

Benutzerprofil abrufen.

### PUT /user/profile

Profil aktualisieren.

**Body:**
```json
{
  "children_ages": [{"name": "Max", "birthdate": "2020-05-15"}],
  "preferred_radius_km": 15,
  "home_lat": 49.0069,
  "home_lng": 8.4037
}
```

### GET /user/saved-events

Merkliste abrufen.

### POST /user/saved-events/:eventId

Event zur Merkliste hinzufügen.

### DELETE /user/saved-events/:eventId

Event von Merkliste entfernen.

### GET /user/plans

Gespeicherte Pläne abrufen.

---

## Search Endpoints

### GET /search/suggestions

Autocomplete-Vorschläge.

**Query Parameter:**

| Parameter | Typ | Beschreibung |
|-----------|-----|--------------|
| `q` | string | Suchbegriff (leer = Default-Suggestions) |

**Response (200):**
```json
{
  "suggestions": [
    { "text": "Indoor", "type": "entity", "source": "entity" },
    { "text": "museum karlsruhe", "type": "query", "source": "log" }
  ],
  "trending": [
    { "text": "fasching", "badge": "🔥", "source": "log" }
  ]
}
```

### POST /search/log

Suchanfrage protokollieren (für Trending-Berechnung).

**Body:**
```json
{
  "query": "kinderflohmarkt"
}
```

---

## Plan Endpoints

### POST /plan/generate

Tagesplan generieren.

**Body:**
```json
{
  "date": "2026-02-01",
  "children_ages": [4, 7],
  "budget": 50,
  "lat": 49.0069,
  "lng": 8.4037,
  "preferences": {
    "indoor_preferred": false,
    "max_travel_time": 30
  }
}
```

---

## Sources Endpoints

### GET /sources

Alle Quellen auflisten.

### GET /sources/health

Quellen-Gesundheitsstatus.

### GET /sources/:id

Einzelne Quelle mit Fetch-Logs.

### POST /sources/:id/trigger

**Admin.** Fetch manuell auslösen.

### POST /sources

**Admin.** Neue Quelle erstellen.

### PUT /sources/:id

**Admin.** Quelle aktualisieren.

### DELETE /sources/:id

**Admin.** Quelle deaktivieren (?hard=true für permanentes Löschen).

### PUT /sources/:id/compliance

**Admin.** Compliance-Informationen aktualisieren.

---

## Admin Endpoints

Alle erfordern **Admin-Rolle**.

### GET /admin/stats

Dashboard-Statistiken.

**Response:**
```json
{
  "success": true,
  "data": {
    "events": {
      "total": 500,
      "published": 450,
      "pending_review": 30,
      "today_imports": 15
    },
    "sources": {
      "healthy": 8,
      "degraded": 1,
      "failing": 0,
      "dead": 0
    }
  }
}
```

### GET /admin/review-queue

Events zur Prüfung.

### POST /admin/review/:id/approve

Event freigeben.

### POST /admin/review/:id/reject

Event ablehnen.

**Body:**
```json
{
  "reason": "Duplikat",
  "reason_code": "DUPLICATE"
}
```

### POST /admin/review/:id/quick-edit

Bearbeiten und freigeben.

### GET /admin/revisions

Ausstehende Revisionen.

### POST /admin/revisions/:id/approve

Revision freigeben.

### POST /admin/revisions/:id/reject

Revision ablehnen.

### GET /admin/duplicates

Duplikat-Kandidaten.

### POST /admin/duplicates/:id/merge

Duplikate zusammenführen.

### POST /admin/duplicates/:id/mark-different

Als unterschiedlich markieren.

### POST /admin/duplicates/:id/ignore

Ignorieren.

### GET /admin/ingest-runs

Ingest-Läufe auflisten.

### GET /admin/ingest-runs/needs-attention

Läufe mit Fehlern.

### POST /admin/ingest-runs/:id/acknowledge

Fehler bestätigen.

---

## Admin Trends Endpoints

### POST /admin/trends/compute

Trending-Begriffe berechnen. **Auch für Cron-Jobs** (mit `X-Cron-Secret` Header).

### GET /admin/trends/preview

Vorschau der Suggestions/Trending.

**Query Parameter:**

| Parameter | Typ | Beschreibung |
|-----------|-----|--------------|
| `q` | string | Suchbegriff |
| `applyOverrides` | boolean | Overrides anwenden (default: true) |

### GET /admin/trends/stats

Trend-Statistiken.

### GET /admin/trends/terms

Berechnete Trending-Begriffe.

### GET /admin/trends/overrides

Override-Regeln auflisten.

### POST /admin/trends/overrides

Override erstellen.

**Body:**
```json
{
  "term": "fasching",
  "action": "PIN",
  "priority": 100,
  "label": "📌"
}
```

**Actions:**
- `PIN` - Ganz oben anzeigen
- `BOOST` - Score erhöhen (benötigt `boost`: 1-100)
- `HIDE` - Verstecken
- `REPLACE` - Ersetzen (benötigt `replacement`)
- `PUSH` - In Trending einfügen

### PATCH /admin/trends/overrides/:id

Override aktualisieren.

### DELETE /admin/trends/overrides/:id

Override deaktivieren (?hard=true für permanentes Löschen).

---

## Health Endpoint

### GET /health

Server-Gesundheitsstatus.

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2026-01-27T12:00:00Z",
  "services": {
    "database": "ok",
    "redis": "not_implemented"
  }
}
```

---

## Fehler-Responses

Alle Fehler folgen diesem Format:

```json
{
  "success": false,
  "error": {
    "message": "Event not found",
    "code": "NOT_FOUND",
    "status": 404
  }
}
```

### HTTP Status Codes

| Code | Bedeutung |
|------|-----------|
| 200 | Erfolgreich |
| 201 | Erstellt |
| 202 | Akzeptiert (Revision erstellt) |
| 400 | Validierungsfehler |
| 401 | Nicht authentifiziert |
| 403 | Keine Berechtigung |
| 404 | Nicht gefunden |
| 409 | Konflikt (z.B. Duplikat) |
| 429 | Rate Limit überschritten |
| 500 | Server-Fehler |

---

## Rate Limiting

| Endpoint-Typ | Limit |
|--------------|-------|
| API allgemein | 100 Requests/Minute |
| Auth Endpoints | 10 Requests/Minute |
| Ingest Endpoints | 50 Requests/Minute |

Bei Überschreitung: `429 Too Many Requests`

---

## Beispiele

### cURL: Login

```bash
curl -X POST https://api.familien-lokal.de/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"password123"}'
```

### cURL: Events suchen

```bash
curl "https://api.familien-lokal.de/api/events?lat=49.0069&lng=8.4037&radius=10&categories=indoor"
```

### cURL: Event speichern

```bash
curl -X POST https://api.familien-lokal.de/api/user/saved-events/EVENT_ID \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### JavaScript: Fetch

```javascript
const response = await fetch('https://api.familien-lokal.de/api/events?limit=10', {
  headers: {
    'Authorization': `Bearer ${token}`
  }
});
const data = await response.json();
```
