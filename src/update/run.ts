import { CliError } from '../http/errors';
import { CLI_VERSION } from '../version';
import { detectInstallation, installationCommand, type InstallMethod } from './install-info';
import { fetchTargetVersion } from './check';
import { requireVersion } from './semver';

import { runProcess, installFailure, type Runner, type RunResult } from './process';
export { executable, runProcess, installFailure, type Runner, type RunResult } from './process';

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
  // Run the shared setup step in the verified new CLI. In versioned installs
  // (for example Volta), this process still belongs to the old package, whose
  // bundled fallback skill must never be installed for the new release.
  const skillArgs = ['setup', '--yes', '--skip-login'];
  const manualSkill = 'trooly setup --yes --skip-login';
  try {
    const skill = await runner('trooly', skillArgs, { stdoutToStderr: true });
    if (skill.code !== 0) throw new Error('Skill installation failed.');
  } catch {
    process.stderr.write(
      `CLI updated, but skill installation failed. Manual command: ${manualSkill}\n`,
    );
  }
  report(`Updated to ${target}.`, true);
}
