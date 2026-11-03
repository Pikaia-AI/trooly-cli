import createClient from 'openapi-fetch';
import { randomUUID } from 'node:crypto';
import { createWriteStream, openAsBlob } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import type { paths } from '../generated/api';
import { CLI_VERSION } from '../version';
import { resolveProfile, normalizeApiBase } from '../config/profiles';
import { ensureAccessToken } from '../auth/tokens';
import { CliError, usageError } from './errors';
import { paginate, type Envelope } from './paginate';
import { redact, registerSecrets } from '../output/json';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
export interface RequestOptions {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  output?: string;
  arrayKey?: string;
}
export interface ClientOptions {
  apiBase: string;
  profileName?: string;
  token?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}
interface ErrorPayload {
  error?: { code?: string; message?: string; details?: unknown };
  meta?: { request_id?: string };
}

function httpExitCode(status: number): number {
  switch (status) {
    case 401:
      return 3;
    case 403:
      return 4;
    case 426:
      return 5;
    default:
      return 1;
  }
}

function errorHint(code: string | undefined, response: Response): string {
  // A rejection of a credential type or environment cannot be fixed by logging in again.
  // Treat the server's code as authoritative; HTTP 401 alone does not imply expired auth.
  switch (code?.toLowerCase()) {
    case 'credential_not_accepted':
      return ' OAuth and API Key credentials cannot access management endpoints. Use the Trooly web app.';
    case 'environment_mismatch':
      return ' Check the profile environment and the Trooly-Environment header.';
    case 'invalid_token':
    case 'not_logged_in':
    case 'unauthenticated':
    case 'unauthorized':
    case 'invalid_api_key':
    case 'token_expired':
    case 'expired_token':
      return ' Run trooly login or check TROOLY_API_KEY.';
    case 'oauth_unavailable':
      return '';
  }
  if (
    !code &&
    response.status === 401 &&
    /\binvalid_token\b/.test(response.headers.get('www-authenticate') ?? '')
  ) {
    return ' Run trooly login or check TROOLY_API_KEY.';
  }
  if (response.status === 403) {
    return ' Check the granted permissions with trooly auth status or adjust permissions in the platform.';
  }
  if (response.status === 426) return ' Run trooly update.';
  return '';
}

export function retryDelay(value: string | null, attempt: number, now = Date.now()): number {
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }
  return 1000 * 2 ** attempt;
}
function safePath(path: string): void {
  if (!path.startsWith('/') || path.startsWith('//') || /[\\\r\n#]/.test(path)) {
    usageError(
      'API paths must be absolute paths on the configured gateway (for example /trooly/v1/projects).',
    );
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(path.split('?')[0]);
  } catch {
    return usageError('API path contains invalid URL encoding.');
  }
  if (decoded.split('/').some((part) => part === '..' || part === '.')) {
    usageError('API paths cannot contain traversal segments.');
  }
}
function transferUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return usageError('Invalid transfer URL.');
  }
  if (
    url.username ||
    url.password ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))
  ) {
    usageError('Transfer URLs require HTTPS (or a local test server).');
  }
  return url;
}
export async function saveResponse(response: Response, output: string): Promise<void> {
  const temporary = `${output}.${randomUUID()}.tmp`;
  try {
    const stream = response.body
      ? Readable.fromWeb(response.body as import('node:stream/web').ReadableStream)
      : Readable.from([]);
    await pipeline(stream, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
    await rename(temporary, output);
  } finally {
    await rm(temporary, { force: true });
  }
}

export class ApiClient {
  readonly apiBase: string;
  /** Typed transport for endpoints compiled from the published contract. */
  readonly typed;
  private readonly fetcher: typeof fetch;
  private readonly sleeper: (ms: number) => Promise<void>;
  constructor(private options: ClientOptions) {
    this.apiBase = normalizeApiBase(options.apiBase);
    this.fetcher = options.fetch ?? fetch;
    this.sleeper = options.sleep ?? ((ms) => sleep(ms));
    this.typed = createClient<paths>({
      baseUrl: this.apiBase,
      fetch: (request) => this.authenticatedFetch(request),
      redirect: 'manual',
    });
  }
  private async authenticatedFetch(original: Request): Promise<Response> {
    const profile = await resolveProfile(this.options.profileName);
    if (!this.options.token && !process.env.TROOLY_API_KEY && profile.apiBase !== this.apiBase) {
      throw new CliError(
        'Credential gateway does not match the requested gateway.',
        3,
        'GATEWAY_MISMATCH',
      );
    }
    let token = this.options.token ?? (await ensureAccessToken(profile));
    let refreshed = false;
    let retry = 0;
    const retryable =
      ['GET', 'PUT', 'DELETE'].includes(original.method) ||
      (original.method === 'POST' && original.headers.has('Idempotency-Key'));
    for (;;) {
      registerSecrets(token);
      const request = new Request(original.clone(), {
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 30000),
        // A gateway redirect must never forward the Bearer token to its Location target.
        redirect: 'manual',
      });
      request.headers.set('Authorization', `Bearer ${token}`);
      if (process.env.TROOLY_DEBUG === '1') {
        process.stderr.write(
          `[http] ${request.method} ${redact(new URL(request.url).pathname)} Authorization=[REDACTED] Idempotency-Key=[REDACTED]\n`,
        );
      }
      let response: Response;
      try {
        response = await this.fetcher(request);
      } catch {
        if (retryable && retry < 3) {
          await this.sleeper(retryDelay(null, retry++));
          continue;
        }
        throw new CliError('The gateway request failed or timed out.', 1, 'NETWORK_ERROR');
      }
      if (process.env.TROOLY_DEBUG === '1') {
        process.stderr.write(`[http] status=${response.status}\n`);
      }
      if (
        response.status === 401 &&
        !refreshed &&
        !this.options.token &&
        !process.env.TROOLY_API_KEY
      ) {
        const error = (await response
          .clone()
          .json()
          .catch(() => ({}))) as ErrorPayload;
        if (
          error.error?.code?.toLowerCase() === 'invalid_token' ||
          /\binvalid_token\b/.test(response.headers.get('www-authenticate') ?? '')
        ) {
          await response.body?.cancel();
          token = await ensureAccessToken(profile, token);
          refreshed = true;
          continue;
        }
      }
      if ([429, 503].includes(response.status) && retryable && retry < 3) {
        const delay = retryDelay(response.headers.get('retry-after'), retry++);
        await response.body?.cancel();
        await this.sleeper(delay);
        continue;
      }
      return response;
    }
  }
  async request<T = unknown>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<Envelope<T>> {
    safePath(path);
    const upper = method.toUpperCase() as Method;
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(upper)) {
      usageError('Unsupported HTTP method.');
    }
    if (options.body !== undefined && ['GET', 'HEAD'].includes(upper)) {
      usageError(`${upper} does not accept a request body.`);
    }
    const headers = new Headers(options.headers);
    if (headers.has('Authorization')) {
      usageError('Authorization cannot be overridden; use TROOLY_API_KEY or trooly login.');
    }
    headers.set(
      'User-Agent',
      `trooly-cli/${CLI_VERSION} (${process.platform}; ${process.arch}) node/${process.versions.node}`,
    );
    headers.set('X-Trooly-CLI-Version', CLI_VERSION);
    if (upper === 'POST' && !headers.has('Idempotency-Key')) {
      headers.set('Idempotency-Key', randomUUID());
    }
    const url = new URL(path, this.apiBase);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    // Dynamic paths are intentional: `trooly api` must support newly published operations.
    // Dedicated command declarations are checked against generated paths separately.
    const dynamic = this.typed as unknown as {
      request(
        method: string,
        path: string,
        init: Record<string, unknown>,
      ): Promise<{ response: Response; error?: unknown }>;
    };
    const { response, error: transportError } = await dynamic.request(
      upper.toLowerCase(),
      url.pathname + url.search,
      { headers, body: options.body, parseAs: 'stream' },
    );
    if (!response.ok) {
      const payload: ErrorPayload =
        transportError && typeof transportError === 'object'
          ? (transportError as ErrorPayload)
          : {};
      const status = response.status;
      const exit = httpExitCode(status);
      let message = payload.error?.message ?? `Request failed (HTTP ${status}).`;
      message += errorHint(payload.error?.code, response);
      // Exact token strings are not retained in diagnostics; only platform errors are displayed.
      if (this.options.token) message = message.split(this.options.token).join('[REDACTED]');
      throw new CliError(
        message,
        exit,
        payload.error?.code ?? `HTTP_${status}`,
        payload.meta?.request_id ?? response.headers.get('x-request-id') ?? undefined,
        payload.error?.details,
      );
    }
    if (options.output) {
      await saveResponse(response, options.output);
      return { data: undefined as T };
    }
    if (response.status === 204 || upper === 'HEAD') return { data: null as T };
    const text = await response.text();
    if (!text) return { data: null as T };
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return { data: text as T };
    }
    return value && typeof value === 'object' && 'data' in value
      ? (value as Envelope<T>)
      : { data: value as T };
  }
  async paginate(method: string, path: string, options: RequestOptions = {}): Promise<unknown[]> {
    if (options.output) usageError('Pagination cannot be combined with file output.');
    return paginate(
      (cursor) => this.request(method, path, { ...options, query: { ...options.query, cursor } }),
      options.query?.cursor as string | undefined,
      options.arrayKey,
    );
  }
  async download(url: string, output: string): Promise<void> {
    // Signed transfer URLs must not redirect requests beyond the supplied destination.
    const response = await this.fetcher(transferUrl(url), {
      redirect: 'error',
      signal: AbortSignal.timeout(300000),
    });
    if (!response.ok) throw new CliError(`Download failed (HTTP ${response.status}).`);
    await saveResponse(response, output);
  }
  async upload(url: string, file: string, headers: Record<string, string> = {}): Promise<void> {
    const safeHeaders = new Headers(headers);
    if (safeHeaders.has('authorization') || safeHeaders.has('cookie')) {
      throw new CliError('Transfer headers cannot contain credentials.');
    }
    const response = await this.fetcher(transferUrl(url), {
      method: 'PUT',
      headers: safeHeaders,
      body: await openAsBlob(file),
      // A redirect must not forward the upload body or transfer headers to another target.
      redirect: 'error',
      signal: AbortSignal.timeout(300000),
    });
    await response.body?.cancel();
    if (!response.ok) throw new CliError(`Upload failed (HTTP ${response.status}).`);
  }
}
