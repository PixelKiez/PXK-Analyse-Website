/* PXK-154 – Browser-Prüfungen (Chromium über Playwright).
   Playwright ist bewusst keine Projekt-Abhängigkeit. Ausführen mit einer lokal vorhandenen Installation:
     PXK_PLAYWRIGHT=/pfad/zu/node_modules/playwright node --test tests/browser.test.mjs
   Optional: PXK_AXE=/pfad/zu/axe.min.js (Accessibility-Snapshot), PXK_SCREENSHOT_DIR=/tmp/pfad (Screenshots).
   Ohne Playwright werden die Tests als NOT_RUN übersprungen, nicht als bestanden gemeldet.
   Der eingebaute Server liefert den Base-Stand unter /__base/ direkt aus Git aus (nur für Negativproben). */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, statSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'ead3908edf49657bd2ae5756690b2610be64e691';
const PREVIEW = 'Vorschau – es wurde keine Anfrage versendet und keine Website geprüft.';
const VIEWPORTS = [320, 390, 768, 1440];
const SHOTS = process.env.PXK_SCREENSHOT_DIR || '';
const AXE = process.env.PXK_AXE || '';
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

const pw = await (async () => {
  const dir = process.env.PXK_PLAYWRIGHT;
  try { return dir ? await import(pathToFileURL(join(dir, 'index.mjs')).href) : await import('playwright'); } catch { return null; }
})();
const skip = pw ? false : 'NOT_RUN: Playwright nicht verfügbar (PXK_PLAYWRIGHT setzen)';

/* ---------- lokaler Server mit Request-Protokoll ---------- */

const serverLog = [];
let server, origin, browser;
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

function load(path) {
  if (path.startsWith('/__base/')) {
    try { return execFileSync('git', ['show', `${BASE}:${path.slice(8)}`], { cwd: ROOT }); } catch { return null; }
  }
  const file = normalize(join(ROOT, path));
  if (!file.startsWith(ROOT + '/')) return null;
  try { return statSync(file).isFile() ? readFileSync(file) : null; } catch { return null; }
}

before(async () => {
  if (!pw) return;
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      serverLog.push({ method: req.method, url: req.url, body });
      const path = decodeURIComponent(new URL(req.url, 'http://local').pathname);
      const content = load(path.endsWith('/') ? path + 'index.html' : path);
      if (!content) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(content);
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await pw.chromium.launch();
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
});

after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise(r => server.close(r));
});

async function open(path, { js = true, width = 1440, height = 900, reducedMotion = 'no-preference' } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, javaScriptEnabled: js, reducedMotion });
  const page = await context.newPage();
  const requests = [], errors = [], blocked = [];
  await context.route('**/*', route => {
    const u = new URL(route.request().url());
    if (u.origin === origin || FONT_HOSTS.includes(u.hostname)) return route.continue();
    blocked.push(u.href);
    return route.abort();
  });
  page.on('request', r => requests.push({ url: r.url(), method: r.method(), post: r.postData() || '', nav: r.isNavigationRequest() }));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  page.on('dialog', d => { errors.push(`Dialog: ${d.message()}`); d.dismiss(); });
  await page.goto(origin + path, { waitUntil: 'networkidle' });
  /* Webfonts (display=swap) können nach networkidle noch angewendet werden; Pixel- und Layoutvergleiche brauchen den Endzustand */
  if (js) await page.evaluate(() => document.fonts.ready);
  return { context, page, requests, errors, blocked };
}

const formState = page => page.evaluate(() => {
  const $ = s => document.querySelector(s);
  return {
    error: !$('#url-error').hidden, result: !$('#result').hidden, text: $('#result').innerText.trim(),
    focus: document.activeElement?.id || '', invalid: $('#url').getAttribute('aria-invalid'),
    describedby: $('#url').getAttribute('aria-describedby'), bodyHidden: $('#result-body').hidden,
    progressHidden: $('#progress').hidden, href: location.href,
  };
});
const waitPreview = page => page.waitForFunction(t => document.querySelector('#result-phase').textContent === t, PREVIEW, { timeout: 2000 });

/* ---------- T4 Formular ---------- */

test('T4 leere/ungültige/gültige Eingaben, Enter, Klick, Mehrfachauslösung, Fehler und Fokus', { skip }, async () => {
  const { context, page, errors } = await open('/index.html');
  const start = page.url();

  await page.click('#analyze button[type=submit]');
  let s = await formState(page);
  assert.equal(s.error, true, 'leer: Fehler sichtbar'); assert.equal(s.result, false, 'leer: kein Ergebnis');
  assert.equal(s.focus, 'url'); assert.equal(s.invalid, 'true'); assert.equal(s.describedby, 'url-error');

  for (const bad of ['   ', 'keine adresse', 'http://', 'musterfirma', 'javascript:alert(1)', '<img src=x onerror=window.__xss=1>.example', '"><svg onload=window.__xss=1>']) {
    await page.fill('#url', bad);
    await page.press('#url', 'Enter');
    s = await formState(page);
    assert.equal(s.error, true, `ungültig "${bad}": Fehler`); assert.equal(s.result, false, `ungültig "${bad}": kein Ergebnis`);
    assert.equal(s.focus, 'url', `ungültig "${bad}": Fokus`);
  }

  await page.fill('#url', 'https://www.musterfirma.example/pfad?x=1#a');
  await page.press('#url', 'Enter');
  await waitPreview(page);
  s = await formState(page);
  assert.equal(s.error, false); assert.equal(s.result, true); assert.equal(s.text, PREVIEW);
  assert.equal(s.invalid, null); assert.equal(s.describedby, null);
  assert.equal(s.bodyHidden, true, 'alter Ergebnisbereich bleibt verborgen'); assert.equal(s.progressHidden, true, 'kein Fortschrittsbalken');

  for (let k = 0; k < 5; k++) await page.click('#analyze button[type=submit]');
  await page.fill('#url', 'müller-bäckerei.example');
  for (let k = 0; k < 3; k++) await page.press('#url', 'Enter');
  await waitPreview(page);
  s = await formState(page);
  assert.equal(s.text, PREVIEW, 'Mehrfachauslösung: gleicher Hinweis'); assert.equal(s.href, start, 'keine Navigation');

  await page.fill('#url', 'x');
  await page.press('#url', 'Enter');
  s = await formState(page);
  assert.equal(s.result, false, 'nach ungültiger Eingabe kein alter Hinweis'); assert.equal(s.error, true);

  assert.equal(await page.evaluate(() => window.__xss), undefined, 'kein XSS');
  assert.equal(await page.locator('img, #analyze svg[onload]').count(), 0, 'keine eingeschleusten Elemente');
  assert.deepEqual(errors, []);
  await context.close();
});

/* ---------- T5 keine Datenübertragung, keine Speicherung ---------- */

test('T5 mit JavaScript: keine Requests durch das Formular, keine Speicherung', { skip }, async t => {
  const marker = 'pxk154-marker-js.example';
  const logStart = serverLog.length;
  const { context, page, requests, errors, blocked } = await open('/index.html');
  await page.waitForTimeout(300);
  const initial = requests.length;
  await page.fill('#url', marker);
  await page.press('#url', 'Enter');
  for (let k = 0; k < 3; k++) await page.click('#analyze button[type=submit]');
  await waitPreview(page);
  await page.waitForTimeout(800);
  const caused = requests.slice(initial);
  t.diagnostic(`initiale Ressourcen: ${initial} (${[...new Set(requests.slice(0, initial).map(r => new URL(r.url).host))].join(', ')}); nach Formularaktion: ${caused.length}`);
  assert.deepEqual(caused, [], 'Formular darf keine Requests auslösen');
  assert.ok(requests.every(r => !r.url.includes(marker) && !r.post.includes(marker)), 'Marker in keinem Request');
  assert.ok(serverLog.slice(logStart).every(r => !r.url.includes(marker) && !r.body.includes(marker)), 'Marker nicht im Server-Log');
  assert.ok(requests.every(r => r.method === 'GET'), 'nur GET-Ressourcen');
  assert.deepEqual(blocked, [], 'keine unerwarteten Fremd-Requests');
  const storage = await page.evaluate(async () => ({
    local: localStorage.length, session: sessionStorage.length, cookie: document.cookie,
    idb: (await indexedDB.databases()).length, caches: (await caches.keys()).length,
  }));
  assert.deepEqual(storage, { local: 0, session: 0, cookie: '', idb: 0, caches: 0 });
  assert.deepEqual(await context.cookies(), []);
  assert.deepEqual(errors, []);
  await context.close();
});

test('T5 ohne JavaScript: eingegebene URL erscheint weder in Query-String noch Body', { skip }, async t => {
  const marker = 'pxk154-marker-nojs.example';
  const logStart = serverLog.length;
  const { context, page, requests } = await open('/index.html', { js: false });
  for (const action of ['enter', 'click', 'enter']) {
    await page.fill('#url', marker);
    await Promise.all([page.waitForLoadState('load'), action === 'enter' ? page.press('#url', 'Enter') : page.click('#analyze button[type=submit]')]);
    assert.equal(page.url(), `${origin}/index.html?`, `${action}: Navigation ohne Formulardaten`);
  }
  const navs = requests.filter(r => r.nav).map(r => `${r.method} ${new URL(r.url).pathname}${new URL(r.url).search || (r.url.endsWith('?') ? '?' : '')}`);
  t.diagnostic(`Navigationen ohne JS: ${navs.join(' | ')}`);
  assert.ok(requests.every(r => !r.url.includes(marker) && !r.post.includes(marker) && r.method === 'GET'));
  assert.ok(serverLog.slice(logStart).every(r => !r.url.includes(marker) && !r.body.includes(marker)), 'Marker nicht im Server-Log');
  await context.close();
});

test('T5 Negativprobe: Base-Stand ohne JavaScript überträgt die URL (?url=)', { skip }, async () => {
  const marker = 'pxk154-marker-base.example';
  const { context, page } = await open('/__base/index.html', { js: false });
  await page.fill('#url', marker);
  await Promise.all([page.waitForLoadState('load'), page.press('#url', 'Enter')]);
  assert.ok(page.url().includes(`url=${marker}`), `erwartete Übertragung im Base-Stand, erhalten: ${page.url()}`);
  assert.ok(serverLog.some(r => r.url.includes(marker)), 'Server hat die Base-Übertragung protokolliert');
  await context.close();
});

/* ---------- T6 keine erfundenen Ergebnisse ---------- */

test('T6 unterschiedliche Domains erzeugen identischen, zahlenfreien Hinweis ohne Score', { skip }, async () => {
  const { context, page, errors } = await open('/index.html');
  const seen = [];
  for (const d of ['alpha-firma.example', 'zweite-website.example', 'kiez-kaffee.de']) {
    await page.fill('#url', d);
    await page.press('#url', 'Enter');
    await waitPreview(page);
    await page.waitForTimeout(400);
    seen.push(await page.evaluate(() => ({
      text: document.querySelector('#result').innerText.trim(),
      score: document.querySelector('#result-score').textContent,
      offsetAttr: document.querySelector('#result-ring').getAttribute('stroke-dashoffset'),
      offsetStyle: document.querySelector('#result-ring').style.strokeDashoffset,
      verdict: document.querySelector('#result-verdict').textContent,
    })));
  }
  for (const s of seen) assert.deepEqual(s, { text: PREVIEW, score: '0', offsetAttr: '175.93', offsetStyle: '', verdict: 'Solide Basis mit Baustellen' });
  assert.ok(!/\d/.test(seen[0].text), 'keine Zahlen im Hinweis');
  assert.deepEqual(errors, []);
  await context.close();
});

test('T6 Negativprobe: Base-Stand erzeugt domainabhängige Fantasie-Werte', { skip }, async () => {
  const { context, page } = await open('/__base/index.html', { reducedMotion: 'reduce' });
  const values = [];
  for (const d of ['alpha-firma.example', 'beispiel-zwei.example']) {
    await page.fill('#url', d);
    await page.press('#url', 'Enter');
    await page.waitForTimeout(300);
    values.push(await page.evaluate(() => ['#result-score', '#result-lcp', '#result-meta'].map(s => document.querySelector(s).textContent).join(' | ')));
  }
  assert.notEqual(values[0], values[1], `Base-Werte ${values.join(' / ')}`);
  await context.close();
});

/* ---------- T8 Navigation ---------- */

test('T8 Anker, Seitenwechsel und Footer-Links funktionieren im Browser', { skip }, async () => {
  const { context, page, errors } = await open('/index.html');
  const broken = await page.evaluate(() => [...document.querySelectorAll('a[href^="#"]')].map(a => a.getAttribute('href')).filter(h => h !== '#' && !document.getElementById(h.slice(1))));
  assert.deepEqual(broken, []);
  await page.click('.nav-links a[href="#preise"]');
  await page.waitForFunction(() => location.hash === '#preise');
  const internal = await page.evaluate(() => [...new Set([...document.querySelectorAll('a[href]')].map(a => a.getAttribute('href')).filter(h => /^[a-z].*\.html/.test(h)).map(h => h.split('#')[0]))]);
  for (const f of internal) assert.equal((await page.request.get(`${origin}/${f}`)).status(), 200, f);
  await Promise.all([page.waitForURL('**/pruefkriterien.html'), page.click('.nav .btn')]);
  assert.match(await page.title(), /Methodik/);
  const brokenP = await page.evaluate(() => [...document.querySelectorAll('a[href^="#"]')].map(a => a.getAttribute('href')).filter(h => h !== '#' && !document.getElementById(h.slice(1))));
  assert.deepEqual(brokenP, []);
  await page.click('.tools a[href="#accessibility"]');
  await page.waitForFunction(() => location.hash === '#accessibility');
  await Promise.all([page.waitForURL('**/index.html#preise'), page.click('#arbeitsweise a.btn')]);
  assert.equal(await page.evaluate(() => !!document.getElementById('preise')), true);
  await Promise.all([page.waitForURL('**/pruefkriterien.html#ux_conversion'), page.click('.tools a[href="pruefkriterien.html#ux_conversion"]')]);
  assert.equal(await page.locator('#ux_conversion .spec-row').count(), 8);
  assert.deepEqual(errors, []);
  await context.close();
});

/* ---------- T9 Mobile / kein horizontaler Überlauf ---------- */

test('T9 kein horizontaler Überlauf bei 320/390/768/1440 px, auch nach Formularaktion und mit offenen FAQ', { skip }, async t => {
  const overflow = page => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  for (const path of ['/index.html', '/pruefkriterien.html']) {
    for (const width of VIEWPORTS) {
      const { context, page, errors } = await open(path, { width, height: 800 });
      const name = `${path.slice(1, -5)}-${width}`;
      assert.ok(await overflow(page) <= 0, `${name}: Überlauf initial`);
      await page.$$eval('details', ds => ds.forEach(d => { d.open = true; }));
      assert.ok(await overflow(page) <= 0, `${name}: Überlauf mit offenen FAQ`);
      if (path === '/index.html') {
        await page.fill('#url', 'https://www.eine-sehr-lange-beispieladresse-fuer-mobile-tests.example/unterseite');
        await page.press('#url', 'Enter');
        await waitPreview(page);
        assert.ok(await overflow(page) <= 0, `${name}: Überlauf nach gültiger Eingabe`);
        if (SHOTS) await page.locator('.hero').screenshot({ path: join(SHOTS, `${name}-hero-preview.png`) });
        await page.fill('#url', 'ungültig');
        await page.press('#url', 'Enter');
        assert.ok(await overflow(page) <= 0, `${name}: Überlauf nach ungültiger Eingabe`);
        const marks = await page.evaluate(() => [...document.querySelectorAll('#report .card .tag, #pro .chart-card .tag, #report .ring small, #nutzen .detail-top span:nth-child(2)')].map(e => {
          const r = e.getBoundingClientRect();
          return { text: e.textContent.trim(), visible: r.width > 0 && r.height > 0 && r.left >= 0 && r.right <= innerWidth && getComputedStyle(e).visibility !== 'hidden' };
        }));
        assert.deepEqual(marks.map(m => m.text), ['Fiktiv', 'fiktiv', 'Beispiel · fiktiv', 'Fiktiv'], `${name}: Fiktiv-Kennzeichnungen`);
        assert.ok(marks.every(m => m.visible), `${name}: Fiktiv-Kennzeichnung sichtbar ${JSON.stringify(marks)}`);
      }
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}-full.png`), fullPage: true });
      assert.deepEqual(errors, [], name);
      await context.close();
    }
  }
  t.diagnostic(SHOTS ? `Screenshots: ${SHOTS}` : 'Screenshots nicht gespeichert (PXK_SCREENSHOT_DIR nicht gesetzt)');
});

test('T9 Breiten-Sweep 320–1440 px (8-px-Schritte, dicht an den Umbrüchen): kein Überlauf, auch nicht zwischen den Pflichtbreiten', { skip }, async () => {
  const widths = new Set();
  for (let w = 320; w <= 1440; w += 8) widths.add(w);
  for (const [a, b] of [[536, 544], [756, 800], [856, 880], [956, 964]]) for (let w = a; w <= b; w++) widths.add(w);
  for (const path of ['/vision.html', '/index.html', '/pruefkriterien.html']) {
    const { context, page } = await open(path);
    await page.$$eval('details', ds => ds.forEach(d => { d.open = true; }));
    const over = [];
    for (const width of [...widths].sort((a, b) => a - b)) {
      await page.setViewportSize({ width, height: 800 });
      const o = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (o > 0) over.push(`${width}px:+${o}`);
    }
    assert.deepEqual(over, [], `${path}: Überlauf`);
    await context.close();
  }
});

/* ---------- T2 / T14 Design im Browser: berechnete Styles gegen vision.html ---------- */

const STYLE_PROPS = ['color', 'background-color', 'font-family', 'font-size', 'font-weight', 'font-style', 'letter-spacing', 'text-transform',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'border-top-width', 'border-top-style', 'border-top-color',
  'border-bottom-width', 'border-radius', 'display', 'position', 'opacity', 'stroke', 'fill', 'stroke-dasharray'];

const computed = (page, props) => page.evaluate(props => [...document.querySelectorAll('body *')].filter(e => e.tagName !== 'SCRIPT').map(e => {
  const cs = getComputedStyle(e);
  return { key: `${e.tagName.toLowerCase()}.${e.getAttribute('class') || ''}#${e.id}`, s: props.map(p => cs.getPropertyValue(p)).join('|') };
}), props);

test('T2/T14 berechnete Styles aller Elemente und Hero-Geometrie entsprechen vision.html', { skip }, async t => {
  for (const width of [1440, 390]) {
    /* reduzierte Bewegung, damit Animationen (z. B. das blinkende Pixel) in beiden Seiten im Endzustand verglichen werden */
    const v = await open('/vision.html', { width, reducedMotion: 'reduce' });
    const i = await open('/index.html', { width, reducedMotion: 'reduce' });
    const [cv, ci] = [await computed(v.page, STYLE_PROPS), await computed(i.page, STYLE_PROPS)];
    assert.equal(ci.length, cv.length, `${width}: Elementanzahl`);
    const diffs = cv.map((e, k) => (e.key !== ci[k].key || e.s !== ci[k].s) ? `${e.key}: ${e.s} ≠ ${ci[k].key}: ${ci[k].s}` : null).filter(Boolean);
    assert.deepEqual(diffs, [], `${width}: Styleabweichungen`);
    const box = (p, s) => p.locator(s).first().boundingBox();
    for (const sel of ['.hero h1', '.url-field', '#report .card .bars', '#pro .chart', '#report .ring--lg']) {
      const [a, b] = [await box(v.page, sel), await box(i.page, sel)];
      assert.equal(Math.round(b.width), Math.round(a.width), `${width} ${sel} Breite`);
      if (sel !== '#report .card .bars') assert.equal(Math.round(b.height), Math.round(a.height), `${width} ${sel} Höhe`);
    }
    const [h1v, h1i] = [await v.page.locator('.hero h1').screenshot(), await i.page.locator('.hero h1').screenshot()];
    t.diagnostic(`${width}px: ${ci.length} Elemente stilgleich; H1-Pixel ${Buffer.compare(h1v, h1i) === 0 ? 'identisch' : 'abweichend'}`);
    assert.equal(Buffer.compare(h1v, h1i), 0, `${width}: H1 pixelidentisch`);
    if (SHOTS) {
      await v.page.screenshot({ path: join(SHOTS, `vision-${width}-hero.png`) });
      await i.page.screenshot({ path: join(SHOTS, `index-${width}-hero.png`) });
    }
    assert.deepEqual([...v.errors, ...i.errors], []);
    await v.context.close(); await i.context.close();
  }
});

/* ---------- T10 Accessibility ---------- */

async function focusWalk(page, max = 200) {
  const seen = [];
  for (let k = 0; k < max; k++) {
    await page.keyboard.press('Tab');
    const f = await page.evaluate(() => {
      const e = document.activeElement;
      /* Rundgang endet, wenn der Fokus wieder auf einem bereits besuchten Element landet (JS-Eigenschaft, kein DOM-Attribut) */
      if (!e || e === document.body || e.__pxkSeen) return null;
      e.__pxkSeen = true;
      const cs = getComputedStyle(e);
      const ring = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== 'none';
      /* Das Eingabefeld hat outline:none; die Markierung kommt über .url-field:focus-within (box-shadow) */
      const field = e.closest('.url-field');
      const within = !!field && field.matches(':focus-within') && getComputedStyle(field).boxShadow !== 'none';
      const name = (e.getAttribute('aria-label') || e.innerText || e.labels?.[0]?.innerText || e.getAttribute('placeholder') || '').trim();
      return { key: `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}|${(e.getAttribute('href') || '')}|${name.slice(0, 30)}`, ring, within, name };
    });
    if (!f) break;
    seen.push(f);
  }
  return seen;
}

test('T10 Tastatur, sichtbarer Fokus, Beschriftungen, Überschriften und Accessibility-Snapshot', { skip }, async t => {
  const { context, page, errors } = await open('/index.html');
  let steps = 0;
  while (steps++ < 15 && await page.evaluate(() => document.activeElement?.id) !== 'url') await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'url', 'Feld per Tab erreichbar');
  await page.keyboard.type('musterfirma.example');
  await page.keyboard.press('Enter');
  await waitPreview(page);
  await page.keyboard.press('Tab');
  const btn = await page.evaluate(() => ({ tag: document.activeElement.tagName, outline: getComputedStyle(document.activeElement).outlineStyle }));
  assert.deepEqual(btn, { tag: 'BUTTON', outline: 'solid' }, 'Button mit sichtbarem Fokus');
  await page.keyboard.press('Enter');
  await waitPreview(page);
  assert.deepEqual(errors, []);
  await context.close();

  const report = {};
  for (const path of ['/vision.html', '/index.html', '/pruefkriterien.html']) {
    const o = await open(path);
    const walk = await focusWalk(o.page);
    const noRing = walk.filter(w => !w.ring && !w.within).map(w => w.key);
    const unnamed = walk.filter(w => !w.name).map(w => w.key);
    const headings = await o.page.evaluate(() => [...document.querySelectorAll('h1,h2,h3,h4')].map(h => +h.tagName[1]));
    const skips = headings.slice(1).filter((h, k) => h - headings[k] > 1).length;
    const label = await o.page.evaluate(() => [...document.querySelectorAll('input')].every(i => i.labels.length > 0));
    let axe = null;
    if (AXE) {
      await o.page.addScriptTag({ path: AXE });
      const r = await o.page.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'] })).violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.map(n => n.target.join(' ')) })));
      axe = r;
    }
    report[path] = { focusable: walk.length, noRing, unnamed, h1: headings.filter(h => h === 1).length, skips, label, axe };
    assert.deepEqual(o.errors, [], path);
    await o.context.close();
  }
  t.diagnostic(`A11y-Bericht: ${JSON.stringify(report)}`);
  for (const path of ['/index.html', '/pruefkriterien.html']) {
    const r = report[path], v = report['/vision.html'];
    assert.equal(r.h1, 1, `${path}: genau eine H1`);
    assert.equal(r.label, true, `${path}: Eingabefelder beschriftet`);
    assert.deepEqual(r.unnamed, [], `${path}: fokussierbare Elemente ohne Namen`);
    assert.deepEqual(r.noRing, [], `${path}: Fokus ohne sichtbare Markierung`);
    assert.ok(r.skips <= v.skips, `${path}: neue Überschriftensprünge`);
    if (r.axe) {
      const severe = r.axe.filter(x => ['serious', 'critical'].includes(x.impact)).map(x => x.id);
      const baseline = new Set(v.axe.filter(x => ['serious', 'critical'].includes(x.impact)).map(x => x.id));
      assert.deepEqual(severe.filter(id => !baseline.has(id)), [], `${path}: neue schwere axe-Verstöße`);
    }
  }
  if (!AXE) t.diagnostic('NOT_RUN: axe-core-Snapshot (PXK_AXE nicht gesetzt)');
});

/* ---------- T11 Reduced Motion ---------- */

test('T11 reduzierte Bewegung: kein Tipp-Platzhalter, sofortiger Sprung und Fokus, Animationen verkürzt', { skip }, async () => {
  const r = await open('/index.html', { reducedMotion: 'reduce' });
  const p0 = await r.page.getAttribute('#url', 'placeholder');
  await r.page.waitForTimeout(3200);
  assert.equal(await r.page.getAttribute('#url', 'placeholder'), p0, 'Platzhalter bleibt statisch');
  await r.page.evaluate(() => scrollTo(0, document.body.scrollHeight));
  await r.page.click('#to-top');
  await r.page.waitForTimeout(80);
  assert.deepEqual(await r.page.evaluate(() => ({ y: Math.round(scrollY), focus: document.activeElement.id })), { y: 0, focus: 'url' });
  await r.page.fill('#url', 'musterfirma.example');
  await r.page.press('#url', 'Enter');
  await waitPreview(r.page);
  assert.ok(parseFloat(await r.page.evaluate(() => getComputedStyle(document.querySelector('#result')).animationDuration)) <= 0.001, 'Einblendung ohne Bewegung');
  assert.deepEqual(r.errors, []);
  await r.context.close();

  const n = await open('/index.html');
  const q0 = await n.page.getAttribute('#url', 'placeholder');
  await n.page.waitForTimeout(3200);
  assert.notEqual(await n.page.getAttribute('#url', 'placeholder'), q0, 'Gegenprobe: ohne Reduced Motion tippt der Platzhalter');
  await n.page.evaluate(() => scrollTo(0, document.body.scrollHeight));
  await n.page.click('#to-top');
  await n.page.waitForFunction(() => document.activeElement.id === 'url', null, { timeout: 2000 });
  await n.context.close();
});
