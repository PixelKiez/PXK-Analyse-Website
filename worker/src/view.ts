import { h } from './http';
import { displayWebsite } from './url';

/* Serverseitig gerenderte Seiten des Anfrageablaufs. Nutzt das bestehende Design (assets/styles.css, ausgeliefert
   vom statischen Frontend auf derselben Domain) plus assets/anfrage.css. Kein JavaScript. Alle variablen Werte laufen durch h(). */
export class View {
  constructor(private base = '') {}

  input(value = '', error: string | null = null, notice: string | null = null): string {
    const invalid = error !== null ? ' aria-invalid="true" aria-describedby="url-error"' : '';
    const body = '<div class="section-head"><p class="eyebrow">Kostenlose Website-Analyse</p><h1 class="h2">Welche Website sollen wir analysieren?</h1>'
      + '<p class="text">Nach der Eingabe melden Sie sich mit Google an und bestätigen die Anfrage. Pixelkiez erstellt die Analyse danach persönlich.</p></div>'
      + (notice !== null ? `<p class="request-notice" role="status">${h(notice)}</p>` : '')
      + `<form class="analyze request-form" method="post" action="${h(this.base)}/api/anfrage">`
      + '<input type="hidden" name="action" value="start">'
      + '<label class="sr-only" for="url">Adresse Ihrer Website</label>'
      + `<div class="url-field"><input id="url" name="website" type="text" inputmode="url" autocomplete="url" maxlength="2048" placeholder="ihre-website.de" value="${h(value)}"${invalid}>`
      + '<button class="btn btn--accent" type="submit">Weiter mit Google</button></div>'
      + (error !== null ? `<p class="form-error" id="url-error" role="alert">${h(error)}</p>` : '')
      + '</form>';
    return this.page('Website eingeben', body);
  }

  confirm(url: string, email: string, csrf: string, idem: string, error: string | null = null): string {
    const base = h(this.base);
    const body = '<div class="section-head"><p class="eyebrow">Letzter Schritt</p><h1 class="h2">Anfrage bestätigen.</h1>'
      + '<p class="text">Bitte prüfen Sie die Angaben. Gespeichert wird der Auftrag erst, wenn Sie unten bestätigen.</p></div>'
      + '<div class="request-grid">'
      + '<article class="card detail" aria-label="Ihre Angaben"><div class="detail-top"><span>Kostenlose Website-Analyse</span><span class="tag">0 €</span></div><dl>'
      + `<div><dt>Website</dt><dd class="mono request-break">${h(displayWebsite(url))}</dd></div>`
      + `<div><dt>E-Mail</dt><dd class="request-break">${h(email)}<small class="request-meta">von Google bestätigt</small></dd></div>`
      + '<div><dt>Leistung</dt><dd>Persönliche Analyse in vier Bereichen. Bericht als PDF mit sieben Seiten per E-Mail.</dd></div>'
      + '<div><dt>Kosten</dt><dd>0 €, kein Abo, keine Folgekosten</dd></div>'
      + '</dl></article>'
      + '<div class="request-side"><h2 class="request-h">Hinweise zur Datenverarbeitung</h2><ul class="request-notes">'
      + '<li>Wir speichern Ihre Website-Adresse, Ihre von Google bestätigte E-Mail-Adresse, die Kennung Ihres Google-Kontos und den Zeitpunkt der Anfrage.</li>'
      + '<li>Zweck: Pixelkiez erstellt damit Ihre Analyse und schickt Ihnen den PDF-Bericht an diese E-Mail-Adresse.</li>'
      + '<li>Die Anmeldung läuft über Google. Wir erhalten nur Konto-Kennung und bestätigte E-Mail-Adresse, keinen Zugriff auf Ihr Postfach.</li>'
      + '<li>Pixelkiez wird intern per E-Mail über Ihre Anfrage informiert.</li>'
      + '<li>Ihre Website wird von dieser Seite nicht automatisch abgerufen oder gescannt.</li>'
      + `</ul><p class="request-small"><a class="request-link" href="${base}/datenschutz.html">Datenschutzerklärung</a></p>`
      + `<form class="request-confirm" method="post" action="${base}/api/anfrage">`
      + `<input type="hidden" name="action" value="confirm"><input type="hidden" name="csrf" value="${h(csrf)}"><input type="hidden" name="idem" value="${h(idem)}">`
      + `<label class="consent"><input type="checkbox" name="zustimmung" value="1" required${error !== null ? ' aria-invalid="true" aria-describedby="confirm-error"' : ''}>`
      + '<span>Ich möchte die kostenlose Website-Analyse für die oben genannte Website erhalten und habe die Hinweise zur Datenverarbeitung gelesen.</span></label>'
      + (error !== null ? `<p class="form-error" id="confirm-error" role="alert">${h(error)}</p>` : '')
      + '<button class="btn btn--accent" type="submit">Kostenlos anfragen</button></form>'
      + `<form class="request-logout" method="post" action="${base}/api/anfrage"><input type="hidden" name="action" value="logout"><input type="hidden" name="csrf" value="${h(csrf)}">`
      + '<button class="btn btn--ghost btn--sm" type="submit">Abbrechen und abmelden</button></form>'
      + '</div></div>';
    return this.page('Anfrage bestätigen', body);
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
