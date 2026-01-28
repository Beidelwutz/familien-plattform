# Changelog

Alle wichtigen Änderungen an diesem Projekt werden hier dokumentiert.

Das Format basiert auf [Keep a Changelog](https://keepachangelog.com/de/1.0.0/),
und dieses Projekt hält sich an [Semantic Versioning](https://semver.org/lang/de/).

## [Unreleased]

### Added

- **Search Autocomplete System**
  - Suggestions basierend auf Suchanfragen und Kategorien
  - Trending-Begriffe mit 🔥 Badge
  - Admin Overrides (PIN, BOOST, HIDE, REPLACE, PUSH)
  - Default-Ansicht mit Top-Kategorien und beliebten Suchen

- **Admin Trends Dashboard** (`/admin/trends`)
  - Live Preview mit realistischem Dropdown-Mockup
  - Mobile/Desktop Toggle für Preview
  - Source Badges (Suche, Kategorie, Override)
  - Quick Actions (PIN/HIDE) mit Undo-Toast
  - PIN-Reihenfolge mit Move up/down

- **Dokumentation**
  - Production Deployment Guide
  - Environment Variables Dokumentation
  - CONTRIBUTING.md
  - SECURITY.md
  - API Dokumentation
  - Architektur-Übersicht
  - Troubleshooting Guide

### Changed

- Default-Suggestions zeigen jetzt Kategorien + beliebte Suchen statt nur Prefix-Match
- `termNorm` Feld für Duplikat-Erkennung bei Overrides
- Verbesserte API-Response mit `source` Feld für Transparenz

### Fixed

- Rate Limiting Reset bei Server-Neustart (In-Memory Store Limitation dokumentiert)
- Raw SQL Queries für `queryNorm` Spalte korrigiert

---

## [0.1.0] - 2026-01-27

### Added

#### Frontend

- **Homepage** mit Feed-Sektionen (TopPicks, AvailableNow, NewThisWeek, TrendingNearby)
- **Event-Suche** (`/suche`)
  - Filter: Datum, Alter, Preis, Kategorie, Indoor/Outdoor
  - List/Map Toggle
  - Pagination mit dynamischer Seitenzahl
  - Mobile Filter-Modal
- **Event-Detailseite** (`/event/[slug]`)
  - Ähnliche Events
  - Booking-Links
  - Map-Integration
- **Merkliste** (`/merkliste`)
  - LocalStorage + API-Sync
  - Auth-Prompt für nicht eingeloggte Nutzer
- **Planer** (`/plan`)
  - Kinder-Alter, Datum, Budget, Präferenzen
  - Timeline-Generierung
  - Plan B Unterstützung
- **Auth-Seiten**
  - Login (`/login`)
  - Registrierung (`/registrieren`)
- **Anbieter-Landingpage** (`/anbieter`)

#### Admin-Bereich

- **Dashboard** (`/admin`) mit Stats
- **Review Queue** (`/admin/review`)
  - Approve/Reject/Edit
  - Field Locking
- **Source Health** (`/admin/sources`)
  - Monitoring
  - Trigger Fetch
  - Enable/Disable
- **Duplicate Detection** (Admin API)
- **Ingest Run Tracking** (Admin API)

#### Backend API

- **Events API**
  - CRUD Operationen
  - Suche mit Filtern
  - Geo-Suche (PostGIS)
  - Pagination
- **Auth API**
  - JWT-basierte Authentifizierung
  - Login/Register/Logout
  - Role-based Access (parent, provider, admin)
- **User API**
  - Profil-Verwaltung
  - Saved Events (Merkliste)
- **Admin API**
  - Stats Dashboard
  - Review Queue
  - Source Management
  - Duplicate Management
  - Ingest Run Monitoring
- **Search API**
  - Suggestions Endpoint
  - Query Logging
- **Plan API**
  - Plan Generation
  - Route Optimization (Placeholder)

#### AI Worker

- **Feed Parser**
  - RSS/Atom Support
  - ICS Calendar Support
  - Fingerprint-Generierung
- **Event Classifier**
  - OpenAI/Anthropic Integration
  - Kategorie-Erkennung
  - Altersgruppen-Erkennung
- **Event Scorer**
  - Relevance Score
  - Quality Score
  - Family Fit Score
- **Deduplicator**
  - Fingerprint-basiert
  - Fuzzy Title Matching
  - Source Priority Merging
- **Normalizer**
  - Feld-Normalisierung
  - Preis-Extraktion
  - Kontakt-Extraktion
- **Geocoder**
  - Nominatim Integration
  - Caching
  - District Extraction

#### Infrastruktur

- Docker Compose Setup (PostgreSQL, Redis)
- Prisma ORM mit PostGIS
- Supabase Integration
- Rate Limiting
- CORS Konfiguration
- JWT Authentication

### Database Models

- `CanonicalEvent` - Hauptevent-Daten
- `EventSource` - Rohdaten von Quellen
- `EventScore` - AI-Scores
- `EventRevision` - Änderungshistorie
- `Source` - Datenquellen
- `SourceFetchLog` - Fetch-Protokolle
- `User` / `FamilyProfile` - Nutzer
- `Provider` - Anbieter
- `SavedEvent` - Merkliste
- `Plan` / `PlanSlot` - Tagesplanung
- `Category` / `Amenity` - Kategorien
- `GeocodeCache` - Geocoding-Cache
- `AICache` / `AIUsageLog` - AI-Tracking
- `DupCandidate` - Duplikat-Kandidaten
- `IngestRun` - Ingest-Protokolle
- `SearchQueryLog` - Suchanfragen
- `TrendingTerm` - Berechnete Trends
- `TrendOverride` - Admin-Overrides

---

## Versionsformat

- **MAJOR**: Inkompatible API-Änderungen
- **MINOR**: Neue Features (abwärtskompatibel)
- **PATCH**: Bugfixes (abwärtskompatibel)

## Links

- [README](README.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)
