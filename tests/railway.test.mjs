/* PXWA – Railway-Frontend: echter Caddy mit deploy/railway/Caddyfile über genau den Dateien des Artefakts
   (public/ ohne Medien, wie .dockerignore). Optional zusätzlich der Docker-Build: PXK_DOCKER=1.
   Ausführen im Repo-Root: node --test tests/railway.test.mjs   (benötigt caddy; ohne caddy: NOT_RUN) */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { caddyAvailable, siteRoot, startCaddy, artifactFiles, waitFor, freePort, ROOT } from './lib/harness.mjs';

const skip = caddyAvailable ? false : 'NOT_RUN: caddy nicht verfügbar';
let root, caddy;
before(async () => { if (skip) return; root = siteRoot(); caddy = await startCaddy(root); });
after(async () => { if (skip) return; await caddy.stop(); rmSync(root, { recursive: true, force: true }); });

const HEADERS = {
  'strict-transport-security': 'max-age=31536000', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY',
  'content-security-policy': "frame-ancestors 'none'", 'referrer-policy': 'strict-origin-when-cross-origin', 'cross-origin-opener-policy': 'same-origin',
};

test('Statische Seiten: alle Artefakt-Dateien mit 200 und Sicherheits-Headern, ohne Server-Kennung', { skip }, async () => {
  for (const f of ['', ...artifactFiles()]) {
    const r = await fetch(`${caddy.url}/${f}`);
    assert.equal(r.status, 200, f || '/');
    for (const [k, v] of Object.entries(HEADERS)) assert.equal(r.headers.get(k), v, `${f}: ${k}`);
    assert.match(r.headers.get('permissions-policy'), /camera=\(\)/);
    assert.equal(r.headers.get('server'), null, 'keine Server-Kennung');
  }
  assert.match(await (await fetch(`${caddy.url}/`)).text(), /<form class="analyze" id="analyze" action="\/api\/anfrage"/);
  assert.match((await fetch(`${caddy.url}/index.html`)).headers.get('content-type'), /^text\/html/);
});

test('Nicht ausgelieferte Dateien: Quellen, Konfiguration, Tests, Git und Medien antworten mit 404; kein Verzeichnis-Listing', { skip }, async () => {
  for (const p of ['/vision.html', '/DESIGN.md', '/STRUCTURE.md', '/package.json', '/railway.json', '/.dockerignore', '/.gitignore', '/.git/HEAD',
    '/worker/wrangler.toml', '/worker/src/index.ts', '/worker/migrations/0001_init.sql', '/deploy/railway/Caddyfile', '/tests/worker.test.mjs',
    '/anfrage.php', '/auth/callback.php', '/server/config.php', '/media/360-pixelkiez-video-1080p.mp4']) {
    const r = await fetch(caddy.url + p, { redirect: 'manual' });
    assert.equal(r.status, 404, p);
  }
  const dir = await fetch(`${caddy.url}/assets/`);
  assert.equal(dir.status, 404, 'kein Verzeichnis-Listing');
});

test('/api/* ohne aktive Worker-Route: 503 statt Annahme, nie gespeichert oder weitergeleitet', { skip }, async () => {
  for (const [method, path] of [['GET', '/api/anfrage'], ['POST', '/api/anfrage'], ['GET', '/api/auth/callback?code=x&state=y']]) {
    const r = await fetch(caddy.url + path, { method, redirect: 'manual', body: method === 'POST' ? 'action=start&website=musterfirma.de' : undefined, headers: method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {} });
    assert.equal(r.status, 503, `${method} ${path}`);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.headers.get('location'), null);
    assert.match(await r.text(), /Anfragen sind im Moment nicht möglich/);
  }
});

test('Docker-Build des Railway-Artefakts (PXK_DOCKER=1): Image enthält genau die Artefakt-Dateien und läuft als nobody', { skip: skip || (process.env.PXK_DOCKER !== '1' && 'NOT_RUN: PXK_DOCKER=1 nicht gesetzt') }, async () => {
  const tag = 'pxwa-frontend-test:local';
  const build = spawnSync('docker', ['build', '-q', '-f', 'deploy/railway/Dockerfile', '-t', tag, '.'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr);
  const ls = spawnSync('docker', ['run', '--rm', '--entrypoint', 'sh', tag, '-c', 'cd /srv && find . -type f | sed "s|^./||" | sort && id -un'], { encoding: 'utf8' });
  assert.equal(ls.status, 0, ls.stderr);
  assert.deepEqual(ls.stdout.trim().split('\n'), [...artifactFiles(), 'nobody']);
  const port = await freePort();
  const run = spawnSync('docker', ['run', '-d', '--rm', '-e', 'PORT=8080', '-p', `127.0.0.1:${port}:8080`, tag], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const id = run.stdout.trim();
  try {
    await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${port}/index.html`)).ok; } catch { return false; } }, { timeout: 15000, what: 'Container-Start' });
    const r = await fetch(`http://127.0.0.1:${port}/api/anfrage`);
    assert.equal(r.status, 503);
    assert.equal((await fetch(`http://127.0.0.1:${port}/index.html`)).headers.get('x-frame-options'), 'DENY');
  } finally {
    spawnSync('docker', ['rm', '-f', id]);
  }
});
