/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EvaluationRun,
  TestCase,
  BenchmarkRunStatus,
  RunResultStatus,
  RunStats,
  AgentConfig,
  RunPerformanceMetrics,
  EvaluationReport,
  Benchmark,
  BenchmarkRun,
  PassFailStatus,
} from '@/types';
import type { IStorageModule } from '@/server/adapters/types';
import { runEvaluationWithConnector, callBedrockJudge, invokeAgent, computeSdkMatcherSessionMetrics } from '@/services/evaluation';
import { resolveAgentModel } from '@/lib/resolveAgentModel';
import { readEnv } from '@/lib/envCompat';
import { buildJudgeAgentsHints } from '@/services/traces/judgeAgentsHints';
import { buildEvaluatorErrorPatch } from '@/services/evaluation/evaluatorError';
import { connectorRegistry } from '@/connectors/server';
import { startTestCaseSpan, finalizeTestCaseSpan, addEvaluationResultEvents } from '@/lib/telemetry';
import { ATTR_AGENT_HEALTH_AGENT_RUN_ID } from '@/lib/telemetry/constants';
import { SpanStatusCode, context } from '@opentelemetry/api';
import { v4 as uuidv4 } from 'uuid';
import {
  runInSession,
  recordVerdict,
  emptyTracesAccessor,
  unavailableTracesAccessor,
  buildTracesAccessor,
  buildJudgeMatcherEntry,
  formatExpectedOutcomesAsClaim,
} from '@/lib/matchers/index';
import type { TracesAccessor } from '@/lib/matchers/index';
import type { EvalResult, TrajectoryAccessor, TestFixtures, RegisteredHook } from '@/lib/testCases/types';
import { createAgentFixture } from '@/lib/testCases/agentFixture';
import type { AgentRunOptions } from '@/lib/testCases/agentFixture';
import { evaluate as evaluateFixture } from '@/lib/testCases/evaluators';
import { judge, bindJudge, clearJudgeCache } from '@/lib/testCases/judge';
import { expect } from '@/lib/matchers/expect';
import type { TrajectoryStep } from '@/types';
import { createHookOrchestrator, type TestDescriptor } from './hookOrchestrator';
import { bucketRunResults } from '@/lib/runStats';
import { loadConfigSync } from '@/lib/config/index';
import { getBackendUrl } from '@/lib/portConfig';
import { DEFAULT_CONFIG } from '@/lib/constants';
import { getCustomAgents } from '@/server/services/customAgentStore';
import { debug } from '@/lib/debug';
import { tracePollingManager } from './traces/tracePoller';
import { fetchSpansForRun, type TraceWindowAgent } from './traces/fetchSpansForRun';
import { CancellationToken, createCancellationToken } from './benchmarkRunner';

export type { CancellationToken } from './benchmarkRunner';
export { createCancellationToken } from './benchmarkRunner';

export interface EvaluationRunProgress {
  runId: string;
  testCaseId: string;
  startedCount: number;
  completedCount: number;
  totalTestCases: number;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
}

export interface ExecuteEvaluationRunOptions {
  cancellationToken?: CancellationToken;
  storageModule: IStorageModule;
  onProgress: (progress: EvaluationRunProgress) => void;
  onTestCaseComplete?: (testCaseId: string, result: {
    reportId: string;
    status: RunResultStatus;
    error?: string;
  }) => Promise<void>;
  evaluateFnMap?: Map<string, (result: any) => Promise<void> | void>;
  /**
   * SDK lifecycle hooks (`beforeAll`/`afterAll`/`beforeEach`/`afterEach`)
   * registered by code-imported eval files, keyed by the absolute file
   * path the loader resolved. When omitted or empty, hooks are a no-op.
   */
  hooksByFile?: Map<string, RegisteredHook[]>;
  /**
   * Per-test-case scope info (sourceFile + describePath) so the
   * orchestrator can look up the right scope chain. Required to be
   * present for code-imported test cases that have hooks registered;
   * tests missing from the map fall through to file-level hooks only.
   */
  testHookScopes?: Map<string, { sourceFile?: string; describePath?: string }>;
}

/**
 * Safely load config with fallback to defaults.
 */
function getConfig() {
  try {
    return loadConfigSync();
  } catch {
    return DEFAULT_CONFIG;
  }
}

/**
 * Run async tasks with bounded concurrency.
 * Uses a sliding-window approach: starts new tasks as previous ones complete,
 * maintaining up to `limit` tasks running at once.
 */
async function runWithConcurrencyLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
  isCancelled?: () => boolean
): Promise<void> {
  const executing = new Set<Promise<void>>();
  for (const item of items) {
    if (isCancelled?.()) break;
    const p = fn(item).then(() => { executing.delete(p); });
    executing.add(p);
    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }
  await Promise.all(executing);
}

/**
 * Execute an EvaluationRun against a set of resolved test cases.
 *
 * This is the source-agnostic execution engine. It takes resolved test cases
 * directly instead of looking them up from a benchmark, making it usable for
 * ad-hoc runs, benchmark runs, and scheduled runs alike.
 */
export async function executeEvaluationRun(
  run: EvaluationRun,
  testCases: TestCase[],
  options: ExecuteEvaluationRunOptions
): Promise<EvaluationRun> {
  const { cancellationToken, storageModule, onProgress, onTestCaseComplete, evaluateFnMap, hooksByFile, testHookScopes } = options;
  // Fresh judge verdict cache per run — content-addressed caching is safe
  // within a run (evaluator is fixed) but could serve stale verdicts across
  // runs if an evaluator was edited in a long-lived server process.
  clearJudgeCache();
  const totalTestCases = testCases.length;
  const concurrency = run.concurrency ?? 1;
  const runStartTime = Date.now();

  console.log(`[EvaluationRunner] Starting run ${run.id} with concurrency=${concurrency} for ${totalTestCases} test cases`);

  // Build agent config
  const config = getConfig();
  const allAgents = [...config.agents, ...getCustomAgents()];
  const baseAgent = allAgents.find(a => a.key === run.agentKey);

  if (!baseAgent) {
    throw new Error(`Agent not found: ${run.agentKey}`);
  }

  const agentConfig: AgentConfig = {
    ...baseAgent,
    endpoint: run.agentEndpoint || baseAgent.endpoint,
    headers: {
      ...baseAgent.headers,
      ...run.headers,
    },
  };

  // Resolve the agent's LLM from the AGENT's own config (connectorConfig),
  // never a user-selected run.modelId. `run.modelId` is only a backward-compat
  // fallback for runs created before the agent-model concept was removed.
  const effectiveModelId = resolveAgentModel(baseAgent, run.modelId);
  const modelConfig = config.models[effectiveModelId];
  const bedrockModelId = modelConfig?.model_id || effectiveModelId;

  // Build the hook orchestrator once per run. The factory hands the
  // orchestrator a fresh `TestFixtures` skeleton on demand; it stamps
  // `testInfo` and `provisioned` and adds `provide` for `beforeEach`.
  // Tests with no hooks pay zero cost — createHookOrchestrator returns a
  // no-op when hooksByFile is empty.
  const hookDescriptors: TestDescriptor[] = testCases.map(tc => {
    const scope = testHookScopes?.get(tc.id);
    return {
      testCaseId: tc.id,
      name: tc.name,
      sourceFile: scope?.sourceFile,
      describePath: scope?.describePath,
    };
  });
  const hookOrchestrator = createHookOrchestrator(
    hooksByFile,
    hookDescriptors,
    () => ({
      result: {} as any,            // overwritten by runner with real EvalResult
      judge,
      traces: emptyTracesAccessor(),
      expect,
      testInfo: { name: '' },       // overwritten by orchestrator
      provisioned: {},
    }),
  );

  // Initialize results if not already set
  if (!run.results) {
    run.results = {};
  }

  // Mutable counters for tracking progress across concurrent tasks
  let completedCount = 0;
  let startedCount = 0;

  // Shared throttle signal for rate-limit backoff
  let throttleUntil = 0;
  let consecutiveThrottles = 0;

  try {
    await runWithConcurrencyLimit(
      testCases,
      concurrency,
      async (testCase: TestCase) => {
        const testCaseId = testCase.id;

        // Check for cancellation before starting
        if (cancellationToken?.isCancelled) {
          return;
        }

        // Wait if a sibling task recently hit a rate-limit error
        const now = Date.now();
        if (now < throttleUntil) {
          await new Promise(r => setTimeout(r, throttleUntil - now));
        }

        // Cross-surface parity: pre-persist a `status: running` placeholder
        // for this test case BEFORE we emit the `progress: status: running`
        // SSE event. /api/evaluate (UI "Run Test" path) already does this so
        // the runs list shows an in-progress row immediately and the UI can
        // resolve evaluatorId for hover/tooltips while the agent is still
        // working. Without this, the runs list stays empty until the agent
        // finishes — the exact UX gap the customer reported on
        // tc-1780591691582-ezc0vkdpj.
        //
        // The order matters: SSE consumers (CLI, web client, SDK tests)
        // listen for `progress: status: running` as the signal to query the
        // runs list. If the placeholder doesn't yet exist when that event
        // fires, the consumer will see an empty list and assume "no row"
        // — even though one is about to appear. Persist FIRST so the
        // contract "once a `running` event has been observed, the row is
        // already on disk" holds for every subscriber.
        //
        // Best-effort: a storage failure here must not abort the run, so
        // we swallow the error and fall back to the post-completion
        // `runs.create()` below (which is what the runner did historically).
        let placeholderRunId: string | undefined;
        try {
          const placeholder = await storageModule.runs.create({
            // status / metricsStatus mirror what /api/evaluate persists so
            // the runs list filter `status=running` finds this row.
            status: 'running',
            metricsStatus: 'pending',
            // Identity / linkage — enough for the UI's runs list to render
            // the row, and for run-details to load the test case + parent
            // evaluation run.
            testCaseId,
            testCaseVersion: (testCase as any).currentVersion ?? (testCase as any).version ?? 1,
            agentKey: agentConfig.key,
            agentName: agentConfig.name,
            agentId: agentConfig.key,
            agentEndpoint: agentConfig.endpoint,
            modelId: effectiveModelId,
            modelName: modelConfig?.display_name || effectiveModelId,
            // Inherit run-level judgeModelId onto the per-test-case run.
            // Same pattern as `evaluatorId` below — the run-detail UI
            // and the audit trail need to know which judge model graded
            // each child report, not just the parent EvaluationRun.
            judgeModelId: run.judgeModelId,
            connectorProtocol: (agentConfig as any).connectorType,
            // The whole point of this fix: persist evaluatorId on the
            // per-test-case run so the run-details page resolves the
            // right evaluator and the score tooltip shows evaluator-
            // specified rubric metrics. Inherits from the run-level
            // evaluatorId the customer set on the EvaluationRun.
            evaluatorId: run.evaluatorId,
            // Group the run under its parent EvaluationRun so the
            // experimentContext lookup in RunDetailsPage works.
            experimentRunId: run.id,
            experimentId: run.benchmarkId,
            // Empty fixtures — will be populated when the agent + judge
            // complete and we update this same doc.
            trajectory: [],
            metrics: {},
            llmJudgeReasoning: '',
            timestamp: new Date().toISOString(),
          } as any);
          placeholderRunId = placeholder.id;
          debug('EvaluationRunner', `[${testCaseId}] Pre-persisted placeholder run: ${placeholderRunId}`);
        } catch (placeholderErr: any) {
          // Storage may not be configured / may be transiently unavailable.
          // Log and proceed — we'll fall through to the legacy create path
          // after the run completes, which preserves backwards compatibility.
          console.warn(
            `[EvaluationRunner] Failed to pre-persist placeholder for ${testCaseId} ` +
              `— in-progress runs list will not show a row for this test case. ` +
              `Reason: ${placeholderErr.message}`
          );
        }

        // Report progress — this test case is starting. The placeholder
        // (when persisted above) is already on disk, so SSE consumers that
        // poll the runs list right after seeing `running` will find it.
        startedCount++;
        onProgress({
          runId: run.id,
          testCaseId,
          startedCount,
          completedCount,
          totalTestCases,
          status: 'running',
        });

        debug('EvaluationRunner', `[${testCaseId}] Starting evaluation (${completedCount}/${totalTestCases} completed)`);

        // Set status to running on the in-memory results map (mirrors the
        // placeholder we just persisted).
        run.results[testCaseId] = {
          reportId: placeholderRunId || '',
          status: 'running',
        };

        // Start the OTel `test_case` eval span BEFORE invoking the agent so the
        // eval span is the active OTel context when the connector spawns/calls
        // the agent. Connectors with `traceContext.propagateEnv/Header` then
        // inject TRACEPARENT/`traceparent`, making the agent's root span a child
        // of this eval span (Strategy A — single trace tree). Without this wrap
        // the evaluation-runs path (the headline `benchmark -f *.eval.js` route)
        // silently degrades to Strategy C; see AGENTS.md "Trace correlation".
        // We synthesize a benchmark shell (the span helper only reads `.name`
        // from it and `.id` from the run) since this path has no Benchmark.
        const synthBenchmark = { name: `evaluation-run:${run.benchmarkId ?? run.id}` } as Benchmark;
        const caseSpanResult = startTestCaseSpan(
          context.active(),
          testCase,
          synthBenchmark,
          run as unknown as BenchmarkRun
        );
        const caseSpan = caseSpanResult?.span;
        const caseSpanContext = caseSpanResult?.context;

        try {
          // Check if this test case has a deterministic evaluate function
          // (an SDK `test()` body). Code tests use control inversion; classic
          // test cases (no body) use the eager judge path below.
          const hasDeterministicEval = evaluateFnMap?.has(testCaseId) ?? false;
          // Detect code-only tests that have no prompt — the body simply
          // never calls agent.run() and the report stays empty.
          const hasPrompt = !!(testCase.initialPrompt && testCase.initialPrompt.trim().length > 0);

          let report: EvaluationReport;
          if (hasDeterministicEval) {
            // CONTROL INVERSION (RFC 004 §4.1, #256): the test body drives the
            // agent via the `agent` fixture rather than the framework invoking
            // eagerly before the body. invokeAgent() runs only when the body
            // calls `agent.run()` (at most once — enforced by the fixture); we
            // then fold the captured trajectory/traces into the report. Setup
            // performed before `agent.run()` therefore happens before the
            // agent ever sees a prompt (#248).
            const evalFn = evaluateFnMap!.get(testCaseId)!;
            report = synthesizeEmptyReport(testCase, agentConfig.key, bedrockModelId);

            // Traces are only meaningful after the agent has run. This view
            // forwards to the accessor loaded inside the invoke callback;
            // reading it before `agent.run()` fails loudly (#230 semantics).
            let loadedTraces: TracesAccessor = unavailableTracesAccessor(
              'traces are only available after agent.run() has been called'
            );
            const tracesView: TracesAccessor = {
              get totalTokens() { return loadedTraces.totalTokens; },
              get totalCost() { return loadedTraces.totalCost; },
              get costSource() { return loadedTraces.costSource; },
              get toolCalls() { return loadedTraces.toolCalls; },
              get spans() { return loadedTraces.spans; },
              spanDuration: (name: string) => loadedTraces.spanDuration(name),
            };

            // The runner-supplied invocation behind `agent.run()`. Reuses the
            // shared invokeAgent() primitive so the trajectory + trace
            // correlation match the classic path exactly.
            // Captured result from agent.run(), reflected into fixtures.result
            // before afterEach/afterAll so hooks that read `result` see the
            // real run (not the empty placeholder). See #248.
            let capturedResult: EvalResult | undefined;
            const invoke = async (prompt: string, options?: AgentRunOptions): Promise<EvalResult> => {
              const invocationTestCase: TestCase = {
                ...testCase,
                initialPrompt: prompt,
                ...(options?.context ? { context: options.context as any } : {}),
              };
              const doInvoke = () => invokeAgent(agentConfig, bedrockModelId, invocationTestCase, {
                registry: connectorRegistry,
                ...(options?.env ? { env: options.env } : {}),
              });
              // Wrap in the eval span's context so connectors propagate W3C
              // trace context to the agent (Strategy A). Mirrors benchmarkRunner.
              const inv = caseSpanContext
                ? await context.with(caseSpanContext, doInvoke)
                : await doInvoke();
              const agentOutput = inv.trajectory
                .filter((s: any) => s.type === 'response' || s.type === 'assistant')
                .map((s: any) => s.content)
                .join('\n');
              const evalResult = buildEvalResult({
                trajectory: inv.trajectory,
                agentOutput,
                rawEvents: inv.rawEvents,
                runId: inv.runId ?? undefined,
                durationMs: inv.agentDurationMs,
              });
              // Fold the invocation into the report shell, then load traces
              // for the body (see #230 loud-failure semantics).
              report.trajectory = inv.trajectory;
              report.rawEvents = inv.rawEvents;
              (report as any).runId = inv.runId ?? undefined;
              (report as any).sessionId = inv.metadata?.sessionId ?? undefined;
              report.performanceMetrics = {
                durationMs: inv.agentDurationMs,
                agentDurationMs: inv.agentDurationMs,
              };
              (report as any).connectorProtocol = inv.connector.type;
              // Strategy-C correlation (see benchmarkRunner.ts): pass the
              // connector's service.name + the run window so agents that emit
              // OTel under their own traceId (Claude Code / subprocess agents)
              // get their spans correlated to the judge + `traces` fixture.
              const traceServiceName = (inv.connector as any)?.traceContext?.serviceName as
                | string
                | undefined;
              const traceWindow: TraceWindowAgent[] | undefined = traceServiceName
                ? [{
                    serviceName: traceServiceName,
                    startedAt: Date.now() - (inv.agentDurationMs || 0) - 60_000,
                    endedAt: Date.now() + 60_000,
                  }]
                : undefined;
              loadedTraces = await loadTracesAccessor(agentConfig, inv.runId ?? undefined, traceWindow);
              // Expose traces on the result too (RFC 004 §4.6) so the body
              // can read `result.traces.*` in addition to the `traces` fixture.
              (evalResult as any).traces = loadedTraces;
              // Forward the SAME Strategy-C correlation window the classic
              // `waitForTracesAndJudge` path uses (`buildJudgeAgentsHints`) so
              // an inline `judge(result, …)` reaches the agent (trace) judge
              // with `agents` hints — parity with the UI/runner path (#264).
              (evalResult as any).judgeAgents = traceWindow;
              capturedResult = evalResult;
              return evalResult;
            };

            const agentFixture = createAgentFixture(invoke, {
              defaultPrompt: hasPrompt ? testCase.initialPrompt : undefined,
            });

            // Placeholder result handed to the body before `agent.run()` —
            // empty trajectory/output. Bodies read the value returned by
            // `agent.run()`; this keeps `fixtures.result` a valid EvalResult.
            const emptyResult = buildEvalResult({
              trajectory: [], agentOutput: '', rawEvents: [], durationMs: 0,
            });

            const scope = testHookScopes?.get(testCaseId);
            const desc: TestDescriptor = {
              testCaseId,
              name: testCase.name,
              sourceFile: scope?.sourceFile,
              describePath: scope?.describePath,
            };

            // Run the body inside a per-test matcher session (ALS-scoped, so
            // concurrent tests never share verdicts — RFC 004). The judge
            // fixture is pre-bound to the run-level evaluator + model (#257).
            let fixtures: TestFixtures | undefined;
            const { results: matcherResults, error: evalError } = await runInSession(async () => {
              const before = await hookOrchestrator.beforeTest(desc);
              for (const r of before.matcherResults) recordVerdict(r);

              fixtures = {
                ...before.fixtures,
                result: emptyResult,
                agent: agentFixture,
                traces: tracesView,
                // Judge fixture binding. We pass the run-level `judgeModelId`
                // (customer input) as the bound `model`, NOT the agent's
                // bedrockModelId. Pre-fix this passed `bedrockModelId` which
                // meant the agent's model leaked into the judge call as if
                // it were the judge model — wrong for any judge that's not
                // configured to use the same model as the agent. The server
                // /api/judge resolves the actual judge model from the
                // evaluator config when this is undefined.
                // Pin the judge fixture to *this* server's actual bound URL.
                // The runner is in-process so AH_PORT is correct, but passing
                // serverUrl explicitly stops the SDK judge from re-deriving
                // (and possibly defaulting to 4001 / a foreign instance) if
                // env is ever mutated mid-run. See AGENTS.md → server lifecycle.
                judge: bindJudge({ evaluatorId: run.evaluatorId, model: run.judgeModelId, serverUrl: getBackendUrl() }),
                evaluate: evaluateFixture,
              };
              const arg = Object.assign(emptyResult, { ...fixtures, result: emptyResult }) as any;

              try {
                if (!before.aborted) {
                  await evalFn(arg);
                }
              } finally {
                // Reflect the captured run into fixtures.result so afterEach/
                // afterAll hooks observe the real result rather than the empty
                // placeholder (#248).
                if (fixtures && capturedResult) {
                  fixtures.result = capturedResult;
                }
                // Always run afterEach/afterAll — even when the body threw.
                const after = await hookOrchestrator.afterTest(desc, fixtures);
                for (const r of after) recordVerdict(r);
              }
            });

            // observe-role signals never gate; errored signals are bucketed
            // separately as `errored` (excluded from pass-rate), not `failed`.
            const erroredMatchers = matcherResults.filter(m => m.errored);
            const anyErrored = erroredMatchers.length > 0;
            const anyGateFailed = matcherResults.some(
              m => !m.pass && m.role !== 'observe' && !m.errored,
            );
            // #335: distinguish an *agent* failure (subprocess timeout / crash —
            // `capturedResult` was never set because `agent.run()` rejected) from
            // a deliberate gate failure. The former must surface as a clearly
            // labelled `errored` run, not a silent `failed` with an empty card.
            // BUT a no-prompt/deterministic test whose body threw a *recorded*
            // gate failure (e.g. a failing chai `expect()` — which both records a
            // code-assertion matcher AND throws) is a FAILED test, not an agent
            // failure: a real agent crash produces no matcher (`anyGateFailed`
            // is false). Without this guard such runs were bucketed as errored
            // (metricsStatus:'error' → passFailStatus null), regressing #245.
            const agentFailed =
              evalError !== undefined && capturedResult === undefined && !anyGateFailed;
            const failed = anyGateFailed || evalError !== undefined;
            (report as any).evaluationType = 'deterministic';
            (report as any).matcherResults = matcherResults;
            if (evalError !== undefined) {
              (report as any).assertionError =
                (evalError as any)?.message ?? String(evalError);
            }

            if (anyErrored) {
              // At least one judge/evaluator could not run. Bucket the run as
              // `errored` via the canonical #247 patch (metricsStatus:'error',
              // passFailStatus cleared) instead of a misleading score-0
              // `failed` — errored runs are excluded from pass-rate.
              Object.assign(
                report,
                buildEvaluatorErrorPatch('judge_failed', erroredMatchers[0].errorMessage ?? 'judge errored'),
              );
              (report as any).skipJudge = true;
            } else if (agentFailed) {
              // #335: the agent never produced a trajectory (timeout/crash).
              // Surface the underlying message (e.g. "Subprocess timed out after
              // 600000ms") on the report instead of a silent empty `failed`.
              Object.assign(
                report,
                buildEvaluatorErrorPatch('agent_failed', (evalError as any)?.message ?? String(evalError)),
              );
              (report as any).skipJudge = true;
            } else {
              (report as any).passFailStatus = failed ? 'failed' : 'passed';
              // Option B BC shim: legacy `llmJudgeReasoning` is a derived view
              // of `matcherResults`. SDK runs leave it empty — judge data lives
              // in `matcherResults` (read via getJudgeMatcherResults()).
              (report as any).llmJudgeReasoning = '';
              // Report-level metrics: pass-rate aggregate (and dimensional
              // pass-through when matchers carry per-claim `judgeMetrics`).
              // Pre-fix this was hardcoded {0,0,0,0}/{100,100,100,100}, which
              // erased partial credit AND silently dropped any custom-evaluator
              // dimensions a multi-claim run produced. See
              // computeSdkMatcherSessionMetrics() in services/evaluation/index.ts.
              (report as any).metrics = computeSdkMatcherSessionMetrics(
                matcherResults,
                { hasEvalError: evalError !== undefined },
              );
              // Matcher session already decided the verdict — mark final so the
              // trace-mode polling / Bedrock-judge path below is skipped.
              (report as any).metricsStatus = 'completed';
              (report as any).skipJudge = true;
            }

            // #334: attach the run's OTel traceId + spans to the report so the
            // run-report Traces tab renders the tree for code-eval (deterministic)
            // runs too. The classic path does this via waitForTracesAndJudge; the
            // deterministic path skipped it entirely. Reuse the spans the pre-poll
            // (loadTracesAccessor) already fetched from OpenSearch — no extra
            // query. Guarded: reading an `unavailable` accessor throws (ingestion
            // lag / opt-out), in which case we leave traceId/spans unset.
            try {
              const fetchedSpans = (capturedResult as any)?.traces?.spans;
              if (Array.isArray(fetchedSpans) && fetchedSpans.length > 0) {
                (report as any).spans = fetchedSpans;
                if (!(report as any).traceId) {
                  (report as any).traceId = fetchedSpans[0]?.traceId;
                }
              }
            } catch { /* traces fixture unavailable — leave traceId/spans unset */ }
          } else {
            // CLASSIC PATH: no code body. Eagerly invoke the agent and run the
            // Bedrock judge (or, for useTraces agents, return a pending report
            // that the trace-polling block below completes). Wrapped in the
            // eval span's context so connectors propagate trace context
            // (Strategy A), matching benchmarkRunner and the SDK path above.
            const runEval = () => runEvaluationWithConnector(
              agentConfig,
              bedrockModelId,
              testCase,
              () => {}, // No debug callback needed
              {
                registry: connectorRegistry,
                evaluatorId: run.evaluatorId,
                // Forward run-level judge model so the SDK runs match the
                // UI/CLI "separate agent vs judge model" contract. Persisted
                // on the child report via the saveReport patch below.
                judgeModelId: run.judgeModelId,
                skipJudge: false,
              }
            );
            report = caseSpanContext
              ? await context.with(caseSpanContext, runEval)
              : await runEval();

            // Classic non-trace reports carry no `metricsStatus`. Without an
            // explicit stamp, the pre-persisted placeholder's 'pending'
            // survives the update-merge below ({...existing, ...fields}
            // never clears a key the report doesn't carry), and the runner
            // then trace-polls a NON-traced agent for the full timeout
            // (10 min for a mock/demo run) before erroring the report.
            // benchmarkRunner clears this explicitly; mirror it here.
            if ((report as any).metricsStatus === undefined) {
              (report as any).metricsStatus = agentConfig.useTraces ? 'pending' : 'completed';
            }
          }

          // Save the report via storage module. When we successfully
          // pre-persisted a placeholder above, UPDATE the same doc so the
          // running-row -> completed-row transition is observable in place
          // (mirrors /api/evaluate). When the placeholder couldn't be
          // created (storage transient failure), fall back to the legacy
          // create path so the run is still saved.
          //
          // Crucial: persist `evaluatorId` on the report regardless of
          // path. The runner has it on `run.evaluatorId`; the report
          // returned by `runEvaluationWithConnector` doesn't carry it
          // (the connector path predates the cross-surface parity work),
          // so we stamp it onto the doc here.
          (report as any).evaluatorId = (report as any).evaluatorId ?? run.evaluatorId;
          // Stamp the eval test_case span's traceId (Strategy A correlator).
          // Agents that adopt the propagated traceparent (REST via header,
          // pi via TRACEPARENT env) emit their spans under this exact
          // traceId, giving the trace poller a precise, window-free match.
          (report as any).traceId = (report as any).traceId ?? caseSpan?.spanContext().traceId;
          // Same fallback for judgeModelId — the connector return path
          // doesn't carry it, but `run.judgeModelId` is the cx input so
          // we stamp it onto the report on save.
          (report as any).judgeModelId = (report as any).judgeModelId ?? run.judgeModelId;
          (report as any).experimentRunId = (report as any).experimentRunId ?? run.id;
          (report as any).experimentId = (report as any).experimentId ?? run.benchmarkId;
          let savedReport: EvaluationReport;
          if (placeholderRunId) {
            // Mirror saveReportWithModule's update shape: pass the report
            // fields plus the placeholder id so storage merges in place.
            // We exclude `id` from the spread so the placeholder's id wins.
            const { id: _ignored, ...reportFields } = report as any;
            savedReport = (await storageModule.runs.update(
              placeholderRunId,
              reportFields as any,
            )) as any;
          } else {
            savedReport = await storageModule.runs.create(report as any);
          }

          // If trace mode (metricsStatus: 'pending'), poll for traces and run judge inline.
          // Skipped for deterministic runs (matcher session decided the verdict already).
          //
          // `waitForTracesAndJudge` writes the final verdict to STORAGE but
          // previously returned void, leaving `savedReport` (the in-memory
          // object below) stuck at its pre-judge `metricsStatus: 'pending'` /
          // undefined `passFailStatus`. That caused every trace-judged test
          // case to be recorded as a bare 'completed' with no verdict, which
          // the stats loop below then silently counted as "passed" — e.g. a
          // run with 66/84 real verdicts displaying 84/84 passed. Capture the
          // resolved judgment here and use IT (not the stale `savedReport`)
          // to decide the outcome.
          // `judgeOutcome` is `undefined` when the trace-judged branch below
          // never ran (deterministic test, or a report that was already
          // fully judged) — in that case we fall back to the (fresh, not
          // stale) `savedReport.passFailStatus` from the synchronous path.
          let judgeOutcome: PassFailStatus | null | undefined;
          // Guarded on agentConfig.useTraces: only trace-mode agents legitimately
          // produce 'pending' — a stale placeholder 'pending' surviving a save-merge
          // must never send an eagerly-judged report into trace polling that
          // clobbers its verdict. No runId requirement: the poller correlates
          // via sessionId/service-window hints when Strategy B is unavailable
          // (REST agents never get a runId; Claude Code spans carry only session.id).
          if (
            !hasDeterministicEval &&
            agentConfig?.useTraces &&
            savedReport.metricsStatus === 'pending'
          ) {
            debug('EvaluationRunner', `[${testCaseId}] Trace mode: polling for traces (runId=${savedReport.runId ?? 'none — window/session correlation'})`);
            judgeOutcome = await waitForTracesAndJudge(savedReport, testCase, storageModule, agentConfig);
          }

          // Update result with success. The run-level status mirrors the
          // report's verdict so aggregate stats (run.stats.passed/failed)
          // reflect what actually happened rather than just "the runner
          // didn't crash". Reports that finished but failed assertions are
          // marked 'failed' here too. When the trace-judged path ran above,
          // prefer its resolved outcome over the (now stale) `savedReport`.
          // A null/undefined passFailStatus (judge/evaluator error) is left
          // OFF the result on purpose — `bucketRunResults` (lib/runStats)
          // treats a 'completed' result with no passFailStatus as `errored`,
          // never as a silent pass.
          const reportPassFail = judgeOutcome !== undefined ? judgeOutcome : (savedReport as any).passFailStatus;
          const status: RunResultStatus = reportPassFail === 'failed' ? 'failed' : 'completed';
          run.results[testCaseId] = {
            reportId: savedReport.id,
            status,
            ...(reportPassFail ? { passFailStatus: reportPassFail } : {}),
          };

          // Finalize the OTel test_case span with the evaluation outcome.
          if (caseSpan) {
            caseSpan.setAttribute(ATTR_AGENT_HEALTH_AGENT_RUN_ID, savedReport.runId || '');
            try {
              addEvaluationResultEvents(caseSpan, savedReport as any);
              finalizeTestCaseSpan(caseSpan, savedReport as any);
            } catch {
              caseSpan.end();
            }
          }
          completedCount++;
          consecutiveThrottles = Math.max(0, consecutiveThrottles - 1);
          debug('EvaluationRunner', `[${testCaseId}] Completed (${completedCount}/${totalTestCases})`);

          // Notify caller
          onProgress({
            runId: run.id,
            testCaseId,
            startedCount,
            completedCount,
            totalTestCases,
            status: 'running',
          });

          if (onTestCaseComplete) {
            await onTestCaseComplete(testCaseId, run.results[testCaseId]);
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          debug('EvaluationRunner', `[${testCaseId}] Failed: ${errorMsg}`);
          // End the OTel test_case span with error status.
          if (caseSpan) {
            caseSpan.setStatus({ code: SpanStatusCode.ERROR, message: errorMsg });
            caseSpan.end();
          }
          // If we pre-persisted a placeholder, mark it failed so the runs
          // list doesn't show a permanently-running row after a crash.
          if (placeholderRunId) {
            try {
              await storageModule.runs.update(placeholderRunId, {
                status: 'failed',
                metricsStatus: 'error',
                llmJudgeReasoning: `Evaluation error: ${errorMsg}`,
              } as any);
            } catch { /* best-effort */ }
          }
          run.results[testCaseId] = {
            reportId: placeholderRunId || '',
            status: 'failed',
            error: errorMsg,
          };

          completedCount++;

          // Signal sibling tasks to back off with exponential backoff
          if (errorMsg.includes('ThrottlingException') || errorMsg.includes('rate limit') || errorMsg.includes('429')) {
            consecutiveThrottles++;
            const backoffMs = Math.min(5000 * Math.pow(2, consecutiveThrottles - 1), 30000);
            throttleUntil = Math.max(throttleUntil, Date.now() + backoffMs);
            await new Promise(r => setTimeout(r, backoffMs));
          }

          // Notify caller
          onProgress({
            runId: run.id,
            testCaseId,
            startedCount,
            completedCount,
            totalTestCases,
            status: 'running',
          });

          if (onTestCaseComplete) {
            await onTestCaseComplete(testCaseId, run.results[testCaseId]);
          }
        }
      },
      () => cancellationToken?.isCancelled ?? false
    );

    // Determine final status
    const wasCancelled = cancellationToken?.isCancelled ?? false;
    const finalStatus: BenchmarkRunStatus = wasCancelled ? 'cancelled' : 'completed';

    // Compute stats from *verdicts*, not raw completion status, reusing the
    // SAME canonical bucketing (`lib/runStats.bucketRunResults`) the UI uses
    // for the runs list and comparison page. A 'completed' result with no
    // resolved passFailStatus (e.g. the trace-judged path before the fix
    // above landed, or a judge/evaluator error) is bucketed `errored` — it
    // must NOT silently inflate `passed`. See run.results[testCaseId]
    // assignment above for how passFailStatus/metricsStatus land here.
    const bucketed = bucketRunResults(run.results as Record<string, { status?: string; passFailStatus?: string }>);
    run.stats = { ...bucketed, total: totalTestCases };

    // Compute performance metrics
    const totalDuration = Date.now() - runStartTime;
    const testCaseDurations = Object.values(run.results)
      .map(r => r.performanceMetrics?.durationMs)
      .filter((d): d is number => d !== undefined);

    run.performanceMetrics = {
      durationMs: totalDuration,
      concurrency,
      avgTestCaseDurationMs: testCaseDurations.length > 0
        ? testCaseDurations.reduce((a, b) => a + b, 0) / testCaseDurations.length : 0,
      maxTestCaseDurationMs: testCaseDurations.length > 0 ? Math.max(...testCaseDurations) : 0,
      minTestCaseDurationMs: testCaseDurations.length > 0 ? Math.min(...testCaseDurations) : 0,
    };

    run.status = finalStatus;
    run.completedAt = new Date().toISOString();

    // Final progress notification
    onProgress({
      runId: run.id,
      testCaseId: testCases[totalTestCases - 1]?.id ?? '',
      startedCount,
      completedCount,
      totalTestCases,
      status: finalStatus === 'cancelled' ? 'cancelled' : 'completed',
    });

    console.log(`[EvaluationRunner] Run ${run.id} ${finalStatus}: ${completedCount}/${totalTestCases} test cases in ${totalDuration}ms`);

    return run;
  } catch (error) {
    // Mark any pending test cases as failed
    const errorMsg = error instanceof Error ? error.message : String(error);
    for (const testCase of testCases) {
      if (!run.results[testCase.id] || run.results[testCase.id].status === 'pending' || run.results[testCase.id].status === 'running') {
        run.results[testCase.id] = { reportId: '', status: 'failed', error: `Execution failed: ${errorMsg}` };
      }
    }

    run.status = 'failed';
    run.completedAt = new Date().toISOString();
    run.error = errorMsg;

    throw error;
  }
}

/**
 * Wait for traces to become available and invoke the LLM judge inline.
 * Wraps tracePollingManager.startPolling in a promise so the caller can await it.
 */
async function waitForTracesAndJudge(
  report: EvaluationReport,
  testCase: TestCase,
  storage: IStorageModule,
  agentConfig: AgentConfig
): Promise<PassFailStatus | null> {
  return new Promise<PassFailStatus | null>((resolve) => {
    tracePollingManager.startPolling(
      report.id,
      report.runId,
      {
        // The poller stops without a verdict when the report reached a
        // terminal state through another path — resolve or this hangs the
        // run's test-case worker forever.
        onStopped: () => resolve(null),
        onTracesFound: async (_spans, updatedReport) => {
          try {
            // Span-built trajectory (hook or default conversion — issue #320).
            const finalTrajectory = updatedReport.trajectory;

            const config = getConfig();
            const modelConfig = config.models[report.modelId || ''];
            // Trace-mode polled judge — same priority chain as the
            // standard path: report.judgeModelId (persisted on the run
            // doc) > BEDROCK_MODEL_ID env > agent's modelId (last-resort
            // BC fallback for runs that didn't carry the new field).
            const judgeModelId =
              report.judgeModelId ||
              readEnv('BEDROCK_MODEL_ID', 'AGENT_HEALTH_BEDROCK_MODEL_ID') ||
              modelConfig?.model_id ||
              report.modelId;

            const judgment = await callBedrockJudge(
              finalTrajectory,
              {
                expectedOutcomes: testCase.expectedOutcomes,
                expectedTrajectory: testCase.expectedTrajectory,
              },
              [],
              () => {},
              judgeModelId,
              report.evaluatorId,
              report.runId,
              // Strategy C correlation hints (#264) so the agent trace
              // judge tool can find spans the agent emits under its OWN
              // correlation, not just spans matching agent-health's runId.
              buildJudgeAgentsHints(report, agentConfig?.traceServiceName)
            );

            await storage.runs.update(report.id, {
              trajectory: finalTrajectory,
              metricsStatus: 'ready',
              passFailStatus: judgment.passFailStatus,
              metrics: judgment.metrics,
              llmJudgeReasoning: judgment.llmJudgeReasoning,
              // Unified judge surface (issue #230 follow-up).
              // The deterministic path doesn't reach here — trace-mode
              // judge runs only when the test case has no SDK body —
              // so there are no pre-existing matcherResults to merge with.
              matcherResults: [
                buildJudgeMatcherEntry(judgment, {
                  claim: formatExpectedOutcomesAsClaim(testCase.expectedOutcomes),
                  model: judgeModelId,
                }),
              ],
              improvementStrategies: judgment.improvementStrategies,
              // Persist the full judge sidecar so the run-detail Judge
              // Output card has all the breadcrumbs even on the
              // trace-deferred SDK path. Same shape as the synchronous
              // /api/evaluate path.
              llmJudgeResponse: {
                modelId: judgeModelId || '',
                timestamp: new Date().toISOString(),
                promptTokens: 0,
                completionTokens: 0,
                latencyMs: judgment.judgeDurationMs ?? 0,
                rawResponse: judgment.rawResponse ?? judgment.llmJudgeReasoning,
                parsedMetrics: judgment.metrics as any,
                improvementStrategies: judgment.improvementStrategies,
                ...(judgment.extraFields ? { extraFields: judgment.extraFields } : {}),
                ...(judgment.judgeDebug ? { judgeDebug: judgment.judgeDebug } : {}),
              },
            } as any);

            debug('EvaluationRunner', `[${testCase.id}] Trace judge complete: ${judgment.passFailStatus}`);
            // Resolve with the JUDGMENT we just computed rather than making
            // the caller re-read `report.id` from storage — this is the fix
            // for the stale-`savedReport` bug (trace-judged runs displaying
            // inflated pass counts because the caller never saw the verdict).
            resolve(judgment.passFailStatus);
          } catch (error) {
            console.error(`[EvaluationRunner] Failed to judge report ${report.id}:`, error instanceof Error ? error.message : error);
            await storage.runs.update(report.id, buildEvaluatorErrorPatch(
              'judge_failed',
              error,
            ) as any).catch(() => {});
            resolve(null); // Don't fail the whole run, just mark metrics as error
          }
        },
        onAttempt: (attempt, max) => {
          debug('EvaluationRunner', `[${testCase.id}] Trace poll attempt ${attempt}/${max}`);
        },
        onError: (error) => {
          console.error(`[EvaluationRunner] Trace polling failed for report ${report.id}:`, error.message);
          resolve(null); // Don't fail the whole run — report already has error status from tracePoller
        },
      },
      { agentConfig }
    );
  });
}

/**
 * Build a synthetic empty EvaluationReport for tests that have no prompt
 * (deterministic-only tests). The body is expected to assert on
 * non-trajectory data (fixtures, external state, computed values) so the
 * trajectory and agent output are deliberately empty.
 *
 * The report is shaped exactly like a real evaluation report so the rest of
 * the pipeline (storage, UI, judge skipping) treats it identically.
 */
function synthesizeEmptyReport(
  testCase: TestCase,
  agentKey: string,
  modelId: string
): EvaluationReport {
  const now = new Date().toISOString();
  return {
    id: uuidv4(),
    testCaseId: testCase.id,
    testCaseVersion: testCase.currentVersion,
    timestamp: now,
    agentName: agentKey,
    agentKey,
    modelName: modelId,
    modelId,
    status: 'completed',
    trajectory: [],
    rawEvents: [],
    metrics: { accuracy: 0, faithfulness: 0, latency_score: 0, trajectory_alignment_score: 0 },
    performanceMetrics: { durationMs: 0 },
    metricsStatus: 'completed',
    skipJudge: true,
    llmJudgeReasoning: '',
    // Deterministic body decides pass/fail; defaults to passed and is
    // overridden by the body's evaluate() call in the runner.
    passFailStatus: 'passed',
    evaluationType: 'deterministic',
  } as unknown as EvaluationReport;
}

/**
 * Wrap the trajectory array with non-enumerable accessor methods. The
 * returned value is still the same Array so iteration / JSON.stringify
 * behave as before, but `traj.toolCalls(...)`, `traj.firstToolCall(...)`,
 * and `traj.stepsOfType(...)` are available for use inside test bodies.
 */
function makeTrajectoryAccessor(steps: TrajectoryStep[]): TrajectoryAccessor {
  const arr = steps as TrajectoryAccessor;
  Object.defineProperties(arr, {
    stepsOfType: {
      value(type: string) {
        return arr.filter((s: any) => s?.type === type);
      },
      enumerable: false,
    },
    toolCalls: {
      value(name?: string, argsPartial?: Record<string, unknown>) {
        return arr.filter((s: any) => {
          if (s?.type !== 'action') return false;
          if (name && s.toolName !== name) return false;
          if (argsPartial) return supersetOf(s.toolArgs ?? s.input, argsPartial);
          return true;
        });
      },
      enumerable: false,
    },
    firstToolCall: {
      value(name?: string, argsPartial?: Record<string, unknown>) {
        for (let i = 0; i < arr.length; i++) {
          const s: any = arr[i];
          if (s?.type !== 'action') continue;
          if (name && s.toolName !== name) continue;
          if (argsPartial && !supersetOf(s.toolArgs ?? s.input, argsPartial)) continue;
          return Object.assign({}, s, { index: i });
        }
        return null;
      },
      enumerable: false,
    },
  });
  return arr;
}

function supersetOf(actual: any, expected: Record<string, unknown>): boolean {
  if (typeof actual !== 'object' || actual === null) return false;
  for (const [k, v] of Object.entries(expected)) {
    if (!(k in actual)) return false;
    if (typeof v === 'object' && v !== null) {
      if (!supersetOf((actual as any)[k], v as Record<string, unknown>)) return false;
    } else if ((actual as any)[k] !== v) return false;
  }
  return true;
}

/**
 * Build the EvalResult object that flows into the test body. Wraps the
 * raw trajectory with sugar accessors and exposes finalResponse() /
 * parsedOutput() helpers as #198 specifies.
 */
function buildEvalResult(input: {
  trajectory: TrajectoryStep[];
  agentOutput: string;
  rawEvents: any[];
  runId?: string;
  durationMs: number;
  tokenUsage?: { prompt: number; completion: number; total: number };
}): EvalResult {
  const trajectory = makeTrajectoryAccessor(input.trajectory);
  return {
    trajectory,
    agentOutput: input.agentOutput,
    finalResponse: () => input.agentOutput,
    parsedOutput: () => {
      try { return JSON.parse(input.agentOutput); }
      catch { return undefined; }
    },
    rawEvents: input.rawEvents,
    runId: input.runId,
    durationMs: input.durationMs,
    tokenUsage: input.tokenUsage,
  };
}

/**
 * Construct the appropriate `TracesAccessor` for a deterministic eval body.
 *
 * Three modes (see lib/matchers/traces.ts):
 *   - `useTraces: false`    → silent zeros (opt-out preserved)
 *   - `useTraces: true`, no runId or fetch yields no spans
 *                            → loud-failure accessor (throws on read)
 *   - `useTraces: true`, spans available
 *                            → real `buildTracesAccessor(spans)`
 *
 * Issue #230: previously this always returned `emptyTracesAccessor()`,
 * which made `expect(traces.totalTokens).to.be.lessThan(N)` pass against
 * `0` regardless of actual token usage — a silent false-pass.
 *
 * The error reason is specific so users can act on it:
 *   - missing runId  → `agent has useTraces=true but produced no runId…`
 *   - fetch failed   → `fetch failed for runId=…: <last error message>`
 *   - empty backend  → `no spans found for runId=… after polling — verify the
 *                       agent's OTel exporter is reachable`
 */
async function loadTracesAccessor(
  agentConfig: AgentConfig,
  runId: string | undefined,
  windowAgents?: TraceWindowAgent[]
): Promise<TracesAccessor> {
  if (!agentConfig.useTraces) {
    return emptyTracesAccessor();
  }
  const hasWindow = !!(windowAgents && windowAgents.length > 0);
  if (!runId && !hasWindow) {
    return unavailableTracesAccessor(
      'agent has useTraces=true but produced neither a runId nor a service-name window for trace correlation'
    );
  }
  const polling = agentConfig.tracePolling ?? {};
  const result = await fetchSpansForRun(runId, {
    maxAttempts: polling.maxAttempts,
    intervalMs: polling.intervalMs,
    windowAgents,
  });
  if (result.spans.length === 0) {
    const target = runId ? `runId=${runId}` : 'service-name window';
    const reason = result.lastError
      ? `fetch failed for ${target}: ${result.lastError}`
      : `no spans found for ${target} after polling — verify the agent's OTel exporter is reachable`;
    return unavailableTracesAccessor(reason);
  }
  return buildTracesAccessor(result.spans);
}
