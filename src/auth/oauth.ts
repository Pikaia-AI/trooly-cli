import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { getPaths } from '../config/paths';
import { readJson, writeJson } from '../config/files';
import { normalizeApiBase } from '../config/profiles';
import { CLI_VERSION } from '../version';
import { CliError } from '../http/errors';
import type {
  OAuthErrorResponse,
  OAuthMetadata,
  OAuthTokenResponse,
  StoredTokens,
} from '../types/oauth';
import { registerSecrets } from '../output/json';

export function oauthHeaders() {
  return {
    'User-Agent': `trooly-cli/${CLI_VERSION} (${process.platform}; ${process.arch}) node/${process.versions.node}`,
    'X-Trooly-CLI-Version': CLI_VERSION,
  };
}
export function clientId(apiBase: string): string {
  return `${apiBase}/oauth/clients/trooly-cli.json`;
}
function validateMetadata(value: OAuthMetadata, apiBase: string): OAuthMetadata {
  if (!value || value.issuer !== apiBase) {
    throw new CliError('OAuth issuer does not match the selected gateway.', 3, 'ISSUER_MISMATCH');
  }
  for (const key of [
    'authorization_endpoint',
    'token_endpoint',
    'revocation_endpoint',
    'device_authorization_endpoint',
  ] as const) {
    let endpoint: URL;
    try {
      endpoint = new URL(value[key]);
    } catch {
      throw new CliError('Invalid OAuth metadata.', 1, 'INVALID_METADATA');
    }
    if (endpoint.origin !== apiBase || endpoint.username || endpoint.password || endpoint.hash) {
      throw new CliError(
        'OAuth endpoint does not belong to the selected gateway.',
        3,
        'ISSUER_MISMATCH',
      );
    }
  }
  return value;
}
export async function discoverOAuth(base: string): Promise<OAuthMetadata> {
  const apiBase = normalizeApiBase(base);
  const file = join(
    getPaths().cacheDir,
    'oauth',
    `${createHash('sha256').update(apiBase).digest('hex')}.json`,
  );
  const cached = await readJson<{ savedAt: number; metadata?: OAuthMetadata }>(file, {
    savedAt: 0,
  });
  if (cached.metadata && Date.now() - cached.savedAt < 86400000) {
    return validateMetadata(cached.metadata, apiBase);
  }
  const response = await fetch(`${apiBase}/.well-known/oauth-authorization-server`, {
    headers: oauthHeaders(),
    signal: AbortSignal.timeout(15000),
    redirect: 'error',
  });
  if (!response.ok) {
    throw new CliError(
      `OAuth discovery failed (${response.status}).`,
      response.status === 426 ? 5 : 1,
      'OAUTH_DISCOVERY_FAILED',
    );
  }
  const metadata = validateMetadata((await response.json()) as OAuthMetadata, apiBase);
  await writeJson(file, { savedAt: Date.now(), metadata });
  return metadata;
}
export class OAuthError extends CliError {
  constructor(
    public oauthCode: string,
    public interval?: number,
  ) {
    const messages: Record<string, string> = {
      invalid_grant: 'Login has expired. Run trooly login.',
      access_denied: 'Authorization was denied. Run trooly login to try again.',
      expired_token: 'The device code expired. Run trooly login again.',
    };
    super(
      messages[oauthCode] ?? `OAuth request failed (${oauthCode}).`,
      ['invalid_grant', 'access_denied', 'expired_token', 'invalid_client'].includes(oauthCode)
        ? 3
        : 1,
      oauthCode,
    );
  }
}
export async function postOAuth<T>(
  url: string,
  values: Record<string, string>,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { ...oauthHeaders(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(values),
    redirect: 'error',
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
      : AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as OAuthErrorResponse;
    if (response.status === 426) {
      throw new CliError(
        'This CLI version is no longer supported. Run trooly update.',
        5,
        'CLI_VERSION_UNSUPPORTED',
      );
    }
    throw new OAuthError(
      typeof error.error === 'string' && /^[a-z_]+$/.test(error.error)
        ? error.error
        : 'oauth_error',
      error.interval,
    );
  }
  // Revocation successfully returns an empty response.
  const text = await response.text();
  try {
    return (text ? JSON.parse(text) : undefined) as T;
  } catch {
    throw new CliError('Invalid JSON in OAuth response.', 1, 'INVALID_OAUTH_RESPONSE');
  }
}
export function storeTokenResponse(value: OAuthTokenResponse): StoredTokens {
  if (
    !value ||
    value.token_type?.toLowerCase() !== 'bearer' ||
    typeof value.access_token !== 'string' ||
    !value.access_token ||
    typeof value.refresh_token !== 'string' ||
    !value.refresh_token ||
    !Number.isFinite(value.expires_in) ||
    value.expires_in <= 0
  ) {
    throw new CliError('Invalid OAuth token response.', 3, 'INVALID_TOKEN_RESPONSE');
  }
  registerSecrets(value.access_token, value.refresh_token);
  return {
    access_token: value.access_token,
    access_expires_at: Date.now() + value.expires_in * 1000,
    refresh_token: value.refresh_token,
  };
}
