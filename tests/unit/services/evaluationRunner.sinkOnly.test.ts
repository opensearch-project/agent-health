/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `executeEvaluationRun` persists ONLY through its `RunSink` and reads its
 * agents/models/judge/traces from the explicit dependencies it is given.
 *
 * Asserted behaviourally, not by scanning source: the runner receives a spy
 * sink plus a storage module that THROWS on any property access, and the
 * process-level fallbacks (config loader, custom-agent store, backend URL)
 * are stubbed to throw too. If a direct `storageModule.*` call — or a
 * `loadConfigSync()` / `getBackendUrl()` lookup — ever reappears in the
 * runner, this suite fails.
 */

import type { EvaluationRun, TestCase } from '@/types';
import type { RunSink } from '@/services/runSink';
import type { JudgeTransport } from '@/lib/judge/transport';
import type { TracesClient } from '@/services/traces/index';

const mockRunEvaluation = jest.fn();
jest.mock('@/services/evaluation', () => ({
  runEvaluationWithConnector: (...args: any[]) => mockRunEvaluation(...args),
  callBedrockJudge: jest.fn(),
  judgeErrorDetailFrom: jest.fn(),
  invokeAgent: jest.fn(),
  computeSdkMatcherSessionMetrics: jest.fn(),
  stampObjectiveActuals: jest.fn(),
  appendNotReachedMarker: jest.fn(),
}));
jest.mock('@/services/connectors/server', () => ({ connectorRegistry: {} }));
jest.mock('@/lib/debug', () => ({ debug: jest.fn() }));
jest.mock('@/services/traces/tracePoller', () => ({ tracePollingManager: { startPolling: jest.fn() } }));

// Process-level fallbacks must not be consulted when explicit deps are given.
jest.mock('@/lib/config/index', () => ({
  loadConfigSync: () => { throw new Error('runner consulted loadConfigSync()'); },
  loadConfig: () => { throw new Error('runner consulted loadConfig()'); },
}));
jest.mock('@/server/services/customAgentStore', () => ({
  getCustomAgents: () => { throw new Error('runner consulted getCustomAgents()'); },
}));
jest.mock('@/lib/portConfig', () => ({
  getBackendUrl: () => { throw new Error('runner consulted getBackendUrl()'); },
  resolveBackendPort: () => { throw new Error('runner consulted resolveBackendPort()'); },
  isBackendPortExplicit: () => true,
  DEFAULT_BACKEND_PORT: 4001,
}));

import { executeEvaluationRun } from '@/services/evaluationRunner';

/** A storage module that fails loudly on ANY access. */
function throwingStorage(): any {
  return new Proxy({}, {
    get(_t, prop) {
      throw new Error(`runner touched storageModule.${String(prop)} directly`);
    },
  });
}

function spySink(): RunSink & { calls: Array<{ method: string; args: any[] }> } {
  const calls: Array<{ method: string; args: any[] }> = [];
  const docs = new Map<string, any>();
  const record = (method: string) => (...args: any[]) => { calls.push({ method, args }); };
  return {
    calls,
    async createRun(run) { record('createRun')(run); return { runId: run.id, executorToken: 'tok' }; },
    async upsertCaseReport(input) {
      record('upsertCaseReport')(input);
      const existing = docs.get(input.reportId) ?? {};
      const { id: _ignored, ...fields } = input.report as any;
      const merged = { ...existing, ...fields, id: input.reportId };
      docs.set(input.reportId, merged);
      return { reportId: input.reportId, report: merged };
    },
    async patchCaseReport(runId, reportId, patch) { record('patchCaseReport')(runId, reportId, patch); },
    async setCaseResult(runId, testCaseId, result) { record('setCaseResult')(runId, testCaseId, result); return { generation: 0 }; },
    async heartbeat(runId, progress) { record('heartbeat')(runId, progress); return { generation: 0 }; },
    async finalize(runId, input) { record('finalize')(runId, input); return { id: runId } as any; },
  };
}

const judge: JudgeTransport = jest.fn(async () => { throw new Error('judge transport must not be called on this path'); });
const traces: TracesClient = { fetchTracesForRun: jest.fn(async () => { throw new Error('traces must not be called on this path'); }) };

const agents = [{ key: 'agent-a', name: 'Agent A', endpoint: 'http://agent.local', headers: {} }] as any;
const models = { 'model-a': { model_id: 'provider.model-a', display_name: 'Model A' } } as any;

function makeRun(): EvaluationRun {
  return {
    id: 'run-spy', docType: 'evaluation-run', name: 'spy', createdAt: '2026-01-01T00:00:00Z', status: 'running',
    agentKey: 'agent-a', modelId: 'model-a', sources: [], trigger: 'api',
    testCaseSnapshots: [{ id: 'tc-1', version: 1, name: 'one' }], results: {},
  } as EvaluationRun;
}
const testCase = { id: 'tc-1', name: 'one', initialPrompt: 'hello', expectedOutcomes: ['ok'], currentVersion: 1 } as unknown as TestCase;

describe('executeEvaluationRun writes only through the sink (behavioural spy, no source scan)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it('classic path: placeholder → final report → case result, all via the sink; storage never touched', async () => {
    mockRunEvaluation.mockResolvedValue({
      id: 'uuid-from-connector', testCaseId: 'tc-1', status: 'completed', passFailStatus: 'passed',
      trajectory: [{ type: 'response', content: 'hi' }], metrics: { accuracy: 100 }, llmJudgeReasoning: 'ok',
      judgeModel: 'provider.judge', judgeProvider: 'bedrock',
    });
    const sink = spySink();
    const onTestCaseComplete = jest.fn();

    const result = await executeEvaluationRun(makeRun(), [testCase], {
      sink, agents, models, judge, traces,
      storageModule: throwingStorage(),
      onProgress: jest.fn(),
      onTestCaseComplete,
    });

    expect(result.status).toBe('completed');
    expect(result.stats).toMatchObject({ passed: 1, failed: 0, total: 1 });

    const sequence = sink.calls.map(c => c.method);
    expect(sequence).toEqual(['upsertCaseReport', 'upsertCaseReport', 'setCaseResult']);

    const [placeholder, final] = sink.calls.filter(c => c.method === 'upsertCaseReport').map(c => c.args[0]);
    // Both writes target the SAME client-minted report id (idempotent key).
    expect(placeholder.reportId).toMatch(/^report-\d+-[a-z0-9]+$/);
    expect(final.reportId).toBe(placeholder.reportId);
    expect(placeholder).toMatchObject({ runId: 'run-spy', testCaseId: 'tc-1', attempt: 1, report: { status: 'running', metricsStatus: 'pending', agentKey: 'agent-a', modelId: 'model-a', modelName: 'Model A' } });
    expect(final.report).toMatchObject({ status: 'completed', passFailStatus: 'passed', experimentRunId: 'run-spy' });
    expect(final.report).not.toHaveProperty('id');

    const caseResult = sink.calls.find(c => c.method === 'setCaseResult')!.args;
    expect(caseResult).toEqual(['run-spy', 'tc-1', { reportId: placeholder.reportId, status: 'completed', passFailStatus: 'passed' }]);
    // The notification hook observes the same persisted result.
    expect(onTestCaseComplete).toHaveBeenCalledWith('tc-1', caseResult[2]);

    // Explicit deps were used: the connector call carried our judge transport.
    expect(mockRunEvaluation).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'agent-a' }), 'provider.model-a', expect.objectContaining({ id: 'tc-1' }), expect.any(Function),
      expect.objectContaining({ judge }),
    );
  });

  it('a crashed case patches its placeholder through the sink (never storage) and still records the failed result', async () => {
    mockRunEvaluation.mockRejectedValue(new Error('agent exploded'));
    const sink = spySink();

    const result = await executeEvaluationRun(makeRun(), [testCase], {
      sink, agents, models, judge, traces, storageModule: throwingStorage(), onProgress: jest.fn(),
    });

    expect(result.stats).toMatchObject({ failed: 1, total: 1 });
    expect(sink.calls.map(c => c.method)).toEqual(['upsertCaseReport', 'patchCaseReport', 'setCaseResult']);
    const patch = sink.calls[1].args;
    expect(patch[0]).toBe('run-spy');
    expect(patch[1]).toBe(sink.calls[0].args[0].reportId);
    expect(patch[2]).toMatchObject({ status: 'failed', metricsStatus: 'error', llmJudgeReasoning: 'Evaluation error: agent exploded' });
    expect(sink.calls[2].args[2]).toEqual({ reportId: patch[1], status: 'failed', error: 'agent exploded' });
  });

  it('a failed placeholder write falls back to creating the final report under the same minted id', async () => {
    mockRunEvaluation.mockResolvedValue({ id: 'x', testCaseId: 'tc-1', status: 'completed', passFailStatus: 'passed', trajectory: [], metrics: {}, llmJudgeReasoning: '' });
    const sink = spySink();
    const realUpsert = sink.upsertCaseReport.bind(sink);
    let first = true;
    sink.upsertCaseReport = async (input) => {
      if (first) { first = false; sink.calls.push({ method: 'upsertCaseReport(failed)', args: [input] }); throw new Error('storage hiccup'); }
      return realUpsert(input);
    };

    const result = await executeEvaluationRun(makeRun(), [testCase], {
      sink, agents, models, judge, traces, storageModule: throwingStorage(), onProgress: jest.fn(),
    });

    expect(result.stats).toMatchObject({ passed: 1 });
    const writes = sink.calls.filter(c => c.method.startsWith('upsertCaseReport'));
    expect(writes).toHaveLength(2);
    expect(writes[1].args[0].reportId).toBe(writes[0].args[0].reportId);
    expect(result.results['tc-1'].reportId).toBe(writes[0].args[0].reportId);
  });

  it('a sink failure on setCaseResult is bookkeeping: the verdict is kept and the run completes', async () => {
    mockRunEvaluation.mockResolvedValue({ id: 'x', testCaseId: 'tc-1', status: 'completed', passFailStatus: 'passed', trajectory: [], metrics: {}, llmJudgeReasoning: '' });
    const sink = spySink();
    sink.setCaseResult = async () => { throw new Error('version_conflict_engine_exception'); };

    const result = await executeEvaluationRun(makeRun(), [testCase], {
      sink, agents, models, judge, traces, storageModule: throwingStorage(), onProgress: jest.fn(),
    });
    expect(result.results['tc-1']).toMatchObject({ status: 'completed', passFailStatus: 'passed' });
    expect(result.stats).toMatchObject({ passed: 1, failed: 0 });
  });

  it('an explicit sink with a missing dependency fails fast instead of mixing in process defaults', async () => {
    const sink = spySink();
    await expect(executeEvaluationRun(makeRun(), [testCase], { sink, agents, models, traces, onProgress: jest.fn() } as any))
      .rejects.toThrow(/every runner dependency must be explicit — missing: judge/);
    expect(sink.calls).toEqual([]);
  });

  it('rejects when neither a sink nor the legacy storageModule is provided', async () => {
    await expect(executeEvaluationRun(makeRun(), [testCase], { agents, models, judge, traces, onProgress: jest.fn() } as any))
      .rejects.toThrow(/options\.sink is required/);
  });

  it('an unknown agentKey fails before any write', async () => {
    const sink = spySink();
    await expect(executeEvaluationRun({ ...makeRun(), agentKey: 'nope' }, [testCase], {
      sink, agents, models, judge, traces, storageModule: throwingStorage(), onProgress: jest.fn(),
    })).rejects.toThrow('Agent not found: nope');
    expect(sink.calls).toEqual([]);
  });
});
