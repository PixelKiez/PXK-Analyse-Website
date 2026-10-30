/* Sicherheitsrelevante HTTP-Helfer: Header, Cookies, Same-Origin-Prüfung, Client-IP, Formulare, Escaping. */

export const MAX_BODY = 16384;

export function securityHeaders(secure: boolean, authOrigin: string): Headers {
  return new Headers({
    'Content-Security-Policy': `default-src 'none'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self'; form-action 'self' ${authOrigin}; frame-ancestors 'none'; base-uri 'none'`,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    /* same-origin statt no-referrer: Bei no-referrer sendet Chrome für Formular-POSTs "Origin: null", die Same-Origin-Prüfung schlüge fehl */
    'Referrer-Policy': 'same-origin',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cache-Control': 'no-store',
    ...(secure ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
  });
}

/* Session-Cookie: __Host- erzwingt Secure, Path=/ und keine Domain (nur über HTTPS möglich). Kurzlebig über Max-Age. */
export const cookieName = (secure: boolean): string => (secure ? '__Host-pxwa' : 'pxwa');

export function sessionCookie(secure: boolean, value: string | null, maxAge: number): string {
  return `${cookieName(secure)}=${value ?? ''}; Path=/; Max-Age=${value === null ? 0 : maxAge}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

export function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/* Lehnt Cross-Site-POSTs ab. Origin wird von aktuellen Browsern bei POST immer gesendet. */
export function sameOrigin(request: Request, origin: string): boolean {
  const o = request.headers.get('origin');
  if (o !== null) return o === origin;
  const site = request.headers.get('sec-fetch-site');
  return site === null || site === 'same-origin' || site === 'none';
}

/* Für das Rate-Limiting: Cloudflare setzt CF-Connecting-IP (vom Client nicht fälschbar). IPv4 vollständig,
   IPv6 als /64-Präfix (sonst reicht ein Adresswechsel im eigenen Netz). */
export function clientIp(request: Request): string {
  const ip = (request.headers.get('cf-connecting-ip') ?? '').trim().toLowerCase();
  if (!ip.includes(':')) return ip || 'unbekannt';
  const [head = '', tail = ''] = ip.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
  return groups.slice(0, 4).map(g => g.replace(/^0+(?=.)/, '')).join(':') + '::/64';
}

/* Liest einen Formular-Body bis MAX_BODY Bytes. null: zu groß. Andere Inhaltstypen ergeben ein leeres Formular. */
export async function readForm(request: Request): Promise<URLSearchParams | null> {
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY) return null;
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  }
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/x-www-form-urlencoded')) return new URLSearchParams();
  const body = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    body.set(c, offset);
    offset += c.byteLength;
  }
  return new URLSearchParams(new TextDecoder().decode(body));
}

export const h = (s: string): string =>
  s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[c] as string);

/* Prüft eine E-Mail-Adresse (ASCII, wie sie Google bestätigt); verhindert auch Steuerzeichen in Mail-Feldern */
export function isEmail(s: string): boolean {
  if (s.length > 254) return false;
  const at = s.lastIndexOf('@');
  if (at < 1 || at > 64) return false;
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  return /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/.test(local)
    && /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(domain);
}
