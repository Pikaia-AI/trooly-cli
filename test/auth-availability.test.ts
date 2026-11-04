import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { main } from '../src/index';
import { discoverOAuth } from '../src/auth/oauth';
import * as browser from '../src/auth/browser';
import * as device from '../src/auth/device';
import * as loopback from '../src/auth/loopback';
import { temporaryAuthHome } from './auth-support';

let home: Awaited<ReturnType<typeof temporaryAuthHome>>;
const cleanup: Array<() => Promise<void>> = [];
beforeEach(async () => {
  home = await temporaryAuthHome();
  for (const [key, value] of Object.entries(home.env)) vi.stubEnv(key, value);
  vi.stubEnv('TROOLY_NO_UPDATE_CHECK', '1');
});
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  await home.clean();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it.each([['login'], ['login', '--device'], ['auth', 'login']])(
  'checks live OAuth availability before %j, even with fresh cached metadata',
  async (...args) => {
    const requests: string[] = [];
    let available = true;
    const server = createServer((req, res) => {
      requests.push(req.url!);
      if (!available) {
        res.writeHead(404).end();
        return;
      }
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
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No local address');
    const base = `http://127.0.0.1:${address.port}`;
    vi.stubEnv('TROOLY_API_BASE', base);
    await discoverOAuth(base);
    available = false;
    requests.length = 0;

    const openBrowser = vi.spyOn(browser, 'openBrowser').mockImplementation(() => {});
    const deviceLogin = vi.spyOn(device, 'deviceLogin');
    const loopbackLogin = vi.spyOn(loopback, 'loopbackLogin');
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    expect(await main(['node', 'trooly', ...args, '--json'])).toBe(3);
    expect(requests).toEqual(['/.well-known/oauth-authorization-server']);
    expect(openBrowser).not.toHaveBeenCalled();
    expect(deviceLogin).not.toHaveBeenCalled();
    expect(loopbackLogin).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
    expect(JSON.parse(stderr.mock.calls.map(([value]) => String(value)).join(''))).toMatchObject({
      error: {
        code: 'OAUTH_UNAVAILABLE',
        message: expect.stringContaining('TROOLY_API_KEY'),
      },
    });
  },
);
