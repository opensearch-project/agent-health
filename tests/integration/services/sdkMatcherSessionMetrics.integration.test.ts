/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test: SDK matcher-session report.metrics shape — pass-rate
 * aggregate + dimensional pass-through.
 *
 * Sits ABOVE the helper unit tests (computeSdkMatcherSessionMetrics.test.ts):
 * those exercise the helper in isolation with hand-rolled MatcherResult[];
 * THIS test exercises the helper through the actual runner contract — a
 * code body that calls `judge(...)` (non-throwing, RFC 004 §4.4), the
 * matcher session collects those into MatcherResult[], the runner writes
 * the final report, and we assert the persisted report's `metrics`
 * reflects partial credit (was hardcoded {0,0,0,0}/{100,100,100,100}
 * pre-fix).
 *
 * The regression boundary this test pins:
 *
 *   - 4-of-6 passing claims (judge calls) → `report.metrics.accuracy = 67`
 *     (4/6 × 100, rounded), NOT 0. This is the headline customer-visible
 *     change: pre-fix every failing run looked identical in the metrics
 *     tile regardless of how many claims passed.
 *   - All-passing → 100. All-failing → 0. (BC.)
 *   - Body that throws explicitly → 0. (BC. `judge()` is non-throwing, so
 *     a throw must come from the bench code itself.)
 *   - Empty body (no claims) → 100. (Vacuous pass — body completed cleanly.)
 *
 * Mirrors the in-tree pattern of evaluationRunner.deterministic.test.ts —
 * mocks invokeAgent + storage, but the matcher session itself is REAL
 * (lib/matchers exports `judge` and the runner runs it). Mocks `global.fetch`
 * to control /api/judge verdicts deterministically without spinning up
 * a server.
 */

import type { EvaluationRun, TestCase } from '@/types';
import type { IStorageModule } from '@/server/adapters/types';
import type { EvaluateFn } from '@/services/sourceResolver';

// Mock `@/services/evaluation` selectively. Spread `jest.requireActual` first
// so the real `computeSdkMatcherSessionMetrics` (a pure function with no
// side effects) is preserved — without this, the runner imports `undefined`
// and the matcher-session block throws at metrics-write time. This is the
// stale-jest-mock anti-pattern AGENTS.md warns about.
jest.mock('@/services/evaluation', () => ({
  ...jest.requireActual('@/services/evaluation'),
  runEvaluationWithConnector: jest.fn(),
  invokeAgent: jest.fn(),
  callBedrockJudge: jest.fn(),
}));

jest.mock('@/connectors/server', () => ({
  connectorRegistry: { getConnector: jest.fn() },
}));

jest.mock('@/lib/config/index', () => ({
  loadConfigSync: () => ({
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
  startTestCaseSpan: jest.fn().mockReturnValue(null),
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
      // The runner first tries pre-persist (placeholder), then either update
      // (if placeholder succeeded) or create (if it failed). We capture both.
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
      JSON.stringify(matched.map(r => ({
        status: r.status,
        evaluationType: r.evaluationType,
        passFailStatus: r.passFailStatus,
      }))),
    );
  }
  return final;
}

/**
 * Install a global.fetch mock that returns deterministic /api/judge verdicts
 * driven by a queue. Each judge() call pops one verdict from the queue.
 */
function installJudgeFetchMock(verdicts: Array<{ pass: boolean; score?: number; judgeMetrics?: Record<string, number> }>) {
  const queue = [...verdicts];
  const fetchMock = jest.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    if (typeof url === 'string' && url.includes('/api/judge')) {
      const v = queue.shift();
      if (!v) {
        throw new Error('judge fetch ran out of queued verdicts; bench called judge() more times than test scripted');
      }
      // Shape mirrors what /api/judge returns from server/routes/judge.ts.
      // The matcher accessor reads `passFailStatus`, `metrics.accuracy`,
      // `improvementStrategies`, and dimensional metrics off this object.
      const acc = v.score ?? (v.pass ? 100 : 0);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          passFailStatus: v.pass ? 'passed' : 'failed',
          metrics: {
            accuracy: acc,
            ...(v.judgeMetrics ?? {}),
          },
          llmJudgeReasoning: v.pass ? 'looks right' : 'does not match',
          improvementStrategies: [],
        }),
        text: async () => '',
      } as any;
    }
    throw new Error(`unexpected fetch to ${url}`);
  });
  (global as any).fetch = fetchMock;
  return fetchMock;
}

describe('SDK matcher-session report.metrics — partial credit + dimensional pass-through (regression)', () => {
  let captured: { savedReports: any[] };
  let storage: IStorageModule;
  let originalFetch: any;

  beforeEach(() => {
    jest.clearAllMocks();
    captured = { savedReports: [] };
    storage = createMockStorage(captured);
    mockInvokeAgent.mockResolvedValue({
      trajectory: [{ type: 'response', content: 'agent output' }],
      rawEvents: [],
      runId: null,
      agentDurationMs: 10,
      connector: { type: 'mock' } as any,
    });
    originalFetch = (global as any).fetch;
  });

  afterEach(() => {
    (global as any).fetch = originalFetch;
  });

  it('pre-fix REGRESSION: 4-of-6 passing judge() claims now reports accuracy=67, not 0', async () => {
    // judge() is non-throwing per RFC 004 §4.4 — a failing verdict is
    // recorded as a gate matcher with pass=false, but the body keeps going.
    // Pre-fix the runner then wrote `metrics: {accuracy:0,...}` for ANY
    // failing run, so a customer with 4 of 6 judges passing got the same
    // metrics tile as one with 0 of 6. Now the metric reflects partial
    // credit so the dashboards rank runs meaningfully.
    installJudgeFetchMock([
      { pass: true },
      { pass: true },
      { pass: true },
      { pass: true },
      { pass: false },
      { pass: false },
    ]);

    const evaluateFn: EvaluateFn = async ({ agent, judge }: any) => {
      const result = await agent.run('P');
      await judge(result, 'claim-1');
      await judge(result, 'claim-2');
      await judge(result, 'claim-3');
      await judge(result, 'claim-4');
      await judge(result, 'claim-5');
      await judge(result, 'claim-6');
    };
    const evaluateFnMap = new Map<string, EvaluateFn>([['tc-partial', evaluateFn]]);

    await executeEvaluationRun(
      run(),
      [tc('tc-partial')],
      { storageModule: storage, evaluateFnMap, onProgress: jest.fn() },
    );

    const report = finalReport(captured, 'tc-partial');
    expect(report.evaluationType).toBe('deterministic');
    expect(report.passFailStatus).toBe('failed');
    expect(report.matcherResults).toHaveLength(6);
    // The headline regression: 4/6 = 67%. NOT 0 (pre-fix value).
    expect(report.metrics.accuracy).toBe(67);
    expect(report.metrics.faithfulness).toBe(67);
    expect(report.metrics.latency_score).toBe(67);
    expect(report.metrics.trajectory_alignment_score).toBe(67);
  });

  it('all-passing judge() claims: report.metrics === {100, 100, 100, 100}', async () => {
    installJudgeFetchMock([{ pass: true }, { pass: true }, { pass: true }]);

    const evaluateFn: EvaluateFn = async ({ agent, judge }: any) => {
      const result = await agent.run('P');
      await judge(result, 'claim-1');
      await judge(result, 'claim-2');
      await judge(result, 'claim-3');
    };
    const evaluateFnMap = new Map<string, EvaluateFn>([['tc-all-pass', evaluateFn]]);

    await executeEvaluationRun(
      run(),
      [tc('tc-all-pass')],
      { storageModule: storage, evaluateFnMap, onProgress: jest.fn() },
    );

    const report = finalReport(captured, 'tc-all-pass');
    expect(report.passFailStatus).toBe('passed');
    expect(report.metrics).toEqual({
      accuracy: 100,
      faithfulness: 100,
      latency_score: 100,
      trajectory_alignment_score: 100,
    });
  });

  it('all-failing judge() claims: report.metrics === {0, 0, 0, 0} (pinned to prevent regression)', async () => {
    installJudgeFetchMock([{ pass: false }, { pass: false }, { pass: false }]);

    const evaluateFn: EvaluateFn = async ({ agent, judge }: any) => {
      const result = await agent.run('P');
      await judge(result, 'claim-1');
      await judge(result, 'claim-2');
      await judge(result, 'claim-3');
    };
    const evaluateFnMap = new Map<string, EvaluateFn>([['tc-all-fail', evaluateFn]]);

    await executeEvaluationRun(
      run(),
      [tc('tc-all-fail')],
      { storageModule: storage, evaluateFnMap, onProgress: jest.fn() },
    );

    const report = finalReport(captured, 'tc-all-fail');
    expect(report.passFailStatus).toBe('failed');
    expect(report.metrics.accuracy).toBe(0);
  });

  it('body that runs cleanly with no claims: report.metrics === {100, 100, 100, 100} (vacuous pass, BC)', async () => {
    const evaluateFn: EvaluateFn = async ({ agent }: any) => {
      await agent.run('P');
      // No expect/judge calls — body just exercises the agent.
    };
    const evaluateFnMap = new Map<string, EvaluateFn>([['tc-no-claims', evaluateFn]]);

    await executeEvaluationRun(
      run(),
      [tc('tc-no-claims')],
      { storageModule: storage, evaluateFnMap, onProgress: jest.fn() },
    );

    const report = finalReport(captured, 'tc-no-claims');
    expect(report.passFailStatus).toBe('passed');
    expect(report.metrics).toEqual({
      accuracy: 100,
      faithfulness: 100,
      latency_score: 100,
      trajectory_alignment_score: 100,
    });
  });

  it('body that throws (chai expect fail-fast): report.metrics === {0, 0, 0, 0} (BC)', async () => {
    // chai expect() is fail-fast: a failing assertion throws, the body
    // bails, evalError is set on the matcher session, and the runner's
    // helper returns 0s regardless of partial pass-rate. Locks BC.
    const evaluateFn: EvaluateFn = async ({ agent, expect }: any) => {
      const result = await agent.run('P');
      expect(result).to.exist;                       // pass (matcher #1)
      expect(result.agentDurationMs).to.equal(999);  // FAIL (throws)
      // never reached:
      expect(result).to.exist;
    };
    const evaluateFnMap = new Map<string, EvaluateFn>([['tc-chai-throw', evaluateFn]]);

    await executeEvaluationRun(
      run(),
      [tc('tc-chai-throw')],
      { storageModule: storage, evaluateFnMap, onProgress: jest.fn() },
    );

    const report = finalReport(captured, 'tc-chai-throw');
    expect(report.passFailStatus).toBe('failed');
    expect(report.metrics).toEqual({
      accuracy: 0,
      faithfulness: 0,
      latency_score: 0,
      trajectory_alignment_score: 0,
    });
  });

  it('dimensional pass-through: per-claim judgeMetrics flow into report-level metrics as mean-aggregated keys', async () => {
    // The second half of the fix. A custom 9-dimension RCA evaluator
    // emits per-claim `judgeMetrics` like
    // {routing_accuracy, tool_correctness, ...}. Each dimension's MEAN
    // across emitting matchers becomes a report-level metric (in addition
    // to the legacy 4-key BC stub).
    installJudgeFetchMock([
      {
        pass: true,
        score: 90,
        judgeMetrics: { routing_accuracy: 90, tool_correctness: 80, diagnostic_completeness: 70 },
      },
      {
        pass: true,
        score: 70,
        judgeMetrics: { routing_accuracy: 70, tool_correctness: 60, diagnostic_completeness: 50 },
      },
    ]);

    const evaluateFn: EvaluateFn = async ({ agent, judge }: any) => {
      const result = await agent.run('P');
      await judge(result, 'classification accuracy');
      await judge(result, 'tool correctness');
    };
    const evaluateFnMap = new Map<string, EvaluateFn>([['tc-dim', evaluateFn]]);

    await executeEvaluationRun(
      run(),
      [tc('tc-dim')],
      { storageModule: storage, evaluateFnMap, onProgress: jest.fn() },
    );

    const report = finalReport(captured, 'tc-dim');
    expect(report.passFailStatus).toBe('passed');
    // Dimensional means flowed up:
    expect(report.metrics.routing_accuracy).toBe(80);        // (90 + 70) / 2
    expect(report.metrics.tool_correctness).toBe(70);        // (80 + 60) / 2
    expect(report.metrics.diagnostic_completeness).toBe(60); // (70 + 50) / 2
    // Legacy BC keys still present (pass-rate aggregate):
    expect(report.metrics.faithfulness).toBe(100);
    expect(report.metrics.latency_score).toBe(100);
    expect(report.metrics.trajectory_alignment_score).toBe(100);
  });
});
