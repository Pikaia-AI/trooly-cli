import { join } from 'node:path';
import { getPaths } from '../config/paths';
import { readJson, withFileLock, writeJson } from '../config/files';
import { validateProfileName } from '../config/profiles';
import { CliError } from '../http/errors';
import type { StoredTokens } from '../types/oauth';
import { registerSecrets } from '../output/json';

export interface KeyringEntry {
  getPassword(): string | null;
  setPassword(value: string): void;
  deleteCredential(): boolean;
}
export type KeyringLoader = () => Promise<{
  Entry: new (service: string, account: string) => KeyringEntry;
}>;
type FileCredentials = Record<string, StoredTokens | null>;

function validateTokens(value: unknown): StoredTokens {
  const tokens = value as StoredTokens;
  if (
    !tokens ||
    typeof tokens.access_token !== 'string' ||
    !tokens.access_token ||
    typeof tokens.refresh_token !== 'string' ||
    !tokens.refresh_token ||
    !Number.isFinite(tokens.access_expires_at)
  ) {
    throw new CliError(
      'Invalid locally stored credentials. Run trooly login again.',
      3,
      'INVALID_CREDENTIALS',
    );
  }
  registerSecrets(tokens.access_token, tokens.refresh_token);
  return tokens;
}

export class CredentialStore {
  constructor(private loadKeyring: KeyringLoader = () => import('@napi-rs/keyring')) {}
  private async file(): Promise<FileCredentials> {
    return readJson(getPaths().credentialsFile, {});
  }
  private async updateFile(action: (credentials: FileCredentials) => void): Promise<void> {
    const { credentialsFile } = getPaths();
    await withFileLock(credentialsFile, async () => {
      const credentials = await this.file();
      action(credentials);
      await writeJson(credentialsFile, credentials);
    });
  }
  private async warnFallback(): Promise<void> {
    const path = join(getPaths().cacheDir, 'credential-file-notice.json');
    await withFileLock(path, async () => {
      const state = await readJson(path, { shown: false });
      if (!state.shown) {
        process.stderr.write(
          'System keyring unavailable; credentials are stored in a private local file.\n',
        );
        await writeJson(path, { shown: true });
      }
    });
  }
  async read(name: string): Promise<StoredTokens | undefined> {
    validateProfileName(name);
    // A file entry is authoritative after a keyring failure. A null entry is a
    // logout tombstone so a temporarily inaccessible old keyring cannot revive it.
    const file = await this.file();
    if (Object.hasOwn(file, name)) {
      return file[name] === null ? undefined : validateTokens(file[name]);
    }
    if (process.env.TROOLY_CREDENTIAL_STORE === 'file') return undefined;
    try {
      const { Entry } = await this.loadKeyring();
      const raw = new Entry('trooly-cli', name).getPassword();
      return raw ? validateTokens(JSON.parse(raw)) : undefined;
    } catch (error) {
      if (error instanceof CliError) throw error;
      await this.warnFallback();
      return undefined;
    }
  }
  async write(name: string, value: StoredTokens): Promise<void> {
    validateProfileName(name);
    const tokens = validateTokens(value);
    const file = await this.file();
    // Keep an active file entry authoritative if the keyring later recovers with older tokens.
    if (
      process.env.TROOLY_CREDENTIAL_STORE !== 'file' &&
      (!Object.hasOwn(file, name) || file[name] === null)
    ) {
      try {
        const { Entry } = await this.loadKeyring();
        new Entry('trooly-cli', name).setPassword(JSON.stringify(tokens));
        if (Object.hasOwn(file, name)) {
          await this.updateFile((entries) => {
            delete entries[name];
          });
        }
        return;
      } catch {
        await this.warnFallback();
      }
    }
    await this.updateFile((entries) => {
      entries[name] = tokens;
    });
  }
  async remove(name: string): Promise<void> {
    validateProfileName(name);
    await this.updateFile((entries) => {
      entries[name] = null;
    });
    if (process.env.TROOLY_CREDENTIAL_STORE !== 'file') {
      try {
        const { Entry } = await this.loadKeyring();
        new Entry('trooly-cli', name).deleteCredential();
      } catch {
        /* The tombstone prevents reuse even if the keyring is unavailable. */
      }
    }
  }
}
export const credentialStore = new CredentialStore();
