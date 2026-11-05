import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { loopbackLogin } from '../src/auth/loopback';
import { chooseLoginMethod, deviceLogin } from '../src/auth/device';
import { localAuthServer, fakeTokenResponse } from './auth-support';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.restoreAllMocks();
});

describe('loopback OAuth', () => {
  it('exchanges a valid callback with PKCE, client ID and REST audience', async () => {
    let authorize: URL;
    let exchange: URLSearchParams | undefined;
    const server = await localAuthServer((_req, res, body) => {
      exchange = body;
      res.end(JSON.stringify(fakeTokenResponse));
    });
    cleanup.push(server.close);
    const result = await loopbackLogin(server.base, server.metadata, {
      onAuthorize: async (value) => {
        authorize = new URL(value);
        expect(authorize.searchParams.get('scope')).toBe('read write');
        expect(authorize.searchParams.get('resource')).toBe(server.base);
        expect(authorize.searchParams.get('client_id')).toBe(
          `${server.base}/oauth/clients/trooly-cli.json`,
        );
        const callback = new URL(authorize.searchParams.get('redirect_uri')!);
        expect(callback.hostname).toBe('127.0.0.1');
        callback.search = new URLSearchParams({
          code: 'fake-auth-code',
          state: authorize.searchParams.get('state')!,
          iss: server.base,
        }).toString();
        expect((await fetch(callback)).status).toBe(200);
      },
    });
    expect(result.access_token).toBe(fakeTokenResponse.access_token);
    expect(exchange?.get('grant_type')).toBe('authorization_code');
    expect(exchange?.get('resource')).toBe(server.base);
    expect(createHash('sha256').update(exchange!.get('code_verifier')!).digest('base64url')).toBe(
      authorize!.searchParams.get('code_challenge'),
    );
  });

  it.each(['state', 'iss', 'denied', 'missing', 'duplicate'] as const)(
    'rejects %s callbacks and never exchanges a code',
    async (mode) => {
      let exchanges = 0;
      const server = await localAuthServer((_req, res) => {
        exchanges++;
        res.end('{}');
      });
      cleanup.push(server.close);
      const promise = loopbackLogin(server.base, server.metadata, {
        onAuthorize: async (value) => {
          const authorize = new URL(value);
          const callback = new URL(authorize.searchParams.get('redirect_uri')!);
          callback.search = new URLSearchParams({
            code: 'fake-code',
            state: mode === 'state' ? 'wrong' : authorize.searchParams.get('state')!,
            iss: mode === 'iss' ? 'wrong' : server.base,
          }).toString();
          if (mode === 'denied') callback.searchParams.set('error', 'access_denied');
          if (mode === 'missing') callback.searchParams.delete('code');
          if (mode === 'duplicate') {
            callback.searchParams.append('state', authorize.searchParams.get('state')!);
          }
          await fetch(callback);
        },
      });
      await expect(promise).rejects.toMatchObject({ exitCode: 3 });
      expect(exchanges).toBe(0);
    },
  );

  it('times out and releases its listener', async () => {
    const server = await localAuthServer((_req, res) => res.end('{}'));
    cleanup.push(server.close);
    let callback = '';
    await expect(
      loopbackLogin(server.base, server.metadata, {
        timeoutMs: 30,
        onAuthorize: (value) => {
          callback = new URL(value).searchParams.get('redirect_uri')!;
        },
      }),
    ).rejects.toMatchObject({ code: 'LOGIN_TIMEOUT', exitCode: 3 });
    await expect(fetch(callback)).rejects.toThrow();
  });

  it('cancels on abort', async () => {
    const server = await localAuthServer((_req, res) => res.end('{}'));
    cleanup.push(server.close);
    const controller = new AbortController();
    await expect(
      loopbackLogin(server.base, server.metadata, {
        signal: controller.signal,
        onAuthorize: () => controller.abort(),
      }),
    ).rejects.toMatchObject({ code: 'LOGIN_CANCELLED' });
  });
});

describe('device OAuth', () => {
  it.each([
    {},
    { verification_uri: 'not-a-url' },
    { verification_uri: 'http://example.com' },
    { verification_uri: 'https://example.com', user_code: '\u001b[31m' },
  ])('rejects invalid device instructions', async (fields) => {
    const server = await localAuthServer((_req, res) =>
      res.end(
        JSON.stringify({
          device_code: 'fake-device',
          user_code: 'BCDF-GHJK',
          expires_in: 600,
          ...fields,
        }),
      ),
    );
    cleanup.push(server.close);
    const onCode = vi.fn();
    await expect(deviceLogin(server.base, server.metadata, { onCode })).rejects.toMatchObject({
      code: 'INVALID_DEVICE_RESPONSE',
    });
    expect(onCode).not.toHaveBeenCalled();
  });
  it('waits for pending authorization, increases every subsequent interval on slow_down, and preserves audience', async () => {
    const requests: URLSearchParams[] = [];
    let polls = 0;
    const server = await localAuthServer((req, res, body) => {
      requests.push(body);
      if (req.url === '/device') {
        res.end(
          JSON.stringify({
            device_code: 'fake-device',
            user_code: 'BCDF-GHJK',
            verification_uri: `${server.base}/verify`,
            verification_uri_complete: `${server.base}/verify?code=BCDF-GHJK`,
            interval: 5,
            expires_in: 600,
          }),
        );
        return;
      }
      polls++;
      if (polls < 4) {
        res
          .writeHead(400)
          .end(JSON.stringify({ error: polls === 2 ? 'slow_down' : 'authorization_pending' }));
        return;
      }
      res.end(JSON.stringify(fakeTokenResponse));
    });
    cleanup.push(server.close);
    let now = 0;
    const waits: number[] = [];
    const onCode = vi.fn();
    const result = await deviceLogin(server.base, server.metadata, {
      now: () => now,
      wait: async (ms) => {
        waits.push(ms);
        now += ms;
      },
      onCode,
    });
    expect(waits).toEqual([5000, 5000, 10000, 10000]);
    expect(result.access_token).toBe(fakeTokenResponse.access_token);
    expect(onCode.mock.calls[0][0].user_code).toBe('BCDF-GHJK');
    expect(requests.every((body) => body.get('resource') === server.base)).toBe(true);
    expect(requests[0].get('scope')).toBe('read write');
  });
  it.each(['expired_token', 'access_denied'])('maps %s to login failure', async (error) => {
    const server = await localAuthServer((req, res) => {
      if (req.url === '/device') {
        res.end(
          JSON.stringify({
            device_code: 'fake-device',
            user_code: 'BCDF-GHJK',
            verification_uri: `${server.base}/verify`,
            expires_in: 600,
          }),
        );
      } else {
        res.writeHead(400).end(JSON.stringify({ error }));
      }
    });
    cleanup.push(server.close);
    await expect(
      deviceLogin(server.base, server.metadata, { wait: async () => {}, onCode: () => {} }),
    ).rejects.toMatchObject({ code: error, exitCode: 3 });
  });
  it('expires locally without polling past the deadline', async () => {
    let polls = 0;
    const server = await localAuthServer((req, res) => {
      if (req.url === '/device') {
        res.end(
          JSON.stringify({
            device_code: 'fake-device',
            user_code: 'BCDF-GHJK',
            verification_uri: `${server.base}/verify`,
            expires_in: 1,
          }),
        );
      } else {
        polls++;
        res.end('{}');
      }
    });
    cleanup.push(server.close);
    let now = 0;
    await expect(
      deviceLogin(server.base, server.metadata, {
        now: () => now,
        wait: async (ms) => {
          now += ms;
        },
        onCode: () => {},
      }),
    ).rejects.toMatchObject({ code: 'expired_token' });
    expect(polls).toBe(0);
  });
});

describe('login method selection', () => {
  it.each(['darwin', 'linux', 'win32'] as const)(
    'uses a device code without an interactive terminal on %s',
    (platform) => {
      expect(chooseLoginMethod(false, { DISPLAY: ':1' }, platform, false)).toBe('device');
    },
  );
  it.each([
    [true, {}, 'darwin', 'device'],
    [false, { SSH_CONNECTION: '' }, 'darwin', 'device'],
    [false, { SSH_TTY: 'fake' }, 'win32', 'device'],
    [false, {}, 'linux', 'device'],
    [false, { DISPLAY: ':1' }, 'linux', 'loopback'],
    [false, { WAYLAND_DISPLAY: 'wayland-0' }, 'linux', 'loopback'],
    [false, {}, 'darwin', 'loopback'],
    [false, {}, 'win32', 'loopback'],
  ] as const)(
    'chooses based on explicit request and environment',
    (device, env, platform, expected) => {
      expect(chooseLoginMethod(device, env, platform, true)).toBe(expected);
    },
  );
});
