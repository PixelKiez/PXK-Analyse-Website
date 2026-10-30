/* PXWA – Integrationstests des API-Workers in workerd (Miniflare) mit lokaler D1 und lokalen Mocks.
   Ausführen im Repo-Root nach `npm ci`:  node --test tests/worker.test.mjs
   Echte Provider (Google, Mail-API, Cloudflare-D1) werden hier NICHT getestet. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mockGoogle, mockMailApi, startWorker, Client, login, confirm, field, waitFor, sleep, workerAvailable, CLIENT_ID, CUSTOMER, NOTIFY_TO, MAIL_FROM, MAIL_TOKEN } from './lib/harness.mjs';

const skip = workerAvailable ? false : 'NOT_RUN: miniflare/esbuild fehlen (npm ci)';
let google, mail, app;

before(async () => {
  if (skip) return;
  google = await mockGoogle().start();
  mail = await mockMailApi().start();
  app = await startWorker({ google, mail });
});
after(async () => {
  if (skip) return;
  await app.stop(); await google.stop(); await mail.stop();
});

const orders = () => app.sql('SELECT * FROM orders ORDER BY id');
const reset = async () => { await app.exec('DELETE FROM notifications; DELETE FROM orders; DELETE FROM rate_limits; DELETE FROM sessions'); mail.reset(); };
const isConfirmPage = html => /Anfrage bestätigen\./.test(html) && /name="idem"/.test(html);
/* Die erste Zustellung läuft nach der Antwort (waitUntil): warten, bis die Benachrichtigung nicht mehr unbearbeitet ist */
const settled = () => waitFor(async () => (await app.sql("SELECT COUNT(*) AS n FROM notifications WHERE status = 'sending' OR (status = 'pending' AND attempts = 0)"))[0].n === 0, { what: 'Zustellung' });

/* ---------- Google-Login ---------- */

test('Google-Login gültig: minimale Rechte, PKCE, Session-Wechsel, Bestätigungsseite mit bestätigter E-Mail', { skip }, async () => {
  await reset();
  const c = new Client(app);
  const first = await c.req('GET', '/api/anfrage');
  assert.equal(first.status, 200);
  assert.equal(c.cookies.size, 0, 'GET ohne Anfrage legt keine Session an');
  const { start, auth, callback } = await login(c, google, { website: 'HTTPS://WWW.Musterfirma.DE/leistungen?utm_source=x#top' });
  assert.equal(start.status, 303);
  const sid0 = start.headers.getSetCookie()[0].split(';')[0];
  const p = auth.searchParams;
  assert.equal(auth.origin + auth.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(p.get('scope'), 'openid email', 'nur openid email – keine Gmail-Rechte');
  assert.ok(![...p.values()].some(v => /gmail|mail\.google|https:\/\/www\.googleapis\.com\/auth/.test(v)), 'keine weiteren Scopes');
  assert.equal(p.get('response_type'), 'code');
  assert.equal(p.get('client_id'), CLIENT_ID);
  assert.equal(p.get('redirect_uri'), `${app.base}/api/auth/callback`);
  assert.equal(p.get('code_challenge_method'), 'S256');
  assert.ok(p.get('state').length >= 32 && p.get('nonce').length >= 32 && p.get('code_challenge').length >= 43);
  assert.equal(callback.status, 303);
  assert.equal(callback.location, `${app.base}/api/anfrage`);
  assert.notEqual(callback.headers.getSetCookie()[0].split(';')[0], sid0, 'Session-ID wird nach dem Login gewechselt');
  assert.ok(c.setCookies.every(s => /HttpOnly/i.test(s) && /SameSite=Lax/i.test(s) && /Max-Age=3600/i.test(s)), 'Cookies HttpOnly, SameSite=Lax, kurzlebig');
  const tokenCall = google.log.token.at(-1);
  assert.ok(tokenCall.code_verifier && tokenCall.client_secret, 'Code-Austausch mit PKCE-Verifier serverseitig');
  const page = await c.req('GET', '/api/anfrage');
  assert.ok(isConfirmPage(page.text));
  assert.match(page.text, new RegExp(CUSTOMER.replace('.', '\\.')));
  assert.match(page.text, /https:\/\/www\.musterfirma\.de\/leistungen</, 'URL normalisiert, Query und Fragment verworfen');
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'.*frame-ancestors 'none'/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal((await app.sql('SELECT COUNT(*) AS n FROM sessions'))[0].n, 1, 'alte Session gelöscht');
});

for (const [name, opts, reason] of [
  ['manipuliert (Payload nach Signatur geändert)', { mode: 'tamper' }, 'signature'],
  ['manipuliert (fremder Schlüssel)', { mode: 'rogue' }, 'signature'],
  ['abgelaufen', { claims: { exp: Math.floor(Date.now() / 1000) - 3600, iat: Math.floor(Date.now() / 1000) - 7200 } }, 'expired'],
  ['falsche Audience', { claims: { aud: 'andere-app.apps.googleusercontent.com', azp: 'andere-app.apps.googleusercontent.com' } }, 'audience'],
  ['falscher Issuer', { claims: { iss: 'https://evil.example' } }, 'issuer'],
  ['E-Mail nicht bestätigt', { claims: { email_verified: false } }, 'email_unverified'],
  ['falsche nonce', { claims: { nonce: 'replayed-nonce-from-another-login' } }, 'nonce'],
  ['alg none', { mode: 'alg-none' }, 'format'],
  ['alg HS256', { mode: 'hs256' }, 'alg'],
]) {
  test(`Google-Login abgelehnt: ${name}`, { skip }, async () => {
    await reset();
    const c = new Client(app);
    const before = app.logs().length;
    const { callback } = await login(c, google, opts);
    assert.equal(callback.status, 401, callback.text.slice(0, 200));
    assert.match(callback.text, /Anmeldung nicht bestätigt/);
    await waitFor(() => app.logs().slice(before).includes(`Google-Anmeldung abgelehnt: ${reason}`), { what: `Log ${reason}` });
    const page = await c.req('GET', '/api/anfrage');
    assert.ok(!isConfirmPage(page.text), 'keine Identität in der Session');
    const r = await c.req('POST', '/api/anfrage', { form: { action: 'confirm', csrf: field(page.text, 'csrf') ?? '', idem: 'x', zustimmung: '1' } });
    assert.equal(r.status, 403);
    assert.equal((await orders()).length, 0);
    assert.equal(mail.state.attempts, 0);
  });
}

test('Token-Replay: Callback mit gleichem state/code ist nur einmal gültig; falscher state wird abgelehnt', { skip }, async () => {
  await reset();
  const c = new Client(app);
  const { callback, callbackPath } = await login(c, google);
  assert.equal(callback.status, 303);
  assert.equal((await c.req('GET', callbackPath)).status, 400, 'state verbraucht');
  assert.equal((await new Client(app).req('GET', callbackPath)).status, 400, 'fremde Session ohne passenden state');
  const c2 = new Client(app);
  const wrong = await login(c2, google, { state: 'a'.repeat(64) });
  assert.equal(wrong.callback.status, 400);
  assert.ok(!isConfirmPage((await c2.req('GET', '/api/anfrage')).text));
  /* Parallele Rückkehr mit demselben state: nur ein Aufruf darf ihn einlösen */
  const c3 = new Client(app);
  const start = await c3.req('POST', '/api/anfrage', { form: { action: 'start', website: 'musterfirma.de' } });
  const p = new URL(start.location).searchParams;
  const codes = [0, 1].map(() => google.issueCode({ nonce: p.get('nonce'), challenge: p.get('code_challenge'), redirectUri: p.get('redirect_uri') }));
  const results = await Promise.all(codes.map(code => c3.req('GET', `/api/auth/callback?code=${encodeURIComponent(code)}&state=${p.get('state')}`)));
  assert.deepEqual(results.map(r => r.status).sort(), [303, 400]);
});

/* ---------- Website-URL ---------- */

test('Ungültige Website-URL: 422, kein Weiterleiten zu Google, Eingabe escaped', { skip }, async () => {
  await reset();
  const bad = ['', '   ', 'keine adresse', 'javascript:alert(1)', 'http://localhost', 'http://127.0.0.1', 'https://[::1]/', 'http://10.0.0.1/admin',
    'https://user:pass@musterfirma.de', 'musterfirma', 'ftp://musterfirma.de', 'https://musterfirma.de:8080', 'musterfirma.de:8080', 'intranet.local', 'firma.internal',
    'https://example.com', 'a'.repeat(2050) + '.de', '<script>alert(1)</script>.de', 'musterfirma.de/"onmouseover="x', 'https://musterfirma.de\\@evil.de', 'http://127.1', 'https://１２７.0.0.1'];
  for (const [i, website] of bad.entries()) {
    const r = await new Client(app, { ip: `198.51.100.${100 + i}` }).req('POST', '/api/anfrage', { form: { action: 'start', website } });
    assert.equal(r.status, 422, `"${website.slice(0, 40)}" → ${r.status}`);
    assert.equal(r.location, null);
    assert.ok(!r.text.includes('<script>alert(1)'), 'kein ungefiltertes Echo');
    assert.match(r.text, /öffentliche Website-Adresse/);
  }
  assert.equal((await orders()).length, 0);
  assert.equal((await app.sql('SELECT COUNT(*) AS n FROM sessions'))[0].n, 0, 'ungültige Eingaben legen keine Session an');
  const idn = new Client(app);
  await login(idn, google, { website: 'müller-bäckerei.de/über-uns' });
  const page = await idn.req('GET', '/api/anfrage');
  assert.match(page.text, /https:\/\/müller-bäckerei\.de\/über-uns</, 'Umlaut-Domain wird akzeptiert und lesbar angezeigt');
  assert.match(JSON.stringify(await app.sql('SELECT data FROM sessions')), /https:\/\/xn--mller-bckerei-/, 'gespeichert in ASCII-Form');
});

/* ---------- Anfrage ohne Login ---------- */

test('Anfrage ohne Login wird abgelehnt (ohne Sitzung, ohne abgeschlossene Google-Anmeldung, nach Ablauf der Anmeldung); Cross-Site-POST wird abgelehnt', { skip }, async () => {
  await reset();
  assert.equal((await new Client(app).req('POST', '/api/anfrage', { form: { action: 'confirm', idem: 'abc', zustimmung: '1' } })).status, 403, 'ohne Session');
  const started = new Client(app);
  assert.equal((await started.req('POST', '/api/anfrage', { form: { action: 'start', website: 'musterfirma.de' } })).status, 303, 'URL gemerkt, Weiterleitung zu Google');
  assert.match((await started.req('GET', '/api/anfrage')).text, /Bitte melden Sie sich mit Google an/);
  const [{ csrf }] = await app.sql("SELECT json_extract(data, '$.csrf') AS csrf FROM sessions");
  const half = await started.req('POST', '/api/anfrage', { form: { action: 'confirm', csrf, idem: 'abc', zustimmung: '1' } });
  assert.equal(half.status, 403, 'Google-Anmeldung nicht abgeschlossen');
  assert.match(half.text, /zuerst mit Google an/);
  /* Gültige Session mit CSRF-Token und Formular, aber Anmeldung abgelaufen (Zeitstempel in D1 zurückdatiert) */
  const expired = new Client(app);
  await login(expired, google);
  const page = await expired.req('GET', '/api/anfrage');
  await app.run("UPDATE sessions SET data = json_set(data, '$.identity.at', 1000000000) WHERE json_extract(data, '$.identity') IS NOT NULL");
  const late = await expired.req('POST', '/api/anfrage', { form: { action: 'confirm', csrf: field(page.text, 'csrf'), idem: field(page.text, 'idem'), zustimmung: '1' } });
  assert.equal(late.status, 403);
  assert.match(late.text, /zuerst mit Google an/);
  const logged = new Client(app);
  await login(logged, google);
  /* Origin-Prüfung als eigene Schicht: selbst mit gültigem Token und Formular wird ein Cross-Site-POST abgelehnt */
  const form = await logged.req('GET', '/api/anfrage');
  const crossSite = await logged.req('POST', '/api/anfrage', { form: { action: 'confirm', csrf: field(form.text, 'csrf'), idem: field(form.text, 'idem'), zustimmung: '1' }, headers: { origin: 'https://evil.example' } });
  assert.equal(crossSite.status, 403);
  assert.match(crossSite.text, /direkt auf dieser Website/);
  assert.equal((await new Client(app).req('POST', '/api/anfrage', { form: { action: 'start', website: 'musterfirma.de' }, headers: { origin: 'null' } })).status, 403, 'Origin "null"');
  assert.equal((await new Client(app).req('POST', '/api/anfrage', { form: { action: 'start', website: 'musterfirma.de' }, headers: { origin: null, 'sec-fetch-site': 'cross-site' } })).status, 403, 'Sec-Fetch-Site: cross-site');
  assert.equal((await confirm(logged, { csrf: 'falsch' })).res.status, 403);
  assert.equal((await confirm(logged, { consent: false })).res.status, 422);
  assert.equal((await orders()).length, 0);
  assert.equal(mail.state.attempts, 0);
});

/* ---------- Erfolgreiche Annahme ---------- */

test('Erfolgreiche Annahme: genau ein Auftrag, genau eine interne Benachrichtigung über die Mail-API, keine Tokens gespeichert, kein PDF', { skip }, async () => {
  await reset();
  const c = new Client(app);
  await login(c, google, { website: 'https://www.musterfirma.de' });
  const { res } = await confirm(c);
  assert.equal(res.status, 303);
  const done = await c.req('GET', '/api/anfrage');
  const ref = (done.text.match(/id="reference">(PXA-[0-9A-Z]{4}-[0-9A-Z]{4})</) || [])[1];
  assert.ok(ref, 'Referenz wird angezeigt');
  assert.match(done.text, /Ihre Anfrage liegt bei uns/);
  const rows = await orders();
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['created_at', 'email', 'google_sub', 'id', 'idempotency_key', 'privacy_version', 'reference', 'status', 'website_url']);
  assert.deepEqual([rows[0].reference, rows[0].email, rows[0].website_url, rows[0].privacy_version], [ref, CUSTOMER, 'https://www.musterfirma.de', 'TEST-2026-10-30']);
  await settled();
  assert.equal(mail.state.accepted.length, 1, 'genau eine Mail');
  const m = mail.state.accepted[0];
  assert.deepEqual(m.to, [NOTIFY_TO], 'nur an Pixelkiez, nie an die Kundin/den Kunden');
  assert.equal(m.from, MAIL_FROM);
  assert.equal(m.reply_to, CUSTOMER);
  assert.equal(m.subject, `Neue Analyse-Anfrage ${ref}`);
  assert.equal(m.idempotencyKey, `pxwa-${ref}`);
  assert.match(m.contentType, /^application\/json/);
  assert.equal(mail.state.requests[0].headers.authorization, `Bearer ${MAIL_TOKEN}`, 'Token aus der Worker-Konfiguration');
  assert.deepEqual(Object.keys(m).filter(k => !['idempotencyKey', 'contentType'].includes(k)).sort(), ['from', 'reply_to', 'subject', 'text', 'to'], 'kein Anhang, kein HTML');
  assert.ok(m.text.includes(ref) && m.text.includes('https://www.musterfirma.de') && m.text.includes(CUSTOMER));
  assert.deepEqual(await app.sql('SELECT status, attempts FROM notifications'), [{ status: 'sent', attempts: 1 }]);
  /* Keine Tokens in Datenbank (inkl. Sessions) oder Log; Log ohne E-Mail-Adresse und Website */
  for (const [where, s] of [['Datenbank', await app.dump()], ['Log', app.logs()]]) {
    assert.ok(!s.includes('mock-access-token') && !/eyJ[A-Za-z0-9_-]{10,}\./.test(s) && !s.includes(c.cookies.values().next().value), `${where}: kein Token, keine Session-ID`);
  }
  assert.ok(!app.logs().includes(CUSTOMER) && !app.logs().includes('musterfirma'));
  await c.req('GET', '/api/anfrage');
  assert.equal((await orders()).length, 1, 'Neuladen erzeugt nichts Neues');
  assert.equal(mail.state.accepted.length, 1);
});

/* ---------- Duplikate ---------- */

test('Wiederholte Anfrage: Doppelabsendung und erneute Anfrage derselben Website erzeugen keinen zweiten Auftrag und keine zweite Mail', { skip }, async () => {
  await reset();
  const c = new Client(app);
  await login(c, google);
  const page = await c.req('GET', '/api/anfrage');
  const form = { action: 'confirm', csrf: field(page.text, 'csrf'), idem: field(page.text, 'idem'), zustimmung: '1' };
  const [a, b] = await Promise.all([c.req('POST', '/api/anfrage', { form }), c.req('POST', '/api/anfrage', { form })]);
  const again = await c.req('POST', '/api/anfrage', { form });
  assert.deepEqual([a.status, b.status, again.status], [303, 303, 303], 'gleiche Absendung → gleiche Bestätigung');
  await settled();
  assert.equal((await orders()).length, 1);
  assert.equal(mail.state.accepted.length, 1);
  const ref = (await orders())[0].reference;
  const c2 = new Client(app);
  await login(c2, google, { website: 'https://musterfirma.de/' });
  assert.equal((await confirm(c2)).res.status, 303);
  const shown = await c2.req('GET', '/api/anfrage');
  assert.match(shown.text, /Diese Website ist schon angefragt/);
  assert.match(shown.text, new RegExp(ref));
  assert.equal((await orders()).length, 1);
  const c3 = new Client(app);
  await login(c3, google, { claims: { sub: '100000000000000000002', email: 'zweite@beispiel-kunde.de' } });
  assert.equal((await confirm(c3)).res.status, 303, 'anderes Konto darf dieselbe Website anfragen');
  await settled();
  assert.equal((await orders()).length, 2);
  assert.equal(mail.state.accepted.length, 2);
});

test('Tageslimit je Google-Konto: höchstens fünf Aufträge in 24 Stunden', { skip }, async () => {
  await reset();
  const statuses = [];
  for (let i = 1; i <= 6; i++) {
    const c = new Client(app, { ip: `198.51.100.${10 + i}` });
    await login(c, google, { website: `firma-${i}.de` });
    statuses.push((await confirm(c)).res.status);
  }
  assert.deepEqual(statuses, [303, 303, 303, 303, 303, 429]);
  assert.equal((await orders()).length, 5);
  await settled();
});

/* ---------- Fehlerpfade ---------- */

test('Fehlgeschlagene Speicherung: keine Bestätigung, kein halber Auftrag, keine Mail; erneuter Versuch klappt', { skip }, async () => {
  await reset();
  const c = new Client(app);
  await login(c, google);
  const page = await c.req('GET', '/api/anfrage');
  const form = { action: 'confirm', csrf: field(page.text, 'csrf'), idem: field(page.text, 'idem'), zustimmung: '1' };
  await app.run('DROP TABLE notifications');   // Auftrag wäre speicherbar, Benachrichtigung nicht → ganzer Batch muss scheitern
  const failed = await c.req('POST', '/api/anfrage', { form });
  assert.equal(failed.status, 503);
  assert.match(failed.text, /konnte nicht verarbeitet werden/);
  assert.ok(!/Referenz|liegt bei uns/.test(failed.text), 'keine Annahmebestätigung');
  assert.equal((await orders()).length, 0, 'Rollback: kein Auftrag ohne Benachrichtigung');
  assert.ok(!app.logs().includes(CUSTOMER));
  await app.migrate();
  assert.equal((await c.req('POST', '/api/anfrage', { form })).status, 303, 'Angaben bleiben in der Session, erneuter Versuch möglich');
  await settled();
  assert.equal((await orders()).length, 1);
  assert.equal(mail.state.accepted.length, 1);
});

test('Fehlgeschlagener Mailversand: Auftrag bleibt gespeichert und bestätigt; Cron versendet genau einmal nach', { skip }, async () => {
  await reset();
  mail.state.mode = 'fail';
  const c = new Client(app);
  await login(c, google);
  assert.equal((await confirm(c)).res.status, 303);
  assert.match((await c.req('GET', '/api/anfrage')).text, /Ihre Anfrage liegt bei uns/, 'Annahme hängt an der Speicherung, nicht am Mailversand');
  await settled();
  assert.deepEqual(await app.sql('SELECT status, attempts, last_error FROM notifications'), [{ status: 'pending', attempts: 1, last_error: 'temporary:503' }]);
  mail.state.mode = 'ok';
  assert.match((await app.cron()).log, /PXWA: 0 versendet, 0 fehlgeschlagen/, 'Backoff: noch nicht fällig');
  await app.run("UPDATE notifications SET next_attempt_at = '2000-01-01 00:00:00'");
  const run = await app.cron();
  assert.equal(run.outcome, 'ok');
  assert.match(run.log, /PXWA: 1 versendet, 0 fehlgeschlagen/);
  assert.ok(!run.log.includes(CUSTOMER));
  assert.equal(mail.state.accepted.length, 1);
  assert.ok(mail.state.accepted[0].text.includes((await orders())[0].reference));
  assert.equal(new Set(mail.state.requests.map(r => r.headers['idempotency-key'])).size, 1, 'gleicher Idempotency-Key bei jedem Versuch');
  await app.run("UPDATE notifications SET next_attempt_at = '2000-01-01 00:00:00'");
  assert.match((await app.cron()).log, /0 versendet/);
  assert.equal(mail.state.accepted.length, 1, 'keine Doppel-Mail');
  assert.deepEqual(await app.sql('SELECT status, attempts FROM notifications'), [{ status: 'sent', attempts: 2 }]);
});

test('Mail-API lehnt dauerhaft ab: kontrollierte Wiederholung mit Backoff, nach zehn Versuchen endgültig fehlgeschlagen', { skip }, async () => {
  await reset();
  mail.state.mode = 'reject';
  const c = new Client(app);
  await login(c, google);
  assert.equal((await confirm(c)).res.status, 303);
  await settled();
  const [n] = await app.sql("SELECT status, attempts, last_error, next_attempt_at > datetime('now', '+4 minutes') AS later FROM notifications");
  assert.deepEqual(n, { status: 'pending', attempts: 1, last_error: 'permanent:422', later: 1 });
  for (let i = 2; i <= 10; i++) {
    await app.run("UPDATE notifications SET next_attempt_at = '2000-01-01 00:00:00'");
    await app.cron();
  }
  assert.deepEqual(await app.sql('SELECT status, attempts FROM notifications'), [{ status: 'failed', attempts: 10 }]);
  await app.run("UPDATE notifications SET next_attempt_at = '2000-01-01 00:00:00'");
  await app.cron();
  assert.equal(mail.state.attempts, 10, 'kein elfter Versuch');
  assert.match(app.logs(), /Versuch 10, endgültig/);
});

test('Benachrichtigung scheitert nach der Speicherung an der Datenbank: Annahme bleibt bestätigt, keine Fehlerseite, Cron versendet genau einmal', { skip }, async () => {
  await reset();
  const c = new Client(app);
  await login(c, google);
  /* Auftrag und Outbox-Eintrag werden gespeichert; erst das Beanspruchen der Benachrichtigung (UPDATE) schlägt fehl */
  await app.run("CREATE TRIGGER pxwa_test_block BEFORE UPDATE ON notifications BEGIN SELECT RAISE(ABORT, 'pxwa test'); END");
  const before = app.logs().length;
  let res;
  try {
    ({ res } = await confirm(c));
    await waitFor(() => app.logs().slice(before).includes('nicht sofort versendet'), { what: 'Log der verschobenen Zustellung' });
  } finally {
    await app.run('DROP TRIGGER pxwa_test_block');
  }
  assert.equal(res.status, 303, 'Auftrag ist gespeichert – keine Fehlerseite, die zu erneutem Absenden verleitet');
  assert.match((await c.req('GET', '/api/anfrage')).text, /Ihre Anfrage liegt bei uns/);
  assert.equal((await orders()).length, 1);
  assert.deepEqual(await app.sql('SELECT status, attempts FROM notifications'), [{ status: 'pending', attempts: 0 }], 'Benachrichtigung bleibt fällig');
  assert.ok(!app.logs().includes(CUSTOMER) && !app.logs().includes('musterfirma'));
  assert.match((await app.cron()).log, /1 versendet, 0 fehlgeschlagen/);
  assert.equal(mail.state.accepted.length, 1, 'genau eine Mail');
});

test('Störungen: fehlende Tabelle, fehlende Konfiguration, kein D1-Binding, Google-Ausfall → ehrliche Fehlerseite, keine Annahme', { skip }, async () => {
  await reset();
  await app.run('ALTER TABLE rate_limits RENAME TO rate_limits_off');
  try {
    const r = await new Client(app).req('POST', '/api/anfrage', { form: { action: 'start', website: 'musterfirma.de' } });
    assert.equal(r.status, 503);
    assert.match(r.text, /konnte nicht verarbeitet werden/);
    assert.equal(r.location, null, 'keine Weiterleitung zu Google');
  } finally {
    await app.run('ALTER TABLE rate_limits_off RENAME TO rate_limits');
  }
  assert.match(app.logs(), /PXWA: Datenbankfehler \(.*rate_limits/);
  google.state.outage = true;
  try {
    const g = new Client(app);
    const { callback } = await login(g, google);
    assert.equal(callback.status, 401);
    assert.match(callback.text, /Anmeldung nicht bestätigt/);
    assert.equal((await confirm(g)).res.status, 403);
  } finally {
    google.state.outage = false;
  }
  await waitFor(() => /Google-Anmeldung abgelehnt: token_exchange/.test(app.logs()), { what: 'Log token_exchange' });
  assert.equal((await orders()).length, 0);
  const g2 = await mockGoogle().start();
  const broken = [
    ['ohne Secret', await startWorker({ google: g2, mail, env: { GOOGLE_CLIENT_SECRET: undefined } }), /GOOGLE_CLIENT_SECRET/],
    ['ohne D1', await startWorker({ google: g2, mail, db: false }), /DB/],
  ];
  try {
    for (const [name, w, key] of broken) {
      for (const method of ['GET', 'POST']) {
        const n = await new Client(w).req(method, '/api/anfrage', method === 'POST' ? { form: { action: 'start', website: 'musterfirma.de' } } : {});
        assert.equal(n.status, 503, `${name} ${method}`);
        assert.match(n.text, /Anfragen sind im Moment nicht möglich/);
      }
      await waitFor(() => key.test(w.logs()), { what: `Log ${name}` });
      assert.ok(!w.logs().includes(CLIENT_ID) && !w.logs().includes('musterfirma'), 'Log nennt nur Schlüsselnamen');
    }
  } finally {
    for (const [, w] of broken) await w.stop();
    await g2.stop();
  }
});

test('Produktion: nicht freigegebener Mail-Anbieter, Test-Endpunkte oder Platzhalter-Domain sperren die API (fail closed, keine Daten an Dritte)', { skip }, async () => {
  const g = await mockGoogle().start();
  const variants = [
    ['Mail-API nicht freigegeben', { ENV: 'production', BASE_URL: 'https://360.beispiel-domain.de', GOOGLE_TOKEN_ENDPOINT: undefined, GOOGLE_JWKS_URI: undefined, MAIL_API_URL: 'https://api.mail-anbieter.example.net/v1/send' }, /MAIL_API_URL/],
    ['Mock-Google in Produktion', { ENV: 'production', BASE_URL: 'https://360.beispiel-domain.de' }, /GOOGLE_TOKEN_ENDPOINT, GOOGLE_JWKS_URI/],
    ['Platzhalter-Domain', { ENV: 'production', BASE_URL: 'https://DOMAIN-FEHLT.example' }, /BASE_URL/],
    ['http in Produktion', { ENV: 'production', BASE_URL: 'http://360.beispiel-domain.de' }, /BASE_URL/],
  ];
  try {
    for (const [name, env, key] of variants) {
      mail.reset();
      const w = await startWorker({ google: g, mail, base: env.BASE_URL, env });
      try {
        const r = await new Client(w).req('POST', '/api/anfrage', { form: { action: 'start', website: 'musterfirma.de' } });
        assert.equal(r.status, 503, name);
        assert.equal(r.location, null, `${name}: keine Weiterleitung`);
        assert.equal((await w.cron()).outcome, 'exception', `${name}: Cron versendet nichts`);
        await waitFor(() => key.test(w.logs()), { what: `Log ${name}` });
        assert.equal(mail.state.attempts, 0, `${name}: kein Aufruf der Mail-API`);
      } finally {
        await w.stop();
      }
    }
  } finally {
    await g.stop();
  }
});

test('Kein Identitäts- oder Session-Spoofing: Formularfelder überschreiben keine Identität, fremde oder fixierte Session-IDs tragen keine Anmeldung', { skip }, async () => {
  await reset();
  /* Vom Angreifer erfundene Session-ID wird nicht übernommen */
  const invented = 'A'.repeat(43);
  const v1 = new Client(app);
  v1.cookies.set('pxwa', invented);
  await v1.req('POST', '/api/anfrage', { form: { action: 'start', website: 'musterfirma.de' } });
  assert.notEqual(v1.cookies.get('pxwa'), invented, 'erfundene Session-ID wird ersetzt');
  /* Session-Fixation: Angreifer schiebt eine echte, gültige Session-ID unter; nach dem Login gilt sie nicht mehr */
  const attacker = new Client(app);
  await attacker.req('POST', '/api/anfrage', { form: { action: 'start', website: 'musterfirma.de' } });
  const victim = new Client(app);
  victim.cookies.set('pxwa', attacker.cookies.get('pxwa'));
  const { callback } = await login(victim, google);
  assert.equal(callback.status, 303);
  assert.notEqual(victim.cookies.get('pxwa'), attacker.cookies.get('pxwa'), 'neue Session-ID nach dem Login');
  const stolen = await attacker.req('GET', '/api/anfrage');
  assert.ok(!/name="idem"/.test(stolen.text) && !stolen.text.includes(CUSTOMER), 'alte Session-ID trägt keine Anmeldung');
  assert.equal((await confirm(attacker)).res.status, 403);
  /* Untergeschobene Formularfelder ändern weder E-Mail, Google-Kennung, Website noch Referenz */
  const page = await victim.req('GET', '/api/anfrage');
  const res = await victim.req('POST', '/api/anfrage', { form: {
    action: 'confirm', csrf: field(page.text, 'csrf'), idem: field(page.text, 'idem'), zustimmung: '1',
    email: 'angreifer@beispiel-kunde.de', sub: '999', google_sub: '999', website: 'https://andere-firma.de', url: 'https://andere-firma.de', reference: 'PXA-AAAA-AAAA', 'identity[email]': 'angreifer@beispiel-kunde.de',
  } });
  assert.equal(res.status, 303);
  const [o] = await orders();
  assert.deepEqual([o.email, o.google_sub, o.website_url], [CUSTOMER, '100000000000000000001', 'https://musterfirma.de']);
  assert.notEqual(o.reference, 'PXA-AAAA-AAAA');
  await settled();
  assert.deepEqual(mail.state.accepted.map(m => m.to), [[NOTIFY_TO]]);
  assert.ok(!mail.state.accepted[0].text.includes('angreifer'));
  /* Abmelden löscht die Session serverseitig; die alte ID ist danach wertlos */
  const sid = victim.cookies.get('pxwa');
  const out = await victim.req('POST', '/api/anfrage', { form: { action: 'logout', csrf: field(page.text, 'csrf') } });
  assert.equal(out.location, `${app.base}/index.html`);
  assert.ok(out.headers.getSetCookie().some(s => /^pxwa=;.*Max-Age=0/i.test(s)));
  const reuse = new Client(app);
  reuse.cookies.set('pxwa', sid);
  assert.ok(!(await reuse.req('GET', '/api/anfrage')).text.includes('Referenz'));
});

test('HTTPS-Basis-URL: __Host-Session-Cookie (Secure, HttpOnly, SameSite=Lax, Path=/, Max-Age, ohne Domain), HSTS und Sicherheits-Header; Ablauf funktioniert', { skip }, async () => {
  const g = await mockGoogle().start();
  mail.reset();
  const s = await startWorker({ google: g, mail, scheme: 'https' });
  try {
    const c = new Client(s);
    const first = await c.req('GET', '/api/anfrage');
    const h = first.headers;
    assert.equal(h.get('strict-transport-security'), 'max-age=31536000');
    assert.match(h.get('content-security-policy'), /^default-src 'none';.*form-action 'self' https:\/\/accounts\.google\.com;.*frame-ancestors 'none'; base-uri 'none'$/);
    assert.equal(h.get('x-frame-options'), 'DENY');
    assert.equal(h.get('x-content-type-options'), 'nosniff');
    assert.equal(h.get('referrer-policy'), 'same-origin');
    assert.equal(h.get('cross-origin-opener-policy'), 'same-origin');
    assert.match(h.get('permissions-policy'), /camera=\(\)/);
    assert.equal(h.get('cache-control'), 'no-store');
    assert.equal(h.get('access-control-allow-origin'), null, 'keine CORS-Freigabe');
    const plain = await new Client(s, { origin: s.base.replace('https:', 'http:') }).req('POST', '/api/anfrage', { form: { action: 'start', website: 'musterfirma.de' } });
    assert.equal(plain.status, 403, 'Formular-POST mit http-Origin passt nicht zur https-Basis-URL');
    const start = await c.req('POST', '/api/anfrage', { form: { action: 'start', website: 'musterfirma.de' } });
    const [cookie] = start.headers.getSetCookie();
    assert.match(cookie, /^__Host-pxwa=[A-Za-z0-9_-]{43};/);
    for (const attr of [/;\s*Path=\/(;|$)/i, /;\s*Secure(;|$)/i, /;\s*HttpOnly(;|$)/i, /;\s*SameSite=Lax(;|$)/i, /;\s*Max-Age=3600(;|$)/i]) assert.match(cookie, attr);
    assert.ok(!/domain=|expires=/i.test(cookie), 'kein Domain-Attribut');
    const sid0 = c.cookies.get('__Host-pxwa');
    const p = new URL(start.location).searchParams;
    const code = g.issueCode({ nonce: p.get('nonce'), challenge: p.get('code_challenge'), redirectUri: p.get('redirect_uri') });
    const callback = await c.req('GET', `/api/auth/callback?code=${encodeURIComponent(code)}&state=${p.get('state')}`);
    assert.equal(callback.status, 303);
    assert.equal(callback.location, `${s.base}/api/anfrage`);
    assert.ok(c.cookies.get('__Host-pxwa') && c.cookies.get('__Host-pxwa') !== sid0, 'Session-Wechsel auch mit __Host-Cookie');
    assert.equal((await confirm(c)).res.status, 303);
    assert.equal((await s.sql('SELECT COUNT(*) AS n FROM orders'))[0].n, 1);
    await waitFor(() => mail.state.accepted.length === 1, { what: 'Mail' });
    assert.ok(c.setCookies.every(x => /;\s*secure/i.test(x) && /^__Host-/.test(x)), 'alle Cookies Secure mit __Host-Präfix');
  } finally {
    await s.stop(); await g.stop();
  }
});

test('Routen: Worker beantwortet nur /api/anfrage und /api/auth/callback; falsche Methoden und zu große Anfragen werden abgelehnt', { skip }, async () => {
  await reset();
  const c = new Client(app);
  for (const path of ['/api/', '/api/orders', '/api/anfrage.php', '/api/../index.html', '/api/auth/callback/x']) assert.equal((await c.req('GET', path)).status, 404, path);
  for (const method of ['PUT', 'DELETE', 'PATCH']) assert.equal((await c.req(method, '/api/anfrage')).status, 405, method);
  assert.equal((await c.req('POST', '/api/auth/callback', { form: {} })).status, 405);
  const big = await c.req('POST', '/api/anfrage', { form: { action: 'start', website: 'musterfirma.de', x: 'y'.repeat(20000) } });
  assert.equal(big.status, 413);
  assert.equal((await app.sql('SELECT COUNT(*) AS n FROM rate_limits'))[0].n, 0, 'nichts gespeichert');
});

test('Hauptnavigation: Anfrageseiten verlinken dieselben Bereiche in derselben Reihenfolge wie die Methodikseite', { skip }, async () => {
  const { readFileSync } = await import('node:fs');
  const links = html => [...(html.match(/<div class="nav-links">([\s\S]*?)<\/div>/) || ['', ''])[1].matchAll(/href="([^"]+)">([^<]+)</g)].map(m => [m[1].replace(/^.*index\.html/, 'index.html'), m[2]]);
  const methodik = links(readFileSync(new URL('../public/pruefkriterien.html', import.meta.url), 'utf8'));
  assert.ok(methodik.length >= 4);
  assert.deepEqual(links((await new Client(app).req('GET', '/api/anfrage')).text), methodik);
});

test('Rate-Limiting: zu viele Anfragestarts von einer IP werden mit 429 gebremst, andere IPs nicht', { skip }, async () => {
  await reset();
  const c = new Client(app, { ip: '203.0.113.9' });
  const codes = [];
  for (let i = 0; i < 22; i++) codes.push((await c.req('POST', '/api/anfrage', { form: { action: 'start', website: 'musterfirma.de' } })).status);
  assert.deepEqual(codes, [...Array(20).fill(303), 429, 429]);
  assert.equal((await new Client(app, { ip: '203.0.113.10' }).req('POST', '/api/anfrage', { form: { action: 'start', website: 'musterfirma.de' } })).status, 303);
  const v6 = ip => new Client(app, { ip }).req('POST', '/api/anfrage', { form: { action: 'start', website: 'musterfirma.de' } });
  for (let i = 0; i < 20; i++) await v6(`2001:db8:1:2::${i.toString(16)}`);
  assert.equal((await v6('2001:db8:1:2:ffff::1')).status, 429, 'IPv6 wird je /64 gezählt');
  assert.ok(!JSON.stringify(await app.sql('SELECT bucket FROM rate_limits')).includes('203.0.113'), 'IP nur pseudonymisiert gespeichert');
  await reset();
});

test('Alias-Host (z. B. www/ohne www/workers.dev): GET leitet auf die Basis-URL um, POST wird abgelehnt', { skip }, async () => {
  await reset();
  const alias = app.base.replace('127.0.0.1', 'localhost');
  const get = await app.fetch(alias + '/api/anfrage', { redirect: 'manual' });
  assert.equal(get.status, 301);
  assert.equal(get.headers.get('location'), `${app.base}/api/anfrage`, 'festes Ziel, kein Host-Echo');
  const post = await app.fetch(alias + '/api/anfrage', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: alias }, body: 'action=start&website=musterfirma.de' });
  assert.equal(post.status, 403);
  assert.equal((await orders()).length, 0);
});

test('Cron-Aufräumen: abgelaufene Sessions und alte Rate-Limit-Fenster werden gelöscht, Aufträge bleiben', { skip }, async () => {
  await reset();
  const c = new Client(app);
  await login(c, google);
  assert.equal((await confirm(c)).res.status, 303);
  await settled();
  await app.run("INSERT INTO sessions (id_hash, data, version, created_at, expires_at) VALUES ('alt', '{\"csrf\":\"x\"}', 0, 1, 2)");
  await app.run("INSERT INTO rate_limits (bucket, window_start, hits) VALUES ('start:alt', 1, 1)");
  const run = await app.cron();
  assert.match(run.log, /1 Sessions und 1 Rate-Limit-Fenster gelöscht/);
  assert.deepEqual((await app.sql('SELECT id_hash FROM sessions')).map(r => r.id_hash).includes('alt'), false);
  assert.equal((await orders()).length, 1);
});

test('Worker-Log: keine unbehandelten Ausnahmen über alle Abläufe', { skip }, async () => {
  await sleep(100);
  assert.deepEqual(app.logs().split('\n').filter(l => /Uncaught|Unerwarteter Fehler|TypeError|ReferenceError/.test(l)), []);
});
