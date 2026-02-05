# Redis einrichten

Redis wird an zwei Stellen genutzt:

- **Backend (Vercel, api.kiezling.com):** Live-Status der AI-Batch-Jobs (Admin-Seite „Start Batch“). Ohne Redis: 503 beim Polling, Batch läuft weiter, nur ohne Live-Fortschritt.
- **AI-Worker (Railway):** Job-Queue (Crawl/Classify/Score). Ohne Redis: Fallback auf synchrone Verarbeitung.

---

## 1. Redis auf Railway (für AI-Worker)

Der AI-Worker wird per Railway deployt. Redis kannst du im **gleichen Railway-Projekt** hinzufügen.

### Redis-Service hinzufügen

1. Im [Railway Dashboard](https://railway.app/dashboard) dein Projekt öffnen.
2. **+ New** (oder `Ctrl+K` / `Cmd+K`) → **Database** → **Redis** wählen (oder Template „Redis“ aus dem Marketplace).
3. Redis-Service erscheint auf der Canvas. Railway setzt automatisch u. a.:
   - `REDIS_URL` (komplette Connection-URL)
   - `REDISHOST`, `REDISPORT`, `REDISPASSWORD`, `REDISUSER`

### AI-Worker mit Redis verbinden

1. **AI-Worker-Service** in Railway öffnen → Tab **Variables**.
2. Variable hinzufügen (Referenz auf den Redis-Service):
   - **Name:** `REDIS_URL`
   - **Value:** `${{ Redis.REDIS_URL }}`
   
   *(Falls dein Redis-Service anders heißt, z.B. „redis“, dann: `${{ redis.REDIS_URL }}` – Groß-/Kleinschreibung wie im Dashboard.)*
3. **Add** → Änderungen unter **Deploy** anwenden („Deploy“ / „Redeploy“).

Danach nutzt der AI-Worker die Redis-Queue; Crawl/Classify-Jobs laufen asynchron.

---

## 2. Redis für das Backend (Vercel, api.kiezling.com)

Das Backend läuft auf **Vercel**, nicht auf Railway. Für den Live-Fortschritt der AI-Batch-Seite braucht das Backend eine **REDIS_URL** in seiner Laufzeitumgebung.

### Option A: Redis auf Railway + TCP Proxy (eine Redis-Instanz)

Wenn du Redis nur auf Railway betreibst:

1. **Redis-Service** auf Railway (wie oben) anlegen.
2. **Öffentlichen Zugang** aktivieren:
   - Redis-Service → **Settings** → **Networking** / **TCP Proxy**.
   - TCP Proxy aktivieren; Railway vergibt eine öffentliche Domain (z.B. `viaduct.proxy.rlwy.net`) und Port.
3. **Connection-URL** bauen (z.B. mit Passwort aus Redis-Variables):
   - Format: `redis://default:PASSWORD@host:port`  
   - Host/Port = die TCP-Proxy-Domain und der angezeigte Port.
4. **Vercel (Backend-Projekt):**
   - Project Settings → **Environment Variables**.
   - Variable **REDIS_URL** anlegen (Value = die gebaute URL, z.B. `redis://default:...@...rlwy.net:12345`).
   - Für Production (und ggf. Preview) setzen → Save → Redeploy.

Hinweis: Traffic von Vercel zu Railway Redis zählt als Egress (Kosten je nach Plan).

### Option B: Upstash Redis (serverless-freundlich für Vercel)

[Upstash](https://upstash.com/) bietet Redis-APIs mit nutzungsbasiertem Modell, gut für Vercel:

1. Upstash Account → neues Redis (z.B. „Redis“) anlegen, Region wählen.
2. Im Upstash-Dashboard die **REST URL** oder **Redis URL** kopieren (oft `rediss://default:...@...upstash.io:6379`).
3. **Vercel (Backend):** Environment Variable **REDIS_URL** = diese URL setzen, Redeploy.

AI-Worker kann weiter Railway Redis nutzen (Option 1); Backend nutzt dann Upstash. Zwei getrennte Redis-Instanzen sind in Ordnung (Backend speichert nur kurzfristig Job-Status).

---

## 3. Lokale Entwicklung

Lokal reicht ein Redis auf Port 6379 (z.B. per Docker) und in beiden `.env`-Dateien dieselbe URL:

**backend/.env**
```env
REDIS_URL="redis://localhost:6379"
```

**ai-worker/.env**
```env
REDIS_URL=redis://localhost:6379
```

Redis starten (aus Projektroot):
```bash
docker compose up -d redis
```

---

## Kurzüberblick

| Umgebung      | Backend (Vercel)     | AI-Worker (Railway)   |
|---------------|----------------------|------------------------|
| Lokal         | `redis://localhost:6379` | `redis://localhost:6379` |
| Produktion    | Vercel Env **REDIS_URL** (Railway TCP Proxy oder Upstash) | Railway Variable `REDIS_URL=${{ Redis.REDIS_URL }}` |

Nach dem Setzen von **REDIS_URL** jeweils Deployment neu anstoßen (Vercel Redeploy, Railway Redeploy).
