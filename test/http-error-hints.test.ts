import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiClient } from '../src/http/client';
import { CliError } from '../src/http/errors';
import { emitError } from '../src/output/render';
import { saveProfile } from '../src/config/profiles';
import { credentialStore } from '../src/auth/store';

let dir: string;
let stderr: string[];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'trooly-error-hints-'));
  for (const name of ['XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'APPDATA', 'LOCALAPPDATA']) {
    vi.stubEnv(name, dir);
  }
  vi.stubEnv('TROOLY_PROFILE', 'default');
  vi.stubEnv('TROOLY_API_BASE', 'https://gateway.test');
  vi.stubEnv('TROOLY_API_KEY', '');
  vi.stubEnv('TROOLY_DEBUG', '0');
  stderr = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((data) => {
    stderr.push(String(data));
    return true;
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

async function rejectedRequest(code?: string, status = 401, authenticate?: string) {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(
      JSON.stringify({
        error: { code, message: 'Server rejected the request.', details: { reason: 'test' } },
        meta: { request_id: 'req_error_hint' },
      }),
      {
        status,
        headers: {
          'Content-Type': 'application/json',
          ...(authenticate ? { 'WWW-Authenticate': authenticate } : {}),
        },
      },
    ),
  );
  const client = new ApiClient({
    apiBase: 'https://gateway.test',
    token: 'fake-error-hint-token',
    fetch: fetcher,
  });
  const error = await client
    .request('GET', '/platform/v2/members')
    .catch((error: unknown) => error);
  expect(error).toBeInstanceOf(CliError);
  expect(fetcher).toHaveBeenCalledTimes(1);
  return error as CliError;
}

describe.each([false, true])('server error hints (json=%s)', (asJson) => {
  it.each([
    [
      'CREDENTIAL_NOT_ACCEPTED',
      'OAuth and API Key credentials cannot access management endpoints. Use the Trooly web app.',
    ],
    ['ENVIRONMENT_MISMATCH', 'Check the profile environment and the Trooly-Environment header.'],
    ['invalid_token', 'Run trooly login or check TROOLY_API_KEY.'],
    ['INVALID_TOKEN', 'Run trooly login or check TROOLY_API_KEY.'],
    ['NOT_LOGGED_IN', 'Run trooly login or check TROOLY_API_KEY.'],
    ['UNAUTHENTICATED', 'Run trooly login or check TROOLY_API_KEY.'],
    ['UNAUTHORIZED', 'Run trooly login or check TROOLY_API_KEY.'],
    ['invalid_api_key', 'Run trooly login or check TROOLY_API_KEY.'],
    ['TOKEN_EXPIRED', 'Run trooly login or check TROOLY_API_KEY.'],
    ['expired_token', 'Run trooly login or check TROOLY_API_KEY.'],
    ['OAUTH_UNAVAILABLE', ''],
    ['UNKNOWN_ERROR', ''],
    [undefined, ''],
  ])('selects the hint for %s and retains exit 3', async (code, hint) => {
    const error = await rejectedRequest(code);
    expect(emitError(error, asJson)).toBe(3);
    const message = `Server rejected the request.${hint ? ` ${hint}` : ''}`;
    expect(error.message).toBe(message);
    if (asJson) {
      expect(JSON.parse(stderr.join(''))).toEqual({
        error: { code: code ?? 'HTTP_401', message, details: { reason: 'test' } },
        meta: { request_id: 'req_error_hint' },
      });
    } else {
      expect(stderr.join('')).toBe(
        `Error: ${message} (${code ?? 'HTTP_401'}, request_id=req_error_hint)\n`,
      );
    }
  });
});

it.each([400, 403])('uses environment guidance even with HTTP %s', async (status) => {
  const error = await rejectedRequest('ENVIRONMENT_MISMATCH', status);
  expect(error.message).toContain(
    'Check the profile environment and the Trooly-Environment header.',
  );
  expect(error.message).not.toContain('trooly login');
  expect(error.exitCode).toBe(status === 403 ? 4 : 1);
});
it('does not tell unknown permission errors to log in', async () => {
  const error = await rejectedRequest('UNKNOWN_ERROR', 403);
  expect(error.message).not.toContain('trooly login');
  expect(error.message).toContain('trooly auth status');
  expect(error.exitCode).toBe(4);
});
it.each([400, 403])('preserves OAUTH_UNAVAILABLE server guidance with HTTP %s', async (status) => {
  expect((await rejectedRequest('OAUTH_UNAVAILABLE', status)).message).toBe(
    'Server rejected the request.',
  );
});
it('uses invalid_token challenge only when the response has no error code', async () => {
  expect((await rejectedRequest(undefined, 401, 'Bearer error="invalid_token"')).message).toContain(
    'Run trooly login',
  );
  expect(
    (await rejectedRequest('CREDENTIAL_NOT_ACCEPTED', 401, 'Bearer error="invalid_token"')).message,
  ).not.toContain('trooly login');
  expect(
    (await rejectedRequest('UNKNOWN_ERROR', 401, 'Bearer error="invalid_token"')).message,
  ).not.toContain('trooly login');
});
it.each([false, true])(
  'retains local missing/expired login guidance (stored=%s)',
  async (stored) => {
    if (stored) {
      await saveProfile('default', { api_base: 'https://gateway.test', auth: 'oauth' });
      vi.spyOn(credentialStore, 'read').mockResolvedValue(undefined);
    }
    const fetcher = vi.fn<typeof fetch>();
    const client = new ApiClient({ apiBase: 'https://gateway.test', fetch: fetcher });
    const error = await client
      .request('GET', '/platform/v2/members')
      .catch((error: unknown) => error);
    expect(error).toMatchObject({ code: 'NOT_LOGGED_IN', exitCode: 3 });
    expect((error as CliError).message).toContain('Run trooly login');
    expect(fetcher).not.toHaveBeenCalled();
  },
);
