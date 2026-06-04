/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Benchmark,
  BenchmarkRun,
  BenchmarkProgress,
  AgentConfig,
  TestCase,
  TestCaseRun,
  EvaluationReport,
  RunConfigInput,
  RunPerformanceMetrics,
} from '@/types';
import {
  getAllTestCasesWithClient,
  saveReportWithClient,
  updateRunWithClient,
  updateBenchmarkRunStatsForReport,
  updateTestCaseLastRunAt,
} from '@/server/services/storage';
import type { Client } from '@opensearch-project/opensearch';
import type { IStorageModule } from '@/server/adapters/types';
import { runEvaluationWithConnector, callBedrockJudge } from './evaluation';
import { buildEvaluatorErrorPatch } from './evaluation/evaluatorError';
import { connectorRegistry } from '@/services/connectors/server';
import {
  startSession,
  endSession,
  emptyTracesAccessor,
  unavailableTracesAccessor,
  buildTracesAccessor,
  buildJudgeMatcherEntry,
  formatExpectedOutcomesAsClaim,
} from '@/lib/matchers/index';
import type { TracesAccessor } from '@/lib/matchers/index';
import type { EvalResult, TrajectoryAccessor, TestFixtures, RegisteredHook } from '@/lib/testCases/types';
import { judge as judgeFn } from '@/lib/testCases/judge';
import { expect as ahExpect } from '@/lib/matchers/expect';
import type { TrajectoryStep } from '@/types';
import { createHookOrchestrator, type TestDescriptor } from './hookOrchestrator';
import { v4 as uuidv4 } from 'uuid';
import { loadConfigSync } from '@/lib/config/index';
import { DEFAULT_CONFIG } from '@/lib/constants';
import { tracePollingManager } from './traces/tracePoller';
import { fetchSpansForRun } from './traces/fetchSpansForRun';
import { getCustomAgents } from '@/server/services/customAgentStore';
import { debug } from '@/lib/debug';
import { RunResultStatus } from '@/types';
import {
  startTestSuiteRunSpan,
  startTestCaseSpan,
  addEvaluationResultEvents,
  finalizeTestCaseSpan,
  finalizeTestSuiteRunSpan,
  emitDeferredTestCaseSpan,
} from '@/lib/telemetry';
import { SpanStatusCode, context, trace } from '@opentelemetry/api';
import { ATTR_AGENT_HEALTH_AGENT_RUN_ID } from '@/lib/telemetry/constants';

/**
 * Safely load config with fallback to defaults.
 * Matches the defensive pattern used in services/evaluation/index.ts.
 */
function getConfig() {
  try {
    return loadConfigSync();
  } catch {
    return DEFAULT_CONFIG;
  }
}

/**
 * Callback invoked after each test case completes during benchmark execution.
 * Used to persist intermediate progress to OpenSearch for real-time polling.
 */
export type OnTestCaseCompleteCallback = (
  testCaseId: string,
  result: { reportId: string; status: RunResultStatus; error?: string; performanceMetrics?: import('@/types').TestCasePerformanceMetrics }
) => Promise<void>;

/**
 * Cancellation token for stopping execution
 */
export interface CancellationToken {
  isCancelled: boolean;
  cancel(): void;
}

/**
 * Create a new cancellation token
 */
export function createCancellationToken(): CancellationToken {
  const token = {
    isCancelled: false,
    cancel() {
      this.isCancelled = true;
    },
  };
  return token;
}

/**
 * Options for executeRun
 */
export interface ExecuteRunOptions {
  cancellationToken?: CancellationToken;
  /** OpenSearch client for storage operations (required) */
  client: Client;
  /** Storage module for test case lookups (preferred over direct OpenSearch queries) */
  storageModule?: IStorageModule;
  /** Callback invoked after each test case completes (for persisting intermediate progress) */
  onTestCaseComplete?: OnTestCaseCompleteCallback;
  /**
   * Per-test-case deterministic evaluate functions keyed by test case ID.
   * Set when the SDK's code-import path resolves a .eval.js/.eval.ts file
   * into runnable test bodies. When the runner sees a test case in this
   * map it skips the LLM-judge path and runs the body inside a matcher
   * session, recording per-matcher verdicts on the report.
   */
  evaluateFnMap?: Map<string, (fixtures: any) => Promise<void> | void>;
  /**
   * SDK lifecycle hooks (`beforeAll`/`afterAll`/`beforeEach`/`afterEach`)
   * registered by code-imported eval files, keyed by absolute file path.
   * Empty / undefined => no-op orchestrator (existing tests unaffected).
   */
  hooksByFile?: Map<string, RegisteredHook[]>;
  /** Per-test-case scope info (sourceFile + describePath) for hook lookup. */
  testHookScopes?: Map<string, { sourceFile?: string; describePath?: string }>;
}

/**
 * Build an agent config from a run's configuration
 */
function buildAgentConfigForRun(run: BenchmarkRun): AgentConfig {
  // Find the base agent config (includes custom agents from JSON-backed store)
  const config = getConfig();
  const allAgents = [...config.agents, ...getCustomAgents()];
  const baseAgent = allAgents.find(a => a.key === run.agentKey);

  if (!baseAgent) {
    throw new Error(`Agent not found: ${run.agentKey}`);
  }

  // Apply run overrides
  return {
    ...baseAgent,
    endpoint: run.agentEndpoint || baseAgent.endpoint,
    headers: {
      ...baseAgent.headers,
      ...run.headers,
    },
  };
}

/**
 * Get the Bedrock model ID from a model key
 */
function getBedrockModelId(modelKey: string): string {
  const config = getConfig();
  const modelConfig = config.models[modelKey];
  return modelConfig?.model_id || modelKey;
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
 * Execute a run for a benchmark
 *
 * A run executes a single configuration against all test cases in the benchmark.
 * Results are stored in the evals_runs index via asyncRunStorage.
 * Supports parallel execution via run.concurrency (default: 1 = sequential).
 */
export async function executeRun(
  benchmark: Benchmark,
  run: BenchmarkRun,
  onProgress: (progress: BenchmarkProgress) => void,
  options: ExecuteRunOptions
): Promise<BenchmarkRun> {
  const totalTestCases = benchmark.testCaseIds.length;
  const { cancellationToken, client, storageModule, onTestCaseComplete, evaluateFnMap, hooksByFile, testHookScopes } = options;
  const concurrency = run.concurrency ?? 1;
  const runStartTime = Date.now();

  console.log(`[BenchmarkRunner] Starting run ${run.id} with concurrency=${concurrency} for ${totalTestCases} test cases`);

  // Start OTel telemetry span for the benchmark run
  const suiteSpanResult = startTestSuiteRunSpan(benchmark, run);
  const suiteSpan = suiteSpanResult?.span;
  const suiteContext = suiteSpanResult?.context;

  // Initialize results if empty
  if (!run.results) {
    run.results = {};
  }

  // Fetch all test cases upfront for this benchmark.
  // Prefer the storage adapter (supports both file and OpenSearch backends)
  // over direct OpenSearch queries which only work with OpenSearch storage.
  let allTestCases: TestCase[];
  if (storageModule) {
    const result = await storageModule.testCases.getAll({ size: 10000 });
    allTestCases = result.items;
  } else {
    allTestCases = await getAllTestCasesWithClient(client);
  }
  const testCaseMap = new Map(allTestCases.map((tc: any) => [tc.id, tc]));

  // Build the hook orchestrator once per run. Returns a no-op when no
  // hooks were registered (the common case for existing tests). The
  // factory passed here is a fresh-skeleton builder — the runner
  // overwrites `result` with the real EvalResult inside the matcher
  // session block, and the orchestrator stamps `testInfo`/`provisioned`.
  const benchmarkTestCases = benchmark.testCaseIds
    .map(id => testCaseMap.get(id))
    .filter((tc): tc is TestCase => !!tc);
  const hookDescriptors: TestDescriptor[] = benchmarkTestCases.map(tc => {
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
      result: {} as any,
      judge: judgeFn,
      traces: emptyTracesAccessor(),
      expect: ahExpect,
      testInfo: { name: '' },
      provisioned: {},
    }),
  );

  // Mutable counters for tracking progress across concurrent tasks.
  // SAFETY: JavaScript is single-threaded — the ++ operator and variable reads
  // are atomic within each synchronous block (between await points). With
  // concurrency > 1, tasks interleave at await boundaries, so:
  // - completedCount++ is always accurate (runs in a synchronous block after await)
  // - Progress events may report the same completedCount if two tasks complete
  //   between the same pair of progress emissions — this is cosmetic only
  // - startedCount is incremented before each task's first await, giving unique indices
  // The final completedCount always equals the number of completed tasks.
  let completedCount = 0;
  let startedCount = 0;

  // Track pending trace polling promises so we can await them before returning.
  // This ensures trace-mode runs (useTraces: true) have their judge evaluation
  // complete before the benchmark reports results (fixes #184).
  const pendingTracePolls: Promise<void>[] = [];

  // Shared throttle signal: when any task hits a rate-limit error,
  // subsequent task starts wait until this timestamp expires.
  // Uses exponential backoff: consecutive throttle errors increase the delay.
  let throttleUntil = 0;
  let consecutiveThrottles = 0;

  try {
    // Process each test case with bounded concurrency
    await runWithConcurrencyLimit(
      benchmark.testCaseIds,
      concurrency,
      async (testCaseId: string) => {
        // Check for cancellation before starting
        if (cancellationToken?.isCancelled) {
          return;
        }

        // Wait if a sibling task recently hit a rate-limit error
        const now = Date.now();
        if (now < throttleUntil) {
          await new Promise(r => setTimeout(r, throttleUntil - now));
        }

        const testCase = testCaseMap.get(testCaseId);

        if (!testCase) {
          const errorMsg = `Test case not found: ${testCaseId}`;
          console.warn(`[BenchmarkRunner] ${errorMsg}`);
          run.results[testCaseId] = { reportId: '', status: 'failed', error: errorMsg };
          completedCount++;

          if (onTestCaseComplete) {
            onTestCaseComplete(testCaseId, run.results[testCaseId])
              .catch(err => console.warn(`[BenchmarkRunner] Failed to persist failure progress for ${testCaseId}:`, err.message));
          }
          return;
        }

        // Report progress — this test case is starting
        startedCount++;
        onProgress({
          currentTestCaseIndex: startedCount - 1,
          startedCount,
          completedCount,
          totalTestCases,
          currentRunId: run.id,
          currentTestCaseId: testCaseId,
          status: 'running',
        });

        debug('BenchmarkRunner', `[${testCaseId}] Starting evaluation (${completedCount}/${totalTestCases} completed)`);
        const testCaseStartTime = Date.now();

        // Start the OTel `test_case` span BEFORE running the agent so the eval
        // span is the active OTel context when the connector spawns/calls the
        // agent. Connectors with `traceContext.propagateEnv/Header` inject
        // TRACEPARENT, making the agent's root span a child of this eval span
        // (single trace tree). agentRunId is unknown at this point — set as
        // attribute later when the report comes back.
        let caseSpan: import('@opentelemetry/api').Span | undefined;
        let caseSpanContext: import('@opentelemetry/api').Context | undefined;
        if (suiteContext) {
          const r = startTestCaseSpan(suiteContext, testCase, benchmark, run);
          caseSpan = r?.span;
          caseSpanContext = r?.context;
        }

        // Set status to running
        run.results[testCaseId] = { reportId: '', status: 'running' };

        try {
          // Build agent config from run configuration
          const agentConfig = buildAgentConfigForRun(run);
          const bedrockModelId = getBedrockModelId(run.modelId);

          // SDK code-import: when this test case has a registered
          // evaluate function we either skip agent invocation entirely
          // (no prompt) or invoke the agent and run the body inside a
          // matcher session afterwards. Mirrors evaluationRunner.ts.
          const hasDeterministicEval = evaluateFnMap?.has(testCaseId) ?? false;
          const hasPrompt = !!(testCase.initialPrompt && testCase.initialPrompt.trim().length > 0);
          const skipAgentInvocation = !hasPrompt && hasDeterministicEval;

          let report;
          if (skipAgentInvocation) {
            debug('BenchmarkRunner', `[${testCaseId}] No prompt — running deterministic body without agent invocation`);
            report = synthesizeEmptyReport(testCase, agentConfig.key, bedrockModelId);
          } else {
            // Run the evaluation using connector. Pass skipJudge when a
            // deterministic body is going to decide pass/fail.
            // Wrap in context.with(caseSpanContext) so the connector sees the
            // eval span as active and propagates W3C trace context to the agent.
            const runEval = () => runEvaluationWithConnector(
              agentConfig,
              bedrockModelId,
              testCase,
              () => {},
              { registry: connectorRegistry, evaluatorId: run.evaluatorId, skipJudge: hasDeterministicEval }
            );
            report = caseSpanContext
              ? await context.with(caseSpanContext, runEval)
              : await runEval();
          }

          // If the test has a deterministic body, run it inside a
          // matcher session and let the verdicts dictate pass/fail.
          if (hasDeterministicEval) {
            const evalFn = evaluateFnMap!.get(testCaseId)!;
            const trajectorySteps = (report.trajectory || []) as TrajectoryStep[];
            const agentOutput = trajectorySteps
              .filter((s: any) => s.type === 'response' || s.type === 'assistant')
              .map((s: any) => s.content)
              .join('\n');
            const evalResult = buildEvalResult({
              trajectory: trajectorySteps,
              agentOutput,
              rawEvents: (report as any).rawEvents || [],
              runId: report.runId,
              durationMs: report.performanceMetrics?.durationMs ?? 0,
            });
            // Pre-load the traces fixture for the body. See issue #230:
            // when useTraces is true the fixture must reflect real OTel
            // data — or fail loudly if it can't — instead of silently
            // returning zeros that make `lessThan(N)` matchers pass.
            const tracesAccessor = await loadTracesAccessor(agentConfig, report.runId);
            const scope = testHookScopes?.get(testCaseId);
            const desc: TestDescriptor = {
              testCaseId,
              name: testCase.name,
              sourceFile: scope?.sourceFile,
              describePath: scope?.describePath,
            };
            const session = startSession();
            // Run beforeAll/beforeEach hooks first — outcomes folded into
            // the matcher session so they show up next to body assertions.
            const before = await hookOrchestrator.beforeTest(desc);
            for (const r of before.matcherResults) {
              (session.results as any).push(r);
            }
            // Overlay the per-run tracesAccessor (#230) over what the
            // orchestrator returned. The orchestrator's noop factory
            // always returns an empty traces accessor.
            const fixtures: TestFixtures = {
              ...before.fixtures,
              result: evalResult,
              traces: tracesAccessor,
            };
            try {
              if (!before.aborted) {
                await evalFn(Object.assign(evalResult, { ...fixtures, result: evalResult }));
              }
              const after = await hookOrchestrator.afterTest(desc, fixtures);
              for (const r of after) {
                (session.results as any).push(r);
              }
              const matcherResults = endSession();
              const anyFailed = matcherResults.some(m => !m.pass);
              (report as any).passFailStatus = anyFailed ? 'failed' : 'passed';
              (report as any).evaluationType = 'deterministic';
              (report as any).matcherResults = matcherResults;
              // Option B BC shim: legacy field empty for SDK runs;
              // canonical judge data lives in `matcherResults`.
              (report as any).llmJudgeReasoning = '';
              (report as any).metrics = anyFailed
                ? { accuracy: 0, faithfulness: 0, latency_score: 0, trajectory_alignment_score: 0 }
                : { accuracy: 100, faithfulness: 100, latency_score: 100, trajectory_alignment_score: 100 };
            } catch (evalError: any) {
              const after = await hookOrchestrator.afterTest(desc, fixtures);
              for (const r of after) {
                (session.results as any).push(r);
              }
              const matcherResults = endSession();
              (report as any).passFailStatus = 'failed';
              (report as any).evaluationType = 'deterministic';
              (report as any).assertionError = evalError.message;
              (report as any).matcherResults = matcherResults;
              (report as any).llmJudgeReasoning = '';
              (report as any).metrics = { accuracy: 0, faithfulness: 0, latency_score: 0, trajectory_alignment_score: 0 };
            }
            // Mark the report as final so trace-mode polling below skips
            // the Bedrock judge fallback (which would error with empty
            // expectedOutcomes for SDK-loaded test cases).
            (report as any).metricsStatus = 'completed';
            (report as any).skipJudge = true;
          }

          // Save the report to OpenSearch and get the actual stored ID
          const savedReport = await saveReportWithClient(client, report, {
            experimentId: benchmark.id,
            experimentRunId: run.id,
          });

          // Denormalize lastRunAt onto the test case (fire-and-forget)
          updateTestCaseLastRunAt(client, testCaseId, new Date().toISOString())
            .catch(err => console.warn(`[BenchmarkRunner] Failed to update lastRunAt for ${testCaseId}:`, err.message));

          // Start trace polling for trace-mode runs (metricsStatus: 'pending').
          // Deterministic SDK runs already populated the report with their own
          // verdict in the matcher session above, so skip this path.
          if (!hasDeterministicEval && savedReport.metricsStatus === 'pending' && savedReport.runId) {
            const pollPromise = startTracePollingForReport(savedReport, testCase, client, benchmark, run);
            // Attach .catch to prevent unhandled rejection if cancelled/errored before allSettled
            pendingTracePolls.push(pollPromise.catch(() => {}));
          }

          // Finalize the eval test_case span. agentRunId is now known (it
          // wasn't when we started the span before invoking the agent).
          if (caseSpan) {
            caseSpan.setAttribute(ATTR_AGENT_HEALTH_AGENT_RUN_ID, savedReport.runId || '');
            if (savedReport.metricsStatus !== 'pending') {
              addEvaluationResultEvents(caseSpan, savedReport);
              finalizeTestCaseSpan(caseSpan, savedReport);
            } else {
              // Trace-mode: judge runs later when polled spans arrive. End span
              // as-is so the trace tree is closed; the late-completion path at
              // line ~832 emits a separate span with the final metrics.
              caseSpan.end();
            }
          }

          // Update result with success - use the actual stored ID
          run.results[testCaseId] = {
            reportId: savedReport.id,
            status: 'completed',
            performanceMetrics: report.performanceMetrics,
          };

          completedCount++;
          consecutiveThrottles = Math.max(0, consecutiveThrottles - 1);
          const testCaseDuration = Date.now() - testCaseStartTime;
          debug('BenchmarkRunner', `[${testCaseId}] Completed in ${testCaseDuration}ms (${completedCount}/${totalTestCases} completed)`);

          // Persist progress to OpenSearch (fire-and-forget with logging)
          if (onTestCaseComplete) {
            onTestCaseComplete(testCaseId, run.results[testCaseId])
              .catch(err => console.warn(`[BenchmarkRunner] Failed to persist progress for ${testCaseId}:`, err.message));
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          const testCaseDuration = Date.now() - testCaseStartTime;
          debug('BenchmarkRunner', `[${testCaseId}] Failed in ${testCaseDuration}ms: ${errorMsg}`);
          run.results[testCaseId] = { reportId: '', status: 'failed', error: errorMsg };

          if (caseSpan) {
            caseSpan.setStatus({ code: SpanStatusCode.ERROR, message: errorMsg });
            caseSpan.end();
          }

          completedCount++;

          // Signal sibling tasks to back off with exponential backoff
          if (errorMsg.includes('ThrottlingException') || errorMsg.includes('rate limit') || errorMsg.includes('429')) {
            consecutiveThrottles++;
            const backoffMs = Math.min(5000 * Math.pow(2, consecutiveThrottles - 1), 30000);
            throttleUntil = Math.max(throttleUntil, Date.now() + backoffMs);
            await new Promise(r => setTimeout(r, backoffMs));
          }

          // Persist failure progress to OpenSearch (fire-and-forget with logging)
          if (onTestCaseComplete) {
            onTestCaseComplete(testCaseId, run.results[testCaseId])
              .catch(err => console.warn(`[BenchmarkRunner] Failed to persist failure progress for ${testCaseId}:`, err.message));
          }
        }
      },
      () => cancellationToken?.isCancelled ?? false
    );

    // If cancelled, send cancellation progress
    if (cancellationToken?.isCancelled) {
      const lastIndex = Math.max(0, Math.min(completedCount - 1, totalTestCases - 1));
      onProgress({
        currentTestCaseIndex: lastIndex,
        completedCount,
        totalTestCases,
        currentRunId: run.id,
        currentTestCaseId: benchmark.testCaseIds[lastIndex],
        status: 'cancelled',
      });
    }

    // Wait for all pending trace polls to complete before reporting final results.
    // This ensures trace-mode runs (useTraces: true) have their judge evaluation
    // finish before the benchmark reports pass/fail stats (fixes #184).
    if (pendingTracePolls.length > 0 && !cancellationToken?.isCancelled) {
      console.log(`[BenchmarkRunner] Waiting for ${pendingTracePolls.length} trace-mode evaluations to complete...`);
      const traceResults = await Promise.allSettled(pendingTracePolls);
      const traceFailures = traceResults.filter(r => r.status === 'rejected');
      if (traceFailures.length > 0) {
        console.warn(`[BenchmarkRunner] ${traceFailures.length}/${pendingTracePolls.length} trace polling tasks failed`);
      } else {
        console.log(`[BenchmarkRunner] All ${pendingTracePolls.length} trace-mode evaluations completed`);
      }
    }

    // Report final progress
    onProgress({
      currentTestCaseIndex: totalTestCases - 1,
      completedCount,
      totalTestCases,
      currentRunId: run.id,
      currentTestCaseId: benchmark.testCaseIds[totalTestCases - 1],
      status: 'completed',
    });

    const totalDuration = Date.now() - runStartTime;
    console.log(`[BenchmarkRunner] Run ${run.id} completed: ${completedCount}/${totalTestCases} test cases in ${totalDuration}ms`);

    // Compute run-level performance metrics
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

    if (suiteSpan) {
      finalizeTestSuiteRunSpan(suiteSpan, run);
    }

    return run;
  } catch (error) {
    // Mark any pending test cases as failed
    const errorMsg = error instanceof Error ? error.message : String(error);
    benchmark.testCaseIds.forEach(testCaseId => {
      if (!run.results[testCaseId] || run.results[testCaseId].status === 'pending') {
        run.results[testCaseId] = { reportId: '', status: 'failed', error: `Benchmark execution failed: ${errorMsg}` };
      }
    });

    if (suiteSpan) {
      suiteSpan.setStatus({ code: SpanStatusCode.ERROR, message: errorMsg });
      suiteSpan.end();
    }

    throw error;
  }
}

/**
 * Create and execute a new run for a benchmark
 *
 * This is the main entry point for running a benchmark.
 * It creates a new BenchmarkRun from the provided configuration and executes it.
 */
/**
 * Generate a unique run ID
 */
function generateRunId(): string {
  return `run-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
}

export async function runBenchmark(
  benchmark: Benchmark,
  runConfig: RunConfigInput,
  onProgress: (progress: BenchmarkProgress) => void,
  client: Client
): Promise<BenchmarkRun> {
  // Create a new run - spread runConfig to include all fields (name, description, etc.)
  const run: BenchmarkRun = {
    ...runConfig,
    id: generateRunId(),
    createdAt: new Date().toISOString(),
    results: {},
  };

  // Initialize pending status for all test cases
  benchmark.testCaseIds.forEach(testCaseId => {
    run.results[testCaseId] = { reportId: '', status: 'pending' };
  });

  return executeRun(benchmark, run, onProgress, { client });
}

/**
 * Save an evaluation report using the storage adapter (works with both file and OpenSearch backends).
 */
async function saveReportWithModule(storage: IStorageModule, report: any): Promise<any> {
  const saved = await storage.runs.create({
    experimentId: report.experimentId || '',
    experimentRunId: report.experimentRunId || '',
    testCaseId: report.testCaseId,
    agentId: report.agentKey || report.agentName,
    modelId: report.modelId || report.modelName,
    status: report.status,
    passFailStatus: report.passFailStatus,
    traceId: report.runId,
    llmJudgeReasoning: report.llmJudgeReasoning,
    metrics: report.metrics,
    trajectory: report.trajectory,
    rawEvents: report.rawEvents || [],
    logs: report.logs || report.openSearchLogs,
    improvementStrategies: report.improvementStrategies,
    metricsStatus: report.metricsStatus,
    traceFetchAttempts: report.traceFetchAttempts,
    lastTraceFetchAt: report.lastTraceFetchAt,
    traceError: report.traceError,
    spans: report.spans,
    connectorProtocol: report.connectorProtocol,
  } as any);
  return { ...report, id: saved.id, timestamp: saved.timestamp };
}

/**
 * Run a single use case with a single configuration (for quick testing).
 * Uses the storage adapter — works with both file and OpenSearch backends.
 */
export interface RunSingleUseCaseOptions {
  /** Whether to await trace polling completion before returning (default: true for CLI, false for UI) */
  awaitTraces?: boolean;
}

export async function runSingleUseCase(
  run: BenchmarkRun,
  testCase: TestCase,
  storage: IStorageModule,
  onStep?: (step: any) => void,
  evaluatorId?: string,
  existingReportId?: string,
  options?: RunSingleUseCaseOptions
): Promise<string> {
  const agentConfig = buildAgentConfigForRun(run);
  const bedrockModelId = getBedrockModelId(run.modelId);
  const startTime = new Date();

  // Start the OTel `test_case` span BEFORE running the agent so the eval span
  // is the active OTel context when the connector spawns/calls the agent.
  // Connectors with `traceContext.propagateEnv/Header` inject TRACEPARENT,
  // making the agent's root span a child of this eval span (single trace tree).
  const standaloneBenchmark = { name: `standalone:${agentConfig.name || agentConfig.key}` } as Benchmark;
  const caseSpanResult = startTestCaseSpan(context.active(), testCase, standaloneBenchmark, run);
  const caseSpan = caseSpanResult?.span;
  const caseSpanContext = caseSpanResult?.context;

  // Run the evaluation using connector, with the eval span as active context.
  const runEval = () => runEvaluationWithConnector(
    agentConfig,
    bedrockModelId,
    testCase,
    onStep || (() => {}),
    { registry: connectorRegistry, evaluatorId }
  );
  const report = caseSpanContext
    ? await context.with(caseSpanContext, runEval)
    : await runEval();

  // If a placeholder run was pre-created, update it instead of creating a new one.
  // We use the storage-layer field names (traceId, etc.) to match `saveReportWithModule`
  // for consistency — the IStorageModule operations accept Partial<TestCaseRun> nominally
  // but the codebase convention is to pass the storage-shaped doc directly.
  let savedReport: any;
  if (existingReportId) {
    const updates = {
      status: report.status,
      passFailStatus: report.passFailStatus,
      traceId: report.runId,
      llmJudgeReasoning: report.llmJudgeReasoning,
      metrics: report.metrics,
      trajectory: report.trajectory,
      rawEvents: report.rawEvents || [],
      logs: report.logs || report.openSearchLogs,
      improvementStrategies: report.improvementStrategies,
      metricsStatus: report.metricsStatus,
      traceFetchAttempts: report.traceFetchAttempts,
      lastTraceFetchAt: report.lastTraceFetchAt,
      traceError: report.traceError,
      spans: report.spans,
      connectorProtocol: report.connectorProtocol,
    } as Partial<TestCaseRun>;
    const updated = await storage.runs.update(existingReportId, updates);
    savedReport = { ...report, id: updated.id, timestamp: updated.timestamp };
  } else {
    savedReport = await saveReportWithModule(storage, report);
  }

  // Denormalize lastRunAt onto the test case (only for persisted test cases)
  storage.testCases.getById(testCase.id)
    .then(existing => {
      if (existing) {
        return storage.testCases.update(testCase.id, { lastRunAt: new Date().toISOString() } as any);
      }
    })
    .catch(err => console.warn(`[BenchmarkRunner] Failed to update lastRunAt for ${testCase.id}:`, err.message));

  // Start trace polling for trace-mode runs
  if (savedReport.metricsStatus === 'pending' && savedReport.runId) {
    if (options?.awaitTraces !== false) {
      // CLI/batch mode: block until traces arrive and judge evaluates
      try {
        await startTracePollingForReportWithModule(savedReport, testCase, storage);
      } catch (err) {
        // Trace polling failed (timeout, auth, etc.) — don't crash.
        // The report is already saved with metricsStatus: 'error' by the poller.
        console.warn(`[BenchmarkRunner] Trace polling failed for ${savedReport.id}: ${err instanceof Error ? err.message : err}`);
      }
    } else {
      // UI mode: fire-and-forget, let the UI poll for status updates
      startTracePollingForReportWithModule(savedReport, testCase, storage)
        .catch(err => console.warn(`[BenchmarkRunner] Background trace polling failed for ${savedReport.id}:`, err.message));
    }
  }

  // Finalize the eval test_case span. agentRunId is now known.
  // For trace-mode runs (metricsStatus='pending'), judge runs later when
  // polled spans arrive — we end the span as-is here so its trace tree is
  // closed; the late-completion path emits a separate span with final metrics.
  if (caseSpan) {
    caseSpan.setAttribute(ATTR_AGENT_HEALTH_AGENT_RUN_ID, savedReport.runId || '');
    if (savedReport.metricsStatus !== 'pending') {
      addEvaluationResultEvents(caseSpan, savedReport);
      finalizeTestCaseSpan(caseSpan, savedReport);
    } else {
      caseSpan.end();
    }
  }

  return savedReport.id;
}

/**
 * Start trace polling for a report that has metricsStatus: 'pending'.
 * Uses the storage adapter — works with both file and OpenSearch backends.
 *
 * Exported so server-side boot recovery (`server/services/traceRecoveryOnBoot.ts`)
 * can re-attach polling for reports that were orphaned by a server restart.
 */
export function startTracePollingForReportWithModule(report: EvaluationReport, testCase: TestCase, storage: IStorageModule): Promise<void> {
  if (!report.runId) {
    console.warn(`[BenchmarkRunner] No runId for report ${report.id}, cannot start trace polling`);
    return Promise.resolve();
  }

  // Pass agent config to trace poller for hooks
  const config = getConfig();
  const allAgents = [...config.agents, ...getCustomAgents()];
  const agentConfig = allAgents.find(a => a.key === report.agentKey);

  return tracePollingManager.startPollingAsync(
    report.id,
    report.runId,
    {
      onTracesFound: async (spans, updatedReport) => {
        try {
          const finalTrajectory = agentConfig?.hooks?.buildTrajectory ? updatedReport.trajectory : report.trajectory;
          // Call the Bedrock judge with the trajectory and expectedOutcomes
          const judgeModelId = report.modelId ? getBedrockModelId(report.modelId) : undefined;

          const judgment = await callBedrockJudge(
            finalTrajectory,
            {
              expectedOutcomes: testCase.expectedOutcomes,
              expectedTrajectory: testCase.expectedTrajectory,
            },
            [], // No logs for trace-mode - traces are the source of truth
            () => {}, // No progress callback needed
            judgeModelId
          );

          // Update report with judge results
          await storage.runs.update(report.id, {
            trajectory: finalTrajectory,
            metricsStatus: 'ready',
            passFailStatus: judgment.passFailStatus,
            metrics: judgment.metrics,
            llmJudgeReasoning: judgment.llmJudgeReasoning,
            // Unified judge surface (issue #230 follow-up).
            matcherResults: [
              buildJudgeMatcherEntry(judgment, {
                claim: formatExpectedOutcomesAsClaim(testCase.expectedOutcomes),
                model: judgeModelId,
              }),
            ],
            improvementStrategies: judgment.improvementStrategies,
          } as any);

          // Emit deferred OTel eval span now that judge is complete
          const completedReport = {
            ...report,
            passFailStatus: judgment.passFailStatus,
            metrics: judgment.metrics,
            llmJudgeReasoning: judgment.llmJudgeReasoning,
          } as EvaluationReport;
          emitDeferredTestCaseSpan(
            testCase,
            completedReport,
            { name: report.experimentId ? `benchmark:${report.experimentId}` : `standalone:${report.agentKey}` },
            report.experimentRunId || report.id,
            report.runId,
            undefined, // startTime
            undefined, // endTime
            spans[0]?.traceId
          );

          // Update parent benchmark run stats now that this report is complete
          if (report.experimentId) {
            await refreshBenchmarkRunStats(storage, report.experimentId, report.id);
          }
        } catch (error) {
          console.error(`[BenchmarkRunner] Failed to judge report ${report.id}:`, error instanceof Error ? error.message : error);
          // Still mark as error
          await storage.runs.update(report.id, buildEvaluatorErrorPatch(
            'judge_failed',
            error,
          ) as any);

          // Update parent benchmark run stats (error counts as failed)
          if (report.experimentId) {
            await refreshBenchmarkRunStats(storage, report.experimentId, report.id);
          }
        }
      },
      onAttempt: () => {}, // No verbose logging
      onError: (error) => {
        console.error(`[BenchmarkRunner] Trace polling failed for report ${report.id}:`, error instanceof Error ? error.message : error);
      },
    },
    {
      agentConfig, // Pass agent config for hooks
      intervalMs: agentConfig?.tracePolling?.intervalMs,
      maxAttempts: agentConfig?.tracePolling?.maxAttempts,
    }
  );
}

/**
 * Start trace polling for the batch benchmark execution path (uses raw OpenSearch client).
 */
function startTracePollingForReport(report: EvaluationReport, testCase: TestCase, client: Client, benchmark?: Benchmark, run?: BenchmarkRun): Promise<void> {
  if (!report.runId) {
    console.warn(`[BenchmarkRunner] No runId for report ${report.id}, cannot start trace polling`);
    return Promise.resolve();
  }

  // Pass agent config to trace poller for hooks
  const config = getConfig();
  const allAgents = [...config.agents, ...getCustomAgents()];
  const agentConfig = allAgents.find(a => a.key === report.agentKey);

  return tracePollingManager.startPollingAsync(
    report.id,
    report.runId,
    {
      onTracesFound: async (spans, updatedReport) => {
        try {
          const finalTrajectory = agentConfig?.hooks?.buildTrajectory ? updatedReport.trajectory : report.trajectory;
          const judgeModelId = report.modelId ? getBedrockModelId(report.modelId) : undefined;
          const judgment = await callBedrockJudge(
            finalTrajectory,
            { expectedOutcomes: testCase.expectedOutcomes, expectedTrajectory: testCase.expectedTrajectory },
            [],
            () => {},
            judgeModelId
          );
          await updateRunWithClient(client, report.id, {
            trajectory: finalTrajectory,
            metricsStatus: 'ready',
            passFailStatus: judgment.passFailStatus,
            metrics: judgment.metrics,
            llmJudgeReasoning: judgment.llmJudgeReasoning,
            // Unified judge surface (issue #230 follow-up).
            matcherResults: [
              buildJudgeMatcherEntry(judgment, {
                claim: formatExpectedOutcomesAsClaim(testCase.expectedOutcomes),
                model: judgeModelId,
              }),
            ],
            improvementStrategies: judgment.improvementStrategies,
          });
          if (report.experimentId) {
            await updateBenchmarkRunStatsForReport(client, report.experimentId, report.id);
          }

          // Emit deferred OTel evaluation span now that judge is complete
          if (benchmark && run) {
            const completedReport = {
              ...report,
              passFailStatus: judgment.passFailStatus,
              metrics: judgment.metrics,
              llmJudgeReasoning: judgment.llmJudgeReasoning,
            } as EvaluationReport;
            const agentTraceId = spans[0]?.traceId;
            emitDeferredTestCaseSpan(testCase, completedReport, benchmark, run.id, report.runId, undefined, undefined, agentTraceId);
          }
        } catch (error) {
          console.error(`[BenchmarkRunner] Failed to judge report ${report.id}:`, error instanceof Error ? error.message : error);
          await updateRunWithClient(client, report.id, buildEvaluatorErrorPatch(
            'judge_failed',
            error,
          ) as any);
          if (report.experimentId) {
            await updateBenchmarkRunStatsForReport(client, report.experimentId, report.id);
          }
        }
      },
      onAttempt: () => {},
      onError: (error) => {
        console.error(`[BenchmarkRunner] Trace polling failed for report ${report.id}:`, error instanceof Error ? error.message : error);
      },
    },
    {
      agentConfig, // Pass agent config for hooks
      intervalMs: agentConfig?.tracePolling?.intervalMs,
      maxAttempts: agentConfig?.tracePolling?.maxAttempts,
    }
  );
}

/**
 * Recompute pass/fail stats for a benchmark run after one of its reports changes.
 * Adapter-agnostic — works with both file and OpenSearch storage.
 */
async function refreshBenchmarkRunStats(
  storage: IStorageModule,
  benchmarkId: string,
  reportId: string,
): Promise<void> {
  try {
    const benchmark = await storage.benchmarks.getById(benchmarkId);
    if (!benchmark) return;

    const targetRun = benchmark.runs?.find((run: any) =>
      Object.values(run.results || {}).some((result: any) => result.reportId === reportId)
    );
    if (!targetRun) return;

    const reportIds = Object.values(targetRun.results || {})
      .map((r: any) => r.reportId)
      .filter(Boolean) as string[];

    let passed = 0, failed = 0, pending = 0, errored = 0;
    const total = Object.keys(targetRun.results || {}).length;

    for (const rid of reportIds) {
      try {
        const report = await storage.runs.getById(rid);
        if (!report) { pending++; continue; }
        const ms = (report as any).metricsStatus;
        if (ms === 'pending' || ms === 'calculating') {
          pending++;
        } else if (ms === 'error') {
          // Evaluator failed to produce a verdict (issue #242).
          errored++;
        } else if (report.passFailStatus === 'passed') {
          passed++;
        } else {
          failed++;
        }
      } catch {
        pending++;
      }
    }
    pending += total - reportIds.length;

    await storage.benchmarks.updateRun(benchmarkId, targetRun.id, {
      stats: { passed, failed, pending, errored, total },
    } as any);
  } catch (err) {
    console.warn(`[BenchmarkRunner] Failed to refresh stats for benchmark ${benchmarkId}:`, err instanceof Error ? err.message : err);
  }
}

// Backwards compatibility aliases
/** @deprecated Use runBenchmark instead */
export const runExperiment = runBenchmark;

// ─── SDK code-import helpers (mirrored from evaluationRunner.ts) ────────────
//
// These helpers let us run a deterministic test body against a synthetic
// EvalResult shape, recording per-matcher verdicts on the resulting report.

function makeTrajectoryAccessor(steps: TrajectoryStep[]): TrajectoryAccessor {
  const arr = steps as TrajectoryAccessor;
  Object.defineProperties(arr, {
    stepsOfType: {
      value(type: string) { return arr.filter((s: any) => s?.type === type); },
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
      try { return JSON.parse(input.agentOutput); } catch { return undefined; }
    },
    rawEvents: input.rawEvents,
    runId: input.runId,
    durationMs: input.durationMs,
    tokenUsage: input.tokenUsage,
  };
}

function buildFixtures(result: EvalResult, traces: TracesAccessor): TestFixtures {
  return {
    result,
    judge: judgeFn,
    traces,
    expect: ahExpect,
    testInfo: { name: '' },
    provisioned: {},
  };
}

/**
 * Construct the appropriate `TracesAccessor` for a deterministic eval body.
 * See {@link loadTracesAccessor} in `services/evaluationRunner.ts` for the
 * canonical doc — issue #230. Kept as a sibling helper here to avoid a
 * circular import between the two runners.
 */
async function loadTracesAccessor(
  agentConfig: AgentConfig,
  runId: string | undefined
): Promise<TracesAccessor> {
  if (!agentConfig.useTraces) {
    return emptyTracesAccessor();
  }
  if (!runId) {
    return unavailableTracesAccessor(
      'agent has useTraces=true but produced no runId for trace correlation'
    );
  }
  const polling = agentConfig.tracePolling ?? {};
  const result = await fetchSpansForRun(runId, {
    maxAttempts: polling.maxAttempts,
    intervalMs: polling.intervalMs,
  });
  if (result.spans.length === 0) {
    const reason = result.lastError
      ? `fetch failed for runId=${runId}: ${result.lastError}`
      : `no spans found for runId=${runId} after polling — verify the agent's OTel exporter is reachable`;
    return unavailableTracesAccessor(reason);
  }
  return buildTracesAccessor(result.spans);
}

function synthesizeEmptyReport(testCase: TestCase, agentKey: string, modelId: string): EvaluationReport {
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
    passFailStatus: 'passed',
    evaluationType: 'deterministic',
  } as unknown as EvaluationReport;
}
