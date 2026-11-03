import { CliError } from './errors';
export interface Envelope<T = unknown> {
  data: T;
  meta?: { next_cursor?: string | null; request_id?: string; [key: string]: unknown };
}
export function pageItems(
  page: Envelope,
  arrayKey?: string,
): { items: unknown[]; cursor?: string } {
  const data = page.data;
  const record =
    data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : undefined;
  let items: unknown;
  if (Array.isArray(data)) {
    items = data;
  } else if (arrayKey) {
    items = record?.[arrayKey];
  } else {
    items =
      record?.items ??
      record?.projects ??
      record?.interviews ??
      record?.responses ??
      record?.versions ??
      record?.events;
  }
  if (!Array.isArray(items)) {
    throw new CliError(
      'This response is not a paginated list; inspect it with trooly api describe.',
      2,
      'NOT_A_LIST',
    );
  }
  const cursor = page.meta?.next_cursor ?? record?.next_cursor;
  if (cursor != null && typeof cursor !== 'string') {
    throw new CliError('Invalid pagination cursor in response.');
  }
  return { items, cursor: cursor || undefined };
}
export async function paginate(
  fetchPage: (cursor?: string) => Promise<Envelope>,
  initialCursor?: string,
  arrayKey?: string,
): Promise<unknown[]> {
  const result: unknown[] = [];
  let cursor = initialCursor;
  const seen = new Set<string>();
  if (cursor) seen.add(cursor);
  for (;;) {
    const page = pageItems(await fetchPage(cursor), arrayKey);
    result.push(...page.items);
    if (!page.cursor) return result;
    if (seen.has(page.cursor)) {
      throw new CliError('Server repeated a pagination cursor.', 1, 'PAGINATION_LOOP');
    }
    seen.add(page.cursor);
    cursor = page.cursor;
  }
}
