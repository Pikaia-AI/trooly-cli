import { getPaths } from './paths';
import { readJson, withFileLock, writeJson } from './files';
import { CliError, usageError } from '../http/errors';

export const DEFAULT_API_BASE = 'https://open-gateway.trooly.ai';
export interface Profile {
  api_base: string;
  auth?: 'oauth';
  organization?: { id: string; name: string };
  environment?: string;
  principal?: { id: string; name: string; type?: string };
  logged_in_at?: string;
}
export interface ProfileConfig {
  current_profile: string;
  profiles: Record<string, Profile>;
}
export interface ResolvedProfile {
  name: string;
  apiBase: string;
  stored?: Profile;
}

export function validateProfileName(name: string): string {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name) ||
    ['__proto__', 'constructor', 'prototype'].includes(name)
  ) {
    usageError('Profile names must contain only letters, digits, dots, underscores and hyphens.');
  }
  return name;
}

export function normalizeApiBase(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return usageError('Invalid API base URL.');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    usageError('API base must be an HTTPS origin (HTTP is permitted only on loopback).');
  }
  return url.origin;
}

export async function loadProfiles(): Promise<ProfileConfig> {
  const config = await readJson<ProfileConfig>(getPaths().configFile, {
    current_profile: 'default',
    profiles: {},
  });
  if (
    !config ||
    typeof config.current_profile !== 'string' ||
    !config.profiles ||
    typeof config.profiles !== 'object' ||
    Array.isArray(config.profiles)
  ) {
    throw new CliError('Invalid profile configuration.', 1, 'LOCAL_STORAGE_ERROR');
  }
  return config;
}

export async function resolveProfile(name?: string): Promise<ResolvedProfile> {
  const config = await loadProfiles();
  const selected = validateProfileName(
    name ?? process.env.TROOLY_PROFILE ?? config.current_profile,
  );
  const stored = Object.hasOwn(config.profiles, selected) ? config.profiles[selected] : undefined;
  return {
    name: selected,
    apiBase: normalizeApiBase(process.env.TROOLY_API_BASE ?? stored?.api_base ?? DEFAULT_API_BASE),
    stored,
  };
}

export async function mutateProfiles(action: (config: ProfileConfig) => void): Promise<void> {
  const { configFile } = getPaths();
  await withFileLock(configFile, async () => {
    const config = await loadProfiles();
    action(config);
    await writeJson(configFile, config);
  });
}

export async function saveProfile(name: string, profile: Profile): Promise<void> {
  validateProfileName(name);
  await mutateProfiles((config) => {
    if (!Object.keys(config.profiles).length) config.current_profile = name;
    config.profiles[name] = profile;
  });
}

export async function useProfile(name: string): Promise<void> {
  validateProfileName(name);
  await mutateProfiles((config) => {
    if (!Object.hasOwn(config.profiles, name)) {
      usageError('Unknown profile. Run trooly login --profile <name> first.');
    }
    config.current_profile = name;
  });
}

export async function removeProfile(name: string): Promise<void> {
  validateProfileName(name);
  await mutateProfiles((config) => {
    if (!Object.hasOwn(config.profiles, name)) usageError('Unknown profile.');
    delete config.profiles[name];
    if (config.current_profile === name) {
      config.current_profile = Object.keys(config.profiles)[0] ?? 'default';
    }
  });
}
