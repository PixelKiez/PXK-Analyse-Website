/* Interactive Google test: stdin is the client secret, never an argument, environment variable, file or log. */
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { startWorker, TERMS_VERSION } from './lib/harness.mjs';
import { isolatedOutbound, MAIL_URL } from './lib/oidc-isolation.mjs';

/* Miniflare's debug option serializes the complete workerd configuration, including bindings, to disk. */
if (['MINIFLARE_WORKERD_CONFIG_DEBUG', 'NODE_DEBUG', 'NODE_OPTIONS', 'DEBUG'].some(key => process.env[key])) {
  console.error('Refusing to start with process or workerd debugging enabled');
  process.exit(1);
}
const clientSecret = readFileSync(0, 'utf8').trim();
if (!clientSecret) throw new Error('No client secret supplied on stdin');

const base = 'http://localhost:8787';
const boundary = isolatedOutbound();
let app;
try {
  app = await startWorker({
  base,
  outbound: boundary.handler,
  env: {
    ENV: 'local', BASE_URL: base,
    GOOGLE_CLIENT_ID: '992953187599-gabq9k5shdu02qd0r4ldqa3dh7ib0c1o.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: clientSecret,
    GOOGLE_AUTH_ENDPOINT: 'https://accounts.google.com/o/oauth2/v2/auth',
    GOOGLE_TOKEN_ENDPOINT: 'https://oauth2.googleapis.com/token',
    GOOGLE_JWKS_URI: 'https://www.googleapis.com/oauth2/v3/certs',
    SECRET: randomBytes(32).toString('hex'),
    PRIVACY_VERSION: 'LOCAL-TEST', TERMS_VERSION,
    MAIL_API_URL: MAIL_URL, MAIL_API_TOKEN: 'local-mock',
    MAIL_FROM: 'test@example.com', MAIL_NOTIFY_TO: 'test@example.com',
  },
  });
} catch {
  console.error('Local test worker could not start');
  process.exit(1);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.headers.host !== 'localhost:8787') { res.writeHead(403).end(); return; }
    const path = new URL(req.url, base).pathname;
    if (path === '/__test/status' && req.method === 'GET') {
      const orders = (await app.sql('SELECT COUNT(*) AS n FROM orders'))[0].n;
      const outbox = (await app.sql('SELECT COUNT(*) AS n FROM notifications'))[0].n;
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ localOrders: orders, localNotifications: outbox, mockedMail: boundary.counts.mail, blockedOutbound: boundary.counts.blocked }));
      return;
    }
    if (!['/api/anfrage', '/api/auth/callback'].includes(path) || !['GET', 'POST'].includes(req.method)) {
      res.writeHead(404).end(); return;
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 65536) { res.writeHead(413).end(); return; }
      chunks.push(chunk);
    }
    const response = await app.fetch(new URL(req.url, base).href, {
      method: req.method, headers: req.headers, redirect: 'manual',
      ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}),
    });
    for (const [name, value] of response.headers) if (name !== 'set-cookie') res.setHeader(name, value);
    const cookies = response.headers.getSetCookie();
    if (cookies.length) res.setHeader('set-cookie', cookies);
    res.writeHead(response.status);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

server.on('error', async () => { console.error('Local test server could not start'); await app.stop(); process.exitCode = 1; });
server.listen(8787, '127.0.0.1', () => console.log('Isolated test ready at http://localhost:8787/api/anfrage; only local D1 and mock mail.'));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(async () => { await app.stop(); process.exit(0); }));
