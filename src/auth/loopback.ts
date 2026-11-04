import { createServer, type ServerResponse } from 'node:http';
import { CliError } from '../http/errors';
import { createPKCE } from './pkce';
import { openBrowser } from './browser';
import { clientId, postOAuth, storeTokenResponse } from './oauth';
import type { OAuthMetadata, OAuthTokenResponse, StoredTokens } from '../types/oauth';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[character];
  });
}

function completionPage(error?: CliError, description?: string): string {
  const title = error ? 'Authorization failed' : 'Authorization complete';
  const message = error
    ? `${error.message} You can close this page and return to the terminal to try again.`
    : 'Authorization complete — you can close this page and return to the terminal.';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} | Trooly</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
      background: #f8fafc; color: #0f172a; font-family: system-ui, -apple-system, sans-serif; }
    main { width: 100%; max-width: 440px; padding: 40px 32px; text-align: center;
      background: #fff; border: 1px solid #e2e8f0; border-radius: 16px; }
    .brand { color: #64748b; font-size: 14px; font-weight: 600; letter-spacing: .04em; }
    .status { display: grid; place-items: center; width: 48px; height: 48px; margin: 24px auto;
      border-radius: 50%; background: ${error ? '#fef2f2' : '#ecfdf5'};
      color: ${error ? '#b91c1c' : '#047857'}; font-size: 24px; }
    h1 { margin: 0 0 16px; font-size: 24px; line-height: 1.3; }
    p { margin: 0; color: #475569; font-size: 15px; line-height: 1.7; overflow-wrap: anywhere; }
    .detail { margin-top: 16px; padding-top: 16px; border-top: 1px solid #e2e8f0; }
  </style>
</head>
<body>
  <main>
    <div class="brand">Trooly CLI</div>
    <div class="status" aria-hidden="true">${error ? '!' : '&#10003;'}</div>
    <h1>${title}</h1>
    <p>${escapeHtml(message)}</p>
    ${description ? `<p class="detail">${escapeHtml(description)}</p>` : ''}
  </main>
</body>
</html>`;
}

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
    const finish = (error?: Error, value?: string, response?: ServerResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', cancel);
      // Stop accepting connections first, and settle only once the listener and
      // all existing connections have closed. Flush the completion page before
      // destroying sockets, including active browser keep-alive connections.
      server.close(() => {
        if (error) reject(error);
        else resolve(value!);
      });
      const closeConnections = () => {
        response?.removeListener('finish', closeConnections);
        response?.removeListener('close', closeConnections);
        server.closeAllConnections();
      };
      if (response && !response.writableFinished && !response.destroyed) {
        response.once('finish', closeConnections);
        response.once('close', closeConnections);
      } else {
        closeConnections();
      }
    };
    const cancel = () => finish(new CliError('Login cancelled.', 3, 'LOGIN_CANCELLED'));
    const server = createServer((req, res) => {
      if (settled) {
        res.destroy();
        return;
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/callback' || req.method !== 'GET') {
        res.writeHead(404).end();
        return;
      }
      let error: CliError | undefined;
      let description: string | undefined;
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
        description = url.searchParams.get('error_description') ?? undefined;
      } else if (url.searchParams.getAll('code').length !== 1 || !url.searchParams.get('code')) {
        error = new CliError('Authorization callback did not contain a code.', 3, 'MISSING_CODE');
      }
      res.writeHead(error ? 400 : 200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
        Connection: 'close',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
      });
      res.end(completionPage(error, description));
      finish(error, url.searchParams.get('code') ?? undefined, res);
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
