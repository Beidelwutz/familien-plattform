# Event-Detail-Seiten: CSS-Selektoren (Karlsruhe Veranstaltungskalender)

Quelle: `kalender.karlsruhe.de` (z. B. `/db/termine/musik/…`).  
Komma-getrennt = Fallback-Reihenfolge (erster Treffer gewinnt).

---

## Scraping per RSS – Wichtiger Hinweis zu &lt;pubDate&gt;

Das RSS-Feed (`https://kalender.karlsruhe.de/db/termine/rss`) liefert pro Event u. a.:

- `<title>`, `<link>`, `<description>`, `<content:encoded>`, `<guid>`, **`<pubDate>`**

**`<pubDate>` ist nur das Veröffentlichungsdatum des Eintrags im Kalender, nicht der Termin der Veranstaltung.**

Beispiel aus dem RSS:

```xml
<item>
  <title>90ER VS. 2000ER PARTY</title>
  <link>https://kalender.karlsruhe.de/db/termine/musik/90er_vs_2000er_party-2</link>
  <description>21 Uhr - Substage Karlsruhe e.V. - ...</description>
  <pubDate>Sat, 21 Feb 2026 21:00:00 +0018</pubDate>
</item>
```

Hier bedeutet `pubDate` „wann dieser Eintrag veröffentlicht wurde“, nicht „wann die Party stattfindet“. Das **tatsächliche Event-Datum und die Uhrzeit** stehen auf der **Detailseite** (z. B. dort: „21. Februar 2026, 21 Uhr“). Beim Scrapen per RSS muss daher für jedes `<item>` die Detail-URL (`<link>`) aufgerufen und mit den unten stehenden Selektoren **Startdatum** (und ggf. Enddatum) von der HTML-Detailseite extrahiert werden. `pubDate` aus dem RSS darf nicht als Event-Start übernommen werden.

---

## Selektoren für die Detailseite

| Feld | Typ | CSS-Selektoren |
|------|-----|----------------|
| **Titel** | text | `.vevent h2`, `#h2-style`, `h2#h2-style` |
| **Beschreibung** | text | `#description`, `#shortDescription`, `.vevent .description`, `.vevent .shortDescription`, `.p-style.shortDescription` |
| **Startdatum** | datetime | `#details b`, `p#details b`, `.vevent #details b` |
| **Enddatum** | datetime | `#details .end-date`, `#details .uhr-end`, `.vevent [class*="end"]` *(auf dieser Seite oft nicht vorhanden)* |
| **Ort (Name)** | text | `#details .location`, `.location`, `#box_ort h5.fn.org`, `.detail-block.vcard .fn.org` |
| **Ort (Adresse)** | text | `#box_ort .adr`, `.adr .street-address`, `#box_ort .street-address`, `.postal-code`, `.locality` *(Adresse: .adr oder .street-address + .postal-code + .locality)* |
| **Bild** | src | `#terminbild img`, `#terminbild img.w-100`, `.vevent #terminbild img`, `section#terminbild img` |
| **Preis** | text | `#ticketservice`, `.vevent [class*="preis"]`, `.vevent [class*="price"]` *(auf vielen Seiten nur Kartenverkauf-Text, kein expliziter Preis)* |
| **Veranstalter** | text | `details.top:nth-of-type(2) h5.fn.org`, `details.top:nth-of-type(2) .detail-block h5`, `details.top .detail-contents .detail-block.vcard h5.fn.org` *(Zweites &lt;details&gt; = „Veranstalter“)* |

---

## Datumsformate (Karlsruhe Kalender)

- **Start:** `DD. MMMM YYYY, HH Uhr` (z. B. „13. Februar 2026, 19 Uhr“)  
- Alternativ erwarten: **DD.MM.YYYY HH:mm**, **DD.MM.YYYY**  
- Dauer steht oft im Fließtext unter `#description` (z. B. „Dauer der Veranstaltung: circa 60 Minuten“); Endzeit ggf. daraus ableiten oder weglassen.

---

## Notizen

- **Titel/Beschreibung:** `.vevent` umschließt den gesamten Event-Block; `#shortDescription` = Kurztext, `#description` = ausführliche Programmbeschreibung.
- **Ort:** Erstes `<details class="top">` = „Veranstaltungsort“ (enthält `#box_ort` mit Name + Adresse). `.location` in `#details` wiederholt den Ortsnamen kompakt.
- **Veranstalter:** Zweites `<details class="top">` = „Veranstalter“; Name im `h5.fn.org` (z. B. „PLANET KA Planetarium Karlsruhe gGmbH“).
- **Bild:** Immer in `#terminbild`; `img` kann `src` relativ haben → ggf. gegen Seiten-URL auflösen.
- **Preis:** Oft nur Hinweis „Online pretix.eu/…“ oder „VVK-Stelle“ in `#ticketservice`; kein eigener Preis-Node. Selektoren oben fangen den Block ab, wenn doch mal „Preis“ oder „Eintritt“ vorkommt.

Diese Selektoren können als `detail_page_config` (z. B. im Admin unter „Detail-Seiten Selektoren“) für die Quelle Karlsruhe Kalender hinterlegt werden.

---

## Fehlende Felder (Titel, Bild, Veranstalter)

- **Titel:** Muss in den Detail-Seiten-Selektoren konfiguriert sein; Feld „Titel“ mit z. B. `.vevent h2` (zuerst) oder `#h2-style`. Ohne Eintrag wird Titel nicht angefragt.
- **Bild:** Feld „Bild“ mit `attr: src`, z. B. `#terminbild img`. Relative `src` werden automatisch zur Seiten-URL aufgelöst.
- **Veranstalter:** Feld „Veranstalter“ mit z. B. `details.top:nth-of-type(2) h5.fn.org` (zweites `<details>` auf der Seite = Veranstalter-Block).
- **Enddatum:** Auf vielen Karlsruhe-Seiten nicht als eigener Knoten; oft nur „Dauer: X Minuten“ in der Beschreibung. Enddatum bleibt dann leer oder wird per Heuristik/AI geschätzt.
