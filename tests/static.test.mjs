/* PXWA – statische Prüfungen (Node ≥ 22). Ausführen im Repo-Root: node --test tests/static.test.mjs
   Prüft Inhalte (kostenloses Angebot, vier Bereiche, sieben PDF-Seiten, GEO & AI Visibility), Methodik, Links,
   unveränderte Design-Quelle, Release-Grenzen (Cloudflare-Pages-Artefakt, Pages Function, Worker), Secrets und den Scope des API-Workers. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join, relative } from 'node:path';
import * as H from './lib/html.mjs';
import { ROOT, artifactFiles, uploadFiles, MIGRATIONS } from './lib/harness.mjs';

const read = p => readFileSync(join(ROOT, p), 'utf8');
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' });
const PAGES = ['public/index.html', 'public/pruefkriterien.html', 'public/impressum.html', 'public/datenschutz.html', 'public/agb.html', 'public/404.html'];
/* Stand vor PXWA-BE-02 (Hero ohne AGB-Häkchen): Referenz für den Hero-Schutz */
const BASE_SHA = '13ac821f94c754a94c330b5686f5bf12f4a0282d';
const FUNCTION = 'functions/api/[[path]].ts';
const MEDIA_FUNCTION = 'functions/media/[file].ts';
const MEDIA = ['media/360-pixelkiez-video-1080p.mp4', 'media/360-pixelkiez-video-poster.jpg', 'media/report-pdf-de-1x1.mp4', 'media/report-pdf-poster.jpg'];
const VIEW = 'worker/src/view.ts';
const WORKER_SRC = readdirSync(join(ROOT, 'worker/src')).filter(f => f.endsWith('.ts')).map(f => 'worker/src/' + f);
/* Alle Dateien, die committet würden (versioniert oder neu, nicht ignoriert) */
const repoFiles = () => git('ls-files', '--cached', '--others', '--exclude-standard').split('\n').filter(f => f && existsSync(join(ROOT, f)));
/* Text der serverseitig gerenderten Seiten: String- und Template-Literale aus view.ts ohne Platzhalter und Tags */
const viewText = () => [...read(VIEW).matchAll(/'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)].map(m => (m[1] ?? m[2]).replace(/\$\{[^}]*\}/g, ' ').replace(/<[^>]+>/g, ' ')).join(' ');
const REFERENCE_ZIP = process.env.PXK_REFERENCE_ZIP || join(ROOT, '..', 'pxwa-quellen-klein.zip');

const AREAS = ['SEO & Auffindbarkeit', 'Performance & Technik', 'GEO & AI Visibility', 'UX, Barrierefreiheit & Vertrauen'];
const METHOD = [
  ['findability_seo', 'SEO & Auffindbarkeit', [['FIND', 10]]],
  ['performance_technology', 'Performance & Technik', [['PERF', 9]]],
  ['geo_ai_visibility', 'GEO & AI Visibility', [['AI', 8]]],
  ['ux_accessibility_trust', 'UX, Barrierefreiheit & Vertrauen', [['UX', 8], ['A11Y', 6], ['TRUST', 8]]],
];
/* 360°Pixelkiez ist eine eigenständige Website: keine Links zu pixelkiez.de, nur die Kontaktadresse 360@pixelkiez.de */
const EXTERNAL_OK = ['mailto:360@pixelkiez.de'];

/* Alles, was Nutzer, Screenreader oder Suchmaschinen lesen: sichtbarer und verborgener Text, Metadaten, ARIA, JSON-LD */
const allText = n => n.text !== undefined ? n.text : ['script', 'style', 'symbol'].includes(n.tag) ? ' ' : ` ${n.children.map(allText).join(' ')} `;
function surfaces(html) {
  const { root } = H.parse(html);
  const out = [['Text', H.norm(allText(H.byTag(root, 'body')[0]))], ['title', H.norm(H.textOf(H.byTag(root, 'title')[0]))]];
  for (const e of H.elements(root)) {
    if (e.tag === 'meta' && e.attrs.get('name') === 'description') out.push(['meta description', e.attrs.get('content')]);
    for (const a of ['aria-label', 'alt', 'title', 'placeholder']) if (e.attrs.has(a)) out.push([a, e.attrs.get(a)]);
    if (e.tag === 'script' && e.attrs.get('type') === 'application/ld+json') {
      const s = [];
      JSON.stringify(JSON.parse(e.raw), (k, v) => { if (typeof v === 'string' && !k.startsWith('@')) s.push(v); return v; });
      out.push(['JSON-LD', s.join(' ')]);
    }
  }
  return out;
}
/* Nicht mehr zum Produkt gehörende oder unzulässige Aussagen */
const FORBIDDEN = [/Premium/i, /Checkout/i, /Warenkorb/i, /\bPro\b/, /Dashboard/i, /\bScore\b/i, /\d+(?:[.,]\d+)?\s?€/g, /pro Monat|monatlich/i,
  /DSGVO-konform|datenschutzkonform|rechtssicher/i, /Server in Deutschland/i, /Vorschau/i, /Testzeitraum|kostenlos testen/i,
  /\b\d+\s*(Werktage?|Arbeitstage?|Tage?|Stunden?|Wochen?)\b/i, /Platz\s*1|Top-?Ranking/i];
const NEGATED_ONLY = [/\bAbo\b/i, /Garantie|garantiert/i, /Monitoring|Überwachung/i, /Beratung/i, /Zertifizierung/i, /Rechtsgutachten|Rechtsberatung/i,
  /Sofort(analyse|scan|ergebnis)/i, /automatische[nrs]?\s+(Scan|Analyse|Bericht)/i, /Punktzahl/i, /Zugriff auf Ihr Postfach/i, /\bDSGVO\b/, /\bWCAG\b/];
const NEGATION = /\b(kein|keine|keinen|keiner|keines|ohne|nicht|nein|weder)\b/i;
function claimProblems(list) {
  const p = [];
  for (const [where, text] of list) {
    for (const re of FORBIDDEN) for (const m of text.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))) {
      if (m[0].replace(/\s/g, '') === '0€') continue;
      p.push(`${where}: "${m[0]}" (…${text.slice(Math.max(0, m.index - 40), m.index + 40)}…)`);
    }
    for (const re of NEGATED_ONLY) for (const m of text.matchAll(new RegExp(re.source, re.flags + 'g'))) {
      const ctx = text.slice(Math.max(0, m.index - 80), m.index + m[0].length + 40);
      if (!NEGATION.test(ctx)) p.push(`${where}: "${m[0]}" ohne Verneinung (…${ctx}…)`);
    }
  }
  return p;
}

test('Dokumente: valides Gerüst, genau eine H1, Landmarks, CSP, keine Inline-Styles oder Inline-Skripte', () => {
  for (const page of PAGES) {
    const html = read(page);
    const { root, doctype } = H.parse(html);
    assert.ok(doctype, `${page}: doctype`);
    assert.equal(H.byTag(root, 'html')[0].attrs.get('lang'), 'de');
    const head = H.byTag(root, 'head')[0];
    assert.equal(head.children.find(c => c.tag).attrs.get('charset'), 'utf-8', `${page}: charset zuerst`);
    assert.equal(H.byTag(root, 'h1').length, 1, `${page}: eine H1`);
    for (const lm of ['header', 'nav', 'main', 'footer']) assert.ok(H.byTag(root, lm).length, `${page}: <${lm}>`);
    const csp = H.byTag(head, 'meta').find(m => m.attrs.get('http-equiv') === 'Content-Security-Policy')?.attrs.get('content') || '';
    assert.match(csp, /script-src 'self'/); assert.match(csp, /form-action 'self' https:\/\/accounts\.google\.com/); assert.match(csp, /object-src 'none'/);
    assert.deepEqual(H.find(root, e => e.attrs.has('style')).map(e => e.tag), [], `${page}: keine style-Attribute (CSP)`);
    assert.deepEqual(H.byTag(root, 'script').filter(s => !s.attrs.has('src') && s.attrs.get('type') !== 'application/ld+json').length, 0, `${page}: keine Inline-Skripte`);
    assert.ok(H.find(root, e => [...e.attrs.keys()].some(a => a.startsWith('on'))).length === 0, `${page}: keine Inline-Event-Handler`);
  }
});

test('Startseite: kostenloses Angebot, vier Bereiche, sieben PDF-Seiten, GEO & AI Visibility, Google-Anmeldung', () => {
  const { root } = H.parse(read('public/index.html'));
  const txt = el => H.norm(H.textOf(el));
  const text = H.norm(H.visibleText(root));
  assert.deepEqual(H.byClass(H.byId(root, 'bereiche'), 'spec-row').map(r => txt(H.byTag(r, 'h3')[0])), AREAS);
  /* Videos: unter dem Hero und rechts neben dem Text bei „Ihr Bericht“; stumm, Schleife, ohne Bedienelemente */
  const videos = H.byTag(root, 'video');
  assert.deepEqual(videos.map(v => H.byTag(v, 'source')[0].attrs.get('src')), ['media/360-pixelkiez-video-1080p.mp4', 'media/report-pdf-de-1x1.mp4']);
  for (const v of videos) assert.ok(['muted', 'loop', 'playsinline', 'poster', 'aria-label'].every(a => v.attrs.has(a)) && !v.attrs.has('controls') && !v.attrs.has('autoplay'));
  assert.ok(H.byTag(H.byId(root, 'bericht'), 'video').length === 1, 'Berichtsvideo im Abschnitt „Ihr Bericht“');
  for (const s of ['GEO', 'AI Visibility', 'Generative Engine Optimization', '0 €', 'mit Google an', 'sieben Seiten', 'Core Web Vitals', 'beobachtet']) assert.ok(text.includes(s), `fehlt: ${s}`);
  assert.equal(H.byClass(root, 'plan').length, 3);
  assert.equal(H.byClass(root, 'plan--featured').length, 1);
  assert.match(txt(H.byClass(root, 'plan--featured')[0]), /0 €/);
  const form = H.byId(root, 'analyze');
  assert.equal(form.attrs.get('action'), '/api/anfrage', 'Formular geht an den API-Worker (Cloudflare-Route /api/*)'); assert.equal(form.attrs.get('method'), 'post');
  assert.deepEqual(H.find(form, e => e.attrs.has('name')).map(e => e.attrs.get('name')), ['action', 'agb_version', 'website', 'agb'], 'nur Website, AGB-Häkchen und angezeigte AGB-Version – per POST, nie in einer GET-URL');
});

test('Hero (PXWA-BE-02): AGB-Pflichthäkchen nicht vorausgewählt, AGB- und Datenschutz-Link, Button „Analysieren“, Hinweis „0 €, kein Abo“', () => {
  const { root } = H.parse(read('public/index.html'));
  const txt = el => H.norm(H.textOf(el));
  const form = H.byId(root, 'analyze');
  const box = H.byId(form, 'agb');
  assert.deepEqual([box.tag, box.attrs.get('type'), box.attrs.get('name'), box.attrs.get('value')], ['input', 'checkbox', 'agb', '1']);
  assert.ok(box.attrs.has('required') && !box.attrs.has('checked'), 'Pflicht und nicht vorausgewählt');
  const label = H.find(form, e => e.tag === 'label' && H.find(e, x => x === box).length)[0];
  assert.ok(label, 'Häkchen steht in seinem Label (ganzer Text klickbar)');
  assert.equal(txt(label), 'Ich akzeptiere die AGB von 360°Pixelkiez.');
  assert.deepEqual(H.byTag(label, 'a').map(a => [a.attrs.get('href'), txt(a)]), [['agb.html', 'AGB']]);
  assert.deepEqual(H.byTag(form, 'a').map(a => a.attrs.get('href')), ['agb.html', 'datenschutz.html'], 'AGB- und separater Datenschutz-Link');
  assert.equal(txt(H.find(form, e => e.tag === 'button')[0]), 'Analysieren');
  assert.equal(txt(H.byClass(form, 'hero-note')[0]), 'Kostenlose Website-Analyse – 0 €, kein Abo. Datenschutzerklärung');
  for (const id of ['url-error', 'agb-error']) assert.ok(H.byId(form, id).attrs.has('hidden'), `${id} zunächst verborgen`);
  assert.equal(txt(H.byTag(H.byClass(root, 'hero')[0], 'h1')[0]), 'Sehen Sie, was Ihre Website ausbremst.', 'Original-H1');
});

test('Hero-Schutz: gegenüber dem Stand vor BE-02 nur die freigegebenen Zeilen neu, Reihenfolge erhalten; außerhalb des Hero nur der Text von Schritt 02 und die Kontaktadresse', () => {
  const now = read('public/index.html');
  const old = git('show', `${BASE_SHA}:public/index.html`);
  const hero = html => { const i = html.indexOf('<section class="hero">'); return html.slice(i, html.indexOf('</section>', i) + '</section>'.length); };
  const lines = html => hero(html).split('\n').map(l => l.trim());
  const [a, b] = [lines(old), lines(now)];
  assert.deepEqual(a.filter(l => !b.includes(l)), ['<button class="btn btn--accent" type="submit">Kostenlos anfragen <svg class="i"><use href="#i-arrow"/></svg></button>'], 'entfernt nur der alte Buttontext');
  assert.deepEqual(b.filter(l => !a.includes(l)), [
    '<input type="hidden" name="agb_version" value="ENTWURF-2026-10-31">',
    '<button class="btn btn--accent" type="submit">Analysieren <svg class="i"><use href="#i-arrow"/></svg></button>',
    '<label class="consent consent--hero"><input id="agb" type="checkbox" name="agb" value="1" required><span>Ich akzeptiere die <a href="agb.html">AGB</a> von 360°Pixelkiez.</span></label>',
    '<p class="form-error" id="agb-error" hidden>Bitte akzeptieren Sie die AGB, damit wir Ihre Website analysieren können.</p>',
    '<p class="hero-note">Kostenlose Website-Analyse – 0 €, kein Abo. <a href="datenschutz.html">Datenschutzerklärung</a></p>',
  ], 'neu nur Häkchen, Fehlertext, Hinweis, Version und Buttontext');
  const kept = a.filter(l => b.includes(l));
  assert.deepEqual(b.filter(l => kept.includes(l)), kept, 'Badge, H1, Lead, URL-Feld und Faktenzeile in unveränderter Reihenfolge');
  const outside = html => html.replace(hero(html), '').replace(/<div class="step cw-lilac"><span>02<\/span>.*?<\/div>/, '<SCHRITT-02>');
  /* Kontaktadresse im Footer: 360@pixelkiez.de ersetzt die frühere Adresse (PO-Entscheidung 01.11.2026), sonst nichts */
  assert.equal(outside(now), outside(old).replaceAll('kontakt@pixelkiez.de', '360@pixelkiez.de'), 'übrige Startseite unverändert (außer Schritt 02, der den zweiten Bestätigungsklick beschrieb, und der Kontaktadresse)');
  assert.match(now, /<span>02<\/span><h3>AGB akzeptieren und anmelden<\/h3>/);
});

test('AGB-Seite: eindeutig als Entwurf gekennzeichnet, keine erfundenen Vertragsklauseln; Version gleich Hero-Feld und TERMS_VERSION', () => {
  const { root } = H.parse(read('public/agb.html'));
  const main = H.norm(H.textOf(H.byTag(root, 'main')[0]));
  for (const s of ['ENTWURF – nicht rechtlich freigegeben', 'in Vorbereitung', 'keine Vertragsbedingungen', 'Bis dahin nimmt diese Website keine Aufträge an']) assert.ok(main.includes(s), `AGB-Seite: „${s}“`);
  assert.ok(!/§|Haftung|Gewährleistung|Gerichtsstand|Widerruf|Vertragsschluss|Kündigung|Leistungsumfang|Vergütung/i.test(main), 'keine Vertragsklauseln');
  assert.deepEqual(H.byClass(root, 'legal-h').map(e => H.norm(H.textOf(e))), ['Version', 'Fragen']);
  const version = H.norm(H.textOf(H.byId(root, 'agb-version')));
  const hero = H.find(H.byId(H.parse(read('public/index.html')).root, 'analyze'), e => e.attrs.get('name') === 'agb_version')[0].attrs.get('value');
  const toml = /^TERMS_VERSION = "([^"]+)"$/m.exec(read('worker/wrangler.toml'))[1];
  assert.deepEqual([hero, toml], [version, version], 'eine AGB-Version in Hero, AGB-Seite und Worker-Konfiguration');
  assert.match(version, /^ENTWURF-/, 'ohne freigegebene Fassung bleibt die Produktion gesperrt (config.ts lehnt ENTWURF ab)');
  assert.ok(read('worker/src/config.ts').includes("(production && /^entwurf/i.test(termsVersion))) missing.push('TERMS_VERSION');"), 'Produktion lehnt AGB-Entwürfe ab');
});

test('Wahrheitsgemäße Aussagen: kein Premium/Checkout/Abo/Dashboard/Score, keine Garantien, keine DSGVO-Behauptung, keine Vorschau-Reste', () => {
  for (const page of PAGES) assert.deepEqual(claimProblems(surfaces(read(page))), [], page);
  assert.deepEqual(claimProblems([['view.ts', viewText()]]), []);
  for (const s of ['Kostenlose Website-Analyse – 0 €, kein Abo', 'PDF mit sieben Seiten', 'keinen Zugriff auf Ihr Postfach', 'nicht automatisch abgerufen oder gescannt', 'Version und Zeitpunkt Ihrer Zustimmung zu den AGB', 'Analysieren']) {
    assert.ok(viewText().includes(s), `view.ts enthält "${s}"`);
  }
  /* Negativprobe: der alte Stand mit Free/Premium wird erkannt */
  const old = git('show', '98d21094619a53c28f56609ecbef13f94859ae58:index.html');
  const found = claimProblems(surfaces(old)).join('\n');
  for (const s of ['Premium', 'Vorschau']) assert.ok(found.includes(s), `Negativprobe: ${s} nicht erkannt`);
});

test('JSON-LD entspricht den sichtbaren FAQ, ohne Angebot oder Preis-Markup', () => {
  const { root } = H.parse(read('public/index.html'));
  const ld = JSON.parse(H.byTag(root, 'script').find(s => s.attrs.get('type') === 'application/ld+json').raw);
  const visible = H.byTag(root, 'details').map(d => [H.norm(H.textOf(H.byTag(d, 'summary')[0])), H.norm(H.textOf(H.byTag(d, 'p')[0]))]);
  assert.deepEqual(ld.mainEntity.map(q => [q.name, q.acceptedAnswer.text]), visible);
  assert.ok(!/offers|price|Offer/.test(JSON.stringify(ld)));
});

test('Methodik: vier Bereiche in Reihenfolge, eindeutige IDs, 48 Original-Prüfpunkte unverändert plus AI-08', t => {
  const { root } = H.parse(read('public/pruefkriterien.html'));
  const txt = el => H.norm(H.textOf(el));
  const sections = H.byTag(root, 'section').filter(s => METHOD.some(m => m[0] === s.attrs.get('id')));
  assert.deepEqual(sections.map(s => s.attrs.get('id')), METHOD.map(m => m[0]));
  const seen = [];
  for (const [id, title, groups] of METHOD) {
    const s = H.byId(root, id);
    assert.equal(txt(H.byTag(s, 'h2')[0]), title);
    const want = groups.flatMap(([prefix, n]) => Array.from({ length: n }, (_, i) => `${prefix}-${String(i + 1).padStart(2, '0')}`));
    const ids = H.byClass(s, 'spec-row').map(r => txt(H.byClass(r, 'count')[0]));
    assert.deepEqual(ids, want, id);
    seen.push(...ids);
  }
  assert.equal(new Set(seen).size, 49);
  const rows = Object.fromEntries(H.byClass(root, 'spec-row').map(r => [txt(H.byClass(r, 'count')[0]), [txt(H.byTag(r, 'h3')[0]), txt(H.byTag(r, 'p')[0])]]));
  assert.match(rows['AI-08'][1], /tatsächlich beobachtete/);
  if (!existsSync(REFERENCE_ZIP)) { t.diagnostic(`NOT_RUN: Referenz-ZIP fehlt (${REFERENCE_ZIP})`); return; }
  const ref = execFileSync('unzip', ['-p', REFERENCE_ZIP, 'pxwa_small_build/pruefkriterien.html']).toString('utf8');
  const refRows = [...ref.matchAll(/<h3>([A-Z0-9]+-\d\d)<\/h3><span class="count">(.*?)<\/span><\/div><p>(.*?)<\/p>/g)];
  assert.equal(refRows.length, 48);
  for (const [, id, name, desc] of refRows) assert.deepEqual(rows[id], [H.decode(name), H.decode(desc)], id);
});

test('Links: interne Anker gültig, keine Links zu pixelkiez.de, nur mailto als externes Ziel', () => {
  const pages = Object.fromEntries(PAGES.map(p => [p.slice(7), read(p)]));
  for (const [page, html] of Object.entries(pages)) {
    for (const a of H.byTag(H.parse(html).root, 'a')) {
      const href = a.attrs.get('href');
      assert.ok(href && href !== '#', `${page}: Link ohne Ziel "${H.norm(H.textOf(a))}"`);
      if (/^(https?:|mailto:)/.test(href)) { assert.ok(EXTERNAL_OK.includes(href), `${page}: externer Link ${href}`); continue; }
      /* Nur 404.html verlinkt absolut (/…), weil Pages sie für Adressen in beliebiger Tiefe ausliefert */
      assert.ok(page === '404.html' ? href.startsWith('/') : !href.startsWith('/'), `${page}: ${href}`);
      const [file, frag] = href.replace(/^\//, '').split('#');
      const target = file || page;
      assert.ok(pages[target], `${page}: unbekannte Datei ${target}`);
      if (frag) assert.ok(H.byId(H.parse(pages[target]).root, frag), `${page}: Anker ${href} fehlt`);
    }
  }
  /* Auch serverseitig gerenderte Seiten und Konfigurationsvorlagen verweisen nicht auf die Webdesign-Website */
  for (const f of [...PAGES, VIEW, 'worker/wrangler.toml', 'worker/.dev.vars.example', 'wrangler.toml', 'public/_headers', FUNCTION]) {
    assert.ok(!/https?:\/\/(www\.)?pixelkiez\.de/i.test(read(f)), `${f}: kein Link zu pixelkiez.de`);
    assert.ok(!/Webdesign/i.test(read(f)), `${f}: kein Bezug auf Webdesign`);
  }
});

test('Eigenständige Website 360°Pixelkiez: Name in Titel, Logo und Footer; Impressum und Datenschutz als eigene Seiten', () => {
  const view = read(VIEW);
  for (const page of PAGES) {
    const { root } = H.parse(read(page));
    assert.match(H.textOf(H.byTag(root, 'title')[0]), /360°Pixelkiez/, `${page}: Titel`);
    assert.ok(H.byClass(root, 'logo').every(l => H.norm(H.textOf(l)).startsWith('360°Pixelkiez')), `${page}: Logo`);
    const legal = H.find(root, e => e.tag === 'nav' && e.attrs.get('aria-label') === 'Rechtliches')[0];
    assert.deepEqual(H.byTag(legal, 'a').map(a => a.attrs.get('href').replace(/^\//, '')), ['impressum.html', 'datenschutz.html'], `${page}: Rechtliches`);
    assert.match(H.norm(H.textOf(H.byClass(root, 'footer')[0])), /© 2026 360°Pixelkiez/, `${page}: Copyright`);
  }
  assert.match(view, /© 2026 360°Pixelkiez/);
  assert.ok(view.includes('<a href="${b}/impressum.html">Impressum</a><a href="${b}/datenschutz.html">Datenschutz</a>'), 'Anfrageseiten: Impressum und Datenschutz');
  const imprint = H.norm(H.textOf(H.byTag(H.parse(read('public/impressum.html')).root, 'main')[0]));
  for (const s of ['§ 5 Digitale-Dienste-Gesetz (DDG)', 'Vincent Schnetzer', '360°Pixelkiez', 'Edelhofdamm 74', '13465 Berlin', '360@pixelkiez.de', '§ 18 Abs. 2 MStV', 'Verbraucherschlichtungsstelle']) {
    assert.ok(imprint.includes(s), `Impressum enthält "${s}"`);
  }
  const privacy = H.norm(H.textOf(H.byTag(H.parse(read('public/datenschutz.html')).root, 'main')[0]));
  assert.match(privacy, /in Vorbereitung/, 'Datenschutzerklärung als unvollständig gekennzeichnet, bis sie fertiggestellt ist');
  assert.match(privacy, /ENTWURF – nicht rechtlich freigegeben/);
  assert.ok(privacy.includes('Vincent Schnetzer') && privacy.includes('360@pixelkiez.de'), 'Verantwortlicher genannt');
  /* Entwurf nennt die tatsächlich genutzten Dienste und Datenflüsse; offene Punkte stehen in eckigen Klammern */
  for (const s of ['Cloudflare Pages', 'Cloudflare Workers', 'Cloudflare-D1-Datenbank mit EU-Jurisdiktion', 'Google Ireland Limited', '„openid“ und „email“', 'Resend', 'Schriftarten', '__Host-pxwa', 'HMAC', '[Frist noch nicht festgelegt']) {
    assert.ok(privacy.includes(s), `Datenschutz-Entwurf nennt "${s}"`);
  }
  assert.ok(!/Railway|Hostinger-PHP|Supabase/.test(privacy), 'keine verworfenen Dienste');
});

test('Design: styles.css unverändert gegenüber vision.html; alle verwendeten Klassen sind definiert', () => {
  const inline = H.byTag(H.parse(read('vision.html')).root, 'style')[0].raw;
  const strip = s => s.split('\n').map(l => l.replace(/\s+$/, '')).join('\n').trim();
  assert.equal(strip(read('public/assets/styles.css')), strip(inline), 'Design-Quelle unverändert');
  const css = read('public/assets/styles.css') + read('public/assets/anfrage.css');
  const classes = new Set();
  for (const p of PAGES) for (const e of H.elements(H.byTag(H.parse(read(p)).root, 'body')[0])) for (const c of (e.attrs.get('class') || '').split(/\s+/).filter(Boolean)) classes.add(c);
  for (const m of read(VIEW).matchAll(/class="([^"]+)"/g)) for (const c of m[1].split(/\s+/)) classes.add(c);
  const unknown = [...classes].filter(c => !new RegExp(`\\.${c.replace(/-/g, '\\-')}(?![\\w-])`).test(css));
  assert.deepEqual(unknown, []);
});

test('Release-Grenze Website (Cloudflare Pages): Konfiguration nur für Pages, Functions nur unter /api/* und für zwei Videos, Sicherheits-Header, keine Railway- oder PHP-Reste', () => {
  assert.deepEqual(artifactFiles(), ['404.html', '_headers', '_routes.json', 'agb.html', 'assets/anfrage.css', 'assets/app.js', 'assets/styles.css', 'datenschutz.html', 'impressum.html', 'index.html', ...MEDIA, 'pruefkriterien.html']);
  assert.deepEqual(repoFiles().filter(f => /\.(php|phtml)$|(^|\/)\.htaccess$|^(server|bin)\/|railway|Dockerfile|Caddyfile|\.dockerignore/i.test(f)), [], 'keine PHP-, Railway- oder Docker-Bestandteile');
  const pages = read('wrangler.toml');
  const active = pages.split('\n').filter(l => !l.trim().startsWith('#')).join('\n');
  assert.match(active, /^name = "pxwa"$/m);
  assert.match(active, /^pages_build_output_dir = "\.\/public"$/m);
  assert.ok(!/^\s*main\s*=/m.test(active), 'kein Worker-Einstiegspunkt in der Pages-Konfiguration');
  assert.match(active, /^\[\[services\]\]\nbinding = "API"\nservice = "pxwa-api"$/m, 'Produktion: internes Service Binding zum privaten Worker');
  assert.match(active, /^\[env\.preview\]\nservices = \[\]$/m, 'Vorschau-Deployments ohne Binding');
  assert.ok(!/\[vars\]|d1_databases|kv_namespaces|r2_buckets|SECRET|TOKEN/i.test(active), 'Website ohne Variablen, Secrets oder Speicher');
  assert.equal(read('worker/wrangler.toml').match(/^compatibility_date = .*$/m)[0], active.match(/^compatibility_date = .*$/m)[0], 'gleiches Kompatibilitätsdatum');
  const headers = read('public/_headers');
  for (const h of ['Strict-Transport-Security: max-age=31536000', 'X-Content-Type-Options: nosniff', 'X-Frame-Options: DENY', "Content-Security-Policy: frame-ancestors 'none'",
    'Referrer-Policy: strict-origin-when-cross-origin', 'Cross-Origin-Opener-Policy: same-origin', 'Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()', '! Access-Control-Allow-Origin']) {
    assert.ok(headers.includes(`\n  ${h}\n`), `_headers: ${h}`);
  }
  assert.match(headers, /^https:\/\/:project\.pages\.dev\/\*\n {2}X-Robots-Tag: noindex$/m, '*.pages.dev wird nicht indexiert');
  for (const page of PAGES) assert.match(read(page), /<meta name="robots" content="noindex,nofollow">/, `${page}: noindex bis zur Launch-Freigabe`);
  const fn = read(FUNCTION);
  assert.match(fn, /return await env\.API\.fetch\(new Request\(request, \{ redirect: 'manual' \}\)\);/, 'Weitergabe der Original-Anfrage ohne Verfolgen von Weiterleitungen');
  assert.match(fn, /if \(!env\.API\) return unavailable\(\);/);
  const code = fn.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  assert.ok(!/console\.|\bfetch\(|env\.ASSETS|next\(/.test(code.replace('env.API.fetch(', '')), 'keine Logs, keine weiteren Aufrufe, kein Rückfall auf statische Dateien');
  for (const f of ['.dev.vars', 'worker/.dev.vars', '.wrangler/state/v3/d1/x.sqlite', 'node_modules/x', '360-pixelkiez-video-1080p.mp4', 'public/media/anderes-video.mp4', 'public/media/entwurf.jpg']) {
    assert.equal(spawnSync('git', ['check-ignore', '-q', f], { cwd: ROOT }).status, 0, `${f} ist ignoriert`);
  }
  /* Genau die vier freigegebenen Medien sind versioniert (frischer Checkout: tests/release.test.mjs) */
  for (const f of MEDIA) assert.equal(spawnSync('git', ['check-ignore', '-q', 'public/' + f], { cwd: ROOT }).status, 1, `public/${f} ist nicht ignoriert`);
  /* Video-Function: nur zwei feste Pfade, nur das eigene Assets-Binding, keine Logs, keine Header der Anfrage an ASSETS */
  const media = read(MEDIA_FUNCTION);
  const mediaCode = media.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  assert.match(mediaCode, /const VIDEOS: readonly string\[\] = \['\/media\/360-pixelkiez-video-1080p\.mp4', '\/media\/report-pdf-de-1x1\.mp4'\];/);
  assert.deepEqual([...mediaCode.matchAll(/\bfetch\(([^)]*\))?/g)].map(m => m[0]), ['fetch(new URL(video, url.origin)'], 'einziger Abruf: feste Videodatei aus ASSETS');
  assert.match(mediaCode, /env\.ASSETS\.fetch\(new URL\(video, url\.origin\)\.href\)/);
  assert.ok(!/console\.|caches\.|Set-Cookie|R2|env\.(?!ASSETS)\w+/i.test(mediaCode), 'keine Logs, kein Cache, keine Cookies, keine weiteren Bindings');
  assert.deepEqual(JSON.parse(read('public/_routes.json')).include, ['/api/*', '/media/360-pixelkiez-video-1080p.mp4', '/media/report-pdf-de-1x1.mp4'], 'Poster bleiben statisch');
});

test('Release-Scan des Pages-Uploads (public/ wie `wrangler pages deploy`): nur Website-Dateien, keine Quellen, kein PHP/Railway, keine Secrets, höchstens 25 MiB je Datei', () => {
  const files = uploadFiles();
  assert.deepEqual(files.filter(f => !f.startsWith('media/')), ['404.html', 'agb.html', 'assets/anfrage.css', 'assets/app.js', 'assets/styles.css', 'datenschutz.html', 'impressum.html', 'index.html', 'pruefkriterien.html']);
  assert.ok(files.filter(f => f.startsWith('media/')).every(f => /^media\/[\w-]+\.(mp4|jpg)$/.test(f)), 'in media/ nur Videos und Poster');
  assert.ok(files.length < 20000);
  for (const f of files) {
    const buf = readFileSync(join(ROOT, 'public', f));
    assert.ok(buf.length <= 25 * 1024 * 1024, `${f}: über 25 MiB`);
    if (/\.(mp4|jpg)$/.test(f)) continue;
    const text = buf.toString('utf8');
    assert.ok(!/railway|<\?php|\.php\b|caddy/i.test(text), `${f}: Railway- oder PHP-Rest`);
    assert.ok(!/-----BEGIN [A-Z ]*PRIVATE KEY|GOCSPX-|\bre_[A-Za-z0-9]{16,}|\bsk_[A-Za-z0-9]{16,}/.test(text), `${f}: Secret`);
    assert.ok(!/test-only|mock-access-token|MAIL_API_TOKEN|GOOGLE_CLIENT_SECRET/.test(text), `${f}: Test- oder Konfigurationswerte`);
  }
});

test('Release-Grenze API (privater Worker): keine Route, keine workers.dev-Adresse, D1, Cron; Produktionswerte für 360.pixelkiez.de und Resend', () => {
  const w = read('worker/wrangler.toml');
  const active = w.split('\n').filter(l => !l.trim().startsWith('#')).join('\n');
  assert.match(active, /^name = "pxwa-api"$/m, 'Name passt zum Service Binding der Pages-Konfiguration');
  assert.match(active, /^main = "src\/index\.ts"$/m);
  assert.match(active, /^workers_dev = false$/m); assert.match(active, /^preview_urls = false$/m);
  assert.ok(!/^\s*(routes?|route)\s*=|\[\[routes\]\]|custom_domain/m.test(active), 'keine öffentliche Route, keine Custom Domain');
  assert.ok(!/pages_build_output_dir/.test(active));
  assert.match(active, /\[\[d1_databases\]\]\s*\nbinding = "DB"\s*\ndatabase_name = "pxwa"/);
  assert.match(w, /--jurisdiction eu/, 'D1 in EU-Jurisdiktion anlegen');
  assert.match(active, /crons = \["\*\/5 \* \* \* \*"\]/);
  assert.match(active, /^ENV = "production"$/m);
  assert.match(active, /^BASE_URL = "https:\/\/360\.pixelkiez\.de"$/m);
  assert.match(active, /^MAIL_API_URL = "https:\/\/api\.resend\.com\/emails"$/m);
  assert.match(active, /^MAIL_FROM = ""$/m, 'Absender erst nach Verifizierung der Versanddomain');
  assert.match(active, /^PRIVACY_VERSION = "ENTWURF-/m, 'Datenschutzerklärung nicht freigegeben: Produktion nimmt keine Aufträge an');
  assert.match(active, /^TERMS_VERSION = "ENTWURF-/m, 'AGB nicht freigegeben: Produktion nimmt keine Aufträge an');
  assert.match(active, /^MAIL_NOTIFY_TO = "360@pixelkiez\.de"$/m);
  assert.ok(!/^ORDER_RETENTION_DAYS\s*=/m.test(active), 'Löschfrist nicht aktiv, solange die Aufbewahrungsfrist offen ist');
  const config = read('worker/src/config.ts');
  assert.match(config, /export const AUTHORIZED_MAIL_API_HOSTS: readonly string\[\] = \['api\.resend\.com'\];/);
  assert.match(config, /export const AUTHORIZED_MAIL_FROM_DOMAINS: readonly string\[\] = \['notify\.pixelkiez\.de'\];/);
  assert.match(config, /export const PRODUCTION_BASE_URL = 'https:\/\/360\.pixelkiez\.de';/);
  assert.match(config, /export const PRODUCTION_NOTIFY_TO = '360@pixelkiez\.de';/, 'fester interner Empfänger in Produktion');
  /* Einzige Adresse ist 360@pixelkiez.de: Die frühere Adresse steht weder in ausgelieferten Seiten noch im Worker oder in der
     Konfiguration (kein versteckter Rückfall, keine Doppelzustellung). */
  for (const f of [...PAGES, ...WORKER_SRC, 'worker/wrangler.toml', 'worker/.dev.vars.example', 'wrangler.toml', FUNCTION, MEDIA_FUNCTION, 'public/_headers', 'public/assets/app.js']) {
    assert.ok(!/kontakt@pixelkiez\.de/i.test(read(f)), `${f}: keine frühere Adresse kontakt@pixelkiez.de`);
  }
  assert.deepEqual([...new Set([...PAGES, VIEW].flatMap(f => [...read(f).matchAll(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi)].map(m => m[0])))], ['360@pixelkiez.de'], 'einzige Mailadresse auf der Website');
});

test('D1-Schema: nur die nötigen Tabellen und Spalten (Datenminimierung), keine Tokens; Migration 0002 rein additiv', () => {
  const sql = MIGRATIONS.join('\n');
  const tables = Object.fromEntries([...sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\);/g)].map(([, name, body]) => [name,
    body.split('\n').map(l => l.trim().split(/\s+/)[0]).filter(c => c && !['PRIMARY'].includes(c))]));
  for (const [, table, column] of sql.matchAll(/^ALTER TABLE (\w+) ADD COLUMN (\w+)/gm)) tables[table].push(column);
  assert.equal(MIGRATIONS.length, 2);
  const additive = MIGRATIONS[1].replace(/^\s*--.*$/gm, '').split(';').map(x => x.trim()).filter(Boolean);
  assert.deepEqual(additive, ['ALTER TABLE orders ADD COLUMN terms_version TEXT NULL', 'ALTER TABLE orders ADD COLUMN terms_accepted_at TEXT NULL'], '0002: nur neue Spalten, kein DROP/UPDATE/DELETE');
  assert.deepEqual(tables, {
    orders: ['id', 'reference', 'idempotency_key', 'google_sub', 'email', 'website_url', 'privacy_version', 'status', 'created_at', 'terms_version', 'terms_accepted_at'],
    notifications: ['id', 'order_id', 'status', 'attempts', 'next_attempt_at', 'locked_until', 'last_error', 'sent_at', 'created_at'],
    rate_limits: ['bucket', 'window_start', 'hits'],
    sessions: ['id_hash', 'data', 'version', 'created_at', 'expires_at'],
  });
  assert.ok(!/token|password|ip_address/i.test(sql.replace(/^\s*--.*$/gm, '')));
});

test('Keine Secrets im Repository', () => {
  const hits = [];
  for (const f of repoFiles().filter(f => !f.startsWith('tests/') && !f.startsWith('node_modules/'))) {
    const s = readFileSync(join(ROOT, f), 'utf8');
    if (/-----BEGIN (RSA |EC )?PRIVATE KEY-----/.test(s)) hits.push(`${f}: privater Schlüssel`);
    if (/GOCSPX-[A-Za-z0-9_-]{10,}/.test(s)) hits.push(`${f}: Google-Client-Secret`);
    if (/\b(re|sk|key|pm|xkeysib)[_-][A-Za-z0-9_-]{20,}/.test(s)) hits.push(`${f}: API-Schlüssel`);
  }
  assert.deepEqual(hits, []);
  assert.ok(!/=\s*"[^"]{20,}"/.test(read('wrangler.toml').replace(/^#.*$/gm, '')), 'Pages-Konfiguration ohne Schlüsselwerte');
  const vars = read('worker/wrangler.toml').split('[vars]')[1].split('\n[')[0];
  assert.ok(!/^\s*(GOOGLE_CLIENT_SECRET|SECRET|MAIL_API_TOKEN)\s*=/m.test(vars), 'Secrets nie als [vars]');
  assert.match(read('worker/.dev.vars.example'), /^GOOGLE_CLIENT_SECRET=$/m); assert.match(read('worker/.dev.vars.example'), /^MAIL_API_TOKEN=$/m); assert.match(read('worker/.dev.vars.example'), /^SECRET=$/m);
});

test('Scope des API-Workers: nur openid email, kein PDF, keine Kunden-Mail, kein Abruf der Kundenwebsite, keine Tokens im Browser', () => {
  const src = WORKER_SRC.map(read).join('\n');
  assert.match(read('worker/src/oidc.ts'), /scope: 'openid email'/);
  /* Code ohne Kommentare (Kommentare nennen die ausgeschlossenen Rechte ausdrücklich) */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  assert.ok(!/gmail|mail\.google\.com|userinfo|googleapis\.com\/auth/i.test(code), 'keine zusätzlichen Google-Berechtigungen');
  assert.ok(!/application\/pdf|%PDF|pdf-lib|pdfkit|jspdf|puppeteer|@cloudflare\/puppeteer/i.test(src), 'keine PDF-Erzeugung');
  assert.deepEqual([...src.matchAll(/\.send\(\{\s*to:\s*([^,]+),/g)].map(m => m[1].trim()), ['this.notifyTo'], 'einziger Mailversand geht an die interne Adresse');
  assert.deepEqual([...src.matchAll(/\bfetch\(([^,)]+)[,)]/g)].map(m => m[1].trim()).sort(), ['this.cfg.apiUrl', 'this.g.jwksUri', 'this.g.tokenEndpoint'], 'ausgehende Aufrufe nur an Google und die Mail-API, nie an die Kundenwebsite');
  assert.ok(!/\b(?:log|console\.(?:log|error|warn))\([^)]*\b(email|website_url|websiteUrl|idToken|id_token|access_token|code|verifier)\b/.test(src), 'keine personenbezogenen Daten oder Tokens im Log');
  assert.ok(!/localStorage|sessionStorage|indexedDB|document\.cookie|fetch\(/.test(read('public/assets/app.js')), 'app.js speichert und sendet nichts selbst');
});

test('TypeScript: Worker und Pages Function ohne Typfehler (tsc --noEmit, strict)', t => {
  const tsc = join(ROOT, 'node_modules/.bin/tsc');
  if (!existsSync(tsc)) { t.skip('NOT_RUN: typescript fehlt (npm ci)'); return; }
  for (const project of ['worker/tsconfig.json', 'functions/tsconfig.json']) {
    const r = spawnSync(tsc, ['-p', join(ROOT, project)], { encoding: 'utf8' });
    assert.equal(r.status, 0, project + ': ' + r.stdout + r.stderr);
  }
});
