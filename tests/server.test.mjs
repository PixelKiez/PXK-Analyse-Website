/* PXWA – Integrationstests der Serverkomponente gegen einen echten PHP-Server (php -S) mit lokalen Mocks.
   Ausführen im Repo-Root:  node --test tests/server.test.mjs   (benötigt php ≥ 8.1 mit pdo_sqlite, openssl, curl, intl)
   MySQL/MariaDB statt SQLite: PXK_MYSQL_DSN='mysql:host=…;port=…;dbname=…;charset=utf8mb4' PXK_MYSQL_USER=… PXK_MYSQL_PASS=…
   (nur eine Testdatenbank angeben – die Tabellen werden gelöscht und neu angelegt).
   Echte Provider (Google, Hostinger-SMTP, Hostinger-Datenbank) werden hier NICHT getestet. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mockGoogle, mockSmtp, startApp, Client, login, confirm, field, decodeMail, phpAvailable, sqliteAvailable, ROOT, CLIENT_ID, CUSTOMER, NOTIFY_TO } from './lib/harness.mjs';

const skip = phpAvailable && sqliteAvailable ? false : 'NOT_RUN: php oder pdo_sqlite nicht verfügbar';
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
  const dbRaw = app.dump();
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

test('Benachrichtigung scheitert nach der Speicherung an der Datenbank: Annahme bleibt bestätigt, keine Fehlerseite, Cron versendet genau einmal', { skip }, async () => {
  reset();
  const c = new Client(app.base);
  await login(c, google);
  /* Auftrag und Outbox-Eintrag werden gespeichert; erst das Beanspruchen der Benachrichtigung (UPDATE) schlägt fehl */
  app.exec(app.driver === 'mysql'
    ? "CREATE TRIGGER pxwa_test_block BEFORE UPDATE ON notifications FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'pxwa test'"
    : "CREATE TRIGGER pxwa_test_block BEFORE UPDATE ON notifications BEGIN SELECT RAISE(ABORT, 'pxwa test'); END");
  let res;
  try {
    ({ res } = await confirm(c));
  } finally {
    app.exec('DROP TRIGGER pxwa_test_block');
  }
  assert.equal(res.status, 303, 'Auftrag ist gespeichert – keine Fehlerseite, die zu erneutem Absenden verleitet');
  const done = await c.req('GET', '/anfrage.php');
  assert.match(done.text, /Ihre Anfrage liegt bei uns/);
  assert.equal(orders().length, 1);
  assert.equal(smtp.state.accepted.length, 0);
  assert.deepEqual(app.sql('SELECT status, attempts FROM notifications'), [{ status: 'pending', attempts: 0 }], 'Benachrichtigung bleibt fällig');
  assert.ok(!app.logs().includes(CUSTOMER) && !app.logs().includes('musterfirma'));
  const run = await app.cron();
  assert.match(run.stdout, /1 versendet, 0 fehlgeschlagen/);
  assert.equal(smtp.state.accepted.length, 1, 'genau eine Mail');
  assert.match(decodeMail(smtp.state.accepted[0].data).text, new RegExp(orders()[0].reference));
});

test('Störungen: fehlende Tabelle, nicht erreichbare Datenbank, fehlende Konfiguration, Google-Ausfall → ehrliche Fehlerseite, keine Annahme', { skip }, async () => {
  reset();
  /* Tabelle fehlt (z. B. Migration nicht gelaufen): Start wird nicht zu Google weitergeleitet */
  app.exec('ALTER TABLE rate_limits RENAME TO rate_limits_off');
  try {
    const r = await new Client(app.base).req('POST', '/anfrage.php', { form: { action: 'start', website: 'musterfirma.de' } });
    assert.equal(r.status, 503);
    assert.match(r.text, /konnte nicht verarbeitet werden/);
    assert.equal(r.location, null, 'keine Weiterleitung zu Google');
  } finally {
    app.exec('ALTER TABLE rate_limits_off RENAME TO rate_limits');
  }
  /* Google-Token-Endpunkt gestört: Anmeldung wird nicht bestätigt, keine Identität, keine Annahme */
  google.state.outage = true;
  try {
    const g = new Client(app.base);
    const { callback } = await login(g, google);
    assert.equal(callback.status, 401);
    assert.match(callback.text, /Anmeldung nicht bestätigt/);
    assert.equal((await confirm(g)).res.status, 403);
  } finally {
    google.state.outage = false;
  }
  assert.match(app.logs(), /Google-Anmeldung abgelehnt: token_exchange/);
  assert.equal(orders().length, 0);
  assert.equal(smtp.state.accepted.length, 0);
  /* Datenbank nicht erreichbar bzw. Konfiguration fehlt: eigene Instanzen */
  const g2 = await mockGoogle().start();
  const noDb = await startApp({ google: g2, smtp, db: 'unreachable' });
  const noConfig = await startApp({ google: g2, smtp, config: false });
  try {
    assert.equal((await fetch(noDb.url + '/anfrage.php')).status, 200, 'Eingabeseite braucht keine Datenbank');
    const r = await new Client(noDb.url).req('POST', '/anfrage.php', { form: { action: 'start', website: 'musterfirma.de' } });
    assert.equal(r.status, 503);
    assert.match(r.text, /konnte nicht verarbeitet werden/);
    assert.equal(r.location, null);
    assert.match(noDb.logs(), /PXWA: Datenbankverbindung fehlgeschlagen/);
    for (const method of ['GET', 'POST']) {
      const n = await new Client(noConfig.url).req(method, '/anfrage.php', method === 'POST' ? { form: { action: 'start', website: 'musterfirma.de' } } : {});
      assert.equal(n.status, 503, method);
      assert.match(n.text, /Anfragen sind im Moment nicht möglich/);
    }
    assert.equal((await fetch(noConfig.url + '/index.html')).status, 200, 'statische Seiten bleiben erreichbar');
    assert.match(noConfig.logs(), /PXWA: Konfigurationsdatei fehlt/);
    for (const l of [noDb.logs(), noConfig.logs()]) assert.ok(!l.includes('musterfirma') && !/PHP (Warning|Notice|Deprecated|Fatal)/.test(l));
  } finally {
    await noDb.stop(); await noConfig.stop(); await g2.stop();
  }
});

test('Kein Identitäts- oder Session-Spoofing: Formularfelder überschreiben keine Identität, fremde oder fixierte Session-IDs tragen keine Anmeldung', { skip }, async () => {
  reset();
  /* Vom Angreifer erfundene Session-ID wird nicht übernommen (session.use_strict_mode) */
  const invented = 'pxwaangreifer0123456789abcdefgh';
  const v1 = new Client(app.base);
  v1.cookies.set('pxwa', invented);
  await v1.req('GET', '/anfrage.php');
  assert.notEqual(v1.cookies.get('pxwa'), invented, 'erfundene Session-ID wird ersetzt');
  /* Session-Fixation: Angreifer schiebt eine echte, gültige Session-ID unter; nach dem Login gilt sie nicht mehr */
  const attacker = new Client(app.base);
  await attacker.req('GET', '/anfrage.php');
  const victim = new Client(app.base);
  victim.cookies.set('pxwa', attacker.cookies.get('pxwa'));
  await login(victim, google);
  assert.notEqual(victim.cookies.get('pxwa'), attacker.cookies.get('pxwa'), 'neue Session-ID nach dem Login');
  const stolen = await attacker.req('GET', '/anfrage.php');
  assert.ok(!/name="idem"/.test(stolen.text) && !stolen.text.includes(CUSTOMER), 'alte Session-ID trägt keine Anmeldung');
  assert.equal((await confirm(attacker)).res.status, 403);
  /* Untergeschobene Formularfelder ändern weder E-Mail, Google-Kennung, Website noch Referenz */
  const page = await victim.req('GET', '/anfrage.php');
  const res = await victim.req('POST', '/anfrage.php', { form: {
    action: 'confirm', csrf: field(page.text, 'csrf'), idem: field(page.text, 'idem'), zustimmung: '1',
    email: 'angreifer@beispiel-kunde.de', sub: '999', google_sub: '999', website: 'https://andere-firma.de', url: 'https://andere-firma.de', reference: 'PXA-AAAA-AAAA', 'identity[email]': 'angreifer@beispiel-kunde.de',
  } });
  assert.equal(res.status, 303);
  const [o] = orders();
  assert.deepEqual([o.email, o.google_sub, o.website_url], [CUSTOMER, '100000000000000000001', 'https://musterfirma.de']);
  assert.notEqual(o.reference, 'PXA-AAAA-AAAA');
  assert.equal(smtp.state.accepted.length, 1);
  assert.deepEqual(smtp.state.accepted[0].rcpt, [NOTIFY_TO]);
  assert.ok(!decodeMail(smtp.state.accepted[0].data).text.includes('angreifer'));
});

test('HTTPS-Basis-URL: __Host-Session-Cookie (Secure, HttpOnly, SameSite=Lax, Path=/, ohne Domain), HSTS und Sicherheits-Header; Ablauf funktioniert', { skip }, async () => {
  reset();
  const g = await mockGoogle().start();
  const s = await startApp({ google: g, smtp, scheme: 'https', db: 'sqlite' });
  try {
    const c = new Client(s.url, { origin: s.base });
    const first = await c.req('GET', '/anfrage.php');
    const [cookie] = first.headers.getSetCookie();
    assert.match(cookie, /^__Host-pxwa=[^;]+;/);
    assert.match(cookie, /;\s*path=\/(;|$)/i);
    assert.match(cookie, /;\s*secure(;|$)/i);
    assert.match(cookie, /;\s*HttpOnly(;|$)/i);
    assert.match(cookie, /;\s*SameSite=Lax(;|$)/i);
    assert.ok(!/domain=|expires=|max-age=/i.test(cookie), 'kein Domain-Attribut, nur Sitzungsdauer');
    const h = first.headers;
    assert.equal(h.get('strict-transport-security'), 'max-age=31536000');
    assert.match(h.get('content-security-policy'), /^default-src 'none';.*form-action 'self' https:\/\/accounts\.google\.com;.*frame-ancestors 'none'; base-uri 'none'$/);
    assert.equal(h.get('x-frame-options'), 'DENY');
    assert.equal(h.get('x-content-type-options'), 'nosniff');
    assert.equal(h.get('referrer-policy'), 'same-origin');
    assert.equal(h.get('cross-origin-opener-policy'), 'same-origin');
    assert.match(h.get('permissions-policy'), /camera=\(\)/);
    assert.equal(h.get('cache-control'), 'no-store');
    assert.equal(h.get('x-powered-by'), null);
    assert.equal(h.get('access-control-allow-origin'), null, 'keine CORS-Freigabe');
    /* Formular-POST mit http-Origin passt nicht zur https-Basis-URL */
    const plain = await new Client(s.url).req('POST', '/anfrage.php', { form: { action: 'start', website: 'musterfirma.de' } });
    assert.equal(plain.status, 403);
    const sid0 = c.cookies.get('__Host-pxwa');
    const { callback } = await login(c, g);
    assert.equal(callback.status, 303);
    assert.equal(callback.location, `${s.base}/anfrage.php`);
    assert.ok(c.cookies.get('__Host-pxwa') && c.cookies.get('__Host-pxwa') !== sid0, 'Session-Wechsel auch mit __Host-Cookie');
    assert.equal((await confirm(c)).res.status, 303);
    assert.equal(s.sql('SELECT COUNT(*) AS n FROM orders')[0].n, 1);
    assert.equal(smtp.state.accepted.length, 1);
    assert.ok(c.setCookies.every(x => /;\s*secure/i.test(x) && /^__Host-/.test(x)), 'alle Cookies Secure mit __Host-Präfix');
  } finally {
    await s.stop(); await g.stop();
    smtp.state.accepted.length = 0;
  }
});

test('Öffentliche Routen: Dateien außerhalb von public/ werden über HTTP nicht ausgeliefert (php -S; LiteSpeed-Verhalten nicht geprüft)', { skip }, async () => {
  /* php -S liefert für unbekannte Pfade die index.html aus – geprüft wird daher, dass der Inhalt der Datei nicht ankommt */
  const markers = {
    '/vision.html': readFileSync(join(ROOT, 'vision.html'), 'utf8').slice(0, 400),
    '/DESIGN.md': readFileSync(join(ROOT, 'DESIGN.md'), 'utf8').slice(0, 200),
    '/STRUCTURE.md': readFileSync(join(ROOT, 'STRUCTURE.md'), 'utf8').slice(0, 200),
    '/server/bootstrap.php': 'spl_autoload_register',
    '/server/config.example.php': 'client_secret',
    '/server/schema/mysql.sql': 'CREATE TABLE',
    '/bin/migrate.php': 'migrate()',
    '/tests/server.test.mjs': 'node:test',
    '/.git/HEAD': 'ref: refs/heads/',
    '/.gitignore': 'server/config.php',
  };
  for (const [path, marker] of Object.entries(markers)) {
    const text = await (await fetch(app.url + path, { redirect: 'manual' })).text();
    assert.ok(!text.includes(marker), `${path} wird nicht ausgeliefert`);
  }
  for (const path of ['/index.html', '/pruefkriterien.html', '/assets/styles.css', '/assets/anfrage.css', '/assets/app.js']) {
    assert.equal((await fetch(app.url + path)).status, 200, path);
  }
});

test('Hauptnavigation: Anfrageseiten verlinken dieselben Bereiche in derselben Reihenfolge wie die Methodikseite', { skip }, async () => {
  const links = html => [...(html.match(/<div class="nav-links">([\s\S]*?)<\/div>/) || ['', ''])[1].matchAll(/href="([^"]+)">([^<]+)</g)].map(m => [m[1].replace(/^.*index\.html/, 'index.html'), m[2]]);
  const methodik = links(await (await fetch(app.url + '/pruefkriterien.html')).text());
  const anfrage = links((await new Client(app.base).req('GET', '/anfrage.php')).text);
  assert.ok(methodik.length >= 4);
  assert.deepEqual(anfrage, methodik);
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
