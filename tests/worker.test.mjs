/* PXWA – Integrationstests des API-Workers in workerd (Miniflare) mit lokaler D1 und lokalen Mocks.
   Ausführen im Repo-Root nach `npm ci`:  node --test tests/worker.test.mjs
   Echte Provider (Google, Resend, Cloudflare-D1) werden hier NICHT getestet; Resend ist ein Mock nach dessen dokumentiertem Vertrag.
   Ablauf (PO-Entscheidung 12.11.2026): Hero mit Website, „Analysieren“ → Bestätigungsseite mit genau einem Kästchen → Google →
   Rückkehr legt den Auftrag an → Eingangsbestätigung. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  mockGoogle, mockResend, startWorker, Client, login, begin, analyze, startForm, addressForm, referenceOf, field, waitFor, sleep, workerAvailable,
  CLIENT_ID, CUSTOMER, NOTIFY_TO, MAIL_FROM, MAIL_TOKEN, TERMS_VERSION, MIGRATION,
} from './lib/harness.mjs';

/* Wortlaut des einen Kästchens, wie ihn der Worker als Nachweis speichert (worker/src/view.ts, DECLARATIONS) */
const ERKLAERUNG = /^ {2}confirmation: '([^']+)',$/m.exec(readFileSync(new URL('../worker/src/view.ts', import.meta.url), 'utf8'))[1];

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
const isAccepted = html => /<h1 class="anfrage-titel">Vielen Dank für Ihre Anfrage\.<\/h1>/.test(html) && Boolean(referenceOf(html));
const checkboxes = html => [...html.matchAll(/<input\b[^>]*type="checkbox"[^>]*>/g)].map(m => m[0]);
const textOf = html => html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&');

/* ---------- Positivfall ---------- */

test('Hero → Bestätigung → Google: „Analysieren“ führt zur Bestätigungsseite mit genau einem Kästchen; mit Häkchen genau ein Free-Auftrag (AGB-Version, Zeitpunkt, Wortlaut, keine Werbeeinwilligung), genau eine Outbox-Benachrichtigung, Eingangsbestätigung mit Referenz', { skip }, async () => {
  await reset();
  const tokens0 = google.log.token.length;
  const c = new Client(app);
  const first = await c.req('GET', '/api/anfrage');
  assert.equal(first.status, 200);
  assert.equal(c.cookies.size, 0, 'GET ohne Anfrage legt keine Session an');
  assert.match(first.text, /<h1 class="anfrage-titel">Welche Website sollen wir analysieren\?<\/h1>/, 'ohne Sitzung: Adresseingabe');
  assert.match(first.text, /<input type="hidden" name="action" value="adresse">/);
  assert.match(first.text, /type="submit">Analysieren<\/button>/);
  assert.deepEqual(checkboxes(first.text), [], 'Adresseingabe ohne Kästchen');
  /* Hero: „Analysieren“ prüft die Adresse und hält sie für die Bestätigungsseite – POST, Weiterleitung auf eine feste Adresse */
  const hero = await c.req('POST', '/api/anfrage', { form: addressForm('HTTPS://WWW.Musterfirma.DE/leistungen?utm_source=x#top') });
  assert.equal(hero.status, 303);
  assert.equal(hero.location, `${app.base}/api/anfrage`, 'feste Adresse, Website steht in keiner URL');
  const sid0 = hero.headers.getSetCookie()[0].split(';')[0];
  const [{ data }] = await app.sql('SELECT data FROM sessions');
  const pending = JSON.parse(data);
  assert.equal(pending.pending.url, 'https://www.musterfirma.de/leistungen', 'normalisiert, Query und Fragment verworfen');
  assert.equal(pending.oidc, undefined, 'noch keine Zustimmung, keine Google-Anmeldung');
  assert.equal(google.log.token.length, tokens0, 'Google noch nicht kontaktiert');
  assert.deepEqual(await counts(), NOTHING);
  /* Bestätigungsseite: Überschrift, Adresse sichtbar, genau ein Pflichtkästchen, nicht vorausgewählt, Links, Schaltfläche, Hinweis */
  const page = await c.req('GET', '/api/anfrage');
  assert.equal(page.status, 200);
  assert.match(page.text, /<h1 class="anfrage-titel">Analyse anfragen<\/h1>/);
  assert.match(page.text, /<p class="anfrage-url mono">https:\/\/www\.musterfirma\.de\/leistungen<\/p>/, 'Adresse gut sichtbar');
  assert.deepEqual(checkboxes(page.text), ['<input id="bestaetigung" type="checkbox" name="bestaetigung" value="1" autocomplete="off" required>'], 'genau ein Kästchen, Pflicht, nicht vorausgewählt');
  const label = /<label class="consent">([\s\S]*?)<\/label>/.exec(page.text)[1];
  assert.equal(textOf(label), ERKLAERUNG, 'Wortlaut wie gespeichert (DECLARATIONS)');
  assert.equal(ERKLAERUNG, 'Ich handle geschäftlich oder für eine Organisation, akzeptiere die AGB und habe die Datenschutzerklärung zur Kenntnis genommen.');
  assert.deepEqual([...label.matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)].map(m => [m[1], m[2]]), [['/agb.html', 'AGB'], ['/datenschutz.html', 'Datenschutzerklärung']]);
  assert.match(page.text, /<button class="btn btn--accent btn--block" type="submit" aria-describedby="google-hinweis">Mit Google anmelden<\/button><p class="anfrage-google" id="google-hinweis">Wir senden die PDF an die angemeldete Google E-Mail-Adresse\.<\/p><\/form>/, 'Schaltfläche, direkt darunter der Hinweis zur PDF');
  assert.ok(!/fortfahren<\/button>/.test(page.text), 'alte Beschriftung entfernt');
  assert.match(page.text, /<p class="anfrage-hinweis">Kostenlos · 0 € · kein Abonnement<\/p>/);
  assert.match(page.text, /<a class="anfrage-aendern" href="\/index\.html#top">Adresse ändern<\/a>/);
  assert.equal(field(page.text, 'agb_version'), TERMS_VERSION);
  assert.equal(field(page.text, 'website'), 'https://www.musterfirma.de/leistungen');
  assert.ok(!/checked|werbung|unternehmer|Newsletter|Webdesign|anfrage-notiz/i.test(page.text), 'kein Marketing- oder Zusatzkästchen, kein Hinweis');
  /* Mit Häkchen weiter zu Google (Formular der Bestätigungsseite) */
  const t0 = Math.floor(Date.now() / 1000);
  const { start, auth, callbackPath } = await begin(c, google, { website: field(page.text, 'website') });
  assert.equal(start.status, 303);
  assert.deepEqual(start.headers.getSetCookie(), [], 'Sitzung aus „Analysieren“ wird weiterverwendet');
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
  assert.deepEqual(Object.keys(flow.consent).sort(), ['at', 'business', 'url', 'version'], 'Unternehmer bestätigt; eine Werbeeinwilligung gibt es nicht');
  assert.equal(flow.consent.business, true);
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
  /* Erfolg: grüner Haken, Dank, Eingang ohne Lieferfrist und ohne behauptete Vertragsannahme, Referenz dezent, zurück zur Startseite */
  assert.match(done.text, /<title>Anfrage eingegangen \| 360°Pixelkiez<\/title>/);
  assert.match(done.text, /<svg class="anfrage-zeichen" viewBox="0 0 64 64" aria-hidden="true" focusable="false">/);
  assert.match(done.text, /<p class="anfrage-text">Ihre Anfrage ist bei uns eingegangen\. Wir melden uns per E-Mail bei Ihnen\.<\/p>/);
  assert.match(done.text, /<div><dt>Referenz<\/dt><dd class="mono" id="reference">PXA-/);
  assert.match(done.text, /<dd class="mono">https:\/\/www\.musterfirma\.de\/leistungen<\/dd>/);
  assert.ok(done.text.includes(`<dd>${CUSTOMER}</dd>`));
  assert.match(done.text, /<a class="btn btn--ghost btn--sm" href="\/index\.html">Zur Startseite<\/a>/);
  assert.ok(!/angenommen|Vertrag|Werktag|\d+\s*Tage|Lieferfrist|bis zum/i.test(textOf(done.text.slice(done.text.indexOf('<main')))), 'keine Frist, keine behauptete Annahme');
  assert.ok(!/<form|type="checkbox"|name="idem"|Anfrage bestätigen/.test(done.text), 'keine zweite Bestätigung');
  assert.match(done.headers.get('content-security-policy'), /default-src 'none'.*frame-ancestors 'none'/);
  assert.equal(done.headers.get('cache-control'), 'no-store');
  const rows = await orders();
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['business_confirmed', 'created_at', 'declarations', 'email', 'google_sub', 'id', 'idempotency_key', 'marketing_consent', 'privacy_version', 'reference', 'status', 'terms_accepted_at', 'terms_version', 'website_url']);
  const o = rows[0];
  assert.deepEqual([o.reference, o.email, o.website_url, o.privacy_version, o.status], [ref, CUSTOMER, 'https://www.musterfirma.de/leistungen', 'TEST-2026-10-30', 'received']);
  assert.deepEqual([o.terms_version, o.terms_accepted_at], [TERMS_VERSION, utc(flow.consent.at)], 'AGB-Version und Zeitpunkt der Zustimmung (vor der Anmeldung) gespeichert');
  /* Nachweis (Art. 7 Abs. 1 DSGVO): Unternehmer bestätigt, keine Werbeeinwilligung, Wortlaut genau des einen Kästchens */
  assert.deepEqual([o.business_confirmed, o.marketing_consent], [1, 0]);
  assert.equal(o.declarations, ERKLAERUNG);
  assert.equal((await app.sql('SELECT COUNT(*) AS n FROM marketing_consents'))[0].n, 0, 'keine Werbeeinwilligung');
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
  assert.notEqual(c.cookies.get('pxwa'), sid0.split('=')[1], 'neue Session-ID');
  assert.equal((await app.sql('SELECT COUNT(*) AS n FROM sessions'))[0].n, 1, 'alte Session gelöscht');
  assert.equal((await app.sql("SELECT COUNT(*) AS n FROM sessions WHERE json_extract(data, '$.oidc') IS NOT NULL"))[0].n, 0, 'Flow samt Zustimmung verbraucht');
  await c.req('GET', '/api/anfrage');
  assert.deepEqual(await counts(), { orders: 1, outbox: 1, mails: 1 }, 'Neuladen erzeugt nichts Neues');
});

/* ---------- Hero („Analysieren“) ---------- */

test('Hero „Analysieren“: gültige Adresse → Bestätigungsseite (POST, feste Weiterleitung, Sitzung ohne Zustimmung); ungültige → Fehler am Feld, keine Sitzung; neue Adresse ersetzt eine offene Anmeldung; nie Google', { skip }, async () => {
  await reset();
  const tokens = google.log.token.length;
  /* Ungültige Adressen: 422 mit Fehler am Feld und Fokus, Eingabe erhalten und escaped, keine Sitzung, kein Google */
  for (const [i, website] of ['', 'keine adresse', 'javascript:alert(1)', 'http://localhost', "musterfirma'\"<b>"].entries()) {
    const c = new Client(app, { ip: `198.51.100.${40 + i}` });
    const r = await c.req('POST', '/api/anfrage', { form: addressForm(website) });
    assert.equal(r.status, 422, JSON.stringify(website));
    assert.equal(r.location, null);
    assert.deepEqual(r.headers.getSetCookie(), [], 'keine Session');
    assert.match(r.text, /<p class="form-error" id="url-error" role="alert">Bitte geben Sie eine öffentliche Website-Adresse wie beispiel\.de ein\.<\/p>/);
    assert.match(r.text, /aria-invalid="true" aria-describedby="url-error" autofocus>/);
    assert.ok(!r.text.includes('<b>') && !checkboxes(r.text).length, 'Eingabe escaped, kein Kästchen');
  }
  assert.match((await new Client(app, { ip: '198.51.100.49' }).req('POST', '/api/anfrage', { form: addressForm("musterfirma.de'\"<b>") })).text, /value="musterfirma\.de&#039;&quot;&lt;b&gt;"/);
  assert.equal((await app.sql('SELECT COUNT(*) AS n FROM sessions'))[0].n, 0);
  /* Gültige Adresse: Weiterleitung auf die feste Bestätigungsseite; die Adresse steht weder in der Weiterleitung noch geht sie an Google */
  const c = new Client(app);
  const r = await c.req('POST', '/api/anfrage', { form: addressForm('firma-a.de') });
  assert.deepEqual([r.status, r.location], [303, `${app.base}/api/anfrage`]);
  assert.match((await c.req('GET', '/api/anfrage')).text, /<p class="anfrage-url mono">https:\/\/firma-a\.de<\/p>/);
  /* Mit Häkchen bei Google, dann im Hero eine andere Adresse: die offene Anmeldung samt Zustimmung zu A verfällt */
  const a = await begin(c, google, { website: 'https://firma-a.de' });
  assert.equal((await flowOf()).length, 1);
  assert.equal((await c.req('POST', '/api/anfrage', { form: addressForm('firma-b.de') })).status, 303);
  assert.deepEqual(await flowOf(), [], 'keine offene Zustimmung mehr');
  const page = await c.req('GET', '/api/anfrage');
  assert.match(page.text, /<p class="anfrage-url mono">https:\/\/firma-b\.de<\/p>/);
  assert.ok(!/anfrage-notiz/.test(page.text), 'neue Adresse: kein Hinweis auf eine abgebrochene Anmeldung');
  assert.equal((await c.req('GET', a.callbackPath)).status, 400, 'Rücksprung zur alten Anmeldung legt nichts an');
  assert.equal(google.log.token.length, tokens, 'Google wird nie kontaktiert');
  assert.deepEqual(await counts(), NOTHING);
});

/* ---------- Bestätigung: genau ein Kästchen ---------- */

test('Bestätigung ohne Häkchen: kein Auftrag, keine Zustimmung, keine Weiterleitung zu Google; Fehler am Kästchen mit Fokus, Adresse bleibt sichtbar', { skip }, async () => {
  await reset();
  const tokens = google.log.token.length;
  for (const [i, bestaetigung] of [false, '0', '', 'on', 'true', 'ja', '1 '].entries()) {
    const c = new Client(app, { ip: `198.51.100.${120 + i}` });
    const { start: r } = await analyze(c, { website: "musterfirma.de/a'b", bestaetigung });
    assert.equal(r.status, 422, `bestaetigung=${JSON.stringify(bestaetigung)}`);
    assert.equal(r.location, null, 'keine Weiterleitung zu Google');
    assert.deepEqual(r.headers.getSetCookie(), [], 'keine neue Session');
    assert.match(r.text, /<p class="form-error" id="bestaetigung-error" role="alert">Bitte bestätigen Sie das Kästchen, um mit Google fortzufahren\.<\/p>/);
    assert.deepEqual(checkboxes(r.text), ['<input id="bestaetigung" type="checkbox" name="bestaetigung" value="1" autocomplete="off" required aria-invalid="true" aria-describedby="bestaetigung-error" autofocus>'], 'Kästchen markiert, Fokus darauf, nicht vorausgewählt');
    assert.ok(r.text.includes('<input type="hidden" name="website" value="https://musterfirma.de/a&#039;b">'), 'Adresse bleibt erhalten und ist escaped');
  }
  /* Die früheren Felder (Hero mit drei Kästchen, alte Seite im Cache) ersetzen das eine Kästchen nicht */
  const alt = (await analyze(new Client(app, { ip: '198.51.100.140' }), { bestaetigung: false, extra: { agb: '1', unternehmer: '1', werbung: '1' } })).start;
  assert.equal(alt.status, 422);
  /* Ungültige Adresse im Formular (manipuliert): Adresseingabe mit Fehler, Fokus auf dem Feld */
  const bad = await new Client(app, { ip: '198.51.100.141' }).req('POST', '/api/anfrage', { form: startForm({ website: 'keine adresse' }) });
  assert.equal(bad.status, 422);
  assert.match(bad.text, /aria-describedby="url-error" autofocus/);
  assert.deepEqual(await counts(), NOTHING);
  assert.deepEqual(await flowOf(), [], 'keine Zustimmung, keine Google-Anmeldung');
  assert.equal(google.log.token.length, tokens, 'Google wird nicht kontaktiert');
});

test('Keine Werbeeinwilligung ohne eigenes Opt-in: untergeschobene Felder (werbung, marketing, frühere Kästchen) ändern nichts; marketing_consent bleibt 0, marketing_consents ohne neue Zeile, Wortlaut nur des einen Kästchens', { skip }, async () => {
  await reset();
  const c = new Client(app, { ip: '198.51.100.71' });
  const f = await begin(c, google, { website: 'firma-mit.de', extra: { werbung: '1', marketing: '1', marketing_consent: '1', agb: '1', unternehmer: '1', newsletter: 'ja' } });
  const [{ data }] = await app.sql('SELECT data FROM sessions');
  assert.ok(!/marketing|werbung|newsletter/i.test(data), 'Zustimmung in der Sitzung ohne Werbeeinwilligung');
  assert.deepEqual(Object.keys(JSON.parse(data).oidc.consent).sort(), ['at', 'business', 'url', 'version']);
  assert.equal((await c.req('GET', f.callbackPath)).status, 303);
  assert.deepEqual(await app.sql('SELECT website_url, business_confirmed, marketing_consent, declarations FROM orders'), [{ website_url: 'https://firma-mit.de', business_confirmed: 1, marketing_consent: 0, declarations: ERKLAERUNG }]);
  assert.equal((await app.sql('SELECT COUNT(*) AS n FROM marketing_consents'))[0].n, 0);
  await settled();
  assert.ok(!/Werbe|Newsletter|marketing/i.test(mail.state.accepted[0].text), 'Benachrichtigung ohne Werbeeinwilligung');
});

test('Manipulierte Zustimmung: falsche, fehlende oder veraltete AGB-Version im Formular und manipulierte Zustimmung in der Session → kein Auftrag', { skip }, async () => {
  await reset();
  /* Varianten, die tatsächlich von der aktuellen Version abweichen (eine reine Datumsversion hat keine Kleinbuchstaben-Variante) */
  const variants = ['ALT-2026-01-01', '', null, TERMS_VERSION + ' ', TERMS_VERSION.toLowerCase(), TERMS_VERSION.replaceAll('-', '.'), TERMS_VERSION + 'x'].filter(v => v !== TERMS_VERSION);
  for (const [i, agbVersion] of variants.entries()) {
    const { start: r } = await analyze(new Client(app, { ip: `198.51.100.${150 + i}` }), { agbVersion });
    assert.equal(r.status, 409, `agb_version=${JSON.stringify(agbVersion)}`);
    assert.equal(r.location, null);
    assert.match(r.text, /AGB wurden aktualisiert/);
    assert.equal(field(r.text, 'agb_version'), TERMS_VERSION, 'Formular bietet die aktuelle Version an');
    assert.ok(!/checked/.test(r.text), 'Häkchen muss neu gesetzt werden');
  }
  assert.deepEqual(await flowOf(), [], 'keine Zustimmung gespeichert');
  /* Zustimmung in der Session nachträglich verändert (Datenbankebene): der Callback löst den Google-Code gar nicht erst ein */
  const tampered = [
    ['Zustimmung entfernt', "json_remove(data, '$.oidc.consent')"],
    ['andere Version', "json_set(data, '$.oidc.consent.version', 'ALT-2026-01-01')"],
    ['ungültige Website', "json_set(data, '$.oidc.consent.url', 'javascript:alert(1)')"],
    ['nicht normalisierte Website', "json_set(data, '$.oidc.consent.url', 'HTTPS://Musterfirma.DE/')"],
    ['Zeitpunkt fehlt', "json_remove(data, '$.oidc.consent.at')"],
    ['Unternehmer-Bestätigung fehlt', "json_remove(data, '$.oidc.consent.business')"],
    ['Unternehmer-Bestätigung falsch', "json_set(data, '$.oidc.consent.business', 'ja')"],
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

test('Zustimmung gehört zu genau einer Session und Website: andere Session, andere URL im Formular und ersetzter Flow → kein fremder Auftrag', { skip }, async () => {
  await reset();
  /* Callback in einer anderen Session (anderer Browser): abgelehnt, der Flow der eigentlichen Session bleibt unberührt */
  const owner = new Client(app);
  const a = await begin(owner, google, { website: 'firma-a.de' });
  const stranger = new Client(app, { ip: '198.51.100.171' });
  assert.equal((await stranger.req('GET', a.callbackPath)).status, 400, 'fremde Session');
  assert.deepEqual(await counts(), NOTHING);
  /* Zweite Website im selben Browser, ohne „Analysieren“ (verstecktes Feld manipuliert), sogar mit Häkchen: abgelehnt, ändert die
     Zustimmung für A nicht */
  const b = await owner.req('POST', '/api/anfrage', { form: startForm({ website: 'firma-b.de' }) });
  assert.deepEqual([b.status, b.location], [409, null]);
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

test('Bestätigung nur für die Website dieser Sitzung: ohne „Analysieren“, mit erfundener oder abgelaufener Sitzung oder mit anderer Website als angezeigt → keine Sitzung, keine Zustimmung, kein Google, Adresse neu eingeben; angezeigte Website mit Häkchen → Google, Auftrag nur für sie', { skip }, async () => {
  await reset();
  const tokens = google.log.token.length;
  const sessions = async () => (await app.sql('SELECT COUNT(*) AS n FROM sessions'))[0].n;
  const rejected = (r, what) => {
    assert.deepEqual([r.status, r.location, r.headers.getSetCookie()], [409, null, []], `${what}: keine Weiterleitung, keine neue Sitzung`);
    assert.match(r.text, /<h1 class="anfrage-titel">Welche Website sollen wir analysieren\?<\/h1>/, `${what}: Adresseingabe`);
    assert.match(r.text, /<p class="form-error" id="url-error" role="alert">Ihre Sitzung ist abgelaufen oder die Website-Adresse hat sich geändert\. Bitte geben Sie die Adresse erneut ein\.<\/p>/, what);
    assert.match(r.text, /<input type="hidden" name="action" value="adresse">/, `${what}: zurück zu „Analysieren“`);
    assert.deepEqual(checkboxes(r.text), [], `${what}: kein Kästchen`);
  };
  /* Ohne Sitzung, auch mit Häkchen und aktueller AGB-Version: start legt keine Sitzung an */
  rejected(await new Client(app, { ip: '198.51.100.230' }).req('POST', '/api/anfrage', { form: startForm({ website: 'firma-b.de' }) }), 'ohne Sitzung');
  const invented = new Client(app, { ip: '198.51.100.231' });
  invented.cookies.set('pxwa', 'A'.repeat(43));
  rejected(await invented.req('POST', '/api/anfrage', { form: startForm() }), 'erfundene Session-ID');
  assert.equal(await sessions(), 0, 'start erzeugt keine Sitzung');
  /* Sitzung zeigt Website A; das versteckte Feld wird auf eine andere Website geändert */
  const c = new Client(app, { ip: '198.51.100.232' });
  await c.req('POST', '/api/anfrage', { form: addressForm('firma-a.de') });
  const page = await c.req('GET', '/api/anfrage');
  assert.equal(field(page.text, 'website'), 'https://firma-a.de');
  for (const website of ['firma-b.de', 'https://firma-a.de/andere-seite', 'https://www.firma-a.de', 'http://firma-a.de', 'firma-a.de.andere-firma.de']) {
    rejected(await c.req('POST', '/api/anfrage', { form: startForm({ website }) }), `angezeigt https://firma-a.de, abgeschickt ${website}`);
  }
  assert.deepEqual(await flowOf(), [], 'keine Zustimmung gespeichert');
  assert.deepEqual(await app.sql("SELECT json_extract(data, '$.pending.url') AS url FROM sessions"), [{ url: 'https://firma-a.de' }], 'Sitzung zeigt weiter Website A');
  /* Angezeigte Website ohne Häkchen: Fehler am Kästchen, kein Google */
  const noBox = await c.req('POST', '/api/anfrage', { form: startForm({ website: field(page.text, 'website'), bestaetigung: false }) });
  assert.deepEqual([noBox.status, noBox.location], [422, null]);
  assert.match(noBox.text, /Bitte bestätigen Sie das Kästchen/);
  assert.deepEqual(await flowOf(), []);
  /* Angezeigte Website (gleiche normalisierte Adresse) mit Häkchen: Google; Zustimmung an diese Website, AGB-Version und diesen state */
  const ok = await c.req('POST', '/api/anfrage', { form: startForm({ website: 'HTTPS://Firma-A.de/' }) });
  assert.equal(ok.status, 303);
  assert.ok(ok.location.startsWith(app.authEndpoint));
  const p = new URL(ok.location).searchParams;
  const [flow] = await flowOf();
  assert.deepEqual([flow.consent.url, flow.consent.version, flow.state], ['https://firma-a.de', TERMS_VERSION, p.get('state')]);
  /* Während der Google-Anmeldung: manipuliertes Formular für Website B ersetzt die Anmeldung für A nicht */
  rejected(await c.req('POST', '/api/anfrage', { form: startForm({ website: 'firma-b.de' }) }), 'bei Google, andere Website');
  assert.deepEqual((await flowOf()).map(f => [f.state, f.consent.url]), [[flow.state, 'https://firma-a.de']], 'laufende Anmeldung unberührt');
  /* Abgelaufene Sitzung: die offene Bestätigungsseite startet nichts */
  const e = new Client(app, { ip: '198.51.100.233' });
  await e.req('POST', '/api/anfrage', { form: addressForm('firma-ablauf.de') });
  const open = await e.req('GET', '/api/anfrage');
  await app.run("UPDATE sessions SET expires_at = ?1 WHERE json_extract(data, '$.pending.url') = 'https://firma-ablauf.de'", Math.floor(Date.now() / 1000) - 1);
  rejected(await e.req('POST', '/api/anfrage', { form: startForm({ website: field(open.text, 'website') }) }), 'abgelaufene Sitzung');
  assert.equal(google.log.token.length, tokens, 'bis hier kein Code-Austausch');
  assert.deepEqual(await counts(), NOTHING);
  /* Rückkehr von Google: genau ein Auftrag, nur für die angezeigte und bestätigte Website */
  const code = google.issueCode({ nonce: p.get('nonce'), challenge: p.get('code_challenge'), redirectUri: p.get('redirect_uri') });
  assert.equal((await c.req('GET', `/api/auth/callback?code=${encodeURIComponent(code)}&state=${p.get('state')}`)).status, 303);
  assert.deepEqual((await orders()).map(o => [o.website_url, o.terms_version]), [['https://firma-a.de', TERMS_VERSION]]);
  await settled();
  assert.deepEqual(await counts(), { orders: 1, outbox: 1, mails: 1 });
});

/* ---------- Google-Anmeldung: Abbruch, ungültige Antworten ---------- */

test('Google-Anmeldung abgebrochen, ohne Code oder mit unbekanntem Code: kein Auftrag; danach Bestätigungsseite mit Hinweis und erneutem Häkchen', { skip }, async () => {
  await reset();
  const c = new Client(app);
  assert.equal((await c.req('POST', '/api/anfrage', { form: addressForm('musterfirma.de') })).status, 303);
  const { auth, callbackPath } = await begin(c, google, { website: 'https://musterfirma.de' });
  const state = auth.searchParams.get('state');
  const cancel = await c.req('GET', `/api/auth/callback?error=access_denied&state=${state}`);
  assert.equal(cancel.status, 400);
  assert.match(cancel.text, /Anmeldung abgebrochen/);
  assert.match(cancel.text, /Es wurde keine Anfrage gespeichert/);
  assert.match(cancel.text, /<a class="btn btn--ghost btn--sm" href="\/api\/anfrage">Erneut versuchen<\/a>/);
  assert.equal((await c.req('GET', callbackPath)).status, 400, 'nach dem Abbruch ist der state verbraucht');
  const back = await c.req('GET', '/api/anfrage');
  assert.match(back.text, /<h1 class="anfrage-titel">Analyse anfragen<\/h1>/, 'zurück auf der Bestätigungsseite');
  assert.match(back.text, /<p class="anfrage-notiz" role="status">Die Google-Anmeldung wurde nicht abgeschlossen\. Es wurde keine Anfrage gespeichert\./);
  assert.match(back.text, /<input type="hidden" name="website" value="https:\/\/musterfirma\.de">/, 'Adresse bleibt');
  assert.deepEqual(checkboxes(back.text), ['<input id="bestaetigung" type="checkbox" name="bestaetigung" value="1" autocomplete="off" required>'], 'Häkchen muss neu gesetzt werden');
  for (const [name, query] of [['ohne Code', ''], ['leerer Code', '&code='], ['zu langer Code', '&code=' + 'x'.repeat(2100)]]) {
    const f = await begin(c, google);
    const r = await c.req('GET', `/api/auth/callback?state=${f.auth.searchParams.get('state')}${query}`);
    assert.equal(r.status, 400, name);
  }
  const unknown = await begin(c, google);
  assert.equal((await c.req('GET', `/api/auth/callback?state=${unknown.auth.searchParams.get('state')}&code=4%2Fmock-gibt-es-nicht`)).status, 401, 'unbekannter Code');
  assert.deepEqual(await counts(), NOTHING);
});

test('Sitzung abgelaufen: GET zeigt wieder die Adresseingabe (ohne Adresse); die offene Bestätigungsseite startet nichts (keine neue Sitzung, kein Google), Adresse neu eingeben; Rückkehr von Google nach Ablauf legt nichts an', { skip }, async () => {
  await reset();
  const expire = () => app.run('UPDATE sessions SET expires_at = ?1', Math.floor(Date.now() / 1000) - 1);
  const c = new Client(app);
  assert.equal((await c.req('POST', '/api/anfrage', { form: addressForm('firma-ablauf.de') })).status, 303);
  const page = await c.req('GET', '/api/anfrage');
  await expire();
  const gone = await c.req('GET', '/api/anfrage');
  assert.match(gone.text, /<h1 class="anfrage-titel">Welche Website sollen wir analysieren\?<\/h1>/);
  assert.ok(!gone.text.includes('firma-ablauf'), 'abgelaufene Sitzung zeigt die Adresse nicht mehr');
  /* Die noch offene Bestätigungsseite abschicken (mit Häkchen): keine Zustimmung, keine neue Sitzung, kein Google – Adresse neu eingeben */
  const restart = await c.req('POST', '/api/anfrage', { form: startForm({ website: field(page.text, 'website') }) });
  assert.deepEqual([restart.status, restart.location, restart.headers.getSetCookie()], [409, null, []]);
  assert.match(restart.text, /<h1 class="anfrage-titel">Welche Website sollen wir analysieren\?<\/h1>/);
  assert.deepEqual(await flowOf(), []);
  /* Bei Google, währenddessen läuft die Sitzung ab: Rückkehr ohne Code-Austausch und ohne Auftrag */
  const tokens = google.log.token.length;
  const f = await begin(c, google, { website: 'firma-ablauf.de' });
  await expire();
  const late = await c.req('GET', f.callbackPath);
  assert.equal(late.status, 400);
  assert.match(late.text, /Anmeldung abgelaufen/);
  assert.equal(google.log.token.length, tokens, 'kein Code-Austausch');
  assert.deepEqual(await counts(), NOTHING);
  assert.match((await c.req('GET', '/api/anfrage')).text, /Welche Website sollen wir analysieren\?/);
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

test('Ungültige oder private Website-URL (im Hero und auf der Bestätigungsseite, auch mit Häkchen): 422, kein Weiterleiten zu Google, keine Session, Eingabe escaped', { skip }, async () => {
  await reset();
  const bad = ['', '   ', 'keine adresse', 'javascript:alert(1)', 'http://localhost', 'http://127.0.0.1', 'https://[::1]/', 'http://10.0.0.1/admin',
    'https://user:pass@musterfirma.de', 'musterfirma', 'ftp://musterfirma.de', 'https://musterfirma.de:8080', 'musterfirma.de:8080', 'intranet.local', 'firma.internal',
    'https://example.com', 'a'.repeat(2050) + '.de', '<script>alert(1)</script>.de', 'musterfirma.de/"onmouseover="x', 'https://musterfirma.de\\@evil.de', 'http://127.1', 'https://１２７.0.0.1'];
  for (const [n, form] of [['Hero', addressForm], ['Bestätigung', website => startForm({ website })]]) {
    for (const [i, website] of bad.entries()) {
      const r = await new Client(app, { ip: `198.51.${n === 'Hero' ? 101 : 102}.${100 + i}` }).req('POST', '/api/anfrage', { form: form(website) });
      assert.equal(r.status, 422, `${n}: "${website.slice(0, 40)}" → ${r.status}`);
      assert.equal(r.location, null);
      assert.ok(!r.text.includes('<script>alert(1)'), 'kein ungefiltertes Echo');
      assert.match(r.text, /öffentliche Website-Adresse/);
      assert.match(r.text, /aria-describedby="url-error" autofocus/, 'Fokus auf der Adresse');
    }
  }
  assert.deepEqual(await counts(), NOTHING);
  assert.equal((await app.sql('SELECT COUNT(*) AS n FROM sessions'))[0].n, 0, 'ungültige Eingaben legen keine Session an');
  const idn = new Client(app);
  assert.equal((await idn.req('POST', '/api/anfrage', { form: addressForm('müller-bäckerei.de/über-uns') })).status, 303);
  const confirm = await idn.req('GET', '/api/anfrage');
  assert.match(confirm.text, /<p class="anfrage-url mono">https:\/\/müller-bäckerei\.de\/über-uns<\/p>/, 'Umlaut-Domain auf der Bestätigungsseite lesbar');
  await login(idn, google, { website: field(confirm.text, 'website') });
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
  await analyze(c);
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
  assert.equal(shown.filter(s => /Diese Website ist bereits angefragt\./.test(s.text)).length, 1, 'eine Annahme, ein Duplikat');
  await settled();
  assert.deepEqual(await counts(), { orders: 3, outbox: 3, mails: 3 });
  /* Später erneut dieselbe Website: keine zweite Anfrage, keine zweite Benachrichtigung; eigener, wahrheitsgemäßer Zustand */
  const again = new Client(app, { ip: '198.51.100.34' });
  assert.equal((await login(again, google, { website: 'firma-parallel.de' })).callback.status, 303);
  const dup = await again.req('GET', '/api/anfrage');
  assert.match(dup.text, /<title>Bereits angefragt \| 360°Pixelkiez<\/title>/);
  assert.match(dup.text, /<h1 class="anfrage-titel">Diese Website ist bereits angefragt\.<\/h1>/);
  assert.match(dup.text, /Wir haben keine zweite angelegt; es gilt die bisherige Referenz\./);
  assert.match(dup.text, /<svg class="anfrage-zeichen anfrage-zeichen--info"/, 'kein Erfolgshaken beim Duplikat');
  assert.ok(!isAccepted(dup.text) && !/Vielen Dank/.test(dup.text), 'keine Eingangsmeldung für eine neue Anfrage');
  assert.equal(referenceOf(dup.text), (await orders()).find(o => o.website_url === 'https://firma-parallel.de').reference);
  await sleep(100);
  assert.deepEqual(await counts(), { orders: 3, outbox: 3, mails: 3 }, 'Duplikat: keine zweite Benachrichtigung');
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

test('Tagesgrenze aller Aufträge (50 in 24 Stunden, viele Konten und IPs): danach kein Auftrag, keine Outbox, keine Mail; ältere Aufträge zählen nicht', { skip }, async () => {
  await reset();
  /* 50 Aufträge anderer Konten in den letzten 24 Stunden, einer davon älter (zählt nicht) */
  const now = Math.floor(Date.now() / 1000);
  for (let i = 1; i <= 50; i++) {
    await app.run("INSERT INTO orders (reference, idempotency_key, google_sub, email, website_url, privacy_version, created_at) VALUES (?1, ?1, ?2, 'k@beispiel-kunde.de', 'https://firma.de', 'TEST', ?3)",
      `PXA-GLOB-${String(i).padStart(4, '0')}`, `sub-${i}`, utc(i === 1 ? now - 2 * 86400 : now - 60));
  }
  const frei = (await login(new Client(app, { ip: '198.51.100.120' }), google, { website: 'firma-frei.de' })).callback;
  assert.equal(frei.status, 303, '49 Aufträge in 24 Stunden: der 50. wird angenommen');
  await settled();
  mail.reset();
  const voll = (await login(new Client(app, { ip: '198.51.100.121' }), google, { website: 'firma-voll.de', claims: { sub: '100000000000000000077', email: 'neu@beispiel-kunde.de' } })).callback;
  assert.equal(voll.status, 429);
  assert.equal(voll.location, null, 'keine Bestätigung');
  assert.match(textOf(voll.text), /Heute sind bereits sehr viele Anfragen eingegangen\. Es wurde keine Anfrage gespeichert\./);
  assert.deepEqual(await counts(), { orders: 51, outbox: 1, mails: 0 });
  await waitFor(() => app.logs().includes('Tagesgrenze aller Aufträge erreicht'), { what: 'Log Tagesgrenze' });
  assert.ok(!app.logs().includes('neu@beispiel-kunde.de') && !app.logs().includes('firma-voll'), 'Log ohne Adressen');
  await reset();
});

test('Testbetrieb (ACCESS_MODE testnutzer): nur freigeschaltete Google-Konten legen einen Auftrag an; andere Konten 403 ohne Auftrag, Outbox und Mail, Adresse nicht im Log', { skip }, async () => {
  /* Eigenes Mock-Google: startWorker setzt dort die Redirect-URI dieses Workers */
  const g2 = await mockGoogle().start();
  const w = await startWorker({ google: g2, mail, env: { ACCESS_MODE: 'testnutzer', ACCESS_ALLOWLIST: ` tester@beispiel-test.de,\n${CUSTOMER.toUpperCase()} ` } });
  try {
    mail.reset();
    const fremd = 'fremd@beispiel-dritte.de';
    const denied = (await login(new Client(w), g2, { claims: { email: fremd, sub: '100000000000000000099' } })).callback;
    assert.equal(denied.status, 403);
    assert.equal(denied.location, null, 'keine Bestätigung');
    assert.match(denied.text, /Noch nicht freigeschaltet/);
    assert.match(denied.text, /Es wurde keine Anfrage gespeichert/);
    assert.deepEqual(await counts(w), NOTHING);
    await waitFor(() => w.logs().includes('ohne Freischaltung (Testbetrieb)'), { what: 'Log Testbetrieb' });
    assert.ok(!w.logs().includes(fremd) && !w.logs().includes('musterfirma'), 'Log ohne Adressen');
    /* Freigeschaltetes Konto (Groß-/Kleinschreibung in der Liste egal): genau ein Auftrag, genau eine Mail */
    const ok = (await login(new Client(w, { ip: '198.51.100.90' }), g2)).callback;
    assert.equal(ok.status, 303);
    await settled(w);
    assert.deepEqual((await orders(w)).map(o => o.email), [CUSTOMER]);
    assert.deepEqual(await w.sql('SELECT status FROM notifications'), [{ status: 'sent' }]);
    assert.equal(mail.state.accepted.length, 1);
  } finally {
    await w.stop(); await g2.stop();
  }
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
  await v1.req('POST', '/api/anfrage', { form: addressForm() });
  assert.notEqual(v1.cookies.get('pxwa'), invented, 'erfundene Session-ID wird ersetzt');
  /* Session-Fixation: Angreifer schiebt eine echte, gültige Session-ID unter; nach dem Login gilt sie nicht mehr */
  const attacker = new Client(app);
  await analyze(attacker, { website: 'angreifer-seite.de' });
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
  /* Auch „Analysieren“ (Hero) nur von dieser Website: fremde Herkunft legt keine Sitzung an */
  for (const headers of [{ origin: 'https://evil.example' }, { origin: 'null' }, { origin: null, 'sec-fetch-site': 'cross-site' }]) {
    const r = await new Client(app).req('POST', '/api/anfrage', { form: addressForm(), headers });
    assert.deepEqual([r.status, r.location, r.headers.getSetCookie()], [403, null, []], JSON.stringify(headers));
  }
  assert.equal((await app.sql('SELECT COUNT(*) AS n FROM sessions'))[0].n, 0, 'fremde Herkunft: keine Sitzung');
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
    const { address, callback } = await login(c, g);
    const [cookie] = address.headers.getSetCookie();
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

test('Hauptnavigation: Anfrageseiten haben denselben Kopf wie die übrigen Seiten (Menüpunkte, Wissen-Beiträge, Button „Analyse“, mobiles Menü)', { skip }, async () => {
  const { readFileSync } = await import('node:fs');
  /* Kopf bis auf die Basisadresse identisch: view.ts verlinkt absolut, impressum.html relativ (Links und Logo-Bild) */
  const kopf = html => (html.match(/<header class="nav-wrap" id="nav">[\s\S]*?<\/header>/) || [''])[0].replace(/(href|src)="(?:https?:\/\/[^/"]+)?\//g, '$1="');
  const statisch = kopf(readFileSync(new URL('../public/impressum.html', import.meta.url), 'utf8'));
  assert.match(statisch, /<details class="mega">[\s\S]*<details class="nav-menu">/);
  assert.equal(kopf((await new Client(app).req('GET', '/api/anfrage')).text), statisch);
});

test('Rate-Limiting: zu viele Anfragestarts von einer IP werden mit 429 gebremst, andere IPs nicht', { skip }, async () => {
  await reset();
  const c = new Client(app, { ip: '203.0.113.9' });
  await c.req('POST', '/api/anfrage', { form: addressForm() });
  const codes = [];
  for (let i = 0; i < 22; i++) codes.push((await c.req('POST', '/api/anfrage', { form: startForm() })).status);
  assert.deepEqual(codes, [...Array(20).fill(303), 429, 429]);
  assert.equal((await analyze(new Client(app, { ip: '203.0.113.10' }))).start.status, 303);
  const v6 = ip => new Client(app, { ip }).req('POST', '/api/anfrage', { form: startForm() });
  for (let i = 0; i < 20; i++) await v6(`2001:db8:1:2::${i.toString(16)}`);
  assert.equal((await v6('2001:db8:1:2:ffff::1')).status, 429, 'IPv6 wird je /64 gezählt');
  assert.ok(!JSON.stringify(await app.sql('SELECT bucket FROM rate_limits')).includes('203.0.113'), 'IP nur pseudonymisiert gespeichert');
  /* „Analysieren“ hat ein eigenes Kontingent (20 in 10 Minuten je IP) */
  const h = new Client(app, { ip: '203.0.113.20' });
  const hero = [];
  for (let i = 0; i < 21; i++) hero.push((await h.req('POST', '/api/anfrage', { form: addressForm(`firma-${i}.de`) })).status);
  assert.deepEqual(hero, [...Array(20).fill(303), 429]);
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
