/* PXWA – Pages-Artefakt im Soft-Launch und nach dem Go-live (Formular-Modus, PXK-155). Ausführen im Repo-Root: node --test tests/softlaunch.test.mjs
   Prüft das Pages-Artefakt (public/): keine Anfragewege (Formular, Eingabe, POST, Google-Login), keine Schaltfläche, die eine
   funktionierende Anfrage nahelegt, sichtbarer Hinweis „Kostenlose Analyse-Anfragen in Kürze verfügbar“, nur die freigegebenen
   Videos aus R2 (PXK-159), Indexierungsregeln, Rechtstexte, keine Secrets und die Startseite gegenüber dem letzten Live-Stand. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const PUBLIC = join(ROOT, 'public');
const walk = d => readdirSync(d).flatMap(f => statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]);
const FILES = walk(PUBLIC).map(f => relative(PUBLIC, f)).sort();
const PAGES = FILES.filter(f => f.endsWith('.html'));
const read = f => readFileSync(join(PUBLIC, f), 'utf8');
const body = html => html.slice(html.indexOf('<body'));
const text = html => body(html).replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const NOTICE = 'Kostenlose Analyse-Anfragen in Kürze verfügbar';
/* Formular-Modus (Go-live PXK-155): Hero mit Anfrageformular statt Hinweis. Die Soft-Launch-Prüfungen bleiben für einen Rückfall auf den
   Soft-Launch erhalten und laufen nur dort; im Formular-Modus prüft das Gegenstück „Einziger Anfrageweg“ ebenso streng. */
const FORM = /<form class="analyze" id="analyze"/.test(read('index.html'));
const NUR_SOFT_LAUNCH = FORM && 'Formular-Modus: gilt nur im Soft-Launch (Gegenstück: „Einziger Anfrageweg“)';
const NUR_FORMULAR = !FORM && 'Soft-Launch: kein Anfrageformular';

/* Videos (Entscheidung des Auftraggebers 03.11.2026 per Rückfrage, PXK-159): Die drei R2-Objekte sind über ihre Adresse abrufbar.
   Eingebunden sind das Berichtsvideo (Lavendel) und das Befund-Video (Peach). Das Berichtsvideo zeigt nach Frame-Prüfung noch
   „Die 4 wichtigsten Metriken“, „Pro Metrik eine Seite“ und eine Schaltfläche „Jetzt analysieren“ – vom Auftraggeber so freigegeben.
   Das Hero-Video steht seit dem P0-Hotfix wieder unter dem Hero. Entscheidung des Auftraggebers 04.11.2026: keine Kennzeichnung als
   alte Fassung und keine Sätze unter den Videos; neue Fassungen der Videos lädt der Auftraggeber in R2 hoch. */
const R2_PFADE = ['/media/360-pixelkiez-video-1080p-website-look.mp4', '/media/report-pdf-de-1x1-lavendel.mp4', '/media/section-bericht-peach-5x4.mp4', '/media/360-pixelkiez-designrunde-am-tisch.webp', '/media/pixelkiez-logo.webp'];
const EINGEBUNDEN = [['demo', 'media/360-pixelkiez-video-1080p-website-look.mp4', 'media/360-pixelkiez-website-analyse-poster.jpg'], ['bericht', 'media/report-pdf-de-1x1-lavendel.mp4', 'media/report-pdf-lavendel-poster.jpg'], ['nutzen', 'media/section-bericht-peach-5x4.mp4', 'media/section-bericht-peach-poster.jpg']];

test('Artefakt: alle 22 Seiten vorhanden, in media/ nur die drei Poster, Functions nur unter /api/* und für die drei R2-Videos', () => {
  assert.equal(PAGES.length, 22);
  for (const p of ['index.html', 'impressum.html', 'datenschutz.html', 'agb.html', '404.html', 'wissen/index.html', 'analyse/index.html', 'analyse/methodik.html']) assert.ok(PAGES.includes(p), p);
  assert.deepEqual(FILES.filter(f => f.startsWith('media/') || /\.(mp4|webm|mov|m4v)$/i.test(f)), EINGEBUNDEN.map(([, , poster]) => poster).sort(), 'keine Videos im Upload (R2), nur die Poster');
  assert.deepEqual(JSON.parse(read('_routes.json')).include, ['/api/*', ...R2_PFADE]);
});

test('Kein Anfrageweg: kein Formular, keine Eingabe, kein Ziel /api/ oder Google; CSP verbietet Formularziele und Verbindungen', { skip: NUR_SOFT_LAUNCH }, () => {
  for (const p of PAGES) {
    const html = read(p);
    assert.ok(!/<(form|input|textarea|select)\b/i.test(html), `${p}: Formular oder Eingabefeld`);
    assert.ok(!/<button\b[^>]*type="submit"/i.test(html) && !/\b(action|formaction)=/i.test(html), `${p}: Absenden`);
    assert.ok(!/(href|src|action)="\.{0,2}\/?api\//i.test(html) && !/accounts\.google\.com/i.test(html), `${p}: Ziel /api/ oder Google-Anmeldung`);
    const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
    assert.match(csp, /form-action 'none'/, `${p}: form-action`);
    assert.match(csp, /connect-src 'none'/, `${p}: connect-src`);
  }
  for (const js of FILES.filter(f => f.endsWith('.js'))) {
    const code = read(js).replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!/\bfetch\(|XMLHttpRequest|sendBeacon|\.submit\(|accounts\.google|\/api\//.test(code), `${js}: sendet nichts`);
  }
});

test('Hinweis sichtbar; keine Schaltfläche oder Überschrift legt eine funktionierende Anfrage nahe', { skip: NUR_SOFT_LAUNCH }, () => {
  const home = read('index.html');
  assert.ok(text(home).includes(`${NOTICE}.`), 'Startseite: Hinweis im Hero');
  assert.ok(!/<p class="bald"[^>]*hidden/.test(home));
  for (const p of PAGES) {
    const html = body(read(p));
    for (const m of html.matchAll(/<(a|button|summary)\b([^>]*)>([\s\S]*?)<\/\1>/g)) {
      const label = m[3].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      /* Schaltflächen (Buttons, .btn-Links): kein Verb einer Anfrage; alle Links (FAQ-Fragen in <summary> erklären den künftigen Ablauf): keine Aufforderung zur Eingabe oder Analyse (Inhaltsverzeichnisse dürfen das Thema „Anfragen“ nennen) */
      if (m[1] === 'button' || /class="btn/.test(m[2])) assert.ok(!/eingeben|analysieren|anfragen|anfordern|beantragen|starten|bestellen|anmelden/i.test(label), `${p}: Schaltfläche „${label}“`);
      if (m[1] !== 'summary') assert.ok(!/Website eingeben|analysieren|Kostenlos anfragen|Analyse anfordern|mit Google anmelden/i.test(label), `${p}: Link „${label}“`);
    }
    for (const m of html.matchAll(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/g)) {
      assert.ok(!/(jetzt|kostenlos) (analysieren|anfragen)|^Kostenlos anfragen/i.test(m[1].replace(/<[^>]+>/g, '')), `${p}: Überschrift „${m[1]}“`);
    }
    assert.ok(!/href="[^"]*#top"[^>]*class="btn|class="btn[^"]*"[^>]*href="[^"]*#top"/.test(html), `${p}: Schaltfläche zurück zum (entfernten) Formular`);
  }
  for (const p of PAGES.filter(p => p.startsWith('wissen/') || p.startsWith('analyse/'))) assert.ok(text(read(p)).includes(`${NOTICE}.`), `${p}: Hinweis statt „Website eingeben“`);
});

test('Einziger Anfrageweg: das Hero-Formular der Startseite (POST /api/anfrage), sonst kein Formular; Skripte senden nichts; Formularziele nur eigene API und Google', { skip: NUR_FORMULAR }, () => {
  for (const p of PAGES) {
    const html = read(p);
    const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
    assert.match(csp, /form-action 'self' https:\/\/accounts\.google\.com$/, `${p}: form-action`);
    assert.match(csp, /connect-src 'none'/, `${p}: connect-src`);
    assert.ok(!/accounts\.google\.com/i.test(html.replace(csp, '')), `${p}: Google-Anmeldung nur über den Worker`);
    if (p === 'index.html') continue;
    assert.ok(!/<(form|input|textarea|select)\b/i.test(html), `${p}: Formular oder Eingabefeld`);
    assert.ok(!/<button\b[^>]*type="submit"/i.test(html) && !/\b(action|formaction)=/i.test(html), `${p}: Absenden`);
    assert.ok(!/(href|src|action)="\.{0,2}\/?api\//i.test(html), `${p}: Ziel /api/`);
  }
  const home = body(read('index.html'));
  const forms = [...home.matchAll(/<form\b[^>]*>/g)].map(m => m[0]);
  assert.deepEqual(forms, ['<form class="analyze" id="analyze" action="/api/anfrage" method="post" novalidate>'], 'genau ein Formular, per POST an den Worker');
  const form = home.slice(home.indexOf(forms[0]), home.indexOf('</form>'));
  assert.deepEqual([...form.matchAll(/<input\b[^>]*\bname="([^"]+)"/g)].map(m => m[1]), ['action', 'website'], 'nur die Website-Adresse');
  assert.ok(!/type="checkbox"/.test(form), 'kein Kästchen im Hero (Bestätigungsseite des Workers)');
  assert.ok(!/<(input|textarea|select)\b/.test(home.replace(form, '')), 'außerhalb des Hero-Formulars keine Eingabe');
  for (const js of FILES.filter(f => f.endsWith('.js'))) {
    const code = read(js).replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!/\bfetch\(|XMLHttpRequest|sendBeacon|\.submit\(|accounts\.google|\/api\//.test(code), `${js}: sendet nichts selbst`);
  }
  /* Unterseiten führen wie vor dem Soft-Launch zum Formular; kein Soft-Launch-Hinweis mehr */
  for (const p of PAGES.filter(p => p.startsWith('wissen/') || p.startsWith('analyse/'))) {
    assert.ok(read(p).includes('<a class="btn btn--accent" href="../index.html#top">Website eingeben <svg class="i"><use href="#i-arrow"/></svg></a>'), `${p}: „Website eingeben“`);
  }
  assert.ok(!PAGES.some(p => text(read(p)).includes(NOTICE)), 'kein Hinweis „in Kürze verfügbar“');
});

test('Videos nur wie entschieden: Hero-Video, Berichtsvideo und Befund-Video auf der Startseite, ohne Bildunterschriften, Video-Metadaten nur dort; keine veralteten Aussagen im Seitentext', () => {
  for (const p of PAGES) {
    const html = read(p);
    if (p === 'index.html') {
      const videos = [...html.matchAll(/<section class="[^"]*" id="([^"]+)">(?:(?!<\/section>)[\s\S])*?<video\b[^>]*poster="([^"]+)"[^>]*>\s*<source src="([^"]+)" type="video\/mp4">/g)].map(m => [m[1], m[3], m[2]]);
      assert.deepEqual(videos, EINGEBUNDEN, 'genau die drei entschiedenen Videos in ihren Abschnitten');
      assert.equal((html.match(/<video\b/g) || []).length, 3);
      assert.ok(![...html.matchAll(/<figure class="(?:showcase-media|report-media[^"]*)">[\s\S]*?<\/figure>/g)].some(m => /<figcaption/.test(m[0])) && !/showcase-badge|Historische Demo/.test(html), 'keine Bildunterschriften unter Videos, keine Kennzeichnung als alte Fassung');
    } else {
      assert.ok(!/<video\b|<source\b|poster=/.test(html), `${p}: Video`);
      /* Einziger erlaubter Verweis: das Logo aus R2 oben und im Footer (Entscheidung des Auftraggebers 04.11.2026) */
      assert.ok(!/(src|href|content)="[^"]*\bmedia\//.test(html.replace(/https:\/\/static\.googleusercontent\.com\/media\//g, '').replace(/ src="(?:\/|\.\.\/)?media\/pixelkiez-logo\.webp"/g, '')), `${p}: Verweis auf media/`);
    }
    if (p !== 'index.html') assert.ok(!/VideoObject/.test(html), `${p}: Video-Metadaten nur auf der Startseite`);
    assert.ok(!/vier (wichtigsten )?Metriken|kontakt@pixelkiez\.de/i.test(html), `${p}: veraltete Aussage`);
  }
});

test('Indexierung: reguläre Seiten freigegeben, Fehlerseite und Vorschau ausgeschlossen', () => {
  for (const p of PAGES.filter(p => p !== '404.html')) assert.match(read(p), /<meta name="robots" content="index,follow">/, p);
  assert.match(read('404.html'), /<meta name="robots" content="noindex,nofollow">/);
  const headers = read('_headers');
  assert.doesNotMatch(headers, /^https:\/\/360\.pixelkiez\.de\/\*\n {2}X-Robots-Tag: noindex$/m);
  assert.match(headers, /^https:\/\/:project\.pages\.dev\/\*\n {2}X-Robots-Tag: noindex$/m);
  assert.match(headers, /^https:\/\/:version\.:project\.pages\.dev\/\*\n {2}X-Robots-Tag: noindex$/m);
  assert.equal((headers.match(/^\/\*$/gm) || []).length, 1, 'Sicherheits-Header bleiben erhalten');
  assert.ok(FILES.includes('sitemap.xml'), 'Sitemap vorhanden');
});

test('Rechtstexte: Impressum 2026-11-04, AGB 2026-11-12 und Datenschutzerklärung 2026-11-13 (ein Kästchen, vom Auftraggeber freigegeben) ohne Entwurfsvermerk und ohne offene Platzhalter, keine behauptete Freigabe', () => {
  for (const [p, stand] of [['impressum.html', '4. November 2026'], ['datenschutz.html', '13. November 2026'], ['agb.html', '12. November 2026']]) {
    const t = text(read(p));
    assert.ok(t.includes(`Stand: ${stand}`) && !/ENTWURF|\[[^\]]*\]/.test(t), `${p}: veröffentlichte Fassung ohne Platzhalter`);
  }
  for (const p of PAGES) assert.ok(!/rechtssicher|DSGVO-konform|datenschutzkonform|rechtlich (geprüft und )?freigegeben(?! )/i.test(text(read(p)).replace('nicht rechtlich freigegeben', '')), `${p}: behauptete Freigabe`);
});

test('Keine Secrets, Test- oder Konfigurationswerte und keine Personendaten außer Impressum/Verantwortlichem im Upload', () => {
  for (const f of FILES.filter(f => !/\.(jpg|png|ico)$/.test(f))) {
    const s = read(f);
    assert.ok(!/-----BEGIN [A-Z ]*PRIVATE KEY|GOCSPX-|\bre_[A-Za-z0-9]{16,}|\bsk_[A-Za-z0-9]{16,}|\bAKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{20,}\./.test(s), `${f}: Secret`);
    assert.ok(!/test-only|mock-access-token|MAIL_API_TOKEN|GOOGLE_CLIENT_SECRET|SESSION_SECRET/.test(s), `${f}: Test- oder Konfigurationswert`);
    const mails = [...new Set((s.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) || []).map(m => m.replace(/\.+$/, '')))].filter(m => !/\.(png|jpg|svg|css|js)$/.test(m));
    /* Einzige eigene Adresse; die Datenschutzerklärung nennt zusätzlich die Aufsichtsbehörde (Art. 77 DSGVO) */
    assert.deepEqual(mails.filter(m => m !== '360@pixelkiez.de' && !(f === 'datenschutz.html' && m === 'mailbox@datenschutz-berlin.de')), [], `${f}: andere E-Mail-Adressen`);
  }
  assert.ok(!existsSync(join(PUBLIC, '.dev.vars')));
});

/* Datenschutz-Fix (03.11.2026): Schriften selbst ausgeliefert, keine Anfrage an Google Fonts oder andere fremde Server */
const FONTS = ['OFL-Archivo.txt', 'OFL-IBM-Plex-Mono.txt', 'archivo-latin-ext.woff2', 'archivo-latin.woff2', 'ibm-plex-mono-400-latin-ext.woff2',
  'ibm-plex-mono-400-latin.woff2', 'ibm-plex-mono-500-latin-ext.woff2', 'ibm-plex-mono-500-latin.woff2'];

test('Schriften selbst ausgeliefert: keine externen Ressourcen, CSP nur eigene Herkunft, Lizenzen beigelegt', () => {
  assert.deepEqual(FILES.filter(f => f.startsWith('assets/fonts/')).map(f => f.slice('assets/fonts/'.length)).sort(), FONTS);
  for (const p of PAGES) {
    const html = read(p);
    assert.ok(!/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(html), `${p}: Google Fonts`);
    /* Kein Tag lädt etwas von einer fremden Herkunft (Links zu Quellen und Canonical/og:url sind keine Ressourcen) */
    for (const m of html.matchAll(/<(link|script|img|source|video|audio|iframe|embed|object)\b[^>]*>/g)) {
      const tag = m[0];
      if (m[1] === 'link' && /rel="(canonical|alternate)"/.test(tag)) continue;
      assert.ok(!/(src|href|data)="(https?:)?\/\//.test(tag), `${p}: externe Ressource ${tag}`);
    }
    assert.ok(!/rel="(preconnect|dns-prefetch|preload|prefetch)"[^>]*href="(https?:)?\/\//.test(html), `${p}: Vorab-Verbindung zu fremdem Server`);
    const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
    assert.match(csp, /(^|; )style-src 'self';/, `${p}: style-src`);
    assert.match(csp, /(^|; )font-src 'self';/, `${p}: font-src`);
    /* Einzige fremde Herkunft: das Formularziel der Google-Anmeldung (Weiterleitung aus dem Worker), keine geladene Ressource */
    assert.ok(!/https?:/.test(csp.replace(/form-action 'self' https:\/\/accounts\.google\.com$/, "form-action 'self'")), `${p}: CSP erlaubt fremde Herkunft`);
    /* fonts.css vor styles.css, mit demselben Pfadpräfix */
    const pre = html.match(/<link rel="stylesheet" href="([^"]*)assets\/styles\.css">/)[1];
    const i = html.indexOf(`<link rel="stylesheet" href="${pre}assets/fonts.css">`);
    assert.ok(i > 0 && i < html.indexOf(`href="${pre}assets/styles.css"`), `${p}: fonts.css vor styles.css`);
  }
  for (const css of FILES.filter(f => f.endsWith('.css'))) assert.ok(!/@import|url\(\s*["']?(https?:)?\/\//.test(read(css)), `${css}: lädt fremde Ressourcen`);
  const fonts = read('assets/fonts.css');
  const urls = [...fonts.matchAll(/url\("([^"]+)"\)/g)].map(m => m[1]);
  assert.equal(urls.length, 10, 'Archivo 400/500/600 und IBM Plex Mono 400/500, je latin und latin-ext');
  for (const u of urls) {
    assert.match(u, /^fonts\/[a-z0-9-]+\.woff2$/);
    assert.equal(readFileSync(join(PUBLIC, 'assets', u)).subarray(0, 4).toString('latin1'), 'wOF2', `${u}: WOFF2`);
  }
  assert.equal((fonts.match(/font-display: swap;/g) || []).length, 10);
  for (const [f, copyright] of [['OFL-Archivo.txt', 'Copyright 2020 The Archivo Project Authors'], ['OFL-IBM-Plex-Mono.txt', 'Copyright © 2017 IBM Corp.']]) {
    const lic = read('assets/fonts/' + f);
    assert.ok(lic.includes(copyright) && lic.includes('SIL OPEN FONT LICENSE Version 1.1'), `${f}: Copyright und OFL 1.1`);
  }
});

/* Startseite gegenüber main (c69cd1b, letzter Stand vor dem Soft-Launch): ersetzt im Soft-Launch den Hero-Schutz aus tests/static.test.mjs.
   Jede Zeile ist eine einzeln freigegebene Änderung; alles andere muss gleich bleiben. */
const MAIN_SHA = 'c69cd1b3cb7dba1426df5006890fec3417841c9f';
/* Go-live (PXK-155, PO-Entscheidung 12.11.2026): Hero nur mit Website-Adresse und „Analysieren“; das Formular sendet die Adresse
   (Aktion „adresse“) an den Worker, der die Bestätigungsseite mit genau einem Kästchen zeigt. Gegenüber main entfallen das AGB-Feld
   und das Kästchen samt Fehlertext; Schaltfläche, Fehlertext zur Adresse und Hinweiszeile bleiben wie in main. */
const FORMULAR_AENDERUNGEN = [
  ['      <input type="hidden" name="action" value="start">\n      <input type="hidden" name="agb_version" value="ENTWURF-2026-10-31">\n', '      <input type="hidden" name="action" value="adresse">\n'],
  ['      <label class="consent consent--hero"><input id="agb" type="checkbox" name="agb" value="1" required><span>Ich akzeptiere die <a href="agb.html">AGB</a> von 360°Pixelkiez.</span></label>\n      <p class="form-error" id="agb-error" hidden>Bitte akzeptieren Sie die AGB, damit wir Ihre Website analysieren können.</p>\n', ''],
];
test('Startseite gegenüber main: nur Hero-Formular nach AGB (bzw. im Soft-Launch der Hinweis), Schriften-Fix, Partner, Logo, Favicon, Videos und Hintergrundbild aus R2 – sonst unverändert', () => {
  const main = execFileSync('git', ['show', `${MAIN_SHA}:public/index.html`], { cwd: ROOT, encoding: 'utf8' });
  const SOFT_LAUNCH_AENDERUNGEN = [
    /* Soft-Launch (c528d96): kein Formularziel, Hinweis statt Formular, Schaltflächen ohne Anfrage, Ablauf „sobald Anfragen möglich sind“ */
    ["form-action 'self' https://accounts.google.com\">", "form-action 'none'\">"],
    [/    <form class="analyze" id="analyze"[\s\S]*?<p class="hero-note">[^\n]*\n/, '    <!-- Soft-Launch: kein Anfrageformular, bis die Google-Anmeldung freigegeben ist (keine Eingabe, kein POST, kein Google-Login) -->\n    <div class="analyze">\n      <p class="bald"><svg class="i"><use href="#i-globe"/></svg><span><b>Kostenlose Analyse-Anfragen in Kürze verfügbar.</b> Bis dahin nimmt diese Website noch keine Anfragen an.</span></p>\n'],
    ['      </div>\n    </form>\n  </section>', '      </div>\n    </div>\n  </section>'],
    ['<h2 class="h2">In drei Schritten zum PDF-Bericht.</h2></div>', '<h2 class="h2">In drei Schritten zum PDF-Bericht.</h2><p class="text">So läuft die kostenlose Analyse ab, sobald Anfragen möglich sind.</p></div>'],
    ['        <a class="btn btn--accent btn--block" href="#top">Website eingeben</a>\n', '        <p class="plan-bald">In Kürze verfügbar</p>\n'],
    ['    <h2 class="h2">Kostenlos anfragen. Persönlich geprüft.</h2>\n    <button class="btn btn--accent" type="button" id="to-top">Website eingeben <svg class="i"><use href="#i-arrow"/></svg></button>\n',
      '    <h2 class="h2">Kostenlose Analyse-Anfragen in Kürze verfügbar.</h2>\n    <a class="btn btn--ghost" href="wissen/index.html">Zum Wissensbereich <svg class="i"><use href="#i-arrow"/></svg></a>\n'],
  ];
  const ERLAUBT = [
    ['<meta name="robots" content="noindex,nofollow">', '<meta name="robots" content="index,follow">'],
    ...(FORM ? FORMULAR_AENDERUNGEN : SOFT_LAUNCH_AENDERUNGEN),
    /* Datenschutz-Fix (94f0b18): Schriften selbst ausgeliefert */
    ["style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com;", "style-src 'self'; font-src 'self';"],
    ['<link rel="preconnect" href="https://fonts.googleapis.com">\n<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">\n', '<link rel="stylesheet" href="assets/fonts.css">\n'],
    ['<script type="application/ld+json">{"@context":"https://schema.org","@graph":', '<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebSite","name":"360°Pixelkiez","alternateName":"360.pixelkiez.de","url":"https://360.pixelkiez.de/"}</script>\n<script type="application/ld+json">{"@context":"https://schema.org","@graph":'],
    /* Videos (PXK-159): Video-Metadaten (VideoObject) für alle drei Videos (04.11.2026); das Hero-Video aus R2 mit neuem Poster, darunter die Partner-Logos;
       Berichtsvideo in der Lavendel-Fassung; Befund-Video statt der Beispielkarte */
    [/\n<script type="application\/ld\+json">\{"@context":"https:\/\/schema\.org","@graph":\[\{"@type":"VideoObject".*?<\/script>/, '\n<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"VideoObject","name":"Kostenlose Website-Analyse von 360°Pixelkiez","inLanguage":"de-DE","description":"Animierter Überblick über die kostenlose Website-Analyse von 360°Pixelkiez: Prüfung öffentlicher Seiten, Befunde mit Messwerten und Beleg, Hebel und Fahrplan für die nächsten Schritte und der Bericht als PDF mit sieben Seiten. Alle gezeigten Werte sind Beispieldaten.","thumbnailUrl":"https://360.pixelkiez.de/media/360-pixelkiez-website-analyse-poster.jpg","contentUrl":"https://360.pixelkiez.de/media/360-pixelkiez-video-1080p-website-look.mp4","uploadDate":"2026-11-04T11:41:54+00:00","duration":"PT48S","width":1920,"height":1080,"publisher":{"@type":"Organization","name":"360°Pixelkiez","url":"https://360.pixelkiez.de/"}},{"@type":"VideoObject","name":"Der PDF-Bericht mit sieben Seiten","inLanguage":"de-DE","description":"Animierte Vorstellung des PDF-Berichts mit sieben Seiten: Kernaussage zuerst, Überblick auf einen Blick, die Bereiche im Detail und ein Fahrplan mit den nächsten Schritten. Beispielbericht, alle gezeigten Werte sind Beispieldaten.","thumbnailUrl":"https://360.pixelkiez.de/media/report-pdf-lavendel-poster.jpg","contentUrl":"https://360.pixelkiez.de/media/report-pdf-de-1x1-lavendel.mp4","uploadDate":"2026-11-01T20:17:58+00:00","duration":"PT35S","width":1080,"height":1080,"publisher":{"@type":"Organization","name":"360°Pixelkiez","url":"https://360.pixelkiez.de/"}},{"@type":"VideoObject","name":"Jeder Befund verständlich erklärt","inLanguage":"de-DE","description":"Animiertes fiktives Beispiel eines Befunds aus dem Bericht: Die Startseite nennt nur Schlagworte, dazu Befund, warum er wichtig ist, und die Empfehlung. Danach die nächsten Schritte, das Weitergeben des PDFs an Team, Agentur oder IT und der Hinweis: 0 €, kein Abo.","thumbnailUrl":"https://360.pixelkiez.de/media/section-bericht-peach-poster.jpg","contentUrl":"https://360.pixelkiez.de/media/section-bericht-peach-5x4.mp4","uploadDate":"2026-11-01T20:17:58+00:00","duration":"PT29S","width":1350,"height":1080,"publisher":{"@type":"Organization","name":"360°Pixelkiez","url":"https://360.pixelkiez.de/"}},{"@type":"ImageObject","name":"Für alle, die eine Website verantworten – 360°Pixelkiez","inLanguage":"de-DE","description":"Symbolbild: Vier Menschen arbeiten in sonnigem Licht an einem runden Tisch mit Laptops, Notizbuch und Kaffee an ihrer Website.","contentUrl":"https://360.pixelkiez.de/media/360-pixelkiez-designrunde-am-tisch.webp","encodingFormat":"image/webp","uploadDate":"2026-11-04T14:13:03+00:00","width":1672,"height":941,"creditText":"360°Pixelkiez","copyrightNotice":"360°Pixelkiez","license":"https://360.pixelkiez.de/impressum","acquireLicensePage":"https://360.pixelkiez.de/impressum","digitalSourceType":"https://schema.org/TrainedAlgorithmicMediaDigitalSource","creator":{"@type":"Organization","name":"360°Pixelkiez","url":"https://360.pixelkiez.de/"}}]}</script>'],
    [/  <section class="showcase" aria-label="Beispielansicht">\n[\s\S]*?\n  <\/section>\n/, '  <section class="showcase" id="demo">\n    <figure class="showcase-media">\n      <div class="showcase-frame">\n        <video class="showcase-video" muted loop playsinline preload="metadata" width="1920" height="1080" poster="media/360-pixelkiez-website-analyse-poster.jpg" aria-label="Animierter Überblick über die kostenlose Website-Analyse von 360°Pixelkiez: Prüfung öffentlicher Seiten, Befunde mit Messwerten und Beleg, Hebel und Fahrplan für die nächsten Schritte und der Bericht als PDF mit sieben Seiten. Alle gezeigten Werte sind Beispieldaten.">\n          <source src="media/360-pixelkiez-video-1080p-website-look.mp4" type="video/mp4">\n        </video>\n      </div>\n    </figure>\n  </section>\n\n  <section class="partner-band" aria-label="Partner">\n    <ul class="partner-logos">\n      <li><a href="https://pixelkiez.de/" target="_blank" rel="noopener"><img src="assets/partner/pixelkiez.png" alt="Pixelkiez" width="104" height="24"></a></li>\n      <li><a href="https://studio.dyai.cloud/" target="_blank" rel="noopener"><img src="assets/partner/dyai-studio.svg" alt="DYAI Studio" width="133" height="26"></a></li>\n    </ul>\n  </section>\n'],
    ['poster="media/report-pdf-poster.jpg"', 'poster="media/report-pdf-lavendel-poster.jpg"'],
    /* Keine Sätze unter den Videos (Entscheidung des Auftraggebers 04.11.2026); „Beispieldaten“ steht im Alternativtext */
    ['\n        <figcaption class="showcase-note">Beispielbericht. Alle gezeigten Werte sind Beispieldaten.</figcaption>', ''],
    ['und ein Fahrplan mit den nächsten Schritten."', 'und ein Fahrplan mit den nächsten Schritten. Beispielbericht, alle gezeigten Werte sind Beispieldaten."'],
    ['<div class="footer-brand"><a class="logo" href="#top">360°Pixelkiez<span>Analyse</span></a>', '<div class="footer-brand"><a class="logo" href="#top">360°<img class="logo-bild" src="media/pixelkiez-logo.webp" alt="Pixelkiez" width="518" height="120" loading="lazy" decoding="async"><span>Website-Analyse</span></a>'],
    /* Videos ohne Bedienelemente, Start per Skript (Entscheidungen des Auftraggebers 04.11.2026) */
    ['<video class="showcase-video showcase-video--square" muted loop playsinline preload="none"', '<video class="showcase-video showcase-video--square" muted loop playsinline preload="metadata"'],
    ['<source src="media/report-pdf-de-1x1.mp4" type="video/mp4">', '<source src="media/report-pdf-de-1x1-lavendel.mp4" type="video/mp4">'],
    [/      <article class="card detail" aria-label="Fiktives Beispiel eines Befunds im Bericht">\n[\s\S]*?\n      <\/article>\n/, '      <figure class="report-media report-media--wide">\n        <div class="showcase-frame">\n          <video class="showcase-video showcase-video--5x4" muted loop playsinline preload="metadata" width="1350" height="1080" poster="media/section-bericht-peach-poster.jpg" aria-label="Animiertes fiktives Beispiel eines Befunds aus dem Bericht: Die Startseite nennt nur Schlagworte, dazu Befund, warum er wichtig ist, und die Empfehlung. Danach die nächsten Schritte, das Weitergeben des PDFs an Team, Agentur oder IT und der Hinweis: 0 €, kein Abo.">\n            <source src="media/section-bericht-peach-5x4.mp4" type="video/mp4">\n          </video>\n        </div>\n      </figure>\n'],
    /* Logo-Zusatz „Website-Analyse“ und Pixelkiez-Logo in der Footer-Leiste (Entscheidung des Auftraggebers 03.11.2026) */
    ['<a class="logo" href="#top">360°Pixelkiez<span>Analyse</span></a>\n    <div class="nav-links">', '<a class="logo" href="#top">360°<img class="logo-bild" src="media/pixelkiez-logo.webp" alt="Pixelkiez" width="518" height="120" decoding="async"><span>Website-Analyse</span></a>\n    <div class="nav-links">'],
    ['      <span>© 2026 360°Pixelkiez</span>\n', '      <span>© 2026 360°Pixelkiez</span>\n      <a href="https://pixelkiez.de/" target="_blank" rel="noopener"><img class="footer-partner" src="assets/partner/pixelkiez.png" alt="Pixelkiez" width="87" height="20"></a>\n'],
    /* Hintergrundbild im Abschnitt „Für alle …“ aus R2 mit ImageObject im JSON-LD oben (Entscheidung des Auftraggebers 04.11.2026) */
    ['  <section class="section" id="fuer-wen">\n', '  <section class="section section--bild" id="fuer-wen">\n    <img class="section-bild" src="media/360-pixelkiez-designrunde-am-tisch.webp" width="1672" height="941" alt="" loading="lazy" decoding="async">\n'],
    /* Favicon-Satz des Auftraggebers (favicon.io, 05.11.2026) statt des „P°“-Favicons */
    ['<link rel="icon" href="favicon.ico" sizes="32x32">\n<link rel="icon" href="assets/favicon.svg" type="image/svg+xml">\n<link rel="apple-touch-icon" href="assets/apple-touch-icon.png">\n',
      '<link rel="icon" href="favicon.ico" sizes="16x16 32x32 48x48">\n<link rel="icon" href="favicon-32x32.png" type="image/png" sizes="32x32">\n<link rel="icon" href="favicon-16x16.png" type="image/png" sizes="16x16">\n<link rel="apple-touch-icon" href="apple-touch-icon.png" sizes="180x180">\n<link rel="manifest" href="site.webmanifest">\n'],
    /* Rechtstexte (Entscheidung des Auftraggebers 04.11.2026): AGB-Link in der Footer-Leiste */
    ['<a href="datenschutz.html">Datenschutz</a></nav>', '<a href="datenschutz.html">Datenschutz</a><a href="agb.html">AGB</a></nav>'],
  ];
  let expected = main;
  for (const [from, to] of ERLAUBT) {
    const n = typeof from === 'string' ? expected.split(from).length - 1 : (expected.match(new RegExp(from.source, from.flags + 'g')) || []).length;
    assert.equal(n, 1, `freigegebene Änderung trifft genau eine Stelle in main: ${String(from).slice(0, 80)}`);
    expected = expected.replace(from, to);
  }
  assert.equal(read('index.html'), expected, 'Startseite weicht außerhalb der freigegebenen Änderungen von main ab');
});
