import openapiTS, { astToString } from 'openapi-typescript';
import { mkdir, writeFile } from 'node:fs/promises';
const source = new URL('https://open-gateway.trooly.ai/docs/openapi.yaml');
const response = await fetch(source, { signal: AbortSignal.timeout(30000) });
if (!response.ok) throw new Error(`OpenAPI download failed (${response.status})`);
const yaml = await response.text();
const types = astToString(await openapiTS(yaml));
await mkdir('src/generated', { recursive: true });
await writeFile('src/generated/api.d.ts', types);
