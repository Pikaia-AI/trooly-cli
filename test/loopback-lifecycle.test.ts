import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loopbackLogin } from '../src/auth/loopback';
import { postOAuth } from '../src/auth/oauth';
import { fakeTokenResponse } from './auth-support';

const { createServer } = vi.hoisted(() => ({ createServer: vi.fn() }));
vi.mock('node:http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:http')>()),
  createServer,
}));
vi.mock('../src/auth/oauth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/auth/oauth')>()),
  postOAuth: vi.fn(),
}));

const base = 'http://127.0.0.1:12345';
const metadata = {
  issuer: base,
  authorization_endpoint: `${base}/authorize`,
  token_endpoint: `${base}/token`,
  revocation_endpoint: `${base}/revoke`,
  device_authorization_endpoint: `${base}/device`,
};

// Control transport events independently: the page must flush before forced
// socket closure, and token exchange must wait for the server's close callback.
let handler: (req: IncomingMessage, res: ServerResponse) => void;
let closed: () => void;
const server = Object.assign(new EventEmitter(), {
  listen: vi.fn((_port: number, _host: string, ready: () => void) => ready()),
  address: () => ({ port: 12346 }),
  close: vi.fn((callback: () => void) => (closed = callback)),
  closeAllConnections: vi.fn(),
});

beforeEach(() => {
  vi.clearAllMocks();
  server.removeAllListeners();
  createServer.mockImplementation((callback: typeof handler) => {
    handler = callback;
    return server;
  });
  vi.mocked(postOAuth).mockResolvedValue(fakeTokenResponse);
});
afterEach(() => vi.restoreAllMocks());

describe('loopback response lifecycle', () => {
  it('closes immediately when login was already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const login = loopbackLogin(base, metadata, { signal: controller.signal });
    const rejected = expect(login).rejects.toMatchObject({ code: 'LOGIN_CANCELLED' });
    expect(server.listen).not.toHaveBeenCalled();
    expect(server.closeAllConnections).toHaveBeenCalledOnce();
    closed();
    await rejected;
    expect(postOAuth).not.toHaveBeenCalled();
  });

  it('releases connections and rejects when the listener cannot start', async () => {
    server.listen.mockImplementationOnce(() => {
      server.emit('error', new Error('listen failed'));
    });
    const login = loopbackLogin(base, metadata);
    const rejected = expect(login).rejects.toThrow('Could not start the loopback login server.');
    expect(server.closeAllConnections).toHaveBeenCalledOnce();
    closed();
    await rejected;
    expect(postOAuth).not.toHaveBeenCalled();
  });

  it.each(['success', 'access_denied', 'server_error'])(
    'flushes the %s HTML page before closing connections and settling login',
    async (mode) => {
      let authorize!: (value: string) => void;
      const ready = new Promise<string>((resolve) => (authorize = resolve));
      let settled = false;
      const login = loopbackLogin(base, metadata, { onAuthorize: authorize }).then(
        (tokens) => {
          settled = true;
          return tokens;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      const url = new URL(await ready);
      const callback = new URL(url.searchParams.get('redirect_uri')!);
      callback.search = new URLSearchParams({
        code: 'fake-code',
        state: url.searchParams.get('state')!,
        iss: base,
      }).toString();
      if (mode !== 'success') {
        callback.searchParams.set('error', mode);
        callback.searchParams.set('error_description', `<script>"x" & 'y'</script>`);
      }
      const response = Object.assign(new EventEmitter(), {
        writableFinished: false,
        destroyed: false,
        writeHead: vi.fn(),
        end: vi.fn(),
      });
      handler(
        { url: callback.pathname + callback.search, method: 'GET' } as IncomingMessage,
        response as unknown as ServerResponse,
      );
      expect(response.writeHead).toHaveBeenCalledWith(mode === 'success' ? 200 : 400, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
        Connection: 'close',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
      });
      const html = response.end.mock.calls[0][0] as string;
      expect(html).toContain('<!doctype html>');
      expect(html).toContain('return to the terminal');
      expect(html).not.toMatch(/<script|<link|<img|\b(?:href|src)=/i);
      if (mode === 'success') {
        expect(html).toContain(
          'Authorization complete — you can close this page and return to the terminal.',
        );
      } else {
        expect(html).toContain(
          mode === 'access_denied' ? 'Authorization was denied.' : 'Authorization failed.',
        );
        expect(html).toContain('&lt;script&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/script&gt;');
      }
      expect(server.close).toHaveBeenCalledOnce();
      expect(server.closeAllConnections).not.toHaveBeenCalled();
      expect(postOAuth).not.toHaveBeenCalled();
      expect(settled).toBe(false);
      response.writableFinished = true;
      response.emit('finish');
      expect(server.closeAllConnections).toHaveBeenCalledOnce();
      expect(postOAuth).not.toHaveBeenCalled();
      response.emit('close');
      expect(server.closeAllConnections).toHaveBeenCalledOnce();
      closed();
      const outcome = await login;
      expect(settled).toBe(true);
      if (mode === 'success') {
        expect(outcome).toMatchObject({ access_token: fakeTokenResponse.access_token });
        expect(postOAuth).toHaveBeenCalledOnce();
      } else {
        expect(outcome).toMatchObject({ code: 'AUTHORIZATION_DENIED', exitCode: 3 });
        expect(postOAuth).not.toHaveBeenCalled();
      }
    },
  );
});
