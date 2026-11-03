import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const ignored = new Set(['.git', 'node_modules', 'coverage']);
const allowed = 'open-gateway.trooly.ai';
// Construct the restricted suffixes so the scanner itself contains no forbidden host.
const suffixes = ['trooly', 'pikaia'].map((name) => `${name}\\.ai`);
const hosts = new RegExp(`(?:[a-z0-9-]+\\.)*(?:${suffixes.join('|')})`, 'gi');
const localPaths =
  /(?:\/Users\/[^/\s]+\/|[A-Z]:\\Users\\[^\\\s]+\\)(?:Pikaia|Documents|\.treehouse)\b/g;
const failures: string[] = [];
async function scan(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name) || entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await scan(path);
      continue;
    }
    if (entry.name.endsWith('.tgz')) continue;
    const content = await readFile(path, 'utf8');
    for (const match of content.matchAll(hosts)) {
      if (match[0].toLowerCase() !== allowed) {
        failures.push(`${relative('.', path)}: unapproved product domain`);
      }
    }
    if (localPaths.test(content)) failures.push(`${relative('.', path)}: workstation path`);
    localPaths.lastIndex = 0;
  }
}
await scan('.');
if (failures.length) {
  console.error([...new Set(failures)].join('\n'));
  process.exitCode = 1;
} else {
  console.log('Public repository check passed.');
}
