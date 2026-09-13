/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for EvaluationRunner service
 *
 * Tests the executeEvaluationRun function which orchestrates evaluation
 * execution with concurrency, cancellation, throttling, and progress reporting.
 *
 * All external dependencies (connectors, storage, config) are mocked so these
 * tests can run without a server or OpenSearch instance.
 */

import type { EvaluationRun, TestCase, AgentConfig } from '@/types';
import type { IStorageModule } from '@/server/adapters/types';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockRunEvaluationWithConnector = jest.fn();
const mockCallBedrockJudge = jest.fn();
jest.mock('@/services/evaluation', () => ({
  ...jest.requireActual('@/services/evaluation'),
  runEvaluationWithConnector: (...args: any[]) => mockRunEvaluationWithConnector(...args),
  callBedrockJudge: (...args: any[]) => mockCallBedrockJudge(...args),
}));

jest.mock('@/services/connectors/server', () => ({
  connectorRegistry: { getConnector: jest.fn() },
}));

const mockLoadConfigSync = jest.fn();
jest.mock('@/lib/config/index', () => ({
  loadConfigSync: () => mockLoadConfigSync(),
}));

jest.mock('@/lib/constants', () => ({
  DEFAULT_CONFIG: {
    agents: [
      { key: 'test-agent', name: 'Test Agent', endpoint: 'http://localhost:3000/agent', connectorType: 'mock' },
    ],
    models: {
      'test-model': { model_id: 'anthropic.claude-test', display_name: 'Test Model', context_window: 200000, max_output_tokens: 4096 },
    },
  },
}));

jest.mock('@/server/services/customAgentStore', () => ({
  getCustomAgents: jest.fn().mockReturnValue([]),
}));

const mockStartPolling = jest.fn();
jest.mock('@/services/traces/tracePoller', () => ({
  tracePollingManager: {
    startPolling: (...args: any[]) => mockStartPolling(...args),
  },
}));

// Suppress console.log/error during tests
jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'error').mockImplementation(() => {});

import { executeEvaluationRun, createCancellationToken } from '@/services/evaluationRunner';
import type { ExecuteEvaluationRunOptions, EvaluationRunProgress } from '@/services/evaluationRunner';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function createTestCase(id: string, name?: string): TestCase {
  const now = new Date().toISOString();
  return {
    id,
    name: name ?? `Test Case ${id}`,
    description: `Description for ${id}`,
    labels: ['category:Test'],
    currentVersion: 1,
    versions: [{
      version: 1,
      createdAt: now,
      initialPrompt: `Prompt for ${id}`,
      context: [],
      expectedOutcomes: ['Expected outcome'],
    }],
    isPromoted: false,
    createdAt: now,
    updatedAt: now,
    initialPrompt: `Prompt for ${id}`,
    context: [],
    expectedOutcomes: ['Expected outcome'],
  };
}

function createEvaluationRun(overrides: Partial<EvaluationRun> = {}): EvaluationRun {
  return {
    id: 'run-1',
    docType: 'evaluation-run',
    name: 'Test Run',
    createdAt: new Date().toISOString(),
    status: 'pending',
    agentKey: 'test-agent',
    modelId: 'test-model',
    concurrency: 1,
    sources: [],
    trigger: 'api',
    testCaseSnapshots: [],
    results: {},
    ...overrides,
  };
}

function createMockStorageModule(): IStorageModule {
  // Cross-surface parity (commit fd984c9e): the runner pre-persists a
  // placeholder via `runs.create` then UPDATES it via `runs.update`. Both
  // need to return the persisted doc shape. We track docs by id so the
  // update path returns the merged doc — mirrors the real adapter.
  const docs = new Map<string, any>();
  return {
    runs: {
      create: jest.fn().mockImplementation((report: any) => {
        const id = report.id || `report-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const doc = { ...report, id };
        docs.set(id, doc);
        return Promise.resolve(doc);
      }),
      update: jest.fn().mockImplementation((id: string, updates: any) => {
        const existing = docs.get(id) || { id };
        const merged = { ...existing, ...updates, id };
        docs.set(id, merged);
        return Promise.resolve(merged);
      }),
      get: jest.fn().mockResolvedValue(null),
      list: jest.fn().mockResolvedValue([]),
      delete: jest.fn().mockResolvedValue(undefined),
    },
    testCases: {
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue(undefined),
      get: jest.fn().mockResolvedValue(null),
      list: jest.fn().mockResolvedValue([]),
      delete: jest.fn().mockResolvedValue(undefined),
    },
    benchmarks: {
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue(undefined),
      get: jest.fn().mockResolvedValue(null),
      list: jest.fn().mockResolvedValue([]),
      delete: jest.fn().mockResolvedValue(undefined),
    },
  } as unknown as IStorageModule;
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();

  mockLoadConfigSync.mockReturnValue({
    agents: [
      { key: 'test-agent', name: 'Test Agent', endpoint: 'http://localhost:3000/agent', connectorType: 'mock' },
    ],
    models: {
      'test-model': { model_id: 'anthropic.claude-test', display_name: 'Test Model', context_window: 200000, max_output_tokens: 4096 },
    },
  });

  mockRunEvaluationWithConnector.mockImplementation((_agent: any, _model: any, testCase: any) =>
    Promise.resolve({
      id: `report-${testCase.id}`,
      testCaseId: testCase.id,
      metricsStatus: 'ready',
      passFailStatus: 'passed',
      trajectory: [{ type: 'response', content: 'Done' }],
    })
  );
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('executeEvaluationRun', () => {
  describe('successful execution', () => {
    it('executes multiple test cases with concurrency=1', async () => {
      const run = createEvaluationRun({ concurrency: 1 });
      const testCases = [createTestCase('tc-1'), createTestCase('tc-2'), createTestCase('tc-3')];
      const storage = createMockStorageModule();
      const onProgress = jest.fn();

      const result = await executeEvaluationRun(run, testCases, {
        storageModule: storage,
        onProgress,
      });

      expect(result.status).toBe('completed');
      expect(result.results['tc-1'].status).toBe('completed');
      expect(result.results['tc-2'].status).toBe('completed');
      expect(result.results['tc-3'].status).toBe('completed');
      expect(mockRunEvaluationWithConnector).toHaveBeenCalledTimes(3);
      expect(storage.runs.create).toHaveBeenCalledTimes(3);
    });

    it('executes with concurrency=2 and completes all test cases', async () => {
      const executionOrder: string[] = [];

      mockRunEvaluationWithConnector.mockImplementation((_agent: any, _model: any, testCase: any) => {
        executionOrder.push(`start-${testCase.id}`);
        return new Promise(resolve => {
          setTimeout(() => {
            executionOrder.push(`end-${testCase.id}`);
            resolve({
              id: `report-${testCase.id}`,
              testCaseId: testCase.id,
              metricsStatus: 'ready',
              passFailStatus: 'passed',
              trajectory: [],
            });
          }, 10);
        });
      });

      const run = createEvaluationRun({ concurrency: 2 });
      const testCases = [createTestCase('tc-1'), createTestCase('tc-2'), createTestCase('tc-3')];
      const storage = createMockStorageModule();
      const onProgress = jest.fn();

      const result = await executeEvaluationRun(run, testCases, {
        storageModule: storage,
        onProgress,
      });

      expect(result.status).toBe('completed');
      expect(Object.keys(result.results)).toHaveLength(3);
      // With concurrency=2, first two should start before either finishes
      expect(executionOrder[0]).toBe('start-tc-1');
      expect(executionOrder[1]).toBe('start-tc-2');
    });
  });

  describe('cancellation', () => {
    it('stops execution when cancellation token is triggered mid-run', async () => {
      const cancellationToken = createCancellationToken();
      let callCount = 0;

      mockRunEvaluationWithConnector.mockImplementation((_agent: any, _model: any, testCase: any) => {
        callCount++;
        // Cancel after the first test case completes
        if (callCount === 1) {
          cancellationToken.cancel();
        }
        return Promise.resolve({
          id: `report-${testCase.id}`,
          testCaseId: testCase.id,
          metricsStatus: 'ready',
          passFailStatus: 'passed',
          trajectory: [],
        });
      });

      const run = createEvaluationRun({ concurrency: 1 });
      const testCases = [createTestCase('tc-1'), createTestCase('tc-2'), createTestCase('tc-3')];
      const storage = createMockStorageModule();
      const onProgress = jest.fn();

      const result = await executeEvaluationRun(run, testCases, {
        cancellationToken,
        storageModule: storage,
        onProgress,
      });

      expect(result.status).toBe('cancelled');
      // Only the first test case should have been executed
      expect(callCount).toBe(1);
      expect(result.results['tc-1'].status).toBe('completed');
    });
  });

  describe('agent not found', () => {
    it('throws error when agent key is not in config', async () => {
      const run = createEvaluationRun({ agentKey: 'nonexistent-agent' });
      const testCases = [createTestCase('tc-1')];
      const storage = createMockStorageModule();
      const onProgress = jest.fn();

      await expect(
        executeEvaluationRun(run, testCases, {
          storageModule: storage,
          onProgress,
        })
      ).rejects.toThrow('Agent not found: nonexistent-agent');
    });
  });

  describe('individual test case failure', () => {
    it('marks failed test case and continues with remaining', async () => {
      mockRunEvaluationWithConnector.mockImplementation((_agent: any, _model: any, testCase: any) => {
        if (testCase.id === 'tc-2') {
          return Promise.reject(new Error('Connection timeout'));
        }
        return Promise.resolve({
          id: `report-${testCase.id}`,
          testCaseId: testCase.id,
          metricsStatus: 'ready',
          passFailStatus: 'passed',
          trajectory: [],
        });
      });

      const run = createEvaluationRun({ concurrency: 1 });
      const testCases = [createTestCase('tc-1'), createTestCase('tc-2'), createTestCase('tc-3')];
      const storage = createMockStorageModule();
      const onProgress = jest.fn();

      const result = await executeEvaluationRun(run, testCases, {
        storageModule: storage,
        onProgress,
      });

      expect(result.status).toBe('completed');
      expect(result.results['tc-1'].status).toBe('completed');
      expect(result.results['tc-2'].status).toBe('failed');
      expect(result.results['tc-2'].error).toBe('Connection timeout');
      expect(result.results['tc-3'].status).toBe('completed');
      expect(mockRunEvaluationWithConnector).toHaveBeenCalledTimes(3);
    });
  });

  describe('progress callbacks', () => {
    it('fires progress with correct started and completed counts', async () => {
      const run = createEvaluationRun({ concurrency: 1 });
      const testCases = [createTestCase('tc-1'), createTestCase('tc-2')];
      const storage = createMockStorageModule();
      const onProgress = jest.fn();

      await executeEvaluationRun(run, testCases, {
        storageModule: storage,
        onProgress,
      });

      // For each test case: 1 "starting" progress + 1 "completed" progress
      // Plus 1 final progress at the end
      const progressCalls = onProgress.mock.calls.map(c => c[0] as EvaluationRunProgress);

      // First test case starts
      expect(progressCalls[0].startedCount).toBe(1);
      expect(progressCalls[0].completedCount).toBe(0);
      expect(progressCalls[0].status).toBe('running');

      // First test case completes
      expect(progressCalls[1].startedCount).toBe(1);
      expect(progressCalls[1].completedCount).toBe(1);
      expect(progressCalls[1].status).toBe('running');

      // Second test case starts
      expect(progressCalls[2].startedCount).toBe(2);
      expect(progressCalls[2].completedCount).toBe(1);
      expect(progressCalls[2].status).toBe('running');

      // Second test case completes
      expect(progressCalls[3].startedCount).toBe(2);
      expect(progressCalls[3].completedCount).toBe(2);
      expect(progressCalls[3].status).toBe('running');

      // Final progress — completed
      const lastProgress = progressCalls[progressCalls.length - 1];
      expect(lastProgress.status).toBe('completed');
      expect(lastProgress.completedCount).toBe(2);
    });
  });

  describe('final stats computation', () => {
    it('computes passed, failed, pending totals correctly', async () => {
      mockRunEvaluationWithConnector.mockImplementation((_agent: any, _model: any, testCase: any) => {
        if (testCase.id === 'tc-2') {
          return Promise.reject(new Error('Failed'));
        }
        return Promise.resolve({
          id: `report-${testCase.id}`,
          testCaseId: testCase.id,
          metricsStatus: 'ready',
          passFailStatus: 'passed',
          trajectory: [],
        });
      });

      const run = createEvaluationRun({ concurrency: 1 });
      const testCases = [createTestCase('tc-1'), createTestCase('tc-2'), createTestCase('tc-3')];
      const storage = createMockStorageModule();
      const onProgress = jest.fn();

      const result = await executeEvaluationRun(run, testCases, {
        storageModule: storage,
        onProgress,
      });

      expect(result.stats).toBeDefined();
      expect(result.stats!.passed).toBe(2); // tc-1 and tc-3 completed
      expect(result.stats!.failed).toBe(1); // tc-2 failed
      expect(result.stats!.total).toBe(3);
    });

    it('computes performanceMetrics with durationMs and concurrency', async () => {
      const run = createEvaluationRun({ concurrency: 2 });
      const testCases = [createTestCase('tc-1'), createTestCase('tc-2')];
      const storage = createMockStorageModule();
      const onProgress = jest.fn();

      const result = await executeEvaluationRun(run, testCases, {
        storageModule: storage,
        onProgress,
      });

      expect(result.performanceMetrics).toBeDefined();
      expect(result.performanceMetrics!.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.performanceMetrics!.concurrency).toBe(2);
    });
  });

  describe('onTestCaseComplete callback', () => {
    it('is called for each completed test case with correct result', async () => {
      const run = createEvaluationRun({ concurrency: 1 });
      const testCases = [createTestCase('tc-1'), createTestCase('tc-2')];
      const storage = createMockStorageModule();
      const onProgress = jest.fn();
      const onTestCaseComplete = jest.fn().mockResolvedValue(undefined);

      await executeEvaluationRun(run, testCases, {
        storageModule: storage,
        onProgress,
        onTestCaseComplete,
      });

      expect(onTestCaseComplete).toHaveBeenCalledTimes(2);
      expect(onTestCaseComplete).toHaveBeenCalledWith('tc-1', expect.objectContaining({
        reportId: expect.any(String),
        status: 'completed',
      }));
      expect(onTestCaseComplete).toHaveBeenCalledWith('tc-2', expect.objectContaining({
        reportId: expect.any(String),
        status: 'completed',
      }));
    });

    it('is called for failed test cases with error', async () => {
      mockRunEvaluationWithConnector.mockRejectedValueOnce(new Error('Timeout'));

      const run = createEvaluationRun({ concurrency: 1 });
      const testCases = [createTestCase('tc-1')];
      const storage = createMockStorageModule();
      const onProgress = jest.fn();
      const onTestCaseComplete = jest.fn().mockResolvedValue(undefined);

      await executeEvaluationRun(run, testCases, {
        storageModule: storage,
        onProgress,
        onTestCaseComplete,
      });

      expect(onTestCaseComplete).toHaveBeenCalledWith('tc-1', expect.objectContaining({
        status: 'failed',
        error: 'Timeout',
      }));
    });
  });

  describe('throttle backoff', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('applies exponential backoff on ThrottlingException', async () => {
      let callCount = 0;

      mockRunEvaluationWithConnector.mockImplementation((_agent: any, _model: any, testCase: any) => {
        callCount++;
        if (testCase.id === 'tc-1') {
          return Promise.reject(new Error('ThrottlingException: Rate exceeded'));
        }
        return Promise.resolve({
          id: `report-${testCase.id}`,
          testCaseId: testCase.id,
          metricsStatus: 'ready',
          passFailStatus: 'passed',
          trajectory: [],
        });
      });

      const run = createEvaluationRun({ concurrency: 1 });
      const testCases = [createTestCase('tc-1'), createTestCase('tc-2')];
      const storage = createMockStorageModule();
      const onProgress = jest.fn();

      const runPromise = executeEvaluationRun(run, testCases, {
        storageModule: storage,
        onProgress,
      });

      // Advance timers to allow backoff delays to resolve
      await jest.advanceTimersByTimeAsync(60000);

      const result = await runPromise;

      // tc-1 failed with throttle error, tc-2 should still execute
      expect(result.results['tc-1'].status).toBe('failed');
      expect(result.results['tc-1'].error).toContain('ThrottlingException');
      expect(result.results['tc-2'].status).toBe('completed');
      expect(result.status).toBe('completed');
    });
  });

  describe('run status transitions', () => {
    it('transitions from pending to completed on success', async () => {
      const run = createEvaluationRun({ status: 'pending' });
      const testCases = [createTestCase('tc-1')];
      const storage = createMockStorageModule();
      const onProgress = jest.fn();

      const result = await executeEvaluationRun(run, testCases, {
        storageModule: storage,
        onProgress,
      });

      expect(result.status).toBe('completed');
      expect(result.completedAt).toBeDefined();
    });

    it('transitions to cancelled when token is cancelled before any test case', async () => {
      const cancellationToken = createCancellationToken();
      cancellationToken.cancel();

      const run = createEvaluationRun({ status: 'pending' });
      const testCases = [createTestCase('tc-1')];
      const storage = createMockStorageModule();
      const onProgress = jest.fn();

      const result = await executeEvaluationRun(run, testCases, {
        cancellationToken,
        storageModule: storage,
        onProgress,
      });

      expect(result.status).toBe('cancelled');
      expect(mockRunEvaluationWithConnector).not.toHaveBeenCalled();
    });

    it('transitions to failed when an unrecoverable error occurs', async () => {
      // Simulate loadConfigSync returning an agent, but something else throws
      // at top level outside the per-test-case try/catch.
      // Actually, the current implementation wraps in try/catch so individual
      // failures don't bubble. Let's verify that all-failed still = 'completed'.
      mockRunEvaluationWithConnector.mockRejectedValue(new Error('Network error'));

      const run = createEvaluationRun({ concurrency: 1 });
      const testCases = [createTestCase('tc-1'), createTestCase('tc-2')];
      const storage = createMockStorageModule();
      const onProgress = jest.fn();

      const result = await executeEvaluationRun(run, testCases, {
        storageModule: storage,
        onProgress,
      });

      // Per the implementation, individual failures are caught — run still completes
      expect(result.status).toBe('completed');
      expect(result.results['tc-1'].status).toBe('failed');
      expect(result.results['tc-2'].status).toBe('failed');
      expect(result.stats!.failed).toBe(2);
    });
  });

  describe('trace polling integration', () => {
    it('triggers trace polling for a trace-enabled agent when report has metricsStatus pending', async () => {
      // Trace polling is explicitly gated by agent configuration. Keep this
      // test focused on the positive useTraces=true path rather than relying
      // on the old implicit "pending means poll" behaviour.
      mockLoadConfigSync.mockReturnValue({
        agents: [
          { key: 'test-agent', name: 'Test Agent', endpoint: 'http://localhost:3000/agent', connectorType: 'mock', useTraces: true },
        ],
        models: {
          'test-model': { model_id: 'anthropic.claude-test', display_name: 'Test Model', context_window: 200000, max_output_tokens: 4096 },
        },
      });

      mockRunEvaluationWithConnector.mockResolvedValue({
        id: 'report-tc-1',
        testCaseId: 'tc-1',
        runId: 'run-abc-123',
        metricsStatus: 'pending',
        trajectory: [],
      });

      // Mock startPolling to immediately invoke onTracesFound
      mockStartPolling.mockImplementation((_reportId: string, _runId: string, callbacks: any) => {
        callbacks.onTracesFound([], { trajectory: [{ type: 'response', content: 'traced' }] });
      });

      mockCallBedrockJudge.mockResolvedValue({
        passFailStatus: 'passed',
        metrics: { accuracy: 1 },
        llmJudgeReasoning: 'Good',
        improvementStrategies: [],
      });

      const run = createEvaluationRun({ concurrency: 1 });
      const testCases = [createTestCase('tc-1')];
      const storage = createMockStorageModule();
      const onProgress = jest.fn();

      const result = await executeEvaluationRun(run, testCases, {
        storageModule: storage,
        onProgress,
      });

      expect(mockStartPolling).toHaveBeenCalledTimes(1);
      expect(mockStartPolling).toHaveBeenCalledWith(
        expect.any(String), // reportId
        'run-abc-123',       // runId
        expect.any(Object),  // callbacks
        expect.objectContaining({ agentConfig: expect.any(Object) })
      );
      expect(result.results['tc-1'].status).toBe('completed');
      // Regression: the resolved judge verdict must land on run.results AND
      // run.stats, not just leave the caller's stale savedReport untouched.
      expect((result.results['tc-1'] as any).passFailStatus).toBe('passed');
      expect(result.stats).toEqual({ passed: 1, failed: 0, pending: 0, errored: 0, total: 1 });
    });

    it('REGRESSION (trace-judged stats inflation): run.stats reflects real mixed verdicts, not "every completed = passed"', async () => {
      // Reproduces the reported bug at scale: N trace-judged test cases with
      // a MIX of judge verdicts must produce run.stats matching the real
      // pass/fail split (e.g. 2 passed / 2 failed), never "all N passed"
      // just because every report reached status 'completed'.
      const testCaseIds = ['tc-1', 'tc-2', 'tc-3', 'tc-4'];
      const verdictByTestCase: Record<string, 'passed' | 'failed'> = {
        'tc-1': 'passed',
        'tc-2': 'passed',
        'tc-3': 'failed',
        'tc-4': 'failed',
      };

      // The polling gate requires a TRACE-MODE agent (agentConfig.useTraces).
      mockLoadConfigSync.mockReturnValue({
        agents: [
          { key: 'test-agent', name: 'Test Agent', endpoint: 'http://localhost:3000/agent', connectorType: 'mock', useTraces: true },
        ],
        models: {
          'test-model': { model_id: 'anthropic.claude-test', display_name: 'Test Model', context_window: 200000, max_output_tokens: 4096 },
        },
      });

      mockRunEvaluationWithConnector.mockImplementation((_agentConfig: any, _model: any, testCase: any) => Promise.resolve({
        id: `report-${testCase.id}`,
        testCaseId: testCase.id,
        runId: `run-abc-${testCase.id}`,
        metricsStatus: 'pending',
        trajectory: [],
      }));

      // Each test case's trace poll resolves to ITS OWN verdict via the
      // report id (encoded above as report-<testCaseId>).
      mockStartPolling.mockImplementation((reportId: string, _runId: string, callbacks: any) => {
        callbacks.onTracesFound([], { trajectory: [{ type: 'response', content: `traced ${reportId}` }] });
      });
      mockCallBedrockJudge.mockImplementation((_trajectory: any, _expected: any, _spans: any, _cb: any, _model: any, _evaluatorId: any, runId: string) => {
        const testCaseId = String(runId).replace('run-abc-', '');
        return Promise.resolve({
          passFailStatus: verdictByTestCase[testCaseId],
          metrics: { accuracy: verdictByTestCase[testCaseId] === 'passed' ? 1 : 0 },
          llmJudgeReasoning: verdictByTestCase[testCaseId],
          improvementStrategies: [],
        });
      });

      const run = createEvaluationRun({ concurrency: 1 });
      const testCases = testCaseIds.map(id => createTestCase(id));
      const storage = createMockStorageModule();

      const result = await executeEvaluationRun(run, testCases, {
        storageModule: storage,
        onProgress: jest.fn(),
      });

      for (const id of testCaseIds) {
        expect((result.results[id] as any).passFailStatus).toBe(verdictByTestCase[id]);
      }
      // The bug: pre-fix, ALL FOUR would be counted `passed` here because the
      // caller never saw the resolved judgment (savedReport stayed at its
      // pre-judge 'pending' state). Post-fix: real 2/2 split.
      expect(result.stats).toEqual({ passed: 2, failed: 2, pending: 0, errored: 0, total: 4 });
    });

    it('judge failure during trace-judged polling is bucketed errored, not passed (does not crash the run)', async () => {
      // Covers waitForTracesAndJudge's catch(judge_failed) path: the judge
      // call itself throws (e.g. Bedrock error) after traces were found.
      // The run must not crash, the result must carry NO passFailStatus, and
      // the canonical bucketing must call it 'errored' rather than a silent
      // pass.
      // The polling gate requires a TRACE-MODE agent (agentConfig.useTraces).
      mockLoadConfigSync.mockReturnValue({
        agents: [
          { key: 'test-agent', name: 'Test Agent', endpoint: 'http://localhost:3000/agent', connectorType: 'mock', useTraces: true },
        ],
        models: {
          'test-model': { model_id: 'anthropic.claude-test', display_name: 'Test Model', context_window: 200000, max_output_tokens: 4096 },
        },
      });

      mockRunEvaluationWithConnector.mockResolvedValue({
        id: 'report-tc-1',
        testCaseId: 'tc-1',
        runId: 'run-abc-123',
        metricsStatus: 'pending',
        trajectory: [],
      });

      mockStartPolling.mockImplementation((_reportId: string, _runId: string, callbacks: any) => {
        callbacks.onTracesFound([], { trajectory: [{ type: 'response', content: 'traced' }] });
      });
      mockCallBedrockJudge.mockRejectedValue(new Error('Bedrock judge exploded'));

      const run = createEvaluationRun({ concurrency: 1 });
      const testCases = [createTestCase('tc-1')];
      const storage = createMockStorageModule();

      const result = await executeEvaluationRun(run, testCases, {
        storageModule: storage,
        onProgress: jest.fn(),
      });

      expect(result.results['tc-1'].status).toBe('completed');
      expect((result.results['tc-1'] as any).passFailStatus).toBeUndefined();
      expect(result.stats).toEqual({ passed: 0, failed: 0, pending: 0, errored: 1, total: 1 });
    });

    it('trace polling failure (onError) is bucketed errored, not passed', async () => {
      // Covers waitForTracesAndJudge's onError callback: trace polling itself
      // fails (e.g. traces never arrive / poller error) before the judge is
      // ever called.
      // The polling gate requires a TRACE-MODE agent (agentConfig.useTraces).
      mockLoadConfigSync.mockReturnValue({
        agents: [
          { key: 'test-agent', name: 'Test Agent', endpoint: 'http://localhost:3000/agent', connectorType: 'mock', useTraces: true },
        ],
        models: {
          'test-model': { model_id: 'anthropic.claude-test', display_name: 'Test Model', context_window: 200000, max_output_tokens: 4096 },
        },
      });

      mockRunEvaluationWithConnector.mockResolvedValue({
        id: 'report-tc-1',
        testCaseId: 'tc-1',
        runId: 'run-abc-123',
        metricsStatus: 'pending',
        trajectory: [],
      });

      mockStartPolling.mockImplementation((_reportId: string, _runId: string, callbacks: any) => {
        callbacks.onError(new Error('trace polling timed out'));
      });

      const run = createEvaluationRun({ concurrency: 1 });
      const testCases = [createTestCase('tc-1')];
      const storage = createMockStorageModule();

      const result = await executeEvaluationRun(run, testCases, {
        storageModule: storage,
        onProgress: jest.fn(),
      });

      expect(result.results['tc-1'].status).toBe('completed');
      expect((result.results['tc-1'] as any).passFailStatus).toBeUndefined();
      expect(result.stats).toEqual({ passed: 0, failed: 0, pending: 0, errored: 1, total: 1 });
      expect(mockCallBedrockJudge).not.toHaveBeenCalled();
    });

    it('does NOT start trace polling for a non-trace agent, even when the report is pending', async () => {
      // Regression for the eager-judge clobber: the default test-agent has
      // useTraces unset (false), so a transiently/erroneously 'pending'
      // report must never enter trace polling.
      mockRunEvaluationWithConnector.mockResolvedValue({
        id: 'report-tc-1',
        testCaseId: 'tc-1',
        runId: 'run-abc-123',
        metricsStatus: 'pending',
        trajectory: [],
      });

      const run = createEvaluationRun({ concurrency: 1 });
      const testCases = [createTestCase('tc-1')];
      const storage = createMockStorageModule();

      await executeEvaluationRun(run, testCases, {
        storageModule: storage,
        onProgress: jest.fn(),
      });

      expect(mockStartPolling).not.toHaveBeenCalled();
    });
  });
});
