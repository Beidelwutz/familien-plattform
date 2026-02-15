/**
 * 20 Teaser-Box-Designs: Presets mit Unique Icons und thematischem Styling.
 * Jedes Preset setzt variant, contentVariant, optional label, icon (Emoji) und themeClass.
 */

export interface TeaserPreset {
  id: number;
  name: string;
  variant: number;
  contentVariant: number;
  label?: string;
  icon: string;
  themeClass: string;
}

export const TEASER_PRESETS: TeaserPreset[] = [
  { id: 1, name: 'Tipp von (Autor)', variant: 7, contentVariant: 16, label: 'Tipp von', icon: '', themeClass: '' },
  { id: 2, name: 'Ankündigung der Redaktion', variant: 12, contentVariant: 7, label: 'Ankündigung', icon: '📢', themeClass: 'teaser-theme-announcement' },
  { id: 3, name: 'Ostern', variant: 4, contentVariant: 7, label: 'Ostern', icon: '🐣', themeClass: 'teaser-theme-easter' },
  { id: 4, name: 'Musik & Konzerte', variant: 8, contentVariant: 16, label: 'Musik-Tipp', icon: '🎵', themeClass: 'teaser-theme-music' },
  { id: 5, name: 'Kinder & Familie', variant: 7, contentVariant: 7, label: 'Tipp von', icon: '👨‍👩‍👧‍👦', themeClass: 'teaser-theme-family' },
  { id: 6, name: 'Weihnachten', variant: 28, contentVariant: 7, label: 'Weihnachten', icon: '🎄', themeClass: 'teaser-theme-christmas' },
  { id: 7, name: 'Sommer / Outdoor', variant: 6, contentVariant: 7, label: 'Draußen', icon: '☀️', themeClass: 'teaser-theme-summer' },
  { id: 8, name: 'Kunst & Kultur', variant: 11, contentVariant: 12, label: 'Kultur', icon: '🎨', themeClass: 'teaser-theme-culture' },
  { id: 9, name: 'Wochenende', variant: 10, contentVariant: 14, label: 'Wochenende', icon: '📅', themeClass: 'teaser-theme-weekend' },
  { id: 10, name: 'Last Minute', variant: 30, contentVariant: 21, label: 'Jetzt noch', icon: '⚡', themeClass: 'teaser-theme-lastminute' },
  { id: 11, name: 'Festival', variant: 8, contentVariant: 16, label: 'Festival', icon: '🎪', themeClass: 'teaser-theme-festival' },
  { id: 12, name: 'Sport & Bewegung', variant: 10, contentVariant: 7, label: 'Sport', icon: '⚽', themeClass: 'teaser-theme-sport' },
  { id: 13, name: 'Kino & Film', variant: 3, contentVariant: 7, label: 'Kino', icon: '🎬', themeClass: 'teaser-theme-cinema' },
  { id: 14, name: 'Markt & Flohmarkt', variant: 9, contentVariant: 7, label: 'Markt', icon: '🛒', themeClass: 'teaser-theme-market' },
  { id: 15, name: 'Workshop & Kurse', variant: 12, contentVariant: 7, label: 'Kurse', icon: '✏️', themeClass: 'teaser-theme-workshop' },
  { id: 16, name: 'Geburtstag / Feier', variant: 4, contentVariant: 7, label: 'Feier', icon: '🎂', themeClass: 'teaser-theme-party' },
  { id: 17, name: 'Halloween', variant: 30, contentVariant: 7, label: 'Halloween', icon: '🎃', themeClass: 'teaser-theme-halloween' },
  { id: 18, name: 'Neujahr / Silvester', variant: 16, contentVariant: 16, label: 'Silvester', icon: '🥂', themeClass: 'teaser-theme-silvester' },
  { id: 19, name: 'Schulanfang', variant: 5, contentVariant: 7, label: 'Schulanfang', icon: '📚', themeClass: 'teaser-theme-school' },
  { id: 20, name: 'Draußen im Kiez', variant: 6, contentVariant: 7, label: 'Kiez', icon: '🌳', themeClass: 'teaser-theme-kiez' },
];

export function getPresetById(id: number): TeaserPreset | undefined {
  return TEASER_PRESETS.find((p) => p.id === id);
}

export function getPresetByVariantContent(variant: number, contentVariant: number, themeClass?: string): TeaserPreset | undefined {
  if (themeClass) {
    const found = TEASER_PRESETS.find((p) => p.themeClass === themeClass);
    if (found) return found;
  }
  return TEASER_PRESETS.find((p) => p.variant === variant && p.contentVariant === contentVariant);
}
