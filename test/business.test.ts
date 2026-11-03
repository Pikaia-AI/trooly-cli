import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerBusiness, poll } from '../src/commands/business';
import { CliError } from '../src/http/errors';

interface Seen {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  authorization?: string;
}
let server: Server;
let directory: string;
let base: string;
let requests: Seen[];
let stdout: string[];
let respond: (request: IncomingMessage, response: ServerResponse, seen: Seen) => void;

async function run(args: string[]) {
  const program = new Command()
    .exitOverride()
    .option('--json')
    .option('--profile <name>')
    .option('--yes');
  registerBusiness(program);
  await program.parseAsync(['node', 'trooly', '--json', ...args]);
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'trooly-business-'));
  await writeFile(
    join(directory, 'input.json'),
    JSON.stringify({ title: 'Sample', expected_draft_revision: '9007199254740993' }),
  );
  vi.stubEnv('XDG_CONFIG_HOME', directory);
  vi.stubEnv('XDG_CACHE_HOME', directory);
  vi.stubEnv('APPDATA', directory);
  vi.stubEnv('LOCALAPPDATA', directory);
  vi.stubEnv('TROOLY_API_KEY', 'test-only-api-key');
  vi.stubEnv('TROOLY_NO_UPDATE_CHECK', '1');
  vi.stubEnv('TROOLY_DEBUG', '0');
  stdout = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((value) => {
    stdout.push(String(value));
    return true;
  });
  requests = [];
  respond = (_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ data: [{ id: '1' }], meta: {} }));
  };
  server = createServer(async (request, response) => {
    const parts: Buffer[] = [];
    for await (const part of request) parts.push(Buffer.from(part));
    const text = Buffer.concat(parts).toString();
    const url = new URL(request.url!, base);
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }
    const seen = {
      method: request.method!,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body,
      authorization: request.headers.authorization,
    };
    requests.push(seen);
    respond(request, response, seen);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No mock port');
  base = `http://127.0.0.1:${address.port}`;
  vi.stubEnv('TROOLY_API_BASE', base);
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const cases: [string[], string, string, boolean?][] = [
  [['project', 'list'], 'GET', '/trooly/v1/projects'],
  [['project', 'get', '9007199254740993'], 'GET', '/trooly/v1/projects/9007199254740993'],
  [['project', 'create', '--input', 'INPUT'], 'POST', '/trooly/v1/projects', true],
  [['project', 'update', '1', '--input', 'INPUT'], 'PUT', '/trooly/v1/projects/1', true],
  [['project', 'delete', '1', '--yes'], 'DELETE', '/trooly/v1/projects/1'],
  [
    ['project', 'launch', '1', '--yes', '--input', 'INPUT'],
    'POST',
    '/trooly/v1/projects/1/launch',
    true,
  ],
  [['project', 'terminate', '1', '--yes'], 'POST', '/trooly/v1/projects/1/terminate'],
  [['project', 'report', '1'], 'GET', '/trooly/v1/projects/1/report'],
  [['interview', 'list', '1'], 'GET', '/trooly/v1/projects/1/interviews'],
  [['interview', 'get', '2'], 'GET', '/trooly/v1/interviews/2'],
  [['interview', 'delete', '2', '--yes'], 'DELETE', '/trooly/v1/interviews/2'],
  [['study', 'list'], 'GET', '/trooly/v2/projects'],
  [['study', 'get', '1'], 'GET', '/trooly/v2/projects/1'],
  [['study', 'create', '--input', 'INPUT'], 'POST', '/trooly/v2/projects', true],
  [['study', 'update', '1', '--input', 'INPUT'], 'PATCH', '/trooly/v2/projects/1', true],
  [['study', 'delete', '1', '--yes'], 'DELETE', '/trooly/v2/projects/1'],
  [['study', 'duplicate', '1'], 'POST', '/trooly/v2/projects/1/duplicate'],
  [['study', 'draft', 'get', '1'], 'GET', '/trooly/v2/projects/1/draft'],
  [
    ['study', 'draft', 'edit', '1', '--input', 'INPUT'],
    'POST',
    '/trooly/v2/projects/1/draft/edits',
    true,
  ],
  [['study', 'draft', 'versions', '1'], 'GET', '/trooly/v2/projects/1/draft/versions'],
  [
    ['study', 'publish', '1', '--input', 'INPUT'],
    'POST',
    '/trooly/v2/projects/1/design/publish',
    true,
  ],
  [['study', 'quote', '1'], 'GET', '/trooly/v2/projects/1/quote'],
  [['study', 'responses', '1'], 'GET', '/trooly/v2/projects/1/responses'],
  [['study', 'response', '1', '2'], 'GET', '/trooly/v2/projects/1/responses/2'],
  [['study', 'report', '1'], 'GET', '/trooly/v2/projects/1/report'],
  [['kb', 'list'], 'GET', '/platform/v2/knowledge_bases'],
  [['kb', 'get', 'kb_1'], 'GET', '/platform/v2/knowledge_bases/kb_1'],
  [['kb', 'create', '--input', 'INPUT'], 'POST', '/platform/v2/knowledge_bases', true],
  [
    ['kb', 'update', 'kb_1', '--input', 'INPUT'],
    'PATCH',
    '/platform/v2/knowledge_bases/kb_1',
    true,
  ],
  [['kb', 'delete', 'kb_1', '--yes'], 'DELETE', '/platform/v2/knowledge_bases/kb_1'],
  [['doc', 'list', '--kb', 'kb_1', '--status', 'ready'], 'GET', '/platform/v2/documents'],
  [['doc', 'get', 'doc_1'], 'GET', '/platform/v2/documents/doc_1'],
  [['doc', 'delete', 'doc_1', '--yes'], 'DELETE', '/platform/v2/documents/doc_1'],
  [['doc', 'retry', 'doc_1'], 'POST', '/platform/v2/documents/doc_1/retry'],
  [['webhook', 'list'], 'GET', '/platform/v2/webhooks'],
  [['webhook', 'create', '--input', 'INPUT'], 'POST', '/platform/v2/webhooks', true],
  [['webhook', 'delete', 'wh_1', '--yes'], 'DELETE', '/platform/v2/webhooks/wh_1'],
  [['webhook', 'deliveries', 'wh_1'], 'GET', '/platform/v2/webhooks/wh_1/deliveries'],
  [
    ['webhook', 'redeliver', 'wh_1', 'del_2'],
    'POST',
    '/platform/v2/webhooks/wh_1/deliveries/del_2/redeliver',
  ],
  [
    ['usage', 'get', '--from', '2026-01-01T00:00:00Z', '--to', '2026-02-01T00:00:00Z'],
    'GET',
    '/platform/v2/usage',
  ],
  [
    ['usage', 'events', '--from', '2026-01-01T00:00:00Z', '--to', '2026-02-01T00:00:00Z'],
    'GET',
    '/platform/v2/usage/events',
  ],
];

describe('dedicated API commands', () => {
  it.each(cases)('%j sends %s %s', async (args, method, path, hasBody) => {
    await run(args.map((value) => (value === 'INPUT' ? join(directory, 'input.json') : value)));
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method, path, authorization: 'Bearer test-only-api-key' });
    if (hasBody) {
      expect(requests[0].body).toEqual({
        title: 'Sample',
        expected_draft_revision: '9007199254740993',
      });
    } else {
      expect(requests[0].body).toBeUndefined();
    }
    if (args[0] === 'usage') {
      expect(requests[0].query).toMatchObject({
        from: '2026-01-01T00:00:00Z',
        to: '2026-02-01T00:00:00Z',
      });
    }
    if (args[0] === 'doc' && args[1] === 'list') {
      expect(requests[0].query).toEqual({ knowledge_base_id: 'kb_1', status: 'ready' });
    }
    expect(JSON.parse(stdout.join(''))).toEqual([{ id: '1' }]);
  });

  it.each([
    ['project', 'delete', '1'],
    ['project', 'launch', '1'],
    ['project', 'terminate', '1'],
    ['interview', 'delete', '1'],
    ['study', 'delete', '1'],
    ['kb', 'delete', 'kb_1'],
    ['doc', 'delete', 'doc_1'],
    ['webhook', 'delete', 'wh_1'],
  ])('%j requires noninteractive confirmation before any request', async (...args) => {
    await expect(run(args)).rejects.toMatchObject({ exitCode: 2 });
    expect(requests).toHaveLength(0);
  });

  it('constructs knowledge search from opaque identifiers and query', async () => {
    await run([
      'knowledge',
      'search',
      'sample words',
      '--kb',
      'kb_1',
      '--kb',
      'kb_2',
      '--doc',
      'doc_3',
      '--top-k',
      '7',
    ]);
    expect(requests[0]).toMatchObject({
      method: 'POST',
      path: '/platform/v2/knowledge/search',
      body: {
        query: 'sample words',
        knowledge_base_ids: ['kb_1', 'kb_2'],
        document_ids: ['doc_3'],
        top_k: 7,
      },
    });
  });

  it('keeps the list page size and starts at the supplied cursor', async () => {
    await run(['project', 'list', '--limit', '12', '--cursor', 'opaque:page']);
    expect(requests[0].query).toEqual({ limit: '12', cursor: 'opaque:page' });
  });

  it.each([
    ['study', 'list', 'projects'],
    ['study', 'responses', 'interviews'],
    ['study', 'draft', 'versions'],
  ])('merges wrapped pages for %s %s', async (group, verb, key) => {
    respond = (_request, response, seen) => {
      response.setHeader('Content-Type', 'application/json');
      const next = seen.query.cursor ? null : 'page-2';
      response.end(
        JSON.stringify({
          data: {
            [key]: [{ id: seen.query.cursor ? '2' : '1' }],
            ...(key === 'versions' ? {} : { next_cursor: next }),
          },
          meta: key === 'versions' ? { next_cursor: next } : {},
        }),
      );
    };
    const args =
      verb === 'draft'
        ? [group, verb, 'versions', '1']
        : [group, verb, ...(verb === 'list' ? [] : ['1'])];
    await run([...args, '--all', '--limit', '10']);
    expect(JSON.parse(stdout.join(''))).toEqual([{ id: '1' }, { id: '2' }]);
    expect(requests.map((request) => request.query)).toEqual([
      { limit: '10' },
      { limit: '10', cursor: 'page-2' },
    ]);
  });

  it.each([
    ['study', 'export', 'responses', '1'],
    ['study', 'export', 'transcripts', '1'],
    ['usage', 'export', '--from', '2026-01-01T00:00:00Z', '--to', '2026-02-01T00:00:00Z'],
  ])('%j writes the server bytes to the requested file', async (...args) => {
    respond = (_request, response) => {
      response.setHeader('Content-Type', 'text/plain');
      response.end('sample,file\n1,value\n');
    };
    const output = join(directory, 'export.txt');
    await run([...args, '-o', output]);
    expect(await readFile(output, 'utf8')).toBe('sample,file\n1,value\n');
    expect(stdout).toEqual([]);
    const expectedPath =
      args[0] === 'usage'
        ? '/platform/v2/usage/export'
        : `/trooly/v2/projects/1/exports/${args[2]}`;
    expect(requests[0]).toMatchObject({ method: 'GET', path: expectedPath });
  });
});

it('uploads, confirms and polls a document without sending API credentials to storage', async () => {
  const source = join(directory, 'notes.md');
  await writeFile(source, 'test document');
  respond = (_request, response, seen) => {
    response.setHeader('Content-Type', 'application/json');
    if (seen.path === '/platform/v2/documents/uploads') {
      response.end(
        JSON.stringify({
          data: { document: { id: 'doc_1' }, upload_url: `${base}/signed-upload` },
        }),
      );
    } else if (seen.path === '/signed-upload') response.end('');
    else if (seen.path.endsWith('/complete')) {
      response.end(JSON.stringify({ data: { id: 'doc_1', status: 'processing' } }));
    } else {
      response.end(JSON.stringify({ data: { id: 'doc_1', status: 'ready' } }));
    }
  };
  await run(['doc', 'upload', source, '--kb', 'kb_1', '--wait']);
  expect(requests.map((item) => [item.method, item.path])).toEqual([
    ['POST', '/platform/v2/documents/uploads'],
    ['PUT', '/signed-upload'],
    ['POST', '/platform/v2/documents/doc_1/complete'],
    ['GET', '/platform/v2/documents/doc_1'],
  ]);
  expect(requests[0].body).toEqual({
    knowledge_base_id: 'kb_1',
    title: 'notes.md',
    file_type: 'md',
    file_size: 13,
    private: false,
  });
  expect(requests[1].body).toBe('test document');
  expect(requests[1].authorization).toBeUndefined();
  expect(JSON.parse(stdout.join(''))).toEqual({ id: 'doc_1', status: 'ready' });
});

it('downloads a document using only its signed URL', async () => {
  respond = (_request, response, seen) => {
    if (seen.path.endsWith('/download')) {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ data: { download_url: `${base}/signed-download` } }));
    } else {
      response.end('document content');
    }
  };
  const output = join(directory, 'document.txt');
  await run(['doc', 'download', 'doc_1', '-o', output]);
  expect(await readFile(output, 'utf8')).toBe('document content');
  expect(requests[1].authorization).toBeUndefined();
});

it('creates, polls and downloads an archive using a string identifier', async () => {
  respond = (_request, response, seen) => {
    if (seen.path === '/archive-file') {
      response.end('archive bytes');
      return;
    }
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify({
        data:
          seen.method === 'POST'
            ? { archive: { archive_id: '9007199254740993', status: 'pending' } }
            : {
                archive_id: '9007199254740993',
                status: 'ready',
                download_url: `${base}/archive-file`,
              },
      }),
    );
  };
  const output = join(directory, 'archive.zip');
  await run(['study', 'media', 'archive', '1', '--wait', '-o', output]);
  expect(requests[0]).toMatchObject({
    method: 'POST',
    path: '/trooly/v2/projects/1/media/archives',
    body: {},
  });
  expect(requests[1]).toMatchObject({
    method: 'GET',
    path: '/trooly/v2/projects/1/media/archives/9007199254740993',
  });
  expect(requests[2].authorization).toBeUndefined();
  expect(await readFile(output, 'utf8')).toBe('archive bytes');
});

it('requires --wait before requesting an archive download', async () => {
  await expect(
    run(['study', 'media', 'archive', '1', '-o', join(directory, 'file.zip')]),
  ).rejects.toMatchObject({ exitCode: 2 });
  expect(requests).toHaveLength(0);
});

it('rejects unsupported upload types before creating remote state', async () => {
  const source = join(directory, 'archive.zip');
  await writeFile(source, 'bytes');
  await expect(run(['doc', 'upload', source, '--kb', 'kb_1'])).rejects.toMatchObject({
    exitCode: 2,
  });
  expect(requests).toHaveLength(0);
});

it.each(['failed', 'expired'])('stops polling a %s job', async (status) => {
  const read = vi.fn();
  await expect(poll({ status }, read, (value) => value.status)).rejects.toMatchObject({
    code: 'PROCESSING_FAILED',
  });
  expect(read).not.toHaveBeenCalled();
});

it('bounds polling without starting another job', async () => {
  let time = 0;
  const read = vi.fn().mockResolvedValue({ status: 'running' });
  await expect(
    poll({ status: 'pending' }, read, (value) => value.status, {
      timeoutMs: 5,
      intervalMs: 2,
      now: () => time,
      sleep: async (ms) => {
        time += ms;
      },
    }),
  ).rejects.toBeInstanceOf(CliError);
  expect(read).toHaveBeenCalledTimes(2);
});

it('accepts confirmation before the command group', async () => {
  await run(['--yes', 'project', 'delete', '1']);
  expect(requests[0]).toMatchObject({ method: 'DELETE', path: '/trooly/v1/projects/1' });
});

it('does not confirm a document whose storage upload failed', async () => {
  const source = join(directory, 'notes.txt');
  await writeFile(source, 'sample');
  respond = (_request, response, seen) => {
    if (seen.path.endsWith('/uploads')) {
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({
          data: { document: { id: 'doc_1' }, upload_url: `${base}/failed-upload` },
        }),
      );
    } else {
      response.writeHead(403).end();
    }
  };
  await expect(run(['doc', 'upload', source, '--kb', 'kb_1'])).rejects.toBeInstanceOf(CliError);
  expect(requests.map((item) => item.path)).toEqual([
    '/platform/v2/documents/uploads',
    '/failed-upload',
  ]);
});

it('does not download a failed archive', async () => {
  respond = (_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ data: { archive: { archive_id: '1', status: 'failed' } } }));
  };
  await expect(
    run(['study', 'media', 'archive', '1', '--wait', '-o', join(directory, 'output.zip')]),
  ).rejects.toMatchObject({ code: 'PROCESSING_FAILED' });
  expect(requests).toHaveLength(1);
});

it('returns the created archive immediately when --wait is absent', async () => {
  const data = { archive: { archive_id: '1', status: 'pending' } };
  respond = (_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ data }));
  };
  await run(['study', 'media', 'archive', '1']);
  expect(requests).toHaveLength(1);
  expect(JSON.parse(stdout.join(''))).toEqual(data);
});

it('preserves the whole draft-version object when --all is absent', async () => {
  const data = { versions: [{ id: '1' }], version_state: { can_undo: true } };
  respond = (_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ data }));
  };
  await run(['study', 'draft', 'versions', '1']);
  expect(JSON.parse(stdout.join(''))).toEqual(data);
});
