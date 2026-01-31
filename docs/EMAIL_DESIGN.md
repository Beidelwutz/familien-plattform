# Kiezling E-Mail Design System

Dieses Dokument definiert das einheitliche Design für alle E-Mail-Vorlagen der Kiezling-Plattform.

## Inhaltsverzeichnis

1. [Farbpalette](#farbpalette)
2. [Typografie](#typografie)
3. [Layout-Struktur](#layout-struktur)
4. [Button-Styles](#button-styles)
5. [E-Mail-Vorlagen-Übersicht](#e-mail-vorlagen-übersicht)
6. [Implementierung](#implementierung)

---

## Farbpalette

### Primärfarben

| Name | Hex-Code | Verwendung |
|------|----------|------------|
| Primary | `#4F46E5` | Haupt-CTA-Buttons, Links |
| Primary Gradient Start | `#6366f1` | E-Mail-Header (Gradient) |
| Primary Gradient End | `#8b5cf6` | E-Mail-Header (Gradient) |
| Primary Light | `#EEF2FF` | Hintergründe, Hover-States |

**CSS Gradient:**
```css
background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
```

### Sekundärfarben

| Name | Hex-Code | Verwendung |
|------|----------|------------|
| Success (Grün) | `#10B981` | Bestätigungs-Buttons (E-Mail verifizieren) |
| Warning (Amber) | `#F59E0B` | Warnhinweise, Erinnerungen |
| Error (Rot) | `#EF4444` | Fehler, Löschungen, Sicherheitswarnungen |

### Neutrale Farben

| Name | Hex-Code | Verwendung |
|------|----------|------------|
| Background | `#f9fafb` | Content-Bereich Hintergrund |
| Text Primary | `#1f2937` | Überschriften |
| Text Body | `#333333` | Fließtext |
| Text Secondary | `#6b7280` | Sekundärer Text, Hinweise |
| Text Muted | `#9ca3af` | Footer, kleine Hinweise |
| Border | `#e5e7eb` | Trennlinien |
| White | `#ffffff` | Buttons, Cards |

---

## Typografie

### Schriftart

```css
font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
```

**Hinweis:** Inter wird über Google Fonts geladen, mit System-Fallbacks für E-Mail-Clients die externe Fonts nicht unterstützen.

### Schriftgrößen

| Element | Größe | Gewicht | Farbe | Line-Height |
|---------|-------|---------|-------|-------------|
| Logo/Brand | 24px | 700 (bold) | `#ffffff` | 1.2 |
| Überschrift H1 | 24px | 700 (bold) | `#1f2937` | 1.3 |
| Überschrift H2 | 20px | 600 (semibold) | `#1f2937` | 1.3 |
| Fließtext | 16px | 400 (normal) | `#333333` | 1.6 |
| Hinweise | 14px | 400 (normal) | `#6b7280` | 1.5 |
| Footer | 12px | 400 (normal) | `#9ca3af` | 1.5 |
| Button | 16px | 600 (semibold) | `#ffffff` | 1 |

---

## Layout-Struktur

### Grundstruktur

```
┌──────────────────────────────────────────────────┐
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │           HEADER                           │  │
│  │  ┌─────────────────────────────────────┐   │  │
│  │  │      Logo: "Kiezling"               │   │  │  <- Gradient Background
│  │  │      (optional: Untertitel)         │   │  │     30px padding
│  │  └─────────────────────────────────────┘   │  │     12px border-radius (oben)
│  └────────────────────────────────────────────┘  │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │           CONTENT                          │  │
│  │                                            │  │
│  │  Überschrift (H2)                          │  │
│  │                                            │  │  <- #f9fafb Background
│  │  Anrede                                    │  │     30px padding
│  │                                            │  │     12px border-radius (unten)
│  │  Haupttext mit Erklärung                   │  │
│  │                                            │  │
│  │  ┌──────────────────────────────────────┐  │  │
│  │  │         [ CTA BUTTON ]               │  │  │  <- Zentriert
│  │  └──────────────────────────────────────┘  │  │     30px margin top/bottom
│  │                                            │  │
│  │  Hinweistext (klein, grau)                 │  │
│  │                                            │  │
│  │  ─────────────────────────────────────     │  │  <- Border #e5e7eb
│  │                                            │  │
│  │  Fallback-Link (falls Button nicht geht)   │  │
│  │                                            │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │           FOOTER                           │  │
│  │                                            │  │  <- Kein Background
│  │  © 2026 Kiezling. Alle Rechte vorbehalten. │  │     20px padding
│  │                                            │  │     Zentriert
│  │  Datenschutz | Impressum                   │  │
│  │                                            │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
└──────────────────────────────────────────────────┘

Gesamtbreite: max-width 600px, zentriert
Außenabstand: 20px padding
```

### Abstände

| Element | Abstand |
|---------|---------|
| Container max-width | 600px |
| Body padding | 20px |
| Header padding | 30px |
| Content padding | 30px |
| Footer padding | 20px |
| Button margin | 30px (top & bottom) |
| Absätze | 16px (margin-bottom) |
| Trennlinie margin | 30px (top & bottom) |

### Border-Radius

| Element | Radius |
|---------|--------|
| Header (oben) | 12px 12px 0 0 |
| Content (unten) | 0 0 12px 12px |
| Buttons | 8px |

---

## Button-Styles

### Primary Button (Standard-CTA)

```css
display: inline-block;
background: #6366f1;
color: white;
text-decoration: none;
padding: 14px 28px;
border-radius: 8px;
font-weight: 600;
font-size: 16px;
```

**Verwendung:** Hauptaktionen wie "Passwort zurücksetzen", "Events entdecken"

### Success Button (Bestätigung)

```css
display: inline-block;
background: #10b981;
color: white;
text-decoration: none;
padding: 14px 28px;
border-radius: 8px;
font-weight: 600;
font-size: 16px;
```

**Verwendung:** Positive Aktionen wie "E-Mail bestätigen", "Zum Dashboard"

### Danger Button (Warnung)

```css
display: inline-block;
background: #EF4444;
color: white;
text-decoration: none;
padding: 14px 28px;
border-radius: 8px;
font-weight: 600;
font-size: 16px;
```

**Verwendung:** Sicherheitsrelevante Aktionen wie "Konto überprüfen"

### Secondary Button (Optional)

```css
display: inline-block;
background: white;
color: #6366f1;
text-decoration: none;
padding: 14px 28px;
border-radius: 8px;
font-weight: 600;
font-size: 16px;
border: 2px solid #6366f1;
```

**Verwendung:** Sekundäre Aktionen

---

## E-Mail-Absender (kiezling.com)

Die Domain `kiezling.com` ist bei Resend verifiziert. Es werden drei verschiedene Absender-Adressen verwendet:

| Absender | E-Mail | Verwendung |
|----------|--------|------------|
| Transactional | `noreply@kiezling.com` | Automatische System-E-Mails (Verifizierung, Passwort) |
| Support | `support@kiezling.com` | Anbieter-Kommunikation, Kontaktbestätigungen |
| Marketing | `team@kiezling.com` | Newsletter, Digest, Event-Erinnerungen |

**Reply-To:** Alle E-Mails haben `support@kiezling.com` als Reply-To Adresse.

---

## E-Mail-Vorlagen-Übersicht

### Kategorie A: Authentifizierung (Absender: noreply@kiezling.com)

| ID | Name | Funktion | Button-Farbe |
|----|------|----------|--------------|
| A1 | Willkommen | `sendWelcomeEmail` | Primary |
| A2 | E-Mail-Verifizierung | `sendVerificationEmail` | Success |
| A3 | Passwort zurücksetzen | `sendPasswordResetEmail` | Primary |
| A4 | Passwort geändert | `sendPasswordChangedEmail` | Danger |
| A5 | Konto gesperrt | `sendAccountLockedEmail` | Danger |
| A6 | E-Mail geändert | `sendEmailChangedEmail` | - (kein Button) |
| A7 | Konto gelöscht | `sendAccountDeletedEmail` | - (kein Button) |

### Kategorie B: Anbieter (Absender: support@kiezling.com)

| ID | Name | Funktion | Button-Farbe |
|----|------|----------|--------------|
| B1 | Anbieter-Registrierung | `sendProviderRegistrationEmail` | Primary |
| B2 | Anbieter freigeschaltet | `sendProviderApprovedEmail` | Success |
| B3 | Anbieter abgelehnt | `sendProviderRejectedEmail` | Primary |
| B4 | Event eingereicht | `sendEventSubmittedEmail` | Primary |
| B5 | Event genehmigt | `sendEventApprovedEmail` | Success |
| B6 | Event abgelehnt | `sendEventRejectedEmail` | Primary |

### Kategorie C: Benachrichtigungen (Absender: team@kiezling.com)

| ID | Name | Funktion | Button-Farbe |
|----|------|----------|--------------|
| C1 | Event-Erinnerung | `sendEventReminderEmail` | Primary |
| C2 | Wöchentlicher Digest | `sendWeeklyDigestEmail` | Primary |
| C3 | Merklisten-Update | `sendWishlistUpdateEmail` | Primary |

### Kategorie D: Transaktional (Absender: support@kiezling.com)

| ID | Name | Funktion | Button-Farbe |
|----|------|----------|--------------|
| D1 | Kontaktbestätigung | `sendContactConfirmationEmail` | - (kein Button) |

---

## Implementierung

### Dateistruktur

```
backend/src/lib/
├── email.ts              # Haupt-Email-Modul
└── emailTemplates.ts     # (optional) Separate Template-Funktionen
```

### Umgebungsvariablen

```bash
# Email (Resend) - Domain kiezling.com ist verifiziert
RESEND_API_KEY="re_xxxxx"  # API Key von https://resend.com/api-keys

# E-Mail Absender
EMAIL_FROM="Kiezling <noreply@kiezling.com>"
EMAIL_FROM_SUPPORT="Kiezling Support <support@kiezling.com>"
EMAIL_FROM_TEAM="Kiezling Team <team@kiezling.com>"
EMAIL_REPLY_TO="support@kiezling.com"
```

### Basis-Template-Funktion

Alle E-Mails nutzen die `baseEmailTemplate()` Funktion für konsistentes Design:

```typescript
interface EmailTemplateOptions {
  title: string;
  headerText?: string;
  content: string;
  buttonText?: string;
  buttonUrl?: string;
  buttonColor?: 'primary' | 'success' | 'danger';
  showFooterLinks?: boolean;
}

function baseEmailTemplate(options: EmailTemplateOptions): string
```

### Absender-Typen

```typescript
type EmailSenderType = 'transactional' | 'support' | 'marketing';

// Verwendung in sendEmail()
sendEmail({
  to: email,
  subject: 'Betreff',
  html: html,
  senderType: 'support',  // Optional: 'transactional' (default), 'support', 'marketing'
});
```

### Verwendungsbeispiel

```typescript
const html = baseEmailTemplate({
  title: 'Willkommen bei Kiezling',
  headerText: 'Willkommen bei Kiezling!',
  content: `
    <h2>Schön, dass du dabei bist!</h2>
    <p>Hallo,</p>
    <p>Herzlich willkommen bei Kiezling...</p>
  `,
  buttonText: 'Events entdecken',
  buttonUrl: `${FRONTEND_URL}/entdecken`,
  buttonColor: 'primary'
});
```

### Standard-Footer-Links

Alle E-Mails enthalten im Footer:
- Copyright mit aktuellem Jahr
- Link zu Datenschutz (`/datenschutz`)
- Link zu Impressum (`/impressum`)

---

## Checkliste für neue E-Mails

- [ ] Nutzt `baseEmailTemplate()` für konsistentes Design
- [ ] Deutsche Sprache mit korrekter Anrede
- [ ] Klare, prägnante Betreffzeile
- [ ] Haupt-CTA ist eindeutig erkennbar
- [ ] Fallback-Link für Button vorhanden (wo nötig)
- [ ] Footer mit Datenschutz/Impressum
- [ ] Plaintext-Version über `stripHtml()` generiert
- [ ] Getestet in gängigen E-Mail-Clients
