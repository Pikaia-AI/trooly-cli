import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, writeFile, mkdir, readFile, rm, symlink, chmod } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  classifyInstallation,
  detectInstallation,
  installationCommand,
} from '../src/update/install-info';
import { validVersion, compareVersions } from '../src/update/semver';
import {
  fetchTargetVersion,
  registryAddress,
  shouldCheckUpdate,
  startUpdateCheck,
  UPDATE_TTL,
} from '../src/update/check';
import { runUpdate, installFailure, executable, runProcess } from '../src/update/run';
import { getPaths } from '../src/config/paths';
import { spawn } from 'node:child_process';

const directories: string[] = [];
const servers: Server[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'trooly-update-'));
  directories.push(path);
  return path;
}
async function registry(handler?: (response: import('node:http').ServerResponse) => void) {
  let count = 0;
  const server = createServer((request, response) => {
    count++;
    expect(request.url).toBe('/trooly');
    if (handler) {
      handler(response);
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ 'dist-tags': { latest: '1.2.3' }, versions: { '1.2.3': {} } }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return { url: `http://127.0.0.1:${address.port}`, count: () => count };
}
async function waitFor(predicate: () => Promise<boolean>) {
  const limit = Date.now() + 3000;
  while (!(await predicate())) {
    if (Date.now() > limit) throw new Error('Timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('installation recognition', () => {
  const shapes: [string, string][] = [
    ['/cache/_npx/hash/node_modules/trooly/dist/index.js', 'npx'],
    ['/.pnpm/_pnpx/hash/trooly/dist/index.js', 'pnpm-dlx'],
    ['/cache/pnpm/dlx/hash/trooly/dist/index.js', 'pnpm-dlx'],
    ['/.volta/tools/image/packages/trooly/dist/index.js', 'volta'],
    ['/Volta/tools/image/packages/trooly/dist/index.js', 'volta'],
    ['/.pnpm/global/5/node_modules/trooly/dist/index.js', 'pnpm'],
    ['/.local/share/pnpm/global/5/node_modules/trooly/dist/index.js', 'pnpm'],
    ['/Library/pnpm/global/5/node_modules/trooly/dist/index.js', 'pnpm'],
    ['/AppData/Local/pnpm/global/5/node_modules/trooly/dist/index.js', 'pnpm'],
    ['/.config/yarn/global/node_modules/trooly/dist/index.js', 'yarn'],
    ['/Yarn/Data/global/node_modules/trooly/dist/index.js', 'yarn'],
    ['/.bun/install/global/node_modules/trooly/dist/index.js', 'bun'],
    ['/lib/node_modules/trooly/dist/index.js', 'npm'],
  ];
  for (const [name, prefix, slash] of [
    ['Linux', '/home/example', '/'],
    ['macOS', '/Users/example', '/'],
    ['Windows', 'C:/Users/example', '\\'],
  ]) {
    for (const [shape, expected] of shapes) {
      it(`${name}: ${shape} -> ${expected}`, () => {
        expect(classifyInstallation(`${prefix}${shape}`.replaceAll('/', slash), () => false)).toBe(
          expected,
        );
      });
    }
    it(`${name}: project manifest above node_modules`, () => {
      const path = `${prefix}/work/app/node_modules/trooly/dist/index.js`.replaceAll('/', slash);
      expect(
        classifyInstallation(path, (candidate) => candidate === `${prefix}/work/app/package.json`),
      ).toBe('project');
    });
  }
  it.each([
    '/usr/local/lib/node_modules/trooly/dist/index.js',
    '/home/example/.nvm/versions/node/v24.0.0/lib/node_modules/trooly/dist/index.js',
    '/home/example/.npm-global/lib/node_modules/trooly/dist/index.js',
    'C:\\Users\\example\\AppData\\Roaming\\npm\\node_modules\\trooly\\dist\\index.js',
  ])('keeps known global npm prefixes global despite ancestor manifests: %s', (path) => {
    expect(classifyInstallation(path, () => true)).toBe('npm');
  });
  it('ignores an unrelated ancestor manifest above a custom prefix', () => {
    expect(
      classifyInstallation(
        '/home/example/tools/node_modules/trooly/dist/index.js',
        (path) => path === '/home/example/package.json',
      ),
    ).toBe('npm');
  });
  it('resolves the executable symlink before classifying', async () => {
    const root = await directory();
    const path = join(root, '.bun/install/global/node_modules/trooly/dist/index.js');
    await mkdir(join(root, '.bun/install/global/node_modules/trooly/dist'), { recursive: true });
    await writeFile(path, '');
    const link = join(root, 'trooly');
    let entry = link;
    if (process.platform === 'win32') {
      // Junctions exercise realpath without requiring file-symlink privileges.
      await symlink(join(root, '.bun/install/global/node_modules/trooly'), link, 'junction');
      entry = join(link, 'dist/index.js');
    } else {
      await symlink(path, link);
    }
    expect(detectInstallation(entry)).toBe('bun');
  });
});

describe('semantic versions', () => {
  it.each(['0.1.0', '1.2.3-beta.2', '1.0.0+build.4', '10.20.30-rc.1+build'])(
    'accepts %s',
    (value) => expect(validVersion(value)).toBe(true),
  );
  it.each([
    'latest',
    'v1.2.3',
    '1.2',
    '01.2.3',
    '1.2.3-01',
    '1.2.3;whoami',
    '1.2.3\n',
    '--help',
    '1.2.3-',
  ])('rejects %s', (value) => expect(validVersion(value)).toBe(false));
  it('compares pre-releases, numeric identifiers, and build metadata correctly', () => {
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBe(1);
    expect(compareVersions('1.0.0-rc.10', '1.0.0-rc.2')).toBe(1);
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBe(-1);
    expect(compareVersions('1.0.0-beta', '1.0.0-beta.1')).toBe(-1);
    expect(compareVersions('1.0.0+one', '1.0.0+two')).toBe(0);
    expect(compareVersions('2.0.0', '10.0.0')).toBe(-1);
  });
});

describe('registry checks', () => {
  it('reads environment, npmrc, then public default in precedence order', async () => {
    const home = await directory();
    expect(await registryAddress({}, home)).toBe('https://registry.npmjs.org');
    await writeFile(join(home, '.npmrc'), '# comment\r\nregistry=http://127.0.0.1:3001/\r\n');
    expect(await registryAddress({}, home)).toBe('http://127.0.0.1:3001');
    expect(await registryAddress({ npm_config_registry: 'http://127.0.0.1:3002/' }, home)).toBe(
      'http://127.0.0.1:3002',
    );
  });
  it('fetches latest and verifies explicit releases against a local registry', async () => {
    const local = await registry();
    const options = { env: { npm_config_registry: local.url } };
    expect(await fetchTargetVersion(undefined, options)).toBe('1.2.3');
    expect(await fetchTargetVersion('1.2.3', options)).toBe('1.2.3');
    await expect(fetchTargetVersion('9.9.9', options)).rejects.toMatchObject({
      code: 'VERSION_NOT_FOUND',
    });
    await expect(fetchTargetVersion('bad version', options)).rejects.toMatchObject({ exitCode: 2 });
    expect(local.count()).toBe(3);
  });
  it('suppresses CI (including empty CI), nonterminal, explicit opt-out, and update invocations', () => {
    expect(shouldCheckUpdate({}, true, false)).toBe(true);
    expect(shouldCheckUpdate({ CI: '' }, true, false)).toBe(false);
    expect(shouldCheckUpdate({}, false, false)).toBe(false);
    expect(shouldCheckUpdate({ TROOLY_NO_UPDATE_CHECK: '1' }, true, false)).toBe(false);
    expect(shouldCheckUpdate({}, true, true)).toBe(false);
  });
  it('caches for 24h and notifies once per release per day', async () => {
    const root = await directory();
    vi.stubEnv('XDG_CACHE_HOME', root);
    vi.stubEnv('LOCALAPPDATA', root);
    const local = await registry();
    const lines: string[] = [];
    const env = { npm_config_registry: local.url };
    let now = Date.now();
    const first = startUpdateCheck({
      env,
      stderrTTY: true,
      now: () => now,
      write: (text) => lines.push(text),
    });
    await first.settled;
    await first.finish();
    expect(lines).toHaveLength(1);
    const second = startUpdateCheck({
      env,
      stderrTTY: true,
      now: () => now,
      write: (text) => lines.push(text),
    });
    await second.settled;
    await second.finish();
    expect(local.count()).toBe(1);
    expect(lines).toHaveLength(1);
    now += UPDATE_TTL + 1;
    const third = startUpdateCheck({
      env,
      stderrTTY: true,
      now: () => now,
      write: (text) => lines.push(text),
    });
    await third.settled;
    expect(local.count()).toBe(2);
    await third.finish();
    expect(lines).toHaveLength(2);
  });
  it('does not wait for a slow registry at command exit', async () => {
    const root = await directory();
    vi.stubEnv('XDG_CACHE_HOME', root);
    vi.stubEnv('LOCALAPPDATA', root);
    const local = await registry(() => {});
    const check = startUpdateCheck({ env: { npm_config_registry: local.url }, stderrTTY: true });
    await waitFor(async () => local.count() === 1);
    const begin = Date.now();
    await check.finish();
    expect(Date.now() - begin).toBeLessThan(250);
  });
  it('shares the daily query and notification between real concurrent processes', async () => {
    const root = await directory();
    const local = await registry();
    const script = `
      const { startUpdateCheck } = await import('./src/update/check.ts');
      const check = startUpdateCheck({
        env: { npm_config_registry: process.env.TEST_REGISTRY },
        stderrTTY: true,
        write: text => process.stdout.write(text),
      });
      await check.settled;
      await check.finish();
    `;
    const child = () =>
      new Promise<string>((resolve, reject) => {
        const processChild = spawn(
          process.execPath,
          ['--import', 'tsx', '--input-type=module', '-e', script],
          {
            env: {
              ...process.env,
              XDG_CACHE_HOME: root,
              LOCALAPPDATA: root,
              TEST_REGISTRY: local.url,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        let stdout = '',
          stderr = '';
        processChild.stdout.on('data', (chunk) => {
          stdout += chunk.toString();
        });
        processChild.stderr.on('data', (chunk) => {
          stderr += chunk.toString();
        });
        processChild.on('error', reject);
        processChild.on('close', (code) =>
          code === 0 ? resolve(stdout) : reject(new Error(stderr)),
        );
      });
    const outputs = await Promise.all([child(), child()]);
    expect(local.count()).toBe(1);
    expect(outputs.join('').split('\n').filter(Boolean)).toHaveLength(1);
  });
  it('rechecks the notice marker when two already-ready commands finish together', async () => {
    const root = await directory();
    vi.stubEnv('XDG_CACHE_HOME', root);
    vi.stubEnv('LOCALAPPDATA', root);
    const cache = join(getPaths().cacheDir, 'update-check.json');
    await mkdir(getPaths().cacheDir, { recursive: true });
    await writeFile(cache, JSON.stringify({ checkedAt: Date.now(), latest: '1.2.3' }));
    const notices: string[] = [];
    const options = {
      env: {},
      stderrTTY: true,
      write: (text: string) => {
        notices.push(text);
      },
    };
    const first = startUpdateCheck(options);
    await first.settled;
    const second = startUpdateCheck(options);
    await second.settled;
    await Promise.all([first.finish(), second.finish()]);
    expect(notices).toHaveLength(1);
    expect(JSON.parse(await readFile(cache, 'utf8')).notifiedVersion).toBe('1.2.3');
  });
  it('skips advisory work immediately while another process owns the lock', async () => {
    const root = await directory();
    vi.stubEnv('XDG_CACHE_HOME', root);
    vi.stubEnv('LOCALAPPDATA', root);
    const local = await registry();
    await mkdir(join(getPaths().cacheDir, 'update-check.json.lock'), { recursive: true });
    const check = startUpdateCheck({ env: { npm_config_registry: local.url }, stderrTTY: true });
    await check.settled;
    const started = Date.now();
    await check.finish();
    expect(Date.now() - started).toBeLessThan(250);
    expect(local.count()).toBe(0);
  });
});

describe('explicit installation', () => {
  it.each([
    ['npm', ['install', '-g', 'trooly@1.2.3']],
    ['pnpm', ['add', '-g', 'trooly@1.2.3']],
    ['yarn', ['global', 'add', 'trooly@1.2.3']],
    ['bun', ['add', '-g', 'trooly@1.2.3']],
    ['volta', ['install', 'trooly@1.2.3']],
  ] as const)(
    'uses the fixed %s command and verifies the updated version',
    async (method, args) => {
      const runner = vi
        .fn()
        .mockResolvedValueOnce({ code: 0, output: 'done' })
        .mockResolvedValueOnce({ code: 0, output: '1.2.3\n' })
        .mockResolvedValueOnce({ code: 0, output: 'skill installed' });
      const write = vi.fn();
      await runUpdate(
        { method },
        { runner, targetVersion: async () => '1.2.3', entry: '/nonexistent/trooly.js', write },
      );
      expect(runner.mock.calls[0]).toEqual([method, args, { stdoutToStderr: false }]);
      expect(runner.mock.calls[1]).toEqual(['trooly', ['version'], { stdoutToStderr: false }]);
      expect(runner.mock.calls[2]).toEqual([
        'trooly',
        ['setup', '--yes', '--skip-login'],
        { stdoutToStderr: true },
      ]);
      expect(runner).toHaveBeenCalledTimes(3);
      expect(write).toHaveBeenCalledWith('Updated to 1.2.3.\n');
    },
  );
  it.each(['npx', 'pnpm-dlx', 'project'] as const)(
    'does not globally modify %s installations',
    async (installation) => {
      const runner = vi.fn();
      await runUpdate(
        {},
        {
          runner,
          targetVersion: async () => '1.2.3',
          installation: () => installation,
          write: () => {},
        },
      );
      expect(runner).not.toHaveBeenCalled();
    },
  );
  it('check mode only reports JSON without installation', async () => {
    const runner = vi.fn(),
      write = vi.fn();
    await runUpdate(
      { check: true, json: true },
      { runner, targetVersion: async () => '1.2.3', write },
    );
    expect(runner).not.toHaveBeenCalled();
    expect(JSON.parse(write.mock.calls[0][0])).toMatchObject({ target: '1.2.3', installed: false });
  });
  it('rejects an unsafe version and invalid manager before fetching or executing', async () => {
    const runner = vi.fn(),
      targetVersion = vi.fn();
    await expect(
      runUpdate({ version: '1.2.3;echo' }, { runner, targetVersion }),
    ).rejects.toMatchObject({ exitCode: 2 });
    await expect(
      runUpdate({ method: 'anything' }, { runner, targetVersion }),
    ).rejects.toMatchObject({ exitCode: 2 });
    expect(runner).not.toHaveBeenCalled();
    expect(targetVersion).not.toHaveBeenCalled();
  });
  it('reports EACCES and manual command on installation failure', async () => {
    await expect(
      runUpdate(
        { method: 'npm' },
        { targetVersion: async () => '1.2.3', runner: async () => ({ code: 1, output: 'EACCES' }) },
      ),
    ).rejects.toThrow(/nvm.*prefix.*sudo.*npm install -g trooly@1.2.3/);
  });
  it('does not claim success when new CLI version mismatches', async () => {
    await expect(
      runUpdate(
        { method: 'npm' },
        { targetVersion: async () => '1.2.3', runner: async () => ({ code: 0, output: '0.1.0' }) },
      ),
    ).rejects.toMatchObject({ code: 'UPDATE_UNVERIFIED' });
  });
  it.each(['exit', 'spawn'])(
    'keeps the upgrade successful when skill installation fails by %s',
    async (failure) => {
      const runner = vi
        .fn()
        .mockResolvedValueOnce({ code: 0, output: 'installed' })
        .mockResolvedValueOnce({ code: 0, output: '1.2.3\n' });
      if (failure === 'exit') runner.mockResolvedValueOnce({ code: 1, output: 'offline' });
      else runner.mockRejectedValueOnce(new Error('spawn failed'));
      const write = vi.fn();
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      await expect(
        runUpdate(
          { method: 'npm', json: true },
          { runner, targetVersion: async () => '1.2.3', write },
        ),
      ).resolves.toBeUndefined();
      expect(runner.mock.calls[2]).toEqual([
        'trooly',
        ['setup', '--yes', '--skip-login'],
        { stdoutToStderr: true },
      ]);
      expect(write).toHaveBeenCalledTimes(1);
      expect(JSON.parse(write.mock.calls[0][0])).toMatchObject({
        installed: true,
        target: '1.2.3',
      });
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining('trooly setup --yes --skip-login'),
      );
    },
  );
  it('runs an actual child process without a shell', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const result = await runProcess(process.execPath, [
      '-e',
      'process.stdout.write("sample-output")',
    ]);
    expect(result).toEqual({ code: 0, output: 'sample-output' });
    expect(stdout).toHaveBeenCalled();
  });
  it('keeps JSON stdout clean while real installer and verification output reach stderr', async () => {
    const stdout: string[] = [],
      stderr: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    await runUpdate(
      { method: 'npm', json: true },
      {
        targetVersion: async () => '1.2.3',
        runner: (command, _args, options) =>
          runProcess(
            process.execPath,
            [
              '-e',
              command === 'trooly'
                ? 'process.stdout.write("1.2.3\\n")'
                : 'process.stdout.write("installed\\n"); process.stderr.write("notice\\n")',
            ],
            options,
          ),
      },
    );
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0])).toMatchObject({ target: '1.2.3', installed: true });
    expect(stderr.join('')).toContain('installed');
    expect(stderr.join('')).toContain('notice');
    expect(stderr.join('')).toContain('1.2.3');
  });
  it('verifies the new PATH command instead of the old version-specific entry', async () => {
    const root = await directory();
    const bin = join(root, 'bin');
    await mkdir(bin);
    const oldEntry = join(root, 'old-entry.js');
    await writeFile(oldEntry, 'process.stdout.write("0.1.0\\n")');
    vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH ?? ''}`);
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runUpdate(
      { method: 'npm' },
      {
        targetVersion: async () => '1.2.3',
        entry: oldEntry,
        runner: async (command, args, options) => {
          if (command === 'npm') {
            if (process.platform === 'win32') {
              const parent = join(bin, 'node_modules/trooly/dist');
              await mkdir(parent, { recursive: true });
              await writeFile(join(parent, 'index.js'), 'process.stdout.write("1.2.3\\n")');
              await writeFile(
                join(bin, 'trooly.cmd'),
                '@node "%~dp0\\node_modules\\trooly\\dist\\index.js" %*',
              );
            } else {
              const commandFile = join(bin, 'trooly');
              await writeFile(commandFile, '#!/usr/bin/env node\nprocess.stdout.write("1.2.3\\n")');
              await chmod(commandFile, 0o755);
            }
            return { code: 0, output: '' };
          }
          return runProcess(command, args, options);
        },
      },
    );
    expect(output).toHaveBeenCalledWith('Updated to 1.2.3.\n');
  });
  it.each(['PATH', 'Path', 'path'])(
    'resolves a Windows JS package manager via %s without a command shell',
    async (key) => {
      const path = join(await directory(), 'bin with spaces');
      const script = join(path, 'node_modules/npm/bin/npm-cli.js');
      await mkdir(join(path, 'node_modules/npm/bin'), { recursive: true });
      await writeFile(script, '');
      expect(
        executable('npm', ['install', '-g', 'trooly@1.2.3'], 'win32', { [key]: path }),
      ).toEqual({
        command: process.execPath,
        args: [script, 'install', '-g', 'trooly@1.2.3'],
      });
    },
  );
  it('resolves a pnpm Windows trooly shim through its quoted relative script', async () => {
    const bin = await directory();
    const parent = join(bin, '.pnpm/trooly@1.2.3/node_modules/trooly/dist');
    await mkdir(parent, { recursive: true });
    const script = join(parent, 'index.js');
    await writeFile(script, '');
    await writeFile(
      join(bin, 'trooly.cmd'),
      '@node "%dp0%\\.pnpm\\trooly@1.2.3\\node_modules\\trooly\\dist\\index.js" %*',
    );
    expect(executable('trooly', ['version'], 'win32', { PATH: bin })).toEqual({
      command: process.execPath,
      args: [script, 'version'],
    });
  });
  it.each(['PATH', 'Path', 'path'])(
    'resolves Windows npx through npm JavaScript via %s without a shell',
    async (key) => {
      const bin = join(await directory(), 'bin with spaces');
      const script = join(bin, 'node_modules/npm/bin/npx-cli.js');
      await mkdir(join(bin, 'node_modules/npm/bin'), { recursive: true });
      await writeFile(script, '');
      const args = ['-y', 'skills', 'add', 'C:\\my skills\\trooly', '-g', '-y'];
      expect(executable('npx', args, 'win32', { [key]: bin })).toEqual({
        command: process.execPath,
        args: [script, ...args],
      });
    },
  );
});
