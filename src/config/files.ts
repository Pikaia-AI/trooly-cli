import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import lockfile from 'proper-lockfile';
import { CliError } from '../http/errors';

const exec = promisify(execFile);
export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw new CliError(
      'Cannot read local configuration or credentials. Check the file format and permissions.',
      1,
      'LOCAL_STORAGE_ERROR',
    );
  }
}

export async function restrictAccess(path: string): Promise<void> {
  if (process.platform !== 'win32') {
    await chmod(path, 0o600);
    return;
  }
  // Use the current SID rather than a localized account/group name.
  const { stdout } = await exec('whoami', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true });
  const sid = stdout.match(/S-1-\d+(?:-\d+)+/)?.[0];
  if (!sid) {
    throw new CliError('Cannot determine the current Windows user for private credential storage.');
  }
  await exec('icacls', [path, '/inheritance:r', '/grant:r', `*${sid}:(F)`], { windowsHide: true });
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    // Restrict the empty file before writing secret content (including Windows ACLs).
    await writeFile(temporary, '', { mode: 0o600, flag: 'wx' });
    await restrictAccess(temporary);
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function withFileLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const release = await lockfile.lock(path, {
    // First-time writes need a lock even before the target file exists.
    realpath: false,
    stale: 30000,
    update: 10000,
    retries: { retries: 100, minTimeout: 100, maxTimeout: 500, factor: 1.2 },
  });
  try {
    return await action();
  } finally {
    await release();
  }
}
