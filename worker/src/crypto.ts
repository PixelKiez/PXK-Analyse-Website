/* Zufall, Hashes und Kodierungen über WebCrypto. */
const encoder = new TextEncoder();

export const randomBytes = (n: number): Uint8Array => crypto.getRandomValues(new Uint8Array(n));

export const hex = (bytes: ArrayBuffer | Uint8Array): string =>
  [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');

export const randomHex = (n: number): string => hex(randomBytes(n));

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* Strenges Base64url ohne Padding; null bei ungültiger Eingabe */
export function b64urlDecode(s: string): Uint8Array | null {
  if (s === '' || /[^A-Za-z0-9_-]/.test(s) || s.length % 4 === 1) return null;
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
    return Uint8Array.from(bin, c => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export const utf8 = (s: string): Uint8Array => encoder.encode(s);

export const sha256 = async (s: string): Promise<ArrayBuffer> => crypto.subtle.digest('SHA-256', utf8(s));

export const sha256Hex = async (s: string): Promise<string> => hex(await sha256(s));

export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', utf8(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, utf8(message)));
}

/* Vergleich in konstanter Zeit (bezogen auf den Inhalt); unterschiedliche Länge ist sofort ungleich */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
