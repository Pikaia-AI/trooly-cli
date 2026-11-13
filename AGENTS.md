# Agent instructions

## Local setup and OpenAPI release preparation

- After `npm ci`, enable the tracked pre-commit hook in each local clone with
  `git config --local core.hooksPath .githooks`. Verify with
  `git config --get core.hooksPath` (expected: `.githooks`).
- Before changing the package version, staging generated API types, or preparing
  a release tag, read [Development and releases](README.md#development-and-releases)
  for the sync triggers and recovery steps.
- Keep `npm run sync-openapi` as the manual contract update command. Generate
  `src/generated/api.d.ts` through that command rather than editing it by hand.
- When the hook stops a commit, resolve the reported error. Review and stage any
  generated diff, then retry the commit with the hook enabled.
- Before tagging a release, run `npm run sync-openapi -- --check` and require it
  to pass. If stale, sync, review, and commit the update before creating the tag.

`CLAUDE.md` is a symlink to this file; maintain agent instructions here.
