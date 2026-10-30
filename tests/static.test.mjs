/* PXWA – statische Prüfungen ohne Abhängigkeiten (Node ≥ 20). Ausführen im Repo-Root: node --test tests/static.test.mjs
   Prüft Inhalte (kostenloses Angebot, vier Bereiche, sieben PDF-Seiten, GEO & AI Visibility), Methodik, Links,
   unveränderte Design-Quelle, Release-Grenze public/, Secrets und den Scope der Serverkomponente. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join, relative } from 'node:path';
import * as H from './lib/html.mjs';
import { ROOT } from './lib/harness.mjs';

const read = p => readFileSync(join(ROOT, p), 'utf8');
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' });
const PAGES = ['public/index.html', 'public/pruefkriterien.html'];
const REFERENCE_ZIP = process.env.PXK_REFERENCE_ZIP || join(ROOT, '..', 'pxwa-quellen-klein.zip');

const AREAS = ['SEO & Auffindbarkeit', 'Performance & Technik', 'GEO & AI Visibility', 'UX, Barrierefreiheit & Vertrauen'];
const REPORT_PAGES = ['Deckblatt und Kurzfazit', 'SEO & Auffindbarkeit', 'Performance & Technik', 'GEO & AI Visibility', 'UX, Barrierefreiheit & Vertrauen', 'Priorisierte Verbesserungen', 'Methodik, Quellen, Prüfgrenzen und Kontakt'];
const METHOD = [
  ['findability_seo', 'SEO & Auffindbarkeit', [['FIND', 10]]],
  ['performance_technology', 'Performance & Technik', [['PERF', 9]]],
  ['geo_ai_visibility', 'GEO & AI Visibility', [['AI', 8]]],
  ['ux_accessibility_trust', 'UX, Barrierefreiheit & Vertrauen', [['UX', 8], ['A11Y', 6], ['TRUST', 8]]],
];
const EXTERNAL_OK = ['https://pixelkiez.de/', 'https://pixelkiez.de/impressum.html', 'https://pixelkiez.de/datenschutz.html', 'mailto:kontakt@pixelkiez.de'];

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
  assert.deepEqual(H.byTag(H.byClass(root, 'report-pages')[0], 'li').map(li => txt(li.children.filter(c => c.tag)[1])), REPORT_PAGES);
  assert.deepEqual(H.byClass(root, 'report-pages')[0].children.filter(c => c.tag).map(li => txt(li.children.find(c => c.tag))), ['01', '02', '03', '04', '05', '06', '07']);
  for (const s of ['GEO', 'AI Visibility', 'Generative Engine Optimization', '0 €', 'mit Google an', 'sieben Seiten', 'Core Web Vitals', 'beobachtet']) assert.ok(text.includes(s), `fehlt: ${s}`);
  assert.equal(H.byClass(root, 'plan').length, 3);
  assert.equal(H.byClass(root, 'plan--featured').length, 1);
  assert.match(txt(H.byClass(root, 'plan--featured')[0]), /0 €/);
  const form = H.byId(root, 'analyze');
  assert.equal(form.attrs.get('action'), 'anfrage.php'); assert.equal(form.attrs.get('method'), 'post');
  assert.deepEqual(H.find(form, e => e.attrs.has('name')).map(e => e.attrs.get('name')), ['action', 'website']);
});

test('Wahrheitsgemäße Aussagen: kein Premium/Checkout/Abo/Dashboard/Score, keine Garantien, keine DSGVO-Behauptung, keine Vorschau-Reste', () => {
  for (const page of PAGES) assert.deepEqual(claimProblems(surfaces(read(page))), [], page);
  const view = [...read('server/src/View.php').matchAll(/'((?:[^'\\]|\\.)*)'/g)].map(m => m[1].replace(/<[^>]+>/g, ' ')).join(' ');
  assert.deepEqual(claimProblems([['View.php', view]]), []);
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

test('Links: interne Anker gültig, externe Ziele nur Pixelkiez und mailto', () => {
  const pages = Object.fromEntries(PAGES.map(p => [p.slice(7), read(p)]));
  for (const [page, html] of Object.entries(pages)) {
    for (const a of H.byTag(H.parse(html).root, 'a')) {
      const href = a.attrs.get('href');
      assert.ok(href && href !== '#', `${page}: Link ohne Ziel "${H.norm(H.textOf(a))}"`);
      if (/^(https?:|mailto:)/.test(href)) { assert.ok(EXTERNAL_OK.includes(href), `${page}: externer Link ${href}`); continue; }
      const [file, frag] = href.split('#');
      const target = file || page;
      assert.ok(pages[target], `${page}: unbekannte Datei ${target}`);
      if (frag) assert.ok(H.byId(H.parse(pages[target]).root, frag), `${page}: Anker ${href} fehlt`);
    }
  }
});

test('Design: styles.css unverändert gegenüber vision.html; alle verwendeten Klassen sind definiert', () => {
  const inline = H.byTag(H.parse(read('vision.html')).root, 'style')[0].raw;
  const strip = s => s.split('\n').map(l => l.replace(/\s+$/, '')).join('\n').trim();
  assert.equal(strip(read('public/assets/styles.css')), strip(inline), 'Design-Quelle unverändert');
  const css = read('public/assets/styles.css') + read('public/assets/anfrage.css');
  const classes = new Set();
  for (const p of PAGES) for (const e of H.elements(H.byTag(H.parse(read(p)).root, 'body')[0])) for (const c of (e.attrs.get('class') || '').split(/\s+/).filter(Boolean)) classes.add(c);
  for (const m of read('server/src/View.php').matchAll(/class="([^"]+)"/g)) for (const c of m[1].split(/\s+/)) classes.add(c);
  const unknown = [...classes].filter(c => !new RegExp(`\\.${c.replace(/-/g, '\\-')}(?![\\w-])`).test(css));
  assert.deepEqual(unknown, []);
});

test('Release-Grenze: public/ enthält nur ausgelieferte Dateien; Konfiguration und Laufzeitdaten sind ausgeschlossen', () => {
  const walk = d => readdirSync(d).flatMap(f => statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [relative(join(ROOT, 'public'), join(d, f))]);
  const files = walk(join(ROOT, 'public')).filter(f => !f.endsWith('.DS_Store')).sort();
  assert.deepEqual(files, ['.htaccess', 'anfrage.php', 'assets/anfrage.css', 'assets/app.js', 'assets/styles.css', 'auth/callback.php', 'index.html', 'pruefkriterien.html']);
  for (const f of ['anfrage.php', 'auth/callback.php']) assert.ok(!/(new\s+PDO|curl_init|SmtpMailer)/.test(read('public/' + f)), `${f}: nur Einstieg, Logik außerhalb des Webroots`);
  for (const f of ['server/config.php', 'var/pxwa.sqlite', 'var/google-jwks.json']) assert.equal(spawnSync('git', ['check-ignore', '-q', f], { cwd: ROOT }).status, 0, `${f} ist ignoriert`);
  assert.ok(!git('ls-files').split('\n').includes('server/config.php'));
  const ht = read('public/.htaccess');
  assert.match(ht, /Options -Indexes/); assert.match(ht, /RewriteRule \(\^\|\/\)\\\. - \[F\]/); assert.match(ht, /https:\/\/%\{HTTP_HOST\}/);
});

test('Keine Secrets im Repository', () => {
  const tracked = git('ls-files').split('\n').filter(f => f && !f.startsWith('tests/') && existsSync(join(ROOT, f)));
  const hits = [];
  for (const f of tracked) {
    const s = readFileSync(join(ROOT, f), 'utf8');
    if (/-----BEGIN (RSA |EC )?PRIVATE KEY-----/.test(s)) hits.push(`${f}: privater Schlüssel`);
    if (/GOCSPX-[A-Za-z0-9_-]{10,}/.test(s)) hits.push(`${f}: Google-Client-Secret`);
    for (const m of s.matchAll(/'(client_secret|password|pass|secret)'\s*=>\s*'([^']+)'/g)) hits.push(`${f}: ${m[1]} gesetzt`);
  }
  assert.deepEqual(hits, []);
  const example = read('server/config.example.php');
  assert.match(example, /'client_secret' => ''/); assert.match(example, /'password' => ''/);
});

test('Scope der Serverkomponente: nur openid email, kein PDF, keine Kunden-Mail, kein Abruf der Kundenwebsite, keine Tokens im Browser', () => {
  const src = readdirSync(join(ROOT, 'server/src')).map(f => read('server/src/' + f)).join('\n') + read('bin/send-notifications.php');
  assert.match(read('server/src/GoogleOidc.php'), /'scope' => 'openid email'/);
  const literals = [...src.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map(m => m[1]).join('\n');
  assert.ok(!/gmail|mail\.google\.com|userinfo|googleapis\.com\/auth/i.test(literals), 'keine zusätzlichen Google-Berechtigungen');
  assert.ok(!/application\/pdf|%PDF|fpdf|tcpdf|dompdf|mpdf|wkhtmltopdf/i.test(src), 'keine PDF-Erzeugung');
  const sends = [...src.matchAll(/->send\(([^,]+),/g)].map(m => m[1].trim());
  assert.deepEqual(sends, ['$this->notifyTo'], 'einziger Mailversand geht an die interne Adresse');
  assert.ok(!/website_url[^;\n]*(curl|file_get_contents|fopen|get\()/.test(src) && !/->get\(\$(url|website)/.test(src), 'Kundenwebsite wird nicht abgerufen');
  assert.ok(!/localStorage|sessionStorage|indexedDB|document\.cookie|fetch\(/.test(read('public/assets/app.js')), 'app.js speichert und sendet nichts selbst');
});

test('PHP-Syntax (php -l) aller Serverdateien', t => {
  if (spawnSync('php', ['-v']).status !== 0) { t.skip('NOT_RUN: php nicht verfügbar'); return; }
  const files = ['server/bootstrap.php', 'server/config.example.php', 'public/anfrage.php', 'public/auth/callback.php', 'bin/migrate.php', 'bin/send-notifications.php',
    ...readdirSync(join(ROOT, 'server/src')).map(f => 'server/src/' + f)];
  for (const f of files) assert.equal(spawnSync('php', ['-l', join(ROOT, f)]).status, 0, f);
});
