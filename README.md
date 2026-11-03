# Trooly CLI

The command-line interface for the [Trooly API](https://open-gateway.trooly.ai/docs), for developers, scripts, CI, and AI assistants. Requires Node.js 22 or later.

## Install

Give your AI assistant this instruction:

> Install the Trooly CLI: run `npx -y trooly@latest setup --yes`, then help me finish signing in.

For prereleases, use `trooly@next` instead of `trooly@latest`.

```sh
npm install -g trooly
# or
pnpm add -g trooly
# without a global installation
npx trooly@latest --help
```

## Set up the CLI and assistant skill

```sh
trooly setup
# Accept setup confirmations automatically
npx -y trooly@latest setup --yes
# Install without starting OAuth login
trooly setup --yes --skip-login
```

`setup` installs the current CLI version globally when run through npx or pnpm dlx, installs the matching Trooly skill for AI assistants, and starts login. An existing global CLI installation is reused. The skill is fetched from the matching GitHub version tag; if that fails, setup tries the copy bundled with the CLI.

Use `--skip-skill` to omit skill installation, `--skip-login` to omit login, and `--yes` to accept confirmations. In a noninteractive terminal, login uses a device code: open the printed link and enter the code to finish signing in. If OAuth is not enabled on the gateway, use `TROOLY_API_KEY` instead; login exits with code 3.

Each failed step prints a command to retry manually, and setup continues with the remaining steps before reporting their results. With `--json`, stdout contains one summary JSON object; progress, login instructions, and subprocess output go to stderr.

## Log in

```sh
trooly login
trooly whoami --json
# Equivalent to:
trooly auth status --json
```

Browser login uses OAuth authorization code + PKCE and a temporary callback on `127.0.0.1`. Select the organization, environment, and permissions on the authorization page. The default request is `read write`; use `trooly login --scope read` for read-only access.

On SSH, headless Linux, or a remote container:

```sh
trooly login --device
```

Open the printed verification link on any device and enter the displayed code. The CLI waits for approval and does not open a local browser. OAuth login and status require the corresponding gateway endpoints to be available.

Credentials use the operating system keyring when available. Otherwise, the CLI warns and stores credentials in a restricted local file. Set `TROOLY_CREDENTIAL_STORE=file` to select file storage explicitly. Tokens are never printed. Concurrent CLI processes coordinate token refresh with a file lock.

Use separate profiles for separate organizations or environments:

```sh
trooly login --profile research
trooly profile list
trooly profile use research
trooly project list --profile research --json
trooly logout
trooly profile remove research
```

`trooly logout` revokes the current OAuth grant and removes local credentials. If the network is unavailable, local credentials are still removed; disconnect the application in the account settings to revoke remotely.

OAuth credentials remain bound to their saved gateway. When changing the gateway with `TROOLY_API_BASE`, use a separate profile to prevent credentials from crossing gateways.

## API keys and configuration

For unattended jobs, provide a service account API key through the `TROOLY_API_KEY` environment variable using your CI secret store. It takes precedence over OAuth. There is deliberately no command-line key argument, so a key is not placed in shell history or process arguments.

| Variable | Purpose |
| --- | --- |
| `TROOLY_API_KEY` | Authenticate using an API key instead of OAuth |
| `TROOLY_PROFILE` | Select a profile for this invocation; `--profile` overrides it |
| `TROOLY_API_BASE` | Override the gateway; default is `https://open-gateway.trooly.ai` |
| `TROOLY_CREDENTIAL_STORE=file` | Use restricted file storage |
| `TROOLY_NO_UPDATE_CHECK=1` | Disable update notifications |
| `TROOLY_DEBUG=1` | Write redacted request summaries to stderr |

On macOS/Linux, configuration is under `$XDG_CONFIG_HOME/trooly` (default `~/.config/trooly`) and caches/locks under `$XDG_CACHE_HOME/trooly` (default `~/.cache/trooly`). Windows uses `%APPDATA%\trooly` and `%LOCALAPPDATA%\trooly` respectively.

## Common commands

```sh
trooly project list --all --json
trooly project get PROJECT_ID --json
trooly project create --input project.json --json
trooly interview list PROJECT_ID --all --json

trooly study list --all --json
trooly study draft get STUDY_ID --json
trooly study responses STUDY_ID --all --json
trooly study export transcripts STUDY_ID -o transcripts.txt
trooly study media archive STUDY_ID --wait -o media.zip

trooly kb list --json
trooly doc upload ./notes.pdf --kb KNOWLEDGE_BASE_ID --wait --json
trooly doc download DOCUMENT_ID -o notes.pdf
trooly knowledge search "customer onboarding" --json

trooly webhook list --json
trooly usage get --from 2026-01-01T00:00:00Z --to 2026-02-01T00:00:00Z --json
trooly usage events --from 2026-01-01T00:00:00Z --to 2026-02-01T00:00:00Z --all --json
trooly usage export --from 2026-01-01T00:00:00Z --to 2026-02-01T00:00:00Z -o usage.csv
```

Run a command with `--help` for its options. Lists support `--limit`, `--cursor`, and `--all`. Deletion, termination, and other destructive operations request confirmation in a terminal. In a script, pass `--yes` explicitly after obtaining the user's approval.

By default, output is a table or readable object. `--json` writes the API's `data` value with the original field names. Pagination combines pages into one array. Errors and advisory notices go to stderr, leaving stdout suitable for pipelines. IDs should be kept as strings.

## Any API operation and interface discovery

Use `trooly api` for operations without a dedicated command:

```sh
trooly api GET /trooly/v1/projects -q limit=50 --json
trooly api GET /trooly/v1/projects --paginate --json
trooly api POST /trooly/v2/projects --input study.json --json
cat study.json | trooly api POST /trooly/v2/projects --input - --json
```

`--query` (`-q`), `--field` (`-f`), and `--header` (`-H`) are repeatable. `--field key=value` builds a JSON body with string values, preserving identifiers exactly; use `--input` for numbers, booleans, arrays, or nested objects. Extra headers cannot replace `Authorization`. Use `-o file` to save an export response.

```sh
trooly api list
trooly api list --search transcript
trooly api list --tag study-responses --json
trooly api describe studyListStudyResponses --json
trooly api describe GET /trooly/v2/projects/{id}/responses
trooly docs studyListStudyResponses
```

Discovery reads the selected gateway's public OpenAPI without login. It caches the contract for 24 hours; pass `--refresh` to fetch it now. An existing cache is used if the gateway is unreachable. `describe` includes parameters, request and response schemas, required permission, and a documentation link. `docs` opens the browser in an interactive terminal and prints a link otherwise.

See the [API documentation](https://open-gateway.trooly.ai/docs) and [OpenAPI contract](https://open-gateway.trooly.ai/docs/openapi.yaml) for pagination, errors, and idempotency.

## AI assistants

Start with:

```sh
trooly guide
trooly whoami --json
# Equivalent to:
trooly auth status --json
```

The guide prints the body of the bundled `skills/trooly/SKILL.md`, which is also installed by `trooly setup`. It contains tested command sequences and discovery instructions. Use `--json`, check exit codes, and request explicit approval before destructive commands. Read `api describe` before constructing an unfamiliar request.

## Upgrade

```sh
trooly update --check
trooly update
trooly update --version 0.1.0
trooly update --method pnpm
```

Updates recognize npm, pnpm, yarn, bun, and Volta installations. Temporary npx/pnpm-dlx runs and project dependencies receive instructions instead of a global install. Global installation uses an exact version and verifies the new CLI version afterward. After a successful upgrade, the matching assistant skill is installed again; a skill installation failure is reported without failing the CLI upgrade. No update occurs automatically.

The advisory version check runs at most once per day, using `npm_config_registry`, `registry=` in `~/.npmrc`, or the public npm registry, in that order. It is skipped in CI and when stderr is not a terminal. A failed or slow check never blocks a command.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | API, network, or other failure |
| 2 | Missing or invalid arguments, or missing noninteractive confirmation |
| 3 | Not logged in, expired/revoked credentials, or authorization denied |
| 4 | Insufficient permissions; review granted permissions or run `trooly login --scope write` |
| 5 | CLI version unsupported by the gateway; run `trooly update` |

## Development and releases

```sh
npm ci
npm run build
npm run lint
npm test
npm pack --dry-run
```

Tests use local mock servers and synthetic data. They do not call the gateway. `npm run sync-openapi` is a separate maintenance command that fetches the public contract and regenerates `src/generated/api.d.ts`; commit the result when updating the contract. It is not run by tests. OAuth and credential endpoint types remain separate until the latter is included in the gateway contract.

CI checks Linux, macOS, and Windows with Node 22 and 24, including an internal-domain scan. A daily workflow proposes OpenAPI changes as a pull request. Releases use tags matching `package.json` (`v0.1.0`); stable versions publish to `latest`, prereleases to `next`.

The first functional package release must be published by a package maintainer before npm trusted publishing can be configured. Configure GitHub OIDC for `Pikaia-AI/trooly-cli` and `release.yml` in the npm package settings; subsequent releases require no stored npm token. Publication and account setup are separate maintainer operations, not actions performed by building the CLI.

## License

Apache-2.0. The package includes the full [LICENSE](LICENSE) and bundled dependency notices in `dist/THIRD_PARTY_LICENSES`.
