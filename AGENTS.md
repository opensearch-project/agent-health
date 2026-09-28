# AGENT.md

This file provides guidance to AI agents when working with code in this repository.

## Project Overview

Agent Health is an evaluation and observability framework for AI agents of any kind — coding assistants, ops/RCA agents, customer-support agents, data-analysis agents, retrieval/discovery agents, and multi-agent workflows — using "Golden Path" trajectory comparison. An LLM Judge (AWS Bedrock Claude) evaluates agent actions against expected trajectories to score performance.

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

# 5. Renamed/moved a file? Repoint every markdown reference to it, or
#    link-check (lychee over **/*.md) fails on the now-dead relative link.
#    CHANGELOG.md links to source/test paths, so a rename there is the usual culprit.
git grep -n "old/path/to/renamed-file" -- '*.md'   # must return nothing
```

**Pre-PR Checklist:**
- [ ] All commits have DCO signoff (`git commit -s`)
- [ ] `CHANGELOG.md` updated under `## [Unreleased]` with PR link
- [ ] `npm run build:all` succeeds
- [ ] `npm run test:all` passes
- [ ] `npm audit --audit-level=high` reports no vulnerabilities
- [ ] New source files have SPDX license headers
- [ ] Renamed/moved files: no `.md` (esp. `CHANGELOG.md`) still links the old path (`link-check` job fails otherwise)

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

Full guide: [docs/SDK.md](docs/SDK.md). Samples: [examples/eval-files/demo.eval.js](examples/eval-files/demo.eval.js).

The SDK is **experimental** — the API surface may change in a minor release without a deprecation cycle. Set `AH_SUPPRESS_EXPERIMENTAL=1` to silence the runtime notice.

## Environment Setup

Copy `.env.example` to `.env`. Key variables:

- `PORT` - Backend port (default: 4001)
- `MLCOMMONS_ENDPOINT` - ML-Commons agent streaming endpoint
- `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` - Bedrock credentials
- `OPENSEARCH_STORAGE_*` - OpenSearch cluster for persistence
- `OPENSEARCH_LOGS_*` - OpenSearch cluster for logs/traces

## Configuration model (config v2)

Two config planes; which one is authoritative is decided by **presence of an authored config file**.

- **`agent-health.config.ts`** (project `<cwd>/` or user `~/.agent-health/`) — the file a human authors: agents, connectors, models, judge, reporters, telemetry, and optionally `storage` / `observability` clusters. **The app never writes this file.**
- **`.agent-health/state.json`** (project + user scoped, gitignored) — runtime state the Settings UI writes (`storage`/`observability`/`customAgents`/`debug`/`remoteServers`). Machine-managed; don't hand-edit.
- **`.env` / `OPENSEARCH_*`** — secrets and overrides.

**Modes:**
- **code-first** (any `agent-health.config.{ts,js,mjs}` present): the `.ts` + `.env` are authoritative; `.agent-health/state.json` is **ignored entirely**; the Settings data-source / remote-server / debug **write endpoints return `409`** ("managed by agent-health.config.ts"). Test Connection is still allowed (read-only probe; writes nothing).
- **ui-first** (no authored config): `.agent-health/state.json` is the writable store; Save persists there (project scope by default; `--global` / user scope is opt-in).

**Resolution** for storage/observability (`getConfigStatus` order is `ts > state > env`):
- code-first: `.ts` → `OPENSEARCH_*` env → file-storage fallback (state ignored)
- ui-first: project `.agent-health/state.json` → user `~/.agent-health/state.json` → `OPENSEARCH_*` env → file fallback

**What writes what:** Test Connection → nothing (probe). Save → `.agent-health/state.json` in ui-first, or `409` in code-first. Changing a cluster in code-first = edit the `.ts` + restart. Legacy `agent-health.yaml` / `agent-health.config.json` are migrated once to `.agent-health/state.json` at startup (originals → `*.backup`); if a `.ts` is also present the migrated clusters are ignored and a startup warning says so.

Human-facing details: [docs/CONFIGURATION.md](docs/CONFIGURATION.md). Design + file-by-file plan: [issue #271](https://github.com/opensearch-project/agent-health/issues/271).

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
   - `gen_ai.provider.name` (formerly `gen_ai.system`, deprecated in semconv 1.37 — still accepted as an alias) - GenAI provider identifier (e.g., `openai`, `anthropic`, `aws.bedrock`)
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
        "gen_ai.provider.name": "anthropic",
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

### Strategy B — `agent_health.run.id` attribute (loose link, separate trees)

For agents we instrument ourselves but that don't propagate W3C context, set the
span attribute `agent_health.run.id` equal to agent-health's `runId`. The eval
span already carries this attribute (`ATTR_AGENT_HEALTH_AGENT_RUN_ID`), so an
OpenSearch `terms` query unions both. SubprocessConnector also exports
`AGENT_EVAL_RUN_ID=<runId>` to the child env as the conventional source for this
attribute.

> Note: this attribute lives in Agent Health's **own** `agent_health.*` namespace
> on purpose. It used to be stamped on the OpenTelemetry-reserved
> `gen_ai.request.id` key, but `gen_ai.request.id` is not a registered Gen AI
> semantic-convention attribute (the `gen_ai.request.*` namespace is for request
> parameters), and the OTEL naming spec advises against adding app-specific keys
> under an existing OTEL namespace. Strategy A (W3C trace context) is the primary
> correlation; this is the loose fallback.

> **Also emitted: the OTEL-standard `gen_ai.conversation.id`.** Alongside
> `agent_health.run.id`, our producers (the eval `test_case` span and the
> observio sample agent) stamp the registered (incubating) Gen AI attribute
> `gen_ai.conversation.id` — "the unique identifier for a conversation
> (session, thread)" — set to the same agent run id. The trace + metrics
> correlation queries match **either** `agent_health.run.id` **or**
> `gen_ai.conversation.id`, so spans that adopt the standard attribute correlate
> without any app-specific key. Use `gen_ai.conversation.id` going forward; the
> `agent_health.run.id` mirror stays for backward compatibility.

### Strategy D — `session.id` attribute (precise, real-world adopted)

Many subprocess agents emit neither W3C context nor our run id, but **do** stamp
the OTEL `session.id` attribute on every span of a run (Claude Code is the
motivating case: 100% of its spans carry one stable `session.id`). When the
connector captures that id, Strategy D correlates **precisely** on
`attributes.session.id` — far tighter than the service-name + time-window
fallback (Strategy C).

- **Capture:** `SubprocessConnector` exposes an `extraResultMetadata(state)`
  hook; `ClaudeCodeConnector` reads `session_id` from the stream-json events
  into the **per-invocation** execution state and returns `{ sessionId }`.
  The runner persists it as `report.sessionId`. The registry shares ONE
  connector instance across all concurrent runs, so nothing captured while
  parsing a child's output may live on the instance — every streaming hook
  (`parseStreamingOutput` / `parseStderrChunk` / `onBeforeStreamEnd` /
  `extraResultMetadata`) receives a `SubprocessExecutionState` created by
  `execute()`; subclasses extend it via `createExecutionState()`. (An earlier
  instance-field capture cross-wired 11/62 reports of a concurrent run — each
  then judged on a sibling case's spans.)
- **Correlate:** `buildJudgeAgentsHints(report)` adds `sessionId` to each
  `agents` hint, and the run-report Traces tab adds it to its `windowAgents`.
  The query builder turns each hint into `(session.id == sessionId) OR
  (service.name + window)`, unioned with A/B. So a span is returned if it
  matches **any** strategy, without duplication.
- **Why not `gen_ai.response.id`?** That's a per-LLM-call provider id (a run has
  many), so it can't correlate a whole run. `session.id` is the per-run id with
  real adoption today; `gen_ai.conversation.id` is the standard we *emit*.

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

### Test levels — required by default for every feature and bug fix

Do not stop at unit tests. Each change ships with regression tests at the levels it touches:

- **Unit** (`tests/unit/`) — logic/engine with mocked deps.
- **Integration** (`tests/integration/`, `npm run test:integration`) — the real server/API path (boot `createApp()` or hit a running backend, assert the HTTP response). Required for anything touching config resolution, storage, routes, migration, or persisted state. Clean up any data created (see Integration Test Cleanup).
- **Playwright e2e** (`tests/e2e/`, `npm run test:e2e`) — any UI-visible behavior or bug (badges, connected/error/empty states, toasts). A UI bug is not fixed for good until an e2e test asserts the rendered result.

Rule of thumb: if a human could see or hit it, there must be an integration and/or Playwright test that fails if the bug returns. Reviewers should reject feature/bugfix PRs that only add unit tests for UI- or API-visible behavior.

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

### Integration / e2e Test Cleanup

**Always delete data created during integration and e2e tests.** These tests hit the
real storage API, and the backend they talk to is whatever `AH_PORT` points at —
often a **live server wired to a shared OpenSearch cluster**. Anything a test
creates and fails to delete is permanent clutter in real data (and, on the file
backend, permanent JSON under `.agent-health/data/`).

**Never delete by name across shared storage; only delete ids you created.**
Cleanup hooks must not enumerate storage (`getAll()`, GET on a collection
endpoint) and delete whatever matches a name/prefix — "name looks test-ish" is
NOT proof of ownership (real data includes benchmarks named `mstest` and
`Jason Test`, and importing the bundled OTEL demo file yields docs named
`OTEL Demo: …`). Give fixtures run-unique names via `uniqueTestName()` so
cross-run collisions can't happen, capture every created id, and delete exactly
those ids. Leftovers from crashed runs are reaped by the tracker's crash ledger
(`jest.globalTeardown.cjs`) and, for historical junk, the reviewed opt-in
`scripts/sweep-test-data.mjs`. This is enforced at RUNTIME, not by scanning
source text for the anti-pattern (an earlier version of this rule,
`tests/unit/testCleanupHygiene.test.ts`, tried to regex-detect "list + delete"
and "name-gated delete" in every cleanup hook's source — removed because a
semantic property checked by string-matching source is exactly the
"coverage-theater" pattern this repo's testing guidance forbids: it is
trivially bypassed by moving the bad logic into a helper function, one level
of indirection defeats it). Instead, [`TestDataTracker.cleanup()`](tests/helpers/testDataTracker.ts)
is structurally incapable of the anti-pattern — it only ever issues a DELETE
for (a) an id previously passed to `track()`/`testCase()`/`benchmark()`/etc.
(`this.entities`), or (b) a report doc returned by a **reconciliation search
that is itself scoped to a tracked test-case id** (`POST /runs/search
{testCaseId}`), and there is no code path in it that calls a listing API or
matches anything by name. The reconciliation pass exists because a background
evaluation can persist its report doc AFTER `afterAll` harvested every id the
suite could see (measured live: 14 leaked reports in one integration run) —
cleanup() re-queries with a bounded settle-poll, and `jest.globalTeardown.cjs`
runs one final end-of-run pass via `reconcile-test-case` ledger markers.
[tests/unit/helpers/testDataTracker.test.ts](tests/unit/helpers/testDataTracker.test.ts)
covers that guarantee directly ("never issues a request for an id that was
not explicitly tracked" — with reconciliation searches allowed only against
tracked test-case ids) against the real implementation, not a source scan.

Use the shared tracker — do not hand-roll `createdXIds[]` arrays:

```typescript
import { createTestDataTracker, uniqueTestName } from '../../helpers/testDataTracker';

const tracker = createTestDataTracker();            // reads AH_PORT, default localhost:4001
afterAll(async () => { await tracker.cleanup(); }); // children before parents, 404-tolerant

const tc = await client.createTestCase({ name: uniqueTestName('my-case') /* ... */ });
tracker.testCase(tc.id);
```

Available: `testCase(id)` / `testCases(ids)`, `benchmark(id)`,
`benchmarkRun(benchmarkId, runId)`, `evaluationRun(id)`, `run(reportId)`,
`evaluator(id)`, `image(digest)`, `customAgent`, `remoteServer`,
`assistantSession`. In Playwright, use the `testData` fixture from
`tests/e2e/fixtures/test-fixtures.ts` — it cleans up automatically per test.

**`cleanup()` never throws** (so it cannot turn a green suite red) but warns on
failure. Set `AH_TEST_CLEANUP_STRICT=1` to make leaks hard failures.

#### Deleting a benchmark or evaluation run does NOT delete its reports

`DELETE /api/storage/benchmarks/:id` and `DELETE /api/storage/evaluation-runs/:id`
are single-document deletes with **no cascade** to the per-test-case report docs
created by `/execute` or a real run (`OpenSearchBenchmarkOperations.delete()` /
`OpenSearchEvaluationRunOperations.delete()` in
`server/adapters/opensearch/StorageModule.ts`). Tracking only the parent leaks
every report — historically the biggest source of shared-cluster clutter. Walk the
results first, after the run reaches a terminal state:

```typescript
const { evaluationRun } = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${runId}`).then(r => r.json());
for (const result of evaluationRun.results ?? []) tracker.run(result.reportId);
tracker.evaluationRun(runId);
```

#### Crash safety net

`afterAll` does not run when a worker is killed (`--forceExit`, a jest timeout,
OOM, Ctrl-C). So every id the tracker records is also appended to a ledger under
`.agent-health/.test-ledger/`, and `jest.globalTeardown.cjs` deletes whatever a
dead suite left behind — **by id**, so it costs nothing when nothing leaked. A
successful `cleanup()` removes its own ledger; a non-empty sweep prints a loud
warning, meaning that suite's cleanup is buggy even though the data is now gone.
Ledgers are scoped by `AH_TEST_RUN_ID` (set in `jest.globalSetup.cjs`) so
concurrent runs sharing a worktree never delete each other's in-flight data.
Escape hatches: `AH_TEST_SKIP_SWEEP=1`, `AH_TEST_LEDGER_DISABLED=1`.

#### Retroactive cleanup

`scripts/sweep-test-data.mjs` finds and deletes test-created entities that leaked
before this harness existed. **Dry-run by default; `--apply` deletes.** Plain
`--apply` only ever touches the unambiguous `ahtest-` prefix; the broad legacy
literal-name patterns (a human could plausibly reuse names like "E2E Test Case")
require an explicit `--legacy` opt-in and print every candidate for review —
keep those patterns exact and never loosen them to something like `/test/i`
(real benchmarks are named `Pulsar-regression-tests`, `mstest`, `Jason Test`).
Report docs carry **no name**, so name matching cannot see them at all;
test-created reports are deleted **by id** via the tracker / crash ledger.
Unknown flags are a hard error — the sweeper refuses rather than silently
running a different sweep.

There is deliberately **no structural "orphan" mode** (an earlier `--orphans`
flag was removed): parent-reference absence is NOT a reliable junk signal on
this data. Classic benchmark `/execute`-era reports carry
`experimentRunId: run-<ts>-<rand>` ids that only ever existed embedded in the
parent benchmark's `runs[]` array — never as standalone evaluation-run docs —
so "eval-run doc 404" mis-flags every old real run; and even benchmark-anchored
resolution selects hundreds of reports of genuine historical work (real,
currently-configured agents) whose parents were simply deleted later.
Reclaiming historical parentless reports requires a bespoke, manually-reviewed
audit — do not automate it on name/parent heuristics. Regression-locked by
[tests/unit/scripts/sweepTestData.test.ts](tests/unit/scripts/sweepTestData.test.ts).

```bash
node scripts/sweep-test-data.mjs                 # dry run: ahtest-* leaks
node scripts/sweep-test-data.mjs --apply         # delete ahtest-* leaks
node scripts/sweep-test-data.mjs --legacy        # dry run incl. legacy names (review!)
node scripts/sweep-test-data.mjs --orphans       # dry run: dangling-parent reports
```

Name new entities with `uniqueTestName()` so they are always sweepable.

#### Legacy pattern (being migrated away from)

Older suites hand-roll this; prefer the tracker above for new code:

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

The `.agent-health/data/` directory is gitignored for this reason — it is runtime state, not source code.

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
