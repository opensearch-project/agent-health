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
}, async function ({ agent, judge, expect }) {
  const result = await agent.run();              // invoke the agent (once)
  expect(result.agentOutput).to.contain('root cause');
  expect(result.trajectory).to.haveCalledTool('search_logs');
  expect(result).to.haveCompletedWithin(60_000);
  await judge(result, 'identifies the failing dependency');     // gate
  expect(result.traces.totalTokens).to.be.lessThan(10_000);
});
```

> **v2 control inversion (RFC 004).** The test body now drives the agent via
> `await agent.run()` — like Playwright's `await page.goto()`. The older eager
> form (a pre-populated `result` fixture) still works during the transition;
> see [Control inversion](#3-control-inversion--the-agent-fixture).

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
async function ({ agent, judge, evaluate, expect, testInfo, provisioned }) { ... }
```

| Fixture  | Type                                             | What it gives you |
|----------|--------------------------------------------------|-------------------|
| `agent`  | `AgentFixture`                                   | `await agent.run(prompt?, options?)` — invoke the agent **once** (control inversion). Returns an `EvalResult`. |
| `judge`  | `JudgeFn`                                         | Non-throwing LLM judge. `judge(...)` gates; `judge.observe(...)` is observational. Returns a `Verdict`. |
| `evaluate` | `EvaluateFn`                                     | Run a custom programmatic evaluator registered with `defineEvaluator()`. |
| `expect` | chai's `expect` with our recording plugin        | Synchronous matcher entry-point. `expect.soft(...)` records a failing assertion instead of throwing — see [Always-record guarantee](#5-matchers-record-structured-verdicts). |
| `testInfo` | `TestInfo` (read-only)                          | `{ name, benchmarkPath, sourceFile, testCaseId }` |
| `provisioned` | `Readonly<Record<string, unknown>>`          | Values set by `beforeEach` via `provide()` |
| `result` | `EvalResult` *(legacy eager path)*               | Pre-populated agent result — present when the runner invokes before the body. Prefer `await agent.run()`. |
| `traces` | `TracesAccessor` *(legacy)*                      | Standalone accessor; equivalent to `result.traces` after `agent.run()`. |

`expect` is also exported at the top level for convenience. Both are the same
function. `result.traces` exposes the same OTel accessor as the standalone
`traces` fixture, scoped to the run.

### 3. Control inversion — the `agent` fixture

The test body invokes the agent itself with `await agent.run()`, the way a
Playwright test calls `await page.goto()` — so you can do setup *before* the
agent runs (seed a ticket, provision a workspace) and feed the result in:

```javascript
test('payment RCA', { prompt: 'Triage the latest payment incident' },
  async ({ agent, expect, judge }) => {
    const id = await seedTicket();                  // setup BEFORE the agent
    const result = await agent.run(`Triage ${id}`); // per-call prompt wins over the option
    expect(result.trajectory).to.haveCalledTool('search_logs');
    await judge(result, 'identifies the DB outage');
  });
```

- **Exactly one invocation per test (enforced).** One test ⇒ one invocation ⇒
  one comparable trajectory. A second `agent.run()` throws. Multi-turn
  conversations (if a connector models them) happen inside that single run.
- **`agent.run(prompt?, options?)`** — `prompt` defaults to the test's `prompt`
  option; `options` is `{ context?, env? }` (e.g. pass a provisioned workspace
  dir via `env`). Returns a fully-captured `EvalResult` with `result.traces`.
- **`agent.invoked`** — read-only boolean, true once `run()` has been called.
- **Legacy eager path.** Older tests destructure a pre-populated `result`
  fixture. That still works; new tests should prefer `agent.run()`. A codemod
  converts the old shape — see [Migrating v1 → v2](#migrating-v1--v2).

### 4. Lifecycle hooks (`beforeEach` / `afterEach` / `beforeAll` / `afterAll`)

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

See the demo at [`examples/eval-files/sdk-hooks-demo.eval.js`](../examples/eval-files/sdk-hooks-demo.eval.js).

### 5. Matchers record structured verdicts

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

#### Always-record guarantee

chai's `expect()` is fail-fast — the first failing assertion throws, and the
rest of the test body (any later `expect()`/`judge()`/`evaluate()` calls)
never executes. For a pass/fail verdict that's the intended Playwright-style
contract, but a report consumed by an optimizer (or by you, comparing runs)
needs the objective actuals — duration, token usage, USD cost — from every
axis, even when one gate fails partway through. A token-budget gate failing
shouldn't erase the cost figure that would otherwise have been on the report.

So regardless of where (or whether) the body throws, the runner **always**
stamps `performanceMetrics.durationMs` / `.agentDurationMs` /
`.totalTokens` / `.totalCostUsd` onto the report the moment `agent.run()`
resolves — reading them straight from the same OTel-derived data
`result.traces`/the `traces` fixture exposes, independent of whether the
body's own code ever reached a matcher that asserted on them. (`totalTokens`/
`totalCostUsd` are `undefined`, not `0`, when `useTraces: true` but spans
never arrived — see the loud-failure accessor in "Traces fixture" below;
they're real `0`s when `useTraces: false`.)

This guarantee has one hard limit: a `judge()`/`evaluate()` call itself is
already non-throwing and records its score/verdict the instant it's called —
so a REACHED judge call is always on the report today, throw-or-not. But a
judge call placed textually *after* a failing `expect()` never executes at
all — that's a pure source-order problem the runner cannot retroactively fix
(it can't record a call that never ran). Use `expect.soft(...)` (below) when
you need later judge/evaluate calls to run even after an earlier assertion
fails.

The matcher panel also gets a distinct **"not reached"** row appended
whenever the body threw — so "this axis never ran" (grey, not-reached) reads
differently from "this axis ran and failed" (red). It's excluded from the
passed/failed counts and gets its own tally: `(3/4 passed, 1 not reached)`.

#### `expect.soft(...)` — keep going instead of bailing on the first failure

`expect.soft(value)` is the same chai assertion surface as `expect(value)`
— every built-in BDD matcher plus the custom ones below — except a failing
assertion **records** the MatcherResult and returns instead of throwing:

```javascript
test('budget-aware RCA', { prompt: '...' }, async ({ agent, expect, judge }) => {
  const result = await agent.run();
  expect.soft(result.traces.totalTokens).to.be.lessThan(10_000);  // fails — recorded, body continues
  expect.soft(result.traces.totalCost).to.be.lessThan(0.05);      // still runs
  await judge(result, 'identifies the root cause');                // still runs — the whole point
  expect(result.agentOutput).to.contain('root cause');             // a HARD expect still bails on ITS OWN failure
});
```

The runner's overall verdict is unaffected by soft vs. hard: a test already
fails when ANY recorded gate matcher has `pass: false` (that's exactly how
non-throwing `judge()`/`evaluate()` gates have always worked) — `expect.soft`
just extends that same non-throwing contract to chai assertions. Mix soft and
hard freely in one body; a hard `expect()` after a soft failure still bails
at that point (source order still matters for the calls *after* a HARD
failure). Reach for `.soft` on measurement/budget-style axis checks where you
want every number on the report regardless of which gates failed; keep hard
`expect()` for a precondition that makes the rest of the body meaningless if
it's false (e.g. "the agent produced any output at all").

> **Known limitation: multi-step property chains can record a derivative
> second failure.** `expect.soft(obj).to.have.property('x').that.equals(5)`
> is really two chai assertions run back-to-back on the same chain (`property`
> checks existence, `equals` checks the value) — with a HARD `expect()`, a
> missing property throws immediately and `.that.equals(5)` never runs. In
> soft mode nothing throws, so `.that.equals(5)` *does* run against
> `undefined` and records its own "expected undefined to equal 5" failure —
> real, but a symptom of the first failure, not independent information.
> Prefer single-step matchers on primitive/simple values with `.soft` (as in
> every example above); for a value that might not exist, use a hard
> `expect()` to check existence first, then `.soft` on the value itself.

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
const v = await judge(result, 'identifies the root cause');   // gate role
await judge.observe(result, 'mentions the runbook');          // observe (non-gating)
await judge(result, 'proposes a remediation', { model: 'claude-sonnet' });
await judge(result, 'follows the SOP', { evaluatorId: 'system-rca-default' });
```

Calls the server's `/api/judge` endpoint with the run's trajectory plus the
user-supplied claim as the expected outcome, and records a `MatcherResult`
with the judge's score and reasoning.

**Non-throwing (RFC 004).** `judge(...)` returns a `Verdict`
(`{ pass, passFailStatus, score, reasoning, role, skipped, orThrow() }`)
**without throwing**. A failing `gate`-role verdict still fails the test (the
runner inspects the recorded MatcherResult); `judge.observe(...)` feeds
score + insights only and never fails the run. Call `.orThrow()` on a verdict
for the old bail-on-first-failure behaviour at a specific point.

- **`judge(result, claim)`** — *gate*: a failing verdict fails the test.
- **`judge.observe(result, claim)`** — *observe*: records score/reasoning, never gates.
- **`{ skip: true }`** (or `AH_SKIP_JUDGE=1`) — returns a non-gating `skipped`
  verdict with no HTTP call; `{ skip: false }` forces the judge to run even
  when `AH_SKIP_JUDGE` is set.

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

### Custom evaluator prompts and provider parity

The saved evaluator's `systemPrompt` and `scoringConfig.metrics` are honored
on **every** judge provider — `bedrock`, `openai-compatible`, `litellm`,
`claude-code`, `pi`, `agent` (trace), and `agentic`. When the judge model's
`provider` (resolved from the model config or `evaluator.inferenceConfig`)
changes, the same prompt and rubric flow through unchanged. Two
provider-specific addendums are appended automatically because they
document the provider's tool-use contract, not the rubric:

- `agentic`: `AGENTIC_JUDGE_ADDENDUM` (the model is told it can iterate /
  use tools / cross-reference).
- `agent` (trace): a `query_spans` / `query_logs` paragraph so the judge
  knows the run-scoped trace tools are available, even when the saved
  prompt doesn't mention them.

The saved prompt fully replaces the default base in both cases — a
regression test pins this for the `agent` provider in
[tests/unit/server/services/piAgenticJudgeService.test.ts](../tests/unit/server/services/piAgenticJudgeService.test.ts).

### Surfacing extra judge-emitted fields

If the saved system prompt asks the model for fields beyond the typed wire
shape (`pass_fail_status` / `reasoning` / `metrics` / `improvement_strategies`),
those extra keys are captured into
`LLMJudgeResponse.extraFields` and rendered on the run-detail page's "Judge
Debug" section. There's no code change required to surface a new field —
ask for it in the prompt and it shows up. Numeric metrics inside `metrics`
that aren't declared in `scoringConfig.metrics` are split into
`extraFields.metrics_unmapped` so nothing the judge emits is silently
dropped.

### Inspecting what reached the model (`AH_JUDGE_DEBUG`)

When iterating on a judge prompt, set `AH_JUDGE_DEBUG=1` on the server (or
run in dev — it's the default in `NODE_ENV !== 'production'`) to capture
the **system prompt** and **user prompt** the judge actually saw, plus the
**raw response** before parsing. They land on
`LLMJudgeResponse.judgeDebug` and render under "Judge Debug" on the
run-detail page — use them to confirm in one round whether your prompt
edit reached the model. Disabled by default in prod because system prompts
can be 10–20 KB and shipping them on every run bloats persisted run docs.

### Which LLM actually judged? (`judgeModel` vs `judgeModelId`)

Two fields describe the judge on every persisted report and run:

| Field | Meaning | Example |
|-------|---------|---------|
| `judgeModelId` | The **configured** judge — what you picked in the run dialog / `--judge-model`. For the agent (trace) judge this is a **provider name**, not a model. | `agent-trace-judge`, `us.anthropic.claude-sonnet-4-6` |
| `judgeModel` | The **underlying LLM** that produced the verdict, as the provider resolved it at judge time. Always recorded (not gated by `AH_JUDGE_DEBUG`). | `amazon-bedrock/global.anthropic.claude-sonnet-4-5-20250929-v1:0` |

For plain Bedrock/OpenAI-compatible judges the two are the same model. For
`agent-trace-judge` (and `pi-judge`) the LLM is picked at run time from the
pi model registry — `judgeModel` is the only place that choice is recorded,
and `llmJudgeResponse.modelId` now carries it too (with
`llmJudgeResponse.judgeProvider` keeping the judge kind). Reports persisted
before this field existed have no `judgeModel`; the UI shows
"model not recorded — auto-picked at run time" for them rather than guessing.

**Pinning the agent judge's model** (the default is an auto-pick preferring
a recent Claude Sonnet on an inference profile; the pick order is fixed for
cross-run comparability):

- Server-wide: `AH_AGENT_JUDGE_MODEL_ID=us.anthropic.claude-sonnet-4-5` (matched
  by base id, so any `us.`/`global.` profile of it satisfies the pin).
- Per evaluator: `inferenceConfig.agentJudgeModelId` (Evaluator page → Inference
  Configuration → provider "Agent Trace Judge" → Underlying LLM).

`GET /api/judge/models` returns the catalog with `resolvedModel` /
`resolvedSource` on the agent-judge entries so you can see what a run
started now would be judged by; the run dialogs show it inline as
"Agent Trace Judge (…) — Claude Sonnet 4.5".

### Custom evaluators — `defineEvaluator()` / `evaluate()`

Not every check is an LLM judge or a chai assertion — sometimes ground truth
lives in code (a SQL result must match a golden row set, a JSON answer must
validate against a schema). Register a deterministic evaluator once and call it
by id:

```javascript
const { defineEvaluator, test } = require('@opensearch-project/agent-health');

defineEvaluator('sql-matches-golden', ({ result }) => {
  const rows = JSON.parse(result.agentOutput);
  return { pass: deepEqual(rows, GOLDEN), reasoning: 'row-set comparison' };
});

test('answers the revenue query', { prompt: '...' }, async ({ agent, evaluate }) => {
  const result = await agent.run();
  await evaluate(result, 'sql-matches-golden');           // gate
  await evaluate.observe(result, 'rows-are-sorted');      // observe (non-gating)
});
```

- The evaluator fn receives `{ result, criteria?, traces? }` and returns
  `{ pass, score?, reasoning? }`.
- It records a `MatcherResult` with `method: 'evaluator'`, **gates by default**,
  and runs **in-process** — deterministic and free (no LLM call).
- `evaluate.observe(...)` feeds score/insights only, mirroring `judge.observe`.

### Traces fixture

After `await agent.run()` resolves, OTel data is available synchronously on
`result.traces` (and on the standalone `traces` fixture for the legacy eager
path) when the agent has `useTraces: true`:

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

## Weighted scoring across criteria

Each `expect(...)`, `judge(...)`, and `evaluate(...)` call records **one
per-matcher pass/fail** — they are not weighted against each other. When you
need a **single aggregate score** that weights criteria differently (e.g. root
cause 60%, SOP selection 20%, relevant-metrics check 10%, latency 10%), the
weighting lives in a **custom evaluator's `scoringConfig`**, not in the test
body. Define the weighted metrics once and attach the evaluator to the run via
`evaluatorId`:

```json
{
  "name": "Ops RCA (weighted)",
  "systemPrompt": "You evaluate an ops agent that triages a ticket. Score each metric 0-100. CRITICAL: root_cause_accuracy is the primary metric.",
  "scoringConfig": {
    "metrics": [
      { "name": "root_cause_accuracy",  "weight": 0.6, "scale": 100 },
      { "name": "sop_selection",        "weight": 0.2, "scale": 100 },
      { "name": "relevant_metrics",     "weight": 0.1, "scale": 100 },
      { "name": "latency",              "weight": 0.1, "scale": 100 }
    ],
    "passThreshold": 80,
    "scale": 100
  }
}
```

The run's overall score is the weighted mean of the metrics the evaluator
emits, so you get one comparable number per run for progress tracking. Use the
deterministic `expect(...)` matchers for the hard checks (exact classification,
tool was called, budget cap) and the judge/evaluator + weighted `scoringConfig`
for the aggregate score. See the ops-RCA worked example at
[`examples/eval-files/ops-rca-classification.eval.js`](../examples/eval-files/ops-rca-classification.eval.js)
and its companion [`examples/eval-files/ops-rca-evaluator.json`](../examples/eval-files/ops-rca-evaluator.json),
and the evaluator reference in [docs/skills/AGENT_HEALTH.md](./skills/AGENT_HEALTH.md#custom-evaluators).

---

## Running the tests

> **Security note:** the ENTIRE contents of an imported `.eval.js`/`.eval.ts`
> file are persisted verbatim on the resulting test case (`sourceCode`) and
> rendered on the Test Case detail page as an IDE-style code view, so anyone
> who can view test cases in this deployment can read the full file --
> including any comments, hardcoded values, or internal URLs it contains.
> Treat eval files like any other source file that lands in your repo and
> gets deployed alongside the app: don't hardcode secrets, tokens, or
> customer data in them -- pull those from environment variables /
> `agent-health.config.ts` instead, same as you already would for the app's
> own credentials.

### Via the UI

`/evaluations/runs/new` → pick "Code import" → select your `.eval.js` files.

### Via the CLI

```bash
npx @opensearch-project/agent-health benchmark -f ./examples/eval-files/demo.eval.js -a observio
```

### Via the HTTP API

```bash
curl -sN -X POST http://localhost:4001/api/storage/evaluation-runs \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Demo",
    "sources": [{
      "type": "code-import",
      "filenames": ["examples/eval-files/demo.eval.js"],
      "testCaseIds": []
    }],
    "agentKey": "observio",
    "modelId": "claude-sonnet"
  }'
```

### Migrating v1 → v2

A codemod rewrites old eager-style eval files (a destructured `result` fixture)
to the v2 control-inversion shape (`const result = await agent.run()`):

```bash
npx @opensearch-project/agent-health migrate sdk-v2 ./evals/*.eval.js   # writes in place
npx @opensearch-project/agent-health migrate sdk-v2 ./evals --dry-run   # preview only
```

The `.eval.js`, `.eval.ts`, and `.eval.mjs` loaders all run through a single
code-import execution path, so `benchmark -f <file>` executes the SDK body
directly.

> **`.eval.js` and `.eval.ts` are both executed as synthetic CJS — only
> `.eval.mjs` needs the package to be really resolvable.** `.eval.js` and
> `.eval.ts` files are both executed in a synthetic context where the
> `require(...)` call for `@opensearch-project/agent-health` is intercepted
> directly, so they work from anywhere on disk regardless of whether the
> package is actually installed at that location. (`.eval.ts` is
> transpiled to CommonJS with `esbuild` — a required runtime dependency of
> this package — before running through that exact same synthetic-CJS
> path; it deliberately does NOT use a native `import()`, both to avoid two
> different Node versions giving the same file two different
> module-execution semantics, and because `import()` caches by URL, which
> would make a `.eval.ts` file unloadable a second time in one process
> without a restart. One consequence: an `.eval.ts` fixture can't use
> `import.meta` or a top-level `await` — real-ESM-only features with no
> CommonJS equivalent.) `.eval.mjs` files use a plain native `import()`, so
> `import { test } from '@opensearch-project/agent-health'` in an `.mjs`
> file must resolve through Node's normal module resolution — the package
> needs to be a real dependency reachable from the file's location
> (installed in `node_modules`, a workspace link, or a `node_modules`
> symlink to a local checkout). Test registrations are shared process-wide
> (keyed off `globalThis`) regardless of loader, so it doesn't matter
> *which* physical copy of the package a given import resolves to — dist
> vs source, symlinked vs installed all register into the same registry
> the loader reads from.

> **`.eval.ts` can `import` sibling `.ts` helper files, but not ESM-only
> packages.** A relative/absolute `import` inside an `.eval.ts` file that
> resolves to another `.ts` file (e.g. `import { helper } from
> './helper.ts'`) is transpiled and executed through the same synthetic-CJS
> mechanism recursively — multi-file `.eval.ts` fixtures work, and a helper
> required more than once within one load executes exactly once (cached
> for the duration of that load only, never across separate loads/reloads).
> An `import` of a package that ships **no CommonJS entry point** (ESM-only,
> e.g. modern `chalk`) fails with an actionable error — `.eval.ts` executes
> as synthetic CJS, so under require()'s own rules that package can't load
> there — unless the running Node version has native `require(esm)`
> interop (stable since Node 22.12; check `process.features.require_module`),
> in which case it works transparently via Node's own mechanism. If you hit
> the error on an older Node, switch the fixture to `.eval.mjs` (real ESM,
> can import ESM-only packages directly) or pre-compile to `.eval.js`.

> **`.eval.mjs` reloads are cache-busted, not cached.** Every `import()` of
> an `.eval.mjs` file is given a unique query string
> (`?ah-reload=<timestamp>-<random>`) so re-loading the same file a second
> time in one process (e.g. re-running the CLI against an edited fixture)
> re-executes its top-level code instead of silently returning Node's
> already-cached module for that URL. Accepted cost: each reload leaves one
> module instance cached under a never-reused query string for the
> lifetime of the process — negligible for CLI/server process lifetimes
> (a handful to a few hundred loads, not an unbounded long-running loop).

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
- [x] Control inversion — the `agent` fixture (`await agent.run()`, one invocation per test) (RFC 004 / [#256](https://github.com/opensearch-project/agent-health/issues/256))
- [x] Non-throwing run-scoped `judge` with `gate` / `observe` roles + `skip` + `orThrow()`
- [x] `defineEvaluator()` / `evaluate()` for mechanical / external verification ([#244](https://github.com/opensearch-project/agent-health/issues/244))
- [x] Single code-import execution path (`benchmark -f *.eval.js` runs the SDK body) + unified `.js` / `.ts` / `.mjs` loaders + `agent-health migrate sdk-v2` codemod
- [x] `expect.soft()` to collect-all-failures instead of bail-on-first
