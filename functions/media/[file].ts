/* 360°Pixelkiez – Pages Function nur für die drei Videos aus Cloudflare R2 (Bucket 360pixelkiez, Pages-Binding MEDIA).
   public/_routes.json listet genau diese Pfade; Poster und alle anderen Dateien bleiben statisch. Der R2-Schlüssel kommt aus der
   festen Liste unten, nie aus der Anfrage: kein Listing, kein öffentlicher Bucket, keine anderen Objekte. Content-Type ist fest
   (video/mp4), unabhängig von den Metadaten im Bucket. Gültige Range-Anfragen bekommen 206 (RFC 9110), sonst 200 oder 416 –
   Safari/iOS spielt Videos nur mit 206 ab. Nur GET und HEAD, kein Logging, keine Cookies. _headers gilt nicht für
   Function-Antworten: Die Sicherheits-Header stehen deshalb hier und müssen denen in public/_headers entsprechen
   (tests/pages.test.mjs vergleicht beide); noindex gilt wie in _headers für alle Adressen (Soft-Launch). */

interface Env {
  MEDIA?: R2Bucket;
}

/* Pfad → R2-Schlüssel (Stand der Objekte im Bucket am 03.11.2026; tests/pages.test.mjs prüft Größe und SHA-256) */
const VIDEOS: ReadonlyMap<string, string> = new Map([
  ['/media/360-pixelkiez-video-1080p.mp4', '360-pixelkiez-video-1080p.mp4'],
  ['/media/report-pdf-de-1x1-lavendel.mp4', 'report-pdf-de-1x1-lavendel.mp4'],
  ['/media/section-bericht-peach-5x4.mp4', 'section-bericht-peach-5x4.mp4'],
]);

const SECURITY_HEADERS: Record<string, string> = {
  'Strict-Transport-Security': 'max-age=31536000',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "frame-ancestors 'none'",
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  /* Videos nur für die eigene Website (kein Einbinden auf fremden Seiten) und nicht indexieren */
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Robots-Tag': 'noindex',
};

export const onRequest: PagesFunction<Env> = async ({ request, env, next }) => {
  const url = new URL(request.url);
  const key = VIDEOS.get(url.pathname);
  /* Andere Pfade erreichen die Function nur bei geänderten Routen: dann wie ohne Function als statische Datei */
  if (key === undefined) return next();
  const head = request.method === 'HEAD';
  const headers = new Headers(SECURITY_HEADERS);
  if (request.method !== 'GET' && !head) {
    headers.set('Allow', 'GET, HEAD');
    return new Response(null, { status: 405, headers });
  }
  /* Ohne Binding (z. B. Vorschau-Deployments) oder bei Fehlern in R2: kontrolliert 503, nie eine andere Datei */
  const bucket = env.MEDIA;
  if (!bucket) return text(503, 'Gerade nicht verfügbar.', headers, head);

  let meta: R2Object | null;
  try {
    meta = await bucket.head(key);
  } catch {
    return text(503, 'Gerade nicht verfügbar.', headers, head);
  }
  if (meta === null) return text(404, 'Nicht gefunden.', headers, head);
  const size = meta.size;
  const etag = meta.httpEtag;
  headers.set('Content-Type', 'video/mp4');
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Cache-Control', 'public, max-age=0, must-revalidate');
  headers.set('ETag', etag);

  if (matchesAny(request.headers.get('if-none-match'), etag)) return new Response(null, { status: 304, headers });

  let range = parseRange(request.headers.get('range'), size);
  /* If-Range: Teilantwort nur, wenn die Datei unverändert ist (starker ETag-Vergleich); sonst die ganze Datei */
  const ifRange = request.headers.get('if-range');
  if (ifRange !== null && (etag.startsWith('W/') || ifRange.trim() !== etag)) range = null;
  if (range === 'unsatisfiable') {
    headers.set('Content-Range', `bytes */${size}`);
    return text(416, 'Angeforderter Bereich nicht verfügbar.', headers, head);
  }
  const [status, start, end] = range === null ? [200, 0, size - 1] : [206, range.start, range.end];
  if (status === 206) headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  headers.set('Content-Length', String(end - start + 1));
  if (head) return new Response(null, { status, headers });

  /* Genau das Objekt, dessen Größe und ETag oben stehen (onlyIf): wurde es inzwischen ersetzt, kommt kein Inhalt → 503 */
  let object: R2Object | R2ObjectBody | null;
  try {
    object = await bucket.get(key, { onlyIf: { etagMatches: meta.etag }, ...(status === 206 ? { range: { offset: start, length: end - start + 1 } } : {}) });
  } catch {
    return text(503, 'Gerade nicht verfügbar.', headers, head);
  }
  if (object === null) return text(404, 'Nicht gefunden.', headers, head);
  if (!('body' in object)) return text(503, 'Gerade nicht verfügbar.', headers, head);
  return new Response(object.body, { status, headers });
};

/* Range-Kopf (RFC 9110, Abschnitt 14): null = ganze Datei – kein Range-Kopf, andere Einheit (muss ignoriert werden) oder
   mehrere Bereiche (multipart/byteranges wird nicht unterstützt); 'unsatisfiable' = ungültig oder außerhalb der Datei → 416 */
function parseRange(value: string | null, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  if (value === null) return null;
  const spec = /^([A-Za-z][\w-]*)=(.+)$/.exec(value.trim());
  if (!spec || value.length > 100) return 'unsatisfiable';
  if (spec[1]!.toLowerCase() !== 'bytes' || spec[2]!.includes(',')) return null;
  const m = /^(\d*)-(\d*)$/.exec(spec[2]!);
  if (!m || (m[1] === '' && m[2] === '') || size === 0) return 'unsatisfiable';
  if (m[1] === '') {
    /* Suffix: die letzten n Byte */
    const n = Number(m[2]);
    return n === 0 ? 'unsatisfiable' : { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  const last = m[2] === '' ? size - 1 : Number(m[2]);
  if (start >= size || last < start) return 'unsatisfiable';
  return { start, end: Math.min(last, size - 1) };
}

/* If-None-Match mit schwachem Vergleich (RFC 9110, Abschnitt 13.1.2) */
function matchesAny(list: string | null, etag: string): boolean {
  const opaque = (t: string) => t.trim().replace(/^W\//, '');
  return list !== null && list.split(',').some(t => t.trim() === '*' || opaque(t) === opaque(etag));
}

function text(status: number, message: string, headers: Headers, head: boolean): Response {
  headers.set('Content-Type', 'text/plain; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  headers.delete('ETag');
  headers.delete('Content-Length');
  return new Response(head ? null : message + '\n', { status, headers });
}
