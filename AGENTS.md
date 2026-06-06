# AGENT.md

This file provides guidance to AI agents when working with code in this repository.

## Project Overview

AgentEval is an evaluation framework for Root Cause Analysis (RCA) agents using "Golden Path" trajectory comparison. An LLM Judge (AWS Bedrock Claude) evaluates agent actions against expected trajectories to score performance.

## Build Commands

```bash
# Install dependencies
npm install

# Development - run both servers simultaneously
npm run dev           # Frontend at http://localhost:4000
npm run dev:server    # Backend at http://localhost:4001

# Build and test
npm run build         # TypeScript check + Vite build
npm test              # Run Jest tests
npm test -- --watch   # Watch mode
npm test -- path/to/file.test.ts  # Single test file
```

## Before Committing

Always run tests before committing changes:

```bash
npm test              # Run all tests - must pass before pushing
```

Update `CHANGELOG.md` under `## [Unreleased]` with your changes:
- `### Added` - New features
- `### Changed` - Changes to existing functionality
- `### Fixed` - Bug fixes
- `### Security` - Security fixes

## Before Raising a PR

All PRs are validated by CI. Fix these locally before pushing to avoid failed checks:

```bash
# 1. Build and test
npm run build:all && npm run test:all

# 2. Security scan - no high/critical vulnerabilities
npm audit --audit-level=high

# 3. Verify DCO signoff on all commits
git log origin/main..HEAD | grep "Signed-off-by"
# If missing, fix with: git rebase origin/main --signoff

# 4. Verify changelog is updated
grep -A5 "## \[Unreleased\]" CHANGELOG.md
```

**Pre-PR Checklist:**
- [ ] All commits have DCO signoff (`git commit -s`)
- [ ] `CHANGELOG.md` updated under `## [Unreleased]` with PR link
- [ ] `npm run build:all` succeeds
- [ ] `npm run test:all` passes
- [ ] `npm audit --audit-level=high` reports no vulnerabilities
- [ ] New source files have SPDX license headers

### CLI: Import Test Cases from JSON

The `benchmark` command supports importing test cases from a JSON file via `-f` / `--file`:

```bash
# Import and benchmark in one step
npx @opensearch-project/agent-health benchmark -f ./test-cases.json -a my-agent

# With a custom benchmark name
npx @opensearch-project/agent-health benchmark -f ./test-cases.json -n "My Benchmark" -a my-agent

# Export produces import-compatible JSON (round-trip support)
npx @opensearch-project/agent-health export -b my-benchmark -o test-cases.json
```

The JSON file must be an array of test case objects with required fields: `name`, `category`, `difficulty`, `initialPrompt`, `expectedOutcomes`.

### Code-based test SDK (experimental)

For more expressive test cases (deterministic checks + targeted LLM judging + per-matcher results), use the code SDK:

```javascript
const { test, expect } = require('@opensearch-project/agent-health');

test('rca-coherent', { prompt: 'Why is X failing?' }, async ({ result, judge }) => {
  expect(result.trajectory).to.haveCalledTool('search_logs');
  expect(result).to.haveCompletedWithin(60_000);
  await judge(result, 'identifies the root cause');
});
```

Full guide: [docs/SDK.md](docs/SDK.md). Samples: [evals/demo.eval.js](evals/demo.eval.js).

The SDK is **experimental** — the API surface may change in a minor release without a deprecation cycle. Set `AH_SUPPRESS_EXPERIMENTAL=1` to silence the runtime notice.

## Environment Setup

Copy `.env.example` to `.env`. Key variables:

- `PORT` - Backend port (default: 4001)
- `MLCOMMONS_ENDPOINT` - ML-Commons agent streaming endpoint
- `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` - Bedrock credentials
- `OPENSEARCH_STORAGE_*` - OpenSearch cluster for persistence
- `OPENSEARCH_LOGS_*` - OpenSearch cluster for logs/traces

## Architecture

> **Full documentation:** See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for detailed architecture patterns.
> **Performance optimization:** See [docs/PERFORMANCE.md](docs/PERFORMANCE.md) for performance optimizations in the Benchmark Runs Overview page.

### Two-Server Architecture

- **Frontend (Vite + React)**: Port 4000 (development) - UI for running evaluations
- **Backend (Express)**: Port 4001 - Proxy for Bedrock API calls (browser cannot call Bedrock directly)
- **Production**: Port 4001 serves both frontend and backend

### Core Data Flow

```
User selects agent + test case
    → Agent streams AG-UI events via SSE
    → AGUIToTrajectoryConverter builds TrajectoryStep[]
    → Backend calls Bedrock Judge for evaluation
    → Report stored (localStorage or OpenSearch)
```

### Services Layer (`services/`)

| Directory     | Purpose                                                                                                                                |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `agent/`      | AG-UI protocol handling: SSE streaming (`sseStream.ts`), event conversion (`aguiConverter.ts`), payload building (`payloadBuilder.ts`) |
| `evaluation/` | Orchestrates evaluation runs (`index.ts`), Bedrock judge client with retry (`bedrockJudge.ts`)                                         |
| `storage/`    | Async storage with OpenSearch backend (`asyncRunStorage.ts`, `asyncTestCaseStorage.ts`, `asyncExperimentStorage.ts`)                   |
| `traces/`     | Trace transformations: Flow view, Timeline view, comparison alignment, tool similarity grouping                                        |
| `opensearch/` | Log fetching from OpenSearch clusters                                                                                                  |

### Key Types (`types/index.ts`)

- `TestCase` - Use case definition with versioned content and expected trajectory
- `TestCaseRun` (alias: `EvaluationReport`) - Result of running a test case
- `TrajectoryStep` - Single step in agent execution (tool_result, assistant, thinking, etc.)
- `Experiment` / `ExperimentRun` - Batch evaluation configurations
- `AgentConfig` - Agent endpoint and authentication configuration

### AG-UI Event Processing

The `AGUIToTrajectoryConverter` class accumulates streaming events into trajectory steps:

```
TOOL_CALL_START → TOOL_CALL_ARGS (deltas) → TOOL_CALL_END → TOOL_CALL_RESULT
```

Events are converted to `TrajectoryStep` objects with types: `tool_result`, `assistant`, `action`, `response`, `thinking`.

### Path Aliases

Use `@/` prefix for imports (configured in tsconfig.json and vite.config.ts):

```typescript
import { EvaluationReport } from "@/types";
import { runEvaluation } from "@/services/evaluation";
```

### Environment Variables in Frontend

Environment variables are exposed via `vite.config.ts` using `loadEnv()`. Access via `import.meta.env.VARIABLE_NAME`. The `lib/config.ts` file provides typed access through `ENV_CONFIG`.

## Agent Types

### ML-Commons Agent (AG-UI Protocol)

- Uses SSE streaming via OpenSearch ML plugin
- Requires MCP Server running on port 3030
- Headers configured via `MLCOMMONS_HEADER_*` env vars

### Langgraph Agent

- Simpler local agent without ML-Commons dependencies
- Endpoint configured via `LANGGRAPH_ENDPOINT`

## OpenTelemetry Instrumentation Standards

**CRITICAL:** All agents integrating with Agent Health MUST follow OpenTelemetry semantic conventions for instrumentation data.

### Required Semantic Conventions

Agent instrumentation MUST use the standardized attributes defined in:
- **Gen AI Conventions**: https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/

### Key Requirements

1. **Span Naming**: Follow the `gen_ai.operation.name` convention
   - Use standard operation types: `chat`, `completion`, `embedding`, etc.

2. **Required Attributes**:
   - `gen_ai.system` - AI system identifier (e.g., `openai`, `anthropic`, `aws.bedrock`)
   - `gen_ai.request.model` - Model identifier
   - `gen_ai.operation.name` - Operation type
   - `gen_ai.request.temperature` - Sampling temperature (if applicable)
   - `gen_ai.request.max_tokens` - Maximum tokens requested
   - `gen_ai.usage.prompt_tokens` - Input token count
   - `gen_ai.usage.completion_tokens` - Output token count

3. **Span Hierarchy**:
   - Root span: Agent execution
   - Child spans: LLM calls, tool invocations, retrieval operations
   - Follow parent-child relationships for accurate trace visualization

4. **Tool Invocation Spans**:
   - Use `gen_ai.tool.name` for tool identification
   - Include `gen_ai.tool.description` for context
   - Capture tool input/output as span events

### Example Instrumentation

```python
from opentelemetry import trace
from opentelemetry.trace import SpanKind

tracer = trace.get_tracer(__name__)

with tracer.start_as_current_span(
    "chat",
    kind=SpanKind.CLIENT,
    attributes={
        "gen_ai.system": "anthropic",
        "gen_ai.request.model": "claude-sonnet-4",
        "gen_ai.operation.name": "chat",
        "gen_ai.request.temperature": 0.7,
        "gen_ai.request.max_tokens": 4096,
    }
) as span:
    response = call_llm(prompt)

    span.set_attributes({
        "gen_ai.usage.prompt_tokens": response.usage.input_tokens,
        "gen_ai.usage.completion_tokens": response.usage.output_tokens,
    })
```

### Why This Matters

- **Trace Visualization**: Agent Health categorizes spans based on these attributes
- **Metrics Calculation**: Token counts and costs are computed from semantic attributes
- **Cross-Agent Comparison**: Standardized attributes enable fair comparisons
- **Debugging**: Consistent naming helps identify issues across different agents

## Trace correlation conventions

When agent-health runs a test case it emits its own `test_case` eval span. To make
the agent's spans correlate with that eval span (so the run-report Traces tab shows
one unified trace tree), agents and connectors follow this layered convention.

### Strategy A — W3C trace context (preferred, single trace tree)

The `test_case` span is started **before** the connector invokes the agent and is
made the active OTel context. Connectors then propagate the context to the agent:

- **Subprocess agents** (Claude Code, Kiro, Pi, anything via `SubprocessConnector`)
  set `traceContext.propagateEnv = true`. The base class injects a W3C
  `TRACEPARENT=00-<traceId>-<spanId>-01` env var into the spawned process.
- **HTTP/SSE agents** (Observio AGUI, REST, OpenAI-compatible, LangGraph)
  set `traceContext.propagateHeader = true`. The base class injects a `traceparent`
  HTTP header via `propagation.inject(context.active(), headers)`.

Agents whose OTel SDK respects W3C trace context (which includes upstream Claude
Code, Anthropic Bedrock SDKs, all standard `@opentelemetry/sdk-*` exporters)
adopt the eval span as parent context automatically — their root span (e.g.
`claude_code.interaction`) becomes a child of `test_case`, sharing the same
`traceId`. Looking up by that `traceId` returns the whole tree.

### Strategy B — `gen_ai.request.id` attribute (loose link, separate trees)

For agents we instrument ourselves but that don't propagate W3C context, set the
span attribute `gen_ai.request.id` equal to agent-health's `runId`. The eval span
already carries this attribute (`ATTR_AGENT_HEALTH_AGENT_RUN_ID`), so an
OpenSearch `terms` query unions both. SubprocessConnector also exports
`AGENT_EVAL_RUN_ID=<runId>` to the child env as the conventional source for this
attribute.

### Strategy C — service-name + time-window (always-on fallback)

For closed-source / 3rd-party agents that do neither A nor B, register the
agent's OpenSearch `service.name` on the connector via
`traceContext.serviceName`. The run-report Traces tab **always** issues this
clause unioned with A/B — the API receives `agents: [{serviceName, startedAt,
endedAt}]` derived from the connector's `traceServiceName` (or the protocol→
name convention map) and the run's wall-clock window. The OpenSearch query
builder unions all three clauses via `bool.should` so spans matching any
strategy are returned without duplication.

This strategy was originally opt-in via a UI checkbox — the noise risk it can
surface is real (concurrent runs of the same agent on overlapping windows,
other users on a shared OTel cluster running the same agent, long-lived agent
sessions that cross run boundaries) — but in practice the run-report Traces
tab landed on a near-empty trace tree by default until the user noticed the
toggle. Empty-by-default was a worse cost than the noise risk, so Strategy C
is now always-on. Users who need stricter isolation can override the
connector's `serviceName` to a tenant-scoped value.

Window derivation:
  - When `report.performanceMetrics.durationMs` is set: `[timestamp −
    durationMs − 60s, timestamp + 60s]` (tight bound).
  - When `durationMs` is missing (older runs persisted before that field):
    fall back to a 30-minute lookback. Wide enough for any realistic agent
    run, narrow enough to keep cross-team noise minimal.

Default per-connector `serviceName` values:

| connectorType    | serviceName              |
|------------------|--------------------------|
| `claude-code`    | `claude-code-agent`      |
| `kiro`           | `kiro-agent`             |
| `pi`             | `pi-agent`               |
| `agui-streaming` | `observio-sample-agent`  |

Users can override per-agent in `agent-health.config.ts`:

```ts
{
  key: 'my-agent',
  connectorType: 'subprocess',
  connectorConfig: {
    traceContext: {
      propagateEnv: true,
      serviceName: 'my-custom-otel-service-name',
    },
  },
}
```

### Validation

Use the Agent Health trace viewer to validate your instrumentation:
1. Run an evaluation with `useTraces: true`
2. View the trace in the Traces page
3. Verify spans have correct `gen_ai.*` attributes
4. Check that span hierarchy matches expected flow

### Additional Resources

- [OpenTelemetry Gen AI Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
- [OpenTelemetry Span Attributes Registry](https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/)
- [Agent Health Trace Categorization](./services/traces/spanCategorization.ts)

## Testing

Tests use Jest with ts-jest. Test files are in `__tests__/` directories or named `*.test.ts`.

```bash
npm test                                    # All tests
npm run test:unit                           # Unit tests only
npm run test:integration                    # Integration tests only
npm test -- --coverage                      # With coverage report
npm test -- services/storage/__tests__/     # Directory
npm test -- --testNamePattern="pattern"     # By name
```

### Coverage

Coverage reports are generated in the `coverage/` directory. HTML report available at `coverage/lcov-report/index.html`.

CI enforces minimum coverage thresholds configured in `jest.config.cjs`:
- **Lines**: 90%
- **Statements**: 90%
- **Functions**: 80%
- **Branches**: 80%

### Integration Test Cleanup

**Always delete data created during integration tests.** Integration tests that call the storage API write JSON files to `agent-health-data/` on disk (the file-based storage backend). If tests don't clean up, these files accumulate in the working directory and appear as untracked files in git.

Track every created ID and delete it in `afterAll`:

```typescript
const createdTestCaseIds: string[] = [];
const createdBenchmarkIds: string[] = [];

afterAll(async () => {
  for (const id of createdTestCaseIds) {
    await fetch(`${BASE_URL}/api/storage/test-cases/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
  }
  for (const id of createdBenchmarkIds) {
    await fetch(`${BASE_URL}/api/storage/benchmarks/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
  }
});

// In each test, push created IDs immediately after creation:
const result = await client.bulkCreateTestCases(testCases);
createdTestCaseIds.push(...result.testCases.map(tc => tc.id));
```

The `agent-health-data/` directory is gitignored for this reason — it is runtime state, not source code.

## CI/CD

GitHub Actions workflows are configured in `.github/workflows/`:

| Workflow | Purpose |
|----------|---------|
| `ci.yml` | Main CI - builds, tests, coverage, security scan |
| `dco.yml` | DCO signoff verification |
| `npm-publish.yml` | Publish to npm registry |
| `backport.yml` | Backport PRs to older branches |
| `stale.yml` | Mark and close stale issues/PRs |
| `dependency-review.yml` | Review dependency changes |
| `links-checker.yml` | Check for broken links |

### Required Checks

All PRs must pass:
1. **Build and Tests** - Builds successfully on Node 18, 20, 22
2. **Coverage Threshold** - Minimum 90% line coverage
3. **License Headers** - All source files must have SPDX headers
4. **Security Scan** - No high/critical vulnerabilities (npm audit)
5. **DCO Signoff** - All commits signed with DCO

### Commit Guidelines

Use conventional commits with DCO signoff:
```bash
git commit -s -m "feat: add new feature"
git commit -s -m "fix: resolve bug in trace view"
git commit -s -m "test: add tests for storage service"
```

## UI Components

- Uses shadcn/ui components in `components/ui/`
- TailwindCSS for styling with dark theme
- React Router with HashRouter for navigation
- Recharts and ECharts for visualizations
- React Flow for DAG-based trace visualization

### Trace Visualization Views

| View | Component | Description |
|------|-----------|-------------|
| Timeline | `TraceTimelineChart.tsx` | Hierarchical span tree with duration bars |
| Flow | `TraceFlowView.tsx` | DAG-based visualization using React Flow |

### Key Components

- `TracesPage.tsx` - Live trace monitoring with auto-refresh
- `TraceVisualization.tsx` - Unified wrapper for all trace views
- `TraceFullScreenView.tsx` - Full-screen mode for detailed analysis
- `TraceFlowComparison.tsx` - Side-by-side trace comparison
