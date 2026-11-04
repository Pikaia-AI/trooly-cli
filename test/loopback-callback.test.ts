import { Agent, get, type IncomingHttpHeaders, type OutgoingHttpHeaders } from 'node:http';
import { once } from 'node:events';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loopbackLogin } from '../src/auth/loopback';
import { fakeTokenResponse, localAuthServer } from './auth-support';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function request(url: URL, agent: Agent, headers?: OutgoingHttpHeaders) {
  return new Promise<{
    status: number;
    headers: IncomingHttpHeaders;
    body: string;
    socket: import('node:net').Socket;
    closed: Promise<void>;
  }>((resolve, reject) => {
    const req = get(url, { agent, headers }, (res) => {
      const socket = res.socket;
      const closed = new Promise<void>((resolve) => socket.once('close', resolve));
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('error', reject);
      res.on('end', () =>
        resolve({ status: res.statusCode!, headers: res.headers, body, socket, closed }),
      );
    });
    req.on('error', reject);
  });
}

async function beginLogin() {
  let exchanges = 0;
  const server = await localAuthServer((_req, res) => {
    exchanges++;
    res.end(JSON.stringify(fakeTokenResponse));
  });
  cleanup.push(server.close);
  const controller = new AbortController();
  cleanup.push(() => controller.abort());
  let authorized!: (url: string) => void;
  const authorization = new Promise<string>((resolve) => (authorized = resolve));
  // Observe failures immediately, even when the HTTP response is still in flight.
  const login = loopbackLogin(server.base, server.metadata, {
    signal: controller.signal,
    onAuthorize: authorized,
  }).then(
    (tokens) => ({ tokens, error: undefined }),
    (error: unknown) => ({ tokens: undefined, error }),
  );
  const authorize = new URL(await authorization);
  const callback = new URL(authorize.searchParams.get('redirect_uri')!);
  callback.search = new URLSearchParams({
    code: 'fake-code',
    state: authorize.searchParams.get('state')!,
    iss: server.base,
  }).toString();
  const agent = new Agent({ keepAlive: true });
  cleanup.push(() => agent.destroy());
  return { callback, login, agent, exchanges: () => exchanges };
}

describe('loopback completion page', () => {
  it.each([
    ['success', 200, 'Authorization complete'],
    ['denied', 400, 'Authorization was denied.'],
    ['error', 400, 'Authorization failed.'],
    ['state', 400, 'OAuth state mismatch. Run trooly login again.'],
    ['issuer', 400, 'OAuth issuer mismatch. Run trooly login again.'],
    ['missing', 400, 'Authorization callback did not contain a code.'],
  ] as const)('renders a self-contained %s page', async (mode, status, message) => {
    const { callback, login, agent, exchanges } = await beginLogin();
    if (mode === 'denied') callback.searchParams.set('error', 'access_denied');
    if (mode === 'error') callback.searchParams.set('error', 'server_error');
    if (mode === 'state') callback.searchParams.set('state', 'wrong');
    if (mode === 'issuer') callback.searchParams.set('iss', 'wrong');
    if (mode === 'missing') callback.searchParams.delete('code');
    const response = await request(callback, agent);
    const outcome = await login;
    expect(response.status).toBe(status);
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(response.headers['content-security-policy']).toBe(
      "default-src 'none'; style-src 'unsafe-inline'",
    );
    expect(response.headers.connection).toBe('close');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.body).toContain('<!doctype html>');
    expect(response.body).toContain('<html lang="en">');
    expect(response.body).toContain('<style>');
    expect(response.body).toContain(message);
    expect(response.body).toContain('return to the terminal');
    expect(response.body).not.toMatch(/<script|<link|<img|\b(?:href|src)=/i);
    expect(response.body).not.toContain('fake-code');
    if (mode === 'success') {
      expect(outcome.tokens?.access_token).toBe(fakeTokenResponse.access_token);
      expect(outcome.error).toBeUndefined();
      expect(exchanges()).toBe(1);
    } else {
      expect(outcome.error).toMatchObject({ exitCode: 3 });
      expect(exchanges()).toBe(0);
    }
  });

  it.each(['access_denied', 'server_error'])('escapes %s descriptions as text', async (error) => {
    const { callback, login, agent } = await beginLogin();
    callback.searchParams.set('error', error);
    const description = `<script>alert("x" & 'y')</script>`;
    callback.searchParams.set('error_description', description);
    const response = await request(callback, agent);
    expect(response.status).toBe(400);
    expect(response.body).toContain(
      '&lt;script&gt;alert(&quot;x&quot; &amp; &#39;y&#39;)&lt;/script&gt;',
    );
    expect(response.body).not.toContain(description);
    expect(response.body).not.toContain('<script>');
    expect((await login).error).toMatchObject({ code: 'AUTHORIZATION_DENIED' });
  });

  it('does not reflect error descriptions from an invalid OAuth state', async () => {
    const { callback, login, agent } = await beginLogin();
    callback.searchParams.set('state', 'wrong');
    callback.searchParams.set('error', 'access_denied');
    callback.searchParams.set('error_description', 'untrusted-provider-description');
    expect((await request(callback, agent)).body).not.toContain('untrusted-provider-description');
    expect((await login).error).toMatchObject({ code: 'STATE_MISMATCH' });
  });
});

describe('loopback connection shutdown', () => {
  it.each([false, true])(
    'allows the login process to exit naturally (denied=%s)',
    async (denied) => {
      const server = await localAuthServer((_req, res) =>
        res.end(JSON.stringify(fakeTokenResponse)),
      );
      cleanup.push(server.close);
      const child = fork(
        fileURLToPath(new URL('./fixtures/auth-loopback-worker.ts', import.meta.url)),
        [server.base],
        { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
      );
      cleanup.push(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill();
      });
      const exited = once(child, 'exit');
      const [message] = await once(child, 'message');
      const authorize = new URL((message as { authorize: string }).authorize);
      const callback = new URL(authorize.searchParams.get('redirect_uri')!);
      callback.search = new URLSearchParams({
        code: 'fake-code',
        state: authorize.searchParams.get('state')!,
        iss: server.base,
      }).toString();
      if (denied) callback.searchParams.set('error', 'access_denied');
      const agent = new Agent({ keepAlive: true });
      cleanup.push(() => agent.destroy());
      // Receiving the response proves the server saw this request, while its
      // declared but unsent body keeps the connection active on the server.
      const other = await request(new URL('/favicon.ico', callback), agent, {
        'Content-Length': '1',
      });
      const callbackAgent = new Agent({ keepAlive: true });
      cleanup.push(() => callbackAgent.destroy());
      expect((await request(callback, callbackAgent)).status).toBe(denied ? 400 : 200);
      await expect.poll(() => child.exitCode, { timeout: 2000 }).toBe(denied ? 3 : 0);
      expect(await exited).toEqual([denied ? 3 : 0, null]);
      expect(other.socket.destroyed).toBe(true);
    },
  );

  it.each([false, true])(
    'closes keep-alive connections after callback (denied=%s)',
    async (denied) => {
      const { callback, login, agent } = await beginLogin();
      const otherAgent = new Agent({ keepAlive: true });
      cleanup.push(() => otherAgent.destroy());
      const other = await request(new URL('/favicon.ico', callback), otherAgent, {
        'Content-Length': '1',
      });
      expect(other.status).toBe(404);
      expect(other.headers.connection).toBe('keep-alive');
      expect(other.socket.destroyed).toBe(false);
      // The response acknowledges that the server is still awaiting the unsent
      // request body; closeIdleConnections cannot clean up this active socket.
      if (denied) callback.searchParams.set('error', 'access_denied');
      const response = await request(callback, agent);
      const outcome = await login;
      expect(response.status).toBe(denied ? 400 : 200);
      if (denied) expect(outcome.error).toMatchObject({ code: 'AUTHORIZATION_DENIED' });
      else expect(outcome.tokens?.access_token).toBe(fakeTokenResponse.access_token);
      // Assert closure before any client-side cleanup, including the stalled socket.
      await Promise.all([other.closed, response.closed]);
      expect(other.socket.destroyed).toBe(true);
      expect(response.socket.destroyed).toBe(true);
      const refused = get(callback, { agent });
      // ECONNREFUSED precedes socket 'close', which removes this new socket
      // from the Agent. Observe closure before checking its connection counts.
      const refusedClosed = new Promise<void>((resolve) => {
        refused.once('socket', (socket) => socket.once('close', resolve));
      });
      await expect(once(refused, 'response')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
      await refusedClosed;
      expect(Object.values(agent.sockets).flat()).toHaveLength(0);
      expect(Object.values(agent.freeSockets).flat()).toHaveLength(0);
      expect(Object.values(otherAgent.sockets).flat()).toHaveLength(0);
      expect(Object.values(otherAgent.freeSockets).flat()).toHaveLength(0);
    },
  );
});
