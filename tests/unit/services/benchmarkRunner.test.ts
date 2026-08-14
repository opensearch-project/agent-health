/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createCancellationToken,
  executeRun,
  runBenchmark,
  runSingleUseCase,
} from '@/services/benchmarkRunner';
import { Benchmark, BenchmarkRun, TestCase, BenchmarkProgress } from '@/types';

// Mock dependencies
const mockGetAllTestCasesWithClient = jest.fn();
const mockSaveReportWithClient = jest.fn();
const mockUpdateRunWithClient = jest.fn();
const mockUpdateBenchmarkRunStatsForReport = jest.fn();
const mockUpdateTestCaseLastRunAt = jest.fn().mockResolvedValue(undefined);

jest.mock('@/server/services/storage', () => ({
  getAllTestCasesWithClient: (...args: any[]) => mockGetAllTestCasesWithClient(...args),
  saveReportWithClient: (...args: any[]) => mockSaveReportWithClient(...args),
  updateRunWithClient: (...args: any[]) => mockUpdateRunWithClient(...args),
  updateBenchmarkRunStatsForReport: (...args: any[]) => mockUpdateBenchmarkRunStatsForReport(...args),
  updateTestCaseLastRunAt: (...args: any[]) => mockUpdateTestCaseLastRunAt(...args),
}));

// Mock OpenSearch client (used for executeRun / runBenchmark paths)
const mockClient = {} as any;

// Mock storage module (used for runSingleUseCase path)
const mockRunsCreate = jest.fn();
const mockRunsUpdate = jest.fn();
const mockTestCasesUpdate = jest.fn().mockResolvedValue(undefined);
const mockTestCasesGetById = jest.fn().mockResolvedValue({ id: 'tc-1', name: 'Test' });
const mockStorageModule = {
  runs: { create: mockRunsCreate, update: mockRunsUpdate },
  testCases: { update: mockTestCasesUpdate, getById: mockTestCasesGetById },
} as any;

const mockRunEvaluationWithConnector = jest.fn();
const mockInvokeAgent = jest.fn();
const mockCallBedrockJudge = jest.fn();

jest.mock('@/services/evaluation', () => ({
  ...jest.requireActual('@/services/evaluation'),
  runEvaluationWithConnector: (...args: any[]) => mockRunEvaluationWithConnector(...args),
  invokeAgent: (...args: any[]) => mockInvokeAgent(...args),
  callBedrockJudge: (...args: any[]) => mockCallBedrockJudge(...args),
}));

// Mock connector registry - use inline object to avoid hoisting issues
jest.mock('@/services/connectors/server', () => ({
  connectorRegistry: {
    getForAgent: jest.fn().mockReturnValue({ type: 'mock', name: 'Mock Connector' }),
  },
}));

const mockStartPolling = jest.fn();
const mockStartPollingAsync = jest.fn().mockResolvedValue(undefined);

jest.mock('@/services/traces/tracePoller', () => ({
  tracePollingManager: {
    startPolling: (...args: any[]) => mockStartPolling(...args),
    startPollingAsync: (...args: any[]) => mockStartPollingAsync(...args),
  },
}));

const mockGetCustomAgents = jest.fn().mockReturnValue([]);
jest.mock('@/server/services/customAgentStore', () => ({
  getCustomAgents: (...args: any[]) => mockGetCustomAgents(...args),
}));

const mockConfig = {
  agents: [
    {
      key: 'test-agent',
      name: 'Test Agent',
      endpoint: 'http://test-agent.example.com',
      headers: { 'X-Agent': 'test' },
    },
    {
      key: 'other-agent',
      name: 'Other Agent',
      endpoint: 'http://other-agent.example.com',
      headers: {},
    },
  ],
  models: {
    'claude-sonnet': {
      model_id: 'anthropic.claude-3-sonnet-20240229-v1:0',
      display_name: 'Claude Sonnet',
    },
    'claude-haiku': {
      model_id: 'anthropic.claude-3-haiku-20240307-v1:0',
      display_name: 'Claude Haiku',
    },
  },
};

jest.mock('@/lib/constants', () => ({
  get DEFAULT_CONFIG() { return mockConfig; },
}));

jest.mock('@/lib/config/index', () => ({
  loadConfigSync: () => mockConfig,
}));

// Silence console output
beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'info').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'debug').mockImplementation(() => {});
});

afterAll(() => {
  jest.restoreAllMocks();
});

// Test data
const createTestCase = (id: string): TestCase => ({
  id,
  name: `Test Case ${id}`,
  description: 'Test description',
  initialPrompt: 'Test prompt',
  context: [],
  expectedOutcomes: ['Expected outcome 1'],
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
  currentVersion: 1,
  versions: [{
    version: 1,
    createdAt: '2024-01-01T00:00:00.000Z',
    initialPrompt: 'Test prompt',
    context: [],
    expectedOutcomes: ['Expected outcome 1'],
  }],
  labels: [],
  category: 'RCA',
  difficulty: 'Medium',
  isPromoted: true,
});

const createExperiment = (testCaseIds: string[]): Benchmark => ({
  id: 'exp-1',
  name: 'Test Benchmark',
  description: 'Test experiment description',
  testCaseIds,
  runs: [],
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
  currentVersion: 1,
  versions: [{
    version: 1,
    createdAt: '2024-01-01T00:00:00.000Z',
    testCaseIds,
  }],
});

const createBenchmarkRun = (id: string): BenchmarkRun => ({
  id,
  name: 'Test Run',
  agentKey: 'test-agent',
  modelId: 'claude-sonnet',
  createdAt: '2024-01-01T00:00:00.000Z',
  results: {},
});

describe('Experiment Runner', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset mock implementations
    mockGetAllTestCasesWithClient.mockReset();
    mockSaveReportWithClient.mockReset();
    mockUpdateRunWithClient.mockReset();
    mockGetCustomAgents.mockReturnValue([]);
    mockRunsCreate.mockReset();
    mockRunsUpdate.mockReset();
    mockTestCasesUpdate.mockResolvedValue(undefined);
    mockTestCasesGetById.mockResolvedValue({ id: 'tc-1', name: 'Test' });
  });

  describe('createCancellationToken', () => {
    it('should create a token with isCancelled = false', () => {
      const token = createCancellationToken();
      expect(token.isCancelled).toBe(false);
    });

    it('should set isCancelled to true when cancel() is called', () => {
      const token = createCancellationToken();
      token.cancel();
      expect(token.isCancelled).toBe(true);
    });
  });

  describe('executeRun', () => {
    it('should execute all test cases in an experiment', async () => {
      const testCase1 = createTestCase('tc-1');
      const testCase2 = createTestCase('tc-2');
      const experiment = createExperiment(['tc-1', 'tc-2']);
      const run = createBenchmarkRun('run-1');

      mockGetAllTestCasesWithClient.mockResolvedValue([testCase1, testCase2]);
      mockRunEvaluationWithConnector.mockResolvedValue({
        id: 'report-1',
        trajectory: [],
        metrics: { accuracy: 0.9 },
      });
      mockSaveReportWithClient.mockResolvedValue({ id: 'saved-report-1', metricsStatus: 'ready' });

      const progressUpdates: BenchmarkProgress[] = [];
      const onProgress = (progress: BenchmarkProgress) => progressUpdates.push(progress);

      const result = await executeRun(experiment, run, onProgress, { client: mockClient });

      expect(mockGetAllTestCasesWithClient).toHaveBeenCalledWith(mockClient);
      expect(mockRunEvaluationWithConnector).toHaveBeenCalledTimes(2);
      expect(mockSaveReportWithClient).toHaveBeenCalledTimes(2);
      expect(result.results['tc-1'].status).toBe('completed');
      expect(result.results['tc-2'].status).toBe('completed');
      expect(progressUpdates.length).toBeGreaterThan(0);
    });

    it('forwards run-level judgeModelId to the judge and stamps it on the saved report (classic path)', async () => {
      // Regression: the classic path passed { evaluatorId, skipJudge } but
      // dropped judgeModelId, so --judge-model / the run-config judge model
      // never reached the judge via POST /benchmarks/:id/execute — the judge
      // silently fell back to BEDROCK_MODEL_ID or the agent's own model.
      const testCase1 = createTestCase('tc-1');
      const experiment = createExperiment(['tc-1']);
      const run = { ...createBenchmarkRun('run-1'), judgeModelId: 'judge-model-xyz', evaluatorId: 'eval-abc' };

      mockGetAllTestCasesWithClient.mockResolvedValue([testCase1]);
      mockRunEvaluationWithConnector.mockResolvedValue({
        id: 'report-1',
        trajectory: [],
        metrics: { accuracy: 0.9 },
      });
      mockSaveReportWithClient.mockImplementation((_c: any, report: any) =>
        Promise.resolve({ ...report, id: 'saved-report-1', metricsStatus: 'ready' }));

      await executeRun(experiment, run, jest.fn(), { client: mockClient });

      // 1) The judge options carry the run-level judgeModelId.
      const options = mockRunEvaluationWithConnector.mock.calls[0][4];
      expect(options.judgeModelId).toBe('judge-model-xyz');
      expect(options.evaluatorId).toBe('eval-abc');

      // 2) The report saved to storage is stamped with both (audit trail +
      //    trace-mode polled judge inputs).
      const savedReportArg = mockSaveReportWithClient.mock.calls[0][1];
      expect(savedReportArg.judgeModelId).toBe('judge-model-xyz');
      expect(savedReportArg.evaluatorId).toBe('eval-abc');
    });

    it('control inversion: deterministic body drives the agent via agent.run() (not the eager judge path)', async () => {
      const testCase1 = createTestCase('tc-1');
      const experiment = createExperiment(['tc-1']);
      const run = createBenchmarkRun('run-1');

      mockGetAllTestCasesWithClient.mockResolvedValue([testCase1]);
      // invokeAgent is the primitive the agent fixture calls.
      mockInvokeAgent.mockResolvedValue({
        trajectory: [{ type: 'response', content: 'Agent output' }],
        rawEvents: [],
        runId: null,
        agentDurationMs: 100,
        connector: { type: 'mock' },
      });
      mockSaveReportWithClient.mockImplementation((_c: any, report: any) =>
        Promise.resolve({ ...report, id: 'saved-report-1' }));

      let captured: any;
      const evaluateFnMap = new Map<string, (f: any) => Promise<void>>([
        ['tc-1', async (fixtures: any) => {
          captured = await fixtures.agent.run('Test prompt');
        }],
      ]);

      const result = await executeRun(experiment, run, jest.fn(), {
        client: mockClient,
        evaluateFnMap,
      });

      // The classic eager judge path must NOT run for code tests.
      expect(mockRunEvaluationWithConnector).not.toHaveBeenCalled();
      expect(mockInvokeAgent).toHaveBeenCalledTimes(1);
      expect(captured.agentOutput).toBe('Agent output');
      expect(result.results['tc-1'].status).toBe('completed');
      // Report records the deterministic verdict.
      const savedReport = mockSaveReportWithClient.mock.calls[0][1];
      expect(savedReport.evaluationType).toBe('deterministic');
      expect(savedReport.passFailStatus).toBe('passed');
    });

    it('should handle cancellation', async () => {
      const testCase1 = createTestCase('tc-1');
      const testCase2 = createTestCase('tc-2');
      const experiment = createExperiment(['tc-1', 'tc-2']);
      const run = createBenchmarkRun('run-1');
      const cancellationToken = createCancellationToken();

      mockGetAllTestCasesWithClient.mockResolvedValue([testCase1, testCase2]);
      mockRunEvaluationWithConnector.mockImplementation(async () => {
        cancellationToken.cancel(); // Cancel after first evaluation starts
        return { id: 'report-1', trajectory: [], metrics: {} };
      });
      mockSaveReportWithClient.mockResolvedValue({ id: 'saved-report-1', metricsStatus: 'ready' });

      const progressUpdates: BenchmarkProgress[] = [];
      const onProgress = (progress: BenchmarkProgress) => progressUpdates.push(progress);

      await executeRun(experiment, run, onProgress, { cancellationToken, client: mockClient });

      // Should have at least one cancelled progress update
      const cancelledProgress = progressUpdates.find(p => p.status === 'cancelled');
      expect(cancelledProgress).toBeDefined();
    });

    it('should handle missing test cases', async () => {
      const testCase1 = createTestCase('tc-1');
      const experiment = createExperiment(['tc-1', 'tc-missing']);
      const run = createBenchmarkRun('run-1');

      mockGetAllTestCasesWithClient.mockResolvedValue([testCase1]);
      mockRunEvaluationWithConnector.mockResolvedValue({ id: 'report-1', trajectory: [], metrics: {} });
      mockSaveReportWithClient.mockResolvedValue({ id: 'saved-report-1', metricsStatus: 'ready' });

      const onProgress = jest.fn();

      const result = await executeRun(experiment, run, onProgress, { client: mockClient });

      expect(result.results['tc-1'].status).toBe('completed');
      expect(result.results['tc-missing'].status).toBe('failed');
    });

    it('should handle evaluation errors', async () => {
      const testCase1 = createTestCase('tc-1');
      const experiment = createExperiment(['tc-1']);
      const run = createBenchmarkRun('run-1');

      mockGetAllTestCasesWithClient.mockResolvedValue([testCase1]);
      mockRunEvaluationWithConnector.mockRejectedValue(new Error('Evaluation failed'));

      const onProgress = jest.fn();

      const result = await executeRun(experiment, run, onProgress, { client: mockClient });

      expect(result.results['tc-1'].status).toBe('failed');
    });

    it('should apply agent endpoint overrides', async () => {
      const testCase1 = createTestCase('tc-1');
      const experiment = createExperiment(['tc-1']);
      const run: BenchmarkRun = {
        ...createBenchmarkRun('run-1'),
        agentEndpoint: 'http://custom-endpoint.example.com',
        headers: { 'X-Custom': 'value' },
      };

      mockGetAllTestCasesWithClient.mockResolvedValue([testCase1]);
      mockRunEvaluationWithConnector.mockResolvedValue({ id: 'report-1', trajectory: [], metrics: {} });
      mockSaveReportWithClient.mockResolvedValue({ id: 'saved-report-1', metricsStatus: 'ready' });

      await executeRun(experiment, run, jest.fn(), { client: mockClient });

      const agentConfigArg = mockRunEvaluationWithConnector.mock.calls[0][0];
      expect(agentConfigArg.endpoint).toBe('http://custom-endpoint.example.com');
      expect(agentConfigArg.headers).toEqual({ 'X-Agent': 'test', 'X-Custom': 'value' });
    });

    it('should resolve custom agents in benchmark execution', async () => {
      const customAgent = {
        key: 'custom-holmes',
        name: 'Holmes Agent',
        endpoint: 'http://holmes.example.com',
        headers: {},
      };
      mockGetCustomAgents.mockReturnValue([customAgent]);

      const testCase1 = createTestCase('tc-1');
      const experiment = createExperiment(['tc-1']);
      const run: BenchmarkRun = {
        ...createBenchmarkRun('run-1'),
        agentKey: 'custom-holmes',
      };

      mockGetAllTestCasesWithClient.mockResolvedValue([testCase1]);
      mockRunEvaluationWithConnector.mockResolvedValue({ id: 'report-1', trajectory: [], metrics: {} });
      mockSaveReportWithClient.mockResolvedValue({ id: 'saved-report-1', metricsStatus: 'ready' });

      const result = await executeRun(experiment, run, jest.fn(), { client: mockClient });

      expect(result.results['tc-1'].status).toBe('completed');
      const agentConfigArg = mockRunEvaluationWithConnector.mock.calls[0][0];
      expect(agentConfigArg.key).toBe('custom-holmes');
      expect(agentConfigArg.endpoint).toBe('http://holmes.example.com');
    });

    it('should throw error for unknown agent', async () => {
      const testCase1 = createTestCase('tc-1');
      const experiment = createExperiment(['tc-1']);
      const run: BenchmarkRun = {
        ...createBenchmarkRun('run-1'),
        agentKey: 'unknown-agent',
      };

      mockGetAllTestCasesWithClient.mockResolvedValue([testCase1]);

      const result = await executeRun(experiment, run, jest.fn(), { client: mockClient });

      // The error is caught and the test case is marked as failed
      expect(result.results['tc-1'].status).toBe('failed');
    });

    it('should start trace polling for pending reports', async () => {
      const testCase1 = createTestCase('tc-1');
      const experiment = createExperiment(['tc-1']);
      const run = createBenchmarkRun('run-1');

      mockGetAllTestCasesWithClient.mockResolvedValue([testCase1]);
      mockRunEvaluationWithConnector.mockResolvedValue({ id: 'report-1', trajectory: [], metrics: {} });
      mockSaveReportWithClient.mockResolvedValue({
        id: 'saved-report-1',
        runId: 'trace-run-id',
        metricsStatus: 'pending',
        agentKey: 'test-agent',
      });

      await executeRun(experiment, run, jest.fn(), { client: mockClient });

      expect(mockStartPollingAsync).toHaveBeenCalledWith(
        'saved-report-1',
        'trace-run-id',
        expect.objectContaining({
          onTracesFound: expect.any(Function),
          onAttempt: expect.any(Function),
          onError: expect.any(Function),
        }),
        expect.objectContaining({
          agentConfig: expect.any(Object),
        })
      );
    });

    it('should initialize results if empty', async () => {
      const testCase1 = createTestCase('tc-1');
      const experiment = createExperiment(['tc-1']);
      const run: BenchmarkRun = {
        id: 'run-1',
        name: 'Test Run',
        agentKey: 'test-agent',
        modelId: 'claude-sonnet',
        createdAt: '2024-01-01T00:00:00.000Z',
        // results is undefined
      } as BenchmarkRun;

      mockGetAllTestCasesWithClient.mockResolvedValue([testCase1]);
      mockRunEvaluationWithConnector.mockResolvedValue({ id: 'report-1', trajectory: [], metrics: {} });
      mockSaveReportWithClient.mockResolvedValue({ id: 'saved-report-1', metricsStatus: 'ready' });

      const result = await executeRun(experiment, run, jest.fn(), { client: mockClient });

      expect(result.results).toBeDefined();
      expect(result.results['tc-1'].status).toBe('completed');
    });

    it('should call onTestCaseComplete after each test case', async () => {
      const testCase1 = createTestCase('tc-1');
      const testCase2 = createTestCase('tc-2');
      const experiment = createExperiment(['tc-1', 'tc-2']);
      const run = createBenchmarkRun('run-1');

      mockGetAllTestCasesWithClient.mockResolvedValue([testCase1, testCase2]);
      mockRunEvaluationWithConnector.mockResolvedValue({
        id: 'report-1',
        trajectory: [],
        metrics: { accuracy: 0.9 },
      });
      mockSaveReportWithClient.mockResolvedValue({ id: 'saved-report-1', metricsStatus: 'ready' });

      const onTestCaseComplete = jest.fn().mockResolvedValue(undefined);
      const onProgress = jest.fn();

      await executeRun(experiment, run, onProgress, {
        client: mockClient,
        onTestCaseComplete,
      });

      // Should be called once per test case
      expect(onTestCaseComplete).toHaveBeenCalledTimes(2);
      expect(onTestCaseComplete).toHaveBeenCalledWith('tc-1', { reportId: 'saved-report-1', status: 'completed' });
      expect(onTestCaseComplete).toHaveBeenCalledWith('tc-2', { reportId: 'saved-report-1', status: 'completed' });
    });

    it('should continue execution if onTestCaseComplete fails', async () => {
      const testCase1 = createTestCase('tc-1');
      const testCase2 = createTestCase('tc-2');
      const experiment = createExperiment(['tc-1', 'tc-2']);
      const run = createBenchmarkRun('run-1');

      mockGetAllTestCasesWithClient.mockResolvedValue([testCase1, testCase2]);
      mockRunEvaluationWithConnector.mockResolvedValue({
        id: 'report-1',
        trajectory: [],
        metrics: { accuracy: 0.9 },
      });
      mockSaveReportWithClient.mockResolvedValue({ id: 'saved-report-1', metricsStatus: 'ready' });

      // First call fails, second succeeds
      const onTestCaseComplete = jest.fn()
        .mockRejectedValueOnce(new Error('Persist failed'))
        .mockResolvedValueOnce(undefined);
      const onProgress = jest.fn();

      // Should not throw
      const result = await executeRun(experiment, run, onProgress, {
        client: mockClient,
        onTestCaseComplete,
      });

      // Execution should complete normally
      expect(result.results['tc-1'].status).toBe('completed');
      expect(result.results['tc-2'].status).toBe('completed');
      expect(onTestCaseComplete).toHaveBeenCalledTimes(2);
    });

    it('should call onTestCaseComplete for failed test cases', async () => {
      const testCase1 = createTestCase('tc-1');
      const experiment = createExperiment(['tc-1']);
      const run = createBenchmarkRun('run-1');

      mockGetAllTestCasesWithClient.mockResolvedValue([testCase1]);
      mockRunEvaluationWithConnector.mockRejectedValue(new Error('Evaluation failed'));

      const onTestCaseComplete = jest.fn().mockResolvedValue(undefined);
      const onProgress = jest.fn();

      const result = await executeRun(experiment, run, onProgress, {
        client: mockClient,
        onTestCaseComplete,
      });

      // Should still call onTestCaseComplete with failed status and error message
      expect(onTestCaseComplete).toHaveBeenCalledTimes(1);
      expect(onTestCaseComplete).toHaveBeenCalledWith('tc-1', { reportId: '', status: 'failed', error: 'Evaluation failed' });
      expect(result.results['tc-1'].status).toBe('failed');
      expect(result.results['tc-1'].error).toBe('Evaluation failed');
    });

    it('should not call onTestCaseComplete if not provided', async () => {
      const testCase1 = createTestCase('tc-1');
      const experiment = createExperiment(['tc-1']);
      const run = createBenchmarkRun('run-1');

      mockGetAllTestCasesWithClient.mockResolvedValue([testCase1]);
      mockRunEvaluationWithConnector.mockResolvedValue({
        id: 'report-1',
        trajectory: [],
        metrics: { accuracy: 0.9 },
      });
      mockSaveReportWithClient.mockResolvedValue({ id: 'saved-report-1', metricsStatus: 'ready' });

      const onProgress = jest.fn();

      // Should not throw when onTestCaseComplete is not provided
      const result = await executeRun(experiment, run, onProgress, { client: mockClient });

      expect(result.results['tc-1'].status).toBe('completed');
    });
  });

  describe('executeRun with concurrency', () => {
    it('should default to sequential execution when concurrency is not set', async () => {
      const testCase1 = createTestCase('tc-1');
      const testCase2 = createTestCase('tc-2');
      const testCase3 = createTestCase('tc-3');
      const experiment = createExperiment(['tc-1', 'tc-2', 'tc-3']);
      const run = createBenchmarkRun('run-1');

      mockGetAllTestCasesWithClient.mockResolvedValue([testCase1, testCase2, testCase3]);

      // Track call order to verify sequential execution
      const callOrder: string[] = [];
      mockRunEvaluationWithConnector.mockImplementation(async (_agent: any, _model: any, tc: any) => {
        callOrder.push(`start-${tc.id}`);
        await new Promise(r => setTimeout(r, 10));
        callOrder.push(`end-${tc.id}`);
        return { id: `report-${tc.id}`, trajectory: [], metrics: {} };
      });
      mockSaveReportWithClient.mockResolvedValue({ id: 'saved-report-1', metricsStatus: 'ready' });

      await executeRun(experiment, run, jest.fn(), { client: mockClient });

      // With concurrency 1 (default), each test case should start after the previous one ends
      expect(callOrder).toEqual([
        'start-tc-1', 'end-tc-1',
        'start-tc-2', 'end-tc-2',
        'start-tc-3', 'end-tc-3',
      ]);
    });

    it('should run test cases in parallel when concurrency > 1', async () => {
      const testCase1 = createTestCase('tc-1');
      const testCase2 = createTestCase('tc-2');
      const testCase3 = createTestCase('tc-3');
      const experiment = createExperiment(['tc-1', 'tc-2', 'tc-3']);
      const run: BenchmarkRun = {
        ...createBenchmarkRun('run-1'),
        concurrency: 2,
      };

      mockGetAllTestCasesWithClient.mockResolvedValue([testCase1, testCase2, testCase3]);

      // Track maximum concurrent executions
      let currentConcurrent = 0;
      let maxConcurrent = 0;
      mockRunEvaluationWithConnector.mockImplementation(async (_agent: any, _model: any, tc: any) => {
        currentConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
        await new Promise(r => setTimeout(r, 50));
        currentConcurrent--;
        return { id: `report-${tc.id}`, trajectory: [], metrics: {} };
      });
      mockSaveReportWithClient.mockResolvedValue({ id: 'saved-report-1', metricsStatus: 'ready' });

      const result = await executeRun(experiment, run, jest.fn(), { client: mockClient });

      // Should have run at most 2 concurrently
      expect(maxConcurrent).toBe(2);
      // All should complete
      expect(result.results['tc-1'].status).toBe('completed');
      expect(result.results['tc-2'].status).toBe('completed');
      expect(result.results['tc-3'].status).toBe('completed');
    });

    it('should stop starting new tasks when cancelled during parallel execution', async () => {
      const testCase1 = createTestCase('tc-1');
      const testCase2 = createTestCase('tc-2');
      const testCase3 = createTestCase('tc-3');
      const experiment = createExperiment(['tc-1', 'tc-2', 'tc-3']);
      const run: BenchmarkRun = {
        ...createBenchmarkRun('run-1'),
        concurrency: 2,
      };
      const cancellationToken = createCancellationToken();

      mockGetAllTestCasesWithClient.mockResolvedValue([testCase1, testCase2, testCase3]);

      let evaluationCount = 0;
      mockRunEvaluationWithConnector.mockImplementation(async () => {
        evaluationCount++;
        if (evaluationCount === 1) {
          // Cancel after first evaluation starts
          cancellationToken.cancel();
        }
        await new Promise(r => setTimeout(r, 10));
        return { id: 'report-1', trajectory: [], metrics: {} };
      });
      mockSaveReportWithClient.mockResolvedValue({ id: 'saved-report-1', metricsStatus: 'ready' });

      const progressUpdates: BenchmarkProgress[] = [];
      await executeRun(experiment, run, (p) => progressUpdates.push(p), {
        cancellationToken,
        client: mockClient,
      });

      // Should not have run all 3 test cases
      expect(evaluationCount).toBeLessThanOrEqual(2);

      // Should have a cancelled progress event
      const cancelledProgress = progressUpdates.find(p => p.status === 'cancelled');
      expect(cancelledProgress).toBeDefined();
    });

    it('should include completedCount and startedCount in progress events', async () => {
      const testCase1 = createTestCase('tc-1');
      const testCase2 = createTestCase('tc-2');
      const experiment = createExperiment(['tc-1', 'tc-2']);
      const run: BenchmarkRun = {
        ...createBenchmarkRun('run-1'),
        concurrency: 1,
      };

      mockGetAllTestCasesWithClient.mockResolvedValue([testCase1, testCase2]);
      mockRunEvaluationWithConnector.mockResolvedValue({ id: 'report-1', trajectory: [], metrics: {} });
      mockSaveReportWithClient.mockResolvedValue({ id: 'saved-report-1', metricsStatus: 'ready' });

      const progressUpdates: BenchmarkProgress[] = [];
      await executeRun(experiment, run, (p) => progressUpdates.push(p), { client: mockClient });

      // Each running progress event should have startedCount and completedCount
      const runningUpdates = progressUpdates.filter(p => p.status === 'running');
      for (const p of runningUpdates) {
        expect(p.completedCount).toBeDefined();
        expect(typeof p.completedCount).toBe('number');
        expect(p.startedCount).toBeDefined();
        expect(typeof p.startedCount).toBe('number');
      }

      // Final progress should have completedCount = 2
      const finalProgress = progressUpdates[progressUpdates.length - 1];
      expect(finalProgress.completedCount).toBe(2);
    });

    it('should assign unique currentTestCaseIndex values under concurrency > 1', async () => {
      const testCase1 = createTestCase('tc-1');
      const testCase2 = createTestCase('tc-2');
      const testCase3 = createTestCase('tc-3');
      const experiment = createExperiment(['tc-1', 'tc-2', 'tc-3']);
      const run: BenchmarkRun = {
        ...createBenchmarkRun('run-1'),
        concurrency: 3,
      };

      mockGetAllTestCasesWithClient.mockResolvedValue([testCase1, testCase2, testCase3]);
      mockRunEvaluationWithConnector.mockImplementation(async () => {
        await new Promise(r => setTimeout(r, 20));
        return { id: 'report-1', trajectory: [], metrics: {} };
      });
      mockSaveReportWithClient.mockResolvedValue({ id: 'saved-report-1', metricsStatus: 'ready' });

      const progressUpdates: BenchmarkProgress[] = [];
      await executeRun(experiment, run, (p) => progressUpdates.push(p), { client: mockClient });

      // Extract the running progress events (one per test case start)
      const runningUpdates = progressUpdates.filter(p => p.status === 'running');
      const indexes = runningUpdates.map(p => p.currentTestCaseIndex);

      // Each started task should get a unique index
      expect(new Set(indexes).size).toBe(indexes.length);
    });

    it('should propagate shared throttle delay to concurrent tasks', async () => {
      const testCase1 = createTestCase('tc-1');
      const testCase2 = createTestCase('tc-2');
      const testCase3 = createTestCase('tc-3');
      const experiment = createExperiment(['tc-1', 'tc-2', 'tc-3']);
      const run: BenchmarkRun = {
        ...createBenchmarkRun('run-1'),
        concurrency: 1,
      };

      mockGetAllTestCasesWithClient.mockResolvedValue([testCase1, testCase2, testCase3]);

      // First call hits throttle, rest succeed
      mockRunEvaluationWithConnector
        .mockRejectedValueOnce(new Error('ThrottlingException: Rate exceeded'))
        .mockResolvedValueOnce({ id: 'report-2', trajectory: [], metrics: {} })
        .mockResolvedValueOnce({ id: 'report-3', trajectory: [], metrics: {} });
      mockSaveReportWithClient.mockResolvedValue({ id: 'saved-report-1', metricsStatus: 'ready' });

      const startTime = Date.now();
      await executeRun(experiment, run, jest.fn(), { client: mockClient });
      const elapsed = Date.now() - startTime;

      // The throttle delay should have added at least 5s
      expect(elapsed).toBeGreaterThanOrEqual(4900);

      // All test cases should have results
      expect(mockRunEvaluationWithConnector).toHaveBeenCalledTimes(3);
    }, 15000);

    it('should add throttle delay on rate limit errors during parallel execution', async () => {
      const testCase1 = createTestCase('tc-1');
      const testCase2 = createTestCase('tc-2');
      const experiment = createExperiment(['tc-1', 'tc-2']);
      const run: BenchmarkRun = {
        ...createBenchmarkRun('run-1'),
        concurrency: 2,
      };

      mockGetAllTestCasesWithClient.mockResolvedValue([testCase1, testCase2]);

      // First call throws throttling error, second succeeds
      mockRunEvaluationWithConnector
        .mockRejectedValueOnce(new Error('ThrottlingException: Rate exceeded'))
        .mockResolvedValueOnce({ id: 'report-2', trajectory: [], metrics: {} });
      mockSaveReportWithClient.mockResolvedValue({ id: 'saved-report-2', metricsStatus: 'ready' });

      const result = await executeRun(experiment, run, jest.fn(), { client: mockClient });

      // Both should have results (first failed, second completed)
      expect(result.results['tc-1'].status).toBe('failed');
      expect(result.results['tc-1'].error).toContain('ThrottlingException');
      expect(result.results['tc-2'].status).toBe('completed');
    });

    it('should increase backoff duration on consecutive throttle errors', async () => {
      const testCase1 = createTestCase('tc-1');
      const testCase2 = createTestCase('tc-2');
      const testCase3 = createTestCase('tc-3');
      const experiment = createExperiment(['tc-1', 'tc-2', 'tc-3']);
      const run: BenchmarkRun = {
        ...createBenchmarkRun('run-1'),
        concurrency: 1,
      };

      mockGetAllTestCasesWithClient.mockResolvedValue([testCase1, testCase2, testCase3]);

      // All calls throw throttle errors
      mockRunEvaluationWithConnector
        .mockRejectedValueOnce(new Error('ThrottlingException: Rate exceeded'))
        .mockRejectedValueOnce(new Error('ThrottlingException: Rate exceeded'))
        .mockResolvedValueOnce({ id: 'report-3', trajectory: [], metrics: {} });
      mockSaveReportWithClient.mockResolvedValue({ id: 'saved-report-1', metricsStatus: 'ready' });

      const startTime = Date.now();
      await executeRun(experiment, run, jest.fn(), { client: mockClient });
      const elapsed = Date.now() - startTime;

      // First throttle: 5s, second throttle: 10s (exponential) = 15s total minimum
      expect(elapsed).toBeGreaterThanOrEqual(14000);

      // All test cases should have results
      expect(Object.keys(run.results)).toHaveLength(3);
    }, 30000);

    it('should reduce throttle counter after successful completion', async () => {
      const testCase1 = createTestCase('tc-1');
      const testCase2 = createTestCase('tc-2');
      const testCase3 = createTestCase('tc-3');
      const experiment = createExperiment(['tc-1', 'tc-2', 'tc-3']);
      const run: BenchmarkRun = {
        ...createBenchmarkRun('run-1'),
        concurrency: 1,
      };

      mockGetAllTestCasesWithClient.mockResolvedValue([testCase1, testCase2, testCase3]);

      // First throttle, second succeeds, third throttle (should use reduced backoff)
      mockRunEvaluationWithConnector
        .mockRejectedValueOnce(new Error('ThrottlingException: Rate exceeded'))
        .mockResolvedValueOnce({ id: 'report-2', trajectory: [], metrics: {} })
        .mockRejectedValueOnce(new Error('ThrottlingException: Rate exceeded'));
      mockSaveReportWithClient.mockResolvedValue({ id: 'saved-report-1', metricsStatus: 'ready' });

      const startTime = Date.now();
      await executeRun(experiment, run, jest.fn(), { client: mockClient });
      const elapsed = Date.now() - startTime;

      // First throttle: 5s, success reduces counter, third throttle: 5s (reset, not 10s)
      // Total ~10s, not 15s
      expect(elapsed).toBeGreaterThanOrEqual(9000);
      expect(elapsed).toBeLessThan(14000);

      // All test cases should have results
      expect(run.results['tc-1'].status).toBe('failed');
      expect(run.results['tc-2'].status).toBe('completed');
      expect(run.results['tc-3'].status).toBe('failed');
    }, 20000);
  });

  describe('runBenchmark', () => {
    it('should create and execute a new run', async () => {
      const testCase1 = createTestCase('tc-1');
      const experiment = createExperiment(['tc-1']);
      const runConfig = {
        name: 'New Run',
        agentKey: 'test-agent',
        modelId: 'claude-sonnet',
      };

      mockGetAllTestCasesWithClient.mockResolvedValue([testCase1]);
      mockRunEvaluationWithConnector.mockResolvedValue({ id: 'report-1', trajectory: [], metrics: {} });
      mockSaveReportWithClient.mockResolvedValue({ id: 'saved-report-1', metricsStatus: 'ready' });

      const onProgress = jest.fn();

      const result = await runBenchmark(experiment, runConfig, onProgress, mockClient);

      expect(result.id).toMatch(/^run-\d+-[a-z0-9]+$/);
      expect(result.name).toBe('New Run');
      expect(result.createdAt).toBeDefined();
      expect(result.results['tc-1']).toBeDefined();
    });

    it('should initialize all test cases as pending', async () => {
      const testCase1 = createTestCase('tc-1');
      const testCase2 = createTestCase('tc-2');
      const experiment = createExperiment(['tc-1', 'tc-2']);
      const runConfig = {
        name: 'New Run',
        agentKey: 'test-agent',
        modelId: 'claude-sonnet',
      };

      mockGetAllTestCasesWithClient.mockResolvedValue([testCase1, testCase2]);
      mockRunEvaluationWithConnector.mockResolvedValue({ id: 'report-1', trajectory: [], metrics: {} });
      mockSaveReportWithClient.mockResolvedValue({ id: 'saved-report-1', metricsStatus: 'ready' });

      const onProgress = jest.fn();

      // We need to check initial state before execution completes
      // The function initializes all as pending, then executes
      await runBenchmark(experiment, runConfig, onProgress, mockClient);

      // Check that execution happened for both
      expect(mockRunEvaluationWithConnector).toHaveBeenCalledTimes(2);
    });
  });

  describe('runSingleUseCase', () => {
    it('should run a single test case and return report ID', async () => {
      const testCase = createTestCase('tc-1');
      const run = createBenchmarkRun('run-1');

      mockRunEvaluationWithConnector.mockResolvedValue({
        id: 'report-1',
        trajectory: [{ type: 'response', content: 'Test' }],
        metrics: { accuracy: 0.95 },
      });
      mockRunsCreate.mockResolvedValue({ id: 'saved-report-1', metricsStatus: 'ready' });

      const onStep = jest.fn();
      const reportId = await runSingleUseCase(run, testCase, mockStorageModule, onStep);

      expect(reportId).toBe('saved-report-1');
      expect(mockRunEvaluationWithConnector).toHaveBeenCalledWith(
        expect.objectContaining({ endpoint: 'http://test-agent.example.com' }),
        'anthropic.claude-3-sonnet-20240229-v1:0',
        testCase,
        onStep,
        expect.objectContaining({ registry: expect.any(Object) })
      );
    });

    it('should use empty callback when onStep is not provided', async () => {
      const testCase = createTestCase('tc-1');
      const run = createBenchmarkRun('run-1');

      mockRunEvaluationWithConnector.mockResolvedValue({
        id: 'report-1',
        trajectory: [],
        metrics: {},
      });
      mockRunsCreate.mockResolvedValue({ id: 'saved-report-1', metricsStatus: 'ready' });

      const reportId = await runSingleUseCase(run, testCase, mockStorageModule);

      expect(reportId).toBe('saved-report-1');
      // The callback should be a no-op function
      const callbackArg = mockRunEvaluationWithConnector.mock.calls[0][3];
      expect(typeof callbackArg).toBe('function');
    });

    it('should start trace polling for pending reports', async () => {
      const testCase = createTestCase('tc-1');
      const run = createBenchmarkRun('run-1');

      mockRunEvaluationWithConnector.mockResolvedValue({ id: 'report-1', trajectory: [], metrics: {}, runId: 'trace-run-id', metricsStatus: 'pending' });
      mockRunsCreate.mockResolvedValue({ id: 'saved-report-1' });

      await runSingleUseCase(run, testCase, mockStorageModule);

      expect(mockStartPollingAsync).toHaveBeenCalled();
    });

    it('should not await trace polling when awaitTraces is false (UI mode)', async () => {
      const testCase = createTestCase('tc-1');
      const run = createBenchmarkRun('run-1');

      // Track if startPollingAsync was called, but resolve eventually to not hang Jest
      let pollingCalled = false;
      mockStartPollingAsync.mockImplementation(() => {
        pollingCalled = true;
        // Resolve after a delay — but runSingleUseCase should NOT wait for it
        return new Promise<void>((resolve) => setTimeout(resolve, 100));
      });

      mockRunEvaluationWithConnector.mockResolvedValue({ id: 'report-1', trajectory: [], metrics: {}, runId: 'trace-run-id', metricsStatus: 'pending' });
      mockRunsCreate.mockResolvedValue({ id: 'saved-report-1' });

      // Measure time — with awaitTraces: false, should return nearly instantly
      const start = Date.now();
      const reportId = await runSingleUseCase(run, testCase, mockStorageModule, undefined, undefined, undefined, { awaitTraces: false });
      const elapsed = Date.now() - start;

      expect(reportId).toBe('saved-report-1');
      expect(pollingCalled).toBe(true); // Polling was started (fire-and-forget)
      expect(elapsed).toBeLessThan(50); // Should return immediately, not wait 100ms
    });

    it('should resolve model key to model ID', async () => {
      const testCase = createTestCase('tc-1');
      const run: BenchmarkRun = {
        ...createBenchmarkRun('run-1'),
        modelId: 'claude-haiku',
      };

      mockRunEvaluationWithConnector.mockResolvedValue({ id: 'report-1', trajectory: [], metrics: {} });
      mockRunsCreate.mockResolvedValue({ id: 'saved-report-1', metricsStatus: 'ready' });

      await runSingleUseCase(run, testCase, mockStorageModule);

      expect(mockRunEvaluationWithConnector).toHaveBeenCalledWith(
        expect.any(Object),
        'anthropic.claude-3-haiku-20240307-v1:0',
        expect.any(Object),
        expect.any(Function),
        expect.objectContaining({ registry: expect.any(Object) })
      );
    });

    it('should preserve agent hooks through buildAgentConfigForRun into runEvaluationWithConnector', async () => {
      // Add hooks to the mock config agent
      const mockHook = jest.fn().mockImplementation(async (ctx: any) => ctx);
      const originalAgent = mockConfig.agents[0];
      mockConfig.agents[0] = {
        ...originalAgent,
        hooks: { beforeRequest: mockHook },
      };

      const testCase = createTestCase('tc-1');
      const run = createBenchmarkRun('run-1');

      mockRunEvaluationWithConnector.mockResolvedValue({
        id: 'report-1',
        trajectory: [],
        metrics: {},
      });
      mockRunsCreate.mockResolvedValue({ id: 'saved-report-1', metricsStatus: 'ready' });

      await runSingleUseCase(run, testCase, mockStorageModule);

      // Verify the agent config passed to runEvaluationWithConnector includes hooks
      const agentConfigArg = mockRunEvaluationWithConnector.mock.calls[0][0];
      expect(agentConfigArg.hooks).toBeDefined();
      expect(agentConfigArg.hooks.beforeRequest).toBe(mockHook);

      // Restore original agent config
      mockConfig.agents[0] = originalAgent;
    });

    it('should resolve custom agents from customAgentStore', async () => {
      const customAgent = {
        key: 'custom-holmes',
        name: 'Holmes Agent',
        endpoint: 'http://holmes.example.com',
        headers: { 'X-Holmes': 'true' },
      };
      mockGetCustomAgents.mockReturnValue([customAgent]);

      const testCase = createTestCase('tc-1');
      const run: BenchmarkRun = {
        ...createBenchmarkRun('run-1'),
        agentKey: 'custom-holmes',
      };

      mockRunEvaluationWithConnector.mockResolvedValue({ id: 'report-1', trajectory: [], metrics: {} });
      mockRunsCreate.mockResolvedValue({ id: 'saved-report-1', metricsStatus: 'ready' });

      const reportId = await runSingleUseCase(run, testCase, mockStorageModule);

      expect(reportId).toBe('saved-report-1');
      const agentConfigArg = mockRunEvaluationWithConnector.mock.calls[0][0];
      expect(agentConfigArg.key).toBe('custom-holmes');
      expect(agentConfigArg.endpoint).toBe('http://holmes.example.com');
      expect(agentConfigArg.headers).toEqual({ 'X-Holmes': 'true' });
    });

    it('should apply endpoint override for custom agents', async () => {
      const customAgent = {
        key: 'custom-holmes',
        name: 'Holmes Agent',
        endpoint: 'http://holmes.example.com',
        headers: {},
      };
      mockGetCustomAgents.mockReturnValue([customAgent]);

      const testCase = createTestCase('tc-1');
      const run: BenchmarkRun = {
        ...createBenchmarkRun('run-1'),
        agentKey: 'custom-holmes',
        agentEndpoint: 'http://override.example.com',
      };

      mockRunEvaluationWithConnector.mockResolvedValue({ id: 'report-1', trajectory: [], metrics: {} });
      mockRunsCreate.mockResolvedValue({ id: 'saved-report-1', metricsStatus: 'ready' });

      await runSingleUseCase(run, testCase, mockStorageModule);

      const agentConfigArg = mockRunEvaluationWithConnector.mock.calls[0][0];
      expect(agentConfigArg.endpoint).toBe('http://override.example.com');
    });

    it('should not call update when test case is not persisted', async () => {
      mockTestCasesGetById.mockResolvedValue(null); // not in storage
      const testCase = createTestCase('tc-inline');
      const run = createBenchmarkRun('run-1');

      mockRunEvaluationWithConnector.mockResolvedValue({
        id: 'report-1',
        trajectory: [],
        metrics: {},
      });
      mockRunsCreate.mockResolvedValue({ id: 'saved-report-1', metricsStatus: 'ready' });

      await runSingleUseCase(run, testCase, mockStorageModule);

      // Wait for the fire-and-forget promise chain to settle
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mockTestCasesGetById).toHaveBeenCalledWith('tc-inline');
      expect(mockTestCasesUpdate).not.toHaveBeenCalled();
    });

    it('should use raw model key if not found in config', async () => {
      const testCase = createTestCase('tc-1');
      const run: BenchmarkRun = {
        ...createBenchmarkRun('run-1'),
        modelId: 'unknown-model-key',
      };

      mockRunEvaluationWithConnector.mockResolvedValue({ id: 'report-1', trajectory: [], metrics: {} });
      mockRunsCreate.mockResolvedValue({ id: 'saved-report-1', metricsStatus: 'ready' });

      await runSingleUseCase(run, testCase, mockStorageModule);

      expect(mockRunEvaluationWithConnector).toHaveBeenCalledWith(
        expect.any(Object),
        'unknown-model-key', // Falls back to raw key
        expect.any(Object),
        expect.any(Function),
        expect.objectContaining({ registry: expect.any(Object) })
      );
    });

    it('should update existing report when existingReportId is provided', async () => {
      const testCase = createTestCase('tc-1');
      const run = createBenchmarkRun('run-1');

      mockRunEvaluationWithConnector.mockResolvedValue({
        id: 'report-1',
        status: 'completed',
        passFailStatus: 'passed',
        trajectory: [{ type: 'response', content: 'Done' }],
        metrics: { accuracy: 0.9 },
        llmJudgeReasoning: 'Good job',
        runId: 'trace-123',
      });
      mockRunsUpdate.mockResolvedValue({ id: 'existing-report-id', timestamp: '2024-01-01T00:00:00Z' });

      const reportId = await runSingleUseCase(run, testCase, mockStorageModule, undefined, undefined, 'existing-report-id');

      expect(reportId).toBe('existing-report-id');
      expect(mockRunsUpdate).toHaveBeenCalledWith('existing-report-id', expect.objectContaining({
        status: 'completed',
        passFailStatus: 'passed',
        llmJudgeReasoning: 'Good job',
        // The connector's runId is now persisted as `runId` (Strategy B
        // trace correlation), NOT mis-stamped into `traceId`. `traceId`
        // stays undefined until a real W3C trace id is available from
        // polled spans. See #190 / #264.
        runId: 'trace-123',
      }));
      expect(mockRunsCreate).not.toHaveBeenCalled();
    });
  });

  describe('performance metrics', () => {
    it('should populate run-level performanceMetrics after completion', async () => {
      const testCase1 = createTestCase('tc-1');
      const testCase2 = createTestCase('tc-2');
      const experiment = createExperiment(['tc-1', 'tc-2']);
      const run = createBenchmarkRun('run-1');

      mockGetAllTestCasesWithClient.mockResolvedValue([testCase1, testCase2]);
      mockRunEvaluationWithConnector.mockResolvedValue({
        id: 'report-1',
        trajectory: [],
        metrics: { accuracy: 0.9 },
        performanceMetrics: {
          durationMs: 1000,
          agentDurationMs: 800,
          judgeDurationMs: 150,
          judgeAttempts: 1,
        },
      });
      mockSaveReportWithClient.mockResolvedValue({ id: 'saved-report-1', metricsStatus: 'ready' });

      const result = await executeRun(experiment, run, jest.fn(), { client: mockClient });

      expect(result.performanceMetrics).toBeDefined();
      expect(result.performanceMetrics!.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.performanceMetrics!.concurrency).toBe(1);
      expect(result.performanceMetrics!.avgTestCaseDurationMs).toBe(1000);
      expect(result.performanceMetrics!.maxTestCaseDurationMs).toBe(1000);
      expect(result.performanceMetrics!.minTestCaseDurationMs).toBe(1000);
    });

    it('should include per-test-case performanceMetrics in results', async () => {
      const testCase1 = createTestCase('tc-1');
      const experiment = createExperiment(['tc-1']);
      const run = createBenchmarkRun('run-1');

      mockGetAllTestCasesWithClient.mockResolvedValue([testCase1]);
      mockRunEvaluationWithConnector.mockResolvedValue({
        id: 'report-1',
        trajectory: [],
        metrics: { accuracy: 0.9 },
        performanceMetrics: {
          durationMs: 500,
          agentDurationMs: 400,
          judgeDurationMs: 80,
          judgeAttempts: 1,
        },
      });
      mockSaveReportWithClient.mockResolvedValue({ id: 'saved-report-1', metricsStatus: 'ready' });

      const result = await executeRun(experiment, run, jest.fn(), { client: mockClient });

      expect(result.results['tc-1'].performanceMetrics).toBeDefined();
      expect(result.results['tc-1'].performanceMetrics!.durationMs).toBe(500);
      expect(result.results['tc-1'].performanceMetrics!.agentDurationMs).toBe(400);
      expect(result.results['tc-1'].performanceMetrics!.judgeDurationMs).toBe(80);
      expect(result.results['tc-1'].performanceMetrics!.judgeAttempts).toBe(1);
    });

    it('should compute correct aggregate with varying durations', async () => {
      const testCase1 = createTestCase('tc-1');
      const testCase2 = createTestCase('tc-2');
      const testCase3 = createTestCase('tc-3');
      const experiment = createExperiment(['tc-1', 'tc-2', 'tc-3']);
      const run = createBenchmarkRun('run-1');

      mockGetAllTestCasesWithClient.mockResolvedValue([testCase1, testCase2, testCase3]);

      let callCount = 0;
      mockRunEvaluationWithConnector.mockImplementation(async () => {
        callCount++;
        const durations = [1000, 2000, 3000];
        return {
          id: `report-${callCount}`,
          trajectory: [],
          metrics: { accuracy: 0.9 },
          performanceMetrics: {
            durationMs: durations[callCount - 1],
            agentDurationMs: durations[callCount - 1] - 200,
          },
        };
      });
      mockSaveReportWithClient.mockResolvedValue({ id: 'saved-report-1', metricsStatus: 'ready' });

      const result = await executeRun(experiment, run, jest.fn(), { client: mockClient });

      expect(result.performanceMetrics!.avgTestCaseDurationMs).toBe(2000);
      expect(result.performanceMetrics!.minTestCaseDurationMs).toBe(1000);
      expect(result.performanceMetrics!.maxTestCaseDurationMs).toBe(3000);
    });

    it('should record concurrency in performanceMetrics', async () => {
      const testCase1 = createTestCase('tc-1');
      const experiment = createExperiment(['tc-1']);
      const run: BenchmarkRun = {
        ...createBenchmarkRun('run-1'),
        concurrency: 3,
      };

      mockGetAllTestCasesWithClient.mockResolvedValue([testCase1]);
      mockRunEvaluationWithConnector.mockResolvedValue({
        id: 'report-1',
        trajectory: [],
        metrics: {},
        performanceMetrics: { durationMs: 500, agentDurationMs: 400 },
      });
      mockSaveReportWithClient.mockResolvedValue({ id: 'saved-report-1', metricsStatus: 'ready' });

      const result = await executeRun(experiment, run, jest.fn(), { client: mockClient });

      expect(result.performanceMetrics!.concurrency).toBe(3);
    });

    it('should handle mixed success/failure results in aggregate', async () => {
      const testCase1 = createTestCase('tc-1');
      const testCase2 = createTestCase('tc-2');
      const experiment = createExperiment(['tc-1', 'tc-2']);
      const run = createBenchmarkRun('run-1');

      mockGetAllTestCasesWithClient.mockResolvedValue([testCase1, testCase2]);

      // First succeeds with metrics, second fails (no metrics)
      mockRunEvaluationWithConnector
        .mockResolvedValueOnce({
          id: 'report-1',
          trajectory: [],
          metrics: { accuracy: 0.9 },
          performanceMetrics: { durationMs: 1500, agentDurationMs: 1200 },
        })
        .mockRejectedValueOnce(new Error('Agent failed'));
      mockSaveReportWithClient.mockResolvedValue({ id: 'saved-report-1', metricsStatus: 'ready' });

      const result = await executeRun(experiment, run, jest.fn(), { client: mockClient });

      // Aggregate should only include successful test case durations
      expect(result.performanceMetrics!.avgTestCaseDurationMs).toBe(1500);
      expect(result.performanceMetrics!.minTestCaseDurationMs).toBe(1500);
      expect(result.performanceMetrics!.maxTestCaseDurationMs).toBe(1500);
      // Failed test case should not have performanceMetrics
      expect(result.results['tc-2'].performanceMetrics).toBeUndefined();
    });

    it('should set zero aggregates when no test cases have metrics', async () => {
      const testCase1 = createTestCase('tc-1');
      const experiment = createExperiment(['tc-1']);
      const run = createBenchmarkRun('run-1');

      mockGetAllTestCasesWithClient.mockResolvedValue([testCase1]);
      mockRunEvaluationWithConnector.mockRejectedValue(new Error('All failed'));

      const result = await executeRun(experiment, run, jest.fn(), { client: mockClient });

      expect(result.performanceMetrics!.avgTestCaseDurationMs).toBe(0);
      expect(result.performanceMetrics!.minTestCaseDurationMs).toBe(0);
      expect(result.performanceMetrics!.maxTestCaseDurationMs).toBe(0);
    });
  });

  describe('trace polling callbacks', () => {
    it('should call Bedrock judge when traces are found', async () => {
      const testCase = createTestCase('tc-1');
      const experiment = createExperiment(['tc-1']);
      const run = createBenchmarkRun('run-1');

      mockGetAllTestCasesWithClient.mockResolvedValue([testCase]);
      mockRunEvaluationWithConnector.mockResolvedValue({ id: 'report-1', trajectory: [], modelId: 'claude-sonnet' });
      mockSaveReportWithClient.mockResolvedValue({
        id: 'saved-report-1',
        runId: 'trace-run-id',
        metricsStatus: 'pending',
        modelId: 'claude-sonnet',
        agentKey: 'test-agent',
        trajectory: [],
      });
      mockCallBedrockJudge.mockResolvedValue({
        passFailStatus: 'passed',
        metrics: { accuracy: 95 },
        llmJudgeReasoning: 'Test passed',
        improvementStrategies: [],
      });

      await executeRun(experiment, run, jest.fn(), { client: mockClient });

      // Get the callbacks passed to startPollingAsync
      const startPollingCall = mockStartPollingAsync.mock.calls[0];
      const callbacks = startPollingCall[2];

      // Simulate traces being found
      const spans = [{ traceId: 'trace-1', name: 'test-span' }];
      const updatedReport = {
        id: 'saved-report-1',
        trajectory: [{ type: 'response', content: 'Traced response' }],
      };

      await callbacks.onTracesFound(spans, updatedReport);

      expect(mockCallBedrockJudge).toHaveBeenCalledWith(
        updatedReport.trajectory,
        expect.objectContaining({
          expectedOutcomes: testCase.expectedOutcomes,
        }),
        [],
        expect.any(Function),
        'anthropic.claude-3-sonnet-20240229-v1:0',
        // evaluatorId (undefined in this fixture), runId, and the Strategy C
        // `agents` hints are now forwarded so the agent (trace) judge can
        // scope its query_spans/query_logs tools. See #264.
        undefined,
        expect.any(String),
        expect.any(Array)
      );

      expect(mockUpdateRunWithClient).toHaveBeenCalledWith(mockClient, 'saved-report-1', expect.objectContaining({
        metricsStatus: 'ready',
        passFailStatus: 'passed',
      }));
    });

    it('should handle judge errors gracefully', async () => {
      const testCase = createTestCase('tc-1');
      const experiment = createExperiment(['tc-1']);
      const run = createBenchmarkRun('run-1');

      mockGetAllTestCasesWithClient.mockResolvedValue([testCase]);
      mockRunEvaluationWithConnector.mockResolvedValue({ id: 'report-1', trajectory: [] });
      mockSaveReportWithClient.mockResolvedValue({
        id: 'saved-report-1',
        runId: 'trace-run-id',
        metricsStatus: 'pending',
      });
      mockCallBedrockJudge.mockRejectedValue(new Error('Judge failed'));

      await executeRun(experiment, run, jest.fn(), { client: mockClient });

      // Get the callbacks
      const callbacks = mockStartPollingAsync.mock.calls[0][2];

      // Simulate traces being found
      await callbacks.onTracesFound([], { id: 'saved-report-1', trajectory: [] });

      expect(mockUpdateRunWithClient).toHaveBeenCalledWith(mockClient, 'saved-report-1', expect.objectContaining({
        metricsStatus: 'error',
        traceError: expect.stringContaining('Judge evaluation failed'),
      }));
    });

    it('should not start polling if runId is missing', async () => {
      const testCase = createTestCase('tc-1');
      const run = createBenchmarkRun('run-1');

      mockRunEvaluationWithConnector.mockResolvedValue({ id: 'report-1', trajectory: [], metricsStatus: 'pending' });
      mockRunsCreate.mockResolvedValue({ id: 'saved-report-1' });

      await runSingleUseCase(run, testCase, mockStorageModule);

      expect(mockStartPollingAsync).not.toHaveBeenCalled();
    });

    it('should call onAttempt callback during polling', async () => {
      const testCase = createTestCase('tc-1');
      const experiment = createExperiment(['tc-1']);
      const run = createBenchmarkRun('run-1');

      mockGetAllTestCasesWithClient.mockResolvedValue([testCase]);
      mockRunEvaluationWithConnector.mockResolvedValue({ id: 'report-1', trajectory: [] });
      mockSaveReportWithClient.mockResolvedValue({
        id: 'saved-report-1',
        runId: 'trace-run-id',
        metricsStatus: 'pending',
      });

      await executeRun(experiment, run, jest.fn(), { client: mockClient });

      // Get the callbacks
      const callbacks = mockStartPollingAsync.mock.calls[0][2];

      // Simulate attempt callback - now a no-op (no verbose logging)
      callbacks.onAttempt(1, 10);

      // Verify callback exists and is callable
      expect(typeof callbacks.onAttempt).toBe('function');
    });

    it('should call onError callback when polling fails', async () => {
      const testCase = createTestCase('tc-1');
      const experiment = createExperiment(['tc-1']);
      const run = createBenchmarkRun('run-1');

      mockGetAllTestCasesWithClient.mockResolvedValue([testCase]);
      mockRunEvaluationWithConnector.mockResolvedValue({ id: 'report-1', trajectory: [] });
      mockSaveReportWithClient.mockResolvedValue({
        id: 'saved-report-1',
        runId: 'trace-run-id',
        metricsStatus: 'pending',
      });

      await executeRun(experiment, run, jest.fn(), { client: mockClient });

      // Get the callbacks
      const callbacks = mockStartPollingAsync.mock.calls[0][2];

      // Simulate error callback
      callbacks.onError(new Error('Polling failed'));

      // Verify console.error was called
      expect(console.error).toHaveBeenCalled();
    });

    it('should wait for trace polling to complete before returning from executeRun', async () => {
      const testCase = createTestCase('tc-1');
      const experiment = createExperiment(['tc-1']);
      const run = createBenchmarkRun('run-1');

      // Track execution order
      const executionOrder: string[] = [];

      mockGetAllTestCasesWithClient.mockResolvedValue([testCase]);
      mockRunEvaluationWithConnector.mockResolvedValue({ id: 'report-1', trajectory: [] });
      mockSaveReportWithClient.mockResolvedValue({
        id: 'saved-report-1',
        runId: 'trace-run-id',
        metricsStatus: 'pending',
      });

      // Make startPollingAsync take some time to resolve
      mockStartPollingAsync.mockImplementation(() => {
        return new Promise<void>((resolve) => {
          setTimeout(() => {
            executionOrder.push('polling-resolved');
            resolve();
          }, 50);
        });
      });

      const resultPromise = executeRun(experiment, run, jest.fn(), { client: mockClient });
      await resultPromise;
      executionOrder.push('executeRun-returned');

      // executeRun should have waited for polling to resolve
      expect(executionOrder).toEqual(['polling-resolved', 'executeRun-returned']);
    });

    it('should handle trace polling rejection gracefully in executeRun', async () => {
      const testCase = createTestCase('tc-1');
      const experiment = createExperiment(['tc-1']);
      const run = createBenchmarkRun('run-1');

      mockGetAllTestCasesWithClient.mockResolvedValue([testCase]);
      mockRunEvaluationWithConnector.mockResolvedValue({ id: 'report-1', trajectory: [] });
      mockSaveReportWithClient.mockResolvedValue({
        id: 'saved-report-1',
        runId: 'trace-run-id',
        metricsStatus: 'pending',
      });

      // Make startPollingAsync reject
      mockStartPollingAsync.mockRejectedValue(new Error('Traces unavailable'));

      // executeRun should NOT throw — it uses Promise.allSettled
      const result = await executeRun(experiment, run, jest.fn(), { client: mockClient });
      expect(result).toBeDefined();
      expect(result.results['tc-1'].status).toBe('completed');
    });
  });

});
