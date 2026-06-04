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
} from '@/types';
import type { IStorageModule } from '@/server/adapters/types';
import { runEvaluationWithConnector, callBedrockJudge } from '@/services/evaluation';
import { buildEvaluatorErrorPatch } from '@/services/evaluation/evaluatorError';
import { connectorRegistry } from '@/services/connectors/server';
import { v4 as uuidv4 } from 'uuid';
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
import { judge } from '@/lib/testCases/judge';
import { expect } from '@/lib/matchers/expect';
import type { TrajectoryStep } from '@/types';
import { createHookOrchestrator, type TestDescriptor } from './hookOrchestrator';
import { loadConfigSync } from '@/lib/config/index';
import { DEFAULT_CONFIG } from '@/lib/constants';
import { getCustomAgents } from '@/server/services/customAgentStore';
import { debug } from '@/lib/debug';
import { tracePollingManager } from './traces/tracePoller';
import { fetchSpansForRun } from './traces/fetchSpansForRun';
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

  // Resolve model ID
  const modelConfig = config.models[run.modelId];
  const bedrockModelId = modelConfig?.model_id || run.modelId;

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

        // Report progress — this test case is starting
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

        // Set status to running
        run.results[testCaseId] = { reportId: '', status: 'running' };

        try {
          // Check if this test case has a deterministic evaluate function
          const hasDeterministicEval = evaluateFnMap?.has(testCaseId) ?? false;
          // Detect code-only tests that have no prompt — skip agent invocation
          // entirely and run the deterministic body against an empty result.
          const hasPrompt = !!(testCase.initialPrompt && testCase.initialPrompt.trim().length > 0);
          const skipAgentInvocation = !hasPrompt && hasDeterministicEval;

          let report: EvaluationReport;
          if (skipAgentInvocation) {
            debug('EvaluationRunner', `[${testCaseId}] No prompt — running deterministic body without agent invocation`);
            report = synthesizeEmptyReport(testCase, agentConfig.key, bedrockModelId);
          } else {
            // Run the evaluation using connector
            report = await runEvaluationWithConnector(
              agentConfig,
              bedrockModelId,
              testCase,
              () => {}, // No debug callback needed
              { registry: connectorRegistry, evaluatorId: run.evaluatorId, skipJudge: hasDeterministicEval }
            );
          }

          // Run deterministic evaluation if applicable
          if (hasDeterministicEval) {
            const evalFn = evaluateFnMap!.get(testCaseId)!;
            const trajectorySteps = report.trajectory || [];
            // The AG-UI converter emits 'assistant' for the final text; older
            // protocols emit 'response'. Accept both.
            const agentOutput = trajectorySteps
              .filter((s: any) => s.type === 'response' || s.type === 'assistant')
              .map((s: any) => s.content)
              .join('\n');

            const evalResult = buildEvalResult({
              trajectory: trajectorySteps,
              agentOutput,
              rawEvents: report.rawEvents || [],
              runId: report.runId,
              durationMs: report.performanceMetrics?.durationMs ?? 0,
            });

            // Pre-load the traces fixture for the body. See issue #230:
            // when useTraces is true the fixture must reflect real OTel
            // data — or fail loudly if it can't — instead of silently
            // returning zeros that make `lessThan(N)` matchers pass.
            const tracesAccessor = await loadTracesAccessor(agentConfig, report.runId);
            // Look up the scope for this test (file + describePath). Code
            // imports populate this from `sourceResolver.testHookScopes`;
            // tests that lack a scope entry simply don't match any hook
            // (the orchestrator's chain walk requires a real `sourceFile`
            // on the descriptor).
            const scope = testHookScopes?.get(testCaseId);
            const desc: TestDescriptor = {
              testCaseId,
              name: testCase.name,
              sourceFile: scope?.sourceFile,
              describePath: scope?.describePath,
            };

            const session = startSession();
            // Run beforeAll/beforeEach. Hook results are folded into the
            // matcher session so the per-matcher UI shows them.
            const before = await hookOrchestrator.beforeTest(desc);
            for (const r of before.matcherResults) {
              (session.results as any).push(r);
            }
            // Stamp the per-test fixtures (with testInfo+provisioned+
            // potentially provide-from-beforeEach) over the EvalResult
            // object so legacy 1-arg bodies and modern destructuring
            // bodies both work. Overlay the per-run tracesAccessor too —
            // the orchestrator's noop factory returns an empty one.
            const fixtures: TestFixtures = {
              ...before.fixtures,
              result: evalResult,
              traces: tracesAccessor,
            };
            const arg = Object.assign(evalResult, { ...fixtures, result: evalResult }) as any;

            try {
              if (!before.aborted) {
                await evalFn(arg);
              }
              // Always run afterEach/afterAll — even when the body or a
              // beforeEach threw. Errors there become MatcherResult
              // entries on the test, not runner crashes.
              const after = await hookOrchestrator.afterTest(desc, fixtures);
              for (const r of after) {
                (session.results as any).push(r);
              }
              const matcherResults = endSession();
              const anyFailed = matcherResults.some(m => !m.pass);
              (report as any).passFailStatus = anyFailed ? 'failed' : 'passed';
              (report as any).evaluationType = 'deterministic';
              (report as any).matcherResults = matcherResults;
              // Option B BC shim: legacy `llmJudgeReasoning` field is a
              // derived view of `matcherResults`. SDK runs use the
              // matcher session as the source of truth (multiple
              // `judge()` calls each become a separate [llm-judge]
              // entry), so we leave the legacy flat-string field empty.
              // External readers that haven't migrated to
              // `getJudgeMatcherResults()` see '' — a clear signal that
              // judge data lives in `matcherResults`.
              (report as any).llmJudgeReasoning = '';
              (report as any).metrics = anyFailed
                ? { accuracy: 0, faithfulness: 0, latency_score: 0, trajectory_alignment_score: 0 }
                : { accuracy: 100, faithfulness: 100, latency_score: 100, trajectory_alignment_score: 100 };
            } catch (evalError: any) {
              // Body threw: still run afterEach/afterAll so cleanup happens.
              const after = await hookOrchestrator.afterTest(desc, fixtures);
              for (const r of after) {
                (session.results as any).push(r);
              }
              const matcherResults = endSession();
              (report as any).passFailStatus = 'failed';
              (report as any).evaluationType = 'deterministic';
              (report as any).assertionError = evalError.message;
              (report as any).matcherResults = matcherResults;
              // See success branch above for the Option B BC rationale.
              (report as any).llmJudgeReasoning = '';
              (report as any).metrics = { accuracy: 0, faithfulness: 0, latency_score: 0, trajectory_alignment_score: 0 };
            }
          }

          // Deterministic eval already produced a verdict via the matcher
          // session. Mark the report as final so the trace-mode polling /
          // Bedrock-judge path below is skipped — those would otherwise call
          // callBedrockJudge with empty expectedOutcomes and fail loudly.
          if (hasDeterministicEval) {
            (report as any).metricsStatus = 'completed';
            (report as any).skipJudge = true;
          }

          // Save the report via storage module
          const savedReport = await storageModule.runs.create(report as any);

          // If trace mode (metricsStatus: 'pending'), poll for traces and run judge inline.
          // Skipped for deterministic runs (matcher session decided the verdict already).
          if (
            !hasDeterministicEval &&
            savedReport.metricsStatus === 'pending' &&
            savedReport.runId
          ) {
            debug('EvaluationRunner', `[${testCaseId}] Trace mode: polling for traces (runId=${savedReport.runId})`);
            await waitForTracesAndJudge(savedReport, testCase, storageModule, agentConfig);
          }

          // Update result with success. The run-level status mirrors the
          // report's verdict so aggregate stats (run.stats.passed/failed)
          // reflect what actually happened rather than just "the runner
          // didn't crash". Reports that finished but failed assertions are
          // marked 'failed' here too.
          const reportPassFail = (savedReport as any).passFailStatus;
          const status: RunResultStatus = reportPassFail === 'failed' ? 'failed' : 'completed';
          run.results[testCaseId] = {
            reportId: savedReport.id,
            status,
            ...(reportPassFail ? { passFailStatus: reportPassFail } : {}),
          };

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
          run.results[testCaseId] = { reportId: '', status: 'failed', error: errorMsg };

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

    // Compute stats from results
    let passed = 0;
    let failed = 0;
    let pending = 0;
    for (const result of Object.values(run.results)) {
      if (result.status === 'completed') {
        // Check if the underlying report passed
        // For now, count completed as needing further resolution
        // We'll check passFailStatus from saved reports
        passed++; // Will be refined by caller if needed
      } else if (result.status === 'failed') {
        failed++;
      } else {
        pending++;
      }
    }

    run.stats = {
      passed,
      failed,
      pending,
      total: totalTestCases,
    };

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
): Promise<void> {
  return new Promise<void>((resolve) => {
    tracePollingManager.startPolling(
      report.id,
      report.runId!,
      {
        onTracesFound: async (_spans, updatedReport) => {
          try {
            const finalTrajectory = agentConfig?.hooks?.buildTrajectory
              ? updatedReport.trajectory
              : report.trajectory;

            const config = getConfig();
            const modelConfig = config.models[report.modelId || ''];
            const judgeModelId = modelConfig?.model_id || report.modelId;

            const judgment = await callBedrockJudge(
              finalTrajectory,
              {
                expectedOutcomes: testCase.expectedOutcomes,
                expectedTrajectory: testCase.expectedTrajectory,
              },
              [],
              () => {},
              judgeModelId
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
            } as any);

            debug('EvaluationRunner', `[${testCase.id}] Trace judge complete: ${judgment.passFailStatus}`);
            resolve();
          } catch (error) {
            console.error(`[EvaluationRunner] Failed to judge report ${report.id}:`, error instanceof Error ? error.message : error);
            await storage.runs.update(report.id, buildEvaluatorErrorPatch(
              'judge_failed',
              error,
            ) as any).catch(() => {});
            resolve(); // Don't fail the whole run, just mark metrics as error
          }
        },
        onAttempt: (attempt, max) => {
          debug('EvaluationRunner', `[${testCase.id}] Trace poll attempt ${attempt}/${max}`);
        },
        onError: (error) => {
          console.error(`[EvaluationRunner] Trace polling failed for report ${report.id}:`, error.message);
          resolve(); // Don't fail the whole run — report already has error status from tracePoller
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
 * Build the fixtures object passed to the new Playwright-style test body.
 * The traces fixture is constructed by {@link loadTracesAccessor} prior
 * to this call — see issue #230.
 */
function buildFixtures(result: EvalResult, traces: TracesAccessor): TestFixtures {
  return {
    result,
    judge,
    traces,
    expect,
    // Defaults for tests that bypass the orchestrator (none today — the
    // runner always goes through `hookOrchestrator.beforeTest()` which
    // overwrites these). Kept here so the function still returns a
    // complete TestFixtures and is safe for any future caller.
    testInfo: { name: '' },
    provisioned: {},
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
