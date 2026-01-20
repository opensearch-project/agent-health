/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { MODEL_PRICING, getPricing, computeAggregateMetrics, computeMetrics } from '@/server/services/metricsService';
import type { MetricsResult, OpenSearchConfig } from '@/types';

// Mock fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

describe('metricsService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });
  describe('MODEL_PRICING', () => {
    it('should have pricing for Claude 4.x models', () => {
      expect(MODEL_PRICING['anthropic.claude-sonnet-4-20250514-v1:0']).toEqual({
        input: 3.0,
        output: 15.0,
      });
      expect(MODEL_PRICING['anthropic.claude-haiku-4-5-20250514-v1:0']).toEqual({
        input: 0.80,
        output: 4.0,
      });
    });

    it('should have pricing for Claude 3.x models', () => {
      expect(MODEL_PRICING['anthropic.claude-3-5-sonnet-20241022-v2:0']).toEqual({
        input: 3.0,
        output: 15.0,
      });
    });

    it('should have a default fallback pricing', () => {
      expect(MODEL_PRICING['default']).toEqual({
        input: 3.0,
        output: 15.0,
      });
    });
  });

  describe('getPricing', () => {
    it('should return default pricing when modelId is undefined', () => {
      expect(getPricing(undefined)).toEqual(MODEL_PRICING['default']);
    });

    it('should return exact match pricing', () => {
      const pricing = getPricing('anthropic.claude-sonnet-4-20250514-v1:0');
      expect(pricing).toEqual({ input: 3.0, output: 15.0 });
    });

    it('should return partial match pricing for region-prefixed model IDs', () => {
      // Model ID with region prefix should still find the base model pricing
      const pricing = getPricing('us-west-2.anthropic.claude-sonnet-4');
      expect(pricing).toEqual({ input: 3.0, output: 15.0 });
    });

    it('should return default pricing for unknown model', () => {
      const pricing = getPricing('unknown-model-id');
      expect(pricing).toEqual(MODEL_PRICING['default']);
    });

    it('should return haiku pricing for haiku models', () => {
      const pricing = getPricing('anthropic.claude-haiku-4');
      expect(pricing).toEqual({ input: 0.80, output: 4.0 });
    });
  });

  describe('computeAggregateMetrics', () => {
    it('should return zeros for empty array', () => {
      const result = computeAggregateMetrics([]);
      expect(result).toEqual({
        totalRuns: 0,
        successRate: 0,
        totalCostUsd: 0,
        avgCostUsd: 0,
        avgDurationMs: 0,
        p50DurationMs: 0,
        p95DurationMs: 0,
        avgTokens: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        avgLlmCalls: 0,
        avgToolCalls: 0,
      });
    });

    it('should return zeros for null/undefined input', () => {
      const result = computeAggregateMetrics(null as any);
      expect(result.totalRuns).toBe(0);
    });

    it('should compute aggregate metrics for single run', () => {
      const metrics: MetricsResult[] = [
        {
          runId: 'run-1',
          traceId: 'trace-1',
          inputTokens: 1000,
          outputTokens: 500,
          totalTokens: 1500,
          costUsd: 0.015,
          durationMs: 2000,
          llmCalls: 2,
          toolCalls: 3,
          toolsUsed: ['tool1', 'tool2', 'tool3'],
          status: 'success',
        },
      ];

      const result = computeAggregateMetrics(metrics);

      expect(result.totalRuns).toBe(1);
      expect(result.successRate).toBe(1);
      expect(result.totalCostUsd).toBe(0.015);
      expect(result.avgCostUsd).toBe(0.015);
      expect(result.avgDurationMs).toBe(2000);
      expect(result.totalInputTokens).toBe(1000);
      expect(result.totalOutputTokens).toBe(500);
      expect(result.avgTokens).toBe(1500);
      expect(result.avgLlmCalls).toBe(2);
      expect(result.avgToolCalls).toBe(3);
    });

    it('should compute aggregate metrics for multiple runs', () => {
      const metrics: MetricsResult[] = [
        {
          runId: 'run-1',
          traceId: 'trace-1',
          inputTokens: 1000,
          outputTokens: 500,
          totalTokens: 1500,
          costUsd: 0.01,
          durationMs: 1000,
          llmCalls: 2,
          toolCalls: 2,
          toolsUsed: ['tool1', 'tool2'],
          status: 'success',
        },
        {
          runId: 'run-2',
          traceId: 'trace-2',
          inputTokens: 2000,
          outputTokens: 1000,
          totalTokens: 3000,
          costUsd: 0.02,
          durationMs: 3000,
          llmCalls: 4,
          toolCalls: 4,
          toolsUsed: ['tool1', 'tool2', 'tool3', 'tool4'],
          status: 'success',
        },
      ];

      const result = computeAggregateMetrics(metrics);

      expect(result.totalRuns).toBe(2);
      expect(result.successRate).toBe(1);
      expect(result.totalCostUsd).toBe(0.03);
      expect(result.avgCostUsd).toBe(0.015);
      expect(result.avgDurationMs).toBe(2000);
      expect(result.totalInputTokens).toBe(3000);
      expect(result.totalOutputTokens).toBe(1500);
      expect(result.avgTokens).toBe(2250);
      expect(result.avgLlmCalls).toBe(3);
      expect(result.avgToolCalls).toBe(3);
    });

    it('should calculate success rate correctly with mixed statuses', () => {
      const metrics: MetricsResult[] = [
        {
          runId: 'run-1',
          traceId: 'trace-1',
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          costUsd: 0.001,
          durationMs: 100,
          llmCalls: 1,
          toolCalls: 1,
          toolsUsed: ['tool1'],
          status: 'success',
        },
        {
          runId: 'run-2',
          traceId: 'trace-2',
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          costUsd: 0.001,
          durationMs: 200,
          llmCalls: 1,
          toolCalls: 1,
          toolsUsed: ['tool1'],
          status: 'error',
        },
        {
          runId: 'run-3',
          traceId: 'trace-3',
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          costUsd: 0.001,
          durationMs: 300,
          llmCalls: 1,
          toolCalls: 1,
          toolsUsed: ['tool1'],
          status: 'pending',
        },
      ];

      const result = computeAggregateMetrics(metrics);

      expect(result.totalRuns).toBe(3);
      expect(result.successRate).toBeCloseTo(1 / 3);
    });

    it('should calculate percentile durations correctly', () => {
      const metrics: MetricsResult[] = Array.from({ length: 100 }, (_, i) => ({
        runId: `run-${i}`,
        traceId: `trace-${i}`,
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        costUsd: 0.001,
        durationMs: (i + 1) * 10, // 10, 20, 30, ..., 1000
        llmCalls: 1,
        toolCalls: 1,
        toolsUsed: ['tool1'],
        status: 'success' as const,
      }));

      const result = computeAggregateMetrics(metrics);

      expect(result.p50DurationMs).toBe(510); // index 50 value
      expect(result.p95DurationMs).toBe(960); // index 95 value
    });

    it('should handle metrics with missing optional fields', () => {
      const metrics: MetricsResult[] = [
        {
          runId: 'run-1',
          traceId: null,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          costUsd: 0,
          durationMs: 0,
          llmCalls: 0,
          toolCalls: 0,
          toolsUsed: [],
          status: 'pending',
        },
      ];

      const result = computeAggregateMetrics(metrics);

      expect(result.totalRuns).toBe(1);
      expect(result.successRate).toBe(0);
      expect(result.totalCostUsd).toBe(0);
      expect(result.avgDurationMs).toBe(0);
    });
  });

  describe('computeMetrics', () => {
    const defaultConfig: OpenSearchConfig = {
      endpoint: 'http://localhost:9200',
      username: 'admin',
      password: 'admin',
      indexPattern: 'otel-v1-apm-span-*',
    };

    it('should return pending metrics when no spans found', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ hits: { hits: [] } }),
      });

      const result = await computeMetrics('test-run', defaultConfig);

      expect(result.runId).toBe('test-run');
      expect(result.traceId).toBeNull();
      expect(result.status).toBe('pending');
      expect(result.totalTokens).toBe(0);
    });

    it('should throw error on non-OK response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal server error'),
      });

      await expect(computeMetrics('test-run', defaultConfig)).rejects.toThrow(
        'OpenSearch query failed'
      );
    });

    it('should compute metrics from spans with token usage', async () => {
      const mockResponse = {
        hits: {
          hits: [
            {
              _source: {
                name: 'agent.run',
                traceId: 'trace-123',
                startTime: '2024-01-01T00:00:00Z',
                endTime: '2024-01-01T00:00:02Z',
                durationInNanos: 2000000000, // 2 seconds
                'status.code': 1,
                'span.attributes.gen_ai@usage@input_tokens': 1000,
                'span.attributes.gen_ai@usage@output_tokens': 500,
                'span.attributes.gen_ai@request@model': 'anthropic.claude-sonnet-4',
              },
            },
          ],
        },
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await computeMetrics('test-run', defaultConfig);

      expect(result.runId).toBe('test-run');
      expect(result.traceId).toBe('trace-123');
      expect(result.inputTokens).toBe(1000);
      expect(result.outputTokens).toBe(500);
      expect(result.totalTokens).toBe(1500);
      expect(result.llmCalls).toBe(1);
      expect(result.durationMs).toBe(2000);
      expect(result.status).toBe('success');
    });

    it('should count tool executions', async () => {
      const mockResponse = {
        hits: {
          hits: [
            {
              _source: {
                name: 'agent.run',
                traceId: 'trace-123',
                durationInNanos: 1000000000,
                'status.code': 1,
              },
            },
            {
              _source: {
                name: 'agent.tool.execute',
                'span.attributes.gen_ai@tool@name': 'search_tool',
              },
            },
            {
              _source: {
                name: 'agent.tool.execute',
                'span.attributes.tool.name': 'calculator_tool',
              },
            },
            {
              _source: {
                name: 'custom.tool',
                'span.attributes.gen_ai@tool@name': 'custom_tool',
              },
            },
          ],
        },
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await computeMetrics('test-run', defaultConfig);

      expect(result.toolCalls).toBe(3);
      expect(result.toolsUsed).toContain('search_tool');
      expect(result.toolsUsed).toContain('calculator_tool');
      expect(result.toolsUsed).toContain('custom_tool');
    });

    it('should aggregate tokens from multiple LLM spans', async () => {
      const mockResponse = {
        hits: {
          hits: [
            {
              _source: {
                name: 'llm.call.1',
                traceId: 'trace-123',
                'span.attributes.gen_ai@usage@input_tokens': 500,
                'span.attributes.gen_ai@usage@output_tokens': 200,
                'span.attributes.gen_ai@request@model': 'anthropic.claude-sonnet-4',
              },
            },
            {
              _source: {
                name: 'llm.call.2',
                traceId: 'trace-123',
                'span.attributes.gen_ai@usage@input_tokens': 800,
                'span.attributes.gen_ai@usage@output_tokens': 300,
                'span.attributes.gen_ai@request@model': 'anthropic.claude-sonnet-4',
              },
            },
          ],
        },
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await computeMetrics('test-run', defaultConfig);

      expect(result.inputTokens).toBe(1300);
      expect(result.outputTokens).toBe(500);
      expect(result.totalTokens).toBe(1800);
      expect(result.llmCalls).toBe(2);
    });

    it('should calculate duration from first to last span when no root span', async () => {
      const mockResponse = {
        hits: {
          hits: [
            {
              _source: {
                name: 'span.1',
                traceId: 'trace-123',
                startTime: '2024-01-01T00:00:00Z',
                endTime: '2024-01-01T00:00:01Z',
              },
            },
            {
              _source: {
                name: 'span.2',
                traceId: 'trace-123',
                startTime: '2024-01-01T00:00:01Z',
                endTime: '2024-01-01T00:00:05Z',
              },
            },
          ],
        },
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await computeMetrics('test-run', defaultConfig);

      expect(result.durationMs).toBe(5000); // 5 seconds
    });

    it('should detect error status from root span', async () => {
      const mockResponse = {
        hits: {
          hits: [
            {
              _source: {
                name: 'agent.run',
                traceId: 'trace-123',
                durationInNanos: 1000000000,
                'status.code': 2, // Error status
              },
            },
          ],
        },
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await computeMetrics('test-run', defaultConfig);

      expect(result.status).toBe('error');
    });

    it('should detect error status from any span when no root span', async () => {
      const mockResponse = {
        hits: {
          hits: [
            {
              _source: {
                name: 'span.1',
                traceId: 'trace-123',
                'status.code': 1, // Success
              },
            },
            {
              _source: {
                name: 'span.2',
                traceId: 'trace-123',
                'status.code': 2, // Error
              },
            },
          ],
        },
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await computeMetrics('test-run', defaultConfig);

      expect(result.status).toBe('error');
    });

    it('should calculate cost correctly based on model pricing', async () => {
      const mockResponse = {
        hits: {
          hits: [
            {
              _source: {
                name: 'llm.call',
                traceId: 'trace-123',
                'span.attributes.gen_ai@usage@input_tokens': 1000000, // 1M input tokens
                'span.attributes.gen_ai@usage@output_tokens': 100000, // 100K output tokens
                'span.attributes.gen_ai@request@model': 'anthropic.claude-sonnet-4',
              },
            },
          ],
        },
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await computeMetrics('test-run', defaultConfig);

      // Claude Sonnet 4: $3/1M input + $15/1M output
      // Cost = (1M/1M) * $3 + (100K/1M) * $15 = $3 + $1.5 = $4.5
      expect(result.costUsd).toBeCloseTo(4.5);
    });

    it('should send correct headers and query to OpenSearch', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ hits: { hits: [] } }),
      });

      await computeMetrics('test-run-123', defaultConfig);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:9200/otel-v1-apm-span-*/_search',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            Authorization: expect.stringContaining('Basic'),
          }),
        })
      );

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(requestBody.query.bool.must[0].term['span.attributes.gen_ai@request@id']).toBe(
        'test-run-123'
      );
    });

    it('should use default index pattern when not provided', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ hits: { hits: [] } }),
      });

      const configWithoutIndex = {
        endpoint: 'http://localhost:9200',
        username: 'admin',
        password: 'admin',
        indexPattern: 'otel-v1-apm-span-*',
      };

      await computeMetrics('test-run', configWithoutIndex);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:9200/otel-v1-apm-span-*/_search',
        expect.any(Object)
      );
    });
  });
});
