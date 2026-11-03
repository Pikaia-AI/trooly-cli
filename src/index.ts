import { Command, CommanderError } from 'commander';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { CLI_VERSION } from './version';
import { registerAuth } from './commands/auth';
import { registerProfile } from './commands/profile';
import { registerApi, HELP_FOOTER } from './commands/api';
import { registerDocs } from './commands/docs';
import { registerBusiness } from './commands/business';
import { registerGuide } from './commands/guide';
import { registerUpdate } from './commands/update';
import { startUpdateCheck } from './update/check';
import { emit, emitError } from './output/render';
import { CliError } from './http/errors';

export function createProgram(): Command {
  const program = new Command()
    .name('trooly')
    .description('Work with the Trooly API from your terminal')
    .version(CLI_VERSION, '-v, --version')
    .option('--profile <name>', 'Use a named profile')
    .option('--json', 'Print machine-readable JSON')
    .option('--yes', 'Confirm a destructive action')
    .addHelpText('after', HELP_FOOTER)
    .exitOverride();
  // Commander sends implicit group help to writeErr; keep it visible on stdout.
  // Only suppress its error lines, which main renders in our standard format.
  program.configureOutput({
    writeErr: (text) => process.stdout.write(text),
    outputError: () => {},
  });
  program.on('beforeAllHelp', ({ command, error }: { command: Command; error: boolean }) => {
    // Unknown help targets also raise commander.help, but remain usage errors.
    if (error && command.args[0] === 'help' && command.args[1]) {
      throw new CliError(`unknown command '${command.args[1]}'`, 2, 'USAGE_ERROR');
    }
  });
  registerAuth(program);
  registerProfile(program);
  registerApi(program);
  registerDocs(program);
  registerBusiness(program);
  registerGuide(program);
  registerUpdate(program);
  program
    .command('version')
    .description('Print the installed version')
    .action((_opts, cmd: Command) => {
      if (cmd.optsWithGlobals().json) emit({ version: CLI_VERSION }, true);
      else {
        process.stdout.write(CLI_VERSION + '\n');
      }
    });
  return program;
}
export async function main(argv = process.argv): Promise<number> {
  const program = createProgram();
  const update = startUpdateCheck({ isUpdate: argv.slice(2).includes('update') });
  try {
    await program.parseAsync(argv);
    return 0;
  } catch (error) {
    if (
      error instanceof CommanderError &&
      (error.exitCode === 0 || error.code === 'commander.help')
    ) {
      return 0;
    }
    const normalized =
      error instanceof CommanderError
        ? new CliError(error.message.replace(/^error: /, ''), 2, 'USAGE_ERROR')
        : error;
    return emitError(normalized, argv.includes('--json'));
  } finally {
    await update.finish();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main();
}
