/* PXWA – Browser-Prüfungen (Chromium über Playwright) gegen php -S mit lokalen Mocks.
   Playwright ist bewusst keine Projekt-Abhängigkeit:
     PXK_PLAYWRIGHT=/pfad/zu/node_modules/playwright [PXK_AXE=/pfad/zu/axe.min.js] [PXK_SCREENSHOT_DIR=…] node --test tests/browser.test.mjs
   Die Google-Anmeldeseite ersetzt ein lokaler Mock-Endpunkt (/auth), der sofort mit einem Einmal-Code zurückleitet,
   so wie Google es nach erfolgreicher Anmeldung täte. (Playwright-Routen greifen bei Redirect-Zielen nicht.)
   Ohne Playwright oder PHP: NOT_RUN statt bestanden. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mockGoogle, mockSmtp, startApp, phpAvailable, sqliteAvailable } from './lib/harness.mjs';

const SHOTS = process.env.PXK_SCREENSHOT_DIR || '';
const AXE = process.env.PXK_AXE || '';
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];
const pw = await (async () => {
  const dir = process.env.PXK_PLAYWRIGHT;
  try { return dir ? await import(pathToFileURL(join(dir, 'index.mjs')).href) : await import('playwright'); } catch { return null; }
})();
const skip = !pw ? 'NOT_RUN: Playwright nicht verfügbar (PXK_PLAYWRIGHT setzen)' : !(phpAvailable && sqliteAvailable) ? 'NOT_RUN: php/sqlite3 fehlt' : false;

let google, smtp, app, browser;
before(async () => {
  if (skip) return;
  google = await mockGoogle().start();
  smtp = await mockSmtp().start();
  app = await startApp({ google, smtp, authEndpoint: `${google.origin}/auth` });
  browser = await pw.chromium.launch();
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
});
after(async () => {
  if (skip) return;
  await browser.close(); await app.stop(); await google.stop(); await smtp.stop();
});

async function open(path, { width = 1440, height = 900, reducedMotion = 'reduce', bypassCSP = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion, bypassCSP });
  const page = await context.newPage();
  const errors = [], blocked = [];
  await context.route('**/*', route => {
    const u = new URL(route.request().url());
    if (u.origin === app.base || FONT_HOSTS.includes(u.hostname)) return route.continue();
    if (u.origin === google.origin && u.pathname === '/auth') return route.continue();
    blocked.push(u.href);
    return route.abort();
  });
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(app.base + path, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  return { context, page, errors, blocked };
}

const overflow = page => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const focusInfo = page => page.evaluate(() => {
  const e = document.activeElement, cs = getComputedStyle(e);
  const field = e.closest('.url-field');
  return {
    id: e.id, tag: e.tagName, type: e.getAttribute('type'), name: e.getAttribute('name'), text: (e.innerText || '').trim(),
    visible: (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || (field && getComputedStyle(field).boxShadow !== 'none'),
  };
});
async function tabTo(page, pred, max = 40) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    /* styles.css setzt bei reduzierter Bewegung transition-duration .01ms für alle Eigenschaften – kurz warten, bis die Outline steht */
    await page.waitForTimeout(30);
    const f = await focusInfo(page);
    if (pred(f)) return f;
  }
  throw new Error('Element per Tab nicht erreichbar');
}

test('Mobile Hauptansicht: kein horizontaler Überlauf, Formular sichtbar, Navigationsbutton in der Pille (320/390/768/1440)', { skip }, async t => {
  for (const width of [320, 390, 768, 1440]) {
    for (const path of ['/index.html', '/pruefkriterien.html', '/anfrage.php']) {
      const { context, page, errors, blocked } = await open(path, { width, height: 800 });
      await page.$$eval('details', ds => ds.forEach(d => { d.open = true; }));
      assert.ok(await overflow(page) <= 0, `${path} ${width}: Überlauf`);
      const nav = await page.evaluate(() => {
        const n = document.querySelector('.nav').getBoundingClientRect(), b = document.querySelector('.nav .btn').getBoundingClientRect();
        return b.right <= n.right && b.left >= n.left;
      });
      assert.ok(nav, `${path} ${width}: Navigationsbutton ragt aus der Pille`);
      if (path !== '/pruefkriterien.html') {
        const form = await page.evaluate(() => ['#url', '.url-field .btn'].map(s => { const r = document.querySelector(s).getBoundingClientRect(); return r.width > 0 && r.left >= 0 && r.right <= innerWidth; }));
        assert.deepEqual(form, [true, true], `${path} ${width}: Eingabefeld und Button vollständig sichtbar`);
      }
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `${path.slice(1).replace(/\W/g, '_')}-${width}.png`), fullPage: true });
      assert.deepEqual(errors, [], `${path} ${width}: Konsolenfehler (inkl. CSP)`);
      assert.deepEqual(blocked, [], `${path} ${width}: unerwartete Fremd-Requests`);
      await context.close();
    }
  }
  t.diagnostic(SHOTS ? `Screenshots: ${SHOTS}` : 'Screenshots nicht gespeichert (PXK_SCREENSHOT_DIR nicht gesetzt)');
});

test('Tastatur: ungültige Eingabe bleibt im Feld; gültige Anfrage komplett per Tab/Enter/Leertaste bis zur Referenz (mobil und Desktop)', { skip }, async () => {
  for (const width of [390, 1440]) {
    app.exec('DELETE FROM notifications; DELETE FROM orders; DELETE FROM rate_limits;');
    smtp.state.accepted.length = 0;
    /* bypassCSP nur hier: Die statische Meta-CSP erlaubt als Formularziel nur https://accounts.google.com, nicht den lokalen Mock.
       Die CSP selbst prüfen der Mobil-Test (keine CSP-Konsolenfehler) und tests/static.test.mjs (form-action). */
    const before = google.log.auth || 0;
    const { context, page, errors, blocked } = await open('/index.html', { width, height: 800, bypassCSP: true });
    const field = await tabTo(page, f => f.id === 'url');
    assert.ok(field.visible, 'Fokus im URL-Feld sichtbar');
    await page.keyboard.type('keine adresse');
    await page.keyboard.press('Enter');
    assert.equal(await page.isVisible('#url-error'), true);
    assert.deepEqual(await page.evaluate(() => [document.activeElement.id, document.activeElement.getAttribute('aria-invalid'), location.pathname]), ['url', 'true', '/index.html']);
    await page.fill('#url', '');
    await page.keyboard.type('musterfirma.de');
    await Promise.all([page.waitForURL(`${app.base}/anfrage.php`), page.keyboard.press('Enter')]);
    assert.equal(google.log.auth - before, 1, 'genau eine Google-Autorisierung');
    assert.equal(google.log.lastAuth.scope, 'openid email');
    assert.match(await page.textContent('h1'), /Anfrage bestätigen/);
    const box = await tabTo(page, f => f.type === 'checkbox');
    assert.ok(box.visible, 'Fokus auf Checkbox sichtbar');
    await page.keyboard.press('Space');
    assert.equal(await page.isChecked('input[name=zustimmung]'), true);
    const submit = await tabTo(page, f => f.tag === 'BUTTON');
    assert.equal(submit.text, 'Kostenlos anfragen');
    assert.ok(submit.visible, 'Fokus auf Absende-Button sichtbar');
    await Promise.all([page.waitForSelector('#reference'), page.keyboard.press('Enter')]);
    assert.match(await page.textContent('#reference'), /^PXA-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    assert.ok(await overflow(page) <= 0, `${width}: Überlauf auf der Bestätigung`);
    assert.equal(app.sql('SELECT COUNT(*) AS n FROM orders')[0].n, 1);
    assert.equal(smtp.state.accepted.length, 1);
    const cookies = await context.cookies();
    assert.ok(cookies.every(c => c.httpOnly && c.sameSite === 'Lax'), 'Session-Cookie HttpOnly/Lax');
    const storage = await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length, cookie: document.cookie }));
    assert.deepEqual(storage, { local: 0, session: 0, cookie: '' }, 'nichts im Browser-Speicher, Cookie für JS unsichtbar');
    assert.deepEqual(errors, [], `${width}: Konsolenfehler`);
    assert.deepEqual(blocked, []);
    await context.close();
  }
});

test('Accessibility-Snapshot (axe-core): keine schweren Verstöße auf Startseite, Methodik, Eingabe- und Bestätigungsseite', { skip: skip || (!AXE && 'NOT_RUN: PXK_AXE nicht gesetzt') }, async t => {
  const report = {};
  for (const path of ['/index.html', '/pruefkriterien.html', '/anfrage.php', 'confirm']) {
    /* axe wird als Inline-Skript injiziert; die CSP der Seite würde das (korrekt) blockieren */
    const o = await open(path === 'confirm' ? '/index.html' : path, { bypassCSP: true });
    if (path === 'confirm') {
      await o.page.fill('#url', 'musterfirma.de');
      await Promise.all([o.page.waitForURL(`${app.base}/anfrage.php`), o.page.press('#url', 'Enter')]);
    }
    await o.page.addScriptTag({ path: AXE });
    const v = await o.page.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'] })).violations.map(x => ({ id: x.id, impact: x.impact, n: x.nodes.length })));
    report[path] = v;
    assert.deepEqual(v.filter(x => ['serious', 'critical'].includes(x.impact)), [], `${path}: schwere axe-Verstöße`);
    await o.context.close();
  }
  t.diagnostic(`axe: ${JSON.stringify(report)}`);
});
