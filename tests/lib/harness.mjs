/* Lokale Test-Umgebung für die PXWA-Serverkomponente – nur Mocks, keine echten Provider.
   - php -S mit eigener Test-Konfiguration (SQLite, Sessions und Schlüssel-Cache in einem Temp-Verzeichnis)
   - Mock-Google: Token-Endpunkt (prüft client_secret, redirect_uri, PKCE, Einmal-Code) und JWKS mit Testschlüssel
   - Mock-SMTP: zählt angenommene Nachrichten, kann temporäre Fehler (451) liefern
   Die Google-Autorisierungsseite selbst wird nicht nachgebaut: Tests lesen state/nonce/code_challenge aus der
   Weiterleitungs-URL und rufen den Callback so auf, wie Google es nach erfolgreicher Anmeldung täte. */
import http from 'node:http';
import net from 'node:net';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { generateKeyPairSync, createHash, sign, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CLIENT_ID = 'pxwa-test-client.apps.googleusercontent.com';
export const CLIENT_SECRET = 'test-only-secret';
export const NOTIFY_TO = 'kontakt@pixelkiez.de';
export const CUSTOMER = 'kunde@beispiel-kunde.de';

export const phpAvailable = spawnSync('php', ['-v']).status === 0;
export const sqliteAvailable = spawnSync('sqlite3', ['-version']).status === 0;

const b64url = b => Buffer.from(b).toString('base64url');
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const listen = (server) => new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)));

/* ---------- Mock-Google ---------- */

export function mockGoogle() {
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const rogue = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...key.publicKey.export({ format: 'jwk' }), kid: 'test-key-1', alg: 'RS256', use: 'sig' };
  const codes = new Map();
  const log = { token: [], certs: 0 };
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

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://mock');
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
  });

  return {
    log, codes,
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

/* ---------- Mock-SMTP ---------- */

export function mockSmtp() {
  const state = { mode: 'ok', accepted: [], attempts: 0, sessions: [] };
  const server = net.createServer(sock => {
    const s = { auth: [], from: '', rcpt: [], data: '' };
    state.sessions.push(s);
    let buf = '', inData = false, authStep = 0;
    const out = l => sock.write(l + '\r\n');
    out('220 mock.smtp ESMTP');
    sock.on('data', chunk => {
      buf += chunk.toString('utf8');
      while (true) {
        if (inData) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) return;
          s.data = buf.slice(0, end);
          buf = buf.slice(end + 5);
          inData = false;
          state.attempts++;
          if (state.mode === 'fail') out('451 4.3.0 Temporary failure, try again later');
          else { state.accepted.push({ from: s.from, rcpt: [...s.rcpt], data: s.data, auth: [...s.auth] }); out('250 2.0.0 queued'); }
          continue;
        }
        const nl = buf.indexOf('\r\n');
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        if (authStep) { s.auth.push(Buffer.from(line, 'base64').toString()); authStep = authStep === 1 ? (out('334 UGFzc3dvcmQ6'), 2) : (out('235 2.7.0 ok'), 0); continue; }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') out('250-mock.smtp\r\n250 AUTH LOGIN');
        else if (line.toUpperCase() === 'AUTH LOGIN') { authStep = 1; out('334 VXNlcm5hbWU6'); }
        else if (cmd === 'MAIL') { s.from = line.slice(10).replace(/[<>]/g, ''); out('250 ok'); }
        else if (cmd === 'RCPT') { s.rcpt.push(line.slice(8).replace(/[<>]/g, '')); out('250 ok'); }
        else if (cmd === 'DATA') { inData = true; out('354 go ahead'); }
        else if (cmd === 'QUIT') { out('221 bye'); sock.end(); }
        else out('502 unknown');
      }
    });
    sock.on('error', () => {});
  });
  return {
    state,
    async start() { this.port = await listen(server); return this; },
    stop: () => new Promise(r => server.close(r)),
  };
}

/* ---------- PHP-Server mit Test-Konfiguration ---------- */

export async function startApp({ google, smtp, authEndpoint }) {
  const dir = mkdtempSync(join(tmpdir(), 'pxwa-test-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const db = join(dir, 'pxwa.sqlite');
  const config = join(dir, 'config.php');
  const sessions = join(dir, 'sessions');
  execFileSync('mkdir', ['-p', sessions]);
  const php = v => JSON.stringify(v).replace(/\$/g, '\\$');
  writeFileSync(config, `<?php return [
  'env' => 'local',
  'base_url' => ${php(base)},
  'google' => ['client_id' => ${php(CLIENT_ID)}, 'client_secret' => ${php(CLIENT_SECRET)}, 'token_endpoint' => ${php(google.origin + '/token')}, 'jwks_uri' => ${php(google.origin + '/certs')}${authEndpoint ? `, 'auth_endpoint' => ${php(authEndpoint)}` : ''}],
  'db' => ['dsn' => ${php('sqlite:' + db)}],
  'mail' => ['host' => '127.0.0.1', 'port' => ${smtp.port}, 'encryption' => 'none', 'username' => 'pxwa-test', 'password' => 'test-only', 'from' => 'analyse@pixelkiez.de', 'notify_to' => ${php(NOTIFY_TO)}, 'timeout' => 5],
  'data_dir' => ${php(dir)},
  'session_dir' => ${php(sessions)},
  'secret' => ${php(randomBytes(32).toString('hex'))},
  'privacy' => ['url' => 'https://pixelkiez.de/datenschutz.html', 'version' => 'TEST-2026-10-30'],
];\n`);
  google.setRedirectUri(`${base}/auth/callback.php`);
  const env = { ...process.env, PXWA_CONFIG: config };
  const migrate = spawnSync('php', [join(ROOT, 'bin/migrate.php')], { env, encoding: 'utf8' });
  if (migrate.status !== 0) throw new Error('Migration fehlgeschlagen: ' + migrate.stderr);
  const proc = spawn('php', ['-S', `127.0.0.1:${port}`, '-t', join(ROOT, 'public')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  proc.stdout.on('data', d => { logs += d; });
  proc.stderr.on('data', d => { logs += d; });
  for (let i = 0; i < 50; i++) {
    try { await fetch(base + '/index.html'); break; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  return {
    base, db, dir, sessions, env,
    logs: () => logs,
    sql: q => JSON.parse(execFileSync('sqlite3', ['-json', db, q], { encoding: 'utf8' }) || '[]'),
    exec: q => execFileSync('sqlite3', [db, q], { encoding: 'utf8' }),
    migrate: () => spawnSync('php', [join(ROOT, 'bin/migrate.php')], { env, encoding: 'utf8' }),
    /* asynchron: der Mock-SMTP läuft im selben Node-Prozess und muss währenddessen antworten können */
    cron: () => new Promise(resolve => {
      const p = spawn('php', [join(ROOT, 'bin/send-notifications.php')], { env });
      let stdout = '', stderr = '';
      p.stdout.on('data', d => { stdout += d; });
      p.stderr.on('data', d => { stderr += d; });
      p.on('close', status => resolve({ status, stdout, stderr }));
    }),
    async stop() { proc.kill(); await new Promise(r => proc.once('exit', r)); rmSync(dir, { recursive: true, force: true }); },
  };
}

/* ---------- HTTP-Client mit Cookie-Speicher (wie ein Browser, ohne JavaScript) ---------- */

export class Client {
  constructor(base) { this.base = base; this.cookies = new Map(); this.setCookies = []; }
  async req(method, path, { form, headers = {} } = {}) {
    const h = { ...headers };
    if (this.cookies.size) h.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    let body;
    if (form) {
      body = new URLSearchParams(form).toString();
      h['content-type'] = 'application/x-www-form-urlencoded';
      if (!('origin' in h)) h.origin = this.base;
      if (h.origin === null) delete h.origin;
    }
    const res = await fetch(new URL(path, this.base), { method, headers: h, body, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      this.setCookies.push(c);
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const k = pair.slice(0, i), v = pair.slice(i + 1);
      if (v === '' || v === 'deleted' || /expires=Thu, 01[- ]Jan[- ]1970/i.test(c)) this.cookies.delete(k); else this.cookies.set(k, v);
    }
    return { status: res.status, location: res.headers.get('location'), headers: res.headers, text: await res.text() };
  }
}

export const field = (html, name) => (html.match(new RegExp(`name="${name}" value="([^"]*)"`)) || [])[1];

/* Kompletter Ablauf bis zur Rückkehr von Google. claims/mode steuern das ID-Token des Mock-Google. */
export async function login(client, google, { website = 'musterfirma.de', claims, mode, state } = {}) {
  const start = await client.req('POST', '/anfrage.php', { form: { action: 'start', website } });
  if (start.status !== 303 || !start.location?.startsWith('https://accounts.google.com/')) return { start };
  const auth = new URL(start.location);
  const p = auth.searchParams;
  const code = google.issueCode({ nonce: p.get('nonce'), challenge: p.get('code_challenge'), redirectUri: p.get('redirect_uri'), claims, mode });
  const callbackPath = `/auth/callback.php?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state ?? p.get('state'))}&scope=email+openid`;
  const callback = await client.req('GET', callbackPath);
  return { start, auth, callback, callbackPath };
}

export async function confirm(client, { consent = true, csrf, idem } = {}) {
  const page = await client.req('GET', '/anfrage.php');
  const form = { action: 'confirm', csrf: csrf ?? field(page.text, 'csrf') ?? '', idem: idem ?? field(page.text, 'idem') ?? '' };
  if (consent) form.zustimmung = '1';
  return { page, form, res: await client.req('POST', '/anfrage.php', { form }) };
}

export const decodeMail = data => {
  const [head, body] = data.split('\r\n\r\n');
  return { head, text: Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8') };
};
