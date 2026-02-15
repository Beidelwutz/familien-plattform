#!/usr/bin/env node
/**
 * Misst die Antwortzeit von GET /api/admin/dashboard.
 * Nutzung:
 *   node scripts/dashboard-timing.mjs
 *   API_URL=https://api.kiezling.com AUTH_TOKEN=<token> node scripts/dashboard-timing.mjs
 *
 * Token für Production: Im Browser einloggen (Admin), DevTools → Application → Local Storage
 * → auth_token kopieren (oder Network-Tab: Request Headers → Authorization → Bearer-Wert).
 */
const API_URL = process.env.API_URL || 'http://localhost:4000';
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';

const url = `${API_URL.replace(/\/$/, '')}/api/admin/dashboard`;
const start = Date.now();

const res = await fetch(url, {
  headers: AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {},
});
const duration = Date.now() - start;
const ok = res.ok;

let body = null;
try {
  body = await res.json();
} catch {
  body = await res.text();
}

console.log('Dashboard-Timing');
console.log('URL:', url);
console.log('Status:', res.status, res.statusText);
console.log('Dauer:', duration, 'ms');
if (body?.success === true && body?.data) {
  console.log('Daten: stats, duplicates, trends, teaser vorhanden:', !!body.data.stats, !!body.data.duplicatesTotal, !!body.data.trends, !!body.data.teaser);
}
if (!ok) {
  console.log('Body:', typeof body === 'object' ? JSON.stringify(body).slice(0, 200) : body);
  if (!AUTH_TOKEN && res.status === 401) {
    console.log('\nHinweis: Für eingeloggte Endpoints AUTH_TOKEN setzen (z.B. aus Browser DevTools nach Login).');
  }
  process.exit(1);
}
console.log('OK');
