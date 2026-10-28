# Design System Blueprint – Pixelkiez Analyse
> Extrahiert aus: https://www.semrush.com/siteaudit/ (Wettbewerber, UI-Referenz) · https://www.spheredigitalrecruitment.com/ · https://typesomething.co/ · https://dovvstudio.com/ (Design-/Architektur-Inspiration) — 2026-10-27
> Farben & Schriften: https://pixelkiez.de/ (CSS-Variablen gemessen, 2026-10-27)
> Stand: v4 nach Feedback „zu überladen, zu dunkel“, „zu weiß“ und „Lila statt Schwarz/Knall-Orange“ → hell, minimal, Pixelkiez-Palette mit verblassten Farbflächen pro Abschnitt. Umsetzung: `index.html`, `assets/styles.css`.
> Muster dienen als Inspiration — keine Übernahme von Inhalten, Marken oder Assets der Referenzen.

## Leitidee
**Hell, ruhig, Pixelkiez-Palette: Papiergrau + Schwarz für Text + Orange für Aktionen. Jeder Abschnitt bekommt eine eigene, helle Farbfläche (Weiß, Grau, verblasstes Pfirsich, verblasstes Lila), damit die Seite nicht zu weiß wirkt.**
Farbe trägt sonst nur Bedeutung (kleine Status-Punkte im Report). Typografie und Weißraum tragen das Design, das Produkt (Score, Report) ersetzt Fotos.

### Konsens der Referenzen
| Muster | Semrush | Sphere | Typesomething | Dovv | Übernommen |
|---|:-:|:-:|:-:|:-:|:-:|
| Fast-Schwarz statt #000 als Ink | ✓ | ✓ | ✓ | ✓ | ✓ (`#0C0C0C`) |
| Flach, keine Schatten – Tiefe über Flächen/Haarlinien | ✓ | ✓ | ✓ | ✓ | ✓ |
| Buttons und Inputs als Pills | ✓ | ✓ | ✓ | ✓ | ✓ |
| Eine Grotesk-Familie, negatives Tracking in Headlines | ✓ | ✓ | ✓ | ✓ | ✓ (Archivo) |
| Großzügiger Section-Rhythmus (112–120px) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Akzentfarbe nur für Aktionen | ✓ | ✓ | ✓ | ✓ | ✓ (Orange) |
| Farbfläche pro Abschnitt (Colorway) | ✓ | ✓ | ✓ | ✓ | ✓ (siehe Farbflächen) |
| Dunkle Bänder / dunkles Abschluss-Panel | – | ✓ | ✓ | ✓ | ✗ ersetzt durch verblasstes Lila (Feedback) |

---

## Color
Alle Basiswerte stammen aus den CSS-Variablen von pixelkiez.de. Nur Hell-Modus (bewusste Entscheidung, kein Dark Mode).

### Basis (≈ 95 % der Fläche)
| Token | Hex | Rolle | pixelkiez.de-Variable |
|---|---|---|---|
| `--paper` | `#EFF0F1` | Seitenhintergrund | `--paper` |
| `--paper-2` | `#E6E7E9` | Ring-/Balken-Spur, Tag-Flächen | `--paper-2` |
| `--surface` | `#FFFFFF` | Karten, URL-Feld, Navigation | – (Ergänzung fürs Produkt) |
| `--ink` | `#0C0C0C` | Text, Score-Ring, Balken, Ink-Button | `--ink` |
| `--ink-70` | `#2F3032` | Navigationslinks, Sekundärtext stark | `--ink-70` |
| `--ink-45` | `#646568` | Fließtext sekundär, Labels, Meta | `--ink-45` |
| `--line` | `#C3C4C8` | Rahmen von Input, Ghost-Buttons, Chips | `--line` |
| `--line-soft` | `#D3D4D7` | Haarlinien: Raster-Rahmen, Sections, Karten | `--line-soft` |

### Akzent (genau einer)
| Token | Hex | Rolle | pixelkiez.de-Variable |
|---|---|---|---|
| `--accent` | `#FE5B2A` | Button „Analysieren“, „Empfohlen“-Badge, Pixel-Punkt, Fortschrittsbalken | `--accent` / `--s-orange` |
| `--accent-hover` | `#E75326` | Hover des Orange-Buttons | `--s-orange-600` |
| `--accent-text` | `#E75326` | Akzentwort in der H1, Schritt-Nummern (nur ≥ 24px oder fett) | `--s-orange-600` |
| `--accent-ink` | `#B4411E` | Orange als **kleiner** Text, falls nötig | `--accent-ink` |
| `--accent-soft` | `#FFE6DD` | Hero-Schein, Fokusring des URL-Felds | `--accent-soft` |

### Lila (Flächenfarbe)
| Token | Hex | Rolle | Herkunft |
|---|---|---|---|
| `--lilac` | `#C8ACF8` | Referenzton | pixelkiez.de („Support“-Karte, Hover des Analyse-Buttons) |
| `--lilac-soft` | `#EBE2FC` | Abschnittsfläche, Hero-Schein rechts | abgeleitet wie Pfirsich aus Orange (HSL 262°, Helligkeit ≈ 93 %) |
| `--lilac-line` | `#D9CCF6` / `#C8B5F0` | Haarlinien / Rahmen auf Lila | abgeleitet |
| `--lilac-text` | `#5B3FA6` | Nummern und Akzent-Text auf Lila (≈ 6:1) | abgeleitet |

**Regeln**
- Auf Orange steht **immer Schwarz** (`--ink`), nie Weiß. Weiß auf `#FE5B2A` erreicht nur ≈ 3:1, Schwarz ≈ 6:1 (wie auf pixelkiez.de: `--on-accent: #0C0C0C`).
- `#FE5B2A` als Textfarbe auf `--paper` erreicht nur ≈ 2,7:1 → für Text `#E75326` (große Schrift) oder `#B4411E` (kleine Schrift, ≈ 5:1).
- Orange als Fläche nur für Buttons und das „Empfohlen“-Badge. Keine orangen oder schwarzen Abschnitte; große Flächen sind immer verblasst (Pfirsich oder Lila).

### Semantik (nur Report, nur als kleine Punkte)
| Token | Hex | Bedeutung | Schwelle |
|---|---|---|---|
| `--good` | `#1E9E5A` | gut | 90–100 |
| `--warn` | `#E8A317` | verbesserungswürdig | 50–89 |
| `--bad` | `#D92D20` | kritisch | 0–49 |

- Bewusst **Bernstein statt Orange** für „Warnung“, damit der Markenakzent nicht als Warnsignal gelesen wird.
- Score-Ring und Kategorie-Balken sind **monochrom in Ink**. Farbe trägt nur der 8px-Status-Punkt daneben.

### Farbflächen pro Abschnitt (Colorway)
Jeder Abschnitt bekommt eine Klasse, die Hintergrund und Text-/Linien-Tokens setzt (Sphere-Muster, Pixelkiez-Farben). Die Flächen sitzen im 1280px-Rahmen mit eckigen Kanten wie auf pixelkiez.de.

| Klasse | Hintergrund | Text / Linien | Einsatz |
|---|---|---|---|
| (Standard) | `#EFF0F1` Papier | Ink / `#D3D4D7` | Hero, Prüfungen, Für wen, Weitere Checks |
| `.cw-white` | `#FFFFFF` | Ink / `#D3D4D7` | Report, FAQ |
| `.cw-grey` | `#E6E7E9` | Ink / `#D3D4D7` | Preise (weiße Karten heben sich ab) |
| `.cw-peach` | `#FFE6DD` | Ink / `#F5CDBF`, Akzent-Text `#B4411E` | Ablauf, Warum Pixelkiez |
| `.cw-lilac` | `#EBE2FC` | Ink / `#D9CCF6`, Akzent-Text `#5B3FA6` | So nutzen Sie den Report, Pro, Abschluss + Footer |

- Reihenfolge: Papier → Pfirsich → Weiß → Papier → Lila → Papier → Lila → Pfirsich → Grau → Weiß → Papier → Lila. Nie zwei gleiche Farbflächen direkt hintereinander („Pro“ steht deshalb hinter „Für wen“).
- Weiße Karten bleiben auf allen Flächen weiß mit Haarlinie in der Linienfarbe der Fläche.
- Buttons auf Pfirsich und Lila: Orange mit schwarzer Schrift (Hauptaktion) oder Ghost.

### Verlauf
- Zweifarbiger, weicher Schein oben im Hero: Pfirsich links, Lila rechts — `radial-gradient(42% 62% at 30% 0%, rgb(255 230 221 / .95), transparent 72%), radial-gradient(42% 62% at 70% 0%, rgb(235 226 252 / .95), transparent 72%)`. Keine weiteren Verläufe.

## Typography
**Archivo** (Headlines + Text) und **IBM Plex Mono** (Labels, Meta, Zahlen im Report), dieselben Familien wie auf pixelkiez.de. Beide frei über Google Fonts verfügbar.

| Rolle | Font | Größe (Mobile → Desktop) | Gewicht | Line-height | Tracking |
|---|---|---|---|---|---|
| H1 | Archivo | `clamp(46px, 7.4vw, 104px)` | 500 | 0.98 | −0.05em |
| H2 | Archivo | `clamp(32px, 4.2vw, 52px)` | 500 | 1.05 | −0.035em |
| H3 (Schritte, Report) | Archivo | 22–24px | 500 | 1.25 | −0.02em |
| Lead | Archivo | `clamp(18px, 1.7vw, 21px)` | 400 | 1.5 | 0 |
| Body | Archivo | 17px | 400 | 1.6 | 0 |
| Eyebrow / Label | IBM Plex Mono | 12px, UPPERCASE | 500 | 1.4 | +0.12em |
| Meta / Fakten | IBM Plex Mono | 12–13px | 400 | 1.5 | 0 |
| Score-Zahl | Archivo, tabular-nums | 21px (klein) / 42px (groß) | 600 | 1 | −0.04em |
| Preis | Archivo, tabular-nums | 48px | 500 | 1 | −0.045em |
| Button | Archivo | 14–15px | 600 | 1 | 0 |

- **Gemischte Schreibung** in Headlines für schnelle Lesbarkeit im Produkt. pixelkiez.de setzt Headlines in VERSALIEN (Archivo 400, −0.035em). Option für mehr Markennähe: H1/H2 in Versalien, Gewicht 400.
- Ein Akzentwort pro H1 in `--accent-text`, sonst keine farbige Typografie.
- Ansprache durchgehend mit **„Sie“** (wie pixelkiez.de).
- Zahlen in Report, Preisen und Balken immer `font-variant-numeric: tabular-nums`.

## Spacing
- **Basis-Raster 4px**, gängige Werte: `8 · 12 · 14 · 16 · 18 · 24 · 28 · 32 · 40 · 64 · 96`.
- **Section vertikal:** `clamp(72px, 10vw, 128px)`. Hero: `clamp(96px, 14vw, 176px)` oben / `clamp(88px, 12vw, 152px)` unten.
- **Rahmen (Pixelkiez-Raster):** Inhalt in einem 1280px breiten Rahmen mit 1px-Haarlinien links und rechts (`--line-soft`); Sections durch eine Haarlinie oben getrennt. Unter 1320px Breite entfallen die Seitenlinien.
- **Seitenrand:** `clamp(16px, 4vw, 48px)`.
- **Textbreiten:** Lead max. 46ch, Fließtext max. 52–62ch, H1 max. 13ch.
- **Grids:** Report 5/7 (Text/Karte), Schritte 3 Spalten mit vertikalen Haarlinien, Preise 3 Spalten (Gap 16px), FAQ 4/8.

## Radius & Tiefe
| Element | Radius |
|---|---|
| Buttons, URL-Feld, Navigation, Chips, Badge | 999px (Pill) |
| Karten (Ergebnis, Report, Preise) | 16px |
| Tags („Demo“, „Beispiel“) | 6px |
| Pixel-Punkt im Badge | 0 (Quadrat, Markenzitat) |

- **Keine Schatten.** Tiefe nur über Weiß-auf-Grau und 1px-Haarlinien.
- Hervorhebung über Rahmenstärke: empfohlener Preis mit `1.5px solid --ink`.
- Fokus: URL-Feld bekommt Ink-Rahmen + 5px-Ring in `--accent-soft`; sonst 2px Ink-Outline.

## Imagery
- Keine Fotos, keine Illustrationen, keine Logo-Wände. Das einzige „Bild“ ist der Report selbst (Score-Ring, Balken, Problemliste).
- Icons: Linien-Icons, 1.7px Strich, in Ink (Globus, Pfeil, Haken, Plus).
- Markenzitat: quadratischer Orange-„Pixel“ im Hero-Badge, blinkt langsam (`steps(1)`).

## Motion
| Zweck | Wert |
|---|---|
| Easing (von pixelkiez.de) | `cubic-bezier(.23, 1, .32, 1)` |
| Hover (Farbe, Rahmen) | 0.2s |
| Pfeil im Button | 3px nach rechts, 0.2s |
| Navigation schrumpft beim Scrollen | 0.3s |
| Ergebnis-Karte erscheint | 0.5s, 8px nach oben |
| Fortschrittsbalken der Demo-Analyse | 2.2s, Orange |
| Score-Ring + Zahl zählen hoch | 1.2s |
| FAQ-Plus dreht zu × | 0.4s |
| Tippender Platzhalter im URL-Feld | 75ms pro Zeichen, 2s Pause |

- `prefers-reduced-motion`: alle Animationen aus, Werte sofort sichtbar.

## Component language
### Navigation
Schwebende weiße Pill (72 % Deckkraft, Blur 16px, Haarlinie), sticky, schrumpft beim Scrollen. Links „Pixelkiez“ + Mono-Label „ANALYSE“ (getrennt durch Haarlinie), mittig 4 Links, rechts Ghost-Button „Anmelden“.

### Hero (nur URL-Eingabe)
Badge mit Orange-Pixel → H1 mit Akzentwort → ein Satz Lead → URL-Feld → drei Fakten mit Haken (Kostenlos · Ohne Anmeldung · Ergebnis in 30 Sekunden). Sonst nichts.

### URL-Feld
68px hoch, weiß, Rahmen `--line`, Globus-Icon links, Orange-Button „Analysieren →“ rechts im Feld. Mobil bricht der Button unter das Feld und wird vollbreit.

### Ergebnis-Karte (nach dem Absenden)
Weiß, 16px Radius, Haarlinie. Ladezustand: Mono-Statuszeile + 3px Orange-Fortschrittsbalken. Danach: kleiner Score-Ring (Ink), Domain + Urteil, drei Probleme mit Status-Punkt, Link zur Report-Vorschau.

### Buttons
| Variante | Fläche / Text | Einsatz |
|---|---|---|
| Accent | `#FE5B2A` / `#0C0C0C` | „Analysieren“, empfohlener Preis |
| Ink | `#0C0C0C` / `#EFF0F1` | Abschluss-CTA |
| Ghost | transparent, Rahmen `--line` → Hover `--ink` | Anmelden, weitere Preise |

### Report-Karte
Kopfzeile (Domain in Mono + Tag „Beispiel“) → großer Score-Ring 132px in Ink mit „von 100“ → Urteil + Meta-Zeile → 5 Kategorie-Balken (Label · 4px-Balken in Ink · Wert · Status-Punkt) → „Zuerst beheben“ mit 3 Zeilen.

### Schritte
Ohne Karten: Mono-Nummer in `--accent-text`, H3, ein Satz. Spalten durch vertikale Haarlinien getrennt, mobil durch horizontale.

### Preise
Drei weiße Karten. Empfohlen: 1.5px Ink-Rahmen + Orange-Pill „EMPFOHLEN“ mit schwarzer Schrift + Orange-Button. Andere: Ghost-Buttons.

### FAQ
Haarlinien-getrennte Zeilen, Frage 19px/500, runder Plus-Button mit Haarlinie, dreht beim Öffnen. Native `<details>`.

### Abschluss + Footer
Abschluss: zentrierte H2 + Ink-Button, der zurück zum URL-Feld springt. Footer: eine Zeile mit Copyright links und Rechtslinks rechts.

---

## CSS-Token-Startpunkt
```css
:root {
  color-scheme: light;
  --paper: #EFF0F1; --paper-2: #E6E7E9; --surface: #FFFFFF;
  --ink: #0C0C0C; --ink-70: #2F3032; --ink-45: #646568;
  --line: #C3C4C8; --line-soft: #D3D4D7;
  --accent: #FE5B2A; --accent-hover: #E75326; --accent-text: #E75326; --accent-ink: #B4411E; --accent-soft: #FFE6DD;
  --lilac: #C8ACF8; --lilac-soft: #EBE2FC; --lilac-line: #D9CCF6; --lilac-text: #5B3FA6;
  --good: #1E9E5A; --warn: #E8A317; --bad: #D92D20;
  --font-sans: "Archivo", Arial, sans-serif;
  --font-mono: "IBM Plex Mono", "SFMono-Regular", Menlo, monospace;
  --r-pill: 999px; --r-card: 16px; --r-tag: 6px;
  --section-y: clamp(72px, 10vw, 128px); --frame: 1280px; --gutter: clamp(16px, 4vw, 48px);
  --ease: cubic-bezier(.23, 1, .32, 1);
}
```

## Bewusst nicht übernommen
- **Aus v1 verworfen (Feedback 2026-10-27):** Ultramarin-Akzent und Geist-Schrift, dunkler Gesamtlook (Dark Mode), schwarze Abschnitte und vollflächiges Knall-Orange, Live-Audit-Mockup im Hero, Logo-Laufband, Kundenstimmen, Kennzahlen-Kacheln, Pro-Dashboard.
- Lavendel/Mint-Look (Semrush-Markenfarben), Neon-Lime/Pink (Typesomething), Sticker, Custom-Cursor und Riesen-Display (Dovv), Foto-Hero mit Personen (Sphere).
- Mehrere Upsell-Bänder hintereinander und lange SEO-Textstrecken auf der Startseite (Semrush).
