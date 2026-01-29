# Cron Setup für Trending-Berechnung

Das Search Trending System benötigt regelmäßige Berechnung der Trending-Begriffe (alle 30-60 Minuten).

## Endpoint

```
POST /api/admin/trends/compute
```

### Authentifizierung

Der Endpoint erfordert einen `X-Cron-Secret` Header mit dem in `.env` definierten `CRON_SECRET`.

## Setup-Optionen

### Option 1: Vercel Cron (empfohlen für Vercel-Hosting)

In `vercel.json` hinzufügen:

```json
{
  "crons": [{
    "path": "/api/admin/trends/compute",
    "schedule": "*/30 * * * *"
  }]
}
```

**Wichtig**: Environment Variable `CRON_SECRET` in Vercel Project Settings setzen.

Vercel sendet automatisch den Header `x-vercel-cron-signature`. Unser Endpoint prüft `X-Cron-Secret`.

### Option 2: Externes Cron-System

Verwende einen externen Cron-Service wie:
- cron-job.org
- EasyCron
- GitHub Actions
- AWS EventBridge

#### Beispiel: cURL Command

```bash
curl -X POST https://api.kiezling.com/api/admin/trends/compute \
  -H "X-Cron-Secret: YOUR_CRON_SECRET" \
  -H "Content-Type: application/json"
```

#### Beispiel: GitHub Actions

`.github/workflows/compute-trends.yml`:

```yaml
name: Compute Trending Terms

on:
  schedule:
    - cron: '*/30 * * * *'  # Every 30 minutes

jobs:
  compute:
    runs-on: ubuntu-latest
    steps:
      - name: Trigger Compute
        run: |
          curl -X POST ${{ secrets.API_URL }}/api/admin/trends/compute \
            -H "X-Cron-Secret: ${{ secrets.CRON_SECRET }}" \
            -H "Content-Type: application/json"
```

Secrets in GitHub Repository Settings setzen:
- `API_URL`: https://api.kiezling.com
- `CRON_SECRET`: (Dein Secret aus .env)

## Manuelle Berechnung

Als Admin kannst du auch manuell über das Admin-Panel berechnen:

1. Gehe zu `/admin/trends`
2. Klicke auf "Trends jetzt berechnen"

## Initial Setup

Nach dem ersten Deployment:

1. `.env` mit `CRON_SECRET` setzen
2. Cron-System konfigurieren (siehe oben)
3. **Ersten Compute manuell triggern**, um initiale Daten zu haben
4. Überprüfen unter `/admin/trends`, ob Daten vorhanden sind

## Monitoring

Der `/admin/trends` Tab zeigt:
- Anzahl berechneter Terms
- Letztes Compute-Datum
- Trend-Scores und Ratios

## Troubleshooting

### "Keine Trending Terms berechnet"

Mögliche Ursachen:
1. Noch keine Suchanfragen in `search_query_logs`
2. Nicht genug Daten (mindestens 10 Searches in 24h + Ratio >= 2)
3. Compute-Job wurde noch nie ausgeführt

**Lösung**: 
- Test-Searches generieren über die normale Suche
- Manuell "Trends jetzt berechnen" klicken

### 401 Unauthorized beim Cron

- `CRON_SECRET` in `.env` setzen
- Header `X-Cron-Secret` korrekt senden
- Bei Vercel: Environment Variable in Project Settings setzen

### Performance

- Job dauert normalerweise < 2 Sekunden
- Bei vielen Daten (100k+ Logs): Eventuell Aggregation optimieren oder Interval erhöhen

## Datenbank-Cleanup (Optional)

Alte `search_query_logs` Einträge können nach 30 Tagen gelöscht werden:

```sql
DELETE FROM search_query_logs 
WHERE created_at < NOW() - INTERVAL '30 days';
```

Alte `trending_terms` (behalte nur die letzten 7 Tage):

```sql
DELETE FROM trending_terms 
WHERE computed_at < NOW() - INTERVAL '7 days';
```

Diese Cleanups können als separater Cron-Job laufen (1x täglich).
