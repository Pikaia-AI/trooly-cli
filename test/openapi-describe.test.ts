import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'yaml';
import { main } from '../src/index';
import { describeOperation, expandReferences, type OpenApiDocument } from '../src/http/openapi';

const source = await readFile(new URL('./fixtures/openapi-describe.yaml', import.meta.url), 'utf8');
const document = parse(source) as OpenApiDocument;
function at(value: unknown, ...path: (string | number)[]): unknown {
  for (const key of path) {
    if (!value || typeof value !== 'object') return undefined;
    value = (value as Record<string | number, unknown>)[key];
  }
  return value;
}
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
let dir: string;
let output: string[];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'trooly-describe-'));
  for (const name of ['XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'APPDATA', 'LOCALAPPDATA']) {
    vi.stubEnv(name, dir);
  }
  vi.stubEnv('TROOLY_API_BASE', 'https://describe.example');
  vi.stubEnv('TROOLY_PROFILE', 'default');
  vi.stubEnv('TROOLY_NO_UPDATE_CHECK', '1');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(source)));
  output = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
    output.push(String(data));
    return true;
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe('describe object depth', () => {
  it.each([false, true])('expands the real edits array and patch shape (json=%s)', async (json) => {
    const args = ['node', 'trooly', 'api', 'describe', 'studyEditDraft'];
    if (json) args.push('--json');
    expect(await main(args)).toBe(0);
    const text = output.join('');
    const operation = json ? JSON.parse(text) : undefined;
    const request = json
      ? operation.requestBody
      : JSON.parse(text.split('Request body:\n')[1].split('\nExample JSON:')[0]);
    const patch =
      request.content['application/json'].schema.properties.edits.items.properties.update_brief
        .allOf[0].properties.patch.allOf[0];
    expect(patch.properties.study_goal.allOf[0]).toEqual({
      type: 'string',
      example: 'Understand study participants',
    });
    expect(patch.properties.background.type).toBe('string');
    expect(patch.properties.details).toMatchObject({
      $ref: '#/components/schemas/BriefDetails',
      title: 'BriefDetails',
    });
    expect(patch.properties.details.properties).toBeUndefined();
    if (!json) {
      const example = JSON.parse(
        text.split('Example JSON:\n')[1].split('\nResponses and errors:')[0],
      );
      expect(example.edits[0].update_brief.patch).toEqual({
        study_goal: 'Understand study participants',
        background: 'Existing research',
        details: '<BriefDetails>',
      });
    }
  });

  it.each(['allOf', 'oneOf', 'anyOf'])('does not count %s or ref jumps as nesting', (keyword) => {
    const wrapped = { [keyword]: [{ [keyword]: [ref('StudyWriteResearchBrief')] }] };
    const expanded = expandReferences(wrapped, document, 0);
    expect(at(expanded, keyword, 0, keyword, 0, 'properties', 'background', 'type')).toBe('string');
    expect(
      at(expanded, keyword, 0, keyword, 0, 'properties', 'study_goal', 'allOf', 0, 'type'),
    ).toBe('string');
    expect(
      at(expanded, keyword, 0, keyword, 0, 'properties', 'details', 'properties'),
    ).toBeUndefined();
  });

  it('counts only objects even through nested arrays and schema-like field names', () => {
    const schema = {
      type: 'object',
      properties: {
        items: { type: 'array', items: { type: 'array', items: ref('StudyWriteResearchBrief') } },
        properties: ref('StudyWriteResearchBrief'),
      },
    };
    const expanded = expandReferences(schema, document, 1);
    expect(
      at(expanded, 'properties', 'items', 'items', 'items', 'properties', 'background', 'type'),
    ).toBe('string');
    expect(at(expanded, 'properties', 'properties', 'properties', 'background', 'type')).toBe(
      'string',
    );
  });

  it('folds inline nested objects as well as referenced ones', () => {
    const expanded = expandReferences(
      {
        type: 'object',
        properties: {
          child: { type: 'object', title: 'Child', properties: { hidden: { type: 'string' } } },
        },
      },
      document,
      0,
    );
    expect(at(expanded, 'properties', 'child')).toMatchObject({
      title: 'Child',
      'x-depth-limit': true,
    });
    expect(at(expanded, 'properties', 'child', 'properties')).toBeUndefined();
  });

  it('marks cycles but expands each independent sibling reference', () => {
    const expanded = expandReferences({ oneOf: [ref('Recursive'), ref('Recursive')] }, document);
    for (const index of [0, 1]) {
      expect(at(expanded, 'oneOf', index, 'properties', 'child', 'allOf', 0)).toMatchObject({
        $ref: '#/components/schemas/Recursive',
        title: 'Recursive',
        'x-circular-ref': true,
      });
    }
  });
});

it('follows alias chains and terminates alias cycles', () => {
  const aliases: OpenApiDocument = {
    paths: {},
    components: {
      schemas: {
        A: ref('B'),
        B: { type: 'object', properties: { value: { type: 'string' } } },
        C: ref('D'),
        D: ref('C'),
      },
    },
  };
  expect(expandReferences(ref('A'), aliases, 0)).toMatchObject({
    properties: { value: { type: 'string' } },
  });
  expect(expandReferences(ref('C'), aliases)).toEqual({
    $ref: '#/components/schemas/C',
    title: 'C',
    'x-circular-ref': true,
  });
});

it('keeps literal examples, defaults and enum values untouched', () => {
  const literal = { $ref: '#/components/schemas/Recursive', properties: { items: 'data' } };
  const schema = { type: 'object', example: literal, default: literal, enum: [literal] };
  expect(expandReferences(schema, document)).toEqual(schema);
});

it('counts additionalProperties objects as nesting but leaves primitive refs expanded', () => {
  const expanded = expandReferences(
    {
      type: 'object',
      properties: {
        map: { type: 'object', additionalProperties: ref('StudyWriteResearchBrief') },
        strings: { type: 'array', items: ref('BriefText') },
      },
    },
    document,
    1,
  );
  expect(at(expanded, 'properties', 'map', 'additionalProperties')).toEqual({
    $ref: '#/components/schemas/StudyWriteResearchBrief',
    title: 'StudyWriteResearchBrief',
    'x-depth-limit': true,
  });
  expect(at(expanded, 'properties', 'strings', 'items', 'type')).toBe('string');
});

it('uses composition scalar examples and folded placeholders without character-index objects', () => {
  const operation = {
    method: 'POST',
    path: '/fixture',
    operationId: 'example',
    summary: '',
    tags: [],
    operation: {
      requestBody: {
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                choice: { type: 'string', allOf: [{ enum: ['chosen'] }] },
                recursive: { type: 'object', allOf: [ref('Recursive')] },
                sibling: {
                  type: 'object',
                  properties: { own: { type: 'boolean' } },
                  allOf: [{ properties: { extra: { type: 'integer' } } }],
                },
              },
            },
          },
        },
      },
    },
  };
  const text = describeOperation(operation, document, 'https://describe.example');
  const example = JSON.parse(text.split('Example JSON:\n')[1].split('\nResponses and errors:')[0]);
  expect(example).toEqual({
    choice: 'chosen',
    recursive: { child: '<Recursive>' },
    sibling: { own: false, extra: 0 },
  });
});
