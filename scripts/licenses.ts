import { createRequire } from 'node:module';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
const root = createRequire(import.meta.url);
const visited = new Set<string>();
const notices: { name: string; version: string; license: string; text: string }[] = [];
async function visit(name: string, from = root): Promise<void> {
  let packageFile: string;
  try {
    packageFile = from.resolve(`${name}/package.json`);
  } catch {
    let directory = dirname(from.resolve(name));
    while (true) {
      try {
        const file = join(directory, 'package.json');
        const candidate = JSON.parse(await readFile(file, 'utf8')) as { name?: string };
        if (candidate.name === name) {
          packageFile = file;
          break;
        }
      } catch {
        /* Continue toward the package root. */
      }
      const parent = dirname(directory);
      if (parent === directory) throw new Error(`Cannot locate license for ${name}`);
      directory = parent;
    }
  }
  if (visited.has(packageFile)) return;
  visited.add(packageFile);
  const manifest = JSON.parse(await readFile(packageFile, 'utf8')) as {
    name: string;
    version: string;
    license: string;
    dependencies?: Record<string, string>;
  };
  const directory = dirname(packageFile);
  const files = (await readdir(directory))
    .filter((file) => /^(licen[sc]e|copying|notice)(\.|$)/i.test(file))
    .sort();
  if (!files.length) throw new Error(`Missing license text for ${manifest.name}`);
  const text = (
    await Promise.all(files.map((file) => readFile(join(directory, file), 'utf8')))
  ).join('\n\n');
  notices.push({ name: manifest.name, version: manifest.version, license: manifest.license, text });
  const local = createRequire(packageFile);
  for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
    await visit(dependency, local);
  }
}
for (const name of ['commander', 'openapi-fetch', 'proper-lockfile', 'yaml']) await visit(name);
await mkdir('dist', { recursive: true });
await writeFile(
  'dist/THIRD_PARTY_LICENSES',
  notices
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(
      (item) => `${item.name}@${item.version} (${item.license})\n${'='.repeat(72)}\n${item.text}`,
    )
    .join('\n\n'),
);
console.log(`Preserved license notices for ${notices.length} bundled dependencies.`);
