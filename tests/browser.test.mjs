/* PXWA – Browser-Prüfungen (Chromium, optional WebKit, über Playwright) gegen lokales Cloudflare Pages:
   `wrangler pages dev` mit public/, _routes.json, _headers und der Pages Function; /api/* geht über das Service Binding an den
   API-Worker (workerd, lokale D1). Das ist eine lokale Nachbildung, kein Test gegen echtes Cloudflare.
   Playwright ist bewusst keine Projekt-Abhängigkeit:
     PXK_PLAYWRIGHT=/pfad/zu/node_modules/playwright [PXK_AXE=/pfad/zu/axe.min.js] [PXK_SCREENSHOT_DIR=…] node --test tests/browser.test.mjs
   Die Google-Anmeldeseite ersetzt ein lokaler Mock-Endpunkt (/auth), der sofort mit einem Einmal-Code zurückleitet,
   so wie Google es nach erfolgreicher Anmeldung täte. (Playwright-Routen greifen bei Redirect-Zielen nicht.)
   Die Videos kommen aus public/media/ (versioniert) über die Video-Function functions/media/[file].ts (Byte-Ranges, 206).
   Ohne Playwright, Wrangler oder Worker-Abhängigkeiten: NOT_RUN statt bestanden. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mockGoogle, mockResend, startPages, waitFor, workerAvailable, wranglerAvailable, ROOT } from './lib/harness.mjs';

const SHOTS = process.env.PXK_SCREENSHOT_DIR || '';
const AXE = process.env.PXK_AXE || '';
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];
const pw = await (async () => {
  const dir = process.env.PXK_PLAYWRIGHT;
  try { return dir ? await import(pathToFileURL(join(dir, 'index.mjs')).href) : await import('playwright'); } catch { return null; }
})();
const skip = !pw ? 'NOT_RUN: Playwright nicht verfügbar (PXK_PLAYWRIGHT setzen)' : !workerAvailable ? 'NOT_RUN: miniflare/esbuild fehlen (npm ci)' : !wranglerAvailable ? 'NOT_RUN: wrangler fehlt (npm ci)' : false;
/* Antworten auf Video-Anfragen einer Seite: Pfad, Range-Kopf der Anfrage, Status */
function trackVideos(page) {
  const seen = [];
  page.on('response', r => { if (new URL(r.url()).pathname.endsWith('.mp4')) seen.push(r); });
  return () => Promise.all(seen.map(async r => ({ path: new URL(r.url()).pathname, range: (await r.request().allHeaders()).range ?? null, status: r.status() })));
}
/* Jede Range-Anfrage an ein Video bekam 206 (nie die ganze Datei mit 200), und jedes genannte Video wurde so geladen */
function assertRanges(list, paths, what) {
  const ranged = list.filter(x => x.range);
  assert.ok(ranged.length > 0, `${what}: Browser fragt Videos mit Range an (${JSON.stringify(list)})`);
  assert.deepEqual(ranged.filter(x => x.status !== 206), [], `${what}: Range-Anfragen ohne 206`);
  for (const p of paths) assert.ok(ranged.some(x => x.path === p), `${what}: ${p} nicht per Range geladen`);
}

let google, mail, app, browser;
before(async () => {
  if (skip) return;
  google = await mockGoogle().start();
  mail = await mockResend().start();
  app = await startPages({ google, mail });
  browser = await pw.chromium.launch();
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
});
after(async () => {
  if (skip) return;
  await browser.close(); await app.stop(); await google.stop(); await mail.stop();
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
  /* 'load' statt 'networkidle': Video-Anfragen (preload) können länger offen bleiben */
  await page.goto(app.base + path, { waitUntil: 'load' });
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
    await page.waitForTimeout(80);
    const f = await focusInfo(page);
    if (pred(f)) return f;
  }
  throw new Error('Element per Tab nicht erreichbar');
}

test('Mobile Hauptansicht: kein horizontaler Überlauf, Formular sichtbar, Navigationsbutton in der Pille (320/390/768/1440)', { skip }, async t => {
  for (const width of [320, 390, 768, 1440]) {
    for (const path of ['/index.html', '/pruefkriterien.html', '/api/anfrage', '/impressum.html', '/datenschutz.html', '/gibt/es/nicht']) {
      const { context, page, errors, blocked } = await open(path, { width, height: 800 });
      await page.$$eval('details', ds => ds.forEach(d => { d.open = true; }));
      assert.ok(await overflow(page) <= 0, `${path} ${width}: Überlauf`);
      const nav = await page.evaluate(() => {
        const n = document.querySelector('.nav').getBoundingClientRect(), b = document.querySelector('.nav .btn').getBoundingClientRect();
        return b.right <= n.right && b.left >= n.left;
      });
      assert.ok(nav, `${path} ${width}: Navigationsbutton ragt aus der Pille`);
      if (['/index.html', '/api/anfrage'].includes(path)) {
        const form = await page.evaluate(() => ['#url', '.url-field .btn'].map(s => { const r = document.querySelector(s).getBoundingClientRect(); return r.width > 0 && r.left >= 0 && r.right <= innerWidth; }));
        assert.deepEqual(form, [true, true], `${path} ${width}: Eingabefeld und Button vollständig sichtbar`);
      }
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `${path.slice(1).replace(/\W/g, '_')}-${width}.png`), fullPage: true });
      /* Die 404-Seite kommt korrekt mit Status 404; Chromium meldet das für das Dokument selbst als Konsolenfehler */
      const expected = path === '/gibt/es/nicht' ? ['Failed to load resource: the server responded with a status of 404 (Not Found)'] : [];
      assert.deepEqual(errors, expected, `${path} ${width}: Konsolenfehler (inkl. CSP)`);
      assert.deepEqual(blocked, [], `${path} ${width}: unerwartete Fremd-Requests`);
      await context.close();
    }
  }
  t.diagnostic(SHOTS ? `Screenshots: ${SHOTS}` : 'Screenshots nicht gespeichert (PXK_SCREENSHOT_DIR nicht gesetzt)');
});

test('Hero beim Öffnen: Überschrift, Text und Website-Eingabe vollständig im ersten Bildschirm und kontrastreich (Desktop und Mobil)', { skip }, async () => {
  /* Alles inklusive Faktenzeile sichtbar; beim sehr kleinen 320×568 mindestens Überschrift, Text, Eingabe und Button */
  const full = ['1920x1080', '1440x900', '1366x768', '1280x720', '1024x768', '768x1024', '390x844', '375x667', '360x740', '360x640'];
  const contrast = (a, b) => {
    const lum = c => { const [r, g, bl] = c.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }); return .2126 * r + .7152 * g + .0722 * bl; };
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + .05) / (y + .05);
  };
  for (const size of [...full, '320x568']) {
    const [width, height] = size.split('x').map(Number);
    const { context, page } = await open('/index.html', { width, height });
    const m = await page.evaluate(() => {
      const b = s => document.querySelector(s).getBoundingClientRect().bottom;
      const input = document.querySelector('#url');
      return {
        vh: innerHeight, nav: b('#nav'), h1Top: document.querySelector('.hero .h1').getBoundingClientRect().top,
        h1: b('.hero .h1'), lead: b('.hero .lead'), field: b('.url-field'), button: b('.url-field .btn'), facts: b('.hero .facts'),
        leadColor: getComputedStyle(document.querySelector('.hero .lead')).color, bodyBg: getComputedStyle(document.body).backgroundColor,
        placeholder: getComputedStyle(input, '::placeholder').color, fieldBg: getComputedStyle(input.closest('.url-field')).backgroundColor,
      };
    });
    const must = full.includes(size) ? ['h1', 'lead', 'field', 'button', 'facts'] : ['h1', 'lead', 'field', 'button'];
    for (const k of must) assert.ok(m[k] <= m.vh, `${size}: ${k} endet bei ${Math.round(m[k])} px, sichtbar sind ${m.vh} px`);
    assert.ok(m.h1Top >= m.nav, `${size}: Überschrift liegt nicht unter der Navigation`);
    assert.ok(contrast(m.leadColor, m.bodyBg) >= 7, `${size}: Lauftext kontrastreich`);
    assert.ok(contrast(m.placeholder, m.fieldBg) >= 7, `${size}: Platzhalter im Eingabefeld kontrastreich`);
    await context.close();
  }
});

test('Video unter dem Hero: mittig, abgerundet, ohne Bedienelemente, startet beim Hineinscrollen und läuft in Schleife (Range-Antworten 206)', { skip }, async () => {
  const state = page => page.evaluate(() => {
    const v = document.querySelector('.showcase-video'), f = v.closest('.showcase-frame'), r = f.getBoundingClientRect(), cs = getComputedStyle(f);
    return { paused: v.paused, time: v.currentTime, loop: v.loop, muted: v.muted, controls: v.controls, inline: v.playsInline,
      top: r.top, left: r.left, right: innerWidth - r.right, width: r.width, vw: innerWidth, vh: innerHeight, radius: parseFloat(cs.borderTopLeftRadius), overflow: cs.overflow };
  });
  for (const [width, height] of [[1440, 900], [390, 844]]) {
    const { context, page, errors, blocked } = await open('/index.html', { width, height, reducedMotion: 'no-preference' });
    const videos = trackVideos(page);
    const before = await state(page);
    assert.ok(before.top >= before.vh - 1, `${width}: Video liegt unter dem ersten Bildschirm`);
    assert.equal(before.paused, true, `${width}: läuft vor dem Scrollen noch nicht`);
    await page.evaluate(() => scrollBy(0, 250));
    await page.waitForFunction(() => { const v = document.querySelector('.showcase-video'); return !v.paused && v.currentTime > 0.3; }, null, { timeout: 5000 });
    const m = await state(page);
    assert.deepEqual([m.loop, m.muted, m.controls, m.inline], [true, true, false, true], `${width}: Schleife, stumm, ohne Bedienelemente`);
    assert.ok(Math.abs(m.left - m.right) <= 1, `${width}: mittig (${m.left} / ${m.right})`);
    assert.ok(m.width <= 960 && m.width < m.vw, `${width}: nicht über die ganze Breite (${m.width})`);
    assert.ok(m.radius >= 12 && m.overflow === 'hidden', `${width}: abgerundete Ecken`);
    /* Schleife: kurz vor dem Ende springt das Video wieder an den Anfang */
    await page.evaluate(() => { const v = document.querySelector('.showcase-video'); v.currentTime = v.duration - 0.3; });
    await page.waitForFunction(() => { const v = document.querySelector('.showcase-video'); return !v.paused && v.currentTime < 2; }, null, { timeout: 5000 });
    assertRanges(await videos(), ['/media/360-pixelkiez-video-1080p.mp4'], `Chromium ${width}`);
    assert.deepEqual(errors, [], `${width}: Konsolenfehler`);
    assert.deepEqual(blocked, [], `${width}: unerwartete Fremd-Requests`);
    await context.close();
  }
  /* Bewegung reduzieren (Betriebssystem): Standbild statt automatischer Wiedergabe */
  const { context, page } = await open('/index.html', { width: 1440, height: 900, reducedMotion: 'reduce' });
  await page.evaluate(() => scrollBy(0, 400));
  await page.waitForTimeout(800);
  assert.equal((await state(page)).paused, true);
  await context.close();
});

test('Video bei „Ihr Bericht“: rechts neben dem Text (mobil darunter), abgerundet, lädt und startet erst beim Hineinscrollen (Range-Antworten 206)', { skip }, async () => {
  for (const [width, height] of [[1440, 900], [390, 844]]) {
    const { context, page, errors, blocked } = await open('/index.html', { width, height, reducedMotion: 'no-preference' });
    const videos = trackVideos(page);
    const report = () => page.evaluate(() => {
      const v = document.querySelector('#bericht .showcase-video'), f = v.closest('.showcase-frame'), t = document.querySelector('#bericht .split-copy');
      const fr = f.getBoundingClientRect(), tr = t.getBoundingClientRect();
      return { paused: v.paused, time: v.currentTime, loop: v.loop, controls: v.controls, buffered: v.buffered.length,
        right: fr.left >= tr.right, below: fr.top >= tr.bottom, radius: parseFloat(getComputedStyle(f).borderTopLeftRadius), overflow: getComputedStyle(f).overflow,
        square: Math.abs(fr.width - fr.height) <= 2, width: fr.width };
    });
    const before = await report();
    assert.equal(before.paused, true, `${width}: läuft erst beim Hineinscrollen`);
    assert.equal(before.buffered, 0, `${width}: lädt erst, wenn es gebraucht wird`);
    await page.evaluate(() => document.querySelector('#bericht .showcase-frame').scrollIntoView({ block: 'center' }));
    await page.waitForFunction(() => { const v = document.querySelector('#bericht .showcase-video'); return !v.paused && v.currentTime > 0.3; }, null, { timeout: 8000 });
    const m = await report();
    assert.ok(width >= 1000 ? m.right : m.below, `${width}: ${width >= 1000 ? 'rechts neben' : 'unter'} dem Text`);
    assert.deepEqual([m.loop, m.controls], [true, false]);
    assert.ok(m.radius >= 12 && m.overflow === 'hidden', `${width}: abgerundete Ecken`);
    assert.ok(m.square && m.width <= 560, `${width}: quadratisch, höchstens 560 px (${m.width})`);
    assert.equal(await page.evaluate(() => document.querySelector('.showcase-video').paused), true, `${width}: Video unter dem Hero hält außerhalb des Bildes an`);
    assertRanges(await videos(), ['/media/report-pdf-de-1x1.mp4'], `Chromium ${width}`);
    assert.deepEqual(errors, [], `${width}: Konsolenfehler`);
    assert.deepEqual(blocked, [], `${width}: unerwartete Fremd-Requests`);
    await context.close();
  }
});

test('Safari-Engine (WebKit): beide Videos laufen – Range-Anfragen bekommen 206 von der Video-Function; scheitert das Laden, steht das Standbild in gleicher Größe da', { skip }, async t => {
  let wk;
  try { wk = await pw.webkit.launch(); } catch { t.skip('NOT_RUN: Playwright-WebKit nicht installiert (playwright install webkit)'); return; }
  const frames = page => page.evaluate(() => [...document.querySelectorAll('.showcase-video')].map(e => {
    const r = e.getBoundingClientRect(), f = e.closest('.showcase-frame').getBoundingClientRect();
    return { tag: e.tagName, label: e.alt || e.getAttribute('aria-label'), fills: Math.abs(r.width - f.width) <= 1 && Math.abs(r.height - f.height) <= 1 };
  }));
  try {
    for (const [width, height] of [[390, 844], [1440, 900]]) {
      const ctx = await wk.newContext({ viewport: { width, height }, reducedMotion: 'no-preference' });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', e => errors.push(String(e)));
      const videos = trackVideos(page);
      await page.goto(app.base + '/', { waitUntil: 'load' });
      for (const sel of ['.showcase', '#bericht .showcase-frame']) {
        await page.evaluate(s => document.querySelector(s).scrollIntoView({ block: 'center' }), sel);
        /* Echte Wiedergabe: das Element bleibt ein Video (kein Standbild-Ersatz) und die Zeit läuft */
        await page.waitForFunction(s => {
          const e = document.querySelector(s).querySelector('.showcase-video');
          return e.tagName === 'VIDEO' && !e.paused && e.currentTime > 0.3 && e.readyState >= 3;
        }, sel, { timeout: 15000 });
      }
      const shown = await frames(page);
      assert.deepEqual(shown.map(e => e.tag), ['VIDEO', 'VIDEO'], `${width}: beide Videos spielen, kein Standbild`);
      for (const e of shown) {
        assert.ok(e.fills, `${width}: füllt den abgerundeten Rahmen`);
        assert.match(e.label, /^Animierte/, `${width}: Alternativtext bleibt`);
      }
      const list = await videos();
      assertRanges(list, ['/media/360-pixelkiez-video-1080p.mp4', '/media/report-pdf-de-1x1.mp4'], `WebKit ${width}`);
      assert.deepEqual(errors, [], `${width}: Skriptfehler`);
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `webkit-${width}.png`) });
      t.diagnostic(`WebKit ${width}: beide Videos spielen; MP4-Antworten: ${list.map(x => `${x.path.slice(7)} ${x.range ?? 'ohne Range'} → ${x.status}`).join(', ')}`);
      await ctx.close();
    }
    /* Poster-Fallback bleibt: Ist ein Video nicht ladbar (Netz, Kontingent, Fehler), ersetzt das Standbild es in gleicher Größe */
    const ctx = await wk.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'no-preference' });
    await ctx.route('**/*.mp4', r => r.abort());
    const page = await ctx.newPage();
    await page.goto(app.base + '/', { waitUntil: 'load' });
    for (const sel of ['.showcase', '#bericht .showcase-frame']) {
      await page.evaluate(s => document.querySelector(s).scrollIntoView({ block: 'center' }), sel);
      await page.waitForFunction(s => { const e = document.querySelector(s).querySelector('.showcase-video'); return e.tagName === 'IMG' && e.complete && e.naturalWidth > 0; }, sel, { timeout: 10000 });
    }
    const still = await frames(page);
    assert.deepEqual(still.map(e => [e.tag, e.fills, /^Animierte/.test(e.label)]), [['IMG', true, true], ['IMG', true, true]], 'Standbild statt schwarzer Fläche');
    await ctx.close();
  } finally {
    await wk.close();
  }
});

test('Scrollen: Inhalte blenden beim Hineinscrollen ein; oben nichts versteckt; ohne JavaScript und bei „Bewegung reduzieren“ alles sofort sichtbar', { skip }, async () => {
  const { context, page, errors } = await open('/index.html', { width: 1440, height: 900, reducedMotion: 'no-preference' });
  const info = await page.evaluate(() => ({ hiddenAbove: [...document.querySelectorAll('.reveal')].filter(e => e.getBoundingClientRect().top <= innerHeight).length, hiddenBelow: document.querySelectorAll('.reveal:not(.is-visible)').length }));
  assert.equal(info.hiddenAbove, 0, 'im ersten Bildschirm wird nichts ausgeblendet');
  assert.ok(info.hiddenBelow > 10, 'weiter unten wartet Inhalt auf das Einblenden');
  await page.evaluate(() => document.querySelector('#warum').scrollIntoView({ behavior: 'instant', block: 'start' }));
  await page.waitForFunction(() => [...document.querySelectorAll('#warum .why-item')].every(e => e.classList.contains('is-visible') && getComputedStyle(e).opacity === '1'), null, { timeout: 5000 });
  assert.deepEqual(errors, []);
  await context.close();
  for (const variant of [{ reducedMotion: 'reduce' }, { javaScriptEnabled: false }]) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...variant });
    const pg = await ctx.newPage();
    await pg.goto(app.base + '/index.html', { waitUntil: 'load' });
    assert.equal(await pg.evaluate(() => document.querySelectorAll('.reveal').length), 0, JSON.stringify(variant));
    assert.equal(await pg.evaluate(() => getComputedStyle(document.querySelector('#warum .why-item')).opacity), '1', JSON.stringify(variant));
    await ctx.close();
  }
});

test('Tastatur: ungültige Eingabe bleibt im Feld; gültige Anfrage komplett per Tab/Enter/Leertaste bis zur Referenz (mobil und Desktop)', { skip }, async () => {
  for (const width of [390, 1440]) {
    await app.exec('DELETE FROM notifications; DELETE FROM orders; DELETE FROM rate_limits; DELETE FROM sessions');
    mail.reset();
    /* bypassCSP nur hier: Die statische Meta-CSP erlaubt als Formularziel nur https://accounts.google.com, nicht den lokalen Mock.
       Die CSP selbst prüfen der Mobil-Test (keine CSP-Konsolenfehler) und tests/static.test.mjs (form-action). */
    const before = google.log.auth || 0;
    const { context, page, errors, blocked } = await open('/index.html', { width, height: 800, bypassCSP: true });
    const field = await tabTo(page, f => f.id === 'url');
    assert.ok(field.visible, 'Fokus im URL-Feld sichtbar');
    await page.keyboard.type('keine adresse');
    await page.keyboard.press('Enter');
    assert.equal(await page.isVisible('#url-error'), true);
    assert.deepEqual(await page.evaluate(() => [document.activeElement.id, document.activeElement.getAttribute('aria-invalid'), location.pathname]), ['url', 'true', '/'], 'Pages liefert /index.html unter / aus');
    await page.fill('#url', '');
    await page.keyboard.type('musterfirma.de');
    await Promise.all([page.waitForURL(`${app.base}/api/anfrage`), page.keyboard.press('Enter')]);
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
    assert.equal((await app.sql('SELECT COUNT(*) AS n FROM orders'))[0].n, 1);
    await waitFor(() => mail.state.accepted.length === 1, { what: 'interne Benachrichtigung' });
    assert.deepEqual(mail.state.accepted[0].to, ['kontakt@pixelkiez.de']);
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
  for (const path of ['/index.html', '/pruefkriterien.html', '/impressum.html', '/datenschutz.html', '/api/anfrage', 'confirm']) {
    /* axe wird als Inline-Skript injiziert; die CSP der Seite würde das (korrekt) blockieren */
    const o = await open(path === 'confirm' ? '/index.html' : path, { bypassCSP: true });
    if (path === 'confirm') {
      await o.page.fill('#url', 'musterfirma.de');
      await Promise.all([o.page.waitForURL(`${app.base}/api/anfrage`), o.page.press('#url', 'Enter')]);
    }
    await o.page.addScriptTag({ path: AXE });
    const v = await o.page.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'] })).violations.map(x => ({ id: x.id, impact: x.impact, n: x.nodes.length })));
    report[path] = v;
    assert.deepEqual(v.filter(x => ['serious', 'critical'].includes(x.impact)), [], `${path}: schwere axe-Verstöße`);
    await o.context.close();
  }
  t.diagnostic(`axe: ${JSON.stringify(report)}`);
});
