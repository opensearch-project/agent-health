/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// @ts-nocheck - Test file uses simplified mock objects
import { executeEvaluationRun, createCancellationToken } from '@/services/evaluationRunner';
import type { EvaluationRun, TestCase } from '@/types';

// Mock dependencies
jest.mock('@/services/evaluation', () => ({
  ...jest.requireActual('@/services/evaluation'),
  runEvaluationWithConnector: jest.fn(),
  callBedrockJudge: jest.fn(),
}));

jest.mock('@/services/connectors/server', () => ({
  connectorRegistry: {},
}));

jest.mock('@/lib/config/index', () => ({
  loadConfigSync: jest.fn(),
}));

jest.mock('@/lib/constants', () => ({
  DEFAULT_CONFIG: {
    agents: [
      { key: 'default-agent', name: 'Default Agent', endpoint: 'http://default:3000', headers: {} },
    ],
    models: {
      'claude-sonnet': { model_id: 'anthropic.claude-sonnet-4-20250514', display_name: 'Claude Sonnet' },
    },
  },
}));

jest.mock('@/server/services/customAgentStore', () => ({
  getCustomAgents: jest.fn().mockReturnValue([]),
}));

jest.mock('@/lib/debug', () => ({
  debug: jest.fn(),
}));

jest.mock('@/services/benchmarkRunner', () => ({
  createCancellationToken: jest.fn(() => ({
    isCancelled: false,
    cancel() { this.isCancelled = true; },
  })),
}));

jest.mock('@/services/traces/tracePoller', () => ({
  tracePollingManager: {
    startPolling: jest.fn(),
  },
}));

import { runEvaluationWithConnector } from '@/services/evaluation';
import { loadConfigSync } from '@/lib/config/index';
import { getCustomAgents } from '@/server/services/customAgentStore';

const mockRunEvaluation = runEvaluationWithConnector as jest.MockedFunction<typeof runEvaluationWithConnector>;
const mockLoadConfigSync = loadConfigSync as jest.MockedFunction<typeof loadConfigSync>;
const mockGetCustomAgents = getCustomAgents as jest.MockedFunction<typeof getCustomAgents>;

function makeTestCase(id: string): TestCase {
  return {
    id,
    name: `Test Case ${id}`,
    prompt: `Prompt for ${id}`,
    context: '',
    expectedOutcomes: ['Expected outcome'],
    labels: [],
    version: 1,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  } as TestCase;
}

function makeRun(overrides: Partial<EvaluationRun> = {}): EvaluationRun {
  return {
    id: 'run-1',
    docType: 'evaluation-run',
    name: 'Test Run',
    createdAt: '2024-01-01T00:00:00Z',
    status: 'pending',
    agentKey: 'default-agent',
    modelId: 'claude-sonnet',
    sources: [],
    trigger: 'api',
    testCaseSnapshots: [],
    results: {},
    ...overrides,
  } as EvaluationRun;
}

function makeStorageModule() {
  // Track placeholder docs by id so the post-completion update path returns
  // a merged doc shape — mirrors the real storage adapter's behaviour. The
  // pre-persist placeholder fix in services/evaluationRunner.ts depends on
  // `runs.update(placeholderId, reportFields)` returning the saved report
  // so the runner can read `savedReport.metricsStatus` etc. (Without this
  // the unit tests' default `update.mockResolvedValue(undefined)` makes
  // the runner crash on `savedReport.metricsStatus` access.)
  const docs = new Map<string, any>();
  const create = jest.fn().mockImplementation((report) => {
    const id = report.id || `report-${report.testCaseId || 'x'}`;
    const doc = { ...report, id };
    docs.set(id, doc);
    return Promise.resolve(doc);
  });
  const update = jest.fn().mockImplementation((id, updates) => {
    const existing = docs.get(id) || { id };
    const merged = { ...existing, ...updates, id };
    docs.set(id, merged);
    return Promise.resolve(merged);
  });
  return {
    runs: {
      create,
      update,
      get: jest.fn(),
      list: jest.fn(),
      delete: jest.fn(),
    },
    testCases: { create: jest.fn(), update: jest.fn(), get: jest.fn(), list: jest.fn(), delete: jest.fn() },
    benchmarks: { create: jest.fn(), update: jest.fn(), get: jest.fn(), list: jest.fn(), delete: jest.fn() },
  } as any;
}

describe('evaluationRunner', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadConfigSync.mockReturnValue({
      agents: [
        { key: 'default-agent', name: 'Default Agent', endpoint: 'http://default:3000', headers: {} },
      ],
      models: {
        'claude-sonnet': { model_id: 'anthropic.claude-sonnet-4-20250514', display_name: 'Claude Sonnet' },
      },
    } as any);
    mockGetCustomAgents.mockReturnValue([]);
    mockRunEvaluation.mockResolvedValue({
      id: 'report-1',
      testCaseId: 'tc-1',
      trajectory: [],
      passFailStatus: 'passed',
    } as any);
  });

  describe('executeEvaluationRun', () => {
    it('should execute all test cases and return completed run with stats', async () => {
      const testCases = [makeTestCase('tc-1'), makeTestCase('tc-2')];
      const run = makeRun();
      const storage = makeStorageModule();
      const onProgress = jest.fn();

      storage.runs.create.mockImplementation((report) =>
        Promise.resolve({ ...report, id: `report-${report.testCaseId || 'x'}` })
      );

      const result = await executeEvaluationRun(run, testCases, {
        storageModule: storage,
        onProgress,
      });

      expect(result.status).toBe('completed');
      expect(result.completedAt).toBeDefined();
      expect(result.stats).toEqual({
        passed: 2,
        failed: 0,
        pending: 0,
        errored: 0,
        total: 2,
      });
      expect(result.results['tc-1'].status).toBe('completed');
      expect(result.results['tc-2'].status).toBe('completed');
      expect(mockRunEvaluation).toHaveBeenCalledTimes(2);
    });

    it('should resolve agent from config and custom agents', async () => {
      const customAgent = { key: 'custom-agent', name: 'Custom', endpoint: 'http://custom:5000', headers: { 'X-Custom': 'val' } };
      mockGetCustomAgents.mockReturnValue([customAgent]);

      const run = makeRun({ agentKey: 'custom-agent' });
      const testCases = [makeTestCase('tc-1')];
      const storage = makeStorageModule();

      await executeEvaluationRun(run, testCases, {
        storageModule: storage,
        onProgress: jest.fn(),
      });

      expect(mockRunEvaluation).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'custom-agent', endpoint: 'http://custom:5000' }),
        expect.any(String),
        expect.any(Object),
        expect.any(Function),
        expect.any(Object)
      );
    });

    it('should throw if agent is not found', async () => {
      const run = makeRun({ agentKey: 'nonexistent-agent' });
      const storage = makeStorageModule();

      await expect(
        executeEvaluationRun(run, [makeTestCase('tc-1')], {
          storageModule: storage,
          onProgress: jest.fn(),
        })
      ).rejects.toThrow('Agent not found: nonexistent-agent');
    });

    it('should override agent endpoint from run config', async () => {
      const run = makeRun({ agentEndpoint: 'http://override:9000' });
      const testCases = [makeTestCase('tc-1')];
      const storage = makeStorageModule();

      await executeEvaluationRun(run, testCases, {
        storageModule: storage,
        onProgress: jest.fn(),
      });

      expect(mockRunEvaluation).toHaveBeenCalledWith(
        expect.objectContaining({ endpoint: 'http://override:9000' }),
        expect.any(String),
        expect.any(Object),
        expect.any(Function),
        expect.any(Object)
      );
    });

    it('should merge run headers with agent headers', async () => {
      const run = makeRun({ headers: { 'Authorization': 'Bearer token' } });
      const testCases = [makeTestCase('tc-1')];
      const storage = makeStorageModule();

      await executeEvaluationRun(run, testCases, {
        storageModule: storage,
        onProgress: jest.fn(),
      });

      expect(mockRunEvaluation).toHaveBeenCalledWith(
        expect.objectContaining({ headers: { 'Authorization': 'Bearer token' } }),
        expect.any(String),
        expect.any(Object),
        expect.any(Function),
        expect.any(Object)
      );
    });

    it('should use concurrency from run config', async () => {
      const testCases = [makeTestCase('tc-1'), makeTestCase('tc-2'), makeTestCase('tc-3')];
      const run = makeRun({ concurrency: 2 });
      const storage = makeStorageModule();
      const executionOrder: string[] = [];

      mockRunEvaluation.mockImplementation(async (_agent, _model, testCase) => {
        executionOrder.push(`start-${testCase.id}`);
        await new Promise(r => setTimeout(r, 50));
        executionOrder.push(`end-${testCase.id}`);
        return { id: `report-${testCase.id}`, testCaseId: testCase.id, trajectory: [] } as any;
      });

      await executeEvaluationRun(run, testCases, {
        storageModule: storage,
        onProgress: jest.fn(),
      });

      // With concurrency=2, first two should start before any finishes
      expect(executionOrder[0]).toBe('start-tc-1');
      expect(executionOrder[1]).toBe('start-tc-2');
      // tc-3 should only start after one of the first two completes
      const tc3StartIdx = executionOrder.indexOf('start-tc-3');
      const firstEndIdx = Math.min(
        executionOrder.indexOf('end-tc-1'),
        executionOrder.indexOf('end-tc-2')
      );
      expect(tc3StartIdx).toBeGreaterThan(firstEndIdx);
    });

    it('should default concurrency to 1 when not specified', async () => {
      const testCases = [makeTestCase('tc-1'), makeTestCase('tc-2')];
      const run = makeRun(); // no concurrency set
      const storage = makeStorageModule();
      const executionOrder: string[] = [];

      mockRunEvaluation.mockImplementation(async (_agent, _model, testCase) => {
        executionOrder.push(`start-${testCase.id}`);
        await new Promise(r => setTimeout(r, 20));
        executionOrder.push(`end-${testCase.id}`);
        return { id: `report-${testCase.id}`, trajectory: [] } as any;
      });

      await executeEvaluationRun(run, testCases, {
        storageModule: storage,
        onProgress: jest.fn(),
      });

      // With concurrency=1, tc-2 should start only after tc-1 ends
      expect(executionOrder).toEqual(['start-tc-1', 'end-tc-1', 'start-tc-2', 'end-tc-2']);
    });

    it('should stop processing when cancellation token is triggered', async () => {
      const testCases = [makeTestCase('tc-1'), makeTestCase('tc-2'), makeTestCase('tc-3')];
      const run = makeRun();
      const storage = makeStorageModule();
      const token = createCancellationToken();

      let evaluationCount = 0;
      mockRunEvaluation.mockImplementation(async () => {
        evaluationCount++;
        if (evaluationCount === 1) {
          token.cancel();
        }
        return { id: 'report', trajectory: [] } as any;
      });

      const result = await executeEvaluationRun(run, testCases, {
        cancellationToken: token,
        storageModule: storage,
        onProgress: jest.fn(),
      });

      expect(result.status).toBe('cancelled');
      // Should have processed at most 1 test case before cancellation takes effect
      expect(evaluationCount).toBeLessThanOrEqual(2);
    });

    it('should skip test case execution if cancellation token is already cancelled', async () => {
      const testCases = [makeTestCase('tc-1')];
      const run = makeRun();
      const storage = makeStorageModule();
      const token = { isCancelled: true, cancel: jest.fn() };

      const result = await executeEvaluationRun(run, testCases, {
        cancellationToken: token,
        storageModule: storage,
        onProgress: jest.fn(),
      });

      expect(result.status).toBe('cancelled');
      expect(mockRunEvaluation).not.toHaveBeenCalled();
    });

    it('should report progress for each test case', async () => {
      const testCases = [makeTestCase('tc-1'), makeTestCase('tc-2')];
      const run = makeRun();
      const storage = makeStorageModule();
      const onProgress = jest.fn();

      await executeEvaluationRun(run, testCases, {
        storageModule: storage,
        onProgress,
      });

      // Should have progress calls: start tc-1, complete tc-1, start tc-2, complete tc-2, final
      expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({
        runId: 'run-1',
        testCaseId: 'tc-1',
        status: 'running',
      }));
      expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({
        runId: 'run-1',
        testCaseId: 'tc-2',
        status: 'running',
      }));
      // Final notification
      expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({
        status: 'completed',
        completedCount: 2,
        totalTestCases: 2,
      }));
    });

    it('should call onTestCaseComplete callback for each test case', async () => {
      const testCases = [makeTestCase('tc-1'), makeTestCase('tc-2')];
      const run = makeRun();
      const storage = makeStorageModule();
      const onTestCaseComplete = jest.fn().mockResolvedValue(undefined);

      await executeEvaluationRun(run, testCases, {
        storageModule: storage,
        onProgress: jest.fn(),
        onTestCaseComplete,
      });

      expect(onTestCaseComplete).toHaveBeenCalledTimes(2);
      expect(onTestCaseComplete).toHaveBeenCalledWith('tc-1', expect.objectContaining({ status: 'completed' }));
      expect(onTestCaseComplete).toHaveBeenCalledWith('tc-2', expect.objectContaining({ status: 'completed' }));
    });

    it('should handle evaluation errors gracefully and mark test case as failed', async () => {
      const testCases = [makeTestCase('tc-1'), makeTestCase('tc-2')];
      const run = makeRun();
      const storage = makeStorageModule();

      mockRunEvaluation
        .mockRejectedValueOnce(new Error('Connection refused'))
        .mockResolvedValueOnce({ id: 'report-2', trajectory: [], passFailStatus: 'passed' } as any);

      const result = await executeEvaluationRun(run, testCases, {
        storageModule: storage,
        onProgress: jest.fn(),
      });

      expect(result.status).toBe('completed');
      expect(result.results['tc-1'].status).toBe('failed');
      expect(result.results['tc-1'].error).toBe('Connection refused');
      expect(result.results['tc-2'].status).toBe('completed');
      expect(result.stats).toEqual({
        passed: 1,
        failed: 1,
        pending: 0,
        errored: 0,
        total: 2,
      });
    });

    it('should apply exponential backoff on throttle errors', async () => {
      jest.useFakeTimers();
      const testCases = [makeTestCase('tc-1'), makeTestCase('tc-2')];
      const run = makeRun({ concurrency: 2 });
      const storage = makeStorageModule();

      mockRunEvaluation
        .mockRejectedValueOnce(new Error('ThrottlingException: Rate exceeded'))
        .mockResolvedValueOnce({ id: 'report-2', trajectory: [] } as any);

      const promise = executeEvaluationRun(run, testCases, {
        storageModule: storage,
        onProgress: jest.fn(),
      });

      // Advance through the backoff delay
      await jest.advanceTimersByTimeAsync(35000);

      const result = await promise;
      expect(result.results['tc-1'].status).toBe('failed');
      expect(result.results['tc-1'].error).toContain('ThrottlingException');
      jest.useRealTimers();
    });

    it('should apply backoff for rate limit (429) errors', async () => {
      jest.useFakeTimers();
      const testCases = [makeTestCase('tc-1'), makeTestCase('tc-2')];
      const run = makeRun();
      const storage = makeStorageModule();

      mockRunEvaluation
        .mockRejectedValueOnce(new Error('429 Too Many Requests'))
        .mockResolvedValueOnce({ id: 'report-2', trajectory: [] } as any);

      const promise = executeEvaluationRun(run, testCases, {
        storageModule: storage,
        onProgress: jest.fn(),
      });

      await jest.advanceTimersByTimeAsync(35000);

      const result = await promise;
      expect(result.results['tc-1'].status).toBe('failed');
      expect(result.results['tc-1'].error).toContain('429');
      expect(result.results['tc-2'].status).toBe('completed');
      jest.useRealTimers();
    });

    it('should compute performance metrics', async () => {
      const testCases = [makeTestCase('tc-1')];
      const run = makeRun();
      const storage = makeStorageModule();

      await executeEvaluationRun(run, testCases, {
        storageModule: storage,
        onProgress: jest.fn(),
      });

      expect(run.performanceMetrics).toBeDefined();
      expect(run.performanceMetrics!.durationMs).toBeGreaterThanOrEqual(0);
      expect(run.performanceMetrics!.concurrency).toBe(1);
    });

    it('should fall back to DEFAULT_CONFIG when loadConfigSync throws', async () => {
      mockLoadConfigSync.mockImplementation(() => { throw new Error('Config not found'); });

      const testCases = [makeTestCase('tc-1')];
      const run = makeRun();
      const storage = makeStorageModule();

      await executeEvaluationRun(run, testCases, {
        storageModule: storage,
        onProgress: jest.fn(),
      });

      // Should still work using DEFAULT_CONFIG fallback
      expect(mockRunEvaluation).toHaveBeenCalledTimes(1);
    });

    it('should pass evaluatorId to runEvaluationWithConnector', async () => {
      const testCases = [makeTestCase('tc-1')];
      const run = makeRun({ evaluatorId: 'custom-evaluator' });
      const storage = makeStorageModule();

      await executeEvaluationRun(run, testCases, {
        storageModule: storage,
        onProgress: jest.fn(),
      });

      expect(mockRunEvaluation).toHaveBeenCalledWith(
        expect.any(Object),
        expect.any(String),
        expect.any(Object),
        expect.any(Function),
        expect.objectContaining({ evaluatorId: 'custom-evaluator' })
      );
    });

    it('should handle empty test cases array', async () => {
      const run = makeRun();
      const storage = makeStorageModule();
      const onProgress = jest.fn();

      const result = await executeEvaluationRun(run, [], {
        storageModule: storage,
        onProgress,
      });

      expect(result.status).toBe('completed');
      expect(result.stats).toEqual({ passed: 0, failed: 0, pending: 0, errored: 0, total: 0 });
      expect(mockRunEvaluation).not.toHaveBeenCalled();
    });

    it('should pre-persist a running placeholder then update with the completed report', async () => {
      // Cross-surface parity (commit fd984c9e): the runner now pre-persists a
      // `status: running` placeholder via `runs.create` BEFORE invoking the
      // agent, then UPDATES the same doc via `runs.update` once the agent +
      // judge complete — mirrors what /api/evaluate does for the UI "Run Test"
      // path. This guarantees the runs list shows an in-progress row.
      const testCases = [makeTestCase('tc-1')];
      const run = makeRun({ evaluatorId: 'system-tool-usage' });
      const storage = makeStorageModule();

      mockRunEvaluation.mockResolvedValue({ id: 'eval-report', trajectory: [], testCaseId: 'tc-1' } as any);

      await executeEvaluationRun(run, testCases, {
        storageModule: storage,
        onProgress: jest.fn(),
      });

      // 1. Placeholder is created first with status='running' and the
      //    run-level evaluatorId.
      expect(storage.runs.create).toHaveBeenCalledTimes(1);
      expect(storage.runs.create).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'running',
          traceStatus: 'not_configured',
          testCaseId: 'tc-1',
          evaluatorId: 'system-tool-usage',
          experimentRunId: run.id,
        }),
      );

      // 2. Same doc is then updated with the completed report.
      expect(storage.runs.update).toHaveBeenCalledTimes(1);
      const [placeholderId, updatePayload] = storage.runs.update.mock.calls[0];
      expect(typeof placeholderId).toBe('string');
      expect(placeholderId.length).toBeGreaterThan(0);
      // The runner stamps evaluatorId onto the report itself as defence in
      // depth (the connector return path predates this work).
      expect(updatePayload).toEqual(expect.objectContaining({ evaluatorId: 'system-tool-usage' }));

      // 3. run.results carries the placeholder id (NOT the inline
      //    eval-report id) so listing endpoints find the persisted doc.
      expect(run.results['tc-1'].reportId).toBe(placeholderId);
    });

    it('should set completedAt timestamp on completion', async () => {
      const run = makeRun();
      const storage = makeStorageModule();

      const result = await executeEvaluationRun(run, [makeTestCase('tc-1')], {
        storageModule: storage,
        onProgress: jest.fn(),
      });

      expect(result.completedAt).toBeDefined();
      // Should be a valid ISO string
      expect(new Date(result.completedAt!).toISOString()).toBe(result.completedAt);
    });
  });

  describe('createCancellationToken', () => {
    it('should create a token that starts as not cancelled', () => {
      const token = createCancellationToken();
      expect(token.isCancelled).toBe(false);
    });

    it('should set isCancelled to true when cancel() is called', () => {
      const token = createCancellationToken();
      token.cancel();
      expect(token.isCancelled).toBe(true);
    });
  });
});
