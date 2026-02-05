# kiezling

Eine Plattform für Familien in Karlsruhe, die lokale Events, Kurse und Ferienangebote findet, bewertet und buchbar macht (kiezling.com).

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
kiezling/
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

**Admin-Konsole:** Frontend und Backend müssen laufen. Im Projektroot `npm run dev` startet beides; das Backend erlaubt CORS für `localhost:3000` und `localhost:3001`.

```bash
# Alle Services starten (Frontend + Backend)
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

## Production Deployment

### Vercel (Frontend)

1. Repository mit Vercel verbinden
2. **Root Directory:** `frontend`
3. **Build Command:** `npm run build`
4. **Output Directory:** `dist`
5. Environment Variables in Vercel Dashboard setzen:
   - `PUBLIC_API_URL` = `https://api.kiezling.com`

### Backend (Railway / Render / Fly.io)

1. Node.js Buildpack oder Dockerfile verwenden
2. Environment Variables setzen (siehe Tabelle unten)
3. PostgreSQL Addon hinzufügen (oder Supabase verwenden)
4. Redis Addon hinzufügen

### Supabase (aktuelle Konfiguration)

Das Backend nutzt Supabase PostgreSQL:

1. Projekt in Supabase erstellen
2. Connection String aus Dashboard → Settings → Database kopieren
3. PostGIS Extension aktivieren:
   ```sql
   CREATE EXTENSION IF NOT EXISTS postgis;
   ```

### Vercel Cron Jobs

Für automatische Trending-Berechnung, `vercel.json` erweitern:

```json
{
  "crons": [{
    "path": "/api/admin/trends/compute",
    "schedule": "*/30 * * * *"
  }]
}
```

### Checkliste vor Go-Live

- [ ] `JWT_SECRET` auf sicheren Wert setzen (min. 32 Zeichen)
- [ ] `CRON_SECRET` setzen (min. 32 Zeichen)
- [ ] `CORS_ORIGIN` auf Production-Domain setzen
- [ ] SSL/HTTPS aktiv
- [ ] Rate Limiting konfiguriert
- [ ] Datenbank-Backups aktiviert
- [ ] Error Monitoring eingerichtet (z.B. Sentry)

## Environment Variables

### Backend (`backend/.env`)

| Variable | Erforderlich | Beschreibung | Beispiel |
|----------|--------------|--------------|----------|
| `DATABASE_URL` | ✅ Ja | PostgreSQL Connection String | `postgresql://user:pass@host:5432/db` |
| `DIRECT_URL` | ✅ Ja | Direct PostgreSQL URL (für Migrationen) | `postgresql://user:pass@host:5432/db` |
| `REDIS_URL` | Nein | Redis Connection String (optional) | `redis://localhost:6379` |
| `PORT` | Nein | Server Port (default: 4000) | `4000` |
| `NODE_ENV` | Nein | Environment | `production` |
| `CORS_ORIGIN` | ✅ Ja | Erlaubte Origins (kommasepariert) | `https://www.kiezling.com` |
| `JWT_SECRET` | ✅ Prod | JWT Signing Secret (min. 32 Zeichen) | `your-super-secret-key-here` |
| `JWT_EXPIRES_IN` | Nein | Token Ablaufzeit (default: 7d) | `7d` |
| `SUPABASE_URL` | ✅ Ja | Supabase Project URL | `https://xxx.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ Ja | Supabase Service Role Key | `eyJ...` |
| `AI_WORKER_URL` | Nein | AI Worker Service URL | `http://localhost:5000` |
| `NOMINATIM_URL` | Nein | Geocoding Service URL | `https://nominatim.openstreetmap.org` |
| `CRON_SECRET` | ✅ Prod | Secret für Cron-Jobs | `your-cron-secret-here` |

**Wichtig:** `DATABASE_URL` und `SUPABASE_URL` müssen auf das **gleiche** Supabase-Projekt zeigen!

### Frontend (`frontend/.env`)

| Variable | Erforderlich | Beschreibung | Beispiel |
|----------|--------------|--------------|----------|
| `PUBLIC_API_URL` | ✅ Ja | Backend API URL | `http://localhost:4000` |
| `PUBLIC_SUPABASE_URL` | ✅ Ja | Supabase Project URL | `https://xxx.supabase.co` |
| `PUBLIC_SUPABASE_ANON_KEY` | ✅ Ja | Supabase Anon/Public Key | `eyJ...` |

**Wichtig:** `PUBLIC_SUPABASE_URL` muss mit dem Backend `SUPABASE_URL` übereinstimmen!

### AI Worker (`ai-worker/.env`)

| Variable | Erforderlich | Beschreibung | Beispiel |
|----------|--------------|--------------|----------|
| `DATABASE_URL` | ✅ Ja | PostgreSQL Connection String | `postgresql://...` |
| `REDIS_URL` | ✅ Ja | Redis Connection String | `redis://localhost:6379` |
| `PORT` | Nein | Server Port (default: 5000) | `5000` |
| `OPENAI_API_KEY` | ✅ Ja | OpenAI API Key | `sk-...` |
| `ANTHROPIC_API_KEY` | Nein | Anthropic API Key (Fallback) | `sk-ant-...` |
| `AI_DAILY_LIMIT_USD` | Nein | Tägliches AI-Budget | `10.0` |
| `AI_MONTHLY_LIMIT_USD` | Nein | Monatliches AI-Budget | `200.0` |
| `DEFAULT_LAT` | Nein | Standard-Latitude | `49.0069` |
| `DEFAULT_LNG` | Nein | Standard-Longitude | `8.4037` |

## Weitere Dokumentation

- [CONTRIBUTING.md](CONTRIBUTING.md) - Beitragsrichtlinien
- [SECURITY.md](SECURITY.md) - Sicherheitsrichtlinien
- [CHANGELOG.md](CHANGELOG.md) - Änderungsprotokoll
- [CRON_SETUP.md](CRON_SETUP.md) - Cron-Job Konfiguration
- [docs/API.md](docs/API.md) - API Dokumentation
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) - Architektur-Übersicht
- [docs/REDIS_SETUP.md](docs/REDIS_SETUP.md) - Redis einrichten (lokal, Railway, Vercel)
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) - Fehlerbehebung

## Lizenz

Proprietary - Alle Rechte vorbehalten
