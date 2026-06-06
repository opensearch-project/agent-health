<!--
  * Copyright OpenSearch Contributors
  * SPDX-License-Identifier: Apache-2.0
-->

# RFC 004: Test SDK v2 — a real Playwright-style harness

| Field        | Value                                                              |
|--------------|--------------------------------------------------------------------|
| **Status**   | Draft                                                              |
| **Author**   | Ashwin P Chandran                                                  |
| **Created**  | 2026-06-05                                                         |
| **Tracking** | [#256](https://github.com/opensearch-project/agent-health/issues/256) |
| **Supersedes** | the experimental `test()/judge()/expect()` SDK (#207, #198)      |
| **Resolves** | #245, #243, #242, #244, #238, #248, #230, #232, #246              |

## 1. TL;DR

The current SDK is *"a thin layer over the existing UI/JSON execution path"* (its own words, #238). That single decision — keep the framework in charge of invoking the agent **eagerly**, and only call the user's body afterwards to *assert on* a result — is the root cause of almost every bug filed against it.

The fix is one idea, applied without compromise: **invert control.** The test body owns execution. The framework supplies *capabilities* (an `agent` fixture, `expect`, `judge`, `traces`) exactly the way Playwright supplies `page` — and the body decides when and how to use them. There is **one** execution engine behind both the CLI and the server, **one** grading surface, and **no** global mutable state.

This collapses the current "two runners × two entry points × two grading systems × eager invocation × global session" combinatorial mess into a single linear pipeline.

---

## 2. Why the current SDK fails (one root cause, many symptoms)

The current execution model (verified in `services/evaluationRunner.ts`, `services/benchmarkRunner.ts`, `lib/testCases/*`, `server/routes/storage/benchmarks.ts`):

```
connector.buildPayload(prompt, context)   ← framework reads test() options
  → invoke agent                          ← framework, eagerly, before any user code
  → buildEvalResult(...)                  ← framework
  → startSession() [GLOBAL singleton]     ← framework
  → evalFn({ result, judge, traces })     ← user body runs LAST, only asserts
  → endSession()                          ← framework collects verdicts
```

Five structural problems fall out of this:

| # | Structural flaw | Symptoms it causes |
|---|-----------------|--------------------|
| A | **Eager, framework-owned invocation.** The body runs *after* the agent, so it can never influence the prompt, seed state first, invoke twice, or do multi-turn. | #238 (no `invoke`), #248 (hooks run after the agent, so "seed a resource the agent reads" can't work) |
| B | **Two entry points that don't share an execution path.** The server runs (`evaluation-runs`, `benchmarks` routes) re-import the file to materialize bodies into an `evaluateFnMap` and *do* run them. `agent-health benchmark -f` imports only the test-case **data** and grades server-side. So whether your body runs depends on how you launched it. | #245 (body never runs under `benchmark -f`) — the headline value prop is silently absent half the time |
| C | **Two grading systems competing.** The body's `expect()/judge()` vs. a server-side evaluator that needs `expectedOutcomes`. They collide: the eager path tries the server judge unless `skipJudge` is threaded through; inline `judge()` criteria never populate `expectedOutcomes`. | #243 (inline criteria ignored), #242 (validation error silently recorded as `completed`, `metrics: 0`, misleading "Waiting for traces…") |
| D | **The framework must anticipate every capability.** Because the body can't *do* anything, the framework has to pre-load it. Traces are fetched by the runner before the body; when it can't, it returns silent zeros. | #230 (traces fixture silently returns 0 → `lessThan(N)` matchers falsely pass) |
| E | **Global mutable session + duplicated runners.** `lib/matchers/session.ts` holds a single module-level `activeSession`; `recordVerdict` pushes into it with no per-test isolation. Under `concurrency > 1`, interleaved bodies cross-contaminate verdicts. And the ~130-line body-execution block is **copy-pasted** between `evaluationRunner.ts` and `benchmarkRunner.ts`. | Latent: wrong matcher attribution under parallelism. #246: regressions land in one runner but not the other. |

Plus the loader's module-instance fragility: `.js` files get a hand-built `require` shim that injects the framework's `test()`, but `.ts/.mjs` go through real `import` and can bind a *different* instance of the SDK module → tests register into a registry nobody reads → "has no test cases" (#232).

**Every one of these is downstream of "the framework drives, the body observes."** Patching them one by one (which is what #229/#234/#241 have been doing) keeps re-introducing the next variant. We should fix the model once.

---

## 3. Design principles (what Playwright actually teaches)

#198 quoted the right lesson but the implementation didn't follow it. Playwright's power is **not** its matchers — it's that it *drives a non-deterministic system and hands you stable primitives to observe it*, and **it does not act on your behalf**:

```ts
test('checkout', async ({ page }) => {
  await page.goto('/cart');        // YOU drive
  await expect(page.locator(...))  // YOU observe, scoped to a real handle
});
```

There is no "Playwright reads a `url:` field off your test and navigates before your body." The navigation *is* the test. Translating faithfully:

1. **The body is the test.** No code runs "before the body" that the body can't see or control.
2. **The agent is a fixture you call**, not a step the framework performs. `await agent.run(...)` is `await page.goto(...)`.
3. **Matchers are scoped to a result handle**, never to ambient global state. `expect(result)` / `judge(result, …)` operate on the thing you got back, the way `expect(locator)` operates on a locator.
4. **One engine. Two transports.** Like `playwright test` (CLI) and the VS Code extension both run the *same* runner, our CLI and server must call one engine and differ only in how they *report*.
5. **Declarative metadata is discovery-only.** Playwright can list tests without running them via static `test(name, …)` registration. Keep that — but it feeds *discovery and the UI*, never a hidden execution step.

---

## 4. The v2 model

### 4.1 Control inversion — the `agent` fixture

```js
const { test, expect } = require('@opensearch-project/agent-health');

test('payment RCA identifies the DB outage', {
  labels: ['category:RCA', 'difficulty:Hard'],
}, async ({ agent, expect, judge }) => {
  // YOU drive the agent — like page.goto()
  const result = await agent.run('Diagnose why the payment service is failing.', {
    context: [{ description: 'Error log', value: 'Connection refused to db-primary:5432' }],
  });

  // Deterministic, cheap checks first (scoped to *this* result)
  expect(result).toHaveCalledTool('search_logs');
  expect(result.output).toMatch(/payment[- ]service/i);
  expect(result).toCompleteWithin(120_000);

  // LLM judge only for the semantic part — scoped to this result, inline criteria
  await judge(result, 'identifies the payment-service cannot reach its database');
});
```

`agent.run()` returns a fully-captured, **immutable** `RunResult`:

```ts
interface RunResult {
  trajectory: Trajectory;          // array + sugar (toolCalls(), firstToolCall(), stepsOfType())
  output: string;                  // final assistant text  (was agentOutput)
  json<T = unknown>(): T | undefined;
  runId: string;
  durationMs: number;
  tokenUsage?: { prompt: number; completion: number; total: number };
  traces: TracesView;             // lazily resolved from THIS run's runId (see 4.4)
  raw: AgUiEvent[];
}
```

This is the capability the framework owns end-to-end (connector wiring, trajectory capture, `runId` correlation, timeout, trace association). The *user* owns *when* and *with what* to call it.

**Exactly one `agent.run()` per test (enforced).** The goal is to *benchmark*
an agent: one test ⇒ one invocation ⇒ one trajectory ⇒ one comparable data
point. A second `agent.run()` call throws. This keeps trajectories comparable
across runs, keeps hashing/dedup clean, and removes any "which run do we
report?" ambiguity. The valuable #238 cases survive — *computed prompt* and
*pre-invocation setup* both need only a single call:

```js
// computed prompt + pre-invocation setup — impossible today (#238 case 1), one run
const id = await seedTicket({ status: 'open' });
const r  = await agent.run(`Triage ticket ${id}`);
```

Multi-turn conversations, if a connector models them, happen *inside* that single
`run()` (the connector owns the turns); they are not multiple harness
invocations. "Multiple/conditional invocations" (#238 cases 2–4) are
intentionally **out of scope** — they're at odds with benchmarking.

**How `agent.run()` is implemented (no new transport).** It wraps the existing
connector stack — AG-UI streaming, REST, subprocess, Claude Code all work
unchanged. Today `runEvaluationWithConnector()` mashes three things together
(resolve+invoke the connector, run the Bedrock judge, synthesize a report). We
split out the pure invocation core:

```ts
// services/sdkEngine.ts — resolved ONCE per run; the `agent` fixture closes over it.
interface AgentRuntime {
  agentConfig: AgentConfig;     // from agentKey
  connector: AgentConnector;    // connectorRegistry.getForAgent(...)
  auth: ConnectorAuth;          // buildConnectorAuth(agentConfig)
  modelId: string;
}

// the one genuinely new primitive — pure invocation, NO judge, NO report synthesis
async function invokeAgent(rt: AgentRuntime, prompt: string, opts): Promise<RunResult> {
  const testCase = synthesizeTestCase(prompt, opts.context);  // ad-hoc TestCase
  const request: ConnectorRequest = {
    testCase, modelId: rt.modelId,
    connectorConfig: rt.agentConfig.connectorConfig,
  };
  // reuse the existing beforeRequest / afterResponse hook wiring verbatim
  const resp = await rt.connector.execute(endpoint, request, rt.auth, onStep, onRawEvent);
  return wrapRunResult(resp);          // sugar accessors + lazy traces bound to resp.runId
}
```

- `agent.run(prompt, opts)` is exactly **one** `invokeAgent` call; a second call
  throws (see above).
- The only new code is the `RunResult` wrapper plus pulling runtime resolution
  (currently duplicated across both runners) into one place.
  `runEvaluationWithConnector()` becomes `invokeAgent()` + the legacy
  judge/report glue, and is deleted once v1 is removed.

### 4.2 `test()` keeps declarative metadata, drops eager invocation

`test(name, options?, body)` is unchanged in *shape*, but `options` is now **purely metadata + defaults** — never an instruction to invoke:

```ts
interface TestOptions {
  description?: string;
  labels?: string[];                 // 'category:RCA', 'difficulty:Hard', free-form
  timeout?: number;
  defaultPrompt?: string;            // optional: discovery/UI display + agent.run() default
  context?: ContextItem[];           // optional default context for agent.run()
  expectedOutcomes?: string[];       // optional: for non-code consumers / round-trip JSON
  expectedTrajectory?: ExpectedStep[];
}
```

- **No prompt anywhere?** The body simply never calls `agent.run()` — a pure data test. No special "skipAgentInvocation" branch in the runner; it's just a body that didn't use the fixture.
- **`defaultPrompt` set?** Discovery shows it; `agent.run()` with no args uses it. The agent is still only invoked *if the body calls `agent.run()`*. There is exactly one way the agent runs.

There is **no eager-invocation compatibility path** in the engine — v1 is removed
outright (§8), so the engine has exactly one code path.

### 4.3 Result-scoped matchers (kills the global session)

Matchers attach to the result, not to a hidden global `activeSession`. The recording context is the `RunResult` (and, for non-agent assertions, the per-test context object the engine passes in):

```js
expect(result).toHaveCalledTool('search_logs');   // records onto result's test context
await judge(result, 'criteria');                  // records onto result's test context
expect(result.traces.totalTokens).toBeLessThan(10_000);
```

Implementation: the engine creates **one `TestContext` per test invocation** (not a module global) and threads it through fixtures. `expect`/`judge`/`traces` close over that context. `lib/matchers/session.ts`'s module-level `activeSession` is deleted. This makes `concurrency > 1` correct by construction — there is no shared mutable cell to corrupt.

### 4.4 `traces` is lazy and honest (#230)

`result.traces` is resolved from *that run's* `runId` on first access, not pre-loaded blindly:

- `useTraces` on the agent + traces available → real OTel data.
- `useTraces` true but none found yet → **awaits** (bounded) then **throws a clear error** on a `traces.*` read, never silent zeros.
- `useTraces` false → accessing `traces.*` throws `"traces not enabled for agent X; set useTraces:true"`.

Because the body drives, `await result.traces.totalTokens` can legitimately *wait* for the exporter — the framework no longer has to guess a pre-load window.

### 4.5 Lifecycle via fixtures + `use` (and hooks that actually wrap the agent — #248)

Two complementary mechanisms, both Playwright-faithful:

**(a) Fixtures with teardown** — the composable primitive. A fixture is setup + teardown in one place, and because the body calls `agent.run()` *after* fixtures resolve, setup is guaranteed to land **before** the agent (fixing #248 by construction):

```js
const { test } = require('@opensearch-project/agent-health');

const it = test.extend({
  // value fixture with teardown via `use`
  workspace: async ({}, use) => {
    const dir = await fs.mkdtemp('/tmp/eval-');
    await use(dir);                       // body + agent.run run here
    await fs.rm(dir, { recursive: true, force: true });  // always-after teardown
  },
});

it('reads the workspace', async ({ agent, workspace }) => {
  await fs.writeFile(`${workspace}/input.json`, '...');   // BEFORE the agent
  const r = await agent.run('Process input.json', { env: { WORKSPACE: workspace } });
  expect(r.output).toContain('done');
});
```

**(b) `beforeEach/afterEach/beforeAll/afterAll`** stay for familiarity, but they execute **inside the engine, around the body** — which now contains the agent call — so they wrap the agent automatically. No env-var smuggling, no `result: {} as any` lie (#248's three coupled changes evaporate because the agent call is *in* the body).

### 4.6 Connector access from fixtures (provisioning that the agent can read)

`agent.run({ env, files, provisioned })` passes structured values straight into the connector's `buildPayload`. This is the type-safe option from #248 §2, made trivial because the body — which has the fixture values in scope — is the caller. No orchestrator-stringifies-into-env hack required (it remains available as `env:` sugar).

### 4.7 The judge — a pluggable, run-scoped evaluator

Today `judge(result, claim)` posts only `{trajectory, expectedOutcomes:[claim]}` —
no traces, no `runId`, no tools, no model choice — and the server gates on
`expectedOutcomes`. That can't express either of the two judging styles real
evals need: *(a)* a cheap contextual LLM call, or *(b)* a judge that actively
**queries the run's trace data** (OpenSearch) to reach a verdict.

The fix builds on machinery that already exists: `server/services/agenticJudgeService.ts`
can already run a tool-using agent judge; it's just not wired to trace data.
Control inversion helps here too — `judge(result, …)` is scoped to a concrete
`RunResult` carrying a `runId`, so trace-querying is well-defined per run.

**Ergonomic forms:**

```js
// (a) simple — single contextual LLM call
await judge(result, 'identifies the DB outage as the root cause');

// (b) rich — control context, give the judge tools, pick the model/evaluator
await judge(result, {
  criteria: 'the remediation is grounded in the actual trace data, not hallucinated',
  context: ['trajectory', 'output', 'traces', 'logs'],  // what the judge sees
  tools:   ['trace_query'],        // judge becomes agentic; can query OpenSearch
  evaluator: 'my-trace-judge',     // or: model: 'claude-sonnet'
});
```

**Three execution modes, one `Verdict` shape:**

| Mode | Trigger | How it runs |
|------|---------|-------------|
| **Contextual** (default) | `judge(result, 'criteria')` | One LLM call via `/api/judge`. SDK sends `{runId, trajectory, output, traces?, logs?, criteria}`. The criteria *is* the expectation — no `expectedOutcomes` gate (#243). Cheap, fast. |
| **Agentic / tool** | `tools: ['trace_query']` | Judge runs as an agent with the built-in **trace-query tool pack**. It pulls *your* spans by `runId`, iterates, returns a verdict. Extends the existing agentic judge; enables the tool path that is currently `--print` read-only. |
| **Custom** | `evaluator: 'my-trace-judge'` | A judge function you define in `agent-health.config.ts` (closes #244). Runs in-process in the engine (it's JS from your config). |

**The trace-query tool pack** is a thin wrapper over primitives that already
exist (`fetchSpansForRun`, `fetchTracesByRunIds`, `fetchLogsForRun`), pointed at
the configured LOGS cluster:

```ts
tools.trace_query = {
  getSpans(runId),         // → fetchSpansForRun
  query(openSearchDsl),    // raw DSL against the LOGS cluster
  getLogs(runId),          // → fetchLogsForRun
  metrics(runId),          // token / cost / duration rollups
};
```

**Custom judge in config** — the full escape hatch. Gets the run context, a
`tools` accessor, and an `llm` helper; returns a `Verdict`:

```js
defineConfig({
  evaluators: {
    'my-trace-judge': async ({ result, criteria, tools, llm }) => {
      const spans = await tools.trace_query.getSpans(result.runId);
      const slow  = spans.filter(s => s.durationMs > 1000);
      const v = await llm.complete(`Spans: ${JSON.stringify(slow)}\nClaim: ${criteria}`);
      return { pass: v.pass, score: v.score, reasoning: v.reasoning };
    },
  },
});
```

**`judge()` records, it does not throw.** It returns a `Verdict` and records one
matcher result. Today it throws on failure, which bails the body before later
judges run. Since any failed matcher already fails the test (§6), recording is
sufficient and lets you run several judges and see *all* verdicts in the UI. For
a hard stop, write `await judge(...).orThrow()` or `expect(verdict).toPass()`.

```ts
interface Verdict {
  pass: boolean;
  score?: number;        // 0–1
  reasoning: string;     // why this single claim passed/failed — feeds the insight layer (§4.8)
  role: 'gate' | 'observe';     // does this verdict gate pass/fail? (§4.7.2)
  cached?: boolean;             // verdict came from the judge cache
  skipped?: boolean;            // judge was skipped (§4.7.1) — neutral, not a failure
  toPass(): void;        // chai-style hard assertion
  orThrow(): Verdict;    // bail the body on failure
}
```

#### 4.7.2 A judge verdict does not always gate the test

A judge **always** produces a `Verdict` (`pass`/`score`/`reasoning`), but whether
that verdict can flip the test to `failed` is a choice. Two uses:

- **Assertive** (default) — `judge(result, claim)`. The criteria is a yes/no
  proposition; `verdict.pass` participates in the gate (§6). `role: 'gate'`.
- **Observational** — `judge.observe(result, criteria)` (or
  `judge(result, criteria, { gate: false })`). A *graded measurement* you want
  for the **score** and the **insight** layer, but which must never fail the
  benchmark on its own. `role: 'observe'`.

This generalises to every signal via a `role`:

| Signal source | Default role | Gates pass/fail? |
|---------------|-------------|------------------|
| `expect(...)` | `gate` | yes (always) |
| `judge(result, claim)` | `gate` | yes — on `verdict.pass` |
| `judge.observe(result, criteria)` | `observe` | no — feeds score + diagnosis only |
| derived metrics (§4.8) | `observe` | no — unless wrapped in `expect(...).toBeLessThan(n)` |
| `skipped` judge (§4.7.1) | neutral | no |

Observational judges are what let a *low-ground-truth* test still produce rich
signal: run several graded-quality judges for diagnosis without turning each
into a brittle pass/fail.
```

#### 4.7.1 Caching & skipping (cost control)

Agentic, trace-querying judges are expensive; two knobs keep them affordable:

- **Content-addressed cache.** Key =
  `sha256(evaluatorId + model + criteria + contextSelection + canonical(trajectory|output))`.
  A hit returns the verdict instantly (`cached: true`). This pays off when a
  body is re-run against a stored/replayed run, when a deterministic agent
  reproduces a trajectory, or when the same criteria is judged across a sweep.
  Cache lives server-side keyed by content, so it survives process restarts.
  Invalidation is automatic — any change to trajectory/criteria/model changes
  the key.
- **Skip mode.** `--no-judge` (CLI), `AGENT_HEALTH_SKIP_JUDGE=1` (env), or
  per-test `{ skipJudge: true }`. Every `judge()` returns a `skipped` verdict:
  neutral, excluded from pass/fail (not counted as a failure), labelled in the
  UI. Deterministic `expect()` still runs, giving a fast structural-only inner
  loop. Trace-derived metrics (§4.8) are still computed — they're free.

### 4.8 From verdicts to insight — the composition model

The current SDK treats evaluation as a **gate** (matchers → pass/fail). The more
valuable job, especially with little ground-truth data, is **diagnosis**: use
the trace to explain *why* the agent performed as it did and recommend *how to
improve it*. v2 makes both first-class by composing three layers over one
`RunResult`:

```
RunResult (trajectory + traces)
  ├─ deterministic signals   expect()  → objective facts    (cheap, hard gate)
  ├─ judge signals           judge()   → graded + reasoning  (semantic, few needed)
  ├─ derived metrics         automatic → tokens, latency, tool histogram,
  │                                       retries, ignored tool errors, redundant calls
  └─ synthesis (optional)    insights  → why-narrative + ranked recommendations
```

**Each layer has a distinct role:**

- **`expect` → facts.** Objective, deterministic, cheap. The hard gate. Each is a
  `Signal { kind: 'deterministic', pass, evidence }`.
- **`judge` → graded claims *with reasoning*.** You only need a few. The verdict's
  `reasoning` is diagnostic evidence the synthesizer consumes — a verdict scores
  *one* claim and never carries cross-cutting fix advice.
  `Signal { kind: 'judge', pass, score, reasoning }`.
- **Derived metrics → no assertion required.** Computed from the trace
  automatically — *this is where "few ground-truth" stops mattering*. The trace
  is rich: tool-call histograms, near-duplicate/redundant calls, tool errors the
  agent ignored, latency hot-spots, token spend per phase. Emitted as
  `Signal { kind: 'metric', name, value, threshold? }`.
- **Synthesis (`insights`) → the "why".** An optional, config-defined evaluator
  that runs **once after the body**, receives the *whole* `TestResult` (all
  signals + metrics + trajectory + traces), and may use the same trace-query
  tools as the agentic judge. It emits structured insight — and needs **zero
  ground truth** because it reasons over the trace itself.

```js
defineConfig({
  insights: async ({ result, signals, metrics, tools, llm }) => {
    // e.g. spot inefficiency the assertions didn't encode
    const dupes = metrics.redundantToolCalls;
    const v = await llm.complete(`Given these signals/metrics/trace, explain why
      the agent scored as it did and list concrete improvements.`);
    return {
      summary: v.summary,
      why: v.why,
      recommendations: v.recommendations,   // ['Cache search_logs results', ...]
      derivedMetrics: { redundantToolCalls: dupes },
    };
  },
});
```

**How the layers combine — three views of one `TestResult`, no either/or:**

| Audience | Derived from | Output |
|----------|-------------|--------|
| **Gate** (benchmark pass-rate) | hard `expect` signals + non-skipped failed judges | `passed` / `failed` / `errored` |
| **Score** (hill-climbing) | weighted judge scores + metric thresholds | 0–1 aggregate |
| **Diagnosis** (improve the agent) | failed `expect`s + judge `reasoning` + trace-derived metric anomalies, run through `insights` | why-narrative + ranked recommendations |

So a test with **two** `expect`s and **one** `judge` still yields a full
diagnostic report: the gate from the asserts, plus an insight narrative the
synthesizer mined from the trace. The UI renders all three — the per-matcher
breakdown (gate), the score, and an Insights panel (why + recommendations).
This is the shift from "did it pass?" to "why did it behave this way, and what
should I change?".

```ts
interface TestResult {
  status: 'passed' | 'failed' | 'errored';
  score?: number;
  signals: Signal[];                 // expect + judge + metric, in body order
  metrics: DerivedMetrics;           // always computed from the trace
  insights?: {                       // present when an `insights` evaluator is configured
    summary: string;
    why: string;
    recommendations: string[];
  };
  runId: string;
}
```

#### 4.8.1 Where the insight layer lives

The `insights` synthesizer is **not** in the test body — it runs *after* it,
uniformly, so every test gets diagnosis with no per-test boilerplate.

- **Defined** in `defineConfig({ insights })` — project-wide by default (keeps the
  benchmark consistent), with an optional per-test override.
- **Runs** in the `sdkEngine`, **server-side**, **once per test**, *after* the
  body finishes and *after* the run's spans have landed (it shares the bounded
  trace-availability wait with the lazy `traces` fixture, §4.4). Server-side
  because that's where the OpenSearch LOGS creds + Bedrock live, and where the
  read-only, `runId`-scoped trace-query tools run.
- **Receives** the whole `TestResult` — all signals (gate + observe), derived
  metrics, trajectory, and the trace tools.
- **Stored** on the persisted `TestResult.insights` and surfaced in the run
  inspector's Insights panel.
- **Optionally rolled up** to a run-level synthesis ("across the suite the agent
  over-calls `search_logs`") by aggregating per-test signals + recommendations —
  a separate, opt-in pass.

Data flow: `body → signals` → engine waits for traces → engine runs the per-test
`insights` synthesizer with trace tools → output persisted next to
signals/metrics → *(optional)* run-level rollup.

---

## 5. Execution architecture: one engine, two transports

```
                         ┌────────────────────────────┐
   CLI (benchmark/run) ──┤                            │
                         │   sdkEngine.runFile(file)  │── load → discover tests
   Server (eval-runs,  ──┤   sdkEngine.runTest(test)  │── per test:
   benchmarks routes)    │                            │     beforeEach → body(fixtures) → afterEach
                         └────────────────────────────┘     (body calls agent.run via connector)
                                      │
                          emits TestRunResult { matcherResults[], status, runId, ... }
                                      │
            ┌─────────────────────────┴─────────────────────────┐
       CLI Reporter (spinner/JSON)                    Server Reporter (storage + SSE → UI)
```

- **Delete** the duplicated body-execution blocks in `evaluationRunner.ts` and `benchmarkRunner.ts` (#246). Both become thin reporters over `sdkEngine`.
- **Delete** the server-side re-import / `evaluateFnMap` materialization in `benchmarks.ts` — the engine loads the file once, in-process, and runs bodies directly. (When the server runs a code benchmark, it invokes the same engine; it does not reconstruct closures across a process/HTTP boundary.)
- `agent.run()` calls the connector directly via the engine; the `runId` it returns is the correlation key the server reporter persists. No second "did the body run?" path.

### Loader unification (#232)

One loader for `.js`, `.ts`, `.mjs`:
- Resolve the SDK module **once** and force every entry point — the custom `.js` require shim *and* the `import()` path for `.ts/.mjs` — to bind that exact instance (inject via `import` hook / `--import` register, or a tiny ESM loader that aliases the package specifier to the in-process module). Tests then always register into the registry the engine reads. The "module-instance mismatch" class of bug is closed.

---

## 6. Grading & status — one surface, honest errors (#242, #243)

Grading derives entirely from the `signals[]` the body produced (§4.8) — the
`expect`/`judge` results. The legacy server-evaluator-needs-`expectedOutcomes`
path is **not** in the code-SDK pipeline at all. Status is the *gate* view of
those signals; `score` and `insights` are the other two views (§4.8).

- `judge(result, criteria)` sends `criteria` as the judge's claim directly — it *is* the expectation. No `expectedOutcomes` requirement. (#243 closed.)
- A judge/connector/infra failure produces a distinct terminal status, never a `completed` run with `metrics: 0`:

```ts
type TestStatus =
  | 'passed'        // all GATE-role signals passed (observe/skipped don't count)
  | 'failed'        // ≥1 GATE-role signal failed (real signal)
  | 'errored';      // body/agent/judge threw an infra/validation error — EXCLUDED from pass-rate
```

A `skipped` judge (§4.7.1) is **neutral** — it never flips `passed`→`failed`.
`errored` is surfaced with the *actual* error string and excluded from pass-rate aggregation (#242 closed). No more "Waiting for traces…" masking "Missing required field: expectedOutcomes."

`expectedOutcomes`/`expectedTrajectory` remain on `TestOptions` purely so JSON round-trip and *non-code* consumers keep working — they never gate the code body.

---

## 7. How each issue is resolved

| Issue | Resolution in v2 |
|-------|------------------|
| **#245** body never runs under `benchmark -f` | One engine; CLI and server both call `sdkEngine.runTest`. The body always runs because running the body *is* the engine. |
| **#238** lazy/`invoke` fixture | `agent.run()` *is* the invoke fixture. Computed prompts, multi-turn, N invocations all natural. Eager mode deleted. |
| **#248** hooks run after the agent | Agent call lives in the body; fixtures/`beforeEach` resolve before the body → before the agent, by construction. The 3 coupled type hacks disappear. |
| **#243** inline `judge()` criteria ignored | `judge(result, criteria)` sends the criteria as the claim; no `expectedOutcomes` needed (§4.7). |
| **#244** custom evaluators in code/config | `evaluators: {}` in `defineConfig` + `judge(result, { evaluator })`; runs in-process with run context + trace tools (§4.7). |
| **#242** judge error → silent `completed/0` | Distinct `errored` status with the real message; excluded from pass-rate. |
| **#230** traces silently zero | `result.traces` is lazy, scoped to the run's `runId`, and throws (or awaits then throws) instead of returning silent zeros. |
| **#232** `.ts/.mjs` register nothing | Single loader binds one SDK module instance across `.js/.ts/.mjs`. |
| **#246** duplicated runners | Both runners become reporters over the single engine; the duplicated block is deleted. |
| *latent* global session under concurrency | One `TestContext` per test; module-global `activeSession` deleted. |

---

## 8. Migration: v1 is removed outright (no compat)

The SDK is experimental with effectively one user (the author), so we **delete
v1 rather than shim it**. This is a deliberate simplification: keeping an
eager-invocation compatibility path would re-introduce the very dual-path
complexity this RFC removes.

- The old eager `test(name, { prompt }, ({ result }) => …)` form is **gone**.
  Bodies receive `agent`/`expect`/`judge`/`traces` and drive invocation
  themselves. There is no `result` fixture and no auto-`agent.run()`.
- Matcher names move to the `toX` convention (`toHaveCalledTool`,
  `toCompleteWithin`, …); `agentOutput` → `output`. No deprecated aliases.
- `judge()` no longer throws by default (§4.7).
- A one-off `npx agent-health migrate-sdk` codemod is offered as a convenience
  (rewrite `{ result }` bodies to `{ agent }` + explicit `agent.run()`, rename
  matchers), but it is *not* a compatibility guarantee — just author ergonomics.

Net effect: the engine has a single code path, no `AGENT_HEALTH_SDK_COMPAT`
flag, and no eager branch to maintain.

---

## 9. Phased implementation plan

1. **Engine extraction.** Create `services/sdkEngine.ts`: `runFile`, `runTest`, per-test `TestContext`, one trajectory/trace/judge capture path. Factor `invokeAgent()` out of `runEvaluationWithConnector()`. Move the body-execution logic out of `evaluationRunner.ts`; have that runner call the engine. (Pure de-dup — kills the global `activeSession`.)
2. **`agent` fixture + control inversion.** Add `agent.run()` (= one `invokeAgent` call, **second call throws**); make `expect/judge/traces` result-scoped; delete `activeSession`. Rewrite the demo evals to the new form (no compat shim).
3. **Judge v2** (§4.7): run-scoped `judge(result, spec)` returning a non-throwing `Verdict`; contextual mode over `/api/judge` with traces/logs context; **errored** status (#242, #243). Includes the **content-addressed cache** and **skip mode** (§4.7.1).
4. **Trace-query tool pack + agentic/custom judge** (#244): wire `trace_query` to `fetchSpansForRun`/`fetchLogsForRun` (read-only, runId-scoped); enable the tool-using judge path; `evaluators: {}` in `defineConfig`.
5. **Lazy honest traces** (#230) on `RunResult.traces`.
6. **Second transport.** Point `benchmarkRunner.ts` and `benchmark -f` at the engine; delete the `benchmarks.ts` re-import/`evaluateFnMap` materialization (#245, #246).
7. **Loader unification** (#232): single SDK-module binding for `.js/.ts/.mjs`.
8. **Fixtures (`test.extend` + `use`)** and hooks-wrap-agent (#248).
9. **Composition & insight layer** (§4.8): always-computed derived trace metrics; opt-in `insights` synthesizer in `defineConfig`; `TestResult { signals, metrics, insights }` + the UI Insights panel (why + recommendations).
10. **Docs rewrite + codemod**; remove v1 entirely.

Each phase is independently shippable and testable. After phase 6 the headline bug (#245) and the whole #238 RFC are resolved with net *less* code than today; phases 9–10 deliver the diagnosis vision (insights/recommendations) on top.

---

## 10. Open questions

- **Discovery for dynamic prompts.** Tests with no `defaultPrompt` show as "dynamic"; we capture the actual prompt from the single `agent.run()` at run time and attach it to the report.
- **Hashing/dedup** when there's no static prompt: hash `name + labels + body source` (already partially done in `computeTestCaseHash`).
- **Naming:** `agent.run()` vs `agent.invoke()` vs `agent.send()`. Recommend `run` (reads well, matches "agent run").
- **Insight cost.** The `insights` synthesizer is an extra LLM call per test. Default it **off** (opt-in via config), and let it reuse the judge cache so a sweep over identical trajectories synthesizes once.
- **Where derived metrics live.** Some are connector-agnostic (token/latency from `RunResult`); richer ones (redundant tool calls, ignored tool errors) need trace access. Compute the cheap ones always; gate the trace-derived ones on `useTraces`.
- **Trace-query tool safety:** the `query(dsl)` raw-DSL tool is powerful — restrict it to read-only and scope it to the run's own `runId` so a judge/insight prompt-injection can't exfiltrate unrelated data.
