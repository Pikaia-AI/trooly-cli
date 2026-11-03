import type { Command } from 'commander';
import type { paths } from '../generated/api';
import { context, readBody, confirmAction, positiveInteger } from './shared';
export { positiveInteger } from './shared';
import { emit } from '../output/render';
import { CliError, usageError } from '../http/errors';
import { registerProject } from './project';
import { registerInterview } from './interview';
import { registerStudy } from './study';
import { registerKb } from './kb';
import { registerDoc } from './doc';
import { registerKnowledge } from './knowledge';
import { registerWebhook } from './webhook';
import { registerUsage } from './usage';

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
type PathFor<M extends Method> = {
  [P in keyof paths]: Exclude<paths[P][M], undefined> extends never ? never : P;
}[keyof paths];
export type QueryFlag = { flag: string; key: string; required?: boolean };
interface EndpointOptions {
  list?: boolean;
  arrayKey?: string;
  body?: 'required' | 'optional';
  destructive?: boolean;
  output?: boolean;
  query?: QueryFlag[];
}

export function fillPath(template: string, values: string[]): string {
  let index = 0;
  return template.replace(/\{[^}]+\}/g, () => {
    const value = values[index++];
    if (!value || value === '.' || value === '..') usageError('Invalid resource identifier.');
    return encodeURIComponent(value);
  });
}

/** Handwritten routes checked against the generated public API contract. */
export function endpoint<M extends Method>(
  group: Command,
  name: string,
  method: M,
  path: PathFor<M>,
  options: EndpointOptions = {},
): Command {
  const command = group.command(name).description(`${method.toUpperCase()} ${path}`);
  if (options.list) {
    command
      .option('--limit <number>', 'Maximum page size', positiveInteger)
      .option('--cursor <cursor>', 'Continuation cursor')
      .option('--all', 'Read every page');
  }
  if (options.body === 'required') {
    command.requiredOption('--input <file|->', 'JSON body from a file or stdin');
  } else if (options.body) {
    command.option('--input <file|->', 'Optional JSON body from a file or stdin');
  }
  if (options.destructive) command.option('--yes', 'Confirm this destructive operation');
  if (options.output) {
    command.requiredOption('-o, --output <file>', 'Write the response to this file');
  }
  for (const query of options.query ?? []) {
    if (query.required) command.requiredOption(query.flag, `API query parameter ${query.key}`);
    else {
      command.option(query.flag, `API query parameter ${query.key}`);
    }
  }
  command.action(async (...args: unknown[]) => {
    const cmd = args.at(-1) as Command;
    const opts = cmd.optsWithGlobals();
    if (options.destructive) await confirmAction(opts.yes);
    const { client, json } = await context(cmd);
    const target = fillPath(path, args.slice(0, -2) as string[]);
    const query: Record<string, string | number | undefined> = {};
    if (options.list) Object.assign(query, { limit: opts.limit, cursor: opts.cursor });
    for (const entry of options.query ?? []) {
      const flagName = entry.flag
        .match(/--([\w-]+)/)![1]
        .replace(/-([a-z])/g, (_, char: string) => char.toUpperCase());
      if (opts[flagName] !== undefined) query[entry.key] = opts[flagName];
    }
    const body = opts.input ? await readBody(opts.input) : undefined;
    const request = { query, body, output: opts.output };
    if (opts.all) {
      emit(
        await client.paginate(method.toUpperCase(), target, {
          ...request,
          arrayKey: options.arrayKey,
        }),
        json,
      );
    } else {
      const response = await client.request(method.toUpperCase(), target, request);
      if (!opts.output) emit(response.data, json);
    }
  });
  return command;
}

export interface PollOptions {
  intervalMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Poll only existing jobs. A timeout leaves the remote job running. */
export async function poll<T>(
  initial: T,
  read: () => Promise<T>,
  state: (value: T) => string | undefined,
  options: PollOptions = {},
): Promise<T> {
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeoutMs ?? 5 * 60_000);
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let value = initial;
  for (;;) {
    const status = state(value);
    if (status === 'ready') return value;
    if (status === 'failed' || status === 'expired') {
      throw new CliError(
        `Processing ${status}. Inspect the resource for details.`,
        1,
        'PROCESSING_FAILED',
      );
    }
    if (!['pending', 'running', 'uploading', 'processing'].includes(status ?? '')) {
      throw new CliError('The server returned an unknown processing state.', 1, 'INVALID_RESPONSE');
    }
    const remaining = deadline - now();
    if (remaining <= 0) {
      throw new CliError(
        'Timed out waiting for processing. The remote job may still be running.',
        1,
        'POLL_TIMEOUT',
      );
    }
    await sleep(Math.min(options.intervalMs ?? 2_000, remaining));
    if (now() >= deadline) {
      throw new CliError(
        'Timed out waiting for processing. The remote job may still be running.',
        1,
        'POLL_TIMEOUT',
      );
    }
    value = await read();
  }
}

export function registerBusiness(program: Command): void {
  registerProject(program);
  registerInterview(program);
  registerStudy(program);
  registerKb(program);
  registerDoc(program);
  registerKnowledge(program);
  registerWebhook(program);
  registerUsage(program);
}
