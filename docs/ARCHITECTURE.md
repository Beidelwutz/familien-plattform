# Architektur

Übersicht der Familien-Lokal Plattform-Architektur.

## System-Übersicht

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│     Frontend    │     │     Backend     │     │    PostgreSQL   │
│     (Astro)     │────▶│    (Express)    │────▶│    + PostGIS    │
│   Port: 3000    │     │   Port: 4000    │     │   Port: 5432    │
└─────────────────┘     └────────┬────────┘     └─────────────────┘
                                 │
                                 ▼
                        ┌─────────────────┐     ┌─────────────────┐
                        │   AI Worker     │     │      Redis      │
                        │   (FastAPI)     │     │    Port: 6379   │
                        │   Port: 5000    │     └─────────────────┘
                        └─────────────────┘
```

## Komponenten

### Frontend (Astro)

**Technologie:** Astro 5.x mit TypeScript

**Architektur:**
- Static Site Generation (SSG) für Performance
- Islands Architecture für interaktive Komponenten
- Tailwind CSS für Styling
- MapLibre GL JS für Karten

**Verzeichnisstruktur:**
```
frontend/
├── src/
│   ├── components/       # Wiederverwendbare Komponenten
│   │   ├── common/       # Allgemeine UI-Elemente
│   │   ├── feed/         # Feed/Liste Komponenten
│   │   ├── layout/       # Layout (Header, Footer)
│   │   ├── map/          # Karten-Komponenten
│   │   ├── planner/      # Planer-Komponenten
│   │   ├── search/       # Such-Komponenten
│   │   └── sections/     # Homepage-Sektionen
│   ├── layouts/          # Basis-Layouts
│   ├── lib/              # Utility-Funktionen
│   ├── pages/            # Seiten (File-based Routing)
│   │   ├── admin/        # Admin-Bereich
│   │   └── event/        # Event-Detailseiten
│   └── styles/           # Globale Styles
└── public/               # Statische Assets
```

### Backend (Express)

**Technologie:** Node.js 20+ mit Express, TypeScript

**Architektur:**
- RESTful API
- JWT-basierte Authentifizierung
- Prisma ORM für Datenbankzugriff
- Rate Limiting (In-Memory/Redis)

**Verzeichnisstruktur:**
```
backend/
├── prisma/
│   ├── schema.prisma     # Datenbankschema
│   ├── migrations/       # Migrationen
│   └── seed.ts           # Testdaten
├── src/
│   ├── lib/              # Business-Logik
│   │   ├── trends/       # Trending-System
│   │   ├── pagination.ts # Pagination-Helper
│   │   └── geo.ts        # Geo-Funktionen
│   ├── middleware/       # Express Middleware
│   │   ├── auth.ts       # JWT Auth
│   │   ├── rateLimit.ts  # Rate Limiting
│   │   └── errorHandler.ts
│   └── routes/           # API Endpoints
│       ├── events.ts
│       ├── auth.ts
│       ├── admin.ts
│       └── ...
└── index.ts              # Entry Point
```

### AI Worker (Python/FastAPI)

**Technologie:** Python 3.11+, FastAPI

**Funktionen:**
- Event-Klassifizierung (OpenAI/Anthropic)
- Event-Scoring
- Feed-Parsing (RSS/ICS)
- Deduplizierung
- Geocoding

**Verzeichnisstruktur:**
```
ai-worker/
├── src/
│   ├── classifiers/      # AI-Klassifizierung
│   ├── crawlers/         # Feed-Parser
│   ├── geocoding/        # Nominatim-Integration
│   ├── ingestion/        # Deduplizierung, Normalisierung
│   ├── monitoring/       # Cost Tracking, Health
│   ├── planner/          # Plan-Generierung
│   ├── routes/           # API Endpoints
│   ├── rules/            # Regel-basierte Filter
│   └── scorers/          # Event-Scoring
└── main.py               # Entry Point
```

### Datenbank (PostgreSQL + PostGIS)

**Technologie:** PostgreSQL 15+ mit PostGIS Extension

**Haupt-Modelle:**

```
┌─────────────────┐     ┌─────────────────┐
│ CanonicalEvent  │◄────│  EventSource    │
│ (Haupt-Event)   │     │ (Rohdaten)      │
└────────┬────────┘     └────────┬────────┘
         │                       │
         │                       ▼
         │              ┌─────────────────┐
         │              │     Source      │
         │              │ (Datenquelle)   │
         │              └─────────────────┘
         │
         ▼
┌─────────────────┐     ┌─────────────────┐
│   EventScore    │     │  EventCategory  │
│ (AI-Scores)     │     │ (Kategorien)    │
└─────────────────┘     └─────────────────┘
```

---

## Datenflüsse

### 1. Event-Ingestion

```
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│  Source  │────▶│AI Worker │────▶│ Backend  │────▶│ Database │
│(RSS/ICS) │     │(Parse,   │     │(Ingest   │     │(Store)   │
│          │     │ Classify)│     │ API)     │     │          │
└──────────┘     └──────────┘     └──────────┘     └──────────┘
                      │
                      ▼
              ┌──────────────┐
              │ Deduplication│
              │ Normalization│
              │ Geocoding    │
              └──────────────┘
```

**Ablauf:**
1. AI Worker fetcht Feed von Source (RSS/ICS)
2. Events werden geparst und normalisiert
3. Fingerprint wird berechnet (Deduplizierung)
4. AI klassifiziert Kategorien, Altersgruppen
5. Geocoding für Adressen
6. Event wird via Backend-API gespeichert

### 2. Benutzer-Suche

```
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│ Frontend │────▶│ Backend  │────▶│ PostGIS  │────▶│ Response │
│(Suche)   │     │(Filter,  │     │(Geo-     │     │(Events)  │
│          │     │ Paginate)│     │ Query)   │     │          │
└──────────┘     └──────────┘     └──────────┘     └──────────┘
```

**Ablauf:**
1. User gibt Suchbegriff/Filter ein
2. Frontend ruft `/api/events` auf
3. Backend baut Prisma-Query mit Filtern
4. PostGIS führt Geo-Suche durch (wenn lat/lng)
5. Events werden sortiert und paginiert zurückgegeben

### 3. Plan-Generierung

```
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│ Frontend │────▶│ Backend  │────▶│AI Worker │────▶│ Response │
│(Planer)  │     │(Plan API)│     │(Generate │     │(Timeline)│
│          │     │          │     │ Plan)    │     │          │
└──────────┘     └──────────┘     └──────────┘     └──────────┘
```

**Ablauf:**
1. User wählt Datum, Kinder-Alter, Budget
2. Frontend ruft `/api/plan/generate` auf
3. Backend leitet an AI Worker weiter
4. AI Worker generiert Timeline mit Events
5. Plan mit Zeitslots wird zurückgegeben

### 4. Search Autocomplete

```
┌──────────┐     ┌──────────┐     ┌──────────────────┐
│ Frontend │────▶│ Backend  │────▶│ Search Logic     │
│(Input)   │     │(API)     │     │ - Log Queries    │
│          │     │          │     │ - Entity Match   │
└──────────┘     └──────────┘     │ - Trending       │
                                  │ - Overrides      │
                                  └──────────────────┘
```

---

## Authentifizierung

```
┌─────────────────────────────────────────────────────────────┐
│                    JWT Authentication Flow                   │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. Login Request                                           │
│     POST /api/auth/login                                    │
│     { email, password }                                     │
│                                                             │
│  2. Server validates credentials                            │
│     - Check user exists                                     │
│     - Verify password (bcrypt)                              │
│                                                             │
│  3. Server returns JWT                                      │
│     { token: "eyJhbG..." }                                  │
│                                                             │
│  4. Client stores token (localStorage)                      │
│                                                             │
│  5. Subsequent requests include token                       │
│     Authorization: Bearer <token>                           │
│                                                             │
│  6. Server verifies token                                   │
│     - Signature check                                       │
│     - Expiration check                                      │
│     - Role-based access control                             │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Token-Payload:**
```json
{
  "sub": "user-id",
  "email": "user@example.com",
  "role": "parent",
  "iat": 1706356800,
  "exp": 1706961600
}
```

---

## Datenbank-Schema (vereinfacht)

### Haupt-Entitäten

```
┌─────────────────────────────────────────────────────────────┐
│                     CanonicalEvent                          │
├─────────────────────────────────────────────────────────────┤
│ id              UUID (PK)                                   │
│ title           VARCHAR(200)                                │
│ description     TEXT                                        │
│ start_datetime  TIMESTAMPTZ                                 │
│ end_datetime    TIMESTAMPTZ                                 │
│ location_*      Location fields                             │
│ price_*         Pricing fields                              │
│ age_min/max     INT                                         │
│ status          ENUM (raw, pending, published, ...)         │
│ is_cancelled    BOOLEAN                                     │
│ provider_id     UUID (FK)                                   │
│ primary_source_id UUID (FK)                                 │
└─────────────────────────────────────────────────────────────┘
         │
         │ 1:N
         ▼
┌─────────────────────────────────────────────────────────────┐
│                      EventSource                            │
├─────────────────────────────────────────────────────────────┤
│ id                  UUID (PK)                               │
│ canonical_event_id  UUID (FK)                               │
│ source_id           UUID (FK)                               │
│ fingerprint         VARCHAR(32)                             │
│ raw_data            JSONB                                   │
│ fetched_at          TIMESTAMPTZ                             │
└─────────────────────────────────────────────────────────────┘
         │
         │ N:1
         ▼
┌─────────────────────────────────────────────────────────────┐
│                        Source                               │
├─────────────────────────────────────────────────────────────┤
│ id              UUID (PK)                                   │
│ name            VARCHAR(200)                                │
│ type            ENUM (api, rss, ics, scraper, partner)      │
│ url             VARCHAR(500)                                │
│ health_status   ENUM (healthy, degraded, failing, dead)     │
│ is_active       BOOLEAN                                     │
│ priority        INT (1-5)                                   │
└─────────────────────────────────────────────────────────────┘
```

### Benutzer-Modelle

```
┌─────────────────────────────────────────────────────────────┐
│                         User                                │
├─────────────────────────────────────────────────────────────┤
│ id              UUID (PK)                                   │
│ email           VARCHAR(255) UNIQUE                         │
│ password_hash   VARCHAR(255)                                │
│ role            ENUM (parent, provider, admin)              │
└─────────────────────────────────────────────────────────────┘
         │
         │ 1:1
         ▼
┌─────────────────────────────────────────────────────────────┐
│                    FamilyProfile                            │
├─────────────────────────────────────────────────────────────┤
│ user_id              UUID (PK, FK)                          │
│ children_ages        JSONB                                  │
│ preferred_radius_km  INT                                    │
│ home_lat/lng         DECIMAL                                │
└─────────────────────────────────────────────────────────────┘
```

### Trending-System

```
┌─────────────────────────────────────────────────────────────┐
│                    SearchQueryLog                           │
├─────────────────────────────────────────────────────────────┤
│ id          CUID (PK)                                       │
│ queryNorm   VARCHAR(120)  -- normalisierter Suchbegriff     │
│ city        VARCHAR(80)                                     │
│ createdAt   TIMESTAMPTZ                                     │
└─────────────────────────────────────────────────────────────┘
                    │
                    │ Aggregiert zu
                    ▼
┌─────────────────────────────────────────────────────────────┐
│                    TrendingTerm                             │
├─────────────────────────────────────────────────────────────┤
│ id          CUID (PK)                                       │
│ term        VARCHAR(120)                                    │
│ city        VARCHAR(80)                                     │
│ score       FLOAT      -- searches24h * trendRatio          │
│ trendRatio  FLOAT      -- Anstieg vs. Baseline              │
│ searches24h INT                                             │
│ baseline7d  FLOAT                                           │
│ computedAt  TIMESTAMPTZ                                     │
└─────────────────────────────────────────────────────────────┘
                    │
                    │ Modifiziert durch
                    ▼
┌─────────────────────────────────────────────────────────────┐
│                    TrendOverride                            │
├─────────────────────────────────────────────────────────────┤
│ id          CUID (PK)                                       │
│ term        VARCHAR(120)                                    │
│ termNorm    VARCHAR(120)  -- für Duplikat-Check             │
│ action      ENUM (PIN, BOOST, HIDE, REPLACE, PUSH)          │
│ boost       INT                                             │
│ replacement VARCHAR(120)                                    │
│ priority    INT                                             │
│ isActive    BOOLEAN                                         │
│ startsAt    TIMESTAMPTZ                                     │
│ endsAt      TIMESTAMPTZ                                     │
└─────────────────────────────────────────────────────────────┘
```

---

## Deployment-Architektur

### Production (Empfohlen)

```
┌─────────────────────────────────────────────────────────────┐
│                         Vercel                              │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                 Frontend (Astro)                     │   │
│  │              https://www.kiezling.com               │   │
│  └─────────────────────────────────────────────────────┘   │
│                           │                                 │
│                           │ API Calls                       │
│                           ▼                                 │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                 Edge Functions                       │   │
│  │                 (Cron Jobs)                          │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                    Railway / Render                         │
│  ┌───────────────────┐    ┌───────────────────┐            │
│  │  Backend (Node)   │    │  AI Worker (Py)   │            │
│  │  api.familien...  │    │  ai.familien...   │            │
│  └───────────────────┘    └───────────────────┘            │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                       Supabase                              │
│  ┌───────────────────┐    ┌───────────────────┐            │
│  │ PostgreSQL+PostGIS│    │     (Redis)       │            │
│  │ Managed Database  │    │ Upstash/Railway   │            │
│  └───────────────────┘    └───────────────────┘            │
└─────────────────────────────────────────────────────────────┘
```

### Lokale Entwicklung

```
┌─────────────────────────────────────────────────────────────┐
│                   Docker Compose                            │
│  ┌───────────────────┐    ┌───────────────────┐            │
│  │    PostgreSQL     │    │      Redis        │            │
│  │    Port: 5432     │    │    Port: 6379     │            │
│  └───────────────────┘    └───────────────────┘            │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                    npm run dev                              │
│  ┌─────────┐    ┌─────────┐    ┌─────────┐                 │
│  │Frontend │    │Backend  │    │AI Worker│                 │
│  │  :3000  │    │  :4000  │    │  :5000  │                 │
│  └─────────┘    └─────────┘    └─────────┘                 │
└─────────────────────────────────────────────────────────────┘
```

---

## Skalierbarkeit

### Aktuelle Einschränkungen

1. **Rate Limiting:** In-Memory Store (Single-Instance)
2. **Caching:** Kein zentrales Caching
3. **Search:** Postgres Full-Text (kein Elasticsearch/Meilisearch)

### Skalierungs-Optionen

| Komponente | Aktuell | Skaliert |
|------------|---------|----------|
| Rate Limit | In-Memory | Redis Store |
| Sessions | JWT | JWT + Redis Blacklist |
| Search | Postgres | Meilisearch |
| Images | URLs | CDN (Cloudinary/Imgix) |
| Geo-Queries | PostGIS | PostGIS + Caching |

---

## Monitoring & Logging

### Implementiert

- Strukturiertes Logging mit Correlation IDs
- IngestRun Tracking (Erfolg/Fehler)
- Source Health Monitoring
- AI Cost Tracking

### Empfohlen für Production

- Sentry für Error Tracking
- Prometheus/Grafana für Metriken
- Log-Aggregation (Logtail/Papertrail)

---

## Weiterführende Dokumentation

- [API Dokumentation](API.md)
- [Troubleshooting](TROUBLESHOOTING.md)
- [CRON Setup](../CRON_SETUP.md)
- [Contributing](../CONTRIBUTING.md)
