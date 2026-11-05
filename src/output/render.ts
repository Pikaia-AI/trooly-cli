import { json, redact } from './json';
import { table, objectText } from './table';
import { CliError } from '../http/errors';
export function emit(value: unknown, asJson = false): void {
  if (asJson) {
    process.stdout.write(json(value) + '\n');
    return;
  }
  const safe = redact(value);
  const object =
    safe && typeof safe === 'object' && !Array.isArray(safe)
      ? (safe as Record<string, unknown>)
      : undefined;
  const listKey = object
    ? ['items', 'projects', 'interviews', 'responses', 'versions', 'events'].find((key) =>
        Array.isArray(object[key]),
      )
    : undefined;
  let human: string;
  if (Array.isArray(safe)) {
    human = table(safe);
  } else if (listKey && object) {
    const rows = table(object[listKey] as unknown[]);
    const details = Object.fromEntries(Object.entries(object).filter(([key]) => key !== listKey));
    human = `${rows}\n${objectText(details)}`.trimEnd();
  } else {
    human = objectText(safe);
  }
  process.stdout.write(human + '\n');
}
export function emitError(error: unknown, asJson = false): number {
  const e =
    error instanceof CliError
      ? error
      : new CliError(error instanceof Error ? error.message : String(error));
  const envelope = {
    error: {
      code: e.code,
      message: e.message,
      ...(e.details === undefined ? {} : { details: e.details }),
    },
    meta: { request_id: e.requestId ?? null },
  };
  process.stderr.write(
    asJson
      ? JSON.stringify(redact(envelope)) + '\n'
      : `Error: ${redact(e.message)} (${redact(e.code)}, request_id=${redact(e.requestId ?? '-')})\n`,
  );
  return e.exitCode;
}
