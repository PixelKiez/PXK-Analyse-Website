/* PXWA – Cloudflare Pages: Pages Function an der Service-Binding-Grenze, Video-Function (Byte-Ranges) und lokales Pages (wrangler pages dev).
   Nur lokale Nachbildung mit workerd und Wrangler, ohne Cloudflare-Konto: KEIN Test gegen echtes Cloudflare, Google oder Resend.
   Ausführen im Repo-Root nach `npm ci`:  node --test tests/pages.test.mjs */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  ROOT, CUSTOMER, NOTIFY_TO, mockGoogle, mockResend, startPages, startPagesFunction, buildPagesFunctions, uploadFiles,
  Client, login, startForm, referenceOf, waitFor, workerAvailable, wranglerAvailable, MfResponse, TERMS_VERSION,
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

test('Routing: Functions laufen nur für /api/* und genau die zwei Videos (_routes.json); Poster und alle übrigen Dateien bleiben statisch', { skip }, () => {
  const routes = JSON.parse(readFileSync(join(ROOT, 'public/_routes.json'), 'utf8'));
  assert.deepEqual(routes, { version: 1, include: ['/api/*', ...VIDEOS], exclude: [] });
  /* Wrangler erzeugt aus functions/media/[file].ts die breitere Regel /media/*; die eigene _routes.json hat Vorrang und
     beschränkt die Video-Function auf die zwei festen Pfade */
  const generated = buildPagesFunctions().routes;
  assert.deepEqual([[...generated.include].sort(), generated.exclude], [['/api/*', '/media/*'], []]);
  assert.ok(routes.include.every(r => r === '/api/*' || r.startsWith('/media/')), 'jede eigene Regel ist durch eine Function gedeckt');
  const files = [];
  const walk = d => { for (const f of readdirSync(join(ROOT, 'functions', d), { withFileTypes: true })) f.isDirectory() ? walk(join(d, f.name)) : files.push(join(d, f.name)); };
  walk('');
  assert.deepEqual(files.sort(), ['api/[[path]].ts', 'media/[file].ts', 'tsconfig.json']);
  assert.deepEqual(VIDEOS.map(v => v.slice(1)), uploadFiles().filter(f => f.endsWith('.mp4')), 'genau die ausgelieferten Videos');
});

/* ---------- Video-Function (functions/media/[file].ts) kompiliert in workerd, mit Ersatz für das Pages-Binding ASSETS ---------- */

const VIDEOS = ['/media/360-pixelkiez-video-1080p.mp4', '/media/report-pdf-de-1x1.mp4'];
const FILE = Uint8Array.from({ length: 1000 }, (_, i) => (i * 7) % 251);
const ETAG = '"pxwa-test-etag"';
/* Ersatz für ASSETS: liefert für die Videos FILE (wie Pages: 200, ganze Datei, auch bei Range); mode steuert Fehlerfälle */
function assetsStub(mode = 'ok') {
  const seen = [];
  const handler = req => {
    seen.push({ method: req.method, url: req.url, headers: Object.fromEntries(req.headers) });
    if (mode === 'throw') throw new Error('ASSETS nicht erreichbar');
    if (!VIDEOS.includes(new URL(req.url).pathname)) return new MfResponse('statische Datei', { status: 200, headers: { 'content-type': 'text/plain' } });
    if (mode === 'missing') return new MfResponse('<!doctype html><title>Seite nicht gefunden</title>', { status: 404, headers: { 'content-type': 'text/html' } });
    if (mode === 'html') return new MfResponse('<!doctype html><title>Startseite</title>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    return new MfResponse(FILE, { status: 200, headers: { 'content-type': 'video/mp4', etag: ETAG } });
  };
  return { seen, handler };
}
/* Sicherheits-Header des Blocks /* in public/_headers */
const headersFile = () => Object.fromEntries(readFileSync(join(ROOT, 'public/_headers'), 'utf8').split(/\n(?=\S)/).find(b => b.startsWith('/*\n'))
  .split('\n').slice(1).map(l => l.trim()).filter(l => l && !l.startsWith('!') && !l.startsWith('#')).map(l => [l.slice(0, l.indexOf(':')).toLowerCase(), l.slice(l.indexOf(':') + 1).trim()]));

test('Video-Function: Byte-Ranges nach RFC 9110 – 200 ohne Range, 206 mit Content-Range/Content-Length, 416 für ungültige oder nicht erfüllbare Bereiche', { skip }, async () => {
  const stub = assetsStub();
  const fn = await startPagesFunction({ assets: stub.handler });
  try {
    for (const video of VIDEOS) {
      const full = await fn.fetch(SITE + video, { headers: { cookie: 'x=1' } });
      assert.equal(full.status, 200, video);
      assert.deepEqual(new Uint8Array(await full.arrayBuffer()), FILE, `${video}: ganze Datei`);
      assert.deepEqual([full.headers.get('content-type'), full.headers.get('content-length'), full.headers.get('accept-ranges'), full.headers.get('etag'), full.headers.get('content-range')],
        ['video/mp4', '1000', 'bytes', ETAG, null], video);
    }
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
      assert.equal(r.headers.get('accept-ranges'), 'bytes', range);
      if (status === 416) {
        assert.equal(r.headers.get('content-range'), 'bytes */1000', range);
        assert.match(r.headers.get('content-type'), /^text\/plain/, range);
        continue;
      }
      assert.deepEqual(body, FILE.slice(start, end + 1), `${range}: Inhalt`);
      assert.equal(r.headers.get('content-length'), String(end - start + 1), `${range}: Content-Length`);
      assert.equal(r.headers.get('content-range'), status === 206 ? `bytes ${start}-${end}/1000` : null, `${range}: Content-Range`);
      assert.equal(r.headers.get('content-type'), 'video/mp4', range);
    }
    /* ASSETS bekommt nur feste Pfade als einfache GET-Anfrage – ohne Range, Cookies oder Bedingungen der Anfrage */
    assert.ok(stub.seen.length > 0 && stub.seen.every(s => s.method === 'GET' && VIDEOS.includes(new URL(s.url).pathname) && new URL(s.url).search === ''
      && !('range' in s.headers) && !('cookie' in s.headers) && !('if-none-match' in s.headers)), JSON.stringify(stub.seen.slice(0, 2)));
  } finally {
    await fn.stop();
  }
});

test('Video-Function: HEAD, ETag (If-None-Match → 304, If-Range), nur GET/HEAD, Sicherheits-Header wie _headers; andere Pfade statisch, Fehler kontrolliert', { skip }, async () => {
  const stub = assetsStub();
  const fn = await startPagesFunction({ assets: stub.handler });
  try {
    const v = SITE + VIDEOS[1];
    const head = await fn.fetch(v, { method: 'HEAD' });
    assert.deepEqual([head.status, head.headers.get('content-length'), head.headers.get('accept-ranges'), (await head.arrayBuffer()).byteLength], [200, '1000', 'bytes', 0]);
    const headRange = await fn.fetch(v, { method: 'HEAD', headers: { range: 'bytes=10-19' } });
    assert.deepEqual([headRange.status, headRange.headers.get('content-length'), headRange.headers.get('content-range'), (await headRange.arrayBuffer()).byteLength], [206, '10', 'bytes 10-19/1000', 0]);
    for (const [inm, status] of [[ETAG, 304], [`W/${ETAG}`, 304], ['*', 304], [`"alt", ${ETAG}`, 304], ['"alt"', 200]]) {
      const r = await fn.fetch(v, { headers: { 'if-none-match': inm, range: 'bytes=0-1' } });
      await r.arrayBuffer();
      assert.equal(r.status, status === 304 ? 304 : 206, `If-None-Match ${inm}`);
      if (status === 304) assert.equal(r.headers.get('etag'), ETAG);
    }
    for (const [ifRange, status] of [[ETAG, 206], ['"alt"', 200], [`W/${ETAG}`, 200], ['Sat, 31 Oct 2026 10:00:00 GMT', 200]]) {
      const r = await fn.fetch(v, { headers: { 'if-range': ifRange, range: 'bytes=0-1' } });
      assert.equal(r.status, status, `If-Range ${ifRange}`);
      assert.equal((await r.arrayBuffer()).byteLength, status === 206 ? 2 : 1000);
    }
    const expected = headersFile();
    assert.ok(Object.keys(expected).length >= 7);
    for (const [range, status] of [[undefined, 200], ['bytes=0-1', 206], ['bytes=5000-', 416]]) {
      const r = await fn.fetch(v, { headers: range ? { range } : {} });
      await r.arrayBuffer();
      assert.equal(r.status, status);
      for (const [k, val] of Object.entries(expected)) assert.equal(r.headers.get(k), val, `${status}: ${k} wie in _headers`);
      assert.equal(r.headers.get('access-control-allow-origin'), null);
      assert.deepEqual(r.headers.getSetCookie(), []);
      assert.equal(r.headers.get('x-robots-tag'), null, 'Produktionsdomain ohne noindex-Header');
    }
    const preview = await fn.fetch('https://pxwa.pages.dev' + VIDEOS[0], { headers: { range: 'bytes=0-1' } });
    await preview.arrayBuffer();
    assert.deepEqual([preview.status, preview.headers.get('x-robots-tag')], [206, 'noindex'], '*.pages.dev wie in _headers nicht indexieren');
    const calls = stub.seen.length;
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
      const r = await fn.fetch(v, { method, body: ['POST', 'PUT', 'PATCH'].includes(method) ? 'x' : undefined });
      await r.arrayBuffer();
      assert.deepEqual([r.status, r.headers.get('allow')], [405, 'GET, HEAD'], method);
    }
    assert.equal(stub.seen.length, calls, 'andere Methoden lesen keine Datei');
    /* Andere Pfade (Poster, unbekannte Dateien, Umgehungsversuche) bedient die Function nicht selbst: weiter an die statischen Dateien */
    for (const p of ['/media/report-pdf-poster.jpg', '/media/gibt-es-nicht.mp4', '/media/360-pixelkiez-video-1080p.mp4.bak', '/media/%2e%2e%2fapi%2fanfrage', '/media/360-PIXELKIEZ-VIDEO-1080P.MP4']) {
      const r = await fn.fetch(SITE + p, { headers: { range: 'bytes=0-1' } });
      assert.deepEqual([r.status, await r.text()], [200, 'statische Datei'], p);
    }
    const q = await fn.fetch(SITE + VIDEOS[0] + '?datei=../../worker/wrangler.toml', { headers: { range: 'bytes=0-1' } });
    await q.arrayBuffer();
    assert.equal(q.status, 206, 'Query verändert die gelesene Datei nicht');
    assert.equal(new URL(stub.seen.at(-1).url).search, '', 'Query geht nicht an ASSETS');
  } finally {
    await fn.stop();
  }
  /* Datei fehlt im Deployment, Pages liefert HTML statt Video, Binding nicht erreichbar: kontrollierte Fehler ohne fremde Inhalte.
     Das Poster-Fallback in app.js ersetzt das Video dann durch das Standbild. */
  for (const [mode, status] of [['missing', 404], ['html', 404], ['throw', 503]]) {
    const f = await startPagesFunction({ assets: assetsStub(mode).handler });
    try {
      const r = await f.fetch(SITE + VIDEOS[0], { headers: { range: 'bytes=0-1' } });
      const text = await r.text();
      assert.equal(r.status, status, mode);
      assert.match(r.headers.get('content-type'), /^text\/plain/, mode);
      assert.ok(!/<html|<title|doctype/i.test(text), `${mode}: kein HTML als Video`);
      assert.equal(r.headers.get('x-frame-options'), 'DENY', mode);
    } finally {
      await f.stop();
    }
  }
});

/* ---------- Lokales Cloudflare Pages (wrangler pages dev) ---------- */

const STATIC_HEADERS = {
  'strict-transport-security': 'max-age=31536000', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY',
  'content-security-policy': "frame-ancestors 'none'", 'referrer-policy': 'strict-origin-when-cross-origin', 'cross-origin-opener-policy': 'same-origin',
};

test('Lokales Pages ohne verbundenen Worker: alle Dateien mit Sicherheits-Headern (Videos über die Function), unbekannte Pfade 404, /api/* 503', { skip }, async t => {
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
    const home = await get('/');
    assert.match(await home.text(), /<form class="analyze" id="analyze" action="\/api\/anfrage"/);
    for (const p of ['/gibt-es-nicht', '/a/b/c', '/vision.html', '/DESIGN.md', '/package.json', '/wrangler.toml', '/worker/wrangler.toml', '/worker/src/index.ts',
      '/functions/api/[[path]].ts', '/tests/pages.test.mjs', '/.git/HEAD', '/railway.json', '/anfrage.php', '/media/gibt-es-nicht.mp4']) {
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

test('Lokales Pages: beide Videos mit echten Byte-Ranges (200/206/416, HEAD, If-None-Match) aus dem eigenen Assets-Binding; Poster weiter statisch', { skip }, async t => {
  const site = await startPages({ worker: false });
  try {
    const get = (p, init = {}) => fetch(site.base + p, { redirect: 'manual', ...init });
    for (const video of VIDEOS) {
      const file = readFileSync(join(ROOT, 'public', video));
      const size = file.length;
      const full = await get(video);
      assert.equal(full.status, 200, video);
      assert.ok(Buffer.from(await full.arrayBuffer()).equals(file), `${video}: ganze Datei bytegleich`);
      assert.deepEqual([full.headers.get('content-length'), full.headers.get('accept-ranges'), full.headers.get('content-type')], [String(size), 'bytes', 'video/mp4']);
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
      assert.equal(post.status, 405, `${video}: nur GET/HEAD`);
      t.diagnostic(`${video}: 200 ganz, 206 mit Content-Range, 416 außerhalb, 304 mit ETag`);
    }
    /* Poster laufen nicht über die Function (nicht in _routes.json): unverändert statisch, Range wird wie bei Pages ignoriert */
    for (const poster of ['/media/360-pixelkiez-video-poster.jpg', '/media/report-pdf-poster.jpg']) {
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
  }
});

test('Lokales Pages mit Worker über das Service Binding: Website + AGB → Function → Worker → Google-Mock → Callback legt an (D1) → Bestätigung → Resend-Mock', { skip }, async () => {
  const google = await mockGoogle().start();
  const mail = await mockResend().start();
  const site = await startPages({ google, mail });
  try {
    const c = new Client(site, { ip: '198.51.100.20' });
    const home = await c.req('GET', '/');
    assert.equal(home.status, 200);
    /* Ohne AGB-Häkchen lehnt der Worker auch hinter der Function ab: keine Weiterleitung, keine Session */
    const noAgb = await c.req('POST', '/api/anfrage', { form: startForm({ agb: false }) });
    assert.deepEqual([noAgb.status, noAgb.location, noAgb.headers.getSetCookie().length], [422, null, 0]);
    assert.match(noAgb.text, /Bitte akzeptieren Sie die AGB/);
    const crossSite = await c.req('POST', '/api/anfrage', { form: startForm(), headers: { origin: 'https://evil.example' } });
    assert.equal(crossSite.status, 403, 'Origin-Prüfung des Workers greift auch hinter der Function');
    assert.deepEqual(site.sql('SELECT COUNT(*) AS n FROM orders'), [{ n: 0 }]);
    const { start, auth, callback, callbackPath } = await login(c, google, { website: 'https://www.musterfirma.de/leistungen' });
    assert.equal(start.status, 303, start.text.slice(0, 200));
    assert.equal(auth.searchParams.get('redirect_uri'), `${site.base}/api/auth/callback`);
    assert.equal(auth.searchParams.get('scope'), 'openid email');
    const [first] = start.headers.getSetCookie();
    assert.match(first, /^pxwa=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=3600; HttpOnly; SameSite=Lax$/, 'Session-Cookie kommt über die Binding-Grenze');
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

test('Medien: Videos und Poster sind versioniert (nicht nur lokal), unter 25 MiB je Datei (Pages-Grenze), Videos mit Faststart', async t => {
  const MEDIA = ['media/360-pixelkiez-video-1080p.mp4', 'media/360-pixelkiez-video-poster.jpg', 'media/report-pdf-de-1x1.mp4', 'media/report-pdf-poster.jpg'];
  assert.ok(MEDIA.every(f => existsSync(join(ROOT, 'public', f))), 'Medien fehlen in public/media/ – Release-Blocker');
  assert.deepEqual(uploadFiles().filter(f => f.startsWith('media/')), MEDIA);
  /* Im Git-Index (bzw. Commit), nicht nur als ignorierte lokale Kopie; den Commit selbst prüft tests/release.test.mjs */
  const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'public/media'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  assert.deepEqual(tracked.map(f => f.slice('public/'.length)).sort(), MEDIA, 'Medien nicht ignoriert');
  const media = MEDIA;
  for (const f of media) {
    const buf = readFileSync(join(ROOT, 'public', f));
    assert.ok(buf.length < 25 * 1024 * 1024, `${f}: ${buf.length} Byte`);
    if (f.endsWith('.mp4')) {
      /* Faststart: moov vor mdat, damit die Wiedergabe ohne vollständigen Download beginnen kann */
      const atoms = [];
      for (let o = 0; o + 8 <= buf.length && atoms.length < 6;) { const size = buf.readUInt32BE(o); atoms.push(buf.toString('latin1', o + 4, o + 8)); if (size < 8) break; o += size; }
      assert.ok(atoms.indexOf('moov') > -1 && atoms.indexOf('moov') < atoms.indexOf('mdat'), `${f}: ${atoms.join(' ')}`);
    }
    t.diagnostic(`${f}: ${(buf.length / 1048576).toFixed(2)} MiB`);
  }
});
