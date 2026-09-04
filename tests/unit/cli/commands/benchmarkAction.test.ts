/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AgentConfig, Benchmark, BenchmarkRun, TestCaseRun } from '@/types/index.js';

jest.mock('@/lib/config/index.js', () => ({
  __esModule: true,
  loadConfig: jest.fn(),
  DEFAULT_SERVER_CONFIG: {
    port: 4001,
    reuseExistingServer: true,
    startTimeout: 30000,
  },
}));

jest.mock('@/cli/utils/serverLifecycle.js', () => ({
  __esModule: true,
  ensureServer: jest.fn(),
  createServerCleanup: jest.fn(),
  isServerRunning: jest.fn(),
}));

jest.mock('@/cli/utils/apiClient.js', () => {
  class MockServerError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'ServerError';
    }
  }

  return {
    __esModule: true,
    ApiClient: jest.fn(),
    ServerError: MockServerError,
  };
});

jest.mock('chalk', () => {
  const identity = (value: string) => value;
  const chalk = {
    cyan: identity,
    green: identity,
    yellow: identity,
    red: identity,
    gray: identity,
    bold: identity,
  };

  return {
    __esModule: true,
    default: chalk,
    ...chalk,
  };
});

jest.mock('ora', () => ({
  __esModule: true,
  default: jest.fn((initialText?: string) => {
    const spinner = {
      text: initialText ?? '',
      start: jest.fn((nextText?: string) => {
        if (nextText) {
          spinner.text = nextText;
        }
        return spinner;
      }),
      succeed: jest.fn(() => spinner),
      fail: jest.fn(() => spinner),
      warn: jest.fn(() => spinner),
      info: jest.fn(() => spinner),
      stop: jest.fn(() => spinner),
    };

    return spinner;
  }),
}));

jest.mock('cli-table3', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(function MockTable(this: any, options: any) {
    this.options = options;
    this.rows = [];
    this.push = (row: unknown) => {
      this.rows.push(row);
    };
    this.toString = () => `TABLE ${JSON.stringify(this.rows)}`;
  }),
}));

import ora from 'ora';
import { loadConfig } from '@/lib/config/index.js';
import { ApiClient } from '@/cli/utils/apiClient.js';
import {
  createServerCleanup,
  ensureServer,
  isServerRunning,
} from '@/cli/utils/serverLifecycle.js';
import {
  buildFileSources,
  createBenchmarkCommand,
  isFilePath,
  loadAndValidateTestCasesFile,
} from '@/cli/commands/benchmark.js';

type MockApiClient = {
  bulkCreateTestCases: jest.Mock;
  createBenchmark: jest.Mock;
  executeBenchmark: jest.Mock;
  findBenchmark: jest.Mock;
  findBenchmarkDetailed: jest.Mock;
  getEvaluationRun: jest.Mock;
  getReportById: jest.Mock;
  listTestCases: jest.Mock;
};

class ProcessExitError extends Error {
  constructor(public readonly code: number) {
    super(`process.exit(${code})`);
    this.name = 'ProcessExitError';
  }
}

const mockLoadConfig = loadConfig as jest.MockedFunction<typeof loadConfig>;
const mockEnsureServer = ensureServer as jest.MockedFunction<typeof ensureServer>;
const mockCreateServerCleanup = createServerCleanup as jest.MockedFunction<
  typeof createServerCleanup
>;
const mockIsServerRunning = isServerRunning as jest.MockedFunction<typeof isServerRunning>;
const MockApiClientClass = ApiClient as unknown as jest.Mock;
const mockOra = ora as unknown as jest.Mock;

const baseConfig = {
  server: {
    port: 4001,
    reuseExistingServer: true,
    startTimeout: 30000,
  },
  agents: [
    {
      key: 'demo-agent',
      name: 'Demo Agent',
      endpoint: 'http://demo-agent',
      enabled: true,
      connectorConfig: { model: 'agent-model-1' },
    },
    {
      key: 'backup-agent',
      name: 'Backup Agent',
      endpoint: 'http://backup-agent',
      enabled: true,
      connectorConfig: { model: 'agent-model-2' },
    },
  ],
  models: {
    'fallback-model': {
      model_id: 'fallback-model',
      display_name: 'Fallback Model',
      provider: 'demo',
      context_window: 8192,
      max_output_tokens: 4096,
    },
  },
  connectors: [],
  testCases: [],
  reporters: [],
  judge: {},
  telemetry: {},
} as const;

function makeApiClient(overrides: Partial<MockApiClient> = {}): MockApiClient {
  return {
    bulkCreateTestCases: jest.fn(),
    createBenchmark: jest.fn(),
    executeBenchmark: jest.fn(),
    findBenchmark: jest.fn(),
    findBenchmarkDetailed: jest.fn().mockResolvedValue({ benchmark: null, ambiguousMatches: [] }),
    getEvaluationRun: jest.fn(),
    getReportById: jest.fn(),
    listTestCases: jest.fn(),
    ...overrides,
  };
}

function makeBenchmark(overrides: Partial<Benchmark> = {}): Benchmark {
  return {
    id: 'bench-1',
    name: 'Benchmark One',
    description: 'Test benchmark',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    currentVersion: 1,
    versions: [],
    testCaseIds: ['tc-1'],
    runs: [],
    ...overrides,
  };
}

function makeRun(overrides: Partial<BenchmarkRun> = {}): BenchmarkRun {
  return {
    id: 'run-1',
    name: 'CLI Run',
    createdAt: '2024-01-01T00:00:00.000Z',
    status: 'completed',
    agentKey: 'demo-agent',
    modelId: 'agent-model-1',
    results: {
      'tc-1': { reportId: 'report-1', status: 'completed' },
    },
    ...overrides,
  };
}

function makeReport(
  id: string,
  testCaseId: string,
  passFailStatus: 'passed' | 'failed'
): TestCaseRun {
  return {
    id,
    timestamp: '2024-01-01T00:00:00.000Z',
    testCaseId,
    agentName: 'Demo Agent',
    agentKey: 'demo-agent',
    modelName: 'agent-model-1',
    modelId: 'agent-model-1',
    status: 'completed',
    passFailStatus,
    trajectory: [],
    metrics: { accuracy: passFailStatus === 'passed' ? 100 : 0 },
    llmJudgeReasoning: '',
  } as TestCaseRun;
}

function validFileTestCases() {
  return [
    {
      name: 'File Case 1',
      category: 'RCA',
      difficulty: 'Easy',
      initialPrompt: 'Investigate the first issue',
      expectedOutcomes: ['Identify the first root cause'],
    },
    {
      name: 'File Case 2',
      category: 'Performance',
      difficulty: 'Hard',
      initialPrompt: 'Investigate the second issue',
      expectedOutcomes: ['Identify the second root cause'],
    },
  ];
}

function joinedConsoleOutput(spy: jest.SpyInstance): string {
  return spy.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
}

async function runBenchmarkCommand(args: string[]): Promise<void> {
  await createBenchmarkCommand().parseAsync(['node', 'benchmark', ...args]);
}

describe('Benchmark Command - Real Module Coverage', () => {
  let tempDir: string;
  let currentApi: MockApiClient;
  let cleanupSpy: jest.Mock;
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  let exitSpy: jest.SpyInstance;
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    tempDir = mkdtempSync(join(tmpdir(), 'benchmark-action-'));
    currentApi = makeApiClient();
    cleanupSpy = jest.fn();

    mockLoadConfig.mockResolvedValue(baseConfig as any);
    mockEnsureServer.mockResolvedValue({
      baseUrl: 'http://localhost:4001',
      wasStarted: true,
    } as any);
    mockCreateServerCleanup.mockReturnValue(cleanupSpy);
    mockIsServerRunning.mockResolvedValue(false);
    MockApiClientClass.mockImplementation(() => currentApi);

    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = jest
      .spyOn(process, 'exit')
      .mockImplementation(((code?: number) => {
        throw new ProcessExitError(code ?? 0);
      }) as never);

    delete process.env.CI;
    delete process.env.OPENSEARCH_DASHBOARDS_URL;
    delete process.env.AH_AGENT_PATH;
    global.fetch = originalFetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('exported helpers', () => {
    it('detects json files and code eval files as file paths', () => {
      expect(isFilePath('suite.json')).toBe(true);
      expect(isFilePath('suite.eval.ts')).toBe(true);
      expect(isFilePath('Baseline')).toBe(false);
    });

    it('loads and validates a real JSON test-case file', () => {
      const filePath = join(tempDir, 'test-cases.json');
      writeFileSync(filePath, JSON.stringify(validFileTestCases(), null, 2));

      const loaded = loadAndValidateTestCasesFile(filePath);

      expect(loaded).toHaveLength(2);
      expect(loaded[0].name).toBe('File Case 1');
      expect(loaded[1].expectedOutcomes).toEqual(['Identify the second root cause']);
    });

    it('throws helpful errors for unreadable, malformed, and invalid files', () => {
      const malformedPath = join(tempDir, 'malformed.json');
      const invalidPath = join(tempDir, 'invalid.json');

      writeFileSync(malformedPath, '{not-json');
      writeFileSync(invalidPath, JSON.stringify([{ name: '' }]));

      expect(() => loadAndValidateTestCasesFile(join(tempDir, 'missing.json'))).toThrow(
        'Cannot read file:'
      );
      expect(() => loadAndValidateTestCasesFile(malformedPath)).toThrow(
        `Invalid JSON in file: ${malformedPath}`
      );
      expect(() => loadAndValidateTestCasesFile(invalidPath)).toThrow(
        `Validation failed for ${invalidPath}:`
      );
    });

    it('splits code and json files into distinct source types', () => {
      expect(buildFileSources(['suite.eval.js', 'extra.json', 'suite.eval.ts'])).toEqual([
        { type: 'code-import', filenames: ['suite.eval.js', 'suite.eval.ts'], testCaseIds: [] },
        { type: 'file-import', filenames: ['extra.json'], testCaseIds: [] },
      ]);
    });
  });

  describe('command action', () => {
    it('runs file mode end-to-end and exports json results', async () => {
      const inputFile = join(tempDir, 'uploaded-cases.json');
      const exportFile = join(tempDir, 'results.json');
      writeFileSync(inputFile, JSON.stringify(validFileTestCases(), null, 2));

      const benchmark = makeBenchmark({
        id: 'bench-file',
        name: 'uploaded-cases',
        testCaseIds: ['tc-1', 'tc-2'],
      });
      const run = makeRun({
        id: 'run-file',
        results: {
          'tc-1': { reportId: 'report-1', status: 'completed' },
          'tc-2': { reportId: 'report-2', status: 'completed' },
        },
      });

      currentApi.bulkCreateTestCases.mockResolvedValue({
        created: 2,
        errors: 0,
        testCases: [
          { id: 'tc-1', name: 'File Case 1' },
          { id: 'tc-2', name: 'File Case 2' },
        ],
      });
      currentApi.findBenchmark.mockResolvedValue(null);
      currentApi.createBenchmark.mockResolvedValue(benchmark);
      currentApi.executeBenchmark.mockImplementation(
        async (_benchmarkId: string, runConfig: any, onProgress?: (event: any) => void) => {
          expect(runConfig).toMatchObject({
            name: 'CLI Run - Demo Agent',
            agentKey: 'demo-agent',
            modelId: 'agent-model-1',
            concurrency: 3,
            evaluatorId: 'rca-default',
            judgeModelId: 'judge-v2',
          });

          onProgress?.({
            type: 'started',
            runId: 'run-file',
            testCases: [
              { id: 'tc-1', name: 'File Case 1', status: 'pending' },
              { id: 'tc-2', name: 'File Case 2', status: 'pending' },
            ],
          });
          onProgress?.({
            type: 'progress',
            currentTestCaseIndex: 1,
            totalTestCases: 2,
            currentTestCase: { id: 'tc-2', name: 'File Case 2' },
            completedCount: 2,
            result: { status: 'completed' },
          });

          return run;
        }
      );
      currentApi.getReportById
        .mockResolvedValueOnce(makeReport('report-1', 'tc-1', 'passed'))
        .mockResolvedValueOnce(makeReport('report-2', 'tc-2', 'passed'));

      await runBenchmarkCommand([
        '-f',
        inputFile,
        '-a',
        'DEMO AGENT',
        '-c',
        '3',
        '-e',
        'rca-default',
        '--judge-model',
        'judge-v2',
        '--output',
        'json',
        '--export',
        exportFile,
      ]);

      const exported = JSON.parse(readFileSync(exportFile, 'utf-8'));
      expect(exported.benchmark).toMatchObject({
        id: 'bench-file',
        name: 'uploaded-cases',
        testCaseCount: 2,
      });
      expect(exported.runs[0]).toMatchObject({
        runId: 'run-file',
        passed: 2,
        failed: 0,
        passRate: 100,
      });

      expect(currentApi.bulkCreateTestCases).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ name: 'File Case 1' }),
          expect.objectContaining({ name: 'File Case 2' }),
        ])
      );
      expect(currentApi.createBenchmark).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'uploaded-cases',
          testCaseIds: ['tc-1', 'tc-2'],
        })
      );
      expect(mockCreateServerCleanup).toHaveBeenCalledWith(
        expect.objectContaining({ baseUrl: 'http://localhost:4001', wasStarted: true }),
        true
      );
      expect(joinedConsoleOutput(logSpy)).toContain('"runId": "run-file"');
      expect(cleanupSpy).toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('runs quick mode as an ad-hoc evaluation run — no benchmark doc is created', async () => {
      mockEnsureServer.mockResolvedValue({
        baseUrl: 'http://localhost:4001',
        wasStarted: false,
      } as any);

      currentApi.listTestCases.mockResolvedValue([
        { id: 'tc-1', name: 'Quick Case 1' },
        { id: 'tc-2', name: 'Quick Case 2' },
      ]);

      // Unified evaluation-runs API: SSE stream (started → progress → completed)
      const encoder = new TextEncoder();
      const sseChunks = [
        `event: started\ndata: ${JSON.stringify({
          runId: 'run-quick',
          testCases: [
            { id: 'tc-1', name: 'Quick Case 1', status: 'pending' },
            { id: 'tc-2', name: 'Quick Case 2', status: 'pending' },
          ],
        })}\n\n`,
        `event: progress\ndata: ${JSON.stringify({ completedCount: 2 })}\n\n`,
        `event: completed\ndata: ${JSON.stringify({ status: 'completed' })}\n\n`,
      ].map((c) => encoder.encode(c));
      let chunkIdx = 0;
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        body: {
          getReader: () => ({
            read: jest.fn().mockImplementation(async () =>
              chunkIdx < sseChunks.length
                ? { done: false, value: sseChunks[chunkIdx++] }
                : { done: true, value: undefined }
            ),
          }),
        },
      } as any);

      currentApi.getEvaluationRun.mockResolvedValue({
        id: 'run-quick',
        status: 'completed',
        results: {
          'tc-1': { reportId: 'report-1', status: 'completed' },
          'tc-2': { reportId: 'report-2', status: 'completed' },
        },
      });

      await runBenchmarkCommand([]);

      const output = joinedConsoleOutput(logSpy);
      // New contract: quick mode is an ad-hoc run over all stored test cases.
      expect(output).toContain('Running in quick mode (ad-hoc run over all test cases)');
      expect(output).toContain('This was an ad-hoc run (ID: run-quick)');
      expect(currentApi.listTestCases).toHaveBeenCalledTimes(1);
      // THE regression this pins: no `quick-<timestamp>` Benchmark doc, ever.
      expect(currentApi.createBenchmark).not.toHaveBeenCalled();
      expect(currentApi.executeBenchmark).not.toHaveBeenCalled();
      // The run went through the unified evaluation-runs API instead.
      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:4001/api/storage/evaluation-runs',
        expect.objectContaining({ method: 'POST' })
      );
      const postBody = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
      expect(postBody.sources).toEqual([{ type: 'test-case-ids', ids: ['tc-1', 'tc-2'] }]);
      expect(postBody.benchmarkId).toBeUndefined();
      expect(cleanupSpy).toHaveBeenCalled();
    });

    it('runs named benchmark mode, resolves agent names, and exports html via the report endpoint', async () => {
      const exportFile = join(tempDir, 'report.html');
      const benchmark = makeBenchmark({
        id: 'bench-existing',
        name: 'Existing Benchmark',
        testCaseIds: ['tc-1'],
      });
      const run = makeRun({
        id: 'run-existing',
        results: {
          'tc-1': { reportId: 'report-1', status: 'completed' },
        },
      });

      mockIsServerRunning.mockResolvedValue(true);
      mockEnsureServer.mockResolvedValue({
        baseUrl: 'http://localhost:4100',
        wasStarted: false,
      } as any);
      currentApi.findBenchmark.mockResolvedValue(benchmark);
      currentApi.executeBenchmark.mockImplementation(
        async (_benchmarkId: string, _runConfig: any, onProgress?: (event: any) => void) => {
          onProgress?.({
            type: 'started',
            runId: 'run-existing',
            testCases: [{ id: 'tc-1', name: 'Named Case', status: 'pending' }],
          });
          onProgress?.({
            type: 'progress',
            currentTestCaseIndex: 0,
            totalTestCases: 1,
            currentTestCase: { id: 'tc-1', name: 'Named Case' },
            completedCount: 1,
            result: { status: 'completed' },
          });

          return run;
        }
      );
      currentApi.getReportById.mockResolvedValue(makeReport('report-1', 'tc-1', 'failed'));
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => 'text/html' },
        text: jest.fn().mockResolvedValue('<html>named benchmark report</html>'),
      } as any);

      await runBenchmarkCommand([
        '-n',
        'Existing Benchmark',
        '-a',
        'DEMO AGENT',
        '--export',
        exportFile,
        '--format',
        'html',
      ]);

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:4100/api/storage/benchmarks/bench-existing/report?format=html&runIds=run-existing'
      );
      expect(readFileSync(exportFile, 'utf-8')).toBe('<html>named benchmark report</html>');
      expect(joinedConsoleOutput(logSpy)).toContain('TABLE');
      expect(currentApi.findBenchmark).toHaveBeenCalledWith('Existing Benchmark');
      expect(cleanupSpy).toHaveBeenCalled();
    });

    it('exits with a helpful error when the server is already running and no source is specified', async () => {
      mockIsServerRunning.mockResolvedValue(true);

      await expect(runBenchmarkCommand([])).rejects.toMatchObject({
        code: 1,
        name: 'ProcessExitError',
      });

      expect(joinedConsoleOutput(errorSpy)).toContain(
        'Benchmark name required when server is already running.'
      );
      expect(mockEnsureServer).not.toHaveBeenCalled();
    });

    it('exits when server startup fails', async () => {
      mockEnsureServer.mockRejectedValue(new Error('port already in use'));

      await expect(runBenchmarkCommand(['-n', 'Existing Benchmark'])).rejects.toMatchObject({
        code: 1,
        name: 'ProcessExitError',
      });

      const connectSpinner = mockOra.mock.results[0].value;
      expect(connectSpinner.fail).toHaveBeenCalledWith(
        'Failed to connect to server: port already in use'
      );
      expect(mockCreateServerCleanup).not.toHaveBeenCalled();
    });
  });
});
