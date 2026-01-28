# Troubleshooting Guide

Häufige Probleme und deren Lösungen.

## Inhaltsverzeichnis

- [Server-Probleme](#server-probleme)
- [Datenbank-Probleme](#datenbank-probleme)
- [Authentifizierung](#authentifizierung)
- [API-Fehler](#api-fehler)
- [Frontend-Probleme](#frontend-probleme)
- [Entwicklungsumgebung](#entwicklungsumgebung)

---

## Server-Probleme

### Port already in use (EADDRINUSE)

**Symptom:**
```
Error: listen EADDRINUSE: address already in use :::4000
```

**Ursache:** Ein anderer Prozess verwendet bereits den Port.

**Lösung (Windows PowerShell):**
```powershell
# Prozess auf Port 4000 finden
Get-NetTCPConnection -LocalPort 4000

# Prozess beenden
Stop-Process -Id <PID> -Force

# Oder direkt beenden
Get-NetTCPConnection -LocalPort 4000 | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

**Lösung (Linux/Mac):**
```bash
# Prozess finden
lsof -i :4000

# Prozess beenden
kill -9 <PID>

# Oder direkt
kill -9 $(lsof -t -i:4000)
```

### Server startet nicht / Hängt beim Start

**Symptom:** Backend startet, bleibt aber hängen.

**Mögliche Ursachen:**

1. **Datenbank nicht erreichbar:**
   ```bash
   # Prüfen ob PostgreSQL läuft
   docker ps | grep postgres
   
   # Docker Container starten
   npm run docker:up
   ```

2. **Prisma Client nicht generiert:**
   ```bash
   cd backend
   npx prisma generate
   ```

3. **Environment Variables fehlen:**
   ```bash
   # .env vorhanden?
   ls backend/.env
   
   # Kopieren falls nicht
   cp backend/.env.example backend/.env
   ```

---

## Datenbank-Probleme

### Prisma Migration Fehler

**Symptom:**
```
Error: P3014: Prisma Migrate could not create the shadow database
```

**Lösung:**
```bash
cd backend

# Schema direkt pushen (nur Development)
npx prisma db push

# Mit Data Loss Warning
npx prisma db push --accept-data-loss
```

### Prisma Generate EPERM Fehler (Windows)

**Symptom:**
```
Error: EPERM: operation not permitted
```

**Lösung:**
```powershell
# .prisma Cache löschen
Remove-Item -Recurse -Force node_modules\.prisma

# Neu generieren
npx prisma generate
```

### Datenbank Connection Refused

**Symptom:**
```
Error: connect ECONNREFUSED 127.0.0.1:5432
```

**Lösungen:**

1. **Docker Container prüfen:**
   ```bash
   docker ps
   
   # Falls nicht gestartet
   npm run docker:up
   ```

2. **Supabase-Verbindung prüfen:**
   - Supabase Dashboard öffnen
   - Settings → Database → Connection string prüfen
   - IP-Allowlist prüfen (falls aktiviert)

3. **DATABASE_URL prüfen:**
   ```bash
   # .env prüfen
   cat backend/.env | grep DATABASE_URL
   ```

### PostGIS Extension fehlt

**Symptom:**
```
Error: function ST_Distance does not exist
```

**Lösung (Supabase SQL Editor):**
```sql
CREATE EXTENSION IF NOT EXISTS postgis;
```

---

## Authentifizierung

### 401 Unauthorized

**Symptom:** API gibt 401 zurück.

**Mögliche Ursachen:**

1. **Token fehlt:**
   ```javascript
   // Header prüfen
   Authorization: Bearer <token>
   ```

2. **Token abgelaufen:**
   ```javascript
   // Neu einloggen
   const response = await fetch('/api/auth/login', {
     method: 'POST',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({ email, password })
   });
   ```

3. **JWT_SECRET geändert:**
   - Alle Tokens werden ungültig wenn JWT_SECRET sich ändert
   - Nutzer müssen sich neu einloggen

### 403 Forbidden (Admin-Endpoints)

**Symptom:** Admin-Endpoints geben 403 zurück.

**Ursache:** Benutzer hat keine Admin-Rolle.

**Lösung (Datenbank):**
```sql
-- User-Rolle auf admin setzen
UPDATE users SET role = 'admin' WHERE email = 'admin@example.com';
```

### Rate Limit erreicht (429)

**Symptom:**
```json
{ "error": "Too many requests, please try again later" }
```

**Ursache:** Zu viele Anfragen in kurzer Zeit.

**Lösungen:**

1. **Entwicklung:** Server neustarten (In-Memory Store wird geleert)
   ```bash
   # Backend neustarten
   npm run dev:backend
   ```

2. **Warten:** Rate Limits resetten nach 1 Minute

3. **Testen:** Mit verschiedenen Endpoints arbeiten
   - Auth: 10 req/min
   - API: 100 req/min

---

## API-Fehler

### CORS Fehler

**Symptom:**
```
Access to fetch at 'http://localhost:4000' from origin 'http://localhost:3000' 
has been blocked by CORS policy
```

**Lösung:**

1. **CORS_ORIGIN prüfen:**
   ```bash
   # backend/.env
   CORS_ORIGIN=http://localhost:3000,http://localhost:4321
   ```

2. **Backend neustarten nach Änderung**

### 404 Not Found für API-Endpoints

**Symptom:** `/api/events` gibt 404 zurück.

**Mögliche Ursachen:**

1. **Falscher Base-Path:**
   ```javascript
   // Falsch
   fetch('/events')
   
   // Richtig
   fetch('/api/events')
   ```

2. **Backend nicht gestartet:**
   ```bash
   npm run dev:backend
   ```

### 500 Internal Server Error

**Symptom:** Generischer Server-Fehler.

**Debugging:**

1. **Backend-Logs prüfen:**
   ```bash
   # Terminal mit Backend-Output prüfen
   npm run dev:backend
   ```

2. **Correlation ID nutzen:**
   - Response enthält oft `correlation_id`
   - In Logs nach dieser ID suchen

3. **Datenbank-Verbindung prüfen:**
   ```bash
   npx prisma db pull
   ```

---

## Frontend-Probleme

### API URL nicht konfiguriert

**Symptom:** Fetch-Fehler im Browser.

**Lösung:**
```bash
# frontend/.env erstellen
echo "PUBLIC_API_URL=http://localhost:4000" > frontend/.env
```

### Astro Build Fehler

**Symptom:**
```
[astro] Unable to render component
```

**Lösungen:**

1. **Dependencies aktualisieren:**
   ```bash
   cd frontend
   npm install
   ```

2. **Cache löschen:**
   ```bash
   rm -rf node_modules/.astro
   npm run dev
   ```

### MapLibre lädt nicht

**Symptom:** Karte bleibt leer/weiß.

**Mögliche Ursachen:**

1. **MapLibre nicht installiert:**
   ```bash
   cd frontend
   npm install maplibre-gl
   ```

2. **CSS nicht importiert:**
   ```javascript
   import 'maplibre-gl/dist/maplibre-gl.css';
   ```

3. **Container hat keine Höhe:**
   ```css
   #map {
     height: 400px; /* Oder 100vh */
   }
   ```

### LocalStorage Fehler (SSR)

**Symptom:**
```
ReferenceError: localStorage is not defined
```

**Ursache:** Code läuft server-seitig in Astro.

**Lösung:**
```javascript
// Browser-Check hinzufügen
if (typeof window !== 'undefined') {
  const token = localStorage.getItem('token');
}

// Oder in client-seitigem Script
<script>
  // Dieser Code läuft nur im Browser
  const token = localStorage.getItem('token');
</script>
```

---

## Entwicklungsumgebung

### npm install Fehler

**Symptom:** Dependencies installieren fehlgeschlagen.

**Lösungen:**

1. **Node Version prüfen:**
   ```bash
   node --version  # Sollte >= 20 sein
   ```

2. **Cache löschen:**
   ```bash
   npm cache clean --force
   rm -rf node_modules package-lock.json
   npm install
   ```

3. **Windows: Als Admin ausführen** (für native Dependencies)

### Docker Container starten nicht

**Symptom:** `npm run docker:up` schlägt fehl.

**Lösungen:**

1. **Docker Desktop läuft?**
   - Windows: Docker Desktop öffnen
   - Linux: `systemctl status docker`

2. **Ports bereits belegt:**
   ```bash
   # Port 5432 (PostgreSQL) prüfen
   netstat -an | grep 5432
   ```

3. **Container-Logs prüfen:**
   ```bash
   docker-compose logs
   ```

### TypeScript Fehler im Editor

**Symptom:** Rote Unterstriche trotz korrektem Code.

**Lösungen:**

1. **TypeScript Server neustarten:**
   - VSCode: `Cmd/Ctrl + Shift + P` → "TypeScript: Restart TS Server"

2. **Prisma Types generieren:**
   ```bash
   cd backend
   npx prisma generate
   ```

3. **Editor neustarten**

---

## Schnelle Diagnose-Checkliste

```
□ Docker läuft?                    docker ps
□ Datenbank erreichbar?            npx prisma db pull
□ Backend gestartet?               curl http://localhost:4000/api/health
□ Frontend gestartet?              curl http://localhost:3000
□ .env Dateien vorhanden?          ls */.env
□ Prisma Client generiert?         ls backend/node_modules/.prisma
□ Dependencies installiert?        npm ls
```

---

## Hilfe holen

Wenn das Problem weiter besteht:

1. **Issue erstellen** mit:
   - Fehlermeldung (vollständig)
   - Schritte zur Reproduktion
   - Environment (OS, Node-Version, etc.)
   - Relevante .env Werte (OHNE Secrets!)

2. **Logs anhängen:**
   - Backend-Logs
   - Browser Console
   - Docker Logs (falls relevant)

---

## Weiterführende Dokumentation

- [API Dokumentation](API.md)
- [Architektur](ARCHITECTURE.md)
- [Security](../SECURITY.md)
