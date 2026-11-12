/* PXWA – Cloudflare Pages: Pages Function an der Service-Binding-Grenze, Video-Function (R2, Byte-Ranges) und lokales Pages (wrangler pages dev).
   Nur lokale Nachbildung mit workerd und Wrangler, ohne Cloudflare-Konto: KEIN Test gegen echtes Cloudflare, Google oder Resend.
   Ausführen im Repo-Root nach `npm ci`:  node --test tests/pages.test.mjs */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, createHash } from 'node:crypto';
import {
  ROOT, CUSTOMER, NOTIFY_TO, mockGoogle, mockResend, startPages, startPagesFunction, buildPagesFunctions, uploadFiles,
  Client, login, startForm, addressForm, field, referenceOf, waitFor, workerAvailable, wranglerAvailable, TERMS_VERSION, SOFT_LAUNCH, R2_VIDEOS, R2_BILDER, R2_MEDIEN,
} from './lib/harness.mjs';
import { execFileSync } from 'node:child_process';

const skip = !workerAvailable ? 'NOT_RUN: miniflare/esbuild fehlen (npm ci)' : !wranglerAvailable ? 'NOT_RUN: wrangler fehlt (npm ci)' : false;
const SITE = 'https://360.pixelkiez.de';

/* Ersatz-Worker hinter dem Binding: spiegelt die empfangene Anfrage; /api/weiter antwortet mit 303 und zwei Cookies */
const ECHO = `let calls = 0;
export default { async fetch(request) {
  calls++;
  const url = new URL(request.url);
  if (url.pathname === '/api/wirft') throw new Error('Testfehler');
  const headers = new Headers({ 'content-type': 'application/json', 'x-calls': String(calls) });
  headers.append('set-cookie', '__Host-pxwa=neu; Path=/; Max-Age=3600; HttpOnly; Secure; SameSite=Lax');
  headers.append('set-cookie', 'zweites=1; Path=/; HttpOnly');
  if (url.pathname === '/api/weiter') { headers.set('location', '${SITE}/api/ziel'); return new Response(null, { status: 303, headers }); }
  const body = request.method === 'HEAD' ? '' : await request.text();
  return new Response(JSON.stringify({ method: request.method, url: request.url, headers: Object.fromEntries(request.headers), body }),
    { status: url.pathname === '/api/fehlt' ? 404 : 200, headers });
} };`;

/* ---------- Kompilierte Pages Function (wrangler pages functions build) in workerd ---------- */

test('Pages Function: Anfrage geht über das Service Binding unverändert an den Worker (Methode, Pfad, Query, Header, Cookies, Body)', { skip }, async () => {
  const fn = await startPagesFunction({ api: ECHO });
  try {
    const cases = [
      ['GET', undefined, {}],
      ['POST', 'action=start&website=m%C3%BCller-b%C3%A4ckerei.de&x=' + 'y'.repeat(5000), { 'content-type': 'application/x-www-form-urlencoded', origin: SITE }],
      ['PUT', '{"a":[1,2,3]}', { 'content-type': 'application/json' }],
      ['DELETE', undefined, {}],
    ];
    for (const [method, body, extra] of cases) {
      const headers = { cookie: '__Host-pxwa=abc123; andere=1', 'cf-connecting-ip': '203.0.113.5', 'user-agent': 'Testbrowser', ...extra };
      const r = await fn.fetch(`${SITE}/api/anfrage?x=1&y=%C3%BC`, { method, headers, body, redirect: 'manual' });
      assert.equal(r.status, 200, method);
      const seen = await r.json();
      assert.equal(seen.method, method);
      assert.equal(seen.url, `${SITE}/api/anfrage?x=1&y=%C3%BC`, `${method}: Original-URL (Host, Pfad, Query) bleibt erhalten`);
      for (const [k, v] of Object.entries(headers)) assert.equal(seen.headers[k], v, `${method}: Header ${k}`);
      assert.equal(seen.body, body ?? '', `${method}: Body`);
      assert.deepEqual(r.headers.getSetCookie(), ['__Host-pxwa=neu; Path=/; Max-Age=3600; HttpOnly; Secure; SameSite=Lax', 'zweites=1; Path=/; HttpOnly'], `${method}: beide Set-Cookie unverändert`);
    }
    const head = await fn.fetch(`${SITE}/api/anfrage`, { method: 'HEAD', redirect: 'manual' });
    assert.equal(head.status, 200);
  } finally {
    await fn.stop();
  }
});

test('Pages Function: Weiterleitungen und Statuscodes des Workers kommen unverändert zurück (303 mit Location und Cookies, 404)', { skip }, async () => {
  const fn = await startPagesFunction({ api: ECHO });
  try {
    const r = await fn.fetch(`${SITE}/api/weiter`, { method: 'POST', body: 'a=b', headers: { 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), `${SITE}/api/ziel`, 'Location unverändert');
    assert.equal(r.headers.getSetCookie().length, 2);
    assert.equal(r.headers.get('x-calls'), '1', 'Weiterleitung wird nicht in der Function verfolgt');
    const missing = await fn.fetch(`${SITE}/api/fehlt`, { redirect: 'manual' });
    assert.equal(missing.status, 404);
  } finally {
    await fn.stop();
  }
});

test('Pages Function: ohne Service Binding (Vorschau) oder bei Ausnahme im Worker 503 – kein HTML, kein Rückfall auf statische Dateien', { skip }, async t => {
  const none = await startPagesFunction({ api: null });
  const broken = await startPagesFunction({ api: ECHO });
  try {
    for (const [name, fn, path] of [['ohne Binding', none, '/api/anfrage'], ['ohne Binding', none, '/api/auth/callback?code=x&state=y'], ['Worker wirft', broken, '/api/wirft']]) {
      for (const method of ['GET', 'POST']) {
        const r = await fn.fetch(SITE + path, { method, body: method === 'POST' ? 'action=start&website=musterfirma.de' : undefined, headers: { 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });
        const text = await r.text();
        assert.equal(r.status, 503, `${name} ${method} ${path}`);
        assert.match(r.headers.get('content-type'), /^text\/plain/);
        assert.equal(r.headers.get('cache-control'), 'no-store');
        assert.equal(r.headers.get('location'), null);
        assert.deepEqual(r.headers.getSetCookie(), []);
        assert.match(text, /Anfragen sind im Moment nicht möglich/);
        assert.ok(!/<html|statische Datei/i.test(text), `${name}: keine statische Seite als API-Antwort`);
      }
    }
    t.diagnostic('Ausnahme im Worker hinter dem Binding: Die Function erhält eine Ausnahme und antwortet mit 503');
  } finally {
    await none.stop(); await broken.stop();
  }
});

test('Routing: Functions laufen nur für /api/* und genau die drei Videos und das Hintergrundbild aus R2 (_routes.json); Poster und alle übrigen Dateien bleiben statisch', { skip }, () => {
  const routes = JSON.parse(readFileSync(join(ROOT, 'public/_routes.json'), 'utf8'));
  assert.deepEqual(routes, { version: 1, include: ['/api/*', ...R2_MEDIEN.map(([p]) => p)], exclude: [] });
  /* Wrangler erzeugt aus functions/media/[file].ts die breitere Regel /media/*; die eigene _routes.json hat Vorrang und
     beschränkt die Video-Function auf die drei festen Pfade */
  const generated = buildPagesFunctions().routes;
  assert.deepEqual([[...generated.include].sort(), generated.exclude], [['/api/*', '/media/*'], []]);
  assert.ok(routes.include.every(r => r === '/api/*' || r.startsWith('/media/')), 'jede eigene Regel ist durch eine Function gedeckt');
  const files = [];
  const walk = d => { for (const f of readdirSync(join(ROOT, 'functions', d), { withFileTypes: true })) f.isDirectory() ? walk(join(d, f.name)) : files.push(join(d, f.name)); };
  walk('');
  assert.deepEqual(files.sort(), ['api/[[path]].ts', 'media/[file].ts', 'tsconfig.json']);
  assert.deepEqual(uploadFiles().filter(f => /\.(mp4|webm|mov|m4v)$/i.test(f)), [], 'keine Videos im Pages-Upload: sie kommen aus R2');
  /* Allowlist der Function: genau diese vier Pfade, jeder fest auf seinen R2-Schlüssel */
  const src = readFileSync(join(ROOT, 'functions/media/[file].ts'), 'utf8');
  assert.deepEqual([...src.matchAll(/\['(\/media\/[^']*)', '([^']*)'\]/g)].map(m => [m[1], m[2]]), R2_MEDIEN);
});

/* ---------- Video-Function (functions/media/[file].ts) kompiliert in workerd, mit Miniflare-R2 als Binding MEDIA ---------- */

const VIDEOS = R2_VIDEOS.map(k => `/media/${k}`);
const POSTERS = ['/media/360-pixelkiez-website-analyse-poster.jpg', '/media/report-pdf-lavendel-poster.jpg', '/media/section-bericht-peach-poster.jpg'];
const FILE = Uint8Array.from({ length: 1000 }, (_, i) => (i * 7) % 251);
/* Je Schlüssel ein anderer Inhalt: so fällt auf, wenn ein Pfad das falsche Objekt liefert */
const content = key => FILE.map(b => (b + R2_MEDIEN.findIndex(([, k]) => k === key) + 1) % 256);
const seeded = (extra = {}) => ({ ...Object.fromEntries(R2_MEDIEN.map(([, k]) => [k, content(k)])), ...extra });
/* Sicherheits-Header des Blocks /* in public/_headers */
const headersFile = () => Object.fromEntries(readFileSync(join(ROOT, 'public/_headers'), 'utf8').split(/\n(?=\S)/).find(b => b.startsWith('/*\n'))
  .split('\n').slice(1).map(l => l.trim()).filter(l => l && !l.startsWith('!') && !l.startsWith('#')).map(l => [l.slice(0, l.indexOf(':')).toLowerCase(), l.slice(l.indexOf(':') + 1).trim()]));
/* noindex laut _headers für eine Adresse; die Medien-Function setzt darüber hinaus ihre eigene noindex-Regel. */
const noindexIn = host => {
  const h = readFileSync(join(ROOT, 'public/_headers'), 'utf8');
  return host.endsWith('.pages.dev') ? /^https:\/\/:project\.pages\.dev\/\*\n {2}X-Robots-Tag: noindex$/m.test(h) : new RegExp(`^https://${host.replace(/\./g, '\\.')}/\\*\\n {2}X-Robots-Tag: noindex$`, 'm').test(h);
};

test('Video-Function (R2): Byte-Ranges nach RFC 9110 – 200 ohne Range, 206 mit Content-Range/Content-Length, 416 für ungültige oder nicht erfüllbare Bereiche; je Pfad genau sein Objekt', { skip }, async () => {
  const fn = await startPagesFunction({ media: seeded() });
  try {
    for (const key of R2_VIDEOS) {
      const full = await fn.fetch(`${SITE}/media/${key}`, { headers: { cookie: 'x=1' } });
      assert.equal(full.status, 200, key);
      assert.deepEqual(new Uint8Array(await full.arrayBuffer()), content(key), `${key}: ganze Datei, genau dieses Objekt`);
      assert.deepEqual([full.headers.get('content-type'), full.headers.get('content-length'), full.headers.get('accept-ranges'), full.headers.get('content-range')],
        ['video/mp4', '1000', 'bytes', null], key);
      assert.match(full.headers.get('etag'), /^"[0-9a-f]{32}"$/, `${key}: starker ETag aus R2`);
      assert.equal(full.headers.get('cache-control'), 'public, max-age=0, must-revalidate', key);
    }
    const data = content(R2_VIDEOS[0]);
    const cases = [
      ['bytes=0-1', 206, 0, 1], ['bytes=0-', 206, 0, 999], ['bytes=100-199', 206, 100, 199], ['bytes=990-5000', 206, 990, 999], ['bytes=999-999', 206, 999, 999],
      ['bytes=-10', 206, 990, 999], ['bytes=-5000', 206, 0, 999], ['Bytes=5-9', 206, 5, 9], ['bytes=0-99999999999999999999', 206, 0, 999],
      ['bytes=1000-', 416], ['bytes=5000-6000', 416], ['bytes=-0', 416], ['bytes=5-2', 416], ['bytes=-', 416], ['bytes=', 416], ['bytes=abc', 416], ['bytes=1-2-3', 416],
      ['bytes= 0-1', 416], ['bytes=0x10-20', 416], ['bytes=+1-2', 416], ['0-1', 416], ['bytes', 416], ['bytes=' + '9'.repeat(120) + '-', 416],
      /* andere Einheit: muss ignoriert werden; mehrere Bereiche: nicht unterstützt → ganze Datei */
      ['items=0-1', 200, 0, 999], ['bytes=0-1,5-6', 200, 0, 999],
    ];
    for (const [range, status, start, end] of cases) {
      const r = await fn.fetch(SITE + VIDEOS[0], { headers: { range } });
      const body = new Uint8Array(await r.arrayBuffer());
      assert.equal(r.status, status, range);
      if (status === 416) {
        assert.deepEqual([r.headers.get('content-range'), r.headers.get('accept-ranges'), r.headers.get('cache-control'), r.headers.get('etag')], ['bytes */1000', 'bytes', 'no-store', null], range);
        assert.match(r.headers.get('content-type'), /^text\/plain/, range);
        continue;
      }
      assert.equal(r.headers.get('accept-ranges'), 'bytes', range);
      assert.deepEqual(body, data.slice(start, end + 1), `${range}: Inhalt`);
      assert.equal(r.headers.get('content-length'), String(end - start + 1), `${range}: Content-Length`);
      assert.equal(r.headers.get('content-range'), status === 206 ? `bytes ${start}-${end}/1000` : null, `${range}: Content-Range`);
      assert.equal(r.headers.get('content-type'), 'video/mp4', range);
    }
  } finally {
    await fn.stop();
  }
});

test('Video-Function (R2): HEAD, ETag (If-None-Match → 304, If-Range), nur GET/HEAD, fester MIME-Typ, Sicherheits-Header wie _headers; nur die drei Schlüssel, Fehler kontrolliert', { skip }, async () => {
  /* Im Bucket liegen zusätzlich Objekte außerhalb der Allowlist und ein Video mit falschem Content-Type in den Metadaten */
  const fn = await startPagesFunction({ media: seeded({ 'geheim.mp4': Uint8Array.of(1, 2, 3), 'kunden/auftraege.json': new TextEncoder().encode('{"email":"kunde@beispiel-kunde.de"}'),
    [R2_VIDEOS[2]]: { data: content(R2_VIDEOS[2]), contentType: 'text/html; charset=utf-8' } }) });
  try {
    const v = SITE + VIDEOS[1];
    const head = await fn.fetch(v, { method: 'HEAD' });
    assert.deepEqual([head.status, head.headers.get('content-length'), head.headers.get('accept-ranges'), (await head.arrayBuffer()).byteLength], [200, '1000', 'bytes', 0]);
    const etag = head.headers.get('etag');
    const headRange = await fn.fetch(v, { method: 'HEAD', headers: { range: 'bytes=10-19' } });
    assert.deepEqual([headRange.status, headRange.headers.get('content-length'), headRange.headers.get('content-range'), (await headRange.arrayBuffer()).byteLength], [206, '10', 'bytes 10-19/1000', 0]);
    const headBad = await fn.fetch(v, { method: 'HEAD', headers: { range: 'bytes=5000-' } });
    assert.deepEqual([headBad.status, headBad.headers.get('content-range'), (await headBad.arrayBuffer()).byteLength], [416, 'bytes */1000', 0]);
    for (const [inm, status] of [[etag, 304], [`W/${etag}`, 304], ['*', 304], [`"alt", ${etag}`, 304], ['"alt"', 206]]) {
      const r = await fn.fetch(v, { headers: { 'if-none-match': inm, range: 'bytes=0-1' } });
      await r.arrayBuffer();
      assert.equal(r.status, status, `If-None-Match ${inm}`);
      if (status === 304) assert.equal(r.headers.get('etag'), etag);
    }
    for (const [ifRange, status] of [[etag, 206], ['"alt"', 200], [`W/${etag}`, 200], ['Sat, 31 Oct 2026 10:00:00 GMT', 200]]) {
      const r = await fn.fetch(v, { headers: { 'if-range': ifRange, range: 'bytes=0-1' } });
      assert.equal(r.status, status, `If-Range ${ifRange}`);
      assert.equal((await r.arrayBuffer()).byteLength, status === 206 ? 2 : 1000);
    }
    /* Content-Type kommt aus der Allowlist, nicht aus den Metadaten im Bucket */
    const mime = await fn.fetch(SITE + VIDEOS[2], { headers: { range: 'bytes=0-9' } });
    assert.deepEqual([mime.status, mime.headers.get('content-type'), mime.headers.get('x-content-type-options')], [206, 'video/mp4', 'nosniff']);
    assert.deepEqual(new Uint8Array(await mime.arrayBuffer()), content(R2_VIDEOS[2]).slice(0, 10));
    const expected = headersFile();
    assert.ok(Object.keys(expected).length >= 7);
    for (const [range, status] of [[undefined, 200], ['bytes=0-1', 206], ['bytes=5000-', 416]]) {
      const r = await fn.fetch(v, { headers: range ? { range } : {} });
      await r.arrayBuffer();
      assert.equal(r.status, status);
      for (const [k, val] of Object.entries(expected)) assert.equal(r.headers.get(k), val, `${status}: ${k} wie in _headers`);
      assert.equal(r.headers.get('access-control-allow-origin'), null);
      assert.equal(r.headers.get('cross-origin-resource-policy'), 'same-origin', 'Video nicht auf fremden Seiten einbindbar');
      assert.deepEqual(r.headers.getSetCookie(), []);
      assert.equal(r.headers.get('x-robots-tag'), 'noindex', 'R2-Medien bleiben gemäß Function-Regel ausgeschlossen');
    }
    const preview = await fn.fetch('https://pxwa.pages.dev' + VIDEOS[0], { headers: { range: 'bytes=0-1' } });
    await preview.arrayBuffer();
    assert.deepEqual([preview.status, preview.headers.get('x-robots-tag') === 'noindex'], [206, noindexIn('pxwa.pages.dev')], '*.pages.dev wie in _headers nicht indexieren');
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
      const r = await fn.fetch(v, { method, body: ['POST', 'PUT', 'PATCH'].includes(method) ? 'x' : undefined });
      assert.deepEqual([r.status, r.headers.get('allow'), (await r.arrayBuffer()).byteLength], [405, 'GET, HEAD', 0], method);
    }
    /* Andere Pfade (Poster, alte oder unbekannte Videos, Objekte außerhalb der Allowlist, Umgehungsversuche, das Verzeichnis selbst)
       bedient die Function nicht selbst: weiter an die statischen Dateien – nie ein anderes R2-Objekt, nie ein Listing */
    for (const p of [...POSTERS, '/media/', '/media/geheim.mp4', '/media/kunden/auftraege.json', '/media/report-pdf-de-1x1.mp4', '/media/gibt-es-nicht.mp4',
      '/media/360-pixelkiez-video-1080p.mp4', '/media/360-pixelkiez-video-1080p.mp4.bak', '/media/%2e%2e%2fapi%2fanfrage', '/media/360-PIXELKIEZ-VIDEO-1080P.MP4', '/media/__proto__', '/media/constructor', '/media/360-pixelkiez-video-1080p.mp4/']) {
      const r = await fn.fetch(SITE + p, { headers: { range: 'bytes=0-1' } });
      assert.deepEqual([r.status, await r.text()], [200, 'statische Datei'], p);
    }
    const q = await fn.fetch(SITE + VIDEOS[0] + '?datei=geheim.mp4&key=kunden/auftraege.json', { headers: { range: 'bytes=0-1' } });
    assert.equal(q.status, 206, 'Query verändert das gelesene Objekt nicht');
    assert.deepEqual(new Uint8Array(await q.arrayBuffer()), content(R2_VIDEOS[0]).slice(0, 2));
  } finally {
    await fn.stop();
  }
  /* Ohne Binding (Vorschau), Binding defekt, Objekt fehlt im Bucket: kontrollierte Fehler ohne fremde Inhalte; andere Methoden
     bleiben 405, ohne dass die Function den Bucket anfasst. Das Poster-Fallback in app.js ersetzt das Video dann durch das Standbild. */
  for (const [mode, media, status] of [['ohne Binding', null, 503], ['Binding defekt', 'broken', 503], ['Objekt fehlt', { [R2_VIDEOS[1]]: content(R2_VIDEOS[1]) }, 404]]) {
    const f = await startPagesFunction({ media });
    try {
      for (const method of ['GET', 'HEAD']) {
        const r = await f.fetch(SITE + VIDEOS[0], { method, headers: { range: 'bytes=0-1' } });
        const text = await r.text();
        assert.equal(r.status, status, `${mode} ${method}`);
        assert.match(r.headers.get('content-type'), /^text\/plain/, mode);
        assert.deepEqual([r.headers.get('cache-control'), r.headers.get('etag'), r.headers.get('x-frame-options')], ['no-store', null, 'DENY'], mode);
        assert.ok(!/<html|<title|doctype|kunde@|R2|Error|at /i.test(text), `${mode}: keine HTML-Seite, keine Interna`);
      }
      const post = await f.fetch(SITE + VIDEOS[0], { method: 'POST', body: 'x' });
      assert.equal(post.status, 405, `${mode}: POST`);
    } finally {
      await f.stop();
    }
  }
});

test('Nur das Hintergrundbild der Produktionsdomain darf indexiert werden', { skip }, async () => {
  const fn = await startPagesFunction({ media: seeded() });
  const [path] = R2_MEDIEN.find(([, key]) => key === R2_BILDER[0]);
  try {
    const full = await fn.fetch(SITE + path);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('x-robots-tag'), null);
    const etag = full.headers.get('etag');
    await full.arrayBuffer();
    for (const options of [{ method: 'HEAD' }, { headers: { range: 'bytes=0-1' } }, { headers: { 'if-none-match': etag } }]) {
      const response = await fn.fetch(SITE + path, options);
      assert.equal(response.status, options.method === 'HEAD' ? 200 : options.headers.range ? 206 : 304);
      assert.equal(response.headers.get('x-robots-tag'), null);
      await response.arrayBuffer();
    }
    for (const url of ['https://pxwa.pages.dev' + path, 'https://test.pxwa.pages.dev' + path, SITE + R2_MEDIEN.find(([, key]) => key === R2_BILDER[1])[0], SITE + VIDEOS[0]]) {
      const response = await fn.fetch(url);
      assert.equal(response.headers.get('x-robots-tag'), 'noindex', url);
      await response.arrayBuffer();
    }
  } finally {
    await fn.stop();
  }
});

test('Bild-Function (R2): das Hintergrundbild kommt fest als image/webp aus pictures/ (200, 206, ETag, Sicherheits-Header); das Original-PNG und andere Pfade im Ordner bedient die Function nicht', { skip }, async () => {
  const [pfad, key] = R2_MEDIEN.find(([, k]) => k === R2_BILDER[0]);
  const fn = await startPagesFunction({ media: seeded({ 'pictures/Sonnige Designrunde am Tisch.png': FILE }) });
  try {
    const full = await fn.fetch(SITE + pfad);
    assert.equal(full.status, 200, pfad);
    assert.deepEqual(new Uint8Array(await full.arrayBuffer()), content(key), 'genau dieses Objekt');
    assert.deepEqual([full.headers.get('content-type'), full.headers.get('content-length'), full.headers.get('x-content-type-options'), full.headers.get('cross-origin-resource-policy'), full.headers.get('x-frame-options')],
      ['image/webp', '1000', 'nosniff', 'same-origin', 'DENY']);
    assert.match(full.headers.get('etag'), /^"[0-9a-f]{32}"$/, 'starker ETag aus R2');
    const teil = await fn.fetch(SITE + pfad, { headers: { range: 'bytes=0-9' } });
    assert.deepEqual([teil.status, teil.headers.get('content-range'), teil.headers.get('content-type')], [206, 'bytes 0-9/1000', 'image/webp']);
    assert.deepEqual(new Uint8Array(await teil.arrayBuffer()), content(key).slice(0, 10));
    for (const p of ['/media/pictures/360-pixelkiez-designrunde-am-tisch.webp', '/media/Sonnige%20Designrunde%20am%20Tisch.png', '/media/pictures/Sonnige%20Designrunde%20am%20Tisch.png',
      '/media/pictures/', '/media/360-pixelkiez-designrunde-am-tisch.png', '/media/360-PIXELKIEZ-DESIGNRUNDE-AM-TISCH.WEBP']) {
      const r = await fn.fetch(SITE + p);
      assert.deepEqual([r.status, await r.text()], [200, 'statische Datei'], p);
    }
  } finally {
    await fn.stop();
  }
});

/* ---------- Lokales Cloudflare Pages (wrangler pages dev) ---------- */

const STATIC_HEADERS = {
  'strict-transport-security': 'max-age=31536000', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY',
  'content-security-policy': "frame-ancestors 'none'", 'referrer-policy': 'strict-origin-when-cross-origin', 'cross-origin-opener-policy': 'same-origin',
};

test('Lokales Pages ohne verbundenen Worker: alle Dateien mit Sicherheits-Headern, unbekannte Pfade 404, /api/* 503', { skip }, async t => {
  const site = await startPages({ worker: false });
  try {
    const get = (p, init = {}) => fetch(site.base + p, { redirect: 'manual', ...init });
    const files = uploadFiles();
    for (const f of files) {
      let r = await get('/' + f);
      if (f.endsWith('.html')) {
        assert.equal(r.status, 308, `${f}: Pages leitet .html auf die Adresse ohne Endung um`);
        r = await get(r.headers.get('location'));
      }
      /* Liefe die Function hier, käme ohne Worker 503 */
      assert.equal(r.status, 200, f);
      for (const [k, v] of Object.entries(STATIC_HEADERS)) assert.equal(r.headers.get(k), v, `${f}: ${k}`);
      assert.match(r.headers.get('permissions-policy'), /camera=\(\)/);
      assert.equal(r.headers.get('access-control-allow-origin'), null, `${f}: keine CORS-Freigabe`);
      await r.arrayBuffer();
    }
    const home = await (await get('/')).text();
    if (SOFT_LAUNCH) {
      assert.match(home, /<p class="bald">/, 'Soft-Launch: Hinweis statt Formular');
      assert.ok(!/<form\b/.test(home), 'Soft-Launch: kein Formular');
    } else {
      assert.match(home, /<form class="analyze" id="analyze" action="\/api\/anfrage"/);
    }
    for (const p of ['/gibt-es-nicht', '/a/b/c', '/vision.html', '/DESIGN.md', '/package.json', '/wrangler.toml', '/worker/wrangler.toml', '/worker/src/index.ts',
      '/functions/api/[[path]].ts', '/tests/pages.test.mjs', '/.git/HEAD', '/railway.json', '/anfrage.php', '/media/gibt-es-nicht.mp4', '/media/report-pdf-de-1x1.mp4', '/media/']) {
      const r = await get(p);
      const text = await r.text();
      assert.equal(r.status, 404, p);
      assert.match(text, /Seite nicht gefunden/, `${p}: eigene 404-Seite statt Startseite`);
      assert.equal(r.headers.get('x-frame-options'), 'DENY');
    }
    /* Lokal antwortet Wranglers Dev-Registry für den nicht verbundenen Worker selbst mit 503; die Function reicht das durch.
       POST mit Body bleibt in diesem lokalen Stub hängen (Eigenheit von wrangler pages dev) und wird hier nicht gesendet.
       Den eigenen 503 der Function (Binding fehlt, Worker wirft) für GET und POST prüft der workerd-Test oben. */
    let unavailable = '';
    for (const path of ['/api/anfrage', '/api/auth/callback?code=x&state=y', '/api']) {
      const r = await get(path, { signal: AbortSignal.timeout(10000) });
      const method = 'GET';
      unavailable = await r.text();
      assert.equal(r.status, 503, `${method} ${path}`);
      assert.match(r.headers.get('content-type'), /^text\/plain/);
      assert.equal(r.headers.get('location'), null);
      assert.deepEqual(r.headers.getSetCookie(), []);
      assert.ok(!/<html/i.test(unavailable), `${path}: keine statische Seite als API-Antwort`);
    }
    t.diagnostic(`/api/* ohne verbundenen Worker: 503 „${unavailable.trim()}“`);
  } finally {
    await site.stop();
  }
});

test('Lokales Pages: alle drei Videos und das Hintergrundbild aus lokalem R2 mit echten Byte-Ranges (200/206/416, HEAD, If-None-Match, 405); Poster statisch; leerer Bucket 404', { skip }, async t => {
  /* Mit PXK_MEDIA_DIR die echten Videos (lokale Kopie der R2-Objekte), sonst Testdaten je Schlüssel */
  const dir = mkdtempSync(join(tmpdir(), 'pxwa-media-'));
  const media = Object.fromEntries(R2_MEDIEN.map(([, k]) => {
    const real = process.env.PXK_MEDIA_DIR && join(process.env.PXK_MEDIA_DIR, k);
    if (real) return [k, real];
    const f = join(dir, k.replace(/\//g, '_'));
    writeFileSync(f, randomBytes(300000));
    return [k, f];
  }));
  const site = await startPages({ worker: false, media });
  try {
    const get = (p, init = {}) => fetch(site.base + p, { redirect: 'manual', ...init });
    for (const [pfad, key] of R2_MEDIEN.filter(([, k]) => R2_BILDER.includes(k))) {
      const r = await get(pfad);
      assert.deepEqual([r.status, r.headers.get('content-type'), r.headers.get('x-frame-options')], [200, 'image/webp', 'DENY'], pfad);
      assert.ok(Buffer.from(await r.arrayBuffer()).equals(readFileSync(media[key])), `${pfad}: bytegleich`);
    }
    for (const key of R2_VIDEOS) {
      const video = `/media/${key}`;
      const file = readFileSync(media[key]);
      const size = file.length;
      const full = await get(video);
      assert.equal(full.status, 200, video);
      assert.ok(Buffer.from(await full.arrayBuffer()).equals(file), `${video}: ganze Datei bytegleich`);
      assert.deepEqual([full.headers.get('content-length'), full.headers.get('accept-ranges'), full.headers.get('content-type'), full.headers.get('x-frame-options')], [String(size), 'bytes', 'video/mp4', 'DENY']);
      const mid = Math.floor(size / 2);
      for (const [range, start, end] of [['bytes=0-1', 0, 1], ['bytes=0-', 0, size - 1], [`bytes=${mid}-${mid + 65535}`, mid, mid + 65535], ['bytes=-4096', size - 4096, size - 1], [`bytes=${size - 1}-`, size - 1, size - 1]]) {
        const r = await get(video, { headers: { range } });
        const body = Buffer.from(await r.arrayBuffer());
        assert.equal(r.status, 206, `${video} ${range}`);
        assert.equal(r.headers.get('content-range'), `bytes ${start}-${end}/${size}`, `${video} ${range}`);
        assert.equal(r.headers.get('content-length'), String(end - start + 1), `${video} ${range}`);
        assert.ok(body.equals(file.subarray(start, end + 1)), `${video} ${range}: Inhalt`);
      }
      for (const range of [`bytes=${size}-`, 'bytes=5-2', 'bytes=abc']) {
        const r = await get(video, { headers: { range } });
        await r.arrayBuffer();
        assert.deepEqual([r.status, r.headers.get('content-range')], [416, `bytes */${size}`], `${video} ${range}`);
      }
      const head = await get(video, { method: 'HEAD', headers: { range: 'bytes=0-1' } });
      assert.deepEqual([head.status, head.headers.get('content-range'), head.headers.get('content-length')], [206, `bytes 0-1/${size}`, '2'], `${video} HEAD`);
      const etag = full.headers.get('etag');
      assert.ok(etag, `${video}: ETag`);
      const again = await get(video, { headers: { 'if-none-match': etag } });
      assert.equal(again.status, 304, `${video}: unverändert → 304`);
      const post = await get(video, { method: 'POST', body: 'x' });
      assert.deepEqual([post.status, post.headers.get('allow')], [405, 'GET, HEAD'], `${video}: nur GET/HEAD`);
      t.diagnostic(`${video}: ${size} Byte, 200 ganz, 206 mit Content-Range, 416 außerhalb, 304 mit ETag, 405 für POST`);
    }
    /* Poster laufen nicht über die Function (nicht in _routes.json): unverändert statisch, Range wird wie bei Pages ignoriert */
    for (const poster of POSTERS) {
      const r = await get(poster, { headers: { range: 'bytes=0-1' } });
      const body = Buffer.from(await r.arrayBuffer());
      assert.equal(r.status, 200, poster);
      assert.ok(body.equals(readFileSync(join(ROOT, 'public', poster))), `${poster}: ganze Datei`);
      assert.match(r.headers.get('content-type'), /^image\/jpeg/);
    }
    const unknown = await get('/media/gibt-es-nicht.mp4', { headers: { range: 'bytes=0-1' } });
    assert.equal(unknown.status, 404);
    assert.match(await unknown.text(), /Seite nicht gefunden/, 'unbekannte Videos: eigene 404-Seite statt Function');
  } finally {
    await site.stop();
    rmSync(dir, { recursive: true, force: true });
  }
  /* Bucket ohne die Objekte: die vier Pfade antworten 404 (text/plain), keine andere Datei */
  const empty = await startPages({ worker: false });
  try {
    for (const video of R2_MEDIEN.map(([p]) => p)) {
      const r = await fetch(empty.base + video, { headers: { range: 'bytes=0-1' } });
      assert.deepEqual([r.status, r.headers.get('content-type'), (await r.text()).trim()], [404, 'text/plain; charset=utf-8', 'Nicht gefunden.'], video);
    }
  } finally {
    await empty.stop();
  }
});

test('Lokales Pages mit Worker über das Service Binding: Hero „Analysieren“ → Bestätigungsseite → Kästchen → Function → Worker → Google-Mock → Callback legt an (D1) → Eingangsbestätigung → Resend-Mock', { skip }, async () => {
  const google = await mockGoogle().start();
  const mail = await mockResend().start();
  const site = await startPages({ google, mail });
  try {
    const c = new Client(site, { ip: '198.51.100.20' });
    const home = await c.req('GET', '/');
    assert.equal(home.status, 200);
    /* Ohne „Analysieren“ (keine Session) lehnt der Worker auch hinter der Function ab: keine Weiterleitung, keine Session */
    const noSession = await c.req('POST', '/api/anfrage', { form: startForm() });
    assert.deepEqual([noSession.status, noSession.location, noSession.headers.getSetCookie().length], [409, null, 0]);
    assert.match(noSession.text, /Bitte geben Sie die Adresse erneut ein/);
    const crossSite = await c.req('POST', '/api/anfrage', { form: startForm(), headers: { origin: 'https://evil.example' } });
    assert.equal(crossSite.status, 403, 'Origin-Prüfung des Workers greift auch hinter der Function');
    assert.deepEqual(site.sql('SELECT COUNT(*) AS n FROM orders'), [{ n: 0 }]);
    /* Hero: „Analysieren“ → feste Weiterleitung zur Bestätigungsseite; Session-Cookie kommt über die Binding-Grenze */
    const hero = await c.req('POST', '/api/anfrage', { form: addressForm('https://www.musterfirma.de/leistungen') });
    assert.deepEqual([hero.status, hero.location], [303, `${site.base}/api/anfrage`]);
    const [first] = hero.headers.getSetCookie();
    assert.match(first, /^pxwa=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=3600; HttpOnly; SameSite=Lax$/, 'Session-Cookie kommt über die Binding-Grenze');
    const confirm = await c.req('GET', '/api/anfrage');
    assert.match(confirm.text, /<h1 class="anfrage-titel">Analyse anfragen<\/h1>/);
    assert.equal((confirm.text.match(/type="checkbox"/g) || []).length, 1, 'genau ein Kästchen');
    assert.match(confirm.text, /Mit Google fortfahren/);
    /* Ohne Häkchen lehnt der Worker auch hinter der Function ab: keine Weiterleitung, keine neue Session */
    const noBox = await c.req('POST', '/api/anfrage', { form: startForm({ website: field(confirm.text, 'website'), bestaetigung: false }) });
    assert.deepEqual([noBox.status, noBox.location, noBox.headers.getSetCookie().length], [422, null, 0]);
    assert.match(noBox.text, /Bitte bestätigen Sie das Kästchen/);
    const { start, auth, callback, callbackPath } = await login(c, google, { website: field(confirm.text, 'website') });
    assert.equal(start.status, 303, start.text.slice(0, 200));
    assert.equal(auth.searchParams.get('redirect_uri'), `${site.base}/api/auth/callback`);
    assert.equal(auth.searchParams.get('scope'), 'openid email');
    assert.ok(!/musterfirma/.test(start.location) && !/musterfirma/.test(hero.location), 'Website-Adresse in keiner Weiterleitung');
    assert.equal(callback.status, 303);
    assert.equal(callback.location, `${site.base}/api/anfrage`);
    assert.notEqual(callback.headers.getSetCookie()[0].split(';')[0], first.split(';')[0], 'Session-Wechsel nach dem Login');
    assert.equal((await c.req('GET', callbackPath)).status, 400, 'Rücksprung nur einmal gültig');
    const done = await c.req('GET', '/api/anfrage');
    const ref = referenceOf(done.text);
    assert.ok(ref, 'Referenz angezeigt, ohne zweiten Klick');
    const orders = site.sql('SELECT reference, email, website_url, terms_version, terms_accepted_at IS NOT NULL AS accepted FROM orders');
    assert.deepEqual(orders, [{ reference: ref, email: CUSTOMER, website_url: 'https://www.musterfirma.de/leistungen', terms_version: TERMS_VERSION, accepted: 1 }], 'genau ein Auftrag in D1 (Migrationen 0001 und 0002 lokal angewendet)');
    await waitFor(() => site.sql("SELECT status FROM notifications")[0]?.status === 'sent', { what: 'Benachrichtigung', timeout: 10000 });
    assert.equal(mail.state.accepted.length, 1);
    assert.deepEqual(mail.state.accepted[0].to, [NOTIFY_TO]);
    assert.equal(mail.state.accepted[0].idempotencyKey, `pxwa-${ref}`);
    assert.ok(mail.state.accepted[0].userAgent);
    const [{ csrf }] = site.sql("SELECT json_extract(data, '$.csrf') AS csrf FROM sessions WHERE json_extract(data, '$.done') IS NOT NULL");
    const out = await c.req('POST', '/api/anfrage', { form: { action: 'logout', csrf } });
    assert.equal(out.location, `${site.base}/index.html`);
    assert.ok(out.headers.getSetCookie().some(s => /^pxwa=;.*Max-Age=0/.test(s)), 'Abmelde-Cookie kommt über die Binding-Grenze');
    assert.ok(!site.logs().includes(CUSTOMER) && !site.logs().includes('musterfirma') && !site.logs().includes('code='), 'Log ohne E-Mail, Website oder Google-Code');
  } finally {
    await site.stop(); await google.stop(); await mail.stop();
  }
});

/* Stand der Videos im R2-Bucket 360pixelkiez (per API gelesen am 03.11.2026; bitgleich mit den lokalen Dateien im Originalarbeitsbaum) */
const R2_OBJECTS = {
  '360-pixelkiez-video-1080p-website-look.mp4': [9065852, '0e9bc84320c4b491af4aa01f3ded8923e0b1a53454d8a8209abbc9c007be5a70'],
  'report-pdf-de-1x1-lavendel.mp4': [3519956, 'ce5ca6ec4596fc45261bb09d644bb18d95ea38f780c8bb0dbf4ecc67e540b496'],
  'section-bericht-peach-5x4.mp4': [1230026, '81499189cf8a2968705b2ba4c13caccec312d4131481855f55b39300ce0c1130'],
  /* WebP-Fassung (q78, XMP) des am 04.11.2026 hochgeladenen pictures/Sonnige Designrunde am Tisch.png, hochgeladen 04.11.2026 */
  'pictures/360-pixelkiez-designrunde-am-tisch.webp': [172666, '00d5b6b198e208e3ec143a25504f1f96cd70201826016838ee8436a00ccb9c5f'],
  /* Logo: zugeschnittene WebP-Fassung (518 × 120, verlustfrei, XMP) des am 04.11.2026 hochgeladenen pictures/PK_TRS_logo.png */
  'pictures/pixelkiez-logo.webp': [13840, '89a2ca04a49e00447fed873139b39b38d91f14d6dcb152d7c27449aabefb337a'],
};
/* Urheber und Credit im XMP der Bilder: das Logo gehört Pixelkiez, das Hintergrundbild 360°Pixelkiez */
const URHEBER = { 'pictures/360-pixelkiez-designrunde-am-tisch.webp': '360°Pixelkiez', 'pictures/pixelkiez-logo.webp': 'Pixelkiez' };

test('Medien: nur die drei Poster sind versioniert und statisch (unter 25 MiB); Videos liegen nicht im Repository oder Pages-Upload, sondern in R2', async t => {
  const POSTER_FILES = POSTERS.map(p => p.slice(1)).sort();
  assert.ok(POSTER_FILES.every(f => existsSync(join(ROOT, 'public', f))), 'Poster fehlen in public/media/ – Release-Blocker');
  assert.deepEqual(uploadFiles().filter(f => f.startsWith('media/')), POSTER_FILES);
  /* Im Git-Index (bzw. Commit), nicht nur als ignorierte lokale Kopie; den Commit selbst prüft tests/release.test.mjs */
  const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'public/media'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  assert.deepEqual(tracked.map(f => f.slice('public/'.length)).sort(), POSTER_FILES, 'Poster nicht ignoriert, keine weiteren Medien');
  assert.deepEqual(Object.keys(R2_OBJECTS), [...R2_VIDEOS, ...R2_BILDER]);
  for (const f of POSTER_FILES) {
    const buf = readFileSync(join(ROOT, 'public', f));
    assert.ok(buf.length < 25 * 1024 * 1024, `${f}: ${buf.length} Byte`);
    t.diagnostic(`${f}: ${(buf.length / 1024).toFixed(1)} KiB`);
  }
});

test('R2-Videos und -Bild (lokale Kopie in PXK_MEDIA_DIR): Größe und SHA-256 wie im Bucket, MP4 mit Faststart (moov vor mdat), WebP mit XMP-Metadaten inkl. KI-Herkunft', { skip: !process.env.PXK_MEDIA_DIR && 'NOT_RUN: PXK_MEDIA_DIR nicht gesetzt (Verzeichnis mit den R2-Objekten)' }, async t => {
  for (const [key, [size, sha]] of Object.entries(R2_OBJECTS)) {
    const buf = readFileSync(join(process.env.PXK_MEDIA_DIR, key));
    assert.deepEqual([buf.length, createHash('sha256').update(buf).digest('hex')], [size, sha], key);
    if (key.endsWith('.webp')) {
      /* Titel, Beschreibung, Urheber, Credit und die maschinenlesbare KI-Herkunft (IPTC DigitalSourceType, Entscheidung des
         Auftraggebers 04.11.2026); kein Copyright-Vermerk (rein KI-erzeugt) */
      assert.deepEqual([buf.toString('latin1', 0, 4), buf.toString('latin1', 8, 12)], ['RIFF', 'WEBP'], key);
      const xmp = buf.toString('utf8');
      for (const s of ['<dc:title>', '<dc:description>', `<dc:creator><rdf:Seq><rdf:li>${URHEBER[key]}</rdf:li>`, `<photoshop:Credit>${URHEBER[key]}</photoshop:Credit>`,
        '<Iptc4xmpExt:DigitalSourceType>http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia</Iptc4xmpExt:DigitalSourceType>']) assert.ok(xmp.includes(s), `${key}: ${s}`);
      assert.ok(!xmp.includes('<dc:rights>'), `${key}: kein Copyright-Vermerk`);
      t.diagnostic(`${key}: ${(buf.length / 1024).toFixed(1)} KiB, WebP mit XMP`);
      continue;
    }
    const atoms = [];
    for (let o = 0; o + 8 <= buf.length && atoms.length < 6;) { const n = buf.readUInt32BE(o); atoms.push(buf.toString('latin1', o + 4, o + 8)); if (n < 8) break; o += n; }
    assert.ok(atoms[0] === 'ftyp' && atoms.indexOf('moov') > -1 && atoms.indexOf('moov') < atoms.indexOf('mdat'), `${key}: ${atoms.join(' ')}`);
    t.diagnostic(`${key}: ${(buf.length / 1048576).toFixed(2)} MiB, ${atoms.join(' ')}`);
  }
});
