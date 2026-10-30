import type { GoogleConfig } from './config';
import { b64url, b64urlDecode, safeEqual, sha256, utf8 } from './crypto';
import { nowSec } from './db';
import { AuthError } from './errors';
import { isEmail } from './http';

/* Google-Anmeldung über OpenID Connect (Authorization Code Flow mit PKCE, state und nonce).
   Scope nur "openid email": keine Gmail-Rechte, kein Profil, kein Zugriff auf das Postfach.
   Das ID-Token kommt ausschließlich über den Server-zu-Server-Aufruf am Token-Endpunkt an,
   wird trotzdem vollständig geprüft (Signatur, Issuer, Audience, Ablauf, nonce, bestätigte E-Mail)
   und danach verworfen. Access- und ID-Token werden weder gespeichert noch geloggt. */

const LEEWAY = 60;
const TIMEOUT_MS = 10000;

interface KeyCache {
  uri: string;
  keys: Map<string, CryptoKey>;
  fetchedAt: number;
  expiresAt: number;
}
/* Je Isolate; Googles Schlüssel sind öffentlich. Unbekannte kid löst höchstens einen Neuabruf pro Minute aus. */
let keyCache: KeyCache | null = null;

type Claims = Record<string, unknown>;

export class GoogleOidc {
  constructor(private g: GoogleConfig, private redirectUri: string) {}

  async authorizationUrl(state: string, nonce: string, verifier: string): Promise<string> {
    const query = new URLSearchParams({
      client_id: this.g.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: 'openid email',
      state,
      nonce,
      code_challenge: b64url(await sha256(verifier)),
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });
    return this.g.authEndpoint + '?' + query.toString().replace(/\+/g, '%20');
  }

  async authenticate(code: string, verifier: string, nonce: string): Promise<{ sub: string; email: string }> {
    let res: Response;
    try {
      res = await fetch(this.g.tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
          code,
          client_id: this.g.clientId,
          client_secret: this.g.clientSecret,
          redirect_uri: this.redirectUri,
          grant_type: 'authorization_code',
          code_verifier: verifier,
        }),
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new AuthError('token_exchange');
    }
    const body = await res.text().catch(() => '');
    if (res.status !== 200) throw new AuthError('token_exchange');
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      throw new AuthError('token_response');
    }
    const idToken = (json as Claims | null)?.id_token;
    if (typeof idToken !== 'string') throw new AuthError('token_response');
    return this.verifyIdToken(idToken, nonce, nowSec());
  }

  async verifyIdToken(jwt: string, expectedNonce: string, now: number): Promise<{ sub: string; email: string }> {
    const parts = jwt.split('.');
    if (parts.length !== 3) throw new AuthError('format');
    const [h64 = '', p64 = '', s64 = ''] = parts;
    const header = parseJson(h64);
    const claims = parseJson(p64);
    const signature = b64urlDecode(s64);
    if (header === null || claims === null || signature === null || signature.length === 0) throw new AuthError('format');
    /* Nur RS256 – verhindert "alg: none" und HS256-Verwechslung mit dem öffentlichen Schlüssel */
    if (header.alg !== 'RS256') throw new AuthError('alg');
    const kid = header.kid;
    const key = typeof kid === 'string' && kid !== '' ? await this.publicKey(kid) : null;
    if (key === null) throw new AuthError('kid');
    if (!(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, utf8(h64 + '.' + p64)))) throw new AuthError('signature');
    if (typeof claims.iss !== 'string' || !this.g.issuers.includes(claims.iss)) throw new AuthError('issuer');
    const clientId = this.g.clientId;
    const aud = claims.aud;
    const audOk = typeof aud === 'string' ? safeEqual(clientId, aud) : Array.isArray(aud) && aud.includes(clientId) && claims.azp === clientId;
    if (!audOk || (claims.azp !== undefined && claims.azp !== clientId)) throw new AuthError('audience');
    if (!Number.isInteger(claims.exp) || now >= (claims.exp as number) + LEEWAY) throw new AuthError('expired');
    if (!Number.isInteger(claims.iat) || (claims.iat as number) > now + LEEWAY) throw new AuthError('iat');
    if (typeof claims.nonce !== 'string' || !safeEqual(expectedNonce, claims.nonce)) throw new AuthError('nonce');
    if (claims.email_verified !== true && claims.email_verified !== 'true') throw new AuthError('email_unverified');
    const email = claims.email;
    if (typeof email !== 'string' || !isEmail(email)) throw new AuthError('email');
    const sub = claims.sub;
    if (typeof sub !== 'string' || sub === '' || sub.length > 255 || /[^\x21-\x7e]/.test(sub)) throw new AuthError('sub');
    return { sub, email: email.toLowerCase() };
  }

  private async publicKey(kid: string): Promise<CryptoKey | null> {
    const now = nowSec();
    const cache = keyCache?.uri === this.g.jwksUri ? keyCache : null;
    const known = cache?.keys.get(kid);
    if (cache && known && cache.expiresAt > now) return known;
    if (!cache || cache.fetchedAt < now - 60 || cache.expiresAt <= now) {
      const fresh = await this.fetchKeys(now);
      if (fresh !== null) {
        keyCache = fresh;
        return fresh.keys.get(kid) ?? null;
      }
      if (!cache || cache.expiresAt < now - 86400) return null;   // Neuabruf gescheitert und Cache mehr als einen Tag abgelaufen
    }
    return cache.keys.get(kid) ?? null;
  }

  private async fetchKeys(now: number): Promise<KeyCache | null> {
    let res: Response | null = null;
    let json: unknown = null;
    try {
      res = await fetch(this.g.jwksUri, { headers: { accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
      json = res.status === 200 ? await res.json() : null;
    } catch {
      json = null;
    }
    const list = (json as Claims | null)?.keys;
    if (!Array.isArray(list)) {
      console.error(`PXWA: Google-Schlüssel konnten nicht geladen werden (HTTP ${res?.status ?? 0})`);
      return null;
    }
    const keys = new Map<string, CryptoKey>();
    for (const k of list as Claims[]) {
      const n = typeof k?.n === 'string' ? b64urlDecode(k.n) : null;
      if (k?.kty === 'RSA' && (k.alg ?? 'RS256') === 'RS256' && (k.use ?? 'sig') === 'sig' && typeof k.kid === 'string' && typeof k.e === 'string'
        && n !== null && n.length >= 256) {
        try {
          keys.set(k.kid, await crypto.subtle.importKey('jwk', { kty: 'RSA', n: k.n as string, e: k.e, alg: 'RS256', ext: true },
            { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']));
        } catch {
          /* ungültiger Schlüssel: überspringen */
        }
      }
    }
    const maxAge = Number(/max-age=(\d+)/.exec(res?.headers.get('cache-control') ?? '')?.[1] ?? 3600);
    return { uri: this.g.jwksUri, keys, fetchedAt: now, expiresAt: now + Math.max(300, Math.min(maxAge, 86400)) };
  }
}

function parseJson(segment: string): Claims | null {
  const bytes = b64urlDecode(segment);
  if (bytes === null) return null;
  try {
    const v: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Claims) : null;
  } catch {
    return null;
  }
}
