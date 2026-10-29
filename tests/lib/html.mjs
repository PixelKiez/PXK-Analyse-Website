/* Minimaler, abhängigkeitsfreier HTML-Parser für die statischen PXK-154-Tests.
   Reicht für das handgeschriebene, wohlgeformte Markup dieses Repos; kein Ersatz für einen Browser-Parser. */

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style']);
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', euro: '€', middot: '·', ndash: '–', mdash: '—' };

export const decode = s => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return ENTITIES[e] ?? m;
});

const parseAttrs = src => {
  const attrs = new Map();
  for (const m of src.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    attrs.set(m[1].toLowerCase(), decode(m[2] ?? m[3] ?? m[4] ?? ''));
  }
  return attrs;
};

export function parse(html) {
  const root = { tag: '#root', attrs: new Map(), children: [], parent: null };
  const doctype = /^\s*<!doctype html>/i.test(html);
  let cur = root, i = 0;
  const re = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/gi;
  let m;
  while ((m = re.exec(html))) {
    if (m.index > i) cur.children.push({ text: decode(html.slice(i, m.index)), parent: cur });
    i = re.lastIndex;
    if (m[0].startsWith('<!')) continue;
    if (m[1]) {
      const tag = m[1].toLowerCase();
      let n = cur;
      while (n && n.tag !== tag) n = n.parent;
      if (!n) throw new Error(`Unerwartetes </${tag}> an Position ${m.index}`);
      cur = n.parent;
      continue;
    }
    const tag = m[2].toLowerCase();
    const el = { tag, attrs: parseAttrs(m[3] || ''), children: [], parent: cur };
    cur.children.push(el);
    if (RAW.has(tag)) {
      const end = html.toLowerCase().indexOf(`</${tag}`, i);
      el.raw = html.slice(i, end);
      el.children.push({ text: el.raw, parent: el });
      re.lastIndex = i = html.indexOf('>', end) + 1;
      continue;
    }
    if (!VOID.has(tag) && !m[4]) cur = el;
  }
  if (i < html.length) cur.children.push({ text: decode(html.slice(i)), parent: cur });
  if (cur !== root) throw new Error(`Nicht geschlossenes <${cur.tag}>`);
  return { root, doctype };
}

export const elements = (node, out = []) => {
  for (const c of node.children || []) if (c.tag) { out.push(c); elements(c, out); }
  return out;
};
export const find = (node, pred) => elements(node).filter(pred);
export const byTag = (node, tag) => find(node, e => e.tag === tag);
export const hasClass = (el, c) => (el.attrs.get('class') || '').split(/\s+/).includes(c);
export const byClass = (node, c) => find(node, e => hasClass(e, c));
export const byId = (node, id) => find(node, e => e.attrs.get('id') === id)[0];
export const closest = (el, pred) => { for (let n = el; n; n = n.parent) if (n.tag && pred(n)) return n; return null; };

export const textOf = node => (node.text !== undefined ? node.text : (node.children || []).map(textOf).join(''));
export const norm = s => s.replace(/\s+/g, ' ').trim();

/* Sichtbarer Text: ohne <head>, <script>, <style>, <symbol>-Definitionen und ohne Elemente mit hidden-Attribut. */
export function visibleText(node) {
  if (node.text !== undefined) return node.text;
  if (['head', 'script', 'style', 'symbol', 'template'].includes(node.tag) || node.attrs?.has('hidden')) return ' ';
  const block = !['span', 'b', 'em', 'small', 'a', 'i', 'strong', 'use', 'svg', 'label'].includes(node.tag);
  const inner = node.children.map(visibleText).join('');
  return block ? ` ${inner} ` : inner;
}

/* Text, der in hidden-Teilbäumen steht (für die Restbefund-Dokumentation). */
export const hiddenTrees = node => find(node, e => e.attrs.has('hidden'));

/* Strukturelles Skelett eines Teilbaums: Tag, Attributnamen und -werte in Dokumentreihenfolge. */
export const skeleton = node => elements(node).map(e => ({ tag: e.tag, attrs: Object.fromEntries(e.attrs), el: e }));
