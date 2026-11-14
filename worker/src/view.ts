import { h } from './http';
import { displayWebsite } from './url';

/* Serverseitig gerenderte Seiten des Anfrageablaufs (PO-Entscheidung 12.11.2026): Website im Hero → „Analysieren“ →
   Bestätigungsseite mit genau einem Pflichtkästchen → Google-Anmeldung → Eingangsbestätigung. Jede Seite ist eine schmale Karte
   mittig im bestehenden Design (assets/styles.css, ausgeliefert vom statischen Frontend auf derselben Domain, plus
   assets/anfrage.css). Kein JavaScript. Alle variablen Werte laufen durch h(). */
/* Wortlaut des einen Kästchens (AGB § 4 Abs. 1, Datenschutzerklärung Abschnitt 8). Er wird beim Auftrag gespeichert; jede Änderung
   des Wortlauts ist eine neue Fassung und braucht eine neue AGB-Version. */
export const DECLARATIONS = {
  confirmation: 'Ich handle geschäftlich oder für eine Organisation, akzeptiere die AGB und habe die Datenschutzerklärung zur Kenntnis genommen.',
} as const;

const HINWEIS = '<p class="anfrage-hinweis">Kostenlos · 0 € · kein Abonnement</p>';
/* Zeichen der Eingangsbestätigung: grüner Haken (zeichnet sich nur bei erlaubter Bewegung, anfrage.css) */
const HAKEN = '<svg class="anfrage-zeichen" viewBox="0 0 64 64" aria-hidden="true" focusable="false"><circle class="anfrage-zeichen-kreis" cx="32" cy="32" r="30"/><path class="anfrage-zeichen-strich" d="M20 33.5l8 8L44.5 24" pathLength="1"/></svg>';

export class View {
  constructor(private base = '') {}

  /* Adresse eingeben: ohne JavaScript nach einer ungültigen Eingabe im Hero, bei direktem Aufruf und nach Ablauf der Sitzung.
     Der Fehler bekommt den Fokus (autofocus). */
  address(value = '', error: string | null = null): string {
    const base = h(this.base);
    const invalid = error !== null ? ' aria-invalid="true" aria-describedby="url-error" autofocus' : '';
    const body = '<h1 class="anfrage-titel">Welche Website sollen wir analysieren?</h1>'
      + `<form class="anfrage-form" method="post" action="${base}/api/anfrage" novalidate>`
      + '<input type="hidden" name="action" value="adresse">'
      + '<label class="sr-only" for="url">Adresse Ihrer Website</label>'
      + `<div class="url-field"><input id="url" name="website" type="text" inputmode="url" autocomplete="url" maxlength="2048" placeholder="ihre-website.de" value="${h(value)}"${invalid}>`
      + '<button class="btn btn--accent" type="submit">Analysieren</button></div>'
      + (error !== null ? `<p class="form-error" id="url-error" role="alert">${h(error)}</p>` : '')
      + '</form>'
      + HINWEIS;
    return this.page('Website eingeben', body);
  }

  /* Bestätigungsseite (AGB § 3 Abs. 2 b, § 4 Abs. 1): eingegebene Adresse, genau ein Pflichtkästchen, nicht vorausgewählt, mit
     funktionierenden Links zu AGB und Datenschutzerklärung, dann „Mit Google anmelden“ und direkt darunter der Hinweis, wohin die PDF
     geht. Das Formular trägt Adresse und AGB-Version dieser Seite; der Worker prüft beides und das Häkchen verbindlich, bevor er zu
     Google weiterleitet. Ohne JavaScript bedienbar. */
  confirm(termsVersion: string, url: string, error: string | null = null, notice: string | null = null): string {
    const base = h(this.base);
    const invalid = error !== null ? ' aria-invalid="true" aria-describedby="bestaetigung-error" autofocus' : '';
    const label = h(DECLARATIONS.confirmation)
      .replace('AGB', `<a href="${base}/agb.html">AGB</a>`)
      .replace('Datenschutzerklärung', `<a href="${base}/datenschutz.html">Datenschutzerklärung</a>`);
    const body = (notice !== null ? `<p class="anfrage-notiz" role="status">${h(notice)}</p>` : '')
      + '<h1 class="anfrage-titel">Analyse anfragen</h1>'
      + '<div class="anfrage-adresse"><p class="anfrage-label">Ihre Website</p>'
      + `<p class="anfrage-url mono">${h(displayWebsite(url))}</p>`
      + `<a class="anfrage-aendern" href="${base}/index.html#top">Adresse ändern</a></div>`
      + `<form class="anfrage-form" method="post" action="${base}/api/anfrage" novalidate>`
      + `<input type="hidden" name="action" value="start"><input type="hidden" name="agb_version" value="${h(termsVersion)}"><input type="hidden" name="website" value="${h(url)}">`
      /* autocomplete="off": Browser stellen das Häkchen beim Zurückblättern nicht wieder her – es ist nie vorausgewählt */
      + `<label class="consent"><input id="bestaetigung" type="checkbox" name="bestaetigung" value="1" autocomplete="off" required${invalid}><span>${label}</span></label>`
      + (error !== null ? `<p class="form-error" id="bestaetigung-error" role="alert">${h(error)}</p>` : '')
      + '<button class="btn btn--accent btn--block" type="submit" aria-describedby="google-hinweis">Mit Google anmelden</button>'
      + '<p class="anfrage-google" id="google-hinweis">Wir senden die PDF an die angemeldete Google E-Mail-Adresse.</p>'
      + '</form>'
      + HINWEIS;
    return this.page('Analyse anfragen', body);
  }

  /* Nach tatsächlich gespeicherter Anfrage (auch bei erneuter Absendung desselben Vorgangs mit derselben Referenz). Keine
     zugesagte Lieferfrist und keine Aussage, der Vertrag sei angenommen (AGB § 3 Abs. 3 und 4). */
  accepted(reference: string, url: string, email: string): string {
    const head = `${HAKEN}<h1 class="anfrage-titel">Vielen Dank für Ihre Anfrage.</h1>`
      + '<p class="anfrage-text">Ihre Anfrage ist bei uns eingegangen. Wir melden uns per E-Mail bei Ihnen.</p>';
    const body = '<div class="anfrage-fertig">' + head + '<dl class="anfrage-daten">'
      + `<div><dt>Website</dt><dd class="mono">${h(displayWebsite(url))}</dd></div>`
      + `<div><dt>E-Mail</dt><dd>${h(email)}</dd></div>`
      + `<div><dt>Referenz</dt><dd class="mono" id="reference">${h(reference)}</dd></div></dl>`
      + `<a class="btn btn--ghost btn--sm" href="${h(this.base)}/index.html">Zur Startseite</a></div>`;
    return this.page('Anfrage eingegangen', body);
  }

  error(title: string, message: string, action = 'Zur Startseite', href = '/index.html'): string {
    const body = `<h1 class="anfrage-titel">${h(title)}</h1><p class="anfrage-text">${h(message)}</p>`
      + `<a class="btn btn--ghost btn--sm" href="${h(this.base + href)}">${h(action)}</a>`;
    return this.page(title, body);
  }

  private page(title: string, main: string): string {
    const b = h(this.base);
    return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<title>${h(title)} | 360°Pixelkiez</title>
<meta name="description" content="Kostenlose Website-Analyse von 360°Pixelkiez: Anfrage mit Google-Anmeldung.">
<link rel="stylesheet" href="${b}/assets/fonts.css">
<link rel="stylesheet" href="${b}/assets/styles.css">
<link rel="stylesheet" href="${b}/assets/anfrage.css">
</head>
<body>
<header class="nav-wrap" id="nav">
  <nav class="nav" aria-label="Hauptnavigation">
    <a class="logo" href="${b}/index.html#top">360°<img class="logo-bild" src="${b}/media/pixelkiez-logo.webp" alt="Pixelkiez" width="518" height="120" decoding="async"><span>Website-Analyse</span></a>
    <div class="nav-links">
      <a href="${b}/index.html#bericht">Bericht</a>
      <a href="${b}/index.html#bereiche">Bereiche</a>
      <a href="${b}/index.html#angebot">Angebot</a>
      <a href="${b}/index.html#faq">FAQ</a>
      <a href="${b}/wissen/index.html">Wissen</a>
      <details class="mega">
        <summary aria-label="Beiträge im Wissensbereich"><svg class="mega-pfeil" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></summary>
        <ul class="mega-panel">
          <li><a href="${b}/wissen/seo-geo-ai-visibility.html">SEO, GEO und AI Visibility: Begriffe, Grundlagen, Grenzen</a></li>
          <li><a href="${b}/wissen/wie-ki-websites-liest.html">Wie KI-Systeme Ihre Website abrufen und was dabei ankommt</a></li>
          <li><a href="${b}/wissen/wie-websites-ausgeliefert-werden.html">Was Ihre Website beim ersten Abruf tatsächlich ausliefert</a></li>
          <li><a href="${b}/wissen/answerability.html">Answerability: Wann eine Website Kundenfragen wirklich beantwortet</a></li>
          <li><a href="${b}/wissen/entity-trust.html">Entity Trust: Ist Ihr Unternehmen für Maschinen eindeutig?</a></li>
          <li><a href="${b}/wissen/agent-readiness.html">Agent-Readiness: Von der lesbaren zur bedienbaren Website</a></li>
          <li class="mega-mehr"><a href="${b}/wissen/index.html">Mehr im Wissensbereich <span aria-hidden="true">→</span></a></li>
        </ul>
      </details>
    </div>
    <a class="btn btn--ghost btn--sm" href="${b}/analyse/index.html">Analyse</a>
    <details class="nav-menu">
      <summary aria-label="Menü"><svg class="nav-menu-auf" viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false"><path d="M3 6h14M3 10h14M3 14h14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg><svg class="nav-menu-zu" viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false"><path d="M5 5l10 10M15 5 5 15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></summary>
      <ul class="nav-menu-panel">
        <li><a href="${b}/index.html#bericht">Bericht</a></li>
        <li><a href="${b}/index.html#bereiche">Bereiche</a></li>
        <li><a href="${b}/index.html#angebot">Angebot</a></li>
        <li><a href="${b}/index.html#faq">FAQ</a></li>
        <li><a href="${b}/wissen/index.html">Wissen</a></li>
      </ul>
    </details>
  </nav>
</header>
<main class="frame" id="top">
  <section class="section request"><div class="anfrage">${main}</div></section>
  <footer class="cw-lilac">
    <div class="footer">
      <span>© 2026 360°Pixelkiez</span>
      <a href="https://pixelkiez.de/" target="_blank" rel="noopener"><img class="footer-partner" src="${b}/assets/partner/pixelkiez.png" alt="Pixelkiez" width="87" height="20"></a>
      <nav aria-label="Rechtliches"><a href="${b}/impressum.html">Impressum</a><a href="${b}/datenschutz.html">Datenschutz</a><a href="mailto:360@pixelkiez.de">Kontakt</a></nav>
    </div>
  </footer>
</main>
</body>
</html>`;
  }
}
