/* Network boundary for the interactive localhost Google test. No real mail API is reachable. */
import { Response } from 'miniflare';

export const MAIL_URL = 'http://pxwa-mail.invalid/emails';
export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

export function isolatedOutbound({ fetchImpl = fetch, counts = { google: 0, mail: 0, blocked: 0 } } = {}) {
  const handler = async request => {
    if (request.url === MAIL_URL && request.method === 'POST') {
      counts.mail++;
      return new Response('{"id":"local-mock-mail"}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const permitted = (request.url === TOKEN_URL && request.method === 'POST') || (request.url === JWKS_URL && request.method === 'GET');
    if (!permitted) {
      counts.blocked++;
      return new Response('blocked by isolated test', { status: 403 });
    }
    try {
      counts.google++;
      const headers = Object.fromEntries(request.headers);
      delete headers.host;
      delete headers['content-length'];
      const response = await fetchImpl(request.url, {
        method: request.method, headers, redirect: 'error',
        ...(request.method === 'POST' ? { body: await request.arrayBuffer() } : {}),
        signal: AbortSignal.timeout(10000),
      });
      return new Response(await response.arrayBuffer(), { status: response.status, headers: Object.fromEntries(response.headers) });
    } catch {
      return new Response('Google request failed', { status: 502 });
    }
  };
  return { handler, counts };
}
