import { h } from './http';
import { displayWebsite } from './url';

/* Serverseitig gerenderte Seiten des Anfrageablaufs. Nutzt das bestehende Design (assets/styles.css, ausgeliefert
   vom statischen Frontend auf derselben Domain) plus assets/anfrage.css. Kein JavaScript. Alle variablen Werte laufen durch h(). */
/* Wortlaut der Kästchen (Datenschutzerklärung Abschnitte 8 und 12, AGB §§ 3, 4, 6). Diese Texte werden beim Auftrag gespeichert;
   jede Änderung des Wortlauts ist eine neue Fassung und braucht eine neue AGB- oder Datenschutz-Version. */
const DATENSCHUTZ_VERWEIS = 'Datenschutzerklärung, Abschnitt 12';
export const DECLARATIONS = {
  terms: 'Ich beauftrage die kostenlose Website-Analyse für die angegebene Adresse. Es gelten die AGB. Die Datenschutzerklärung habe ich zur Kenntnis genommen.',
  business: 'Ich frage die Analyse als Unternehmer an (gewerblich, freiberuflich, Verein oder Organisation, § 14 BGB).',
  marketing: 'Ja, 360°Pixelkiez darf mir per E-Mail Informationen und Angebote zur Website-Analyse von 360°Pixelkiez, Fachinformationen zu Website-Technik, SEO und KI-Auffindbarkeit sowie Bitten um Feedback zu meinem Bericht senden – auch als Newsletter. Ich kann diese Einwilligung jederzeit widerrufen, z. B. über den Abmeldelink in jeder E-Mail oder per Mail an 360@pixelkiez.de. Details: ' + DATENSCHUTZ_VERWEIS + '.',
} as const;

export class View {
  constructor(private base = '') {}

  /* Eingabe (Ablauf laut AGB § 3): Website, zwei Pflichtkästchen (AGB, Unternehmer) und ein freiwilliges Kästchen für werbliche
     E-Mails, keins vorausgewählt; dann „Analyse anfragen“ und Google-Anmeldung. Für Fehler ohne JavaScript und nach einer
     abgebrochenen Anmeldung. Das erste fehlerhafte Feld bekommt den Fokus (autofocus). Die Kästchentexte stehen in DECLARATIONS
     und werden mit dem Auftrag gespeichert (Nachweis nach Art. 7 Abs. 1 DSGVO). */
  input(termsVersion: string, value = '', errors: { url?: string | null; agb?: string | null; business?: string | null } = {}, notice: string | null = null): string {
    const base = h(this.base);
    const urlError = errors.url ?? null;
    const agbError = errors.agb ?? null;
    const businessError = errors.business ?? null;
    const first = urlError !== null ? 'url' : agbError !== null ? 'agb' : businessError !== null ? 'unternehmer' : null;
    const invalid = (id: string, error: string | null): string => (error !== null ? ` aria-invalid="true" aria-describedby="${id}-error"${first === id ? ' autofocus' : ''}` : '');
    const box = (id: string, required: boolean, error: string | null, html: string): string =>
      `<label class="consent"><input id="${id}" type="checkbox" name="${id}" value="1"${required ? ' required' : ''}${invalid(id, error)}><span>${html}</span></label>`
      + (error !== null ? `<p class="form-error" id="${id}-error" role="alert">${h(error)}</p>` : '');
    const body = '<div class="section-head"><p class="eyebrow">Kostenlose Website-Analyse</p><h1 class="h2">Welche Website sollen wir analysieren?</h1>'
      + '<p class="text">Nach dem Klick auf „Analyse anfragen“ melden Sie sich mit Google an. Mit der erfolgreichen Anmeldung ist Ihre Anfrage abgeschickt; bricht die Anmeldung ab, speichern wir keine Anfrage. Pixelkiez erstellt die Analyse persönlich.</p></div>'
      + (notice !== null ? `<p class="request-notice" role="status">${h(notice)}</p>` : '')
      + '<div class="request-grid">'
      + `<form class="analyze request-form" method="post" action="${base}/api/anfrage">`
      + `<input type="hidden" name="action" value="start"><input type="hidden" name="agb_version" value="${h(termsVersion)}">`
      + '<label class="sr-only" for="url">Adresse Ihrer Website</label>'
      + `<div class="url-field"><input id="url" name="website" type="text" inputmode="url" autocomplete="url" maxlength="2048" placeholder="ihre-website.de" value="${h(value)}"${invalid('url', urlError)}>`
      + '<button class="btn btn--accent" type="submit">Analyse anfragen</button></div>'
      + (urlError !== null ? `<p class="form-error" id="url-error" role="alert">${h(urlError)}</p>` : '')
      + box('agb', true, agbError, `Ich beauftrage die kostenlose Website-Analyse für die angegebene Adresse. Es gelten die <a class="request-link" href="${base}/agb.html">AGB</a>. Die <a class="request-link" href="${base}/datenschutz.html">Datenschutzerklärung</a> habe ich zur Kenntnis genommen.`)
      + box('unternehmer', true, businessError, h(DECLARATIONS.business))
      + box('werbung', false, null, `Freiwillig: ${h(DECLARATIONS.marketing.replace(DATENSCHUTZ_VERWEIS + '.', ''))}<a class="request-link" href="${base}/datenschutz.html#werbung">${DATENSCHUTZ_VERWEIS}</a>.`)
      + '<p class="request-small">Kostenlose Website-Analyse – 0 €, kein Abo. Die Analyse erhalten Sie auch ohne Einwilligung in werbliche E-Mails.</p>'
      + '</form>'
      + '<div class="request-side"><h2 class="request-h">Hinweise zur Datenverarbeitung</h2><ul class="request-notes">'
      + '<li>Vor der Google-Anmeldung speichern wir Ihre Website-Adresse und Ihre Angaben aus den Kästchen höchstens zehn Minuten in einer serverseitigen Sitzung. Wird die Anmeldung nicht abgeschlossen, entsteht daraus kein Auftrag, und Pixelkiez erhält keine Benachrichtigung.</li>'
      + '<li>Erst nach erfolgreicher Google-Anmeldung entsteht der kostenlose Analyseauftrag. Dazu speichern wir Ihre von Google bestätigte E-Mail-Adresse, die Kennung Ihres Google-Kontos, den Zeitpunkt der Anfrage sowie Wortlaut, Version und Zeitpunkt Ihrer Bestätigungen. Die Anfragedaten löschen wir automatisch vier Monate nach Eingang.</li>'
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
  <section class="section request">${main}</section>
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
