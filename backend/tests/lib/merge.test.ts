/**
 * Merge lib tests: Sanitisierung und Logik für AI-verbesserte Beschreibung
 * sowie Integration der neuen Classifier-Felder (organizer_website, improved_description, etc.)
 */

import { describe, it, expect } from 'vitest';
import {
  sanitizeImprovedDescriptionHtml,
  stripHtmlToText,
} from '../../src/lib/merge.js';

describe('sanitizeImprovedDescriptionHtml', () => {
  it('erlaubt p, strong, br und entfernt Attribute', () => {
    const input = '<p class="lead">Text</p><strong id="x">wichtig</strong><br/>';
    expect(sanitizeImprovedDescriptionHtml(input)).toBe(
      '<p>Text</p><strong>wichtig</strong><br/>'
    );
  });

  it('entfernt nicht erlaubte Tags (script, div, span); Tag-Inhalt bleibt', () => {
    const input = '<p>Ok</p><script>alert(1)</script><div>No</div>';
    const out = sanitizeImprovedDescriptionHtml(input);
    expect(out).not.toMatch(/<script|<\/script|<div|<\/div/);
    expect(out).toContain('<p>Ok</p>');
    expect(out).toContain('alert(1)');
    expect(out).toContain('No');
  });

  it('gibt leeren String für leere/ungültige Eingabe', () => {
    expect(sanitizeImprovedDescriptionHtml('')).toBe('');
    expect(sanitizeImprovedDescriptionHtml('   ')).toBe('');
  });

  it('begrenzt auf 8000 Zeichen', () => {
    const long = '<p>' + 'x'.repeat(9000) + '</p>';
    const out = sanitizeImprovedDescriptionHtml(long);
    expect(out.length).toBeLessThanOrEqual(8000 + 10); // +10 für Tags
  });
});

describe('stripHtmlToText', () => {
  it('entfernt alle HTML-Tags und normalisiert Leerzeichen', () => {
    expect(stripHtmlToText('<p>Hallo</p> <strong>Welt</strong>')).toBe('Hallo Welt');
  });

  it('ist geeignet für description_short (500 Zeichen)', () => {
    const html = '<p>Ein langer Absatz mit vielen Wörtern.</p>';
    const text = stripHtmlToText(html);
    expect(text.length).toBeLessThanOrEqual(html.length);
    expect(text).not.toMatch(/<|>/);
  });
});
