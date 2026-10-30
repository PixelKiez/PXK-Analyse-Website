/* PXWA – Integrationstests der Serverkomponente gegen einen echten PHP-Server (php -S) mit lokalen Mocks.
   Ausführen im Repo-Root:  node --test tests/server.test.mjs   (benötigt php ≥ 8.1 mit pdo_sqlite, openssl, curl, intl und sqlite3)
   Echte Provider (Google, Hostinger-SMTP, Hostinger-Datenbank) werden hier NICHT getestet. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mockGoogle, mockSmtp, startApp, Client, login, confirm, field, decodeMail, phpAvailable, sqliteAvailable, CLIENT_ID, CUSTOMER, NOTIFY_TO } from './lib/harness.mjs';

const skip = phpAvailable && sqliteAvailable ? false : 'NOT_RUN: php oder sqlite3 nicht verfügbar';
let google, smtp, app;

before(async () => {
  if (skip) return;
  google = await mockGoogle().start();
  smtp = await mockSmtp().start();
  app = await startApp({ google, smtp });
});
after(async () => {
  if (skip) return;
  await app.stop(); await google.stop(); await smtp.stop();
});

const orders = () => app.sql('SELECT * FROM orders ORDER BY id');
const reset = () => { app.exec('DELETE FROM notifications; DELETE FROM orders; DELETE FROM rate_limits;'); smtp.state.accepted.length = 0; smtp.state.mode = 'ok'; };
const isConfirmPage = html => /Anfrage bestätigen\./.test(html) && /name="idem"/.test(html);

/* ---------- Google-Login ---------- */

test('Google-Login gültig: minimale Rechte, PKCE, Session-Wechsel, Bestätigungsseite mit bestätigter E-Mail', { skip }, async () => {
  reset();
  const c = new Client(app.base);
  const first = await c.req('GET', '/anfrage.php');
  const sid0 = [...c.cookies.values()][0];
  assert.equal(first.status, 200);
  const { start, auth, callback } = await login(c, google, { website: 'HTTPS://WWW.Musterfirma.DE/leistungen?utm_source=x#top' });
  assert.equal(start.status, 303);
  const p = auth.searchParams;
  assert.equal(auth.origin + auth.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(p.get('scope'), 'openid email', 'nur openid email – keine Gmail-Rechte');
  assert.ok(![...p.values()].some(v => /gmail|mail\.google|https:\/\/www\.googleapis\.com\/auth/.test(v)), 'keine weiteren Scopes');
  assert.equal(p.get('response_type'), 'code');
  assert.equal(p.get('client_id'), CLIENT_ID);
  assert.equal(p.get('redirect_uri'), `${app.base}/auth/callback.php`);
  assert.equal(p.get('code_challenge_method'), 'S256');
  assert.ok(p.get('state').length >= 32 && p.get('nonce').length >= 32 && p.get('code_challenge').length >= 43);
  assert.equal(callback.status, 303);
  assert.equal(callback.location, `${app.base}/anfrage.php`);
  assert.notEqual([...c.cookies.values()][0], sid0, 'Session-ID wird nach dem Login gewechselt');
  assert.ok(c.setCookies.every(s => /HttpOnly/i.test(s) && /SameSite=Lax/i.test(s)), 'Cookies HttpOnly + SameSite=Lax');
  const tokenCall = google.log.token.at(-1);
  assert.ok(tokenCall.code_verifier && tokenCall.client_secret, 'Code-Austausch mit PKCE-Verifier serverseitig');
  const page = await c.req('GET', '/anfrage.php');
  assert.ok(isConfirmPage(page.text));
  assert.match(page.text, new RegExp(CUSTOMER.replace('.', '\\.')));
  assert.match(page.text, /https:\/\/www\.musterfirma\.de\/leistungen</, 'URL normalisiert, Query und Fragment verworfen');
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'.*frame-ancestors 'none'/);
  assert.equal(page.headers.get('x-powered-by'), null);
  assert.equal(page.headers.get('cache-control'), 'no-store');
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
    reset();
    const c = new Client(app.base);
    const before = app.logs().length;
    const { callback } = await login(c, google, opts);
    assert.equal(callback.status, 401, callback.text.slice(0, 200));
    assert.match(callback.text, /Anmeldung nicht bestätigt/);
    assert.match(app.logs().slice(before), new RegExp(`Google-Anmeldung abgelehnt: ${reason}`));
    const page = await c.req('GET', '/anfrage.php');
    assert.ok(!isConfirmPage(page.text), 'keine Identität in der Session');
    const r = await c.req('POST', '/anfrage.php', { form: { action: 'confirm', csrf: field(page.text, 'csrf') ?? '', idem: 'x', zustimmung: '1' } });
    assert.ok([403].includes(r.status));
    assert.equal(orders().length, 0);
    assert.equal(smtp.state.accepted.length, 0);
  });
}

test('Token-Replay: Callback mit gleichem state/code ist nur einmal gültig; falscher state wird abgelehnt', { skip }, async () => {
  reset();
  const c = new Client(app.base);
  const { callback, callbackPath } = await login(c, google);
  assert.equal(callback.status, 303);
  const replay = await c.req('GET', callbackPath);
  assert.equal(replay.status, 400, 'state verbraucht');
  const other = new Client(app.base);
  const stolen = await other.req('GET', callbackPath);
  assert.equal(stolen.status, 400, 'fremde Session ohne passenden state');
  const c2 = new Client(app.base);
  const wrong = await login(c2, google, { state: 'a'.repeat(64) });
  assert.equal(wrong.callback.status, 400);
  assert.ok(!isConfirmPage((await c2.req('GET', '/anfrage.php')).text));
});

/* ---------- Website-URL ---------- */

test('Ungültige Website-URL: 422, kein Weiterleiten zu Google, Eingabe escaped', { skip }, async () => {
  reset();
  const bad = ['', '   ', 'keine adresse', 'javascript:alert(1)', 'http://localhost', 'http://127.0.0.1', 'https://[::1]/', 'http://10.0.0.1/admin',
    'https://user:pass@musterfirma.de', 'musterfirma', 'ftp://musterfirma.de', 'https://musterfirma.de:8080', 'musterfirma.de:8080', 'intranet.local', 'firma.internal',
    'https://example.com', 'a'.repeat(2050) + '.de', '<script>alert(1)</script>.de', 'musterfirma.de/"onmouseover="x', 'https://musterfirma.de\\@evil.de'];
  for (const website of bad) {
    const c = new Client(app.base);
    const r = await c.req('POST', '/anfrage.php', { form: { action: 'start', website } });
    assert.equal(r.status, 422, `"${website.slice(0, 40)}" → ${r.status}`);
    assert.equal(r.location, null);
    assert.ok(!r.text.includes('<script>alert(1)'), 'kein ungefiltertes Echo');
    assert.match(r.text, /öffentliche Website-Adresse/);
  }
  assert.equal(orders().length, 0);
  app.exec('DELETE FROM rate_limits;');   // 20 Starts in 10 Minuten wären sonst erreicht
  const idn = new Client(app.base);
  await login(idn, google, { website: 'müller-bäckerei.de' });
  const page = await idn.req('GET', '/anfrage.php');
  assert.match(page.text, /https:\/\/müller-bäckerei\.de</, 'Umlaut-Domain wird akzeptiert und lesbar angezeigt');
});

/* ---------- Anfrage ohne Login ---------- */

test('Anfrage ohne Login wird abgelehnt (ohne Sitzung, ohne abgeschlossene Google-Anmeldung, nach Ablauf der Anmeldung); Cross-Site-POST wird abgelehnt', { skip }, async () => {
  reset();
  const fresh = new Client(app.base);
  await fresh.req('GET', '/anfrage.php');
  assert.equal((await fresh.req('POST', '/anfrage.php', { form: { action: 'confirm', idem: 'abc', zustimmung: '1' } })).status, 403, 'neue Sitzung ohne Login');
  const started = new Client(app.base);
  assert.equal((await started.req('POST', '/anfrage.php', { form: { action: 'start', website: 'musterfirma.de' } })).status, 303, 'URL gemerkt, Weiterleitung zu Google');
  assert.equal((await started.req('POST', '/anfrage.php', { form: { action: 'confirm', idem: 'abc', zustimmung: '1' } })).status, 403, 'Google-Anmeldung nicht abgeschlossen');
  /* Gültige Sitzung mit CSRF-Token und Formular, aber Anmeldung abgelaufen (Zeitstempel in der Session-Datei zurückdatiert) */
  const expired = new Client(app.base);
  await login(expired, google);
  const page = await expired.req('GET', '/anfrage.php');
  const sid = expired.cookies.get('pxwa');
  const file = join(app.sessions, `sess_${sid}`);
  const raw = readFileSync(file, 'utf8');
  const aged = raw.replace(/(identity\|a:3:\{.*?s:2:"at";i:)\d{10}/, '$11000000000');
  assert.notEqual(aged, raw);
  writeFileSync(file, aged);
  const late = await expired.req('POST', '/anfrage.php', { form: { action: 'confirm', csrf: field(page.text, 'csrf'), idem: field(page.text, 'idem'), zustimmung: '1' } });
  assert.equal(late.status, 403);
  assert.match(late.text, /zuerst mit Google an/);
  const logged = new Client(app.base);
  await login(logged, google);
  /* Origin-Prüfung als eigene Schicht: selbst mit gültigem Token und Formular wird ein Cross-Site-POST abgelehnt */
  const form = await logged.req('GET', '/anfrage.php');
  const crossSite = await logged.req('POST', '/anfrage.php', { form: { action: 'confirm', csrf: field(form.text, 'csrf'), idem: field(form.text, 'idem'), zustimmung: '1' }, headers: { origin: 'https://evil.example' } });
  assert.equal(crossSite.status, 403);
  assert.match(crossSite.text, /direkt auf dieser Website/);
  const crossStart = await new Client(app.base).req('POST', '/anfrage.php', { form: { action: 'start', website: 'musterfirma.de' }, headers: { origin: 'null' } });
  assert.equal(crossStart.status, 403, 'Start ohne Token: Origin "null" wird abgelehnt');
  const fetchSite = await new Client(app.base).req('POST', '/anfrage.php', { form: { action: 'start', website: 'musterfirma.de' }, headers: { origin: null, 'sec-fetch-site': 'cross-site' } });
  assert.equal(fetchSite.status, 403, 'ohne Origin, aber Sec-Fetch-Site: cross-site');
  const badCsrf = await confirm(logged, { csrf: 'falsch' });
  assert.equal(badCsrf.res.status, 403);
  const noConsent = await confirm(logged, { consent: false });
  assert.equal(noConsent.res.status, 422);
  assert.equal(orders().length, 0);
  assert.equal(smtp.state.accepted.length, 0);
});

/* ---------- Erfolgreiche Annahme ---------- */

test('Erfolgreiche Annahme: genau ein Auftrag, genau eine interne Benachrichtigung, keine Tokens gespeichert, kein PDF', { skip }, async () => {
  reset();
  const c = new Client(app.base);
  await login(c, google, { website: 'https://www.musterfirma.de' });
  const { res } = await confirm(c);
  assert.equal(res.status, 303);
  const done = await c.req('GET', '/anfrage.php');
  const ref = (done.text.match(/id="reference">(PXA-[0-9A-Z]{4}-[0-9A-Z]{4})</) || [])[1];
  assert.ok(ref, 'Referenz wird angezeigt');
  assert.match(done.text, /Ihre Anfrage liegt bei uns/);
  const rows = orders();
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['created_at', 'email', 'google_sub', 'id', 'idempotency_key', 'privacy_version', 'reference', 'status', 'website_url']);
  assert.equal(rows[0].reference, ref);
  assert.equal(rows[0].email, CUSTOMER);
  assert.equal(rows[0].website_url, 'https://www.musterfirma.de');
  assert.equal(rows[0].privacy_version, 'TEST-2026-10-30');
  assert.equal(smtp.state.accepted.length, 1, 'genau eine Mail');
  const mail = smtp.state.accepted[0];
  assert.deepEqual(mail.rcpt, [NOTIFY_TO], 'nur an Pixelkiez, nie an die Kundin/den Kunden');
  assert.equal(mail.from, 'analyse@pixelkiez.de');
  assert.deepEqual(mail.auth, ['pxwa-test', 'test-only'], 'SMTP-Anmeldung mit Zugangsdaten aus der Serverkonfiguration');
  const { head, text } = decodeMail(mail.data);
  assert.match(head, new RegExp(`Subject: Neue Analyse-Anfrage ${ref}`));
  assert.match(head, new RegExp(`Reply-To: <${CUSTOMER}>`));
  assert.ok(!/multipart|application\/pdf|attachment/i.test(head), 'kein Anhang');
  assert.match(text, new RegExp(ref)); assert.match(text, /https:\/\/www\.musterfirma\.de/); assert.match(text, new RegExp(CUSTOMER.replace('.', '\\.')));
  assert.deepEqual(app.sql('SELECT status, attempts FROM notifications'), [{ status: 'sent', attempts: 1 }]);
  /* Keine Tokens in Datenbank, Sessions oder Log */
  const dbRaw = readFileSync(app.db).toString('latin1');
  const sessions = readdirSync(app.sessions).map(f => readFileSync(join(app.sessions, f), 'utf8')).join('\n');
  for (const [where, s] of [['Datenbank', dbRaw], ['Sessions', sessions], ['Log', app.logs()]]) {
    assert.ok(!s.includes('mock-access-token') && !/eyJ[A-Za-z0-9_-]{10,}\./.test(s), `${where}: kein Access- oder ID-Token`);
  }
  assert.ok(!app.logs().includes(CUSTOMER) && !app.logs().includes('musterfirma'), 'Log ohne E-Mail-Adresse und Website');
  /* Neuladen der Bestätigung erzeugt nichts Neues */
  await c.req('GET', '/anfrage.php');
  assert.equal(orders().length, 1);
  assert.equal(smtp.state.accepted.length, 1);
});

/* ---------- Duplikate ---------- */

test('Wiederholte Anfrage: Doppelabsendung und erneute Anfrage derselben Website erzeugen keinen zweiten Auftrag und keine zweite Mail', { skip }, async () => {
  reset();
  const c = new Client(app.base);
  await login(c, google);
  const page = await c.req('GET', '/anfrage.php');
  const form = { action: 'confirm', csrf: field(page.text, 'csrf'), idem: field(page.text, 'idem'), zustimmung: '1' };
  const [a, b] = await Promise.all([c.req('POST', '/anfrage.php', { form }), c.req('POST', '/anfrage.php', { form })]);
  const again = await c.req('POST', '/anfrage.php', { form });
  assert.deepEqual([a.status, b.status, again.status], [303, 303, 303], 'gleiche Absendung → gleiche Bestätigung');
  assert.equal(orders().length, 1);
  assert.equal(smtp.state.accepted.length, 1);
  const ref = orders()[0].reference;
  /* Neue Session, gleiches Google-Konto, gleiche Website (andere Schreibweise) */
  const c2 = new Client(app.base);
  await login(c2, google, { website: 'https://musterfirma.de/' });
  const r2 = await confirm(c2);
  assert.equal(r2.res.status, 303);
  const shown = await c2.req('GET', '/anfrage.php');
  assert.match(shown.text, /Diese Website ist schon angefragt/);
  assert.match(shown.text, new RegExp(ref));
  assert.equal(orders().length, 1);
  assert.equal(smtp.state.accepted.length, 1);
  /* Anderes Konto darf dieselbe Website anfragen */
  const c3 = new Client(app.base);
  await login(c3, google, { claims: { sub: '100000000000000000002', email: 'zweite@beispiel-kunde.de' } });
  assert.equal((await confirm(c3)).res.status, 303);
  assert.equal(orders().length, 2);
  assert.equal(smtp.state.accepted.length, 2);
});

/* ---------- Fehlerpfade ---------- */

test('Fehlgeschlagene Speicherung: keine Bestätigung, kein halber Auftrag, keine Mail; erneuter Versuch klappt', { skip }, async () => {
  reset();
  const c = new Client(app.base);
  await login(c, google);
  const page = await c.req('GET', '/anfrage.php');
  const form = { action: 'confirm', csrf: field(page.text, 'csrf'), idem: field(page.text, 'idem'), zustimmung: '1' };
  app.exec('DROP TABLE notifications;');   // Auftrag wäre speicherbar, Benachrichtigung nicht → ganze Transaktion muss scheitern
  const failed = await c.req('POST', '/anfrage.php', { form });
  assert.equal(failed.status, 503);
  assert.match(failed.text, /konnte nicht verarbeitet werden/);
  assert.ok(!/Referenz|liegt bei uns/.test(failed.text), 'keine Annahmebestätigung');
  assert.equal(orders().length, 0, 'Rollback: kein Auftrag ohne Benachrichtigung');
  assert.equal(smtp.state.accepted.length, 0);
  assert.ok(!app.logs().includes(CUSTOMER));
  assert.equal(app.migrate().status, 0);
  const retry = await c.req('POST', '/anfrage.php', { form });
  assert.equal(retry.status, 303, 'Angaben bleiben in der Session, erneuter Versuch möglich');
  assert.equal(orders().length, 1);
  assert.equal(smtp.state.accepted.length, 1);
});

test('Fehlgeschlagener Mailversand: Auftrag bleibt gespeichert und bestätigt; Cron versendet genau einmal nach', { skip }, async () => {
  reset();
  smtp.state.mode = 'fail';
  const c = new Client(app.base);
  await login(c, google);
  const { res } = await confirm(c);
  assert.equal(res.status, 303);
  const done = await c.req('GET', '/anfrage.php');
  assert.match(done.text, /Ihre Anfrage liegt bei uns/, 'Annahme hängt an der Speicherung, nicht am Mailversand');
  assert.equal(orders().length, 1);
  assert.equal(smtp.state.accepted.length, 0);
  let n = app.sql('SELECT status, attempts, last_error FROM notifications')[0];
  assert.deepEqual(n, { status: 'pending', attempts: 1, last_error: 'temporary:451' });
  smtp.state.mode = 'ok';
  const early = await app.cron();
  assert.match(early.stdout, /0 versendet/, 'Backoff: noch nicht fällig');
  app.exec("UPDATE notifications SET next_attempt_at = '2000-01-01 00:00:00';");
  const run = await app.cron();
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /1 versendet, 0 fehlgeschlagen/);
  assert.ok(!run.stdout.includes(CUSTOMER) && !run.stderr.includes(CUSTOMER));
  assert.equal(smtp.state.accepted.length, 1);
  assert.match(decodeMail(smtp.state.accepted[0].data).text, new RegExp(orders()[0].reference));
  app.exec("UPDATE notifications SET next_attempt_at = '2000-01-01 00:00:00';");
  assert.match((await app.cron()).stdout, /0 versendet/);
  assert.equal(smtp.state.accepted.length, 1, 'keine Doppel-Mail');
  n = app.sql('SELECT status, attempts FROM notifications')[0];
  assert.deepEqual(n, { status: 'sent', attempts: 2 });
});

test('Rate-Limiting: zu viele Anfragestarts von einer IP werden mit 429 gebremst', { skip }, async () => {
  reset();
  const c = new Client(app.base);
  const codes = [];
  for (let i = 0; i < 22; i++) codes.push((await c.req('POST', '/anfrage.php', { form: { action: 'start', website: 'musterfirma.de' } })).status);
  assert.deepEqual(codes.slice(0, 20), Array(20).fill(303));
  assert.deepEqual(codes.slice(20), [429, 429]);
  reset();
});

test('Alias-Host (z. B. www/ohne www/Vorschau-Domain): GET leitet auf die Basis-URL um, POST wird abgelehnt', { skip }, async () => {
  reset();
  const alias = app.base.replace('127.0.0.1', 'localhost');
  const get = await fetch(alias + '/anfrage.php', { redirect: 'manual' });
  assert.equal(get.status, 301);
  assert.equal(get.headers.get('location'), `${app.base}/anfrage.php`, 'festes Ziel, kein Host-Echo');
  const post = await fetch(alias + '/anfrage.php', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: alias }, body: 'action=start&website=musterfirma.de' });
  assert.equal(post.status, 403);
  assert.equal(orders().length, 0);
});

test('Server-Log: keine PHP-Warnungen, -Hinweise oder Deprecations über alle Abläufe', { skip }, () => {
  assert.deepEqual(app.logs().split('\n').filter(l => /PHP (Warning|Notice|Deprecated|Fatal|Parse)/.test(l)), []);
});
