import { fileURLToPath } from 'node:url';

// Both src/package.ts and the bundled dist/index.js are one level below the package root.
export function bundledSkillDirectory(): string {
  return fileURLToPath(new URL('../skills/trooly/', import.meta.url));
}
