# Page Structure Blueprint – PXK Website-Analyse
> Extrahiert aus: https://www.semrush.com/siteaudit/ (Wettbewerber, UI-Referenz) · https://www.spheredigitalrecruitment.com/ · https://typesomething.co/ · https://dovvstudio.com/ (Design-/Architektur-Inspiration) — 2026-10-27
> Copy-Beispiele der Referenzen werden nur als **Muster** zitiert. Deutsche Beispiele sind eigene Platzhalter zur Veranschaulichung.

## Kernprinzip
**Der Hero ist das Tool** (Semrush) — URL rein, Wert sofort. **Die Demo ersetzt den Screenshot** (Typesomething). **Die Seite bleibt kurz** (Type ≈ 5.300px statt Semrush ≈ 14.600px): Ziel ≤ 7.000px Desktop-Höhe.

## Seitenarchitektur
```
/                       Homepage (Tool-Hero + Verkauf)
/analyse?url=…          Gratis-Report (Teaser, Score + Top-Issues, Pro-Inhalte gesperrt)
/preise                 Pricing + Vergleichstabelle + FAQ
/funktionen             Check-Kategorien im Detail (je Kategorie Anker oder Unterseite)
/beispiel-report        Öffentlicher Demo-Report (Vertrauen + SEO)
/ressourcen             Blog / Ratgeber (SEO-Fragen-Artikel)
/check/{plattform}      Programmatic SEO: „Website-Check für WordPress / Shopify / Wix / Webflow …“
/login · /app/…         Dashboard (Projekte, Monitoring, Reports, Alerts)
/impressum · /datenschutz · /agb
```
Herkunft: Free-Tool-Landingpage als Funnel-Einstieg + „Other free tools“-Linkhub (Semrush), Programmatic-Landingpages im Footer (Dovv), Ressourcen-Hub (Type).

## Homepage section order
| # | Section | Pattern | Quelle |
|---|---|---|---|
| 0 | **Nav** | Schwebende Pill, sticky, schrumpft beim Scrollen. Logo · Funktionen · Preise · Beispiel-Report · Ressourcen · Anmelden · [Kostenlos analysieren] | Type + Semrush (Links sichtbar) |
| 1 | **Hero = Tool** | Status-Pill → H1 (1 Akzentwort) → Lead (~25 Wörter) → URL-Eingabe mit integriertem Button → Beispiel-Chips + Kontingent → USP-Leiste (3 Spalten) | Dovv/Type Pill · Sphere Akzentwort · Semrush Tool · Type USP |
| 2 | **Trust-Leiste** | Label „Vertraut von“ zwischen Hairlines + Logo-Marquee (graustufig) + Live-Zähler analysierter Websites | Dovv Marquee, Semrush Logo-Wall |
| 3 | **Live-Audit-Demo** | Browser-Mockup: Crawl-Schritte tippen sich durch, Score-Ring zählt hoch, Issues erscheinen nacheinander (IntersectionObserver) | Type Chat-Demo |
| 4 | **So funktioniert's** | Eyebrow + H2, 3 Schritt-Karten (01 URL eingeben → 02 Analyse in Sekunden → 03 Priorisierte To-dos) | Semrush 3 Schritte, Type Steps, Dovv Nummerierung |
| 5 | **Was wir prüfen** | Flächenwechsel auf Weiß. 6 Karten (3×2): Performance · Technisches SEO · Inhalte & Meta · Barrierefreiheit · Sicherheit & DSGVO · AI-Search-Sichtbarkeit — Titel metrik-geführt | Type Feature-Grid, Semrush Check-Kategorien + AI-Search |
| 6 | **Gratis vs. Pro** | 2-Spalter: links einfacher Score-Ring (Gratis), rechts dichtes Dashboard (Trends, Benchmark-Gauge, Issue-Liste) + 1 kontextueller Upgrade-CTA | Semrush visueller Upsell (nur 1× statt 4×) |
| 7 | **Ergebnisse** | Vorher/Nachher-Kennzahl-Kacheln („58 → 91“), optional Case-Slider mit angeschnittener Folgekarte + Progress-Bar | Semrush Vorher/Nachher, Sphere Case-Slider/Stats |
| 8 | **Testimonial** | Großes Zitat + Avatar + Rolle, links KPI + Mono-Zähler „01/05“ + Pfeile | Dovv (Semrush hat keine Testimonials → Differenzierung) |
| 9 | **Pricing** (Dark-Section) | Eyebrow + H2 (Kontrast-Claim), 3 Karten, Mitte hervorgehoben, Link „Alle Funktionen vergleichen“ | Dovv Pricing + Hell/Dunkel-Rhythmus |
| 10 | **FAQ** | 5–7 Fragen, Accordion, FAQPage-Schema | Semrush + Sphere-Accordion |
| 11 | **Abschluss-CTA** | Dunkles Panel (40px Radius), H2, URL-Eingabe erneut, Risk-Reversal-Microcopy | Type Dark-CTA |
| 12 | **Footer** | Logo + Claim · 4 Linkspalten (Produkt / Plattform-Checks / Ressourcen / Unternehmen) · Legal · Cookie-Einstellungen | Semrush/Type/Dovv |

**Flächen-Rhythmus:** `--bg` (Hero–Schritte) → `--surface` weiß (Prüfungen, Gratis/Pro) → `--bg` (Ergebnisse, Testimonial) → `--ink-deep` (Pricing) → `--bg` (FAQ) → Dark-Panel → Footer. Trennung nur über Flächenwechsel, keine Trennlinien zwischen Sections.

## Gratis-Report `/analyse` (Produkt-UI, Semrush-Dashboard-Muster)
1. Kopf: Domain + Screenshot-Thumbnail + Datum · Aktionen (PDF – Pro, Monitoring aktivieren)
2. Gesamt-Score-Ring + Benchmark-Gauge („Top 10 % deiner Branche“) + 3 Kennzahl-Kacheln (Kritisch · Warnungen · Bestanden)
3. Kategorie-Ringe in einer Reihe (Performance · SEO · Barrierefreiheit · Sicherheit · AI-Sichtbarkeit)
4. **„Zuerst beheben“** – Top-5-Issues mit Severity, betroffenen Seiten und Klartext-Empfehlung (Semrush-Value-Prop „what to fix first“)
5. Restliche Issues verschwommen + Lock → Upgrade-Karte (einziger Upsell auf der Seite)
6. Optional bei langen Reports: Floating Bottom-Pill-Nav für Sprünge zwischen Kategorien (Dovv)

## Copy patterns
### Headlines
- **Referenz-Formeln (Muster, nicht übernehmen):**
  - Sphere: „We + Verb + *Akzent-Adjektiv* + Nomen“ (4 Wörter, Verb an Position 2)
  - Type: „Negation des Status quo. Radikale Vereinfachung.“ – „Skip the X. Just Y.“ (2 Imperativ-Sätze, 5 Wörter)
  - Dovv: „We + Verb + Objekt + Wirkung“ (6 Wörter, Statement)
  - Semrush: H1 = Toolname als Keyword (2 Wörter), Benefit wandert in den Lead
- **Unsere Formel (Hybrid):** Nutzen-Statement mit 4–7 Wörtern + ein Akzentwort; Keyword steckt in H1 oder direkt im Lead.
  - Platzhalter: „Finde, was deine Website *ausbremst*.“ · „Schluss mit Raten. Klare To-dos für deine Website.“
- **Section-H2:** kurzer Kontrast-Claim mit Komma (Dovv: „Versprechen, Angst-Entkräftung“) oder SEO-Frage für Ratgeber-Sections (Semrush). Klare Aussagesätze bevorzugen, keine holprigen Fragen.
- **Feature-Titel metrik-geführt** (Type): „100+ Prüfpunkte in 30 Sekunden“, „Ladezeit in Millisekunden, nicht Bauchgefühl“.

### Subheads & Eyebrows
- Verhältnis Headline : Lead ≈ 1 : 4 (Wörter). Lead-Formel (Semrush): **Tempo + konkreter Output + Priorisierung** — „In Sekunden … findest du … und weißt, was du zuerst beheben musst.“
- Jede Section: **Mono-Eyebrow (2–4 Wörter) + H2/Statement** (Sphere-Rhythmus, Verhältnis ≈ 1:3).

### CTAs
| Rolle | Verb / Text | Herkunft |
|---|---|---|
| Primär-Tool | „Website analysieren“ / „Kostenlos analysieren“ | Semrush „Analyze Website“ |
| Explore | „So funktioniert's ↓“, „Beispiel-Report ansehen“ | Type „See how it works“, Dovv „See our work“ |
| Upgrade | „Vollständigen Report freischalten“, „Pro 14 Tage testen“ | Semrush „Try [Produkt]“ |
| Sales/Agentur | „15-Min-Demo buchen“ | Dovv „Book a 15 min call“ |
| Nav | „Anmelden“ (Text) + „Kostenlos analysieren“ (Pill) | Semrush Log In + Start free |
- Verb zuerst, 2–3 Wörter, immer mit Pfeil-Icon. Kein UPPERCASE.

### Value-Props (wiederkehrend)
Tempo („in 30 Sekunden“) · Priorisierung („was zuerst“) · Klartext statt Fachchinesisch · messbarer Fortschritt (Score steigt) · AI-Search-Sichtbarkeit · DSGVO/Server in Deutschland (eigene Differenzierung).

### Microcopy / Risk-Reversal
- Unter Hero-Input und Abschluss-CTA: „Ohne Anmeldung. Ohne Kreditkarte.“ (Type „No account, no sign-up“, Semrush „Cancel anytime“, Dovv „Replies within 24h“)
- Pricing: „Monatlich kündbar“, „Einmalig, keine Verlängerung“.

## Navigation
- Top: schwebende Pill-Nav mit 4 sichtbaren Links + Login + Primär-CTA (kein Mega-Menü, kein Hamburger am Desktop).
- Mobile: Pill mit Logo + Primär-CTA + Menü-Icon → Fullscreen-Sheet.
- Report-/Langseiten: optionale Floating Bottom-Pill-Nav für Abschnittssprünge.
- Ankerlinks mit Smooth-Scroll für Homepage-Sections.

## Footer
- Spalte 1: Logo, 1-Satz-Claim, Firmierung (Pixelkiez), Social-Icons.
- Spalten 2–5: **Produkt** (Funktionen, Preise, Beispiel-Report, Changelog) · **Plattform-Checks** (Programmatic-SEO-Links) · **Ressourcen** (Ratgeber, Glossar, Hilfe) · **Unternehmen** (Über uns, Kontakt, Agentur-Partner).
- Bottom-Bar: © · Impressum · Datenschutz · AGB · Cookie-Einstellungen · Back-to-top.
- Kein Newsletter-Block, kein Mega-Typo-Claim.

## Conversion & Monetarisierung (Funnel-Struktur)
```
Hero-URL-Eingabe ─► Gratis-Teaser-Report (Score + Top-5) ─► E-Mail/Account für vollständigen Report
                                                         ├► Einzel-Report (einmalig, PDF)
                                                         └► Monitoring-Abo (wöchentliche Crawls, Trends, Alerts)
                                                              └► Agentur-Plan (mehrere Domains, White-Label-PDF)
```
- Semrush-Leiter (Free Check → Site Audit → Plattform) auf 3 Stufen gespiegelt; Gratis-Kontingent sichtbar (1/Tag), Missbrauchsschutz per Rate-Limit/Captcha.
- Upsell **kontextuell und einmalig** pro Seite (Section 6 + Lock im Report), nicht als wiederholtes Band.

## SEO-Grundgerüst (eigene Seite muss 100/100 erreichen — Glaubwürdigkeitsbeweis)
- Title: „Keyword: Nutzen | Marke“ (Semrush/Dovv: Keyword vorne). Description mit Keyword + Nutzen + Beweis (Dovv: „50+ clients, rated 4.9/5“-Muster).
- JSON-LD: `SoftwareApplication`/`WebApplication` + `Organization` + `FAQPage` (+ `VideoObject` falls Demo-Video). Type hat keins, Sphere nur Basis → besser machen.
- Eigenes og:image je Seite (Sphere-Fehler: og:title „Home“ vermeiden), korrekte Heading-Hierarchie (Sphere missbraucht H2 als Eyebrow → Eyebrow als `<p>`).

## Divergence (choices for the user)
| Dimension | Optionen in den Referenzen | Empfehlung |
|---|---|---|
| **Akzentfarbe** | Lavendel (Semrush, Sphere) · Neon-Lime (Type, Dovv) · Orange (Dovv-Brand) | **Ultramarin `#3D3DF5`** — Lavendel = Semrush-Verwechslung, Lime kollidiert mit „gut“-Grün. Alternative: Pixelkiez-Markenfarbe, falls vorhanden |
| **Headline-Gewicht** | 400 (Type) · 500 (Dovv) · 600 (Semrush) · 700 (Sphere) | **500** |
| **Hintergrund-Ton** | Weiß (Semrush) · kühles Grau `#F0F1F8` (Sphere) · warmes Off-White (Type) · neutral `#F5F5F5` (Dovv) | Neutral-warm `#F6F6F4` + weiße Karten |
| **Navigation** | Klassisch + Mega-Menü (Semrush) · Hamburger-only (Sphere) · Floating Top-Pill (Type) · Floating Bottom-Pill (Dovv) | **Floating Top-Pill mit sichtbaren Links**; Bottom-Pill nur im Report |
| **Hero-Visual** | Tool + Verlauf (Semrush) · Foto-Raster (Sphere) · Typo + Blobs (Type) · Riesen-Display + Sticker (Dovv) | Tool im Hero, Live-Demo direkt darunter |
| **Schritte** | 3 (Semrush, Type) · 4 (Dovv) | 3 |
| **Section-Übergänge** | harte Flächenwechsel (Type) · gerundete Overlap-Sheets (Sphere) · geschwungene Kante (Dovv) | Flächenwechsel; Overlap-Sheet nur in die Dark-Pricing-Section |
| **Motion-Intensität** | Lenis + Reveals (Sphere, Dovv) · Vanilla-Mikro-Animationen (Type) · kaum (Semrush) | Vanilla IO-Reveals + Count-ups, kein Smooth-Scroll-Zwang |
| **Seitenlänge/SEO-Text** | Longform ~4.000 Wörter unter dem Tool (Semrush) · kurz (Type, Dovv) | Homepage kurz; Longform auf `/check/*` und Ratgeber auslagern |
| **Mono-Font** | DM Mono (Dovv) · keiner (Rest) | Geist Mono für Labels + Zahlen |

## Tech-Hinweise aus den Referenzen
- Type & Dovv: **Astro** (statisch, Islands, Variable-Font self-hosted, kaum Bilder → 100/100). Semrush: Next.js mit atomarem CSS + Container-Queries. Sphere: WordPress-Theme.
- Naheliegend: Marketing-Site statisch (Astro), App/Dashboard separat (z. B. Next.js) mit denselben Design-Tokens aus DESIGN.md.
