# Familien-Lokal Plattform

Eine Plattform für Familien in Karlsruhe, die lokale Events, Kurse und Ferienangebote findet, bewertet und buchbar macht.

## USP

Eltern bekommen in unter 20 Sekunden einen fertigen, stressfreien Plan (inkl. Route/Zeitslots + Plan B bei Regen/ausgebucht).

## Tech-Stack

- **Frontend:** Astro (Static + Islands), Vanilla CSS, TypeScript
- **Backend:** Node.js + TypeScript (Express/Fastify)
- **AI-Worker:** Python (Crawler, Klassifikation, Scoring, Plan-Generator)
- **Datenbank:** PostgreSQL + PostGIS
- **Queue:** Redis
- **Search:** Meilisearch (optional)

## Projektstruktur

```
familien-lokal/
├── frontend/          # Astro App
├── backend/           # Node.js API
├── ai-worker/         # Python AI Service
├── shared/            # Shared Types/Schemas
├── docker-compose.yml # Lokale Dev-Infrastruktur
└── README.md
```

## Schnellstart

### Voraussetzungen

- Node.js >= 20
- Python >= 3.11
- Docker + Docker Compose

### Installation

```bash
# 1. Dependencies installieren
npm install

# 2. Docker-Container starten (PostgreSQL + Redis)
npm run docker:up

# 3. Datenbank migrieren
npm run db:migrate

# 4. Python-Dependencies installieren
cd ai-worker
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt
cd ..

# 5. Entwicklungsserver starten
npm run dev
```

### Umgebungsvariablen

Kopiere `.env.example` nach `.env` und passe die Werte an:

```bash
cp backend/.env.example backend/.env
cp ai-worker/.env.example ai-worker/.env
```

## Entwicklung

```bash
# Alle Services starten
npm run dev

# Nur Frontend
npm run dev:frontend

# Nur Backend
npm run dev:backend

# AI-Worker (separates Terminal)
cd ai-worker
python -m src.main
```

## Datenbank

```bash
# Prisma Schema generieren
npm run db:generate

# Migrationen ausführen
npm run db:migrate

# Schema pushen (Dev only)
npm run db:push
```

## Lizenz

Proprietary - Alle Rechte vorbehalten
