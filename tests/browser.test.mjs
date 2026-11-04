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
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mockGoogle, mockResend, startPages, waitFor, sleep, workerAvailable, wranglerAvailable, ROOT, TERMS_VERSION, SOFT_LAUNCH, SOFT_LAUNCH_SKIP, R2_VIDEOS } from './lib/harness.mjs';

const SHOTS = process.env.PXK_SCREENSHOT_DIR || '';
const AXE = process.env.PXK_AXE || '';
const MEDIA_DIR = process.env.PXK_MEDIA_DIR || '';
/* Soft-Launch mit selbst ausgelieferten Schriften: jede Anfrage an Google Fonts zählt als Fremd-Request (blocked) */
const FONT_HOSTS = SOFT_LAUNCH ? [] : ['fonts.googleapis.com', 'fonts.gstatic.com'];
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
  const media = MEDIA_DIR ? Object.fromEntries(R2_VIDEOS.map(k => [k, join(MEDIA_DIR, k)])) : {};
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
      if (SOFT_LAUNCH && path === '/index.html') {
        const hinweis = await page.evaluate(() => { const r = document.querySelector('.hero .bald').getBoundingClientRect(); return r.width > 0 && r.left >= 0 && r.right <= innerWidth; });
        assert.ok(hinweis, `${path} ${width}: Hinweis „in Kürze verfügbar“ vollständig sichtbar`);
      } else if (['/index.html', '/api/anfrage'].includes(path)) {
        const form = await page.evaluate(() => ['#url', '.url-field .btn', '#agb', 'label.consent', 'label.consent a'].map(s => { const r = document.querySelector(s).getBoundingClientRect(); return r.width > 0 && r.left >= 0 && r.right <= innerWidth; }));
        assert.deepEqual(form, [true, true, true, true, true], `${path} ${width}: Eingabefeld, Button, AGB-Häkchen und AGB-Link vollständig sichtbar`);
        const target = await page.evaluate(() => document.querySelector('label.consent').getBoundingClientRect().height);
        assert.ok(target >= 24, `${path} ${width}: AGB-Häkchen mit Beschriftung mindestens 24 px hoch (${target})`);
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

test('Hero beim Öffnen: Überschrift, Text, Website-Eingabe und AGB-Häkchen im ersten Bildschirm (ab 360×640) und kontrastreich (Desktop und Mobil)', { skip: formSkip }, async () => {
  /* Alles inklusive AGB-Häkchen, Hinweis und Faktenzeile sichtbar. 360×640: Faktenzeile darf seit dem AGB-Häkchen (BE-02) knapp unter
     den Rand rutschen, Häkchen und Hinweis nicht. Beim sehr kleinen 320×568 wie bisher mindestens Überschrift, Text, Eingabe und Button;
     das Häkchen liegt dort knapp darunter (ohne Häkchen setzt „Analysieren“ den Fokus mit Fehlertext darauf). */
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
        h1: b('.hero .h1'), lead: b('.hero .lead'), field: b('.url-field'), button: b('.url-field .btn'), agb: b('.hero .consent'), note: b('.hero .hero-note'), facts: b('.hero .facts'),
        leadColor: getComputedStyle(document.querySelector('.hero .lead')).color, bodyBg: getComputedStyle(document.body).backgroundColor,
        placeholder: getComputedStyle(input, '::placeholder').color, fieldBg: getComputedStyle(input.closest('.url-field')).backgroundColor,
      };
    });
    const must = full.includes(size) ? ['h1', 'lead', 'field', 'button', 'agb', 'note', 'facts'] : compact.includes(size) ? ['h1', 'lead', 'field', 'button', 'agb', 'note'] : ['h1', 'lead', 'field', 'button'];
    for (const k of must) assert.ok(m[k] <= m.vh, `${size}: ${k} endet bei ${Math.round(m[k])} px, sichtbar sind ${m.vh} px`);
    assert.ok(m.h1Top >= m.nav, `${size}: Überschrift liegt nicht unter der Navigation`);
    assert.ok(contrast(m.leadColor, m.bodyBg) >= 7, `${size}: Lauftext kontrastreich`);
    assert.ok(contrast(m.placeholder, m.fieldBg) >= 7, `${size}: Platzhalter im Eingabefeld kontrastreich`);
    await context.close();
  }
});

test('Befund-Video bei „Jeder Befund verständlich erklärt“: links neben den Punkten (mobil darunter), 5:4, abgerundet, startet von selbst erst im Bild, stumm, Schleife, ohne Bedienelemente (Range-Antworten 206)', { skip: videoSkip }, async () => {
  /* An der Stelle der früheren Beispielkarte (Entscheidung des Auftraggebers 03.11.2026, PXK-159); unter dem Hero die historische Demo (P0-Hotfix) */
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
        assert.match(e.label, /^(Animierte|Historische Demo)/, `${width}: Alternativtext bleibt`);
      }
      const list = await videos();
      assertRanges(list, ['/media/360-pixelkiez-video-1080p.mp4', '/media/report-pdf-de-1x1-lavendel.mp4', '/media/section-bericht-peach-5x4.mp4'], `WebKit ${width}`);
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
          assertRanges(await videos(), ['/media/360-pixelkiez-video-1080p.mp4', '/media/report-pdf-de-1x1-lavendel.mp4', '/media/section-bericht-peach-5x4.mp4'], was);
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

test('Tastatur: ungültige Adresse und fehlendes AGB-Häkchen bleiben im Formular (Fokus, nichts gesendet); mit Häkchen per Tab/Leertaste/Enter über Google direkt zur Referenz (mobil und Desktop)', { skip: formSkip }, async () => {
  for (const width of [390, 1440]) {
    await resetData();
    /* bypassCSP nur hier: Die statische Meta-CSP erlaubt als Formularziel nur https://accounts.google.com, nicht den lokalen Mock.
       Die CSP selbst prüfen der Mobil-Test (keine CSP-Konsolenfehler) und tests/static.test.mjs (form-action). */
    const before = google.log.auth || 0;
    const { context, page, errors, blocked, requests } = await open('/index.html', { width, height: 800, bypassCSP: true });
    const field = await tabTo(page, f => f.id === 'url');
    assert.ok(field.visible, 'Fokus im URL-Feld sichtbar');
    await page.keyboard.type('keine adresse');
    await page.keyboard.press('Enter');
    assert.equal(await page.isVisible('#url-error'), true);
    assert.deepEqual(await page.evaluate(() => [document.activeElement.id, document.activeElement.getAttribute('aria-invalid'), location.pathname]), ['url', 'true', '/'], 'Pages liefert /index.html unter / aus');
    await page.fill('#url', '');
    await page.keyboard.type('musterfirma.de');
    /* Gültige Adresse, aber kein AGB-Häkchen: Fehler am Häkchen, Fokus dorthin, keine Anfrage an Worker oder Google */
    await page.keyboard.press('Enter');
    assert.equal(await page.isVisible('#agb-error'), true);
    assert.equal(await page.isVisible('#url-error'), false);
    assert.deepEqual(await page.evaluate(() => [document.activeElement.id, document.activeElement.getAttribute('aria-invalid'), document.activeElement.getAttribute('aria-describedby'), location.pathname]), ['agb', 'true', 'agb-error', '/']);
    await page.waitForTimeout(80);
    assert.ok((await focusInfo(page)).visible, 'Fokus auf dem Häkchen sichtbar');
    assert.equal(await page.isChecked('#agb'), false, 'nicht vorausgewählt');
    assert.deepEqual(requests.filter(r => r.method === 'POST' || r.url.includes('/api/')), [], 'ohne Häkchen wird nichts gesendet');
    assert.equal((google.log.auth || 0) - before, 0);
    await page.keyboard.press('Space');
    assert.equal(await page.isChecked('#agb'), true);
    assert.equal(await page.isVisible('#agb-error'), false, 'Fehler verschwindet mit dem Häkchen');
    await page.keyboard.press('Shift+Tab');
    await page.waitForTimeout(80);
    const submit = await focusInfo(page);
    assert.deepEqual([submit.tag, submit.text], ['BUTTON', 'Analysieren']);
    assert.ok(submit.visible, 'Fokus auf „Analysieren“ sichtbar');
    await Promise.all([page.waitForSelector('#reference'), page.keyboard.press('Enter')]);
    assert.equal(new URL(page.url()).pathname, '/api/anfrage');
    assert.match(await page.textContent('#reference'), /^PXA-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    assert.match(await page.textContent('h1'), /Ihre Anfrage liegt bei uns/);
    assert.equal(await page.locator('form, input[type=checkbox]').count(), 0, 'kein zweiter Bestätigungsschritt');
    assert.equal(google.log.auth - before, 1, 'genau eine Google-Autorisierung');
    assert.equal(google.log.lastAuth.scope, 'openid email');
    assert.ok(await overflow(page) <= 0, `${width}: Überlauf auf der Bestätigung`);
    assert.deepEqual(app.sql('SELECT website_url, terms_version FROM orders'), [{ website_url: 'https://musterfirma.de', terms_version: TERMS_VERSION }]);
    await waitFor(() => mail.state.accepted.length === 1, { what: 'interne Benachrichtigung' });
    assert.deepEqual(mail.state.accepted[0].to, ['360@pixelkiez.de']);
    assert.deepEqual(leaks(requests, 'musterfirma'), [], 'Website-Adresse nie in einer URL');
    assert.ok(requests.some(r => r.method === 'POST' && /website=musterfirma\.de/.test(r.body) && /agb=1/.test(r.body) && r.body.includes(`agb_version=${TERMS_VERSION}`)), 'per POST mit Häkchen und AGB-Version');
    const cookies = await context.cookies();
    assert.ok(cookies.every(c => c.httpOnly && c.sameSite === 'Lax'), 'Session-Cookie HttpOnly/Lax');
    const storage = await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length, cookie: document.cookie }));
    assert.deepEqual(storage, { local: 0, session: 0, cookie: '' }, 'nichts im Browser-Speicher, Cookie für JS unsichtbar');
    assert.deepEqual(errors, [], `${width}: Konsolenfehler`);
    assert.deepEqual(blocked, []);
    await context.close();
  }
});

test('Kleine Bildschirme (320×568, 360×640) in Chromium und WebKit: „Analysieren“ ohne AGB-Häkchen zeigt Häkchen und Fehlertext vollständig im Bild, Fokus am Häkchen; nichts gesendet, kein Auftrag, keine Benachrichtigung', { skip: formSkip }, async t => {
  /* Gemessen wird nach dem Klick, ohne dass der Test selbst scrollt: Beide Elemente liegen zwischen Navigation und unterem Fensterrand
     und sind an ihrem Mittelpunkt nicht verdeckt. Mit und ohne „Bewegung reduzieren“ – sonst scrollt die Seite weich, daher warten, bis sie steht. */
  const settle = page => page.evaluate(() => new Promise(done => {
    let last = NaN, same = 0;
    const tick = () => { if (scrollY === last) same++; else { same = 0; last = scrollY; } if (same >= 10) done(scrollY); else requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }));
  const seen = page => page.evaluate(() => {
    const nav = document.querySelector('#nav').getBoundingClientRect().bottom;
    return Object.fromEntries(['#agb', '#agb-error'].map(s => {
      const e = document.querySelector(s), r = e.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return [s, { top: Math.round(r.top), bottom: Math.round(r.bottom), visible: r.height > 0 && r.top >= nav && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth && (hit === e || e.contains(hit)) }];
    }));
  });
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
            await page.fill('#url', 'musterfirma.de');
            const y0 = await page.evaluate(() => scrollY);
            await page.click('.url-field .btn');
            const y = await settle(page);
            const m = await seen(page);
            const info = `scrollY ${y0} → ${y}, Häkchen ${m['#agb'].top}–${m['#agb'].bottom} px, Fehlertext ${m['#agb-error'].top}–${m['#agb-error'].bottom} px, Fensterhöhe ${height} px`;
            assert.equal(await page.isVisible('#agb-error'), true, `${what}: Fehlertext eingeblendet`);
            assert.ok(m['#agb'].visible, `${what}: AGB-Häkchen vollständig im Bild (${info})`);
            assert.ok(m['#agb-error'].visible, `${what}: Fehlertext vollständig im Bild (${info})`);
            assert.deepEqual(await page.evaluate(() => [document.activeElement.id, document.activeElement.getAttribute('aria-invalid'), document.activeElement.getAttribute('aria-describedby'), document.querySelector('#agb').checked, location.pathname]),
              ['agb', 'true', 'agb-error', false, '/'], `${what}: Fokus am Häkchen, als ungültig markiert und mit dem Fehlertext verknüpft`);
            if (SHOTS) await page.screenshot({ path: join(SHOTS, `agb-fehler-${name.toLowerCase()}-${size}-${reducedMotion}.png`) });
            await sleep(200);
            assert.deepEqual(requests.filter(r => r.method === 'POST' || r.url.includes('/api/')), [], `${what}: ohne Häkchen wird nichts gesendet`);
            assert.equal((google.log.auth || 0) - before, 0, `${what}: keine Weiterleitung zu Google`);
            assert.deepEqual([orderCount(), app.sql('SELECT COUNT(*) AS n FROM notifications')[0].n, mail.state.attempts], [0, 0, 0], `${what}: kein Auftrag, kein Outbox-Eintrag, keine Mail`);
            /* Weiter bedienbar: Häkchen setzen nimmt Fehlertext und Markierung zurück */
            await page.check('#agb');
            assert.deepEqual([await page.isVisible('#agb-error'), await page.getAttribute('#agb', 'aria-invalid')], [false, null], `${what}: Fehler verschwindet mit dem Häkchen`);
            /* Nur mit Screenshots: WebKit meldet die dafür von Playwright eingefügten Styles als CSP-Verstoß (die Seiten-CSP blockiert sie zu Recht) */
            assert.deepEqual(SHOTS && name === 'WebKit' ? errors.filter(e => !/^Refused to apply a stylesheet/.test(e)) : errors, [], `${what}: Konsolenfehler`);
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

test('Ohne JavaScript: fehlendes Häkchen → Server-Fehlerseite mit Fokus am Häkchen, kein Auftrag; mit Häkchen Anfrage per POST bis zur Referenz; Adresse nie in einer GET-URL', { skip: formSkip }, async () => {
  await resetData();
  const before = google.log.auth || 0;
  const { context, page, requests, blocked } = await open('/index.html', { width: 390, height: 800, bypassCSP: true, javaScriptEnabled: false });
  await page.fill('#url', 'musterfirma.de');
  await Promise.all([page.waitForURL(`${app.base}/api/anfrage`), page.press('#url', 'Enter')]);
  assert.match(await page.textContent('h1'), /Welche Website sollen wir analysieren/);
  assert.equal(await page.isVisible('#agb-error'), true);
  assert.deepEqual(await page.evaluate(() => [document.activeElement.id, document.querySelector('#url').value, document.querySelector('#agb').checked]), ['agb', 'musterfirma.de', false], 'Fokus per autofocus, Eingabe erhalten, Häkchen nicht gesetzt');
  assert.equal((google.log.auth || 0) - before, 0, 'ohne Häkchen keine Weiterleitung zu Google');
  assert.equal(orderCount(), 0);
  await page.check('#agb');
  await Promise.all([page.waitForSelector('#reference'), page.click('.url-field .btn')]);
  assert.match(await page.textContent('#reference'), /^PXA-/);
  assert.equal(orderCount(), 1);
  await waitFor(() => mail.state.accepted.length === 1, { what: 'interne Benachrichtigung' });
  assert.deepEqual(leaks(requests, 'musterfirma'), [], 'Website-Adresse nie in einer URL');
  assert.deepEqual(requests.filter(r => /website=/.test(r.body)).map(r => r.method), ['POST', 'POST']);
  assert.deepEqual(blocked, []);
  await context.close();
});

test('Browser-Zurück und Abbruch bei Google: Formular wieder benutzbar, kein Auftrag ohne abgeschlossene Anmeldung; erneuter Rücksprung nach Erfolg legt nichts doppelt an', { skip: formSkip }, async () => {
  await resetData();
  google.state.authPage = true;
  try {
    const { context, page, errors, requests } = await open('/index.html', { width: 1440, height: 900, bypassCSP: true });
    await page.fill('#url', 'musterfirma.de');
    await page.check('#agb');
    await Promise.all([page.waitForURL(u => u.href.startsWith(`${google.origin}/auth`)), page.click('.url-field .btn')]);
    assert.equal(orderCount(), 0, 'Google-Seite erreicht: noch kein Auftrag');
    /* Zurück zur Startseite: Button wieder aktiv, erneutes Absenden möglich */
    await page.goBack({ waitUntil: 'load' });
    assert.equal(new URL(page.url()).pathname, '/');
    assert.equal(await page.isDisabled('.url-field .btn'), false, 'Button nach Zurück wieder aktiv');
    await page.fill('#url', 'musterfirma.de');
    await page.check('#agb');
    await Promise.all([page.waitForURL(u => u.href.startsWith(`${google.origin}/auth`)), page.click('.url-field .btn')]);
    /* Abbruch bei Google */
    await Promise.all([page.waitForURL(`${app.base}/api/auth/callback**`), page.click('#abbrechen')]);
    assert.match(await page.textContent('h1'), /Anmeldung abgebrochen/);
    assert.match(await page.textContent('main'), /Es wurde keine Anfrage gespeichert/);
    assert.equal(orderCount(), 0);
    await Promise.all([page.waitForURL(`${app.base}/api/anfrage`), page.click('a.btn:has-text("Erneut versuchen")')]);
    assert.equal(await page.inputValue('#url'), 'https://musterfirma.de', 'Adresse vorausgefüllt');
    assert.equal(await page.isChecked('#agb'), false, 'Häkchen muss erneut gesetzt werden');
    await page.check('#agb');
    await Promise.all([page.waitForURL(u => u.href.startsWith(`${google.origin}/auth`)), page.click('.url-field .btn')]);
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
  for (const path of SOFT_LAUNCH ? SEITEN.slice(0, -1) : ['/index.html', 'hero-fehler', '/impressum.html', '/datenschutz.html', '/agb.html', '/wissen/index.html', '/wissen/seo-geo-ai-visibility.html', '/wissen/wie-ki-websites-liest.html', '/wissen/wie-websites-ausgeliefert-werden.html', '/wissen/answerability.html', '/wissen/entity-trust.html', '/wissen/agent-readiness.html', '/analyse/index.html', '/analyse/auffindbarkeit-seo.html', '/analyse/performance-technik.html', '/analyse/nutzerfuehrung-conversion.html', '/analyse/vertrauen-datenschutz.html', '/analyse/barrierefreiheit.html', '/analyse/ki-verstaendlichkeit.html', '/analyse/methodik.html', '/analyse/warum-website-analyse.html', '/analyse/ki-crawler-agenten.html', '/api/anfrage', 'server-fehler', 'angenommen']) {
    /* axe wird als Inline-Skript injiziert; die CSP der Seite würde das (korrekt) blockieren */
    const o = await open(path.startsWith('/') ? path : path === 'server-fehler' ? '/api/anfrage' : '/index.html', { bypassCSP: true });
    if (path === 'hero-fehler') await o.page.click('.url-field .btn');
    if (path === 'server-fehler') {
      /* Pflichtfeld im Browser abschalten, damit die Fehlerseite des Workers (fehlendes Häkchen) geprüft wird */
      await o.page.$eval('#agb', e => { e.required = false; });
      await o.page.fill('#url', 'musterfirma.de');
      await Promise.all([o.page.waitForSelector('#agb-error'), o.page.click('.url-field .btn')]);
    }
    if (path === 'angenommen') {
      await o.page.fill('#url', 'musterfirma.de');
      await o.page.check('#agb');
      await Promise.all([o.page.waitForSelector('#reference'), o.page.press('#url', 'Enter')]);
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
