import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const release = vi.hoisted(() => ({ current: '0.1.0-beta.4' }));
vi.mock('../src/version', () => ({
  get CLI_VERSION() {
    return release.current;
  },
}));

const prompt = vi.hoisted(() => ({ question: vi.fn(), close: vi.fn() }));
vi.mock('node:readline/promises', () => ({ createInterface: () => prompt }));

import * as updateModule from '../src/update/run';
import { runUpdate } from '../src/update/run';
import { startUpdateCheck } from '../src/update/check';
import { createProgram } from '../src/index';
import { getPaths } from '../src/config/paths';

const ttyDescriptors = [process.stdin, process.stdout].map((stream) =>
  Object.getOwnPropertyDescriptor(stream, 'isTTY'),
);
function setTTY(value: boolean) {
  for (const stream of [process.stdin, process.stdout]) {
    Object.defineProperty(stream, 'isTTY', { configurable: true, value });
  }
}
let root: string;
let tags: Record<string, string>;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  prompt.question.mockReset();
  prompt.close.mockReset();
  root = await mkdtemp(join(tmpdir(), 'trooly-channels-'));
  vi.stubEnv('XDG_CACHE_HOME', root);
  vi.stubEnv('LOCALAPPDATA', root);
  vi.stubEnv('npm_config_registry', 'http://127.0.0.1:12345');
  release.current = '0.1.0-beta.4';
  tags = { latest: '0.1.0-beta.0', next: '0.1.0-beta.5' };
  fetchMock = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          'dist-tags': tags,
          versions: { '0.1.0-beta.0': {}, '0.1.0-beta.4': {}, '0.1.0-beta.5': {}, '0.1.0': {} },
        }),
      ),
  );
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(async () => {
  [process.stdin, process.stdout].forEach((stream, index) => {
    const descriptor = ttyDescriptors[index];
    if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor);
    else Reflect.deleteProperty(stream, 'isTTY');
  });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

const scenarios = [
  ['next ahead', '0.1.0-beta.4', '0.1.0-beta.0', '0.1.0-beta.5', '0.1.0-beta.5', true],
  ['stable release ahead', '0.1.0-beta.4', '0.1.0', '0.1.0-beta.5', '0.1.0', true],
  ['both older', '0.1.0-beta.4', '0.1.0-beta.0', '0.1.0-beta.3', '0.1.0-beta.3', false],
  ['next equal', '0.1.0-beta.4', '0.1.0-beta.0', '0.1.0-beta.4', '0.1.0-beta.4', false],
  ['stable ignores next', '0.1.0', '0.1.0', '0.2.0-beta.1', '0.1.0', false],
  ['stable latest older', '0.1.0', '0.1.0-beta.0', '0.2.0-beta.1', '0.1.0-beta.0', false],
  [
    'numeric prerelease order',
    '0.1.0-beta.4',
    '0.1.0-beta.2',
    '0.1.0-beta.10',
    '0.1.0-beta.10',
    true,
  ],
  ['build metadata equality', '0.1.0+one', '0.1.0+two', '0.2.0-beta.1', '0.1.0+two', false],
  [
    'hyphen in build metadata is stable',
    '0.1.0+build-one',
    '0.1.0',
    '0.2.0-beta.1',
    '0.1.0',
    false,
  ],
] as const;

describe('release channels across manual and daily checks', () => {
  it.each(scenarios)('%s', async (_name, current, latest, next, target, newer) => {
    release.current = current;
    tags = { latest, next };
    const write = vi.fn();
    const runner = vi
      .fn()
      .mockResolvedValueOnce({ code: 0, output: 'installed' })
      .mockResolvedValueOnce({ code: 0, output: target });
    await runUpdate({ check: true }, { write, runner });
    expect(write.mock.calls[0][0]).toBe(
      newer
        ? `Available: ${target} (current ${current}).\n`
        : `Already up to date (current ${current}; target ${target}).\n`,
    );
    expect(runner).not.toHaveBeenCalled();
    await runUpdate({ method: 'npm' }, { write, runner });
    if (newer) expect(runner.mock.calls[0][1]).toEqual(['install', '-g', `trooly@${target}`]);
    else expect(runner).not.toHaveBeenCalled();
    const notices: string[] = [];
    const daily = startUpdateCheck({
      env: { npm_config_registry: 'http://127.0.0.1:12345' },
      stderrTTY: true,
      write: (text) => notices.push(text),
    });
    await daily.settled;
    await daily.finish();
    expect(notices).toEqual(
      newer
        ? [`A new version ${target} is available (current ${current}); run trooly update.\n`]
        : [],
    );
  });
});

async function dailyNotice() {
  const write = vi.fn();
  const check = startUpdateCheck({
    env: { npm_config_registry: 'http://127.0.0.1:12345' },
    stderrTTY: true,
    write,
  });
  await check.settled;
  await check.finish();
  return write.mock.calls.map(([text]) => text);
}

it.each([
  { latest: '0.1.0' },
  { next: '0.1.0-beta.5' },
  { latest: 'broken', next: '0.1.0-beta.5' },
])('uses a valid available tag for prereleases: %j', async (available) => {
  tags = available as Record<string, string>;
  const write = vi.fn();
  await runUpdate({ check: true }, { write });
  expect(write.mock.calls[0][0]).toMatch(/Available: 0.1.0/);
});

it('fails explicit updates and silently skips daily notices when neither tag is valid', async () => {
  tags = { latest: 'broken', next: 'bad' };
  await expect(runUpdate({ check: true })).rejects.toMatchObject({ code: 'REGISTRY_ERROR' });
  expect(await dailyNotice()).toEqual([]);
});

it.each([undefined, '0.0.9-beta.1'])(
  'invalidates legacy or different-version caches (%s)',
  async (current) => {
    const cache = join(getPaths().cacheDir, 'update-check.json');
    await mkdir(getPaths().cacheDir, { recursive: true });
    await writeFile(
      cache,
      JSON.stringify({ current, checkedAt: Date.now(), latest: '0.1.0-beta.0' }),
    );
    expect(await dailyNotice()).toEqual([
      'A new version 0.1.0-beta.5 is available (current 0.1.0-beta.4); run trooly update.\n',
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(cache, 'utf8')).current).toBe(release.current);
  },
);

it('does not reuse a prerelease next target after switching to stable', async () => {
  tags = { latest: '0.1.0', next: '0.2.0-beta.1' };
  expect(await dailyNotice()).toHaveLength(1);
  release.current = '0.1.0';
  expect(await dailyNotice()).toEqual([]);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

describe('explicit channels', () => {
  it.each([
    ['0.1.0-beta.4', 'latest', '0.1.0', '0.2.0-beta.1', '0.1.0'],
    ['0.1.0', 'next', '0.1.0', '0.2.0-beta.1', '0.2.0-beta.1'],
    ['0.1.0-beta.4', 'next', '0.1.0', '0.1.0-beta.5', '0.1.0-beta.5'],
  ])('selects %s --channel %s', async (current, channel, latest, next, target) => {
    release.current = current;
    tags = { latest, next };
    const runner = vi.fn().mockResolvedValue({ code: 0, output: target });
    const write = vi.fn();
    await runUpdate({ channel, check: true }, { runner, write });
    expect(write).toHaveBeenCalledWith(`Available: ${target} (current ${current}).\n`);
    expect(runner).not.toHaveBeenCalled();
    await runUpdate({ channel, method: 'npm' }, { runner, write });
    expect(runner.mock.calls[0][1]).toEqual(['install', '-g', `trooly@${target}`]);
  });
  it.each([false, true])('does not downgrade with --channel latest, yes=%s', async (yes) => {
    const write = vi.fn(),
      runner = vi.fn();
    await runUpdate({ channel: 'latest', method: 'npm', yes }, { write, runner });
    expect(write.mock.calls[0][0]).toContain('Already up to date');
    expect(runner).not.toHaveBeenCalled();
  });
  it.each(['latest', 'next'])('does not fall back when explicit %s is missing', async (channel) => {
    delete tags[channel];
    await expect(runUpdate({ channel, check: true })).rejects.toThrow(`for channel ${channel}`);
  });
  it.each([
    { channel: 'beta' },
    { channel: '' },
    { channel: 'latest', version: '0.1.0' },
    { version: '' },
  ])('rejects invalid options before fetching: %j', async (options) => {
    const runner = vi.fn();
    await expect(runUpdate(options, { runner })).rejects.toMatchObject({ exitCode: 2 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
  });
  it.each(['npx', 'pnpm-dlx', 'project'] as const)(
    'prints the chosen exact target for %s',
    async (method) => {
      const write = vi.fn(),
        runner = vi.fn();
      await runUpdate({}, { installation: () => method, runner, write });
      expect(write.mock.calls[0][0]).toContain('0.1.0-beta.5');
      expect(write.mock.calls[0][0]).not.toContain('@latest');
      expect(runner).not.toHaveBeenCalled();
    },
  );
});

describe('explicit downgrade confirmation', () => {
  it('refuses a non-interactive downgrade without --yes before invoking the installer', async () => {
    setTTY(false);
    const runner = vi.fn();
    const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await expect(runUpdate({ version: '0.1.0-beta.0', method: 'npm' }, { runner })).rejects.toThrow(
      '--yes',
    );
    expect(warn).toHaveBeenCalledWith(
      'Warning: downgrading Trooly CLI from 0.1.0-beta.4 to 0.1.0-beta.0.\n',
    );
    expect(runner).not.toHaveBeenCalled();
    expect(prompt.question).not.toHaveBeenCalled();
  });
  it('warns before a non-interactive --yes downgrade and keeps JSON stdout clean', async () => {
    setTTY(false);
    const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const write = vi.fn();
    const runner = vi.fn(async () => {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('downgrading'));
      return { code: 0, output: '0.1.0-beta.0' };
    });
    await runUpdate(
      { version: '0.1.0-beta.0', method: 'npm', yes: true, json: true },
      { runner, write },
    );
    expect(runner).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenCalledTimes(1);
    expect(JSON.parse(write.mock.calls[0][0])).toMatchObject({
      current: release.current,
      target: '0.1.0-beta.0',
      installed: true,
    });
    expect(prompt.question).not.toHaveBeenCalled();
  });
  it.each(['n', '', 'yes'])(
    'interactive answer %j controls downgrade installation',
    async (answer) => {
      setTTY(true);
      prompt.question.mockResolvedValue(answer);
      const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const write = vi.fn();
      const runner = vi.fn(async () => {
        expect(warn).toHaveBeenCalled();
        expect(prompt.question).toHaveBeenCalled();
        return { code: 0, output: '0.1.0-beta.0' };
      });
      const result = runUpdate({ version: '0.1.0-beta.0', method: 'npm' }, { runner, write });
      if (answer === 'yes') {
        await result;
        expect(runner).toHaveBeenCalledTimes(2);
      } else {
        await expect(result).rejects.toThrow('Action cancelled');
        expect(runner).not.toHaveBeenCalled();
      }
      expect(prompt.question).toHaveBeenCalledWith(expect.stringContaining('[y/N]'));
      expect(prompt.close).toHaveBeenCalledTimes(1);
    },
  );
  it('reports an explicit downgrade in --check without installing or prompting', async () => {
    setTTY(false);
    const runner = vi.fn(),
      write = vi.fn();
    await runUpdate({ version: '0.1.0-beta.0', check: true }, { runner, write });
    expect(write.mock.calls[0][0]).toContain('Downgrade: 0.1.0-beta.4 -> 0.1.0-beta.0');
    expect(runner).not.toHaveBeenCalled();
    expect(prompt.question).not.toHaveBeenCalled();
  });
});

describe('update CLI options', () => {
  it.each([
    ['--yes', 'update', '--version', '0.1.0-beta.0'],
    ['update', '--version', '0.1.0-beta.0', '--yes'],
  ])('forwards confirmation with args %j', async (...args) => {
    const run = vi.spyOn(updateModule, 'runUpdate').mockResolvedValue();
    await createProgram().parseAsync(args, { from: 'user' });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ version: '0.1.0-beta.0', yes: true }),
    );
  });
  it('preserves global flags and last profile precedence across nested commands', async () => {
    const program = createProgram();
    const study = program.commands.find((command) => command.name() === 'study')!;
    const draft = study.commands.find((command) => command.name() === 'draft')!;
    const get = draft.commands.find((command) => command.name() === 'get')!;
    const action = vi.fn();
    get.action(action);
    await program.parseAsync(
      ['--profile', 'first', '--json', 'study', 'draft', 'get', '1', '--profile', 'last', '--yes'],
      { from: 'user' },
    );
    expect(action).toHaveBeenCalledOnce();
    expect(get.optsWithGlobals()).toMatchObject({ profile: 'last', json: true, yes: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('parses an exact downgrade target instead of displaying the root version', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await createProgram().parseAsync(['update', '--version', '0.1.0-beta.0', '--check', '--json'], {
      from: 'user',
    });
    expect(JSON.parse(String(write.mock.calls[0][0]))).toMatchObject({
      target: '0.1.0-beta.0',
      installed: false,
      message: expect.stringContaining('Downgrade:'),
    });
  });
  it.each([['--version'], ['-v'], ['auth', '--version'], ['update', '-v']])(
    'preserves version display for %j',
    async (...args) => {
      const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
      await expect(createProgram().parseAsync(args, { from: 'user' })).rejects.toMatchObject({
        code: 'commander.version',
        exitCode: 0,
      });
      expect(write).toHaveBeenCalledWith(`${release.current}\n`);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
  it('parses --channel and uses it for actual check output', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await createProgram().parseAsync(['update', '--channel', 'latest', '--check', '--json'], {
      from: 'user',
    });
    expect(JSON.parse(String(write.mock.calls[0][0]))).toMatchObject({
      target: '0.1.0-beta.0',
      installed: false,
      message: expect.stringContaining('Already up to date'),
    });
  });
  it('documents automatic selection, channel overrides, and downgrade confirmation in help', () => {
    const write = vi.fn();
    const program = createProgram();
    program.commands
      .find((command) => command.name() === 'update')!
      .configureOutput({ writeOut: write })
      .outputHelp();
    const help = write.mock.calls.map(([text]) => text).join('');
    expect(help).toContain('--channel <latest|next>');
    expect(help).toContain('prereleases use the higher of next/latest');
    expect(help).toContain('stable releases use latest only');
    expect(help).toContain('non-interactive terminals require --yes');
  });
});
