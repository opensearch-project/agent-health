/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for the lightweight `fetchSpansForRun` polling helper used by the
 * SDK runner to pre-load OTel spans into the `traces` fixture (issue #230).
 */
import {
  fetchSpansForRun,
  SDK_TRACE_POLL_CEILING,
} from '@/services/traces/fetchSpansForRun';

jest.mock('@/services/traces/index', () => ({
  fetchTracesByRunIds: jest.fn(),
}));

import { fetchTracesByRunIds } from '@/services/traces/index';

const mockFetch = fetchTracesByRunIds as jest.MockedFunction<typeof fetchTracesByRunIds>;

describe('fetchSpansForRun', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('returns spans on first attempt when data is available', async () => {
    const spans = [{ spanId: 's1', name: 'a' }] as any;
    mockFetch.mockResolvedValueOnce({ spans, total: 1 } as any);

    const result = await fetchSpansForRun('run-1', { maxAttempts: 5, intervalMs: 0 });

    expect(result.spans).toBe(spans);
    expect(result.lastError).toBeUndefined();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(['run-1']);
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
    // No errors thrown — backend simply had no data. lastError must be
    // undefined so the caller surfaces "no spans found", not "fetch failed".
    expect(result.lastError).toBeUndefined();
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('surfaces the last error message when every attempt throws (Copilot #234 review)', async () => {
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
    // The transient error was followed by a successful (but empty) fetch,
    // so we don't blame the long-recovered hiccup. Caller should surface
    // "no spans found" not "fetch failed".
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

  it('caps maxAttempts at SDK_TRACE_POLL_CEILING to prevent pathological waits (Copilot #234 review)', async () => {
    mockFetch.mockResolvedValue({ spans: [], total: 0 } as any);

    // Ask for 10_000 attempts — the helper must clamp to the ceiling.
    const result = await fetchSpansForRun('run-1', {
      maxAttempts: 10_000,
      intervalMs: 0,
    });

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
