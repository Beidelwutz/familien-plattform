# Contributing Guidelines

Vielen Dank für dein Interesse an Familien-Lokal! Diese Richtlinien helfen dir beim Beitragen zum Projekt.

## Inhaltsverzeichnis

- [Entwicklungsumgebung](#entwicklungsumgebung)
- [Code Style](#code-style)
- [Commit-Nachrichten](#commit-nachrichten)
- [Pull Requests](#pull-requests)
- [Issue-Richtlinien](#issue-richtlinien)

## Entwicklungsumgebung

### Voraussetzungen

- Node.js >= 20
- Python >= 3.11
- Docker + Docker Compose
- Git

### Setup

1. **Fork erstellen** auf GitHub

2. **Repository klonen:**
   ```bash
   git clone https://github.com/DEIN-USERNAME/familien-lokal.git
   cd familien-lokal
   ```

3. **Dependencies installieren:**
   ```bash
   npm install
   ```

4. **Docker-Container starten:**
   ```bash
   npm run docker:up
   ```

5. **Datenbank migrieren:**
   ```bash
   npm run db:migrate
   ```

6. **Entwicklungsserver starten:**
   ```bash
   npm run dev
   ```

### Branch-Namenskonvention

- `feature/beschreibung` - Neue Features
- `fix/beschreibung` - Bugfixes
- `docs/beschreibung` - Dokumentation
- `refactor/beschreibung` - Refactoring
- `test/beschreibung` - Tests

Beispiele:
```
feature/search-autocomplete
fix/login-redirect
docs/api-endpoints
refactor/event-card-component
```

## Code Style

### TypeScript

- **Strict Mode** aktiviert
- Explizite Typen für Funktionsparameter und Rückgabewerte
- Interfaces über Types bevorzugen
- Keine `any` Typen (außer wenn absolut notwendig)

```typescript
// Gut
function getUserById(id: string): Promise<User | null> {
  return prisma.user.findUnique({ where: { id } });
}

// Schlecht
function getUserById(id): any {
  return prisma.user.findUnique({ where: { id } });
}
```

### Formatierung

- **Prettier** für automatische Formatierung
- 2 Spaces Einrückung
- Einfache Anführungszeichen
- Semikolons

### Dateistruktur

```
src/
├── components/     # UI-Komponenten
├── pages/          # Astro-Seiten
├── lib/            # Utility-Funktionen
├── routes/         # API-Routen (Backend)
├── middleware/     # Express Middleware
└── types/          # TypeScript-Typen
```

### Namenskonventionen

| Typ | Konvention | Beispiel |
|-----|------------|----------|
| Komponenten | PascalCase | `EventCard.astro` |
| Funktionen | camelCase | `getUserById()` |
| Konstanten | UPPER_SNAKE | `MAX_PAGE_SIZE` |
| Dateien (TS) | camelCase | `eventService.ts` |
| Dateien (Astro) | PascalCase | `EventCard.astro` |

## Commit-Nachrichten

Wir verwenden **Conventional Commits** für einheitliche Commit-Nachrichten.

### Format

```
type(scope): beschreibung

[optionaler body]

[optionaler footer]
```

### Typen

| Typ | Beschreibung |
|-----|--------------|
| `feat` | Neues Feature |
| `fix` | Bugfix |
| `docs` | Dokumentation |
| `style` | Formatierung (kein Code-Änderung) |
| `refactor` | Code-Refactoring |
| `test` | Tests hinzufügen/ändern |
| `chore` | Wartung, Dependencies |
| `perf` | Performance-Verbesserungen |

### Beispiele

```bash
# Feature
feat(search): add autocomplete suggestions

# Bugfix
fix(auth): resolve token expiration issue

# Dokumentation
docs(readme): add deployment instructions

# Refactoring
refactor(events): extract filter logic to separate function

# Breaking Change
feat(api)!: change response format for events endpoint

BREAKING CHANGE: The events endpoint now returns a paginated response object instead of an array.
```

## Pull Requests

### Vor dem PR

1. **Branch aktuell halten:**
   ```bash
   git fetch origin
   git rebase origin/main
   ```

2. **Tests ausführen** (wenn vorhanden):
   ```bash
   npm test
   ```

3. **Linting prüfen:**
   ```bash
   npm run lint
   ```

### PR-Beschreibung

Verwende diese Vorlage:

```markdown
## Beschreibung

[Kurze Beschreibung der Änderungen]

## Änderungen

- [Änderung 1]
- [Änderung 2]

## Screenshots (bei UI-Änderungen)

[Screenshots hier einfügen]

## Checkliste

- [ ] Code folgt den Style Guidelines
- [ ] Selbst-Review durchgeführt
- [ ] Dokumentation aktualisiert (falls nötig)
- [ ] Keine neuen Warnungen
```

### Review-Prozess

1. Mindestens ein Review erforderlich
2. Alle Kommentare müssen adressiert werden
3. CI/CD muss grün sein (sobald eingerichtet)
4. Squash Merge bevorzugt

## Issue-Richtlinien

### Bug Reports

Verwende diese Informationen:

- **Beschreibung:** Was ist passiert?
- **Erwartetes Verhalten:** Was sollte passieren?
- **Reproduktion:** Schritte zum Reproduzieren
- **Umgebung:** Browser, OS, etc.
- **Screenshots:** Falls hilfreich

### Feature Requests

- **Problem:** Welches Problem löst das Feature?
- **Lösung:** Wie stellst du dir die Lösung vor?
- **Alternativen:** Welche Alternativen hast du erwogen?

## Fragen?

Bei Fragen erstelle ein Issue mit dem Label `question` oder kontaktiere das Team direkt.

---

Danke für deinen Beitrag! 🎉
