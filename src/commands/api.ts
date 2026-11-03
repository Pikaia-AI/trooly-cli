import { Command } from 'commander';
import { context, collect, pairs, readBody, confirmAction } from './shared';
import {
  loadOpenApi,
  listOperations,
  findOperation,
  matchOperation,
  expandReferences,
  describeOperation,
  nearestPaths,
  docsUrl,
} from '../http/openapi';
import { CliError, usageError } from '../http/errors';
import { emit } from '../output/render';
import { resolveProfile, DEFAULT_API_BASE } from '../config/profiles';
export const HELP_FOOTER =
  `\nAPI documentation: ${DEFAULT_API_BASE}/docs\n` +
  'Discover endpoints: trooly api list\n' +
  'Assistant instructions: trooly guide\n';
export function registerApi(program: Command): void {
  const api = program
    .command('api')
    .description('Call or discover any public API operation')
    .argument('[method]', 'HTTP method')
    .argument('[path]', 'Gateway-relative path')
    .option('-q, --query <key=value>', 'Query parameter', collect, [])
    .option('-f, --field <key=value>', 'JSON string field', collect, [])
    .option('--input <file|->', 'JSON request body')
    .option('-H, --header <name:value>', 'Extra HTTP header', collect, [])
    .option('--paginate', 'Merge all cursor pages')
    .option('-o, --output <file>', 'Write response bytes to a file')
    .addHelpText('after', HELP_FOOTER)
    .action(
      async (method: string | undefined, path: string | undefined, _options, cmd: Command) => {
        if (!method || !path) {
          usageError('Specify METHOD and path, or use trooly api list / describe.');
        }
        const opts = cmd.optsWithGlobals();
        if (method.toUpperCase() === 'DELETE' || /\/(terminate|launch)\/?(?:\?|$)/.test(path)) {
          await confirmAction(opts.yes);
        }
        const { client, json, apiBase } = await context(cmd);
        const options = {
          query: pairs(opts.query),
          body: await readBody(opts.input, opts.field),
          headers: pairs(opts.header, ':'),
          output: opts.output as string | undefined,
        };
        try {
          const value = opts.paginate
            ? await client.paginate(method, path, options)
            : (await client.request(method, path, options)).data;
          if (!opts.output) emit(value, json);
        } catch (error) {
          if (
            error instanceof CliError &&
            [
              'HTTP_400',
              'HTTP_403',
              'HTTP_404',
              'INVALID_ARGUMENT',
              'BAD_REQUEST',
              'NOT_FOUND',
              'FORBIDDEN',
              'PERMISSION_DENIED',
            ].includes(error.code)
          ) {
            try {
              const document = await loadOpenApi(apiBase);
              const op = matchOperation(document, method, path);
              if (!op) {
                error.message += ` Similar paths: ${nearestPaths(document, path).join(', ')}. Use trooly api list --search <keyword>.`;
              } else {
                const operationHint = ` See trooly api describe ${op.operationId}; ${docsUrl(apiBase, op)}.`;
                const permissionHint =
                  error.exitCode === 4
                    ? ` Required permission: ${op.operation['x-required-permission'] ?? '(not specified)'}.`
                    : '';
                error.message += operationHint + permissionHint;
              }
            } catch {
              /* Keep the original request error if discovery is unavailable. */
            }
          }
          throw error;
        }
      },
    );
  api
    .command('list')
    .description('List operations without logging in')
    .option('--tag <tag>', 'Filter by tag')
    .option('--search <keyword>', 'Search paths, identifiers and summaries')
    .option('--refresh', 'Refresh the cached contract')
    .action(async (_options, cmd: Command) => {
      const opts = cmd.optsWithGlobals();
      const profile = await resolveProfile(opts.profile);
      const document = await loadOpenApi(profile.apiBase, opts.refresh);
      emit(
        listOperations(document, opts.tag, opts.search).map(
          ({ method, path, operationId, summary }) => ({ method, path, operationId, summary }),
        ),
        Boolean(opts.json),
      );
    });
  api
    .command('describe')
    .description('Describe an operation by operationId or METHOD path')
    .argument('<operationId|method>')
    .argument('[path]')
    .option('--refresh', 'Refresh the cached contract')
    .action(async (id: string, path: string | undefined, _options, cmd: Command) => {
      const opts = cmd.optsWithGlobals();
      const profile = await resolveProfile(opts.profile);
      const document = await loadOpenApi(profile.apiBase, opts.refresh);
      const op = findOperation(document, id, path);
      if (!op) {
        usageError(
          `Operation not found. Use trooly api list --search ${JSON.stringify(path ?? id)}. ` +
            `Similar paths: ${nearestPaths(document, path ?? id).join(', ')}`,
        );
      }
      if (opts.json) emit(expandReferences(op.operation, document), true);
      else {
        process.stdout.write(describeOperation(op, document, profile.apiBase) + '\n');
      }
    });
}
