/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for lib/benchmarkRunsTable — the pure filter / sort / chart-series
 * logic behind the benchmark Runs tab (table + pass-rate-over-time chart).
 */

import type { BenchmarkRun } from '@/types';
import {
  buildRunTableRow, computePassRate, applyRunFilters, toggleRunFilter, removeRunFilter,
  sortRunRows, toggleRunSort, buildPassRateSeries, rowFieldValue, rowFieldLabel,
  seriesColor, SERIES_COLORS, DEFAULT_RUN_SORT, latestRunId, RunTableRow, RunFilter,
} from '@/lib/benchmarkRunsTable';

const resolvers = {
  agentName: (k: string) => ({ 'agent-cc': 'Agent A', 'agent-ais': 'Agent B' } as Record<string, string>)[k] || k || 'Unknown',
  modelName: (id: string) => ({ 'm-sonnet': 'Sonnet 4.6' } as Record<string, string>)[id] || id,
  judgeLabel: (id?: string | null) => (id ? `J:${id}` : '—'),
  evaluatorLabel: (id?: string | null) => (id ? `E:${id}` : '—'),
};

function run(overrides: Partial<BenchmarkRun> & { id: string }): BenchmarkRun {
  return {
    name: overrides.id,
    createdAt: '2026-09-01T00:00:00.000Z',
    agentKey: 'agent-cc',
    modelId: 'm-sonnet',
    status: 'completed',
    results: {},
    ...overrides,
  } as BenchmarkRun;
}

const res = (status: string, passFailStatus?: string) => ({ reportId: 'r', status, passFailStatus }) as any;

describe('computePassRate', () => {
  it('returns null when nothing is evaluable', () => {
    expect(computePassRate(0, 0)).toBeNull();
  });
  it('rounds to one decimal over passed+failed only', () => {
    expect(computePassRate(1, 2)).toBe(33.3);
    expect(computePassRate(2, 0)).toBe(100);
  });
});

describe('buildRunTableRow', () => {
  it('recomputes pass/fail/errored from results and excludes errored from the pass rate', () => {
    const row = buildRunTableRow(run({
      id: 'a',
      results: {
        t1: res('completed', 'passed'),
        t2: res('completed', 'failed'),
        t3: res('completed'), // errored (#242)
        t4: res('running'),
      },
      testCaseSnapshots: [{}, {}, {}, {}, {}, {}] as any,
    }), resolvers);
    expect(row.passed).toBe(1);
    expect(row.failed).toBe(1);
    expect(row.errored).toBe(1);
    expect(row.running).toBe(1);
    expect(row.total).toBe(6);       // planned total from snapshots
    expect(row.pending).toBe(2);     // 6 - 1 - 1 - 1 - 1(running)
    expect(row.size).toBe(6);
    expect(row.passRate).toBe(50);   // 1 / (1+1), NOT 1/6
  });

  it('resolves display labels and keeps raw ids for filtering', () => {
    const row = buildRunTableRow(run({ id: 'a', judgeModelId: 'jm', evaluatorId: 'ev' }), resolvers);
    expect(row.agentName).toBe('Agent A');
    expect(row.modelName).toBe('Sonnet 4.6');
    expect(row.judgeLabel).toBe('J:jm');
    expect(row.evaluatorLabel).toBe('E:ev');
    expect(rowFieldValue(row, 'agent')).toBe('agent-cc');
    expect(rowFieldLabel(row, 'agent')).toBe('Agent A');
    expect(rowFieldValue(row, 'judge')).toBe('jm');
    expect(rowFieldValue(row, 'evaluator')).toBe('ev');
    expect(rowFieldValue(row, 'model')).toBe('m-sonnet');
    expect(rowFieldValue(row, 'status')).toBe('completed');
    expect(rowFieldLabel(row, 'status')).toBe('completed');
  });

  it('handles missing judge/evaluator with em dashes and empty ids', () => {
    const row = buildRunTableRow(run({ id: 'a' }), resolvers);
    expect(row.judgeModelId).toBe('');
    expect(row.judgeLabel).toBe('—');
    expect(row.evaluatorId).toBe('');
    expect(row.passRate).toBeNull();
  });
});

describe('filters', () => {
  const rows: RunTableRow[] = [
    run({ id: 'cc1', agentKey: 'agent-cc', evaluatorId: 'ev-a' }),
    run({ id: 'cc2', agentKey: 'agent-cc', evaluatorId: 'ev-b' }),
    run({ id: 'ais1', agentKey: 'agent-ais', evaluatorId: 'ev-a', status: 'running' }),
  ].map(r => buildRunTableRow(r, resolvers));

  const fAgentCC: RunFilter = { field: 'agent', value: 'agent-cc', label: 'Agent A' };
  const fAgentAIS: RunFilter = { field: 'agent', value: 'agent-ais', label: 'Agent B' };
  const fEvA: RunFilter = { field: 'evaluator', value: 'ev-a', label: 'E:ev-a' };
  const fRunning: RunFilter = { field: 'status', value: 'running', label: 'Running' };

  it('returns all rows with no filters (same reference)', () => {
    expect(applyRunFilters(rows, [])).toBe(rows);
  });

  it('ANDs across fields and ORs within a field', () => {
    expect(applyRunFilters(rows, [fAgentCC]).map(r => r.run.id)).toEqual(['cc1', 'cc2']);
    expect(applyRunFilters(rows, [fAgentCC, fAgentAIS]).map(r => r.run.id)).toEqual(['cc1', 'cc2', 'ais1']);
    expect(applyRunFilters(rows, [fAgentCC, fEvA]).map(r => r.run.id)).toEqual(['cc1']);
    expect(applyRunFilters(rows, [fRunning]).map(r => r.run.id)).toEqual(['ais1']);
    expect(applyRunFilters(rows, [fAgentCC, fRunning])).toEqual([]);
  });

  it('toggleRunFilter adds when absent and removes when present', () => {
    const a = toggleRunFilter([], fAgentCC);
    expect(a).toEqual([fAgentCC]);
    const b = toggleRunFilter(a, fEvA);
    expect(b).toHaveLength(2);
    // Same field+value but a different label still counts as the same filter.
    const c = toggleRunFilter(b, { ...fAgentCC, label: 'renamed' });
    expect(c).toEqual([fEvA]);
  });

  it('removeRunFilter removes only the matching filter', () => {
    expect(removeRunFilter([fAgentCC, fEvA], fEvA)).toEqual([fAgentCC]);
    expect(removeRunFilter([fAgentCC], fEvA)).toEqual([fAgentCC]);
  });
});

describe('sorting', () => {
  const rows = [
    run({ id: 'b', name: 'Bravo', createdAt: '2026-09-02T00:00:00Z', results: { t: res('completed', 'passed') }, testCaseSnapshots: [{}, {}] as any }),
    run({ id: 'a', name: 'Alpha', createdAt: '2026-09-03T00:00:00Z', results: { t: res('completed', 'failed') }, testCaseSnapshots: [{}] as any }),
    run({ id: 'c', name: 'Charlie', createdAt: '2026-09-01T00:00:00Z', results: {}, testCaseSnapshots: [{}, {}, {}] as any }),
  ].map(r => buildRunTableRow(r, resolvers));

  it('defaults to newest first', () => {
    expect(DEFAULT_RUN_SORT).toEqual({ field: 'date', dir: 'desc' });
    expect(sortRunRows(rows, DEFAULT_RUN_SORT).map(r => r.run.id)).toEqual(['a', 'b', 'c']);
  });

  it('sorts by name asc/desc', () => {
    expect(sortRunRows(rows, { field: 'name', dir: 'asc' }).map(r => r.run.id)).toEqual(['a', 'b', 'c']);
    expect(sortRunRows(rows, { field: 'name', dir: 'desc' }).map(r => r.run.id)).toEqual(['c', 'b', 'a']);
  });

  it('sorts by size numerically', () => {
    expect(sortRunRows(rows, { field: 'size', dir: 'desc' }).map(r => r.run.id)).toEqual(['c', 'b', 'a']);
  });

  it('sinks null pass rates to the bottom in either direction', () => {
    expect(sortRunRows(rows, { field: 'passRate', dir: 'desc' }).map(r => r.run.id)).toEqual(['b', 'a', 'c']);
    expect(sortRunRows(rows, { field: 'passRate', dir: 'asc' }).map(r => r.run.id)).toEqual(['a', 'b', 'c']);
  });

  it('does not mutate the input', () => {
    const copy = [...rows];
    sortRunRows(rows, { field: 'name', dir: 'asc' });
    expect(rows).toEqual(copy);
  });

  it('toggleRunSort flips direction on the same field and picks a sensible default on a new one', () => {
    expect(toggleRunSort({ field: 'date', dir: 'desc' }, 'date')).toEqual({ field: 'date', dir: 'asc' });
    expect(toggleRunSort({ field: 'date', dir: 'desc' }, 'name')).toEqual({ field: 'name', dir: 'asc' });
    expect(toggleRunSort({ field: 'name', dir: 'asc' }, 'passRate')).toEqual({ field: 'passRate', dir: 'desc' });
    expect(toggleRunSort({ field: 'name', dir: 'asc' }, 'size')).toEqual({ field: 'size', dir: 'desc' });
  });
});

describe('buildPassRateSeries', () => {
  it('groups by agent, orders points by time, and drops runs without an evaluable pass rate', () => {
    const rows = [
      run({ id: 'cc-late', agentKey: 'agent-cc', createdAt: '2026-09-03T00:00:00Z', results: { t: res('completed', 'passed') } }),
      run({ id: 'cc-early', agentKey: 'agent-cc', createdAt: '2026-09-01T00:00:00Z', results: { t: res('completed', 'failed') } }),
      run({ id: 'ais', agentKey: 'agent-ais', createdAt: '2026-09-02T00:00:00Z', results: { t: res('completed', 'passed'), u: res('completed', 'failed') } }),
      run({ id: 'errored-only', agentKey: 'agent-ais', createdAt: '2026-09-02T12:00:00Z', results: { t: res('completed') } }),
      run({ id: 'running-nothing-judged', agentKey: 'agent-cc', createdAt: '2026-09-04T00:00:00Z', status: 'running', results: { t: res('running') } }),
    ].map(r => buildRunTableRow(r, resolvers));

    const series = buildPassRateSeries(rows);
    // Alphabetical by label — NOT by point count — so the index→colour mapping
    // is stable while polling adds runs.
    expect(series.map(s => s.key)).toEqual(['agent-cc', 'agent-ais']); // 'Agent A' < 'Agent B'
    expect(series[0].label).toBe('Agent A');
    expect(series[0].points.map(p => p.runId)).toEqual(['cc-early', 'cc-late']);
    expect(series[0].points.map(p => p.passRate)).toEqual([0, 100]);
    expect(series[1].points).toHaveLength(1);
    expect(series[1].points[0]).toMatchObject({ runId: 'ais', passRate: 50, passed: 1, failed: 1, total: 2 });
    for (const s of series) for (const p of s.points) expect(typeof p.t).toBe('number');
  });

  it('skips runs with an unparseable createdAt', () => {
    const rows = [run({ id: 'x', createdAt: 'not-a-date', results: { t: res('completed', 'passed') } })].map(r => buildRunTableRow(r, resolvers));
    expect(buildPassRateSeries(rows)).toEqual([]);
  });

  it('returns an empty list for no rows', () => {
    expect(buildPassRateSeries([])).toEqual([]);
  });

  it('keeps series order (and therefore colours) stable when a new run makes another agent the busiest', () => {
    const base = [
      run({ id: 'cc1', agentKey: 'agent-cc', createdAt: '2026-09-01T00:00:00Z', results: { t: res('completed', 'passed') } }),
      run({ id: 'ais1', agentKey: 'agent-ais', createdAt: '2026-09-01T00:00:00Z', results: { t: res('completed', 'passed') } }),
      run({ id: 'ais2', agentKey: 'agent-ais', createdAt: '2026-09-02T00:00:00Z', results: { t: res('completed', 'passed') } }),
    ].map(r => buildRunTableRow(r, resolvers));
    const before = buildPassRateSeries(base).map(s => s.key);
    const after = buildPassRateSeries([
      ...base,
      ...[
        run({ id: 'cc2', agentKey: 'agent-cc', createdAt: '2026-09-03T00:00:00Z', results: { t: res('completed', 'passed') } }),
        run({ id: 'cc3', agentKey: 'agent-cc', createdAt: '2026-09-04T00:00:00Z', results: { t: res('completed', 'passed') } }),
      ].map(r => buildRunTableRow(r, resolvers)),
    ]).map(s => s.key);
    expect(after).toEqual(before);
  });
});

describe('latestRunId', () => {
  it('picks the max createdAt regardless of array order and ignores unparseable dates', () => {
    expect(latestRunId([
      { id: 'old', createdAt: '2026-09-01T00:00:00Z' },
      { id: 'bad', createdAt: 'nope' },
      { id: 'new', createdAt: '2026-09-03T00:00:00Z' },
      { id: 'mid', createdAt: '2026-09-02T00:00:00Z' },
    ])).toBe('new');
  });
  it('returns null for an empty list', () => {
    expect(latestRunId([])).toBeNull();
  });
});

describe('seriesColor', () => {
  it('cycles through the palette', () => {
    expect(seriesColor(0)).toBe(SERIES_COLORS[0]);
    expect(seriesColor(SERIES_COLORS.length)).toBe(SERIES_COLORS[0]);
    expect(seriesColor(SERIES_COLORS.length + 1)).toBe(SERIES_COLORS[1]);
  });
});
