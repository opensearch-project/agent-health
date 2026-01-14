# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AgentEval is an evaluation framework for Root Cause Analysis (RCA) agents. It uses "Golden Path" trajectory comparison where an LLM Judge (AWS Bedrock) evaluates agent actions against expected outcomes. The frontend streams agent execution via AG-UI protocol and visualizes trajectories in real-time.

**Key concepts:**
- **Test Case** (UI: "Use Case"): A scenario with prompt, context, and expected outcomes
- **Experiment**: Collection of test cases with multiple runs to compare configurations
- **Experiment Run**: Point-in-time snapshot with agent/model config and results
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
npm test -- --watch         # Watch mode
npm test -- path/to/file.test.ts  # Single test file
```

### CLI / NPX Package
```bash
npm run build:cli           # Build CLI only
npm run build:all           # Build UI + server + CLI
npm run demo                # Build all + run server

# NPX usage (after publishing)
npx @opensearch-project/agent-health           # Start server
npx @opensearch-project/agent-health --port 8080
npx @opensearch-project/agent-health --env-file .env
```

### Setup (first time)
```bash
./scripts/setup.sh              # Quick start (assumes ML-Commons running)
./scripts/setup.sh --setup-opensearch  # Full setup from scratch
./scripts/setup.sh --stop       # Stop all services
./scripts/setup.sh --status     # Check service status
```

## Architecture

### Service Layer (`services/`)

**Agent Services** (`services/agent/`):
- `sseStream.ts`: `consumeSSEStream()` - SSE connection to agent endpoint
- `aguiConverter.ts`: `AGUIToTrajectoryConverter` - converts AG-UI events to TrajectorySteps
- `payloadBuilder.ts`: `buildAgentPayload()` - constructs agent request payload

**Evaluation Services** (`services/evaluation/`):
- `index.ts`: Main `runEvaluation()` - orchestrates agent call, streaming, and judge
- `bedrockJudge.ts`: `callBedrockJudge()` - backend proxy call with exponential backoff
- `mockTrajectory.ts`: `generateMockTrajectory()` - testing without real agent

**Storage Services** (`services/storage/`):
- `opensearchClient.ts`: OpenSearch client for persistence
- `asyncTestCaseStorage.ts`: Test case CRUD operations
- `asyncExperimentStorage.ts`: Experiment management
- `asyncRunStorage.ts`: Evaluation run persistence
- Data stored in OpenSearch indexes (configured via `OPENSEARCH_STORAGE_*` env vars)

**Trace Services** (`services/traces/`):
- `tracePoller.ts`: Polls for traces with configurable delay (traces take ~5 min to propagate)
- `index.ts`: Trace fetching and metrics calculation from OTel spans

**Other Services**:
- `comparisonService.ts`: Aggregate metrics and side-by-side comparison logic
- `experimentRunner.ts`: Batch execution of test cases across runs
- `metrics.ts`: Token/cost calculations from trace data

### Configuration (`lib/`)

- `constants.ts`: Agent configs, model configs, tool definitions
- `config.ts`: Runtime config loading from env vars
- `labels.ts`: Unified labeling system (replaces category/difficulty)
- `testCaseValidation.ts`: Zod schemas for test case validation

### Type System (`types/index.ts`)

Key interfaces:
- `TestCase`: Versioned use case with prompt, context, expectedOutcomes, labels
- `TestCaseRun` (alias: `EvaluationReport`): Single evaluation result with trajectory and metrics
- `Experiment` / `ExperimentRun`: Batch evaluation configurations and results
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
- `demo/sample*.ts`: Sample test cases, experiments, runs, traces
- `utils/startServer.ts`: Server bootstrap for CLI context

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

Then add the model key to the agent's `models` array in the agents config.

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
- `/api/judge` - Bedrock evaluation proxy
- `/api/agent/stream` - Agent execution proxy (SSE)
- `/api/logs/*` - OpenSearch log queries
- `/api/traces/*` - OTel trace queries
- `/api/metrics/*` - Token/cost metrics from traces
- `/api/storage/*` - Test case, experiment, run persistence

### Environment Variables

**Required** (see [.env.example](.env.example)):
- `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`: Bedrock credentials for LLM judge

**Optional** (all have sensible defaults):
- `LANGGRAPH_ENDPOINT` / `HOLMESGPT_ENDPOINT` / `MLCOMMONS_ENDPOINT`: Agent endpoints
- `OPENSEARCH_STORAGE_*`: Storage cluster for test cases/experiments (features degrade if missing)
- `OPENSEARCH_LOGS_*`: Logs cluster for agent execution logs (features degrade if missing)
- `MLCOMMONS_HEADER_*`: Headers for ML-Commons agent data source access (see [docs/ML-COMMONS-SETUP.md](docs/ML-COMMONS-SETUP.md))

## Coding Style Conventions

### Backend Patterns

**SSE Streaming for Long-Running Operations**
- Use Server-Sent Events for operations that take time (experiment execution, agent streaming)
- Set headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, then `res.flushHeaders()`
- Send structured events: `{ type: 'started' | 'progress' | 'completed' | 'cancelled' | 'error', ... }`
- Backend continues execution even if client disconnects - persist state immediately after starting

**Cancellation Token Pattern**
- Use `CancellationToken` interface: `{ isCancelled: boolean, cancel(): void }`
- Store active tokens in `Map<runId, CancellationToken>` registry at route level
- Check `cancellationToken?.isCancelled` before each loop iteration
- Clean up registry in `finally` block

**Run Status State Machine**
- Status progression: `pending` → `running` → `completed` | `failed` | `cancelled`
- Persist `running` status immediately when starting (survives page refresh)
- Use OpenSearch Painless scripts for atomic array updates

**Background Job Pattern (e.g., Trace Polling)**
- Use singleton manager class with `Map<id, State>` and `Map<id, Callbacks>`
- Jobs are in-memory for short-lived operations (~10 min max)
- Implement dual-location: server (primary) + browser (recovery)

**Route Validation**
- Create `validateX(input): string | null` functions returning error message or null
- Return 400 with `{ error: message }` on validation failure
- Use early returns for 404: `if (error.meta?.statusCode === 404)`

### Frontend Patterns

**SSE Consumption**
- Use `ReadableStream` with chunk buffering for incomplete events
- Buffer: `buffer += decoder.decode(value, { stream: true })`, split on `\n\n`, keep last part
- Distinguish app errors from `SyntaxError` (expected for incomplete chunks)

**Polling with useRef**
- Store intervals in `useRef<NodeJS.Timeout | null>(null)`
- Clear in useEffect cleanup
- Different intervals for active runs (2s) vs background sync (5s)

**Status Derivation for Legacy Data**
- Create `getEffectiveStatus(item)` helpers to normalize missing status fields
- Derive from child results when parent undefined
- Document legacy handling with comments

**Progress UI**
- Track per-item: `{ id, name, status: 'pending' | 'running' | 'completed' | 'failed' }`
- Initialize all as `pending`, update individually as each completes
- Compute aggregate stats from results

### Storage Layer

**Async Storage Wrapper Pattern**
- Create `asyncXStorage` classes wrapping OpenSearch client
- Include `toAppFormat()` / `toStorageFormat()` converters
- Expose: `getAll()`, `getById()`, `create()`, `update()`, `delete()`

**OpenSearch Array Updates**
- Use Painless scripts: `for (int i = 0; i < ctx._source.runs.size(); i++) { if (ctx._source.runs[i].id == params.runId) { ... } }`

### Type Patterns

**Status as String Unions**
- Define: `type RunResultStatus = 'pending' | 'running' | 'completed' | 'failed'`
- Not enums - string unions are easier to work with

**Config Input vs Full Entity**
- `RunConfigInput`: user-provided fields only
- `ExperimentRun`: full entity with system-added id, createdAt, status, results

**Event Types with Discriminator**
- Include `type` field in event interfaces for switch statements
- Separate types: `ExperimentProgress`, `ExperimentStartedEvent`

### Module Organization

**Service Directory Structure**
```
services/
├── agent/          # Agent communication (SSE, AG-UI conversion)
├── client/         # Browser-side API calls
├── evaluation/     # Judge, mock data
├── storage/        # OpenSearch async wrappers
└── traces/         # Background trace polling
```

**Exports**
- Barrel exports via `index.ts` with named functions
- `export { executeExperimentRun, cancelExperimentRun }` not namespace objects

## Testing

Tests are located in `tests/` (integration) and `__tests__/` or `*.test.ts` (unit). Jest config in [jest.config.cjs](jest.config.cjs).

**Key settings:**
- Test timeout: 30s (for integration tests with SSE streams)
- Force exit enabled (prevents hanging on SSE connections)
- Path alias `@/*` configured for imports

**Test structure:**
- `tests/integration/` - Integration tests requiring real services
- `tests/unit/` - Unit tests for individual functions
- Service tests in `services/*/(__tests__|*.test.ts)` - Colocated with implementation

**Mocking:**
- Config mock at `__mocks__/@/lib/config.ts` - auto-loaded by Jest for `@/lib/config` imports
- Use this pattern for mocking other shared modules

## OpenSearch Project Compliance

This repository follows OpenSearch project conventions:

**Required files (DO NOT REMOVE):**
- [LICENSE.txt](LICENSE.txt) - Apache 2.0 license
- [NOTICE.txt](NOTICE.txt) - Legal attribution
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md)
- [MAINTAINERS.md](MAINTAINERS.md), [ADMINS.md](ADMINS.md)
- [opensearch_dashboards.json](opensearch_dashboards.json) - Plugin manifest (if building as dashboard plugin)

**Customizable files:**
- [FEATURES.md](FEATURES.md), [ONBOARDING.md](ONBOARDING.md), [RELEASING.md](RELEASING.md), [RESPONSIBILITIES.md](RESPONSIBILITIES.md)
- [PULL_REQUEST_TEMPLATE.md](PULL_REQUEST_TEMPLATE.md)

**License Headers (REQUIRED for all source files):**
All source files MUST include an SPDX license header. Add the appropriate header at the top of new files:

```typescript
// For .ts, .tsx, .js, .jsx, .cjs, .mjs, .css files:
/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */
```

```bash
# For .sh files (after shebang if present):
# Copyright OpenSearch Contributors
# SPDX-License-Identifier: Apache-2.0
```

```html
<!-- For .html files (after DOCTYPE if present): -->
<!--
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
-->
```

**DCO Signoff (REQUIRED for all commits):**
All commits MUST include a DCO (Developer Certificate of Origin) signoff. This is enforced by CI.

```bash
# Use -s flag when committing
git commit -s -m "feat: your commit message"

# Or use -S for GPG signing + signoff
git commit -s -S -m "feat: your commit message"
```

The signoff line will be added automatically:
```
Signed-off-by: Your Name <your.email@example.com>
```

To fix commits missing signoff, use:
```bash
# Amend last commit
git commit --amend -s --no-edit

# Rebase and signoff all commits (interactive)
git rebase -i HEAD~N  # then use 'edit' and run: git commit --amend -s --no-edit && git rebase --continue
```

