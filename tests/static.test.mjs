/* PXK-154 – statische Prüfungen ohne Abhängigkeiten (Node >= 20).
   Ausführen im Repo-Root:  node --test tests/static.test.mjs
   Jede Prüfung hat eine Negativprobe gegen den Base-Stand oder eine gezielte Mutation,
   damit belegt ist, dass der Test den ursprünglichen Fehler tatsächlich erkennt. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as H from './lib/html.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'ead3908edf49657bd2ae5756690b2610be64e691';
const REFERENCE_ZIP = process.env.PXK_REFERENCE_ZIP || join(ROOT, '..', 'pxwa-quellen-klein.zip');

const git = (...args) => execFileSync('git', args, { cwd: ROOT, maxBuffer: 1 << 26 });
const gitText = (...args) => git(...args).toString('utf8');
const read = p => readFileSync(join(ROOT, p), 'utf8');
const base = p => gitText('show', `${BASE}:${p}`);
const sha256 = b => createHash('sha256').update(b).digest('hex');

const PROTECTED = ['vision.html', 'assets/styles.css', 'DESIGN.md', 'STRUCTURE.md', '.gitignore'];
const ALLOWED_CHANGES = [/^index\.html$/, /^assets\/app\.js$/, /^pruefkriterien\.html$/, /^tests\//];
const PREVIEW = 'Vorschau – es wurde keine Anfrage versendet und keine Website geprüft.';
const AREAS = [
  ['findability_seo', 'Auffindbarkeit & SEO', 'FIND', 10],
  ['performance_technology', 'Performance & Technik', 'PERF', 9],
  ['ux_conversion', 'Nutzerführung & Conversion', 'UX', 8],
  ['accessibility', 'Barrierefreiheit', 'A11Y', 6],
  ['trust_privacy_content', 'Vertrauen, Datenschutz & Inhalt', 'TRUST', 8],
  ['ai_readiness', 'KI-Verständlichkeit', 'AI', 7],
];
/* Platzhalter-Links, die bewusst offen bleiben: Release-Blocker (AC9), nicht Teil von PXK-154. */
const KNOWN_PLACEHOLDERS = ['Kontakt', 'Impressum', 'Datenschutz', 'AGB'];
const EXTERNAL_OK = ['https://pixelkiez.de/'];

/* ---------- Prüffunktionen (werden auch für die Negativproben verwendet) ---------- */

function scopeViolations(paths) {
  return paths.filter(p => !ALLOWED_CHANGES.some(r => r.test(p)));
}

function documentProblems(html) {
  const p = [];
  const { root, doctype } = H.parse(html);
  if (!doctype) p.push('kein <!doctype html>');
  const htmlEl = H.byTag(root, 'html');
  if (htmlEl.length !== 1) p.push('nicht genau ein <html>');
  else if (htmlEl[0].attrs.get('lang') !== 'de') p.push('html lang ist nicht "de"');
  const heads = H.byTag(root, 'head'), bodies = H.byTag(root, 'body');
  if (heads.length !== 1) p.push('nicht genau ein <head>');
  if (bodies.length !== 1) p.push('nicht genau ein <body>');
  if (htmlEl[0] && htmlEl[0].children.filter(c => c.tag).map(c => c.tag).join(',') !== 'head,body') p.push('<html> enthält nicht genau head,body');
  const head = heads[0];
  const first = head && head.children.find(c => c.tag);
  if (!first || first.tag !== 'meta' || (first.attrs.get('charset') || '').toLowerCase() !== 'utf-8') p.push('meta charset=utf-8 nicht als erstes Element im head');
  const metas = H.byTag(head || root, 'meta');
  const named = n => metas.find(m => m.attrs.get('name') === n)?.attrs.get('content');
  const vp = named('viewport') || '';
  if (!/width=device-width/.test(vp) || !/initial-scale=1/.test(vp)) p.push('viewport fehlt oder unvollständig');
  if ((named('robots') || '').replace(/\s/g, '') !== 'noindex,nofollow') p.push('robots ist nicht noindex,nofollow');
  if (!H.norm(H.textOf(H.byTag(head || root, 'title')[0] || { children: [] }))) p.push('title fehlt');
  if (!(named('description') || '').trim()) p.push('meta description fehlt');
  if (bodies[0] && H.find(bodies[0], e => ['meta', 'title', 'link'].includes(e.tag)).length) p.push('head-Elemente im body');
  const h1 = H.byTag(root, 'h1');
  if (h1.length !== 1) p.push(`${h1.length} statt genau einer h1`);
  for (const lm of ['header', 'nav', 'main', 'footer']) if (!H.byTag(root, lm).length) p.push(`Landmark <${lm}> fehlt`);
  return p;
}

const bodyEls = html => {
  const { root } = H.parse(html);
  const body = H.byTag(root, 'body')[0] || root;
  return H.elements(body).filter(e => e.tag !== 'script' && !H.closest(e.parent, x => x.tag === 'script'));
};
const ownText = el => H.norm(el.children.filter(c => c.text !== undefined).map(c => c.text).join(' '));
const heroTextAllowed = el =>
  H.hasClass(el, 'badge') || H.hasClass(el, 'lead') ||
  (el.tag === 'button' && el.attrs.get('type') === 'submit') ||
  (el.tag === 'span' && el.parent && H.hasClass(el.parent, 'facts'));

/* Vergleicht das Element-Skelett von vision.html und index.html.
   Erlaubt: Textänderungen außerhalb des Hero; href/aria-label außerhalb des Hero;
   im Hero nur Badge/Lead/Button/Facts-Text und das Entfernen von name="url". */
function structureProblems(visionHtml, indexHtml) {
  const p = [];
  const v = bodyEls(visionHtml), i = bodyEls(indexHtml);
  if (v.length !== i.length) p.push(`Elementanzahl ${i.length} statt ${v.length}`);
  const n = Math.min(v.length, i.length);
  for (let k = 0; k < n; k++) {
    const a = v[k], b = i[k];
    const where = `${a.tag}#${a.attrs.get('id') || ''}.${a.attrs.get('class') || ''} (Element ${k})`;
    if (a.tag !== b.tag) { p.push(`Tag ${b.tag} statt ${a.tag} bei ${where}`); break; }
    const inHero = !!H.closest(a, e => H.hasClass(e, 'hero'));
    const removable = a.attrs.get('id') === 'url' ? ['name'] : [];
    const want = [...a.attrs.keys()].filter(x => !removable.includes(x)).sort().join(' ');
    const have = [...b.attrs.keys()].sort().join(' ');
    if (want !== have) p.push(`Attribute [${have}] statt [${want}] bei ${where}`);
    for (const [name, val] of b.attrs) {
      if (a.attrs.get(name) === val) continue;
      if (!inHero && (name === 'href' || name === 'aria-label')) continue;
      p.push(`Attributwert ${name}="${val}" statt "${a.attrs.get(name)}" bei ${where}`);
    }
    if (inHero && !heroTextAllowed(a) && ownText(a) !== ownText(b)) p.push(`Hero-Text geändert bei ${where}: "${ownText(b)}"`);
  }
  const h1 = html => H.norm(H.textOf(H.byTag(H.parse(html).root, 'h1')[0] || { children: [] }));
  if (h1(indexHtml) !== h1(visionHtml)) p.push(`H1 "${h1(indexHtml)}" statt "${h1(visionHtml)}"`);
  return p;
}

function criteriaProblems(html) {
  const p = [];
  const { root } = H.parse(html);
  const seen = new Set();
  const sections = H.byTag(root, 'section').filter(s => AREAS.some(a => a[0] === s.attrs.get('id')));
  if (sections.map(s => s.attrs.get('id')).join() !== AREAS.map(a => a[0]).join()) p.push('Bereichsabschnitte fehlen oder falsche Reihenfolge');
  for (const [key, title, prefix, count] of AREAS) {
    const s = H.byId(root, key);
    if (!s) { p.push(`Bereich ${key} fehlt`); continue; }
    const h2 = H.norm(H.textOf(H.byTag(s, 'h2')[0] || { children: [] }));
    if (h2 !== title) p.push(`Bereichsname "${h2}" statt "${title}"`);
    const ids = H.byClass(s, 'spec-row').map(r => H.norm(H.textOf(H.byClass(r, 'count')[0] || { children: [] })));
    if (ids.length !== count) p.push(`${key}: ${ids.length} statt ${count} Kriterien`);
    ids.forEach((id, n) => {
      if (id !== `${prefix}-${String(n + 1).padStart(2, '0')}`) p.push(`${key}: ID "${id}" an Position ${n + 1}`);
      if (seen.has(id)) p.push(`doppelte ID ${id}`);
      seen.add(id);
    });
  }
  const total = H.byClass(root, 'spec-row').length;
  if (total !== 48) p.push(`${total} statt 48 Kriterienzeilen`);
  if (seen.size !== 48) p.push(`${seen.size} statt 48 eindeutige IDs`);
  return p;
}

const HARD = [
  /\d+(?:[.,]\d+)?\s?€/g, /pro Monat/i, /monatlich/i, /14 Tage/i, /kostenlos testen/i, /Testzeitraum/i,
  /\b112\b/, /30 Sekunden/i, /in Sekunden/i, /Ergebnis in/i,
  /Anmelden/i, /\bLogin\b/i, /Dashboard/i, /Team-Zug/i,
  /wöchentlich/i, /jede Woche/i, /\bKW\s?\d/i, /seit gestern/i, /neuen Fehlern/i, /Verlauf/i,
  /kiez-kaffee/i, /speisekarte/i,
  /DSGVO-konform/i, /Server in Deutschland/i, /Auftragsverarbeitung/i,
  /Festpreis/i, /Umsetzung anfragen/i, /Gespräch vereinbaren/i, /\bbehebt\b/i,
  /\bScore\b/i, /\bPro\b/, /\bCheck\b/, /\bAnalysieren\b/i, /\bDemo\b/,
  /vier\s+(priorisierte|Maßnahmen|Baustellen)/i, /Branche/i, /\d+\s+Prüf(ungen|punkte)/i,
  /spart\s+\d/i, /\b\d+\s*(Werktage?|Arbeitstage?|Tage?|Stunden?|Wochen?)\b/i,
  /gecrawlt/i, /wird gemessen/i,
  /erfolgreich/i, /vielen Dank/i, /(Anfrage|Auftrag|Bestellung)\s+(ist\s+)?(eingegangen|erhalten|bestätigt)/i,
];
const NEGATED_ONLY = [
  /\bAbo\b/i, /Monitoring/i, /Überwachung/i, /\bKonto\b/i, /Garantie|garantiert/i, /Beratung/i,
  /Zertifizierung|zertifiziert/i, /\bDSGVO\b/, /\bBFSG\b/, /\bWCAG\b/, /Rechtsgutachten|Rechtsberatung/i,
  /automatische[nrs]?\s+(Analyse|Scan|Prüfung)/i, /Sofort(analyse|scan|ergebnis)/i,
  /versendet|gesendet|übermittelt|gespeichert/i,
];
const NEGATION = /\b(kein|keine|keinen|keiner|keines|ohne|nicht|nein|weder)\b/i;

/* Alle für Nutzer, Screenreader oder Suchmaschinen sichtbaren Texte einer Seite. */
function claimSurfaces(html) {
  const { root } = H.parse(html);
  const body = H.byTag(root, 'body')[0] || root;
  const out = [['sichtbarer Text', H.norm(H.visibleText(body))]];
  const title = H.byTag(root, 'title')[0];
  if (title) out.push(['title', H.norm(H.textOf(title))]);
  for (const m of H.byTag(root, 'meta')) if (m.attrs.get('name') === 'description') out.push(['meta description', m.attrs.get('content')]);
  for (const e of H.elements(root)) for (const a of ['aria-label', 'alt', 'title', 'placeholder']) if (e.attrs.has(a)) out.push([a, e.attrs.get(a)]);
  for (const s of H.byTag(root, 'script')) if (s.attrs.get('type') === 'application/ld+json') {
    const strings = [];
    JSON.stringify(JSON.parse(s.raw), (k, v) => { if (typeof v === 'string' && !k.startsWith('@')) strings.push(v); return v; });
    out.push(['JSON-LD', strings.join(' ')]);
  }
  return out;
}

function claimProblems(surfaces) {
  const p = [];
  for (const [where, text] of surfaces) {
    for (const re of HARD) {
      for (const m of text.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))) {
        if (re === HARD[0] && m[0].replace(/\s/g, '') === '0€') continue;
        p.push(`${where}: "${m[0]}" (…${text.slice(Math.max(0, m.index - 40), m.index + 40)}…)`);
      }
    }
    for (const re of NEGATED_ONLY) {
      for (const m of text.matchAll(new RegExp(re.source, re.flags + 'g'))) {
        const ctx = text.slice(Math.max(0, m.index - 80), m.index + m[0].length + 60);
        if (!NEGATION.test(ctx)) p.push(`${where}: "${m[0]}" ohne Verneinung (…${ctx}…)`);
      }
    }
  }
  return p;
}

const APP_FORBIDDEN = [
  /\bfetch\s*\(/, /XMLHttpRequest/, /sendBeacon/, /WebSocket/, /EventSource/,
  /localStorage/, /sessionStorage/, /indexedDB/, /document\.cookie/, /caches\./,
  /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, /\beval\s*\(|new Function/,
  /Math\.imul|\bhash\s*\(/, /strokeDashoffset|is-running|countUp|dataFor/,
  /result-score|result-ring|result-verdict|result-lcp|result-meta/,
  /\.submit\s*\(|requestSubmit|location\s*=|location\.(href|assign|replace)|history\.(push|replace)State/,
  /body\.hidden\s*=\s*false/,
];
const appProblems = src => APP_FORBIDDEN.filter(re => re.test(src)).map(re => `verbotenes Muster ${re}`)
  .concat(src.includes(`'${PREVIEW}'`) ? [] : ['exakter Vorschau-Hinweis fehlt']);

function formProblems(html) {
  const { root } = H.parse(html);
  const form = H.byId(root, 'analyze');
  if (!form) return ['Formular #analyze fehlt'];
  const p = [];
  for (const a of ['action', 'method', 'target']) if (form.attrs.has(a)) p.push(`Formular hat ${a}`);
  for (const e of H.elements(form)) if (e.attrs.has('name')) p.push(`benanntes Feld <${e.tag} name="${e.attrs.get('name')}"> würde ohne JavaScript übertragen`);
  return p;
}

const readAllowlist = () => read('tests/release-allowlist.txt').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
function releaseProblems(allowlist) {
  const p = [];
  for (const f of allowlist) {
    if (/^(vision\.html|DESIGN\.md|STRUCTURE\.md|\.gitignore)$/.test(f) || /^tests\//.test(f) || /\.md$/i.test(f)) p.push(`${f} darf nicht öffentlich ausgeliefert werden`);
    if (!existsSync(join(ROOT, f))) p.push(`${f} existiert nicht`);
  }
  for (const page of allowlist.filter(f => f.endsWith('.html'))) {
    const { root } = H.parse(read(page));
    for (const e of H.elements(root)) {
      const ref = e.tag === 'script' ? e.attrs.get('src') : (e.tag === 'link' || e.tag === 'a') ? e.attrs.get('href') : null;
      if (!ref || /^(https?:|mailto:|tel:|#)/.test(ref)) continue;
      const file = ref.split('#')[0];
      if (!allowlist.includes(file)) p.push(`${page} verweist auf ${file}, das nicht im Release-Artefakt ist`);
    }
  }
  return p;
}

function linkReport(page, html, pages) {
  const p = [], placeholders = [];
  const { root } = H.parse(html);
  for (const a of H.byTag(root, 'a')) {
    const href = a.attrs.get('href');
    const label = H.norm(H.textOf(a));
    if (href === undefined) { p.push(`<a> ohne href: "${label}"`); continue; }
    if (href === '#') { placeholders.push(label); continue; }
    if (/^https?:/.test(href)) { if (!EXTERNAL_OK.includes(href)) p.push(`unerwarteter externer Link ${href}`); continue; }
    const [file, frag] = href.split('#');
    const target = file || page;
    if (!pages[target]) { p.push(`Link "${label}" auf unbekannte Datei ${target}`); continue; }
    if (frag && !H.byId(H.parse(pages[target]).root, frag)) p.push(`Link "${label}" → ${href}: Ziel-ID fehlt`);
  }
  return { problems: p, placeholders };
}

/* ---------- T1 / T15: geschützte Dateien und Change-Scope ---------- */

test('T1 geschützte Dateien sind bytegleich zum Base-SHA', () => {
  for (const f of PROTECTED) {
    const now = readFileSync(join(ROOT, f));
    const then = git('show', `${BASE}:${f}`);
    assert.equal(sha256(now), sha256(then), `${f} weicht vom Base-SHA ab`);
  }
  execFileSync('git', ['diff', '--quiet', BASE, '--', ...PROTECTED], { cwd: ROOT });
});

test('T15 geänderte Dateien gehören nur zur Allowlist', t => {
  const changed = gitText('diff', '--name-only', BASE).split('\n').filter(Boolean);
  const untracked = gitText('ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean);
  const all = [...new Set([...changed, ...untracked])].sort();
  t.diagnostic(`geänderte Pfade gegen ${BASE.slice(0, 7)}: ${all.join(', ')}`);
  assert.deepEqual(scopeViolations(all), []);
  assert.deepEqual(scopeViolations(['vision.html', 'assets/styles.css', 'package.json']), ['vision.html', 'assets/styles.css', 'package.json'], 'Negativprobe: Scope-Prüfung muss Verstöße melden');
});

/* ---------- T3: Dokumentgerüst ---------- */

test('T3 index.html und pruefkriterien.html sind valide Dokumente mit genau einer H1 und noindex', () => {
  assert.deepEqual(documentProblems(read('index.html')), []);
  assert.deepEqual(documentProblems(read('pruefkriterien.html')), []);
});

test('T3 Negativprobe: Base-index.html wird als unvollständig erkannt', () => {
  const p = documentProblems(base('index.html'));
  assert.ok(p.includes('kein <!doctype html>') && p.includes('robots ist nicht noindex,nofollow'), p.join('; '));
});

/* ---------- T2 / T14: Hero, Design und Struktur gegen vision.html ---------- */

test('T2/T14 Element-Skelett, Attribute und Hero entsprechen vision.html', () => {
  assert.deepEqual(structureProblems(read('vision.html'), read('index.html')), []);
});

test('T2/T14 CSS-Quelle unverändert: assets/styles.css entspricht dem Inline-CSS von vision.html', () => {
  const inline = H.byTag(H.parse(read('vision.html')).root, 'style')[0].raw;
  const strip = s => s.split('\n').map(l => l.replace(/\s+$/, '')).join('\n').trim();
  assert.equal(strip(read('assets/styles.css')), strip(inline));
});

test('T2/T14 Hero-Texte, Grafikanzahlen und Auszugskennzeichnung', t => {
  const { root } = H.parse(read('index.html'));
  const hero = H.byClass(root, 'hero')[0];
  const txt = el => H.norm(H.textOf(el));
  assert.equal(txt(H.byTag(hero, 'h1')[0]), 'Sehen Sie, was Ihre Website ausbremst.');
  assert.equal(txt(H.byClass(hero, 'badge')[0]), 'Website-Analyse als PDF');
  assert.equal(txt(H.byTag(hero, 'button')[0]), 'Vorschau anzeigen');
  assert.deepEqual(H.byClass(hero, 'facts')[0].children.filter(c => c.tag).map(txt), ['Free bis 6 Seiten', 'Persönlich geprüft', 'PDF per E-Mail']);
  const lead = txt(H.byClass(hero, 'lead')[0]);
  assert.match(lead, /persönlich/); assert.match(lead, /PDF per E-Mail/); assert.match(lead, /Vorschau/); assert.match(lead, /nicht versendet/);
  const count = c => H.byClass(root, c).length;
  const counts = { bar: count('bar'), 'spec-row': count('spec-row'), ring: count('ring'), chart: count('chart'), plan: count('plan'), tool: count('tool'), step: count('step'), use: count('use'), details: H.byTag(root, 'details').length, section: H.byTag(root, 'section').length };
  t.diagnostic(`Grafik-/Komponentenanzahl: ${JSON.stringify(counts)}`);
  assert.deepEqual(counts, { bar: 5, 'spec-row': 5, ring: 2, chart: 1, plan: 3, tool: 6, step: 6, use: 3, details: 6, section: 12 });
  const vSections = H.byTag(H.parse(read('vision.html')).root, 'section').map(s => s.attrs.get('id') || s.attrs.get('class'));
  assert.deepEqual(H.byTag(root, 'section').map(s => s.attrs.get('id') || s.attrs.get('class')), vSections, 'Abschnittsreihenfolge');
  assert.match(txt(H.byId(root, 'pruefungen')), /fünf der sechs Analysebereiche als Auszug/);
  assert.match(txt(H.byId(root, 'report')), /Auszug: 5 von 6 Bereichen/);
});

test('T2/T14 Negativproben: sechster Balken, Hero-Klasse, H1 und Hero-Attribut werden erkannt', () => {
  const vision = read('vision.html'), index = read('index.html');
  const bar = '<div class="bar"><span>Barrierefreiheit</span><span class="bar-track"><i style="width:61%"></i></span><b class="num">61</b><span class="sev sev--warn"></span></div>';
  assert.ok(index.includes(bar));
  const mutations = {
    'sechster Balken': index.replace(bar, bar + bar),
    'Hero-Klasse': index.replace('class="url-field"', 'class="url-field neu"'),
    'H1-Text': index.replace('<em>ausbremst</em>', '<em>bremst</em>'),
    'Hero-Attribut': index.replace('placeholder="ihre-website.de"', 'placeholder="musterfirma.example"'),
    'Hero-Fehlertext': index.replace('Bitte geben Sie eine Adresse wie beispiel.de ein.', 'Ungültig.'),
    'Grafikgeometrie': index.replace('stroke-dashoffset="113.1"', 'stroke-dashoffset="50"'),
  };
  for (const [name, html] of Object.entries(mutations)) {
    assert.notEqual(html, index, name);
    assert.ok(structureProblems(vision, html).length > 0, `Mutation "${name}" wurde nicht erkannt`);
  }
});

/* ---------- T4 / T5 / T6 (statischer Anteil): Formular und app.js ---------- */

test('T5 Formular überträgt ohne JavaScript keine Felder (kein name, kein action/method)', () => {
  assert.deepEqual(formProblems(read('index.html')), []);
  assert.ok(formProblems(base('index.html')).some(x => x.includes('name="url"')), 'Negativprobe: Base-Formular mit name="url" muss erkannt werden');
});

test('T5/T6 app.js enthält keine Übertragung, Speicherung, Score-Berechnung oder Scan-Simulation', () => {
  assert.deepEqual(appProblems(read('assets/app.js')), []);
  const baseProblems = appProblems(base('assets/app.js'));
  assert.ok(baseProblems.length >= 3, `Negativprobe: Base-app.js muss als Scan-Simulation erkannt werden (${baseProblems.join('; ')})`);
});

/* ---------- T7: Methodikseite ---------- */

test('T7 Methodikseite: sechs Bereiche, 48 eindeutige IDs, Verteilung 10/9/8/6/8/7', t => {
  const html = read('pruefkriterien.html');
  assert.deepEqual(criteriaProblems(html), []);
  const { root } = H.parse(html);
  t.diagnostic(AREAS.map(([key, , prefix]) => `${prefix}=${H.byClass(H.byId(root, key), 'spec-row').length}`).join(' '));
});

test('T7 Methodikseite: Coverage-Hinweis, keine Zertifizierung, nur vorhandene Styles', () => {
  const html = read('pruefkriterien.html');
  const { root } = H.parse(html);
  const text = H.norm(H.visibleText(root));
  assert.match(text, /nicht was bei jeder Website geprüft wird/);
  assert.match(text, /je Auftrag unterschiedlich/);
  assert.match(text, /Kein Rechtsgutachten und keine Zertifizierung/);
  assert.equal(H.byTag(root, 'style').length, 0, 'kein eigenes <style>');
  const styled = H.find(root, e => e.attrs.has('style')).map(e => e.attrs.get('style'));
  assert.deepEqual(styled, ['position:absolute'], 'nur das Icon-Sprite trägt (wie in index.html) ein style-Attribut');
  const sheets = H.byTag(root, 'link').filter(l => l.attrs.get('rel') === 'stylesheet').map(l => l.attrs.get('href'));
  assert.deepEqual(sheets, ['https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap', 'assets/styles.css']);
  assert.deepEqual(H.byTag(root, 'script').map(s => s.attrs.get('src')), ['assets/app.js']);
  const used = new Set(H.elements(H.byTag(root, 'body')[0]).flatMap(e => (e.attrs.get('class') || '').split(/\s+/).filter(Boolean)));
  const css = read('assets/styles.css');
  const unknown = [...used].filter(c => !new RegExp(`\\.${c.replace(/-/g, '\\-')}(?![\\w-])`).test(css));
  assert.deepEqual(unknown, [], 'nur Klassen aus assets/styles.css');
});

test('T7 Negativproben: fehlendes, doppeltes oder falsch zugeordnetes Kriterium wird erkannt', () => {
  const html = read('pruefkriterien.html');
  assert.ok(criteriaProblems(html.replace('<span class="count">FIND-10</span>', '<span class="count">FIND-09</span>')).length > 0, 'doppelte ID');
  const withoutAi07 = html.split('\n').filter(l => !l.includes('>AI-07<')).join('\n');
  assert.notEqual(withoutAi07, html);
  assert.ok(criteriaProblems(withoutAi07).length > 0, 'fehlendes Kriterium');
  assert.ok(criteriaProblems(html.replace('<span class="count">UX-08</span>', '<span class="count">A11Y-07</span>')).length > 0, 'falsche Zuordnung');
  assert.ok(criteriaProblems(html.replace('<h2 class="h2">KI-Verständlichkeit</h2>', '<h2 class="h2">KI-Sichtbarkeit</h2>')).length > 0, 'falscher Bereichsname');
});

test('T7 Kriterien stimmen mit der Referenz-ZIP überein (falls lokal verfügbar)', t => {
  if (!existsSync(REFERENCE_ZIP)) { t.skip(`NOT_RUN: Referenz-ZIP nicht gefunden (${REFERENCE_ZIP})`); return; }
  const ref = execFileSync('unzip', ['-p', REFERENCE_ZIP, 'pxwa_small_build/pruefkriterien.html']).toString('utf8');
  const refRows = [...ref.matchAll(/<h3>([A-Z0-9]+-\d\d)<\/h3><span class="count">(.*?)<\/span><\/div><p>(.*?)<\/p>/g)].map(m => [m[1], H.decode(m[2]), H.decode(m[3])]);
  const { root } = H.parse(read('pruefkriterien.html'));
  const ours = H.byClass(root, 'spec-row').map(r => [H.norm(H.textOf(H.byClass(r, 'count')[0])), H.norm(H.textOf(H.byTag(r, 'h3')[0])), H.norm(H.textOf(H.byTag(r, 'p')[0]))]);
  assert.equal(refRows.length, 48);
  assert.deepEqual(ours, refRows);
});

/* ---------- T8: Navigation ---------- */

test('T8 interne Links und Anker sind gültig; offene Rechtslinks sind als Release-Blocker gelistet', t => {
  const pages = { 'index.html': read('index.html'), 'pruefkriterien.html': read('pruefkriterien.html') };
  for (const [page, html] of Object.entries(pages)) {
    const { problems, placeholders } = linkReport(page, html, pages);
    assert.deepEqual(problems, [], page);
    assert.deepEqual([...placeholders].sort(), [...KNOWN_PLACEHOLDERS].sort(), `${page}: nur bekannte Platzhalter`);
    t.diagnostic(`${page}: RELEASE-BLOCKER Platzhalter-Links ohne Ziel: ${placeholders.join(', ')}`);
  }
  for (const html of Object.values(pages)) assert.ok(!/vision\.html|DESIGN\.md|STRUCTURE\.md/.test(html), 'kein Link auf historische Dateien');
});

test('T8 Negativprobe: Base-index.html hat zusätzliche tote Platzhalter', () => {
  const { placeholders } = linkReport('index.html', base('index.html'), { 'index.html': base('index.html') });
  assert.ok(placeholders.length > KNOWN_PLACEHOLDERS.length, placeholders.join(', '));
});

/* ---------- T12: wahrheitsgemäße Inhalte ---------- */

test('T12 keine Abo-, Preis-, Scan-, Monitoring- oder Garantie-Aussagen in Text, Metadaten, ARIA und JSON-LD', t => {
  for (const page of ['index.html', 'pruefkriterien.html']) assert.deepEqual(claimProblems(claimSurfaces(read(page))), [], page);
  const literals = [...read('assets/app.js').matchAll(/'((?:[^'\\]|\\.)*)'/g)].map(m => m[1]).join(' ');
  assert.deepEqual(claimProblems([['app.js-Texte', literals]]), []);
  const hidden = H.hiddenTrees(H.parse(read('index.html')).root);
  assert.deepEqual(hidden.map(e => e.attrs.get('id')), ['url-error', 'result', 'result-body'], 'versteckte Inhalte nur in Fehlermeldung und Ergebnisbereich');
  t.diagnostic(`Restbefund (nie angezeigt, hidden, Hero-geschützt): ${H.norm(H.textOf(H.byId(H.parse(read('index.html')).root, 'result-body')))}`);
});

test('T12 Negativprobe: Base-index.html und Base-app.js werden als unwahr erkannt', () => {
  const found = claimProblems(claimSurfaces(base('index.html'))).join('\n');
  for (const s of ['29 €', '14 Tage', 'Anmelden', 'KW 30', 'Score', 'DSGVO-konform', 'Festpreis']) assert.ok(found.includes(s), `nicht erkannt: ${s}`);
  const baseLiterals = [...base('assets/app.js').matchAll(/'((?:[^'\\]|\\.)*)'/g)].map(m => m[1]).join(' ');
  assert.ok(claimProblems([['app.js', baseLiterals]]).length > 0, 'Crawl-Phasen der Base-app.js nicht erkannt');
});

test('T12 JSON-LD entspricht den sichtbaren FAQ und enthält kein Angebot/Preis', () => {
  const { root } = H.parse(read('index.html'));
  const ld = JSON.parse(H.byTag(root, 'script').find(s => s.attrs.get('type') === 'application/ld+json').raw);
  assert.equal(ld['@type'], 'FAQPage');
  const visible = H.byTag(root, 'details').map(d => [H.norm(H.textOf(H.byTag(d, 'summary')[0])), H.norm(H.textOf(H.byTag(d, 'p')[0]))]);
  assert.deepEqual(ld.mainEntity.map(q => [q.name, q.acceptedAnswer.text]), visible);
  const raw = JSON.stringify(ld);
  assert.ok(!/offers|price|Offer|WebApplication/.test(raw));
  assert.ok(/offers|price/.test(H.byTag(H.parse(base('index.html')).root, 'script').find(s => s.attrs.get('type') === 'application/ld+json').raw), 'Negativprobe: Base-JSON-LD mit Angebot');
});

/* ---------- T13: Release-Schutz ---------- */

test('T13 Release-Allowlist schließt historische Dateien aus und deckt alle verlinkten Ressourcen ab', t => {
  const allow = readAllowlist();
  t.diagnostic(`öffentliches Artefakt (Allowlist): ${allow.join(', ')}`);
  assert.deepEqual(releaseProblems(allow), []);
  assert.ok(!allow.includes('vision.html'));
  const repoFiles = gitText('ls-files').split('\n').filter(Boolean).concat(gitText('ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean));
  const excluded = repoFiles.filter(f => !allow.includes(f));
  for (const f of ['vision.html', 'DESIGN.md', 'STRUCTURE.md']) assert.ok(excluded.includes(f), `${f} muss ausgeschlossen sein`);
  t.diagnostic('NOT_RUN: echter HTTP-404/410-Test für /vision.html erst nach Hosting-Entscheidung (D-10/RG1)');
});

test('T13 Negativprobe: vision.html oder fehlende Ressource im Artefakt wird erkannt', () => {
  const allow = readAllowlist();
  assert.ok(releaseProblems([...allow, 'vision.html']).some(x => x.startsWith('vision.html')));
  assert.ok(releaseProblems(allow.filter(f => f !== 'assets/app.js')).some(x => x.includes('assets/app.js')));
});
