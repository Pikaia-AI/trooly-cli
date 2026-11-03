import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { getPaths } from '../config/paths';
import { withFileLock } from '../config/files';
import { type ResolvedProfile, normalizeApiBase, resolveProfile } from '../config/profiles';
import { CliError } from '../http/errors';
import { credentialStore } from './store';
import { clientId, discoverOAuth, OAuthError, postOAuth, storeTokenResponse } from './oauth';
import type { OAuthTokenResponse } from '../types/oauth';

export async function withProfileLock<T>(name: string, action: () => Promise<T>): Promise<T> {
  const path = join(getPaths().cacheDir, 'locks', createHash('sha256').update(name).digest('hex'));
  return withFileLock(path, action);
}
export function assertProfileGateway(profile: ResolvedProfile): void {
  if (profile.stored && normalizeApiBase(profile.stored.api_base) !== profile.apiBase) {
    throw new CliError(
      'This profile is logged in to a different gateway. Select its gateway or log in with a separate profile.',
      3,
      'PROFILE_GATEWAY_MISMATCH',
    );
  }
}
// Call only while holding this profile's lock. Configuration and credentials
// can have changed since a command first resolved its profile.
export async function resolveLockedProfile(
  expected: ResolvedProfile,
  requireStored = true,
): Promise<ResolvedProfile> {
  const current = await resolveProfile(expected.name);
  if (current.apiBase !== expected.apiBase) {
    throw new CliError(
      'The profile gateway changed while this command was running. Select the profile again.',
      3,
      'PROFILE_GATEWAY_MISMATCH',
    );
  }
  assertProfileGateway(current);
  if (requireStored && !current.stored) {
    throw new CliError(
      'Not logged in. Run trooly login or set TROOLY_API_KEY.',
      3,
      'NOT_LOGGED_IN',
    );
  }
  return current;
}
export async function ensureAccessToken(
  profile: ResolvedProfile,
  rejectedToken?: string,
): Promise<string> {
  if (process.env.TROOLY_API_KEY) return process.env.TROOLY_API_KEY;
  // Re-read under the lock so concurrent CLI processes cannot reuse a rotated refresh token.
  return withProfileLock(profile.name, async () => {
    await resolveLockedProfile(profile);
    const latest = await credentialStore.read(profile.name);
    if (!latest) throw new CliError('Login has expired. Run trooly login.', 3, 'NOT_LOGGED_IN');
    if (
      latest.access_expires_at > Date.now() + 60000 &&
      (!rejectedToken || latest.access_token !== rejectedToken)
    ) {
      return latest.access_token;
    }
    const metadata = await discoverOAuth(profile.apiBase);
    try {
      const response = await postOAuth<OAuthTokenResponse>(metadata.token_endpoint, {
        grant_type: 'refresh_token',
        refresh_token: latest.refresh_token,
        client_id: clientId(profile.apiBase),
        resource: profile.apiBase,
      });
      const next = storeTokenResponse(response);
      await credentialStore.write(profile.name, next);
      return next.access_token;
    } catch (error) {
      if (error instanceof OAuthError && error.oauthCode === 'invalid_grant') {
        await credentialStore.remove(profile.name);
      }
      throw error;
    }
  });
}
