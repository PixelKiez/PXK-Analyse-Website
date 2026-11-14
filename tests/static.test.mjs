/* PXWA – statische Prüfungen (Node ≥ 22). Ausführen im Repo-Root: node --test tests/static.test.mjs
   Prüft Inhalte (kostenloses Angebot, vier Bereiche, sieben PDF-Seiten, GEO & AI Visibility), Methodik, Links,
   unveränderte Design-Quelle, Release-Grenzen (Cloudflare-Pages-Artefakt, Pages Function, Worker), Secrets und den Scope des API-Workers. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { join, relative } from 'node:path';
import * as H from './lib/html.mjs';
import { ROOT, artifactFiles, uploadFiles, MIGRATIONS, SOFT_LAUNCH, SOFT_LAUNCH_SKIP, R2_VIDEOS, R2_BILDER, R2_MEDIEN } from './lib/harness.mjs';

const read = p => readFileSync(join(ROOT, p), 'utf8');
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' });
/* Wissensbereich: Übersicht und sechs eigenständige 360°Pixelkiez-Beiträge (Entscheidung des Auftraggebers 02.11.2026) */
const WISSEN = ['index', 'seo-geo-ai-visibility', 'wie-ki-websites-liest', 'wie-websites-ausgeliefert-werden', 'answerability', 'entity-trust', 'agent-readiness'].map(s => `public/wissen/${s}.html`);
/* Analyse-Bereich: Übersicht, sechs Prüfbereiche, drei Vertiefungen (Paket rc4 ohne Score, Entscheidung des Auftraggebers 02.11.2026) */
const ANALYSE = ['index', 'auffindbarkeit-seo', 'performance-technik', 'nutzerfuehrung-conversion', 'vertrauen-datenschutz', 'barrierefreiheit', 'ki-verstaendlichkeit', 'methodik', 'warum-website-analyse', 'ki-crawler-agenten'].map(s => `public/analyse/${s}.html`);
const INHALT = [...WISSEN, ...ANALYSE];
/* Titelbilder (og:image, 1200×630) je Seite, Icons; Stylesheet und Skript des Kreisdiagramms (Startseite und Analyse-Übersicht) */
const OG = ['start', 'wissen', 'analyse', ...WISSEN.slice(1).map(s => 'wissen-' + s.split('/').pop().slice(0, -5)), ...ANALYSE.slice(1).map(s => 'analyse-' + s.split('/').pop().slice(0, -5))];
/* Partner-Logos unter dem Hero (Entscheidung des Auftraggebers 03.11.2026), lokal ausgeliefert (CSP img-src 'self') */
const PARTNER_LOGOS = ['assets/partner/dyai-studio.svg', 'assets/partner/pixelkiez.png'];
/* Favicon-Satz des Auftraggebers (favicon.io, Ordner favicon_io, 05.11.2026) bitgleich im Wurzelverzeichnis; ersetzt das „P°“-Favicon */
const FAVICONS = {
  'android-chrome-192x192.png': '027b16d97e75774dee695476b1e1e738841e33a6b292cd44b20597931a45239c',
  'android-chrome-512x512.png': '60841043b8c16d8080a018ce8f4d959a060042b2342072807d3a268331bdbf3d',
  'apple-touch-icon.png': '0c1933c736ba5a0f46edb84c854f00ca61432639ad27bbf57b8b9b2912e4b9a3',
  'favicon-16x16.png': '8995cb13c31447b5eab7d0d5667d7fbc68df18ffcebce72caa0c9684bb8e5e60',
  'favicon-32x32.png': '56302ce2233f98c194eaa01c44898c5395b9cf79f7016923e11aaf65771acaf4',
  'favicon.ico': 'e80c78ef4d0a2ff1a945ba8456064e6be22c4b0f1d219aa8cc5ea3ec302590b7',
  'site.webmanifest': '7a9e07ce1f7386689917602ddc5a75750ad842e605ff764f67173529c181bf04',
};
const BILDER = [...Object.keys(FAVICONS), ...OG.map(n => `assets/og/${n}.jpg`), ...PARTNER_LOGOS];
const ASSETS = ['assets/anfrage.css', 'assets/app.js', 'assets/donut.css', 'assets/donut.js', 'assets/inhalt.css', 'assets/styles.css'];
/* Selbst ausgelieferte Schriften (Soft-Launch-Datenschutz-Fix 03.11.2026): Stylesheet, WOFF2-Dateien und OFL-Lizenzen */
const FONT_FILES = ['assets/fonts.css', ...['OFL-Archivo.txt', 'OFL-IBM-Plex-Mono.txt', 'archivo-latin-ext.woff2', 'archivo-latin.woff2', 'ibm-plex-mono-400-latin-ext.woff2',
  'ibm-plex-mono-400-latin.woff2', 'ibm-plex-mono-500-latin-ext.woff2', 'ibm-plex-mono-500-latin.woff2'].map(f => 'assets/fonts/' + f)];
const PAGES = ['public/index.html', 'public/impressum.html', 'public/datenschutz.html', 'public/agb.html', 'public/404.html', ...INHALT];
/* Stand vor PXWA-BE-02 (Hero ohne AGB-Häkchen): Referenz für den Hero-Schutz */
const BASE_SHA = '13ac821f94c754a94c330b5686f5bf12f4a0282d';
const FUNCTION = 'functions/api/[[path]].ts';
const MEDIA_FUNCTION = 'functions/media/[file].ts';
/* Versioniert sind nur die Poster der eingebundenen Videos; die Videos liegen im R2-Bucket 360pixelkiez (functions/media/[file].ts).
   Eingebunden: das Hero-Video direkt unter dem Hero (P0-Hotfix PXK-159), das Berichtsvideo
   bei „Ein PDF. Sieben Seiten.“ und das Befund-Video bei „Jeder Befund verständlich erklärt.“ (Entscheidung des Auftraggebers 03.11.2026) */
const MEDIA = ['media/360-pixelkiez-website-analyse-poster.jpg', 'media/report-pdf-lavendel-poster.jpg', 'media/section-bericht-peach-poster.jpg'];
const VIDEOS_EINGEBUNDEN = [['demo', 'media/360-pixelkiez-video-1080p-website-look.mp4', 'media/360-pixelkiez-website-analyse-poster.jpg'], ['bericht', 'media/report-pdf-de-1x1-lavendel.mp4', 'media/report-pdf-lavendel-poster.jpg'], ['nutzen', 'media/section-bericht-peach-5x4.mp4', 'media/section-bericht-peach-poster.jpg']];
const VIEW = 'worker/src/view.ts';
const WORKER_SRC = readdirSync(join(ROOT, 'worker/src')).filter(f => f.endsWith('.ts')).map(f => 'worker/src/' + f);
/* Alle Dateien, die committet würden (versioniert oder neu, nicht ignoriert) */
const repoFiles = () => git('ls-files', '--cached', '--others', '--exclude-standard').split('\n').filter(f => f && existsSync(join(ROOT, f)));
/* Text der serverseitig gerenderten Seiten: String- und Template-Literale aus view.ts ohne Platzhalter und Tags */
const viewText = () => [...read(VIEW).matchAll(/'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)].map(m => (m[1] ?? m[2]).replace(/\$\{[^}]*\}/g, ' ').replace(/<[^>]+>/g, ' ')).join(' ');

/* 360°Pixelkiez ist eine eigenständige Website. Externe Ziele: die Kontaktadresse 360@pixelkiez.de und die beiden Partner
   (Entscheidung des Auftraggebers 03.11.2026: Logos unter dem Hero, pixelkiez.de im Footer); sonst kein Link zu pixelkiez.de */
const PARTNER = ['https://pixelkiez.de/', 'https://studio.dyai.cloud/'];
const EXTERNAL_OK = ['mailto:360@pixelkiez.de', ...PARTNER];
const PARTNER_LINK = '<a href="https://pixelkiez.de/" target="_blank" rel="noopener">';
/* Herausgeber der Quellen, die Wissens- und Analyseseiten belegen (nur dort erlaubt, nur https, nie pixelkiez.de) */
const SOURCE_HOSTS = [
  'about.ads.microsoft.com', 'almanac.httparchive.org', 'angular.dev', 'arxiv.org', 'baymard.com',
  'blog.cloudflare.com', 'blog.google', 'blogs.bing.com', 'bsi.bund.de', 'cheatsheetseries.owasp.org',
  'commoncrawl.org', 'datatracker.ietf.org', 'developer.chrome.com', 'developer.wordpress.org', 'developers.cloudflare.com',
  'developers.facebook.com', 'developers.google.com', 'developers.openai.com', 'docs.astro.build', 'docs.claude.com',
  'docs.perplexity.ai', 'en.wikipedia.org', 'eur-lex.europa.eu', 'help.openai.com', 'html.spec.whatwg.org',
  'justiz.hamburg.de', 'llmstxt.org', 'nda.ie', 'nextjs.org', 'nuxt.com',
  'oeil.europarl.europa.eu', 'platform.claude.com', 'playwright.dev', 'pubsonline.informs.org', 'react.dev',
  'schema.org', 'static.googleusercontent.com', 'support.anthropic.com', 'support.apple.com', 'support.claude.com',
  'support.google.com', 'svelte.dev', 'vercel.com', 'web.dev', 'webaim.org',
  'www.bing.com', 'www.bundesfachstelle-barrierefreiheit.de', 'www.bundesgerichtshof.de', 'www.etsi.org', 'www.ftc.gov',
  'www.gesetze-im-internet.de', 'www.gov.uk', 'www.ietf.org', 'www.nngroup.com', 'www.perplexity.ai',
  'www.pewresearch.org', 'www.rfc-editor.org', 'www.schleswig-holstein.de', 'www.typescriptlang.org', 'www.w3.org',
  'www.wikidata.org',
];

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
/* Wissens- und Analyseseiten erklären Standards, Gesetze und Studien. Dort gelten die Angebotsregeln nicht für Fremdbegriffe,
   die als Sachinformation vorkommen (WCAG, DSGVO, Marktüberwachung, Real User Monitoring, Baymards Checkout-Studie, „monatlich“
   bei Datensätzen, „Vorschau“ bei Anbieterfunktionen, Fristen wie „24 Stunden“ für robots.txt, automatische Barrierefreiheitstests).
   Unverändert verboten bleiben dort Premium, Score, Dashboard, Preise, Ranking-Versprechen und Konformitätsbehauptungen;
   Abo, Garantie, Beratung, Zertifizierung, Rechtsgutachten, Sofortanalyse und Punktzahl nur verneint. */
const CONTENT_EXEMPT = [/Checkout/i, /pro Monat|monatlich/i, /Vorschau/i, /\b\d+\s*(Werktage?|Arbeitstage?|Tage?|Stunden?|Wochen?)\b/i,
  /Monitoring|Überwachung/i, /automatische[nrs]?\s+(Scan|Analyse|Bericht)/i, /\bDSGVO\b/, /\bWCAG\b/].map(String);
/* Analyseseiten und der Abschnitt „Pixelkiez Score“ der Startseite zeigen, wie sich der Score zusammensetzt (Entscheidungen des
   Auftraggebers 02.11.2026); überall sonst bleibt „Score“ verboten */
const SCORE = String(/\bScore\b/i);
/* Rechtstexte (Impressum, Datenschutz, AGB, Fassung 2026-11-04) nennen Gesetze, Fristen und Zertifizierungen der Dienstleister als
   Pflichtangaben; dort gelten zusätzlich zu den Ausnahmen der Inhaltsseiten DSGVO, Zertifizierung, Garantie (Haftungsklausel) und
   Beratung als Sachangabe. Verboten bleiben Premium, Score, Dashboard, Preise, Ranking-Versprechen und Konformitätsbehauptungen. */
const RECHT = ['public/impressum.html', 'public/datenschutz.html', 'public/agb.html'];
const RECHT_EXEMPT = [...CONTENT_EXEMPT, String(/Zertifizierung/i), String(/Garantie|garantiert/i), String(/Beratung/i), String(/\bPro\b/)];
function claimProblems(list, art = false) {
  const p = [];
  const exempt = art === 'analyse' ? [...CONTENT_EXEMPT, SCORE] : art === 'score' ? [SCORE] : art === 'recht' ? RECHT_EXEMPT : art ? CONTENT_EXEMPT : [];
  const rules = rs => rs.filter(re => !exempt.includes(String(re).replace(/g$/, '')));
  for (const [where, text] of list) {
    for (const re of rules(FORBIDDEN)) for (const m of text.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))) {
      if (m[0].replace(/\s/g, '') === '0€') continue;
      p.push(`${where}: "${m[0]}" (…${text.slice(Math.max(0, m.index - 40), m.index + 40)}…)`);
    }
    for (const re of rules(NEGATED_ONLY)) for (const m of text.matchAll(new RegExp(re.source, re.flags + 'g'))) {
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
    /* Soft-Launch: kein Formular, also auch kein Formularziel (form-action 'none'); sonst nur die eigene API und Google */
    assert.match(csp, /script-src 'self'/); assert.match(csp, SOFT_LAUNCH ? /form-action 'none'/ : /form-action 'self' https:\/\/accounts\.google\.com/); assert.match(csp, /object-src 'none'/);
    assert.deepEqual(H.find(root, e => e.attrs.has('style')).map(e => e.tag), [], `${page}: keine style-Attribute (CSP)`);
    assert.deepEqual(H.byTag(root, 'script').filter(s => !s.attrs.has('src') && s.attrs.get('type') !== 'application/ld+json').length, 0, `${page}: keine Inline-Skripte`);
    assert.ok(H.find(root, e => [...e.attrs.keys()].some(a => a.startsWith('on'))).length === 0, `${page}: keine Inline-Event-Handler`);
  }
});

test('Startseite: kostenloses Angebot, sechs Bereiche, sieben PDF-Seiten, GEO & AI Visibility, Google-Anmeldung', () => {
  const { root } = H.parse(read('public/index.html'));
  const txt = el => H.norm(H.textOf(el));
  const text = H.norm(H.visibleText(root));
  /* Videos aus R2: Berichtsvideo neben dem Text bei „Ein PDF. Sieben Seiten.“, Befund-Video bei „Jeder Befund verständlich erklärt.“
     (an der Stelle der früheren Beispielkarte); unter dem Hero das Ablauf-Video. Entscheidung des Auftraggebers 04.11.2026: autoplay,
     stumm, Schleife, inline, preload="metadata", ohne Bedienelemente – weder Browser-Leiste noch eigene Play-/Pause-Schaltflächen, ohne autoplay */
  const videos = H.byTag(root, 'video');
  assert.deepEqual(videos.map(v => [H.find(root, e => e.tag === 'section' && H.find(e, x => x === v).length)[0].attrs.get('id'), H.byTag(v, 'source')[0].attrs.get('src'), v.attrs.get('poster')]), VIDEOS_EINGEBUNDEN);
  /* Ohne autoplay: WebKit blendet für autoplay-Videos, die nicht laufen dürfen (Stromsparmodus), eigene Play-/Pause-Bedienelemente
     ein – das darf nie sein (Entscheidung des Auftraggebers 04.11.2026). Gestartet wird per Skript (app.js) */
  for (const v of videos) assert.ok(['muted', 'loop', 'playsinline', 'poster', 'aria-label'].every(a => v.attrs.has(a)) && !v.attrs.has('controls') && !v.attrs.has('autoplay') && v.attrs.get('preload') === 'metadata');
  /* Keine selbst erzeugten Bedienelemente: app.js erzeugt keine Schaltflächen, keine Stile dafür */
  assert.ok(!/createElement\(['"]button|video-toggle|braucht-start|video-hinweis|\.controls = true/.test(read('public/assets/app.js')), 'app.js ohne Video-Schaltflächen');
  assert.ok(!/video-toggle|braucht-start|video-hinweis/.test(read('public/assets/anfrage.css')), 'CSS ohne Video-Schaltflächen');
  for (const v of videos) assert.equal(H.byTag(v, 'source')[0].attrs.get('type'), 'video/mp4');
  assert.ok(VIDEOS_EINGEBUNDEN.every(([, src]) => R2_VIDEOS.includes(src.slice('media/'.length))), 'jedes eingebundene Video liegt in R2');
  /* Unter dem Hero genau ein Video. Entscheidung des Auftraggebers 04.11.2026: keine Kennzeichnung als alte Fassung, keine Sätze unter
     den Videos; die Beschreibung (auch „Beispieldaten“) steht im Alternativtext und in den Metadaten der Poster */
  const demo = H.byClass(root, 'showcase');
  assert.equal(demo.length, 1, 'genau ein Video unter dem Hero');
  const videoFiguren = H.byTag(root, 'figure').filter(f => H.byTag(f, 'video').length);
  assert.deepEqual([videoFiguren.length, videoFiguren.flatMap(f => H.byTag(f, 'figcaption')).length, H.byClass(root, 'showcase-badge').length], [3, 0, 0], 'keine Bildunterschrift unter Videos, keine Plakette');
  assert.ok(!/historisch|früheren Entwurf/i.test(read('public/index.html')), 'keine Kennzeichnung als alte Fassung');
  for (const v of videos) assert.match(v.attrs.get('aria-label'), /^Animiert.*(Beispieldaten|fiktives Beispiel)/, 'Alternativtext beschreibt das Video und nennt Beispieldaten');
  assert.equal(H.byClass(root, 'detail').length, 0, 'Beispielkarte ersetzt durch das Befund-Video');
  for (const s of ['GEO', 'AI Visibility', 'Generative Engine Optimization', '0 €', 'mit Google an', 'sieben Seiten']) assert.ok(text.includes(s), `fehlt: ${s}`);
  /* Es sind sechs Bereiche; nirgends mehr „vier Bereiche“ und keine Seitenangabe je Bereich (der Bericht bleibt bei sieben Seiten) */
  assert.ok(text.includes('in sechs Bereichen') && !/[Vv]ier Bereich|Seite \d des Berichts|je eine Seite pro Bereich/.test(read('public/index.html')), 'sechs Bereiche');
  /* AI-08 ist gestrichen (48 Kriterien): keine Zusage beobachteter KI-Antwort-Stichproben mehr */
  assert.ok(!/beobachtet|Stichprobe tatsächlich/.test(read('public/index.html')), 'keine KI-Antwort-Stichproben');
  /* Abschnitt „So setzt sich der Pixelkiez Score zusammen.“ ersetzt „Vier Bereiche. Ein klares Bild.“ an derselben Stelle (#bereiche);
     „Alle Prüfpunkte nachlesen“ entfällt */
  const ids = H.byTag(root, 'section').map(s => s.attrs.get('id')).filter(Boolean);
  assert.ok(!ids.includes('tools') && !ids.includes('score'), 'Abschnitte „Alle Prüfpunkte nachlesen“ und der frühere Score-Abschnitt entfallen');
  assert.deepEqual(ids.slice(ids.indexOf('bericht'), ids.indexOf('nutzen') + 1), ['bericht', 'bereiche', 'nutzen'], 'Score-Abschnitt an der Stelle von „Vier Bereiche“');
  const score = H.byId(root, 'bereiche');
  assert.equal(txt(H.byTag(score, 'h2')[0]), 'So setzt sich der Pixelkiez Score zusammen.');
  assert.ok(!/Vier Bereiche\. Ein klares Bild\./.test(read('public/index.html')), '„Vier Bereiche. Ein klares Bild.“ entfernt');
  const legende = H.byTag(H.byClass(score, 'donut-legende')[0], 'a');
  assert.deepEqual(legende.map(a => a.attrs.get('href')), ['auffindbarkeit-seo', 'performance-technik', 'nutzerfuehrung-conversion', 'vertrauen-datenschutz', 'barrierefreiheit', 'ki-verstaendlichkeit'].map(s => `analyse/${s}.html`));
  assert.equal(legende.reduce((n, a) => n + Number(a.attrs.get('data-gewicht')), 0), 100, 'Gewichte ergeben 100 %');
  assert.equal(legende.reduce((n, a) => n + Number(a.attrs.get('data-kriterien')), 0), 48, '48 Prüfkriterien');
  assert.equal(H.byTag(H.byClass(score, 'donut-bild')[0], 'a').length, 6, 'sechs Segmente');
  assert.equal(H.byClass(root, 'plan').length, 3);
  assert.equal(H.byClass(root, 'plan--featured').length, 1);
  assert.match(txt(H.byClass(root, 'plan--featured')[0]), /0 €/);
  /* Soft-Launch: kein Formular (Hinweis und Anfragewege prüft tests/softlaunch.test.mjs) */
  if (SOFT_LAUNCH) { assert.equal(H.byTag(root, 'form').length, 0, 'Soft-Launch: kein Formular'); return; }
  const form = H.byId(root, 'analyze');
  assert.equal(form.attrs.get('action'), '/api/anfrage', 'Formular geht an den API-Worker (Cloudflare-Route /api/*)'); assert.equal(form.attrs.get('method'), 'post');
  assert.deepEqual(H.find(form, e => e.attrs.has('name')).map(e => e.attrs.get('name')), ['action', 'website'], 'nur die Website-Adresse – per POST, nie in einer GET-URL');
});

test('Hero (PO-Entscheidung 12.11.2026): nur Website-Adresse und „Analysieren“, kein Kästchen, keine Google-Weiterleitung; die Bestätigungsseite des Workers hat genau ein Kästchen im Wortlaut von AGB § 4 Abs. 1', { skip: SOFT_LAUNCH_SKIP }, () => {
  const { root } = H.parse(read('public/index.html'));
  const txt = el => H.norm(H.textOf(el));
  const form = H.byId(root, 'analyze');
  assert.equal(H.find(form, e => e.attrs.get('name') === 'action')[0].attrs.get('value'), 'adresse', 'Hero sendet nur die Adresse (Aktion „adresse“)');
  assert.deepEqual(H.find(root, e => e.tag === 'input' && e.attrs.get('type') === 'checkbox'), [], 'kein Kästchen auf der Startseite');
  assert.ok(!/agb_version|bestaetigung|unternehmer|werbung/.test(read('public/index.html')), 'keine Zustimmungsfelder im Hero');
  assert.equal(txt(H.find(form, e => e.tag === 'button')[0]), 'Analysieren', 'primärer CTA exakt „Analysieren“');
  assert.equal(txt(H.byClass(form, 'hero-note')[0]), 'Kostenlose Website-Analyse – 0 €, kein Abo. Datenschutzerklärung');
  /* Fehlertext wie die Antwort des Workers ohne JavaScript */
  const url = H.byId(form, 'url-error');
  assert.ok(url.attrs.has('hidden'), 'url-error zunächst verborgen');
  assert.ok(read('worker/src/app.ts').includes(`'${txt(url)}'`), 'url-error: gleicher Text wie im Worker');
  assert.equal(txt(H.byTag(H.byClass(root, 'hero')[0], 'h1')[0]), 'Sehen Sie, was Ihre Website ausbremst.', 'Original-H1');
  /* Bestätigungsseite (worker/src/view.ts): genau ein Kästchen; sein Wortlaut wird gespeichert und steht wörtlich in AGB § 4 Abs. 1;
     Schaltflächen wie in AGB § 3 Abs. 2 */
  const view = read(VIEW);
  const wortlaut = /^ {2}confirmation: '([^']+)',$/m.exec(view)[1];
  assert.equal(wortlaut, 'Ich handle geschäftlich oder für eine Organisation, akzeptiere die AGB und habe die Datenschutzerklärung zur Kenntnis genommen.');
  assert.equal((view.match(/type="checkbox"/g) || []).length, 1, 'view.ts: genau ein Kästchen');
  assert.ok(!/DECLARATIONS\.(terms|business|marketing)|werbung|Newsletter/.test(view), 'view.ts: keine weiteren Erklärungen, kein Werbe-Opt-in');
  const agb = H.norm(H.textOf(H.byTag(H.parse(read('public/agb.html')).root, 'main')[0]));
  assert.ok(agb.includes(`mit dem Wortlaut „${wortlaut}“`), 'AGB § 4 Abs. 1 nennt genau den Wortlaut');
  /* Die Schaltfläche der Bestätigungsseite heißt in AGB § 3 Abs. 2 und in der Datenschutzerklärung genau wie in view.ts */
  const knopf = /aria-describedby="google-hinweis">([^<]+)<\/button>/.exec(view)[1];
  assert.equal(knopf, 'Mit Google anmelden');
  for (const s of ['klickt auf die Schaltfläche „Analysieren“', 'Seite „Analyse anfragen“', `klickt auf die Schaltfläche „${knopf}“`]) assert.ok(agb.includes(s), `AGB § 3 Abs. 2: „${s}“`);
  const ds = H.norm(H.textOf(H.byTag(H.parse(read('public/datenschutz.html')).root, 'main')[0]));
  assert.ok(ds.includes(`klicken auf „${knopf}“`), 'Datenschutzerklärung nennt dieselbe Schaltfläche');
  assert.ok(![view, agb, ds].some(t => t.includes('Mit Google fortfahren')), 'alte Beschriftung nirgends mehr');
});

/* Ersetzt durch den Test „Startseite gegenüber main“ in tests/softlaunch.test.mjs: Er vergleicht die ganze Startseite bytegenau mit main
   (c69cd1b) und lässt nur einzeln freigegebene Änderungen zu – im Soft-Launch und im Formular-Modus. Dieser ältere Vergleich mit dem Stand
   vor BE-02 kennt die späteren Entscheidungen (Schriften, Partner, Logo, Videos, Rechtstexte) nicht mehr. */
test('Hero-Schutz: gegenüber dem Stand vor BE-02 nur die freigegebenen Zeilen neu, Reihenfolge erhalten; außerhalb des Hero nur die einzeln freigegebenen Änderungen', { skip: 'ersetzt durch tests/softlaunch.test.mjs „Startseite gegenüber main“ (bytegenau, beide Modi)' }, () => {
  const now = read('public/index.html');
  const old = git('show', `${BASE_SHA}:public/index.html`);
  const hero = html => { const i = html.indexOf('<section class="hero">'); return html.slice(i, html.indexOf('</section>', i) + '</section>'.length); };
  const lines = html => hero(html).split('\n').map(l => l.trim());
  const [a, b] = [lines(old), lines(now)];
  /* Es sind sechs Bereiche (Entscheidung des Auftraggebers 03.11.2026): Einleitung und Faktenzeile nennen sechs statt vier */
  assert.deepEqual(a.filter(l => !b.includes(l)), [
    '<p class="lead">Pixelkiez prüft Ihre Website persönlich in vier Bereichen, inklusive GEO &amp; AI Visibility. Den Bericht erhalten Sie kostenlos als PDF mit sieben Seiten per E-Mail.</p>',
    '<button class="btn btn--accent" type="submit">Kostenlos anfragen <svg class="i"><use href="#i-arrow"/></svg></button>',
    '<span><svg class="i"><use href="#i-check"/></svg>Vier Bereiche</span>',
  ], 'entfernt nur der alte Buttontext und die beiden Angaben „vier Bereiche“');
  assert.deepEqual(b.filter(l => !a.includes(l)), [
    '<p class="lead">Pixelkiez prüft Ihre Website persönlich in sechs Bereichen, inklusive GEO &amp; AI Visibility. Den Bericht erhalten Sie kostenlos als PDF mit sieben Seiten per E-Mail.</p>',
    '<input type="hidden" name="agb_version" value="ENTWURF-2026-10-31">',
    '<button class="btn btn--accent" type="submit">Analysieren <svg class="i"><use href="#i-arrow"/></svg></button>',
    '<label class="consent consent--hero"><input id="agb" type="checkbox" name="agb" value="1" required><span>Ich akzeptiere die <a href="agb.html">AGB</a> von 360°Pixelkiez.</span></label>',
    '<p class="form-error" id="agb-error" hidden>Bitte akzeptieren Sie die AGB, damit wir Ihre Website analysieren können.</p>',
    '<p class="hero-note">Kostenlose Website-Analyse – 0 €, kein Abo. <a href="datenschutz.html">Datenschutzerklärung</a></p>',
    '<span><svg class="i"><use href="#i-check"/></svg>Sechs Bereiche</span>',
  ], 'neu nur Häkchen, Fehlertext, Hinweis, Version, Buttontext und „sechs Bereiche“');
  const kept = a.filter(l => b.includes(l));
  assert.deepEqual(b.filter(l => kept.includes(l)), kept, 'Badge, H1, Lead, URL-Feld und Faktenzeile in unveränderter Reihenfolge');
  const outside = html => html.replace(hero(html), '').replace(/<div class="step cw-lilac"><span>02<\/span>.*?<\/div>/, '<SCHRITT-02>');
  /* Kontaktadresse im Footer: 360@pixelkiez.de ersetzt die frühere Adresse (PO-Entscheidung 01.11.2026).
     Eyebrow-Zeilen über den Abschnittsüberschriften entfallen (Entscheidung des Auftraggebers 02.11.2026), sonst nichts */
  const withoutEyebrows = html => html.replace(/^[ \t]*<p class="eyebrow">[^<]*<\/p>\n/gm, '').replace(/<p class="eyebrow">[^<]*<\/p>/g, '');
  assert.ok(!now.includes('class="eyebrow"'), 'Startseite ohne Eyebrow-Zeilen');
  const withWissen = html => html
    .replace('<li><a href="pruefkriterien.html#geo_ai_visibility">GEO &amp; AI Visibility</a></li></ul>', '<li><a href="pruefkriterien.html#geo_ai_visibility">GEO &amp; AI Visibility</a></li><li><a href="wissen/index.html">Wissen</a></li><li><a href="analyse/index.html">Analyse</a></li></ul>')
    /* Menü (Entscheidung des Auftraggebers 03.11.2026): „Analyse“ nur noch als Button rechts, kein zweiter Menüpunkt */
    .replace('      <a href="#faq">FAQ</a>\n', '      <a href="#faq">FAQ</a>\n      <a href="wissen/index.html">Wissen</a>\n');
  /* Entscheidungen des Auftraggebers 02.11.2026 (zweite Runde): „Alle Prüfpunkte nachlesen“ entfällt, dafür der Abschnitt
     „Pixelkiez Score“ in der Mitte; AI-08 (beobachtete KI-Antwort-Stichproben) gestrichen; Bild-Metadaten im Kopf (Canonical,
     Open Graph, Twitter, Icons), Video-Metadaten (JSON-LD) sowie Stylesheet und Skript des Diagramms. Sonst nichts. */
  const KOPF = /\n((?:<link rel="canonical" href="[^"]+">|<meta (?:property="og:[a-z_:]+"|name="twitter:[a-z:]+") content="[^"]*">|<link rel="(?:icon|apple-touch-icon|manifest)" href="[^"]+"(?: type="image\/png")?(?: sizes="[0-9x ]+")?>)\n)+(?=<link rel="preconnect")/;
  assert.match(now, KOPF, 'Kopfdaten für Bilder');
  /* Neu im Kopf: Beiträge zu Wissen (Mega-Menü) und mobiles Menü, beide geprüft im Test „Hauptnavigation“ */
  const MENUES = [/\n      <details class="mega">\n[\s\S]*?\n      <\/details>/, /\n    <details class="nav-menu">\n[\s\S]*?\n    <\/details>/];
  /* Partner-Logos unter dem Video und Pixelkiez-Logo in der Footer-Leiste (Entscheidung des Auftraggebers 03.11.2026), geprüft im Test „Partner“ */
  const PARTNER_NEU = [/  <section class="partner-band"[\s\S]*?<\/section>\n\n/, `      ${PARTNER_LINK}<img class="footer-partner" src="assets/partner/pixelkiez.png" alt="Pixelkiez" width="87" height="20"></a>\n`];
  /* Logo-Zusatz oben „Website-Analyse“ statt „Analyse“ (Entscheidung des Auftraggebers 03.11.2026), geprüft im Test „Hauptnavigation“ */
  const ohneNeues = html => [...MENUES, ...PARTNER_NEU].reduce((s, re) => s.replace(re, ''), html).replace('content="index,follow"', 'content="noindex,nofollow"').replace(KOPF, '\n')
    .replace('    <a class="logo" href="#top">360°<img class="logo-bild" src="media/pixelkiez-logo.webp" alt="Pixelkiez" width="518" height="120" decoding="async"><span>Website-Analyse</span></a>', '    <a class="logo" href="#top">360°Pixelkiez<span>Analyse</span></a>').replace('<link rel="stylesheet" href="assets/donut.css">\n', '')
    .replace(/\n<script type="application\/ld\+json">\{"@context":"https:\/\/schema\.org","@graph":\[\{"@type":"VideoObject".*?<\/script>/, '')
    .replace('\n<script src="assets/donut.js"></script>', '').replace(SCORE_ABSCHNITT, '');
  const ohneAlt = html => html.replace(/  <section class="section" id="tools">\n[\s\S]*?\n  <\/section>\n\n/, '').replace(SCORE_ABSCHNITT, '')
    /* Katalog (pruefkriterien.html) ersetzt durch die Analyse: Button oben rechts, „Methodik ansehen“ und Footer */
    .replace('<a class="btn btn--ghost btn--sm" href="pruefkriterien.html">Katalog</a>', '<a class="btn btn--ghost btn--sm" href="analyse/index.html">Analyse</a>')
    .replace('<a class="btn btn--ghost btn--sm" href="pruefkriterien.html">Methodik ansehen', '<a class="btn btn--ghost btn--sm" href="analyse/methodik.html">Methodik ansehen')
    .replace('<li><a href="pruefkriterien.html">Alle Prüfpunkte</a></li><li><a href="pruefkriterien.html#findability_seo">SEO &amp; Auffindbarkeit</a></li><li><a href="pruefkriterien.html#geo_ai_visibility">GEO &amp; AI Visibility</a></li>',
      '<li><a href="analyse/methodik.html">Methodik</a></li><li><a href="analyse/auffindbarkeit-seo.html">SEO &amp; Auffindbarkeit</a></li><li><a href="analyse/ki-verstaendlichkeit.html">GEO &amp; AI Visibility</a></li>')
    .replace(' KI-Antworten nennen wir nur, wenn wir sie in einer Stichprobe tatsächlich beobachtet haben.', '').replace('<span>beobachtete KI-Antworten</span>', '')
    .replaceAll(' KI-Antworten zeigen wir nur, wenn wir sie in einer datierten Stichprobe tatsächlich beobachtet haben.', '')
    /* Sechs Bereiche; der Bericht bleibt bei sieben Seiten, Seitenangaben je Bereich entfallen */
    .replace('in vier Bereichen: SEO, Performance, GEO &amp; AI Visibility sowie UX, Barrierefreiheit und Vertrauen.', 'in sechs Bereichen: Auffindbarkeit &amp; SEO, Performance &amp; Technik, Nutzerführung, Vertrauen &amp; Datenschutz, Barrierefreiheit sowie KI-Verständlichkeit (GEO &amp; AI Visibility).')
    .replace('</svg>Vier Bereiche inklusive GEO &amp; AI Visibility</li>', '</svg>Sechs Bereiche inklusive GEO &amp; AI Visibility</li>')
    .replace('<p>Seite 6 des Berichts ordnet die Verbesserungen,', '<p>Der Bericht ordnet die Verbesserungen,')
    .replace('je eine Seite pro Bereich', 'die Bereiche im Detail');
  assert.equal(ohneNeues(outside(now)), ohneAlt(withWissen(withoutEyebrows(outside(old)))).replaceAll('kontakt@pixelkiez.de', '360@pixelkiez.de'), 'übrige Startseite unverändert (außer Schritt 02, Kontaktadresse, Eyebrow-Zeilen, Links zu Wissen und Analyse, Menüs, Score-Abschnitt statt Prüfpunkte-Liste, AI-08 und Metadaten)');
  assert.match(now, /<span>02<\/span><h3>AGB akzeptieren und anmelden<\/h3>/);
});

test('AGB-Seite: Fassung 2026-11-12 (ein Kästchen, nur Unternehmer, keine Werbeeinwilligung bei der Anfrage), ohne Platzhalter; Worker führt genau die freigegebenen Fassungen', () => {
  /* PO-Entscheidung 12.11.2026: Bestätigungsseite mit genau einem Kästchen. §§ 3, 4 und 6 Abs. 2 gegenüber der Fassung 2026-11-04 angepasst;
     nur Unternehmer (§ 14 BGB) bleibt, daher weiter ohne Widerrufsbelehrung für Verbraucher */
  const { root } = H.parse(read('public/agb.html'));
  const main = H.norm(H.textOf(H.byTag(root, 'main')[0]));
  assert.ok(main.includes('Stand: 12. November 2026 · Version 2026-11-12'), 'Version');
  assert.ok(!/ENTWURF|in Vorbereitung|Variante|\[|Widerrufsbelehrung|Muster-Widerrufsformular/.test(main), 'keine Entwurfs-, Varianten- oder Verbraucher-Widerrufsreste');
  for (const s of ['ausschließlich an Unternehmer', 'Verbraucher können die Analyse nicht anfragen', 'durch ein einziges, nicht vorausgewähltes Kästchen',
    'Bei der Anfrage wird keine Einwilligung in werbliche E-Mails (§ 6) abgefragt', 'eine solche Einwilligung wird aus ihr auch nicht abgeleitet', 'keine Rechtsberatung', '§ 36 VSBG']) assert.ok(main.includes(s), `AGB: „${s}“`);
  assert.ok(!/drei Kästchen|eigenes Kästchen|Analyse anfragen“;|Kästchentext bei der Anfrage/.test(main), 'keine Reste des Ablaufs mit drei Kästchen');
  assert.deepEqual(H.byClass(root, 'legal-h').map(e => H.norm(H.textOf(e)).split(' ').slice(0, 2).join(' ')), Array.from({ length: 13 }, (_, i) => `§ ${i + 1}`), '§ 1 bis § 13');
  /* Wortlaut AGB 2026-11-12 und Datenschutzerklärung 2026-11-13 vom Auftraggeber am 13.11.2026 freigegeben (Human Gate P1, keine
     anwaltliche Prüfung). Der Worker führt genau die Fassung der jeweiligen Seite; eine neue Fassung läuft wieder erst als ENTWURF
     (Produktion fail closed, config.ts). Die Startseite trägt keine AGB-Version mehr (die Bestätigungsseite zeigt sie). */
  const fassungVon = t => /Stand: [^·]+ · Version (\d{4}-\d{2}-\d{2})/.exec(t)[1];
  const privacyMain = H.norm(H.textOf(H.byTag(H.parse(read('public/datenschutz.html')).root, 'main')[0]));
  assert.equal(/^TERMS_VERSION = "([^"]+)"$/m.exec(read('worker/wrangler.toml'))[1], fassungVon(main));
  assert.equal(/^PRIVACY_VERSION = "([^"]+)"$/m.exec(read('worker/wrangler.toml'))[1], fassungVon(privacyMain));
  assert.ok(!read('public/index.html').includes('agb_version'), 'Startseite ohne AGB-Version');
  assert.ok(read('worker/src/config.ts').includes("(production && /^entwurf/i.test(termsVersion))) missing.push('TERMS_VERSION');"), 'Produktion lehnt AGB-Entwürfe ab');
});

const SCORE_ABSCHNITT = /  <section class="section" id="bereiche">\n[\s\S]*?\n  <\/section>\n/;
test('Wahrheitsgemäße Aussagen: kein Premium/Checkout/Abo/Dashboard/Score, keine Garantien, keine DSGVO-Behauptung, keine Vorschau-Reste', () => {
  for (const page of PAGES) {
    const html = read(page).replace(SCORE_ABSCHNITT, '');
    assert.deepEqual(claimProblems(surfaces(html), ANALYSE.includes(page) ? 'analyse' : INHALT.includes(page) ? 'wissen' : RECHT.includes(page) ? 'recht' : false), [], page);
  }
  /* Startseite: im Abschnitt „Pixelkiez Score“ ist nur „Score“ erlaubt, alle übrigen Regeln gelten */
  const abschnitt = read('public/index.html').match(SCORE_ABSCHNITT)[0];
  assert.deepEqual(claimProblems([['Score-Abschnitt', H.norm(H.visibleText(H.parse(abschnitt).root))]], 'score'), []);
  assert.ok(claimProblems([['Probe', 'Pixelkiez Score mit Garantie und Premium.']], 'score').length >= 2, 'Score-Abschnitt: Garantie und Premium bleiben verboten');
  /* Die Ausnahmen gelten nur für Inhaltsseiten: dieselben Fremdbegriffe bleiben auf Angebotsseiten verboten */
  assert.ok(claimProblems([['Probe', 'Wir prüfen nach WCAG und bieten ein Monitoring pro Monat mit 24 Stunden Vorschau im Checkout.']]).length >= 6);
  assert.ok(claimProblems([['Probe', 'Pixelkiez Score, Premium und Garantie für Rankings.']], 'wissen').length >= 3, 'Wissensseiten: Score, Premium, Garantie bleiben verboten');
  const analyse = claimProblems([['Probe', 'Pixelkiez Score, Premium und Garantie für Rankings.']], 'analyse');
  assert.ok(analyse.length >= 2 && !analyse.some(x => /Score/.test(x.split('(')[0])), 'Analyseseiten: Score erlaubt, Premium und Garantie bleiben verboten');
  assert.ok(claimProblems([['Probe', 'Ihr Pixelkiez Score.']]).length >= 1, 'Angebotsseiten: Score bleibt verboten');
  assert.deepEqual(claimProblems([['view.ts', viewText()]]), []);
  for (const s of ['Kostenlos · 0 € · kein Abonnement', 'Analyse anfragen', 'Mit Google anmelden', 'Wir senden die PDF an die angemeldete Google E-Mail-Adresse.', 'Adresse ändern', 'Vielen Dank für Ihre Anfrage.',
    'Ihre Anfrage ist bei uns eingegangen. Wir melden uns per E-Mail bei Ihnen.']) {
    assert.ok(viewText().includes(s), `view.ts enthält "${s}"`);
  }
  /* PO-Entscheidung 14.11.2026: keine Duplikatsperre, dieselbe Website darf erneut angefragt werden */
  assert.ok(!/bereits angefragt/i.test(viewText()), 'view.ts ohne Duplikat-Zustand');
  /* Eingangsbestätigung: keine zugesagte Lieferfrist, keine Behauptung einer Vertragsannahme */
  assert.ok(!/angenommen|Vertrag|Lieferfrist|Werktag|innerhalb von/i.test(viewText()), 'view.ts: keine Frist, keine behauptete Annahme');
  /* Negativprobe: der alte Stand mit Free/Premium wird erkannt */
  const old = git('show', '98d21094619a53c28f56609ecbef13f94859ae58:index.html');
  const found = claimProblems(surfaces(old)).join('\n');
  for (const s of ['Premium', 'Vorschau']) assert.ok(found.includes(s), `Negativprobe: ${s} nicht erkannt`);
});

test('Website-Name verweist eindeutig auf die kanonische Startseite', () => {
  const { root } = H.parse(read('public/index.html'));
  const entries = H.byTag(root, 'script').filter(s => s.attrs.get('type') === 'application/ld+json').map(s => JSON.parse(s.raw));
  const sites = entries.flatMap(x => x['@graph'] || [x]).filter(x => x['@type'] === 'WebSite');
  assert.equal(sites.length, 1);
  assert.equal(sites[0].name, '360°Pixelkiez');
  assert.equal(sites[0].alternateName, '360.pixelkiez.de');
  assert.equal(sites[0].url, 'https://360.pixelkiez.de/');
  assert.match(read('public/index.html'), /<link rel="canonical" href="https:\/\/360\.pixelkiez\.de\/">/);
});

test('JSON-LD entspricht den sichtbaren FAQ, ohne Angebot oder Preis-Markup', () => {
  const { root } = H.parse(read('public/index.html'));
  const ld = JSON.parse(H.byTag(root, 'script').find(s => s.attrs.get('type') === 'application/ld+json').raw);
  /* Nur der FAQ-Abschnitt: die Menüs im Kopf sind ebenfalls <details> */
  const visible = H.byTag(H.byId(root, 'faq'), 'details').map(d => [H.norm(H.textOf(H.byTag(d, 'summary')[0])), H.norm(H.textOf(H.byTag(d, 'p')[0]))]);
  assert.deepEqual(ld.mainEntity.map(q => [q.name, q.acceptedAnswer.text]), visible);
  assert.ok(!/offers|price|Offer/.test(JSON.stringify(ld)));
});

test('Katalog ersetzt durch die Analyse: keine Katalogseite, keine Verweise darauf; die Analyse-Übersicht führt sechs Prüfbereiche mit zusammen 48 Kriterien', () => {
  /* Entscheidung des Auftraggebers 03.11.2026: pruefkriterien.html entfällt, die Analyse-Seiten enthalten alle Informationen */
  assert.ok(!existsSync(join(ROOT, 'public/pruefkriterien.html')), 'Katalogseite entfernt');
  for (const f of [...PAGES, VIEW]) assert.ok(!/pruefkriterien|>Katalog</.test(read(f)), `${f}: Verweis auf den Katalog`);
  const { root } = H.parse(read('public/analyse/index.html'));
  const legende = H.byTag(H.byClass(root, 'donut-legende')[0], 'a');
  assert.equal(legende.length, 6);
  assert.equal(legende.reduce((n, a) => n + Number(a.attrs.get('data-kriterien')), 0), 48, '48 Prüfkriterien');
  assert.equal(legende.reduce((n, a) => n + Number(a.attrs.get('data-gewicht')), 0), 100, 'Gewichte ergeben 100 %');
  for (const a of legende) assert.ok(existsSync(join(ROOT, 'public/analyse', a.attrs.get('href'))), a.attrs.get('href'));
  /* Startseite: der Button oben rechts führt zur Analyse */
  const nav = H.byTag(H.parse(read('public/index.html')).root, 'nav')[0];
  assert.deepEqual(H.byClass(nav, 'btn').map(a => [a.attrs.get('href'), H.norm(H.textOf(a))]), [['analyse/index.html', 'Analyse']]);
});

test('Hauptnavigation: „Analyse“ nur als Button, Wissen mit Pfeil zu den sechs Beiträgen und „Mehr im Wissensbereich“, mobiles Menü; auf allen Seiten gleich', () => {
  /* Entscheidung des Auftraggebers 03.11.2026: kein doppeltes „Analyse“ im Menü, Mega-Menü für Wissen, Menü-Button mobil */
  const ziel = a => [a.attrs.get('href'), H.norm(H.textOf(a))];
  const beitraege = H.byClass(H.parse(read('public/wissen/index.html')).root, 'karte').map(k => [k.attrs.get('href'), H.norm(H.textOf(H.byClass(k, 'karte-titel')[0]))]);
  assert.equal(beitraege.length, 6, 'sechs Beiträge im Wissensbereich');
  for (const page of PAGES) {
    const rel = page.slice('public/'.length);
    const p = rel === '404.html' ? '/' : rel.includes('/') ? '../' : '';
    const start = rel === 'index.html' ? '' : `${p}index.html`;
    const nav = H.byTag(H.byTag(H.parse(read(page)).root, 'header')[0], 'nav')[0];
    assert.equal(H.norm(H.textOf(H.byTag(H.byClass(nav, 'logo')[0], 'span')[0])), 'Website-Analyse', `${page}: Logo-Zusatz oben`);
    /* Logo oben und im Footer (Auftraggeber 04.11.2026): „360°“ und daneben das Pixelkiez-Logo aus R2, gelesen „360°Pixelkiez“ */
    const logos = H.byClass(H.parse(read(page)).root, 'logo');
    assert.equal(logos.length, 2, `${page}: Logo oben und im Footer`);
    logos.forEach((l, i) => {
      const bild = H.byTag(l, 'img')[0];
      assert.equal(l.children[0]?.text, '360°', `${page}: „360°“ vor dem Logo`);
      assert.deepEqual(['class', 'src', 'alt', 'width', 'height', 'loading'].map(a => bild?.attrs.get(a)), ['logo-bild', `${p}media/pixelkiez-logo.webp`, 'Pixelkiez', '518', '120', i ? 'lazy' : undefined], `${page}: Logo ${i ? 'im Footer (lazy)' : 'oben'}`);
    });
    assert.ok(R2_MEDIEN.some(([pfad, k]) => pfad === '/media/pixelkiez-logo.webp' && R2_BILDER.includes(k)), 'Logo kommt aus R2 (Allowlist der Function)');
    const links = H.byClass(nav, 'nav-links')[0];
    const abschnitte = [['bericht', 'Bericht'], ['bereiche', 'Bereiche'], ['angebot', 'Angebot'], ['faq', 'FAQ']].map(([id, t]) => [`${start}#${id}`, t]);
    const wissen = [`${p}wissen/index.html`, 'Wissen'];
    assert.deepEqual(links.children.filter(e => e.tag === 'a').map(ziel), [...abschnitte, wissen], `${page}: Menüpunkte ohne „Analyse“`);
    const mega = H.byClass(links, 'mega')[0];
    assert.equal(mega?.tag, 'details', `${page}: Beiträge als <details> (auch ohne JavaScript)`);
    assert.equal(H.byTag(mega, 'summary')[0].attrs.get('aria-label'), 'Beiträge im Wissensbereich', `${page}: Pfeil mit Namen`);
    assert.deepEqual(H.byTag(H.byClass(mega, 'mega-panel')[0], 'a').map(ziel), [...beitraege.map(([h, t]) => [`${p}wissen/${h}`, t]), [`${p}wissen/index.html`, 'Mehr im Wissensbereich →']], `${page}: sechs Beiträge und „Mehr im Wissensbereich“`);
    assert.deepEqual(H.byClass(nav, 'btn').map(ziel), [[`${p}analyse/index.html`, 'Analyse']], `${page}: genau ein Button „Analyse“`);
    const menu = H.byClass(nav, 'nav-menu')[0];
    assert.equal(menu?.tag, 'details', `${page}: mobiles Menü als <details>`);
    assert.equal(H.byTag(menu, 'summary')[0].attrs.get('aria-label'), 'Menü', `${page}: Menü-Button mit Namen`);
    assert.deepEqual(H.byTag(menu, 'a').map(ziel), [...abschnitte, wissen], `${page}: Punkte im mobilen Menü`);
    const artikel = beitraege.find(([h]) => `wissen/${h}` === rel);
    const aktuell = rel.startsWith('wissen/') ? [wissen, ...(artikel ? [[`${p}${rel}`, artikel[1]]] : []), wissen] : rel.startsWith('analyse/') ? [[`${p}analyse/index.html`, 'Analyse']] : [];
    assert.deepEqual(H.find(nav, e => e.attrs.get('aria-current') === 'page').map(ziel), aktuell, `${page}: aktueller Bereich markiert`);
  }
  /* Anfrageseiten (view.ts) haben denselben Kopf; verglichen wird das gerenderte Markup im Worker-Test */
  assert.match(read(VIEW), /<details class="mega">[\s\S]*<details class="nav-menu">/);
});

test('Partner: unter dem Hero Pixelkiez und DYAI Studio nebeneinander, ohne Beschriftung (lokale Logos, Alternativtext, neuer Tab); Pixelkiez-Logo unten im Footer jeder Seite', () => {
  /* Entscheidung des Auftraggebers 03.11.2026; hebt die frühere Regel „kein Link zu pixelkiez.de“ für genau diese Partner-Links auf */
  const { root } = H.parse(read('public/index.html'));
  const teile = H.byTag(root, 'main')[0].children.filter(e => e.tag);
  const i = teile.findIndex(e => H.hasClass(e, 'hero'));
  /* P0-Hotfix PXK-159: das Hero-Video direkt unter dem Hero, die Logos darunter */
  assert.deepEqual([teile[i + 1], teile[i + 2], teile[i + 3]].map(e => e.attrs.get('id') || e.attrs.get('class')), ['demo', 'partner-band', 'ablauf'], 'Reihenfolge: Hero, Video, Partner-Logos, Ablauf');
  const band = teile[i + 2];
  assert.equal(H.norm(H.textOf(band)), '', 'kein sichtbares Wort, nur die Logos');
  assert.deepEqual(H.byTag(band, 'a').map(a => { const img = H.byTag(a, 'img')[0]; return [a.attrs.get('href'), a.attrs.get('target'), a.attrs.get('rel'), img.attrs.get('src'), img.attrs.get('alt')]; }), [
    ['https://pixelkiez.de/', '_blank', 'noopener', 'assets/partner/pixelkiez.png', 'Pixelkiez'],
    ['https://studio.dyai.cloud/', '_blank', 'noopener', 'assets/partner/dyai-studio.svg', 'DYAI Studio'],
  ]);
  for (const f of PARTNER_LOGOS) assert.ok(statSync(join(ROOT, 'public', f)).size > 500, f);
  for (const page of PAGES) {
    const { root: seite } = H.parse(read(page));
    const kontakt = H.find(seite, e => e.tag === 'h4' && H.norm(H.textOf(e)) === 'Kontakt')[0];
    assert.deepEqual(H.byTag(kontakt.parent, 'a').map(a => a.attrs.get('href')), ['mailto:360@pixelkiez.de'], `${page}: Footer Kontakt nur mit E-Mail`);
    const leiste = H.byClass(seite, 'footer')[0];
    const p = page === 'public/404.html' ? '/' : page.slice(7).includes('/') ? '../' : '';
    assert.deepEqual(H.byTag(leiste, 'a').filter(a => a.attrs.get('href').startsWith('https:')).map(a => { const img = H.byTag(a, 'img')[0]; return [a.attrs.get('href'), a.attrs.get('target'), a.attrs.get('rel'), img?.attrs.get('src'), img?.attrs.get('alt'), H.norm(H.textOf(a))]; }),
      [['https://pixelkiez.de/', '_blank', 'noopener', `${p}assets/partner/pixelkiez.png`, 'Pixelkiez', '']], `${page}: Pixelkiez-Logo unten im Footer, ohne Text`);
    assert.ok(!/pixelkiez\.de(?!\/")/.test(H.textOf(H.find(seite, e => e.tag === 'footer')[0]).replace('360@pixelkiez.de', '')), `${page}: kein Text „pixelkiez.de“ im Footer`);
  }
  assert.ok(read(VIEW).includes(`      ${PARTNER_LINK}<img class="footer-partner" src="\${b}/assets/partner/pixelkiez.png" alt="Pixelkiez" width="87" height="20"></a>\n`), 'Anfrageseiten: Pixelkiez-Logo im Footer');
  assert.ok(!read(VIEW).includes('>pixelkiez.de</a>'), 'Anfrageseiten: kein Text „pixelkiez.de“');
});

test('Favicon: exakt der Satz des Auftraggebers (favicon.io) – bitgleich, ICO 16/32/48 px, PNGs in ihren Größen, Manifest mit beiden Android-Icons; altes „P°“-Favicon entfernt', () => {
  /* Entscheidung des Auftraggebers 05.11.2026: „exakt dieses Favicon“ aus dem Ordner favicon_io */
  for (const [f, sha] of Object.entries(FAVICONS)) assert.equal(createHash('sha256').update(readFileSync(join(ROOT, 'public', f))).digest('hex'), sha, `${f}: bitgleich zum Ordner favicon_io`);
  const ico = readFileSync(join(ROOT, 'public/favicon.ico'));
  assert.equal(ico.readUInt16LE(4), 3, 'drei Größen im ICO');
  assert.deepEqual([0, 1, 2].map(i => ico[6 + i * 16]), [16, 32, 48]);
  const png = f => { const b = readFileSync(join(ROOT, 'public', f)); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };
  assert.deepEqual(['favicon-16x16.png', 'favicon-32x32.png', 'apple-touch-icon.png', 'android-chrome-192x192.png', 'android-chrome-512x512.png'].map(png), [[16, 16], [32, 32], [180, 180], [192, 192], [512, 512]]);
  const manifest = JSON.parse(read('public/site.webmanifest'));
  assert.deepEqual(manifest.icons.map(i => [i.src, i.sizes]), [['/android-chrome-192x192.png', '192x192'], ['/android-chrome-512x512.png', '512x512']]);
  for (const i of manifest.icons) assert.ok(existsSync(join(ROOT, 'public', i.src)), `${i.src} liegt im Wurzelverzeichnis`);
  for (const f of ['public/assets/favicon.svg', 'public/assets/apple-touch-icon.png']) assert.ok(!existsSync(join(ROOT, f)), `${f}: altes Favicon entfernt`);
});

test('Seitenende: jede Seite lädt anfrage.css; dort kein Überfedern über das Ende (overscroll-behavior-y: none) und Footer über der Home-Leiste', () => {
  /* Mensch 03.11.2026: mobil ließ sich unter den Footer weiterscrollen (leere helle Fläche); Schluss ist unten am Footer */
  const css = read('public/assets/anfrage.css');
  assert.match(css, /^html, body \{ overscroll-behavior-y: none; \}$/m);
  assert.match(css, /^\.footer \{ padding-bottom: calc\(32px \+ env\(safe-area-inset-bottom, 0px\)\); \}$/m);
  for (const page of PAGES) assert.match(read(page), /<link rel="stylesheet" href="[^"]*assets\/anfrage\.css">/, `${page}: lädt anfrage.css`);
});

test('Links: interne Anker gültig, zu pixelkiez.de nur der Partner-Link, sonst nur mailto als externes Ziel (Wissensseiten zusätzlich ihre Quellen)', () => {
  const pages = Object.fromEntries(PAGES.map(p => [p.slice(7), read(p)]));
  for (const [page, html] of Object.entries(pages)) {
    for (const a of H.byTag(H.parse(html).root, 'a')) {
      const href = a.attrs.get('href');
      assert.ok(href && href !== '#', `${page}: Link ohne Ziel "${H.norm(H.textOf(a))}"`);
      if (/^(https?:|mailto:)/.test(href)) {
        /* Wissensseiten belegen ihre Aussagen: https-Quellen nur von den freigegebenen Herausgebern, nie pixelkiez.de */
        const source = /^(wissen|analyse)\//.test(page) && href.startsWith('https://') && SOURCE_HOSTS.includes(new URL(href).hostname);
        assert.ok(EXTERNAL_OK.includes(href) || source, `${page}: externer Link ${href}`);
        continue;
      }
      /* Nur 404.html verlinkt absolut (/…), weil Pages sie für Adressen in beliebiger Tiefe ausliefert */
      assert.ok(page === '404.html' ? href.startsWith('/') : !href.startsWith('/'), `${page}: ${href}`);
      /* Relativ zur Seite auflösen (Wissensseiten liegen in wissen/); ein Verzeichnis meint dessen index.html */
      const url = new URL(href, `https://360.pixelkiez.de/${page}`);
      const [file, frag] = [decodeURIComponent(url.pathname.slice(1)).replace(/(^|\/)$/, '$1index.html'), decodeURIComponent(url.hash.slice(1))];
      const target = file || page;
      assert.ok(pages[target], `${page}: unbekannte Datei ${target}`);
      if (frag) assert.ok(H.byId(H.parse(pages[target]).root, frag), `${page}: Anker ${href} fehlt`);
    }
  }
  /* Auch serverseitig gerenderte Seiten und Konfigurationsvorlagen: zu pixelkiez.de nur der Partner-Link (Startseite, neuer Tab) */
  for (const f of [...PAGES, VIEW, 'worker/wrangler.toml', 'worker/.dev.vars.example', 'wrangler.toml', 'public/_headers', FUNCTION]) {
    assert.ok(!/https?:\/\/(www\.)?pixelkiez\.de/i.test(read(f).replaceAll(PARTNER_LINK, '')), `${f}: Link zu pixelkiez.de außer dem Partner-Link`);
    /* Auch Rechtstexte und Einwilligung: Pixelkiez-Webdesign gehört nicht zu 360°Pixelkiez (Entscheidung des Auftraggebers 04.11.2026) */
    assert.ok(!/Webdesign/i.test(read(f)), `${f}: kein Bezug auf Webdesign`);
  }
});

test('Eigenständige Website 360°Pixelkiez: Name in Titel, Logo und Footer; Impressum, Datenschutz und AGB als eigene Seiten (Fassung 2026-11-04)', () => {
  const view = read(VIEW);
  for (const page of PAGES) {
    const { root } = H.parse(read(page));
    assert.match(H.textOf(H.byTag(root, 'title')[0]), /360°Pixelkiez/, `${page}: Titel`);
    /* Name des Logos wie vorgelesen: Text „360°“ und Alternativtext des Pixelkiez-Logos (Auftraggeber 04.11.2026) */
    const name = l => H.norm(l.children.map(c => c.text ?? (c.tag === 'img' ? c.attrs.get('alt') : H.textOf(c))).join(''));
    assert.ok(H.byClass(root, 'logo').every(l => name(l).startsWith('360°Pixelkiez')), `${page}: Logo`);
    const legal = H.find(root, e => e.tag === 'nav' && e.attrs.get('aria-label') === 'Rechtliches')[0];
    /* relativ zur Seite aufgelöst: auch die Wissensseiten in wissen/ verweisen auf dieselben Rechtsseiten */
    assert.deepEqual(H.byTag(legal, 'a').map(a => new URL(a.attrs.get('href'), `https://360.pixelkiez.de/${page.slice(7)}`).pathname.slice(1)), ['impressum.html', 'datenschutz.html', 'agb.html'], `${page}: Rechtliches (mit AGB, Entscheidung des Auftraggebers 04.11.2026)`);
    assert.match(H.norm(H.textOf(H.byClass(root, 'footer')[0])), /© 2026 360°Pixelkiez/, `${page}: Copyright`);
  }
  assert.match(view, /© 2026 360°Pixelkiez/);
  assert.ok(view.includes('<a href="${b}/impressum.html">Impressum</a><a href="${b}/datenschutz.html">Datenschutz</a>'), 'Anfrageseiten: Impressum und Datenschutz');
  const imprint = H.norm(H.textOf(H.byTag(H.parse(read('public/impressum.html')).root, 'main')[0]));
  for (const s of ['§ 5 Digitale-Dienste-Gesetz (DDG)', 'Vincent Schnetzer', '360°Pixelkiez', 'Edelhofdamm 74', '13465 Berlin', 'Einzelunternehmen', '360@pixelkiez.de', '§ 18 Abs. 2 MStV', 'Verbraucherschlichtungsstelle', 'Stand: 4. November 2026']) {
    assert.ok(imprint.includes(s), `Impressum enthält "${s}"`);
  }
  /* Entscheidung des Auftraggebers 04.11.2026: keine Umsatzsteuer-ID (noch nicht erteilt), keine Platzhalter */
  assert.ok(!/Umsatzsteuer|USt-?Id|Wirtschafts-Identifikationsnummer|Telefon|\[/.test(imprint), 'Impressum ohne USt-ID, W-IdNr., Telefon-Platzhalter');
  const privacy = H.norm(H.textOf(H.byTag(H.parse(read('public/datenschutz.html')).root, 'main')[0]));
  /* Fassung 2026-11-13 (Bestätigungsseite mit einem Kästchen; zur rechtlichen Freigabe): ohne Entwurfsvermerk im Text, ohne Platzhalter */
  assert.ok(privacy.includes('Version 2026-11-13') && !/ENTWURF|in Vorbereitung|\[/.test(privacy), 'Datenschutzerklärung: Fassung 2026-11-13 ohne Entwurfsvermerk und Platzhalter');
  /* Fassung 2026-11-13: keine Aussage über nicht vorhandene Technik. Automatisch löscht nur der Cron die Datenbank (orders.ts purgeOrders);
     Benachrichtigung und Bericht im Postfach werden von Hand gelöscht. Es gibt keinen Newsletter und keine Verteilerliste. */
  assert.ok(privacy.includes('Unsere interne Benachrichtigung über die Anfrage (Abschnitt 9) und den Bericht in unserem Postfach (Abschnitte 10 und 11) löschen wir nicht automatisch, sondern von Hand'), 'Postfach: Löschung von Hand');
  assert.ok(privacy.includes('Derzeit versenden wir keine werblichen E-Mails und keinen Newsletter; eine Verteilerliste besteht nicht.'), 'kein Newsletter, keine Verteilerliste');
  assert.ok(!/Verteilerfunktion|intern, Newsletter|inkl\. Bericht und Nachweis/.test(privacy), 'keine Reste: Newsletter-Verteiler, Bericht als automatisch gelöschte Anfragedaten');
  assert.deepEqual(privacy.match(/\(automatisch\)/g), ['(automatisch)'], 'genau eine automatische Löschfrist (Datenbank)');
  /* Abschnitt 8 beschreibt den tatsächlichen Ablauf: Website-Adresse schon vor der Google-Anmeldung in der Sitzung, nicht an Google;
     keine Werbeeinwilligung bei der Anfrage (Abschnitte 12 und 18) */
  for (const s of ['Wenn Sie auf „Analysieren“ klicken, prüfen wir die eingegebene Website-Adresse und speichern sie in Ihrer serverseitigen Sitzung',
    'Die Website-Adresse wird dabei nicht an Google übermittelt', 'Die Adresse der zu analysierenden Website übermitteln wir dabei nicht an Google',
    'Ihre Bestätigung, dass Sie geschäftlich oder für eine Organisation handeln', 'Bei der Anfrage über diese Website fragen wir keine solche Einwilligung ab',
    'Ihre Bestätigung der AGB ist keine Einwilligung in werbliche E-Mails']) assert.ok(privacy.includes(s), `Datenschutzerklärung: „${s}“`);
  assert.ok(!/Angaben aus den Kästchen|nicht vorangekreuzte Kästchen eingewilligt|ob Sie in werbliche E-Mails eingewilligt haben/.test(privacy), 'keine Reste des Ablaufs mit drei Kästchen');
  /* § 7: Googles Bestätigung (email_verified) belegt bei fremden Domains keinen aktuellen Postfachzugriff – keine Zusicherung des Besitzes */
  assert.ok(!privacy.includes('tatsächlich Ihnen gehört') && privacy.includes('belegt sie nicht in jedem Fall, dass Sie aktuell Zugriff auf das zugehörige Postfach haben'), 'Datenschutz § 7 ohne Besitzzusicherung');
  assert.ok(privacy.includes('Vincent Schnetzer') && privacy.includes('360@pixelkiez.de'), 'Verantwortlicher genannt');
  /* Nennt die tatsächlich genutzten Dienste und Datenflüsse */
  for (const s of ['Cloudflare Pages', 'Cloudflare Workers', 'Cloudflare-D1-Datenbank', 'Jurisdiktionsbeschränkung „Europäische Union“', 'Google Ireland Limited', '`openid` und `email`'.replaceAll('`', ''), 'Resend', 'Hostinger International Ltd.', '__Host-pxwa', 'HMAC', 'Berliner Beauftragte für Datenschutz']) {
    assert.ok(privacy.includes(s), `Datenschutzerklärung nennt "${s}"`);
  }
  /* Schriften kommen von dieser Website; Analysewerkzeuge werden nicht genannt (Entscheidung des Auftraggebers 04.11.2026) */
  assert.ok(!/Google Fonts|fonts\.googleapis|PageSpeed|Lighthouse|KI-Sprachmodell/.test(privacy), 'keine Google-Fonts-Angabe, keine Werkzeugliste');
  assert.ok(!/Railway|Hostinger-PHP|Supabase/.test(privacy), 'keine verworfenen Dienste');
});

/* Breite und Höhe eines JPEG aus dem SOF-Segment */
function jpegSize(buf) {
  for (let i = 2; i < buf.length - 9;) {
    if (buf[i] !== 0xFF) return null;
    const marker = buf[i + 1], len = buf.readUInt16BE(i + 2);
    if (marker >= 0xC0 && marker <= 0xCF && ![0xC4, 0xC8, 0xCC].includes(marker)) return [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)];
    i += 2 + len;
  }
  return null;
}

test('Unterseiten (Wissen, Analyse): Häufige Fragen und Weiterlesen im Stil der Startseite; keine Kopfzeile mit Zahlen, keine Datumszeilen bei Quellen, keine nummerierten Listen', () => {
  for (const page of INHALT) {
    const html = read(page);
    const { root } = H.parse(html);
    const txt = el => H.norm(H.textOf(el));
    /* Häufige Fragen: Überschrift links, aufklappbare Fragen mit Plus-Symbol rechts – wie „Gut zu wissen.“ auf der Startseite */
    const grid = H.byClass(root, 'faq-grid');
    assert.equal(grid.length, 1, `${page}: ein FAQ-Abschnitt`);
    assert.equal(txt(H.byTag(H.byClass(grid[0], 'section-head')[0], 'h2')[0]), 'Häufige Fragen.', page);
    const details = H.byTag(H.byClass(grid[0], 'faq')[0], 'details');
    assert.ok(details.length >= 3, `${page}: mindestens drei Fragen`);
    for (const d of details) assert.equal(H.byClass(H.byTag(d, 'summary')[0], 'plus').length, 1, `${page}: Plus-Symbol`);
    /* Strukturierte Daten entsprechen den sichtbaren Fragen */
    const graph = H.byTag(root, 'script').filter(x => x.attrs.get('type') === 'application/ld+json').flatMap(x => JSON.parse(x.raw)['@graph'] || []);
    const faq = graph.find(n => n['@type'] === 'FAQPage');
    const visible = details.map(d => { const q = H.byTag(d, 'summary')[0]; return [H.norm(H.textOf(q)), txt(H.byTag(d, 'p')[0])]; });
    assert.deepEqual(faq.mainEntity.map(q => [q.name, q.acceptedAnswer.text]), visible, `${page}: FAQ-JSON-LD`);
    /* Weiterlesen (Artikel): Linkliste der Startseite mit Titel, Satz und Pfeil */
    if (!page.endsWith('/index.html')) {
      const tools = H.byClass(root, 'tools');
      assert.equal(tools.length, 1, `${page}: Weiterlesen`);
      assert.ok(H.byClass(tools[0], 'tool').length >= 2 && H.byClass(tools[0], 'tool').every(a => a.tag === 'a' && H.byTag(a, 'b').length === 1), page);
    }
    /* Entscheidung des Auftraggebers 02.11.2026: keine Zahlen mit Text unter dem Titel, keine Datumszeilen bei Quellen,
       keine nummerierten Listen im Text; das Inhaltsverzeichnis kommt ohne Nummern aus */
    for (const c of ['kopf-meta', 'q-stand', 'fragen', 'weiter']) assert.ok(!H.byClass(root, c).length, `${page}: .${c}`);
    /* Wissen-Übersicht: Karten ohne Nummern und ohne orangefarbene Zeile darüber (Entscheidung des Auftraggebers 03.11.2026) */
    if (page === 'public/wissen/index.html') assert.equal(H.byClass(root, 'karte-nr').length, 0, 'Wissen-Karten ohne Nummern');
    for (const art of H.byClass(root, 'lesetext')) assert.equal(H.byTag(art, 'ol').length, 0, `${page}: nummerierte Liste im Text`);
    for (const toc of H.byClass(root, 'toc')) assert.equal(H.byTag(toc, 'ol').length, 0, `${page}: Inhaltsverzeichnis ohne Nummern`);
    assert.ok(!/Stand der Quellenprüfung|Quellenstand|Seitenstand|Min\. Lesezeit|Beobachtete KI-Antwort-Stichproben/.test(html), `${page}: Datums- oder Zahlenzeile`);
    assert.ok(!H.find(root, e => /^h[23]$/.test(e.tag) && /^\d+\.\s/.test(txt(e))).length, `${page}: nummerierte Überschrift`);
  }
});

test('Bild-Metadaten: Titelbild je Seite (Open Graph, Twitter, JSON-LD), Icons, Alternativtexte der Illustrationen, Poster, Video-Metadaten', () => {
  const BASE = 'https://360.pixelkiez.de';
  for (const page of PAGES) {
    const html = read(page);
    const { root } = H.parse(html);
    const head = H.byTag(root, 'head')[0];
    const meta = k => H.byTag(head, 'meta').find(m => m.attrs.get('property') === k || m.attrs.get('name') === k)?.attrs.get('content');
    const links = H.byTag(head, 'link');
    /* Icons auf jeder Seite, auch 404 (dort absolut) */
    const icons = links.filter(l => ['icon', 'apple-touch-icon', 'manifest'].includes(l.attrs.get('rel'))).map(l => ['rel', 'href', 'type', 'sizes'].map(a => l.attrs.get(a)));
    const pre = page === 'public/404.html' ? '/' : page.split('/').length > 2 ? '../' : '';
    assert.deepEqual(icons, [['icon', `${pre}favicon.ico`, undefined, '16x16 32x32 48x48'], ['icon', `${pre}favicon-32x32.png`, 'image/png', '32x32'], ['icon', `${pre}favicon-16x16.png`, 'image/png', '16x16'],
      ['apple-touch-icon', `${pre}apple-touch-icon.png`, undefined, '180x180'], ['manifest', `${pre}site.webmanifest`, undefined, undefined]], `${page}: Favicon-Satz`);
    if (page === 'public/404.html') { assert.equal(meta('og:image'), undefined, '404 ohne Titelbild'); continue; }
    /* Canonical und Open Graph passen zusammen; Titelbild existiert, ist 1200×630 und trägt Beschreibung und Copyright */
    const canonical = links.find(l => l.attrs.get('rel') === 'canonical')?.attrs.get('href');
    assert.ok(canonical?.startsWith(BASE + '/') && meta('og:url') === canonical, `${page}: Canonical = og:url`);
    for (const k of ['og:type', 'og:title', 'og:description', 'og:site_name', 'og:locale']) assert.ok(meta(k), `${page}: ${k}`);
    const img = meta('og:image');
    assert.match(img, /^https:\/\/360\.pixelkiez\.de\/assets\/og\/[a-z0-9-]+\.jpg$/, `${page}: og:image`);
    const buf = readFileSync(join(ROOT, 'public', img.slice(BASE.length + 1)));
    assert.deepEqual(jpegSize(buf), [1200, 630], `${page}: Titelbild 1200×630`);
    assert.deepEqual([meta('og:image:width'), meta('og:image:height'), meta('og:image:type')], ['1200', '630', 'image/jpeg'], page);
    assert.ok(meta('og:image:alt')?.length > 20 && meta('twitter:image:alt') === meta('og:image:alt'), `${page}: Bildbeschreibung`);
    assert.ok(meta('twitter:card') === 'summary_large_image' && meta('twitter:image') === img, `${page}: Twitter`);
    assert.ok(buf.includes(Buffer.from('© 2026 360°Pixelkiez')) && buf.includes(Buffer.from('Titelbild')), `${page}: Copyright und Beschreibung in der Bilddatei`);
    /* Strukturierte Daten der Inhaltsseiten nennen dasselbe Titelbild */
    if (INHALT.includes(page)) {
      const graph = H.byTag(root, 'script').filter(x => x.attrs.get('type') === 'application/ld+json').flatMap(x => JSON.parse(x.raw)['@graph'] || []);
      const main = graph.find(n => ['Article', 'CollectionPage'].includes(n['@type']));
      assert.deepEqual(main.image, { '@type': 'ImageObject', url: img, width: 1200, height: 630 }, `${page}: JSON-LD image`);
    }
    /* Illustrationen: Bild mit Alternativtext; Vorschaubilder in Karten und das Diagramm (mit Legende als Text) sind dekorativ */
    for (const svg of H.byTag(H.byTag(root, 'body')[0], 'svg')) {
      if (H.find(root, e => H.hasClass(e, 'szene-bild') && H.find(e, x => x === svg).length).length) {
        assert.ok(svg.attrs.get('role') === 'img' && svg.attrs.get('aria-label')?.startsWith('Illustration: '), `${page}: Illustration ohne Alternativtext`);
      } else {
        const hidden = n => n && (n.attrs?.get('aria-hidden') === 'true' || hidden(n.parent));
        assert.ok(hidden(svg) || H.hasClass(svg, 'i') || H.hasClass(svg, 'sr-only'), `${page}: SVG ohne Alternativtext und nicht dekorativ`);
      }
    }
  }
  for (const f of Object.keys(FAVICONS)) assert.ok(statSync(join(ROOT, 'public', f)).size > 200, f);
  /* Alle JPEGs (Titelbilder, Poster) mit XMP-Block (Titel, Beschreibung, Urheber, Copyright). Die Videos liegen in R2 (nicht im Repository);
     ihre Dateien prüft tests/pages.test.mjs (Größe, SHA-256, Faststart) */
  for (const f of [...OG.map(n => `assets/og/${n}.jpg`), ...MEDIA.filter(m => m.endsWith('.jpg'))]) {
    const buf = readFileSync(join(ROOT, 'public', f));
    for (const s of ['http://ns.adobe.com/xap/1.0/', '<dc:creator><rdf:Seq><rdf:li>360°Pixelkiez</rdf:li>', '© 2026 360°Pixelkiez', '<dc:title>', '<dc:description>']) assert.ok(buf.includes(Buffer.from(s)), `${f}: ${s}`);
  }
  /* Videos der Startseite: Beschriftung, Poster, Maße und passende Video-Metadaten */
  const { root } = H.parse(read('public/index.html'));
  const ld = H.byTag(root, 'script').filter(x => x.attrs.get('type') === 'application/ld+json').map(x => JSON.parse(x.raw));
  const vids = ld.flatMap(x => x['@graph'] || []).filter(n => n['@type'] === 'VideoObject');
  const videos = H.byTag(root, 'video');
  for (const v of videos) {
    assert.ok(v.attrs.get('aria-label') && v.attrs.get('width') && v.attrs.get('height'), 'Video beschriftet und mit Maßen');
    assert.ok(MEDIA.includes(v.attrs.get('poster')), `Poster ${v.attrs.get('poster')} versioniert`);
    assert.equal(jpegSize(readFileSync(join(ROOT, 'public', v.attrs.get('poster')))).join('x'), `${v.attrs.get('width')}x${v.attrs.get('height')}`, 'Poster so groß wie das Video');
  }
  /* Video-Metadaten (VideoObject) für jedes eingebundene Video, auch im Soft-Launch (Entscheidung des Auftraggebers 04.11.2026) */
  assert.equal(vids.length, videos.length);
  videos.forEach((v, i) => {
    assert.ok(v.attrs.get('aria-label') && v.attrs.get('width') && v.attrs.get('height'), 'Video beschriftet und mit Maßen');
    assert.equal(vids[i].thumbnailUrl, `${BASE}/${v.attrs.get('poster')}`);
    assert.equal(vids[i].contentUrl, `${BASE}/${H.byTag(v, 'source')[0].attrs.get('src')}`);
    assert.deepEqual([String(vids[i].width), String(vids[i].height)], [v.attrs.get('width'), v.attrs.get('height')]);
    assert.ok(vids[i].name && vids[i].description && /^PT\d+S$/.test(vids[i].duration) && vids[i].uploadDate, 'Name, Beschreibung, Dauer, Datum');
    assert.equal(vids[i].description, v.attrs.get('aria-label'), 'Beschreibung gleich dem Alternativtext');
    assert.deepEqual([vids[i].inLanguage, vids[i].publisher?.name], ['de-DE', '360°Pixelkiez']);
  });
  /* Hintergrundbild „Für alle, die eine Website verantworten.“ (Auftraggeber 04.11.2026): WebP aus R2 (pictures/), dekorativ
     (alt=""), mit Maßen, lazy; ImageObject mit Beschreibung, Maßen und der KI-Herkunft (schema.org digitalSourceType) */
  const bilder = H.byTag(root, 'img').filter(i => i.attrs.get('class') === 'section-bild');
  assert.equal(bilder.length, 1, 'genau ein Hintergrundbild');
  const bild = bilder[0];
  assert.deepEqual(['src', 'width', 'height', 'alt', 'loading', 'decoding'].map(a => bild.attrs.get(a)),
    ['media/360-pixelkiez-designrunde-am-tisch.webp', '1672', '941', '', 'lazy', 'async'], 'Bild: Quelle, Maße, dekorativ, lazy');
  assert.equal(H.find(root, e => e.tag === 'section' && H.find(e, x => x === bild).length)[0].attrs.get('id'), 'fuer-wen', 'Bild im Abschnitt „Für alle …“');
  assert.ok(R2_MEDIEN.some(([p, k]) => p === '/' + bild.attrs.get('src') && R2_BILDER.includes(k)), 'Bild kommt aus R2 (Allowlist der Function)');
  const imgs = ld.flatMap(x => x['@graph'] || []).filter(n => n['@type'] === 'ImageObject');
  assert.equal(imgs.length, 1, 'ImageObject für das Hintergrundbild');
  assert.deepEqual([imgs[0].contentUrl, String(imgs[0].width), String(imgs[0].height), imgs[0].encodingFormat, imgs[0].inLanguage, imgs[0].creditText, imgs[0].creator?.name],
    [`${BASE}/${bild.attrs.get('src')}`, '1672', '941', 'image/webp', 'de-DE', '360°Pixelkiez', '360°Pixelkiez']);
  assert.equal(imgs[0].digitalSourceType, 'https://schema.org/TrainedAlgorithmicMediaDigitalSource', 'KI-Herkunft maschinenlesbar');
  assert.ok(imgs[0].name && imgs[0].description && imgs[0].uploadDate, 'Name, Beschreibung, Datum');
  /* Bild-Metadaten der Google Search Console (06.11.2026): Rechtehinweis nur mit dem Namen (ohne ©, KI-Bild; Entscheidung des Auftraggebers), Lizenz = Abschnitt „Urheberrecht“ im Impressum */
  assert.deepEqual([imgs[0].copyrightNotice, imgs[0].license, imgs[0].acquireLicensePage],
    ['360°Pixelkiez', `${BASE}/impressum`, `${BASE}/impressum`], 'copyrightNotice, license, acquireLicensePage');
  assert.match(read('public/impressum.html'), /<h2 class="legal-h">Urheberrecht<\/h2>/, 'Lizenzseite enthält den Abschnitt „Urheberrecht“');
});

test('Design: styles.css unverändert gegenüber vision.html; alle verwendeten Klassen sind definiert', () => {
  const inline = H.byTag(H.parse(read('vision.html')).root, 'style')[0].raw;
  const strip = s => s.split('\n').map(l => l.replace(/\s+$/, '')).join('\n').trim();
  assert.equal(strip(read('public/assets/styles.css')), strip(inline), 'Design-Quelle unverändert');
  const css = read('public/assets/styles.css') + read('public/assets/anfrage.css') + read('public/assets/inhalt.css') + read('public/assets/donut.css');
  const classes = new Set();
  for (const p of PAGES) for (const e of H.elements(H.byTag(H.parse(read(p)).root, 'body')[0])) for (const c of (e.attrs.get('class') || '').split(/\s+/).filter(Boolean)) classes.add(c);
  for (const m of read(VIEW).matchAll(/class="([^"]+)"/g)) for (const c of m[1].split(/\s+/)) classes.add(c);
  const unknown = [...classes].filter(c => !new RegExp(`\\.${c.replace(/-/g, '\\-')}(?![\\w-])`).test(css));
  assert.deepEqual(unknown, []);
});

test('Release-Grenze Website (Cloudflare Pages): Konfiguration nur für Pages, Functions nur unter /api/* und für drei Videos aus R2, Sicherheits-Header, keine Railway- oder PHP-Reste', () => {
  assert.deepEqual(artifactFiles(), ['404.html', '_headers', '_routes.json', 'agb.html', ...ASSETS, ...FONT_FILES, ...BILDER, 'datenschutz.html', 'impressum.html', 'index.html', 'sitemap.xml', ...MEDIA, ...INHALT.map(p => p.slice(7))].sort());
  assert.deepEqual(repoFiles().filter(f => /\.(php|phtml)$|(^|\/)\.htaccess$|^(server|bin)\/|railway|Dockerfile|Caddyfile|\.dockerignore/i.test(f)), [], 'keine PHP-, Railway- oder Docker-Bestandteile');
  const pages = read('wrangler.toml');
  const active = pages.split('\n').filter(l => !l.trim().startsWith('#')).join('\n');
  assert.match(active, /^name = "pxwa"$/m);
  assert.match(active, /^pages_build_output_dir = "\.\/public"$/m);
  assert.ok(!/^\s*main\s*=/m.test(active), 'kein Worker-Einstiegspunkt in der Pages-Konfiguration');
  /* Service Binding API nur für die Produktion; Vorschau-Deployments erreichen weder Worker noch D1. Im Soft-Launch gar keins. */
  assert.ok(!/^\[\[services\]\]/m.test(active), 'kein API-Service-Binding für Vorschau-Deployments');
  if (SOFT_LAUNCH) assert.ok(!/services\]\]/.test(active), 'Soft-Launch: kein API-Service-Binding');
  else assert.match(active, /^\[\[env\.production\.services\]\]\nbinding = "API"\nservice = "pxwa-api"$/m, 'Produktion: Service Binding API → pxwa-api');
  assert.match(active, /^compatibility_date = "2026-07-30"$/m, 'Vorschau: bisheriges Kompatibilitätsdatum');
  assert.match(active, /^\[env\.production\]\ncompatibility_date = "2026-11-01"$/m, 'Produktion: bisheriges Kompatibilitätsdatum');
  assert.match(active, /^\[\[r2_buckets\]\]\nbinding = "MEDIA"\nbucket_name = "360pixelkiez"$/m, 'bestehendes R2-Binding für Vorschau');
  assert.match(active, /^\[\[env\.production\.r2_buckets\]\]\nbinding = "MEDIA"\nbucket_name = "360pixelkiez"$/m, 'bestehendes R2-Binding für Produktion');
  assert.equal((active.match(/r2_buckets/g) || []).length, 2, 'genau die beiden bestehenden R2-Bindings');
  assert.ok(!/\[vars\]|d1_databases|kv_namespaces|SECRET|TOKEN|remote\s*=|preview_bucket_name|jurisdiction/i.test(active), 'Website ohne Variablen, Secrets oder weiteren Speicher');
  assert.equal(read('worker/wrangler.toml').match(/^compatibility_date = .*$/m)[0], active.match(/^compatibility_date = .*$/m)[0], 'gleiches Kompatibilitätsdatum');
  const headers = read('public/_headers');
  for (const h of ['Strict-Transport-Security: max-age=31536000', 'X-Content-Type-Options: nosniff', 'X-Frame-Options: DENY', "Content-Security-Policy: frame-ancestors 'none'",
    'Referrer-Policy: strict-origin-when-cross-origin', 'Cross-Origin-Opener-Policy: same-origin', 'Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()', '! Access-Control-Allow-Origin']) {
    assert.ok(headers.includes(`\n  ${h}\n`), `_headers: ${h}`);
  }
  assert.match(headers, /^https:\/\/:project\.pages\.dev\/\*\n {2}X-Robots-Tag: noindex$/m, '*.pages.dev wird nicht indexiert');
  assert.match(read('public/404.html'), /<meta name="robots" content="noindex,nofollow">/, 'Fehlerseite bleibt ausgeschlossen');
  const indexable = PAGES.filter(page => page !== 'public/404.html');
  for (const page of indexable) assert.match(read(page), /<meta name="robots" content="index,follow">/, `${page}: Indexierung erlaubt`);
  const canonicals = indexable.map(page => read(page).match(/<link rel="canonical" href="([^"]+)">/)?.[1]).sort();
  const sitemap = read('public/sitemap.xml');
  assert.match(sitemap, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  const locations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]).sort();
  assert.equal(new Set(locations).size, locations.length, 'Sitemap ohne Duplikate');
  assert.deepEqual(locations, canonicals, 'Sitemap enthält genau die kanonischen öffentlichen Seiten');
  const fn = read(FUNCTION);
  assert.match(fn, /return await env\.API\.fetch\(new Request\(request, \{ redirect: 'manual' \}\)\);/, 'Weitergabe der Original-Anfrage ohne Verfolgen von Weiterleitungen');
  assert.match(fn, /if \(!env\.API\) return unavailable\(\);/);
  const code = fn.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  assert.ok(!/console\.|\bfetch\(|env\.ASSETS|next\(/.test(code.replace('env.API.fetch(', '')), 'keine Logs, keine weiteren Aufrufe, kein Rückfall auf statische Dateien');
  for (const f of ['.dev.vars', 'worker/.dev.vars', '.wrangler/state/v3/d1/x.sqlite', 'node_modules/x', '360-pixelkiez-video-1080p-website-look.mp4', 'public/media/anderes-video.mp4', 'public/media/entwurf.jpg',
    ...R2_MEDIEN.map(([p]) => `public${p}`), 'public/media/360-pixelkiez-video-poster.jpg', 'public/media/report-pdf-de-1x1.mp4']) {
    assert.equal(spawnSync('git', ['check-ignore', '-q', f], { cwd: ROOT }).status, 0, `${f} ist ignoriert`);
  }
  /* Genau die drei Poster sind versioniert, die Videos nie (sie liegen in R2; frischer Checkout: tests/release.test.mjs) */
  for (const f of MEDIA) assert.equal(spawnSync('git', ['check-ignore', '-q', 'public/' + f], { cwd: ROOT }).status, 1, `public/${f} ist nicht ignoriert`);
  /* Video-Function: nur drei feste Pfade → feste R2-Schlüssel, nur das Binding MEDIA, nur lesen (head/get), keine Logs, kein Abruf */
  const media = read(MEDIA_FUNCTION);
  const mediaCode = media.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  assert.deepEqual([...mediaCode.matchAll(/\['(\/media\/[^']*)', '([^']*)'\]/g)].map(m => [m[1], m[2]]), R2_MEDIEN, 'Allowlist: Pfad → R2-Schlüssel');
  assert.match(mediaCode, /const key = MEDIEN\.get\(url\.pathname\);\n\s*if \(key === undefined\) return next\(\);/, 'Schlüssel nur aus der Allowlist, sonst statisch');
  assert.deepEqual([...mediaCode.matchAll(/\bbucket\.(\w+)\(/g)].map(m => m[1]), ['head', 'get'], 'R2 nur lesen: head und get, kein list/put/delete');
  assert.deepEqual([...mediaCode.matchAll(/\bbucket\.(?:head|get)\((\w+)[,)]/g)].map(m => m[1]), ['key', 'key'], 'gelesen wird nur der feste Schlüssel');
  assert.ok(!/\bfetch\(|console\.|caches\.|Set-Cookie|env\.(?!MEDIA\b)\w+|createMultipartUpload/i.test(mediaCode), 'kein Abruf, keine Logs, kein Cache, keine Cookies, keine weiteren Bindings');
  assert.deepEqual(mediaCode.match(/.*\benv\.MEDIA\b.*/g).map(l => l.trim()), ['const bucket = env.MEDIA;'], 'R2 nur über bucket (head/get, siehe oben), nie direkt');
  assert.match(mediaCode, /const TYPEN: Readonly<Record<string, string>> = \{ mp4: 'video\/mp4', webp: 'image\/webp' \};/, 'feste Content-Types je Endung');
  assert.match(mediaCode, /headers\.set\('Content-Type', TYPEN\[key\.slice\(key\.lastIndexOf\('\.'\) \+ 1\)\] \?\? 'application\/octet-stream'\);/, 'fester Content-Type nach Endung, nicht aus den R2-Metadaten');
  assert.ok(!/httpMetadata|writeHttpMetadata|customMetadata/.test(mediaCode), 'keine Metadaten aus dem Bucket in der Antwort');
  assert.deepEqual(JSON.parse(read('public/_routes.json')).include, ['/api/*', ...R2_MEDIEN.map(([p]) => p)], 'Poster bleiben statisch');
});

test('Release-Scan des Pages-Uploads (public/ wie `wrangler pages deploy`): nur Website-Dateien, keine Quellen, kein PHP/Railway, keine Secrets, höchstens 25 MiB je Datei', () => {
  const files = uploadFiles();
  assert.deepEqual(files.filter(f => !f.startsWith('media/')), ['404.html', 'agb.html', ...ASSETS, ...FONT_FILES, ...BILDER, 'datenschutz.html', 'impressum.html', 'index.html', 'sitemap.xml',
    ...INHALT.map(p => p.slice(7))].sort());
  assert.ok(files.filter(f => f.startsWith('media/')).every(f => /^media\/[\w-]+\.(mp4|jpg)$/.test(f)), 'in media/ nur Videos und Poster');
  assert.ok(files.length < 20000);
  for (const f of files) {
    const buf = readFileSync(join(ROOT, 'public', f));
    assert.ok(buf.length <= 25 * 1024 * 1024, `${f}: über 25 MiB`);
    if (/\.(mp4|jpg|png|ico|woff2)$/.test(f)) continue;
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
  assert.match(active, /^MAIL_FROM = "anfrage@360\.pixelkiez\.de"$/m, 'freigegebener Absender auf der verifizierten Versanddomain');
  /* Rechtstexte (AGB 2026-11-12, Datenschutzerklärung 2026-11-13; Bestätigungsseite mit einem Kästchen): Wortlaut vom Auftraggeber am
     13.11.2026 freigegeben, Aktivierungs-Commit */
  assert.match(active, /^PRIVACY_VERSION = "2026-11-13"$/m, 'Datenschutzerklärung 2026-11-13 freigegeben');
  assert.match(active, /^TERMS_VERSION = "2026-11-12"$/m, 'AGB 2026-11-12 freigegeben');
  assert.match(active, /^MAIL_NOTIFY_TO = "360@pixelkiez\.de"$/m);
  /* Entscheidung des Auftraggebers 04.11.2026: Anfragedaten vier Monate nach Eingang löschen (Datenschutzerklärung Abschnitte 8 und 16) */
  assert.match(active, /^ORDER_RETENTION_DAYS = "120"$/m, 'Löschfrist vier Monate');
  /* PXK-155: bis zur eigenen Release-Freigabe nur freigeschaltete Testkonten (Liste als Secret, nie im Repository) */
  assert.match(active, /^ACCESS_MODE = "testnutzer"$/m, 'kontrollierter Test, kein öffentlicher Auftragseingang');
  /* Betriebsprotokoll nur mit eigenen Meldungen, ohne automatische Aufrufprotokolle (Datenschutzerklärung Abschnitt 5) */
  assert.match(active, /^\[observability\.logs\]\ninvocation_logs = false$/m, 'keine Aufrufprotokolle mit Anfrage-Metadaten');
  const config = read('worker/src/config.ts');
  assert.match(config, /export const AUTHORIZED_MAIL_API_HOSTS: readonly string\[\] = \['api\.resend\.com'\];/);
  assert.match(config, /export const AUTHORIZED_MAIL_FROM_DOMAINS: readonly string\[\] = \['360\.pixelkiez\.de'\];/);
  assert.match(config, /export const PRODUCTION_BASE_URL = 'https:\/\/360\.pixelkiez\.de';/);
  assert.match(config, /export const PRODUCTION_NOTIFY_TO = '360@pixelkiez\.de';/, 'fester interner Empfänger in Produktion');
  /* Einzige Adresse ist 360@pixelkiez.de: Die frühere Adresse steht weder in ausgelieferten Seiten noch im Worker oder in der
     Konfiguration (kein versteckter Rückfall, keine Doppelzustellung). */
  for (const f of [...PAGES, ...WORKER_SRC, 'worker/wrangler.toml', 'worker/.dev.vars.example', 'wrangler.toml', FUNCTION, MEDIA_FUNCTION, 'public/_headers', 'public/assets/app.js']) {
    assert.ok(!/kontakt@pixelkiez\.de/i.test(read(f)), `${f}: keine frühere Adresse kontakt@pixelkiez.de`);
  }
  /* Einzige eigene Adresse ist 360@pixelkiez.de; die Datenschutzerklärung nennt zusätzlich die Aufsichtsbehörde (Art. 77 DSGVO) */
  const adressen = f => [...read(f).matchAll(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi)].map(m => m[0]).filter(a => !(f === 'public/datenschutz.html' && a === 'mailbox@datenschutz-berlin.de'));
  assert.deepEqual([...new Set([...PAGES, VIEW].flatMap(adressen))], ['360@pixelkiez.de'], 'einzige Mailadresse auf der Website');
});

test('D1-Schema: nur die nötigen Tabellen und Spalten (Datenminimierung), keine Tokens, keine IP-Adressen; Migrationen 0002 und 0003 rein additiv', () => {
  const sql = MIGRATIONS.join('\n');
  const tables = Object.fromEntries([...sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\);/g)].map(([, name, body]) => [name,
    body.split('\n').map(l => l.trim().split(/\s+/)[0]).filter(c => c && !['PRIMARY'].includes(c))]));
  for (const [, table, column] of sql.matchAll(/^ALTER TABLE (\w+) ADD COLUMN (\w+)/gm)) tables[table].push(column);
  assert.equal(MIGRATIONS.length, 3);
  const statementsOf = m => m.replace(/^\s*--.*$/gm, '').split(';').map(x => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
  assert.deepEqual(statementsOf(MIGRATIONS[1]), ['ALTER TABLE orders ADD COLUMN terms_version TEXT NULL', 'ALTER TABLE orders ADD COLUMN terms_accepted_at TEXT NULL'], '0002: nur neue Spalten, kein DROP/UPDATE/DELETE');
  /* 0003 (Rechtstexte 2026-11-04): Nachweis der Erklärungen je Auftrag, eigene Tabelle für Werbeeinwilligungen – nur hinzufügen */
  assert.ok(statementsOf(MIGRATIONS[2]).every(x => /^(ALTER TABLE orders ADD COLUMN|CREATE TABLE IF NOT EXISTS marketing_consents|CREATE INDEX IF NOT EXISTS)/.test(x)), '0003: nur neue Spalten, Tabelle und Index');
  assert.deepEqual(tables, {
    orders: ['id', 'reference', 'idempotency_key', 'google_sub', 'email', 'website_url', 'privacy_version', 'status', 'created_at', 'terms_version', 'terms_accepted_at', 'business_confirmed', 'marketing_consent', 'declarations'],
    notifications: ['id', 'order_id', 'status', 'attempts', 'next_attempt_at', 'locked_until', 'last_error', 'sent_at', 'created_at'],
    rate_limits: ['bucket', 'window_start', 'hits'],
    sessions: ['id_hash', 'data', 'version', 'created_at', 'expires_at'],
    /* Werbeeinwilligung bis zum Widerruf, ohne Website-Adresse (Datenschutzerklärung Abschnitt 12) */
    marketing_consents: ['id', 'google_sub', 'email', 'wording', 'privacy_version', 'given_at', 'order_reference', 'revoked_at'],
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
  assert.ok(!/^\s*(GOOGLE_CLIENT_SECRET|SECRET|MAIL_API_TOKEN|ACCESS_ALLOWLIST)\s*=/m.test(vars), 'Secrets nie als [vars]');
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
  /* Seiten des Workers (Eingabe, Fehler, Bestätigung) wie die Website: Schriften selbst ausgeliefert, CSP nur eigene Herkunft */
  assert.ok(!/fonts\.googleapis\.com|fonts\.gstatic\.com|preconnect/.test(read(VIEW) + read('worker/src/http.ts')), 'Worker-Seiten ohne Google Fonts');
  assert.match(read(VIEW), /<link rel="stylesheet" href="\$\{b\}\/assets\/fonts\.css">\n<link rel="stylesheet" href="\$\{b\}\/assets\/styles\.css">/, 'fonts.css vor styles.css');
  assert.match(read('worker/src/http.ts'), /'Content-Security-Policy': `default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self'; form-action 'self' \$\{authOrigin\}; frame-ancestors 'none'; base-uri 'none'`/, 'Worker-CSP: Stile und Schriften nur von der eigenen Herkunft');
});

test('TypeScript: Worker und Pages Function ohne Typfehler (tsc --noEmit, strict)', t => {
  const tsc = join(ROOT, 'node_modules/.bin/tsc');
  if (!existsSync(tsc)) { t.skip('NOT_RUN: typescript fehlt (npm ci)'); return; }
  for (const project of ['worker/tsconfig.json', 'functions/tsconfig.json']) {
    const r = spawnSync(tsc, ['-p', join(ROOT, project)], { encoding: 'utf8' });
    assert.equal(r.status, 0, project + ': ' + r.stdout + r.stderr);
  }
});
