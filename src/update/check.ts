import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { getPaths } from '../config/paths';
import { CLI_VERSION } from '../version';
import { CliError } from '../http/errors';
import { compareVersions, requireVersion, validVersion } from './semver';

export const UPDATE_TTL = 24 * 60 * 60 * 1000;
interface CheckCache {
  current: string;
  checkedAt: number;
  latest: string;
  notifiedAt?: number;
  notifiedVersion?: string;
}
export async function registryAddress(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): Promise<string> {
  let value = env.npm_config_registry;
  if (!value) {
    try {
      const npmrc = await readFile(join(home, '.npmrc'), 'utf8');
      value = /^\s*registry\s*=\s*([^\r\n]+)$/m.exec(npmrc)?.[1]?.trim();
    } catch {
      /* A missing npmrc uses the public registry. */
    }
  }
  const url = new URL(value || 'https://registry.npmjs.org');
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new CliError('Invalid npm registry URL.', 2, 'INVALID_REGISTRY');
  }
  return url.href.replace(/\/$/, '');
}
export type UpdateChannel = 'latest' | 'next';
export function requireChannel(channel: string): UpdateChannel {
  if (channel !== 'latest' && channel !== 'next') {
    throw new CliError('Channel must be latest or next.', 2, 'INVALID_CHANNEL');
  }
  return channel;
}
// Both explicit updates and daily checks resolve registry tags here. Build
// metadata does not make a release a prerelease, even when it contains a hyphen.
export function selectTargetVersion(
  tags: { latest?: unknown; next?: unknown } | undefined,
  current: string,
  channel?: UpdateChannel,
): string {
  requireVersion(current);
  const candidates = channel
    ? [tags?.[channel]]
    : current.split('+')[0].includes('-')
      ? [tags?.latest, tags?.next]
      : [tags?.latest];
  const versions = candidates.filter(validVersion);
  if (!versions.length) {
    throw new CliError(
      `npm registry did not return a valid release version${channel ? ` for channel ${channel}` : ''}.`,
      1,
      'REGISTRY_ERROR',
    );
  }
  return versions.reduce((highest, version) =>
    compareVersions(version, highest) > 0 ? version : highest,
  );
}
export async function fetchTargetVersion(
  version?: string,
  options: {
    signal?: AbortSignal;
    env?: NodeJS.ProcessEnv;
    home?: string;
    channel?: UpdateChannel;
  } = {},
): Promise<string> {
  if (version) requireVersion(version);
  const registry = await registryAddress(options.env, options.home);
  const response = await fetch(`${registry}/trooly`, {
    signal: options.signal ?? AbortSignal.timeout(1500),
    redirect: 'error',
  });
  if (!response.ok) {
    throw new CliError(`npm registry returned HTTP ${response.status}.`, 1, 'REGISTRY_ERROR');
  }
  const body = (await response.json()) as {
    'dist-tags'?: { latest?: unknown; next?: unknown };
    versions?: Record<string, unknown>;
  };
  const target = version ?? selectTargetVersion(body['dist-tags'], CLI_VERSION, options.channel);
  if (!validVersion(target)) {
    throw new CliError('npm registry did not return a valid release version.', 1, 'REGISTRY_ERROR');
  }
  if (version && !body.versions?.[version]) {
    throw new CliError(`Version ${version} is not published.`, 2, 'VERSION_NOT_FOUND');
  }
  return target;
}
export function shouldCheckUpdate(
  env: NodeJS.ProcessEnv,
  stderrTTY: boolean,
  isUpdate: boolean,
): boolean {
  return !('CI' in env) && stderrTTY && env.TROOLY_NO_UPDATE_CHECK !== '1' && !isUpdate;
}
async function readCache(path: string): Promise<CheckCache | undefined> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as CheckCache;
    return value.current === CLI_VERSION &&
      Number.isFinite(value.checkedAt) &&
      validVersion(value.latest)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}
async function saveCache(path: string, value: CheckCache): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}
async function acquireAdvisoryLock(path: string): Promise<(() => Promise<void>) | undefined> {
  try {
    await mkdir(dirname(path), { recursive: true });
    return await lockfile.lock(path, { realpath: false, retries: 0, stale: 30000 });
  } catch {
    // Another process checking/notifying is enough. Advisory work never waits
    // for a lock and never turns an unavailable cache into a command error.
    return undefined;
  }
}
export function startUpdateCheck(
  options: {
    isUpdate?: boolean;
    env?: NodeJS.ProcessEnv;
    stderrTTY?: boolean;
    now?: () => number;
    write?: (text: string) => void;
  } = {},
): { settled: Promise<void>; finish(): Promise<void> } {
  const env = options.env ?? process.env;
  if (
    !shouldCheckUpdate(
      env,
      options.stderrTTY ?? Boolean(process.stderr.isTTY),
      options.isUpdate ?? false,
    )
  ) {
    return { settled: Promise.resolve(), finish: async () => {} };
  }
  const now = options.now ?? Date.now;
  const write = options.write ?? ((text) => process.stderr.write(text));
  const path = join(getPaths().cacheDir, 'update-check.json');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  timer.unref();
  let ready: CheckCache | undefined;
  let finished = false;
  const work = (async () => {
    const release = await acquireAdvisoryLock(path);
    if (!release) return;
    let result: CheckCache | undefined;
    try {
      if (finished) return;
      const old = await readCache(path);
      if (finished) return;
      if (old && now() - old.checkedAt >= 0 && now() - old.checkedAt < UPDATE_TTL) result = old;
      else {
        const latest = await fetchTargetVersion(undefined, { env, signal: controller.signal });
        if (finished) return;
        result = { ...old, current: CLI_VERSION, checkedAt: now(), latest };
        await saveCache(path, result);
      }
    } finally {
      await release();
    }
    if (!finished) ready = result;
  })()
    .catch(() => {})
    .finally(() => clearTimeout(timer));
  return {
    // Callers that need completed background work can synchronize without a timer.
    // Normal command exit still calls finish() directly and never waits for a query.
    settled: work,
    async finish() {
      finished = true;
      controller.abort();
      clearTimeout(timer);
      // Do not await a registry query at command exit; only cache I/O may finish.
      void work;
      if (!ready || compareVersions(ready.latest, CLI_VERSION) <= 0) return;
      const release = await acquireAdvisoryLock(path);
      if (!release) return;
      try {
        // A different command may have notified since this command started.
        const result = await readCache(path);
        if (!result || compareVersions(result.latest, CLI_VERSION) <= 0) return;
        if (
          result.notifiedVersion === result.latest &&
          result.notifiedAt !== undefined &&
          now() - result.notifiedAt < UPDATE_TTL
        ) {
          return;
        }
        await saveCache(path, { ...result, notifiedAt: now(), notifiedVersion: result.latest });
        write(
          `A new version ${result.latest} is available (current ${CLI_VERSION}); run trooly update.\n`,
        );
      } catch {
        /* Advisory only. */
      } finally {
        await release().catch(() => {});
      }
    },
  };
}
