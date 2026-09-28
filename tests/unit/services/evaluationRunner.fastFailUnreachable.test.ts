/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Fast-fail for unreachable agent endpoints — runner-level regression tests
 * (services/evaluation/agentReachability.ts wired through invokeAgent /
 * runEvaluationWithConnector / executeEvaluationRun).
 *
 * Owner incident: a run against a DOWN endpoint spent the full trace-polling
 * budget on every case (minutes each) before erroring it as a trace timeout.
 * These tests drive the REAL runner + REAL evaluation primitives against a
 * fake connector and assert:
 *   - a transport failure finalises the case immediately as `agent_failed`
 *     with the failure class + host, and trace polling is never started;
 *   - after N consecutive transport failures the breaker refuses the rest of
 *     the run without calling the connector;
 *   - a success resets the count; non-transport errors neither count nor
 *     reset; `connectorConfig.unreachableThreshold` is honoured;
 *   - the run carries `agentFailureSummary`.
 */
import { executeEvaluationRun } from '@/services/evaluationRunner';
import { tracePollingManager } from '@/services/traces/tracePoller';
import type { EvaluationRun, TestCase } from '@/types';
import type { IStorageModule } from '@/server/adapters/types';
import type { EvaluateFn } from '@/services/sourceResolver';

const mockExecute = jest.fn();

jest.mock('@/services/connectors/server', () => ({
  connectorRegistry: {
    getForAgent: jest.fn(() => ({
      type: 'rest',
      name: 'Fake REST',
      supportsStreaming: false,
      buildPayload: () => ({}),
      execute: (...args: any[]) => mockExecute(...args),
    })),
  },
}));

const AGENTS = [
  { key: 'dead-agent', name: 'Dead Agent', endpoint: 'http://agent.internal:9000/run', connectorType: 'rest', useTraces: true },
  { key: 'dead-agent-threshold-2', name: 'Dead Agent (t=2)', endpoint: 'http://agent.internal:9000/run', connectorType: 'rest', useTraces: true, connectorConfig: { unreachableThreshold: 2 } },
  { key: 'plain-agent', name: 'Plain Agent', endpoint: 'http://agent.internal:9000/run', connectorType: 'rest', useTraces: false },
];

jest.mock('@/lib/config/index', () => ({
  loadConfigSync: jest.fn(() => ({
    agents: AGENTS,
    models: { 'claude-sonnet': { model_id: 'anthropic.claude-sonnet-4' } },
  })),
}));

jest.mock('@/lib/constants', () => ({
  DEFAULT_CONFIG: { agents: [], models: { 'claude-sonnet': { model_id: 'anthropic.claude-sonnet-4' } } },
}));

jest.mock('@/server/services/customAgentStore', () => ({ getCustomAgents: jest.fn(() => []) }));
jest.mock('@/lib/debug', () => ({ debug: jest.fn() }));
jest.mock('@/services/traces/tracePoller', () => ({ tracePollingManager: { startPolling: jest.fn() } }));
jest.mock('@/services/traces/index', () => ({ fetchTracesForRun: jest.fn() }));

const mockStartPolling = tracePollingManager.startPolling as jest.Mock;

/** What Node's fetch throws for a closed port. */
function connectionRefused(): TypeError {
  const e = new TypeError('fetch failed');
  const cause = new Error('connect ECONNREFUSED 10.0.0.5:9000') as Error & { code: string };
  cause.code = 'ECONNREFUSED';
  (e as any).cause = cause;
  return e;
}

function createMockStorage(): IStorageModule {
  const docs = new Map<string, any>();
  const create = jest.fn().mockImplementation((report: any) => {
    const id = report.id ?? `report-${docs.size + 1}`;
    const doc = { ...report, id };
    docs.set(id, doc);
    return Promise.resolve(doc);
  });
  const update = jest.fn().mockImplementation((id: string, updates: any) => {
    const merged = { ...(docs.get(id) || { id }), ...updates, id };
    docs.set(id, merged);
    return Promise.resolve(merged);
  });
  return {
    runs: { create, update, getById: jest.fn((id: string) => Promise.resolve(docs.get(id))) },
    evaluationRuns: { updateResult: jest.fn() },
    health: jest.fn().mockResolvedValue({ status: 'green' }),
    isConfigured: jest.fn().mockReturnValue(true),
    __docs: docs,
  } as unknown as IStorageModule;
}

function finalReports(storage: IStorageModule): any[] {
  return [...(storage as any).__docs.values()];
}

function makeRun(agentKey: string, concurrency = 1): EvaluationRun {
  return {
    id: 'run-ff', name: 'Run', agentKey, modelId: 'claude-sonnet', status: 'running', results: {}, concurrency,
    createdAt: new Date().toISOString(),
  } as unknown as EvaluationRun;
}

function makeCases(n: number): TestCase[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `tc-${i + 1}`, name: `TC ${i + 1}`, initialPrompt: `search products ${i + 1}`, context: [], expectedOutcomes: ['ok'],
  })) as unknown as TestCase[];
}

const noop = () => {};

describe('executeEvaluationRun — fast-fail for unreachable agent endpoints', () => {
  let storage: IStorageModule;

  beforeEach(() => {
    jest.clearAllMocks();
    storage = createMockStorage();
  });

  it('dead endpoint (useTraces agent): 3 connector calls, breaker refuses the rest, NO trace polling, run carries the summary', async () => {
    mockExecute.mockImplementation(() => Promise.reject(connectionRefused()));
    const run = makeRun('dead-agent');
    const started = Date.now();

    const result = await executeEvaluationRun(run, makeCases(5), { storageModule: storage, onProgress: noop });

    // Pre-fix each of the 5 cases went into trace polling for the full budget.
    expect(mockStartPolling).not.toHaveBeenCalled();
    expect(Date.now() - started).toBeLessThan(5_000);
    // Only the first 3 cases dialled the endpoint; the breaker refused 4 and 5.
    expect(mockExecute).toHaveBeenCalledTimes(3);

    const reports = finalReports(storage);
    expect(reports).toHaveLength(5);
    for (const r of reports) {
      expect(r.status).toBe('failed');
      expect(r.metricsStatus).toBe('error');
      expect(r.passFailStatus).toBeNull();
      expect(r.skipJudge).toBe(true);
      expect(r.traceError).toMatch(/^Agent run did not complete \(kind=agent_failed\)/);
      expect(r.traceFetchAttempts).toBeUndefined();
    }
    const dialled = reports.filter(r => /ECONNREFUSED — connection refused while calling agent endpoint agent.internal:9000/.test(r.traceError));
    const refused = reports.filter(r => /agent endpoint unreachable — 3 consecutive connection failures \(ECONNREFUSED, agent.internal:9000\); this case was not attempted/.test(r.traceError));
    expect(dialled).toHaveLength(3);
    expect(refused).toHaveLength(2);
    // Host only — the endpoint path never lands on a report.
    for (const r of reports) expect(r.traceError).not.toContain('/run');

    expect(result.agentFailureSummary).toBe(
      'Agent endpoint unreachable — 3 consecutive connection failures (ECONNREFUSED, agent.internal:9000); 2 further cases were not attempted',
    );
    expect(result.stats).toMatchObject({ errored: 5, passed: 0, failed: 0, total: 5 });
    // Every case has a per-case result entry with the report id (nothing "not run").
    expect(Object.values(result.results).every(r => r.reportId && r.status === 'completed')).toBe(true);
  });

  it('honours connectorConfig.unreachableThreshold (2): only two connector calls', async () => {
    mockExecute.mockImplementation(() => Promise.reject(connectionRefused()));
    const result = await executeEvaluationRun(makeRun('dead-agent-threshold-2'), makeCases(4), { storageModule: storage, onProgress: noop });
    expect(mockExecute).toHaveBeenCalledTimes(2);
    expect(mockStartPolling).not.toHaveBeenCalled();
    expect(result.agentFailureSummary).toContain('2 consecutive connection failures');
    expect(result.agentFailureSummary).toContain('2 further cases were not attempted');
  });

  it('non-transport errors (agent timeout) do not trip the breaker: every case still dials, none is polled', async () => {
    mockExecute.mockImplementation(() => Promise.reject(new Error('Subprocess timed out after 600000ms')));
    const result = await executeEvaluationRun(makeRun('dead-agent'), makeCases(4), { storageModule: storage, onProgress: noop });
    expect(mockExecute).toHaveBeenCalledTimes(4);
    expect(mockStartPolling).not.toHaveBeenCalled();
    expect(result.agentFailureSummary).toBeUndefined();
    for (const r of finalReports(storage)) {
      expect(r.metricsStatus).toBe('error');
      expect(r.traceError).toContain('(kind=agent_failed): Subprocess timed out after 600000ms');
    }
  });

  it('a connection reset AFTER the agent started answering is a mid-stream failure of that case — not counted, not relabelled', async () => {
    mockExecute.mockImplementation((_endpoint: string, _req: any, _auth: any, onStep?: (s: any) => void) => {
      onStep?.({ type: 'assistant', content: 'partial…' });
      const e = new Error('read ECONNRESET') as Error & { code: string };
      e.code = 'ECONNRESET';
      return Promise.reject(e);
    });
    const result = await executeEvaluationRun(makeRun('dead-agent'), makeCases(4), { storageModule: storage, onProgress: noop });
    expect(mockExecute).toHaveBeenCalledTimes(4);
    expect(mockStartPolling).not.toHaveBeenCalled();
    expect(result.agentFailureSummary).toBeUndefined();
    for (const r of finalReports(storage)) {
      expect(r.metricsStatus).toBe('error');
      expect(r.traceError).toContain('(kind=agent_failed): read ECONNRESET');
      expect(r.traceError).not.toContain('while calling agent endpoint');
    }
  });

  it('a prompt-specific 500 from an agent that is UP fast-fails the case with HTTP_500 but never opens the breaker', async () => {
    mockExecute.mockImplementation(() => Promise.reject(new Error('REST request failed: 500 - internal error')));
    const result = await executeEvaluationRun(makeRun('dead-agent'), makeCases(5), { storageModule: storage, onProgress: noop });
    expect(mockExecute).toHaveBeenCalledTimes(5);
    expect(mockStartPolling).not.toHaveBeenCalled();
    expect(result.agentFailureSummary).toBeUndefined();
    for (const r of finalReports(storage)) {
      expect(r.traceError).toContain('HTTP_500 — endpoint rejected the request with HTTP 500 while calling agent endpoint agent.internal:9000');
    }
  });

  it('gateway 503s DO open the breaker (the endpoint itself is down behind a proxy)', async () => {
    mockExecute.mockImplementation(() => Promise.reject(new Error('REST request failed: 503 - Service Unavailable')));
    const result = await executeEvaluationRun(makeRun('dead-agent'), makeCases(5), { storageModule: storage, onProgress: noop });
    expect(mockExecute).toHaveBeenCalledTimes(3);
    expect(result.agentFailureSummary).toContain('(HTTP_503, agent.internal:9000); 2 further cases were not attempted');
  });

  it('a success resets the consecutive count (SDK path, agent.run() rejects then answers)', async () => {
    // fail, fail, ok, fail, fail, ok, fail, fail → never 3 in a row → no open circuit.
    const script = ['fail', 'fail', 'ok', 'fail', 'fail', 'ok', 'fail', 'fail'];
    let i = 0;
    mockExecute.mockImplementation(() => {
      const step = script[i++];
      return step === 'ok'
        ? Promise.resolve({ trajectory: [{ type: 'response', content: 'answer' }], runId: null, rawEvents: [] })
        : Promise.reject(connectionRefused());
    });
    const cases = makeCases(script.length);
    const evaluateFnMap = new Map<string, EvaluateFn>();
    for (const tc of cases) evaluateFnMap.set(tc.id, (async ({ agent }: any) => { await agent.run(tc.initialPrompt); }) as EvaluateFn);

    const result = await executeEvaluationRun(makeRun('plain-agent'), cases, { storageModule: storage, onProgress: noop, evaluateFnMap });

    expect(mockExecute).toHaveBeenCalledTimes(script.length);
    expect(result.agentFailureSummary).toBeUndefined();
    const reports = finalReports(storage);
    const agentFailed = reports.filter(r => /kind=agent_failed/.test(r.traceError ?? ''));
    expect(agentFailed).toHaveLength(6);
    // SDK-path agent failures carry the same classified message.
    expect(agentFailed[0].traceError).toContain('ECONNREFUSED — connection refused while calling agent endpoint agent.internal:9000');
    expect(reports.filter(r => r.passFailStatus === 'passed')).toHaveLength(2);
  });

  it('SDK path: the breaker refuses agent.run() once open, without calling the connector', async () => {
    mockExecute.mockImplementation(() => Promise.reject(connectionRefused()));
    const cases = makeCases(5);
    const evaluateFnMap = new Map<string, EvaluateFn>();
    for (const tc of cases) evaluateFnMap.set(tc.id, (async ({ agent }: any) => { await agent.run(tc.initialPrompt); }) as EvaluateFn);

    const result = await executeEvaluationRun(makeRun('plain-agent'), cases, { storageModule: storage, onProgress: noop, evaluateFnMap });

    expect(mockExecute).toHaveBeenCalledTimes(3);
    expect(result.agentFailureSummary).toContain('2 further cases were not attempted');
    const refused = finalReports(storage).filter(r => /this case was not attempted/.test(r.traceError ?? ''));
    expect(refused).toHaveLength(2);
    for (const r of refused) expect(r.metricsStatus).toBe('error');
  });

  it('an endpoint that answers (even badly) is never counted: no summary, connector called for every case', async () => {
    mockExecute.mockImplementation(() => Promise.resolve({ trajectory: [{ type: 'response', content: 'garbage' }], runId: null, rawEvents: [] }));
    const cases = makeCases(3);
    const evaluateFnMap = new Map<string, EvaluateFn>();
    for (const tc of cases) evaluateFnMap.set(tc.id, (async ({ agent }: any) => { await agent.run(tc.initialPrompt); throw new Error('bad answer'); }) as EvaluateFn);
    const result = await executeEvaluationRun(makeRun('plain-agent'), cases, { storageModule: storage, onProgress: noop, evaluateFnMap });
    expect(mockExecute).toHaveBeenCalledTimes(3);
    expect(result.agentFailureSummary).toBeUndefined();
    expect(result.stats?.failed).toBe(3);
  });
});
