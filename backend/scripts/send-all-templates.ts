/**
 * Sendet alle E-Mail-Vorlagen an eine Adresse (Vorschau/Test).
 *
 * Verwendung: npx tsx scripts/send-all-templates.ts <email@beispiel.de>
 */

import 'dotenv/config';
import {
  sendWelcomeEmail,
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendPasswordChangedEmail,
  sendAccountLockedEmail,
  sendEmailChangedEmail,
  sendAccountDeletedEmail,
  sendProviderRegistrationEmail,
  sendProviderApprovedEmail,
  sendProviderRejectedEmail,
  sendEventSubmittedEmail,
  sendEventApprovedEmail,
  sendEventRejectedEmail,
  sendEventReminderEmail,
  sendWeeklyDigestEmail,
  sendWishlistUpdateEmail,
  sendContactConfirmationEmail,
} from '../src/lib/email.js';

const TO = process.argv[2] || 'pepebauer5@gmail.com';

/** Resend erlaubt max. 2 Anfragen/Sekunde – Pause zwischen E-Mails (ms) */
const DELAY_MS = 600;

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function run() {
  console.log('\n📬 Sende alle E-Mail-Vorlagen an:', TO);
  console.log('   (Resend-Limit: 2/s → Pause', DELAY_MS, 'ms zwischen E-Mails)\n');
  console.log('═'.repeat(55));

  const results: { name: string; ok: boolean; err?: string }[] = [];

  const send = async (name: string, fn: () => Promise<boolean>) => {
    const ok = await fn();
    results.push({ name, ok });
    await delay(DELAY_MS);
  };

  // A1: Willkommen
  await send('A1 Willkommen', () => sendWelcomeEmail(TO));

  // A2: E-Mail-Verifizierung
  await send('A2 E-Mail bestätigen', () => sendVerificationEmail(TO, 'demo-verification-token-123'));

  // A3: Passwort zurücksetzen
  await send('A3 Passwort zurücksetzen', () => sendPasswordResetEmail(TO, 'demo-reset-token-456'));

  // A4: Passwort geändert
  await send('A4 Passwort geändert', () => sendPasswordChangedEmail(TO));

  // A5: Konto gesperrt
  await send('A5 Konto gesperrt', () => sendAccountLockedEmail(TO, 15));

  // A6: E-Mail geändert (geht an alte Adresse = TO)
  await send('A6 E-Mail geändert', () => sendEmailChangedEmail(TO, 'neue-email@beispiel.de'));

  // A7: Konto gelöscht
  await send('A7 Konto gelöscht', () => sendAccountDeletedEmail(TO));

  // B1: Anbieter-Registrierung
  await send('B1 Anbieter-Registrierung', () => sendProviderRegistrationEmail(TO, 'Familienzentrum Musterstadt'));

  // B2: Anbieter freigeschaltet
  await send('B2 Anbieter freigeschaltet', () => sendProviderApprovedEmail(TO, 'Familienzentrum Musterstadt'));

  // B3: Anbieter abgelehnt
  await send('B3 Anbieter abgelehnt', () =>
    sendProviderRejectedEmail(TO, 'Familienzentrum Musterstadt', 'Unvollständige Angaben. Bitte Dokumente nachreichen.'),
  );

  // B4: Event eingereicht
  await send('B4 Event eingereicht', () => sendEventSubmittedEmail(TO, 'Kinderflohmarkt im Park', 'evt-demo-001'));

  // B5: Event freigeschaltet
  await send('B5 Event freigeschaltet', () =>
    sendEventApprovedEmail(TO, 'Kinderflohmarkt im Park', 'kinderflohmarkt-im-park'),
  );

  // B6: Event abgelehnt
  await send('B6 Event abgelehnt', () =>
    sendEventRejectedEmail(TO, 'Kinderflohmarkt im Park', 'evt-demo-001', 'Kein klarer Familienbezug. Bitte Beschreibung anpassen.'),
  );

  // C1: Event-Erinnerung
  const inTwoDays = new Date();
  inTwoDays.setDate(inTwoDays.getDate() + 2);
  inTwoDays.setHours(14, 0, 0, 0);
  await send('C1 Event-Erinnerung', () =>
    sendEventReminderEmail(TO, {
      title: 'Kinderflohmarkt im Park',
      slug: 'kinderflohmarkt-im-park',
      date: inTwoDays,
      location: 'Stadtpark Karlsruhe',
    }),
  );

  // C2: Wöchentlicher Digest
  await send('C2 Wöchentlicher Digest', () =>
    sendWeeklyDigestEmail(TO, [
      { title: 'Basteln für Kinder', slug: 'basteln-fuer-kinder', date: 'Sa, 8. Feb 2025', priceType: 'free' },
      { title: 'Musikworkshop', slug: 'musikworkshop', date: 'So, 9. Feb 2025', priceType: 'paid' },
      { title: 'Vorlesestunde', slug: 'vorlesestunde', date: 'Mo, 10. Feb 2025', priceType: 'free' },
    ]),
  );

  // C3: Merklisten-Update
  await send('C3 Merklisten-Update', () =>
    sendWishlistUpdateEmail(TO, [
      {
        title: 'Kinderflohmarkt im Park',
        slug: 'kinderflohmarkt-im-park',
        changeType: 'date_changed',
        details: 'Neuer Termin: 15. Februar 2025, 10–14 Uhr',
      },
      {
        title: 'Basteln für Kinder',
        slug: 'basteln-fuer-kinder',
        changeType: 'location_changed',
        details: 'Ort: Stadtbibliothek, Raum 2',
      },
    ]),
  );

  // D1: Kontaktbestätigung
  await send('D1 Kontaktbestätigung', () =>
    sendContactConfirmationEmail(TO, 'Max Mustermann', 'Frage zu Events für Kinder'),
  );

  // Auswertung
  console.log('\n📊 Ergebnis:\n');
  let ok = 0;
  for (const r of results) {
    const icon = r.ok ? '✅' : '❌';
    console.log(`   ${icon} ${r.name}`);
    if (r.ok) ok++;
  }
  console.log(`\n   Gesendet: ${ok}/${results.length}`);
  if (ok < results.length) {
    console.log('   Fehlgeschlagen:', results.length - ok);
    process.exit(1);
  }
  console.log('\n🎉 Alle Vorlagen wurden gesendet. Postfach prüfen:', TO, '\n');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
