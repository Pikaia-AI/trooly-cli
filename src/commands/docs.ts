import { Command } from 'commander';
import { resolveProfile } from '../config/profiles';
import { loadOpenApi, findOperation, docsUrl } from '../http/openapi';
import { usageError } from '../http/errors';
import { openBrowser } from '../auth/browser';
import { emit } from '../output/render';
export function registerDocs(program: Command): void {
  program
    .command('docs')
    .description('Open API documentation (print a link in non-interactive use)')
    .argument('[operationId]')
    .option('--refresh', 'Refresh the cached contract')
    .action(async (id: string | undefined, _options, cmd: Command) => {
      const opts = cmd.optsWithGlobals();
      const profile = await resolveProfile(opts.profile);
      const op = id
        ? findOperation(await loadOpenApi(profile.apiBase, opts.refresh), id)
        : undefined;
      if (id && !op) usageError('Operation not found. Use trooly api list.');
      const url = docsUrl(profile.apiBase, op);
      if (opts.json) emit({ url }, true);
      else {
        process.stdout.write(url + '\n');
      }
      if (!opts.json && process.stdin.isTTY && process.stdout.isTTY) openBrowser(url);
    });
}
