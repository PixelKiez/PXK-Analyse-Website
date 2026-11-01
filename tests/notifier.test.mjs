/* PXWA – interne Benachrichtigung über Resend (Mock nach dokumentiertem Vertrag), Outbox, Cron, Produktionskonfiguration
   und Löschfrist; API-Worker in workerd (Miniflare) mit lokaler D1. Ausführen im Repo-Root nach `npm ci`:
   node --test tests/notifier.test.mjs   Echte Provider (Google, Resend, Cloudflare-D1) werden hier NICHT getestet. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mockGoogle, mockResend, startWorker, resendOutbound, Client, login, begin, startForm, waitFor, sleep, workerAvailable, CUSTOMER, NOTIFY_TO, MAIL_FROM, MAIL_TOKEN, PRODUCTION_BASE } from './lib/harness.mjs';

const skip = workerAvailable ? false : 'NOT_RUN: miniflare/esbuild fehlen (npm ci)';
let google, mail, app;

before(async () => {
  if (skip) return;
  google = await mockGoogle().start();
  mail = await mockResend().start();
  app = await startWorker({ google, mail });
});
after(async () => {
  if (skip) return;
  await app.stop(); await google.stop(); await mail.stop();
});

const orders = () => app.sql('SELECT * FROM orders ORDER BY id');
const reset = async () => { await app.exec('DELETE FROM notifications; DELETE FROM orders; DELETE FROM rate_limits; DELETE FROM sessions'); mail.reset(); };
/* Die erste Zustellung läuft nach der Antwort (waitUntil): warten, bis die Benachrichtigung nicht mehr unbearbeitet ist */
const settled = (timeout = 5000) => waitFor(async () => (await app.sql("SELECT COUNT(*) AS n FROM notifications WHERE status = 'sending' OR (status = 'pending' AND attempts = 0)"))[0].n === 0, { what: 'Zustellung', timeout });
const due = () => app.run("UPDATE notifications SET next_attempt_at = '2000-01-01 00:00:00', locked_until = NULL WHERE status <> 'sent'");

test('Fehlgeschlagener Mailversand: Auftrag bleibt gespeichert und bestätigt; Cron versendet genau einmal nach', { skip }, async () => {
  await reset();
  mail.state.mode = 'fail';
  const c = new Client(app);
  assert.equal((await login(c, google)).callback.status, 303);
  assert.match((await c.req('GET', '/api/anfrage')).text, /Ihre Anfrage liegt bei uns/, 'Annahme hängt an der Speicherung, nicht am Mailversand');
  await settled();
  assert.deepEqual(await app.sql('SELECT status, attempts, last_error FROM notifications'), [{ status: 'pending', attempts: 1, last_error: 'temporary:503:service_unavailable' }]);
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

test('Vorübergehender Fehler der Mail-API (503): kontrollierte Wiederholung mit Backoff, nach zehn Versuchen endgültig fehlgeschlagen', { skip }, async () => {
  await reset();
  mail.state.mode = 'fail';
  const c = new Client(app);
  assert.equal((await login(c, google)).callback.status, 303);
  await settled();
  const [n] = await app.sql("SELECT status, attempts, last_error, next_attempt_at > datetime('now', '+4 minutes') AS later FROM notifications");
  assert.deepEqual(n, { status: 'pending', attempts: 1, last_error: 'temporary:503:service_unavailable', later: 1 });
  for (let i = 2; i <= 10; i++) {
    await due();
    await app.cron();
  }
  assert.deepEqual(await app.sql('SELECT status, attempts FROM notifications'), [{ status: 'failed', attempts: 10 }]);
  await due();
  await app.cron();
  assert.equal(mail.state.attempts, 10, 'kein elfter Versuch');
  assert.match(app.logs(), /Versuch 10, endgültig\)/);
  assert.equal((await orders()).length, 1, 'Auftrag bleibt gespeichert');
});

test('Mail-API lehnt dauerhaft ab (401, 403, 422): sofort „failed“ ohne automatische Wiederholung; Auftrag bleibt; nach Korrektur manuell neu eingereiht genau eine Mail', { skip }, async () => {
  for (const [i, [mode, code]] of [['auth', 'permanent:401:validation_error'], ['forbidden', 'permanent:403:validation_error'], ['reject', 'permanent:422:validation_error']].entries()) {
    await reset();
    mail.state.mode = mode;
    const before = app.logs().length;
    const c = new Client(app, { ip: `198.51.100.${60 + i}` });
    assert.equal((await login(c, google, { website: `firma-${mode}.de` })).callback.status, 303, mode);
    assert.match((await c.req('GET', '/api/anfrage')).text, /Ihre Anfrage liegt bei uns/, `${mode}: Annahme hängt nicht an Resend`);
    await settled();
    assert.deepEqual(await app.sql('SELECT status, attempts, last_error, sent_at FROM notifications'), [{ status: 'failed', attempts: 1, last_error: code, sent_at: null }], `${mode}: überprüfbarer Status in D1`);
    assert.match(app.logs().slice(before), /Versuch 1, dauerhaft abgelehnt – keine automatische Wiederholung, Konfiguration prüfen\)/, mode);
    /* Auch wenn die Zeile fällig wäre: der Cron wiederholt dauerhafte Fehler nicht */
    for (let k = 0; k < 3; k++) { await due(); assert.match((await app.cron()).log, /PXWA: 0 versendet, 0 fehlgeschlagen/, mode); }
    assert.equal(mail.state.attempts, 1, `${mode}: genau ein Versuch, keine sinnlose Wiederholung`);
    assert.deepEqual((await orders()).map(o => o.website_url), [`https://firma-${mode}.de`], `${mode}: Auftrag bleibt unverändert`);
  }
  /* Nach Korrektur der Konfiguration (docs/deploy-cloudflare-pages.md, Abschnitt 8): manuell neu einreihen */
  mail.state.mode = 'ok';
  await app.run("UPDATE notifications SET status = 'pending', next_attempt_at = '2000-01-01 00:00:00' WHERE status = 'failed' AND last_error LIKE 'permanent:%'");
  assert.match((await app.cron()).log, /PXWA: 1 versendet, 0 fehlgeschlagen/);
  assert.deepEqual(await app.sql('SELECT status, attempts, last_error FROM notifications'), [{ status: 'sent', attempts: 2, last_error: null }]);
  assert.equal(mail.state.accepted.length, 1, 'genau eine Mail');
});

test('Benachrichtigung scheitert nach der Speicherung an der Datenbank: Annahme bleibt bestätigt, keine Fehlerseite, Cron versendet genau einmal', { skip }, async () => {
  await reset();
  const c = new Client(app);
  const { callbackPath } = await begin(c, google);
  /* Auftrag und Outbox-Eintrag werden gespeichert; erst das Beanspruchen der Benachrichtigung (UPDATE) schlägt fehl */
  await app.run("CREATE TRIGGER pxwa_test_block BEFORE UPDATE ON notifications BEGIN SELECT RAISE(ABORT, 'pxwa test'); END");
  const before = app.logs().length;
  let res;
  try {
    res = await c.req('GET', callbackPath);
    await waitFor(() => app.logs().slice(before).includes('nicht sofort abgeschlossen'), { what: 'Log der verschobenen Zustellung' });
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

/* Gültige Produktionskonfiguration: echte Google-Endpunkte, Resend, Absender aus notify.pixelkiez.de, freigegebene Datenschutz-Version */
const PROD = {
  ENV: 'production', BASE_URL: PRODUCTION_BASE, GOOGLE_TOKEN_ENDPOINT: undefined, GOOGLE_JWKS_URI: undefined, GOOGLE_AUTH_ENDPOINT: undefined,
  MAIL_API_URL: 'https://api.resend.com/emails', MAIL_FROM: 'benachrichtigung@notify.pixelkiez.de', PRIVACY_VERSION: '2026-11-01', TERMS_VERSION: 'AGB-2026-11-01',
};
/* Hero-Formular gegen die Produktionskonfiguration (dort freigegebene AGB-Version) */
const prodStart = () => startForm({ agbVersion: PROD.TERMS_VERSION });

test('Produktion: gültige Konfiguration wird angenommen – Basis-URL 360.pixelkiez.de, Google-Callback /api/auth/callback, __Host-Cookie; ohne Aufträge kein Aufruf von Resend', { skip }, async () => {
  const w = await startWorker({ base: PRODUCTION_BASE, env: PROD });
  try {
    const c = new Client(w);
    assert.equal((await c.req('GET', '/api/anfrage')).status, 200);
    const start = await c.req('POST', '/api/anfrage', { form: prodStart() });
    assert.equal(start.status, 303);
    const auth = new URL(start.location);
    assert.equal(auth.origin + auth.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(auth.searchParams.get('redirect_uri'), 'https://360.pixelkiez.de/api/auth/callback');
    assert.match(start.headers.getSetCookie()[0], /^__Host-pxwa=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=3600; HttpOnly; SameSite=Lax; Secure$/);
    const run = await w.cron();
    assert.equal(run.outcome, 'ok');
    assert.match(run.log, /0 versendet, 0 fehlgeschlagen, 0 übersprungen\..*Löschfrist nicht aktiv/);
  } finally {
    await w.stop();
  }
});

test('Produktion: falscher Mail-Anbieter oder Pfad, fremder Absender, Datenschutz- oder AGB-Entwurf, Test-Endpunkte, andere Domain oder ungültige Löschfrist sperren die API (fail closed)', { skip }, async () => {
  const variants = [
    ['Mail-API nicht Resend', { MAIL_API_URL: 'https://api.mail-anbieter.example.net/emails' }, /MAIL_API_URL/],
    ['Resend mit falschem Pfad', { MAIL_API_URL: 'https://api.resend.com/v1/send' }, /MAIL_API_URL/],
    ['Absender außerhalb von notify.pixelkiez.de', { MAIL_FROM: 'analyse@pixelkiez.de' }, /MAIL_FROM/],
    ['Empfängerpostfach als Absender', { MAIL_FROM: '360@pixelkiez.de' }, /MAIL_FROM/],
    ['Datenschutzerklärung nur als Entwurf', { PRIVACY_VERSION: 'ENTWURF-2026-10-31' }, /PRIVACY_VERSION/],
    ['AGB nur als Entwurf', { TERMS_VERSION: 'ENTWURF-2026-10-31' }, /TERMS_VERSION/],
    ['AGB-Entwurf in Kleinschreibung', { TERMS_VERSION: 'entwurf-agb' }, /TERMS_VERSION/],
    ['AGB-Version fehlt', { TERMS_VERSION: undefined }, /TERMS_VERSION/],
    ['Mock-Google in Produktion', { GOOGLE_TOKEN_ENDPOINT: 'http://127.0.0.1:9/token', GOOGLE_JWKS_URI: 'http://127.0.0.1:9/certs' }, /GOOGLE_TOKEN_ENDPOINT, GOOGLE_JWKS_URI/],
    ['andere Domain', { BASE_URL: 'https://360.beispiel-domain.de' }, /BASE_URL/],
    ['pages.dev statt eigener Domain', { BASE_URL: 'https://pxwa.pages.dev' }, /BASE_URL/],
    ['http in Produktion', { BASE_URL: 'http://360.pixelkiez.de' }, /BASE_URL/],
    ['Platzhalter-Domain', { BASE_URL: 'https://DOMAIN-FEHLT.example' }, /BASE_URL/],
    ['ungültige Löschfrist', { ORDER_RETENTION_DAYS: '0' }, /ORDER_RETENTION_DAYS/],
  ];
  for (const [name, env, key] of variants) {
    mail.reset();
    const w = await startWorker({ base: env.BASE_URL ?? PRODUCTION_BASE, env: { ...PROD, ...env } });
    try {
      const r = await new Client(w).req('POST', '/api/anfrage', { form: prodStart() });
      assert.equal(r.status, 503, name);
      assert.equal(r.location, null, `${name}: keine Weiterleitung`);
      assert.equal((await w.cron()).outcome, 'exception', `${name}: Cron versendet nichts`);
      await waitFor(() => key.test(w.logs()), { what: `Log ${name}` });
      assert.equal(mail.state.attempts, 0, `${name}: kein Aufruf der Mail-API`);
    } finally {
      await w.stop();
    }
  }
});

test('Produktion: interner Empfänger ausschließlich 360@pixelkiez.de – jede andere Adresse, auch die frühere kontakt@pixelkiez.de, sperrt die API (503, kein Cron-Versand, kein Aufruf von Resend)', { skip }, async () => {
  const variants = [
    ['frühere Adresse (kein Rückfall)', 'kontakt@pixelkiez.de'], ['anderes Postfach', 'info@pixelkiez.de'], ['andere Domain', '360@pixelkiez.com'],
    ['Versanddomain statt Postfach', '360@notify.pixelkiez.de'], ['verworfene Adresse auf der Subdomain', 'analyse@360.pixelkiez.de'],
    ['verworfene Mail-Subdomain', 'analyse@mail.360.pixelkiez.de'], ['angehängte Fremddomain', '360@pixelkiez.de.example.net'],
    ['Subdomain-Präfix', '360@mail.pixelkiez.de'], ['Plus-Adresse', '360+test@pixelkiez.de'], ['andere Ziffern', '3600@pixelkiez.de'],
    ['neue und frühere Adresse (Doppelzustellung)', '360@pixelkiez.de,kontakt@pixelkiez.de'], ['zwei Empfänger mit Semikolon', '360@pixelkiez.de;kontakt@pixelkiez.de'],
    ['zwei Empfänger', '360@pixelkiez.de,angreifer@example.net'], ['Anzeigename', 'Pixelkiez <360@pixelkiez.de>'], ['mailto-Schema', 'mailto:360@pixelkiez.de'],
    ['Kopfzeilen-Injektion', '360@pixelkiez.de\r\nBcc: angreifer@example.net'],
    ['Unicode-Doppelgänger (Kelvin-Zeichen U+212A)', '360@pixel\u212Aiez.de'], ['Unicode-Doppelgänger (kyrillisches е)', '360@pixelkiez.de'.replace('e', '\u0435')],
    ['Unicode-Doppelgänger (punktloses ı)', '360@p\u0131xelkiez.de'], ['Unicode-Doppelgänger (Vollbreiten-Ziffern)', '\uFF13\uFF16\uFF10@pixelkiez.de'],
    ['Unicode-Doppelgänger (arabisch-indische Ziffern)', '\u0663\u0666\u0660@pixelkiez.de'], ['Unicode-Doppelgänger (Vollbreiten-@)', '360\uFF20pixelkiez.de'],
    ['unsichtbares Zeichen (Zero-Width Space)', '360@pixel\u200Bkiez.de'], ['weiches Trennzeichen', '360@pixel\u00ADkiez.de'],
    ['nachgestellter Punkt', '360@pixelkiez.de.'], ['leer', ''], ['nicht gesetzt', undefined],
  ];
  for (const [name, to] of variants) {
    mail.reset();
    const w = await startWorker({ base: PRODUCTION_BASE, env: { ...PROD, MAIL_NOTIFY_TO: to }, outbound: resendOutbound(mail) });
    try {
      const r = await new Client(w).req('POST', '/api/anfrage', { form: prodStart() });
      assert.equal(r.status, 503, name);
      assert.equal(r.location, null, `${name}: keine Weiterleitung`);
      assert.match(r.text, /Gerade nicht verfügbar/, `${name}: sichere Fehlerseite`);
      /* Der Footer der Fehlerseite verlinkt öffentlich mailto:360@pixelkiez.de; außerhalb davon steht der konfigurierte Wert nirgends */
      const body = r.text.replaceAll('href="mailto:360@pixelkiez.de"', '');
      assert.ok(!body.includes('MAIL_NOTIFY_TO') && !(to && body.includes(to)), `${name}: Antwort nennt weder Schlüssel noch Adresse`);
      assert.equal((await w.cron()).outcome, 'exception', `${name}: Cron versendet nichts`);
      await waitFor(() => /Ungültige oder fehlende Werte: MAIL_NOTIFY_TO/.test(w.logs()), { what: `Log ${name}` });
      assert.ok(!(to && w.logs().includes(to)), `${name}: Log nennt nur den Schlüssel, nie den Wert`);
      assert.equal(mail.state.attempts, 0, `${name}: kein Aufruf der Mail-API`);
    } finally {
      await w.stop();
    }
  }
});

test('Produktion: Groß-/Kleinschreibung von 360@pixelkiez.de wird angenommen; versendet wird immer genau einmal an die kleingeschriebene Adresse über api.resend.com', { skip }, async () => {
  for (const to of ['360@pixelkiez.de', '360@PixelKiez.de', '360@PIXELKIEZ.DE']) {
    mail.reset();
    const w = await startWorker({ base: PRODUCTION_BASE, env: { ...PROD, MAIL_NOTIFY_TO: to }, outbound: resendOutbound(mail) });
    try {
      assert.equal((await new Client(w).req('POST', '/api/anfrage', { form: prodStart() })).status, 303, `${to}: Konfiguration angenommen`);
      await w.run("INSERT INTO orders (reference, idempotency_key, google_sub, email, website_url, privacy_version, created_at) VALUES ('PXA-TEST-0001', 'k1', 's', ?1, 'https://firma.de', '2026-11-01', '2026-11-01 10:00:00')", CUSTOMER);
      await w.run("INSERT INTO notifications (order_id, next_attempt_at, created_at) SELECT id, '2000-01-01 00:00:00', created_at FROM orders");
      assert.match((await w.cron()).log, /PXWA: 1 versendet, 0 fehlgeschlagen/, to);
      assert.equal(mail.state.accepted.length, 1, to);
      assert.deepEqual(mail.state.accepted[0].to, ['360@pixelkiez.de'], `${to}: kanonischer Empfänger, keine zweite Adresse`);
      assert.equal(mail.state.accepted[0].from, PROD.MAIL_FROM);
    } finally {
      await w.stop();
    }
  }
});

test('Cron-Aufräumen: abgelaufene Sessions und alte Rate-Limit-Fenster werden gelöscht, Aufträge bleiben', { skip }, async () => {
  await reset();
  const c = new Client(app);
  assert.equal((await login(c, google)).callback.status, 303);
  await settled();
  await app.run("INSERT INTO sessions (id_hash, data, version, created_at, expires_at) VALUES ('alt', '{\"csrf\":\"x\"}', 0, 1, 2)");
  await app.run("INSERT INTO rate_limits (bucket, window_start, hits) VALUES ('start:alt', 1, 1)");
  const run = await app.cron();
  assert.match(run.log, /1 Sessions und 1 Rate-Limit-Fenster gelöscht/);
  assert.deepEqual((await app.sql('SELECT id_hash FROM sessions')).map(r => r.id_hash).includes('alt'), false);
  assert.equal((await orders()).length, 1);
});

test('Resend-Vertrag: POST /emails mit Bearer-Token, User-Agent, JSON und Idempotency-Key; Antwort-ID im Log, keine Adressen im Log', { skip }, async () => {
  await reset();
  const c = new Client(app);
  assert.equal((await login(c, google, { website: 'https://www.musterfirma.de' })).callback.status, 303);
  await settled();
  const [o] = await orders();
  assert.equal(mail.state.requests.length, 1);
  const { headers, raw } = mail.state.requests[0];
  assert.equal(headers.authorization, `Bearer ${MAIL_TOKEN}`);
  assert.match(headers['content-type'], /^application\/json/);
  assert.match(headers['user-agent'], /^pxwa-api\/1 /, 'User-Agent ist Pflicht (sonst 403 bei Resend)');
  assert.equal(headers['idempotency-key'], `pxwa-${o.reference}`);
  assert.ok(headers['idempotency-key'].length <= 256);
  const body = JSON.parse(raw);
  assert.deepEqual(Object.keys(body).sort(), ['from', 'reply_to', 'subject', 'text', 'to']);
  assert.deepEqual([body.from, body.to, body.reply_to, body.subject], [MAIL_FROM, [NOTIFY_TO], CUSTOMER, `Neue Analyse-Anfrage ${o.reference}`]);
  const id = mail.state.accepted[0].id;
  assert.match(app.logs(), new RegExp(`Benachrichtigung zu ${o.reference} von der Mail-API angenommen \\(ID ${id}\\)`));
  assert.ok(!app.logs().includes(CUSTOMER) && !app.logs().includes('musterfirma'));
});

test('Resend-Fehler: vorübergehende Fehler mit Backoff wiederholt, dauerhafte sofort „failed“; Auftrag bleibt angenommen; gespeichert wird nur der feste Fehlername', { skip }, async () => {
  const cases = [
    ['auth', 'failed', 'permanent:401:validation_error'], ['forbidden', 'failed', 'permanent:403:validation_error'], ['reject', 'failed', 'permanent:422:validation_error'],
    ['ratelimit', 'pending', 'temporary:429:rate_limit_exceeded'], ['quota', 'pending', 'temporary:429:daily_quota_exceeded'], ['busy', 'pending', 'temporary:409:concurrent_idempotent_requests'],
    ['error', 'pending', 'temporary:500:application_error'], ['fail', 'pending', 'temporary:503:service_unavailable'], ['drop', 'pending', 'connect'],
  ];
  for (const [i, [mode, status, code]] of cases.entries()) {
    await reset();
    mail.state.mode = mode;
    const c = new Client(app, { ip: `198.51.100.${150 + i}` });
    assert.equal((await login(c, google, { website: `firma-${mode}.de` })).callback.status, 303, mode);
    assert.match((await c.req('GET', '/api/anfrage')).text, /Ihre Anfrage liegt bei uns/, `${mode}: Annahme hängt nicht an Resend`);
    await settled();
    const [n] = await app.sql("SELECT status, attempts, last_error, next_attempt_at > datetime('now', '+4 minutes') AS later FROM notifications");
    assert.deepEqual(n, { status, attempts: 1, last_error: code, later: 1 }, mode);
    assert.equal((await orders()).length, 1, `${mode}: Auftrag bleibt gespeichert`);
    await due();
    await app.cron();
    assert.equal(mail.state.attempts, status === 'failed' ? 1 : 2, `${mode}: ${status === 'failed' ? 'keine' : 'eine'} automatische Wiederholung`);
  }
  assert.ok(!app.logs().includes('Invalid `to` field'), 'Freitext von Resend (kann Adressen enthalten) landet nicht im Log');
  /* Gleicher Key mit anderem Inhalt (z. B. nach Konfigurationsänderung): 409 invalid_idempotent_request, dauerhaft */
  await reset();
  mail.state.mode = 'fail';
  const c = new Client(app);
  assert.equal((await login(c, google)).callback.status, 303);
  await settled();
  mail.state.mode = 'ok';
  mail.state.keys.set(`pxwa-${(await orders())[0].reference}`, { raw: '{}', id: 'alt' });
  await due();
  await app.cron();
  assert.deepEqual(await app.sql('SELECT status, last_error FROM notifications'), [{ status: 'failed', last_error: 'permanent:409:invalid_idempotent_request' }]);
  await due();
  await app.cron();
  assert.equal(mail.state.attempts, 2, 'keine Wiederholung nach dauerhaftem Fehler');
  assert.equal((await orders()).length, 1);
});

test('Antwort von Resend geht verloren (Verbindungsabbruch, Zeitüberschreitung): Wiederholung mit gleichem Idempotency-Key, genau eine Mail je Auftrag', { skip }, async () => {
  await reset();
  mail.state.mode = 'drop';
  const a = new Client(app, { ip: '198.51.100.31' });
  assert.equal((await login(a, google, { website: 'firma-abbruch.de' })).callback.status, 303);
  await settled();
  mail.state.mode = 'hang';
  const b = new Client(app, { ip: '198.51.100.32' });
  assert.equal((await login(b, google, { website: 'firma-zeitueberschreitung.de' })).callback.status, 303);
  await settled(25000);
  assert.deepEqual((await app.sql('SELECT last_error FROM notifications ORDER BY id')).map(r => r.last_error), ['connect', 'timeout']);
  assert.equal(mail.state.accepted.length, 2, 'Resend hatte beide Mails angenommen, die Antworten gingen verloren');
  mail.state.mode = 'ok';
  await due();
  assert.match((await app.cron()).log, /2 versendet, 0 fehlgeschlagen/);
  assert.equal(mail.state.accepted.length, 2, 'Wiederholung erzeugt keine zweite Mail (Idempotency-Key)');
  assert.equal(mail.state.attempts, 4);
  assert.deepEqual(await app.sql('SELECT status, attempts FROM notifications ORDER BY id'), [{ status: 'sent', attempts: 2 }, { status: 'sent', attempts: 2 }]);
});

test('Resend nimmt an, Speichern des Status in D1 scheitert: Benachrichtigung bleibt fällig, Wiederholung ohne zweite Mail', { skip }, async () => {
  await reset();
  const c = new Client(app);
  const { callbackPath } = await begin(c, google);
  const before = app.logs().length;
  await app.run("CREATE TRIGGER pxwa_test_sent BEFORE UPDATE OF status ON notifications WHEN NEW.status = 'sent' BEGIN SELECT RAISE(ABORT, 'pxwa test'); END");
  try {
    assert.equal((await c.req('GET', callbackPath)).status, 303);
    await waitFor(() => app.logs().slice(before).includes('nicht sofort abgeschlossen'), { what: 'Log' });
  } finally {
    await app.run('DROP TRIGGER pxwa_test_sent');
  }
  assert.equal(mail.state.accepted.length, 1);
  assert.deepEqual(await app.sql('SELECT status, attempts FROM notifications'), [{ status: 'sending', attempts: 1 }], 'bleibt beansprucht, bis die Sperre abläuft');
  assert.match((await app.cron()).log, /0 versendet, 0 fehlgeschlagen/, 'während der Sperre kein zweiter Versuch');
  await due();
  assert.match((await app.cron()).log, /1 versendet/);
  assert.equal(mail.state.accepted.length, 1, 'genau eine Mail');
  assert.equal(mail.state.attempts, 2);
  assert.deepEqual(await app.sql('SELECT status, attempts FROM notifications'), [{ status: 'sent', attempts: 2 }]);
});

test('Parallele Zustellversuche und Cron-Fehler: gleichzeitige Cron-Läufe senden genau einmal; ein D1-Fehler hält andere Benachrichtigungen nicht auf', { skip }, async () => {
  await reset();
  mail.state.mode = 'fail';
  for (const [i, site] of ['firma-eins.de', 'firma-zwei.de'].entries()) {
    const c = new Client(app, { ip: `198.51.100.${40 + i}` });
    assert.equal((await login(c, google, { website: site })).callback.status, 303);
  }
  await settled();
  mail.state.mode = 'ok';
  const [first, second] = await orders();
  await due();
  await app.run(`CREATE TRIGGER pxwa_test_one BEFORE UPDATE ON notifications WHEN OLD.order_id = ${first.id} BEGIN SELECT RAISE(ABORT, 'pxwa test'); END`);
  try {
    const runs = await Promise.all([app.cron(), app.cron(), app.cron()]);
    assert.ok(runs.every(r => r.outcome === 'ok'), 'Cron bricht nicht ab');
  } finally {
    await app.run('DROP TRIGGER pxwa_test_one');
  }
  assert.deepEqual(mail.state.accepted.map(m => m.subject), [`Neue Analyse-Anfrage ${second.reference}`], 'zweite Benachrichtigung genau einmal versendet');
  assert.equal(mail.state.attempts - 2, 1, 'parallele Läufe: nur ein Versuch');
  assert.match(app.logs(), /Zustellung der Benachrichtigung \d+ unterbrochen/);
  await due();
  await app.cron();
  assert.deepEqual((await app.sql('SELECT status FROM notifications ORDER BY id')).map(r => r.status), ['sent', 'sent']);
  assert.equal(mail.state.accepted.length, 2);
});

test('Löschfrist: ohne ORDER_RETENTION_DAYS löscht der Cron keine Aufträge; mit Frist nur erledigte und alte – offene Aufträge bleiben', { skip }, async () => {
  const seed = async w => {
    await w.exec('DELETE FROM notifications; DELETE FROM orders');
    for (const [ref, status, created] of [['PXA-AAAA-0001', 'completed', '2000-01-01 00:00:00'], ['PXA-AAAA-0002', 'received', '2000-01-01 00:00:00'], ['PXA-AAAA-0003', 'completed', new Date().toISOString().slice(0, 19).replace('T', ' ')]]) {
      await w.run("INSERT INTO orders (reference, idempotency_key, google_sub, email, website_url, privacy_version, status, created_at) VALUES (?1, ?1, 's', 'k@beispiel-kunde.de', 'https://firma.de', 'TEST', ?2, ?3)", ref, status, created);
      await w.run("INSERT INTO notifications (order_id, status, attempts, next_attempt_at, created_at) SELECT id, 'sent', 1, created_at, created_at FROM orders WHERE reference = ?1", ref);
    }
  };
  await seed(app);
  assert.match((await app.cron()).log, /Löschfrist nicht aktiv/);
  assert.equal((await orders()).length, 3);
  const w = await startWorker({ google, mail, env: { ORDER_RETENTION_DAYS: '30' } });
  try {
    await seed(w);
    assert.match((await w.cron()).log, /1 erledigte Aufträge gelöscht/);
    assert.deepEqual((await w.sql('SELECT reference FROM orders ORDER BY id')).map(r => r.reference), ['PXA-AAAA-0002', 'PXA-AAAA-0003'], 'offener alter Auftrag bleibt');
    assert.equal((await w.sql('SELECT COUNT(*) AS n FROM notifications'))[0].n, 2);
  } finally {
    await w.stop();
  }
  await reset();
});

test('Worker-Log: keine unbehandelten Ausnahmen über alle Abläufe', { skip }, async () => {
  await sleep(100);
  assert.deepEqual(app.logs().split('\n').filter(l => /Uncaught|Unerwarteter Fehler|TypeError|ReferenceError/.test(l)), []);
});
