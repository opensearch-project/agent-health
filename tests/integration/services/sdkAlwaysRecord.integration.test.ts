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
 * JSON carries `performanceMetrics.durationMs` plus a distinctly-flagged
 * `notReached` marker for matcher #2, which never ran; for a TRACED agent
 * `.totalTokens` / `.totalCostUsd` are stamped from the spans (counted once,
 * #653), for an untraced one they are ABSENT, never `0` (#654).
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
    agents: [
      // No `useTraces` — the deterministic path loads `emptyTracesAccessor()`:
      // usage is NOT captured, so the report must carry NO token/cost numbers
      // (never a literal 0 — #654).
      { key: 'test-agent', name: 'Test Agent', endpoint: 'http://localhost:3000/agent', connectorType: 'mock' },
      // `useTraces: true` — the runner reads the spans the stub TracesClient
      // below returns and stamps the always-record actuals from them.
      { key: 'traced-agent', name: 'Traced Agent', endpoint: 'http://localhost:3000/agent', connectorType: 'mock', useTraces: true, tracePolling: { maxAttempts: 1, intervalMs: 0 } },
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
  startTestCaseSpan: jest.fn().mockReturnValue(null),
  finalizeTestCaseSpan: jest.fn(),
  addEvaluationResultEvents: jest.fn(),
}));

jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'warn').mockImplementation(() => {});

import { invokeAgent } from '@/services/evaluation';
import { executeEvaluationRun } from '@/services/evaluationRunner';
import type { Span } from '@/types';
import type { TracesClient } from '@/services/traces/index';

/**
 * Real-shaped agent trace: an `invoke_agent` span stamped with the ROLL-UP
 * of its three `chat` children (exactly their sum, as GenAI-convention
 * frameworks do), plus a tool span. Summing every span would read 2× the
 * real usage (#653); the leaf-usage invariant counts 6,000 / 300 once.
 */
const MODEL = 'anthropic.claude-sonnet-4-20250514-v1:0';
const TRACED_SPANS: Span[] = [
  { traceId: 'trace-1', spanId: 'agent', name: 'invoke_agent demo', status: 'OK', startTime: '2026-01-01T00:00:00Z', endTime: '2026-01-01T00:00:10Z',
    attributes: { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.request.model': MODEL, 'gen_ai.usage.input_tokens': 6000, 'gen_ai.usage.output_tokens': 300, 'agent_health.run.id': 'req-traced-1' } },
  { traceId: 'trace-1', spanId: 'chat-1', parentSpanId: 'agent', name: 'chat', status: 'OK', startTime: '2026-01-01T00:00:01Z', endTime: '2026-01-01T00:00:03Z',
    attributes: { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': MODEL, 'gen_ai.usage.input_tokens': 1000, 'gen_ai.usage.output_tokens': 50 } },
  { traceId: 'trace-1', spanId: 'tool-1', parentSpanId: 'agent', name: 'execute_tool search', status: 'OK', startTime: '2026-01-01T00:00:03Z', endTime: '2026-01-01T00:00:04Z',
    attributes: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'search' } },
  { traceId: 'trace-1', spanId: 'chat-2', parentSpanId: 'agent', name: 'chat', status: 'OK', startTime: '2026-01-01T00:00:04Z', endTime: '2026-01-01T00:00:06Z',
    attributes: { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': MODEL, 'gen_ai.usage.input_tokens': 2000, 'gen_ai.usage.output_tokens': 100 } },
  { traceId: 'trace-1', spanId: 'chat-3', parentSpanId: 'agent', name: 'chat', status: 'OK', startTime: '2026-01-01T00:00:06Z', endTime: '2026-01-01T00:00:09Z',
    attributes: { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': MODEL, 'gen_ai.usage.input_tokens': 3000, 'gen_ai.usage.output_tokens': 150 } },
] as unknown as Span[];
const EXPECTED_LEAF_TOKENS = 6000 + 300;
// Sonnet-class rates: $3 / M input, $15 / M output.
const EXPECTED_LEAF_COST = (6000 * 3 + 300 * 15) / 1_000_000;

const stubTraces: TracesClient = {
  fetchTracesForRun: jest.fn().mockResolvedValue({ spans: TRACED_SPANS, total: TRACED_SPANS.length }),
};

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
    // This mock agent has no useTraces (emptyTracesAccessor): usage was not
    // captured, so the persisted report carries NO totalTokens/totalCostUsd
    // — absent, never a literal `0` that every view would then show and
    // average as a measured zero (#654). The always-record contract for a
    // TRACED agent is the next test.
    expect(report.performanceMetrics).not.toHaveProperty('totalTokens');
    expect(report.performanceMetrics).not.toHaveProperty('totalCostUsd');

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

  it('TRACED agent, matcher #1 fails: totalTokens/totalCostUsd are stamped from the spans, counted ONCE despite the invoke_agent roll-up (#653)', async () => {
    mockInvokeAgent.mockResolvedValue({
      trajectory: [{ type: 'response', content: 'agent output' }],
      rawEvents: [],
      runId: 'req-traced-1',
      agentDurationMs: 4242,
      connector: { type: 'mock' } as any,
    });
    const evaluateFn: EvaluateFn = async ({ agent, expect }: any) => {
      const result = await agent.run('P');
      expect(result.agentDurationMs).to.equal(999); // matcher #1: FAILS — throws
      expect(result.traces.totalTokens).to.be.lessThan(1); // matcher #2: NEVER reached
    };
    const evaluateFnMap = new Map<string, EvaluateFn>([['tc-traced-throw', evaluateFn]]);

    await executeEvaluationRun(
      run({ agentKey: 'traced-agent' }),
      [tc('tc-traced-throw')],
      { storageModule: storage, evaluateFnMap, onProgress: jest.fn(), traces: stubTraces },
    );

    const report = finalReport(captured, 'tc-traced-throw');
    expect(report.passFailStatus).toBe('failed');
    // Always-record: stamped even though the body threw before reading them …
    expect(report.performanceMetrics.totalTokens).toBe(EXPECTED_LEAF_TOKENS);
    expect(report.performanceMetrics.totalCostUsd).toBeCloseTo(EXPECTED_LEAF_COST, 10);
    // … and NOT the 2× a plain sum over every usage-carrying span gives.
    expect(report.performanceMetrics.totalTokens).not.toBe(EXPECTED_LEAF_TOKENS * 2);
    expect(report.matcherResults[1].notReached).toBe(true);
  });

  it('control (untraced): all matchers pass — the report still carries NO token/cost numbers', async () => {
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
    expect(report.performanceMetrics).not.toHaveProperty('totalTokens');
    expect(report.performanceMetrics).not.toHaveProperty('totalCostUsd');
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
