<!--
  * Copyright OpenSearch Contributors
  * SPDX-License-Identifier: Apache-2.0
-->

# Agent Health SDK Guide (experimental)

> ⚠️ **Experimental.** The SDK API surface — `test()` signature, options shape,
> fixtures, matcher set — may change in a minor release without a deprecation
> cycle. Pin your `@opensearch-project/agent-health` version if you depend on
> it. Set `AGENT_HEALTH_SUPPRESS_EXPERIMENTAL=1` to silence the runtime notice.

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

### 3. Matchers record structured verdicts

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
```

Calls the server's `/api/judge` endpoint with the test's trajectory plus the
user-supplied claim as the expected outcome. Throws on judge failure (so the
test bails) and records a MatcherResult with the judge's score and reasoning.

The legacy form `judge(trajectory, [...claims])` is preserved for backward
compatibility with code written against the original PR.

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
AGENT_HEALTH_SUPPRESS_EXPERIMENTAL=1 npm test
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
- [ ] `defineEvaluator()` for #186-style mechanical / external verification
- [ ] `expect.soft()` to collect-all-failures instead of bail-on-first
