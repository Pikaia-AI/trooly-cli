import type { Command } from 'commander';
import { runUpdate } from '../update/run';
export function registerUpdate(program: Command): void {
  program
    .command('update')
    .description('Check for or install a Trooly CLI release')
    .option(
      '--version <version>',
      'Install an exact semantic version; downgrades require confirmation',
    )
    .option(
      '--channel <latest|next>',
      'Select a release channel for this update (never downgrades)',
    )
    .option('--yes', 'Confirm an explicit --version downgrade')
    .option('--method <manager>', 'Use npm, pnpm, yarn, bun, or volta')
    .option('--check', 'Report the target release without installing')
    .addHelpText(
      'after',
      '\nBy default, prereleases use the higher of next/latest; stable releases use latest only.\n' +
        '--channel selects only that tag for this invocation; future checks follow the installed version.\n' +
        'Targets at or below the current version are skipped. Only --version permits a downgrade;\n' +
        'it warns and asks for confirmation (non-interactive terminals require --yes).\n' +
        '--version and --channel cannot be combined. --check never installs or prompts.',
    )
    .action(async (options, command: Command) =>
      runUpdate({
        ...options,
        json: Boolean(command.optsWithGlobals().json),
        yes: Boolean(command.optsWithGlobals().yes),
      }),
    );
}
