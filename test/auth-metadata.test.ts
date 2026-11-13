import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { discoverOAuth, postOAuth } from '../src/auth/oauth';
import { temporaryAuthHome } from './auth-support';

let home: Awaited<ReturnType<typeof temporaryAuthHome>>;
const cleanup: Array<() => Promise<void>> = [];
beforeEach(async () => {
  home = await temporaryAuthHome();
  for (const [key, value] of Object.entries(home.env)) vi.stubEnv(key, value);
});
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  await home.clean();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
async function server(handler: (response: import('node:http').ServerResponse) => void) {
  const instance = createServer((_req, res) => handler(res));
  await new Promise<void>((resolve) => instance.listen(0, '127.0.0.1', resolve));
  const address = instance.address();
  if (!address || typeof address === 'string') throw new Error('Invalid listener');
  const base = `http://127.0.0.1:${address.port}`;
  cleanup.push(async () => {
    instance.closeAllConnections();
    await new Promise<void>((resolve) => instance.close(() => resolve()));
  });
  return base;
}
it('caches metadata for one day and validates the cached issuer', async () => {
  let count = 0;
  const base = await server((res) => {
    count++;
    res.end(
      JSON.stringify({
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        revocation_endpoint: `${base}/revoke`,
        device_authorization_endpoint: `${base}/device`,
      }),
    );
  });
  expect((await discoverOAuth(base)).issuer).toBe(base);
  expect((await discoverOAuth(base)).issuer).toBe(base);
  expect(count).toBe(1);
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 86400001);
  await discoverOAuth(base);
  expect(count).toBe(2);
});
it('rejects a mismatched issuer before any credentials can be sent', async () => {
  const base = await server((res) => res.end(JSON.stringify({ issuer: 'https://example.com' })));
  await expect(discoverOAuth(base)).rejects.toMatchObject({ code: 'ISSUER_MISMATCH' });
});
it('rejects token endpoints on another origin', async () => {
  const base = await server((res) =>
    res.end(
      JSON.stringify({
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: 'https://example.com/token',
        revocation_endpoint: `${base}/revoke`,
        device_authorization_endpoint: `${base}/device`,
      }),
    ),
  );
  await expect(discoverOAuth(base)).rejects.toMatchObject({ code: 'ISSUER_MISMATCH' });
});
it('does not leak a malformed token response in a parser error', async () => {
  const base = await server((res) => res.end('invalid-json fake-sensitive-response'));
  await expect(postOAuth(base, { code: 'fake-code' })).rejects.toMatchObject({
    message: 'Invalid JSON in OAuth response.',
  });
});
it('reports unavailable OAuth with the API key alternative', async () => {
  const base = await server((res) => res.writeHead(404).end());
  await expect(discoverOAuth(base)).rejects.toMatchObject({
    code: 'OAUTH_UNAVAILABLE',
    exitCode: 3,
    message: expect.stringContaining('TROOLY_API_KEY'),
  });
});
it.each([
  [500, 1],
  [426, 5],
])('preserves discovery error handling for HTTP %i', async (status, exitCode) => {
  const base = await server((res) => res.writeHead(status).end());
  await expect(discoverOAuth(base)).rejects.toMatchObject({
    code: 'OAUTH_DISCOVERY_FAILED',
    exitCode,
  });
});
it('preserves network errors during availability checks', async () => {
  const error = new TypeError('fetch failed');
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(error);
  await expect(discoverOAuth('http://127.0.0.1:1', { refresh: true })).rejects.toBe(error);
});
