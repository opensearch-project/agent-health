/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * useRunTelemetry — request planning + caching contract.
 *
 * The benchmark Runs tab polls every 2–5 s while a run is live and rebuilds
 * its `runs` array each tick. The hook must:
 *   - issue ONE batch request for a page of runs (keys deduped, chunked at
 *     TELEMETRY_BATCH_CHUNK, hints riding along),
 *   - NOT re-request when a poll tick yields the same terminal set,
 *   - re-request a run's keys once it flips running → terminal,
 *   - request keys for newly-appearing reports only,
 *   - degrade to `error` (cells "—") on a failed batch call without a retry
 *     storm, and recover on `refetch()`.
 */

import * as React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react';

jest.mock('@/lib/constants', () => ({
  DEFAULT_CONFIG: { agents: [{ key: 'demo', name: 'Demo', traceServiceName: 'demo-otel-service' }], models: {} },
}));

import { useRunTelemetry, TELEMETRY_BATCH_CHUNK, resolveAgentTraceServiceName } from '@/hooks/useRunTelemetry';
import type { TelemetryReport } from '@/lib/runTelemetry';

const report = (id: string, extra: Partial<TelemetryReport> = {}): TelemetryReport => ({
  id, timestamp: '2026-09-09T10:00:00.000Z', ...extra,
});
const run = (id: string, reportIds: string[], status = 'completed') => ({
  id, status, results: Object.fromEntries(reportIds.map((rid, i) => [`tc-${i}`, { reportId: rid }])),
});

const okMetrics = (keys: string[]) => ({
  metrics: keys.map(k => ({ runId: k, status: 'success' as const, hasSpans: true, totalTokens: 1000, costUsd: 0.5, llmCalls: 3, toolCalls: 1, inputTokens: 900, outputTokens: 100, durationMs: 0, toolsUsed: [], traceId: null as any })),
  aggregate: {} as any,
});

describe('useRunTelemetry', () => {
  beforeAll(() => { jest.spyOn(console, 'warn').mockImplementation(() => {}); jest.spyOn(console, 'error').mockImplementation(() => {}); });
  afterAll(() => { (console.warn as jest.Mock).mockRestore?.(); (console.error as jest.Mock).mockRestore?.(); });

  const reports = {
    r1: report('r1', { runId: 'k1', sessionId: 's1', traceId: 't1', connectorProtocol: 'claude-code', agentKey: 'demo', performanceMetrics: { durationMs: 44_000, agentDurationMs: 1 } }),
    r2: report('r2', { runId: 'k2', connectorProtocol: 'claude-code' }),
    r3: report('r3'),  // no runId → keyed by report id
  };

  it('issues ONE batch call for the page with deduped keys and A/C/D hints, then aggregates per run', async () => {
    const fetchBatch = jest.fn(async (keys: string[]) => okMetrics(keys));
    const runs = [run('run-a', ['r1', 'r2']), run('run-b', ['r3'])];
    const { result } = renderHook(() => useRunTelemetry(runs, reports, { fetchBatch }));

    expect(result.current.loadingRunIds).toEqual(new Set(['run-a', 'run-b']));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(fetchBatch).toHaveBeenCalledTimes(1);
    const [keys, sessionIds, traceIds, agents] = fetchBatch.mock.calls[0];
    expect(keys).toEqual(['k1', 'k2', 'r3']);
    expect(sessionIds).toEqual({ k1: 's1' });
    expect(traceIds).toEqual({ k1: 't1' });
    expect(agents.k1[0]).toMatchObject({ serviceName: 'demo-otel-service', sessionId: 's1' });  // per-agent override wins
    expect(agents.k2[0].serviceName).toBe('claude-code-agent');                                   // protocol default
    expect(agents.r3).toBeUndefined();                                                            // nothing derivable

    expect(result.current.byRunId['run-a']).toMatchObject({ totalTokens: 2000, llmCalls: 6, spansCases: 2, totalCases: 2, hasSpans: true, medianDurationMs: 44_000 });
    expect(result.current.byRunId['run-b']).toMatchObject({ totalTokens: 1000, spansCases: 1 });
    expect(result.current.loadingRunIds.size).toBe(0);
    expect(result.current.error).toBeNull();
  });

  it('does NOT refetch when a poll tick re-creates the runs array with the same terminal set', async () => {
    const fetchBatch = jest.fn(async (keys: string[]) => okMetrics(keys));
    const { result, rerender } = renderHook(
      ({ runs }: { runs: ReturnType<typeof run>[] }) => useRunTelemetry(runs, reports, { fetchBatch }),
      { initialProps: { runs: [run('run-a', ['r1', 'r2'])] } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchBatch).toHaveBeenCalledTimes(1);

    // Three "poll ticks": fresh array identity, identical content.
    for (let i = 0; i < 3; i++) rerender({ runs: [run('run-a', ['r1', 'r2'])] });
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });
    expect(fetchBatch).toHaveBeenCalledTimes(1);
  });

  it('refetches a run\'s keys when it flips running → completed (provisional value replaced), but not on a running tick', async () => {
    const fetchBatch = jest.fn(async (keys: string[]) => okMetrics(keys));
    const { result, rerender } = renderHook(
      ({ runs }: { runs: ReturnType<typeof run>[] }) => useRunTelemetry(runs, reports, { fetchBatch }),
      { initialProps: { runs: [run('run-a', ['r1'], 'running')] } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchBatch).toHaveBeenCalledTimes(1);       // provisional fetch while running (shows live numbers)

    rerender({ runs: [run('run-a', ['r1'], 'running')] });
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });
    expect(fetchBatch).toHaveBeenCalledTimes(1);       // same running set → no refetch

    rerender({ runs: [run('run-a', ['r1'], 'completed')] });
    await waitFor(() => expect(fetchBatch).toHaveBeenCalledTimes(2));   // terminal → final fetch
    expect(fetchBatch.mock.calls[1][0]).toEqual(['k1']);
    await waitFor(() => expect(result.current.loading).toBe(false));

    rerender({ runs: [run('run-a', ['r1'], 'completed')] });
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });
    expect(fetchBatch).toHaveBeenCalledTimes(2);       // final value cached for good
  });

  it('requests only the NEW keys when a report appears (a new run landing on the page)', async () => {
    const fetchBatch = jest.fn(async (keys: string[]) => okMetrics(keys));
    const { result, rerender } = renderHook(
      ({ runs }: { runs: ReturnType<typeof run>[] }) => useRunTelemetry(runs, reports, { fetchBatch }),
      { initialProps: { runs: [run('run-a', ['r1'])] } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    rerender({ runs: [run('run-a', ['r1']), run('run-b', ['r3'])] });
    await waitFor(() => expect(fetchBatch).toHaveBeenCalledTimes(2));
    expect(fetchBatch.mock.calls[1][0]).toEqual(['r3']);
    await waitFor(() => expect(result.current.byRunId['run-b']?.hasSpans).toBe(true));
    expect(result.current.byRunId['run-a']?.hasSpans).toBe(true);   // untouched
  });

  it('chunks a large key set at TELEMETRY_BATCH_CHUNK per request', async () => {
    const fetchBatch = jest.fn(async (keys: string[]) => okMetrics(keys));
    const many: Record<string, TelemetryReport> = {};
    const ids: string[] = [];
    for (let i = 0; i < TELEMETRY_BATCH_CHUNK + 5; i++) { const id = `rep-${i}`; ids.push(id); many[id] = report(id); }
    const { result } = renderHook(() => useRunTelemetry([run('big', ids)], many, { fetchBatch }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchBatch).toHaveBeenCalledTimes(2);
    expect(fetchBatch.mock.calls[0][0]).toHaveLength(TELEMETRY_BATCH_CHUNK);
    expect(fetchBatch.mock.calls[1][0]).toHaveLength(5);
    expect(result.current.byRunId.big?.totalCases).toBe(TELEMETRY_BATCH_CHUNK + 5);
  });

  it('a failed batch call → error set, cells resolve to "no spans" (no skeleton), no retry storm; refetch() recovers', async () => {
    let fail = true;
    const fetchBatch = jest.fn(async (keys: string[]) => { if (fail) throw new Error('500'); return okMetrics(keys); });
    const { result, rerender } = renderHook(
      ({ runs }: { runs: ReturnType<typeof run>[] }) => useRunTelemetry(runs, reports, { fetchBatch }),
      { initialProps: { runs: [run('run-a', ['r1'])] } },
    );
    await waitFor(() => expect(result.current.error).toBe('metrics unavailable'));
    expect(result.current.loading).toBe(false);
    expect(result.current.loadingRunIds.size).toBe(0);
    expect(result.current.byRunId['run-a']).toMatchObject({ hasSpans: false, totalCases: 1, medianDurationMs: 44_000 });

    rerender({ runs: [run('run-a', ['r1'])] });
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });
    expect(fetchBatch).toHaveBeenCalledTimes(1);   // error is cached; no retry on every tick

    fail = false;
    act(() => result.current.refetch());
    await waitFor(() => expect(result.current.byRunId['run-a']?.hasSpans).toBe(true));
    expect(result.current.error).toBeNull();
    expect(fetchBatch).toHaveBeenCalledTimes(2);
  });

  it('a key the server does not echo back settles as "no spans" rather than a permanent skeleton', async () => {
    const fetchBatch = jest.fn(async () => ({ metrics: [], aggregate: {} as any }));
    const { result } = renderHook(() => useRunTelemetry([run('run-a', ['r1'])], reports, { fetchBatch }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.loadingRunIds.size).toBe(0);
    expect(result.current.byRunId['run-a']?.hasSpans).toBe(false);
  });

  it('enabled:false fetches nothing and reports nothing loading', async () => {
    const fetchBatch = jest.fn(async (keys: string[]) => okMetrics(keys));
    const { result } = renderHook(() => useRunTelemetry([run('run-a', ['r1'])], reports, { fetchBatch, enabled: false }));
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });
    expect(fetchBatch).not.toHaveBeenCalled();
    expect(result.current.loadingRunIds.size).toBe(0);
    expect(result.current.loading).toBe(false);
  });

  it('resolveAgentTraceServiceName reads AgentConfig.traceServiceName from DEFAULT_CONFIG', () => {
    expect(resolveAgentTraceServiceName('demo')).toBe('demo-otel-service');
    expect(resolveAgentTraceServiceName('unknown')).toBeUndefined();
    expect(resolveAgentTraceServiceName(undefined)).toBeUndefined();
  });
});
