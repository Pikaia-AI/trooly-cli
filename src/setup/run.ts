import { createInterface } from 'node:readline/promises';
import { login } from '../commands/auth';
import { CliError, usageError } from '../http/errors';
import { redact } from '../output/json';
import { CLI_VERSION } from '../version';
import { detectInstallation, installationCommand } from '../update/install-info';
import { installFailure, runProcess, type Runner } from '../update/process';
import { installSkill, manualCommand, type StepResult } from './skill';

export interface SetupOptions {
  yes?: boolean;
  skipSkill?: boolean;
  skipLogin?: boolean;
  json?: boolean;
  profile?: string;
}

export interface SetupResult {
  version: string;
  steps: { cli: StepResult; skill: StepResult; login: StepResult };
  exit_code: number;
}

async function confirmSetup(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    usageError('Run trooly setup --yes in a non-interactive terminal.');
  }
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await prompt.question('Run the requested Trooly setup steps? [y/N] ');
    if (!/^y(es)?$/i.test(answer.trim())) usageError('Setup cancelled.');
  } finally {
    prompt.close();
  }
}

export async function runSetup(
  options: SetupOptions,
  dependencies: {
    runner?: Runner;
    installation?: typeof detectInstallation;
    entry?: string;
    login?: typeof login;
    write?: (text: string) => void;
    warn?: (text: string) => void;
    confirm?: () => Promise<void>;
  } = {},
): Promise<SetupResult> {
  if (!options.yes) await (dependencies.confirm ?? confirmSetup)();
  const runner = dependencies.runner ?? runProcess;
  const write = dependencies.write ?? ((text) => process.stdout.write(text));
  const warn = dependencies.warn ?? ((text) => process.stderr.write(text));
  const summary: SetupResult = {
    version: CLI_VERSION,
    steps: {
      cli: {
        status: 'skipped',
        message: 'The current installation does not need a global install.',
      },
      skill: { status: 'skipped', message: 'Skipped with --skip-skill.' },
      login: { status: 'skipped', message: 'Skipped with --skip-login.' },
    },
    exit_code: 0,
  };
  const method = (dependencies.installation ?? detectInstallation)(dependencies.entry);
  if (method === 'npx' || method === 'pnpm-dlx') {
    const command = installationCommand('npm', CLI_VERSION);
    const manual = manualCommand(command.command, command.args);
    try {
      const result = await runner(command.command, command.args, {
        stdoutToStderr: Boolean(options.json),
      });
      if (result.code !== 0) throw installFailure(result.output, manual);
      summary.steps.cli = {
        status: 'success',
        message: `Installed trooly@${CLI_VERSION} globally.`,
      };
    } catch (error) {
      const failure =
        error instanceof CliError && error.code === 'UPDATE_FAILED'
          ? error
          : installFailure(error instanceof Error ? error.message : String(error), manual);
      summary.steps.cli = { status: 'failed', message: failure.message, manual_command: manual };
      summary.exit_code = 1;
      warn(`${redact(failure.message)}\n`);
    }
  }
  if (!options.skipSkill) {
    summary.steps.skill = await installSkill(CLI_VERSION, { runner, json: options.json, warn });
    if (summary.steps.skill.status === 'failed') summary.exit_code = 1;
  }
  if (!options.skipLogin) {
    const manual = manualCommand('trooly', [
      'login',
      ...(options.profile ? ['--profile', options.profile] : []),
    ]);
    try {
      await (dependencies.login ?? login)({ profile: options.profile });
      summary.steps.login = { status: 'success', message: 'Signed in to Trooly.' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      summary.steps.login = { status: 'failed', message, manual_command: manual };
      summary.exit_code = error instanceof CliError ? error.exitCode : 1;
      warn(`${redact(message)} Manual command: ${manual}\n`);
    }
  }
  write(
    options.json
      ? `${JSON.stringify(redact(summary))}\n`
      : `Trooly setup ${summary.exit_code === 0 ? 'complete' : 'finished with failures'}.\n${Object.entries(
          summary.steps,
        )
          .map(([name, result]) => `${name}: ${result.status} — ${redact(result.message)}`)
          .join('\n')}\n`,
  );
  return summary;
}
