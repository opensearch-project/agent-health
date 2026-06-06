<!--
  * Copyright OpenSearch Contributors
  * SPDX-License-Identifier: Apache-2.0
-->

# Agent Health SDK Guide (experimental)

> ⚠️ **Experimental.** The SDK API surface — `test()` signature, options shape,
> fixtures, matcher set — may change in a minor release without a deprecation
> cycle. Pin your `@opensearch-project/agent-health` version if you depend on
> it. Set `AH_SUPPRESS_EXPERIMENTAL=1` to silence the runtime notice.

The SDK lets you write Agent Health test cases as plain JavaScript / TypeScript
files instead of clicking through the UI. Tests live alongside your repo,
follow Playwright's mental model (`test`, `expect`, fixtures), and produce
**per-matcher results** that the UI renders as a structured breakdown.

```javascript
const { test, expect } = require('@opensearch-project/agent-health');

test('rca-log-analysis', {
  prompt: 'Why is service X failing?',
  labels: ['category:RCA', 'difficulty:Medium'],
}, async function ({ result, judge, traces }) {
  expect(result.agentOutput).to.contain('root cause');
  expect(result.trajectory).to.haveCalledTool('search_logs');
  expect(result).to.haveCompletedWithin(60_000);
  await judge(result, 'identifies the failing dependency');
  expect(traces.totalTokens).to.be.lessThan(10_000);
});
```

---

## Concepts

### 1. `test()` — registers a test case

Two valid signatures:

```javascript
test('name', body)                    // no options
test('name', options, body)           // with options
```

Only `name` is required. All `options` fields are optional. Within the same
`.eval.js` / `.eval.ts` file every test name must be unique — registration
throws on duplicates.

### 2. The body receives **fixtures**

```javascript
async function ({ result, judge, traces, expect }) { ... }
```

| Fixture  | Type                                             | What it gives you |
|----------|--------------------------------------------------|-------------------|
| `result` | `EvalResult`                                     | Trajectory, agent output, durationMs, runId, tokenUsage |
| `judge`  | `(result, claim) => Promise<JudgeVerdict>`       | LLM-judge matcher (calls server's `/api/judge`) |
| `traces` | `TracesAccessor`                                 | Token counts, costs, span durations from OTel |
| `expect` | chai's `expect` with our recording plugin        | Synchronous matcher entry-point |

`expect` is also exported at the top level for convenience. Both are the same
function.

### 3. Lifecycle hooks (`beforeEach` / `afterEach` / `beforeAll` / `afterAll`)

For *side-effecting* per-test setup with a teardown step — the kind that
a connector can't express because connectors are pure request-shapers
with no lifecycle — the SDK provides Playwright-style hooks. Use them
for things like materializing a temp workspace, seeding a database,
starting a sandbox, or writing a fixture file the agent's tools open.

```javascript
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, beforeAll, afterAll, beforeEach, afterEach, expect } = require('@opensearch-project/agent-health');

let suiteRoot;
beforeAll(() => {
  suiteRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'my-suite-'));
});
afterAll(() => fs.rmSync(suiteRoot, { recursive: true, force: true }));

beforeEach(({ provide, testInfo }) => {
  const dir = fs.mkdtempSync(path.join(suiteRoot, `${testInfo.name}-`));
  provide('workspaceDir', dir);
});
afterEach(({ provisioned }) => {
  // afterEach always runs — even when beforeEach failed before the
  // provide() call — so guard before reaching for the value.
  if (typeof provisioned.workspaceDir === 'string') {
    fs.rmSync(provisioned.workspaceDir, { recursive: true, force: true });
  }
});

test('uses workspace', { prompt: '...' }, async ({ result, provisioned }) => {
  expect(fs.existsSync(provisioned.workspaceDir)).to.equal(true);
});
```

Key points:

- **Scope.** Hooks attach to the file they're declared in (top level) or
  to the surrounding `describe()` block. Nested describes inherit outer
  hooks; ordering is outer-→inner for `beforeAll`/`beforeEach`, and
  inner-→outer for `afterEach`/`afterAll`.
- **Once-per-scope guarantee.** `beforeAll` runs exactly once, even when
  the runner dispatches tests in parallel — the orchestrator uses a
  promise-based once-latch and all parallel arrivals await it. `afterAll`
  uses a remaining-tests counter and fires when the last test in the
  scope completes.
- **Always-runs teardown.** `afterEach` and `afterAll` run even when the
  body or `beforeEach` threw. Hook errors don't crash the runner; they
  surface as `MatcherResult` entries on the test (visible in the same
  per-matcher panel as your assertion failures).
- **`provide(key, value)`** is the only way to surface a value from
  `beforeEach` to the body. Don't mutate `testInfo` and don't rely on
  closure variables for per-test state — those don't survive parallelism.
  The `provisioned` bag is per-test (each test gets a fresh empty object),
  so concurrent tests are isolated.
- **`testInfo`** is read-only metadata: `{ name, benchmarkPath, sourceFile,
  testCaseId }`. Useful for naming temp resources or tagging logs.
- **`test.beforeEach(...)`** is also accepted as an equivalent alias for
  `beforeEach(...)`, mirroring Playwright's surface.

Hooks are a no-op when no test in the run uses them — the orchestrator
is short-circuited to a noop variant and existing tests pay zero cost.

See the demo at [`evals/sdk-hooks-demo.eval.js`](../evals/sdk-hooks-demo.eval.js).

### 4. Matchers record structured verdicts

Every `expect(...).to.X(...)` call, every `judge(result, ...)` call, and every
traces helper produces one **MatcherResult**. The runner collects them and
the UI shows a per-matcher breakdown:

```
Matchers (4/5 passed)
─────────────────────
✅ to contain 'root cause'                   [code]
✅ haveCalledTool('search_logs')             [code]
❌ to be lessThan 30000                       [code]   actual: 47320
✅ identifies the failing dependency         [judge]  score: 85%
✅ totalTokens < 10000                        [traces] 2,341 tokens
```

This is the major upgrade over throw-and-fail: every assertion gets its own
row, status, and detail block.

---

## Test options

```typescript
interface TestOptions {
  prompt?: string;          // Initial prompt sent to the agent
  description?: string;     // Free-form description shown in the UI
  context?: { description: string; value: string }[];
  labels?: string[];        // Prefixed strings: 'category:RCA', 'difficulty:Medium'
  timeout?: number;         // Per-test timeout override in ms
}
```

### No `category` / `difficulty` keys

The previous standalone `category` and `difficulty` fields are gone. They
live in `labels` as prefixed strings:

```javascript
labels: ['category:RCA', 'difficulty:Medium', 'team:platform', 'tier:p0']
```

Anything before the colon is the facet; anything after is the value. Free-form
labels without a colon are also fine. The UI extracts category/difficulty for
display via `lib/testCaseLabels.ts`. A cold-start migration on the server
auto-folds legacy top-level fields into labels for older documents.

### No prompt = no agent invocation

```javascript
test('data-quality-check', {
  description: 'Verify fixtures match a baseline',
  labels: ['category:Data Quality'],
}, function ({ result }) {
  // result is empty — no agent was invoked
  const baseline = JSON.parse(fs.readFileSync('./baselines.json'));
  expect(baseline.version).to.equal(1);
});
```

When `prompt` is omitted the runner skips agent invocation entirely and the
body runs against an empty `EvalResult` (durationMs: 0, trajectory: []).
Useful for purely data-driven tests where there's no agent step.

---

## EvalResult shape

```typescript
interface EvalResult {
  trajectory: TrajectoryAccessor;     // see below
  agentOutput: string;                 // concatenated final response text
  finalResponse(): string;             // sugar — same as agentOutput
  parsedOutput(): unknown;             // try-parse agentOutput as JSON
  rawEvents: any[];                    // raw AG-UI events
  runId?: string;                      // for log/trace correlation
  durationMs: number;                  // wall-clock duration (0 when no prompt)
  tokenUsage?: { prompt; completion; total };
}
```

### Trajectory sugar accessors

Beyond being a normal `TrajectoryStep[]`, the trajectory has three helper
methods you can use without writing filter loops:

```javascript
result.trajectory.stepsOfType('action');           // → all action steps
result.trajectory.toolCalls();                     // → all action steps (alias)
result.trajectory.toolCalls('search_logs');        // → filtered by tool name
result.trajectory.firstToolCall('http_probe', { method: 'POST' });
//   → { ...step, index: N }   or null
```

`firstToolCall` returns the matched step with an `.index` annotation so you
can assert ordering: `expect(firstSearch.index).to.be.lessThan(firstReview.index)`.

---

## Matchers

### Built-in chai matchers

Every chai BDD matcher works (`.equal`, `.contain`, `.have.length.greaterThan`,
`.match`, etc.). See https://www.chaijs.com/api/bdd/ for the full reference.

### Custom matchers

| Matcher                                      | What it does |
|---------------------------------------------|--------------|
| `expect(traj).to.haveCalledTool(name, args?)` | At least one `action` step matches; `args` is partial-superset |
| `expect(traj).to.haveStepsOfType(type)`      | At least one step of given type exists |
| `expect(text).to.haveOutputMatching(re)`     | String matches regex (or contains substring when given a string) |
| `expect(result).to.haveCompletedWithin(ms)`  | `result.durationMs` ≤ threshold |

### LLM judge — `judge()`

```javascript
await judge(result, 'identifies the root cause');
await judge(result, 'proposes a remediation', { model: 'claude-sonnet' });
await judge(result, 'follows the SOP', { evaluatorId: 'system-rca-default' });
```

Calls the server's `/api/judge` endpoint with the test's trajectory plus the
user-supplied claim as the expected outcome. Throws on judge failure (so the
test bails) and records a MatcherResult with the judge's score and reasoning.

The legacy form `judge(trajectory, [...claims])` is preserved for backward
compatibility with code written against the original PR.

#### Per-call options

| Option        | Forwarded as | What it does |
|---------------|--------------|--------------|
| `model`       | `modelId`    | Override the judge model. Same provider routing (`bedrock`, `litellm`, `claude-code`, `pi`, `openai-compatible`, `agentic`, `demo`) the UI uses. |
| `evaluatorId` | `evaluatorId`| Pick a stored evaluator. Same shape the UI sends — built-in ids are prefixed `system-` (e.g. `system-rca-default`, `system-factuality`) and resolve via `getSystemEvaluatorById`; anything else is a storage id resolved via `storage.evaluators.getById`. |
| `serverUrl`   | (request URL)| Point at a non-default agent-health server (defaults to `http://localhost:${AGENT_HEALTH_PORT ?? 4001}`). |
| `skip`        | (no request) | Tri-state. `true` → skip the judge (records a non-gating `skipped` verdict, no HTTP call). `false` → force the judge to run **even if `AH_SKIP_JUDGE` is set**. Omitted → defer to `AH_SKIP_JUDGE`. |

#### Run-level evaluator (UI-equivalent)

When the runner constructs the `judge` fixture for a test body, it binds
the **run-level** `evaluatorId` and judge `model` from the `EvaluationRun`
so destructured `judge` calls inherit the run's evaluator without the
author passing it manually:

```javascript
// In the test body — no per-call evaluatorId needed.
test('rca-investigate', { prompt: 'Investigate the failing service ...' }, async ({ agent, judge }) => {
  const result = await agent.run();
  // If the run was created with `evaluatorId: 'system-rca-default'`, this
  // call POSTs `{ ..., evaluatorId: 'system-rca-default' }` automatically.
  // Substitute any user-defined evaluator id and the same binding applies.
  await judge(result, 'identifies the ticket details');
  await judge(result, 'reports the current state');
  await judge(result, 'recommends concrete next steps');
});
```

This matches the UI "Run Test" path exactly: pick an evaluator on the run
config, every judged test case in the run uses it. Per-call options always
win over the bound default — useful when one matcher in a test needs a
different evaluator:

```javascript
await judge(result, 'meets product gap criteria', { evaluatorId: 'product-gap-eval' });
```

The **imported** `judge` (from `require('@opensearch-project/agent-health')`)
is always the unbound version — use it when you genuinely want the server's
default evaluator regardless of run config:

```javascript
const { judge } = require('@opensearch-project/agent-health');
// Always uses the server default evaluator; bypasses any run-level binding.
await judge(result, 'baseline check');
```

In practice, prefer the fixture-destructured form so SDK runs and UI runs
produce comparable verdicts.

### Traces fixture

The runner pre-loads OTel data into the `traces` fixture before invoking
the body when the agent has `useTraces: true`, so all access is sync:

```javascript
expect(traces.totalTokens).to.be.lessThan(10_000);
expect(traces.totalCost).to.be.lessThan(0.05);
expect(traces.spanDuration('search_logs')).to.be.lessThan(2_000);
expect(traces.toolCalls).to.have.length.greaterThan(0);
expect(traces.spans).to.have.length.greaterThan(0);   // raw access for power users
```

Availability rules:

- **Agent has `useTraces: false`** — every accessor returns `0` / `[]`. This
  is the opt-out path; assertions like `traces.totalTokens === 0` are still
  meaningful (they assert “I didn't expect any traces”).
- **Agent has `useTraces: true` and spans were fetched** — accessors return
  the real aggregated values.
- **Agent has `useTraces: true` but spans were not retrievable** — every
  read **throws** with a specific reason:
  - `agent has useTraces=true but produced no runId for trace correlation`
  - `fetch failed for runId=…: <underlying error message>` (transient or
    persistent backend errors)
  - `no spans found for runId=… after polling — verify the agent's OTel
    exporter is reachable`

  This turns the silent false-pass described in [#230] into an actionable
  failure.

- **The body never calls `agent.run()`** (a data-only / deterministic test) —
  the `traces` fixture starts *unavailable* and every read **throws**
  `traces are only available after agent.run() has been called`. Traces are a
  property of an agent invocation, so a body that never invokes the agent has
  none to read. Call `agent.run()` first, or don't read `traces` in that test.

Polling is bounded so the test body never blocks for long: by default
10 attempts at 1s each (~10s budget). Override per agent via the
`tracePolling.intervalMs` / `tracePolling.maxAttempts` fields, or globally
via the `TRACE_POLL_INTERVAL_MS` / `TRACE_POLL_MAX_ATTEMPTS` env vars (the
same vars the judge poller honours). A hard ceiling of 60 attempts is
enforced regardless of configuration.

[#230]: https://github.com/opensearch-project/agent-health/issues/230

---

## Running the tests

### Via the UI

`/evaluations/runs/new` → pick "Code import" → select your `.eval.js` files.

### Via the CLI

```bash
npx @opensearch-project/agent-health benchmark -f ./evals/demo.eval.js -a observio
```

### Via the HTTP API

```bash
curl -sN -X POST http://localhost:4002/api/storage/evaluation-runs \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Demo",
    "sources": [{
      "type": "code-import",
      "filenames": ["evals/demo.eval.js"],
      "testCaseIds": []
    }],
    "agentKey": "observio",
    "modelId": "claude-sonnet"
  }'
```

---

## Dev tips

### Suppress the experimental warning in your test runs

```bash
AH_SUPPRESS_EXPERIMENTAL=1 npm test
```

### Get IntelliSense for custom matchers in TypeScript

Drop a tiny `chai-augmentations.d.ts` in your project:

```typescript
// chai-augmentations.d.ts
import 'chai';
declare global {
  namespace Chai {
    interface Assertion {
      haveCalledTool(name: string, args?: Record<string, unknown>): Assertion;
      haveStepsOfType(type: string): Assertion;
      haveOutputMatching(pattern: RegExp | string): Assertion;
      haveCompletedWithin(ms: number): Assertion;
    }
  }
}
```

We don't ship this with the SDK because chai@4's types use ambient namespaces
that conflict with other `Assertion` types in the OpenSearch ecosystem —
keeping it user-supplied lets you opt in without breaking anyone else.

---

## Roadmap

- [x] Optional fields on TestOptions; only `name` required
- [x] Within-file duplicate detection
- [x] No-prompt mode (skip agent invocation entirely)
- [x] Per-matcher results — chai recording plugin + judge() + traces helper
- [x] UI breakdown panel
- [x] Real traces pre-loading from OTel exporter (#230)
- [x] Lifecycle hooks (`beforeEach`/`afterEach`/`beforeAll`/`afterAll`) with `provide()` for per-test out-of-band provisioning ([#229](https://github.com/opensearch-project/agent-health/issues/229))
- [ ] `defineEvaluator()` for #186-style mechanical / external verification
- [ ] `expect.soft()` to collect-all-failures instead of bail-on-first
