import { Resend } from 'resend';
import { logger } from './logger.js';

// Initialize Resend client
const resend = process.env.RESEND_API_KEY 
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

// Email configuration
const FROM_EMAIL = process.env.EMAIL_FROM || 'Kiezling <noreply@kiezling.com>';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

export interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

/**
 * Send an email using Resend
 * Falls back to console logging in development if no API key is configured
 */
export async function sendEmail(options: EmailOptions): Promise<boolean> {
  const { to, subject, html, text } = options;

  // Development mode: log to console if no API key
  if (!resend) {
    logger.warn('No RESEND_API_KEY configured, logging email instead');
    logger.info('EMAIL_SEND', {
      to,
      subject,
      html: html.substring(0, 500) + '...',
    });
    return true;
  }

  try {
    const { data, error } = await resend.emails.send({
      from: FROM_EMAIL,
      to,
      subject,
      html,
      text: text || stripHtml(html),
    });

    if (error) {
      logger.error('Failed to send email', { error, to, subject });
      return false;
    }

    logger.info('Email sent successfully', { id: data?.id, to, subject });
    return true;
  } catch (error) {
    logger.error('Email send error', { error, to, subject });
    return false;
  }
}

/**
 * Send password reset email
 */
export async function sendPasswordResetEmail(
  email: string, 
  resetToken: string
): Promise<boolean> {
  const resetUrl = `${FRONTEND_URL}/passwort-reset?token=${resetToken}`;

  const html = `
<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Passwort zurücksetzen</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
    <h1 style="color: white; margin: 0; font-size: 24px;">Kiezling</h1>
  </div>
  
  <div style="background: #f9fafb; padding: 30px; border-radius: 0 0 12px 12px;">
    <h2 style="color: #1f2937; margin-top: 0;">Passwort zurücksetzen</h2>
    
    <p>Hallo,</p>
    
    <p>Du hast eine Anfrage zum Zurücksetzen deines Passworts gestellt. Klicke auf den Button unten, um ein neues Passwort zu erstellen:</p>
    
    <div style="text-align: center; margin: 30px 0;">
      <a href="${resetUrl}" style="display: inline-block; background: #6366f1; color: white; text-decoration: none; padding: 14px 28px; border-radius: 8px; font-weight: 600; font-size: 16px;">
        Passwort zurücksetzen
      </a>
    </div>
    
    <p style="color: #6b7280; font-size: 14px;">
      Dieser Link ist aus Sicherheitsgründen nur <strong>1 Stunde</strong> gültig.
    </p>
    
    <p style="color: #6b7280; font-size: 14px;">
      Falls du diese Anfrage nicht gestellt hast, kannst du diese E-Mail ignorieren. Dein Passwort wird nicht geändert.
    </p>
    
    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 30px 0;">
    
    <p style="color: #9ca3af; font-size: 12px; margin-bottom: 0;">
      Falls der Button nicht funktioniert, kopiere diesen Link in deinen Browser:<br>
      <a href="${resetUrl}" style="color: #6366f1; word-break: break-all;">${resetUrl}</a>
    </p>
  </div>
  
  <div style="text-align: center; padding: 20px; color: #9ca3af; font-size: 12px;">
    <p>&copy; ${new Date().getFullYear()} Kiezling. Alle Rechte vorbehalten.</p>
    <p>
      <a href="${FRONTEND_URL}/datenschutz" style="color: #9ca3af;">Datenschutz</a> |
      <a href="${FRONTEND_URL}/impressum" style="color: #9ca3af;">Impressum</a>
    </p>
  </div>
</body>
</html>
  `.trim();

  return sendEmail({
    to: email,
    subject: 'Passwort zurücksetzen - Kiezling',
    html,
  });
}

/**
 * Send welcome email after registration
 */
export async function sendWelcomeEmail(email: string): Promise<boolean> {
  const html = `
<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Willkommen bei Kiezling</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
    <h1 style="color: white; margin: 0; font-size: 24px;">Willkommen bei Kiezling!</h1>
  </div>
  
  <div style="background: #f9fafb; padding: 30px; border-radius: 0 0 12px 12px;">
    <h2 style="color: #1f2937; margin-top: 0;">Schön, dass du dabei bist!</h2>
    
    <p>Hallo,</p>
    
    <p>Herzlich willkommen bei <strong>Kiezling</strong> – deiner Plattform für Familienaktivitäten in Karlsruhe und Umgebung!</p>
    
    <p>Mit deinem Konto kannst du:</p>
    
    <ul style="padding-left: 20px;">
      <li>Events speichern und eine Merkliste erstellen</li>
      <li>Personalisierte Tagespläne für deine Familie generieren</li>
      <li>Benachrichtigungen für neue Events erhalten</li>
    </ul>
    
    <div style="text-align: center; margin: 30px 0;">
      <a href="${FRONTEND_URL}/entdecken" style="display: inline-block; background: #6366f1; color: white; text-decoration: none; padding: 14px 28px; border-radius: 8px; font-weight: 600; font-size: 16px;">
        Events entdecken
      </a>
    </div>
    
    <p style="color: #6b7280; font-size: 14px;">
      Tipp: Nutze den <a href="${FRONTEND_URL}/plan" style="color: #6366f1;">KI-Planer</a>, um in Sekunden einen perfekten Familientag zu erstellen!
    </p>
    
    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 30px 0;">
    
    <p style="color: #6b7280; font-size: 14px; margin-bottom: 0;">
      Bei Fragen erreichst du uns unter <a href="mailto:support@kiezling.com" style="color: #6366f1;">support@kiezling.com</a>
    </p>
  </div>
  
  <div style="text-align: center; padding: 20px; color: #9ca3af; font-size: 12px;">
    <p>&copy; ${new Date().getFullYear()} Kiezling. Alle Rechte vorbehalten.</p>
    <p>
      <a href="${FRONTEND_URL}/datenschutz" style="color: #9ca3af;">Datenschutz</a> |
      <a href="${FRONTEND_URL}/impressum" style="color: #9ca3af;">Impressum</a>
    </p>
  </div>
</body>
</html>
  `.trim();

  return sendEmail({
    to: email,
    subject: 'Willkommen bei Kiezling!',
    html,
  });
}

/**
 * Send email verification email
 */
export async function sendVerificationEmail(
  email: string,
  verificationToken: string
): Promise<boolean> {
  const verifyUrl = `${FRONTEND_URL}/email-bestaetigen?token=${verificationToken}`;

  const html = `
<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>E-Mail bestätigen</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
    <h1 style="color: white; margin: 0; font-size: 24px;">Kiezling</h1>
  </div>
  
  <div style="background: #f9fafb; padding: 30px; border-radius: 0 0 12px 12px;">
    <h2 style="color: #1f2937; margin-top: 0;">Bestätige deine E-Mail-Adresse</h2>
    
    <p>Hallo,</p>
    
    <p>Vielen Dank für deine Registrierung bei Kiezling! Bitte bestätige deine E-Mail-Adresse, indem du auf den Button unten klickst:</p>
    
    <div style="text-align: center; margin: 30px 0;">
      <a href="${verifyUrl}" style="display: inline-block; background: #10b981; color: white; text-decoration: none; padding: 14px 28px; border-radius: 8px; font-weight: 600; font-size: 16px;">
        E-Mail bestätigen
      </a>
    </div>
    
    <p style="color: #6b7280; font-size: 14px;">
      Dieser Link ist <strong>24 Stunden</strong> gültig.
    </p>
    
    <p style="color: #6b7280; font-size: 14px;">
      Falls du dich nicht bei Kiezling registriert hast, kannst du diese E-Mail ignorieren.
    </p>
    
    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 30px 0;">
    
    <p style="color: #9ca3af; font-size: 12px; margin-bottom: 0;">
      Falls der Button nicht funktioniert, kopiere diesen Link in deinen Browser:<br>
      <a href="${verifyUrl}" style="color: #6366f1; word-break: break-all;">${verifyUrl}</a>
    </p>
  </div>
  
  <div style="text-align: center; padding: 20px; color: #9ca3af; font-size: 12px;">
    <p>&copy; ${new Date().getFullYear()} Kiezling. Alle Rechte vorbehalten.</p>
    <p>
      <a href="${FRONTEND_URL}/datenschutz" style="color: #9ca3af;">Datenschutz</a> |
      <a href="${FRONTEND_URL}/impressum" style="color: #9ca3af;">Impressum</a>
    </p>
  </div>
</body>
</html>
  `.trim();

  return sendEmail({
    to: email,
    subject: 'E-Mail bestätigen - Kiezling',
    html,
  });
}

/**
 * Simple HTML to text converter
 */
function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
