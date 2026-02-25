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

### Key Architecture Principle

**All clients (CLI, UI) access OpenSearch through the server HTTP API.** Never bypass the server to access OpenSearch directly from CLI commands. This ensures consistent behavior and single source of truth. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for details.

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
- `asyncBenchmarkStorage.ts`: Benchmark management
- `asyncRunStorage.ts`: Evaluation run persistence
- Data stored in OpenSearch indexes (configured via `OPENSEARCH_STORAGE_*` env vars)

**Trace Services** (`services/traces/`):
- `tracePoller.ts`: Polls for traces with configurable delay (traces take ~5 min to propagate)
- `index.ts`: Trace fetching and metrics calculation from OTel spans
- `traceGrouping.ts`: Groups flat spans by traceId with summary statistics for table view
- `spanCategorization.ts`: Categorizes spans by type (AGENT, LLM, TOOL, etc.) based on OTEL conventions

**Client Services** (`services/client/`):
- `evaluationApi.ts`: Browser-side API client for server-mediated evaluation (SSE streaming)
- `index.ts`: Barrel exports for all client API modules

**Other Services**:
- `comparisonService.ts`: Aggregate metrics and side-by-side comparison logic
- `benchmarkRunner.ts`: Batch execution of test cases across runs
- `metrics.ts`: Token/cost calculations from trace data

**Connector Services** (`services/connectors/`):
- `types.ts`: Connector interfaces (`AgentConnector`, `ConnectorRequest`, `ConnectorResponse`)
- `registry.ts`: Singleton registry for connector lookup (`connectorRegistry.get()`, `getForAgent()`)
- `base/BaseConnector.ts`: Abstract base class with auth header building
- `agui/AGUIStreamingConnector.ts`: AG-UI SSE streaming protocol
- `rest/RESTConnector.ts`: Non-streaming REST API calls
- `subprocess/SubprocessConnector.ts`: CLI tool invocation via child process
- `claude-code/ClaudeCodeConnector.ts`: Claude Code CLI (specialized subprocess connector)
- `mock/MockConnector.ts`: Demo agent for testing
- `index.ts`: Browser-safe exports (no Node.js dependencies)
- `server.ts`: All connectors including Node.js-only (subprocess, claude-code)

### Connector System

The connector system provides a pluggable abstraction for different agent communication protocols:

**Built-in Connectors:**
| Connector | Protocol | Use Case |
|-----------|----------|----------|
| `agui-streaming` | AG-UI SSE | ML-Commons agents (default) |
| `rest` | HTTP POST | Non-streaming REST APIs |
| `subprocess` | CLI | Command-line tools |
| `claude-code` | Claude CLI | Claude Code agent comparison |
| `mock` | In-memory | Demo and testing |

**Using Connectors:**
```typescript
// Get connector for an agent
import { connectorRegistry } from '@/services/connectors';
const connector = connectorRegistry.getForAgent(agentConfig);

// Execute evaluation
const response = await connector.execute(endpoint, request, auth, onProgress);
```

**Creating Custom Connectors:**
```typescript
import { BaseConnector } from '@/services/connectors';

class CustomConnector extends BaseConnector {
  readonly type = 'custom' as const;
  readonly name = 'My Custom Agent';
  readonly supportsStreaming = true;

  async execute(endpoint, request, auth, onProgress) {
    // Your protocol implementation
  }
}

// Register connector
connectorRegistry.register(new CustomConnector());
```

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
      connectorType: "agui-streaming", models: ["claude-sonnet-4"] }
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
- `commands/benchmark.ts`: Run full benchmark across multiple test cases and agents
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
- `OPENSEARCH_LOGS_*`: Logs cluster for agent execution logs (features degrade if missing)
- `MLCOMMONS_HEADER_*`: Headers for ML-Commons agent data source access (see [docs/ML-COMMONS-SETUP.md](docs/ML-COMMONS-SETUP.md))

### Data Model

#### Entity Identification

| Entity | System ID Format | Natural Key | Unique? | OpenSearch Doc ID |
|--------|-----------------|-------------|---------|-------------------|
| Test Case | `tc-{timestamp}-{random}` | `name` | ID only | `{id}-v{version}` |
| Benchmark | `bench-{timestamp}-{random}` | `name` | ID only | `{id}` |
| Run | `run-{timestamp}-{random}` | `name` | ID only | Embedded in benchmark |
| TestCaseRun | `report-{timestamp}-{random}` | N/A | ID only | `{id}` |

**Note:** Names are NOT enforced as unique. Multiple entities can have the same name.

#### Versioning Strategy

| Entity | Strategy | Triggers New Version | Document Storage |
|--------|----------|---------------------|------------------|
| Test Case | Immutable versions | Any content change | New doc: `{id}-v{n+1}` |
| Benchmark | Selective | testCaseIds change only | Single doc, versions array |
| Run | Not versioned | N/A | Embedded in benchmark |

#### Key Relationships

- **Benchmark → Test Cases**: `benchmark.testCaseIds[]` references `testCase.id`
- **Benchmark → Runs**: `benchmark.runs[]` embeds run configurations
- **Run → TestCaseRun**: `run.results[testCaseId].reportId` references `testCaseRun.id`
- **TestCaseRun → Benchmark**: `testCaseRun.experimentId` references `benchmark.id`

#### OpenSearch Indexes

| Index | Entity | Document ID Format |
|-------|--------|-------------------|
| `evals_test_cases` | Test Case | `{testCaseId}-v{version}` |
| `evals_benchmarks` | Benchmark | `{benchmarkId}` |
| `evals_runs` | TestCaseRun | `{reportId}` |
| `evals_analytics` | Analytics | `analytics-{runId}` |

## Coding Style Conventions

### Backend Patterns

**SSE Streaming for Long-Running Operations**
- Use Server-Sent Events for operations that take time (benchmark execution, agent streaming)
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
- `BenchmarkRun`: full entity with system-added id, createdAt, status, results

**Event Types with Discriminator**
- Include `type` field in event interfaces for switch statements
- Separate types: `BenchmarkProgress`, `BenchmarkStartedEvent`

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
- `export { executeBenchmarkRun, cancelBenchmarkRun }` not namespace objects

## Testing

All tests are centralized in the `tests/` folder, mirroring the source structure. Jest config in [jest.config.cjs](jest.config.cjs).

### Test Directory Structure

```
tests/
├── unit/                    # Unit tests (mock all dependencies)
│   ├── cli/                 # CLI command tests
│   ├── lib/                 # Library utility tests
│   ├── server/              # Backend server tests
│   │   ├── config/
│   │   ├── constants/
│   │   ├── prompts/
│   │   ├── routes/
│   │   │   └── storage/
│   │   └── services/
│   │       └── storage/
│   └── services/            # Frontend service tests
│       ├── agent/
│       ├── client/
│       ├── evaluation/
│       ├── opensearch/
│       ├── storage/
│       └── traces/
└── integration/             # Integration tests (real services)
    └── services/
        ├── storage/
        └── traces/
```

### Writing Tests

**File naming:** `<module-name>.test.ts` - place in `tests/unit/<path-mirroring-source>/`

**Required header:**
```typescript
/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */
```

**Basic test structure:**
```typescript
/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { functionToTest } from '@/path/to/module';

// Mock dependencies - use @/ path alias
jest.mock('@/services/storage/opensearchClient', () => ({
  benchmarkStorage: {
    getAll: jest.fn(),
    getById: jest.fn(),
  },
}));

describe('ModuleName', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('functionToTest', () => {
    it('should handle normal case', () => {
      // Arrange
      const input = 'test';

      // Act
      const result = functionToTest(input);

      // Assert
      expect(result).toBe('expected');
    });

    it('should handle edge case', () => {
      // Test edge cases, error handling, etc.
    });
  });
});
```

### Import Conventions

**Always use `@/` path alias** - never relative paths like `../`:

```typescript
// ✅ Correct - use @/ alias
import { myFunction } from '@/services/storage/asyncRunStorage';
jest.mock('@/server/services/opensearchClient');

// ❌ Wrong - relative paths break when tests move
import { myFunction } from '../asyncRunStorage';
jest.mock('../../../services/opensearchClient');
```

**Common import paths:**
| Module | Import Path |
|--------|-------------|
| Types | `@/types` |
| Server routes | `@/server/routes/<name>` |
| Server services | `@/server/services/<name>` |
| Frontend services | `@/services/<category>/<name>` |
| Lib utilities | `@/lib/<name>` |
| CLI commands | `@/cli/commands/<name>` |

### Global Mocks (`__mocks__/`)

Some modules use `import.meta.url` or browser-only APIs that don't work in Jest. These are globally mocked via `__mocks__/` and `moduleNameMapper` in `jest.config.cjs`:
- `__mocks__/@/lib/config.ts` - config loader (avoids dynamic `import()`)
- `__mocks__/@/server/services/configService.ts` - server config service
- `__mocks__/@/server/utils/version.ts` - version utility
- `__mocks__/dagre.ts`, `__mocks__/xyflow-react.ts` - browser-only graph libraries

If you add a module that uses `import.meta.url`, you'll need a mock here and a corresponding `moduleNameMapper` entry in `jest.config.cjs`.

### Mocking Patterns

**Mock external modules:**
```typescript
jest.mock('@/services/storage/opensearchClient', () => ({
  benchmarkStorage: {
    getAll: jest.fn().mockResolvedValue([]),
    getById: jest.fn().mockResolvedValue(null),
  },
  isStorageConfigured: true,
}));
```

**Mock with type safety:**
```typescript
import { benchmarkStorage } from '@/services/storage/opensearchClient';

const mockStorage = benchmarkStorage as jest.Mocked<typeof benchmarkStorage>;
mockStorage.getAll.mockResolvedValue([mockBenchmark]);
```

**Dynamic require for module re-import:**
```typescript
it('should handle config changes', () => {
  jest.resetModules();
  process.env.MY_VAR = 'new-value';

  const { myConfig } = require('@/lib/config');
  expect(myConfig).toBe('new-value');
});
```

**Suppress console output:**
```typescript
beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
```

### Testing Async Code

**Async/await pattern:**
```typescript
it('should fetch data', async () => {
  mockFetch.mockResolvedValue({ data: 'test' });

  const result = await fetchData();

  expect(result.data).toBe('test');
});

it('should handle errors', async () => {
  mockFetch.mockRejectedValue(new Error('Network error'));

  await expect(fetchData()).rejects.toThrow('Network error');
});
```

**SSE stream testing:**
```typescript
it('should handle SSE stream', async () => {
  const mockReader = {
    read: jest.fn()
      .mockResolvedValueOnce({ done: false, value: encoder.encode('data: {"type":"start"}\n\n') })
      .mockResolvedValueOnce({ done: true }),
  };

  // Test stream consumption
});
```

### Coverage Thresholds

CI enforces these minimums (configured in `jest.config.cjs`):
- **Lines: 90%**
- **Statements: 90%**
- **Functions: 80%**
- **Branches: 80%**

**Check coverage locally:**
```bash
npm test -- --coverage
open coverage/lcov-report/index.html  # View HTML report
```

### Running Tests

```bash
npm test                              # All tests
npm run test:unit                     # Unit tests only
npm run test:integration              # Integration tests only
npm test -- --coverage                # With coverage report
npm test -- tests/unit/services/      # Specific directory
npm test -- --testNamePattern="fetch" # By test name
npm test -- --watch                   # Watch mode
```

### Test Categories

**Unit tests** (`tests/unit/`):
- Mock ALL external dependencies
- Test one function/class at a time
- Fast execution (<100ms per test)
- No network/file system access

**Integration tests** (`tests/integration/`):
- Test multiple modules together
- May use real services (OpenSearch, etc.)
- Name files `*.integration.test.ts`
- Longer timeout allowed (30s)

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

When preparing to raise a PR against the upstream repository (change remote from origin if different) :

1. **Fetch latest from upstream:**
   ```bash
   git fetch origin main
   ```

2. **Create a clean branch from upstream main:**
   ```bash
   git checkout -b <branch-name> origin/main
   ```

3. **Cherry-pick your commits** (if working from a development branch):
   ```bash
   git cherry-pick <oldest-commit>^..<newest-commit>
   ```

4. **Verify DCO sign-off on all commits:**
   ```bash
   # Check if all commits have sign-off
   git log --format="%h %s" origin/main..HEAD
   git log origin/main..HEAD | grep -c "Signed-off-by"

   # If any commits are missing sign-off, rebase with --signoff
   git rebase origin/main --signoff
   ```

5. **Add changelog entry (REQUIRED - CI will fail without this):**
   - Update `CHANGELOG.md` for EVERY commit/PR - this is enforced by CI
   - Add entry under "Unreleased" section with appropriate category:
     - `Added` - New features, commands, components
     - `Changed` - Modifications to existing functionality
     - `Fixed` - Bug fixes
     - `Removed` - Removed features or deprecated code
     - `Security` - Security-related fixes
   - Include PR link in format `([#PR_NUMBER](https://github.com/opensearch-project/agent-health/pull/PR_NUMBER))`
   ```markdown
   ## [Unreleased]
   ### Added
   - CLI commands for headless agent evaluation ([#33](https://github.com/opensearch-project/agent-health/pull/33))

   ### Fixed
   - Memory leak in benchmark timeout handling ([#33](https://github.com/opensearch-project/agent-health/pull/33))
   ```

6. **Push to your fork (change remote name as needed):**
   ```bash
   git push -u fork <branch-name>
   ```

7. **Create PR** via GitHub UI or CLI:
   ```bash
   gh pr create --repo opensearch-project/agent-health --base main
   ```

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

## Pending Features

The following features are planned but not yet implemented:

### CLI Enhancements
- `compare` command: Side-by-side comparison of agent results
- JSON/Table/Markdown output formats for all commands
- Parallel test case execution with `--parallel` flag

### Connector SDK
- Python connector SDK (similar to Playwright's Python support)
- Subprocess protocol for language-agnostic connectors
- WebSocket connector for bidirectional streaming
- gRPC connector for high-performance scenarios

### Agent Comparison Features
- Automated A/B testing between agent versions
- Cost estimation and comparison across agents
- Latency distribution analysis
- Trajectory similarity scoring

### Observability
- OpenTelemetry integration for connector spans
- Prometheus metrics export
- Structured logging with correlation IDs

