/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression tests for the run-status-integrity fix (2026-09-04).
 *
 * Live symptom (S2): a concurrency=3 run ended `failed` at 37/62 with five
 * per-case results reading "Evaluation error: version_conflict_engine_exception
 * … [eval-run-…]". The conflict came from the per-case bookkeeping write
 * (`onTestCaseComplete` → `evaluationRuns.updateResult`), which the runner
 * awaited INSIDE the evaluation try/catch — so a storage race was misfiled
 * as an agent/evaluator failure: the already-judged report was rewritten to
 * `metricsStatus: 'error'`, the in-memory result flipped to `failed`, and when
 * the retry inside the catch conflicted again the whole run went `failed`.
 *
 * Also pins the cancellation contract (R3): never-started planned cases get
 * explicit `{ reportId: '', status: 'cancelled' }` markers and terminal-aware
 * stats (`notRun`, never phantom `pending`).
 */

import { executeEvaluationRun, createCancellationToken } from '@/services/evaluationRunner';
import type { EvaluationRun, TestCase } from '@/types';
import type { IStorageModule } from '@/server/adapters/types';

jest.mock('@/services/evaluation', () => ({
  ...jest.requireActual('@/services/evaluation'),
  runEvaluationWithConnector: jest.fn(),
  invokeAgent: jest.fn(),
  callBedrockJudge: jest.fn(),
}));
jest.mock('@/services/connectors/server', () => ({ connectorRegistry: { getForAgent: jest.fn() } }));
jest.mock('@/lib/config/index', () => ({
  loadConfigSync: jest.fn(() => ({
    agents: [{ key: 'test-agent', name: 'Test Agent', endpoint: 'http://localhost:3000', connectorType: 'agui-streaming' }],
    models: { 'claude-sonnet': { model_id: 'anthropic.claude-sonnet-4', display_name: 'Claude Sonnet' } },
  })),
}));
jest.mock('@/lib/constants', () => ({
  DEFAULT_CONFIG: {
    agents: [{ key: 'test-agent', name: 'Test Agent', endpoint: 'http://localhost:3000', connectorType: 'agui-streaming' }],
    models: { 'claude-sonnet': { model_id: 'anthropic.claude-sonnet-4' } },
  },
}));
jest.mock('@/server/services/customAgentStore', () => ({ getCustomAgents: jest.fn(() => []) }));
jest.mock('@/lib/debug', () => ({ debug: jest.fn() }));
jest.mock('@/services/traces/tracePoller', () => ({ tracePollingManager: { startPolling: jest.fn() } }));
jest.mock('@/lib/telemetry', () => ({
  startTestCaseSpan: jest.fn(() => null),
  finalizeTestCaseSpan: jest.fn(),
  addEvaluationResultEvents: jest.fn(),
}));

import { runEvaluationWithConnector } from '@/services/evaluation';
const mockRunEval = runEvaluationWithConnector as jest.Mock;

function createMockStorage(): IStorageModule {
  return {
    runs: { create: jest.fn(), update: jest.fn(), getById: jest.fn() },
    evaluationRuns: { create: jest.fn(), getById: jest.fn(), update: jest.fn(), delete: jest.fn(), list: jest.fn(), updateResult: jest.fn(), mergeMissingResults: jest.fn() },
    health: jest.fn().mockResolvedValue({ status: 'green' }),
    isConfigured: jest.fn().mockReturnValue(true),
  } as unknown as IStorageModule;
}

function tc(id: string): TestCase {
  return { id, name: id, initialPrompt: `prompt ${id}`, context: [] } as unknown as TestCase;
}

function makeRun(overrides: Partial<EvaluationRun> = {}): EvaluationRun {
  return {
    id: 'run-1', name: 'Run', agentKey: 'test-agent', modelId: 'claude-sonnet',
    status: 'running', results: {}, createdAt: new Date().toISOString(),
    ...overrides,
  } as unknown as EvaluationRun;
}

function versionConflict() {
  const err: any = new Error('version_conflict_engine_exception: [version_conflict_engine_exception] Reason: [run-1]: version conflict');
  err.meta = { statusCode: 409 };
  return err;
}

describe('executeEvaluationRun — per-case persistence is bookkeeping, not evaluation', () => {
  let storage: IStorageModule;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    storage = createMockStorage();
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    (storage.runs.create as jest.Mock).mockImplementation(async (r: any) => ({ ...r, id: `placeholder-${r.testCaseId}` }));
    (storage.runs.update as jest.Mock).mockImplementation(async (id: string, fields: any) => ({ ...fields, id }));
    mockRunEval.mockImplementation(async (_agent: any, _model: any, testCase: TestCase) => ({
      id: `report-${testCase.id}`, testCaseId: testCase.id,
      trajectory: [{ type: 'response', content: 'ok' }], rawEvents: [],
      status: 'completed', passFailStatus: 'passed', metricsStatus: 'completed',
      performanceMetrics: { durationMs: 5 },
    }));
  });
  afterEach(() => warn.mockRestore());

  it('a version_conflict thrown by onTestCaseComplete does NOT flip the verdict to failed, does NOT rewrite the report as an evaluator error, and does NOT fail the run', async () => {
    const onTestCaseComplete = jest.fn()
      .mockRejectedValueOnce(versionConflict())   // tc-1's bookkeeping write races and loses
      .mockResolvedValue(undefined);

    const run = makeRun();
    const completed = await executeEvaluationRun(run, [tc('tc-1'), tc('tc-2'), tc('tc-3')], {
      storageModule: storage, onProgress: jest.fn(), onTestCaseComplete, concurrency: 3,
    } as any);

    expect(completed.status).toBe('completed');
    // Every verdict survives — nothing is "failed" because of a storage race.
    expect(Object.values(completed.results).map(r => r.status)).toEqual(['completed', 'completed', 'completed']);
    expect(Object.values(completed.results).every(r => r.passFailStatus === 'passed')).toBe(true);
    expect(completed.stats).toEqual({ passed: 3, failed: 0, errored: 0, pending: 0, notRun: 0, total: 3 });

    // The report was never rewritten with an "Evaluation error: version_conflict…" patch.
    const errorPatches = (storage.runs.update as jest.Mock).mock.calls
      .filter(([, fields]) => typeof fields?.llmJudgeReasoning === 'string' && fields.llmJudgeReasoning.includes('version_conflict'));
    expect(errorPatches).toHaveLength(0);
    const errorStatusPatches = (storage.runs.update as jest.Mock).mock.calls.filter(([, f]) => f?.metricsStatus === 'error');
    expect(errorStatusPatches).toHaveLength(0);

    // Persistence was attempted once per case (no double-write from a catch block).
    expect(onTestCaseComplete).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Failed to persist result'));
  });

  it('a genuine agent failure still lands as failed (persistence isolation does not swallow real errors)', async () => {
    mockRunEval.mockRejectedValueOnce(new Error('agent exploded'));
    const onTestCaseComplete = jest.fn().mockResolvedValue(undefined);
    const completed = await executeEvaluationRun(makeRun(), [tc('tc-1')], {
      storageModule: storage, onProgress: jest.fn(), onTestCaseComplete,
    } as any);
    expect(completed.results['tc-1'].status).toBe('failed');
    expect(completed.results['tc-1'].error).toContain('agent exploded');
    expect(onTestCaseComplete).toHaveBeenCalledWith('tc-1', expect.objectContaining({ status: 'failed' }));
    expect(completed.stats).toEqual({ passed: 0, failed: 1, errored: 0, pending: 0, notRun: 0, total: 1 });
  });
});

describe('executeEvaluationRun — cancellation stamps never-started cases as `cancelled` (notRun, never pending)', () => {
  let storage: IStorageModule;
  beforeEach(() => {
    jest.clearAllMocks();
    storage = createMockStorage();
    (storage.runs.create as jest.Mock).mockImplementation(async (r: any) => ({ ...r, id: `placeholder-${r.testCaseId}` }));
    (storage.runs.update as jest.Mock).mockImplementation(async (id: string, fields: any) => ({ ...fields, id }));
  });

  it('cancel after the first case: remaining planned cases get explicit cancelled markers and stats.notRun counts them', async () => {
    const token = createCancellationToken();
    mockRunEval.mockImplementation(async (_a: any, _m: any, testCase: TestCase) => {
      token.cancel(); // cancel while the first case is in flight
      return {
        id: `report-${testCase.id}`, testCaseId: testCase.id, trajectory: [], rawEvents: [],
        status: 'completed', passFailStatus: 'failed', metricsStatus: 'completed', performanceMetrics: { durationMs: 1 },
      };
    });

    const run = makeRun({ concurrency: 1 } as any);
    const cases = [tc('tc-1'), tc('tc-2'), tc('tc-3'), tc('tc-4')];
    const completed = await executeEvaluationRun(run, cases, {
      storageModule: storage, cancellationToken: token, onProgress: jest.fn(), onTestCaseComplete: jest.fn(),
    } as any);

    expect(completed.status).toBe('cancelled');
    expect(completed.results['tc-1']).toMatchObject({ status: 'failed', passFailStatus: 'failed' }); // runner mirrors the verdict into status
    for (const id of ['tc-2', 'tc-3', 'tc-4']) {
      expect(completed.results[id]).toEqual({ reportId: '', status: 'cancelled' });
    }
    // Terminal-aware: nothing is pending on a cancelled run.
    expect(completed.stats).toEqual({ passed: 0, failed: 1, errored: 0, pending: 0, notRun: 3, total: 4 });
  });
});
