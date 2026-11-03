/* PXWA – Release-Prüfung aus einem frischen Git-Checkout. Klont das lokale Repository in ein temporäres Verzeichnis und
   prüft genau einen Commit (PXK_RELEASE_REF, Standard HEAD). Uncommittete, lokale oder ignorierte Dateien zählen nicht:
   Fehlen die Poster im Commit, schlägt der Test fehl, auch wenn public/media/ lokal vollständig ist. Die Videos liegen im
   R2-Bucket 360pixelkiez und werden über functions/media/[file].ts ausgeliefert (nicht im Commit).
   Ausführen im Repo-Root: npm run test:release   (oder PXK_RELEASE_REF=<sha> node --test tests/release.test.mjs) */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as H from './lib/html.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REF = process.env.PXK_RELEASE_REF || 'HEAD';
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/* Freigegebene öffentliche Website-Medien im Commit (eigenes 360°Pixelkiez-Material) mit SHA-256. Eine neue Fassung braucht eine
   eigene Freigabe und eine bewusste Änderung dieser Liste. Fassung vom 03.11.2026 (PXK-159, Entscheidung des Auftraggebers: Bericht-
   und Befund-Video aus R2 eingebunden): die zwei Poster dieser Videos mit eingebetteten Metadaten (Titel, Beschreibung, Urheber,
   Copyright); Bilddaten bitgleich zu den lokalen Postern vom 31.10.2026. P0-Hotfix (PXK-159): Poster der historischen Demo unter dem
   Hero, Bild bei 31,5 s aus dem R2-Objekt 360-pixelkiez-video-1080p.mp4 (neutrale Fahrplan-Ansicht), mit denselben Metadaten-Feldern. */
const MEDIA = {
  'media/360-pixelkiez-video-historisch-poster.jpg': 'b6b6b79178e669d46b2b5f803c9ae5ce71f81d27cd99a31bc6c8b24d31bd0fb7',
  'media/report-pdf-lavendel-poster.jpg': '0195793804dfa08e5415e816121c1067d48c77c5ebc5d3a8a659ff1eac103932',
  'media/section-bericht-peach-poster.jpg': '593e8ad3318a426408bc511d97f78d9c37d0f1772f9f7e6e8e14d496f59eff52',
};
/* Titelbilder (og:image) je Seite und Icons gehören zur Website */
const OG = ['start', 'wissen', 'analyse',
  ...['agent-readiness', 'answerability', 'entity-trust', 'seo-geo-ai-visibility', 'wie-ki-websites-liest', 'wie-websites-ausgeliefert-werden'].map(s => `wissen-${s}`),
  ...['auffindbarkeit-seo', 'barrierefreiheit', 'ki-crawler-agenten', 'ki-verstaendlichkeit', 'methodik', 'nutzerfuehrung-conversion', 'performance-technik', 'vertrauen-datenschutz', 'warum-website-analyse'].map(s => `analyse-${s}`)];
/* Selbst ausgelieferte Schriften (Datenschutz-Fix 94f0b18): Stylesheet, WOFF2-Dateien und OFL-Lizenzen */
const FONTS = ['assets/fonts.css', ...['OFL-Archivo.txt', 'OFL-IBM-Plex-Mono.txt', 'archivo-latin-ext.woff2', 'archivo-latin.woff2', 'ibm-plex-mono-400-latin-ext.woff2',
  'ibm-plex-mono-400-latin.woff2', 'ibm-plex-mono-500-latin-ext.woff2', 'ibm-plex-mono-500-latin.woff2'].map(f => 'assets/fonts/' + f)];
const SITE = ['404.html', '_headers', '_routes.json', 'agb.html', 'assets/anfrage.css', 'assets/app.js', 'assets/donut.css', 'assets/donut.js', 'assets/inhalt.css', 'assets/styles.css', ...FONTS,
  'assets/apple-touch-icon.png', 'assets/favicon.svg', 'favicon.ico', ...OG.map(n => `assets/og/${n}.jpg`), 'assets/partner/dyai-studio.svg', 'assets/partner/pixelkiez.png', 'datenschutz.html', 'impressum.html', 'index.html',
  ...['agent-readiness', 'answerability', 'entity-trust', 'index', 'seo-geo-ai-visibility', 'wie-ki-websites-liest', 'wie-websites-ausgeliefert-werden'].map(s => `wissen/${s}.html`),
  ...['auffindbarkeit-seo', 'barrierefreiheit', 'index', 'ki-crawler-agenten', 'ki-verstaendlichkeit', 'methodik', 'nutzerfuehrung-conversion', 'performance-technik', 'vertrauen-datenschutz', 'warum-website-analyse'].map(s => `analyse/${s}.html`)];

let dir, sha;
before(() => {
  sha = git(ROOT, 'rev-parse', '--verify', `${REF}^{commit}`);
  dir = mkdtempSync(join(tmpdir(), 'pxwa-release-'));
  /* --no-local: echter Klon über das Git-Protokoll (keine Hardlinks, keine Dateien aus dem Arbeitsverzeichnis) */
  execFileSync('git', ['clone', '--quiet', '--no-local', '--no-checkout', ROOT, dir], { stdio: 'ignore' });
  git(dir, 'checkout', '--quiet', '--detach', sha);
});
after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

const pub = f => join(dir, 'public', f);

test('Frischer Checkout: public/ enthält genau die Website-Dateien und die zwei freigegebenen Poster (versioniert, bytegleich), keine Videos', t => {
  t.diagnostic(`geprüfter Commit: ${sha}`);
  const files = git(dir, 'ls-files', 'public').split('\n').filter(Boolean).map(f => f.slice('public/'.length)).sort();
  assert.deepEqual(files, [...SITE, ...Object.keys(MEDIA)].sort(), 'Medien fehlen im Commit oder unerwartete Dateien in public/');
  assert.deepEqual(git(dir, 'ls-files').split('\n').filter(f => /\.(mp4|webm|mov|m4v)$/i.test(f)), [], 'keine Videos im Repository (sie liegen in R2)');
  for (const [f, hash] of Object.entries(MEDIA)) {
    assert.ok(existsSync(pub(f)), `${f} fehlt im frischen Checkout`);
    const buf = readFileSync(pub(f));
    assert.ok(buf.length > 1024 && buf.length <= 25 * 1024 * 1024, `${f}: ${buf.length} Byte (Pages-Grenze 25 MiB)`);
    assert.equal(createHash('sha256').update(buf).digest('hex'), hash, `${f}: nicht die freigegebene Fassung`);
    if (f.endsWith('.jpg')) assert.equal(buf.subarray(0, 3).toString('hex'), 'ffd8ff', `${f}: kein JPEG`);
    if (f.endsWith('.mp4')) assert.equal(buf.toString('latin1', 4, 8), 'ftyp', `${f}: kein MP4`);
    t.diagnostic(`${f}: ${(buf.length / 1048576).toFixed(2)} MiB`);
  }
});

test('Frischer Checkout: jede in den Seiten referenzierte lokale Datei (src, poster, href, Titelbild) liegt vor oder ist ein Video-Pfad der R2-Function; jede feste Route ist gedeckt', () => {
  const missing = [];
  /* Feste Video-Pfade: in _routes.json und in der Allowlist der Function (Pfad → R2-Schlüssel), nicht als Datei im Checkout */
  const routes = JSON.parse(readFileSync(pub('_routes.json'), 'utf8'));
  const r2 = new Set([...readFileSync(join(dir, 'functions/media/[file].ts'), 'utf8').matchAll(/\['(\/media\/[^']+)', '[^']+'\]/g)].map(m => m[1]));
  const videoRoute = path => routes.include.includes('/' + path) && r2.has('/' + path);
  for (const page of SITE.filter(f => f.endsWith('.html'))) {
    for (const e of H.elements(H.parse(readFileSync(pub(page), 'utf8')).root)) {
      /* Titelbilder werden absolut angegeben (og:image, twitter:image) und müssen im Checkout liegen */
      if (e.tag === 'meta' && /^(og:image|twitter:image)$/.test(e.attrs.get('property') || e.attrs.get('name') || '')) {
        const v = e.attrs.get('content');
        if (!v.startsWith('https://360.pixelkiez.de/') || !existsSync(pub(v.slice('https://360.pixelkiez.de/'.length)))) missing.push(`${page}: Titelbild ${v}`);
      }
      for (const a of ['src', 'poster', 'href']) {
        const v = e.attrs.get(a);
        if (!v || /^(https?:|mailto:|data:|#)/.test(v) || v.startsWith('/api/')) continue;
        /* relativ zur Seite auflösen (Wissensseiten liegen in wissen/); ein Verzeichnis meint dessen index.html */
        const path = decodeURI(new URL(v, `https://360.pixelkiez.de/${page}`).pathname.slice(1)).replace(/(^|\/)$/, '$1index.html');
        if (!existsSync(pub(path)) && !videoRoute(path)) missing.push(`${page}: ${a}="${v}"`);
      }
    }
  }
  for (const r of routes.include.filter(r => !r.includes('*'))) if (!existsSync(pub(r.slice(1))) && !r2.has(r)) missing.push(`_routes.json: ${r}`);
  assert.deepEqual([...r2].sort(), routes.include.filter(r => r.startsWith('/media/')).sort(), 'Allowlist der Function = Video-Routen');
  assert.deepEqual(missing, []);
});

test('Frischer Checkout: keine PHP-, Railway- oder Docker-Reste, keine lokalen Secret-Dateien, keine Schlüssel im Inhalt', () => {
  const files = git(dir, 'ls-files').split('\n').filter(Boolean);
  assert.deepEqual(files.filter(f => /\.(php|phtml)$|(^|\/)\.htaccess$|railway|Dockerfile|Caddyfile|\.dockerignore|(^|\/)\.env|(^|\/)\.dev\.vars$|\.sqlite$|^\.wrangler\//i.test(f)), []);
  const hits = [];
  for (const f of files.filter(f => !/\.(mp4|jpg)$/.test(f) && !f.startsWith('tests/'))) {
    const s = readFileSync(join(dir, f), 'utf8');
    if (/-----BEGIN (RSA |EC )?PRIVATE KEY-----|GOCSPX-[A-Za-z0-9_-]{10,}|\b(re|sk|pm|xkeysib)_[A-Za-z0-9_-]{20,}/.test(s)) hits.push(f);
  }
  assert.deepEqual(hits, []);
});
