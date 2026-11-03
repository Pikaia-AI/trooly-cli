import { defineConfig } from 'tsup';
export default defineConfig({
  entry: ['src/index.ts'], format: ['esm'], target: 'node22', clean: true,
  splitting: false, sourcemap: false,
  noExternal: ['commander', 'openapi-fetch', 'proper-lockfile', 'yaml'],
  external: ['@napi-rs/keyring'],
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
});
