# Security Policy

## Unterstützte Versionen

| Version | Unterstützt        |
|---------|--------------------|
| main    | ✅ Ja              |
| < main  | ❌ Nein            |

## Sicherheitslücken melden

Wir nehmen Sicherheit ernst. Wenn du eine Sicherheitslücke entdeckst, hilf uns bitte, sie verantwortungsvoll zu beheben.

### Meldeprozess

1. **NICHT** als öffentliches GitHub Issue melden
2. Sende eine E-Mail an: **security@familien-lokal.de**
3. Füge folgende Informationen bei:
   - Beschreibung der Schwachstelle
   - Schritte zur Reproduktion
   - Mögliche Auswirkungen
   - Vorgeschlagene Behebung (falls vorhanden)

### Was du erwarten kannst

- **Bestätigung** innerhalb von 48 Stunden
- **Status-Update** innerhalb von 5 Werktagen
- **Koordinierte Veröffentlichung** nach Behebung

### Was wir bitten

- Gib uns Zeit, die Schwachstelle zu beheben
- Veröffentliche keine Details vor der Behebung
- Teste nicht an Production-Systemen ohne Erlaubnis

## Sicherheits-Best-Practices

### Für Entwickler

#### Environment Variables

```bash
# Sichere Werte generieren (Linux/Mac)
openssl rand -base64 32

# Niemals Default-Werte in Production verwenden!
JWT_SECRET="dev-secret"  # ❌ NICHT in Production
JWT_SECRET="a8f3k2m..."  # ✅ Zufällig generiert
```

#### Secrets-Management

- ❌ **Niemals** Secrets in Code committen
- ❌ **Niemals** `.env` Dateien committen
- ✅ `.env.example` für Dokumentation verwenden
- ✅ Environment Variables im Hosting-Provider setzen

### Production-Härtung

#### Erforderliche Konfiguration

```bash
# JWT Secret (min. 32 Zeichen)
JWT_SECRET="<zufällig-generierter-string>"

# Cron Secret (min. 32 Zeichen)
CRON_SECRET="<zufällig-generierter-string>"

# CORS restriktiv setzen
CORS_ORIGIN="https://familien-lokal.de"

# Production Mode
NODE_ENV="production"
```

#### HTTPS erzwingen

Alle Production-Deployments müssen HTTPS verwenden:

- Vercel: Automatisch aktiviert
- Custom Domain: SSL-Zertifikat einrichten (Let's Encrypt)

#### Rate Limiting

Das Backend implementiert Rate Limiting:

| Endpoint-Typ | Limit |
|--------------|-------|
| API allgemein | 100 req/min |
| Auth Endpoints | 10 req/min |
| Ingest Endpoints | 50 req/min |

**Hinweis:** Aktuell In-Memory Store. Für Multi-Instance: Redis verwenden.

### Bekannte Einschränkungen

| Bereich | Aktueller Stand | Empfehlung für Production |
|---------|-----------------|---------------------------|
| Rate Limiting | In-Memory | Redis Store verwenden |
| Admin-Auth | Client-seitig | SSR-Schutz implementieren |
| Token Refresh | Nicht implementiert | Refresh Tokens hinzufügen |
| Password Reset | Nicht implementiert | Email-Verifizierung |

### Datenschutz (DSGVO)

#### Implementiert

- Passwort-Hashing (bcrypt)
- HTTPS-Übertragung
- Minimale Datenerfassung

#### Zu implementieren

- [ ] Cookie-Banner
- [ ] Datenschutzerklärung (/datenschutz)
- [ ] Datenexport (Art. 20)
- [ ] Account-Löschung (Art. 17)
- [ ] Einwilligungsverwaltung

## Sicherheits-Checkliste für Deployment

### Vor Go-Live

- [ ] `JWT_SECRET` sicher gesetzt (min. 32 Zeichen, zufällig)
- [ ] `CRON_SECRET` sicher gesetzt (min. 32 Zeichen, zufällig)
- [ ] `CORS_ORIGIN` auf Production-Domain beschränkt
- [ ] `NODE_ENV=production` gesetzt
- [ ] HTTPS aktiv und erzwungen
- [ ] Alle `.env.example` Defaults ersetzt
- [ ] Keine Debug-Logs in Production
- [ ] Error-Nachrichten sanitized (keine Stack-Traces)

### Regelmäßig prüfen

- [ ] Dependencies auf Sicherheitslücken (`npm audit`)
- [ ] Zugriffsrechte auf Datenbank
- [ ] Backup-Integrität
- [ ] Log-Überwachung auf verdächtige Aktivitäten

## Dependency-Sicherheit

### Automatische Prüfung

```bash
# Node.js Dependencies prüfen
npm audit

# Sicherheitslücken beheben
npm audit fix

# Python Dependencies prüfen (ai-worker)
pip-audit
```

### Empfohlene Tools

- **Dependabot** - Automatische Dependency-Updates
- **Snyk** - Kontinuierliche Schwachstellen-Überwachung
- **GitHub Security Alerts** - Benachrichtigungen aktivieren

## Incident Response

### Bei einem Sicherheitsvorfall

1. **Isolieren** - Betroffene Systeme isolieren
2. **Analysieren** - Umfang des Vorfalls bestimmen
3. **Beheben** - Schwachstelle schließen
4. **Benachrichtigen** - Betroffene Nutzer informieren (falls erforderlich)
5. **Dokumentieren** - Vorfall und Maßnahmen dokumentieren
6. **Verbessern** - Prozesse anpassen

## Kontakt

- **Sicherheitsprobleme:** security@familien-lokal.de
- **Allgemeine Fragen:** info@familien-lokal.de

---

Letzte Aktualisierung: Januar 2026
