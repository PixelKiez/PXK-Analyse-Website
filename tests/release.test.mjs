/* PXWA – Release-Prüfung aus einem frischen Git-Checkout. Klont das lokale Repository in ein temporäres Verzeichnis und
   prüft genau einen Commit (PXK_RELEASE_REF, Standard HEAD). Uncommittete, lokale oder ignorierte Dateien zählen nicht:
   Fehlen die Medien im Commit, schlägt der Test fehl, auch wenn public/media/ lokal vollständig ist.
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

/* Freigegebene öffentliche Website-Medien (eigenes 360°Pixelkiez-Material) mit SHA-256. Eine neue Fassung braucht eine
   eigene Freigabe und eine bewusste Änderung dieser Liste. Fassung vom 03.11.2026 (Freigabe des Auftraggebers): eingebettete
   Metadaten (Titel, Beschreibung, Urheber, Copyright); Video- und Bilddaten bitgleich zur vorigen Fassung. */
const MEDIA = {
  'media/360-pixelkiez-video-1080p.mp4': '593d8ebaa2b9915fe3294cde395b126f6763fd80b81e940d92e77b78b9ee3a50',
  'media/360-pixelkiez-video-poster.jpg': 'ed00b1672e93f78e005f246817e6c098a15daddc651c0ed4ac74a7b12a7faef6',
  'media/report-pdf-de-1x1.mp4': '8b616ebf7971600cce4a5d91a8b8b657ddc0dd522f2b8fe514010c6bdac8331d',
  'media/report-pdf-poster.jpg': 'a45494725853ee2acadf0e47ae4aff871531034f1d0a29397389cda7b6b9ceb2',
};
/* Titelbilder (og:image) je Seite und Icons gehören zur Website */
const OG = ['start', 'wissen', 'analyse',
  ...['agent-readiness', 'answerability', 'entity-trust', 'seo-geo-ai-visibility', 'wie-ki-websites-liest', 'wie-websites-ausgeliefert-werden'].map(s => `wissen-${s}`),
  ...['auffindbarkeit-seo', 'barrierefreiheit', 'ki-crawler-agenten', 'ki-verstaendlichkeit', 'methodik', 'nutzerfuehrung-conversion', 'performance-technik', 'vertrauen-datenschutz', 'warum-website-analyse'].map(s => `analyse-${s}`)];
const SITE = ['404.html', '_headers', '_routes.json', 'agb.html', 'assets/anfrage.css', 'assets/app.js', 'assets/donut.css', 'assets/donut.js', 'assets/inhalt.css', 'assets/styles.css',
  'assets/apple-touch-icon.png', 'assets/favicon.svg', 'favicon.ico', ...OG.map(n => `assets/og/${n}.jpg`), 'datenschutz.html', 'impressum.html', 'index.html',
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

test('Frischer Checkout: public/ enthält genau die Website-Dateien und die vier freigegebenen Medien (versioniert, bytegleich)', t => {
  t.diagnostic(`geprüfter Commit: ${sha}`);
  const files = git(dir, 'ls-files', 'public').split('\n').filter(Boolean).map(f => f.slice('public/'.length)).sort();
  assert.deepEqual(files, [...SITE, ...Object.keys(MEDIA)].sort(), 'Medien fehlen im Commit oder unerwartete Dateien in public/');
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

test('Frischer Checkout: jede in den Seiten referenzierte lokale Datei (src, poster, href, Titelbild) und jede feste Function-Route liegt vor', () => {
  const missing = [];
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
        if (!existsSync(pub(path))) missing.push(`${page}: ${a}="${v}"`);
      }
    }
  }
  const routes = JSON.parse(readFileSync(pub('_routes.json'), 'utf8'));
  for (const r of routes.include.filter(r => !r.includes('*'))) if (!existsSync(pub(r.slice(1)))) missing.push(`_routes.json: ${r}`);
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
