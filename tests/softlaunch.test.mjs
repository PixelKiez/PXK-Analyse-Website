/* PXWA – Soft-Launch (statisch, vor der Freigabe der Google-Anmeldung). Ausführen im Repo-Root: node --test tests/softlaunch.test.mjs
   Prüft das Pages-Artefakt (public/): keine Anfragewege (Formular, Eingabe, POST, Google-Login), keine Schaltfläche, die eine
   funktionierende Anfrage nahelegt, sichtbarer Hinweis „Kostenlose Analyse-Anfragen in Kürze verfügbar“, keine Videos mit veralteten
   Prüfkriterien, noindex, Entwurfskennzeichnung der Rechtstexte, keine Secrets. Gilt nur für den Branch release/pxwa-soft-launch. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
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

test('Artefakt: alle 22 Seiten vorhanden, keine Medien, Functions nur unter /api/*', () => {
  assert.equal(PAGES.length, 22);
  for (const p of ['index.html', 'impressum.html', 'datenschutz.html', 'agb.html', '404.html', 'wissen/index.html', 'analyse/index.html', 'analyse/methodik.html']) assert.ok(PAGES.includes(p), p);
  assert.deepEqual(FILES.filter(f => f.startsWith('media/') || /\.(mp4|webm|mov)$/i.test(f)), [], 'keine Videos und Poster im Upload');
  assert.deepEqual(JSON.parse(read('_routes.json')).include, ['/api/*']);
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

test('Keine Videos oder Video-Metadaten mit veralteten Prüfkriterien (vier Metriken, Score-Beispiele, kontakt@)', () => {
  for (const p of PAGES) {
    const html = read(p);
    assert.ok(!/<video\b|<source\b|VideoObject|poster=/.test(html), `${p}: Video`);
    assert.ok(!/(src|href|content)="[^"]*\bmedia\//.test(html.replace(/https:\/\/static\.googleusercontent\.com\/media\//g, '')), `${p}: Verweis auf media/`);
    assert.ok(!/vier (wichtigsten )?Metriken|kontakt@pixelkiez\.de/i.test(html), `${p}: veraltete Aussage`);
  }
});

test('noindex bleibt: jede Seite mit robots-Meta, zusätzlich X-Robots-Tag für alle Pfade auf 360.pixelkiez.de', () => {
  for (const p of PAGES) assert.match(read(p), /<meta name="robots" content="noindex,nofollow">/, p);
  assert.match(read('_headers'), /^https:\/\/360\.pixelkiez\.de\/\*\n {2}X-Robots-Tag: noindex$/m);
  assert.equal((read('_headers').match(/^\/\*$/gm) || []).length, 1, 'genau ein „/*“-Block (Sicherheits-Header)');
  assert.ok(!FILES.includes('robots.txt') && !FILES.includes('sitemap.xml'), 'keine Freigabe für Suchmaschinen');
});

test('Rechtstexte: Entwürfe bleiben als Entwurf gekennzeichnet, keine behauptete Freigabe', () => {
  for (const p of ['datenschutz.html', 'agb.html']) assert.ok(text(read(p)).includes('ENTWURF – nicht rechtlich freigegeben.'), p);
  for (const p of PAGES) assert.ok(!/rechtssicher|DSGVO-konform|datenschutzkonform|rechtlich (geprüft und )?freigegeben(?! )/i.test(text(read(p)).replace('nicht rechtlich freigegeben', '')), `${p}: behauptete Freigabe`);
});

test('Keine Secrets, Test- oder Konfigurationswerte und keine Personendaten außer Impressum/Verantwortlichem im Upload', () => {
  for (const f of FILES.filter(f => !/\.(jpg|png|ico)$/.test(f))) {
    const s = read(f);
    assert.ok(!/-----BEGIN [A-Z ]*PRIVATE KEY|GOCSPX-|\bre_[A-Za-z0-9]{16,}|\bsk_[A-Za-z0-9]{16,}|\bAKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{20,}\./.test(s), `${f}: Secret`);
    assert.ok(!/test-only|mock-access-token|MAIL_API_TOKEN|GOOGLE_CLIENT_SECRET|SESSION_SECRET/.test(s), `${f}: Test- oder Konfigurationswert`);
    const mails = [...new Set((s.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) || []).map(m => m.replace(/\.+$/, '')))].filter(m => !/\.(png|jpg|svg|css|js)$/.test(m));
    assert.deepEqual(mails.filter(m => m !== '360@pixelkiez.de'), [], `${f}: andere E-Mail-Adressen`);
  }
  assert.ok(!existsSync(join(PUBLIC, '.dev.vars')));
});
