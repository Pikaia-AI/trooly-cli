import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

export type InstallMethod = 'npm' | 'pnpm' | 'yarn' | 'bun' | 'volta';
export type Installation = InstallMethod | 'npx' | 'pnpm-dlx' | 'project';

export function classifyInstallation(
  path: string,
  hasProjectManifest: (path: string) => boolean = existsSync,
): Installation {
  const normalized = path.replaceAll('\\', '/');
  const lower = normalized.toLowerCase();
  if (lower.includes('/_npx/')) return 'npx';
  if (lower.includes('/.pnpm/_pnpx') || lower.includes('/pnpm/dlx')) return 'pnpm-dlx';
  if (lower.includes('/.volta/') || lower.includes('/volta/')) return 'volta';
  if (
    [
      '/.pnpm/global',
      '/.local/share/pnpm',
      '/library/pnpm/global/',
      '/appdata/local/pnpm/global/',
    ].some((p) => lower.includes(p))
  ) {
    return 'pnpm';
  }
  if (lower.includes('/.config/yarn/global') || lower.includes('/yarn/data/global')) return 'yarn';
  if (lower.includes('/.bun/install/global')) return 'bun';
  // Recognize established global prefixes before looking for project metadata.
  // An unrelated manifest in a home directory must not turn a global install
  // into a project dependency.
  if (
    /^\/usr\/(?:local\/)?lib\/node_modules\//.test(lower) ||
    /\/(?:\.nvm\/versions\/node\/[^/]+|\.local|\.npm-global|\.npm-packages)\/lib\/node_modules\//.test(
      lower,
    ) ||
    lower.includes('/appdata/roaming/npm/node_modules/')
  ) {
    return 'npm';
  }
  const marker = '/node_modules/';
  const index = lower.indexOf(marker);
  if (index >= 0) {
    const owner = normalized.slice(0, index);
    if (hasProjectManifest(`${owner}/package.json`)) return 'project';
  }
  return 'npm';
}

export function detectInstallation(entry = process.argv[1]): Installation {
  let path = resolve(entry ?? '');
  try {
    // Executable symlinks can hide the package manager's actual installation directory.
    path = realpathSync(path);
  } catch {
    /* Classify the supplied path when it no longer exists. */
  }
  return classifyInstallation(path);
}

export function installationCommand(
  method: InstallMethod,
  version: string,
): { command: string; args: string[] } {
  const specifier = `trooly@${version}`;
  let args: string[];
  switch (method) {
    case 'npm':
      args = ['install', '-g', specifier];
      break;
    case 'volta':
      args = ['install', specifier];
      break;
    case 'yarn':
      args = ['global', 'add', specifier];
      break;
    default:
      args = ['add', '-g', specifier];
  }
  return { command: method, args };
}
