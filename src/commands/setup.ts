import type { Command } from 'commander';
import { CliError } from '../http/errors';
import { runSetup } from '../setup/run';

export function registerSetup(program: Command): void {
  program
    .command('setup')
    .description('Install the CLI and companion skill, then sign in')
    .option('--yes', 'Run setup without confirmation')
    .option('--skip-skill', 'Skip companion skill installation')
    .option('--skip-login', 'Skip OAuth login')
    .action(async (_options, command: Command) => {
      const result = await runSetup(command.optsWithGlobals());
      if (result.exit_code !== 0) {
        throw new CliError(
          'Some setup steps failed. See the setup summary.',
          result.exit_code,
          'SETUP_FAILED',
        );
      }
    });
}
