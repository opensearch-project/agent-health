/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test: ALWAYS-RECORD — objective actuals (duration/tokens/
 * cost) survive a mid-body throw in a code-SDK (`.eval.js`) test.
 *
 * Bug (owner-hit, measurement-harness-defeating): chai's `expect()` is
 * fail-fast. When a test body's first matcher throws, the rest of the body
 * — later `expect()`/`judge()` calls — never executes. Pre-fix, nothing
 * else wrote `totalTokens`/`totalCostUsd` onto the report unless a matcher
 * happened to read them, so a failing token-budget gate silently erased
 * the cost figure too (seen on eval-run-1787783388969-1tmdqr5nv: "T1 cost
 * n/a"). An optimizer reading these reports needs all four axes
 * (accuracy, latency, tokens, cost) even when one gate fails.
 *
 * This test runs a REAL 2-matcher eval file body through the actual
 * `executeEvaluationRun` runner (mocking only the connector/storage
 * boundary — the matcher session, chai plugin, and always-record helpers
 * are all real) where matcher #1 fails, and asserts the persisted report
 * JSON carries `performanceMetrics.durationMs` / `.totalTokens` /
 * `.totalCostUsd` plus a distinctly-flagged `notReached` marker for
 * matcher #2, which never ran.
 *
 * Mirrors the harness in sdkMatcherSessionMetrics.integration.test.ts.
 */

import type { EvaluationRun, TestCase } from '@/types';
import type { IStorageModule } from '@/server/adapters/types';
import type { EvaluateFn } from '@/services/sourceResolver';

jest.mock('@/services/evaluation', () => ({
  ...jest.requireActual('@/services/evaluation'),
  runEvaluationWithConnector: jest.fn(),
  invokeAgent: jest.fn(),
  callBedrockJudge: jest.fn(),
}));

jest.mock('@/services/connectors/server', () => ({
  connectorRegistry: { getConnector: jest.fn() },
}));

jest.mock('@/lib/config/index', () => ({
  loadConfigSync: () => ({
    // No `useTraces` — the deterministic path loads `emptyTracesAccessor()`
    // (real zeros), deterministically, with no OpenSearch/trace-fetch
    // mocking required. That's sufficient to prove the FIELD is present
    // post-fix (it was simply absent — `undefined` — pre-fix).
    agents: [
      { key: 'test-agent', name: 'Test Agent', endpoint: 'http://localhost:3000/agent', connectorType: 'mock' },
    ],
    models: {
      'claude-sonnet': { model_id: 'anthropic.claude-test', display_name: 'Test', context_window: 200000, max_output_tokens: 4096 },
    },
  }),
}));

jest.mock('@/lib/constants', () => ({
  DEFAULT_CONFIG: { agents: [], models: {} },
}));

jest.mock('@/server/services/customAgentStore', () => ({
  getCustomAgents: jest.fn().mockReturnValue([]),
}));

jest.mock('@/services/traces/tracePoller', () => ({
  tracePollingManager: { startPolling: jest.fn() },
}));

jest.mock('@/lib/telemetry/evalSpans', () => ({
  startIsolatedTestCaseSpan: jest.fn().mockReturnValue(null),
  finalizeTestCaseSpan: jest.fn(),
  addEvaluationResultEvents: jest.fn(),
}));

jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'warn').mockImplementation(() => {});

import { invokeAgent } from '@/services/evaluation';
import { executeEvaluationRun } from '@/services/evaluationRunner';

const mockInvokeAgent = invokeAgent as jest.Mock;

function createMockStorage(captured: { savedReports: any[] }): IStorageModule {
  const noop = jest.fn();
  return {
    testCases: { getById: noop, getAll: noop, create: noop, update: noop, delete: noop, bulkCreate: noop, bulkUpsert: noop, search: noop },
    benchmarks: { getById: noop, getAll: noop, create: noop, update: noop, delete: noop, bulkCreate: noop, addRun: noop, updateRun: noop, deleteRun: noop },
    runs: {
      getById: noop, getAll: noop,
      create: jest.fn().mockImplementation(async (report: any) => {
        captured.savedReports.push(report);
        return { ...report, id: report.id ?? `report-${captured.savedReports.length}` };
      }),
      update: jest.fn().mockImplementation(async (id: string, report: any) => {
        captured.savedReports.push({ ...report, id });
        return { ...report, id };
      }),
      delete: noop, bulkCreate: noop, search: noop, getByTestCase: noop, getByExperiment: noop, getByExperimentRun: noop, getIterations: noop, countsByTestCase: noop, addAnnotation: noop, updateAnnotation: noop, deleteAnnotation: noop,
    },
    evaluationRuns: { create: noop, getById: noop, update: noop, delete: noop, list: noop, updateResult: noop },
    analytics: { query: noop, aggregations: noop, writeRecord: noop, backfill: noop },
    evaluators: { getAll: noop, getById: noop, getVersions: noop, getVersion: noop, create: noop, update: noop, delete: noop },
    sessionMetadata: { get: noop, put: noop, list: noop },
    health: jest.fn().mockResolvedValue({ status: 'green' }),
    isConfigured: jest.fn().mockReturnValue(true),
  } as unknown as IStorageModule;
}

const tc = (id: string): TestCase =>
  ({ id, name: id, initialPrompt: 'P', context: [] } as unknown as TestCase);

const run = (overrides: Partial<EvaluationRun> = {}): EvaluationRun =>
  ({
    id: 'run-1',
    agentKey: 'test-agent',
    modelId: 'claude-sonnet',
    status: 'running',
    results: {},
    createdAt: new Date().toISOString(),
    ...overrides,
  } as unknown as EvaluationRun);

/** Pull the FINAL saved report (not the placeholder) from captured saves. */
function finalReport(captured: { savedReports: any[] }, testCaseId: string): any {
  const matched = captured.savedReports.filter(r => r.testCaseId === testCaseId);
  const final = matched.find(r => r.evaluationType === 'deterministic');
  if (!final) {
    throw new Error(
      `No final SDK matcher-session report found for ${testCaseId}; saw: ` +
      JSON.stringify(matched.map(r => ({ status: r.status, evaluationType: r.evaluationType }))),
    );
  }
  return final;
}

describe('ALWAYS-RECORD: objective actuals survive a mid-body throw (regression)', () => {
  let captured: { savedReports: any[] };
  let storage: IStorageModule;

  beforeEach(() => {
    jest.clearAllMocks();
    captured = { savedReports: [] };
    storage = createMockStorage(captured);
    mockInvokeAgent.mockResolvedValue({
      trajectory: [{ type: 'response', content: 'agent output' }],
      rawEvents: [],
      runId: null,
      agentDurationMs: 4242,
      connector: { type: 'mock' } as any,
    });
  });

  it('2-matcher eval file, matcher #1 fails: report JSON still carries duration/tokens/cost, and matcher #2 is marked notReached', async () => {
    // The exact shape of the bug report: a token/latency-style gate fails
    // first; a SECOND matcher (that would read totalCost) is placed after
    // it and never executes because chai throws on the first failure.
    const evaluateFn: EvaluateFn = async ({ agent, expect }: any) => {
      const result = await agent.run('P');
      expect(result.agentDurationMs).to.equal(999); // matcher #1: FAILS — throws
      expect(result).to.exist;                       // matcher #2: NEVER reached
    };
    const evaluateFnMap = new Map<string, EvaluateFn>([['tc-mid-throw', evaluateFn]]);

    await executeEvaluationRun(
      run(),
      [tc('tc-mid-throw')],
      { storageModule: storage, evaluateFnMap, onProgress: jest.fn() },
    );

    const report = finalReport(captured, 'tc-mid-throw');
    expect(report.passFailStatus).toBe('failed');

    // ── The fix under test ──────────────────────────────────────────────
    // durationMs/agentDurationMs already survived a throw pre-fix (stamped
    // by invoke() before the body runs further) — pinned here as a
    // non-regression, not the headline assertion.
    expect(report.performanceMetrics.durationMs).toBe(4242);
    expect(report.performanceMetrics.agentDurationMs).toBe(4242);
    // THE GAP THIS PR CLOSES: totalTokens/totalCostUsd are now PRESENT
    // (real zeros — this mock agent has no useTraces, so the accessor is
    // the deterministic emptyTracesAccessor) even though the body never
    // reached a `traces.totalTokens`/`totalCost` matcher. Pre-fix these
    // were `undefined` on the persisted report — this is the literal
    // "cost n/a" symptom from the bug report.
    expect(report.performanceMetrics.totalTokens).toBe(0);
    expect(report.performanceMetrics.totalCostUsd).toBe(0);

    // Matcher panel data: matcher #1 recorded as a real failure; matcher
    // #2 is a distinctly-flagged synthetic "not reached" entry, not just
    // silently absent.
    expect(report.matcherResults).toHaveLength(2);
    expect(report.matcherResults[0].pass).toBe(false);
    expect(report.matcherResults[0].notReached).toBeFalsy();
    expect(report.matcherResults[1].notReached).toBe(true);
    expect(report.matcherResults[1].pass).toBe(false);

    // The notReached marker must NOT be double-counted in the aggregate
    // score computation (it's neither a real pass nor a real fail).
    expect(report.metrics).toEqual({
      accuracy: 0, faithfulness: 0, latency_score: 0, trajectory_alignment_score: 0,
    }); // hasEvalError bypass — unchanged BC behavior, pinned for clarity.
  });

  it('control: all matchers pass — totalTokens/totalCostUsd are present with the SAME contract (no throw needed to see them)', async () => {
    const evaluateFn: EvaluateFn = async ({ agent, expect }: any) => {
      const result = await agent.run('P');
      expect(result).to.exist;
    };
    const evaluateFnMap = new Map<string, EvaluateFn>([['tc-clean', evaluateFn]]);

    await executeEvaluationRun(
      run(),
      [tc('tc-clean')],
      { storageModule: storage, evaluateFnMap, onProgress: jest.fn() },
    );

    const report = finalReport(captured, 'tc-clean');
    expect(report.passFailStatus).toBe('passed');
    expect(report.performanceMetrics.totalTokens).toBe(0);
    expect(report.performanceMetrics.totalCostUsd).toBe(0);
    // No throw → no notReached marker.
    expect(report.matcherResults.some((m: any) => m.notReached)).toBe(false);
  });

  it('a REACHED judge() call before the throw is already recorded (ordering, not always-record, decides reachability)', async () => {
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        passFailStatus: 'passed',
        metrics: { accuracy: 100 },
        llmJudgeReasoning: 'looks right',
        improvementStrategies: [],
      }),
      text: async () => '',
    });

    const evaluateFn: EvaluateFn = async ({ agent, judge, expect }: any) => {
      const result = await agent.run('P');
      await judge(result, 'claim reached before the throw');   // reached — recorded
      expect(result.agentDurationMs).to.equal(999);              // fails — throws
      await judge(result, 'claim after the throw — never runs'); // NOT reached
    };
    const evaluateFnMap = new Map<string, EvaluateFn>([['tc-judge-order', evaluateFn]]);

    await executeEvaluationRun(
      run(),
      [tc('tc-judge-order')],
      { storageModule: storage, evaluateFnMap, onProgress: jest.fn() },
    );

    const report = finalReport(captured, 'tc-judge-order');
    // The reached judge() call's score IS on the report (already-working
    // guarantee — judge() is non-throwing and records synchronously).
    const judgeEntries = report.matcherResults.filter((m: any) => m.method === 'llm-judge');
    expect(judgeEntries).toHaveLength(1);
    expect(judgeEntries[0].pass).toBe(true);
    // The unreached second judge() call has NO matcherResult of its own —
    // only the synthetic notReached marker stands in for "something after
    // this point never ran". This is the documented limit of always-record:
    // it cannot resurrect a call the user's source order never let execute.
    expect(report.matcherResults.filter((m: any) => m.notReached)).toHaveLength(1);
  });
});
