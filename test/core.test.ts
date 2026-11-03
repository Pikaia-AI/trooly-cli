import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiClient, retryDelay } from '../src/http/client';
import { paginate } from '../src/http/paginate';
import { main } from '../src/index';
import { CLI_VERSION } from '../src/version';
import {
  docsUrl,
  loadOpenApi,
  openapiCacheFile,
  operations,
  listOperations,
  expandReferences,
  findOperation,
  describeOperation,
  nearestPaths,
  type OpenApiDocument,
} from '../src/http/openapi';
import { stringify } from 'yaml';
import { registerSecrets } from '../src/output/json';
import { emit } from '../src/output/render';
import { table } from '../src/output/table';

const document: OpenApiDocument = {
  openapi: '3.0.3',
  info: { title: 'Sample API', version: '1' },
  paths: {
    '/trooly/v1/projects': {
      parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer' } }],
      get: {
        operationId: 'listProjects',
        tags: ['projects'],
        summary: 'List projects',
        'x-required-permission': 'project.read',
        responses: {
          200: {
            description: 'ok',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Project' } } },
          },
        },
      },
      post: {
        operationId: 'createProject',
        tags: ['projects'],
        summary: 'Create project',
        requestBody: {
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Project' } } },
        },
        responses: { 201: { description: 'created' }, 400: { description: 'invalid' } },
      },
    },
    '/trooly/v1/projects/{id}': {
      get: { operationId: 'getProject', tags: ['projects'], summary: 'Read one project' },
    },
    '/trooly/v1/interviews': {
      get: { operationId: 'listTranscripts', tags: ['interviews'], summary: 'Read transcripts' },
    },
  },
  components: {
    schemas: {
      Project: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string', example: 'Sample' },
          parent: { $ref: '#/components/schemas/Project' },
          nested: { $ref: '#/components/schemas/Level1' },
        },
      },
      Level1: { type: 'object', properties: { child: { $ref: '#/components/schemas/Level2' } } },
      Level2: { type: 'object', properties: { child: { $ref: '#/components/schemas/Level3' } } },
      Level3: { type: 'object', properties: { child: { $ref: '#/components/schemas/Level4' } } },
      Level4: { type: 'string' },
    },
  },
};
interface Seen {
  method: string;
  path: string;
  query: Record<string, string>;
  body: string;
  headers: IncomingMessage['headers'];
}
let server: Server;
let base: string;
let dir: string;
let seen: Seen[];
let output: string[];
let errors: string[];
let respond: (req: Seen, res: ServerResponse) => void;
function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'trooly-core-'));
  for (const name of ['XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'APPDATA', 'LOCALAPPDATA']) {
    vi.stubEnv(name, dir);
  }
  vi.stubEnv('TROOLY_API_KEY', 'fake-core-key');
  vi.stubEnv('TROOLY_DEBUG', '0');
  vi.stubEnv('TROOLY_NO_UPDATE_CHECK', '1');
  vi.stubEnv('TROOLY_PROFILE', 'default');
  seen = [];
  output = [];
  errors = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
    output.push(String(data));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((data) => {
    errors.push(String(data));
    return true;
  });
  respond = (_req, res) => send(res, 200, { data: { id: '9007199254740993' } });
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const url = new URL(req.url!, base);
    const call = {
      method: req.method!,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body: Buffer.concat(chunks).toString(),
      headers: req.headers,
    };
    seen.push(call);
    if (call.path === '/docs/openapi.yaml') {
      res.writeHead(200, { 'Content-Type': 'application/yaml' });
      res.end(stringify(document));
    } else {
      respond(call, res);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No local port');
  base = `http://127.0.0.1:${address.port}`;
  vi.stubEnv('TROOLY_API_BASE', base);
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const run = (...args: string[]) => main(['node', 'trooly', ...args]);
describe('request boundary', () => {
  it('sends required headers and preserves IDs and repeated query/field options', async () => {
    expect(
      await run(
        'api',
        'POST',
        '/trooly/v1/projects',
        '-q',
        'limit=50',
        '-q',
        'cursor=a+b',
        '-f',
        'id=9007199254740993',
        '-f',
        'title=Sample',
        '--json',
      ),
    ).toBe(0);
    expect(JSON.parse(output.join(''))).toEqual({ id: '9007199254740993' });
    expect(seen[0].headers.authorization).toBe('Bearer fake-core-key');
    expect(seen[0].headers['x-trooly-cli-version']).toBe(CLI_VERSION);
    const escapedVersion = CLI_VERSION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(seen[0].headers['user-agent']).toMatch(
      new RegExp(`^trooly-cli/${escapedVersion} \\(.+; .+\\) node/`),
    );
    expect(seen[0].headers['idempotency-key']).toMatch(/^[a-f0-9-]{36}$/);
    expect(seen[0].query).toEqual({ limit: '50', cursor: 'a+b' });
    expect(JSON.parse(seen[0].body)).toEqual({ id: '9007199254740993', title: 'Sample' });
  });
  it.each([429, 503])(
    'retries %s preserving idempotency key and obeying Retry-After',
    async (status) => {
      const delays: number[] = [];
      respond = (_req, res) =>
        send(res, seen.length < 3 ? status : 200, { data: { ok: true } }, { 'Retry-After': '2' });
      await new ApiClient({
        apiBase: base,
        sleep: async (ms) => {
          delays.push(ms);
        },
      }).request('POST', '/trooly/v1/projects', { body: { title: 'Sample' } });
      expect(delays).toEqual([2000, 2000]);
      expect(seen).toHaveLength(3);
      expect(new Set(seen.map((call) => call.headers['idempotency-key'])).size).toBe(1);
    },
  );
  it('limits retries to three and does not retry PATCH', async () => {
    respond = (_req, res) =>
      send(res, 503, { error: { code: 'UNAVAILABLE', message: 'Later' } }, { 'Retry-After': '0' });
    const client = new ApiClient({ apiBase: base });
    await expect(client.request('GET', '/trooly/v1/projects')).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });
    expect(seen).toHaveLength(4);
    await expect(
      client.request('PATCH', '/trooly/v1/projects/1', { body: {} }),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(seen).toHaveLength(5);
  });
  it('retries network failures with exponential delay', async () => {
    const delays: number[] = [];
    let attempts = 0;
    const client = new ApiClient({
      apiBase: base,
      fetch: async (...args) => {
        if (++attempts < 3) throw new TypeError('failed');
        return fetch(...args);
      },
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    expect((await client.request('GET', '/trooly/v1/projects')).data).toEqual({
      id: '9007199254740993',
    });
    expect(delays).toEqual([1000, 2000]);
  });
  it.each([
    [400, 1],
    [401, 3],
    [403, 4],
    [426, 5],
    [500, 1],
  ])('HTTP %s maps to exit %s and stderr JSON', async (status, code) => {
    respond = (_req, res) =>
      send(res, status, {
        error: { code: 'TEST_ERROR', message: 'Rejected' },
        meta: { request_id: 'req_sample' },
      });
    expect(await run('api', 'GET', '/trooly/v1/projects', '--json')).toBe(code);
    expect(output).toHaveLength(0);
    expect(JSON.parse(errors.join('')).meta.request_id).toBe('req_sample');
    expect(seen).toHaveLength(1);
    if (status === 403) expect(errors.join('')).toContain('trooly auth status');
    if (status === 426) expect(errors.join('')).toContain('trooly update');
  });
  it.each(['//attacker.invalid/', 'https://attacker.invalid/', '/a/../b', '/bad%ZZ'])(
    'rejects unsafe path %s without a request',
    async (path) => {
      expect(await run('api', 'GET', path, '--json')).toBe(2);
      expect(seen).toHaveLength(0);
    },
  );
  it('forbids Authorization overrides and malformed JSON before sending', async () => {
    expect(
      await run('api', 'GET', '/trooly/v1/projects', '-H', 'aUtHoRiZaTiOn: bad', '--json'),
    ).toBe(2);
    await writeFile(join(dir, 'bad.json'), '{');
    expect(
      await run('api', 'POST', '/trooly/v1/projects', '--input', join(dir, 'bad.json'), '--json'),
    ).toBe(2);
    expect(seen).toHaveLength(0);
  });
  it('does not follow gateway redirects with credentials', async () => {
    respond = (_req, res) => {
      res.writeHead(302, { Location: '/other' });
      res.end();
    };
    expect(await run('api', 'GET', '/redirect', '--json')).toBe(1);
    expect(seen).toHaveLength(1);
  });
  it('streams exports to a file, preserving original bytes and stdout', async () => {
    respond = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/csv' });
      res.end('id,title\n1,Sample\n');
    };
    const file = join(dir, 'export.csv');
    expect(await run('api', 'GET', '/export', '-o', file, '--json')).toBe(0);
    expect(await readFile(file, 'utf8')).toBe('id,title\n1,Sample\n');
    expect(output).toHaveLength(0);
  });
  it('requires confirmation for a raw destructive request', async () => {
    expect(await run('api', 'DELETE', '/trooly/v1/projects/1', '--json')).toBe(2);
    expect(seen).toHaveLength(0);
    errors = [];
    expect(await run('api', 'DELETE', '/trooly/v1/projects/1', '--yes', '--json')).toBe(0);
  });
  it('redacts debug and echoed credential fields', async () => {
    vi.stubEnv('TROOLY_DEBUG', '1');
    respond = (_req, res) =>
      send(res, 200, { data: { access_token: 'fake-response-token', message: 'fake-core-key' } });
    expect(await run('api', 'POST', '/trooly/v1/projects', '--json')).toBe(0);
    expect(output.join('')).not.toContain('fake-response-token');
    expect(output.join('')).not.toContain('fake-core-key');
    expect(errors.join('')).toContain('[REDACTED]');
    expect(errors.join('')).not.toContain('fake-core-key');
    expect(errors.join('')).not.toContain(seen[0].headers['idempotency-key']);
  });
  it('redacts active OAuth tokens embedded in upstream error messages and details', async () => {
    registerSecrets('fake-current-access-token');
    respond = (_req, res) =>
      send(res, 500, {
        error: {
          code: 'FAILED',
          message: 'Rejected fake-current-access-token',
          details: { echo: 'fake-current-access-token' },
        },
      });
    expect(await run('api', 'GET', '/trooly/v1/projects', '--json')).toBe(1);
    expect(errors.join('')).not.toContain('fake-current-access-token');
    expect(JSON.parse(errors.join('')).error.details.echo).toBe('[REDACTED]');
  });
  it('interprets delta and HTTP-date Retry-After values', () => {
    expect(retryDelay('3', 0)).toBe(3000);
    expect(retryDelay('Thu, 01 Jan 1970 00:00:10 GMT', 0, 5000)).toBe(5000);
    expect(retryDelay('invalid', 2)).toBe(4000);
  });
});
describe('pagination and discovery', () => {
  it('renders large combined lists without overflowing the argument stack', () => {
    const rows = Array.from({ length: 150000 }, (_, id) => ({ id: String(id) }));
    emit(rows, true);
    const parsed = JSON.parse(output.join(''));
    expect(parsed).toHaveLength(150000);
    expect(parsed.at(-1)).toEqual({ id: '149999' });
    expect(table(rows).split('\n')).toHaveLength(150001);
  });
  it('merges cursor pages and retains filters', async () => {
    respond = (req, res) =>
      send(res, 200, {
        data: [{ id: req.query.cursor ? '2' : '1' }],
        meta: { next_cursor: req.query.cursor ? null : 'next' },
      });
    expect(
      await run('api', 'GET', '/trooly/v1/projects', '--paginate', '-q', 'limit=1', '--json'),
    ).toBe(0);
    expect(JSON.parse(output.join(''))).toEqual([{ id: '1' }, { id: '2' }]);
    expect(seen.map((x) => x.query.limit)).toEqual(['1', '1']);
  });
  it('rejects repeated cursors and non-list pagination', async () => {
    await expect(
      paginate(async () => ({ data: [], meta: { next_cursor: 'same' } })),
    ).rejects.toMatchObject({ code: 'PAGINATION_LOOP' });
    await expect(paginate(async () => ({ data: { id: '1' } }))).rejects.toMatchObject({
      code: 'NOT_A_LIST',
    });
  });
  it('lists without authentication and filters tag/keyword', async () => {
    vi.stubEnv('TROOLY_API_KEY', '');
    expect(
      await run('api', 'list', '--tag', 'interviews', '--search', 'transcript', '--json'),
    ).toBe(0);
    expect(JSON.parse(output.join(''))).toEqual([
      {
        method: 'GET',
        path: '/trooly/v1/interviews',
        operationId: 'listTranscripts',
        summary: 'Read transcripts',
      },
    ]);
    expect(seen[0].headers.authorization).toBeUndefined();
    expect(listOperations(document, 'projects')).toHaveLength(3);
  });
  it('finds operations by ID and method/path and expands references safely', async () => {
    const byId = findOperation(document, 'listProjects')!;
    expect(findOperation(document, 'GET', '/trooly/v1/projects')).toEqual(byId);
    const expanded = expandReferences(byId.operation, document);
    expect(JSON.stringify(expanded)).toContain('Sample');
    expect(JSON.stringify(expanded)).toContain('#/components/schemas/Project');
    expect(await run('api', 'describe', 'GET', '/trooly/v1/projects', '--json')).toBe(0);
    expect(JSON.parse(output.join('')).parameters[0].name).toBe('limit');
    expect(describeOperation(findOperation(document, 'createProject')!, document, base)).toContain(
      'Example JSON:',
    );
  });
  it('prints operation-specific docs link without opening a browser', async () => {
    expect(await run('docs', 'listProjects')).toBe(0);
    expect(output.join('')).toBe(`${base}/docs#tag/projects/operation/listProjects\n`);
    expect(docsUrl(base, operations(document)[0])).toBe(
      `${base}/docs#tag/projects/operation/listProjects`,
    );
  });
  it('refreshes after 24h and on --refresh, then falls back to a cached contract', async () => {
    await loadOpenApi(base);
    await loadOpenApi(base);
    expect(seen).toHaveLength(1);
    await loadOpenApi(base, true);
    expect(seen).toHaveLength(2);
    const file = openapiCacheFile(base);
    const past = new Date(Date.now() - 86401000);
    await utimes(file, past, past);
    await loadOpenApi(base);
    expect(seen).toHaveLength(3);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect((await loadOpenApi(base, true)).paths).toEqual(document.paths);
    expect(errors.join('')).toContain('cached');
  });
  it('reports a docs link when no cache and gateway unavailable', async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await expect(loadOpenApi(base)).rejects.toThrow(`${base}/docs`);
  });
  it('adds approximate-path and parameter hints without hiding the original error', async () => {
    respond = (_req, res) => send(res, 404, { error: { code: 'NOT_FOUND', message: 'Missing' } });
    expect(await run('api', 'GET', '/trooly/v1/projets', '--json')).toBe(1);
    expect(JSON.parse(errors.join('')).error.message).toContain('/trooly/v1/projects');
    expect(nearestPaths(document, '/trooly/v1/projets')[0]).toBe('/trooly/v1/projects');
    errors = [];
    respond = (_req, res) =>
      send(res, 400, { error: { code: 'INVALID_ARGUMENT', message: 'Invalid' } });
    expect(await run('api', 'GET', '/trooly/v1/projects', '--json')).toBe(1);
    expect(JSON.parse(errors.join('')).error.message).toContain('trooly api describe listProjects');
  });
  it('renders help, guide and usage errors without network calls', async () => {
    expect(await run('--help')).toBe(0);
    expect(output.join('')).toContain('trooly api list');
    output = [];
    expect(await run('api', '--help')).toBe(0);
    expect(output.join('')).toContain('trooly guide');
    output = [];
    expect(await run('guide')).toBe(0);
    expect(output.join('')).toContain('trooly auth status --json');
    output = [];
    expect(await run('unknown-command', '--json')).toBe(2);
    expect(output).toHaveLength(0);
    expect(JSON.parse(errors.join('')).error.code).toBe('USAGE_ERROR');
    expect(seen).toHaveLength(0);
  });
});
