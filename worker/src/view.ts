import { h } from './http';
import { displayWebsite } from './url';

/* Serverseitig gerenderte Seiten des Anfrageablaufs. Nutzt das bestehende Design (assets/styles.css, ausgeliefert
   vom statischen Frontend auf derselben Domain) plus assets/anfrage.css. Kein JavaScript. Alle variablen Werte laufen durch h(). */
export class View {
  constructor(private base = '') {}

  /* Eingabe wie im Hero der Startseite: Website, AGB-Häkchen (nie vorausgewählt), „Analysieren“. Für Fehler ohne JavaScript
     und nach einer abgebrochenen Anmeldung. Das erste fehlerhafte Feld bekommt den Fokus (autofocus). */
  input(termsVersion: string, value = '', errors: { url?: string | null; agb?: string | null } = {}, notice: string | null = null): string {
    const base = h(this.base);
    const urlError = errors.url ?? null;
    const agbError = errors.agb ?? null;
    const first = urlError !== null ? 'url' : agbError !== null ? 'agb' : null;
    const invalid = (id: string, error: string | null): string => (error !== null ? ` aria-invalid="true" aria-describedby="${id}-error"${first === id ? ' autofocus' : ''}` : '');
    const body = '<div class="section-head"><p class="eyebrow">Kostenlose Website-Analyse</p><h1 class="h2">Welche Website sollen wir analysieren?</h1>'
      + '<p class="text">Nach dem Klick auf „Analysieren“ melden Sie sich mit Google an. Danach speichern wir Ihre Anfrage ohne weiteren Klick, und Pixelkiez erstellt die Analyse persönlich.</p></div>'
      + (notice !== null ? `<p class="request-notice" role="status">${h(notice)}</p>` : '')
      + '<div class="request-grid">'
      + `<form class="analyze request-form" method="post" action="${base}/api/anfrage">`
      + `<input type="hidden" name="action" value="start"><input type="hidden" name="agb_version" value="${h(termsVersion)}">`
      + '<label class="sr-only" for="url">Adresse Ihrer Website</label>'
      + `<div class="url-field"><input id="url" name="website" type="text" inputmode="url" autocomplete="url" maxlength="2048" placeholder="ihre-website.de" value="${h(value)}"${invalid('url', urlError)}>`
      + '<button class="btn btn--accent" type="submit">Analysieren</button></div>'
      + (urlError !== null ? `<p class="form-error" id="url-error" role="alert">${h(urlError)}</p>` : '')
      + `<label class="consent"><input id="agb" type="checkbox" name="agb" value="1" required${invalid('agb', agbError)}>`
      + `<span>Ich akzeptiere die <a class="request-link" href="${base}/agb.html">AGB</a> von 360°Pixelkiez.</span></label>`
      + (agbError !== null ? `<p class="form-error" id="agb-error" role="alert">${h(agbError)}</p>` : '')
      + `<p class="request-small">Kostenlose Website-Analyse – 0 €, kein Abo. <a class="request-link" href="${base}/datenschutz.html">Datenschutzerklärung</a></p>`
      + '</form>'
      + '<div class="request-side"><h2 class="request-h">Hinweise zur Datenverarbeitung</h2><ul class="request-notes">'
      + '<li>Vor der Google-Anmeldung speichern wir Ihre Website-Adresse sowie Version und Zeitpunkt Ihrer Zustimmung zu den AGB vorübergehend in einer serverseitigen Sitzung. Wird die Anmeldung nicht abgeschlossen, entsteht daraus kein Auftrag, und Pixelkiez erhält keine Benachrichtigung.</li>'
      + '<li>Erst nach erfolgreicher Google-Anmeldung und mit gültiger Zustimmung entsteht der eigentliche kostenlose Analyseauftrag. Erst dann ordnen wir ihm Ihre von Google bestätigte E-Mail-Adresse und die Kennung Ihres Google-Kontos zu; dazu kommen der Zeitpunkt der Anfrage sowie Version und Zeitpunkt Ihrer Zustimmung zu den AGB.</li>'
      + '<li>Zweck: Pixelkiez erstellt damit Ihre Analyse und schickt Ihnen den Bericht als PDF mit sieben Seiten an diese E-Mail-Adresse.</li>'
      + '<li>Die Anmeldung läuft über Google. Wir erhalten nur Konto-Kennung und bestätigte E-Mail-Adresse, keinen Zugriff auf Ihr Postfach.</li>'
      + '<li>Pixelkiez wird intern per E-Mail über Ihre Anfrage informiert.</li>'
      + '<li>Ihre Website wird von dieser Seite nicht automatisch abgerufen oder gescannt.</li>'
      + '</ul></div></div>';
    return this.page('Website eingeben', body);
  }

  accepted(reference: string, url: string, email: string, kind: 'created' | 'duplicate'): string {
    const head = kind === 'duplicate'
      ? '<p class="eyebrow">Bereits angefragt</p><h1 class="h2">Diese Website ist schon angefragt.</h1>'
        + `<p class="text">Für <span class="mono request-break">${h(displayWebsite(url))}</span> liegt mit Ihrem Google-Konto bereits eine Anfrage vor. Wir haben keine zweite Anfrage angelegt.</p>`
      : '<p class="eyebrow">Anfrage gespeichert</p><h1 class="h2">Ihre Anfrage liegt bei uns.</h1>'
        + `<p class="text">Pixelkiez analysiert <span class="mono request-break">${h(displayWebsite(url))}</span> persönlich und schickt Ihnen den PDF-Bericht mit sieben Seiten an <b class="request-break">${h(email)}</b>. Eine feste Bearbeitungszeit sagen wir nicht zu.</p>`;
    const body = `<div class="section-head">${head}`
      + `<p class="request-ref">Referenz <b class="mono" id="reference">${h(reference)}</b></p>`
      + `<p><a class="btn btn--ghost btn--sm" href="${h(this.base)}/index.html">Zur Startseite</a></p></div>`;
    return this.page(kind === 'duplicate' ? 'Bereits angefragt' : 'Anfrage gespeichert', body);
  }

  error(title: string, message: string, action = 'Zur Startseite', href = '/index.html'): string {
    const body = `<div class="section-head"><p class="eyebrow">Hinweis</p><h1 class="h2">${h(title)}</h1><p class="text">${h(message)}</p>`
      + `<p><a class="btn btn--ghost btn--sm" href="${h(this.base + href)}">${h(action)}</a></p></div>`;
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
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600&amp;family=IBM+Plex+Mono:wght@400;500&amp;display=swap">
<link rel="stylesheet" href="${b}/assets/styles.css">
<link rel="stylesheet" href="${b}/assets/anfrage.css">
</head>
<body>
<header class="nav-wrap" id="nav">
  <nav class="nav" aria-label="Hauptnavigation">
    <a class="logo" href="${b}/index.html#top">360°Pixelkiez<span>Analyse</span></a>
    <div class="nav-links"><a href="${b}/index.html#bericht">Bericht</a><a href="${b}/index.html#bereiche">Bereiche</a><a href="${b}/index.html#angebot">Angebot</a><a href="${b}/index.html#faq">FAQ</a></div>
    <a class="btn btn--ghost btn--sm" href="${b}/index.html">Start</a>
  </nav>
</header>
<main class="frame" id="top">
  <section class="section request">${main}</section>
  <footer class="cw-lilac">
    <div class="footer">
      <span>© 2026 360°Pixelkiez</span>
      <nav aria-label="Rechtliches"><a href="${b}/impressum.html">Impressum</a><a href="${b}/datenschutz.html">Datenschutz</a><a href="mailto:kontakt@pixelkiez.de">Kontakt</a></nav>
    </div>
  </footer>
</main>
</body>
</html>`;
  }
}
