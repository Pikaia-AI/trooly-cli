import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { getPaths } from '../config/paths';
import { normalizeApiBase } from '../config/profiles';
import { CliError } from './errors';

type ObjectValue = Record<string, unknown>;
export interface OpenApiDocument extends ObjectValue {
  paths: Record<string, ObjectValue>;
  components?: ObjectValue;
}
export interface Operation {
  method: string;
  path: string;
  operationId: string;
  summary: string;
  tags: string[];
  operation: ObjectValue;
}
const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'];
const DAY = 86400000;
function object(value: unknown): ObjectValue | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as ObjectValue)
    : undefined;
}
function parseDocument(source: string): OpenApiDocument {
  const document = parse(source, { maxAliasCount: 100 }) as unknown;
  if (!object(document) || !object((document as ObjectValue).paths)) {
    throw new Error('Invalid OpenAPI document');
  }
  return document as OpenApiDocument;
}
export function openapiCacheFile(apiBase: string): string {
  const url = new URL(normalizeApiBase(apiBase));
  const host = url.host.replace(/[^a-zA-Z0-9.-]/g, '_');
  // Include the origin hash so different schemes and sanitized hosts cannot share a cache.
  return join(
    getPaths().cacheDir,
    'openapi',
    `${host}-${createHash('sha256').update(url.origin).digest('hex').slice(0, 12)}.yaml`,
  );
}
export async function loadOpenApi(apiBase: string, refresh = false): Promise<OpenApiDocument> {
  const file = openapiCacheFile(apiBase);
  let cached: OpenApiDocument | undefined;
  let fresh = false;
  try {
    cached = parseDocument(await readFile(file, 'utf8'));
    fresh = Date.now() - (await stat(file)).mtimeMs < DAY;
  } catch {
    /* Missing or invalid cache is downloaded again. */
  }
  if (cached && fresh && !refresh) return cached;
  try {
    const response = await fetch(`${normalizeApiBase(apiBase)}/docs/openapi.yaml`, {
      signal: AbortSignal.timeout(10000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const source = await response.text();
    const document = parseDocument(source);
    await mkdir(join(getPaths().cacheDir, 'openapi'), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, source, { mode: 0o600 });
      // Concurrent readers must see a complete contract, never a partially written download.
      await rename(tmp, file);
    } finally {
      await rm(tmp, { force: true });
    }
    return document;
  } catch {
    // A previously validated contract keeps discovery usable when refresh is unavailable.
    if (cached) {
      process.stderr.write('The gateway is unavailable; using the cached API contract.\n');
      return cached;
    }
    throw new CliError(
      `Unable to load the API contract. Documentation: ${apiBase}/docs`,
      1,
      'OPENAPI_UNAVAILABLE',
    );
  }
}
export function operations(document: OpenApiDocument): Operation[] {
  return Object.entries(document.paths).flatMap(([path, item]) =>
    METHODS.flatMap((method) => {
      const operation = object(item[method]);
      if (!operation) return [];
      const inherited = Array.isArray(item.parameters) ? item.parameters : [];
      const local = Array.isArray(operation.parameters) ? operation.parameters : [];
      return [
        {
          method: method.toUpperCase(),
          path,
          operationId: String(operation.operationId ?? ''),
          summary: String(operation.summary ?? ''),
          tags: Array.isArray(operation.tags) ? operation.tags.map(String) : [],
          operation: {
            ...operation,
            ...(inherited.length || local.length ? { parameters: [...inherited, ...local] } : {}),
          },
        },
      ];
    }),
  );
}
export function listOperations(
  document: OpenApiDocument,
  tag?: string,
  search?: string,
): Operation[] {
  return operations(document).filter(
    (op) =>
      (!tag || op.tags.includes(tag)) &&
      (!search ||
        `${op.path} ${op.operationId} ${op.summary}`.toLowerCase().includes(search.toLowerCase())),
  );
}
export function findOperation(
  document: OpenApiDocument,
  idOrMethod: string,
  path?: string,
): Operation | undefined {
  return operations(document).find((op) =>
    path
      ? op.method === idOrMethod.toUpperCase() && op.path === path
      : op.operationId === idOrMethod,
  );
}
export function matchOperation(
  document: OpenApiDocument,
  method: string,
  actualPath: string,
): Operation | undefined {
  const path = actualPath.split('?')[0];
  return (
    findOperation(document, method, path) ??
    operations(document).find(
      (op) =>
        op.method === method.toUpperCase() &&
        op.path.split('/').length === path.split('/').length &&
        op.path
          .split('/')
          .every((part, index) => /^\{[^}]+\}$/.test(part) || part === path.split('/')[index]),
    )
  );
}
export function docsUrl(base: string, op?: Operation): string {
  const url = `${normalizeApiBase(base)}/docs`;
  if (!op) return url;
  return `${url}#tag/${encodeURIComponent(op.tags[0] ?? '')}/operation/${encodeURIComponent(op.operationId)}`;
}
export function expandReferences(
  value: unknown,
  document: OpenApiDocument,
  maxDepth = 3,
  depth = 0,
  seen = new Set<string>(),
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => expandReferences(item, document, maxDepth, depth, seen));
  }
  const record = object(value);
  if (!record) return value;
  if (typeof record.$ref === 'string') {
    const ref = record.$ref;
    if (!ref.startsWith('#/')) return { $ref: ref };
    const name = ref.split('/').at(-1)!;
    if (seen.has(ref) || depth > maxDepth) return { $ref: ref, title: name };
    let target: unknown = document;
    for (const segment of ref.slice(2).split('/')) {
      target = object(target)?.[segment.replace(/~1/g, '/').replace(/~0/g, '~')];
    }
    if (target === undefined) return { $ref: ref };
    const nextSeen = new Set(seen).add(ref);
    return expandReferences(
      {
        ...object(target),
        ...Object.fromEntries(Object.entries(record).filter(([key]) => key !== '$ref')),
      },
      document,
      maxDepth,
      depth,
      nextSeen,
    );
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, child]) => [
      key,
      expandReferences(
        child,
        document,
        maxDepth,
        depth + (key === 'properties' || key === 'items' ? 1 : 0),
        seen,
      ),
    ]),
  );
}
function example(schemaValue: unknown): unknown {
  const schema = object(schemaValue);
  if (!schema) return null;
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  if (schema.$ref) return `<${schema.title ?? String(schema.$ref).split('/').at(-1)}>`;
  if (schema.allOf && Array.isArray(schema.allOf)) {
    return Object.assign({}, ...schema.allOf.map(example));
  }
  if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf)) {
    return example(((schema.oneOf ?? schema.anyOf) as unknown[])[0]);
  }
  if (schema.type === 'array') return [example(schema.items)];
  if (schema.type === 'object' || schema.properties) {
    return Object.fromEntries(
      Object.entries(object(schema.properties) ?? {}).map(([key, child]) => [key, example(child)]),
    );
  }
  if (schema.type === 'boolean') return false;
  if (schema.type === 'integer' || schema.type === 'number') return 0;
  return '<string>';
}
export function describeOperation(
  op: Operation,
  document: OpenApiDocument,
  apiBase: string,
): string {
  const expanded = expandReferences(op.operation, document) as ObjectValue;
  const lines = [
    `${op.method} ${op.path}`,
    `${op.operationId}: ${op.summary}`,
    String(expanded.description ?? ''),
    `Required permission: ${expanded['x-required-permission'] ?? '(not specified)'}`,
  ];
  if (Array.isArray(expanded.parameters)) {
    for (const value of expanded.parameters) {
      const p = object(value) ?? {};
      const s = object(p.schema) ?? {};
      lines.push(
        `${p.in} ${p.name}: ${s.type ?? 'object'}${p.required ? ' (required)' : ''}${s.enum ? ` enum=${JSON.stringify(s.enum)}` : ''}`,
      );
    }
  }
  if (expanded.requestBody) {
    lines.push(`Request body:\n${JSON.stringify(expanded.requestBody, null, 2)}`);
    const media = object(object(expanded.requestBody)?.content);
    const json = object(media?.['application/json']);
    if (json) {
      lines.push(`Example JSON:\n${JSON.stringify(json.example ?? example(json.schema), null, 2)}`);
    }
  }
  lines.push(
    `Responses and errors:\n${JSON.stringify(expanded.responses ?? {}, null, 2)}`,
    docsUrl(apiBase, op),
  );
  return lines.filter(Boolean).join('\n');
}
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const old = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = old;
    }
  }
  return row[b.length];
}
export function nearestPaths(document: OpenApiDocument, path: string): string[] {
  return Object.keys(document.paths)
    .map((value) => ({ value, distance: distance(path.slice(0, 512), value) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 3)
    .map((item) => item.value);
}
