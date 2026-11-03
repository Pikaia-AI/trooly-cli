import { setTimeout as delay } from 'node:timers/promises';
import { CliError } from '../http/errors';
import { clientId, OAuthError, postOAuth, storeTokenResponse } from './oauth';
import type {
  DeviceAuthorizationResponse,
  OAuthMetadata,
  OAuthTokenResponse,
  StoredTokens,
} from '../types/oauth';

export function chooseLoginMethod(
  device = false,
  env = process.env,
  platform: NodeJS.Platform = process.platform,
): 'device' | 'loopback' {
  return device ||
    'SSH_CONNECTION' in env ||
    'SSH_TTY' in env ||
    (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY)
    ? 'device'
    : 'loopback';
}
export interface DeviceOptions {
  scope?: string;
  signal?: AbortSignal;
  wait?: (ms: number) => Promise<void>;
  onCode?: (code: DeviceAuthorizationResponse) => void;
  now?: () => number;
}
export async function deviceLogin(
  apiBase: string,
  metadata: OAuthMetadata,
  options: DeviceOptions = {},
): Promise<StoredTokens> {
  const code = await postOAuth<DeviceAuthorizationResponse>(
    metadata.device_authorization_endpoint,
    { client_id: clientId(apiBase), resource: apiBase, scope: options.scope ?? 'read write' },
    options.signal,
  );
  if (
    !code ||
    typeof code.device_code !== 'string' ||
    !code.device_code ||
    typeof code.user_code !== 'string' ||
    !/^[A-Za-z0-9-]{1,64}$/.test(code.user_code) ||
    typeof code.verification_uri !== 'string' ||
    !code.verification_uri ||
    (code.verification_uri_complete !== undefined &&
      typeof code.verification_uri_complete !== 'string') ||
    !Number.isFinite(code.expires_in) ||
    code.expires_in <= 0 ||
    (code.interval !== undefined && (!Number.isFinite(code.interval) || code.interval <= 0))
  ) {
    throw new CliError('Invalid device authorization response.', 1, 'INVALID_DEVICE_RESPONSE');
  }
  for (const value of [code.verification_uri, code.verification_uri_complete].filter(Boolean)) {
    let url: URL;
    try {
      url = new URL(value!);
    } catch {
      throw new CliError('Invalid device verification URL.', 1, 'INVALID_DEVICE_RESPONSE');
    }
    if (
      url.username ||
      url.password ||
      (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
    ) {
      throw new CliError('Invalid device verification URL.', 1, 'INVALID_DEVICE_RESPONSE');
    }
  }
  (
    options.onCode ??
    ((value: DeviceAuthorizationResponse) => {
      process.stderr.write(
        `Open this URL on any device:\n${value.verification_uri}\nEnter code: ${value.user_code}\n`,
      );
      if (value.verification_uri_complete) {
        process.stderr.write(`${value.verification_uri_complete}\n`);
      }
      process.stderr.write('Waiting for authorization… (Ctrl+C to cancel)\n');
    })
  )(code);
  const now = options.now ?? Date.now;
  const deadline = now() + code.expires_in * 1000;
  const wait = options.wait ?? ((ms: number) => delay(ms, undefined, { signal: options.signal }));
  let interval = (code.interval ?? 5) * 1000;
  while (now() < deadline) {
    await wait(Math.min(interval, deadline - now()));
    if (now() >= deadline) break;
    try {
      const token = await postOAuth<OAuthTokenResponse>(
        metadata.token_endpoint,
        {
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: code.device_code,
          client_id: clientId(apiBase),
          resource: apiBase,
        },
        options.signal,
      );
      return storeTokenResponse(token);
    } catch (error) {
      if (!(error instanceof OAuthError)) throw error;
      if (error.oauthCode === 'authorization_pending') continue;
      if (error.oauthCode === 'slow_down') {
        interval = Math.max(
          interval + 5000,
          Number.isFinite(error.interval) ? error.interval! * 1000 : 0,
        );
        continue;
      }
      throw error;
    }
  }
  throw new OAuthError('expired_token');
}
