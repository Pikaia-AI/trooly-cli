import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OAuthMetadata } from '../src/types/oauth';

export async function localAuthServer(
  handler: (
    req: IncomingMessage,
    res: ServerResponse,
    body: URLSearchParams,
  ) => unknown | Promise<unknown>,
) {
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/.well-known/oauth-authorization-server') {
      res.end(JSON.stringify(metadata));
      return;
    }
    try {
      await handler(req, res, new URLSearchParams(body));
    } catch {
      res.writeHead(500).end(JSON.stringify({ error: 'test_handler_error' }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No local address');
  const base = `http://127.0.0.1:${address.port}`;
  const metadata: OAuthMetadata = {
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    revocation_endpoint: `${base}/revoke`,
    device_authorization_endpoint: `${base}/device`,
  };
  return {
    base,
    metadata,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
export const fakeTokenResponse = {
  access_token: 'fake-access-new',
  refresh_token: 'fake-refresh-new',
  expires_in: 3600,
  token_type: 'Bearer',
};
export async function temporaryAuthHome() {
  const directory = await mkdtemp(join(tmpdir(), 'trooly-auth-'));
  return {
    directory,
    env: {
      XDG_CONFIG_HOME: join(directory, 'config'),
      XDG_CACHE_HOME: join(directory, 'cache'),
      APPDATA: join(directory, 'config'),
      LOCALAPPDATA: join(directory, 'cache'),
      TROOLY_CREDENTIAL_STORE: 'file',
    },
    clean: () => rm(directory, { recursive: true, force: true }),
  };
}
