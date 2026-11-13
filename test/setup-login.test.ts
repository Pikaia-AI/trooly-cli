import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { main } from '../src/index';
import { credentialStore } from '../src/auth/store';
import { resolveProfile } from '../src/config/profiles';
import * as browser from '../src/auth/browser';
import * as device from '../src/auth/device';
import * as loopback from '../src/auth/loopback';
import { fakeTokenResponse, localAuthServer, temporaryAuthHome } from './auth-support';

let home: Awaited<ReturnType<typeof temporaryAuthHome>>;
const cleanup: Array<() => Promise<void>> = [];
beforeEach(async () => {
  home = await temporaryAuthHome();
  for (const [key, value] of Object.entries(home.env)) vi.stubEnv(key, value);
  vi.stubEnv('TROOLY_NO_UPDATE_CHECK', '1');
  vi.stubEnv('TROOLY_PROFILE', 'default');
  vi.stubEnv('TROOLY_API_KEY', '');
});
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  await home.clean();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it('returns exit code 3 and one setup JSON summary when the gateway has no OAuth', async () => {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url!);
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No local address');
  vi.stubEnv('TROOLY_API_BASE', `http://127.0.0.1:${address.port}`);
  const openBrowser = vi.spyOn(browser, 'openBrowser').mockImplementation(() => {});
  const deviceLogin = vi.spyOn(device, 'deviceLogin');
  const loopbackLogin = vi.spyOn(loopback, 'loopbackLogin');
  const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);

  expect(await main(['node', 'trooly', 'setup', '--yes', '--skip-skill', '--json'])).toBe(3);
  expect(stdout).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(stdout.mock.calls[0][0]))).toMatchObject({
    exit_code: 3,
    steps: {
      cli: { status: 'skipped' },
      skill: { status: 'skipped' },
      login: {
        status: 'failed',
        message: expect.stringContaining('TROOLY_API_KEY'),
        manual_command: 'trooly login',
      },
    },
  });
  expect(requests).toEqual(['/.well-known/oauth-authorization-server']);
  expect(openBrowser).not.toHaveBeenCalled();
  expect(deviceLogin).not.toHaveBeenCalled();
  expect(loopbackLogin).not.toHaveBeenCalled();
});

it('uses device authorization for noninteractive setup and emits only its final JSON summary', async () => {
  for (const stream of [process.stdin, process.stdout]) {
    const descriptor = Object.getOwnPropertyDescriptor(stream, 'isTTY');
    Object.defineProperty(stream, 'isTTY', { configurable: true, value: false });
    cleanup.push(async () => {
      if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor);
      else Reflect.deleteProperty(stream, 'isTTY');
    });
  }
  const identity = {
    credential: { type: 'oauth', id: 'grant_example', environment: 'live' },
    principal: { type: 'user', id: 'usr_example', name: 'Example' },
    organization: { id: 'org_example', name: 'Example', type: 'organization' },
    permissions: ['read', 'write'],
  };
  const requests: string[] = [];
  const server = await localAuthServer((req, res) => {
    requests.push(req.url!);
    if (req.url === '/device') {
      res.end(
        JSON.stringify({
          device_code: 'fake-device-code',
          user_code: 'BCDF-GHJK',
          verification_uri: `${server.base}/verify`,
          interval: 0.001,
          expires_in: 600,
        }),
      );
      return;
    }
    if (req.url === '/token') {
      res.end(JSON.stringify(fakeTokenResponse));
      return;
    }
    if (req.url === '/platform/v2/credential') {
      res.end(JSON.stringify({ data: identity }));
      return;
    }
    res.writeHead(404).end();
  });
  cleanup.push(server.close);
  vi.stubEnv('TROOLY_API_BASE', server.base);
  const openBrowser = vi.spyOn(browser, 'openBrowser').mockImplementation(() => {});
  const loopbackLogin = vi.spyOn(loopback, 'loopbackLogin');
  const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

  expect(await main(['node', 'trooly', 'setup', '--yes', '--skip-skill', '--json'])).toBe(0);
  expect(requests).toEqual(['/device', '/token', '/platform/v2/credential']);
  expect(openBrowser).not.toHaveBeenCalled();
  expect(loopbackLogin).not.toHaveBeenCalled();
  expect(stdout).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(stdout.mock.calls[0][0]))).toMatchObject({
    exit_code: 0,
    steps: { login: { status: 'success' } },
  });
  expect(stderr.mock.calls.map(([value]) => String(value)).join('')).toContain('BCDF-GHJK');
  expect((await resolveProfile()).stored?.organization).toEqual(identity.organization);
  expect((await credentialStore.read('default'))?.access_token).toBe(
    fakeTokenResponse.access_token,
  );
  const output = [...stdout.mock.calls, ...stderr.mock.calls]
    .map(([value]) => String(value))
    .join('');
  expect(output).not.toContain(fakeTokenResponse.access_token);
  expect(output).not.toContain(fakeTokenResponse.refresh_token);
});
