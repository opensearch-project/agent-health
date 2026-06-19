/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { OpenSearchObservabilityModule } from '@/server/adapters/observability/OpenSearchObservabilityModule';
import { fetchTraces, checkTracesHealth } from '@/server/services/tracesService';
import { fetchLogs } from '@/server/services/logsService';

jest.mock('@/server/services/tracesService', () => ({
  fetchTraces: jest.fn(),
  checkTracesHealth: jest.fn(),
}));
jest.mock('@/server/services/logsService', () => ({
  fetchLogs: jest.fn(),
}));

const mockFetchTraces = fetchTraces as jest.MockedFunction<typeof fetchTraces>;
const mockCheckTracesHealth = checkTracesHealth as jest.MockedFunction<typeof checkTracesHealth>;
const mockFetchLogs = fetchLogs as jest.MockedFunction<typeof fetchLogs>;

describe('OpenSearchObservabilityModule', () => {
  const client = { search: jest.fn() } as any;
  const indexes = { traces: 'otel-traces-*', logs: 'ml-logs-*', metrics: 'otel-metrics-*' };
  let mod: OpenSearchObservabilityModule;

  beforeEach(() => {
    jest.clearAllMocks();
    mod = new OpenSearchObservabilityModule(client, indexes);
  });

  it('is always configured', () => {
    expect(mod.isConfigured()).toBe(true);
  });

  describe('traces.query', () => {
    it('delegates to fetchTraces with the bound client + traces index and maps pagination', async () => {
      mockFetchTraces.mockResolvedValue({
        spans: [{ traceId: 't1', spanId: 's1' } as any],
        total: 1,
        nextCursor: 'cur',
        hasMore: true,
      });

      const result = await mod.traces.query({ traceId: 't1', size: 50 });

      expect(mockFetchTraces).toHaveBeenCalledWith(
        { traceId: 't1', size: 50 },
        client,
        'otel-traces-*'
      );
      expect(result).toEqual({
        spans: [{ traceId: 't1', spanId: 's1' }],
        total: 1,
        nextCursor: 'cur',
        hasMore: true,
      });
    });

    it('defaults nextCursor=null / hasMore=false when the service omits them', async () => {
      mockFetchTraces.mockResolvedValue({ spans: [], total: 0 } as any);

      const result = await mod.traces.query({ runIds: ['r1'] });

      expect(result.nextCursor).toBeNull();
      expect(result.hasMore).toBe(false);
    });
  });

  describe('traces.getByTraceId / getByRunIds', () => {
    it('getByTraceId queries by the single trace id', async () => {
      mockFetchTraces.mockResolvedValue({ spans: [{ traceId: 'tx' } as any], total: 1 } as any);

      const spans = await mod.traces.getByTraceId('tx');

      expect(mockFetchTraces).toHaveBeenCalledWith(
        expect.objectContaining({ traceId: 'tx' }),
        client,
        'otel-traces-*'
      );
      expect(spans).toEqual([{ traceId: 'tx' }]);
    });

    it('getByRunIds short-circuits to [] for an empty list (no query)', async () => {
      const spans = await mod.traces.getByRunIds([]);
      expect(spans).toEqual([]);
      expect(mockFetchTraces).not.toHaveBeenCalled();
    });

    it('getByRunIds queries by the run ids', async () => {
      mockFetchTraces.mockResolvedValue({ spans: [], total: 0 } as any);
      await mod.traces.getByRunIds(['r1', 'r2']);
      expect(mockFetchTraces).toHaveBeenCalledWith(
        expect.objectContaining({ runIds: ['r1', 'r2'] }),
        client,
        'otel-traces-*'
      );
    });
  });

  describe('logs.query', () => {
    it('delegates to fetchLogs with the bound client + logs index', async () => {
      mockFetchLogs.mockResolvedValue({ logs: [{ id: 'l1' } as any], total: 1 } as any);

      const result = await mod.logs.query({ runId: 'run-1' });

      expect(mockFetchLogs).toHaveBeenCalledWith({ runId: 'run-1' }, client, 'ml-logs-*');
      expect(result).toEqual({ logs: [{ id: 'l1' }], total: 1 });
    });
  });

  describe('health', () => {
    it('delegates to checkTracesHealth on the traces index', async () => {
      mockCheckTracesHealth.mockResolvedValue({ status: 'ok', index: 'otel-traces-*' });
      const health = await mod.health();
      expect(mockCheckTracesHealth).toHaveBeenCalledWith(client, 'otel-traces-*');
      expect(health).toEqual({ status: 'ok', index: 'otel-traces-*' });
    });

    it('surfaces an error health result (no fallback)', async () => {
      mockCheckTracesHealth.mockResolvedValue({
        status: 'error',
        error: 'boom',
        errorCategory: 'connection',
        suggestion: 'check cluster',
      });
      const health = await mod.health();
      expect(health.status).toBe('error');
      expect(health.errorCategory).toBe('connection');
    });
  });
});
