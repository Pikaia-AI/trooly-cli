import openapiTS, { astToString } from 'openapi-typescript';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
const source = new URL('https://open-gateway.trooly.ai/docs/openapi.yaml');
const response = await fetch(source, { signal: AbortSignal.timeout(30000) });
if (!response.ok) throw new Error(`OpenAPI download failed (${response.status})`);
const yaml = await response.text();
const types = astToString(await openapiTS(yaml));
const generatedPath = 'src/generated/api.d.ts';
if (process.argv.includes('--check')) {
  if ((await readFile(generatedPath, 'utf8')) !== types) {
    throw new Error(
      'OpenAPI types are out of date. Run npm run sync-openapi and commit the result before tagging.',
    );
  }
} else {
  await mkdir('src/generated', { recursive: true });
  await writeFile(generatedPath, types);
}
