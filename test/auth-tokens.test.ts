import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ApiClient } from '../src/http/client';
import { credentialStore } from '../src/auth/store';
import { ensureAccessToken, withProfileLock } from '../src/auth/tokens';
import { resolveProfile, saveProfile, removeProfile } from '../src/config/profiles';
import { logout } from '../src/commands/auth';
import { registerAuth } from '../src/commands/auth';
import { registerProfile } from '../src/commands/profile';
import { Command } from 'commander';
import { fakeTokenResponse, localAuthServer, temporaryAuthHome } from './auth-support';

let home: Awaited<ReturnType<typeof temporaryAuthHome>>;
const cleanup: Array<() => Promise<void>> = [];
beforeEach(async () => {
  home = await temporaryAuthHome();
  for (const [key, value] of Object.entries(home.env)) vi.stubEnv(key, value);
  vi.stubEnv('TROOLY_API_KEY', '');
  vi.stubEnv('TROOLY_PROFILE', 'default');
  vi.stubEnv('TROOLY_API_BASE', undefined);
});
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  await home.clean();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
async function save(base: string, expires = Date.now() + 1000) {
  await saveProfile('default', { api_base: base, auth: 'oauth' });
  await credentialStore.write('default', {
    access_token: 'fake-access-old',
    refresh_token: 'fake-refresh-old',
    access_expires_at: expires,
  });
  return resolveProfile();
}

describe('token refresh', () => {
  it('refreshes in the last 60 seconds and persists the rotated pair', async () => {
    let calls = 0;
    const server = await localAuthServer((_req, res, body) => {
      calls++;
      expect(body.get('grant_type')).toBe('refresh_token');
      expect(body.get('refresh_token')).toBe('fake-refresh-old');
      expect(body.get('resource')).toBe(server.base);
      res.end(JSON.stringify(fakeTokenResponse));
    });
    cleanup.push(server.close);
    const profile = await save(server.base, Date.now() + 59000);
    expect(await ensureAccessToken(profile)).toBe('fake-access-new');
    expect(await ensureAccessToken(profile)).toBe('fake-access-new');
    expect(calls).toBe(1);
    expect((await credentialStore.read('default'))?.refresh_token).toBe('fake-refresh-new');
  });
  it('does not refresh an unexpired token', async () => {
    // Keep the 60-second boundary independent of filesystem/Windows ACL latency.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    const profile = await save('http://127.0.0.1:1', Date.now() + 61000);
    expect(await ensureAccessToken(profile)).toBe('fake-access-old');
  });
  it('uses API keys without reading OAuth credentials', async () => {
    vi.stubEnv('TROOLY_API_KEY', 'fake-api-key');
    const read = vi.spyOn(credentialStore, 'read');
    expect(await ensureAccessToken(await resolveProfile())).toBe('fake-api-key');
    expect(read).not.toHaveBeenCalled();
  });
  it('deletes credentials on invalid_grant', async () => {
    const server = await localAuthServer((_req, res) =>
      res.writeHead(400).end(JSON.stringify({ error: 'invalid_grant' })),
    );
    cleanup.push(server.close);
    const profile = await save(server.base);
    await expect(ensureAccessToken(profile)).rejects.toMatchObject({
      exitCode: 3,
      code: 'invalid_grant',
    });
    expect(await credentialStore.read('default')).toBeUndefined();
  });
  it('does not send stored OAuth credentials to an overridden gateway', async () => {
    const profile = await save('http://127.0.0.1:1');
    await expect(
      ensureAccessToken({ ...profile, apiBase: 'http://127.0.0.1:2' }),
    ).rejects.toMatchObject({ code: 'PROFILE_GATEWAY_MISMATCH' });
  });
  it.each([false, true])(
    'rereads gateway under the credential lock after remove/recreate (expired=%s)',
    async (expired) => {
      let traffic = 0;
      const gatewayA = await localAuthServer((_req, res) => {
        traffic++;
        res.end(JSON.stringify(fakeTokenResponse));
      });
      const gatewayB = await localAuthServer((_req, res) => {
        traffic++;
        res.end(JSON.stringify(fakeTokenResponse));
      });
      cleanup.push(gatewayA.close, gatewayB.close);
      const stale = await save(gatewayA.base, Date.now() + 3600000);
      let entered!: () => void;
      let proceed!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        proceed = resolve;
      });
      const recreation = withProfileLock('default', async () => {
        entered();
        await gate;
        await credentialStore.remove('default');
        await removeProfile('default');
        await saveProfile('default', { api_base: gatewayB.base, auth: 'oauth' });
        await credentialStore.write('default', {
          access_token: 'fake-gateway-b-access',
          refresh_token: 'fake-gateway-b-refresh',
          access_expires_at: Date.now() + (expired ? -1 : 3600000),
        });
      });
      await ready;
      const request = ensureAccessToken(stale);
      const rejected = expect(request).rejects.toMatchObject({ code: 'PROFILE_GATEWAY_MISMATCH' });
      proceed();
      await recreation;
      await rejected;
      expect(traffic).toBe(0);
      expect((await credentialStore.read('default'))?.refresh_token).toBe('fake-gateway-b-refresh');
    },
  );
  it('does not use orphaned tokens without an authoritative stored profile', async () => {
    const stale = await save('http://127.0.0.1:1', Date.now() + 3600000);
    await removeProfile('default');
    vi.stubEnv('TROOLY_API_BASE', stale.apiBase);
    const read = vi.spyOn(credentialStore, 'read');
    await expect(ensureAccessToken(stale)).rejects.toMatchObject({ code: 'NOT_LOGGED_IN' });
    expect(read).not.toHaveBeenCalled();
  });
  it('forces one refresh after invalid_token, then retries the API only once', async () => {
    let apiCalls = 0;
    let refreshCalls = 0;
    const server = await localAuthServer((req, res) => {
      if (req.url === '/token') {
        refreshCalls++;
        res.end(JSON.stringify(fakeTokenResponse));
        return;
      }
      apiCalls++;
      res
        .writeHead(401)
        .end(JSON.stringify({ error: { code: 'invalid_token', message: 'Invalid token' } }));
    });
    cleanup.push(server.close);
    await save(server.base, Date.now() + 3600000);
    await expect(
      new ApiClient({ apiBase: server.base, profileName: 'default' }).request(
        'GET',
        '/trooly/v1/projects',
      ),
    ).rejects.toMatchObject({ exitCode: 3 });
    expect(apiCalls).toBe(2);
    expect(refreshCalls).toBe(1);
  });
  it('does not rotate again when a rejected token was already replaced', async () => {
    let calls = 0;
    const server = await localAuthServer((_req, res) => {
      calls++;
      res.end(JSON.stringify(fakeTokenResponse));
    });
    cleanup.push(server.close);
    const profile = await save(server.base, Date.now() + 3600000);
    await ensureAccessToken(profile, 'fake-access-old');
    await ensureAccessToken(profile, 'fake-access-old');
    expect(calls).toBe(1);
  });

  it.each([false, true])(
    'serializes two real processes (forced=%s)',
    async (forced) => {
      let refreshCalls = 0;
      const server = await localAuthServer(async (_req, res) => {
        refreshCalls++;
        await new Promise((resolve) => setTimeout(resolve, 150));
        res.end(JSON.stringify(fakeTokenResponse));
      });
      cleanup.push(server.close);
      await save(server.base, forced ? Date.now() + 3600000 : Date.now() - 1000);
      const children: ChildProcess[] = [];
      try {
        const launch = () => {
          const child = fork(
            fileURLToPath(new URL('./fixtures/auth-refresh-worker.ts', import.meta.url)),
            [],
            {
              execArgv: ['--import', 'tsx'],
              stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
              env: {
                ...process.env,
                ...home.env,
                REJECTED_FAKE_TOKEN: forced ? 'fake-access-old' : '',
              },
            },
          );
          children.push(child);
          const ready = new Promise<void>((resolve, reject) => {
            child.once('message', () => resolve());
            child.once('error', reject);
            child.once('exit', (code) => {
              if (code) reject(new Error('Child failed before ready'));
            });
          });
          const done = new Promise<void>((resolve, reject) => {
            child.on('message', (value) => {
              if (typeof value === 'object' && value !== null && 'ok' in value && !value.ok) {
                reject(new Error('Child refresh failed'));
              }
            });
            child.once('exit', (code) =>
              code === 0 ? resolve() : reject(new Error('Child exited unsuccessfully')),
            );
            child.once('error', reject);
          });
          return { child, ready, done };
        };
        const a = launch();
        const b = launch();
        await Promise.all([a.ready, b.ready]);
        a.child.send('go');
        b.child.send('go');
        await Promise.all([a.done, b.done]);
        expect(refreshCalls).toBe(1);
        expect((await credentialStore.read('default'))?.access_token).toBe('fake-access-new');
      } finally {
        for (const child of children) if (child.exitCode === null) child.kill();
      }
    },
    15000,
  );
});

describe('logout', () => {
  it('does not revoke or erase a recreated profile on a different gateway', async () => {
    let traffic = 0;
    const gatewayA = await localAuthServer((_req, res) => {
      traffic++;
      res.end();
    });
    const gatewayB = await localAuthServer((_req, res) => {
      traffic++;
      res.end();
    });
    cleanup.push(gatewayA.close, gatewayB.close);
    const stale = await save(gatewayA.base);
    await withProfileLock('default', async () => {
      await credentialStore.remove('default');
      await removeProfile('default');
      await saveProfile('default', { api_base: gatewayB.base, auth: 'oauth' });
      await credentialStore.write('default', {
        access_token: 'fake-b-access',
        refresh_token: 'fake-b-refresh',
        access_expires_at: Date.now() + 3600000,
      });
    });
    await expect(logout(stale, true)).rejects.toMatchObject({ code: 'PROFILE_GATEWAY_MISMATCH' });
    expect((await credentialStore.read('default'))?.refresh_token).toBe('fake-b-refresh');
    expect((await resolveProfile()).apiBase).toBe(gatewayB.base);
    expect(traffic).toBe(0);
  });
  it('revokes the refresh token and removes local credentials', async () => {
    let sent: URLSearchParams | undefined;
    const server = await localAuthServer((_req, res, body) => {
      sent = body;
      res.end();
    });
    cleanup.push(server.close);
    await logout(await save(server.base));
    expect(sent?.get('token')).toBe('fake-refresh-old');
    expect(sent?.get('token_type_hint')).toBe('refresh_token');
    expect(await credentialStore.read('default')).toBeUndefined();
  });
  it('still deletes local credentials when revocation fails', async () => {
    const server = await localAuthServer((_req, res) => res.writeHead(503).end('{}'));
    cleanup.push(server.close);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await logout(await save(server.base));
    expect(await credentialStore.read('default')).toBeUndefined();
    expect(stderr.mock.calls.flat().join(' ')).toContain('Connected applications');
    expect(stderr.mock.calls.flat().join(' ')).not.toContain('fake-refresh');
  });
});

describe('auth and profile commands', () => {
  function program() {
    const cli = new Command().exitOverride().option('--profile <name>').option('--json');
    registerAuth(cli);
    registerProfile(cli);
    return cli;
  }
  it('rejects changing an existing profile gateway before beginning login', async () => {
    await save('http://127.0.0.1:1');
    vi.stubEnv('TROOLY_API_BASE', 'http://127.0.0.1:2');
    await expect(
      program().parseAsync(['node', 'trooly', 'login', '--device']),
    ).rejects.toMatchObject({ code: 'PROFILE_GATEWAY_MISMATCH' });
  });
  it('revalidates gateway at login commit after the profile was concurrently recreated', async () => {
    const identity = {
      credential: { type: 'oauth', id: 'grant_fake', environment: 'live' },
      principal: { type: 'user', id: 'usr_fake', name: 'Example' },
      organization: { id: 'org_fake', name: 'Example', type: 'business' },
      permissions: [],
    };
    const gatewayB = await localAuthServer((_req, res) => res.end());
    const gatewayA = await localAuthServer(async (req, res) => {
      if (req.url === '/device') {
        res.end(
          JSON.stringify({
            device_code: 'fake-device',
            user_code: 'BCDF-GHJK',
            verification_uri: `${gatewayA.base}/verify`,
            expires_in: 600,
            interval: 0.001,
          }),
        );
        return;
      }
      if (req.url === '/token') {
        res.end(JSON.stringify(fakeTokenResponse));
        return;
      }
      await withProfileLock('default', async () => {
        await credentialStore.remove('default');
        await removeProfile('default');
        await saveProfile('default', { api_base: gatewayB.base, auth: 'oauth' });
        await credentialStore.write('default', {
          access_token: 'fake-b-access',
          refresh_token: 'fake-b-refresh',
          access_expires_at: Date.now() + 3600000,
        });
      });
      res.end(JSON.stringify({ data: identity }));
    });
    cleanup.push(gatewayA.close, gatewayB.close);
    await save(gatewayA.base);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await expect(
      program().parseAsync(['node', 'trooly', 'login', '--device']),
    ).rejects.toMatchObject({ code: 'PROFILE_GATEWAY_MISMATCH' });
    expect((await credentialStore.read('default'))?.refresh_token).toBe('fake-b-refresh');
    expect((await resolveProfile()).apiBase).toBe(gatewayB.base);
  });
  it('logs in through device flow, saves identity, reports raw status, and switches profiles', async () => {
    const identity = {
      credential: { type: 'oauth', id: 'grant_fake', environment: 'live' },
      principal: { type: 'user', id: 'usr_fake', name: 'Example user' },
      organization: { id: 'org_fake', name: 'Example organization', type: 'business' },
      permissions: ['trooly.project.read'],
    };
    const seenHeaders: Array<string | undefined> = [];
    const server = await localAuthServer((req, res) => {
      if (req.url === '/device') {
        res.end(
          JSON.stringify({
            device_code: 'fake-device',
            user_code: 'BCDF-GHJK',
            verification_uri: `${server.base}/verify`,
            expires_in: 600,
            interval: 0.001,
          }),
        );
        return;
      }
      if (req.url === '/token') {
        res.end(JSON.stringify(fakeTokenResponse));
        return;
      }
      if (req.url === '/platform/v2/credential') {
        seenHeaders.push(req.headers.authorization);
        res.end(JSON.stringify({ data: identity }));
        return;
      }
      res.end();
    });
    cleanup.push(server.close);
    vi.stubEnv('TROOLY_API_BASE', server.base);
    const writeTokens = credentialStore.write.bind(credentialStore);
    vi.spyOn(credentialStore, 'write').mockImplementation(async (name, tokens) => {
      expect((await resolveProfile(name)).stored?.api_base).toBe(server.base);
      await writeTokens(name, tokens);
    });
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await program().parseAsync([
      'node',
      'trooly',
      'login',
      '--device',
      '--profile',
      'sample',
      '--json',
    ]);
    const saved = await resolveProfile('sample');
    expect(saved.stored?.organization).toEqual(identity.organization);
    expect(saved.stored?.environment).toBe('live');
    expect(saved.stored?.principal).toEqual(identity.principal);
    expect(stdout.mock.calls.map((call) => String(call[0])).join('')).not.toContain('fake-access');
    stdout.mockClear();
    await program().parseAsync([
      'node',
      'trooly',
      'auth',
      'status',
      '--profile',
      'sample',
      '--json',
    ]);
    expect(JSON.parse(stdout.mock.calls.map((call) => String(call[0])).join(''))).toEqual(identity);
    expect(seenHeaders).toEqual(['Bearer fake-access-new', 'Bearer fake-access-new']);
    await program().parseAsync(['node', 'trooly', 'profile', 'use', 'sample']);
    expect((await resolveProfile()).name).toBe('default'); // Explicit test environment still overrides the stored selection.
    stdout.mockClear();
    await program().parseAsync(['node', 'trooly', 'profile', 'list', '--json']);
    expect(JSON.parse(stdout.mock.calls.map((call) => String(call[0])).join(''))[0].current).toBe(
      true,
    );
  });
});
