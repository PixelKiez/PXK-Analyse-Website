/* Lokale Test-Umgebung für PXWA – nur Mocks, keine echten Provider (kein Cloudflare-Konto, kein Google, kein Resend).
   - API-Worker in workerd (Miniflare) mit lokaler D1-Datenbank (SQLite, im Speicher), Bundle per esbuild aus worker/src
   - Mock-Google: Token-Endpunkt (prüft client_secret, redirect_uri, PKCE, Einmal-Code) und JWKS mit Testschlüssel
   - Mock-Resend: Vertrag von POST https://api.resend.com/emails (User-Agent, Bearer-Token, JSON-Schema, Idempotency-Key,
     Fehlerantworten { statusCode, name, message }); kann Fehler, Verbindungsabbruch und ausbleibende Antworten simulieren
   - Pages Function: mit `wrangler pages functions build` kompiliert und in workerd ausgeführt (Vertrag an der Binding-Grenze)
   - Lokales Cloudflare Pages: `wrangler pages dev` mit public/, _routes.json, _headers und functions/ aus dem Repository,
     optional mit dem API-Worker in derselben Sitzung, verbunden über das Service Binding API wie in Produktion
   Die Google-Autorisierungsseite selbst wird nicht nachgebaut: Tests lesen state/nonce/code_challenge aus der
   Weiterleitungs-URL und rufen den Callback so auf, wie Google es nach erfolgreicher Anmeldung täte. */
import http from 'node:http';
import net from 'node:net';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { generateKeyPairSync, createHash, sign, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CLIENT_ID = 'pxwa-test-client.apps.googleusercontent.com';
export const CLIENT_SECRET = 'test-only-secret';
export const MAIL_TOKEN = 'test-only-mail-token';
export const MAIL_FROM = 'analyse@notify.pixelkiez.de';
export const NOTIFY_TO = 'kontakt@pixelkiez.de';
export const CUSTOMER = 'kunde@beispiel-kunde.de';
export const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
export const PRODUCTION_BASE = 'https://360.pixelkiez.de';
/* AGB-Version, die der Hero zur Zustimmung anbietet (Feld agb_version); lokale Tests nutzen genau diesen Entwurf */
export const TERMS_VERSION = /<input type="hidden" name="agb_version" value="([^"]+)">/.exec(readFileSync(join(ROOT, 'public/index.html'), 'utf8'))[1];

const load = async name => { try { return await import(name); } catch { return null; } };
const miniflare = await load('miniflare');
const esbuild = await load('esbuild');
export const workerAvailable = Boolean(miniflare && esbuild);
const WRANGLER = join(ROOT, 'node_modules/.bin/wrangler');
export const wranglerAvailable = existsSync(WRANGLER);
const wranglerEnv = (extra = {}) => ({ ...process.env, WRANGLER_SEND_METRICS: 'false', ...extra });

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
  /* outage: Token- und Schlüssel-Endpunkt antworten mit 503 (Störung bei Google).
     authPage: /auth zeigt statt sofortiger Rückleitung eine Seite mit „Weiter“ und „Abbrechen“ (Browser-Zurück, Abbruch) */
  const state = { outage: false, authPage: false };
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
      const back = `${p.get('redirect_uri')}?state=${encodeURIComponent(p.get('state'))}`;
      if (state.authPage) {
        const esc = s => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(`<!doctype html><html lang="de"><title>Mock-Google</title><h1>Mock-Google-Anmeldung</h1>
<a id="weiter" href="${esc(`${back}&code=${encodeURIComponent(code)}&scope=email%20openid`)}">Weiter</a> <a id="abbrechen" href="${esc(`${back}&error=access_denied`)}">Abbrechen</a></html>`);
      }
      res.writeHead(302, { location: `${back}&code=${encodeURIComponent(code)}&scope=email%20openid` });
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

/* ---------- Mock-Resend ---------- */

/* Antwortet wie POST https://api.resend.com/emails laut Dokumentation: ohne User-Agent 403, ohne/mit falschem Bearer-Token 401,
   Schemafehler 422, Idempotency-Key (1–256 Zeichen): gleiche Anfrage erneut → gleiche Antwort ohne zweite Mail,
   anderer Inhalt → 409 invalid_idempotent_request. Erfolgreich: 200 { id }.
   mode: 'ok' | 'fail' (503) | 'error' (500) | 'ratelimit' (429) | 'quota' (429 Tageskontingent) | 'busy' (409 parallel)
         | 'forbidden' (403 Domain nicht verifiziert) | 'reject' (422) | 'auth' (401)
         | 'drop' (nimmt an, trennt dann die Verbindung) | 'hang' (nimmt an, antwortet nie) */
const RESEND_FIELDS = ['from', 'to', 'subject', 'bcc', 'cc', 'reply_to', 'html', 'text', 'headers', 'attachments', 'tags', 'scheduled_at', 'template'];
const RESEND_ERRORS = {
  fail: [503, 'service_unavailable', 'API is temporarily unavailable'], error: [500, 'application_error', 'An unexpected error occurred.'],
  ratelimit: [429, 'rate_limit_exceeded', 'Too many requests. Please limit the number of requests per second.'],
  quota: [429, 'daily_quota_exceeded', 'You have exceeded your daily email sending quota.'],
  busy: [409, 'concurrent_idempotent_requests', 'There is another request in progress with the same key.'],
  forbidden: [403, 'validation_error', 'The notify.pixelkiez.de domain is not verified.'],
  reject: [422, 'validation_error', 'Invalid `to` field. kontakt@pixelkiez.de'], auth: [401, 'validation_error', 'API key is invalid'],
};
const addresses = v => (typeof v === 'string' ? [v] : Array.isArray(v) ? v : null);
const isAddress = v => typeof v === 'string' && /^(?:[^<>]+ <)?[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}>?$/i.test(v);
function resendSchemaProblem(json) {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return 'body must be an object';
  const unknown = Object.keys(json).filter(k => !RESEND_FIELDS.includes(k));
  if (unknown.length) return `unknown field ${unknown[0]}`;
  if (!isAddress(json.from)) return 'from';
  const to = addresses(json.to);
  if (!to || to.length < 1 || to.length > 50 || !to.every(isAddress)) return 'to';
  if (typeof json.subject !== 'string' || !json.subject) return 'subject';
  if (typeof json.text !== 'string' && typeof json.html !== 'string') return 'text or html';
  if (json.reply_to !== undefined && !(addresses(json.reply_to) ?? []).every(isAddress)) return 'reply_to';
  return null;
}

export function mockResend() {
  const state = { mode: 'ok', accepted: [], attempts: 0, requests: [], keys: new Map() };
  const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const error = (res, statusCode, name, message) => json(res, statusCode, { statusCode, name, message });
  const server = http.createServer(async (req, res) => {
    const raw = (await readBody(req)).toString('utf8');
    const url = new URL(req.url, 'http://mock');
    if (url.pathname !== '/emails') return error(res, 404, 'not_found', 'The requested endpoint does not exist.');
    if (req.method !== 'POST') return error(res, 405, 'method_not_allowed', 'Method is not allowed for the requested path.');
    state.attempts++;
    state.requests.push({ headers: req.headers, raw });
    if (!req.headers['user-agent']) { res.writeHead(403, { 'content-type': 'text/plain' }); return res.end('error code: 1010'); }
    if (!req.headers.authorization) return error(res, 401, 'missing_api_key', 'Missing API key in the authorization header.');
    if (req.headers.authorization !== `Bearer ${MAIL_TOKEN}`) return error(res, 401, 'validation_error', 'API key is invalid');
    if (RESEND_ERRORS[state.mode]) return error(res, ...RESEND_ERRORS[state.mode]);
    if (!/^application\/json/.test(req.headers['content-type'] || '')) return error(res, 422, 'validation_error', 'Content-Type must be application/json');
    let body;
    try { body = JSON.parse(raw); } catch { return error(res, 422, 'validation_error', 'Invalid JSON'); }
    const problem = resendSchemaProblem(body);
    if (problem) return error(res, 422, 'validation_error', `Invalid ${problem}`);
    const key = req.headers['idempotency-key'];
    if (key !== undefined && (key.length < 1 || key.length > 256)) return error(res, 400, 'invalid_idempotency_key', 'Idempotency keys, if present, must have between 1 and 256 characters.');
    const seen = key && state.keys.get(key);
    if (seen && seen.raw !== raw) return error(res, 409, 'invalid_idempotent_request', 'This idempotency key has been used on a request that had a different payload.');
    if (seen) return json(res, 200, { id: seen.id });   // gleiche Anfrage: gleiche Antwort, keine zweite Mail
    const id = randomUUID();
    state.accepted.push({ ...body, id, idempotencyKey: key, contentType: req.headers['content-type'], userAgent: req.headers['user-agent'] });
    if (key) state.keys.set(key, { raw, id });
    if (state.mode === 'drop') return req.socket.destroy();
    if (state.mode === 'hang') return;
    json(res, 200, { id });
  });
  return {
    state,
    async start() { this.port = await listen(server); this.origin = `http://127.0.0.1:${this.port}`; this.url = `${this.origin}/emails`; return this; },
    reset() { state.mode = 'ok'; state.accepted.length = 0; state.requests.length = 0; state.attempts = 0; state.keys.clear(); },
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

export const COMPATIBILITY_DATE = /^compatibility_date\s*=\s*"([^"]+)"/m.exec(readFileSync(join(ROOT, 'worker/wrangler.toml'), 'utf8'))[1];
export const MIGRATION = readFileSync(join(ROOT, 'worker/migrations/0001_init.sql'), 'utf8');
/* Alle Migrationen in Reihenfolge, wie `wrangler d1 migrations apply` sie anwendet */
export const MIGRATIONS = readdirSync(join(ROOT, 'worker/migrations')).filter(f => /^\d{4}_.*\.sql$/.test(f)).sort().map(f => readFileSync(join(ROOT, 'worker/migrations', f), 'utf8'));
const statements = sql => sql.replace(/^\s*--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean);

/* Ausgehende Anfragen des Workers abfangen (Miniflare outboundService): https://api.resend.com geht an den Mock-Resend,
   alles andere wird abgewiesen. So lässt sich der Produktionsmodus (fest api.resend.com) ohne echten Versand prüfen. */
export function resendOutbound(mail) {
  return async request => {
    const url = new URL(request.url);
    if (url.origin !== 'https://api.resend.com') return new miniflare.Response('nicht erlaubt', { status: 502 });
    const r = await fetch(mail.origin + url.pathname + url.search, { method: request.method, headers: Object.fromEntries(request.headers), body: request.method === 'POST' ? await request.text() : undefined });
    return new miniflare.Response(await r.text(), { status: r.status, headers: Object.fromEntries(r.headers) });
  };
}

/* base: Basis-URL (BASE_URL); scheme 'https' ergibt https://127.0.0.1:PORT. env: Overrides (undefined entfernt den Schlüssel).
   db: false startet ohne D1-Binding; migrate: false lässt das Schema weg. outbound: siehe resendOutbound. */
export async function startWorker({ google, mail, base, scheme = 'http', authEndpoint, env = {}, db = true, migrate = true, outbound } = {}) {
  base ??= `${scheme}://127.0.0.1:${await freePort()}`;
  const bindings = {
    ENV: 'local', BASE_URL: base,
    GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
    GOOGLE_TOKEN_ENDPOINT: google ? `${google.origin}/token` : undefined, GOOGLE_JWKS_URI: google ? `${google.origin}/certs` : undefined,
    GOOGLE_AUTH_ENDPOINT: authEndpoint,
    SECRET: randomBytes(32).toString('hex'), PRIVACY_VERSION: 'TEST-2026-10-30', TERMS_VERSION,
    MAIL_API_URL: mail?.url, MAIL_API_TOKEN: MAIL_TOKEN, MAIL_FROM, MAIL_NOTIFY_TO: NOTIFY_TO,
    ...env,
  };
  for (const k of Object.keys(bindings)) if (bindings[k] === undefined) delete bindings[k];
  google?.setRedirectUri(`${base}/api/auth/callback`);
  let logs = '';
  const options = {
    modules: true, scriptPath: await bundle(), modulesRoot: bundled.dir, compatibilityDate: COMPATIBILITY_DATE, bindings,
    ...(db ? { d1Databases: { DB: 'pxwa-test-' + randomBytes(6).toString('hex') } } : {}),
    ...(outbound ? { outboundService: outbound } : {}),
    handleRuntimeStdio(stdout, stderr) { stdout.on('data', d => { logs += d; }); stderr.on('data', d => { logs += d; }); },
  };
  const mf = new miniflare.Miniflare(options);
  await mf.ready;
  let d1 = db ? await mf.getD1Database('DB') : null;
  const run = (q, ...params) => d1.prepare(q).bind(...params).run();
  const app = {
    mf, base, authEndpoint: authEndpoint ?? GOOGLE_AUTH,
    logs: () => logs,
    fetch: (url, init) => mf.dispatchFetch(url, init),
    sql: async (q, ...params) => (await d1.prepare(q).bind(...params).all()).results,
    run,
    exec: async q => { for (const s of statements(q)) await run(s); },
    migrate: async () => { for (const m of MIGRATIONS) for (const s of statements(m)) await run(s); },
    /* Neue Konfiguration wie nach einem Deploy (z. B. andere TERMS_VERSION); D1-Daten bleiben erhalten. undefined entfernt den Schlüssel. */
    async reconfigure(env) {
      const next = { ...bindings, ...env };
      for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
      await mf.setOptions({ ...options, bindings: next });
      if (db) d1 = await mf.getD1Database('DB');
    },
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

/* ---------- Cloudflare Pages: Artefakt, kompilierte Function, lokale Pages-Sitzung ---------- */

/* Was `wrangler pages deploy` aus public/ NICHT als Datei hochlädt (Konfiguration verarbeitet Pages gesondert) – wie in Wrangler */
export const PAGES_IGNORED = [/^_worker\.js$/, /^_redirects$/, /^_headers$/, /^_routes\.json$/, /^functions(\/|$)/, /(^|\/)\.DS_Store$/, /(^|\/)node_modules(\/|$)/, /(^|\/)\.git(\/|$)/, /^\.wrangler(\/|$)/];

/* Dateien in public/, die ein Upload von genau diesem Arbeitsstand ausliefern würde (auch ignorierte lokale Dateien; den Commit prüft tests/release.test.mjs) */
export function uploadFiles() {
  const out = [];
  const walk = dir => {
    for (const name of readdirSync(join(ROOT, 'public', dir))) {
      const rel = dir ? `${dir}/${name}` : name;
      if (PAGES_IGNORED.some(re => re.test(rel))) continue;
      if (statSync(join(ROOT, 'public', rel)).isDirectory()) walk(rel); else out.push(rel);
    }
  };
  walk('');
  return out.sort();
}

/* Versionierte bzw. nicht ignorierte Dateien in public/ (das, was ein Commit enthält) */
export const artifactFiles = () => execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'public'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').filter(f => f && existsSync(join(ROOT, f)) && !f.endsWith('.DS_Store')).map(f => f.slice('public/'.length)).sort();

/* functions/ mit Wrangler kompilieren (wie beim Pages-Deploy); liefert Skript und die von Wrangler erzeugten Routen */
let compiled = null;
export function buildPagesFunctions() {
  if (!compiled) {
    const dir = mkdtempSync(join(tmpdir(), 'pxwa-functions-'));
    const routes = join(dir, 'routes.json');
    const r = spawnSync(WRANGLER, ['pages', 'functions', 'build', '--outdir', join(dir, 'out'), '--output-routes-path', routes, '--compatibility-date', COMPATIBILITY_DATE],
      { cwd: ROOT, env: wranglerEnv(), encoding: 'utf8' });
    if (r.status !== 0) throw new Error('wrangler pages functions build: ' + r.stdout + r.stderr);
    compiled = { dir: join(dir, 'out'), script: join(dir, 'out', 'index.js'), routes: JSON.parse(readFileSync(routes, 'utf8')) };
    process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
  }
  return compiled;
}

/* Antwort für Ersatz-Bindings in Node (Miniflare erwartet seine eigene Response-Klasse) */
export const MfResponse = miniflare?.Response;

/* Kompilierte Pages Function in workerd. api: Skript eines Workers hinter dem Service Binding API; null = kein Binding (Vorschau).
   assets: Ersatz für das Pages-Binding ASSETS (Node-Funktion Request → MfResponse); Standard: immer „statische Datei“ */
export async function startPagesFunction({ api = null, assets } = {}) {
  const fn = buildPagesFunctions();
  const workers = [{
    name: 'pages', modules: true, scriptPath: fn.script, modulesRoot: fn.dir, compatibilityDate: COMPATIBILITY_DATE,
    serviceBindings: { ...(api ? { API: 'pxwa-api' } : {}), ASSETS: assets ?? (() => new MfResponse('statische Datei', { status: 200 })) },
  }];
  if (api) workers.push({ name: 'pxwa-api', modules: true, script: api, compatibilityDate: COMPATIBILITY_DATE });
  const mf = new miniflare.Miniflare({ workers });
  await mf.ready;
  return { fetch: (url, init) => mf.dispatchFetch(url, init), stop: () => mf.dispose() };
}

/* Lokales Cloudflare Pages (`wrangler pages dev` mit wrangler.toml aus dem Root). worker: true startet den API-Worker aus
   worker/wrangler.toml in derselben Sitzung (-c … -c …), erreichbar nur über das Service Binding API. Seine [vars] werden
   durch Testwerte ersetzt (lokaler Modus, Mock-Google, Mock-Resend); D1 ist lokal, mit `wrangler d1 migrations apply --local`.
   worker: false: nur die Website, das Binding ist dann nicht verbunden. */
export async function startPages({ google, mail, worker = true, env = {} } = {}) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const dir = mkdtempSync(join(tmpdir(), 'pxwa-pages-'));
  const state = join(dir, 'state');
  /* Ein einzelnes -c lehnt Wrangler für Pages ab; ohne -c gilt wrangler.toml im Root, mit Worker beide Dateien */
  const args = ['pages', 'dev'];
  const authEndpoint = google ? `${google.origin}/auth` : GOOGLE_AUTH;
  if (worker) {
    const vars = {
      ENV: 'local', BASE_URL: base, GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: CLIENT_SECRET, GOOGLE_AUTH_ENDPOINT: authEndpoint,
      GOOGLE_TOKEN_ENDPOINT: `${google.origin}/token`, GOOGLE_JWKS_URI: `${google.origin}/certs`, SECRET: randomBytes(32).toString('hex'),
      PRIVACY_VERSION: 'TEST-2026-10-31', TERMS_VERSION, MAIL_API_URL: mail.url, MAIL_API_TOKEN: MAIL_TOKEN, MAIL_FROM, MAIL_NOTIFY_TO: NOTIFY_TO, ...env,
    };
    const toml = readFileSync(join(ROOT, 'worker/wrangler.toml'), 'utf8')
      .replace(/^main = .*$/m, `main = ${JSON.stringify(join(ROOT, 'worker/src/index.ts'))}`)
      .replace(/^migrations_dir = .*$/m, `migrations_dir = ${JSON.stringify(join(ROOT, 'worker/migrations'))}`)
      .replace(/^\[vars\][\s\S]*?(?=^\[)/m, '[vars]\n' + Object.entries(vars).filter(([, v]) => v !== undefined).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join('\n') + '\n\n');
    writeFileSync(join(dir, 'worker.toml'), toml);
    const m = spawnSync(WRANGLER, ['d1', 'migrations', 'apply', 'pxwa', '--local', '--persist-to', state, '-c', join(dir, 'worker.toml')], { cwd: ROOT, env: wranglerEnv(), encoding: 'utf8' });
    if (m.status !== 0) throw new Error('wrangler d1 migrations apply: ' + m.stdout + m.stderr);
    args.push('-c', 'wrangler.toml', '-c', join(dir, 'worker.toml'));
    google.setRedirectUri(`${base}/api/auth/callback`);
  }
  args.push('--ip', '127.0.0.1', '--port', String(port), '--inspector-port', String(await freePort()), '--persist-to', state, '--show-interactive-dev-session=false');
  /* Eigene Prozessgruppe (zum vollständigen Beenden) und eigene Dev-Registry (parallele Sitzungen verbinden sich nicht) */
  const proc = spawn(WRANGLER, args, { cwd: ROOT, env: wranglerEnv({ WRANGLER_REGISTRY_PATH: join(dir, 'registry') }), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let logs = '';
  proc.stdout.on('data', d => { logs += d; });
  proc.stderr.on('data', d => { logs += d; });
  await waitFor(async () => {
    if (proc.exitCode !== null) throw new Error('wrangler pages dev beendet: ' + logs);
    try { await fetch(base + '/', { redirect: 'manual', signal: AbortSignal.timeout(2000) }); return true; } catch { return false; }
  }, { timeout: 60000, what: 'wrangler pages dev' });
  const { DatabaseSync } = await import('node:sqlite');
  const d1 = join(state, 'v3/d1/miniflare-D1DatabaseObject');
  const withDb = fn => {
    const file = readdirSync(d1).find(f => f.endsWith('.sqlite') && f !== 'metadata.sqlite');
    const db = new DatabaseSync(join(d1, file));
    try { return fn(db); } finally { db.close(); }
  };
  return {
    base, authEndpoint,
    logs: () => logs,
    fetch: (url, init) => fetch(url, init),
    sql: (q, ...params) => withDb(db => db.prepare(q).all(...params).map(r => ({ ...r }))),
    exec: q => withDb(db => db.exec(q)),
    async stop() {
      try { process.kill(-proc.pid, 'SIGTERM'); } catch { /* bereits beendet */ }
      await new Promise(r => (proc.exitCode !== null || proc.signalCode !== null ? r() : proc.once('exit', r)));
      rmSync(dir, { recursive: true, force: true });
    },
  };
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

/* Formular des Hero: Website, AGB-Häkchen (agb: false lässt es weg) und die angezeigte AGB-Version */
export const startForm = ({ website = 'musterfirma.de', agb = true, agbVersion = TERMS_VERSION, extra = {} } = {}) => ({
  action: 'start', website, ...(agb === true ? { agb: '1' } : agb === false ? {} : { agb }), ...(agbVersion === null ? {} : { agb_version: agbVersion }), ...extra,
});

/* Hero absenden („Analysieren“) und – wenn der Worker zu Google weiterleitet – den Google-Teil bis zum Code nachbilden */
export async function begin(client, google, opts = {}) {
  const start = await client.req('POST', '/api/anfrage', { form: startForm(opts) });
  if (start.status !== 303 || !start.location?.startsWith(client.app.authEndpoint)) return { start };
  const auth = new URL(start.location);
  const p = auth.searchParams;
  const code = google.issueCode({ nonce: p.get('nonce'), challenge: p.get('code_challenge'), redirectUri: p.get('redirect_uri'), claims: opts.claims, mode: opts.mode });
  const callbackPath = `/api/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(opts.state ?? p.get('state'))}&scope=email+openid`;
  return { start, auth, code, callbackPath };
}

/* Kompletter Ablauf: Hero mit AGB → Google → Rückkehr. Die Rückkehr legt bei gültiger Zustimmung den Auftrag an (kein zweiter Klick).
   claims/mode steuern das ID-Token des Mock-Google. */
export async function login(client, google, opts = {}) {
  const flow = await begin(client, google, opts);
  if (!flow.callbackPath) return flow;
  return { ...flow, callback: await client.req('GET', flow.callbackPath) };
}

/* Referenz auf der Eingangsbestätigung */
export const referenceOf = html => (html.match(/id="reference">(PXA-[0-9A-Z]{4}-[0-9A-Z]{4})</) || [])[1];
