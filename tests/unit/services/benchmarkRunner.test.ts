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

jest.mock('@/server/services/storage', () => ({
  getAllTestCasesWithClient: (...args: any[]) => mockGetAllTestCasesWithClient(...args),
  saveReportWithClient: (...args: any[]) => mockSaveReportWithClient(...args),
  updateRunWithClient: (...args: any[]) => mockUpdateRunWithClient(...args),
}));

// Mock OpenSearch client
const mockClient = {} as any;

const mockRunEvaluationWithConnector = jest.fn();
const mockCallBedrockJudge = jest.fn();

jest.mock('@/services/evaluation', () => ({
  runEvaluationWithConnector: (...args: any[]) => mockRunEvaluationWithConnector(...args),
  callBedrockJudge: (...args: any[]) => mockCallBedrockJudge(...args),
}));

// Mock connector registry - use inline object to avoid hoisting issues
jest.mock('@/services/connectors/server', () => ({
  connectorRegistry: {
    getForAgent: jest.fn().mockReturnValue({ type: 'mock', name: 'Mock Connector' }),
  },
}));

const mockStartPolling = jest.fn();

jest.mock('@/services/traces/tracePoller', () => ({
  tracePollingManager: {
    startPolling: (...args: any[]) => mockStartPolling(...args),
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
      });

      await executeRun(experiment, run, jest.fn(), { client: mockClient });

      expect(mockStartPolling).toHaveBeenCalledWith(
        'saved-report-1',
        'trace-run-id',
        expect.objectContaining({
          onTracesFound: expect.any(Function),
          onAttempt: expect.any(Function),
          onError: expect.any(Function),
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

      // Should still call onTestCaseComplete with failed status
      expect(onTestCaseComplete).toHaveBeenCalledTimes(1);
      expect(onTestCaseComplete).toHaveBeenCalledWith('tc-1', { reportId: '', status: 'failed' });
      expect(result.results['tc-1'].status).toBe('failed');
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
      mockSaveReportWithClient.mockResolvedValue({ id: 'saved-report-1', metricsStatus: 'ready' });

      const onStep = jest.fn();
      const reportId = await runSingleUseCase(run, testCase, mockClient, onStep);

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
      mockSaveReportWithClient.mockResolvedValue({ id: 'saved-report-1', metricsStatus: 'ready' });

      const reportId = await runSingleUseCase(run, testCase, mockClient);

      expect(reportId).toBe('saved-report-1');
      // The callback should be a no-op function
      const callbackArg = mockRunEvaluationWithConnector.mock.calls[0][3];
      expect(typeof callbackArg).toBe('function');
    });

    it('should start trace polling for pending reports', async () => {
      const testCase = createTestCase('tc-1');
      const run = createBenchmarkRun('run-1');

      mockRunEvaluationWithConnector.mockResolvedValue({ id: 'report-1', trajectory: [], metrics: {} });
      mockSaveReportWithClient.mockResolvedValue({
        id: 'saved-report-1',
        runId: 'trace-run-id',
        metricsStatus: 'pending',
      });

      await runSingleUseCase(run, testCase, mockClient);

      expect(mockStartPolling).toHaveBeenCalled();
    });

    it('should resolve model key to model ID', async () => {
      const testCase = createTestCase('tc-1');
      const run: BenchmarkRun = {
        ...createBenchmarkRun('run-1'),
        modelId: 'claude-haiku',
      };

      mockRunEvaluationWithConnector.mockResolvedValue({ id: 'report-1', trajectory: [], metrics: {} });
      mockSaveReportWithClient.mockResolvedValue({ id: 'saved-report-1', metricsStatus: 'ready' });

      await runSingleUseCase(run, testCase, mockClient);

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
      mockSaveReportWithClient.mockResolvedValue({ id: 'saved-report-1', metricsStatus: 'ready' });

      await runSingleUseCase(run, testCase, mockClient);

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
      mockSaveReportWithClient.mockResolvedValue({ id: 'saved-report-1', metricsStatus: 'ready' });

      const reportId = await runSingleUseCase(run, testCase, mockClient);

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
      mockSaveReportWithClient.mockResolvedValue({ id: 'saved-report-1', metricsStatus: 'ready' });

      await runSingleUseCase(run, testCase, mockClient);

      const agentConfigArg = mockRunEvaluationWithConnector.mock.calls[0][0];
      expect(agentConfigArg.endpoint).toBe('http://override.example.com');
    });

    it('should use raw model key if not found in config', async () => {
      const testCase = createTestCase('tc-1');
      const run: BenchmarkRun = {
        ...createBenchmarkRun('run-1'),
        modelId: 'unknown-model-key',
      };

      mockRunEvaluationWithConnector.mockResolvedValue({ id: 'report-1', trajectory: [], metrics: {} });
      mockSaveReportWithClient.mockResolvedValue({ id: 'saved-report-1', metricsStatus: 'ready' });

      await runSingleUseCase(run, testCase, mockClient);

      expect(mockRunEvaluationWithConnector).toHaveBeenCalledWith(
        expect.any(Object),
        'unknown-model-key', // Falls back to raw key
        expect.any(Object),
        expect.any(Function),
        expect.objectContaining({ registry: expect.any(Object) })
      );
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
      });
      mockCallBedrockJudge.mockResolvedValue({
        passFailStatus: 'passed',
        metrics: { accuracy: 95 },
        llmJudgeReasoning: 'Test passed',
        improvementStrategies: [],
      });

      await executeRun(experiment, run, jest.fn(), { client: mockClient });

      // Get the callbacks passed to startPolling
      const startPollingCall = mockStartPolling.mock.calls[0];
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
        'anthropic.claude-3-sonnet-20240229-v1:0'
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
      const callbacks = mockStartPolling.mock.calls[0][2];

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

      mockRunEvaluationWithConnector.mockResolvedValue({ id: 'report-1', trajectory: [] });
      mockSaveReportWithClient.mockResolvedValue({
        id: 'saved-report-1',
        metricsStatus: 'pending',
        // runId is missing
      });

      await runSingleUseCase(run, testCase, mockClient);

      expect(mockStartPolling).not.toHaveBeenCalled();
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
      const callbacks = mockStartPolling.mock.calls[0][2];

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
      const callbacks = mockStartPolling.mock.calls[0][2];

      // Simulate error callback
      callbacks.onError(new Error('Polling failed'));

      // Verify console.error was called
      expect(console.error).toHaveBeenCalled();
    });
  });

});
