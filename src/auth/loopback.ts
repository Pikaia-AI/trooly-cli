import { createServer } from 'node:http';
import { CliError } from '../http/errors';
import { createPKCE } from './pkce';
import { openBrowser } from './browser';
import { clientId, postOAuth, storeTokenResponse } from './oauth';
import type { OAuthMetadata, OAuthTokenResponse, StoredTokens } from '../types/oauth';

export interface LoopbackOptions {
  scope?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onAuthorize?: (url: string) => void | Promise<void>;
}
export async function loopbackLogin(
  apiBase: string,
  metadata: OAuthMetadata,
  options: LoopbackOptions = {},
): Promise<StoredTokens> {
  const { verifier, challenge, state } = createPKCE();
  let redirectUri = '';
  const code = await new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', cancel);
      server.close();
      server.closeIdleConnections();
      if (error) server.closeAllConnections();
      if (error) reject(error);
      else {
        resolve(value!);
      }
    };
    const cancel = () => finish(new CliError('Login cancelled.', 3, 'LOGIN_CANCELLED'));
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/callback' || req.method !== 'GET') {
        res.writeHead(404).end();
        return;
      }
      let error: CliError | undefined;
      if (
        url.searchParams.getAll('state').length !== 1 ||
        url.searchParams.get('state') !== state
      ) {
        error = new CliError('OAuth state mismatch. Run trooly login again.', 3, 'STATE_MISMATCH');
      } else if (
        url.searchParams.getAll('iss').length !== 1 ||
        url.searchParams.get('iss') !== metadata.issuer
      ) {
        error = new CliError(
          'OAuth issuer mismatch. Run trooly login again.',
          3,
          'ISSUER_MISMATCH',
        );
      } else if (url.searchParams.has('error')) {
        error = new CliError(
          url.searchParams.get('error') === 'access_denied'
            ? 'Authorization was denied.'
            : 'Authorization failed.',
          3,
          'AUTHORIZATION_DENIED',
        );
      } else if (url.searchParams.getAll('code').length !== 1 || !url.searchParams.get('code')) {
        error = new CliError('Authorization callback did not contain a code.', 3, 'MISSING_CODE');
      }
      res.writeHead(error ? 400 : 200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
      });
      res.end(
        error
          ? 'Login failed. Return to the terminal.'
          : 'Login successful. You can close this page.',
      );
      finish(error, url.searchParams.get('code') ?? undefined);
    });
    const timer = setTimeout(
      () => finish(new CliError('Login timed out. Run trooly login again.', 3, 'LOGIN_TIMEOUT')),
      options.timeoutMs ?? 300000,
    );
    server.on('error', () =>
      finish(new CliError('Could not start the loopback login server. Try trooly login --device.')),
    );
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) {
      cancel();
      return;
    }
    server.listen(0, '127.0.0.1', () => {
      if (settled) {
        server.close();
        return;
      }
      const address = server.address();
      if (!address || typeof address === 'string') {
        finish(new CliError('Could not determine the loopback address.'));
        return;
      }
      redirectUri = `http://127.0.0.1:${address.port}/callback`;
      const url = new URL(metadata.authorization_endpoint);
      url.search = new URLSearchParams({
        response_type: 'code',
        client_id: clientId(apiBase),
        redirect_uri: redirectUri,
        scope: options.scope ?? 'read write',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        resource: apiBase,
      }).toString();
      const authorize =
        options.onAuthorize ??
        ((value: string) => {
          process.stderr.write(
            `Open this URL to authorize Trooly:\n${value}\nWaiting for authorization…\n`,
          );
          openBrowser(value);
        });
      Promise.resolve()
        .then(() => authorize(url.href))
        .catch(() => finish(new CliError('Could not begin browser authorization.')));
    });
  });
  const response = await postOAuth<OAuthTokenResponse>(
    metadata.token_endpoint,
    {
      grant_type: 'authorization_code',
      code,
      client_id: clientId(apiBase),
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource: apiBase,
    },
    options.signal,
  );
  return storeTokenResponse(response);
}
