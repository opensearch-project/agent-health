# Configuration Guide

Agent Health has **one file you author** plus state the app manages:

1. **`agent-health.config.ts`** — the config you write (agents, connectors, models, judge, reporters, telemetry, and optionally storage/observability). Optional; only for customization.
2. **`.agent-health/state.json`** — runtime state the app writes (storage/observability/custom agents/debug). You don't hand-edit this; the Settings UI manages it.
3. **Environment variables** — secrets and quick overrides (`process.env` / `.env`).

Which is authoritative depends on the mode (below). Zero config also works — file-based storage and built-in demo agents need nothing.

## Quick Start (Zero Config)

Most users can start immediately with no configuration:

```bash
# If you have AWS credentials configured (aws configure)
npx agent-health run -t demo-tc-1 -a claude-code
```

This works because:
- Claude Code uses your `AWS_PROFILE` automatically
- Travel Planner demo test cases are built-in
- File-based storage is used by default (no OpenSearch needed)
- Results shown in terminal

## Two modes: code-first vs UI-first

Which file is authoritative depends on whether you author an `agent-health.config.ts`:

| Mode | Trigger | Source of truth | Settings UI (data sources) |
|------|---------|-----------------|----------------------------|
| **Code-first** | an `agent-health.config.{ts,js,mjs}` exists (project **or** user scope) | the `.ts` + `.env` | read-only — edit the file and restart |
| **UI-first** | no authored config file anywhere | `.agent-health/state.json` + `.env` | writable — the UI persists here |

**The rule:** if an authored config file is present, the runtime state file is
**ignored entirely** and the `.ts` wins. Otherwise the state file (written by the
Settings UI) is used. Exactly one plane is active — no merging, no precedence puzzle.

`.agent-health/` resolves at both **user** (`~/.agent-health/`) and **project**
(`<cwd>/.agent-health/`) scope, project overriding user — so you can set clusters
once globally and override per project.

Resolution for storage/observability (each tier overrides the one below):

```
Code-first:  project agent-health.config.ts → user ~/.agent-health/*.ts → OPENSEARCH_* env
UI-first:    project .agent-health/state.json → user ~/.agent-health/state.json → OPENSEARCH_* env → file-storage fallback
```

A single committed `agent-health.config.ts` (reading secrets from `process.env`)
is all most projects need — no state file required.

## Runtime state file (`.agent-health/state.json`)

In **UI-first** mode (no authored config), configuring storage/observability via
the **Settings page** writes `.agent-health/state.json` (project scope by
default; gitignored). Don't hand-edit it — treat it as app-managed state:

```json
{
  "storage": { "endpoint": "https://...", "authType": "sigv4", "awsRegion": "us-east-1", "awsService": "es", "awsProfile": "default" },
  "observability": { "endpoint": "https://...", "authType": "sigv4", "awsRegion": "us-east-1", "indexes": { "traces": "otel-v1-apm-span-*", "logs": "ml-commons-logs-*" } },
  "debug": false
}
```

In **code-first** mode (an `agent-health.config.ts` exists) this file is
**ignored**, and the Settings data-source panels are read-only — set
storage/observability in the `.ts` (see [TypeScript Config File](#typescript-config-file-optional)).

### What gets written, and when

The app **never writes your `agent-health.config.ts`** — you author it by hand.
UI writes only ever target `.agent-health/state.json`, and only in ui-first mode:

| Action | UI-first (no `.ts`) | Code-first (a `.ts` exists) |
|--------|---------------------|------------------------------|
| **Test Connection** | nothing written — connectivity probe only | nothing written — probe only |
| **Save** (storage / observability / remote server) | writes `.agent-health/state.json` (project scope) | **`409 "managed by agent-health.config.ts"`** — nothing written |
| **Change a value for real** | Save in the UI | edit `agent-health.config.ts` + restart |

So if you edit the endpoint field and hit **Test Connection**, it only probes
that endpoint (falling back to stored credentials *only* when the endpoint
matches the configured one); the typed value is **not persisted** until you
**Save** — and in code-first mode Save is rejected with a `409`. To actually
switch clusters in code-first mode, edit the `.ts` and restart.

### Auto-migration from legacy files

Existing `agent-health.yaml` and `agent-health.config.json` files are migrated
once to `.agent-health/state.json` on first startup (handled by
`configMigration.ts`); the originals are renamed to `*.backup`. If you also have
an `agent-health.config.ts`, the migrated storage/observability are ignored
(code-first) — a startup warning tells you to move them into the `.ts`.

## Where things live: settings vs data vs your test files

Three locations are easy to confuse — they hold different things and have
different lifecycles:

| Location | Plane | Holds | Lifecycle |
|----------|-------|-------|-----------|
| `.agent-health/` | **Settings + Data** (control plane + file storage backend) | `state.json` (which storage/observability cluster, custom agents, debug flag — UI-first mode only) and `data/` (`test-cases/`, `benchmarks/`, `runs/`, `analytics/`, `evaluators/`, `traces/`, `skill-evals/` — the records Agent Health produces when no OpenSearch cluster is configured) | app-managed, gitignored, grows with use |
| `evals/` *(or wherever you keep them)* | **Your source code** | the `.eval.js` / `.eval.ts` test files **you author** with the code SDK | you own it, version-controlled |

Rules of thumb:

- **`.agent-health/`** answers *"how is Agent Health configured?"* (`state.json`)
  and *"what has Agent Health stored?"* (`data/`). `state.json` is like
  `.vscode/settings.json` and is **ignored entirely** in code-first mode (when an
  `agent-health.config.ts` is present); `data/` is like a local `./data` database
  directory, used only when the storage backend is **file** (set
  `OPENSEARCH_STORAGE_*` or `storage` in your config to use a cluster instead).
- **`evals/`** is **your test source** — `.eval.js` / `.eval.ts` files you write
  with the [code SDK](./SDK.md) and run with
  `agent-health benchmark -f ./examples/eval-files/demo.eval.js`. They are **not** stored under
  `.agent-health/data/`; *running* them produces run records that land there (or
  in OpenSearch).

`.agent-health/` is **gitignored** — runtime state, not source. Your `evals/` and
any committed `agent-health.config.ts` are the parts you version-control.

## File-Based Storage (Default)

By default, Agent Health uses **file-based storage** that requires no external services. Data is stored as JSON files under the app-managed `.agent-health/data/` directory — combined with `state.json` so there is **one** gitignored, app-managed folder:

```
.agent-health/
├── state.json        # config-v2 runtime state (UI-managed)
└── data/             # generated, disposable
    ├── test-cases/   # Test case definitions
    ├── benchmarks/   # Benchmark configurations
    ├── runs/         # Evaluation run results
    ├── analytics/    # Analytics data
    └── evaluators/   # Evaluator (judge) definitions
```

This means you can start using Agent Health immediately without setting up OpenSearch. To switch to OpenSearch storage, configure the `OPENSEARCH_STORAGE_*` environment variables (see below).

## Environment Variables

### AWS Credentials

Required for Claude Code agent and Bedrock judge.

| Variable | Description | Default |
|----------|-------------|---------|
| `AWS_PROFILE` | AWS profile to use | `default` |
| `AWS_REGION` | AWS region | `us-west-2` |
| `AWS_ACCESS_KEY_ID` | Explicit access key (alternative to profile) | - |
| `AWS_SECRET_ACCESS_KEY` | Explicit secret key | - |
| `AWS_SESSION_TOKEN` | Session token (for temporary credentials) | - |

**Note:** If you've run `aws configure`, credentials are auto-detected.

### OpenSearch Storage (Optional)

Override the default file-based storage with an OpenSearch cluster for shared, production-grade persistence. Without these settings, file-based storage is used automatically.

**Basic Auth (username/password):**

| Variable | Description | Default |
|----------|-------------|---------|
| `OPENSEARCH_STORAGE_ENDPOINT` | Storage cluster URL | - |
| `OPENSEARCH_STORAGE_USERNAME` | Username | - |
| `OPENSEARCH_STORAGE_PASSWORD` | Password | - |
| `OPENSEARCH_STORAGE_TLS_SKIP_VERIFY` | Skip TLS verification | `false` |

**AWS SigV4 Auth (instead of username/password):**

| Variable | Description | Default |
|----------|-------------|---------|
| `OPENSEARCH_STORAGE_ENDPOINT` | Storage cluster URL | - |
| `OPENSEARCH_STORAGE_AUTH_TYPE` | Auth type: `none` \| `basic` \| `sigv4` (defaults to `basic` when a username/password is set) | - |
| `OPENSEARCH_STORAGE_AWS_REGION` | AWS region (required for SigV4) | - |
| `OPENSEARCH_STORAGE_AWS_PROFILE` | AWS profile name (uses default credential chain if omitted) | - |
| `OPENSEARCH_STORAGE_AWS_SERVICE` | `es` for managed OpenSearch, `aoss` for Serverless | `es` |
| `OPENSEARCH_STORAGE_TLS_SKIP_VERIFY` | Skip TLS verification | `false` |

SigV4 uses the AWS credential chain (`AWS_PROFILE`, `~/.aws/credentials`, IAM role, etc.) — no explicit access keys needed. You can also configure SigV4 via the Settings UI or the `agent-health.config.json` file.

### OpenSearch Observability (Optional)

View agent traces and logs. Only needed for ML-Commons agent.

**Basic Auth (username/password):**

| Variable | Description | Default |
|----------|-------------|---------|
| `OPENSEARCH_LOGS_ENDPOINT` | Logs cluster URL | - |
| `OPENSEARCH_LOGS_USERNAME` | Username | - |
| `OPENSEARCH_LOGS_PASSWORD` | Password | - |
| `OPENSEARCH_LOGS_TRACES_INDEX` | Traces index pattern | `otel-v1-apm-span-*` |
| `OPENSEARCH_LOGS_INDEX` | Logs index pattern | `ml-commons-logs-*` |

**AWS SigV4 Auth (instead of username/password):**

| Variable | Description | Default |
|----------|-------------|---------|
| `OPENSEARCH_LOGS_ENDPOINT` | Logs cluster URL | - |
| `OPENSEARCH_LOGS_AUTH_TYPE` | Auth type: `none` \| `basic` \| `sigv4` (defaults to `basic` when a username/password is set) | - |
| `OPENSEARCH_LOGS_AWS_REGION` | AWS region (required for SigV4) | - |
| `OPENSEARCH_LOGS_AWS_PROFILE` | AWS profile name (uses default credential chain if omitted) | - |
| `OPENSEARCH_LOGS_AWS_SERVICE` | `es` for managed OpenSearch, `aoss` for Serverless | `es` |
| `OPENSEARCH_LOGS_TRACES_INDEX` | Traces index pattern | `otel-v1-apm-span-*` |
| `OPENSEARCH_LOGS_INDEX` | Logs index pattern | `ml-commons-logs-*` |

SigV4 authentication is also configurable via the Settings UI (select "AWS SigV4" from the Authentication Type dropdown) or the `agent-health.config.json` file.

### Agent Endpoints (Optional)

Override default agent endpoints.

| Variable | Description | Default |
|----------|-------------|---------|
| `TRAVEL_PLANNER_ENDPOINT` | Travel Planner demo agent URL (requires OTel Demo Docker) | `http://localhost:3000` |

To configure additional agents (LangGraph, ML-Commons, HolmesGPT, Claude Code, etc.), use `agent-health.config.ts`. See [TypeScript Config File](#typescript-config-file-optional) below.

### Debug Logging

| Variable | Description | Default |
|----------|-------------|---------|
| `DEBUG` | Enable verbose debug logging on server startup | `false` |

Debug logging can also be toggled at runtime via the Settings page "Verbose Logging" toggle or the `POST /api/debug` endpoint. When enabled, structured debug output appears in both the browser console and server terminal.

### Advanced Settings

| Variable | Description | Default |
|----------|-------------|---------|
| `VITE_BACKEND_PORT` | Backend server port | `4001` |
| `AGENT_HEALTH_EVAL_ROOTS` | Path-delimiter-separated directories a relative code-SDK `sourceFile` is resolved against (see [`evalRoots`](#where-the-server-looks-for-eval-source-files-evalroots)) | server cwd |
| `BEDROCK_MODEL_ID` | Judge model ID | `us.anthropic.claude-sonnet-4-5-20250929-v1:0` |

## Where the server looks for eval source files (`evalRoots`)

Code-SDK test cases imported from an `.eval.js` / `.eval.ts` / `.eval.mjs`
file are stored with a **relative** `sourceFile` (e.g. `evals/demo.eval.js`).
When a run of those stored cases starts, the server must re-open that file to
execute the test bodies. Historically the path was resolved against the
server's `process.cwd()` **only** — so a shared server started from the
agent-health checkout could not run suites that live in another repo.

The server now resolves a relative `sourceFile` against an ordered list of
**eval roots**; the first directory that contains the file wins. Absolute
`sourceFile`s are used verbatim.

| Precedence | Source | Notes |
|-----------|--------|-------|
| 1 (highest) | `AGENT_HEALTH_EVAL_ROOTS` env var | Path-delimiter separated (`:` on POSIX, `;` on Windows), e.g. `AGENT_HEALTH_EVAL_ROOTS=/srv/eval-suites:/srv/other-suites` |
| 2 | `evalRoots: string[]` in `agent-health.config.ts` (code-first) **or** `"evalRoots": [...]` in `.agent-health/state.json` (ui-first) | Same rule as every other setting: an authored `.ts` config makes `state.json` ignored |
| 3 (default) | `[process.cwd()]` | Identical to the pre-feature behaviour |

Relative roots are resolved against the server's cwd. A configured list
**replaces** the default — add `.` explicitly to keep the cwd as a fallback.
Because a stored `sourceFile` is relative, the same relative path under two
roots resolves to the **first** root that has it — keep relative eval paths
unique across roots (e.g. one suite repo per root, or distinct sub-directories).
The effective list is exposed on `GET /api/storage/config/status` as
`evalRoots: { roots, source }`, and the CLI `benchmark` command prints a
one-line hint before a run when a stored case's `sourceFile` is under none of
the server's roots.

```ts
// agent-health.config.ts
export default defineConfig({
  evalRoots: ['/srv/eval-suites', '.'],
});
```

Two consequences worth knowing:

- **Newly imported cases are keyed relative to the root that matched.** A
  `code-import` of `evals/demo.eval.js` found under `/srv/eval-suites` is
  stored as `evals/demo.eval.js`, so any server with the same roots can run it.
- **An unresolvable `sourceFile` is a hard pre-start error** (with
  [#503](https://github.com/opensearch-project/agent-health/pull/503)): a
  stored code case whose file is under none of the roots fails the run before
  it starts, listing the roots tried, instead of silently falling back to the
  classic LLM-judge path. Fix it by pointing `AGENT_HEALTH_EVAL_ROOTS` at the
  directory that contains the suite (or re-importing with `benchmark -f`).

> Running the CLI from the eval repo against a server started from a
> *different* directory trips the CLI's foreign-instance guard; set
> `AH_REUSE_FOREIGN_SERVER=1` to opt in (that is the shared-server workflow).

## TypeScript Config File (Optional)

Create `agent-health.config.ts` for custom agents, models, or connectors.

### When to Use a Config File

- Adding custom agents
- Custom connectors
- CI/CD (version-controlled config)
- Custom test case locations

### When NOT to Use a Config File

- Just running Claude Code
- Using default file-based storage (works out of the box)
- Simple storage setup (use env vars for OpenSearch)
- Quick testing with Travel Planner demo

### Example Config

```typescript
// agent-health.config.ts
import { defineConfig } from '@opensearch-project/agent-health';

export default defineConfig({
  // Add custom agents (built-ins still work)
  agents: [
    {
      key: 'my-agent',
      name: 'My Custom Agent',
      connectorType: 'rest', // or 'agui-streaming', 'langgraph', 'strands', 'subprocess'
      endpoint: 'http://localhost:8080/chat',
      useTraces: true,
    },
  ],

  // Optional: OpenSearch storage for eval results (can also use env vars / the
  // Settings UI). Read secrets from process.env so this file stays committable.
  storage: {
    endpoint: process.env.OPENSEARCH_STORAGE_ENDPOINT!,
    authType: 'sigv4',          // 'none' | 'basic' | 'sigv4'
    awsRegion: 'us-east-1',
    awsService: 'es',           // 'es' (managed) | 'aoss' (serverless)
    awsProfile: process.env.AWS_PROFILE,
  },

  // Optional: OpenSearch observability cluster for traces/logs (Traces tab).
  observability: {
    endpoint: process.env.OPENSEARCH_LOGS_ENDPOINT!,
    authType: 'sigv4',
    awsRegion: 'us-east-1',
    indexes: { traces: 'otel-v1-apm-span-*', logs: 'ml-commons-logs-*' },
  },

  // Custom test cases location
  testCases: './my-tests/*.yaml',
});
```

> **Precedence:** an authored `agent-health.config.ts` (above) **wins** and the
> runtime state file is ignored (code-first). Without a `.ts`, the Settings UI's
> `.agent-health/state.json` is used, then `OPENSEARCH_*` env, then file-based
> fallback. See [Two modes: code-first vs UI-first](#two-modes-code-first-vs-ui-first).

### Config File Options

| Option | Type | Description |
|--------|------|-------------|
| `agents` | `UserAgentConfig[]` | Custom agents (merged with defaults) |
| `models` | `UserModelConfig[]` | Custom models (merged with defaults) |
| `connectors` | `AgentConnector[]` | Custom connectors |
| `storage` | `StorageClusterConfig` | OpenSearch storage cluster (endpoint + auth) |
| `observability` | `ObservabilityClusterConfig` | OpenSearch traces/logs cluster (endpoint + auth + index patterns) |
| `evalRoots` | `string[]` | Directories a relative code-SDK `sourceFile` is resolved against, first hit wins (see [Where the server looks for eval source files](#where-the-server-looks-for-eval-source-files-evalroots)) |
| `testCases` | `string \| string[]` | Test case file patterns |
| `reporters` | `ReporterConfig[]` | Output reporters |
| `judge` | `JudgeConfig` | Judge model configuration |
| `telemetry` | `TelemetryConfig` | OTel evaluation span emission |
| `extends` | `boolean` | Extend defaults (`true`) or replace (`false`) |

### Agent Config Options

```typescript
interface UserAgentConfig {
  key: string;              // Unique identifier
  name: string;             // Display name
  endpoint: string;         // URL or command name
  connectorType?: string;   // 'agui-streaming', 'rest', 'langgraph', 'strands', 'subprocess', 'claude-code', 'mock'
  headers?: Record<string, string>;  // HTTP headers
  useTraces?: boolean;      // Enable trace collection
  connectorConfig?: Record<string, any>;  // Connector-specific config
  hooks?: AgentHooks;       // beforeRequest hook, etc.
  description?: string;     // Description
  enabled?: boolean;        // Enable/disable agent (default true)
}
```

## Built-in Agents

These agents work out of the box:

| Agent | Key | Connector | Notes |
|-------|-----|-----------|-------|
| Demo Agent | `demo` | `mock` | Simulated responses for testing |
| Claude Code | `claude-code` | `claude-code` | Requires `claude` CLI installed |
| Amazon Strands | `strands` | `strands` | Bedrock Agent Runtime (disabled by default) |
| LangGraph (REST) | `langgraph-rest` | `langgraph` | Direct REST API (disabled by default) |

## Built-in Connectors

| Type | Protocol | Use Case |
|------|----------|----------|
| `agui-streaming` | AG-UI SSE | ML-Commons and AG-UI compatible agents |
| `rest` | HTTP POST | Simple REST APIs |
| `openai-compatible` | OpenAI Chat Completions | LiteLLM, Ollama, vLLM |
| `langgraph` | LangGraph REST `/invoke` | Non-AG-UI LangGraph instances |
| `strands` | Bedrock Agent Runtime | Amazon Strands agents (server-only) |
| `subprocess` | CLI | Generic CLI tools |
| `claude-code` | CLI | Claude Code CLI specifically |
| `mock` | In-memory | Testing and demos |

## Configuration Hierarchy

Settings are loaded in this order (later overrides earlier):

```
1. Built-in defaults (lib/constants.ts)
      ↓
2. Environment variables (.env / OPENSEARCH_*)
      ↓
3. Runtime state (.agent-health/state.json) — UI-written; used only in ui-first mode
      ↓
4. agent-health.config.ts — authored; in code-first mode it WINS and the state file is ignored
```

**Note:** For **agents/models/connectors/judge/reporters/telemetry**, the
TypeScript config (`agent-health.config.ts`) is always authoritative. For
**storage and observability** the order depends on mode — code-first: `.ts` >
`OPENSEARCH_*` env > file fallback (state ignored); ui-first:
`.agent-health/state.json` > `OPENSEARCH_*` env > file fallback. See
[Two modes: code-first vs UI-first](#two-modes-code-first-vs-ui-first).

## Validation

Check your configuration:

```bash
npx agent-health doctor
```

This shows:
- Config file status
- AWS credentials
- Storage configuration
- Available agents and connectors
