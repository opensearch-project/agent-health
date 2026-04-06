# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AgentEval is an evaluation framework for Root Cause Analysis (RCA) agents. It uses "Golden Path" trajectory comparison where an LLM Judge (AWS Bedrock) evaluates agent actions against expected outcomes. The frontend streams agent execution via AG-UI protocol and visualizes trajectories in real-time.

**Key concepts:**
- **Test Case** (UI: "Use Case"): A scenario with prompt, context, and expected outcomes
- **Benchmark**: Collection of test cases with multiple runs to compare configurations
- **Benchmark Run**: Point-in-time snapshot with agent/model config and results
- **Trajectory**: Sequence of agent steps (thinking → action → tool_result → response)

## Development Commands

### Starting the Application

**Two processes required:**

```bash
# Terminal 1 - Backend server (port 4001)
npm run dev:server

# Terminal 2 - Frontend dev server (port 4000)
npm run dev
```

**Production mode (single terminal):**
```bash
npm run server  # Build UI + start server on port 4001
```

**Ports:**
- Development: Frontend on 4000, Backend on 4001
- Production: Single server on 4001 (serves both UI and API)

### Building
```bash
npm run build   # TypeScript compile + Vite production build
```

### Testing
```bash
npm test                    # Run all tests (unit + integration)
npm run test:unit           # Unit tests only
npm run test:integration    # Integration tests only
npm run test:e2e            # E2E tests with Playwright
npm run test:e2e:ui         # E2E tests with Playwright UI mode
npm run test:e2e:report     # View Playwright HTML report
npm run test:all            # Run all tests (unit + integration + e2e)
npm test -- --watch         # Watch mode
npm test -- path/to/file.test.ts  # Single test file
```

**IMPORTANT:** After making code changes, always run `npm run build:all && npm run test:all` to verify the build succeeds and all tests pass. A pre-push hook enforces this automatically.

**NEVER use `git push --no-verify` or `git commit --no-verify`.** The pre-push and pre-commit hooks exist to catch build failures, test regressions, and other issues before they reach CI. If a hook fails, fix the underlying issue instead of bypassing the check. Skipping hooks leads to broken CI pipelines and wasted review cycles.

### CLI / NPX Package
```bash
npm run build:cli           # Build CLI only
npm run build:all           # Build UI + server + CLI
npm run demo                # Build all + run server

# NPX usage (after publishing)
npx @opensearch-project/agent-health           # Start server
npx @opensearch-project/agent-health --port 8080
npx @opensearch-project/agent-health --env-file .env

# CLI subcommands
npx @opensearch-project/agent-health list agents    # List configured agents
npx @opensearch-project/agent-health list connectors # List available connectors
npx @opensearch-project/agent-health list test-cases # List sample test cases
npx @opensearch-project/agent-health run -t <test-case> -a <agent>  # Run test case
npx @opensearch-project/agent-health doctor         # Check configuration
npx @opensearch-project/agent-health init           # Initialize config files

# Import test cases from JSON and run benchmark
npx @opensearch-project/agent-health benchmark -f ./test-cases.json -a <agent>
npx @opensearch-project/agent-health benchmark -f ./test-cases.json -n "My Benchmark" -a <agent>

# Export test cases (produces import-compatible JSON)
npx @opensearch-project/agent-health export -b <benchmark> -o test-cases.json

# Generate reports (HTML, PDF, JSON)
npx @opensearch-project/agent-health report -b <benchmark>
npx @opensearch-project/agent-health report -b <benchmark> -f pdf -o report.pdf

# One-time migration for existing benchmark runs
npx @opensearch-project/agent-health migrate --dry-run
```

**IMPORTANT:** Do not modify the `name` or `version` fields in `package.json`. These are used for publishing the tool via NPX.

### Setup (first time)
```bash
./scripts/setup.sh              # Quick start (assumes ML-Commons running)
./scripts/setup.sh --setup-opensearch  # Full setup from scratch
./scripts/setup.sh --stop       # Stop all services
./scripts/setup.sh --status     # Check service status
```

## Architecture

> **Full documentation:** See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for detailed architecture patterns, including the server-mediated CLI design and Playwright-style server lifecycle.

> **Performance optimization:** See [docs/PERFORMANCE.md](docs/PERFORMANCE.md) for detailed performance optimizations in the Benchmark Runs Overview page, including lightweight polling, field projection, pagination, and adaptive intervals.

### Key Architecture Principle

**All clients (CLI, UI) access OpenSearch through the server HTTP API.** Never bypass the server to access OpenSearch directly from CLI commands. This ensures consistent behavior and single source of truth. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for details.

### Service Layer (`services/`)

Key subdirectories: `agent/` (SSE, AG-UI), `evaluation/` (judge, mock), `storage/` (OpenSearch CRUD), `traces/` (OTel polling/metrics), `client/` (browser API), `connectors/` (agent protocols — see `/add-connector` skill).

### OpenTelemetry Instrumentation Standards

**CRITICAL REQUIREMENT:** All agents integrating with Agent Health MUST follow OpenTelemetry semantic conventions for instrumentation data.

#### Required Semantic Conventions

Agent instrumentation MUST adhere to the standardized attributes defined in:
- **Gen AI Conventions**: https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/

#### Mandatory Implementation Requirements

**1. Span Attributes**

All LLM interaction spans MUST include:
```typescript
{
  "gen_ai.system": "anthropic" | "openai" | "aws.bedrock" | ...,
  "gen_ai.request.model": "claude-sonnet-4",
  "gen_ai.operation.name": "chat" | "completion" | "embedding",
  "gen_ai.request.temperature": 0.7,
  "gen_ai.request.max_tokens": 4096,
  "gen_ai.usage.prompt_tokens": 1234,
  "gen_ai.usage.completion_tokens": 567,
}
```

**2. Span Hierarchy**

Follow this structure:
- **Root span**: Agent execution (e.g., `agent.execute`, `rca.analyze`)
- **Child spans**: LLM calls, tool invocations, retrieval operations
- **Grandchild spans**: Nested operations within tools

**3. Tool Invocation Spans**

Tool execution spans MUST include:
```typescript
{
  "gen_ai.tool.name": "search_logs",
  "gen_ai.tool.description": "Search application logs for errors",
  // Tool input as span event
  // Tool output as span event
}
```

**4. Span Events**

Capture key moments as span events:
- `gen_ai.content.prompt` - Input to LLM
- `gen_ai.content.completion` - Output from LLM
- `gen_ai.tool.input` - Tool invocation arguments
- `gen_ai.tool.output` - Tool execution results

See [OpenTelemetry Gen AI Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) for full implementation examples. Key files: `spanCategorization.ts` (span categorization), `metrics.ts` (token/cost calculation).

### Configuration (`lib/`)

- `constants.ts`: Default agent configs, model configs, tool definitions
- `config/loader.ts`: Loads and merges `agent-health.config.ts` with built-in defaults
- `config/types.ts`: `UserAgentConfig`, `UserModelConfig`, `AgentHealthConfig` types
- `debug.ts`: Universal debug logging (browser `localStorage` + Node.js in-memory flag / `DEBUG` env var)
- `hooks.ts`: `executeBeforeRequestHook()` - runs user-defined lifecycle hooks
- `labels.ts`: Unified labeling system (replaces category/difficulty)
- `testCaseValidation.ts`: Zod schemas for test case validation
- `runStats.ts`: Aggregate pass/fail/accuracy statistics from benchmark run results

#### Config File System

Agents and models can be configured via `agent-health.config.ts` in the working directory (also `.js` or `.mjs`). User config is merged with built-in defaults unless `extends: false` is set. See `agent-health.config.example.ts` for the full schema.

```typescript
// agent-health.config.ts
export default {
  agents: [
    { key: "my-agent", name: "My Agent", endpoint: "http://localhost:3000/agent",
      connectorType: "agui-streaming" }
  ],
  // extends: false,  // Set to use ONLY your agents/models (no built-in defaults)
};
```

Agent keys matching built-in keys (e.g., `"langgraph"`) override the built-in agent. The `init` CLI command generates this file.

#### Lifecycle Hooks

Agents can define a `beforeRequest` hook in config to customize requests:

```typescript
hooks: {
  beforeRequest: async ({ endpoint, payload, headers }) => {
    // e.g., pre-create a thread, modify payload, add auth headers
    return { endpoint, payload, headers };
  },
}
```

### Type System (`types/index.ts`)

Key interfaces:
- `TestCase`: Versioned use case with prompt, context, expectedOutcomes, labels
- `TestCaseRun` (alias: `EvaluationReport`): Single evaluation result with trajectory and metrics
- `Benchmark` / `BenchmarkRun`: Batch evaluation configurations and results
- `TrajectoryStep`: Agent step (thinking/action/tool_result/response)
- `AgentConfig` / `ModelConfig`: Agent and model configuration schemas

### Path Aliases

TypeScript path alias `@/*` maps to project root (configured in [tsconfig.json](tsconfig.json), [vite.config.ts](vite.config.ts), [jest.config.cjs](jest.config.cjs)):
```typescript
import { TestCase } from '@/types';
import { getConfig } from '@/lib/config';
```

### CLI (`cli/`)

Entry point for NPX package (`bin/cli.js` → `cli/index.ts`):
- `commands/list.ts`: List agents, test cases, benchmarks, connectors
- `commands/run.ts`: Run single test case against an agent
- `commands/benchmark.ts`: Run full benchmark across multiple test cases and agents (supports `-f <file.json>` to import test cases from JSON)
- `commands/export.ts`: Export benchmark test cases as import-compatible JSON
- `commands/doctor.ts`: Check configuration and system requirements
- `commands/init.ts`: Initialize `agent-health.config.ts` configuration file
- `utils/serverLifecycle.ts`: Playwright-style server auto-start (start if not running, auto-stop on exit)
- `utils/apiClient.ts`: Typed HTTP client wrapping all server API calls for CLI
- `demo/sample*.ts`: Sample test cases, benchmarks, runs, traces

**Server Auto-Start Pattern:** CLI commands that need the backend use `ensureServer()` from `serverLifecycle.ts`. This checks if a server is already running, starts one if not, and registers cleanup handlers. Similar to Playwright's `webServer` pattern.

### Directory Structure

```
.
├── cli/              # NPX package entry point
│   └── demo/         # Sample data generators
├── components/       # React UI components (shadcn/ui + custom)
├── services/         # Business logic layer
│   ├── agent/        # AG-UI protocol handling (SSE, conversion)
│   ├── client/       # Browser-side API calls
│   ├── evaluation/   # Judge, mock data
│   ├── storage/      # OpenSearch async wrappers
│   ├── traces/       # Background trace polling
│   └── opensearch/   # Log fetching utilities
├── server/           # Express backend (port 4001)
│   ├── routes/       # API endpoints
│   ├── services/     # Backend-only services
│   ├── prompts/      # LLM judge prompts
│   └── middleware/   # Express middleware
├── lib/              # Shared configuration & constants
├── types/            # TypeScript type definitions
├── hooks/            # React custom hooks
├── tests/            # Test files (unit & integration)
├── docs/             # Additional documentation
└── scripts/          # Setup and utility scripts
```

## Key Implementation Notes

### Test Cases

Test cases are managed via the UI (Settings > Use Cases) and stored in OpenSearch. The `TestCase` type uses:
- **Labels**: Unified tagging system (e.g., `category:RCA`, `difficulty:Medium`)
- **Versions**: Immutable history - each edit creates a new version
- **expectedOutcomes**: Text descriptions of expected agent behavior (used by judge)

### Storage Adapter Validation

Both the file and OpenSearch storage adapters enforce these invariants:
- **`testCases.create()`** requires a `name` field — throws `'Test case name is required'` if missing.
- **`testCases.update()`** throws `'Test case {id} not found'` if the entity doesn't already exist (consistent with `benchmarks.update()` and `runs.update()`). This prevents ghost documents from being silently created via update-as-upsert.

### Adding New Models

Update `lib/constants.ts` → `DEFAULT_CONFIG.models`:
```typescript
"model-key": {
  model_id: "anthropic.claude-...",
  display_name: "Display Name",
  context_window: 200000,
  max_output_tokens: 4096
}
```

Models are configured globally in `config.models`, not per-agent.

### Trajectory Step Types

Five step types in agent execution:
1. `thinking`: Agent reasoning (streamed)
2. `action`: Tool invocation with toolName, toolArgs
3. `tool_result`: Tool output with status (SUCCESS/FAILURE)
4. `assistant`: Intermediate assistant messages
5. `response`: Final agent conclusion

### LLM Judge

The Bedrock LLM judge (`server/routes/judge.ts`) evaluates agent performance:
- Compares actual trajectory against expectedOutcomes
- Returns `passFailStatus` (passed/failed), accuracy metric, and reasoning
- Provides improvement strategies categorized by priority

### Backend Server (`server/`)

Express server on port 4001 provides:
- `/api/agents`, `/api/models` - Agent/model configuration (list, add/remove custom agents)
- `/api/debug` - Debug mode toggle (GET status, POST to enable/disable)
- `/api/evaluate` - Server-side evaluation execution (used by CLI)
- `/api/judge` - Bedrock evaluation proxy
- `/api/agent/stream` - Agent execution proxy (SSE)
- `/api/logs/*` - OpenSearch log queries
- `/api/traces/*` - OTel trace queries
- `/api/metrics/*` - Token/cost metrics from traces
- `/api/storage/*` - Test case, benchmark, run persistence

### Environment Variables

**Required** (see [.env.example](.env.example)):
- `AWS_PROFILE`, `AWS_REGION`: AWS profile for Bedrock LLM judge (recommended)
- Or explicit credentials: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`

**Optional** (all have sensible defaults):
- `DEBUG`: Enable verbose debug logging on server startup (`true`/`false`, default: `false`)
- `LANGGRAPH_ENDPOINT` / `HOLMESGPT_ENDPOINT` / `MLCOMMONS_ENDPOINT`: Agent endpoints
- `OPENSEARCH_STORAGE_*`: Storage cluster for test cases/benchmarks (features degrade if missing)
  - Basic auth: `OPENSEARCH_STORAGE_ENDPOINT`, `OPENSEARCH_STORAGE_USERNAME`, `OPENSEARCH_STORAGE_PASSWORD`
  - AWS SigV4: `OPENSEARCH_STORAGE_AUTH_TYPE=sigv4`, `OPENSEARCH_STORAGE_AWS_REGION`, `OPENSEARCH_STORAGE_AWS_PROFILE` (optional), `OPENSEARCH_STORAGE_AWS_SERVICE` (`es` or `aoss`)
- `OPENSEARCH_LOGS_*`: Logs cluster for agent execution logs (features degrade if missing)
  - Basic auth: `OPENSEARCH_LOGS_ENDPOINT`, `OPENSEARCH_LOGS_USERNAME`, `OPENSEARCH_LOGS_PASSWORD`
  - AWS SigV4: `OPENSEARCH_LOGS_AUTH_TYPE=sigv4`, `OPENSEARCH_LOGS_AWS_REGION`, `OPENSEARCH_LOGS_AWS_PROFILE` (optional), `OPENSEARCH_LOGS_AWS_SERVICE` (`es` or `aoss`)
- `MLCOMMONS_HEADER_*`: Headers for ML-Commons agent data source access (see [docs/ML-COMMONS-SETUP.md](docs/ML-COMMONS-SETUP.md))

### Data Model

**Key relationships:** Benchmark → `testCaseIds[]` → TestCase; Benchmark → `runs[]` (embedded) → `results[testCaseId].reportId` → TestCaseRun. Names are NOT unique. Test cases use immutable versioning (new doc per edit: `{id}-v{n+1}`).

**OpenSearch indexes:** `evals_test_cases`, `evals_benchmarks`, `evals_runs`, `evals_analytics`.

## Coding Style Conventions

### Key Patterns
- **SSE streaming** for long-running ops: set event-stream headers, `res.flushHeaders()`, structured events (`started`/`progress`/`completed`/`cancelled`/`error`), persist state immediately
- **Cancellation tokens**: `{ isCancelled, cancel() }` in `Map<runId, token>`, check before each iteration, clean up in `finally`
- **Run status**: `pending` → `running` → `completed` | `failed` | `cancelled`
- **Route validation**: `validateX(): string | null`, return 400 with `{ error }`, early return for 404
- **Storage wrappers**: `asyncXStorage` with `toAppFormat()`/`toStorageFormat()`, expose CRUD methods
- **Types**: String unions (not enums) for status. `RunConfigInput` (user fields) vs `BenchmarkRun` (full entity). Discriminated unions with `type` field.
- **Exports**: Barrel exports via `index.ts` with named functions

## Testing

Tests in `tests/` folder mirroring source structure. Jest config in [jest.config.cjs](jest.config.cjs). See `/write-test` skill for full conventions, mocking patterns, and templates.

**Coverage thresholds:** Lines 90%, Statements 90%, Functions 80%, Branches 80%. Always use `@/` path alias in imports, never relative paths.

## CI/CD Workflows

GitHub Actions workflows in `.github/workflows/`:

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `ci.yml` | Push/PR to main | Run tests, coverage, linting |
| `npm-publish.yml` | Tag push (v*) | Build and publish to npm |
| `stale.yml` | Scheduled daily | Mark stale issues/PRs |
| `dco.yml` | PR | Enforce DCO signoff |
| `add-untriaged.yml` | Issues | Add untriaged label |
| `backport.yml` | PR merge | Create backport PRs |
| `changelog.yml` | PR | Validate changelog |
| `dependency-review.yml` | PR | Review dependency changes |
| `links-checker.yml` | Push/Scheduled | Check for broken links |

## PR Workflow

Use `/create-pr` skill for full workflow. Key requirements:
- All commits need DCO signoff (`git commit -s`)
- `CHANGELOG.md` must be updated (CI enforced)
- `npm run build:all && npm run test:all` must pass
- New source files need SPDX license headers

## OpenSearch Project Compliance

- **Required files (DO NOT REMOVE):** LICENSE.txt, NOTICE.txt, CODE_OF_CONDUCT.md, CONTRIBUTING.md, SECURITY.md, MAINTAINERS.md, ADMINS.md
- **SPDX license header** required on all source files: `/* Copyright OpenSearch Contributors \n SPDX-License-Identifier: Apache-2.0 */`
- **DCO signoff** required on all commits: `git commit -s -m "message"` (CI enforced)
- See `/create-pr` skill for full compliance checklist


