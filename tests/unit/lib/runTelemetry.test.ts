/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for lib/runTelemetry.ts — the pure per-run telemetry roll-up
 * behind the benchmark Runs table's Tokens · Cost · LLM calls · Time/case
 * columns and the run inspector's telemetry strip.
 */

import {
  aggregateRunTelemetry,
  aggregateAllRunTelemetry,
  buildRunTelemetryCorrelation,
  collectReportIds,
  metricsKeyForReport,
  median,
  formatTokensCompact,
  formatCostUsd,
  formatDurationCompact,
  type TelemetryReport,
  type TelemetryMetricsResult,
} from '@/lib/runTelemetry';

// resolveAgentServiceName warns (by design) for generic transports with no
// traceServiceName; keep the test output readable.
beforeAll(() => { jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterAll(() => { (console.warn as jest.Mock).mockRestore?.(); });

const report = (id: string, extra: Partial<TelemetryReport> = {}): TelemetryReport => ({
  id,
  timestamp: '2026-09-09T10:00:00.000Z',
  ...extra,
});

const run = (id: string, reportIds: Array<string | undefined>, status?: string) => ({
  id,
  status,
  results: Object.fromEntries(reportIds.map((rid, i) => [`tc-${i}`, rid ? { reportId: rid } : {}])),
});

const ok = (runId: string, over: Partial<TelemetryMetricsResult> = {}): TelemetryMetricsResult => ({
  runId, status: 'success', hasSpans: true, totalTokens: 1000, costUsd: 0.5, llmCalls: 3, toolCalls: 2, ...over,
});

describe('metricsKeyForReport', () => {
  it('prefers the connector runId, falls back to the report id', () => {
    expect(metricsKeyForReport({ id: 'rep-1', runId: 'agent-run-1' })).toBe('agent-run-1');
    expect(metricsKeyForReport({ id: 'rep-1' })).toBe('rep-1');
    expect(metricsKeyForReport({ id: '', runId: undefined } as any)).toBeUndefined();
  });
});

describe('collectReportIds', () => {
  it('dedupes and skips empty reportIds', () => {
    expect(collectReportIds([run('a', ['r1', 'r2', undefined]), run('b', ['r2', 'r3'])])).toEqual(['r1', 'r2', 'r3']);
  });
});

describe('buildRunTelemetryCorrelation', () => {
  it('keys every report once and carries A (traceId) / D (sessionId) / C (service hints)', () => {
    const reports = {
      r1: report('r1', { runId: 'k1', traceId: 't1', sessionId: 's1', connectorProtocol: 'claude-code', performanceMetrics: { durationMs: 40_000, agentDurationMs: 38_000 } }),
      r2: report('r2', { connectorProtocol: 'rest', agentKey: 'demo-rest' }),        // no runId → keyed by report id, no default service name
      r3: report('r3', { runId: 'k1' }),                                               // duplicate key (same agent run) — counted per run, requested once
    };
    const c = buildRunTelemetryCorrelation([run('run-a', ['r1', 'r2']), run('run-b', ['r3'])], reports);
    expect(c.keys).toEqual(['k1', 'r2']);
    expect(c.sessionIdByKey).toEqual({ k1: 's1' });
    expect(c.traceIdByKey).toEqual({ k1: 't1' });
    expect(c.agentsByKey.k1).toHaveLength(1);
    expect(c.agentsByKey.k1[0]).toMatchObject({ serviceName: 'claude-code-agent', sessionId: 's1' });
    expect(c.agentsByKey.k1[0].endedAt - c.agentsByKey.k1[0].startedAt).toBe(2 * (40_000 + 60_000));
    expect(c.agentsByKey.r2).toBeUndefined();  // generic transport, no override → no Strategy-C guess
    expect(c.keysByRun).toEqual({ 'run-a': ['k1', 'r2'], 'run-b': ['k1'] });
  });

  it('uses the per-agent traceServiceName override when provided', () => {
    const reports = { r1: report('r1', { connectorProtocol: 'rest', agentKey: 'my-rest' }) };
    const c = buildRunTelemetryCorrelation([run('run-a', ['r1'])], reports, key => (key === 'my-rest' ? 'my-otel-service' : undefined));
    expect(c.agentsByKey.r1[0].serviceName).toBe('my-otel-service');
  });

  it('skips results whose report has not loaded', () => {
    const c = buildRunTelemetryCorrelation([run('run-a', ['missing', 'r1'])], { r1: report('r1') });
    expect(c.keys).toEqual(['r1']);
    expect(c.keysByRun['run-a']).toEqual(['r1']);
  });
});

describe('median', () => {
  it('handles odd, even, empty and non-finite input', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
    expect(median([NaN, 5, Infinity])).toBe(5);
  });
});

describe('aggregateRunTelemetry', () => {
  const reports = {
    r1: report('r1', { runId: 'k1', performanceMetrics: { durationMs: 44_000, agentDurationMs: 1 } }),
    r2: report('r2', { runId: 'k2', performanceMetrics: { durationMs: 38_000, agentDurationMs: 1 } }),
    r3: report('r3', { runId: 'k3', performanceMetrics: { durationMs: 61_000, agentDurationMs: 1 } }),
    r4: report('r4', { runId: 'k4' }),  // no duration recorded
  };

  it('sums tokens/cost/llm/tool calls over span-bearing reports, medians the durations, counts spans/total', () => {
    const t = aggregateRunTelemetry(run('run-a', ['r1', 'r2', 'r3', 'r4']), reports, {
      k1: ok('k1', { totalTokens: 2_000_000, costUsd: 8.1, llmCalls: 100, toolCalls: 40 }),
      k2: ok('k2', { totalTokens: 3_900_000, costUsd: 12.09, llmCalls: 212, toolCalls: 60 }),
      k3: ok('k3', { hasSpans: false, totalTokens: 0, costUsd: 0, llmCalls: 0, toolCalls: 0 }),
      k4: { runId: 'k4', error: 'boom', status: 'error' },
    })!;
    expect(t.totalTokens).toBe(5_900_000);
    expect(t.costUsd).toBeCloseTo(20.19, 6);
    expect(t.llmCalls).toBe(312);
    expect(t.toolCalls).toBe(100);
    expect(t.medianDurationMs).toBe(44_000);   // median of 44k, 38k, 61k
    expect(t.spansCases).toBe(2);
    expect(t.totalCases).toBe(4);
    expect(t.errorCases).toBe(1);        // k4 errored → counted, but a partial failure is NOT "unavailable"
    expect(t.unavailable).toBe(false);
    expect(t.hasSpans).toBe(true);
    expect(t.partial).toBe(false);
  });

  it('unavailable only when EVERY report\'s metrics request failed; wall-clock median survives', () => {
    const t = aggregateRunTelemetry(run('run-a', ['r1', 'r2']), reports, {
      k1: { runId: 'k1', error: '500', status: 'error' },
      k2: { runId: 'k2', error: '500', status: 'error' },
    })!;
    expect(t.unavailable).toBe(true);
    expect(t.errorCases).toBe(2);
    expect(t.hasSpans).toBe(false);
    expect(t.medianDurationMs).toBe(41_000);
    // one key not fetched yet + one errored → not (yet) unavailable
    expect(aggregateRunTelemetry(run('run-a', ['r1', 'r2']), reports, { k1: { runId: 'k1', error: '500', status: 'error' } })!.unavailable).toBe(false);
  });

  it('hasSpans:false for every report → zero sums, hasSpans false, duration still populated', () => {
    const t = aggregateRunTelemetry(run('run-a', ['r1', 'r2']), reports, {
      k1: ok('k1', { hasSpans: false, totalTokens: 0, costUsd: 0, llmCalls: 0 }),
      k2: ok('k2', { hasSpans: false, totalTokens: 0, costUsd: 0, llmCalls: 0 }),
    })!;
    expect(t.hasSpans).toBe(false);
    expect(t.spansCases).toBe(0);
    expect(t.totalTokens).toBe(0);
    expect(t.medianDurationMs).toBe(41_000);
  });

  it('treats a missing hasSpans flag (older servers) as real data and pending results as no data', () => {
    const t = aggregateRunTelemetry(run('run-a', ['r1', 'r2']), reports, {
      k1: { runId: 'k1', status: 'success', totalTokens: 10, costUsd: 0, llmCalls: 1, toolCalls: 0 },
      k2: { runId: 'k2', status: 'pending', totalTokens: 999, costUsd: 9, llmCalls: 9, toolCalls: 9 },
    })!;
    expect(t.totalTokens).toBe(10);
    expect(t.spansCases).toBe(1);
  });

  it('cost 0 with spans present stays 0 (renderer decides to show "—")', () => {
    const t = aggregateRunTelemetry(run('run-a', ['r1']), reports, { k1: ok('k1', { costUsd: 0, totalTokens: 500 }) })!;
    expect(t.hasSpans).toBe(true);
    expect(t.costUsd).toBe(0);
    expect(formatCostUsd(t.costUsd)).toBeNull();
  });

  it('propagates the partial flag when any contributing result hit the size cap', () => {
    const t = aggregateRunTelemetry(run('run-a', ['r1', 'r2']), reports, { k1: ok('k1'), k2: ok('k2', { partial: true }) })!;
    expect(t.partial).toBe(true);
  });

  it('returns undefined when no report of the run has loaded / has a key; metrics missing → hasSpans false', () => {
    expect(aggregateRunTelemetry(run('run-a', ['nope']), reports, {})).toBeUndefined();
    expect(aggregateRunTelemetry(run('run-a', []), reports, {})).toBeUndefined();
    const t = aggregateRunTelemetry(run('run-a', ['r1']), reports, {})!;
    expect(t.hasSpans).toBe(false);
    expect(t.totalCases).toBe(1);
    expect(t.medianDurationMs).toBe(44_000);
  });

  it('aggregateAllRunTelemetry keys by run id', () => {
    const all = aggregateAllRunTelemetry([run('run-a', ['r1']), run('run-b', ['nope'])], reports, { k1: ok('k1') });
    expect(all['run-a']?.totalTokens).toBe(1000);
    expect(all['run-b']).toBeUndefined();
  });
});

describe('formatters', () => {
  it('formatTokensCompact', () => {
    expect(formatTokensCompact(5_900_000)).toBe('5.9M');
    expect(formatTokensCompact(12_345)).toBe('12.3K');
    expect(formatTokensCompact(312)).toBe('312');
    expect(formatTokensCompact(NaN)).toBe('—');
  });
  it('formatCostUsd', () => {
    expect(formatCostUsd(20.19)).toBe('$20.19');
    expect(formatCostUsd(0.0042)).toBe('$0.0042');
    expect(formatCostUsd(0)).toBeNull();
    expect(formatCostUsd(-1)).toBeNull();
  });
  it('formatDurationCompact', () => {
    expect(formatDurationCompact(44_000)).toBe('44 s');
    expect(formatDurationCompact(800)).toBe('0.8 s');
    expect(formatDurationCompact(125_000)).toBe('2m 05s');
    expect(formatDurationCompact(3_725_000)).toBe('1h 02m');
    expect(formatDurationCompact(null)).toBe('—');
    expect(formatDurationCompact(-5)).toBe('—');
  });
});
