import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import { isolatedOutbound, MAIL_URL, TOKEN_URL, JWKS_URL } from './lib/oidc-isolation.mjs';

test('localhost OAuth boundary mocks mail and only forwards exact Google token and JWKS endpoints', async () => {
  const forwarded = [];
  const { handler, counts } = isolatedOutbound({ fetchImpl: async (url, init) => {
    forwarded.push({ url, method: init.method, redirect: init.redirect });
    return new Response('{}', { status: 200 });
  } });
  for (const [url, method] of [[MAIL_URL, 'POST'], [TOKEN_URL, 'POST'], [JWKS_URL, 'GET']]) {
    assert.equal((await handler(new Request(url, { method }))).status, 200);
  }
  for (const [url, method] of [['https://api.resend.com/emails', 'POST'], [TOKEN_URL, 'GET'], [TOKEN_URL + '?other=1', 'POST'], [JWKS_URL + '/other', 'GET'], ['https://example.com/', 'GET'], [MAIL_URL, 'GET']]) {
    assert.equal((await handler(new Request(url, { method }))).status, 403);
  }
  assert.deepEqual(forwarded, [{ url: TOKEN_URL, method: 'POST', redirect: 'error' }, { url: JWKS_URL, method: 'GET', redirect: 'error' }]);
  assert.deepEqual(counts, { google: 2, mail: 1, blocked: 6 });
});

test('workerd outbound isolation intercepts mock mail and denies the real Resend endpoint', async () => {
  const { handler, counts } = isolatedOutbound({ fetchImpl: async () => { throw new Error('unexpected network call'); } });
  const mf = new Miniflare({
    modules: true,
    compatibilityDate: '2026-07-30',
    outboundService: handler,
    script: `export default { async fetch() {
      const mock = await fetch('${MAIL_URL}', { method: 'POST' });
      const real = await fetch('https://api.resend.com/emails', { method: 'POST' });
      return Response.json({ mock: mock.status, real: real.status });
    } }`,
  });
  try {
    const response = await mf.dispatchFetch('http://localhost/');
    assert.deepEqual(await response.json(), { mock: 200, real: 403 });
    assert.deepEqual(counts, { google: 0, mail: 1, blocked: 1 });
  } finally {
    await mf.dispose();
  }
});
