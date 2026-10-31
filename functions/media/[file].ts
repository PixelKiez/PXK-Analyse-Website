/* 360°Pixelkiez – Pages Function nur für die zwei Videos (public/_routes.json listet genau diese Pfade; Poster und alle
   anderen Dateien bleiben statisch). Cloudflare Pages beantwortet Byte-Range-Anfragen statischer Dateien mit 200 und der
   ganzen Datei; Safari/iOS spielt Videos dann nicht ab. Diese Function liest die Datei aus dem eigenen Pages-Assets-Binding
   (feste Pfade, nichts aus der Anfrage, keine fremde Quelle) und beantwortet gültige Range-Anfragen mit 206 (RFC 9110).
   Nur GET und HEAD, kein Logging, keine Cookies. _headers gilt nicht für Function-Antworten: Die Sicherheits-Header stehen
   deshalb hier und müssen denen in public/_headers entsprechen (tests/pages.test.mjs vergleicht beide). */

const VIDEOS: readonly string[] = ['/media/360-pixelkiez-video-1080p.mp4', '/media/report-pdf-de-1x1.mp4'];

const SECURITY_HEADERS: Record<string, string> = {
  'Strict-Transport-Security': 'max-age=31536000',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "frame-ancestors 'none'",
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
};

export const onRequest: PagesFunction = async ({ request, env, next }) => {
  const url = new URL(request.url);
  const video = VIDEOS.find(v => v === url.pathname);
  /* Andere Pfade erreichen die Function nur bei geänderten Routen: dann wie ohne Function als statische Datei */
  if (!video) return next();
  const head = request.method === 'HEAD';
  const headers = new Headers(SECURITY_HEADERS);
  if (url.hostname.endsWith('.pages.dev')) headers.set('X-Robots-Tag', 'noindex');
  if (request.method !== 'GET' && !head) {
    headers.set('Allow', 'GET, HEAD');
    return new Response(null, { status: 405, headers });
  }

  /* Eigene statische Datei, ohne Header der Anfrage (kein Range, keine Bedingungen): Pages liefert 200 mit der ganzen Datei */
  let asset: Response;
  try {
    asset = await env.ASSETS.fetch(new URL(video, url.origin).href);
  } catch {
    return text(503, 'Gerade nicht verfügbar.', headers, head);
  }
  if (asset.status !== 200 || asset.headers.get('content-type')?.split(';')[0]?.trim() !== 'video/mp4') {
    await asset.body?.cancel();
    return asset.status >= 500 ? text(503, 'Gerade nicht verfügbar.', headers, head) : text(404, 'Nicht gefunden.', headers, head);
  }
  const file = await asset.arrayBuffer();
  const size = file.byteLength;
  const etag = asset.headers.get('etag');
  headers.set('Content-Type', 'video/mp4');
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Cache-Control', 'public, max-age=0, must-revalidate');
  if (etag) headers.set('ETag', etag);

  if (etag && matchesAny(request.headers.get('if-none-match'), etag)) return new Response(null, { status: 304, headers });

  let range = parseRange(request.headers.get('range'), size);
  /* If-Range: Teilantwort nur, wenn die Datei unverändert ist (starker ETag-Vergleich); sonst die ganze Datei */
  const ifRange = request.headers.get('if-range');
  if (ifRange !== null && (!etag || etag.startsWith('W/') || ifRange.trim() !== etag)) range = null;
  if (range === 'unsatisfiable') {
    headers.set('Content-Range', `bytes */${size}`);
    return text(416, 'Angeforderter Bereich nicht verfügbar.', headers, head);
  }
  const [status, start, end] = range === null ? [200, 0, size - 1] : [206, range.start, range.end];
  if (status === 206) headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  headers.set('Content-Length', String(end - start + 1));
  return new Response(head ? null : status === 206 ? file.slice(start, end + 1) : file, { status, headers });
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
  return new Response(head ? null : message + '\n', { status, headers });
}
