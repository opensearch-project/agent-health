/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { formatCost, formatDuration, formatTokens } from '@/services/metrics';

describe('metrics utility functions', () => {
  describe('formatCost', () => {
    it('should format costs >= $0.01 with 2 decimal places', () => {
      expect(formatCost(1.5)).toBe('$1.50');
      expect(formatCost(0.05)).toBe('$0.05');
      expect(formatCost(0.01)).toBe('$0.01');
      expect(formatCost(10)).toBe('$10.00');
      expect(formatCost(123.456)).toBe('$123.46');
    });

    it('should format costs < $0.01 with 4 decimal places', () => {
      expect(formatCost(0.009)).toBe('$0.0090');
      expect(formatCost(0.001)).toBe('$0.0010');
      expect(formatCost(0.0005)).toBe('$0.0005');
      expect(formatCost(0.00001)).toBe('$0.0000');
    });

    it('should handle zero', () => {
      expect(formatCost(0)).toBe('$0.0000');
    });
  });

  describe('formatDuration', () => {
    it('should format milliseconds for durations < 1 second', () => {
      expect(formatDuration(100)).toBe('100ms');
      expect(formatDuration(500)).toBe('500ms');
      expect(formatDuration(999)).toBe('999ms');
      expect(formatDuration(1)).toBe('1ms');
    });

    it('should format seconds for durations >= 1 second and < 1 minute', () => {
      expect(formatDuration(1000)).toBe('1.0s');
      expect(formatDuration(1500)).toBe('1.5s');
      expect(formatDuration(30000)).toBe('30.0s');
      expect(formatDuration(59999)).toBe('60.0s');
    });

    it('should format minutes and seconds for durations >= 1 minute', () => {
      expect(formatDuration(60000)).toBe('1m 0s');
      expect(formatDuration(90000)).toBe('1m 30s');
      expect(formatDuration(120000)).toBe('2m 0s');
      expect(formatDuration(125000)).toBe('2m 5s');
      expect(formatDuration(3600000)).toBe('60m 0s');
    });

    it('should handle zero', () => {
      expect(formatDuration(0)).toBe('0ms');
    });

    it('should round milliseconds correctly', () => {
      expect(formatDuration(999.9)).toBe('1000ms');
      expect(formatDuration(50.4)).toBe('50ms');
    });
  });

  describe('formatTokens', () => {
    it('should format tokens < 1000 as plain numbers', () => {
      expect(formatTokens(0)).toBe('0');
      expect(formatTokens(1)).toBe('1');
      expect(formatTokens(100)).toBe('100');
      expect(formatTokens(999)).toBe('999');
    });

    it('should format tokens >= 1000 with K suffix', () => {
      expect(formatTokens(1000)).toBe('1.0K');
      expect(formatTokens(1500)).toBe('1.5K');
      expect(formatTokens(10000)).toBe('10.0K');
      expect(formatTokens(999999)).toBe('1000.0K');
    });

    it('should format tokens >= 1000000 with M suffix', () => {
      expect(formatTokens(1000000)).toBe('1.0M');
      expect(formatTokens(1500000)).toBe('1.5M');
      expect(formatTokens(10000000)).toBe('10.0M');
    });
  });
});

describe('metrics API functions', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = jest.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('fetchRunMetrics', () => {
    it('should be exported and callable', async () => {
      const { fetchRunMetrics } = await import('@/services/metrics');
      expect(typeof fetchRunMetrics).toBe('function');
    });

    it('should fetch metrics for a run ID', async () => {
      const mockMetrics = {
        runId: 'test-run-123',
        totalTokens: 1000,
        costUsd: 0.05,
        durationMs: 5000,
      };
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockMetrics),
      });

      const { fetchRunMetrics } = await import('@/services/metrics');
      const result = await fetchRunMetrics('test-run-123');

      // Backend handles config resolution - no headers needed from frontend
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/metrics/test-run-123')
      );
      expect(result).toEqual(mockMetrics);
    });

    it('should URL encode run ID', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      });

      const { fetchRunMetrics } = await import('@/services/metrics');
      await fetchRunMetrics('run/with/slashes');

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('run%2Fwith%2Fslashes')
      );
    });

    it('should throw error on non-OK response', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ error: 'Run not found' }),
      });

      const { fetchRunMetrics } = await import('@/services/metrics');

      await expect(fetchRunMetrics('test-run')).rejects.toThrow('Run not found');
    });

    it('should handle JSON parse failure on error response', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.reject(new Error('Invalid JSON')),
      });

      const { fetchRunMetrics } = await import('@/services/metrics');

      await expect(fetchRunMetrics('test-run')).rejects.toThrow('Unknown error');
    });
  });

  describe('fetchBatchMetrics', () => {
    it('should be exported and callable', async () => {
      const { fetchBatchMetrics } = await import('@/services/metrics');
      expect(typeof fetchBatchMetrics).toBe('function');
    });

    it('should fetch metrics for multiple run IDs', async () => {
      const mockResponse = {
        metrics: [
          { runId: 'run-1', totalTokens: 500 },
          { runId: 'run-2', totalTokens: 800 },
        ],
        aggregate: {
          totalRuns: 2,
          totalCostUsd: 0.05,
        },
      };
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const { fetchBatchMetrics } = await import('@/services/metrics');
      const result = await fetchBatchMetrics(['run-1', 'run-2']);

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/metrics/batch'),
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ runIds: ['run-1', 'run-2'] }),
        })
      );
      expect(result.metrics).toHaveLength(2);
      expect(result.aggregate.totalRuns).toBe(2);
    });

    it('should throw error on non-OK response', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ error: 'Invalid run IDs' }),
      });

      const { fetchBatchMetrics } = await import('@/services/metrics');

      await expect(fetchBatchMetrics(['run-1'])).rejects.toThrow('Invalid run IDs');
    });

    it('should handle JSON parse failure on error response', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.reject(new Error('Invalid JSON')),
      });

      const { fetchBatchMetrics } = await import('@/services/metrics');

      await expect(fetchBatchMetrics(['run-1'])).rejects.toThrow('Unknown error');
    });
  });
});
