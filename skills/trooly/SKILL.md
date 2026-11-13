---
name: trooly
description: Use when the user wants to query or operate Trooly data, projects, interviews, studies, knowledge bases, or usage.
---
# Trooly CLI guide for AI assistants

## Check identity first

Run `trooly auth status --json` before making requests. Verify the organization,
environment, credential type and granted permissions. Use `--profile <name>` to
select a saved login. CI can supply TROOLY_API_KEY; never put credentials in flags.

## Output and failures

Use `--json` for data commands. JSON on stdout preserves API field names; errors
and notices go to stderr. IDs are opaque strings: never convert them to numbers.
Exit codes: 0 success; 1 API/network failure; 2 invalid usage; 3 login required or
expired; 4 permission denied; 5 CLI too old (run `trooly update`).
List commands accept `--limit`, `--cursor`, and `--all`. The latter returns one
merged array. Generic API requests use `--paginate`. Do not change filters while
continuing a cursor. Creating requests carry an idempotency key reused on retries.

## Export interview transcripts

`trooly study list --all --json`
`trooly study responses <project-id> --all --json`
`trooly study export transcripts <project-id> -o transcripts.txt`

For a qualitative project, list interviews and read their existing transcript:
`trooly project list --all --json`
`trooly interview list <project-id> --all --json`
`trooly interview get <interview-id> --json`
Inspect the returned structure before processing it; do not invent fields.

## Upload a knowledge document

`trooly kb list --all --json`
`trooly doc upload notes.md --kb <knowledge-base-id> --wait --json`
`trooly knowledge search "research findings" --kb <knowledge-base-id> --json`

## Inspect usage

`trooly usage get --from 2026-01-01T00:00:00Z --to 2026-02-01T00:00:00Z --all --json`
`trooly usage events --from 2026-01-01T00:00:00Z --to 2026-02-01T00:00:00Z --all --json`
`trooly usage export --from 2026-01-01T00:00:00Z --to 2026-02-01T00:00:00Z -o usage.csv`
Replace the sample time window with the user's requested dates. Aggregate windows
must align with UTC hours or days as described by the API.

## Discover other operations

`trooly api list --search transcript`
`trooly api describe <operationId> --json`
`trooly api GET /trooly/v1/projects -q limit=50 --json`
`trooly api POST /trooly/v2/projects --input study.json --json`
Request-body commands accept JSON files or `--input -` for stdin. Use API discovery
to check required fields, permission requirements and response schemas first.

## Destructive operations

Obtain the user's approval before deleting, terminating, launching a project or
removing interviewee information. Such commands require `--yes` when not running
in a terminal. Do not add this flag until the user has approved the operation.

## Documentation

Human-readable: https://open-gateway.trooly.ai/docs
OpenAPI: https://open-gateway.trooly.ai/docs/openapi.yaml
The Getting started documentation covers pagination, error codes and idempotency.
Use `trooly docs <operationId>` for the relevant operation.
