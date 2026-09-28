/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for services/evaluation/runSingleUseCase.ts — the engine behind
 * `POST /api/evaluate`. Ported from the former services/benchmarkRunner.ts
 * suite when the legacy per-benchmark runner was removed; the behaviour under
 * test is unchanged.
 */

import { runSingleUseCase } from '@/services/evaluation/runSingleUseCase';
import { BenchmarkRun, TestCase } from '@/types';

// Mock storage module
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

const createBenchmarkRun = (id: string): BenchmarkRun => ({
  id,
  name: 'Test Run',
  agentKey: 'test-agent',
  modelId: 'claude-sonnet',
  createdAt: '2024-01-01T00:00:00.000Z',
  results: {},
});

describe('runSingleUseCase (services/evaluation)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetCustomAgents.mockReturnValue([]);
    mockRunsCreate.mockReset();
    mockRunsUpdate.mockReset();
    mockStartPollingAsync.mockReset();
    mockStartPollingAsync.mockResolvedValue(undefined);
    mockTestCasesUpdate.mockResolvedValue(undefined);
    mockTestCasesGetById.mockResolvedValue({ id: 'tc-1', name: 'Test' });
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

    it('forwards report.matcherResults on the placeholder-update path (existingReportId) — regression for the unified judge surface being silently dropped', async () => {
      const testCase = createTestCase('tc-1');
      const run = createBenchmarkRun('run-1');
      const matcherResults = [
        { description: 'judge: identifies root cause', pass: true, method: 'llm-judge', improvementStrategies: [{ category: 'x', issue: 'y', recommendation: 'z', priority: 'high' }] },
      ];

      mockRunEvaluationWithConnector.mockResolvedValue({
        id: 'report-1',
        status: 'completed',
        passFailStatus: 'passed',
        trajectory: [],
        metrics: { accuracy: 0.9 },
        matcherResults,
      });
      mockRunsUpdate.mockResolvedValue({ id: 'existing-report-id', timestamp: '2024-01-01T00:00:00Z' });

      await runSingleUseCase(run, testCase, mockStorageModule, undefined, undefined, 'existing-report-id');

      expect(mockRunsUpdate).toHaveBeenCalledWith('existing-report-id', expect.objectContaining({ matcherResults }));
    });

    it('forwards report.matcherResults on the create path (no existingReportId, saveReportWithModule) — regression for the unified judge surface being silently dropped', async () => {
      const testCase = createTestCase('tc-1');
      const run = createBenchmarkRun('run-1');
      const matcherResults = [
        { description: 'judge: identifies root cause', pass: true, method: 'llm-judge', improvementStrategies: [{ category: 'x', issue: 'y', recommendation: 'z', priority: 'high' }] },
      ];

      mockRunEvaluationWithConnector.mockResolvedValue({
        id: 'report-1',
        status: 'completed',
        passFailStatus: 'passed',
        trajectory: [],
        metrics: { accuracy: 0.9 },
        matcherResults,
      });
      mockRunsCreate.mockResolvedValue({ id: 'saved-report-1', timestamp: '2024-01-01T00:00:00Z', metricsStatus: 'ready' });

      await runSingleUseCase(run, testCase, mockStorageModule);

      expect(mockRunsCreate).toHaveBeenCalledWith(expect.objectContaining({ matcherResults }));
    });

    it('starts polling even when runId is missing (sessionId/window/traceId correlation)', async () => {
      // REST-connector reports never carry a runId; the poller now derives
      // correlation from the report's sessionId / eval traceId / service
      // window, so pending trace-mode reports must still be polled.
      const testCase = createTestCase('tc-1');
      const run = createBenchmarkRun('run-1');

      mockRunEvaluationWithConnector.mockResolvedValue({ id: 'report-1', trajectory: [], metricsStatus: 'pending' });
      mockRunsCreate.mockResolvedValue({ id: 'saved-report-1', metricsStatus: 'pending' });

      await runSingleUseCase(run, testCase, mockStorageModule);

      expect(mockStartPollingAsync).toHaveBeenCalledWith(
        'saved-report-1',
        undefined,
        expect.anything(),
        expect.anything()
      );
    });

    it('stamps judgeModelId / evaluatorId from the run onto the report before saving (create path)', async () => {
      const testCase = createTestCase('tc-1');
      const run: BenchmarkRun = { ...createBenchmarkRun('run-1'), judgeModelId: 'judge-model', evaluatorId: 'eval-1' };

      mockRunEvaluationWithConnector.mockResolvedValue({ id: 'report-1', testCaseId: 'tc-1', agentKey: 'test-agent', trajectory: [], metrics: {} });
      mockRunsCreate.mockResolvedValue({ id: 'saved-report-1', metricsStatus: 'ready' });

      await runSingleUseCase(run, testCase, mockStorageModule);

      expect(mockRunEvaluationWithConnector).toHaveBeenCalledWith(
        expect.any(Object),
        expect.any(String),
        testCase,
        expect.any(Function),
        expect.objectContaining({ judgeModelId: 'judge-model' })
      );
      expect(mockRunsCreate).toHaveBeenCalledWith(expect.objectContaining({
        judgeModelId: 'judge-model',
        evaluatorId: 'eval-1',
        testCaseId: 'tc-1',
        agentId: 'test-agent',
      }));
    });

    it('never stamps a non-W3C connector run id into traceId (create path)', async () => {
      const testCase = createTestCase('tc-1');
      const run = createBenchmarkRun('run-1');

      mockRunEvaluationWithConnector.mockResolvedValue({ id: 'report-1', trajectory: [], metrics: {}, runId: 'conv-123' });
      mockRunsCreate.mockResolvedValue({ id: 'saved-report-1', metricsStatus: 'ready' });

      await runSingleUseCase(run, testCase, mockStorageModule);

      const saved = mockRunsCreate.mock.calls[0][0];
      expect(saved.runId).toBe('conv-123');
      expect(saved.traceId).toBeUndefined();
    });

    it('forwards the explicit evaluatorId argument to runEvaluationWithConnector', async () => {
      const testCase = createTestCase('tc-1');
      const run = createBenchmarkRun('run-1');

      mockRunEvaluationWithConnector.mockResolvedValue({ id: 'report-1', trajectory: [], metrics: {} });
      mockRunsCreate.mockResolvedValue({ id: 'saved-report-1', metricsStatus: 'ready' });

      await runSingleUseCase(run, testCase, mockStorageModule, undefined, 'custom-evaluator');

      expect(mockRunEvaluationWithConnector.mock.calls[0][4]).toEqual(
        expect.objectContaining({ evaluatorId: 'custom-evaluator' })
      );
    });

    it('propagates an unknown agent as a thrown error (no report is written)', async () => {
      const testCase = createTestCase('tc-1');
      const run: BenchmarkRun = { ...createBenchmarkRun('run-1'), agentKey: 'does-not-exist' };

      await expect(runSingleUseCase(run, testCase, mockStorageModule)).rejects.toThrow('Agent not found: does-not-exist');
      expect(mockRunsCreate).not.toHaveBeenCalled();
    });

    it('does not throw when awaited trace polling rejects (CLI mode) — the poller already persisted the error', async () => {
      const testCase = createTestCase('tc-1');
      const run = createBenchmarkRun('run-1');

      mockRunEvaluationWithConnector.mockResolvedValue({ id: 'report-1', trajectory: [], metrics: {}, metricsStatus: 'pending' });
      mockRunsCreate.mockResolvedValue({ id: 'saved-report-1', metricsStatus: 'pending' });
      mockStartPollingAsync.mockRejectedValueOnce(new Error('Traces unavailable'));

      await expect(runSingleUseCase(run, testCase, mockStorageModule)).resolves.toBe('saved-report-1');
    });
  });
});
