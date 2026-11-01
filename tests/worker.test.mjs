/* PXWA – Integrationstests des API-Workers in workerd (Miniflare) mit lokaler D1 und lokalen Mocks.
   Ausführen im Repo-Root nach `npm ci`:  node --test tests/worker.test.mjs
   Echte Provider (Google, Resend, Cloudflare-D1) werden hier NICHT getestet; Resend ist ein Mock nach dessen dokumentiertem Vertrag.
   Ablauf (PXWA-BE-02): Hero mit Website + AGB-Häkchen → Google → Rückkehr legt den Auftrag an, ohne zweiten Klick. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mockGoogle, mockResend, startWorker, Client, login, begin, startForm, referenceOf, field, waitFor, sleep, workerAvailable,
  CLIENT_ID, CUSTOMER, NOTIFY_TO, MAIL_FROM, MAIL_TOKEN, TERMS_VERSION, MIGRATION,
} from './lib/harness.mjs';

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

const orders = (w = app) => w.sql('SELECT * FROM orders ORDER BY id');
const reset = async (w = app) => { await w.exec('DELETE FROM notifications; DELETE FROM orders; DELETE FROM rate_limits; DELETE FROM sessions'); mail.reset(); };
/* Aufträge, Outbox-Einträge und Aufrufe der Mail-API – für „kein Auftrag, keine Mail“ */
const counts = async (w = app) => ({
  orders: (await w.sql('SELECT COUNT(*) AS n FROM orders'))[0].n, outbox: (await w.sql('SELECT COUNT(*) AS n FROM notifications'))[0].n, mails: mail.state.attempts,
});
const NOTHING = { orders: 0, outbox: 0, mails: 0 };
const flowOf = async (w = app) => (await w.sql("SELECT json_extract(data, '$.oidc') AS f FROM sessions WHERE json_extract(data, '$.oidc') IS NOT NULL")).map(r => JSON.parse(r.f));
const utc = ts => new Date(ts * 1000).toISOString().slice(0, 19).replace('T', ' ');
/* Die erste Zustellung läuft nach der Antwort (waitUntil): warten, bis die Benachrichtigung nicht mehr unbearbeitet ist */
const settled = (w = app) => waitFor(async () => (await w.sql("SELECT COUNT(*) AS n FROM notifications WHERE status = 'sending' OR (status = 'pending' AND attempts = 0)"))[0].n === 0, { what: 'Zustellung' });
const isAccepted = html => /Ihre Anfrage liegt bei uns/.test(html) && Boolean(referenceOf(html));

/* ---------- Positivfall ---------- */

test('Website + AGB + Google: genau ein Free-Auftrag mit AGB-Version und Zustimmungszeitpunkt, genau eine Outbox-Benachrichtigung, Bestätigung mit Referenz ohne zweiten Klick', { skip }, async () => {
  await reset();
  const c = new Client(app);
  const first = await c.req('GET', '/api/anfrage');
  assert.equal(first.status, 200);
  assert.equal(c.cookies.size, 0, 'GET ohne Anfrage legt keine Session an');
  assert.match(first.text, /<input id="agb" type="checkbox" name="agb" value="1" required>/, 'Häkchen Pflicht und nicht vorausgewählt');
  assert.equal(field(first.text, 'agb_version'), TERMS_VERSION);
  assert.match(first.text, /href="\/agb\.html">AGB<\/a>/);
  assert.match(first.text, /href="\/datenschutz\.html">Datenschutzerklärung<\/a>/);
  assert.match(first.text, /type="submit">Analysieren<\/button>/);
  assert.match(first.text, /Kostenlose Website-Analyse – 0 €, kein Abo/);
  /* Datenhinweis wie der Ablauf: Website und AGB-Zustimmung liegen schon vor der Google-Anmeldung in der Session (siehe flow unten),
     Auftrag mit E-Mail-Adresse erst nach der Anmeldung, ohne abgeschlossene Anmeldung weder Auftrag noch Benachrichtigung */
  assert.match(first.text, /<li>Vor der Google-Anmeldung speichern wir Ihre Website-Adresse sowie Version und Zeitpunkt Ihrer Zustimmung zu den AGB vorübergehend in einer serverseitigen Sitzung\. Wird die Anmeldung nicht abgeschlossen, entsteht daraus kein Auftrag, und Pixelkiez erhält keine Benachrichtigung\.<\/li>/);
  assert.match(first.text, /<li>Erst nach erfolgreicher Google-Anmeldung und mit gültiger Zustimmung entsteht der eigentliche kostenlose Analyseauftrag\. Erst dann ordnen wir ihm Ihre von Google bestätigte E-Mail-Adresse und die Kennung Ihres Google-Kontos zu; dazu kommen der Zeitpunkt der Anfrage sowie Version und Zeitpunkt Ihrer Zustimmung zu den AGB\.<\/li>/);
  assert.doesNotMatch(first.text, /Erst nach der Google-Anmeldung speichern wir Ihre Website-Adresse/, 'keine Behauptung, die Website-Adresse werde erst nach der Anmeldung gespeichert');
  const t0 = Math.floor(Date.now() / 1000);
  const { start, auth, callbackPath } = await begin(c, google, { website: 'HTTPS://WWW.Musterfirma.DE/leistungen?utm_source=x#top' });
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
  assert.ok(!/musterfirma/i.test(start.location) && !/musterfirma/i.test(callbackPath), 'Website-Adresse steht in keiner GET-URL (weder zu Google noch im Callback)');
  /* Zustimmung serverseitig vor der Anmeldung: normalisierte Website, aktuelle Version, Serverzeit */
  const [flow] = await flowOf();
  assert.equal(flow.consent.url, 'https://www.musterfirma.de/leistungen', 'URL normalisiert, Query und Fragment verworfen');
  assert.equal(flow.consent.version, TERMS_VERSION);
  assert.ok(flow.consent.at >= t0 && flow.consent.at <= t0 + 5, 'Zeitpunkt vom Server');
  assert.deepEqual(await counts(), NOTHING, 'vor der Rückkehr von Google noch kein Auftrag');
  const callback = await c.req('GET', callbackPath);
  assert.equal(callback.status, 303);
  assert.equal(callback.location, `${app.base}/api/anfrage`);
  assert.notEqual(callback.headers.getSetCookie()[0].split(';')[0], sid0, 'Session-ID wird nach dem Login gewechselt');
  assert.ok(c.setCookies.every(s => /HttpOnly/i.test(s) && /SameSite=Lax/i.test(s) && /Max-Age=3600/i.test(s)), 'Cookies HttpOnly, SameSite=Lax, kurzlebig');
  const tokenCall = google.log.token.at(-1);
  assert.ok(tokenCall.code_verifier && tokenCall.client_secret, 'Code-Austausch mit PKCE-Verifier serverseitig');
  const done = await c.req('GET', '/api/anfrage');
  const ref = referenceOf(done.text);
  assert.ok(ref, 'Referenz wird angezeigt');
  assert.ok(isAccepted(done.text));
  assert.match(done.text, /https:\/\/www\.musterfirma\.de\/leistungen</);
  assert.ok(!/<form|type="checkbox"|name="idem"|Anfrage bestätigen/.test(done.text), 'keine zweite Bestätigung');
  assert.match(done.headers.get('content-security-policy'), /default-src 'none'.*frame-ancestors 'none'/);
  assert.equal(done.headers.get('cache-control'), 'no-store');
  const rows = await orders();
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['created_at', 'email', 'google_sub', 'id', 'idempotency_key', 'privacy_version', 'reference', 'status', 'terms_accepted_at', 'terms_version', 'website_url']);
  const o = rows[0];
  assert.deepEqual([o.reference, o.email, o.website_url, o.privacy_version, o.status], [ref, CUSTOMER, 'https://www.musterfirma.de/leistungen', 'TEST-2026-10-30', 'received']);
  assert.deepEqual([o.terms_version, o.terms_accepted_at], [TERMS_VERSION, utc(flow.consent.at)], 'AGB-Version und Zeitpunkt der Zustimmung (vor der Anmeldung) gespeichert');
  await settled();
  assert.equal(mail.state.accepted.length, 1, 'genau eine Mail');
  const m = mail.state.accepted[0];
  assert.deepEqual(m.to, [NOTIFY_TO], 'nur an Pixelkiez (360@pixelkiez.de), nie an die Kundin/den Kunden');
  assert.equal(m.from, MAIL_FROM);
  assert.equal(m.reply_to, CUSTOMER);
  assert.equal(m.subject, `Neue Analyse-Anfrage ${ref}`);
  assert.equal(m.idempotencyKey, `pxwa-${ref}`);
  assert.match(m.contentType, /^application\/json/);
  assert.equal(mail.state.requests[0].headers.authorization, `Bearer ${MAIL_TOKEN}`, 'Token aus der Worker-Konfiguration');
  assert.deepEqual(Object.keys(m).filter(k => !['idempotencyKey', 'contentType', 'userAgent', 'id'].includes(k)).sort(), ['from', 'reply_to', 'subject', 'text', 'to'], 'kein Anhang, kein HTML');
  for (const s of [`Referenz: ${ref}`, `Eingegangen (UTC): ${o.created_at}`, 'Website: https://www.musterfirma.de/leistungen', `E-Mail-Adresse: ${CUSTOMER}`, 'Auftrag: Free (0 €), Status received', `AGB: Version ${TERMS_VERSION}, akzeptiert (UTC) ${o.terms_accepted_at}`]) {
    assert.ok(m.text.includes(s), `Mail enthält „${s}“`);
  }
  assert.deepEqual(await app.sql('SELECT status, attempts FROM notifications'), [{ status: 'sent', attempts: 1 }]);
  /* Keine Tokens in Datenbank (inkl. Sessions) oder Log; Log ohne E-Mail-Adresse und Website */
  for (const [where, s] of [['Datenbank', await app.dump()], ['Log', app.logs()]]) {
    assert.ok(!s.includes('mock-access-token') && !/eyJ[A-Za-z0-9_-]{10,}\./.test(s) && !s.includes(c.cookies.values().next().value), `${where}: kein Token, keine Session-ID`);
  }
  assert.ok(!app.logs().includes(CUSTOMER) && !app.logs().includes('musterfirma'));
  assert.equal((await app.sql('SELECT COUNT(*) AS n FROM sessions'))[0].n, 1, 'alte Session gelöscht');
  assert.equal((await app.sql("SELECT COUNT(*) AS n FROM sessions WHERE json_extract(data, '$.oidc') IS NOT NULL"))[0].n, 0, 'Flow samt Zustimmung verbraucht');
  await c.req('GET', '/api/anfrage');
  assert.deepEqual(await counts(), { orders: 1, outbox: 1, mails: 1 }, 'Neuladen erzeugt nichts Neues');
});

/* ---------- AGB-Gate ---------- */

test('Ohne AGB-Häkchen: kein Auftrag, keine Session, keine Weiterleitung zu Google; Fehler am Häkchen mit Fokus', { skip }, async () => {
  await reset();
  const tokens = google.log.token.length;
  for (const [i, agb] of [false, '0', '', 'on', 'true', 'ja', '1 '].entries()) {
    const c = new Client(app, { ip: `198.51.100.${120 + i}` });
    const r = await c.req('POST', '/api/anfrage', { form: startForm({ website: "musterfirma.de/?a=1&b='2'", agb }) });
    assert.equal(r.status, 422, `agb=${JSON.stringify(agb)}`);
    assert.equal(r.location, null, 'keine Weiterleitung zu Google');
    assert.deepEqual(r.headers.getSetCookie(), [], 'keine Session');
    assert.match(r.text, /Bitte akzeptieren Sie die AGB/);
    assert.match(r.text, /<input id="agb" type="checkbox" name="agb" value="1" required aria-invalid="true" aria-describedby="agb-error" autofocus>/, 'Häkchen markiert, Fokus darauf, nicht vorausgewählt');
    assert.ok(r.text.includes('value="musterfirma.de/?a=1&amp;b=&#039;2&#039;"'), 'Eingabe bleibt erhalten und ist escaped');
  }
  /* Ungültige Adresse und fehlendes Häkchen: beide Fehler, Fokus auf der Adresse */
  const both = await new Client(app, { ip: '198.51.100.140' }).req('POST', '/api/anfrage', { form: startForm({ website: 'keine adresse', agb: false }) });
  assert.equal(both.status, 422);
  assert.match(both.text, /id="url-error"/); assert.match(both.text, /id="agb-error"/);
  assert.match(both.text, /aria-describedby="url-error" autofocus/);
  assert.ok(!/aria-describedby="agb-error" autofocus/.test(both.text), 'nur ein autofocus');
  assert.deepEqual(await counts(), NOTHING);
  assert.equal((await app.sql('SELECT COUNT(*) AS n FROM sessions'))[0].n, 0);
  assert.equal(google.log.token.length, tokens, 'Google wird nicht kontaktiert');
});

test('Manipulierte Zustimmung: falsche, fehlende oder veraltete AGB-Version im Formular und manipulierte Zustimmung in der Session → kein Auftrag', { skip }, async () => {
  await reset();
  for (const [i, agbVersion] of ['ALT-2026-01-01', '', null, TERMS_VERSION + ' ', TERMS_VERSION.toLowerCase(), TERMS_VERSION + 'x'].entries()) {
    const r = await new Client(app, { ip: `198.51.100.${150 + i}` }).req('POST', '/api/anfrage', { form: startForm({ agbVersion }) });
    assert.equal(r.status, 409, `agb_version=${JSON.stringify(agbVersion)}`);
    assert.equal(r.location, null);
    assert.match(r.text, /AGB wurden aktualisiert/);
    assert.equal(field(r.text, 'agb_version'), TERMS_VERSION, 'Formular bietet die aktuelle Version an');
    assert.ok(!/checked/.test(r.text), 'Häkchen muss neu gesetzt werden');
  }
  assert.equal((await app.sql('SELECT COUNT(*) AS n FROM sessions'))[0].n, 0);
  /* Zustimmung in der Session nachträglich verändert (Datenbankebene): der Callback löst den Google-Code gar nicht erst ein */
  const tampered = [
    ['Zustimmung entfernt', "json_remove(data, '$.oidc.consent')"],
    ['andere Version', "json_set(data, '$.oidc.consent.version', 'ALT-2026-01-01')"],
    ['ungültige Website', "json_set(data, '$.oidc.consent.url', 'javascript:alert(1)')"],
    ['nicht normalisierte Website', "json_set(data, '$.oidc.consent.url', 'HTTPS://Musterfirma.DE/')"],
    ['Zeitpunkt fehlt', "json_remove(data, '$.oidc.consent.at')"],
    ['Idempotenzschlüssel fehlt', "json_remove(data, '$.oidc.idem')"],
  ];
  for (const [i, [name, expr]] of tampered.entries()) {
    const c = new Client(app, { ip: `198.51.100.${160 + i}` });
    const { callbackPath } = await begin(c, google);
    await app.run(`UPDATE sessions SET data = ${expr} WHERE json_extract(data, '$.oidc') IS NOT NULL`);
    const tokens = google.log.token.length;
    const r = await c.req('GET', callbackPath);
    assert.equal(r.status, 409, name);
    assert.match(r.text, /Es wurde keine Anfrage gespeichert/, name);
    assert.equal(google.log.token.length, tokens, `${name}: kein Code-Austausch`);
    assert.ok(!isAccepted((await c.req('GET', '/api/anfrage')).text), name);
  }
  assert.deepEqual(await counts(), NOTHING);
  assert.match(app.logs(), /Google-Rückkehr ohne gültige AGB-Zustimmung/);
});

test('Zustimmung gehört zu genau einer Session und Website: andere Session, andere URL ohne Häkchen und ersetzter Flow → kein fremder Auftrag', { skip }, async () => {
  await reset();
  /* Callback in einer anderen Session (anderer Browser): abgelehnt, der Flow der eigentlichen Session bleibt unberührt */
  const owner = new Client(app);
  const a = await begin(owner, google, { website: 'firma-a.de' });
  const stranger = new Client(app, { ip: '198.51.100.171' });
  assert.equal((await stranger.req('GET', a.callbackPath)).status, 400, 'fremde Session');
  assert.deepEqual(await counts(), NOTHING);
  /* Zweite Website im selben Browser ohne Häkchen: abgelehnt, ändert die Zustimmung für A nicht */
  const b = await owner.req('POST', '/api/anfrage', { form: startForm({ website: 'firma-b.de', agb: false }) });
  assert.equal(b.status, 422);
  assert.equal((await flowOf())[0].consent.url, 'https://firma-a.de', 'Zustimmung bleibt an Website A gebunden');
  assert.equal((await owner.req('GET', a.callbackPath)).status, 303);
  assert.deepEqual((await orders()).map(o => o.website_url), ['https://firma-a.de'], 'Auftrag nur für die Website mit Zustimmung');
  /* Neuer Start mit Häkchen ersetzt einen offenen Flow: dessen state gilt nicht mehr; der neue Flow bleibt davon unberührt */
  const c = new Client(app, { ip: '198.51.100.172' });
  const first = await begin(c, google, { website: 'firma-c.de' });
  const second = await begin(c, google, { website: 'firma-d.de' });
  assert.equal((await c.req('GET', first.callbackPath)).status, 400, 'ersetzter Flow');
  assert.equal((await c.req('GET', second.callbackPath)).status, 303, 'aktueller Flow gilt weiter');
  assert.deepEqual((await orders()).map(o => o.website_url), ['https://firma-a.de', 'https://firma-d.de'], 'Website C ohne gültige Zustimmung nie angelegt');
  await settled();
  assert.equal(mail.state.accepted.length, 2);
});

/* ---------- Google-Anmeldung: Abbruch, ungültige Antworten ---------- */

test('Google-Anmeldung abgebrochen, ohne Code oder mit unbekanntem Code: kein Auftrag; danach Neustart mit erneutem Häkchen', { skip }, async () => {
  await reset();
  const c = new Client(app);
  const { auth, callbackPath } = await begin(c, google, { website: 'musterfirma.de' });
  const state = auth.searchParams.get('state');
  const cancel = await c.req('GET', `/api/auth/callback?error=access_denied&state=${state}`);
  assert.equal(cancel.status, 400);
  assert.match(cancel.text, /Anmeldung abgebrochen/);
  assert.equal((await c.req('GET', callbackPath)).status, 400, 'nach dem Abbruch ist der state verbraucht');
  const back = await c.req('GET', '/api/anfrage');
  assert.match(back.text, /nicht abgeschlossen\. Es wurde keine Anfrage gespeichert/);
  assert.match(back.text, /value="https:\/\/musterfirma\.de"/, 'Adresse vorausgefüllt');
  assert.match(back.text, /<input id="agb" type="checkbox" name="agb" value="1" required>/, 'Häkchen muss neu gesetzt werden');
  for (const [name, query] of [['ohne Code', ''], ['leerer Code', '&code='], ['zu langer Code', '&code=' + 'x'.repeat(2100)]]) {
    const f = await begin(c, google);
    const r = await c.req('GET', `/api/auth/callback?state=${f.auth.searchParams.get('state')}${query}`);
    assert.equal(r.status, 400, name);
  }
  const unknown = await begin(c, google);
  assert.equal((await c.req('GET', `/api/auth/callback?state=${unknown.auth.searchParams.get('state')}&code=4%2Fmock-gibt-es-nicht`)).status, 401, 'unbekannter Code');
  assert.deepEqual(await counts(), NOTHING);
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
  test(`Google-Token abgelehnt (${name}): kein Auftrag, keine Mail`, { skip }, async () => {
    await reset();
    const c = new Client(app);
    const before = app.logs().length;
    const { callback } = await login(c, google, opts);
    assert.equal(callback.status, 401, callback.text.slice(0, 200));
    assert.match(callback.text, /Anmeldung nicht bestätigt/);
    assert.match(callback.text, /Es wurde keine Anfrage gespeichert/);
    await waitFor(() => app.logs().slice(before).includes(`Google-Anmeldung abgelehnt: ${reason}`), { what: `Log ${reason}` });
    assert.ok(!isAccepted((await c.req('GET', '/api/anfrage')).text));
    assert.deepEqual(await counts(), NOTHING);
  });
}

test('PKCE, state und nonce: falscher Verifier, falscher state und falsche nonce in der Session → kein Auftrag', { skip }, async () => {
  await reset();
  for (const [i, [name, expr, status]] of [
    ['PKCE-Verifier passt nicht zur Challenge', "json_set(data, '$.oidc.verifier', 'falscher-verifier-falscher-verifier-falscher-verifier')", 401],
    ['nonce passt nicht zum ID-Token', "json_set(data, '$.oidc.nonce', 'andere-nonce')", 401],
    ['state abgelaufen', "json_set(data, '$.oidc.at', 1000000000)", 400],
  ].entries()) {
    const c = new Client(app, { ip: `198.51.100.${180 + i}` });
    const { callbackPath } = await begin(c, google);
    await app.run(`UPDATE sessions SET data = ${expr} WHERE json_extract(data, '$.oidc') IS NOT NULL`);
    assert.equal((await c.req('GET', callbackPath)).status, status, name);
  }
  await waitFor(() => /Google-Anmeldung abgelehnt: token_exchange/.test(app.logs()) && /Google-Anmeldung abgelehnt: nonce/.test(app.logs()), { what: 'Log PKCE/nonce' });
  const wrong = await login(new Client(app, { ip: '198.51.100.190' }), google, { state: 'a'.repeat(64) });
  assert.equal(wrong.callback.status, 400, 'falscher state');
  assert.deepEqual(await counts(), NOTHING);
});

/* ---------- AGB-Version: geändert, entfernt, Zustimmung abgelaufen ---------- */

test('AGB-Version zwischen Zustimmung und Rückkehr geändert oder entfernt, Zustimmung abgelaufen → fail closed, kein Auftrag; neue Version nur mit neuer Zustimmung', { skip }, async () => {
  const g = await mockGoogle().start();
  mail.reset();
  const w = await startWorker({ google: g, mail });
  try {
    /* Deploy mit neuer AGB-Version, während die Kundin bei Google ist */
    const c = new Client(w);
    const { callbackPath } = await begin(c, g);
    await w.reconfigure({ TERMS_VERSION: 'TEST-AGB-2026-11-01' });
    const tokens = g.log.token.length;
    const changed = await c.req('GET', callbackPath);
    assert.equal(changed.status, 409);
    assert.match(changed.text, /AGB wurden geändert/);
    assert.equal(g.log.token.length, tokens, 'kein Code-Austausch');
    assert.deepEqual(await counts(w), NOTHING);
    /* Alte Startseite (alte Version) wird abgelehnt; die neue Fassung braucht eine neue Zustimmung */
    const stale = await c.req('POST', '/api/anfrage', { form: startForm() });
    assert.equal(stale.status, 409);
    assert.equal(field(stale.text, 'agb_version'), 'TEST-AGB-2026-11-01');
    assert.equal((await login(c, g, { agbVersion: 'TEST-AGB-2026-11-01' })).callback.status, 303);
    assert.deepEqual((await orders(w)).map(o => o.terms_version), ['TEST-AGB-2026-11-01']);
    await settled(w);
    /* Zustimmung älter als 10 Minuten (state selbst noch gültig): abgelehnt */
    const late = new Client(w, { ip: '198.51.100.201' });
    const l = await begin(late, g, { website: 'firma-spaet.de', agbVersion: 'TEST-AGB-2026-11-01' });
    await w.run(`UPDATE sessions SET data = json_set(data, '$.oidc.consent.at', ${Math.floor(Date.now() / 1000) - 601}) WHERE json_extract(data, '$.oidc') IS NOT NULL`);
    assert.equal((await late.req('GET', l.callbackPath)).status, 409, 'abgelaufene Zustimmung');
    /* TERMS_VERSION entfernt oder ungültig: API gesperrt, auch der Callback legt nichts an */
    for (const [i, value] of [undefined, '', 'mit Leerzeichen', 'x'.repeat(65)].entries()) {
      const v = new Client(w, { ip: `198.51.100.${210 + i}` });
      await w.reconfigure({ TERMS_VERSION: 'TEST-AGB-2026-11-01' });
      const f = await begin(v, g, { website: `firma-${i}.de`, agbVersion: 'TEST-AGB-2026-11-01' });
      await w.reconfigure({ TERMS_VERSION: value });
      const r = await v.req('GET', f.callbackPath);
      assert.equal(r.status, 503, `TERMS_VERSION=${JSON.stringify(value)}`);
      assert.match(r.text, /Anfragen sind im Moment nicht möglich/);
      assert.equal((await v.req('POST', '/api/anfrage', { form: startForm({ agbVersion: value ?? '' }) })).status, 503);
    }
    await waitFor(() => /Ungültige oder fehlende Werte: TERMS_VERSION/.test(w.logs()), { what: 'Log TERMS_VERSION' });
    assert.equal((await orders(w)).length, 1, 'nur der Auftrag mit neuer Zustimmung');
    assert.equal(mail.state.accepted.length, 1);
  } finally {
    await w.stop(); await g.stop();
  }
});

/* ---------- Website-URL ---------- */

test('Ungültige oder private Website-URL (auch mit Häkchen): 422, kein Weiterleiten zu Google, keine Session, Eingabe escaped', { skip }, async () => {
  await reset();
  const bad = ['', '   ', 'keine adresse', 'javascript:alert(1)', 'http://localhost', 'http://127.0.0.1', 'https://[::1]/', 'http://10.0.0.1/admin',
    'https://user:pass@musterfirma.de', 'musterfirma', 'ftp://musterfirma.de', 'https://musterfirma.de:8080', 'musterfirma.de:8080', 'intranet.local', 'firma.internal',
    'https://example.com', 'a'.repeat(2050) + '.de', '<script>alert(1)</script>.de', 'musterfirma.de/"onmouseover="x', 'https://musterfirma.de\\@evil.de', 'http://127.1', 'https://１２７.0.0.1'];
  for (const [i, website] of bad.entries()) {
    const r = await new Client(app, { ip: `198.51.100.${100 + i}` }).req('POST', '/api/anfrage', { form: startForm({ website }) });
    assert.equal(r.status, 422, `"${website.slice(0, 40)}" → ${r.status}`);
    assert.equal(r.location, null);
    assert.ok(!r.text.includes('<script>alert(1)'), 'kein ungefiltertes Echo');
    assert.match(r.text, /öffentliche Website-Adresse/);
    assert.match(r.text, /aria-describedby="url-error" autofocus/, 'Fokus auf der Adresse');
  }
  assert.deepEqual(await counts(), NOTHING);
  assert.equal((await app.sql('SELECT COUNT(*) AS n FROM sessions'))[0].n, 0, 'ungültige Eingaben legen keine Session an');
  const idn = new Client(app);
  await login(idn, google, { website: 'müller-bäckerei.de/über-uns' });
  const page = await idn.req('GET', '/api/anfrage');
  assert.match(page.text, /https:\/\/müller-bäckerei\.de\/über-uns</, 'Umlaut-Domain wird akzeptiert und lesbar angezeigt');
  assert.match((await orders())[0].website_url, /^https:\/\/xn--mller-bckerei-/, 'gespeichert in ASCII-Form');
  await settled();
});

/* ---------- Doppelklick, Replay, parallele Rückkehr ---------- */

test('Doppelklick, Replay und parallele Rückkehr: keine doppelten Aufträge oder Mails; erneute Anfrage derselben Website ergibt die vorhandene Referenz', { skip }, async () => {
  await reset();
  /* Doppelklick auf „Analysieren“ in einer Session: nur der zuletzt gespeicherte Flow ist gültig */
  const c = new Client(app);
  await c.req('POST', '/api/anfrage', { form: startForm() });
  const starts = await Promise.all([0, 1].map(() => c.req('POST', '/api/anfrage', { form: startForm() })));
  assert.deepEqual(starts.map(s => s.status), [303, 303]);
  const callbacks = [];
  for (const s of starts) {
    const p = new URL(s.location).searchParams;
    const code = google.issueCode({ nonce: p.get('nonce'), challenge: p.get('code_challenge'), redirectUri: p.get('redirect_uri') });
    callbacks.push(`/api/auth/callback?code=${encodeURIComponent(code)}&state=${p.get('state')}`);
  }
  const results = await Promise.all(callbacks.map(path => c.req('GET', path)));
  assert.deepEqual(results.map(r => r.status).sort(), [303, 400], 'genau eine Rückkehr legt an');
  assert.equal((await orders()).length, 1);
  /* Replay der erfolgreichen Rückkehr (Zurück, Neuladen, kopierte URL) */
  for (const path of callbacks) assert.equal((await c.req('GET', path)).status, 400, 'state verbraucht');
  assert.equal((await new Client(app).req('GET', callbacks[0])).status, 400, 'fremde Session ohne passenden state');
  /* Parallele Rückkehr mit demselben state: nur ein Aufruf darf ihn einlösen */
  const c2 = new Client(app, { ip: '198.51.100.31' });
  const f = await begin(c2, google, { website: 'firma-parallel.de' });
  const p = f.auth.searchParams;
  const codes = [f.code, google.issueCode({ nonce: p.get('nonce'), challenge: p.get('code_challenge'), redirectUri: p.get('redirect_uri') })];
  const same = await Promise.all(codes.map(code => c2.req('GET', `/api/auth/callback?code=${encodeURIComponent(code)}&state=${p.get('state')}`)));
  assert.deepEqual(same.map(r => r.status).sort(), [303, 400]);
  assert.equal((await orders()).length, 2);
  /* Zwei Browser, gleiches Google-Konto, gleiche Website, gleichzeitig: ein Auftrag, eine Mail, zweimal dieselbe Referenz */
  const [x, y] = [new Client(app, { ip: '198.51.100.32' }), new Client(app, { ip: '198.51.100.33' })];
  const [fx, fy] = [await begin(x, google, { website: 'firma-zwei-browser.de' }), await begin(y, google, { website: 'https://firma-zwei-browser.de/' })];
  const both = await Promise.all([x.req('GET', fx.callbackPath), y.req('GET', fy.callbackPath)]);
  assert.deepEqual(both.map(r => r.status), [303, 303]);
  const shown = await Promise.all([x, y].map(k => k.req('GET', '/api/anfrage')));
  assert.equal(referenceOf(shown[0].text), referenceOf(shown[1].text), 'gleiche Referenz');
  assert.equal(shown.filter(s => /Diese Website ist schon angefragt/.test(s.text)).length, 1, 'eine Annahme, ein Duplikat');
  await settled();
  assert.deepEqual(await counts(), { orders: 3, outbox: 3, mails: 3 });
  /* Später erneut dieselbe Website: keine zweite Anfrage */
  const again = new Client(app, { ip: '198.51.100.34' });
  assert.equal((await login(again, google, { website: 'firma-parallel.de' })).callback.status, 303);
  const dup = await again.req('GET', '/api/anfrage');
  assert.match(dup.text, /Diese Website ist schon angefragt/);
  assert.equal(referenceOf(dup.text), (await orders()).find(o => o.website_url === 'https://firma-parallel.de').reference);
  /* Anderes Konto darf dieselbe Website anfragen */
  const other = new Client(app, { ip: '198.51.100.35' });
  assert.equal((await login(other, google, { website: 'firma-parallel.de', claims: { sub: '100000000000000000002', email: 'zweite@beispiel-kunde.de' } })).callback.status, 303);
  await settled();
  assert.deepEqual(await counts(), { orders: 4, outbox: 4, mails: 4 });
  assert.equal(new Set(mail.state.accepted.map(m => m.idempotencyKey)).size, 4, 'je Auftrag genau eine Mail');
});

test('Tageslimit je Google-Konto: höchstens fünf Aufträge in 24 Stunden', { skip }, async () => {
  await reset();
  const statuses = [];
  for (let i = 1; i <= 6; i++) {
    const c = new Client(app, { ip: `198.51.100.${10 + i}` });
    statuses.push((await login(c, google, { website: `firma-${i}.de` })).callback.status);
  }
  assert.deepEqual(statuses, [303, 303, 303, 303, 303, 429]);
  assert.equal((await orders()).length, 5);
  await settled();
});

/* ---------- Fehlerpfade ---------- */

test('Fehlgeschlagene Speicherung: keine Bestätigung, kein halber Auftrag, keine Mail; Neustart mit Häkchen klappt', { skip }, async () => {
  await reset();
  const c = new Client(app);
  const { callbackPath } = await begin(c, google);
  await app.run('DROP TABLE notifications');   // Auftrag wäre speicherbar, Benachrichtigung nicht → ganzer Batch muss scheitern
  const failed = await c.req('GET', callbackPath);
  assert.equal(failed.status, 503);
  assert.match(failed.text, /konnte nicht verarbeitet werden/);
  assert.ok(!/Referenz|liegt bei uns/.test(failed.text), 'keine Annahmebestätigung');
  assert.equal((await orders()).length, 0, 'Rollback: kein Auftrag ohne Benachrichtigung');
  assert.ok(!app.logs().includes(CUSTOMER));
  await app.exec(MIGRATION);
  assert.equal((await c.req('GET', callbackPath)).status, 400, 'derselbe Rücksprung zählt nicht ein zweites Mal');
  assert.equal((await login(c, google)).callback.status, 303, 'neuer Versuch mit erneutem Häkchen');
  await settled();
  assert.deepEqual(await counts(), { orders: 1, outbox: 1, mails: 1 });
});

test('Störungen: fehlende Tabelle, fehlende Konfiguration, kein D1-Binding, Google-Ausfall → ehrliche Fehlerseite, keine Annahme', { skip }, async () => {
  await reset();
  await app.run('ALTER TABLE rate_limits RENAME TO rate_limits_off');
  try {
    const r = await new Client(app).req('POST', '/api/anfrage', { form: startForm() });
    assert.equal(r.status, 503);
    assert.match(r.text, /konnte nicht verarbeitet werden/);
    assert.equal(r.location, null, 'keine Weiterleitung zu Google');
  } finally {
    await app.run('ALTER TABLE rate_limits_off RENAME TO rate_limits');
  }
  assert.match(app.logs(), /PXWA: Datenbankfehler \(.*rate_limits/);
  google.state.outage = true;
  try {
    const { callback } = await login(new Client(app), google);
    assert.equal(callback.status, 401);
    assert.match(callback.text, /Anmeldung nicht bestätigt/);
  } finally {
    google.state.outage = false;
  }
  await waitFor(() => /Google-Anmeldung abgelehnt: token_exchange/.test(app.logs()), { what: 'Log token_exchange' });
  assert.deepEqual(await counts(), NOTHING);
  const g2 = await mockGoogle().start();
  const broken = [
    ['ohne Secret', await startWorker({ google: g2, mail, env: { GOOGLE_CLIENT_SECRET: undefined } }), /GOOGLE_CLIENT_SECRET/],
    ['ohne D1', await startWorker({ google: g2, mail, db: false }), /DB/],
  ];
  try {
    for (const [name, w, key] of broken) {
      for (const method of ['GET', 'POST']) {
        const n = await new Client(w).req(method, '/api/anfrage', method === 'POST' ? { form: startForm() } : {});
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

test('Kein Identitäts-, Zustimmungs- oder Session-Spoofing: Formularfelder überschreiben nichts, fremde oder fixierte Session-IDs tragen keine Anfrage', { skip }, async () => {
  await reset();
  /* Vom Angreifer erfundene Session-ID wird nicht übernommen */
  const invented = 'A'.repeat(43);
  const v1 = new Client(app);
  v1.cookies.set('pxwa', invented);
  await v1.req('POST', '/api/anfrage', { form: startForm() });
  assert.notEqual(v1.cookies.get('pxwa'), invented, 'erfundene Session-ID wird ersetzt');
  /* Session-Fixation: Angreifer schiebt eine echte, gültige Session-ID unter; nach dem Login gilt sie nicht mehr */
  const attacker = new Client(app);
  await attacker.req('POST', '/api/anfrage', { form: startForm({ website: 'angreifer-seite.de' }) });
  const victim = new Client(app);
  victim.cookies.set('pxwa', attacker.cookies.get('pxwa'));
  /* Untergeschobene Formularfelder ändern weder E-Mail, Google-Kennung, Website, Referenz noch AGB-Daten */
  const { callback } = await login(victim, google, { extra: {
    email: 'angreifer@beispiel-kunde.de', sub: '999', google_sub: '999', url: 'https://andere-firma.de', reference: 'PXA-AAAA-AAAA', 'identity[email]': 'angreifer@beispiel-kunde.de',
    terms_version: 'GEFAELSCHT', terms_accepted_at: '2000-01-01 00:00:00', 'consent[version]': 'GEFAELSCHT', idem: 'x', csrf: 'x', state: 'x',
  } });
  assert.equal(callback.status, 303);
  assert.notEqual(victim.cookies.get('pxwa'), attacker.cookies.get('pxwa'), 'neue Session-ID nach dem Login');
  const stolen = await attacker.req('GET', '/api/anfrage');
  assert.ok(!isAccepted(stolen.text) && !stolen.text.includes(CUSTOMER), 'alte Session-ID trägt keine Anfrage');
  const [o] = await orders();
  assert.deepEqual([o.email, o.google_sub, o.website_url, o.terms_version], [CUSTOMER, '100000000000000000001', 'https://musterfirma.de', TERMS_VERSION]);
  assert.notEqual(o.reference, 'PXA-AAAA-AAAA');
  assert.notEqual(o.terms_accepted_at, '2000-01-01 00:00:00');
  await settled();
  assert.deepEqual(mail.state.accepted.map(m => m.to), [[NOTIFY_TO]]);
  assert.ok(!mail.state.accepted[0].text.includes('angreifer'));
  /* Abmelden löscht die Session serverseitig; die alte ID ist danach wertlos */
  const sid = victim.cookies.get('pxwa');
  const [{ csrf }] = await app.sql("SELECT json_extract(data, '$.csrf') AS csrf FROM sessions WHERE json_extract(data, '$.done') IS NOT NULL");
  const out = await victim.req('POST', '/api/anfrage', { form: { action: 'logout', csrf } });
  assert.equal(out.location, `${app.base}/index.html`);
  assert.ok(out.headers.getSetCookie().some(s => /^pxwa=;.*Max-Age=0/i.test(s)));
  const reuse = new Client(app);
  reuse.cookies.set('pxwa', sid);
  assert.ok(!(await reuse.req('GET', '/api/anfrage')).text.includes('Referenz'));
});

test('Cross-Site-POST und veraltete zweite Bestätigung: abgelehnt, kein Auftrag', { skip }, async () => {
  await reset();
  const c = new Client(app);
  const crossSite = await c.req('POST', '/api/anfrage', { form: startForm(), headers: { origin: 'https://evil.example' } });
  assert.equal(crossSite.status, 403);
  assert.match(crossSite.text, /direkt auf dieser Website/);
  assert.equal((await new Client(app).req('POST', '/api/anfrage', { form: startForm(), headers: { origin: 'null' } })).status, 403, 'Origin "null"');
  assert.equal((await new Client(app).req('POST', '/api/anfrage', { form: startForm(), headers: { origin: null, 'sec-fetch-site': 'cross-site' } })).status, 403, 'Sec-Fetch-Site: cross-site');
  /* Die frühere zweite Bestätigung (action=confirm) und unbekannte Aktionen legen nie etwas an, auch nicht in einer laufenden Anmeldung */
  await begin(c, google);
  const [{ csrf }] = await app.sql("SELECT json_extract(data, '$.csrf') AS csrf FROM sessions");
  for (const action of ['confirm', 'order', 'submit']) {
    const r = await c.req('POST', '/api/anfrage', { form: { action, csrf, idem: 'abc', zustimmung: '1', agb: '1', agb_version: TERMS_VERSION, website: 'musterfirma.de' } });
    assert.equal(r.status, 400, action);
  }
  assert.deepEqual(await counts(), NOTHING);
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
    const plain = await new Client(s, { origin: s.base.replace('https:', 'http:') }).req('POST', '/api/anfrage', { form: startForm() });
    assert.equal(plain.status, 403, 'Formular-POST mit http-Origin passt nicht zur https-Basis-URL');
    const { start, callback } = await login(c, g);
    const [cookie] = start.headers.getSetCookie();
    assert.match(cookie, /^__Host-pxwa=[A-Za-z0-9_-]{43};/);
    for (const attr of [/;\s*Path=\/(;|$)/i, /;\s*Secure(;|$)/i, /;\s*HttpOnly(;|$)/i, /;\s*SameSite=Lax(;|$)/i, /;\s*Max-Age=3600(;|$)/i]) assert.match(cookie, attr);
    assert.ok(!/domain=|expires=/i.test(cookie), 'kein Domain-Attribut');
    assert.equal(callback.status, 303);
    assert.equal(callback.location, `${s.base}/api/anfrage`);
    assert.ok(c.cookies.get('__Host-pxwa') && c.cookies.get('__Host-pxwa') !== cookie.split(';')[0].split('=')[1], 'Session-Wechsel auch mit __Host-Cookie');
    assert.ok(isAccepted((await c.req('GET', '/api/anfrage')).text));
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
  const big = await c.req('POST', '/api/anfrage', { form: startForm({ extra: { x: 'y'.repeat(20000) } }) });
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
  for (let i = 0; i < 22; i++) codes.push((await c.req('POST', '/api/anfrage', { form: startForm() })).status);
  assert.deepEqual(codes, [...Array(20).fill(303), 429, 429]);
  assert.equal((await new Client(app, { ip: '203.0.113.10' }).req('POST', '/api/anfrage', { form: startForm() })).status, 303);
  const v6 = ip => new Client(app, { ip }).req('POST', '/api/anfrage', { form: startForm() });
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
  const post = await app.fetch(alias + '/api/anfrage', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: alias }, body: new URLSearchParams(startForm()).toString() });
  assert.equal(post.status, 403);
  assert.deepEqual(await counts(), NOTHING);
});

test('Worker-Log: keine unbehandelten Ausnahmen über alle Abläufe', { skip }, async () => {
  await sleep(100);
  assert.deepEqual(app.logs().split('\n').filter(l => /Uncaught|Unerwarteter Fehler|TypeError|ReferenceError/.test(l)), []);
});
