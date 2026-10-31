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
   eigene Freigabe und eine bewusste Änderung dieser Liste. */
const MEDIA = {
  'media/360-pixelkiez-video-1080p.mp4': '3c34886c0bfa8130ca08b64c496813d6e199cae218d57016539a765584a073f3',
  'media/360-pixelkiez-video-poster.jpg': 'f2867751a9b5c28e2d1d65f6857ba96e4e651bbfac482b4dc0cad5390f312095',
  'media/report-pdf-de-1x1.mp4': '028005b2cc077a4c610457029130dd080c70f27d0b59e47e8884cf868eeb6a97',
  'media/report-pdf-poster.jpg': '0654272d71a86d1de3473bba8c800aabd3ff546e12659b2374f9f313a0d5f477',
};
const SITE = ['404.html', '_headers', '_routes.json', 'assets/anfrage.css', 'assets/app.js', 'assets/styles.css', 'datenschutz.html', 'impressum.html', 'index.html', 'pruefkriterien.html'];

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

test('Frischer Checkout: jede in den Seiten referenzierte lokale Datei (src, poster, href) und jede feste Function-Route liegt vor', () => {
  const missing = [];
  for (const page of SITE.filter(f => f.endsWith('.html'))) {
    for (const e of H.elements(H.parse(readFileSync(pub(page), 'utf8')).root)) {
      for (const a of ['src', 'poster', 'href']) {
        const v = e.attrs.get(a);
        if (!v || /^(https?:|mailto:|data:|#)/.test(v) || v.startsWith('/api/')) continue;
        const path = decodeURI(v.split(/[?#]/)[0]).replace(/^\//, '');
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
