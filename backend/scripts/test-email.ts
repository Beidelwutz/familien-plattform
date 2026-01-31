/**
 * E-Mail Test-Skript
 * 
 * Verwendung:
 *   npx tsx scripts/test-email.ts <deine-email@beispiel.de>
 * 
 * Testet alle E-Mail-Typen (transactional, support, marketing)
 */

import 'dotenv/config';
import { Resend } from 'resend';

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || 'Kiezling <noreply@kiezling.com>';
const EMAIL_FROM_SUPPORT = process.env.EMAIL_FROM_SUPPORT || 'Kiezling Support <support@kiezling.com>';
const EMAIL_FROM_TEAM = process.env.EMAIL_FROM_TEAM || 'Kiezling Team <team@kiezling.com>';
const REPLY_TO = process.env.EMAIL_REPLY_TO || 'support@kiezling.com';

async function testEmails(recipientEmail: string) {
  console.log('\n🧪 Kiezling E-Mail Test\n');
  console.log('═'.repeat(50));
  
  // Prüfe API Key
  if (!RESEND_API_KEY) {
    console.error('\n❌ RESEND_API_KEY ist nicht konfiguriert!');
    console.error('   Bitte trage den API Key in backend/.env ein:');
    console.error('   RESEND_API_KEY="re_xxxxxxxxxxxx"\n');
    process.exit(1);
  }
  
  console.log(`\n📧 Empfänger: ${recipientEmail}`);
  console.log(`📤 Reply-To:  ${REPLY_TO}\n`);
  
  const resend = new Resend(RESEND_API_KEY);
  
  const tests = [
    {
      name: 'Transactional (noreply)',
      from: EMAIL_FROM,
      subject: '🧪 Test: Transaktionale E-Mail',
      description: 'System-E-Mails wie Verifizierung, Passwort-Reset',
    },
    {
      name: 'Support',
      from: EMAIL_FROM_SUPPORT,
      subject: '🧪 Test: Support E-Mail',
      description: 'Anbieter-Kommunikation, Kontaktbestätigung',
    },
    {
      name: 'Marketing (Team)',
      from: EMAIL_FROM_TEAM,
      subject: '🧪 Test: Marketing E-Mail',
      description: 'Newsletter, Digest, Event-Erinnerungen',
    },
  ];
  
  const results: { name: string; success: boolean; error?: string }[] = [];
  
  for (const test of tests) {
    console.log(`\n📨 Sende: ${test.name}`);
    console.log(`   Von: ${test.from}`);
    
    const html = `
<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <title>${test.subject}</title>
</head>
<body style="font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
    <h1 style="color: white; margin: 0; font-size: 24px;">Kiezling E-Mail Test</h1>
  </div>
  
  <div style="background: #f9fafb; padding: 30px; border-radius: 0 0 12px 12px;">
    <h2 style="color: #1f2937; margin-top: 0;">✅ E-Mail erfolgreich zugestellt!</h2>
    
    <p>Dies ist eine Test-E-Mail für den <strong>${test.name}</strong> Absender.</p>
    
    <div style="background: white; border: 1px solid #e5e7eb; padding: 16px; margin: 20px 0; border-radius: 8px;">
      <p style="margin: 0; color: #6b7280; font-size: 14px;">
        <strong>Absender-Typ:</strong> ${test.name}<br>
        <strong>Von:</strong> ${test.from}<br>
        <strong>Verwendung:</strong> ${test.description}<br>
        <strong>Zeitstempel:</strong> ${new Date().toLocaleString('de-DE')}
      </p>
    </div>
    
    <p style="color: #6b7280; font-size: 14px;">
      Wenn du diese E-Mail siehst, funktioniert der E-Mail-Versand über Resend mit der verifizierten Domain <strong>kiezling.com</strong> korrekt.
    </p>
    
    <div style="text-align: center; margin: 30px 0;">
      <a href="https://www.kiezling.com" style="display: inline-block; background: #6366f1; color: white; text-decoration: none; padding: 14px 28px; border-radius: 8px; font-weight: 600; font-size: 16px;">
        Zur Kiezling Website
      </a>
    </div>
  </div>
  
  <div style="text-align: center; padding: 20px; color: #9ca3af; font-size: 12px;">
    <p>&copy; ${new Date().getFullYear()} Kiezling. Test-E-Mail.</p>
  </div>
</body>
</html>
    `;
    
    try {
      const { data, error } = await resend.emails.send({
        from: test.from,
        replyTo: REPLY_TO,
        to: recipientEmail,
        subject: test.subject,
        html,
      });
      
      if (error) {
        console.log(`   ❌ Fehler: ${error.message}`);
        results.push({ name: test.name, success: false, error: error.message });
      } else {
        console.log(`   ✅ Erfolgreich gesendet (ID: ${data?.id})`);
        results.push({ name: test.name, success: true });
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unbekannter Fehler';
      console.log(`   ❌ Exception: ${errorMsg}`);
      results.push({ name: test.name, success: false, error: errorMsg });
    }
    
    // Kurze Pause zwischen E-Mails
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  // Zusammenfassung
  console.log('\n' + '═'.repeat(50));
  console.log('\n📊 Zusammenfassung:\n');
  
  const successful = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  
  for (const result of results) {
    console.log(`   ${result.success ? '✅' : '❌'} ${result.name}${result.error ? `: ${result.error}` : ''}`);
  }
  
  console.log(`\n   Erfolgreich: ${successful}/${results.length}`);
  
  if (failed > 0) {
    console.log(`   Fehlgeschlagen: ${failed}/${results.length}`);
    console.log('\n⚠️  Einige E-Mails konnten nicht gesendet werden.');
    console.log('   Prüfe den API Key und die Domain-Verifizierung bei Resend.\n');
    process.exit(1);
  } else {
    console.log('\n🎉 Alle E-Mails wurden erfolgreich gesendet!');
    console.log(`   Prüfe dein Postfach: ${recipientEmail}\n`);
  }
}

// Main
const email = process.argv[2];

if (!email) {
  console.error('\n❌ Bitte gib eine E-Mail-Adresse an!\n');
  console.error('   Verwendung: npx tsx scripts/test-email.ts <email@beispiel.de>\n');
  process.exit(1);
}

// Einfache E-Mail-Validierung
if (!email.includes('@') || !email.includes('.')) {
  console.error('\n❌ Ungültige E-Mail-Adresse!\n');
  process.exit(1);
}

testEmails(email);
