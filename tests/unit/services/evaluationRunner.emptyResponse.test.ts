/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Empty-response failure — runner-level regression tests
 * (services/evaluation/emptyResponse.ts wired through invokeAgent /
 * runEvaluationWithConnector / executeEvaluationRun).
 *
 * Owner incident: an HTTP agent answered 200 with `{ answer: null, results:
 * [], steps: [] }` (its model call had failed silently); the agent's
 * afterResponse hook rendered a "no results" placeholder as the response step;
 * agent-health sent that to the judge, which PASSED it on a lenient rubric.
 *
 * These tests drive the REAL runner + REAL evaluation primitives against a
 * fake REST connector (judge mocked so we can assert it is NEVER called for an
 * empty result) and assert:
 *   - `200 {}` finalises the case as `agent_empty_response`, no judge call, no
 *     trace polling, bucketed errored, run carries the summary;
 *   - a hook `{ empty: true }` does the same even when the hook rendered text;
 *   - structured results with a null answer ARE judged;
 *   - three empties trip the breaker (default) / do not when
 *     `emptyResponseTripsBreaker: false`;
 *   - the SDK `agent.run()` path rejects and is stamped the same way.
 */
import { executeEvaluationRun } from '@/services/evaluationRunner';
import { tracePollingManager } from '@/services/traces/tracePoller';
import { callBedrockJudge } from '@/services/evaluation/bedrockJudge';
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

jest.mock('@/services/evaluation/bedrockJudge', () => ({
  callBedrockJudge: jest.fn(),
  simulateBedrockJudge: jest.fn(),
}));
const mockJudge = callBedrockJudge as jest.Mock;

/** afterResponse hook modelled on the owner's: renders a placeholder from the structured payload and flags emptiness. */
const renderingHook = {
  afterResponse: async (ctx: any) => {
    const d = ctx.rawEvents?.[0] ?? ctx.response;
    const results: any[] = Array.isArray(d?.results) ? d.results : [];
    const text = results.length === 0
      ? 'No results available (source=unknown).'
      : results.map((r: any) => `${r.id}: ${r.title}`).join('\n');
    const trajectory = [{ id: 'r', timestamp: Date.now(), type: 'response', content: text }];
    const stepCount = Array.isArray(d?.steps) ? d.steps.length : 0;
    const hasProse = typeof d?.answer === 'string' && d.answer.trim().length > 0;
    return { ...ctx, trajectory, empty: stepCount === 0 && results.length === 0 && !hasProse };
  },
};

const AGENTS = [
  { key: 'rest-agent', name: 'REST Agent', endpoint: 'http://agent.internal:9000/run', connectorType: 'rest', useTraces: false },
  { key: 'traced-agent', name: 'Traced Agent', endpoint: 'http://agent.internal:9000/run', connectorType: 'rest', useTraces: true },
  { key: 'no-trip-agent', name: 'No Trip', endpoint: 'http://agent.internal:9000/run', connectorType: 'rest', useTraces: false, connectorConfig: { emptyResponseTripsBreaker: false } },
  { key: 'hook-agent', name: 'Hook Agent', endpoint: 'http://agent.internal:9000/run', connectorType: 'rest', useTraces: false, hooks: renderingHook },
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

/** What the REAL RESTConnector produces for a `200 <body>` (parseResponse fallback = JSON echo). */
function restResult(body: any) {
  const trajectory = body && typeof body === 'object' && typeof body.answer === 'string' && body.answer
    ? [{ id: 'r', timestamp: Date.now(), type: 'response', content: body.answer }]
    : [{ id: 'r', timestamp: Date.now(), type: 'response', content: JSON.stringify(body, null, 2) }];
  return { trajectory, runId: body?.runId ?? null, rawEvents: [body], metadata: { status: 200 } };
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
const finalReports = (storage: IStorageModule): any[] => [...(storage as any).__docs.values()];

function makeRun(agentKey: string): EvaluationRun {
  return {
    id: 'run-empty', name: 'Run', agentKey, modelId: 'claude-sonnet', judgeModelId: 'demo-model', status: 'running', results: {}, concurrency: 1,
    createdAt: new Date().toISOString(),
  } as unknown as EvaluationRun;
}
function makeCases(n: number): TestCase[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `tc-${i + 1}`, name: `TC ${i + 1}`, initialPrompt: `search products ${i + 1}`, context: [], expectedOutcomes: ['Any reply at all.'],
  })) as unknown as TestCase[];
}
const noop = () => {};
const PASS = { passFailStatus: 'passed', metrics: { accuracy: 100 }, llmJudgeReasoning: 'ok', improvementStrategies: [], judgeDurationMs: 1, judgeAttempts: 1 };

describe('executeEvaluationRun — empty agent responses are agent failures, never judged', () => {
  let storage: IStorageModule;
  beforeEach(() => {
    jest.clearAllMocks();
    storage = createMockStorage();
    mockJudge.mockResolvedValue(PASS);
  });

  it('`200 {}` on every case: agent_empty_response reports, judge NEVER called, no polling, run errored, summary set', async () => {
    mockExecute.mockImplementation(() => Promise.resolve(restResult({})));
    const result = await executeEvaluationRun(makeRun('rest-agent'), makeCases(2), { storageModule: storage, onProgress: noop });

    expect(mockJudge).not.toHaveBeenCalled();
    expect(mockStartPolling).not.toHaveBeenCalled();
    const reports = finalReports(storage);
    expect(reports).toHaveLength(2);
    for (const r of reports) {
      expect(r.status).toBe('failed');
      expect(r.metricsStatus).toBe('error');
      expect(r.passFailStatus).toBeNull();
      expect(r.skipJudge).toBe(true);
      expect(r.agentError).toEqual({ stage: 'agent', kind: 'empty-response', code: 'EMPTY_RESPONSE', message: expect.stringContaining('EMPTY_RESPONSE — agent returned an empty response (no steps, no answer, no results) from agent endpoint agent.internal:9000') });
      expect(r.traceError).toMatch(/^Agent returned an empty response \(kind=agent_empty_response\): EMPTY_RESPONSE — /);
      expect(r.llmJudgeReasoning).toContain('**Agent returned an empty response.**');
      // What the agent returned stays visible on the report.
      expect(r.trajectory).toEqual([expect.objectContaining({ type: 'response', content: '{}' })]);
      expect(r.rawEvents).toEqual([{}]);
      expect(r.traceError).not.toContain('/run');
    }
    expect(result.stats).toMatchObject({ errored: 2, passed: 0, failed: 0, pending: 0, total: 2 });
    expect(Object.values(result.results).every(r => r.reportId && r.status === 'completed' && !r.passFailStatus)).toBe(true);
    expect(result.agentFailureSummary).toBe('2 cases returned an empty response (no steps, no answer, no results) — not judged');
  });

  it('the owner incident: a hook renders a placeholder and flags `empty: true` → not judged (pre-fix: PASSED)', async () => {
    mockExecute.mockImplementation(() => Promise.resolve(restResult({ answer: null, results: [], ids: [], source: null, session_id: 'sess-1', steps: [] })));
    const result = await executeEvaluationRun(makeRun('hook-agent'), makeCases(1), { storageModule: storage, onProgress: noop });

    expect(mockJudge).not.toHaveBeenCalled();
    const [r] = finalReports(storage);
    expect(r.agentError.kind).toBe('empty-response');
    expect(r.agentError.message).toContain('the connector hook flagged the response as empty');
    expect(r.trajectory[0].content).toBe('No results available (source=unknown).');
    expect(result.stats?.errored).toBe(1);
    expect(result.stats?.passed).toBe(0);
  });

  it('the same hook with real results is judged normally (results ARE the answer for a retrieval agent)', async () => {
    mockExecute.mockImplementation(() => Promise.resolve(restResult({ answer: null, results: [{ id: 'p1', title: 'Trail shoe' }], steps: [{ tool: 'search' }] })));
    const result = await executeEvaluationRun(makeRun('hook-agent'), makeCases(1), { storageModule: storage, onProgress: noop });
    expect(mockJudge).toHaveBeenCalledTimes(1);
    expect(mockJudge.mock.calls[0][0]).toEqual([expect.objectContaining({ content: 'p1: Trail shoe' })]);
    expect(result.stats?.passed).toBe(1);
    expect(result.agentFailureSummary).toBeUndefined();
  });

  it('structured results with a null answer through the plain REST connector are judged (not empty)', async () => {
    mockExecute.mockImplementation(() => Promise.resolve(restResult({ answer: null, results: [{ id: 'p1', title: 'Trail shoe' }] })));
    const result = await executeEvaluationRun(makeRun('rest-agent'), makeCases(1), { storageModule: storage, onProgress: noop });
    expect(mockJudge).toHaveBeenCalledTimes(1);
    expect(result.stats?.passed).toBe(1);
    expect(finalReports(storage)[0].agentError).toBeUndefined();
  });

  it('a real answer is judged; the judge sees the answer text', async () => {
    mockExecute.mockImplementation(() => Promise.resolve(restResult({ answer: 'Here are the products I found.' })));
    await executeEvaluationRun(makeRun('rest-agent'), makeCases(1), { storageModule: storage, onProgress: noop });
    expect(mockJudge).toHaveBeenCalledTimes(1);
    expect(mockJudge.mock.calls[0][0]).toEqual([expect.objectContaining({ content: 'Here are the products I found.' })]);
  });

  it('useTraces agent returning `200 {}`: final immediately — never enters trace polling', async () => {
    mockExecute.mockImplementation(() => Promise.resolve(restResult({})));
    const result = await executeEvaluationRun(makeRun('traced-agent'), makeCases(1), { storageModule: storage, onProgress: noop });
    expect(mockStartPolling).not.toHaveBeenCalled();
    expect(mockJudge).not.toHaveBeenCalled();
    const [r] = finalReports(storage);
    expect(r.metricsStatus).toBe('error');
    expect(r.traceFetchAttempts).toBeUndefined();
    expect(r.agentError.kind).toBe('empty-response');
    expect(result.stats?.errored).toBe(1);
  });

  it('three consecutive empties trip the breaker (default): cases 4–5 are refused without dialling; summary says "empty responses"', async () => {
    mockExecute.mockImplementation(() => Promise.resolve(restResult({})));
    const result = await executeEvaluationRun(makeRun('rest-agent'), makeCases(5), { storageModule: storage, onProgress: noop });
    expect(mockExecute).toHaveBeenCalledTimes(3);
    expect(mockJudge).not.toHaveBeenCalled();
    expect(result.agentFailureSummary).toBe(
      'Agent endpoint unreachable — 3 consecutive empty responses (EMPTY_RESPONSE, agent.internal:9000); 2 further cases were not attempted',
    );
    const reports = finalReports(storage);
    expect(reports.filter(r => r.agentError?.kind === 'empty-response')).toHaveLength(3);
    const refused = reports.filter(r => r.agentError?.kind === 'unreachable');
    expect(refused).toHaveLength(2);
    expect(refused[0].traceError).toContain('3 consecutive empty responses (EMPTY_RESPONSE, agent.internal:9000); this case was not attempted');
    expect(result.stats).toMatchObject({ errored: 5, passed: 0, failed: 0 });
  });

  it('connectorConfig.emptyResponseTripsBreaker: false — every case dials, every case is an empty-response failure, no circuit opens', async () => {
    mockExecute.mockImplementation(() => Promise.resolve(restResult({})));
    const result = await executeEvaluationRun(makeRun('no-trip-agent'), makeCases(5), { storageModule: storage, onProgress: noop });
    expect(mockExecute).toHaveBeenCalledTimes(5);
    expect(mockJudge).not.toHaveBeenCalled();
    expect(finalReports(storage).every(r => r.agentError?.kind === 'empty-response')).toBe(true);
    expect(result.agentFailureSummary).toBe('5 cases returned an empty response (no steps, no answer, no results) — not judged');
  });

  it('AGENT_EMPTY_RESPONSE_TRIPS_BREAKER=0 disables counting for agents without a per-agent setting', async () => {
    const prev = process.env.AGENT_EMPTY_RESPONSE_TRIPS_BREAKER;
    process.env.AGENT_EMPTY_RESPONSE_TRIPS_BREAKER = '0';
    try {
      mockExecute.mockImplementation(() => Promise.resolve(restResult({})));
      const result = await executeEvaluationRun(makeRun('rest-agent'), makeCases(4), { storageModule: storage, onProgress: noop });
      expect(mockExecute).toHaveBeenCalledTimes(4);
      expect(result.agentFailureSummary).toBe('4 cases returned an empty response (no steps, no answer, no results) — not judged');
    } finally {
      if (prev === undefined) delete process.env.AGENT_EMPTY_RESPONSE_TRIPS_BREAKER; else process.env.AGENT_EMPTY_RESPONSE_TRIPS_BREAKER = prev;
    }
  });

  it('a real answer between empties resets the streak: empty, empty, ok, empty, empty → no circuit, 2 judged', async () => {
    const script = ['empty', 'empty', 'ok', 'empty', 'empty', 'ok'];
    let i = 0;
    mockExecute.mockImplementation(() => Promise.resolve(script[i++] === 'ok' ? restResult({ answer: 'fine' }) : restResult({})));
    const result = await executeEvaluationRun(makeRun('rest-agent'), makeCases(script.length), { storageModule: storage, onProgress: noop });
    expect(mockExecute).toHaveBeenCalledTimes(script.length);
    expect(mockJudge).toHaveBeenCalledTimes(2);
    expect(result.stats).toMatchObject({ errored: 4, passed: 2 });
    expect(result.agentFailureSummary).toBe('4 cases returned an empty response (no steps, no answer, no results) — not judged');
  });

  it('a hook that THROWS resets the breaker streak (the endpoint answered): empty, empty, hook-error, empty, empty → no circuit', async () => {
    let calls = 0;
    const throwingAgent = { key: 'throwing-hook-agent', name: 'Throwing Hook', endpoint: 'http://agent.internal:9000/run', connectorType: 'rest', useTraces: false,
      hooks: { afterResponse: async (ctx: any) => { if (++calls === 3) throw new Error('hook bug'); return ctx; } } };
    AGENTS.push(throwingAgent as any);
    try {
      mockExecute.mockImplementation(() => Promise.resolve(restResult({})));
      const result = await executeEvaluationRun(makeRun('throwing-hook-agent'), makeCases(5), { storageModule: storage, onProgress: noop });
      expect(mockExecute).toHaveBeenCalledTimes(5);
      expect(result.agentFailureSummary).toBe('4 cases returned an empty response (no steps, no answer, no results) — not judged');
      const reports = finalReports(storage);
      expect(reports.filter(r => r.agentError?.kind === 'empty-response')).toHaveLength(4);
      // The hook-error case is a plain agent_failed (no structured classification), not an empty response.
      const hookFailed = reports.find(r => /hook bug/.test(r.traceError ?? ''));
      expect(hookFailed?.agentError).toBeUndefined();
      expect(hookFailed?.traceError).toMatch(/kind=agent_failed/);
    } finally {
      AGENTS.pop();
    }
  });

  it('SDK path: agent.run() rejects with the empty-response error; the report is stamped agent_empty_response and keeps the payload', async () => {
    mockExecute.mockImplementation(() => Promise.resolve(restResult({})));
    const cases = makeCases(2);
    const evaluateFnMap = new Map<string, EvaluateFn>();
    const seen: string[] = [];
    for (const tc of cases) {
      evaluateFnMap.set(tc.id, (async ({ agent }: any) => {
        try { await agent.run(tc.initialPrompt); } catch (e: any) { seen.push(e.name); throw e; }
      }) as EvaluateFn);
    }
    const result = await executeEvaluationRun(makeRun('rest-agent'), cases, { storageModule: storage, onProgress: noop, evaluateFnMap });
    expect(seen).toEqual(['AgentEmptyResponseError', 'AgentEmptyResponseError']);
    for (const r of finalReports(storage)) {
      expect(r.metricsStatus).toBe('error');
      expect(r.agentError.kind).toBe('empty-response');
      expect(r.traceError).toMatch(/kind=agent_empty_response/);
      expect(r.trajectory).toEqual([expect.objectContaining({ content: '{}' })]);
      expect(r.rawEvents).toEqual([{}]);
    }
    expect(result.stats).toMatchObject({ errored: 2, passed: 0, failed: 0 });
    expect(result.agentFailureSummary).toBe('2 cases returned an empty response (no steps, no answer, no results) — not judged');
  });
});
