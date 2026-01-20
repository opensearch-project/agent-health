/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// @ts-nocheck - Test file uses simplified mock objects
import { executeBenchmarkRun, cancelBenchmarkRun } from '@/services/client/benchmarkApi';
import type { RunConfigInput, BenchmarkRun, ExperimentProgress, ExperimentStartedEvent } from '@/types';

// Helper to create a mock ReadableStream from SSE data chunks
function createMockSSEStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;

  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]));
        index++;
      } else {
        controller.close();
      }
    },
  });
}

// Helper to format SSE data
function sseData(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

describe('benchmarkApi', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('executeBenchmarkRun', () => {
    const mockRunConfig: RunConfigInput = {
      name: 'Test Run',
      agent: { key: 'test-agent', name: 'Test Agent' },
      model: { key: 'test-model', name: 'Test Model' },
    };

    const mockCompletedRun: BenchmarkRun = {
      id: 'run-123',
      name: 'Test Run',
      createdAt: '2024-01-01T00:00:00Z',
      agent: { key: 'test-agent', name: 'Test Agent' },
      model: { key: 'test-model', name: 'Test Model' },
      status: 'completed',
      results: [],
    };

    it('should execute run and return completed result', async () => {
      const mockStream = createMockSSEStream([
        sseData({ type: 'started', runId: 'run-123', testCases: ['tc-1', 'tc-2'] }),
        sseData({ type: 'progress', runId: 'run-123', testCaseId: 'tc-1', status: 'completed' }),
        sseData({ type: 'progress', runId: 'run-123', testCaseId: 'tc-2', status: 'completed' }),
        sseData({ type: 'completed', run: mockCompletedRun }),
      ]);

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        body: mockStream,
      });

      const onProgress = jest.fn();
      const onStarted = jest.fn();

      const result = await executeBenchmarkRun(
        'exp-123',
        mockRunConfig,
        onProgress,
        onStarted
      );

      expect(global.fetch).toHaveBeenCalledWith(
        '/api/storage/benchmarks/exp-123/execute',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(mockRunConfig),
        })
      );

      expect(onStarted).toHaveBeenCalledWith({
        runId: 'run-123',
        testCases: ['tc-1', 'tc-2'],
      });

      expect(onProgress).toHaveBeenCalledTimes(2);
      expect(result).toEqual(mockCompletedRun);
    });

    it('should throw on HTTP error', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        statusText: 'Internal Server Error',
      });

      const onProgress = jest.fn();

      await expect(
        executeBenchmarkRun('exp-123', mockRunConfig, onProgress)
      ).rejects.toThrow('Failed to start benchmark run: Internal Server Error');
    });

    it('should throw when no response body', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        body: null,
      });

      const onProgress = jest.fn();

      await expect(
        executeBenchmarkRun('exp-123', mockRunConfig, onProgress)
      ).rejects.toThrow('No response body');
    });

    it('should throw on error event from server', async () => {
      const mockStream = createMockSSEStream([
        sseData({ type: 'started', runId: 'run-123' }),
        sseData({ type: 'error', error: 'Test case not found' }),
      ]);

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        body: mockStream,
      });

      const onProgress = jest.fn();

      await expect(
        executeBenchmarkRun('exp-123', mockRunConfig, onProgress)
      ).rejects.toThrow('Test case not found');
    });

    it('should throw when run completes without result', async () => {
      const mockStream = createMockSSEStream([
        sseData({ type: 'started', runId: 'run-123' }),
        sseData({ type: 'progress', runId: 'run-123', status: 'completed' }),
        // Missing 'completed' event with run result
      ]);

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        body: mockStream,
      });

      const onProgress = jest.fn();

      await expect(
        executeBenchmarkRun('exp-123', mockRunConfig, onProgress)
      ).rejects.toThrow('Run completed without returning result');
    });

    it('should handle incomplete JSON chunks gracefully', async () => {
      // Simulate a chunk being split across SSE boundaries
      const mockStream = createMockSSEStream([
        sseData({ type: 'started', runId: 'run-123', testCases: [] }),
        'data: {"type": "pro', // Incomplete JSON
        'gress", "runId": "run-123"}\n\n', // Rest of the JSON
        sseData({ type: 'completed', run: mockCompletedRun }),
      ]);

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        body: mockStream,
      });

      const onProgress = jest.fn();

      const result = await executeBenchmarkRun('exp-123', mockRunConfig, onProgress);

      // Should complete successfully despite the split chunk
      expect(result).toEqual(mockCompletedRun);
    });

    it('should process completed event in remaining buffer', async () => {
      // Completed event without trailing newlines (remaining in buffer)
      const mockStream = createMockSSEStream([
        sseData({ type: 'started', runId: 'run-123', testCases: [] }),
        `data: ${JSON.stringify({ type: 'completed', run: mockCompletedRun })}`, // No trailing \n\n
      ]);

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        body: mockStream,
      });

      const onProgress = jest.fn();

      const result = await executeBenchmarkRun('exp-123', mockRunConfig, onProgress);

      expect(result).toEqual(mockCompletedRun);
    });

    it('should throw on error event in remaining buffer', async () => {
      const mockStream = createMockSSEStream([
        sseData({ type: 'started', runId: 'run-123', testCases: [] }),
        `data: ${JSON.stringify({ type: 'error', error: 'Final error' })}`, // No trailing \n\n
      ]);

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        body: mockStream,
      });

      const onProgress = jest.fn();

      await expect(
        executeBenchmarkRun('exp-123', mockRunConfig, onProgress)
      ).rejects.toThrow('Final error');
    });

    it('should handle started event without testCases array', async () => {
      const mockStream = createMockSSEStream([
        sseData({ type: 'started', runId: 'run-123' }), // No testCases field
        sseData({ type: 'completed', run: mockCompletedRun }),
      ]);

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        body: mockStream,
      });

      const onProgress = jest.fn();
      const onStarted = jest.fn();

      await executeBenchmarkRun('exp-123', mockRunConfig, onProgress, onStarted);

      expect(onStarted).toHaveBeenCalledWith({
        runId: 'run-123',
        testCases: [],
      });
    });

    it('should work without onStarted callback', async () => {
      const mockStream = createMockSSEStream([
        sseData({ type: 'started', runId: 'run-123' }),
        sseData({ type: 'completed', run: mockCompletedRun }),
      ]);

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        body: mockStream,
      });

      const onProgress = jest.fn();

      // Should not throw even without onStarted callback
      const result = await executeBenchmarkRun('exp-123', mockRunConfig, onProgress);
      expect(result).toEqual(mockCompletedRun);
    });
  });

  describe('cancelBenchmarkRun', () => {
    it('should cancel run and return true on success', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ cancelled: true }),
      });

      const result = await cancelBenchmarkRun('exp-123', 'run-456');

      expect(global.fetch).toHaveBeenCalledWith(
        '/api/storage/benchmarks/exp-123/cancel',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ runId: 'run-456' }),
        })
      );

      expect(result).toBe(true);
    });

    it('should return false when cancelled is not true', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ cancelled: false }),
      });

      const result = await cancelBenchmarkRun('exp-123', 'run-456');

      expect(result).toBe(false);
    });

    it('should throw on HTTP error with JSON error message', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        statusText: 'Not Found',
        json: jest.fn().mockResolvedValue({ error: 'Run not found' }),
      });

      await expect(
        cancelBenchmarkRun('exp-123', 'run-456')
      ).rejects.toThrow('Run not found');
    });

    it('should throw on HTTP error when JSON parsing fails', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        statusText: 'Internal Server Error',
        json: jest.fn().mockRejectedValue(new Error('Invalid JSON')),
      });

      await expect(
        cancelBenchmarkRun('exp-123', 'run-456')
      ).rejects.toThrow('Internal Server Error');
    });

    it('should throw fallback error when no error message in response', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        statusText: 'Bad Request',
        json: jest.fn().mockResolvedValue({}), // No error field
      });

      await expect(
        cancelBenchmarkRun('exp-123', 'run-456')
      ).rejects.toThrow('Failed to cancel run');
    });
  });
});
