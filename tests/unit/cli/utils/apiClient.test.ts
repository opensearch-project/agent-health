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

    it('should throw error on failed health check', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
      });

      await expect(client.checkHealth()).rejects.toThrow(
        'Server health check failed: 503 Service Unavailable'
      );
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
});
