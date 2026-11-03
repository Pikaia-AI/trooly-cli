import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import type { Command } from 'commander';
import { resolveProfile } from '../config/profiles';
import { ApiClient } from '../http/client';
import { usageError } from '../http/errors';
export async function context(command: Command) {
  const options = command.optsWithGlobals();
  const profile = await resolveProfile(options.profile as string | undefined);
  return {
    client: new ApiClient({ apiBase: profile.apiBase, profileName: profile.name }),
    json: Boolean(options.json),
    apiBase: profile.apiBase,
  };
}
export function pairs(values: string[] = [], separator = '='): Record<string, string> {
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const value of values) {
    const index = value.indexOf(separator);
    if (index < 1) usageError(`Expected key${separator}value: ${value}`);
    result[value.slice(0, index).trim()] = value.slice(index + 1).trim();
  }
  return result;
}
export async function readBody(input?: string, fields: string[] = []): Promise<unknown> {
  if (input && fields.length) usageError('Use either --input or --field, not both.');
  if (input) {
    let text: string;
    try {
      if (input === '-') {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
        text = Buffer.concat(chunks).toString('utf8');
      } else {
        text = await readFile(input, 'utf8');
      }
    } catch {
      return usageError('Unable to read the input file.');
    }
    try {
      return JSON.parse(text);
    } catch {
      return usageError('Input must contain valid JSON.');
    }
  }
  return fields.length ? pairs(fields) : undefined;
}
export async function confirmAction(yes = false): Promise<void> {
  if (yes) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    usageError('This action requires --yes in a non-interactive terminal.');
  }
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    if (
      !/^y(es)?$/i.test(
        (await prompt.question('Continue with this destructive action? [y/N] ')).trim(),
      )
    ) {
      usageError('Action cancelled.');
    }
  } finally {
    prompt.close();
  }
}
export const collect = (value: string, previous: string[] = []) => [...previous, value];
export function positiveInteger(value: string): number {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    return usageError('Expected a positive integer.');
  }
  return Number(value);
}
