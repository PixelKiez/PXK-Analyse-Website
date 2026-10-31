/* PXWA – Cloudflare Pages: Pages Function an der Service-Binding-Grenze und lokales Pages (wrangler pages dev).
   Nur lokale Nachbildung mit workerd und Wrangler, ohne Cloudflare-Konto: KEIN Test gegen echtes Cloudflare, Google oder Resend.
   Ausführen im Repo-Root nach `npm ci`:  node --test tests/pages.test.mjs */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  ROOT, CUSTOMER, NOTIFY_TO, mockGoogle, mockResend, startPages, startPagesFunction, buildPagesFunctions, uploadFiles,
  Client, login, confirm, field, waitFor, workerAvailable, wranglerAvailable,
} from './lib/harness.mjs';

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

test('Routing: Function läuft nur für /api/* (_routes.json); Wrangler erzeugt aus functions/ dieselbe Regel; functions/ enthält nur das Gateway', { skip }, () => {
  const routes = JSON.parse(readFileSync(join(ROOT, 'public/_routes.json'), 'utf8'));
  assert.deepEqual(routes, { version: 1, include: ['/api/*'], exclude: [] });
  const generated = buildPagesFunctions().routes;
  assert.deepEqual([generated.include, generated.exclude], [routes.include, routes.exclude], 'eigene und erzeugte Regeln stimmen überein');
  const files = [];
  const walk = d => { for (const f of readdirSync(join(ROOT, 'functions', d), { withFileTypes: true })) f.isDirectory() ? walk(join(d, f.name)) : files.push(join(d, f.name)); };
  walk('');
  assert.deepEqual(files.sort(), ['api/[[path]].ts', 'tsconfig.json']);
});

/* ---------- Lokales Cloudflare Pages (wrangler pages dev) ---------- */

const STATIC_HEADERS = {
  'strict-transport-security': 'max-age=31536000', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY',
  'content-security-policy': "frame-ancestors 'none'", 'referrer-policy': 'strict-origin-when-cross-origin', 'cross-origin-opener-policy': 'same-origin',
};

test('Lokales Pages ohne verbundenen Worker: statische Dateien ohne Function mit Sicherheits-Headern, unbekannte Pfade 404, /api/* 503', { skip }, async t => {
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
    const video = files.find(f => f.endsWith('.mp4'));
    if (video) {
      const r = await get('/' + video, { headers: { range: 'bytes=0-1' } });
      await r.arrayBuffer();
      assert.ok([200, 206].includes(r.status));
      t.diagnostic(`Range bytes=0-1 auf ${video}: HTTP ${r.status}${r.status === 200 ? ' (ganze Datei, wie von Cloudflare für Pages dokumentiert – Safari/iOS spielt so kein Video)' : ''}`);
    } else {
      t.diagnostic('Medien fehlen in public/media/ – Range-Verhalten nicht geprüft');
    }
  } finally {
    await site.stop();
  }
});

test('Lokales Pages mit Worker über das Service Binding: URL-Eingabe → Function → Worker → Google-Mock → Callback → D1 → Bestätigung → Resend-Mock', { skip }, async () => {
  const google = await mockGoogle().start();
  const mail = await mockResend().start();
  const site = await startPages({ google, mail });
  try {
    const c = new Client(site, { ip: '198.51.100.20' });
    const home = await c.req('GET', '/');
    assert.equal(home.status, 200);
    const { start, auth, callback } = await login(c, google, { website: 'https://www.musterfirma.de/leistungen' });
    assert.equal(start.status, 303, start.text.slice(0, 200));
    assert.equal(auth.searchParams.get('redirect_uri'), `${site.base}/api/auth/callback`);
    assert.equal(auth.searchParams.get('scope'), 'openid email');
    const [first] = start.headers.getSetCookie();
    assert.match(first, /^pxwa=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=3600; HttpOnly; SameSite=Lax$/, 'Session-Cookie kommt über die Binding-Grenze');
    assert.equal(callback.status, 303);
    assert.equal(callback.location, `${site.base}/api/anfrage`);
    assert.notEqual(callback.headers.getSetCookie()[0].split(';')[0], first.split(';')[0], 'Session-Wechsel nach dem Login');
    const crossSite = await c.req('POST', '/api/anfrage', { form: { action: 'confirm', csrf: 'x', idem: 'y', zustimmung: '1' }, headers: { origin: 'https://evil.example' } });
    assert.equal(crossSite.status, 403, 'Origin-Prüfung des Workers greift auch hinter der Function');
    const page = await c.req('GET', '/api/anfrage');
    const form = { action: 'confirm', csrf: field(page.text, 'csrf'), idem: field(page.text, 'idem'), zustimmung: '1' };
    const [a, b] = await Promise.all([c.req('POST', '/api/anfrage', { form }), c.req('POST', '/api/anfrage', { form })]);
    assert.deepEqual([a.status, b.status], [303, 303], 'Doppelabsendung → gleiche Bestätigung');
    const done = await c.req('GET', '/api/anfrage');
    const ref = (done.text.match(/id="reference">(PXA-[0-9A-Z]{4}-[0-9A-Z]{4})</) || [])[1];
    assert.ok(ref, 'Referenz angezeigt');
    const orders = site.sql('SELECT reference, email, website_url FROM orders');
    assert.deepEqual(orders, [{ reference: ref, email: CUSTOMER, website_url: 'https://www.musterfirma.de/leistungen' }], 'genau ein Auftrag in D1');
    await waitFor(() => site.sql("SELECT status FROM notifications")[0]?.status === 'sent', { what: 'Benachrichtigung', timeout: 10000 });
    assert.equal(mail.state.accepted.length, 1);
    assert.deepEqual(mail.state.accepted[0].to, [NOTIFY_TO]);
    assert.equal(mail.state.accepted[0].idempotencyKey, `pxwa-${ref}`);
    assert.ok(mail.state.accepted[0].userAgent);
    const out = await c.req('POST', '/api/anfrage', { form: { action: 'logout', csrf: form.csrf } });
    assert.equal(out.location, `${site.base}/index.html`);
    assert.ok(out.headers.getSetCookie().some(s => /^pxwa=;.*Max-Age=0/.test(s)), 'Abmelde-Cookie kommt über die Binding-Grenze');
    assert.ok(!site.logs().includes(CUSTOMER) && !site.logs().includes('musterfirma') && !site.logs().includes('code='), 'Log ohne E-Mail, Website oder Google-Code');
  } finally {
    await site.stop(); await google.stop(); await mail.stop();
  }
});

test('Medien: Videos und Poster liegen lokal vor, unter 25 MiB je Datei (Pages-Grenze); sonst Release-Blocker', { skip: !existsSync(join(ROOT, 'public/media')) && 'NOT_RUN: public/media/ fehlt – Release-Blocker: Originalmedien fehlen' }, async t => {
  const media = uploadFiles().filter(f => f.startsWith('media/'));
  assert.deepEqual(media, ['media/360-pixelkiez-video-1080p.mp4', 'media/360-pixelkiez-video-poster.jpg', 'media/report-pdf-de-1x1.mp4', 'media/report-pdf-poster.jpg']);
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
