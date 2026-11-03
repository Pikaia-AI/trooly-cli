import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CliError } from '../http/errors';
import { CLI_VERSION } from '../version';
import { detectInstallation, installationCommand, type InstallMethod } from './install-info';
import { fetchTargetVersion } from './check';
import { requireVersion } from './semver';

export interface RunResult {
  code: number;
  output: string;
}
export type Runner = (
  command: string,
  args: string[],
  options?: { stdoutToStderr?: boolean },
) => Promise<RunResult>;

// Windows .cmd files require a shell. Resolve package-manager JS launchers
// instead, so no registry value or version ever enters a shell command string.
export function executable(
  command: string,
  args: string[],
  platform = process.platform,
  env = process.env,
): { command: string; args: string[] } {
  if (platform !== 'win32' || !['npm', 'pnpm', 'yarn', 'trooly'].includes(command)) {
    return { command, args };
  }
  const candidates: Record<string, string[]> = {
    npm: ['node_modules/npm/bin/npm-cli.js'],
    pnpm: ['node_modules/pnpm/bin/pnpm.cjs', 'node_modules/pnpm/bin/pnpm.js'],
    yarn: ['node_modules/yarn/bin/yarn.js'],
    trooly: ['node_modules/trooly/dist/index.js'],
  };
  for (const directory of (env.PATH ?? '').split(';')) {
    if (!directory) continue;
    const exe = join(directory, `${command}.exe`);
    if (existsSync(exe)) return { command: exe, args };
    // Resolve only an existing command at this PATH position; do not skip an
    // earlier shim in favor of an unrelated package installed beside it.
    const shim = join(directory, `${command}.cmd`);
    for (const relative of candidates[command]) {
      const script = join(directory, relative);
      if (existsSync(script) && (command !== 'trooly' || existsSync(shim))) {
        return { command: process.execPath, args: [script, ...args] };
      }
    }
    if (command === 'trooly' && existsSync(shim)) {
      // npm and pnpm shims quote a path relative to their own directory. Read
      // that literal path without evaluating any batch syntax or variables.
      const source = readFileSync(shim, 'utf8');
      const match = /"%(?:~dp0|dp0%)[\\/]?([^"\r\n%]*[\\/]trooly[\\/]dist[\\/]index\.js)"/i.exec(
        source,
      );
      if (match) {
        const script = resolve(directory, match[1].replaceAll('\\', '/'));
        if (existsSync(script)) return { command: process.execPath, args: [script, ...args] };
      }
      throw new CliError(
        'The trooly command on PATH uses an unsupported Windows launcher.',
        1,
        'UPDATE_UNVERIFIED',
      );
    }
    // Corepack shims use a sibling distribution entry.
    const corepack = join(directory, 'node_modules', 'corepack', 'dist', `${command}.js`);
    if (existsSync(corepack)) return { command: process.execPath, args: [corepack, ...args] };
  }
  throw new CliError(
    `Cannot resolve a shell-free ${command} launcher. Run the printed installation command manually.`,
    1,
    'INSTALLER_NOT_FOUND',
  );
}
export const runProcess: Runner = async (command, args, options = {}) => {
  const target = executable(command, args);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(target.command, target.args, {
      shell: false,
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    let output = '';
    const record = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-65536);
    };
    child.stdout.on('data', (chunk) => {
      record(chunk);
      (options.stdoutToStderr ? process.stderr : process.stdout).write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      record(chunk);
      process.stderr.write(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code: code ?? 1, output }));
  });
};
export function installFailure(output: string, manual: string): CliError {
  const permission = output.includes('EACCES')
    ? 'Global directory is not writable. Use a Node version manager such as nvm, or set npm prefix to a user-owned directory; sudo is not recommended. '
    : '';
  return new CliError(
    `${permission}Installation failed. Manual command: ${manual}`,
    1,
    'UPDATE_FAILED',
  );
}
export async function runUpdate(
  options: { version?: string; method?: string; check?: boolean; json?: boolean },
  dependencies: {
    runner?: Runner;
    targetVersion?: typeof fetchTargetVersion;
    installation?: typeof detectInstallation;
    entry?: string;
    write?: (text: string) => void;
  } = {},
): Promise<void> {
  if (options.version) requireVersion(options.version);
  if (options.method && !['npm', 'pnpm', 'yarn', 'bun', 'volta'].includes(options.method)) {
    throw new CliError('Method must be npm, pnpm, yarn, bun, or volta.', 2, 'INVALID_METHOD');
  }
  const write = dependencies.write ?? ((text) => process.stdout.write(text));
  const target = requireVersion(
    await (dependencies.targetVersion ?? fetchTargetVersion)(options.version),
  );
  const report = (message: string, installed = false) =>
    write(
      options.json
        ? `${JSON.stringify({ current: CLI_VERSION, target, installed, message })}\n`
        : `${message}\n`,
    );
  if (options.check) {
    report(
      target === CLI_VERSION
        ? `Already at ${target}.`
        : `Available: ${target} (current ${CLI_VERSION}).`,
    );
    return;
  }
  if (target === CLI_VERSION) {
    report(`Already at ${target}.`);
    return;
  }
  const method =
    (options.method as InstallMethod | undefined) ??
    (dependencies.installation ?? detectInstallation)(dependencies.entry);
  if (method === 'npx' || method === 'pnpm-dlx') {
    report(
      'This is a temporary run. Start a fresh run with trooly@latest; no global update is needed.',
    );
    return;
  }
  if (method === 'project') {
    report('Trooly is a project dependency. Update its version in the project package.json.');
    return;
  }
  const command = installationCommand(method, target);
  const manual = [command.command, ...command.args].join(' ');
  const runner = dependencies.runner ?? runProcess;
  let result: RunResult;
  const outputOptions = { stdoutToStderr: Boolean(options.json) };
  try {
    result = await runner(command.command, command.args, outputOptions);
  } catch (error) {
    throw installFailure(
      error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      manual,
    );
  }
  if (result.code !== 0) throw installFailure(result.output, manual);
  // Resolve the newly installed command through PATH. The original realpath
  // can point at a previous Volta version or a different package manager.
  let verification: RunResult;
  try {
    verification = await runner('trooly', ['version'], outputOptions);
  } catch {
    throw new CliError(
      'Installation completed, but trooly could not be launched from PATH to verify its version.',
      1,
      'UPDATE_UNVERIFIED',
    );
  }
  if (verification.code !== 0 || !verification.output.split(/\s+/).includes(target)) {
    throw new CliError(
      'Installation completed, but the new trooly version could not be verified.',
      1,
      'UPDATE_UNVERIFIED',
    );
  }
  report(`Updated to ${target}.`, true);
}
