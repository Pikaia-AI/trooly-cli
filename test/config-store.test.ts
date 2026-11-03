import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, join } from 'node:path';
import { CredentialStore } from '../src/auth/store';
import { getPaths } from '../src/config/paths';
import {
  loadProfiles,
  normalizeApiBase,
  removeProfile,
  resolveProfile,
  saveProfile,
  useProfile,
  validateProfileName,
} from '../src/config/profiles';
import { temporaryAuthHome } from './auth-support';

let home: Awaited<ReturnType<typeof temporaryAuthHome>>;
beforeEach(async () => {
  home = await temporaryAuthHome();
  for (const [key, value] of Object.entries(home.env)) vi.stubEnv(key, value);
  vi.stubEnv('TROOLY_API_BASE', undefined);
  vi.stubEnv('TROOLY_PROFILE', undefined);
});
afterEach(async () => {
  await home.clean();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
const tokens = {
  access_token: 'fake-access',
  refresh_token: 'fake-refresh',
  access_expires_at: 9999999999999,
};

describe('credential storage', () => {
  it.runIf(process.platform === 'win32')(
    'restricts the Windows credential ACL to the current SID',
    async () => {
      const store = new CredentialStore();
      await store.write('default', tokens);
      const exec = promisify(execFile);
      const { stdout } = await exec('whoami', ['/user', '/fo', 'csv', '/nh'], {
        windowsHide: true,
      });
      const sid = stdout.match(/S-1-\d+(?:-\d+)+/)?.[0];
      expect(sid).toBeDefined();

      const credentialPath = getPaths().credentialsFile;
      const aclPath = join(home.directory, 'credentials.acl');
      // /save exports SDDL with numeric SIDs and the actual inheritance-protection flag.
      // The display output resolves account names and cannot prove inheritance is disabled.
      await exec('icacls', [credentialPath, '/save', aclPath], { windowsHide: true });
      const lines = (await readFile(aclPath, 'utf16le')).trim().split(/\r?\n/);
      expect(lines).toHaveLength(2);
      expect(lines[0]).toBe(basename(credentialPath));
      const dacl = lines[1].match(/^D:((?:P|AI|AR)*)(\(.*\))$/);
      expect(dacl).not.toBeNull();
      expect(dacl![1]).toContain('P');
      // Exactly one allow ACE, no inheritance flags, full control, and the current SID.
      expect(dacl![2]).toBe(`(A;;FA;;;${sid})`);
      expect(await store.read('default')).toEqual(tokens);
    },
  );
  it('forces file storage without loading native modules and restricts permissions', async () => {
    const loader = vi.fn().mockRejectedValue(new Error('Must not load'));
    const store = new CredentialStore(loader);
    await store.write('default', tokens);
    expect(await store.read('default')).toEqual(tokens);
    expect(loader).not.toHaveBeenCalled();
    if (process.platform !== 'win32') {
      expect((await stat(getPaths().credentialsFile)).mode & 0o777).toBe(0o600);
    }
    await store.remove('default');
    expect(await store.read('default')).toBeUndefined();
  });
  it('falls back once when keyring cannot load', async () => {
    vi.stubEnv('TROOLY_CREDENTIAL_STORE', undefined);
    const loader = vi.fn().mockRejectedValue(new Error('Unavailable'));
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const store = new CredentialStore(loader);
    await store.write('a', tokens);
    await store.write('b', tokens);
    expect(await store.read('a')).toEqual(tokens);
    expect(
      stderr.mock.calls.filter((call) => String(call[0]).includes('keyring unavailable')),
    ).toHaveLength(1);
    if (process.platform !== 'win32') {
      expect((await stat(getPaths().credentialsFile)).mode & 0o777).toBe(0o600);
    }
  });
  it('uses lazy keyring entries with the expected service and profile account', async () => {
    vi.stubEnv('TROOLY_CREDENTIAL_STORE', undefined);
    const values = new Map<string, string>();
    const addresses: string[] = [];
    class Entry {
      constructor(
        service: string,
        private account: string,
      ) {
        addresses.push(`${service}/${account}`);
      }
      getPassword() {
        return values.get(this.account) ?? null;
      }
      setPassword(value: string) {
        values.set(this.account, value);
      }
      deleteCredential() {
        return values.delete(this.account);
      }
    }
    const loader = vi.fn(async () => ({ Entry }));
    const store = new CredentialStore(loader);
    expect(loader).not.toHaveBeenCalled();
    await store.write('example', tokens);
    expect(await store.read('example')).toEqual(tokens);
    expect(addresses).toEqual(['trooly-cli/example', 'trooly-cli/example']);
    await store.remove('example');
    expect(values.size).toBe(0);
  });
  it('prevents stale keyring credentials from reviving after failed deletion', async () => {
    vi.stubEnv('TROOLY_CREDENTIAL_STORE', undefined);
    const unavailable = new CredentialStore(async () => {
      throw new Error('Unavailable');
    });
    await unavailable.remove('default');
    const loader = vi.fn(async () => ({
      Entry: class {
        getPassword() {
          return JSON.stringify(tokens);
        }
        setPassword() {}
        deleteCredential() {
          return false;
        }
      },
    }));
    expect(await new CredentialStore(loader).read('default')).toBeUndefined();
    expect(loader).not.toHaveBeenCalled();
  });
  it('uses a recovered keyring for an explicit new login after a logout tombstone', async () => {
    vi.stubEnv('TROOLY_CREDENTIAL_STORE', undefined);
    const previous = {
      ...tokens,
      access_token: 'fake-old-keyring-access',
      refresh_token: 'fake-old-keyring-refresh',
    };
    const replacement = {
      ...tokens,
      access_token: 'fake-new-keyring-access',
      refresh_token: 'fake-new-keyring-refresh',
    };
    let password: string | null = JSON.stringify(previous);
    let available = false;
    const loader = vi.fn(async () => {
      if (!available) throw new Error('Keyring temporarily unavailable');
      return {
        Entry: class {
          getPassword() {
            return password;
          }
          setPassword(value: string) {
            password = value;
          }
          deleteCredential() {
            password = null;
            return true;
          }
        },
      };
    });
    const store = new CredentialStore(loader);
    await store.remove('default');
    available = true;
    loader.mockClear();
    expect(await store.read('default')).toBeUndefined();
    expect(loader).not.toHaveBeenCalled();
    await store.write('default', replacement);
    expect(JSON.parse(password!)).toEqual(replacement);
    expect(JSON.parse(await readFile(getPaths().credentialsFile, 'utf8'))).toEqual({});
    expect(await new CredentialStore(loader).read('default')).toEqual(replacement);
  });
  it('falls back to the file for a new login when the keyring remains unavailable', async () => {
    vi.stubEnv('TROOLY_CREDENTIAL_STORE', undefined);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const loader = vi.fn().mockRejectedValue(new Error('Unavailable'));
    const store = new CredentialStore(loader);
    await store.remove('default');
    await store.write('default', tokens);
    expect(JSON.parse(await readFile(getPaths().credentialsFile, 'utf8')).default).toEqual(tokens);
    loader.mockClear();
    expect(await store.read('default')).toEqual(tokens);
    expect(loader).not.toHaveBeenCalled();
  });
  it('does not lose different profiles when their file writes race', async () => {
    const store = new CredentialStore();
    await Promise.all(Array.from({ length: 5 }, (_, i) => store.write(`profile-${i}`, tokens)));
    const raw = JSON.parse(await readFile(getPaths().credentialsFile, 'utf8'));
    expect(Object.keys(raw)).toHaveLength(5);
  });
});

describe('profiles', () => {
  it('selects explicit flag, then environment, then current profile', async () => {
    await saveProfile('first', { api_base: 'http://127.0.0.1:1' });
    await saveProfile('second', { api_base: 'http://127.0.0.1:2' });
    expect((await resolveProfile()).name).toBe('first');
    vi.stubEnv('TROOLY_PROFILE', 'second');
    expect((await resolveProfile()).name).toBe('second');
    expect((await resolveProfile('first')).name).toBe('first');
    vi.stubEnv('TROOLY_API_BASE', 'http://127.0.0.1:3');
    expect((await resolveProfile()).apiBase).toBe('http://127.0.0.1:3');
    vi.stubEnv('TROOLY_PROFILE', undefined);
    await useProfile('second');
    expect((await resolveProfile()).name).toBe('second');
    await removeProfile('second');
    expect((await loadProfiles()).current_profile).toBe('first');
  });
  it.each(['../escape', '__proto__', 'constructor', '', 'space name'])(
    'rejects unsafe profile %s',
    (name) => expect(() => validateProfileName(name)).toThrow(),
  );
  it.each([
    'http://example.com',
    'https://example.com/path',
    'https://user:pass@example.com',
    'https://example.com?x=1',
    'not-url',
  ])('rejects invalid base %s', (base) => expect(() => normalizeApiBase(base)).toThrow());
  it('rejects selecting an unknown profile', async () => {
    await expect(useProfile('missing')).rejects.toMatchObject({ exitCode: 2 });
  });
  it('uses platform-specific configuration and cache roots', () => {
    expect(
      getPaths(
        { XDG_CONFIG_HOME: '/config', XDG_CACHE_HOME: '/cache' },
        'linux',
        '/fake',
      ).configFile.replaceAll('\\', '/'),
    ).toBe('/config/trooly/config.json');
    expect(
      getPaths(
        { APPDATA: '/roaming', LOCALAPPDATA: '/local' },
        'win32',
        '/fake',
      ).cacheDir.replaceAll('\\', '/'),
    ).toBe('/local/trooly');
  });
});
