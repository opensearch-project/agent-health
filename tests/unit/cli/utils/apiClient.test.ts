/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { ApiClient } from '@/cli/utils/apiClient';

// Mock fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch;

describe('ApiClient', () => {
  let client: ApiClient;
  const baseUrl = 'http://localhost:4001';

  beforeEach(() => {
    client = new ApiClient(baseUrl);
    mockFetch.mockReset();
  });

  describe('checkHealth', () => {
    it('should return health response on success', async () => {
      const healthResponse = { status: 'healthy', version: '1.0.0', service: 'agent-health' };
      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue(healthResponse),
      });

      const result = await client.checkHealth();

      expect(mockFetch).toHaveBeenCalledWith(`${baseUrl}/health`);
      expect(result).toEqual(healthResponse);
    });

    it('should throw error after all retries exhausted', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
      });

      await expect(client.checkHealth(2, 1)).rejects.toThrow(
        'Server health check failed: 503 Service Unavailable'
      );
      // 1 initial + 2 retries = 3 calls
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('should succeed on retry after transient failure', async () => {
      const healthResponse = { status: 'healthy', version: '1.0.0', service: 'agent-health' };
      // First call fails with network error, second succeeds
      mockFetch
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockResolvedValueOnce({
          ok: true,
          json: jest.fn().mockResolvedValue(healthResponse),
        });

      const result = await client.checkHealth(2, 1);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(result).toEqual(healthResponse);
    });

    it('should not retry when retries is 0', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
      });

      await expect(client.checkHealth(0)).rejects.toThrow(
        'Server health check failed: 503 Service Unavailable'
      );
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should retry on network errors', async () => {
      const healthResponse = { status: 'healthy', version: '1.0.0', service: 'agent-health' };
      mockFetch
        .mockRejectedValueOnce(new Error('fetch failed'))
        .mockRejectedValueOnce(new Error('fetch failed'))
        .mockResolvedValueOnce({
          ok: true,
          json: jest.fn().mockResolvedValue(healthResponse),
        });

      const result = await client.checkHealth(2, 1);

      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(result).toEqual(healthResponse);
    });
  });

  describe('listBenchmarks', () => {
    it('should return array of benchmarks', async () => {
      const benchmarks = [{ id: 'bench-1', name: 'Benchmark 1' }];
      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ benchmarks }),
      });

      const result = await client.listBenchmarks();

      expect(mockFetch).toHaveBeenCalledWith(`${baseUrl}/api/storage/benchmarks`);
      expect(result).toEqual(benchmarks);
    });

    it('should return empty array when no benchmarks', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({}),
      });

      const result = await client.listBenchmarks();

      expect(result).toEqual([]);
    });

    it('should throw error on failure', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      await expect(client.listBenchmarks()).rejects.toThrow(
        'Failed to list benchmarks: 500 Internal Server Error'
      );
    });
  });

  describe('getBenchmark', () => {
    it('should return benchmark by ID', async () => {
      const benchmark = { id: 'bench-1', name: 'Benchmark 1', runs: [] };
      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue(benchmark),
      });

      const result = await client.getBenchmark('bench-1');

      expect(mockFetch).toHaveBeenCalledWith(`${baseUrl}/api/storage/benchmarks/bench-1`);
      expect(result).toEqual(benchmark);
    });

    it('should return null for 404', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
      });

      const result = await client.getBenchmark('non-existent');

      expect(result).toBeNull();
    });

    it('should throw error on other failures', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      await expect(client.getBenchmark('bench-1')).rejects.toThrow(
        'Failed to get benchmark: 500 Internal Server Error'
      );
    });

    it('should URL encode benchmark ID', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ id: 'bench/1' }),
      });

      await client.getBenchmark('bench/1');

      expect(mockFetch).toHaveBeenCalledWith(`${baseUrl}/api/storage/benchmarks/bench%2F1`);
    });
  });

  describe('getRun', () => {
    it('should return run from benchmark by ID', async () => {
      const run = { id: 'run-1', name: 'Run 1', results: {} };
      const benchmark = { id: 'bench-1', name: 'Benchmark 1', runs: [run] };
      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue(benchmark),
      });

      const result = await client.getRun('bench-1', 'run-1');

      expect(mockFetch).toHaveBeenCalledWith(`${baseUrl}/api/storage/benchmarks/bench-1`);
      expect(result).toEqual(run);
    });

    it('should return null if benchmark not found', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
      });

      const result = await client.getRun('non-existent', 'run-1');

      expect(result).toBeNull();
    });

    it('should return null if run not found in benchmark', async () => {
      const benchmark = { id: 'bench-1', name: 'Benchmark 1', runs: [{ id: 'run-2' }] };
      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue(benchmark),
      });

      const result = await client.getRun('bench-1', 'run-1');

      expect(result).toBeNull();
    });

    it('should return null if benchmark has no runs', async () => {
      const benchmark = { id: 'bench-1', name: 'Benchmark 1' };
      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue(benchmark),
      });

      const result = await client.getRun('bench-1', 'run-1');

      expect(result).toBeNull();
    });
  });

  describe('getReportById', () => {
    it('should return report by ID', async () => {
      const report = {
        id: 'report-1',
        testCaseId: 'tc-1',
        status: 'completed',
        passFailStatus: 'passed',
      };
      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue(report),
      });

      const result = await client.getReportById('report-1');

      expect(mockFetch).toHaveBeenCalledWith(`${baseUrl}/api/storage/runs/report-1`);
      expect(result).toEqual(report);
    });

    it('should return null for 404', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
      });

      const result = await client.getReportById('non-existent');

      expect(result).toBeNull();
    });

    it('should throw error on other failures', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      await expect(client.getReportById('report-1')).rejects.toThrow(
        'Failed to get report: 500 Internal Server Error'
      );
    });

    it('should URL encode report ID', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ id: 'report/1' }),
      });

      await client.getReportById('report/1');

      expect(mockFetch).toHaveBeenCalledWith(`${baseUrl}/api/storage/runs/report%2F1`);
    });
  });

  describe('findBenchmark', () => {
    it('should find benchmark by exact ID', async () => {
      const benchmark = { id: 'bench-1', name: 'Benchmark 1' };
      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue(benchmark),
      });

      const result = await client.findBenchmark('bench-1');

      expect(result).toEqual(benchmark);
    });

    it('should find benchmark by name if ID not found', async () => {
      const benchmark = { id: 'bench-1', name: 'My Benchmark' };
      // First call (getBenchmark by ID) returns 404
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });
      // Second call (listBenchmarks) returns the benchmark
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValue({ benchmarks: [benchmark] }),
      });

      const result = await client.findBenchmark('My Benchmark');

      expect(result).toEqual(benchmark);
    });

    it('should return null if not found by ID or name', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValue({ benchmarks: [] }),
      });

      const result = await client.findBenchmark('non-existent');

      expect(result).toBeNull();
    });
  });

  describe('listTestCases', () => {
    it('should return array of test cases', async () => {
      const testCases = [{ id: 'tc-1', name: 'Test Case 1' }];
      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ testCases }),
      });

      const result = await client.listTestCases();

      expect(mockFetch).toHaveBeenCalledWith(`${baseUrl}/api/storage/test-cases`);
      expect(result).toEqual(testCases);
    });

    it('should return empty array when no test cases', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({}),
      });

      const result = await client.listTestCases();

      expect(result).toEqual([]);
    });
  });

  describe('listAgents', () => {
    it('should return array of agents', async () => {
      const agents = [{ key: 'mock', name: 'Mock Agent' }];
      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ agents }),
      });

      const result = await client.listAgents();

      expect(mockFetch).toHaveBeenCalledWith(`${baseUrl}/api/agents`);
      expect(result).toEqual(agents);
    });
  });

  describe('listModels', () => {
    it('should return array of models', async () => {
      const models = [{ key: 'claude-sonnet', display_name: 'Claude Sonnet' }];
      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ models }),
      });

      const result = await client.listModels();

      expect(mockFetch).toHaveBeenCalledWith(`${baseUrl}/api/models`);
      expect(result).toEqual(models);
    });
  });

  describe('getTestCase', () => {
    it('should return test case by ID', async () => {
      const testCase = { id: 'tc-1', name: 'Test Case 1' };
      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue(testCase),
      });

      const result = await client.getTestCase('tc-1');

      expect(mockFetch).toHaveBeenCalledWith(`${baseUrl}/api/storage/test-cases/tc-1`);
      expect(result).toEqual(testCase);
    });

    it('should return null for 404', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
      });

      const result = await client.getTestCase('non-existent');

      expect(result).toBeNull();
    });
  });

  describe('createBenchmark', () => {
    it('should create benchmark and return result', async () => {
      const newBenchmark = { id: 'bench-new', name: 'New Benchmark', testCaseIds: ['tc-1'] };
      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue(newBenchmark),
      });

      const result = await client.createBenchmark({
        name: 'New Benchmark',
        testCaseIds: ['tc-1'],
      });

      expect(mockFetch).toHaveBeenCalledWith(
        `${baseUrl}/api/storage/benchmarks`,
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'New Benchmark', testCaseIds: ['tc-1'] }),
        })
      );
      expect(result).toEqual(newBenchmark);
    });

    it('should throw error on failure', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        text: jest.fn().mockResolvedValue('Validation error'),
      });

      await expect(
        client.createBenchmark({ name: 'Bad Benchmark', testCaseIds: [] })
      ).rejects.toThrow('Failed to create benchmark: Validation error');
    });
  });

  describe('bulkCreateTestCases', () => {
    it('should bulk create test cases and return response', async () => {
      const bulkResponse = {
        created: 2,
        errors: false,
        testCases: [
          { id: 'tc-1', name: 'Test Case 1' },
          { id: 'tc-2', name: 'Test Case 2' },
        ],
      };
      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue(bulkResponse),
      });

      const testCases = [
        { name: 'Test Case 1', category: 'RCA', difficulty: 'Easy', initialPrompt: 'test', expectedOutcomes: ['outcome'] },
        { name: 'Test Case 2', category: 'RCA', difficulty: 'Medium', initialPrompt: 'test2', expectedOutcomes: ['outcome2'] },
      ];
      const result = await client.bulkCreateTestCases(testCases);

      expect(mockFetch).toHaveBeenCalledWith(
        `${baseUrl}/api/storage/test-cases/bulk`,
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ testCases }),
        })
      );
      expect(result).toEqual(bulkResponse);
    });

    it('should throw error on failure', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        text: jest.fn().mockResolvedValue('Server error'),
      });

      await expect(
        client.bulkCreateTestCases([{ name: 'Test' }])
      ).rejects.toThrow('Failed to bulk create test cases: Server error');
    });

    it('should parse JSON error body', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        text: jest.fn().mockResolvedValue(JSON.stringify({ error: 'Validation failed' })),
      });

      await expect(
        client.bulkCreateTestCases([])
      ).rejects.toThrow('Failed to bulk create test cases: Validation failed');
    });
  });

  describe('cancelRun', () => {
    it('should cancel run successfully', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
      });

      await client.cancelRun('bench-1', 'run-1');

      expect(mockFetch).toHaveBeenCalledWith(
        `${baseUrl}/api/storage/benchmarks/bench-1/cancel`,
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ runId: 'run-1' }),
        })
      );
    });

    it('should throw error on failure', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        text: jest.fn().mockResolvedValue('Run not found'),
      });

      await expect(client.cancelRun('bench-1', 'run-1')).rejects.toThrow(
        'Failed to cancel run: Run not found'
      );
    });
  });

  describe('executeBenchmark', () => {
    const encoder = new TextEncoder();
    const runConfig = { name: 'Run 1', agentKey: 'mock', modelId: 'model-1' };

    function makeSSEReader(events: string[]) {
      let callIndex = 0;
      const chunks = events.map(e => `data: ${e}\n\n`);
      return {
        read: jest.fn().mockImplementation(() => {
          if (callIndex < chunks.length) {
            return Promise.resolve({ done: false, value: encoder.encode(chunks[callIndex++]) });
          }
          return Promise.resolve({ done: true, value: undefined });
        }),
        cancel: jest.fn().mockResolvedValue(undefined),
      };
    }

    it('should throw on non-ok response with JSON error body', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        text: jest.fn().mockResolvedValue(JSON.stringify({ error: 'Benchmark not found' })),
      });

      await expect(
        client.executeBenchmark('bench-1', runConfig as any)
      ).rejects.toThrow('Failed to execute benchmark: Benchmark not found');
    });

    it('should throw on non-ok response with plain text error body', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        text: jest.fn().mockResolvedValue('Internal server error'),
      });

      await expect(
        client.executeBenchmark('bench-1', runConfig as any)
      ).rejects.toThrow('Failed to execute benchmark: Internal server error');
    });

    it('should throw when response body is missing', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        body: null,
      });

      await expect(
        client.executeBenchmark('bench-1', runConfig as any)
      ).rejects.toThrow('Response body is missing');
    });

    it('should process started event and capture runId', async () => {
      const events: any[] = [];
      const mockRun = { id: 'run-1', status: 'completed', results: {} };
      const reader = makeSSEReader([
        JSON.stringify({ type: 'started', runId: 'run-1', testCases: [] }),
        JSON.stringify({ type: 'completed', run: mockRun }),
      ]);

      mockFetch.mockResolvedValue({
        ok: true,
        body: { getReader: () => reader },
      });

      const result = await client.executeBenchmark('bench-1', runConfig as any, (e) => events.push(e));

      expect(result).toEqual(mockRun);
      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('started');
      expect(events[1].type).toBe('completed');
    });

    it('should process cancelled event as final run', async () => {
      const mockRun = { id: 'run-1', status: 'cancelled', results: {} };
      const reader = makeSSEReader([
        JSON.stringify({ type: 'started', runId: 'run-1', testCases: [] }),
        JSON.stringify({ type: 'cancelled', run: mockRun }),
      ]);

      mockFetch.mockResolvedValue({
        ok: true,
        body: { getReader: () => reader },
      });

      const result = await client.executeBenchmark('bench-1', runConfig as any);

      expect(result).toEqual(mockRun);
    });

    it('should throw on error event without runId', async () => {
      const reader = makeSSEReader([
        JSON.stringify({ type: 'error', error: 'Agent failed' }),
      ]);

      mockFetch.mockResolvedValue({
        ok: true,
        body: { getReader: () => reader },
      });

      await expect(
        client.executeBenchmark('bench-1', runConfig as any)
      ).rejects.toThrow('Agent failed');
    });

    it('should throw on error event with runId after polling fails', async () => {
      jest.spyOn(console, 'warn').mockImplementation();

      const reader = makeSSEReader([
        JSON.stringify({ type: 'started', runId: 'run-1', testCases: [] }),
        JSON.stringify({ type: 'error', error: 'Agent failed' }),
      ]);

      // First call: execute endpoint
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: { getReader: () => reader },
      });
      // Second call: polling getBenchmark returns 404 (run not found)
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      await expect(
        client.executeBenchmark('bench-1', runConfig as any)
      ).rejects.toThrow('Agent failed');
    });

    it('should skip non-JSON SSE lines (SyntaxError)', async () => {
      const mockRun = { id: 'run-1', status: 'completed', results: {} };
      // Mix a non-JSON line with valid events
      let callIndex = 0;
      const chunks = [
        `data: not-valid-json\n\n`,
        `data: ${JSON.stringify({ type: 'completed', run: mockRun })}\n\n`,
      ];
      const reader = {
        read: jest.fn().mockImplementation(() => {
          if (callIndex < chunks.length) {
            return Promise.resolve({ done: false, value: encoder.encode(chunks[callIndex++]) });
          }
          return Promise.resolve({ done: true, value: undefined });
        }),
        cancel: jest.fn().mockResolvedValue(undefined),
      };

      mockFetch.mockResolvedValue({
        ok: true,
        body: { getReader: () => reader },
      });

      const result = await client.executeBenchmark('bench-1', runConfig as any);
      expect(result).toEqual(mockRun);
    });

    it('should skip lines that do not start with data:', async () => {
      const mockRun = { id: 'run-1', status: 'completed', results: {} };
      let callIndex = 0;
      const chunks = [
        `event: ping\n\n`,
        `data: ${JSON.stringify({ type: 'completed', run: mockRun })}\n\n`,
      ];
      const reader = {
        read: jest.fn().mockImplementation(() => {
          if (callIndex < chunks.length) {
            return Promise.resolve({ done: false, value: encoder.encode(chunks[callIndex++]) });
          }
          return Promise.resolve({ done: true, value: undefined });
        }),
        cancel: jest.fn().mockResolvedValue(undefined),
      };

      mockFetch.mockResolvedValue({
        ok: true,
        body: { getReader: () => reader },
      });

      const result = await client.executeBenchmark('bench-1', runConfig as any);
      expect(result).toEqual(mockRun);
    });

    it('should fall back to polling when stream disconnects with runId', async () => {
      jest.spyOn(console, 'warn').mockImplementation();

      const mockRun = { id: 'run-1', status: 'completed', results: {} };
      // Reader that gives a started event then throws
      let callIndex = 0;
      const reader = {
        read: jest.fn().mockImplementation(() => {
          if (callIndex === 0) {
            callIndex++;
            return Promise.resolve({
              done: false,
              value: encoder.encode(`data: ${JSON.stringify({ type: 'started', runId: 'run-1', testCases: [] })}\n\n`),
            });
          }
          return Promise.reject(new Error('Network disconnected'));
        }),
        cancel: jest.fn().mockResolvedValue(undefined),
      };

      // First call: execute endpoint, second call: getBenchmark for polling
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          body: { getReader: () => reader },
        })
        .mockResolvedValueOnce({
          ok: true,
          json: jest.fn().mockResolvedValue({
            id: 'bench-1',
            runs: [mockRun],
          }),
        });

      const result = await client.executeBenchmark('bench-1', runConfig as any);
      expect(result).toEqual(mockRun);
    });

    it('should re-throw stream error when no runId captured', async () => {
      // Reader that throws immediately (no started event)
      const reader = {
        read: jest.fn().mockRejectedValue(new Error('Connection refused')),
        cancel: jest.fn().mockResolvedValue(undefined),
      };

      mockFetch.mockResolvedValue({
        ok: true,
        body: { getReader: () => reader },
      });

      await expect(
        client.executeBenchmark('bench-1', runConfig as any)
      ).rejects.toThrow('Connection refused');
    });

    it('should poll for status when stream ends without final event but runId exists', async () => {
      jest.spyOn(console, 'warn').mockImplementation();

      const mockRun = { id: 'run-1', status: 'completed', results: {} };
      // Stream sends started but ends without completed/cancelled
      const reader = makeSSEReader([
        JSON.stringify({ type: 'started', runId: 'run-1', testCases: [] }),
        JSON.stringify({ type: 'progress', currentTestCaseIndex: 0, totalTestCases: 1, currentTestCase: { id: 'tc-1', name: 'TC' } }),
      ]);

      // First call: execute, second call: getBenchmark for polling
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          body: { getReader: () => reader },
        })
        .mockResolvedValueOnce({
          ok: true,
          json: jest.fn().mockResolvedValue({
            id: 'bench-1',
            runs: [mockRun],
          }),
        });

      const result = await client.executeBenchmark('bench-1', runConfig as any);
      expect(result).toEqual(mockRun);
    });

    it('should throw when stream ends without final event and no runId', async () => {
      // Stream ends immediately with no events
      const reader = {
        read: jest.fn().mockResolvedValue({ done: true, value: undefined }),
        cancel: jest.fn().mockResolvedValue(undefined),
      };

      mockFetch.mockResolvedValue({
        ok: true,
        body: { getReader: () => reader },
      });

      await expect(
        client.executeBenchmark('bench-1', runConfig as any)
      ).rejects.toThrow('No final run received from server');
    });

    it('should process progress events via onProgress callback', async () => {
      const events: any[] = [];
      const mockRun = { id: 'run-1', status: 'completed', results: {} };
      const reader = makeSSEReader([
        JSON.stringify({ type: 'started', runId: 'run-1', testCases: [{ id: 'tc-1', name: 'TC', status: 'pending' }] }),
        JSON.stringify({ type: 'progress', currentTestCaseIndex: 0, totalTestCases: 1, currentTestCase: { id: 'tc-1', name: 'TC' } }),
        JSON.stringify({ type: 'completed', run: mockRun }),
      ]);

      mockFetch.mockResolvedValue({
        ok: true,
        body: { getReader: () => reader },
      });

      await client.executeBenchmark('bench-1', runConfig as any, (e) => events.push(e));

      expect(events).toHaveLength(3);
      expect(events[1].type).toBe('progress');
    });
  });

  describe('runEvaluation', () => {
    const encoder = new TextEncoder();

    function makeSSEReader(events: string[]) {
      let callIndex = 0;
      const chunks = events.map(e => `data: ${e}\n\n`);
      return {
        read: jest.fn().mockImplementation(() => {
          if (callIndex < chunks.length) {
            return Promise.resolve({ done: false, value: encoder.encode(chunks[callIndex++]) });
          }
          return Promise.resolve({ done: true, value: undefined });
        }),
        cancel: jest.fn().mockResolvedValue(undefined),
      };
    }

    it('should throw on non-ok response with JSON error body', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        text: jest.fn().mockResolvedValue(JSON.stringify({ error: 'Test case not found' })),
      });

      await expect(
        client.runEvaluation('tc-1', 'mock', 'model-1')
      ).rejects.toThrow('Failed to run evaluation: Test case not found');
    });

    it('should throw on non-ok response with plain text error body', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        text: jest.fn().mockResolvedValue('Server error'),
      });

      await expect(
        client.runEvaluation('tc-1', 'mock', 'model-1')
      ).rejects.toThrow('Failed to run evaluation: Server error');
    });

    it('should throw when response body is missing', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        body: null,
      });

      await expect(
        client.runEvaluation('tc-1', 'mock', 'model-1')
      ).rejects.toThrow('Response body is missing');
    });

    it('should process completed event and return result', async () => {
      const mockResult = { id: 'report-1', status: 'completed', passFailStatus: 'passed', trajectorySteps: 3 };
      const reader = makeSSEReader([
        JSON.stringify({ type: 'started', testCase: 'tc-1', agent: 'mock' }),
        JSON.stringify({ type: 'completed', report: mockResult }),
      ]);

      mockFetch.mockResolvedValue({
        ok: true,
        body: { getReader: () => reader },
      });

      const events: any[] = [];
      const result = await client.runEvaluation('tc-1', 'mock', 'model-1', (e) => events.push(e));

      expect(result).toEqual(mockResult);
      expect(events).toHaveLength(2);
    });

    it('should throw on error event', async () => {
      const reader = makeSSEReader([
        JSON.stringify({ type: 'error', error: 'Agent crashed' }),
      ]);

      mockFetch.mockResolvedValue({
        ok: true,
        body: { getReader: () => reader },
      });

      await expect(
        client.runEvaluation('tc-1', 'mock', 'model-1')
      ).rejects.toThrow('Agent crashed');
    });

    it('should skip non-JSON SSE lines (SyntaxError)', async () => {
      const mockResult = { id: 'report-1', status: 'completed', trajectorySteps: 1 };
      let callIndex = 0;
      const chunks = [
        `data: {broken json\n\n`,
        `data: ${JSON.stringify({ type: 'completed', report: mockResult })}\n\n`,
      ];
      const reader = {
        read: jest.fn().mockImplementation(() => {
          if (callIndex < chunks.length) {
            return Promise.resolve({ done: false, value: encoder.encode(chunks[callIndex++]) });
          }
          return Promise.resolve({ done: true, value: undefined });
        }),
        cancel: jest.fn().mockResolvedValue(undefined),
      };

      mockFetch.mockResolvedValue({
        ok: true,
        body: { getReader: () => reader },
      });

      const result = await client.runEvaluation('tc-1', 'mock', 'model-1');
      expect(result).toEqual(mockResult);
    });

    it('should throw when stream ends without result', async () => {
      const reader = makeSSEReader([
        JSON.stringify({ type: 'started', testCase: 'tc-1', agent: 'mock' }),
      ]);

      mockFetch.mockResolvedValue({
        ok: true,
        body: { getReader: () => reader },
      });

      await expect(
        client.runEvaluation('tc-1', 'mock', 'model-1')
      ).rejects.toThrow('No result received from evaluation');
    });

    it('should process step events via onProgress', async () => {
      const mockResult = { id: 'report-1', status: 'completed', trajectorySteps: 1 };
      const reader = makeSSEReader([
        JSON.stringify({ type: 'started', testCase: 'tc-1', agent: 'mock' }),
        JSON.stringify({ type: 'step', stepIndex: 0, step: { type: 'thinking', content: 'Analyzing...' } }),
        JSON.stringify({ type: 'completed', report: mockResult }),
      ]);

      mockFetch.mockResolvedValue({
        ok: true,
        body: { getReader: () => reader },
      });

      const events: any[] = [];
      await client.runEvaluation('tc-1', 'mock', 'model-1', (e) => events.push(e));

      expect(events).toHaveLength(3);
      expect(events[1].type).toBe('step');
    });
  });

  describe('pollRunStatus', () => {
    it('should return run immediately when in terminal state', async () => {
      const mockRun = { id: 'run-1', status: 'completed', results: {} };
      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          id: 'bench-1',
          runs: [mockRun],
        }),
      });

      const result = await client.pollRunStatus('bench-1', 'run-1');
      expect(result).toEqual(mockRun);
    });

    it('should return null when run not found', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
      });

      const result = await client.pollRunStatus('bench-1', 'run-1');
      expect(result).toBeNull();
    });

    it('should call onProgress during polling', async () => {
      const mockRun = { id: 'run-1', status: 'completed', results: {} };
      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          id: 'bench-1',
          runs: [mockRun],
        }),
      });

      const progressCalls: any[] = [];
      await client.pollRunStatus('bench-1', 'run-1', (run) => progressCalls.push(run));

      expect(progressCalls).toHaveLength(1);
      expect(progressCalls[0]).toEqual(mockRun);
    });

    it('should return null for failed status', async () => {
      const mockRun = { id: 'run-1', status: 'failed', results: {} };
      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          id: 'bench-1',
          runs: [mockRun],
        }),
      });

      const result = await client.pollRunStatus('bench-1', 'run-1');
      expect(result).toEqual(mockRun);
    });

    it('should return run for cancelled status', async () => {
      const mockRun = { id: 'run-1', status: 'cancelled', results: {} };
      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          id: 'bench-1',
          runs: [mockRun],
        }),
      });

      const result = await client.pollRunStatus('bench-1', 'run-1');
      expect(result).toEqual(mockRun);
    });
  });

  describe('findTestCase', () => {
    it('should find test case by exact ID', async () => {
      const testCase = { id: 'tc-1', name: 'Test Case 1' };
      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue(testCase),
      });

      const result = await client.findTestCase('tc-1');
      expect(result).toEqual(testCase);
    });

    it('should find test case by name (case-insensitive) if ID not found', async () => {
      const testCase = { id: 'tc-1', name: 'My Test Case' };
      // First call (getTestCase by ID) returns 404
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });
      // Second call (listTestCasesWithMeta) returns the test case
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValue({ testCases: [testCase] }),
      });

      const result = await client.findTestCase('my test case');
      expect(result).toEqual(testCase);
    });

    it('should return null if not found by ID or name', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValue({ testCases: [] }),
      });

      const result = await client.findTestCase('non-existent');
      expect(result).toBeNull();
    });
  });

  describe('listTestCasesWithMeta', () => {
    it('should return test cases with metadata', async () => {
      const testCases = [{ id: 'tc-1', name: 'Test Case 1' }];
      const meta = { storageConfigured: true, storageReachable: true, realDataCount: 1, sampleDataCount: 0 };
      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ testCases, total: 1, meta }),
      });

      const result = await client.listTestCasesWithMeta();

      expect(result.data).toEqual(testCases);
      expect(result.total).toBe(1);
      expect(result.meta).toEqual(meta);
    });

    it('should provide default meta when not in response', async () => {
      const testCases = [{ id: 'tc-1', name: 'TC' }];
      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ testCases }),
      });

      const result = await client.listTestCasesWithMeta();

      expect(result.meta.storageConfigured).toBe(false);
      expect(result.meta.sampleDataCount).toBe(1);
    });

    it('should throw error on failure', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      await expect(client.listTestCasesWithMeta()).rejects.toThrow(
        'Failed to list test cases: 500 Internal Server Error'
      );
    });
  });

  describe('listBenchmarksWithMeta', () => {
    it('should return benchmarks with metadata', async () => {
      const benchmarks = [{ id: 'bench-1', name: 'Bench' }];
      const meta = { storageConfigured: true, storageReachable: true, realDataCount: 1, sampleDataCount: 0 };
      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ benchmarks, total: 1, meta }),
      });

      const result = await client.listBenchmarksWithMeta();

      expect(result.data).toEqual(benchmarks);
      expect(result.total).toBe(1);
    });

    it('should provide default meta when not in response', async () => {
      const benchmarks = [{ id: 'bench-1', name: 'B' }];
      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ benchmarks }),
      });

      const result = await client.listBenchmarksWithMeta();

      expect(result.meta.storageConfigured).toBe(false);
      expect(result.meta.sampleDataCount).toBe(1);
    });
  });

  describe('exportBenchmark', () => {
    it('should return exported test cases', async () => {
      const exported = [{ name: 'TC1', initialPrompt: 'test' }];
      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue(exported),
      });

      const result = await client.exportBenchmark('bench-1');
      expect(result).toEqual(exported);
    });

    it('should throw on 404', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
      });

      await expect(client.exportBenchmark('non-existent')).rejects.toThrow(
        'Benchmark not found: non-existent'
      );
    });

    it('should throw on other errors', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      await expect(client.exportBenchmark('bench-1')).rejects.toThrow(
        'Failed to export benchmark: 500 Internal Server Error'
      );
    });
  });

  describe('checkHealth edge cases', () => {
    it('should wrap non-Error thrown values', async () => {
      mockFetch.mockRejectedValue('string error');

      await expect(client.checkHealth(0)).rejects.toThrow('string error');
    });
  });

  describe('listAgents error handling', () => {
    it('should throw error on failure', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      await expect(client.listAgents()).rejects.toThrow(
        'Failed to list agents: 500 Internal Server Error'
      );
    });

    it('should return empty array when no agents', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({}),
      });

      const result = await client.listAgents();
      expect(result).toEqual([]);
    });
  });

  describe('listModels error handling', () => {
    it('should throw error on failure', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      await expect(client.listModels()).rejects.toThrow(
        'Failed to list models: 500 Internal Server Error'
      );
    });

    it('should return empty array when no models', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({}),
      });

      const result = await client.listModels();
      expect(result).toEqual([]);
    });
  });

  describe('listTestCases error handling', () => {
    it('should throw error on failure', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      await expect(client.listTestCases()).rejects.toThrow(
        'Failed to list test cases: 500 Internal Server Error'
      );
    });
  });

  describe('getTestCase error handling', () => {
    it('should throw error on non-404 failure', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      await expect(client.getTestCase('tc-1')).rejects.toThrow(
        'Failed to get test case: 500 Internal Server Error'
      );
    });
  });

  describe('updateBenchmark', () => {
    it('should PUT to the correct endpoint with updated fields', async () => {
      const updatedBenchmark = { id: 'bench-1', name: 'Benchmark 1', testCaseIds: ['tc-new-1', 'tc-new-2'] };
      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue(updatedBenchmark),
      });

      const result = await client.updateBenchmark('bench-1', {
        testCaseIds: ['tc-new-1', 'tc-new-2'],
      });

      expect(mockFetch).toHaveBeenCalledWith(
        `${baseUrl}/api/storage/benchmarks/bench-1`,
        expect.objectContaining({
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ testCaseIds: ['tc-new-1', 'tc-new-2'] }),
        })
      );
      expect(result).toEqual(updatedBenchmark);
    });

    it('should throw error on failure', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        text: jest.fn().mockResolvedValue('Not found'),
      });

      await expect(client.updateBenchmark('bench-1', { name: 'New Name' })).rejects.toThrow(
        'Failed to update benchmark: Not found'
      );
    });
  });

  describe('findBenchmark', () => {
    it('should return benchmark when found by ID', async () => {
      const benchmark = { id: 'bench-1', name: 'Benchmark 1', runs: [] };
      mockFetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue(benchmark),
      });

      const result = await client.findBenchmark('bench-1');

      expect(result).toEqual(benchmark);
    });

    it('should fall back to name match when ID not found', async () => {
      const benchmarks = [
        { id: 'bench-1', name: 'My Benchmark' },
        { id: 'bench-2', name: 'Other Benchmark' },
      ];
      // First call (getBenchmark by ID) returns 404
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });
      // Second call (listBenchmarks) returns list
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValue({ benchmarks }),
      });

      const result = await client.findBenchmark('My Benchmark');

      expect(result).toEqual(benchmarks[0]);
    });

    it('should return null when not found by ID or name', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValue({ benchmarks: [] }),
      });

      const result = await client.findBenchmark('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('pollReportStatus', () => {
    it('should poll until report reaches completed status', async () => {
      let callCount = 0;
      mockFetch.mockImplementation(() => {
        callCount++;
        const status = callCount >= 3 ? 'completed' : 'running';
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            id: 'report-123',
            status,
            passFailStatus: status === 'completed' ? 'passed' : undefined,
            metrics: status === 'completed' ? { accuracy: 85 } : undefined,
            trajectory: [{ type: 'action', content: 'test' }],
            llmJudgeReasoning: status === 'completed' ? 'Good job' : undefined,
          }),
        });
      });

      const result = await client.pollReportStatus('report-123', 30000);

      expect(result).toBeDefined();
      expect(result!.id).toBe('report-123');
      expect(result!.status).toBe('completed');
      expect(result!.passFailStatus).toBe('passed');
      expect(callCount).toBeGreaterThanOrEqual(3);
    });

    it('should return null if report is not found', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
      });

      const result = await client.pollReportStatus('nonexistent', 10000);
      expect(result).toBeNull();
    });

    it('should return report on failed status', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          id: 'report-fail',
          status: 'failed',
          trajectory: [],
          llmJudgeReasoning: 'Execution failed',
        }),
      });

      const result = await client.pollReportStatus('report-fail', 10000);
      expect(result).toBeDefined();
      expect(result!.status).toBe('failed');
    });

    it('should call onPoll callback on every poll cycle while waiting', async () => {
      let callCount = 0;
      mockFetch.mockImplementation(() => {
        callCount++;
        const status = callCount >= 3 ? 'completed' : 'running';
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            id: 'report-poll',
            status,
            passFailStatus: status === 'completed' ? 'passed' : undefined,
            metrics: { accuracy: 90 },
            trajectory: [],
            llmJudgeReasoning: status === 'completed' ? 'done' : undefined,
          }),
        });
      });

      const observed: string[] = [];
      const result = await client.pollReportStatus('report-poll', 30000, (r) => {
        observed.push(r.status as string);
      });

      expect(result).toBeDefined();
      expect(result!.status).toBe('completed');
      // Should have observed the running→completed transition
      expect(observed.length).toBeGreaterThanOrEqual(2);
      expect(observed[0]).toBe('running');
      expect(observed[observed.length - 1]).toBe('completed');
    }, 30000);
  });

  describe('runEvaluation - SSE disconnect recovery', () => {
    function createSSEStream(events: any[], disconnectAfter?: number) {
      const encoder = new TextEncoder();
      let eventIndex = 0;

      return new ReadableStream({
        pull(controller) {
          if (disconnectAfter !== undefined && eventIndex >= disconnectAfter) {
            controller.error(new Error('network disconnect'));
            return;
          }
          if (eventIndex < events.length) {
            const data = `data: ${JSON.stringify(events[eventIndex])}\n\n`;
            controller.enqueue(encoder.encode(data));
            eventIndex++;
          } else {
            controller.close();
          }
        },
      });
    }

    it('should fall back to polling when SSE stream disconnects after started event', async () => {
      const sseEvents = [
        { type: 'started', testCase: 'Test', agent: 'Agent', reportId: 'report-poll-1' },
        { type: 'step', stepIndex: 0, step: { type: 'action', content: 'doing stuff' } },
      ];

      // First call: SSE eval endpoint — disconnects after 2 events
      mockFetch.mockImplementationOnce(() => Promise.resolve({
        ok: true,
        body: createSSEStream(sseEvents, 2),
      }));

      // Subsequent calls: polling for report status
      let pollCount = 0;
      mockFetch.mockImplementation(() => {
        pollCount++;
        const status = pollCount >= 2 ? 'completed' : 'running';
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            id: 'report-poll-1',
            status,
            passFailStatus: status === 'completed' ? 'passed' : undefined,
            metrics: { accuracy: 90 },
            trajectory: [{ type: 'action', content: 'test' }],
            llmJudgeReasoning: 'Recovered via polling',
          }),
        });
      });

      const result = await client.runEvaluation('tc-1', 'observio', 'claude-sonnet-4');

      expect(result).toBeDefined();
      expect(result.id).toBe('report-poll-1');
      expect(result.status).toBe('completed');
    });

    it('should ignore heartbeat events and complete normally', async () => {
      const sseEvents = [
        { type: 'started', testCase: 'Test', agent: 'Agent', reportId: 'report-hb-1' },
        { type: 'heartbeat' },
        { type: 'step', stepIndex: 0, step: { type: 'action', content: 'working' } },
        { type: 'heartbeat' },
        { type: 'completed', report: { id: 'report-hb-1', status: 'completed', passFailStatus: 'passed', metrics: { accuracy: 95 }, trajectorySteps: 1, llmJudgeReasoning: 'Good' } },
      ];

      mockFetch.mockResolvedValue({
        ok: true,
        body: createSSEStream(sseEvents),
      });

      const progressEvents: any[] = [];
      const result = await client.runEvaluation('tc-1', 'observio', 'claude-sonnet-4', (e) => progressEvents.push(e));

      expect(result.status).toBe('completed');
      // Heartbeat events should NOT be forwarded to onProgress
      expect(progressEvents.some(e => e.type === 'heartbeat')).toBe(false);
      // But started, step, completed should be
      expect(progressEvents.some(e => e.type === 'started')).toBe(true);
      expect(progressEvents.some(e => e.type === 'step')).toBe(true);
    });

    it('should throw ServerError without polling fallback', async () => {
      const sseEvents = [
        { type: 'started', testCase: 'Test', agent: 'Agent', reportId: 'report-err-1' },
        { type: 'error', error: 'Agent endpoint unreachable' },
      ];

      mockFetch.mockResolvedValue({
        ok: true,
        body: createSSEStream(sseEvents),
      });

      await expect(
        client.runEvaluation('tc-1', 'observio', 'claude-sonnet-4')
      ).rejects.toThrow('Agent endpoint unreachable');
    });

    it('should poll when stream ends without completed event', async () => {
      const sseEvents = [
        { type: 'started', testCase: 'Test', agent: 'Agent', reportId: 'report-noend-1' },
        { type: 'step', stepIndex: 0, step: { type: 'action', content: 'working' } },
        // Stream ends without 'completed' event
      ];

      // First call: SSE
      mockFetch.mockImplementationOnce(() => Promise.resolve({
        ok: true,
        body: createSSEStream(sseEvents),
      }));

      // Polling calls
      mockFetch.mockImplementation(() => Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          id: 'report-noend-1',
          status: 'completed',
          passFailStatus: 'failed',
          metrics: { accuracy: 40 },
          trajectory: [{ type: 'action', content: 'test' }],
          llmJudgeReasoning: 'Incomplete execution',
        }),
      }));

      const result = await client.runEvaluation('tc-1', 'observio', 'claude-sonnet-4');
      expect(result.id).toBe('report-noend-1');
      expect(result.status).toBe('completed');
    });

    it('should emit synthetic reconnecting + polling events through onProgress on disconnect', async () => {
      // SSE drops after 2 events; client should emit:
      //   1. The original started/step events
      //   2. A synthetic { type: 'reconnecting', reportId } once polling starts
      //   3. One or more { type: 'polling', reportId, status } events per poll cycle
      const sseEvents = [
        { type: 'started', testCase: 'Test', agent: 'Agent', reportId: 'report-syn-1' },
        { type: 'step', stepIndex: 0, step: { type: 'action', content: 'x' } },
      ];
      mockFetch.mockImplementationOnce(() => Promise.resolve({
        ok: true,
        body: createSSEStream(sseEvents, 2),
      }));

      let pollCount = 0;
      mockFetch.mockImplementation(() => {
        pollCount++;
        const status = pollCount >= 2 ? 'completed' : 'running';
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            id: 'report-syn-1',
            status,
            passFailStatus: status === 'completed' ? 'passed' : undefined,
            metrics: { accuracy: 80 },
            trajectory: [{ type: 'action' }],
            llmJudgeReasoning: status === 'completed' ? 'ok' : undefined,
          }),
        });
      });

      const progressEvents: any[] = [];
      const result = await client.runEvaluation(
        'tc-1', 'observio', 'claude-sonnet-4',
        (e) => progressEvents.push(e),
      );

      expect(result.status).toBe('completed');
      // The original SSE events should be forwarded
      expect(progressEvents.some(e => e.type === 'started')).toBe(true);
      expect(progressEvents.some(e => e.type === 'step')).toBe(true);
      // The synthetic reconnect + polling lifecycle events must also appear
      const reconnect = progressEvents.find(e => e.type === 'reconnecting');
      expect(reconnect).toBeDefined();
      expect(reconnect.reportId).toBe('report-syn-1');
      const polling = progressEvents.filter(e => e.type === 'polling');
      expect(polling.length).toBeGreaterThanOrEqual(1);
      expect(polling[0].reportId).toBe('report-syn-1');
      expect(polling.map(e => e.status)).toEqual(
        expect.arrayContaining(['running']),
      );
    }, 30000);

    it('should emit reconnecting event when stream ends without completion', async () => {
      const sseEvents = [
        { type: 'started', testCase: 'Test', agent: 'Agent', reportId: 'report-noend-2' },
        // No completed, no error — stream just ends.
      ];
      mockFetch.mockImplementationOnce(() => Promise.resolve({
        ok: true,
        body: createSSEStream(sseEvents),
      }));
      mockFetch.mockImplementation(() => Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          id: 'report-noend-2',
          status: 'completed',
          passFailStatus: 'passed',
          metrics: { accuracy: 100 },
          trajectory: [],
          llmJudgeReasoning: 'fine',
        }),
      }));

      const progressEvents: any[] = [];
      await client.runEvaluation(
        'tc-1', 'observio', 'claude-sonnet-4',
        (e) => progressEvents.push(e),
      );
      expect(progressEvents.some(e => e.type === 'reconnecting' && e.reportId === 'report-noend-2')).toBe(true);
    });
  });
});
