import type { Command } from 'commander';
import { runUpdate } from '../update/run';
export function registerUpdate(program: Command): void {
  program
    .command('update')
    .description('Check for or install a Trooly CLI release')
    .option('--version <version>', 'Install an exact semantic version')
    .option('--method <manager>', 'Use npm, pnpm, yarn, bun, or volta')
    .option('--check', 'Report the target release without installing')
    .action(async (options, command: Command) =>
      runUpdate({ ...options, json: Boolean(command.optsWithGlobals().json) }),
    );
}
