/* Lokale Test-Umgebung für PXWA – nur Mocks, keine echten Provider.
   - API-Worker in workerd (Miniflare) mit lokaler D1-Datenbank (SQLite, im Speicher), Bundle per esbuild aus worker/src
   - Mock-Google: Token-Endpunkt (prüft client_secret, redirect_uri, PKCE, Einmal-Code) und JWKS mit Testschlüssel
   - Mock-Mail-API (HTTPS-Mail-API-Ersatz): prüft Bearer-Token, zählt angenommene Nachrichten, kann 503/422 liefern
   - Caddy mit deploy/railway/Caddyfile als statischer Ursprung (Railway-Ersatz) und ein Edge-Proxy als Cloudflare-Ersatz:
     /api/* → Worker, alles andere → Caddy (wie die Cloudflare-Route <domain>/api/*)
   Die Google-Autorisierungsseite selbst wird nicht nachgebaut: Tests lesen state/nonce/code_challenge aus der
   Weiterleitungs-URL und rufen den Callback so auf, wie Google es nach erfolgreicher Anmeldung täte. */
import http from 'node:http';
import net from 'node:net';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { generateKeyPairSync, createHash, sign, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, cpSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CLIENT_ID = 'pxwa-test-client.apps.googleusercontent.com';
export const CLIENT_SECRET = 'test-only-secret';
export const MAIL_TOKEN = 'test-only-mail-token';
export const MAIL_FROM = 'analyse@pixelkiez.de';
export const NOTIFY_TO = 'kontakt@pixelkiez.de';
export const CUSTOMER = 'kunde@beispiel-kunde.de';
export const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';

const load = async name => { try { return await import(name); } catch { return null; } };
const miniflare = await load('miniflare');
const esbuild = await load('esbuild');
export const workerAvailable = Boolean(miniflare && esbuild);
export const caddyAvailable = spawnSync('caddy', ['version']).status === 0;

const b64url = b => Buffer.from(b).toString('base64url');
export const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const listen = (server, port = 0) => new Promise(r => server.listen(port, '127.0.0.1', () => r(server.address().port)));
const readBody = async req => { const c = []; for await (const x of req) c.push(x); return Buffer.concat(c); };
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export async function waitFor(fn, { timeout = 5000, what = 'Bedingung' } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) throw new Error(`Zeitüberschreitung: ${what}`);
    await sleep(25);
  }
}

/* ---------- Mock-Google ---------- */

export function mockGoogle() {
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const rogue = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...key.publicKey.export({ format: 'jwk' }), kid: 'test-key-1', alg: 'RS256', use: 'sig' };
  const codes = new Map();
  const log = { token: [], certs: 0 };
  const state = { outage: false };   // true: Token- und Schlüssel-Endpunkt antworten mit 503 (Störung bei Google)
  let redirectUri = '';

  const idToken = ({ nonce, claims = {}, mode }) => {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: mode === 'alg-none' ? 'none' : mode === 'hs256' ? 'HS256' : 'RS256', kid: 'test-key-1', typ: 'JWT' };
    const payload = { iss: 'https://accounts.google.com', azp: CLIENT_ID, aud: CLIENT_ID, sub: '100000000000000000001', email: CUSTOMER, email_verified: true, iat: now, exp: now + 3600, nonce, ...claims };
    const h64 = b64url(JSON.stringify(header)), p64 = b64url(JSON.stringify(payload));
    if (mode === 'alg-none') return `${h64}.${p64}.`;
    const sig = b64url(sign('sha256', Buffer.from(`${h64}.${p64}`), mode === 'rogue' ? rogue.privateKey : key.privateKey));
    /* Manipulation nach dem Signieren: andere E-Mail-Adresse, Signatur bleibt alt */
    if (mode === 'tamper') return `${h64}.${b64url(JSON.stringify({ ...payload, email: 'angreifer@beispiel-kunde.de' }))}.${sig}`;
    return `${h64}.${p64}.${sig}`;
  };

  const server = http.createServer(async (req, res) => {
    const body = (await readBody(req)).toString('utf8');
    const url = new URL(req.url, 'http://mock');
    if (state.outage && ['/certs', '/token'].includes(url.pathname)) {
      res.writeHead(503, { 'content-type': 'text/plain' });
      return res.end('Service Unavailable');
    }
    if (req.method === 'GET' && url.pathname === '/certs') {
      log.certs++;
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' });
      return res.end(JSON.stringify({ keys: [jwk] }));
    }
    /* Nur für Browser-Tests: Autorisierung ohne Google-Oberfläche, sofortiger Rücksprung mit Einmal-Code */
    if (req.method === 'GET' && url.pathname === '/auth') {
      const p = url.searchParams;
      log.auth = (log.auth || 0) + 1;
      log.lastAuth = Object.fromEntries(p);
      const code = '4/mock-' + randomBytes(12).toString('hex');
      codes.set(code, { nonce: p.get('nonce'), challenge: p.get('code_challenge'), redirectUri: p.get('redirect_uri') });
      res.writeHead(302, { location: `${p.get('redirect_uri')}?state=${encodeURIComponent(p.get('state'))}&code=${encodeURIComponent(code)}&scope=email%20openid` });
      return res.end();
    }
    if (req.method === 'POST' && url.pathname === '/token') {
      const f = Object.fromEntries(new URLSearchParams(body));
      log.token.push(f);
      const entry = codes.get(f.code);
      codes.delete(f.code);   // Codes sind wie bei Google nur einmal einlösbar
      const challengeOk = entry && createHash('sha256').update(f.code_verifier || '').digest('base64url') === entry.challenge;
      const ok = entry && challengeOk && f.client_id === CLIENT_ID && f.client_secret === CLIENT_SECRET
        && f.grant_type === 'authorization_code' && f.redirect_uri === redirectUri && entry.redirectUri === redirectUri;
      if (!ok) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end('{"error":"invalid_grant"}'); }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ access_token: 'mock-access-token-should-never-be-stored', expires_in: 3599, scope: 'openid email', token_type: 'Bearer', id_token: idToken(entry) }));
    }
    res.writeHead(404); res.end();
  });

  return {
    log, codes, state,
    async start() { this.port = await listen(server); this.origin = `http://127.0.0.1:${this.port}`; return this; },
    setRedirectUri(u) { redirectUri = u; },
    issueCode({ nonce, challenge, redirectUri: ru, claims, mode }) {
      const code = '4/mock-' + randomBytes(12).toString('hex');
      codes.set(code, { nonce, challenge, redirectUri: ru, claims, mode });
      return code;
    },
    stop: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); }),
  };
}

/* ---------- Mock-Mail-API ---------- */

/* mode: 'ok' | 'fail' (503, vorübergehend) | 'reject' (422, dauerhaft) */
export function mockMailApi() {
  const state = { mode: 'ok', accepted: [], attempts: 0, requests: [] };
  const server = http.createServer(async (req, res) => {
    const raw = (await readBody(req)).toString('utf8');
    const url = new URL(req.url, 'http://mock');
    if (req.method !== 'POST' || url.pathname !== '/v1/send') { res.writeHead(404); return res.end(); }
    state.attempts++;
    state.requests.push({ headers: req.headers, raw });
    if (req.headers.authorization !== `Bearer ${MAIL_TOKEN}`) { res.writeHead(401); return res.end('{"error":"unauthorized"}'); }
    if (state.mode === 'fail') { res.writeHead(503, { 'content-type': 'application/json' }); return res.end('{"error":"try again later"}'); }
    if (state.mode === 'reject') { res.writeHead(422, { 'content-type': 'application/json' }); return res.end('{"error":"invalid"}'); }
    let json;
    try { json = JSON.parse(raw); } catch { res.writeHead(400); return res.end(); }
    state.accepted.push({ ...json, idempotencyKey: req.headers['idempotency-key'], contentType: req.headers['content-type'] });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'mock-' + state.accepted.length }));
  });
  return {
    state,
    async start() { this.port = await listen(server); this.origin = `http://127.0.0.1:${this.port}`; this.url = `${this.origin}/v1/send`; return this; },
    reset() { state.mode = 'ok'; state.accepted.length = 0; state.requests.length = 0; state.attempts = 0; },
    stop: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); }),
  };
}

/* ---------- API-Worker in workerd (Miniflare) ---------- */

let bundled = null;
async function bundle() {
  if (!bundled) {
    const dir = mkdtempSync(join(tmpdir(), 'pxwa-bundle-'));
    const outfile = join(dir, 'worker.mjs');
    await esbuild.build({ entryPoints: [join(ROOT, 'worker/src/index.ts')], bundle: true, format: 'esm', target: 'es2022', platform: 'neutral', outfile, logLevel: 'silent' });
    bundled = { dir, outfile };
    process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
  }
  return bundled.outfile;
}

const COMPATIBILITY_DATE = /^compatibility_date\s*=\s*"([^"]+)"/m.exec(readFileSync(join(ROOT, 'worker/wrangler.toml'), 'utf8'))[1];
export const MIGRATION = readFileSync(join(ROOT, 'worker/migrations/0001_init.sql'), 'utf8');
const statements = sql => sql.replace(/^\s*--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean);

/* base: Basis-URL (BASE_URL); scheme 'https' ergibt https://127.0.0.1:PORT. env: Overrides (undefined entfernt den Schlüssel).
   db: false startet ohne D1-Binding; migrate: false lässt das Schema weg. */
export async function startWorker({ google, mail, base, scheme = 'http', authEndpoint, env = {}, db = true, migrate = true } = {}) {
  base ??= `${scheme}://127.0.0.1:${await freePort()}`;
  const bindings = {
    ENV: 'local', BASE_URL: base,
    GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
    GOOGLE_TOKEN_ENDPOINT: google ? `${google.origin}/token` : undefined, GOOGLE_JWKS_URI: google ? `${google.origin}/certs` : undefined,
    GOOGLE_AUTH_ENDPOINT: authEndpoint,
    SECRET: randomBytes(32).toString('hex'), PRIVACY_VERSION: 'TEST-2026-10-30',
    MAIL_API_URL: mail?.url, MAIL_API_TOKEN: MAIL_TOKEN, MAIL_FROM, MAIL_NOTIFY_TO: NOTIFY_TO,
    ...env,
  };
  for (const k of Object.keys(bindings)) if (bindings[k] === undefined) delete bindings[k];
  google?.setRedirectUri(`${base}/api/auth/callback`);
  let logs = '';
  const mf = new miniflare.Miniflare({
    modules: true, scriptPath: await bundle(), modulesRoot: bundled.dir, compatibilityDate: COMPATIBILITY_DATE, bindings,
    ...(db ? { d1Databases: { DB: 'pxwa-test-' + randomBytes(6).toString('hex') } } : {}),
    handleRuntimeStdio(stdout, stderr) { stdout.on('data', d => { logs += d; }); stderr.on('data', d => { logs += d; }); },
  });
  await mf.ready;
  const d1 = db ? await mf.getD1Database('DB') : null;
  const run = (q, ...params) => d1.prepare(q).bind(...params).run();
  const app = {
    mf, base, authEndpoint: authEndpoint ?? GOOGLE_AUTH,
    logs: () => logs,
    fetch: (url, init) => mf.dispatchFetch(url, init),
    sql: async (q, ...params) => (await d1.prepare(q).bind(...params).all()).results,
    run,
    exec: async q => { for (const s of statements(q)) await run(s); },
    migrate: async () => { for (const s of statements(MIGRATION)) await run(s); },
    /* Gesamter gespeicherter Inhalt aller Tabellen */
    dump: async () => JSON.stringify(await Promise.all(['orders', 'notifications', 'rate_limits', 'sessions'].map(t => app.sql(`SELECT * FROM ${t}`)))),
    /* Cron-Trigger auslösen; liefert Ergebnis und die dabei geschriebenen Log-Zeilen */
    async cron() {
      const before = logs.length;
      const result = await (await mf.getWorker()).scheduled({ cron: '*/5 * * * *' });
      await sleep(50);
      return { ...result, log: logs.slice(before) };
    },
    stop: () => mf.dispose(),
  };
  if (db && migrate) await app.migrate();
  return app;
}

/* ---------- Statischer Ursprung (Caddy, wie auf Railway) und Edge (wie die Cloudflare-Route) ---------- */

/* Dateien, die ins Railway-Artefakt gehen: versionierte bzw. nicht ignorierte Dateien in public/ ohne public/media/ (.dockerignore) */
export const artifactFiles = () => execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'public'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').filter(f => f && existsSync(join(ROOT, f)) && !f.startsWith('public/media/') && !f.endsWith('.DS_Store')).map(f => f.slice('public/'.length)).sort();

/* media: lokale Testkopie der Videos aus public/media/ ergänzen (Ersatz für den späteren Medien-Dienst; nicht Teil des Artefakts) */
export function siteRoot({ media = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pxwa-site-'));
  for (const f of artifactFiles()) { mkdirSync(dirname(join(dir, f)), { recursive: true }); cpSync(join(ROOT, 'public', f), join(dir, f)); }
  if (media && existsSync(join(ROOT, 'public/media'))) cpSync(join(ROOT, 'public/media'), join(dir, 'media'), { recursive: true });
  return dir;
}

export async function startCaddy(root) {
  const port = await freePort();
  const home = mkdtempSync(join(tmpdir(), 'pxwa-caddy-'));
  const proc = spawn('caddy', ['run', '--config', join(ROOT, 'deploy/railway/Caddyfile'), '--adapter', 'caddyfile'], {
    env: { ...process.env, PORT: String(port), SITE_ROOT: root, XDG_DATA_HOME: home, XDG_CONFIG_HOME: home, HOME: home }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  proc.stdout.on('data', d => { logs += d; });
  proc.stderr.on('data', d => { logs += d; });
  const url = `http://127.0.0.1:${port}`;
  await waitFor(async () => { try { return (await fetch(url + '/index.html')).ok; } catch { return false; } }, { timeout: 10000, what: 'Caddy-Start' });
  return {
    url, logs: () => logs,
    async stop() { proc.kill(); await new Promise(r => proc.exitCode !== null ? r() : proc.once('exit', r)); rmSync(home, { recursive: true, force: true }); },
  };
}

const HOP = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'content-length', 'upgrade', 'te', 'trailer', 'proxy-connection']);

export async function startEdge({ port, worker, origin }) {
  const server = http.createServer(async (req, res) => {
    try {
      const body = await readBody(req);
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = Array.isArray(v) ? v.join(', ') : v;
      const init = { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body, redirect: 'manual' };
      let r;
      if (req.url.startsWith('/api/')) {
        headers['cf-connecting-ip'] = req.socket.remoteAddress.replace(/^::ffff:/, '');
        r = await worker.fetch(`http://127.0.0.1:${port}${req.url}`, init);
      } else {
        r = await fetch(origin + req.url, init);
      }
      res.statusCode = r.status;
      for (const [k, v] of r.headers) if (!HOP.has(k) && k !== 'set-cookie' && k !== 'content-encoding') res.setHeader(k, v);
      const cookies = r.headers.getSetCookie();
      if (cookies.length) res.setHeader('set-cookie', cookies);
      res.end(Buffer.from(await r.arrayBuffer()));
    } catch {
      res.statusCode = 502;
      res.end();
    }
  });
  await listen(server, port);
  return { url: `http://127.0.0.1:${port}`, stop: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); }) };
}

/* ---------- HTTP-Client mit Cookie-Speicher (wie ein Browser, ohne JavaScript), direkt gegen den Worker ---------- */

export class Client {
  /* origin: Origin-Header für Formulare; ip: CF-Connecting-IP, die Cloudflare setzen würde */
  constructor(app, { origin, ip = '198.51.100.7', base } = {}) { this.app = app; this.base = base ?? app.base; this.origin = origin ?? new URL(this.base).origin; this.ip = ip; this.cookies = new Map(); this.setCookies = []; }
  async req(method, path, { form, headers = {} } = {}) {
    const h = { 'cf-connecting-ip': this.ip, ...headers };
    if (this.cookies.size) h.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    let body;
    if (form) {
      body = new URLSearchParams(form).toString();
      h['content-type'] = 'application/x-www-form-urlencoded';
      if (!('origin' in h)) h.origin = this.origin;
      if (h.origin === null) delete h.origin;
    }
    const res = await this.app.fetch(new URL(path, this.base).href, { method, headers: h, body, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      this.setCookies.push(c);
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const k = pair.slice(0, i), v = pair.slice(i + 1);
      if (v === '' || /max-age=0(;|$)/i.test(c)) this.cookies.delete(k); else this.cookies.set(k, v);
    }
    return { status: res.status, location: res.headers.get('location'), headers: res.headers, text: await res.text() };
  }
}

export const field = (html, name) => (html.match(new RegExp(`name="${name}" value="([^"]*)"`)) || [])[1];

/* Kompletter Ablauf bis zur Rückkehr von Google. claims/mode steuern das ID-Token des Mock-Google. */
export async function login(client, google, { website = 'musterfirma.de', claims, mode, state } = {}) {
  const start = await client.req('POST', '/api/anfrage', { form: { action: 'start', website } });
  if (start.status !== 303 || !start.location?.startsWith(client.app.authEndpoint)) return { start };
  const auth = new URL(start.location);
  const p = auth.searchParams;
  const code = google.issueCode({ nonce: p.get('nonce'), challenge: p.get('code_challenge'), redirectUri: p.get('redirect_uri'), claims, mode });
  const callbackPath = `/api/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state ?? p.get('state'))}&scope=email+openid`;
  const callback = await client.req('GET', callbackPath);
  return { start, auth, callback, callbackPath };
}

export async function confirm(client, { consent = true, csrf, idem } = {}) {
  const page = await client.req('GET', '/api/anfrage');
  const form = { action: 'confirm', csrf: csrf ?? field(page.text, 'csrf') ?? '', idem: idem ?? field(page.text, 'idem') ?? '' };
  if (consent) form.zustimmung = '1';
  return { page, form, res: await client.req('POST', '/api/anfrage', { form }) };
}
