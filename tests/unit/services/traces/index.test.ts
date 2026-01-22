/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// @ts-nocheck - Test file uses simplified mock objects for Span type
import {
  processSpansIntoTree,
  calculateTimeRange,
  getSpanColor,
  flattenVisibleSpans,
  fetchTraces,
  fetchTraceById,
  fetchTracesByRunIds,
  fetchRecentTraces,
  checkTracesHealth,
} from '@/services/traces';
import { Span } from '@/types';

// Mock fetch
global.fetch = jest.fn();

// Helper to create spans
function createSpan(overrides: Partial<Span> = {}): Span {
  return {
    traceId: 'trace-1',
    spanId: overrides.spanId || 'span-1',
    parentSpanId: overrides.parentSpanId,
    name: overrides.name || 'test-span',
    serviceName: 'test-service',
    startTime: overrides.startTime || '2024-01-01T00:00:00.000Z',
    endTime: overrides.endTime || '2024-01-01T00:00:01.000Z',
    durationMs: overrides.durationMs ?? 1000,
    status: overrides.status || 'OK',
    attributes: overrides.attributes || {},
    children: overrides.children,
    ...overrides,
  };
}

describe('Traces Service Index', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('processSpansIntoTree', () => {
    it('should return empty array for empty input', () => {
      expect(processSpansIntoTree([])).toEqual([]);
    });

    it('should return empty array for null/undefined input', () => {
      expect(processSpansIntoTree(null as any)).toEqual([]);
      expect(processSpansIntoTree(undefined as any)).toEqual([]);
    });

    it('should return single span as root', () => {
      const spans = [createSpan({ spanId: 'root' })];
      const result = processSpansIntoTree(spans);

      expect(result).toHaveLength(1);
      expect(result[0].spanId).toBe('root');
      expect(result[0].children).toEqual([]);
    });

    it('should build parent-child relationships', () => {
      const spans = [
        createSpan({ spanId: 'parent', startTime: '2024-01-01T00:00:00.000Z' }),
        createSpan({ spanId: 'child1', parentSpanId: 'parent', startTime: '2024-01-01T00:00:01.000Z' }),
        createSpan({ spanId: 'child2', parentSpanId: 'parent', startTime: '2024-01-01T00:00:02.000Z' }),
      ];

      const result = processSpansIntoTree(spans);

      expect(result).toHaveLength(1);
      expect(result[0].spanId).toBe('parent');
      expect(result[0].children).toHaveLength(2);
      expect(result[0].children![0].spanId).toBe('child1');
      expect(result[0].children![1].spanId).toBe('child2');
    });

    it('should handle multiple root spans', () => {
      const spans = [
        createSpan({ spanId: 'root1', startTime: '2024-01-01T00:00:00.000Z' }),
        createSpan({ spanId: 'root2', startTime: '2024-01-01T00:00:05.000Z' }),
      ];

      const result = processSpansIntoTree(spans);

      expect(result).toHaveLength(2);
      expect(result[0].spanId).toBe('root1');
      expect(result[1].spanId).toBe('root2');
    });

    it('should sort children by start time', () => {
      const spans = [
        createSpan({ spanId: 'parent' }),
        createSpan({ spanId: 'child1', parentSpanId: 'parent', startTime: '2024-01-01T00:00:03.000Z' }),
        createSpan({ spanId: 'child2', parentSpanId: 'parent', startTime: '2024-01-01T00:00:01.000Z' }),
        createSpan({ spanId: 'child3', parentSpanId: 'parent', startTime: '2024-01-01T00:00:02.000Z' }),
      ];

      const result = processSpansIntoTree(spans);

      expect(result[0].children![0].spanId).toBe('child2');
      expect(result[0].children![1].spanId).toBe('child3');
      expect(result[0].children![2].spanId).toBe('child1');
    });

    it('should handle deeply nested spans', () => {
      const spans = [
        createSpan({ spanId: 'root' }),
        createSpan({ spanId: 'child', parentSpanId: 'root' }),
        createSpan({ spanId: 'grandchild', parentSpanId: 'child' }),
      ];

      const result = processSpansIntoTree(spans);

      expect(result).toHaveLength(1);
      expect(result[0].children![0].spanId).toBe('child');
      expect(result[0].children![0].children![0].spanId).toBe('grandchild');
    });

    it('should handle orphan spans as roots', () => {
      const spans = [
        createSpan({ spanId: 'child', parentSpanId: 'nonexistent-parent' }),
      ];

      const result = processSpansIntoTree(spans);

      expect(result).toHaveLength(1);
      expect(result[0].spanId).toBe('child');
    });
  });

  describe('calculateTimeRange', () => {
    it('should return zero range for empty input', () => {
      expect(calculateTimeRange([])).toEqual({ startTime: 0, endTime: 0, duration: 0 });
    });

    it('should return zero range for null/undefined input', () => {
      expect(calculateTimeRange(null as any)).toEqual({ startTime: 0, endTime: 0, duration: 0 });
      expect(calculateTimeRange(undefined as any)).toEqual({ startTime: 0, endTime: 0, duration: 0 });
    });

    it('should calculate range for single span', () => {
      const spans = [createSpan({
        startTime: '2024-01-01T00:00:00.000Z',
        endTime: '2024-01-01T00:00:01.000Z',
      })];

      const result = calculateTimeRange(spans);

      expect(result.startTime).toBe(new Date('2024-01-01T00:00:00.000Z').getTime());
      expect(result.endTime).toBe(new Date('2024-01-01T00:00:01.000Z').getTime());
      expect(result.duration).toBe(1000);
    });

    it('should calculate range across multiple spans', () => {
      const spans = [
        createSpan({ startTime: '2024-01-01T00:00:05.000Z', endTime: '2024-01-01T00:00:06.000Z' }),
        createSpan({ startTime: '2024-01-01T00:00:00.000Z', endTime: '2024-01-01T00:00:02.000Z' }),
        createSpan({ startTime: '2024-01-01T00:00:08.000Z', endTime: '2024-01-01T00:00:10.000Z' }),
      ];

      const result = calculateTimeRange(spans);

      expect(result.startTime).toBe(new Date('2024-01-01T00:00:00.000Z').getTime());
      expect(result.endTime).toBe(new Date('2024-01-01T00:00:10.000Z').getTime());
      expect(result.duration).toBe(10000);
    });
  });

  describe('getSpanColor', () => {
    it('should return red for error spans', () => {
      const span = createSpan({ status: 'ERROR', name: 'any-name' });
      expect(getSpanColor(span)).toBe('#ef4444');
    });

    it('should return indigo for agent run spans', () => {
      expect(getSpanColor(createSpan({ name: 'agent.run' }))).toBe('#6366f1');
      expect(getSpanColor(createSpan({ name: 'run-operation' }))).toBe('#6366f1');
    });

    it('should return purple for LLM/bedrock spans', () => {
      expect(getSpanColor(createSpan({ name: 'bedrock-invoke' }))).toBe('#a855f7');
      expect(getSpanColor(createSpan({ name: 'llm-call' }))).toBe('#a855f7');
      expect(getSpanColor(createSpan({ name: 'converse-api' }))).toBe('#a855f7');
    });

    it('should return amber for tool spans', () => {
      expect(getSpanColor(createSpan({ name: 'tool-execution' }))).toBe('#f59e0b');
    });

    it('should return blue for node/process spans', () => {
      expect(getSpanColor(createSpan({ name: 'node-processing' }))).toBe('#3b82f6');
      expect(getSpanColor(createSpan({ name: 'process-step' }))).toBe('#3b82f6');
    });

    it('should return gray for default spans', () => {
      expect(getSpanColor(createSpan({ name: 'something-else' }))).toBe('#64748b');
    });

    it('should handle missing name', () => {
      expect(getSpanColor(createSpan({ name: undefined }))).toBe('#64748b');
    });
  });

  describe('flattenVisibleSpans', () => {
    it('should return empty array for empty input', () => {
      expect(flattenVisibleSpans([], new Set())).toEqual([]);
    });

    it('should flatten all spans when all expanded', () => {
      const parent = createSpan({ spanId: 'parent' });
      parent.children = [createSpan({ spanId: 'child', parentSpanId: 'parent' })];

      const result = flattenVisibleSpans([parent], new Set(['parent']));

      expect(result).toHaveLength(2);
      expect(result[0].spanId).toBe('parent');
      expect(result[0].depth).toBe(0);
      expect(result[0].hasChildren).toBe(true);
      expect(result[1].spanId).toBe('child');
      expect(result[1].depth).toBe(1);
    });

    it('should hide children when collapsed', () => {
      const parent = createSpan({ spanId: 'parent' });
      parent.children = [createSpan({ spanId: 'child', parentSpanId: 'parent' })];

      const result = flattenVisibleSpans([parent], new Set()); // No expanded spans

      expect(result).toHaveLength(1);
      expect(result[0].spanId).toBe('parent');
      expect(result[0].hasChildren).toBe(true);
    });

    it('should handle deeply nested expansion', () => {
      const grandchild = createSpan({ spanId: 'grandchild' });
      const child = createSpan({ spanId: 'child', children: [grandchild] });
      const parent = createSpan({ spanId: 'parent', children: [child] });

      const result = flattenVisibleSpans([parent], new Set(['parent', 'child']));

      expect(result).toHaveLength(3);
      expect(result[0].depth).toBe(0);
      expect(result[1].depth).toBe(1);
      expect(result[2].depth).toBe(2);
    });

    it('should mark spans without children correctly', () => {
      const spans = [createSpan({ spanId: 'leaf' })];

      const result = flattenVisibleSpans(spans, new Set());

      expect(result[0].hasChildren).toBe(false);
    });
  });

  describe('fetchTraces', () => {
    it('should make POST request with params', async () => {
      const mockResponse = { spans: [], total: 0 };
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const params = { traceId: 'test-trace-123' };
      const result = await fetchTraces(params);

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/traces'),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
          body: JSON.stringify(params),
        })
      );
      expect(result).toEqual(mockResponse);
    });

    it('should throw error on non-ok response', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: 'Server error' }),
      });

      await expect(fetchTraces({})).rejects.toThrow('Server error');
    });

    it('should handle non-JSON error response', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.reject(new Error('Not JSON')),
      });

      // When JSON parsing fails, it falls back to 'Unknown error' message
      await expect(fetchTraces({})).rejects.toThrow('Unknown error');
    });
  });

  describe('fetchTraceById', () => {
    it('should call fetchTraces with traceId', async () => {
      const mockResponse = { spans: [], total: 0 };
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      await fetchTraceById('trace-123');

      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: JSON.stringify({ traceId: 'trace-123' }),
        })
      );
    });
  });

  describe('fetchTracesByRunIds', () => {
    it('should call fetchTraces with runIds', async () => {
      const mockResponse = { spans: [], total: 0 };
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      await fetchTracesByRunIds(['run-1', 'run-2']);

      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: JSON.stringify({ runIds: ['run-1', 'run-2'] }),
        })
      );
    });
  });

  describe('fetchRecentTraces', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2024-01-01T12:00:00.000Z'));
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should call fetchTraces with time range defaults', async () => {
      const mockResponse = { spans: [], total: 0 };
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      await fetchRecentTraces({});

      const callBody = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
      expect(callBody.size).toBe(500);
      expect(callBody.endTime).toBeDefined();
      expect(callBody.startTime).toBeLessThan(callBody.endTime);
      // Default 5 minutes = 300000ms
      expect(callBody.endTime - callBody.startTime).toBe(300000);
    });

    it('should use custom options', async () => {
      const mockResponse = { spans: [], total: 0 };
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      await fetchRecentTraces({
        minutesAgo: 10,
        serviceName: 'my-service',
        textSearch: 'error',
        size: 100,
      });

      const callBody = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
      expect(callBody.serviceName).toBe('my-service');
      expect(callBody.textSearch).toBe('error');
      expect(callBody.size).toBe(100);
      expect(callBody.endTime - callBody.startTime).toBe(600000); // 10 minutes
    });
  });

  describe('checkTracesHealth', () => {
    it('should call health endpoint', async () => {
      const mockResponse = { status: 'healthy', index: 'traces-index' };
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        json: () => Promise.resolve(mockResponse),
      });

      const result = await checkTracesHealth();

      // Backend handles config resolution - no headers needed from frontend
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/traces/health')
      );
      expect(result).toEqual(mockResponse);
    });
  });
});
