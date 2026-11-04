/* PXWA – Soft-Launch (statisch, vor der Freigabe der Google-Anmeldung). Ausführen im Repo-Root: node --test tests/softlaunch.test.mjs
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

/* Videos (Entscheidung des Auftraggebers 03.11.2026 per Rückfrage, PXK-159): Die drei R2-Objekte sind über ihre Adresse abrufbar.
   Eingebunden sind das Berichtsvideo (Lavendel) und das Befund-Video (Peach). Das Berichtsvideo zeigt nach Frame-Prüfung noch
   „Die 4 wichtigsten Metriken“, „Pro Metrik eine Seite“ und eine Schaltfläche „Jetzt analysieren“ – vom Auftraggeber so freigegeben.
   Das Hero-Video steht seit dem P0-Hotfix wieder unter dem Hero. Entscheidung des Auftraggebers 04.11.2026: keine Kennzeichnung als
   alte Fassung und keine Sätze unter den Videos; neue Fassungen der Videos lädt der Auftraggeber in R2 hoch. */
const R2_PFADE = ['/media/360-pixelkiez-video-1080p-website-look.mp4', '/media/report-pdf-de-1x1-lavendel.mp4', '/media/section-bericht-peach-5x4.mp4', '/media/360-pixelkiez-designrunde-am-tisch.webp'];
const EINGEBUNDEN = [['demo', 'media/360-pixelkiez-video-1080p-website-look.mp4', 'media/360-pixelkiez-website-analyse-poster.jpg'], ['bericht', 'media/report-pdf-de-1x1-lavendel.mp4', 'media/report-pdf-lavendel-poster.jpg'], ['nutzen', 'media/section-bericht-peach-5x4.mp4', 'media/section-bericht-peach-poster.jpg']];

test('Artefakt: alle 22 Seiten vorhanden, in media/ nur die drei Poster, Functions nur unter /api/* und für die drei R2-Videos', () => {
  assert.equal(PAGES.length, 22);
  for (const p of ['index.html', 'impressum.html', 'datenschutz.html', 'agb.html', '404.html', 'wissen/index.html', 'analyse/index.html', 'analyse/methodik.html']) assert.ok(PAGES.includes(p), p);
  assert.deepEqual(FILES.filter(f => f.startsWith('media/') || /\.(mp4|webm|mov|m4v)$/i.test(f)), EINGEBUNDEN.map(([, , poster]) => poster).sort(), 'keine Videos im Upload (R2), nur die Poster');
  assert.deepEqual(JSON.parse(read('_routes.json')).include, ['/api/*', ...R2_PFADE]);
});

test('Kein Anfrageweg: kein Formular, keine Eingabe, kein Ziel /api/ oder Google; CSP verbietet Formularziele und Verbindungen', () => {
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

test('Hinweis sichtbar; keine Schaltfläche oder Überschrift legt eine funktionierende Anfrage nahe', () => {
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
      assert.ok(!/(src|href|content)="[^"]*\bmedia\//.test(html.replace(/https:\/\/static\.googleusercontent\.com\/media\//g, '')), `${p}: Verweis auf media/`);
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

test('Rechtstexte: Fassung 2026-11-04 (Entscheidung des Auftraggebers) ohne Entwurfsvermerk und ohne offene Platzhalter, keine behauptete Freigabe', () => {
  for (const p of ['impressum.html', 'datenschutz.html', 'agb.html']) {
    const t = text(read(p));
    assert.ok(t.includes('Stand: 4. November 2026') && !/ENTWURF|\[[^\]]*\]/.test(t), `${p}: veröffentlichte Fassung ohne Platzhalter`);
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
    assert.ok(!/https?:/.test(csp), `${p}: CSP erlaubt fremde Herkunft`);
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

/* Ausgangspunkt ist der zuletzt veröffentlichte Stand; nur die Robots-Angabe darf davon abweichen. */
const LIVE_SHA = '22d520ca5f601949574d03b204e740b54fc71093';
test('Startseite: gegenüber dem letzten Live-Stand nur die Indexierungsangabe geändert', () => {
  const live = execFileSync('git', ['show', `${LIVE_SHA}:public/index.html`], { cwd: ROOT, encoding: 'utf8' });
  const old = '<meta name="robots" content="noindex,nofollow">';
  assert.equal(live.split(old).length, 2, 'genau eine bisherige Robots-Angabe');
  assert.equal(read('index.html'), live.replace(old, '<meta name="robots" content="index,follow">'));
});
