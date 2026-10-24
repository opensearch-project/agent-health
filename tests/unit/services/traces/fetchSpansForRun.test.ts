/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for the lightweight `fetchSpansForRun` polling helper used by the
 * SDK runner to pre-load OTel spans into the `traces` fixture (issue #230).
 *
 * Correlation now unions Strategy B (runId) with Strategy C (service-name +
 * time window) via `fetchTracesForRun`, so agents whose OTel spans are NOT
 * tagged with our connector runId (Claude Code, any subprocess agent) still
 * populate the fixture. Previously this helper queried runId only and returned
 * 0 spans for those agents.
 */
import {
  fetchSpansForRun,
  SDK_TRACE_POLL_CEILING,
} from '@/services/traces/fetchSpansForRun';

jest.mock('@/services/traces/index', () => ({
  fetchTracesForRun: jest.fn(),
}));

import { fetchTracesForRun } from '@/services/traces/index';

const mockFetch = fetchTracesForRun as jest.MockedFunction<typeof fetchTracesForRun>;

describe('fetchSpansForRun', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('returns spans on first attempt when data is available (runId path)', async () => {
    const spans = [{ spanId: 's1', name: 'a' }] as any;
    mockFetch.mockResolvedValueOnce({ spans, total: 1 } as any);

    const result = await fetchSpansForRun('run-1', { maxAttempts: 5, intervalMs: 0 });

    expect(result.spans).toBe(spans);
    expect(result.lastError).toBeUndefined();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    // runId-only: no window fallback requested.
    expect(mockFetch).toHaveBeenCalledWith({
      runId: 'run-1',
      includeWindowFallback: false,
      windowAgents: undefined,
    });
  });

  it('forwards the exact correlators (traceId / sessionId) so the server can match before the window', async () => {
    mockFetch.mockResolvedValueOnce({ spans: [{ spanId: 's1' }], total: 1 } as any);
    const windowAgents = [{ serviceName: 'retrieval-agent', startedAt: 1, endedAt: 2 }];

    await fetchSpansForRun('run-1', {
      maxAttempts: 1, intervalMs: 0, windowAgents,
      traceId: 'aaaa0000aaaa0000aaaa0000aaaa0000', sessionId: 'sess-1',
    });

    expect(mockFetch).toHaveBeenCalledWith({
      runId: 'run-1',
      traceId: 'aaaa0000aaaa0000aaaa0000aaaa0000',
      sessionId: 'sess-1',
      includeWindowFallback: true,
      windowAgents,
    });
  });

  // ── The fix: Strategy-C correlation ──────────────────────────────────────
  it('correlates by service-name + time window when runId tags nothing (Claude Code / subprocess agents)', async () => {
    const spans = [
      { spanId: 's1', name: 'claude_code.interaction', traceId: 't-abc' },
    ] as any;
    // Simulate the real failure mode: the agent emitted spans under its own
    // traceId + service.name, never tagged with our runId. The union query
    // resolves them via the windowAgents (Strategy C) clause.
    mockFetch.mockResolvedValueOnce({ spans, total: 1 } as any);

    const windowAgents = [
      { serviceName: 'claude-code-agent', startedAt: 1000, endedAt: 2000 },
    ];
    const result = await fetchSpansForRun('subprocess-xyz', {
      maxAttempts: 3,
      intervalMs: 0,
      windowAgents,
    });

    expect(result.spans).toBe(spans);
    expect(mockFetch).toHaveBeenCalledWith({
      runId: 'subprocess-xyz',
      includeWindowFallback: true,
      windowAgents,
    });
  });

  it('works with windowAgents and no runId (deferred trace-mode runs)', async () => {
    const spans = [{ spanId: 's1', name: 'a', traceId: 't-1' }] as any;
    mockFetch.mockResolvedValueOnce({ spans, total: 1 } as any);

    const windowAgents = [{ serviceName: 'pi-agent', startedAt: 1, endedAt: 2 }];
    const result = await fetchSpansForRun(undefined, { maxAttempts: 2, intervalMs: 0, windowAgents });

    expect(result.spans).toBe(spans);
    expect(mockFetch).toHaveBeenCalledWith({
      runId: undefined,
      includeWindowFallback: true,
      windowAgents,
    });
  });

  it('polls until spans appear', async () => {
    const spans = [{ spanId: 's1', name: 'a' }] as any;
    mockFetch
      .mockResolvedValueOnce({ spans: [], total: 0 } as any)
      .mockResolvedValueOnce({ spans: [], total: 0 } as any)
      .mockResolvedValueOnce({ spans, total: 1 } as any);

    const result = await fetchSpansForRun('run-1', { maxAttempts: 5, intervalMs: 0 });

    expect(result.spans).toBe(spans);
    expect(result.lastError).toBeUndefined();
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('returns spans:[] with no lastError after maxAttempts of empty (clean) responses', async () => {
    mockFetch.mockResolvedValue({ spans: [], total: 0 } as any);

    const result = await fetchSpansForRun('run-1', { maxAttempts: 3, intervalMs: 0 });

    expect(result.spans).toEqual([]);
    expect(result.lastError).toBeUndefined();
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('surfaces the last error message when every attempt throws', async () => {
    mockFetch.mockRejectedValue(new Error('network down'));

    const result = await fetchSpansForRun('run-1', { maxAttempts: 2, intervalMs: 0 });

    expect(result.spans).toEqual([]);
    expect(result.lastError).toBe('network down');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('clears lastError when a transient error is followed by a clean (but empty) response', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce({ spans: [], total: 0 } as any);

    const result = await fetchSpansForRun('run-1', { maxAttempts: 2, intervalMs: 0 });

    expect(result.spans).toEqual([]);
    expect(result.lastError).toBeUndefined();
  });

  it('coerces non-Error throws to a string in lastError', async () => {
    mockFetch.mockRejectedValue('plain string failure');

    const result = await fetchSpansForRun('run-1', { maxAttempts: 1, intervalMs: 0 });

    expect(result.spans).toEqual([]);
    expect(result.lastError).toBe('plain string failure');
  });

  it('recovers after a transient error if a later attempt succeeds', async () => {
    const spans = [{ spanId: 's', name: 'a' }] as any;
    mockFetch
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce({ spans, total: 1 } as any);

    const result = await fetchSpansForRun('run-1', { maxAttempts: 3, intervalMs: 0 });

    expect(result.spans).toBe(spans);
    expect(result.lastError).toBeUndefined();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('uses the configured interval between attempts', async () => {
    mockFetch
      .mockResolvedValueOnce({ spans: [], total: 0 } as any)
      .mockResolvedValueOnce({ spans: [{ spanId: 's', name: 'a' }] as any, total: 1 } as any);

    const before = Date.now();
    const result = await fetchSpansForRun('run-1', { maxAttempts: 3, intervalMs: 25 });
    const elapsed = Date.now() - before;

    expect(result.spans).toHaveLength(1);
    expect(elapsed).toBeGreaterThanOrEqual(20);
  });

  it('honours maxAttempts=1 (no retries, no inter-attempt sleep)', async () => {
    mockFetch.mockResolvedValueOnce({ spans: [], total: 0 } as any);

    const result = await fetchSpansForRun('run-1', { maxAttempts: 1, intervalMs: 9999 });

    expect(result.spans).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('caps maxAttempts at SDK_TRACE_POLL_CEILING to prevent pathological waits', async () => {
    mockFetch.mockResolvedValue({ spans: [], total: 0 } as any);

    const result = await fetchSpansForRun('run-1', { maxAttempts: 10_000, intervalMs: 0 });

    expect(result.spans).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(SDK_TRACE_POLL_CEILING);
  });

  it('treats invalid maxAttempts (0, negative) as at-least-1', async () => {
    mockFetch.mockResolvedValueOnce({ spans: [], total: 0 } as any);

    const result = await fetchSpansForRun('run-1', { maxAttempts: 0, intervalMs: 0 });

    expect(result.spans).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
