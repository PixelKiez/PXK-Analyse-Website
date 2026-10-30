import { utf8 } from './crypto';

/* Prüft und normalisiert die eingegebene Website-Adresse.
   Die Adresse wird nur gespeichert, nie serverseitig abgerufen (kein Scan, daher keine SSRF-Fläche).
   Gespeichert werden Schema, Host und Pfad; Query-String und Fragment werden verworfen (Datensparsamkeit). */

export const MAX_INPUT = 2048;
export const MAX_STORED = 300;

/* Nicht öffentliche bzw. reservierte Endungen (RFC 2606, RFC 6761, RFC 6762, übliche interne Namen) */
const RESERVED_TLDS = new Set(['localhost', 'local', 'localdomain', 'internal', 'intranet', 'lan', 'home', 'corp', 'test', 'example', 'invalid', 'onion', 'arpa']);

export function normalizeWebsite(input: string): string | null {
  let v = input.trim();
  if (v === '' || utf8(v).length > MAX_INPUT || /[\x00-\x20\x7f\\<>"`{}|^]/.test(v)) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) {
    /* "javascript:…", "mailto:…" usw. ablehnen; "host:port" bleibt erlaubt und wird unten geprüft */
    if (/^[a-z][a-z0-9+.-]*:/i.test(v) && !/^[^/:]+:\d+(?:[/?#]|$)/.test(v)) return null;
    v = 'https://' + v;
  }
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)/i.exec(v);
  if (!m) return null;
  const scheme = (m[1] ?? '').toLowerCase();
  const authority = m[2] ?? '';
  if ((scheme !== 'http' && scheme !== 'https') || authority.includes('@')) return null;
  const hp = /^([^:]*)(?::(\d{1,5}))?$/.exec(authority);
  if (!hp || (hp[2] !== undefined && ![80, 443].includes(Number(hp[2])))) return null;
  const host = normalizeHost(hp[1] ?? '');
  const path = normalizePath(m[3] ?? '');
  if (host === null || path === null) return null;
  const url = `${scheme}://${host}${path}`;
  return utf8(url).length <= MAX_STORED ? url : null;
}

/* Anzeigeform: Umlaut-Domains und -Pfade wieder lesbar machen (nur zur Anzeige, Ausgabe wird escaped) */
export function displayWebsite(url: string): string {
  const m = /^(https?):\/\/([^/]*)(.*)$/.exec(url);
  if (!m) return url;
  const host = (m[2] ?? '').split('.').map(l => (l.startsWith('xn--') ? punycodeDecode(l.slice(4)) ?? l : l)).join('.');
  let path = m[3] ?? '';
  try {
    const decoded = decodeURIComponent(path);
    if (!/[\x00-\x20\x7f]/.test(decoded)) path = decoded;
  } catch {
    /* kein gültiges UTF-8: kodierte Form anzeigen */
  }
  return `${m[1]}://${host}${path}`;
}

function normalizeHost(input: string): string | null {
  let h = input.toLowerCase().replace(/\.+$/, '');
  if (h === '' || h.startsWith('[') || h.includes('%') || isIpv4(h)) return null;
  if (/[^\x00-\x7f]/.test(h)) {
    /* Umlaut-Domain → ASCII (IDNA/UTS 46, nicht-transitional wie im URL-Standard) */
    try {
      h = new URL(`https://${h}/`).hostname.replace(/\.+$/, '');
    } catch {
      return null;
    }
    if (isIpv4(h)) return null;
  }
  if (h.length > 253) return null;
  const labels = h.split('.');
  if (labels.length < 2 || !labels.every(l => /^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(l))) return null;
  const tld = labels[labels.length - 1] ?? '';
  if (!/^(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/.test(tld) || RESERVED_TLDS.has(tld)) return null;
  if (/(?:^|\.)example\.(?:com|net|org)$/.test(h)) return null;
  return h;
}

function normalizePath(input: string): string | null {
  if (input === '' || input === '/') return '';
  const path = input.replace(/[^\x21-\x7e]/gu, c => [...utf8(c)].map(b => '%' + b.toString(16).toUpperCase().padStart(2, '0')).join(''));
  return /^(?:\/(?:[A-Za-z0-9\-._~!$&'()*+,;=:@]|%[0-9A-Fa-f]{2})*)+$/.test(path) ? path : null;
}

const isIpv4 = (h: string): boolean => /^\d+(?:\.\d+){0,3}$/.test(h);

/* Punycode-Dekodierung (RFC 3492) für die Anzeige von xn--Labels; null bei ungültiger Eingabe */
function punycodeDecode(input: string): string | null {
  const BASE = 36, TMIN = 1, TMAX = 26, SKEW = 38, DAMP = 700;
  const digit = (c: number): number => (c >= 48 && c <= 57 ? c - 22 : c >= 65 && c <= 90 ? c - 65 : c >= 97 && c <= 122 ? c - 97 : BASE);
  const adapt = (delta: number, points: number, first: boolean): number => {
    delta = first ? Math.floor(delta / DAMP) : delta >> 1;
    delta += Math.floor(delta / points);
    let k = 0;
    for (; delta > ((BASE - TMIN) * TMAX) >> 1; k += BASE) delta = Math.floor(delta / (BASE - TMIN));
    return Math.floor(k + ((BASE - TMIN + 1) * delta) / (delta + SKEW));
  };
  const out: number[] = [];
  const basic = Math.max(0, input.lastIndexOf('-'));
  for (let j = 0; j < basic; j++) {
    const c = input.charCodeAt(j);
    if (c >= 0x80) return null;
    out.push(c);
  }
  let n = 128, i = 0, bias = 72;
  for (let idx = basic > 0 ? basic + 1 : 0; idx < input.length;) {
    const old = i;
    for (let w = 1, k = BASE; ; k += BASE) {
      if (idx >= input.length) return null;
      const d = digit(input.charCodeAt(idx++));
      if (d >= BASE) return null;
      i += d * w;
      if (i > 0x7fffffff) return null;
      const t = k <= bias ? TMIN : k >= bias + TMAX ? TMAX : k - bias;
      if (d < t) break;
      w *= BASE - t;
    }
    bias = adapt(i - old, out.length + 1, old === 0);
    n += Math.floor(i / (out.length + 1));
    i %= out.length + 1;
    if (n > 0x10ffff) return null;
    out.splice(i++, 0, n);
  }
  return String.fromCodePoint(...out);
}
