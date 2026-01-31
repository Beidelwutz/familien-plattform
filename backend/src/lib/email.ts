import { Resend } from 'resend';
import { logger } from './logger.js';

// Initialize Resend client
const resend = process.env.RESEND_API_KEY 
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

// ============================================
// EMAIL CONFIGURATION (Domain: kiezling.com)
// ============================================

// Absender-Adressen für verschiedene E-Mail-Typen
const EMAIL_FROM = {
  // Standard: Automatische System-E-Mails (Verifizierung, Passwort-Reset, etc.)
  default: process.env.EMAIL_FROM || 'Kiezling <noreply@kiezling.com>',
  // Support: Für Anbieter-Kommunikation und Kontaktbestätigungen
  support: process.env.EMAIL_FROM_SUPPORT || 'Kiezling Support <support@kiezling.com>',
  // Team: Für Newsletter, Digest und Engagement-E-Mails
  team: process.env.EMAIL_FROM_TEAM || 'Kiezling Team <team@kiezling.com>',
};

// Reply-To Adresse für alle E-Mails
const REPLY_TO_EMAIL = process.env.EMAIL_REPLY_TO || 'support@kiezling.com';

// Frontend URL für Links in E-Mails
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

// Support E-Mail für Anzeige in E-Mail-Texten
const SUPPORT_EMAIL = 'support@kiezling.com';

// E-Mail-Typ zur Bestimmung des Absenders
export type EmailSenderType = 'transactional' | 'support' | 'marketing';

// ============================================
// TYPES & INTERFACES
// ============================================

export interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
  senderType?: EmailSenderType;
  replyTo?: string;
}

export interface EmailTemplateOptions {
  title: string;
  headerText?: string;
  content: string;
  buttonText?: string;
  buttonUrl?: string;
  buttonColor?: 'primary' | 'success' | 'danger';
  showFooterLinks?: boolean;
  fallbackUrl?: string;
}

// ============================================
// DESIGN CONSTANTS
// ============================================

const COLORS = {
  primary: '#6366f1',
  primaryDark: '#4F46E5',
  success: '#10b981',
  danger: '#EF4444',
  warning: '#F59E0B',
  background: '#f9fafb',
  textPrimary: '#1f2937',
  textBody: '#333333',
  textSecondary: '#6b7280',
  textMuted: '#9ca3af',
  border: '#e5e7eb',
  white: '#ffffff',
};

const GRADIENT = 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)';

// ============================================
// BASE TEMPLATE FUNCTION
// ============================================

/**
 * Generate consistent HTML email template
 * All emails use this base template for consistent branding
 */
function baseEmailTemplate(options: EmailTemplateOptions): string {
  const {
    title,
    headerText,
    content,
    buttonText,
    buttonUrl,
    buttonColor = 'primary',
    showFooterLinks = true,
    fallbackUrl,
  } = options;

  const buttonBgColor = buttonColor === 'success' 
    ? COLORS.success 
    : buttonColor === 'danger' 
      ? COLORS.danger 
      : COLORS.primary;

  const buttonHtml = buttonText && buttonUrl ? `
    <div style="text-align: center; margin: 30px 0;">
      <a href="${buttonUrl}" style="display: inline-block; background: ${buttonBgColor}; color: white; text-decoration: none; padding: 14px 28px; border-radius: 8px; font-weight: 600; font-size: 16px;">
        ${buttonText}
      </a>
    </div>
  ` : '';

  const fallbackHtml = fallbackUrl ? `
    <hr style="border: none; border-top: 1px solid ${COLORS.border}; margin: 30px 0;">
    <p style="color: ${COLORS.textMuted}; font-size: 12px; margin-bottom: 0;">
      Falls der Button nicht funktioniert, kopiere diesen Link in deinen Browser:<br>
      <a href="${fallbackUrl}" style="color: ${COLORS.primary}; word-break: break-all;">${fallbackUrl}</a>
    </p>
  ` : '';

  const footerLinksHtml = showFooterLinks ? `
    <p>
      <a href="${FRONTEND_URL}/datenschutz" style="color: ${COLORS.textMuted};">Datenschutz</a> |
      <a href="${FRONTEND_URL}/impressum" style="color: ${COLORS.textMuted};">Impressum</a>
    </p>
  ` : '';

  return `
<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
</head>
<body style="font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: ${COLORS.textBody}; max-width: 600px; margin: 0 auto; padding: 20px; background-color: ${COLORS.white};">
  <div style="background: ${GRADIENT}; padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
    <h1 style="color: white; margin: 0; font-size: 24px;">${headerText || 'Kiezling'}</h1>
  </div>
  
  <div style="background: ${COLORS.background}; padding: 30px; border-radius: 0 0 12px 12px;">
    ${content}
    ${buttonHtml}
    ${fallbackHtml}
  </div>
  
  <div style="text-align: center; padding: 20px; color: ${COLORS.textMuted}; font-size: 12px;">
    <p>&copy; ${new Date().getFullYear()} Kiezling. Alle Rechte vorbehalten.</p>
    ${footerLinksHtml}
  </div>
</body>
</html>
  `.trim();
}

// ============================================
// CORE EMAIL FUNCTION
// ============================================

/**
 * Bestimmt die From-Adresse basierend auf dem E-Mail-Typ
 */
function getFromAddress(senderType?: EmailSenderType): string {
  switch (senderType) {
    case 'support':
      return EMAIL_FROM.support;
    case 'marketing':
      return EMAIL_FROM.team;
    case 'transactional':
    default:
      return EMAIL_FROM.default;
  }
}

/**
 * Send an email using Resend
 * Falls back to console logging in development if no API key is configured
 * 
 * @param options.senderType - 'transactional' (default), 'support', oder 'marketing'
 * @param options.replyTo - Optional: Reply-To Adresse (default: support@kiezling.com)
 */
export async function sendEmail(options: EmailOptions): Promise<boolean> {
  const { to, subject, html, text, senderType, replyTo } = options;

  const fromAddress = getFromAddress(senderType);
  const replyToAddress = replyTo || REPLY_TO_EMAIL;

  // Development mode: log to console if no API key
  if (!resend) {
    logger.warn('No RESEND_API_KEY configured, logging email instead');
    logger.info('EMAIL_SEND', {
      from: fromAddress,
      replyTo: replyToAddress,
      to,
      subject,
      html: html.substring(0, 500) + '...',
    });
    return true;
  }

  try {
    const { data, error } = await resend.emails.send({
      from: fromAddress,
      replyTo: replyToAddress,
      to,
      subject,
      html,
      text: text || stripHtml(html),
    });

    if (error) {
      logger.error('Failed to send email', { error, from: fromAddress, to, subject });
      return false;
    }

    logger.info('Email sent successfully', { id: data?.id, from: fromAddress, to, subject });
    return true;
  } catch (error) {
    logger.error('Email send error', { error, from: fromAddress, to, subject });
    return false;
  }
}

// ============================================
// KATEGORIE A: AUTHENTIFIZIERUNG
// ============================================

/**
 * A1: Send welcome email after registration
 */
export async function sendWelcomeEmail(email: string): Promise<boolean> {
  const html = baseEmailTemplate({
    title: 'Willkommen bei Kiezling',
    headerText: 'Willkommen bei Kiezling!',
    content: `
      <h2 style="color: ${COLORS.textPrimary}; margin-top: 0;">Schön, dass du dabei bist!</h2>
      
      <p>Hallo,</p>
      
      <p>Herzlich willkommen bei <strong>Kiezling</strong> – deiner Plattform für Familienaktivitäten in Karlsruhe und Umgebung!</p>
      
      <p>Mit deinem Konto kannst du:</p>
      
      <ul style="padding-left: 20px;">
        <li>Events speichern und eine Merkliste erstellen</li>
        <li>Personalisierte Tagespläne für deine Familie generieren</li>
        <li>Benachrichtigungen für neue Events erhalten</li>
      </ul>
      
      <p style="color: ${COLORS.textSecondary}; font-size: 14px; margin-top: 20px;">
        Tipp: Nutze den <a href="${FRONTEND_URL}/plan" style="color: ${COLORS.primary};">KI-Planer</a>, um in Sekunden einen perfekten Familientag zu erstellen!
      </p>
      
      <hr style="border: none; border-top: 1px solid ${COLORS.border}; margin: 30px 0;">
      
      <p style="color: ${COLORS.textSecondary}; font-size: 14px; margin-bottom: 0;">
        Bei Fragen erreichst du uns unter <a href="mailto:${SUPPORT_EMAIL}" style="color: ${COLORS.primary};">${SUPPORT_EMAIL}</a>
      </p>
    `,
    buttonText: 'Events entdecken',
    buttonUrl: `${FRONTEND_URL}/entdecken`,
    buttonColor: 'primary',
  });

  return sendEmail({
    to: email,
    subject: 'Willkommen bei Kiezling!',
    html,
    senderType: 'transactional',
  });
}

/**
 * A2: Send email verification email
 */
export async function sendVerificationEmail(
  email: string,
  verificationToken: string
): Promise<boolean> {
  const verifyUrl = `${FRONTEND_URL}/email-bestaetigen?token=${verificationToken}`;

  const html = baseEmailTemplate({
    title: 'E-Mail bestätigen',
    headerText: 'Kiezling',
    content: `
      <h2 style="color: ${COLORS.textPrimary}; margin-top: 0;">Bestätige deine E-Mail-Adresse</h2>
      
      <p>Hallo,</p>
      
      <p>Vielen Dank für deine Registrierung bei Kiezling! Bitte bestätige deine E-Mail-Adresse, indem du auf den Button unten klickst:</p>
      
      <p style="color: ${COLORS.textSecondary}; font-size: 14px;">
        Dieser Link ist <strong>24 Stunden</strong> gültig.
      </p>
      
      <p style="color: ${COLORS.textSecondary}; font-size: 14px;">
        Falls du dich nicht bei Kiezling registriert hast, kannst du diese E-Mail ignorieren.
      </p>
    `,
    buttonText: 'E-Mail bestätigen',
    buttonUrl: verifyUrl,
    buttonColor: 'success',
    fallbackUrl: verifyUrl,
  });

  return sendEmail({
    to: email,
    subject: 'E-Mail bestätigen - Kiezling',
    html,
    senderType: 'transactional',
  });
}

/**
 * A3: Send password reset email
 */
export async function sendPasswordResetEmail(
  email: string, 
  resetToken: string
): Promise<boolean> {
  const resetUrl = `${FRONTEND_URL}/passwort-reset?token=${resetToken}`;

  const html = baseEmailTemplate({
    title: 'Passwort zurücksetzen',
    headerText: 'Kiezling',
    content: `
      <h2 style="color: ${COLORS.textPrimary}; margin-top: 0;">Passwort zurücksetzen</h2>
      
      <p>Hallo,</p>
      
      <p>Du hast eine Anfrage zum Zurücksetzen deines Passworts gestellt. Klicke auf den Button unten, um ein neues Passwort zu erstellen:</p>
      
      <p style="color: ${COLORS.textSecondary}; font-size: 14px;">
        Dieser Link ist aus Sicherheitsgründen nur <strong>1 Stunde</strong> gültig.
      </p>
      
      <p style="color: ${COLORS.textSecondary}; font-size: 14px;">
        Falls du diese Anfrage nicht gestellt hast, kannst du diese E-Mail ignorieren. Dein Passwort wird nicht geändert.
      </p>
    `,
    buttonText: 'Passwort zurücksetzen',
    buttonUrl: resetUrl,
    buttonColor: 'primary',
    fallbackUrl: resetUrl,
  });

  return sendEmail({
    to: email,
    subject: 'Passwort zurücksetzen - Kiezling',
    html,
    senderType: 'transactional',
  });
}

/**
 * A4: Send confirmation after password change
 */
export async function sendPasswordChangedEmail(email: string): Promise<boolean> {
  const html = baseEmailTemplate({
    title: 'Passwort geändert',
    headerText: 'Kiezling',
    content: `
      <h2 style="color: ${COLORS.textPrimary}; margin-top: 0;">Dein Passwort wurde geändert</h2>
      
      <p>Hallo,</p>
      
      <p>Dein Passwort für dein Kiezling-Konto wurde erfolgreich geändert.</p>
      
      <p style="color: ${COLORS.textSecondary}; font-size: 14px;">
        <strong>Zeitpunkt:</strong> ${new Date().toLocaleString('de-DE', { 
          dateStyle: 'full', 
          timeStyle: 'short' 
        })}
      </p>
      
      <div style="background: #FEF3C7; border-left: 4px solid ${COLORS.warning}; padding: 16px; margin: 20px 0; border-radius: 4px;">
        <p style="margin: 0; color: #92400E; font-size: 14px;">
          <strong>Warst du das nicht?</strong><br>
          Falls du dein Passwort nicht selbst geändert hast, setze es bitte umgehend zurück und kontaktiere uns unter <a href="mailto:${SUPPORT_EMAIL}" style="color: #92400E;">${SUPPORT_EMAIL}</a>.
        </p>
      </div>
    `,
    buttonText: 'Passwort zurücksetzen',
    buttonUrl: `${FRONTEND_URL}/passwort-vergessen`,
    buttonColor: 'danger',
  });

  return sendEmail({
    to: email,
    subject: 'Passwort geändert - Kiezling',
    html,
    senderType: 'transactional',
  });
}

/**
 * A5: Send notification when account is locked
 */
export async function sendAccountLockedEmail(
  email: string,
  lockoutMinutes: number = 15
): Promise<boolean> {
  const html = baseEmailTemplate({
    title: 'Konto vorübergehend gesperrt',
    headerText: 'Sicherheitshinweis',
    content: `
      <h2 style="color: ${COLORS.textPrimary}; margin-top: 0;">Dein Konto wurde vorübergehend gesperrt</h2>
      
      <p>Hallo,</p>
      
      <p>Wir haben mehrere fehlgeschlagene Anmeldeversuche bei deinem Kiezling-Konto festgestellt.</p>
      
      <p>Aus Sicherheitsgründen wurde dein Konto für <strong>${lockoutMinutes} Minuten</strong> gesperrt.</p>
      
      <div style="background: #FEE2E2; border-left: 4px solid ${COLORS.danger}; padding: 16px; margin: 20px 0; border-radius: 4px;">
        <p style="margin: 0; color: #991B1B; font-size: 14px;">
          <strong>Das warst nicht du?</strong><br>
          Wenn du diese Anmeldeversuche nicht unternommen hast, empfehlen wir dir dringend, dein Passwort zu ändern, sobald die Sperre aufgehoben ist.
        </p>
      </div>
      
      <p style="color: ${COLORS.textSecondary}; font-size: 14px;">
        Nach Ablauf der Sperrzeit kannst du dich wieder normal anmelden. Falls du dein Passwort vergessen hast, nutze bitte die "Passwort vergessen"-Funktion.
      </p>
    `,
    buttonText: 'Passwort zurücksetzen',
    buttonUrl: `${FRONTEND_URL}/passwort-vergessen`,
    buttonColor: 'danger',
  });

  return sendEmail({
    to: email,
    subject: 'Sicherheitswarnung: Konto vorübergehend gesperrt - Kiezling',
    html,
    senderType: 'transactional',
  });
}

/**
 * A6: Send notification when email is changed (to OLD email)
 */
export async function sendEmailChangedEmail(
  oldEmail: string,
  newEmail: string
): Promise<boolean> {
  const html = baseEmailTemplate({
    title: 'E-Mail-Adresse geändert',
    headerText: 'Kiezling',
    content: `
      <h2 style="color: ${COLORS.textPrimary}; margin-top: 0;">Deine E-Mail-Adresse wurde geändert</h2>
      
      <p>Hallo,</p>
      
      <p>Die E-Mail-Adresse für dein Kiezling-Konto wurde geändert.</p>
      
      <p style="color: ${COLORS.textSecondary}; font-size: 14px;">
        <strong>Alte E-Mail:</strong> ${oldEmail}<br>
        <strong>Neue E-Mail:</strong> ${newEmail}<br>
        <strong>Zeitpunkt:</strong> ${new Date().toLocaleString('de-DE', { 
          dateStyle: 'full', 
          timeStyle: 'short' 
        })}
      </p>
      
      <div style="background: #FEF3C7; border-left: 4px solid ${COLORS.warning}; padding: 16px; margin: 20px 0; border-radius: 4px;">
        <p style="margin: 0; color: #92400E; font-size: 14px;">
          <strong>Warst du das nicht?</strong><br>
          Falls du diese Änderung nicht selbst vorgenommen hast, kontaktiere uns bitte umgehend unter <a href="mailto:${SUPPORT_EMAIL}" style="color: #92400E;">${SUPPORT_EMAIL}</a>.
        </p>
      </div>
      
      <p style="color: ${COLORS.textSecondary}; font-size: 14px;">
        Zukünftige E-Mails werden an die neue Adresse gesendet.
      </p>
    `,
  });

  return sendEmail({
    to: oldEmail,
    subject: 'E-Mail-Adresse geändert - Kiezling',
    html,
    senderType: 'transactional',
  });
}

/**
 * A7: Send confirmation when account is deleted
 */
export async function sendAccountDeletedEmail(email: string): Promise<boolean> {
  const html = baseEmailTemplate({
    title: 'Konto gelöscht',
    headerText: 'Auf Wiedersehen',
    content: `
      <h2 style="color: ${COLORS.textPrimary}; margin-top: 0;">Dein Konto wurde gelöscht</h2>
      
      <p>Hallo,</p>
      
      <p>Dein Kiezling-Konto und alle damit verbundenen Daten wurden erfolgreich gelöscht.</p>
      
      <p>Folgende Daten wurden entfernt:</p>
      <ul style="padding-left: 20px; color: ${COLORS.textSecondary};">
        <li>Dein Benutzerprofil</li>
        <li>Deine Merkliste</li>
        <li>Deine gespeicherten Pläne</li>
        <li>Deine Familienprofile</li>
      </ul>
      
      <p style="color: ${COLORS.textSecondary}; font-size: 14px;">
        Wir bedauern, dass du uns verlässt. Falls du deine Meinung änderst, kannst du dich jederzeit wieder registrieren.
      </p>
      
      <hr style="border: none; border-top: 1px solid ${COLORS.border}; margin: 30px 0;">
      
      <p style="color: ${COLORS.textSecondary}; font-size: 14px; margin-bottom: 0;">
        Wir würden uns über dein Feedback freuen. Schreib uns gerne an <a href="mailto:${SUPPORT_EMAIL}" style="color: ${COLORS.primary};">${SUPPORT_EMAIL}</a>, warum du gegangen bist.
      </p>
    `,
  });

  return sendEmail({
    to: email,
    subject: 'Dein Kiezling-Konto wurde gelöscht',
    html,
    senderType: 'transactional',
  });
}

// ============================================
// KATEGORIE B: ANBIETER
// ============================================

/**
 * B1: Send confirmation after provider registration
 */
export async function sendProviderRegistrationEmail(
  email: string,
  providerName: string
): Promise<boolean> {
  const html = baseEmailTemplate({
    title: 'Anbieter-Registrierung eingegangen',
    headerText: 'Willkommen als Anbieter!',
    content: `
      <h2 style="color: ${COLORS.textPrimary}; margin-top: 0;">Vielen Dank für deine Registrierung!</h2>
      
      <p>Hallo,</p>
      
      <p>Deine Registrierung als Anbieter bei Kiezling ist bei uns eingegangen.</p>
      
      <div style="background: ${COLORS.white}; border: 1px solid ${COLORS.border}; padding: 16px; margin: 20px 0; border-radius: 8px;">
        <p style="margin: 0; color: ${COLORS.textSecondary}; font-size: 14px;">
          <strong>Anbieter-Name:</strong> ${providerName}<br>
          <strong>Status:</strong> <span style="color: ${COLORS.warning};">Wird geprüft</span>
        </p>
      </div>
      
      <p><strong>Was passiert als Nächstes?</strong></p>
      <ol style="padding-left: 20px; color: ${COLORS.textSecondary};">
        <li>Unser Team prüft deine Angaben (1-2 Werktage)</li>
        <li>Du erhältst eine Bestätigung per E-Mail</li>
        <li>Nach Freischaltung kannst du sofort Events erstellen</li>
      </ol>
      
      <p style="color: ${COLORS.textSecondary}; font-size: 14px;">
        Bei Fragen erreichst du uns unter <a href="mailto:${SUPPORT_EMAIL}" style="color: ${COLORS.primary};">${SUPPORT_EMAIL}</a>
      </p>
    `,
    buttonText: 'Zum Anbieter-Dashboard',
    buttonUrl: `${FRONTEND_URL}/anbieter/dashboard`,
    buttonColor: 'primary',
  });

  return sendEmail({
    to: email,
    subject: 'Anbieter-Registrierung eingegangen - Kiezling',
    html,
    senderType: 'support',
  });
}

/**
 * B2: Send notification when provider is approved
 */
export async function sendProviderApprovedEmail(
  email: string,
  providerName: string
): Promise<boolean> {
  const html = baseEmailTemplate({
    title: 'Anbieter freigeschaltet',
    headerText: 'Du bist freigeschaltet!',
    content: `
      <h2 style="color: ${COLORS.textPrimary}; margin-top: 0;">Herzlichen Glückwunsch!</h2>
      
      <p>Hallo,</p>
      
      <p>Großartige Neuigkeiten! Dein Anbieter-Profil <strong>"${providerName}"</strong> wurde erfolgreich geprüft und freigeschaltet.</p>
      
      <div style="background: #D1FAE5; border-left: 4px solid ${COLORS.success}; padding: 16px; margin: 20px 0; border-radius: 4px;">
        <p style="margin: 0; color: #065F46; font-size: 14px;">
          <strong>Status:</strong> Aktiv<br>
          Du kannst jetzt Events erstellen und für Familien in Karlsruhe sichtbar werden!
        </p>
      </div>
      
      <p><strong>Erste Schritte:</strong></p>
      <ul style="padding-left: 20px;">
        <li>Erstelle dein erstes Event</li>
        <li>Vervollständige dein Anbieter-Profil</li>
        <li>Füge Bilder und Beschreibungen hinzu</li>
      </ul>
    `,
    buttonText: 'Erstes Event erstellen',
    buttonUrl: `${FRONTEND_URL}/anbieter/events/neu`,
    buttonColor: 'success',
  });

  return sendEmail({
    to: email,
    subject: 'Anbieter-Profil freigeschaltet - Kiezling',
    html,
    senderType: 'support',
  });
}

/**
 * B3: Send notification when provider is rejected
 */
export async function sendProviderRejectedEmail(
  email: string,
  providerName: string,
  reason?: string
): Promise<boolean> {
  const reasonHtml = reason ? `
    <div style="background: #FEE2E2; border-left: 4px solid ${COLORS.danger}; padding: 16px; margin: 20px 0; border-radius: 4px;">
      <p style="margin: 0; color: #991B1B; font-size: 14px;">
        <strong>Begründung:</strong><br>
        ${reason}
      </p>
    </div>
  ` : '';

  const html = baseEmailTemplate({
    title: 'Anbieter-Registrierung abgelehnt',
    headerText: 'Kiezling',
    content: `
      <h2 style="color: ${COLORS.textPrimary}; margin-top: 0;">Anbieter-Registrierung konnte nicht genehmigt werden</h2>
      
      <p>Hallo,</p>
      
      <p>Leider konnten wir deine Anbieter-Registrierung für <strong>"${providerName}"</strong> nicht genehmigen.</p>
      
      ${reasonHtml}
      
      <p>Du hast folgende Möglichkeiten:</p>
      <ul style="padding-left: 20px; color: ${COLORS.textSecondary};">
        <li>Überarbeite deine Angaben und registriere dich erneut</li>
        <li>Kontaktiere uns für Rückfragen</li>
      </ul>
      
      <p style="color: ${COLORS.textSecondary}; font-size: 14px;">
        Bei Fragen stehen wir dir gerne unter <a href="mailto:${SUPPORT_EMAIL}" style="color: ${COLORS.primary};">${SUPPORT_EMAIL}</a> zur Verfügung.
      </p>
    `,
    buttonText: 'Erneut registrieren',
    buttonUrl: `${FRONTEND_URL}/anbieter/registrieren`,
    buttonColor: 'primary',
  });

  return sendEmail({
    to: email,
    subject: 'Anbieter-Registrierung abgelehnt - Kiezling',
    html,
    senderType: 'support',
  });
}

/**
 * B4: Send confirmation when event is submitted
 */
export async function sendEventSubmittedEmail(
  email: string,
  eventTitle: string,
  eventId: string
): Promise<boolean> {
  const html = baseEmailTemplate({
    title: 'Event eingereicht',
    headerText: 'Kiezling',
    content: `
      <h2 style="color: ${COLORS.textPrimary}; margin-top: 0;">Event wurde eingereicht</h2>
      
      <p>Hallo,</p>
      
      <p>Dein Event wurde erfolgreich eingereicht und wird nun von unserem Team geprüft.</p>
      
      <div style="background: ${COLORS.white}; border: 1px solid ${COLORS.border}; padding: 16px; margin: 20px 0; border-radius: 8px;">
        <p style="margin: 0; color: ${COLORS.textSecondary}; font-size: 14px;">
          <strong>Event:</strong> ${eventTitle}<br>
          <strong>Status:</strong> <span style="color: ${COLORS.warning};">Wird geprüft</span>
        </p>
      </div>
      
      <p style="color: ${COLORS.textSecondary}; font-size: 14px;">
        Die Prüfung dauert in der Regel 1-2 Werktage. Du erhältst eine Benachrichtigung, sobald dein Event freigeschaltet wurde.
      </p>
    `,
    buttonText: 'Event ansehen',
    buttonUrl: `${FRONTEND_URL}/anbieter/events/${eventId}`,
    buttonColor: 'primary',
  });

  return sendEmail({
    to: email,
    subject: `Event eingereicht: ${eventTitle} - Kiezling`,
    html,
    senderType: 'support',
  });
}

/**
 * B5: Send notification when event is approved
 */
export async function sendEventApprovedEmail(
  email: string,
  eventTitle: string,
  eventSlug: string
): Promise<boolean> {
  const eventUrl = `${FRONTEND_URL}/event/${eventSlug}`;

  const html = baseEmailTemplate({
    title: 'Event freigeschaltet',
    headerText: 'Event ist live!',
    content: `
      <h2 style="color: ${COLORS.textPrimary}; margin-top: 0;">Dein Event ist jetzt sichtbar!</h2>
      
      <p>Hallo,</p>
      
      <p>Gute Nachrichten! Dein Event <strong>"${eventTitle}"</strong> wurde geprüft und ist jetzt für alle Familien auf Kiezling sichtbar.</p>
      
      <div style="background: #D1FAE5; border-left: 4px solid ${COLORS.success}; padding: 16px; margin: 20px 0; border-radius: 4px;">
        <p style="margin: 0; color: #065F46; font-size: 14px;">
          <strong>Status:</strong> Veröffentlicht<br>
          Familien können dein Event jetzt entdecken und auf ihre Merkliste setzen!
        </p>
      </div>
      
      <p style="color: ${COLORS.textSecondary}; font-size: 14px;">
        Tipp: Teile den Link zu deinem Event in sozialen Medien, um mehr Familien zu erreichen.
      </p>
    `,
    buttonText: 'Event ansehen',
    buttonUrl: eventUrl,
    buttonColor: 'success',
  });

  return sendEmail({
    to: email,
    subject: `Event freigeschaltet: ${eventTitle} - Kiezling`,
    html,
    senderType: 'support',
  });
}

/**
 * B6: Send notification when event is rejected
 */
export async function sendEventRejectedEmail(
  email: string,
  eventTitle: string,
  eventId: string,
  reason?: string
): Promise<boolean> {
  const reasonHtml = reason ? `
    <div style="background: #FEE2E2; border-left: 4px solid ${COLORS.danger}; padding: 16px; margin: 20px 0; border-radius: 4px;">
      <p style="margin: 0; color: #991B1B; font-size: 14px;">
        <strong>Begründung:</strong><br>
        ${reason}
      </p>
    </div>
  ` : '';

  const html = baseEmailTemplate({
    title: 'Event abgelehnt',
    headerText: 'Kiezling',
    content: `
      <h2 style="color: ${COLORS.textPrimary}; margin-top: 0;">Event konnte nicht veröffentlicht werden</h2>
      
      <p>Hallo,</p>
      
      <p>Leider konnte dein Event <strong>"${eventTitle}"</strong> nicht veröffentlicht werden.</p>
      
      ${reasonHtml}
      
      <p>Du kannst das Event bearbeiten und erneut zur Prüfung einreichen.</p>
      
      <p style="color: ${COLORS.textSecondary}; font-size: 14px;">
        Bei Fragen stehen wir dir gerne unter <a href="mailto:${SUPPORT_EMAIL}" style="color: ${COLORS.primary};">${SUPPORT_EMAIL}</a> zur Verfügung.
      </p>
    `,
    buttonText: 'Event bearbeiten',
    buttonUrl: `${FRONTEND_URL}/anbieter/events/${eventId}`,
    buttonColor: 'primary',
  });

  return sendEmail({
    to: email,
    subject: `Event abgelehnt: ${eventTitle} - Kiezling`,
    html,
    senderType: 'support',
  });
}

// ============================================
// KATEGORIE C: BENACHRICHTIGUNGEN
// ============================================

export interface EventReminderData {
  title: string;
  slug: string;
  date: Date;
  location?: string;
}

/**
 * C1: Send event reminder (event from wishlist is coming up)
 */
export async function sendEventReminderEmail(
  email: string,
  event: EventReminderData
): Promise<boolean> {
  const eventUrl = `${FRONTEND_URL}/event/${event.slug}`;
  const formattedDate = event.date.toLocaleDateString('de-DE', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  const formattedTime = event.date.toLocaleTimeString('de-DE', {
    hour: '2-digit',
    minute: '2-digit',
  });

  const html = baseEmailTemplate({
    title: 'Event-Erinnerung',
    headerText: 'Nicht vergessen!',
    content: `
      <h2 style="color: ${COLORS.textPrimary}; margin-top: 0;">Dein gemerktes Event steht bevor!</h2>
      
      <p>Hallo,</p>
      
      <p>Ein Event aus deiner Merkliste findet bald statt:</p>
      
      <div style="background: ${COLORS.white}; border: 1px solid ${COLORS.border}; padding: 20px; margin: 20px 0; border-radius: 8px;">
        <h3 style="margin: 0 0 10px 0; color: ${COLORS.textPrimary};">${event.title}</h3>
        <p style="margin: 0; color: ${COLORS.textSecondary}; font-size: 14px;">
          📅 <strong>${formattedDate}</strong> um ${formattedTime} Uhr<br>
          ${event.location ? `📍 ${event.location}` : ''}
        </p>
      </div>
      
      <p style="color: ${COLORS.textSecondary}; font-size: 14px;">
        Plane genug Zeit für die Anfahrt ein und vergiss nicht, alles Nötige einzupacken!
      </p>
    `,
    buttonText: 'Event-Details ansehen',
    buttonUrl: eventUrl,
    buttonColor: 'primary',
  });

  return sendEmail({
    to: email,
    subject: `Erinnerung: ${event.title} steht bevor - Kiezling`,
    html,
    senderType: 'marketing',
  });
}

export interface WeeklyDigestEvent {
  title: string;
  slug: string;
  date: string;
  priceType: 'free' | 'paid';
}

/**
 * C2: Send weekly digest with new events
 */
export async function sendWeeklyDigestEmail(
  email: string,
  events: WeeklyDigestEvent[]
): Promise<boolean> {
  const eventsHtml = events.slice(0, 5).map(event => `
    <div style="border-bottom: 1px solid ${COLORS.border}; padding: 15px 0;">
      <a href="${FRONTEND_URL}/event/${event.slug}" style="text-decoration: none; color: ${COLORS.textPrimary};">
        <strong>${event.title}</strong>
      </a>
      <p style="margin: 5px 0 0 0; color: ${COLORS.textSecondary}; font-size: 14px;">
        📅 ${event.date} ${event.priceType === 'free' ? '• 🎉 Kostenlos' : ''}
      </p>
    </div>
  `).join('');

  const html = baseEmailTemplate({
    title: 'Wöchentlicher Digest',
    headerText: 'Diese Woche bei Kiezling',
    content: `
      <h2 style="color: ${COLORS.textPrimary}; margin-top: 0;">Neue Events für deine Familie!</h2>
      
      <p>Hallo,</p>
      
      <p>Hier sind die neuesten Familienaktivitäten in Karlsruhe:</p>
      
      <div style="background: ${COLORS.white}; border: 1px solid ${COLORS.border}; border-radius: 8px; overflow: hidden; margin: 20px 0;">
        ${eventsHtml}
      </div>
      
      ${events.length > 5 ? `<p style="color: ${COLORS.textSecondary}; font-size: 14px;">... und ${events.length - 5} weitere Events!</p>` : ''}
      
      <hr style="border: none; border-top: 1px solid ${COLORS.border}; margin: 30px 0;">
      
      <p style="color: ${COLORS.textMuted}; font-size: 12px;">
        Du erhältst diese E-Mail, weil du den wöchentlichen Digest abonniert hast.<br>
        <a href="${FRONTEND_URL}/einstellungen" style="color: ${COLORS.primary};">E-Mail-Einstellungen ändern</a>
      </p>
    `,
    buttonText: 'Alle Events entdecken',
    buttonUrl: `${FRONTEND_URL}/entdecken`,
    buttonColor: 'primary',
  });

  return sendEmail({
    to: email,
    subject: 'Diese Woche auf Kiezling: Neue Familienaktivitäten',
    html,
    senderType: 'marketing',
  });
}

export interface WishlistUpdateEvent {
  title: string;
  slug: string;
  changeType: 'date_changed' | 'cancelled' | 'location_changed' | 'price_changed';
  details?: string;
}

/**
 * C3: Send notification about changes to saved events
 */
export async function sendWishlistUpdateEmail(
  email: string,
  events: WishlistUpdateEvent[]
): Promise<boolean> {
  const changeLabels: Record<WishlistUpdateEvent['changeType'], string> = {
    date_changed: '📅 Datum/Zeit geändert',
    cancelled: '❌ Abgesagt',
    location_changed: '📍 Ort geändert',
    price_changed: '💰 Preis geändert',
  };

  const eventsHtml = events.map(event => `
    <div style="border-bottom: 1px solid ${COLORS.border}; padding: 15px 0;">
      <a href="${FRONTEND_URL}/event/${event.slug}" style="text-decoration: none; color: ${COLORS.textPrimary};">
        <strong>${event.title}</strong>
      </a>
      <p style="margin: 5px 0 0 0; color: ${event.changeType === 'cancelled' ? COLORS.danger : COLORS.warning}; font-size: 14px;">
        ${changeLabels[event.changeType]}
        ${event.details ? `<br><span style="color: ${COLORS.textSecondary};">${event.details}</span>` : ''}
      </p>
    </div>
  `).join('');

  const html = baseEmailTemplate({
    title: 'Änderungen an deinen gemerkten Events',
    headerText: 'Merklisten-Update',
    content: `
      <h2 style="color: ${COLORS.textPrimary}; margin-top: 0;">Änderungen an deinen gemerkten Events</h2>
      
      <p>Hallo,</p>
      
      <p>Bei einigen Events aus deiner Merkliste gab es Änderungen:</p>
      
      <div style="background: ${COLORS.white}; border: 1px solid ${COLORS.border}; border-radius: 8px; overflow: hidden; margin: 20px 0;">
        ${eventsHtml}
      </div>
      
      <p style="color: ${COLORS.textSecondary}; font-size: 14px;">
        Überprüfe die Details und aktualisiere ggf. deine Pläne.
      </p>
    `,
    buttonText: 'Zur Merkliste',
    buttonUrl: `${FRONTEND_URL}/merkliste`,
    buttonColor: 'primary',
  });

  return sendEmail({
    to: email,
    subject: 'Änderungen an deinen gemerkten Events - Kiezling',
    html,
    senderType: 'marketing',
  });
}

// ============================================
// KATEGORIE D: TRANSAKTIONAL
// ============================================

/**
 * D1: Send confirmation after contact form submission
 */
export async function sendContactConfirmationEmail(
  email: string,
  name: string,
  subject: string
): Promise<boolean> {
  const html = baseEmailTemplate({
    title: 'Nachricht erhalten',
    headerText: 'Kiezling',
    content: `
      <h2 style="color: ${COLORS.textPrimary}; margin-top: 0;">Vielen Dank für deine Nachricht!</h2>
      
      <p>Hallo ${name},</p>
      
      <p>Wir haben deine Nachricht erhalten und werden uns schnellstmöglich bei dir melden.</p>
      
      <div style="background: ${COLORS.white}; border: 1px solid ${COLORS.border}; padding: 16px; margin: 20px 0; border-radius: 8px;">
        <p style="margin: 0; color: ${COLORS.textSecondary}; font-size: 14px;">
          <strong>Betreff:</strong> ${subject}<br>
          <strong>Eingegangen am:</strong> ${new Date().toLocaleDateString('de-DE', {
            dateStyle: 'full',
          })}
        </p>
      </div>
      
      <p style="color: ${COLORS.textSecondary}; font-size: 14px;">
        Unser Team antwortet in der Regel innerhalb von 1-2 Werktagen.
      </p>
    `,
  });

  return sendEmail({
    to: email,
    subject: 'Wir haben deine Nachricht erhalten - Kiezling',
    html,
    senderType: 'support',
  });
}

// ============================================
// UTILITY FUNCTIONS
// ============================================

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
