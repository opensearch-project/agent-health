/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { MODEL_PRICING, getPricing, computeAggregateMetrics, computeMetrics, computeMetricsFromSpans, computeBatchMetrics } from '@/server/services/metricsService';
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
                status: { code: 1 },
                attributes: {
                  'gen_ai.usage.input_tokens': 1000,
                  'gen_ai.usage.output_tokens': 500,
                  'gen_ai.request.model': 'anthropic.claude-sonnet-4',
                },
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

    it('adds a Strategy-A traceId should-clause when a traceId correlator is passed', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ hits: { hits: [] } }),
      });

      await computeMetrics('run-with-no-native-id', defaultConfig, undefined, 'trace-abc-123');

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      const should = requestBody.query.bool.must[0].bool.should;
      expect(should).toEqual(expect.arrayContaining([{ terms: { traceId: ['trace-abc-123'] } }]));
    });

    it('omits the traceId should-clause when no traceId correlator is passed', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ hits: { hits: [] } }),
      });

      await computeMetrics('run-x', defaultConfig);

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      const should = requestBody.query.bool.must[0].bool.should;
      expect(should.some((c: any) => c.term && 'traceId' in c.term)).toBe(false);
    });

    it('finds a REST-connector run (no agent_health.run.id/gen_ai.conversation.id attrs) via the traceId correlator alone', async () => {
      // REST connectors never get a native runId, so `report.runId` falls back
      // to `report.traceId` upstream — the ONLY thing that reaches the agent's
      // spans is a direct traceId match (Strategy A), not Strategy B.
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          hits: {
            hits: [
              {
                _source: {
                  name: 'invoke_agent',
                  traceId: 'trace-rest-1',
                  durationInNanos: 1000000000,
                  status: { code: 1 },
                  attributes: {
                    'gen_ai.request.model': 'anthropic.claude-sonnet-4',
                    'gen_ai.usage.input_tokens': 300,
                    'gen_ai.usage.output_tokens': 50,
                  },
                },
              },
            ],
          },
        }),
      });

      const result = await computeMetrics('trace-rest-1', defaultConfig, undefined, 'trace-rest-1');

      expect(result.status).toBe('success');
      expect(result.inputTokens).toBe(300);
      expect(result.llmCalls).toBe(1);
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
                status: { code: 1 },
              },
            },
            {
              _source: {
                name: 'agent.tool.execute',
                attributes: { 'gen_ai.tool.name': 'search_tool' },
              },
            },
            {
              _source: {
                name: 'agent.tool.execute',
                attributes: { 'tool.name': 'calculator_tool' },
              },
            },
            {
              _source: {
                name: 'custom.tool',
                attributes: { 'gen_ai.tool.name': 'custom_tool' },
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
                attributes: {
                  'gen_ai.usage.input_tokens': 500,
                  'gen_ai.usage.output_tokens': 200,
                  'gen_ai.request.model': 'anthropic.claude-sonnet-4',
                },
              },
            },
            {
              _source: {
                name: 'llm.call.2',
                traceId: 'trace-123',
                attributes: {
                  'gen_ai.usage.input_tokens': 800,
                  'gen_ai.usage.output_tokens': 300,
                  'gen_ai.request.model': 'anthropic.claude-sonnet-4',
                },
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
                status: { code: 2 }, // Error status
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
                status: { code: 1 }, // Success
              },
            },
            {
              _source: {
                name: 'span.2',
                traceId: 'trace-123',
                status: { code: 2 }, // Error
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
                attributes: {
                  'gen_ai.usage.input_tokens': 1000000, // 1M input tokens
                  'gen_ai.usage.output_tokens': 100000, // 100K output tokens
                  'gen_ai.request.model': 'anthropic.claude-sonnet-4',
                },
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
      // Strategy B matches agent_health.run.id OR the OTEL-standard
      // gen_ai.conversation.id (both stamped = runId by our producers), under
      // every index schema — nested `attributes.*` (+ its `.keyword` multi-field
      // for dynamically mapped text) AND the flat `@`-encoded
      // `span.attributes.*` the live `otel-v1-apm-span-*` index uses. The
      // single-run path delegates to the shared `terms` builder with a
      // one-element array (functionally a `term`).
      const should = requestBody.query.bool.must[0].bool.should;
      expect(should).toEqual([
        { terms: { 'attributes.agent_health.run.id': ['test-run-123'] } },
        { terms: { 'attributes.agent_health.run.id.keyword': ['test-run-123'] } },
        { terms: { 'span.attributes.agent_health@run@id': ['test-run-123'] } },
        { terms: { 'attributes.gen_ai.conversation.id': ['test-run-123'] } },
        { terms: { 'attributes.gen_ai.conversation.id.keyword': ['test-run-123'] } },
        { terms: { 'span.attributes.gen_ai@conversation@id': ['test-run-123'] } },
      ]);
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

    it('ORs in Strategy-D session.id clauses when a sessionId is supplied (agents that never stamp agent_health.run.id / gen_ai.conversation.id, e.g. Claude Code)', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ hits: { hits: [] } }),
      });

      await computeMetrics('test-run-123', defaultConfig, 'e84af53e-6920-44a5-bd75-5ee6cebf58c6');

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      const should = requestBody.query.bool.must[0].bool.should;
      expect(should).toEqual(expect.arrayContaining([
        { terms: { 'attributes.agent_health.run.id': ['test-run-123'] } },
        { terms: { 'attributes.agent_health.run.id.keyword': ['test-run-123'] } },
        { terms: { 'span.attributes.agent_health@run@id': ['test-run-123'] } },
        { terms: { 'attributes.gen_ai.conversation.id': ['test-run-123'] } },
        { terms: { 'attributes.gen_ai.conversation.id.keyword': ['test-run-123'] } },
        { terms: { 'span.attributes.gen_ai@conversation@id': ['test-run-123'] } },
      ]));
      const sessionClause = should.find((c: any) => c.terms?.['attributes.session.id.keyword']);
      expect(sessionClause.terms['attributes.session.id.keyword']).toEqual(['e84af53e-6920-44a5-bd75-5ee6cebf58c6']);
      // Flat-@ schema path is queried too.
      expect(should.find((c: any) => c.terms?.['span.attributes.session@id'])).toBeTruthy();
    });

    it('does not add session.id clauses when no sessionId is supplied (unchanged query shape)', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ hits: { hits: [] } }),
      });

      await computeMetrics('test-run-123', defaultConfig);

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      const should = requestBody.query.bool.must[0].bool.should;
      // Exactly the six Strategy-B clauses (2 run-id attributes x 3 field
      // paths: nested, nested .keyword, flat-@), no session.id / traceId clauses.
      expect(should).toHaveLength(6);
      expect(JSON.stringify(should)).not.toContain('session');
      expect(JSON.stringify(should)).not.toContain('traceId');
    });
  });

  describe('computeMetricsFromSpans', () => {
    it('should return pending metrics for empty spans', () => {
      const result = computeMetricsFromSpans('run-1', []);
      expect(result.runId).toBe('run-1');
      expect(result.status).toBe('pending');
      expect(result.totalTokens).toBe(0);
    });

    it('should set hasSpans:false for empty spans (regression: nonexistent runId indistinguishable from real zero-cost run)', () => {
      const result = computeMetricsFromSpans('run-does-not-exist', []);
      expect(result.hasSpans).toBe(false);
    });

    it('should set hasSpans:true when spans exist, even with zero cost', () => {
      const spans = [
        {
          name: 'agent.run',
          traceId: 'trace-1',
          durationInNanos: 1000000,
          status: { code: 1 },
          attributes: {},
        },
      ];
      const result = computeMetricsFromSpans('run-1', spans);
      expect(result.hasSpans).toBe(true);
      expect(result.costUsd).toBe(0);
    });

    it('should compute metrics from spans with token usage', () => {
      const spans = [
        {
          name: 'agent.run',
          traceId: 'trace-1',
          durationInNanos: 3000000000,
          status: { code: 1 },
          attributes: {
            'gen_ai.usage.input_tokens': 500,
            'gen_ai.usage.output_tokens': 200,
            'gen_ai.request.model': 'anthropic.claude-sonnet-4',
          },
        },
      ];

      const result = computeMetricsFromSpans('run-1', spans);

      expect(result.inputTokens).toBe(500);
      expect(result.outputTokens).toBe(200);
      expect(result.totalTokens).toBe(700);
      expect(result.llmCalls).toBe(1);
      expect(result.durationMs).toBe(3000);
      expect(result.status).toBe('success');
      expect(result.traceId).toBe('trace-1');
    });

    it('falls back to vendor SDK token keys (Claude Code emits bare input_tokens/output_tokens, not gen_ai.usage.*)', () => {
      // Real shape captured from a live Claude Code `claude_code.llm_request`
      // span (comparison-page Cost/Tokens/LLM Calls columns bug): it stamps
      // `gen_ai.request.model` correctly but reports usage under bare
      // `input_tokens` / `output_tokens`, not the OTel registry names.
      const spans = [
        {
          name: 'claude_code.llm_request',
          traceId: 'trace-cc-1',
          durationInNanos: 7238000000,
          status: { code: 1 },
          attributes: {
            'gen_ai.system': 'anthropic',
            'gen_ai.request.model': 'global.anthropic.claude-sonnet-4-6',
            'span.type': 'llm_request',
            input_tokens: 34947,
            output_tokens: 313,
          },
        },
      ];

      const result = computeMetricsFromSpans('run-cc-1', spans);

      expect(result.inputTokens).toBe(34947);
      expect(result.outputTokens).toBe(313);
      expect(result.totalTokens).toBe(35260);
      expect(result.llmCalls).toBe(1);
      expect(result.costUsd).toBeGreaterThan(0);
    });

    it('prefers gen_ai.usage.* registry keys over vendor keys when both are present', () => {
      const spans = [
        {
          name: 'chat',
          attributes: {
            'gen_ai.request.model': 'anthropic.claude-sonnet-4',
            'gen_ai.usage.input_tokens': 10,
            'gen_ai.usage.output_tokens': 5,
            input_tokens: 999,
            output_tokens: 999,
          },
        },
      ];

      const result = computeMetricsFromSpans('run-1', spans);

      expect(result.inputTokens).toBe(10);
      expect(result.outputTokens).toBe(5);
    });

    it('excludes agent-health eval/judge spans from token/LLM-call counts (Strategy A can pull in the shared trace)', () => {
      const spans = [
        {
          name: 'test_case',
          attributes: {
            'gen_ai.operation.name': 'evaluation',
          },
        },
        {
          name: 'chat',
          attributes: {
            'gen_ai.operation.name': 'evaluation',
            'gen_ai.request.model': 'judge-model',
            'gen_ai.usage.input_tokens': 9999,
            'gen_ai.usage.output_tokens': 9999,
          },
        },
        {
          name: 'claude_code.llm_request',
          attributes: {
            'gen_ai.request.model': 'anthropic.claude-sonnet-4',
            input_tokens: 500,
            output_tokens: 100,
          },
        },
      ];

      const result = computeMetricsFromSpans('run-1', spans);

      // Only the agent's own LLM span counts — the eval/judge spans sharing
      // the trace are excluded entirely.
      expect(result.inputTokens).toBe(500);
      expect(result.outputTokens).toBe(100);
      expect(result.llmCalls).toBe(1);
    });
  });

  describe('computeBatchMetrics', () => {
    const defaultConfig: OpenSearchConfig = {
      endpoint: 'http://localhost:9200',
      username: 'admin',
      password: 'admin',
      indexPattern: 'otel-v1-apm-span-*',
    };

    it('should return empty array for empty run IDs', async () => {
      const result = await computeBatchMetrics([], defaultConfig);
      expect(result).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should use terms query to fetch spans for multiple runs', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          hits: {
            hits: [
              {
                _source: {
                  name: 'agent.run',
                  traceId: 'trace-1',
                  durationInNanos: 1000000000,
                  status: { code: 1 },
                  attributes: {
                    'agent_health.run.id': 'run-1',
                    'gen_ai.usage.input_tokens': 100,
                    'gen_ai.usage.output_tokens': 50,
                    'gen_ai.request.model': 'anthropic.claude-sonnet-4',
                  },
                },
              },
              {
                _source: {
                  name: 'agent.run',
                  traceId: 'trace-2',
                  durationInNanos: 2000000000,
                  status: { code: 1 },
                  attributes: {
                    'agent_health.run.id': 'run-2',
                    'gen_ai.usage.input_tokens': 200,
                    'gen_ai.usage.output_tokens': 100,
                    'gen_ai.request.model': 'anthropic.claude-sonnet-4',
                  },
                },
              },
            ],
          },
        }),
      });

      const result = await computeBatchMetrics(['run-1', 'run-2'], defaultConfig);

      expect(result).toHaveLength(2);
      expect(result[0].runId).toBe('run-1');
      expect(result[0].inputTokens).toBe(100);
      expect(result[1].runId).toBe('run-2');
      expect(result[1].inputTokens).toBe(200);

      // Should use terms query (single request for both IDs)
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      const should = requestBody.query.bool.must[0].bool.should;
      expect(should).toEqual([
        { terms: { 'attributes.agent_health.run.id': ['run-1', 'run-2'] } },
        { terms: { 'attributes.agent_health.run.id.keyword': ['run-1', 'run-2'] } },
        { terms: { 'span.attributes.agent_health@run@id': ['run-1', 'run-2'] } },
        { terms: { 'attributes.gen_ai.conversation.id': ['run-1', 'run-2'] } },
        { terms: { 'attributes.gen_ai.conversation.id.keyword': ['run-1', 'run-2'] } },
        { terms: { 'span.attributes.gen_ai@conversation@id': ['run-1', 'run-2'] } },
      ]);
    });

    it('should return pending metrics for run IDs with no matching spans', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ hits: { hits: [] } }),
      });

      const result = await computeBatchMetrics(['run-no-data'], defaultConfig);

      expect(result).toHaveLength(1);
      expect(result[0].runId).toBe('run-no-data');
      expect(result[0].status).toBe('pending');
    });

    it('should handle OpenSearch failure gracefully', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal error'),
      });

      const result = await computeBatchMetrics(['run-1', 'run-2'], defaultConfig);

      expect(result).toHaveLength(2);
      expect(result[0].status).toBe('pending');
      expect(result[1].status).toBe('pending');
    });

    it('ORs in Strategy-D session.id terms (one per runId) when sessionIdByRunId is supplied', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ hits: { hits: [] } }),
      });

      await computeBatchMetrics(
        ['run-1', 'run-2'],
        defaultConfig,
        { 'run-1': 'session-aaa', 'run-2': 'session-bbb' }
      );

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      const should = requestBody.query.bool.must[0].bool.should;
      const sessionClause = should.find((c: any) => c.terms?.['attributes.session.id.keyword']);
      expect(sessionClause.terms['attributes.session.id.keyword'].sort()).toEqual(['session-aaa', 'session-bbb']);
    });

    it('groups a session.id-matched span back to the runId that requested that session (Strategy D grouping)', async () => {
      // The Claude-Code motivating case: this span carries NEITHER
      // agent_health.run.id NOR gen_ai.conversation.id -- only session.id, so
      // the OLD grouping logic (agent_health.run.id only) would silently drop
      // this span and the run would show "--" despite the span existing.
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          hits: {
            hits: [
              {
                _source: {
                  name: 'agent.run',
                  traceId: 'trace-sessioned',
                  durationInNanos: 1000000000,
                  status: { code: 1 },
                  attributes: {
                    'session.id': 'session-aaa',
                    'gen_ai.usage.input_tokens': 40,
                    'gen_ai.usage.output_tokens': 10,
                    'gen_ai.request.model': 'anthropic.claude-sonnet-4',
                  },
                },
              },
            ],
          },
        }),
      });

      const result = await computeBatchMetrics(
        ['run-1', 'run-2'],
        defaultConfig,
        { 'run-1': 'session-aaa', 'run-2': 'session-bbb' }
      );

      const run1 = result.find(r => r.runId === 'run-1')!;
      const run2 = result.find(r => r.runId === 'run-2')!;
      expect(run1.status).toBe('success');
      expect(run1.inputTokens).toBe(40);
      expect(run2.status).toBe('pending'); // no span carried session-bbb
    });

    it('groups a gen_ai.conversation.id-matched span back to its runId (pre-existing grouping gap, fixed alongside Strategy D)', () => {
      // Regression: the OLD grouping code only ever checked
      // `agent_health.run.id` when routing a matched span back to its runId --
      // a span that matched via the OR'd `gen_ai.conversation.id` clause was
      // silently dropped even though the query itself matched it.
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          hits: {
            hits: [
              {
                _source: {
                  name: 'agent.run',
                  traceId: 'trace-conv',
                  durationInNanos: 500000000,
                  status: { code: 1 },
                  attributes: { 'gen_ai.conversation.id': 'run-2' },
                },
              },
            ],
          },
        }),
      });

      return computeBatchMetrics(['run-1', 'run-2'], defaultConfig).then((result) => {
        const run2 = result.find(r => r.runId === 'run-2')!;
        expect(run2.status).toBe('success');
        expect(run2.durationMs).toBe(500);
      });
    });

    it('adds a Strategy-A traceId terms should-clause and groups spans back by traceId (REST-connector / vendor-SDK runs)', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          hits: {
            hits: [
              {
                // No agent_health.run.id / gen_ai.conversation.id at all —
                // only findable via the traceId correlator.
                _source: {
                  name: 'claude_code.llm_request',
                  traceId: 'trace-cc-run-1',
                  attributes: {
                    'gen_ai.request.model': 'anthropic.claude-sonnet-4',
                    input_tokens: 400,
                    output_tokens: 80,
                  },
                },
              },
            ],
          },
        }),
      });

      const result = await computeBatchMetrics(
        ['run-cc-1'],
        defaultConfig,
        undefined,
        { 'run-cc-1': 'trace-cc-run-1' }
      );

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      const should = requestBody.query.bool.must[0].bool.should;
      expect(should).toEqual(expect.arrayContaining([{ terms: { traceId: ['trace-cc-run-1'] } }]));

      expect(result).toHaveLength(1);
      expect(result[0].runId).toBe('run-cc-1');
      expect(result[0].inputTokens).toBe(400);
      expect(result[0].outputTokens).toBe(80);
    });

    it('groups a span matched only via gen_ai.conversation.id back to its runId (pre-fix this silently dropped it)', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          hits: {
            hits: [
              {
                _source: {
                  name: 'chat',
                  traceId: 'trace-conv-1',
                  attributes: {
                    'gen_ai.conversation.id': 'run-conv-1',
                    'gen_ai.request.model': 'anthropic.claude-sonnet-4',
                    'gen_ai.usage.input_tokens': 111,
                    'gen_ai.usage.output_tokens': 22,
                  },
                },
              },
            ],
          },
        }),
      });

      const result = await computeBatchMetrics(['run-conv-1'], defaultConfig);

      expect(result).toHaveLength(1);
      expect(result[0].runId).toBe('run-conv-1');
      expect(result[0].inputTokens).toBe(111);
      expect(result[0].status).toBe('success');
    });
  });

  // -------------------------------------------------------------------------
  // Strategy C (service.name + run window) — parity with /api/traces and the
  // trace judge. A report that carries NO correlation id (no runId /
  // sessionId / traceId — the shape a REST-connector agent produces when its
  // response echoes nothing agent-health recognizes) must still get metrics
  // from the spans its agent emitted in the run window.
  // -------------------------------------------------------------------------
  describe('Strategy C service-window hints (agents)', () => {
    const defaultConfig: OpenSearchConfig = {
      endpoint: 'http://localhost:9200',
      username: 'admin',
      password: 'admin',
      indexPattern: 'otel-v1-apm-span-*',
    };
    const emptyHits = () => ({ ok: true, json: () => Promise.resolve({ hits: { hits: [] } }) });
    const T0 = Date.parse('2026-03-01T10:00:00.000Z');
    const hint = { serviceName: 'example-agent', startedAt: T0, endedAt: T0 + 60_000 };

    it('computeMetrics ORs a service.name + startTime-window clause into the union (exact DSL, same as /api/traces)', async () => {
      mockFetch.mockResolvedValue(emptyHits());

      // A real run id + a traceId (so the key is NOT a surrogate) + one hint.
      await computeMetrics('run-1', defaultConfig, undefined, 'trace-1', [hint]);

      const should = JSON.parse(mockFetch.mock.calls[0][1].body).query.bool.must[0].bool.should;
      // 6 Strategy-B clauses + 1 Strategy-A traceId clause + exactly one Strategy-C clause.
      expect(should).toHaveLength(8);
      expect(should[7]).toEqual({
        bool: {
          must: [
            {
              bool: {
                should: [
                  { term: { serviceName: 'example-agent' } },
                  { term: { 'attributes.gen_ai.agent.name': 'example-agent' } },
                ],
                minimum_should_match: 1,
              },
            },
            {
              range: {
                startTime: {
                  gte: new Date(T0).toISOString(),
                  lte: new Date(T0 + 60_000).toISOString(),
                },
              },
            },
          ],
        },
      });
    });

    it('a hint carrying a sessionId becomes (session.id) OR (service window), unioned with A/B/D clauses', async () => {
      mockFetch.mockResolvedValue(emptyHits());

      await computeMetrics('run-1', defaultConfig, 'sess-report', 'trace-1', [{ ...hint, sessionId: 'sess-hint' }]);

      const should = JSON.parse(mockFetch.mock.calls[0][1].body).query.bool.must[0].bool.should;
      const text = JSON.stringify(should);
      // Strategy D from the report-level sessionId, Strategy A traceId, and the hint clause all present.
      expect(text).toContain('sess-report');
      expect(text).toContain('"traceId":["trace-1"]');
      const hintClause = should[should.length - 1];
      expect(hintClause.bool.minimum_should_match).toBe(1);
      expect(hintClause.bool.should).toEqual([
        { terms: { 'attributes.session.id': ['sess-hint'] } },
        { terms: { 'attributes.session.id.keyword': ['sess-hint'] } },
        { terms: { 'span.attributes.session@id': ['sess-hint'] } },
        expect.objectContaining({ bool: expect.objectContaining({ must: expect.any(Array) }) }),
      ]);
    });

    it('no hints => query shape unchanged (no serviceName / range clause)', async () => {
      mockFetch.mockResolvedValue(emptyHits());
      await computeMetrics('run-1', defaultConfig, undefined, undefined, []);
      const text = JSON.stringify(JSON.parse(mockFetch.mock.calls[0][1].body).query);
      expect(text).not.toContain('serviceName');
      expect(text).not.toContain('range');
    });

    it('the batch _source projection keeps the top-level serviceName (window attribution needs it; regression caught by the fake-OpenSearch integration test)', async () => {
      mockFetch.mockResolvedValue(emptyHits());
      await computeBatchMetrics(['k'], defaultConfig, undefined, undefined, { k: [hint] });
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body._source).toEqual(expect.arrayContaining(['serviceName', 'startTime', 'span.attributes.*', 'attributes']));
    });

    it('computeBatchMetrics attributes window-matched spans to the key whose hint they fall in (no ids on the spans at all)', async () => {
      const span = (serviceName: string, startIso: string, inTok: number) => ({
        _source: {
          name: 'chat',
          traceId: 'trace-' + Math.random().toString(36).slice(2, 8),
          serviceName,
          startTime: startIso,
          endTime: startIso,
          durationInNanos: 1_000_000,
          status: { code: 1 },
          attributes: { 'gen_ai.request.model': 'anthropic.claude-sonnet-4', 'gen_ai.usage.input_tokens': inTok, 'gen_ai.usage.output_tokens': 1 },
        },
      });
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          hits: {
            hits: [
              span('example-agent', '2026-03-01T10:00:10.000Z', 100), // inside report-a's window
              span('example-agent', '2026-03-01T10:00:20.000Z', 200), // inside report-a's window
              span('example-agent', '2026-03-01T10:05:10.000Z', 400), // inside report-b's window
              span('other-agent',   '2026-03-01T10:00:15.000Z', 999), // right time, wrong service -> unattributed
              span('example-agent', '2026-03-01T11:00:00.000Z', 999), // right service, outside every window -> unattributed
            ],
          },
        }),
      });
      const A = Date.parse('2026-03-01T10:00:00.000Z');
      const B = Date.parse('2026-03-01T10:05:00.000Z');

      const results = await computeBatchMetrics(
        ['report-a', 'report-b'],
        defaultConfig,
        undefined,
        undefined,
        {
          'report-a': [{ serviceName: 'example-agent', startedAt: A, endedAt: A + 60_000 }],
          'report-b': [{ serviceName: 'example-agent', startedAt: B, endedAt: B + 60_000 }],
        }
      );

      const byKey = new Map(results.map(r => [r.runId, r]));
      expect(byKey.get('report-a')).toEqual(expect.objectContaining({ inputTokens: 300, llmCalls: 2, status: 'success', hasSpans: true }));
      expect(byKey.get('report-b')).toEqual(expect.objectContaining({ inputTokens: 400, llmCalls: 1, status: 'success', hasSpans: true }));
      // The request carried one Strategy-C clause per key.
      const should = JSON.parse(mockFetch.mock.calls[0][1].body).query.bool.must[0].bool.should;
      expect(should.filter((c: any) => c.bool?.must?.[0]?.bool?.should?.[0]?.term?.serviceName === 'example-agent')).toHaveLength(2);
    });

    it('overlapping windows for the same service: each span is counted for exactly ONE key (nearest window midpoint)', async () => {
      const mk = (startIso: string, inTok: number) => ({
        _source: {
          name: 'chat', traceId: 't', serviceName: 'example-agent', startTime: startIso, endTime: startIso,
          durationInNanos: 1, status: { code: 1 },
          attributes: { 'gen_ai.request.model': 'anthropic.claude-sonnet-4', 'gen_ai.usage.input_tokens': inTok, 'gen_ai.usage.output_tokens': 0 },
        },
      });
      // Windows: a = [0, 100s] (mid 50s), b = [60s, 160s] (mid 110s). Overlap = [60s, 100s].
      const base = Date.parse('2026-03-01T10:00:00.000Z');
      const iso = (s: number) => new Date(base + s * 1000).toISOString();
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ hits: { hits: [mk(iso(30), 1), mk(iso(70), 10), mk(iso(95), 100), mk(iso(150), 1000)] } }),
      });

      const results = await computeBatchMetrics(['a', 'b'], defaultConfig, undefined, undefined, {
        a: [{ serviceName: 'example-agent', startedAt: base, endedAt: base + 100_000 }],
        b: [{ serviceName: 'example-agent', startedAt: base + 60_000, endedAt: base + 160_000 }],
      });

      const byKey = new Map(results.map(r => [r.runId, r]));
      // 30s -> a only; 70s -> overlap, |70-50|=20 < |70-110|=40 -> a; 95s -> overlap, |95-50|=45 > |95-110|=15 -> b; 150s -> b only.
      expect(byKey.get('a')!.inputTokens).toBe(11);
      expect(byKey.get('b')!.inputTokens).toBe(1100);
      expect(byKey.get('a')!.inputTokens + byKey.get('b')!.inputTokens).toBe(1111); // nothing double-counted
    });

    it('precise strategies win over the window: a span naming its run id is never re-attributed to an overlapping window', async () => {
      const base = Date.parse('2026-03-01T10:00:00.000Z');
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          hits: {
            hits: [{
              _source: {
                name: 'chat', traceId: 't', serviceName: 'example-agent',
                startTime: new Date(base + 10_000).toISOString(), durationInNanos: 1, status: { code: 1 },
                attributes: { 'agent_health.run.id': 'run-precise', 'gen_ai.request.model': 'm', 'gen_ai.usage.input_tokens': 5, 'gen_ai.usage.output_tokens': 0 },
              },
            }],
          },
        }),
      });

      const results = await computeBatchMetrics(['run-precise', 'report-windowed'], defaultConfig, undefined, undefined, {
        'report-windowed': [{ serviceName: 'example-agent', startedAt: base, endedAt: base + 60_000 }],
      });

      const byKey = new Map(results.map(r => [r.runId, r]));
      expect(byKey.get('run-precise')!.inputTokens).toBe(5);
      expect(byKey.get('report-windowed')!.hasSpans).toBe(false);
    });

    it('a window-only key is a SURROGATE (e.g. a report id): it is NOT sent as a Strategy-B run-id terms value, only its window clause is', async () => {
      mockFetch.mockResolvedValue(emptyHits());
      await computeBatchMetrics(['report-surrogate', 'run-real'], defaultConfig, undefined, undefined, {
        'report-surrogate': [hint],
      });
      const should = JSON.parse(mockFetch.mock.calls[0][1].body).query.bool.must[0].bool.should;
      const runIdTerms = should.filter((c: any) => c.terms?.['attributes.agent_health.run.id']);
      expect(runIdTerms).toHaveLength(1);
      expect(runIdTerms[0].terms['attributes.agent_health.run.id']).toEqual(['run-real']);
      expect(JSON.stringify(should)).not.toContain('report-surrogate');
      // ...and a span that happens to carry the surrogate string as its run id is NOT attributed to it.
    });

    it('a span carrying the surrogate key string as agent_health.run.id is not attributed to the surrogate (only the window can)', async () => {
      const base = Date.parse('2026-03-01T10:00:00.000Z');
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ hits: { hits: [{
          _source: { name: 'chat', traceId: 't', serviceName: 'other-service', startTime: new Date(base + 5000).toISOString(), durationInNanos: 1, status: { code: 1 },
            attributes: { 'agent_health.run.id': 'report-surrogate', 'gen_ai.request.model': 'm', 'gen_ai.usage.input_tokens': 9, 'gen_ai.usage.output_tokens': 0 } },
        }] } }),
      });
      const [m] = await computeBatchMetrics(['report-surrogate'], defaultConfig, undefined, undefined, {
        'report-surrogate': [{ serviceName: 'example-agent', startedAt: base, endedAt: base + 60_000 }],
      });
      expect(m.hasSpans).toBe(false);
    });

    it('computeMetrics (single) applies the same surrogate rule and stamps correlatedBy', async () => {
      mockFetch.mockResolvedValue(emptyHits());
      await computeMetrics('report-surrogate', defaultConfig, undefined, undefined, [hint]);
      const should = JSON.parse(mockFetch.mock.calls[0][1].body).query.bool.must[0].bool.should;
      expect(JSON.stringify(should)).not.toContain('report-surrogate');
      expect(should).toHaveLength(1); // the window clause only
    });

    it('stamps correlatedBy = ids / window / mixed per key', async () => {
      const base = Date.parse('2026-03-01T10:00:00.000Z');
      const mk = (attrs: Record<string, unknown>, offsetS: number, serviceName = 'example-agent') => ({
        _source: { name: 'chat', traceId: 't', serviceName, startTime: new Date(base + offsetS * 1000).toISOString(), durationInNanos: 1, status: { code: 1 },
          attributes: { 'gen_ai.request.model': 'm', 'gen_ai.usage.input_tokens': 1, 'gen_ai.usage.output_tokens': 0, ...attrs } },
      });
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ hits: { hits: [
          mk({ 'agent_health.run.id': 'run-ids' }, 5, 'svc-ids'),          // ids only
          mk({}, 5),                                                        // window only -> report-w
          mk({ 'agent_health.run.id': 'run-mixed' }, 100, 'svc-mixed'),     // ids
          mk({}, 105, 'svc-mixed'),                                         // + window for the same key -> mixed
        ] } }),
      });
      const results = await computeBatchMetrics(['run-ids', 'report-w', 'run-mixed'], defaultConfig, undefined, undefined, {
        'report-w': [{ serviceName: 'example-agent', startedAt: base, endedAt: base + 60_000 }],
        'run-mixed': [{ serviceName: 'svc-mixed', startedAt: base + 90_000, endedAt: base + 120_000, sessionId: 'sess-mixed' }],
      });
      const byKey = new Map(results.map(r => [r.runId, r]));
      expect(byKey.get('run-ids')!.correlatedBy).toBe('ids');
      expect(byKey.get('report-w')!.correlatedBy).toBe('window');
      expect(byKey.get('run-mixed')!.correlatedBy).toBe('mixed');
      expect(byKey.get('run-ids')!.partial).toBeUndefined();
    });

    it('flags every key in a chunk `partial` when the query hit its size cap (counts are a lower bound)', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ hits: { total: { value: 25_000 }, hits: [{
          _source: { name: 'chat', traceId: 't', attributes: { 'agent_health.run.id': 'run-1', 'gen_ai.request.model': 'm', 'gen_ai.usage.input_tokens': 1, 'gen_ai.usage.output_tokens': 0 } },
        }] } }),
      });
      const results = await computeBatchMetrics(['run-1', 'run-2'], defaultConfig);
      expect(results.every(r => r.partial === true)).toBe(true);
      // Single-run path: same flag at its own cap.
      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ hits: { total: { value: 600 }, hits: [] } }) });
      const single = await computeMetrics('run-1', defaultConfig);
      expect(single.partial).toBe(true);
    });

    it('a hint sessionId is registered as a Strategy-D correlator for its key (attribution by session.id beats the window)', async () => {
      const base = Date.parse('2026-03-01T10:00:00.000Z');
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          hits: {
            hits: [{
              _source: {
                name: 'chat', traceId: 't', serviceName: 'example-agent',
                // OUTSIDE the window, but carries the hint's session id.
                startTime: new Date(base + 600_000).toISOString(), durationInNanos: 1, status: { code: 1 },
                attributes: { 'session.id': 'sess-k', 'gen_ai.request.model': 'm', 'gen_ai.usage.input_tokens': 7, 'gen_ai.usage.output_tokens': 0 },
              },
            }],
          },
        }),
      });

      const results = await computeBatchMetrics(['k'], defaultConfig, undefined, undefined, {
        k: [{ serviceName: 'example-agent', startedAt: base, endedAt: base + 60_000, sessionId: 'sess-k' }],
      });

      expect(results[0].inputTokens).toBe(7);
      // And the query carried the session.id clauses for it.
      expect(JSON.stringify(JSON.parse(mockFetch.mock.calls[0][1].body).query)).toContain('sess-k');
    });
  });
});
