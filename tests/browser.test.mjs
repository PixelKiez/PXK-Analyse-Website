/* PXWA – Browser-Prüfungen (Chromium, optional WebKit, über Playwright) gegen lokales Cloudflare Pages:
   `wrangler pages dev` mit public/, _routes.json, _headers und der Pages Function; /api/* geht über das Service Binding an den
   API-Worker (workerd, lokale D1). Das ist eine lokale Nachbildung, kein Test gegen echtes Cloudflare.
   Playwright ist bewusst keine Projekt-Abhängigkeit:
     PXK_PLAYWRIGHT=/pfad/zu/node_modules/playwright [PXK_AXE=/pfad/zu/axe.min.js] [PXK_SCREENSHOT_DIR=…] node --test tests/browser.test.mjs
   Die Google-Anmeldeseite ersetzt ein lokaler Mock-Endpunkt (/auth), der sofort mit einem Einmal-Code zurückleitet,
   so wie Google es nach erfolgreicher Anmeldung täte. (Playwright-Routen greifen bei Redirect-Zielen nicht.)
   Die Videos kommen aus lokalem R2 (Binding MEDIA) über die Video-Function functions/media/[file].ts (Byte-Ranges, 206);
   für die Wiedergabe braucht es die echten Dateien: PXK_MEDIA_DIR=/pfad/mit/den/drei/R2-Objekten.
   Soft-Launch (Hero ohne Formular): Website ohne verbundenen Worker wie in Produktion (/api/* 503); Formular-Szenarien werden
   als übersprungen gemeldet, der Test „Soft-Launch im Browser“ prüft Hinweis, Partner und dass nichts gesendet wird.
   Ohne Playwright, Wrangler oder Worker-Abhängigkeiten: NOT_RUN statt bestanden. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mockGoogle, mockResend, startPages, waitFor, sleep, workerAvailable, wranglerAvailable, ROOT, TERMS_VERSION, SOFT_LAUNCH, SOFT_LAUNCH_SKIP, R2_VIDEOS, R2_BILDER, R2_MEDIEN } from './lib/harness.mjs';

const SHOTS = process.env.PXK_SCREENSHOT_DIR || '';
const AXE = process.env.PXK_AXE || '';
const MEDIA_DIR = process.env.PXK_MEDIA_DIR || '';
/* Schriften selbst ausgeliefert (Website und Worker-Seiten): jede Anfrage an Google Fonts zählt als Fremd-Request (blocked) */
const FONT_HOSTS = [];
/* Alle 22 Seiten der Website (ohne die Seiten des API-Workers) */
const SEITEN = ['/index.html', '/impressum.html', '/datenschutz.html', '/agb.html', '/wissen/index.html', '/wissen/seo-geo-ai-visibility.html', '/wissen/wie-ki-websites-liest.html', '/wissen/wie-websites-ausgeliefert-werden.html', '/wissen/answerability.html', '/wissen/entity-trust.html', '/wissen/agent-readiness.html', '/analyse/index.html', '/analyse/auffindbarkeit-seo.html', '/analyse/performance-technik.html', '/analyse/nutzerfuehrung-conversion.html', '/analyse/vertrauen-datenschutz.html', '/analyse/barrierefreiheit.html', '/analyse/ki-verstaendlichkeit.html', '/analyse/methodik.html', '/analyse/warum-website-analyse.html', '/analyse/ki-crawler-agenten.html', '/gibt/es/nicht'];
const pw = await (async () => {
  const dir = process.env.PXK_PLAYWRIGHT;
  try { return dir ? await import(pathToFileURL(join(dir, 'index.mjs')).href) : await import('playwright'); } catch { return null; }
})();
const skip = !pw ? 'NOT_RUN: Playwright nicht verfügbar (PXK_PLAYWRIGHT setzen)' : !workerAvailable ? 'NOT_RUN: miniflare/esbuild fehlen (npm ci)' : !wranglerAvailable ? 'NOT_RUN: wrangler fehlt (npm ci)' : false;
const videoSkip = skip || (!MEDIA_DIR && 'NOT_RUN: PXK_MEDIA_DIR nicht gesetzt (echte Videos aus R2 für die Wiedergabe)');
const formSkip = skip || SOFT_LAUNCH_SKIP;
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
  /* Lokales R2: mit PXK_MEDIA_DIR die echten Objekte; ohne nur das Hintergrundbild als WebP-Platzhalter (1 × 1 px), damit die
     Startseite keine 404 in der Konsole hat – die Video-Tests melden dann NOT_RUN */
  const platzhalter = () => {
    const dir = mkdtempSync(join(tmpdir(), 'pxwa-bild-'));
    return Object.fromEntries(R2_BILDER.map((k, i) => { const f = join(dir, `${i}.webp`); writeFileSync(f, Buffer.from('UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAdQ+L43vv+BiOh/AAA=', 'base64')); return [k, f]; }));
  };
  const media = MEDIA_DIR ? Object.fromEntries(R2_MEDIEN.map(([, k]) => [k, join(MEDIA_DIR, k)])) : platzhalter();
  app = await startPages(SOFT_LAUNCH ? { worker: false, media } : { google, mail, media });
  browser = await pw.chromium.launch();
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
});
after(async () => {
  if (skip) return;
  await browser.close(); await app.stop(); await google.stop(); await mail.stop();
});

async function open(path, { width = 1440, height = 900, reducedMotion = 'reduce', bypassCSP = false, javaScriptEnabled = true, engine = browser, videos = false } = {}) {
  const context = await engine.newContext({ viewport: { width, height }, reducedMotion, bypassCSP, javaScriptEnabled });
  const page = await context.newPage();
  const errors = [], blocked = [], requests = [];
  page.on('request', r => requests.push({ method: r.method(), url: r.url(), body: r.postData() ?? '' }));
  /* Video-Antworten ab der Navigation mitschreiben: preload="auto" fragt schon vor 'load' an */
  const tracked = videos ? trackVideos(page) : null;
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
  if (javaScriptEnabled) await page.evaluate(() => document.fonts.ready);
  return { context, page, errors, blocked, requests, videos: tracked };
}
const resetData = async () => { await app.exec('DELETE FROM notifications; DELETE FROM orders; DELETE FROM rate_limits; DELETE FROM sessions'); mail.reset(); };
const orderCount = () => app.sql('SELECT COUNT(*) AS n FROM orders')[0].n;
/* Die eingegebene Website darf nur im POST-Body stehen, nie in einer URL (keine Übertragung per GET, nicht an Google) */
const leaks = (requests, needle) => requests.filter(r => r.url.toLowerCase().includes(needle));

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

test('Mobile Hauptansicht: kein horizontaler Überlauf, Formular (im Soft-Launch der Hinweis) sichtbar, Navigationsbutton in der Pille (320/390/768/1440)', { skip }, async t => {
  for (const width of [320, 390, 768, 1440]) {
    /* Soft-Launch: /api/anfrage antwortet in Produktion mit 503 (kein Worker), daher nur die Seiten der Website */
    for (const path of SOFT_LAUNCH ? SEITEN : ['/index.html', '/api/anfrage', '/impressum.html', '/datenschutz.html', '/agb.html', '/wissen/index.html', '/wissen/seo-geo-ai-visibility.html', '/wissen/wie-ki-websites-liest.html', '/wissen/wie-websites-ausgeliefert-werden.html', '/wissen/answerability.html', '/wissen/entity-trust.html', '/wissen/agent-readiness.html', '/analyse/index.html', '/analyse/auffindbarkeit-seo.html', '/analyse/performance-technik.html', '/analyse/nutzerfuehrung-conversion.html', '/analyse/vertrauen-datenschutz.html', '/analyse/barrierefreiheit.html', '/analyse/ki-verstaendlichkeit.html', '/analyse/methodik.html', '/analyse/warum-website-analyse.html', '/analyse/ki-crawler-agenten.html', '/gibt/es/nicht']) {
      const { context, page, errors, blocked } = await open(path, { width, height: 800 });
      await page.$$eval('details', ds => ds.forEach(d => { d.open = true; }));
      assert.ok(await overflow(page) <= 0, `${path} ${width}: Überlauf`);
      const nav = await page.evaluate(() => {
        const n = document.querySelector('.nav').getBoundingClientRect(), b = document.querySelector('.nav .btn').getBoundingClientRect();
        return b.right <= n.right && b.left >= n.left;
      });
      assert.ok(nav, `${path} ${width}: Navigationsbutton ragt aus der Pille`);
      /* Mobil (ohne Menüleiste) steht daneben der Menü-Button, ebenfalls ganz in der Pille */
      const menu = await page.evaluate(() => {
        const n = document.querySelector('.nav').getBoundingClientRect(), m = document.querySelector('.nav-menu summary').getBoundingClientRect();
        return [m.width > 0, m.right <= n.right && m.left >= n.left];
      });
      assert.deepEqual(menu, width <= 760 ? [true, true] : [false, menu[1]], `${path} ${width}: Menü-Button nur mobil und in der Pille`);
      /* Verwaschener Verlauf der Startseite (Auftraggeber 04.11.2026): auf body ab dem oberen Bildschirmrand hinter der Menüleiste,
         so breit wie der Rahmen; ab 1321 px setzt die erste Ebene die Rahmenlinien bis oben fort. Hintergrundfarbe Lila (Statusleiste
         in Safari ab iOS 26), sichtbar bleibt die Papiergrau-Ebene; main ohne eigenen Verlauf */
      if (path === '/index.html') {
        const verlauf = await page.evaluate(() => { const b = getComputedStyle(document.body);
          return [b.backgroundColor, b.backgroundImage.startsWith('linear-gradient'), b.backgroundSize.split(', ')[0] !== '0px 0px', getComputedStyle(document.querySelector('main.frame')).backgroundImage]; });
        assert.deepEqual(verlauf, ['rgb(235, 226, 252)', true, width > 1320, 'none'], `${path} ${width}: Verlauf ab Bildschirmrand, Rahmenlinien bis oben nur mit Rahmen`);
      }
      if (SOFT_LAUNCH && path === '/index.html') {
        const hinweis = await page.evaluate(() => { const r = document.querySelector('.hero .bald').getBoundingClientRect(); return r.width > 0 && r.left >= 0 && r.right <= innerWidth; });
        assert.ok(hinweis, `${path} ${width}: Hinweis „in Kürze verfügbar“ vollständig sichtbar`);
      } else if (['/index.html', '/api/anfrage'].includes(path)) {
        /* Startseite und Adresseingabe des Workers (ohne Sitzung): Eingabefeld und „Analysieren“, kein Kästchen; die Bestätigungsseite
           prüft der Test „Nutzerreise“ in allen Breiten */
        const form = await page.evaluate(() => [...['#url', '.url-field .btn'].map(s => { const r = document.querySelector(s).getBoundingClientRect(); return r.width > 0 && r.left >= 0 && r.right <= innerWidth; }),
          document.querySelector('.url-field .btn').textContent.trim(), document.querySelectorAll('input[type=checkbox]').length]);
        assert.deepEqual(form, [true, true, 'Analysieren', 0], `${path} ${width}: Eingabefeld und „Analysieren“ vollständig sichtbar, kein Kästchen`);
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

test('Hero beim Öffnen: Überschrift, Text, Website-Eingabe, „Analysieren“, Hinweis- und Faktenzeile im ersten Bildschirm (ab 360×640), kein Kästchen, kontrastreich (Desktop und Mobil)', { skip: formSkip }, async t => {
  /* PO-Entscheidung 12.11.2026: keine Kästchen im Hero. Überschrift, Text, Eingabe, Schaltfläche, Hinweiszeile (0 €, Datenschutz) und
     Faktenzeile liegen im ersten Bildschirm, auch bei 360×640 (die frühere Abweichung M-1 entfällt). Beim sehr kleinen 320×568
     mindestens Überschrift, Text, Eingabe und Button. */
  const full = ['1920x1080', '1440x900', '1366x768', '1280x720', '1024x768', '768x1024', '390x844', '375x667', '360x740'];
  const compact = ['360x640'];
  const contrast = (a, b) => {
    const lum = c => { const [r, g, bl] = c.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }); return .2126 * r + .7152 * g + .0722 * bl; };
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + .05) / (y + .05);
  };
  for (const size of [...full, ...compact, '320x568']) {
    const [width, height] = size.split('x').map(Number);
    const { context, page } = await open('/index.html', { width, height });
    const m = await page.evaluate(() => {
      const b = s => document.querySelector(s).getBoundingClientRect().bottom;
      const input = document.querySelector('#url');
      return {
        vh: innerHeight, nav: b('#nav'), h1Top: document.querySelector('.hero .h1').getBoundingClientRect().top,
        h1: b('.hero .h1'), lead: b('.hero .lead'), field: b('.url-field'), button: b('.url-field .btn'), note: b('.hero .hero-note'), facts: b('.hero .facts'),
        boxes: document.querySelectorAll('.hero input[type=checkbox]').length,
        leadColor: getComputedStyle(document.querySelector('.hero .lead')).color, bodyBg: getComputedStyle(document.body).backgroundColor,
        placeholder: getComputedStyle(input, '::placeholder').color, fieldBg: getComputedStyle(input.closest('.url-field')).backgroundColor,
      };
    });
    assert.equal(m.boxes, 0, `${size}: kein Kästchen im Hero`);
    const must = [...full, ...compact].includes(size) ? ['h1', 'lead', 'field', 'button', 'note', 'facts'] : ['h1', 'lead', 'field', 'button'];
    for (const k of must) assert.ok(m[k] <= m.vh, `${size}: ${k} endet bei ${Math.round(m[k])} px, sichtbar sind ${m.vh} px`);
    t.diagnostic(`${size}: Hinweis ${Math.round(m.note)} px, Faktenzeile ${Math.round(m.facts)} px (sichtbar ${m.vh} px)`);
    assert.ok(m.h1Top >= m.nav, `${size}: Überschrift liegt nicht unter der Navigation`);
    assert.ok(contrast(m.leadColor, m.bodyBg) >= 7, `${size}: Lauftext kontrastreich`);
    assert.ok(contrast(m.placeholder, m.fieldBg) >= 7, `${size}: Platzhalter im Eingabefeld kontrastreich`);
    await context.close();
  }
});

test('Befund-Video bei „Jeder Befund verständlich erklärt“: links neben den Punkten (mobil darunter), 5:4, abgerundet, startet von selbst erst im Bild, stumm, Schleife, ohne Bedienelemente (Range-Antworten 206)', { skip: videoSkip }, async () => {
  /* An der Stelle der früheren Beispielkarte (Entscheidung des Auftraggebers 03.11.2026, PXK-159); unter dem Hero das Ablauf-Video (P0-Hotfix) */
  for (const [width, height] of [[1440, 900], [390, 844]]) {
    const { context, page, errors, blocked, videos } = await open('/index.html', { width, height, reducedMotion: 'no-preference', videos: true });
    const state = () => page.evaluate(() => {
      const v = document.querySelector('#nutzen .showcase-video'), f = v.closest('.showcase-frame'), t = document.querySelector('#nutzen .split-copy');
      const fr = f.getBoundingClientRect(), tr = t.getBoundingClientRect(), cs = getComputedStyle(f);
      return { paused: v.paused, time: v.currentTime, loop: v.loop, muted: v.muted, controls: v.controls, inline: v.playsInline, buffered: v.buffered.length,
        left: fr.right <= tr.left, below: fr.top >= tr.bottom, radius: parseFloat(cs.borderTopLeftRadius), overflow: cs.overflow, ratio: fr.width / fr.height, width: fr.width,
        heroVideo: document.querySelectorAll('.showcase').length, autoplay: v.autoplay, knoepfe: document.querySelectorAll('.showcase-frame button, .video-toggle').length };
    });
    await page.waitForFunction(() => document.querySelector('#nutzen .showcase-video').paused);
    const before = await state();
    assert.deepEqual([before.paused, before.heroVideo, before.autoplay, before.knoepfe], [true, 1, false, 0], `${width}: außerhalb des Bildes angehalten; Hero-Video (Demo) da; ohne autoplay (Start per Skript); keine Schaltflächen`);
    await page.evaluate(() => document.querySelector('#nutzen .showcase-frame').scrollIntoView({ block: 'center' }));
    await page.waitForFunction(() => { const v = document.querySelector('#nutzen .showcase-video'); return !v.paused && v.currentTime > 0.3; }, null, { timeout: 8000 });
    const m = await state();
    assert.ok(width >= 1000 ? m.left : m.below, `${width}: ${width >= 1000 ? 'links neben' : 'unter'} den Punkten`);
    assert.deepEqual([m.loop, m.muted, m.controls, m.inline, m.knoepfe], [true, true, false, true, 0], `${width}: Schleife, stumm, inline, ohne Bedienelemente`);
    assert.ok(m.radius >= 12 && m.overflow === 'hidden', `${width}: abgerundete Ecken`);
    assert.ok(Math.abs(m.ratio - 1.25) < 0.01 && m.width <= 640, `${width}: 5:4, höchstens 640 px (${m.width} px, ${m.ratio.toFixed(3)})`);
    await page.evaluate(() => { const v = document.querySelector('#nutzen .showcase-video'); v.currentTime = v.duration - 0.3; });
    await page.waitForFunction(() => { const v = document.querySelector('#nutzen .showcase-video'); return !v.paused && v.currentTime < 2; }, null, { timeout: 5000 });
    assertRanges(await videos(), ['/media/section-bericht-peach-5x4.mp4'], `Chromium ${width}`);
    assert.deepEqual(errors, [], `${width}: Konsolenfehler`);
    assert.deepEqual(blocked, [], `${width}: unerwartete Fremd-Requests`);
    await context.close();
  }
  /* Bewegung reduzieren (Betriebssystem): Standbild statt automatischer Wiedergabe, ohne Schaltfläche, Zustand dokumentiert */
  const { context, page } = await open('/index.html', { width: 1440, height: 900, reducedMotion: 'reduce' });
  await page.evaluate(() => document.querySelector('#nutzen .showcase-frame').scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(800);
  assert.deepEqual(await page.evaluate(() => { const v = document.querySelector('#nutzen .showcase-video'); return [v.paused, v.dataset.wiedergabe, document.querySelectorAll('.showcase-frame button').length]; }), [true, 'Bewegung reduziert', 0]);
  await context.close();
});

test('Video bei „Ihr Bericht“: rechts neben dem Text (mobil darunter), abgerundet, startet von selbst erst im Bild (Range-Antworten 206)', { skip: videoSkip }, async () => {
  for (const [width, height] of [[1440, 900], [390, 844]]) {
    const { context, page, errors, blocked, videos } = await open('/index.html', { width, height, reducedMotion: 'no-preference', videos: true });
    const report = () => page.evaluate(() => {
      const v = document.querySelector('#bericht .showcase-video'), f = v.closest('.showcase-frame'), t = document.querySelector('#bericht .split-copy');
      const fr = f.getBoundingClientRect(), tr = t.getBoundingClientRect();
      return { paused: v.paused, time: v.currentTime, loop: v.loop, controls: v.controls, buffered: v.buffered.length,
        right: fr.left >= tr.right, below: fr.top >= tr.bottom, radius: parseFloat(getComputedStyle(f).borderTopLeftRadius), overflow: getComputedStyle(f).overflow,
        square: Math.abs(fr.width - fr.height) <= 2, width: fr.width };
    });
    await page.waitForFunction(() => document.querySelector('#bericht .showcase-video').paused);
    const before = await report();
    assert.equal(before.paused, true, `${width}: läuft erst im Bild`);
    await page.evaluate(() => document.querySelector('#bericht .showcase-frame').scrollIntoView({ block: 'center' }));
    await page.waitForFunction(() => { const v = document.querySelector('#bericht .showcase-video'); return !v.paused && v.currentTime > 0.3; }, null, { timeout: 8000 });
    const m = await report();
    assert.ok(width >= 1000 ? m.right : m.below, `${width}: ${width >= 1000 ? 'rechts neben' : 'unter'} dem Text`);
    assert.deepEqual([m.loop, m.controls], [true, false]);
    assert.ok(m.radius >= 12 && m.overflow === 'hidden', `${width}: abgerundete Ecken`);
    assert.ok(m.square && m.width <= 560, `${width}: quadratisch, höchstens 560 px (${m.width})`);
    assert.equal(await page.evaluate(() => document.querySelector('#nutzen .showcase-video').paused), true, `${width}: Befund-Video außerhalb des Bildes läuft nicht`);
    assertRanges(await videos(), ['/media/report-pdf-de-1x1-lavendel.mp4'], `Chromium ${width}`);
    assert.deepEqual(errors, [], `${width}: Konsolenfehler`);
    assert.deepEqual(blocked, [], `${width}: unerwartete Fremd-Requests`);
    await context.close();
  }
});

test('Safari-Engine (WebKit): alle drei Videos laufen – Range-Anfragen bekommen 206 von der Video-Function (R2); scheitert das Laden, bleibt das Standbild ohne Schaltfläche, mit Netz startet es wieder', { skip: videoSkip }, async t => {
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
      for (const sel of ['#demo .showcase-frame', '#bericht .showcase-frame', '#nutzen .showcase-frame']) {
        await page.evaluate(s => document.querySelector(s).scrollIntoView({ block: 'center' }), sel);
        /* Echte Wiedergabe: das Element bleibt ein Video (kein Standbild-Ersatz) und die Zeit läuft */
        await page.waitForFunction(s => {
          const e = document.querySelector(s).querySelector('.showcase-video');
          return e.tagName === 'VIDEO' && !e.paused && e.currentTime > 0.3 && e.readyState >= 3;
        }, sel, { timeout: 15000 });
      }
      const shown = await frames(page);
      assert.deepEqual(shown.map(e => e.tag), ['VIDEO', 'VIDEO', 'VIDEO'], `${width}: alle drei Videos spielen, kein Standbild`);
      for (const e of shown) {
        assert.ok(e.fills, `${width}: füllt den abgerundeten Rahmen`);
        assert.match(e.label, /^Animierte/, `${width}: Alternativtext bleibt`);
      }
      const list = await videos();
      assertRanges(list, ['/media/360-pixelkiez-video-1080p-website-look.mp4', '/media/report-pdf-de-1x1-lavendel.mp4', '/media/section-bericht-peach-5x4.mp4'], `WebKit ${width}`);
      assert.deepEqual(errors, [], `${width}: Skriptfehler`);
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `webkit-${width}.png`) });
      t.diagnostic(`WebKit ${width}: alle drei Videos spielen; MP4-Antworten: ${list.map(x => `${x.path.slice(7)} ${x.range ?? 'ohne Range'} → ${x.status}`).join(', ')}`);
      await ctx.close();
    }
    /* Unterbrochenes Netz (Ladefehler): Das Standbild (Poster) bleibt im Video stehen, ohne Schaltfläche; der Zustand ist dokumentiert.
       Kommt das Netz zurück (online), startet das sichtbare Video von selbst. */
    const ctx = await wk.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'no-preference', isMobile: true, hasTouch: true });
    await ctx.route('**/*.mp4', r => r.abort());
    const page = await ctx.newPage();
    await page.goto(app.base + '/', { waitUntil: 'load' });
    for (const sel of ['#demo', '#bericht', '#nutzen']) {
      await page.evaluate(s => document.querySelector(`${s} .showcase-frame`).scrollIntoView({ block: 'center', behavior: 'instant' }), sel);
      await page.waitForFunction(s => document.querySelector(`${s} .showcase-video`).dataset.wiedergabe === 'Ladefehler', sel, { timeout: 10000 });
    }
    const still = await page.evaluate(() => [...document.querySelectorAll('.showcase-frame')].map(f => {
      const v = f.querySelector('.showcase-video'), r = v.getBoundingClientRect(), fr = f.getBoundingClientRect();
      return [v.tagName, !!v.poster, Math.abs(r.width - fr.width) <= 1, v.readyState < 2, f.querySelectorAll('button').length];
    }));
    assert.deepEqual(still, Array(3).fill(['VIDEO', true, true, true, 0]), 'Standbild (Poster, kein Bild aus dem Video) ohne Schaltfläche, keine schwarze Fläche');
    await ctx.unroute('**/*.mp4');
    await page.evaluate(() => dispatchEvent(new Event('online')));
    await page.waitForFunction(() => { const v = document.querySelector('#nutzen .showcase-video'); return !v.paused && v.currentTime > 0.3; }, null, { timeout: 15000 });
    await ctx.close();
  } finally {
    await wk.close();
  }
});

test('Videos: Läuft app.js, während die Quellenauswahl noch läuft (networkState NO_SOURCE), bleibt das Video und spielt; nur ein echter Ladefehler zeigt den Hinweis (Chromium und WebKit)', { skip: videoSkip }, async t => {
  /* Nachstellung des Rennens aus WebKit unter Last: networkState meldet NO_SOURCE, bis die Seite load() aufruft */
  const race = () => {
    const d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'networkState');
    const load = HTMLMediaElement.prototype.load;
    const neu = new WeakSet();
    Object.defineProperty(HTMLMediaElement.prototype, 'networkState', { configurable: true, get() { return neu.has(this) ? d.get.call(this) : HTMLMediaElement.NETWORK_NO_SOURCE; } });
    HTMLMediaElement.prototype.load = function () { neu.add(this); return load.call(this); };
  };
  let wk = null;
  try { wk = await pw.webkit.launch(); } catch { /* unten als NOT_RUN gemeldet */ }
  try {
    for (const [name, engine] of [['Chromium', browser], ['WebKit', wk]]) {
      await t.test(name, { skip: !engine && 'NOT_RUN: Playwright-WebKit nicht installiert (playwright install webkit)' }, async () => {
        const ctx = await engine.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'no-preference' });
        await ctx.addInitScript(race);
        const page = await ctx.newPage();
        await page.goto(app.base + '/', { waitUntil: 'load' });
        assert.deepEqual(await page.$$eval('#bericht .showcase-video, #nutzen .showcase-video', es => es.map(e => e.tagName)), ['VIDEO', 'VIDEO'], `${name}: kein Standbild ohne Ladefehler`);
        await page.evaluate(() => document.querySelector('#nutzen .showcase-frame').scrollIntoView({ block: 'center' }));
        await page.waitForFunction(() => { const e = document.querySelector('#nutzen .showcase-video'); return e.tagName === 'VIDEO' && !e.paused && e.currentTime > 0.3; }, null, { timeout: 15000 });
        await ctx.close();
      });
    }
  } finally {
    if (wk) await wk.close();
  }
});

/* P0-Hotfix PXK-159 (Entscheidung des Auftraggebers 04.11.2026): keine Play-/Pause-Schaltflächen. Die Videos laufen stumm, inline und
   in Schleife von selbst, sobald sie im Bild sind; ganz außerhalb angehalten, beim erneuten Sichtbarwerden, nach Tabwechsel und nach
   pageshow wieder gestartet. Tabwechsel und pageshow sind nachgestellt (visibilityState/Ereignisse), kein echter Tab. */
/* WebKit erzwingt im Stromsparmodus (macOS/iOS) eigene Bedienelemente für autoplay-Videos, die nicht laufen; deren Symbole lädt WebKit
   aus blob:-Adressen, die die CSP (img-src 'self') sperrt. Diese Meldung stammt vom System, nicht von der Seite; sie wird hier
   ausdrücklich ausgenommen (in Bericht und PR dokumentiert). Jede andere Konsolenmeldung bleibt ein Fehler. */
const systemMeldung = m => /^Button failed to load, iconName = [\w-]+, layoutTraits = /.test(m);
const ohneKnoepfe = page => page.evaluate(() => ({ knoepfe: document.querySelectorAll('.showcase-frame button, .video-toggle, .braucht-start, .video-hinweis').length,
  controls: [...document.querySelectorAll('.showcase-video')].filter(v => v.controls).length,
  vollbild: !!document.fullscreenElement || [...document.querySelectorAll('.showcase-video')].some(v => v.webkitDisplayingFullscreen) }));
const laeuft = (page, sec, nach = 0.3) => page.waitForFunction(([s, t]) => { const v = document.querySelector(`${s} .showcase-video`); return !v.paused && v.currentTime > t; }, [sec, nach], { timeout: 15000 });
const zeige = (page, sec) => page.evaluate(s => document.querySelector(`${s} .showcase-frame`).scrollIntoView({ block: 'center', behavior: 'instant' }), sec);

test('Videos ohne Bedienelemente: alle drei starten stumm, inline und in Schleife von selbst im Bild, halten ganz außerhalb an, starten beim erneuten Sichtbarwerden, nach Tabwechsel und nach pageshow wieder (Chromium und WebKit, 320/390/768/1440)', { skip: videoSkip }, async t => {
  let wk = null;
  try { wk = await pw.webkit.launch(); } catch { /* unten als NOT_RUN gemeldet */ }
  try {
    for (const [name, engine] of [['Chromium', browser], ['WebKit', wk]]) {
      await t.test(name, { skip: !engine && 'NOT_RUN: Playwright-WebKit nicht installiert (playwright install webkit)' }, async () => {
        for (const width of [320, 390, 768, 1440]) {
          const mobil = width < 768, was = `${name} ${width}`;
          const ctx = await engine.newContext({ viewport: { width, height: mobil ? 800 : 900 }, isMobile: mobil, hasTouch: mobil, reducedMotion: 'no-preference' });
          await ctx.route('**/*', r => r.request().url().startsWith(app.base + '/') ? r.continue() : r.abort());
          const page = await ctx.newPage();
          const errors = [];
          page.on('pageerror', e => errors.push(String(e)));
          page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
          const videos = trackVideos(page);
          await page.goto(app.base + '/', { waitUntil: 'load' });
          for (const sec of ['#demo', '#bericht', '#nutzen']) {
            await zeige(page, sec);
            await laeuft(page, sec);
            const m = await page.evaluate(s => { const v = document.querySelector(`${s} .showcase-video`); return [v.muted, v.defaultMuted, v.playsInline, v.loop, v.autoplay, v.controls, v.dataset.wiedergabe]; }, sec);
            assert.deepEqual(m, [true, true, true, true, false, false, 'läuft'], `${was} ${sec}: stumm, inline, Schleife, ohne autoplay-Attribut (Start per Skript), ohne Leiste`);
            assert.deepEqual(await ohneKnoepfe(page), { knoepfe: 0, controls: 0, vollbild: false }, `${was} ${sec}: keine Schaltflächen, kein Vollbild`);
            /* Ende der Datei: läuft in Schleife weiter */
            await page.evaluate(s => { const v = document.querySelector(`${s} .showcase-video`); v.currentTime = v.duration - 0.3; }, sec);
            await page.waitForFunction(s => { const v = document.querySelector(`${s} .showcase-video`); return !v.paused && v.currentTime < 2; }, sec, { timeout: 8000 });
            /* Ganz aus dem Bild: angehalten; wieder im Bild: läuft von selbst weiter */
            await page.evaluate(() => scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
            await page.waitForFunction(s => document.querySelector(`${s} .showcase-video`).paused, sec, { timeout: 5000 });
            await zeige(page, sec);
            await laeuft(page, sec, 0);
          }
          /* Tabwechsel (nachgestellt): Browser hält das Video im Hintergrund an; beim Zurückkommen startet es wieder */
          await zeige(page, '#bericht');
          await laeuft(page, '#bericht');
          await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); document.querySelector('#bericht .showcase-video').pause(); });
          await page.waitForTimeout(400);
          assert.equal(await page.evaluate(() => document.querySelector('#bericht .showcase-video').paused), true, `${was}: im Hintergrund kein Neustart`);
          await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
          await laeuft(page, '#bericht', 0);
          /* Zurück-Navigation aus dem Cache (pageshow, persisted) */
          await page.evaluate(() => { document.querySelector('#bericht .showcase-video').pause(); dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); });
          await laeuft(page, '#bericht', 0);
          assertRanges(await videos(), ['/media/360-pixelkiez-video-1080p-website-look.mp4', '/media/report-pdf-de-1x1-lavendel.mp4', '/media/section-bericht-peach-5x4.mp4'], was);
          assert.deepEqual(errors.filter(e => !systemMeldung(e)), [], `${was}: Konsolenfehler`);
          await ctx.close();
        }
      });
    }
  } finally {
    if (wk) await wk.close();
  }
});

test('Negativfälle Autoplay: Browser verbietet Autoplay (nachgestellt, Chromium und WebKit) und „Bewegung reduzieren“ – Standbild ohne eigene Schaltfläche, Grund in data-wiedergabe, keine Konsolenfehler', { skip: videoSkip }, async t => {
  /* Nachbildung einer Autoplay-Sperre (wie der iOS-Stromsparmodus): play() wird abgelehnt, autoplay greift nicht. Chromiums Schalter
     --autoplay-policy=user-gesture-required sperrt stumme Videos nicht (geprüft 04.11.2026), WebKit hat keinen. Kein echtes Gerät. */
  const sperre = () => {
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () { return Promise.reject(new DOMException('Autoplay blockiert (Nachbildung)', 'NotAllowedError')); };
    document.addEventListener('DOMContentLoaded', () => document.querySelectorAll('video').forEach(v => { v.autoplay = false; v.pause(); }));
    void play;
  };
  let wk = null;
  try { wk = await pw.webkit.launch(); } catch { /* unten */ }
  try {
    for (const [name, engine, fall] of [['Chromium', browser, 'gesperrt'], ['WebKit', wk, 'gesperrt'], ['Chromium', browser, 'reduziert'], ['WebKit', wk, 'reduziert']]) {
      await t.test(`${name} ${fall}`, { skip: !engine && 'NOT_RUN: Browser nicht startbar' }, async () => {
        for (const width of [390, 1440]) {
          const mobil = width < 768;
          const ctx = await engine.newContext({ viewport: { width, height: mobil ? 844 : 900 }, isMobile: mobil, hasTouch: mobil, reducedMotion: fall === 'reduziert' ? 'reduce' : 'no-preference' });
          if (fall === 'gesperrt') await ctx.addInitScript(sperre);
          await ctx.route('**/*', r => r.request().url().startsWith(app.base + '/') ? r.continue() : r.abort());
          const page = await ctx.newPage();
          const errors = [];
          page.on('pageerror', e => errors.push(String(e)));
          page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
          await page.goto(app.base + '/', { waitUntil: 'load' });
          for (const sec of ['#demo', '#bericht', '#nutzen']) {
            await zeige(page, sec);
            await page.waitForTimeout(1500);
            const m = await page.evaluate(s => { const v = document.querySelector(`${s} .showcase-video`); return [v.paused, v.currentTime, !!v.poster, v.dataset.wiedergabe]; }, sec);
            assert.deepEqual(m, [true, 0, true, fall === 'reduziert' ? 'Bewegung reduziert' : 'abgelehnt: NotAllowedError'], `${name} ${fall} ${width} ${sec}: Standbild, Grund dokumentiert`);
          }
          assert.deepEqual(await ohneKnoepfe(page), { knoepfe: 0, controls: 0, vollbild: false }, `${name} ${fall} ${width}: keine Schaltflächen`);
          assert.deepEqual(errors.filter(e => !systemMeldung(e)), [], `${name} ${fall} ${width}: Konsolenfehler`);
          await ctx.close();
        }
      });
    }
  } finally {
    if (wk) await wk.close();
  }
});

test('Stromsparmodus (nachgestellt, Chromium und WebKit mobil): Tippen auf das Video startet es ohne Schaltfläche; danach hält es beim Hinausscrollen an und läuft beim Hineinscrollen von selbst weiter', { skip: videoSkip }, async t => {
  /* Rückmeldung des Auftraggebers 04.11.2026: „Die Videos in der mobilen Ansicht laufen nicht.“ Ursache: Im iOS-Stromsparmodus lehnt
     WebKit jeden Start ohne Nutzergeste ab (RequireUserGestureForVideoDueToLowPowerMode, NotAllowedError). Nachbildung: play() gilt
     nur während der Verarbeitung eines echten Ereignisses (Tipp, Klick, Taste) als Geste, sonst wird es abgelehnt; nach einem Start
     durch eine Geste darf dasselbe Video wieder per Skript starten (WebKit hebt die Sperre für das Element nach dem ersten Start
     durch eine Geste auf). Kein echtes Gerät. */
  const stromsparmodus = () => {
    const play = HTMLMediaElement.prototype.play, frei = new WeakSet();
    let geste = false;
    for (const typ of ['pointerup', 'touchend', 'click', 'keydown']) addEventListener(typ, e => { if (e.isTrusted) { geste = true; setTimeout(() => { geste = false; }, 0); } }, true);
    HTMLMediaElement.prototype.play = function () {
      if (!frei.has(this) && !geste) return Promise.reject(new DOMException('Stromsparmodus (Nachbildung)', 'NotAllowedError'));
      frei.add(this);
      return play.call(this);
    };
  };
  let wk = null;
  try { wk = await pw.webkit.launch(); } catch { /* unten als NOT_RUN gemeldet */ }
  try {
    for (const [name, engine] of [['WebKit', wk], ['Chromium', browser]]) {
      await t.test(name, { skip: !engine && 'NOT_RUN: Playwright-WebKit nicht installiert (playwright install webkit)' }, async () => {
        const ctx = await engine.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'no-preference' });
        await ctx.addInitScript(stromsparmodus);
        await ctx.route('**/*', r => r.request().url().startsWith(app.base + '/') ? r.continue() : r.abort());
        const page = await ctx.newPage();
        const errors = [];
        page.on('pageerror', e => errors.push(String(e)));
        page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
        await page.goto(app.base + '/', { waitUntil: 'load' });
        for (const sec of ['#demo', '#bericht', '#nutzen']) {
          const video = `${sec} .showcase-video`;
          await zeige(page, sec);
          await page.waitForTimeout(1200);
          assert.deepEqual(await page.evaluate(s => { const v = document.querySelector(s); return [v.paused, v.dataset.wiedergabe]; }, video), [true, 'abgelehnt: NotAllowedError'], `${name} ${sec}: ohne Geste abgelehnt, Standbild`);
          /* Echter Tipp (Playwright prüft, dass er das Video trifft und nichts darüber liegt) */
          await page.locator(video).tap();
          await laeuft(page, sec);
          assert.equal(await page.evaluate(s => document.querySelector(s).dataset.wiedergabe, video), 'läuft', `${name} ${sec}: läuft nach dem Tippen`);
          /* Ganz hinaus: hält an; wieder hinein: läuft ohne neuen Tipp */
          await page.evaluate(() => scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
          await page.waitForFunction(s => document.querySelector(s).paused, video, { timeout: 5000 });
          await zeige(page, sec);
          await laeuft(page, sec, await page.evaluate(s => document.querySelector(s).currentTime + 0.3, video));
        }
        assert.deepEqual(await ohneKnoepfe(page), { knoepfe: 0, controls: 0, vollbild: false }, `${name}: keine Schaltflächen, kein Vollbild`);
        assert.deepEqual(errors.filter(e => !systemMeldung(e)), [], `${name}: Konsolenfehler`);
        await ctx.close();
      });
    }
  } finally {
    if (wk) await wk.close();
  }
});

test('Hintergrundbild „Für alle, die eine Website verantworten.“: lädt aus R2 als WebP, füllt den Abschnitt innerhalb des Rahmens hinter den Karten; Karten (Farbe, Text) unverändert und anklickbar obenauf (Chromium und WebKit, 390/1440)', { skip }, async t => {
  let wk = null;
  try { wk = await pw.webkit.launch(); } catch { /* unten als NOT_RUN gemeldet */ }
  try {
    for (const [name, engine] of [['Chromium', browser], ['WebKit', wk]]) {
      await t.test(name, { skip: !engine && 'NOT_RUN: Playwright-WebKit nicht installiert (playwright install webkit)' }, async () => {
        for (const width of [390, 1440]) {
          const { context, page, errors, blocked } = await open('/index.html', { width, engine });
          await page.evaluate(() => document.querySelector('#fuer-wen').scrollIntoView({ block: 'start', behavior: 'instant' }));
          await page.waitForFunction(() => { const i = document.querySelector('#fuer-wen .section-bild'); return i.complete && i.naturalWidth > 0; }, null, { timeout: 10000 });
          const m = await page.evaluate(() => {
            const s = document.querySelector('#fuer-wen'), i = s.querySelector('.section-bild'), sr = s.getBoundingClientRect(), ir = i.getBoundingClientRect();
            const karten = [...s.querySelectorAll('.step')];
            /* Mitte jeder Karte: der oberste Treffer gehört zur Karte, nicht zum Bild oder Schleier */
            const oben = karten.every(k => { const r = k.getBoundingClientRect(); return k.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)); });
            return { url: new URL(i.currentSrc).pathname, deckt: Math.abs(ir.left - sr.left) < 2 && Math.abs(ir.right - sr.right) < 2 && Math.abs(ir.bottom - sr.bottom) < 2,
              imRahmen: ir.left >= document.querySelector('main.frame').getBoundingClientRect().left - 0.5, fit: getComputedStyle(i).objectFit,
              farben: [...new Set(karten.map(k => getComputedStyle(k).backgroundColor))], texte: karten.map(k => k.querySelector('h3').textContent), oben };
          });
          assert.deepEqual(m, { url: '/media/360-pixelkiez-designrunde-am-tisch.webp', deckt: true, imRahmen: true, fit: 'cover', farben: ['rgb(235, 226, 252)'],
            texte: ['Unternehmen & Selbstständige', 'Marketing-Teams', 'Geschäftsführung'], oben: true }, `${name} ${width}`);
          assert.ok(await overflow(page) <= 0, `${name} ${width}: Überlauf`);
          assert.deepEqual([errors, blocked], [[], []], `${name} ${width}: Konsolenfehler, Fremd-Requests`);
          await context.close();
        }
      });
    }
  } finally {
    if (wk) await wk.close();
  }
});

test('Autoplay am Bildschirmrand: Ein Video, das nur an die Unterkante stößt, wird noch nicht gestartet und läuft nach dem Hineinscrollen von selbst (WebKit und Chromium mobil, alle drei Videos)', { skip: videoSkip }, async t => {
  /* Live 04.11.2026 (WebKit mobil, 390 × 844): Das Hero-Video lag beim Laden genau an der Unterkante; play() kam bei einem Bruchteil
     eines Pixels, WebKit lehnte ab (NotAllowedError) und der automatische Start blieb danach aus. */
  let wk = null;
  try { wk = await pw.webkit.launch(); } catch { /* unten als NOT_RUN gemeldet */ }
  try {
    for (const [name, engine] of [['WebKit', wk], ['Chromium', browser]]) {
      await t.test(name, { skip: !engine && 'NOT_RUN: Playwright-WebKit nicht installiert (playwright install webkit)' }, async () => {
        const ctx = await engine.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'no-preference' });
        await ctx.route('**/*', r => r.request().url().startsWith(app.base + '/') ? r.continue() : r.abort());
        const page = await ctx.newPage();
        await page.goto(app.base + '/', { waitUntil: 'load' });
        for (const sec of ['#demo', '#bericht', '#nutzen']) {
          /* 2 px des Videos im Bild: noch kein Start */
          await page.evaluate(s => { const r = document.querySelector(`${s} .showcase-frame`).getBoundingClientRect(); scrollBy({ top: r.top - innerHeight + 2, behavior: 'instant' }); }, sec);
          await page.waitForTimeout(700);
          assert.equal(await page.evaluate(s => document.querySelector(`${s} .showcase-video`).paused, sec), true, `${name} ${sec}: am Rand noch nicht gestartet`);
          /* Ganz im Bild: startet von selbst, ohne „Abspielen“ */
          await page.evaluate(s => document.querySelector(`${s} .showcase-frame`).scrollIntoView({ block: 'center', behavior: 'instant' }), sec);
          await page.waitForFunction(s => { const v = document.querySelector(`${s} .showcase-video`); return !v.paused && v.currentTime > 0.3; }, sec, { timeout: 15000 });
          assert.equal(await page.evaluate(s => document.querySelector(`${s} .showcase-video`).dataset.wiedergabe, sec), 'läuft', `${name} ${sec}: läuft von selbst`);
        }
        await ctx.close();
      });
    }
  } finally {
    if (wk) await wk.close();
  }
});

test('Partner-Logos: echter Klick bzw. Tipp trifft den Link (elementFromPoint, kein überlagernder Abschnitt) und öffnet pixelkiez.de bzw. studio.dyai.cloud im neuen Tab; Footer-Logo ebenso (Chromium und WebKit, 320/390/768/1440)', { skip }, async t => {
  /* P0-Hotfix PXK-159: Der negative Abstand zog die Logos in den positionierten Hero; dessen Fläche lag über den Logos und fing Klicks ab */
  let wk = null;
  try { wk = await pw.webkit.launch(); } catch { /* unten als NOT_RUN gemeldet */ }
  try {
    for (const [name, engine] of [['Chromium', browser], ['WebKit', wk]]) {
      await t.test(name, { skip: !engine && 'NOT_RUN: Playwright-WebKit nicht installiert (playwright install webkit)' }, async () => {
        for (const width of [320, 390, 768, 1440]) {
          const mobil = width < 768;
          const ctx = await engine.newContext({ viewport: { width, height: mobil ? 800 : 900 }, isMobile: mobil, hasTouch: mobil, reducedMotion: 'reduce' });
          /* Externe Partnerseiten nicht wirklich laden: geprüft wird, dass der neue Tab genau diese Adresse öffnet */
          await ctx.route('**/*', r => r.request().url().startsWith(app.base + '/') ? r.continue() : r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Partner</title>' }));
          const page = await ctx.newPage();
          await page.goto(app.base + '/', { waitUntil: 'load' });
          for (const [sel, ziel, tippflaeche] of [['.partner-logos a[href="https://pixelkiez.de/"]', 'https://pixelkiez.de/', true], ['.partner-logos a[href="https://studio.dyai.cloud/"]', 'https://studio.dyai.cloud/', true], ['.footer a[href="https://pixelkiez.de/"]', 'https://pixelkiez.de/', false]]) {
            const was = `${name} ${width} ${ziel}${tippflaeche ? '' : ' (Footer)'}`;
            const link = page.locator(sel);
            await link.scrollIntoViewIfNeeded();
            await page.waitForTimeout(150);
            const box = await link.locator('img').boundingBox();
            const x = box.x + box.width / 2, y = box.y + box.height / 2;
            assert.equal(await page.evaluate(([x, y, s]) => document.querySelector(s).contains(document.elementFromPoint(x, y)), [x, y, sel]), true, `${was}: elementFromPoint trifft den Link`);
            if (tippflaeche) { const l = await link.boundingBox(); assert.ok(l.height >= 44, `${was}: Tippfläche mindestens 44 px hoch (${l.height})`); }
            const neu = ctx.waitForEvent('page', { timeout: 10000 });
            if (mobil) await page.touchscreen.tap(x, y); else await page.mouse.click(x, y);
            const tab = await neu;
            await tab.waitForLoadState('domcontentloaded');
            assert.deepEqual([tab.url(), page.url()], [ziel, app.base + '/'], `${was}: neuer Tab mit der Partnerseite, Website bleibt offen`);
            await tab.close();
          }
          await ctx.close();
        }
      });
    }
  } finally {
    if (wk) await wk.close();
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

/* Bestätigungsseite: Kennzahlen für Layout und Inhalt (Karte schmal und mittig, genau ein Kästchen, Links, Schaltfläche, Hinweis) */
const bestaetigung = page => page.evaluate(() => {
  const r = s => { const x = document.querySelector(s).getBoundingClientRect(); return { left: x.left, right: x.right, top: x.top, bottom: x.bottom, width: x.width }; };
  const box = document.querySelector('#bestaetigung');
  return {
    h1: document.querySelector('h1').textContent, url: document.querySelector('.anfrage-url').textContent,
    boxes: document.querySelectorAll('input[type=checkbox]').length, checked: box.checked, required: box.required,
    links: [...document.querySelectorAll('label.consent a')].map(a => [new URL(a.href).pathname, a.textContent]),
    label: document.querySelector('label.consent').textContent,
    button: document.querySelector('.anfrage-form button[type=submit]').textContent.trim(), hinweis: document.querySelector('.anfrage-hinweis').textContent,
    karte: r('.anfrage'), knopf: r('.anfrage-form .btn'), vw: document.documentElement.clientWidth, vh: innerHeight,
  };
});
/* Element vollständig sichtbar: zwischen Navigation und unterem Fensterrand, am Mittelpunkt nicht verdeckt */
const imBild = (page, selectors) => page.evaluate(sel => {
  const nav = document.querySelector('#nav').getBoundingClientRect().bottom;
  return Object.fromEntries(sel.map(s => {
    const e = document.querySelector(s), r = e.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return [s, { top: Math.round(r.top), bottom: Math.round(r.bottom), visible: r.height > 0 && r.top >= nav && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth && (hit === e || e.contains(hit)) }];
  }));
}, selectors);
/* Bis die Seite ruhig steht (weiches Scrollen) */
const settle = page => page.evaluate(() => new Promise(done => {
  let last = NaN, same = 0;
  const tick = () => { if (scrollY === last) same++; else { same = 0; last = scrollY; } if (same >= 10) done(scrollY); else requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
}));
/* Fokus per autofocus nach dem Laden (WebKit setzt ihn mit kurzer Verzögerung). Abfrage im festen Takt statt per
   requestAnimationFrame: das wird unter Last im kopflosen Browser gedrosselt (Gesamtlauf), der Fokus selbst ist dann längst gesetzt */
const fokusAuf = (page, id) => page.waitForFunction(i => document.activeElement && document.activeElement.id === i, id, { timeout: 5000, polling: 100 });
/* Die Fehlerseite (422) melden Browser für das Dokument selbst als Konsolenfehler; das ist die gewollte Antwort des Workers */
const ohne422 = errors => errors.filter(e => !/status of 422/.test(e));

test('Nutzerreise im Browser (Chromium und WebKit, 320/390/768/1440): Hero „Analysieren“ → Bestätigungsseite (schmal, mittig, genau ein Kästchen) → ohne Häkchen Fehler am Kästchen, kein Google → mit Häkchen über Google zu „Vielen Dank für Ihre Anfrage.“; Haken animiert nur bei erlaubter Bewegung; Website-Adresse nie in einer URL', { skip: formSkip }, async t => {
  let wk = null;
  try { wk = await pw.webkit.launch(); } catch { /* unten als NOT_RUN gemeldet */ }
  try {
    for (const [name, engine] of [['Chromium', browser], ['WebKit', wk]]) {
      await t.test(name, { skip: !engine && 'NOT_RUN: Playwright-WebKit nicht installiert (playwright install webkit)' }, async st => {
        for (const [width, reducedMotion] of [[320, 'reduce'], [390, 'reduce'], [390, 'no-preference'], [768, 'reduce'], [1440, 'reduce'], [1440, 'no-preference']]) {
          await resetData();
          const before = google.log.auth || 0;
          const height = width >= 768 ? 900 : 800;
          const what = `${name} ${width} ${reducedMotion}`;
          const shot = async state => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `reise-${name.toLowerCase()}-${width}-${reducedMotion}-${state}.png`), fullPage: true }); };
          /* Ohne bypassCSP: Hero und Bestätigungsseite schicken an die eigene API, die Weiterleitung zu Google erlaubt die Worker-CSP */
          const { context, page, errors, blocked, requests } = await open('/index.html', { width, height, reducedMotion, engine });
          assert.equal(await page.locator('.hero input[type=checkbox]').count(), 0, `${what}: kein Kästchen im Hero`);
          await page.fill('#url', 'musterfirma.de');
          await shot('1-hero');
          await Promise.all([page.waitForURL(`${app.base}/api/anfrage`), page.click('.url-field .btn')]);
          await page.waitForLoadState('load');
          await page.evaluate(() => document.fonts.ready);
          /* Bestätigungsseite */
          const b = await bestaetigung(page);
          assert.deepEqual([b.h1, b.url, b.boxes, b.checked, b.required, b.button, b.hinweis],
            ['Analyse anfragen', 'https://musterfirma.de', 1, false, true, 'Mit Google fortfahren', 'Kostenlos · 0 € · kein Abonnement'], `${what}: Inhalt der Bestätigungsseite`);
          assert.equal(b.label.replace(/\s+/g, ' ').trim(), 'Ich handle geschäftlich oder für eine Organisation, akzeptiere die AGB und habe die Datenschutzerklärung zur Kenntnis genommen.');
          assert.deepEqual(b.links, [['/agb.html', 'AGB'], ['/datenschutz.html', 'Datenschutzerklärung']], `${what}: AGB und Datenschutzerklärung verlinkt`);
          assert.ok(await overflow(page) <= 0, `${what}: kein seitlicher Überlauf`);
          assert.ok(b.karte.width <= 520.5 && b.karte.left >= 0 && b.karte.right <= b.vw, `${what}: Karte schmal (${Math.round(b.karte.width)} px) und im Bild`);
          assert.ok(Math.abs(b.karte.left - (b.vw - b.karte.right)) <= 1.5, `${what}: Karte mittig (${Math.round(b.karte.left)} | ${Math.round(b.vw - b.karte.right)})`);
          assert.ok(b.knopf.bottom <= b.vh, `${what}: „Mit Google fortfahren“ im ersten Bildschirm (${Math.round(b.knopf.bottom)} von ${b.vh} px)`);
          st.diagnostic(`${what}: Karte ${Math.round(b.karte.width)} px breit, Schaltfläche endet bei ${Math.round(b.knopf.bottom)} von ${b.vh} px`);
          await shot('2-bestaetigung');
          /* Ohne Häkchen: Fehler am Kästchen (Server, auch ohne JavaScript), Fokus dorthin, kein Google, kein Auftrag */
          await Promise.all([page.waitForSelector('#bestaetigung-error'), page.click('.anfrage-form .btn')]);
          await fokusAuf(page, 'bestaetigung');
          await settle(page);
          const fehler = await imBild(page, ['#bestaetigung', '#bestaetigung-error']);
          assert.ok(fehler['#bestaetigung'].visible && fehler['#bestaetigung-error'].visible, `${what}: Kästchen und Fehlertext vollständig im Bild ${JSON.stringify(fehler)}`);
          assert.deepEqual(await page.evaluate(() => [document.activeElement.getAttribute('aria-invalid'), document.activeElement.getAttribute('aria-describedby'), document.activeElement.checked]), ['true', 'bestaetigung-error', false]);
          assert.equal((google.log.auth || 0) - before, 0, `${what}: ohne Häkchen keine Weiterleitung zu Google`);
          assert.equal(orderCount(), 0);
          await shot('3-fehler');
          /* Mit Häkchen: Google (Mock) → Rückkehr → Eingangsbestätigung */
          await page.check('#bestaetigung');
          await Promise.all([page.waitForSelector('#reference'), page.click('.anfrage-form .btn')]);
          await page.waitForLoadState('load');
          await page.evaluate(() => document.fonts.ready);
          const e = await page.evaluate(() => {
            const zeichen = document.querySelector('.anfrage-zeichen'), z = zeichen.getBoundingClientRect(), k = document.querySelector('.anfrage').getBoundingClientRect();
            return { h1: document.querySelector('h1').textContent, text: document.querySelector('.anfrage-text').textContent, ref: document.querySelector('#reference').textContent,
              zeichen: z.width > 0 && z.top >= 0 && z.bottom <= innerHeight, animationen: document.getAnimations().filter(a => typeof a.animationName === 'string').map(a => a.animationName).sort(),
              mitte: Math.abs(k.left - (document.documentElement.clientWidth - k.right)), start: document.querySelector('.anfrage-fertig .btn').textContent };
          });
          assert.deepEqual([e.h1, e.text, e.start], ['Vielen Dank für Ihre Anfrage.', 'Ihre Anfrage ist bei uns eingegangen. Wir melden uns per E-Mail bei Ihnen.', 'Zur Startseite'], `${what}: Erfolg`);
          assert.match(e.ref, /^PXA-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
          assert.ok(e.zeichen && e.mitte <= 1.5, `${what}: Haken sichtbar, Karte mittig`);
          assert.ok(await overflow(page) <= 0, `${what}: kein seitlicher Überlauf auf der Bestätigung`);
          /* Bewegung: nur bei erlaubter Bewegung zeichnet sich der Haken (Kreis, dann Strich); danach steht er fertig da */
          assert.deepEqual(e.animationen, reducedMotion === 'reduce' ? [] : ['anfrage-kreis', 'anfrage-strich'], `${what}: Animation nur bei erlaubter Bewegung`);
          await page.evaluate(() => Promise.all(document.getAnimations().map(a => a.finished)));
          assert.equal(await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.anfrage-zeichen-strich')).strokeDashoffset) || 0), 0, `${what}: Haken vollständig gezeichnet`);
          await shot('4-erfolg');
          assert.equal(orderCount(), 1, `${what}: genau ein Auftrag`);
          assert.equal(google.log.auth - before, 1, `${what}: genau eine Google-Autorisierung`);
          assert.equal(google.log.lastAuth.scope, 'openid email');
          assert.ok(!JSON.stringify(google.log.lastAuth).includes('musterfirma'), `${what}: Website-Adresse geht nicht an Google`);
          assert.deepEqual(leaks(requests, 'musterfirma'), [], `${what}: Website-Adresse nie in einer URL`);
          const posts = requests.filter(r => r.method === 'POST').map(r => Object.fromEntries(new URLSearchParams(r.body)));
          assert.deepEqual(posts.map(p => [p.action, p.bestaetigung ?? null]), [['adresse', null], ['start', null], ['start', '1']], `${what}: Hero, Absenden ohne und mit Häkchen`);
          assert.ok(posts.every(p => !('werbung' in p) && !('unternehmer' in p) && !('agb' in p)), `${what}: keine weiteren Kästchen`);
          await waitFor(() => mail.state.accepted.length === 1, { what: 'interne Benachrichtigung' });
          assert.deepEqual(SHOTS && name === 'WebKit' ? ohne422(errors).filter(x => !/^Refused to apply a stylesheet/.test(x)) : ohne422(errors), [], `${what}: Konsolenfehler (inkl. CSP)`);
          assert.deepEqual(blocked, [], `${what}: unerwartete Fremd-Requests`);
          await context.close();
        }
      });
    }
  } finally {
    if (wk) await wk.close();
  }
});

test('Tastatur: ungültige Adresse bleibt im Hero (Fokus, nichts gesendet); Bestätigungsseite per Tab/Leertaste/Enter: ohne Häkchen Fehler mit Fokus, mit Häkchen über Google zur Referenz (mobil und Desktop)', { skip: formSkip }, async () => {
  for (const width of [390, 1440]) {
    await resetData();
    const before = google.log.auth || 0;
    const { context, page, errors, blocked, requests } = await open('/index.html', { width, height: 800 });
    const field = await tabTo(page, f => f.id === 'url');
    assert.ok(field.visible, 'Fokus im URL-Feld sichtbar');
    await page.keyboard.type('keine adresse');
    await page.keyboard.press('Enter');
    assert.equal(await page.isVisible('#url-error'), true);
    assert.deepEqual(await page.evaluate(() => [document.activeElement.id, document.activeElement.getAttribute('aria-invalid'), location.pathname]), ['url', 'true', '/'], 'Pages liefert /index.html unter / aus');
    assert.deepEqual(requests.filter(r => r.method === 'POST' || r.url.includes('/api/')), [], 'ungültige Adresse: nichts gesendet');
    /* Korrigieren: der Fehler verschwindet beim Tippen, Enter führt zur Bestätigungsseite */
    await page.fill('#url', '');
    await page.keyboard.type('musterfirma.de');
    assert.deepEqual([await page.isVisible('#url-error'), await page.getAttribute('#url', 'aria-invalid')], [false, null], 'Fehler verschwindet mit gültiger Adresse');
    await Promise.all([page.waitForURL(`${app.base}/api/anfrage`), page.keyboard.press('Enter')]);
    await page.waitForLoadState('load');
    assert.equal(await page.textContent('h1'), 'Analyse anfragen');
    /* Tab-Reihenfolge auf der Bestätigungsseite: … Adresse ändern → Kästchen → AGB → Datenschutzerklärung → Mit Google fortfahren */
    const box = await tabTo(page, f => f.id === 'bestaetigung');
    assert.ok(box.visible, 'Fokus auf dem Kästchen sichtbar');
    const knopf = await tabTo(page, f => f.tag === 'BUTTON', 4);
    assert.deepEqual([knopf.text, knopf.visible], ['Mit Google fortfahren', true], 'Fokus auf der Schaltfläche sichtbar');
    await Promise.all([page.waitForSelector('#bestaetigung-error'), page.keyboard.press('Enter')]);
    await fokusAuf(page, 'bestaetigung');
    assert.deepEqual(await page.evaluate(() => [document.activeElement.getAttribute('aria-invalid'), document.activeElement.getAttribute('aria-describedby'), document.querySelector('#bestaetigung-error').getAttribute('role')]), ['true', 'bestaetigung-error', 'alert']);
    assert.equal((google.log.auth || 0) - before, 0, 'ohne Häkchen keine Weiterleitung zu Google');
    await page.keyboard.press('Space');
    assert.equal(await page.isChecked('#bestaetigung'), true);
    await tabTo(page, f => f.tag === 'BUTTON', 4);
    await Promise.all([page.waitForSelector('#reference'), page.keyboard.press('Enter')]);
    assert.equal(new URL(page.url()).pathname, '/api/anfrage');
    assert.equal(await page.textContent('h1'), 'Vielen Dank für Ihre Anfrage.');
    assert.match(await page.textContent('#reference'), /^PXA-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    assert.equal(await page.locator('form, input[type=checkbox]').count(), 0, 'kein weiterer Bestätigungsschritt');
    const zurueck = await tabTo(page, f => f.text === 'Zur Startseite');
    assert.ok(zurueck.visible, 'Link „Zur Startseite“ per Tastatur erreichbar');
    assert.equal(google.log.auth - before, 1, 'genau eine Google-Autorisierung');
    assert.deepEqual(app.sql('SELECT website_url, terms_version, business_confirmed, marketing_consent FROM orders'), [{ website_url: 'https://musterfirma.de', terms_version: TERMS_VERSION, business_confirmed: 1, marketing_consent: 0 }]);
    await waitFor(() => mail.state.accepted.length === 1, { what: 'interne Benachrichtigung' });
    assert.deepEqual(mail.state.accepted[0].to, ['360@pixelkiez.de']);
    assert.deepEqual(leaks(requests, 'musterfirma'), [], 'Website-Adresse nie in einer URL');
    const cookies = await context.cookies();
    assert.ok(cookies.every(c => c.httpOnly && c.sameSite === 'Lax'), 'Session-Cookie HttpOnly/Lax');
    const storage = await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length, cookie: document.cookie }));
    assert.deepEqual(storage, { local: 0, session: 0, cookie: '' }, 'nichts im Browser-Speicher, Cookie für JS unsichtbar');
    assert.deepEqual(ohne422(errors), [], `${width}: Konsolenfehler`);
    assert.deepEqual(blocked, []);
    await context.close();
  }
});

test('Kleine Bildschirme (320×568, 360×640) in Chromium und WebKit: ungültige Adresse zeigt Feld und Fehlertext im Bild; auf der Bestätigungsseite zeigt „Mit Google fortfahren“ ohne Häkchen Kästchen und Fehlertext vollständig im Bild, Fokus am Kästchen; nichts gesendet, kein Auftrag', { skip: formSkip }, async t => {
  let wk = null;
  try { wk = await pw.webkit.launch(); } catch { /* unten als NOT_RUN gemeldet */ }
  try {
    for (const [name, engine] of [['Chromium', browser], ['WebKit', wk]]) {
      await t.test(name, { skip: !engine && 'NOT_RUN: Playwright-WebKit nicht installiert (playwright install webkit)' }, async st => {
        for (const size of ['320x568', '360x640']) {
          for (const reducedMotion of ['no-preference', 'reduce']) {
            await resetData();
            const before = google.log.auth || 0;
            const [width, height] = size.split('x').map(Number);
            const what = `${name} ${size} ${reducedMotion}`;
            const { context, page, errors, blocked, requests } = await open('/index.html', { width, height, reducedMotion, engine });
            /* Hero: ungültige Adresse – Feld und Fehlertext im Bild, Fokus im Feld, nichts gesendet */
            await page.fill('#url', 'keine adresse');
            await page.click('.url-field .btn');
            await settle(page);
            const hero = await imBild(page, ['#url', '#url-error']);
            assert.ok(hero['#url'].visible && hero['#url-error'].visible, `${what}: Feld und Fehlertext im Bild ${JSON.stringify(hero)}`);
            assert.equal(await page.evaluate(() => document.activeElement.id), 'url');
            assert.deepEqual(requests.filter(r => r.method === 'POST' || r.url.includes('/api/')), [], `${what}: ungültige Adresse sendet nichts`);
            /* Bestätigungsseite ohne Häkchen */
            await page.fill('#url', 'musterfirma.de');
            await Promise.all([page.waitForURL(`${app.base}/api/anfrage`), page.click('.url-field .btn')]);
            await Promise.all([page.waitForSelector('#bestaetigung-error'), page.click('.anfrage-form .btn')]);
            await fokusAuf(page, 'bestaetigung');
            const y = await settle(page);
            const m = await imBild(page, ['#bestaetigung', '#bestaetigung-error']);
            const info = `scrollY ${y}, Kästchen ${m['#bestaetigung'].top}–${m['#bestaetigung'].bottom} px, Fehlertext ${m['#bestaetigung-error'].top}–${m['#bestaetigung-error'].bottom} px, Fensterhöhe ${height} px`;
            assert.ok(m['#bestaetigung'].visible, `${what}: Kästchen vollständig im Bild (${info})`);
            assert.ok(m['#bestaetigung-error'].visible, `${what}: Fehlertext vollständig im Bild (${info})`);
            assert.ok(await overflow(page) <= 0, `${what}: kein seitlicher Überlauf`);
            if (SHOTS) await page.screenshot({ path: join(SHOTS, `bestaetigung-fehler-${name.toLowerCase()}-${size}-${reducedMotion}.png`) });
            await sleep(200);
            assert.equal((google.log.auth || 0) - before, 0, `${what}: keine Weiterleitung zu Google`);
            assert.deepEqual([orderCount(), app.sql('SELECT COUNT(*) AS n FROM notifications')[0].n, mail.state.attempts], [0, 0, 0], `${what}: kein Auftrag, kein Outbox-Eintrag, keine Mail`);
            assert.deepEqual(SHOTS && name === 'WebKit' ? ohne422(errors).filter(e => !/^Refused to apply a stylesheet/.test(e)) : ohne422(errors), [], `${what}: Konsolenfehler`);
            assert.deepEqual(blocked, [], `${what}: unerwartete Fremd-Requests`);
            st.diagnostic(`${what}: ${info}`);
            await context.close();
          }
        }
      });
    }
  } finally {
    if (wk) await wk.close();
  }
});

test('Ohne JavaScript: ungültige Adresse → Server-Fehlerseite mit Fokus am Feld; gültige → Bestätigungsseite; ohne Häkchen Fehler am Kästchen, kein Auftrag; mit Häkchen per POST bis zur Referenz; Adresse nie in einer GET-URL', { skip: formSkip }, async () => {
  await resetData();
  const before = google.log.auth || 0;
  const { context, page, requests, blocked } = await open('/index.html', { width: 390, height: 800, javaScriptEnabled: false });
  await page.fill('#url', 'keine adresse');
  await Promise.all([page.waitForURL(`${app.base}/api/anfrage`), page.press('#url', 'Enter')]);
  assert.equal(await page.textContent('h1'), 'Welche Website sollen wir analysieren?');
  assert.equal(await page.isVisible('#url-error'), true);
  await fokusAuf(page, 'url');
  assert.equal(await page.inputValue('#url'), 'keine adresse', 'Eingabe erhalten');
  await page.fill('#url', 'musterfirma.de');
  await Promise.all([page.waitForSelector('#bestaetigung'), page.press('#url', 'Enter')]);
  assert.equal(await page.textContent('h1'), 'Analyse anfragen');
  assert.equal(await page.textContent('.anfrage-url'), 'https://musterfirma.de');
  await Promise.all([page.waitForSelector('#bestaetigung-error'), page.click('.anfrage-form .btn')]);
  await fokusAuf(page, 'bestaetigung');
  assert.equal(await page.isChecked('#bestaetigung'), false);
  assert.equal((google.log.auth || 0) - before, 0, 'ohne Häkchen keine Weiterleitung zu Google');
  assert.equal(orderCount(), 0);
  await page.check('#bestaetigung');
  await Promise.all([page.waitForSelector('#reference'), page.click('.anfrage-form .btn')]);
  assert.equal(await page.textContent('h1'), 'Vielen Dank für Ihre Anfrage.');
  assert.match(await page.textContent('#reference'), /^PXA-/);
  assert.equal(orderCount(), 1);
  await waitFor(() => mail.state.accepted.length === 1, { what: 'interne Benachrichtigung' });
  assert.deepEqual(leaks(requests, 'musterfirma'), [], 'Website-Adresse nie in einer URL');
  assert.deepEqual(requests.filter(r => /website=/.test(r.body)).map(r => r.method), ['POST', 'POST', 'POST', 'POST']);
  assert.deepEqual(blocked, []);
  await context.close();
});

test('Browser-Zurück und Abbruch bei Google: Bestätigungsseite mit Hinweis wieder benutzbar, kein Auftrag ohne abgeschlossene Anmeldung; erneuter Rücksprung nach Erfolg legt nichts doppelt an', { skip: formSkip }, async () => {
  await resetData();
  google.state.authPage = true;
  try {
    const { context, page, errors, requests } = await open('/index.html', { width: 1440, height: 900 });
    await page.fill('#url', 'musterfirma.de');
    await Promise.all([page.waitForURL(`${app.base}/api/anfrage`), page.click('.url-field .btn')]);
    /* Zurück von der Bestätigungsseite zum Hero: „Analysieren“ wieder aktiv */
    await page.goBack({ waitUntil: 'load' });
    assert.equal(new URL(page.url()).pathname, '/');
    assert.equal(await page.isDisabled('.url-field .btn'), false, 'Button nach Zurück wieder aktiv');
    await page.fill('#url', 'musterfirma.de');
    await Promise.all([page.waitForURL(`${app.base}/api/anfrage`), page.click('.url-field .btn')]);
    await page.check('#bestaetigung');
    await Promise.all([page.waitForURL(u => u.href.startsWith(`${google.origin}/auth`)), page.click('.anfrage-form .btn')]);
    assert.equal(orderCount(), 0, 'Google-Seite erreicht: noch kein Auftrag');
    /* Zurück von Google: Bestätigungsseite neu vom Server, Hinweis, Kästchen leer, Adresse bleibt */
    await page.goBack({ waitUntil: 'load' });
    assert.equal(new URL(page.url()).pathname, '/api/anfrage');
    assert.match(await page.textContent('.anfrage-notiz'), /Die Google-Anmeldung wurde nicht abgeschlossen\. Es wurde keine Anfrage gespeichert\./);
    assert.deepEqual([await page.isChecked('#bestaetigung'), await page.textContent('.anfrage-url')], [false, 'https://musterfirma.de']);
    await page.check('#bestaetigung');
    await Promise.all([page.waitForURL(u => u.href.startsWith(`${google.origin}/auth`)), page.click('.anfrage-form .btn')]);
    /* Abbruch bei Google */
    await Promise.all([page.waitForURL(`${app.base}/api/auth/callback**`), page.click('#abbrechen')]);
    assert.match(await page.textContent('h1'), /Anmeldung abgebrochen/);
    assert.match(await page.textContent('main'), /Es wurde keine Anfrage gespeichert/);
    assert.equal(orderCount(), 0);
    await Promise.all([page.waitForURL(`${app.base}/api/anfrage`), page.click('a.btn:has-text("Erneut versuchen")')]);
    assert.equal(await page.textContent('.anfrage-url'), 'https://musterfirma.de', 'Adresse bleibt');
    assert.equal(await page.isChecked('#bestaetigung'), false, 'Häkchen muss erneut gesetzt werden');
    await page.check('#bestaetigung');
    await Promise.all([page.waitForURL(u => u.href.startsWith(`${google.origin}/auth`)), page.click('.anfrage-form .btn')]);
    await Promise.all([page.waitForSelector('#reference'), page.click('#weiter')]);
    const ref = await page.textContent('#reference');
    assert.equal(orderCount(), 1);
    /* Zurück auf die Google-Seite und erneut „Weiter“: der state ist verbraucht, kein zweiter Auftrag */
    await page.goBack({ waitUntil: 'load' });
    assert.ok(page.url().startsWith(`${google.origin}/auth`), page.url());
    await Promise.all([page.waitForURL(`${app.base}/api/auth/callback**`), page.click('#weiter')]);
    assert.match(await page.textContent('h1'), /Anmeldung abgelaufen/);
    await page.goto(app.base + '/api/anfrage');
    assert.equal(await page.textContent('#reference'), ref, 'Bestätigung bleibt dieselbe');
    await waitFor(() => mail.state.accepted.length === 1, { what: 'interne Benachrichtigung' });
    await sleep(300);
    assert.deepEqual([orderCount(), mail.state.accepted.length], [1, 1], 'genau ein Auftrag, genau eine Mail');
    assert.deepEqual(leaks(requests, 'musterfirma'), [], 'Website-Adresse nie in einer URL');
    assert.deepEqual(errors.filter(e => !/status of 40[09]/.test(e)), [], 'Konsolenfehler (außer den erwarteten 400/409-Dokumenten)');
    await context.close();
  } finally {
    google.state.authPage = false;
  }
});

test('Menü: Pfeil bei „Wissen“ klappt sechs Beiträge und „Mehr im Wissensbereich“ auf, Escape und Klick daneben schließen; mobil Menü-Button neben „Analyse“; ohne JavaScript bedienbar (Chromium und WebKit)', { skip }, async t => {
  /* Entscheidung des Auftraggebers 03.11.2026: kein doppeltes „Analyse“ im Menü, Mega-Menü für Wissen, Menü-Button mobil */
  const sichtbar = (page, s) => page.$$eval(s, es => es.map(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; }));
  let wk = null;
  try { wk = await pw.webkit.launch(); } catch { /* unten als NOT_RUN gemeldet */ }
  try {
    for (const [name, engine] of [['Chromium', browser], ['WebKit', wk]]) {
      await t.test(name, { skip: !engine && 'NOT_RUN: Playwright-WebKit nicht installiert (playwright install webkit)' }, async () => {
        /* Desktop: Menüpunkte ohne „Analyse“, rechts der Button „Analyse“, kein Menü-Button */
        let { context, page, errors, blocked } = await open('/index.html', { engine });
        assert.deepEqual(await page.$$eval('.nav-links > a', as => as.map(a => a.textContent.trim())), ['Bericht', 'Bereiche', 'Angebot', 'FAQ', 'Wissen']);
        assert.deepEqual(await page.$$eval('.nav .btn', as => as.map(a => a.textContent.trim())), ['Analyse']);
        assert.equal(await page.isVisible('.nav-menu summary'), false, `${name}: kein Menü-Button auf dem Desktop`);
        assert.equal(await page.isVisible('.mega-panel'), false, `${name}: Beiträge zunächst zugeklappt`);
        await page.click('.mega summary');
        assert.deepEqual(await sichtbar(page, '.mega-panel a'), Array(7).fill(true), `${name}: sechs Beiträge und „Mehr“ vollständig sichtbar`);
        await page.mouse.click(20, 860);
        assert.equal(await page.isVisible('.mega-panel'), false, `${name}: Klick daneben schließt`);
        /* Tastatur: Enter öffnet, Escape schließt und lässt den Fokus auf dem Pfeil */
        await page.focus('.mega summary');
        await page.keyboard.press('Enter');
        assert.equal(await page.isVisible('.mega-panel'), true, `${name}: Enter öffnet`);
        await page.keyboard.press('Escape');
        assert.deepEqual([await page.isVisible('.mega-panel'), await page.evaluate(() => document.activeElement.matches('.mega summary'))], [false, true], `${name}: Escape schließt, Fokus auf dem Pfeil`);
        await page.click('.mega summary');
        await Promise.all([page.waitForURL(/\/wissen\/(index(\.html)?)?$/), page.click('.mega-mehr a')]);
        assert.deepEqual(errors, [], `${name}: Konsolenfehler`);
        assert.deepEqual(blocked, [], `${name}: Fremd-Requests`);
        await context.close();
        /* Mobil: Menü-Button öffnet die Punkte; ein Sprungziel auf derselben Seite schließt das Menü */
        ({ context, page, errors, blocked } = await open('/index.html', { width: 390, height: 800, engine }));
        assert.equal(await page.isVisible('.nav-links'), false);
        await page.click('.nav-menu summary');
        assert.deepEqual(await sichtbar(page, '.nav-menu-panel a'), Array(5).fill(true), `${name}: fünf Menüpunkte vollständig sichtbar`);
        await page.click('.nav-menu-panel a[href="#faq"]');
        await page.waitForURL(/#faq$/);
        assert.equal(await page.isVisible('.nav-menu-panel'), false, `${name}: nach der Wahl geschlossen`);
        assert.deepEqual(errors, [], `${name}: Konsolenfehler (mobil)`);
        await context.close();
        /* Ohne JavaScript: beide Menüs öffnen trotzdem (<details>) */
        for (const [width, s] of [[1440, '.mega'], [390, '.nav-menu']]) {
          ({ context, page } = await open('/wissen/entity-trust.html', { width, height: 800, engine, javaScriptEnabled: false }));
          await page.click(`${s} summary`);
          assert.deepEqual(await sichtbar(page, `${s} ul a`), Array(s === '.mega' ? 7 : 5).fill(true), `${name} ${width} ohne JavaScript: ${s} öffnet`);
          await context.close();
        }
      });
    }
  } finally {
    if (wk) await wk.close();
  }
});

test('Accessibility-Snapshot (axe-core): keine schweren Verstöße auf Startseite (auch mit Fehlern), Methodik, Wissens- und Analyseseiten, Rechtsseiten, Eingabe-, Fehler- und Bestätigungsseite', { skip: skip || (!AXE && 'NOT_RUN: PXK_AXE nicht gesetzt') }, async t => {
  if (!SOFT_LAUNCH) await resetData();
  const report = {};
  /* Soft-Launch: ohne Formular und ohne Worker nur die 22 Seiten der Website */
  for (const path of SOFT_LAUNCH ? SEITEN.slice(0, -1) : ['/index.html', 'hero-fehler', '/impressum.html', '/datenschutz.html', '/agb.html', '/wissen/index.html', '/wissen/seo-geo-ai-visibility.html', '/wissen/wie-ki-websites-liest.html', '/wissen/wie-websites-ausgeliefert-werden.html', '/wissen/answerability.html', '/wissen/entity-trust.html', '/wissen/agent-readiness.html', '/analyse/index.html', '/analyse/auffindbarkeit-seo.html', '/analyse/performance-technik.html', '/analyse/nutzerfuehrung-conversion.html', '/analyse/vertrauen-datenschutz.html', '/analyse/barrierefreiheit.html', '/analyse/ki-verstaendlichkeit.html', '/analyse/methodik.html', '/analyse/warum-website-analyse.html', '/analyse/ki-crawler-agenten.html', '/api/anfrage', 'adresse-fehler', 'bestaetigung', 'bestaetigung-fehler', 'angenommen', 'duplikat']) {
    /* axe wird als Inline-Skript injiziert; die CSP der Seite würde das (korrekt) blockieren */
    const o = await open(path.startsWith('/') ? path : path === 'adresse-fehler' ? '/api/anfrage' : '/index.html', { bypassCSP: true });
    if (path === 'hero-fehler') await o.page.click('.url-field .btn');
    /* Fehlerseite des Workers zur Adresse (ohne JavaScript-Vorprüfung) */
    if (path === 'adresse-fehler') await Promise.all([o.page.waitForSelector('#url-error'), o.page.click('.url-field .btn')]);
    if (['bestaetigung', 'bestaetigung-fehler', 'angenommen', 'duplikat'].includes(path)) {
      await o.page.fill('#url', 'musterfirma.de');
      await Promise.all([o.page.waitForSelector('#bestaetigung'), o.page.click('.url-field .btn')]);
    }
    if (path === 'bestaetigung-fehler') await Promise.all([o.page.waitForSelector('#bestaetigung-error'), o.page.click('.anfrage-form .btn')]);
    if (path === 'angenommen' || path === 'duplikat') {
      await o.page.check('#bestaetigung');
      await Promise.all([o.page.waitForSelector('#reference'), o.page.click('.anfrage-form .btn')]);
      if (path === 'duplikat') assert.equal(await o.page.textContent('h1'), 'Diese Website ist bereits angefragt.');
    }
    await o.page.addScriptTag({ path: AXE });
    const v = await o.page.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'] })).violations.map(x => ({ id: x.id, impact: x.impact, n: x.nodes.length })));
    report[path] = v;
    assert.deepEqual(v.filter(x => ['serious', 'critical'].includes(x.impact)), [], `${path}: schwere axe-Verstöße`);
    await o.context.close();
  }
  t.diagnostic(`axe: ${JSON.stringify(report)}`);
});

test('Soft-Launch im Browser (Chromium und WebKit, 320/390/768/1440, alle 22 Seiten): Hinweis statt Formular, Partner-Logos geladen und verlinkt; keine Anfrage an /api/, Google oder fremde Server (auch keine Schriften)', { skip: skip || (!SOFT_LAUNCH && 'nur im Soft-Launch') }, async t => {
  let wk = null;
  try { wk = await pw.webkit.launch(); } catch { /* unten als NOT_RUN gemeldet */ }
  try {
    for (const [name, engine] of [['Chromium', browser], ['WebKit', wk]]) {
      await t.test(name, { skip: !engine && 'NOT_RUN: Playwright-WebKit nicht installiert (playwright install webkit)' }, async st => {
        let n = 0;
        for (const width of [320, 390, 768, 1440]) {
          for (const path of SEITEN) {
            const { context, page, errors, blocked, requests } = await open(path, { width, height: width >= 768 ? 900 : 800, engine });
            /* Seite ganz durchscrollen, damit alles nachgeladen wird, was beim Scrollen lädt (Videos laden erst im Bild) */
            await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += innerHeight / 2) { scrollTo(0, y); await new Promise(r => setTimeout(r, 30)); } });
            await page.waitForTimeout(150);
            /* blob:-Adressen der eigenen Herkunft sind Objekte im Browser, keine Netzanfragen (WebKit lädt so die Symbole seiner im
               Stromsparmodus erzwungenen Video-Bedienelemente, siehe systemMeldung) */
            const fremd = requests.filter(r => !r.url.startsWith(app.base + '/') && !r.url.startsWith('blob:' + app.base + '/'));
            assert.deepEqual([fremd, blocked], [[], []], `${name} ${path} ${width}: Anfragen an fremde Server (Google, Schriften, OAuth)`);
            assert.deepEqual(requests.filter(r => r.method !== 'GET' || new URL(r.url).pathname.startsWith('/api')), [], `${name} ${path} ${width}: Anfrage an /api/ oder kein GET`);
            assert.equal(await page.locator('form, input, textarea, select, button[type=submit]').count(), 0, `${name} ${path} ${width}: kein Formular`);
            assert.ok(await overflow(page) <= 0, `${name} ${path} ${width}: Überlauf`);
            /* Seitenende: nichts unter dem Footer, kein Überfedern über das Ende hinaus (iOS Safari zeigte darunter eine leere Fläche) */
            const ende = await page.evaluate(() => ({ rest: document.documentElement.scrollHeight - (document.querySelector('.footer').getBoundingClientRect().bottom + scrollY),
              over: getComputedStyle(document.documentElement).overscrollBehaviorY }));
            assert.ok(Math.abs(ende.rest) <= 1 && ende.over === 'none', `${name} ${path} ${width}: Seite endet am Footer (${JSON.stringify(ende)})`);
            /* Die 404-Seite kommt korrekt mit Status 404; Browser melden das für das Dokument selbst als Konsolenfehler */
            assert.deepEqual(errors.filter(e => !(path === '/gibt/es/nicht' && /status of 404/.test(e)) && !systemMeldung(e)), [], `${name} ${path} ${width}: Konsolenfehler`);
            if (path === '/index.html') {
              await page.evaluate(() => scrollTo(0, 0));
              await page.waitForTimeout(100);
              const m = await page.evaluate(() => {
                const r = s => document.querySelector(s).getBoundingClientRect();
                const logos = [...document.querySelectorAll('.partner-logos a')].map(a => { const img = a.querySelector('img'), b = img.getBoundingClientRect();
                  return [a.href, a.target, a.rel, img.alt, img.complete && img.naturalWidth > 0, b.width > 0 && b.left >= 0 && b.right <= innerWidth]; });
                return { vh: innerHeight, nav: r('#nav').bottom, bald: r('.hero .bald'), text: document.querySelector('.hero .bald').innerText.trim(), logos,
                  footer: (() => { const img = document.querySelector('.footer .footer-partner'); return img.complete && img.naturalWidth > 0; })() };
              });
              assert.match(m.text, /^Kostenlose Analyse-Anfragen in Kürze verfügbar\./, `${name} ${width}: Hinweis`);
              assert.ok(m.bald.top >= m.nav && m.bald.bottom <= m.vh, `${name} ${width}: Hinweis im ersten Bildschirm (${Math.round(m.bald.top)}–${Math.round(m.bald.bottom)} px von ${m.vh})`);
              assert.deepEqual(m.logos, [['https://pixelkiez.de/', '_blank', 'noopener', 'Pixelkiez', true, true], ['https://studio.dyai.cloud/', '_blank', 'noopener', 'DYAI Studio', true, true]], `${name} ${width}: Partner-Logos geladen, sichtbar, verlinkt`);
              assert.ok(m.footer, `${name} ${width}: Pixelkiez-Logo im Footer geladen`);
              if (SHOTS) await page.screenshot({ path: join(SHOTS, `softlaunch-${name.toLowerCase()}-${width}.png`), fullPage: true });
            }
            n++;
            await context.close();
          }
        }
        st.diagnostic(`${name}: ${n} Seitenaufrufe ohne Fremd-, API- oder Google-Anfrage`);
      });
    }
  } finally {
    if (wk) await wk.close();
  }
});
