/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Render tests for the compact BenchmarkRunsTable + RunFilterPills used by
 * the benchmark Runs tab. Page-level wiring (filters actually narrowing the
 * rows, chart legend, etc.) lives in BenchmarkRunsPage.test.ts; this file
 * pins the table's own contract: empty state, filter-pill rendering, action
 * gating, and the click-to-filter cells not triggering row navigation.
 */

import * as React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import type { BenchmarkRun } from '@/types';

jest.mock('@/lib/utils', () => ({
  formatDate: jest.fn(() => 'Aug 31, 2026'),
  cn: jest.fn((...args: unknown[]) => args.filter(Boolean).join(' ')),
}));

jest.mock('@/components/evals3/BenchmarkCasesTab', () => ({
  CaseHeatStrip: ({ run }: { run: BenchmarkRun }) => React.createElement('div', { 'data-testid': 'heat-strip' }, run.name),
}));

import { BenchmarkRunsTable, RunFilterPills, formatRunDate, BenchmarkRunsTableProps } from '@/components/evals3/BenchmarkRunsTable';
import { buildRunTableRow, RunFilter } from '@/lib/benchmarkRunsTable';

const resolvers = {
  agentName: (k: string) => k,
  modelName: (id: string) => id,
  judgeLabel: (id?: string | null) => id || '—',
  evaluatorLabel: (id?: string | null) => id || '—',
};

function mkRun(overrides: Partial<BenchmarkRun> & { id: string }): BenchmarkRun {
  return {
    name: overrides.id, createdAt: '2026-09-01T00:00:00.000Z', agentKey: 'agent-a', modelId: 'model-x',
    status: 'completed', results: { t: { reportId: 'r', status: 'completed', passFailStatus: 'passed' } as any },
    ...overrides,
  } as BenchmarkRun;
}

function renderTable(partial: Partial<BenchmarkRunsTableProps> = {}) {
  const props: BenchmarkRunsTableProps = {
    rows: [], filters: [], onToggleFilter: jest.fn(), sort: { field: 'date', dir: 'desc' }, onSort: jest.fn(),
    benchmarkId: 'bench-1', currentVersion: 2, latestRunId: null, selectable: true, selectedRunIds: [],
    onToggleSelect: jest.fn(), onOpenRun: jest.fn(), onOpenEvaluator: jest.fn(),
    onDelete: jest.fn(), deletingId: null, onCancel: jest.fn(), isCancelling: () => false,
    testCases: [], reportsById: {}, onSelectCase: jest.fn(), expandedRunIds: new Set(), onToggleExpand: jest.fn(),
    ...partial,
  };
  return { ...render(React.createElement(BenchmarkRunsTable, props)), props };
}

describe('BenchmarkRunsTable', () => {
  it('renders the filtered-empty message when there are no rows', () => {
    renderTable();
    expect(screen.getByTestId('benchmark-runs-table-empty').textContent).toContain('No runs match the current filters');
  });

  it('clicking a filter cell calls onToggleFilter with the raw id and does NOT open the run', () => {
    const row = buildRunTableRow(mkRun({ id: 'r1', agentKey: 'agent-z', judgeModelId: 'jm', evaluatorId: 'ev' }), resolvers);
    const { props } = renderTable({ rows: [row] });
    fireEvent.click(screen.getByTestId('run-cell-agent'));
    expect(props.onToggleFilter).toHaveBeenCalledWith({ field: 'agent', value: 'agent-z', label: 'agent-z' });
    fireEvent.click(screen.getByTestId('run-cell-judge'));
    expect(props.onToggleFilter).toHaveBeenCalledWith({ field: 'judge', value: 'jm', label: 'jm' });
    fireEvent.click(screen.getByTestId('run-cell-evaluator'));
    expect(props.onToggleFilter).toHaveBeenCalledWith({ field: 'evaluator', value: 'ev', label: 'ev' });
    fireEvent.click(screen.getByTestId('run-cell-model'));
    expect(props.onToggleFilter).toHaveBeenCalledWith({ field: 'model', value: 'model-x', label: 'model-x' });
    expect(props.onOpenRun).not.toHaveBeenCalled();
    // but clicking the row itself does open it
    fireEvent.click(screen.getByTestId('run-row'));
    expect(props.onOpenRun).toHaveBeenCalledWith('r1');
  });

  it('marks the active filter cell aria-pressed', () => {
    const row = buildRunTableRow(mkRun({ id: 'r1' }), resolvers);
    const filters: RunFilter[] = [{ field: 'agent', value: 'agent-a', label: 'agent-a' }];
    renderTable({ rows: [row], filters });
    expect(screen.getByTestId('run-cell-agent').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('run-cell-model').getAttribute('aria-pressed')).toBe('false');
  });

  it('renders em dashes for missing judge/evaluator instead of filter buttons', () => {
    const row = buildRunTableRow(mkRun({ id: 'r1' }), resolvers);
    renderTable({ rows: [row] });
    expect(screen.queryByTestId('run-cell-judge')).toBeNull();
    expect(screen.queryByTestId('run-cell-evaluator')).toBeNull();
  });

  // Owner ask (2026-09-08): Delete on EVERY row — the table no longer has an
  // "actions disabled" set; the page dispatches per run kind instead.
  it('status badges filter by status; every row offers Delete; only a Running row offers Cancel', () => {
    const running = buildRunTableRow(mkRun({ id: 'run-running', status: 'running' }), resolvers);
    const done = buildRunTableRow(mkRun({ id: 'run-done' }), resolvers);
    const ext = buildRunTableRow(mkRun({ id: 'run-ext', status: 'cancelled' }), resolvers);
    const { props } = renderTable({ rows: [running, done, ext] });

    const rows = screen.getAllByTestId('run-row');
    fireEvent.click(within(rows[0]).getByTestId('run-status-running'));
    expect(props.onToggleFilter).toHaveBeenCalledWith({ field: 'status', value: 'running', label: 'Running' });
    expect(within(rows[0]).getByLabelText('Cancel run')).toBeTruthy();
    fireEvent.click(within(rows[0]).getByLabelText('Cancel run'));
    expect(props.onCancel).toHaveBeenCalledWith(running);

    expect(within(rows[1]).queryByLabelText('Cancel run')).toBeNull();
    fireEvent.click(within(rows[1]).getByLabelText('Delete run'));
    expect(props.onDelete).toHaveBeenCalledWith(done);

    // The running row has Delete too.
    expect(within(rows[0]).getByLabelText('Delete run')).toBeTruthy();

    fireEvent.click(within(rows[2]).getByTestId('run-status-cancelled'));
    expect(props.onToggleFilter).toHaveBeenCalledWith({ field: 'status', value: 'cancelled', label: 'Cancelled' });
    expect(within(rows[2]).getByLabelText('Delete run')).toBeTruthy();
    expect(within(rows[2]).queryByLabelText('Cancel run')).toBeNull();
    expect(screen.getAllByLabelText('Delete run')).toHaveLength(3);
  });

  it('a deleting row shows its Delete button disabled (spinner) while others stay enabled', () => {
    const a = buildRunTableRow(mkRun({ id: 'run-a' }), resolvers);
    const b = buildRunTableRow(mkRun({ id: 'run-b' }), resolvers);
    renderTable({ rows: [a, b], deletingId: 'run-a' });
    const rows = screen.getAllByTestId('run-row');
    expect((within(rows[0]).getByLabelText('Delete run') as HTMLButtonElement).disabled).toBe(true);
    expect((within(rows[1]).getByLabelText('Delete run') as HTMLButtonElement).disabled).toBe(false);
  });

  // Owner report (2026-09-08): cancelled runs still looked in progress on the
  // benchmark page — "Cancelled" badge next to "/19 ⟳". A terminal row must
  // read "n not run" and never carry a spinner or a Running badge.
  it('cancelled partial run: Cancelled badge + "n not run", no spinner, no Running badge; failed run gets a Failed badge', () => {
    const snaps = Array.from({ length: 6 }, (_, i) => ({ id: `tc-${i}`, version: 1, name: `tc-${i}` })) as any;
    const partialResults = {
      'tc-0': { reportId: 'r0', status: 'completed', passFailStatus: 'passed' },
      'tc-1': { reportId: 'r1', status: 'completed', passFailStatus: 'failed' },
    } as any;
    const cancelled = buildRunTableRow(mkRun({ id: 'run-cancelled', status: 'cancelled', results: partialResults, testCaseSnapshots: snaps }), resolvers);
    const failed = buildRunTableRow(mkRun({ id: 'run-failed', status: 'failed', error: 'executor died', results: { ...partialResults, 'tc-2': { reportId: '', status: 'running' } }, testCaseSnapshots: snaps }), resolvers);
    const live = buildRunTableRow(mkRun({ id: 'run-live', status: 'running', results: { ...partialResults, 'tc-2': { reportId: '', status: 'running' } }, testCaseSnapshots: snaps }), resolvers);
    const { props } = renderTable({ rows: [cancelled, failed, live] });
    const [rowCancelled, rowFailed, rowLive] = screen.getAllByTestId('run-row');

    // Cancelled: badge, "4 not run", pass rate over judged cases only, NO in-progress affordances.
    expect(within(rowCancelled).getByTestId('run-status-cancelled')).toBeTruthy();
    expect(within(rowCancelled).queryByTestId('run-status-running')).toBeNull();
    expect(within(rowCancelled).queryByTestId('run-stats-pending')).toBeNull();
    expect(rowCancelled.querySelector('.animate-spin')).toBeNull();
    expect(within(rowCancelled).getByTestId('run-stats-not-run').textContent).toContain('4 not run');
    expect(within(rowCancelled).getByTestId('run-passrate-cell').textContent).toContain('50%');
    expect(within(rowCancelled).getByTestId('run-size-cell').textContent).toBe('6');
    expect(within(rowCancelled).queryByLabelText('Cancel run')).toBeNull();

    // Failed: badge filters by status; the dead executor's `running` entry is "not run", not a spinner.
    fireEvent.click(within(rowFailed).getByTestId('run-status-failed'));
    expect(props.onToggleFilter).toHaveBeenCalledWith({ field: 'status', value: 'failed', label: 'Failed' });
    expect(within(rowFailed).getByTestId('run-status-failed').getAttribute('title')).toContain('executor died');
    expect(rowFailed.querySelector('.animate-spin')).toBeNull();
    expect(within(rowFailed).getByTestId('run-stats-not-run').textContent).toContain('4 not run');

    // Live run keeps the in-progress rendering and shows no "not run".
    expect(within(rowLive).getByTestId('run-status-running')).toBeTruthy();
    expect(within(rowLive).getByTestId('run-stats-pending').textContent).toContain('/4');
    expect(within(rowLive).queryByTestId('run-stats-not-run')).toBeNull();
  });

  it('shows an outdated version badge only when the run version is behind the benchmark', () => {
    const old = buildRunTableRow(mkRun({ id: 'old', benchmarkVersion: 1 }), resolvers);
    const cur = buildRunTableRow(mkRun({ id: 'cur', benchmarkVersion: 2 }), resolvers);
    renderTable({ rows: [old, cur], currentVersion: 2 });
    const rows = screen.getAllByTestId('run-row');
    expect(within(rows[0]).getByText('v1')).toBeTruthy();
    expect(within(rows[1]).queryByText('v2')).toBeNull();
  });

  it('renders the heat strip only for expanded rows', () => {
    const a = buildRunTableRow(mkRun({ id: 'a' }), resolvers);
    const b = buildRunTableRow(mkRun({ id: 'b' }), resolvers);
    const { props } = renderTable({ rows: [a, b], expandedRunIds: new Set(['b']) });
    expect(screen.getAllByTestId('heat-strip')).toHaveLength(1);
    expect(screen.getByTestId('heat-strip').textContent).toBe('b');
    fireEvent.click(within(screen.getAllByTestId('run-row')[0]).getByTestId('run-expand-cases'));
    expect(props.onToggleExpand).toHaveBeenCalledWith('a');
  });

  it('sort headers expose aria-sort and call onSort', () => {
    const { props } = renderTable({ sort: { field: 'passRate', dir: 'asc' } });
    const th = screen.getByText('Pass %').closest('th')!;
    expect(th.getAttribute('aria-sort')).toBe('ascending');
    fireEvent.click(th);
    expect(props.onSort).toHaveBeenCalledWith('passRate');
    expect(screen.getByText('Date').closest('th')!.getAttribute('aria-sort')).toBe('none');
  });
});

describe('RunFilterPills', () => {
  it('renders nothing without filters', () => {
    const { container } = render(React.createElement(RunFilterPills, { filters: [], onRemove: jest.fn(), onClear: jest.fn(), shown: 3, total: 3 }));
    expect(container.innerHTML).toBe('');
  });

  it('renders one pill per filter using column-header labels, plus Clear and the shown/total count', () => {
    const onRemove = jest.fn();
    const onClear = jest.fn();
    const filters: RunFilter[] = [
      { field: 'agent', value: 'a', label: 'Agent A' },
      { field: 'evaluator', value: 'e', label: 'Persona' },
      { field: 'judge', value: 'j', label: 'Sonnet' },
    ];
    render(React.createElement(RunFilterPills, { filters, onRemove, onClear, shown: 1, total: 5 }));
    const pills = screen.getAllByTestId('run-filter-pill');
    expect(pills.map(p => p.textContent)).toEqual(['Agent:Agent A', 'Judge:Persona', 'J. Model:Sonnet']);
    expect(screen.getByTestId('run-filter-count').textContent).toBe('1 of 5 runs');
    fireEvent.click(pills[1]);
    expect(onRemove).toHaveBeenCalledWith(filters[1]);
    fireEvent.click(screen.getByTestId('run-filter-clear'));
    expect(onClear).toHaveBeenCalled();
  });
});

describe('formatRunDate', () => {
  it('omits the year for the current year and includes it otherwise', () => {
    const now = new Date('2026-09-03T12:00:00Z');
    expect(formatRunDate('2026-09-01T15:04:00Z', now)).not.toMatch(/2026/);
    expect(formatRunDate('2025-09-01T15:04:00Z', now)).toMatch(/2025/);
    expect(formatRunDate('garbage', now)).toBe('—');
  });
});

// ─── Telemetry columns (Tokens · Cost · LLM calls · Time/case) ──────────────
// Owner ask (2026-09-09): telemetry on the benchmark pages. Values come from
// useRunTelemetry via `telemetryByRunId`; this pins the table's three cell
// states (value / "—" + reason tooltip / loading skeleton) and that the new
// columns are sortable.
import { sortRunRows } from '@/lib/benchmarkRunsTable';
import type { RunTelemetry } from '@/lib/runTelemetry';
import {
  TELEMETRY_NO_SPANS_TITLE, TELEMETRY_UNAVAILABLE_TITLE, TELEMETRY_NO_REPORTS_TITLE, telemetryDashTitle,
} from '@/components/evals3/BenchmarkRunsTable';

const tel = (over: Partial<RunTelemetry> = {}): RunTelemetry => ({
  totalTokens: 5_900_000, costUsd: 20.19, llmCalls: 312, toolCalls: 118,
  medianDurationMs: 44_000, spansCases: 4, totalCases: 4, hasSpans: true, partial: false, ...over,
});

describe('BenchmarkRunsTable — telemetry columns', () => {
  it('adds Tokens / Cost / LLM calls / Time/case headers between Pass % and Judge', () => {
    renderTable();
    const headers = screen.getAllByRole('columnheader').map(h => h.textContent?.trim()).filter(Boolean);
    expect(headers).toEqual(['Run', 'Agent', 'Model', 'Size', 'Pass %', 'Tokens', 'Cost', 'LLM calls', 'Time/case', 'Judge', 'J. Model', 'Date']);
  });

  it('renders compact values with detail tooltips when spans were found', () => {
    const row = buildRunTableRow(mkRun({ id: 'r1' }), resolvers);
    renderTable({ rows: [row], telemetryByRunId: { r1: tel() } });
    // The Tokens cell carries the cost as a CSS-hidden (lg:hidden) suffix so
    // narrow viewports — where the Cost column is hidden — still show it as
    // "5.9M · $20.19" in ONE cell.
    expect(screen.getByTestId('run-tokens-cell').textContent).toBe('5.9M · $20.19');
    expect(within(screen.getByTestId('run-tokens-cell')).getByText('· $20.19').className).toContain('lg:hidden');
    expect(screen.getByTestId('run-tokens-cell').getAttribute('data-state')).toBe('value');
    expect(within(screen.getByTestId('run-tokens-cell')).getByText('5.9M').getAttribute('title')).toContain('5,900,000 tokens');
    expect(within(screen.getByTestId('run-tokens-cell')).getByText('5.9M').getAttribute('title')).toContain('spans found for 4 of 4 cases');
    expect(screen.getByTestId('run-cost-cell').textContent).toBe('$20.19');
    expect(screen.getByTestId('run-llmcalls-cell').textContent).toBe('312');
    expect(within(screen.getByTestId('run-llmcalls-cell')).getByText('312').getAttribute('title')).toContain('118 tool calls');
    expect(screen.getByTestId('run-timepercase-cell').textContent).toBe('44 s');
  });

  it('prefixes ≥ when the metrics were flagged partial (size cap hit)', () => {
    const row = buildRunTableRow(mkRun({ id: 'r1' }), resolvers);
    renderTable({ rows: [row], telemetryByRunId: { r1: tel({ partial: true }) } });
    expect(within(screen.getByTestId('run-tokens-cell')).getByText('≥5.9M')).toBeTruthy();
    expect(screen.getByTestId('run-llmcalls-cell').textContent).toBe('≥312');
  });

  it('hasSpans:false → "—" with the no-spans tooltip on span-derived cells; Time/case still shows the wall-clock', () => {
    const row = buildRunTableRow(mkRun({ id: 'r1' }), resolvers);
    renderTable({ rows: [row], telemetryByRunId: { r1: tel({ hasSpans: false, spansCases: 0, totalTokens: 0, costUsd: 0, llmCalls: 0, medianDurationMs: 22_000 }) } });
    for (const id of ['run-tokens-cell', 'run-cost-cell', 'run-llmcalls-cell']) {
      const cell = screen.getByTestId(id);
      expect(cell.textContent).toBe('—');
      expect(cell.getAttribute('data-state')).toBe('empty');
      expect(within(cell).getByText('—').getAttribute('title')).toBe(TELEMETRY_NO_SPANS_TITLE);
    }
    expect(screen.getByTestId('run-timepercase-cell').textContent).toBe('22 s');
  });

  it('spans present but zero cost → Cost reads "—" (not $0.00) while Tokens keeps its value', () => {
    const row = buildRunTableRow(mkRun({ id: 'r1' }), resolvers);
    renderTable({ rows: [row], telemetryByRunId: { r1: tel({ costUsd: 0 }) } });
    expect(screen.getByTestId('run-cost-cell').textContent).toBe('—');
    expect(within(screen.getByTestId('run-cost-cell')).getByText('—').getAttribute('title')).toBe('Not recorded for this run');
    expect(screen.getByTestId('run-tokens-cell').textContent).toBe('5.9M');
  });

  it('shows a skeleton while the run is in telemetryLoadingRunIds and no value has arrived', () => {
    const row = buildRunTableRow(mkRun({ id: 'r1' }), resolvers);
    renderTable({ rows: [row], telemetryByRunId: {}, telemetryLoadingRunIds: new Set(['r1']) });
    const cell = screen.getByTestId('run-tokens-cell');
    expect(cell.getAttribute('data-state')).toBe('loading');
    expect(within(cell).getByLabelText('Loading')).toBeTruthy();
    expect(cell.textContent).toBe('');
  });

  it('telemetryUnavailable → every telemetry cell reads "—" with the unavailable tooltip; rest of the row still renders', () => {
    const row = buildRunTableRow(mkRun({ id: 'r1' }), resolvers);
    renderTable({ rows: [row], telemetryByRunId: { r1: tel() }, telemetryUnavailable: true });
    for (const id of ['run-tokens-cell', 'run-cost-cell', 'run-llmcalls-cell', 'run-timepercase-cell']) {
      const cell = screen.getByTestId(id);
      expect(cell.textContent).toBe('—');
      expect(within(cell).getByText('—').getAttribute('title')).toBe(TELEMETRY_UNAVAILABLE_TITLE);
    }
    expect(screen.getByTestId('run-size-cell').textContent).toBe('1');
  });

  it('a run with no roll-up at all (no reports) reads "—" with the no-reports tooltip', () => {
    const row = buildRunTableRow(mkRun({ id: 'r1' }), resolvers);
    renderTable({ rows: [row], telemetryByRunId: {} });
    expect(within(screen.getByTestId('run-tokens-cell')).getByText('—').getAttribute('title')).toBe(TELEMETRY_NO_REPORTS_TITLE);
  });

  it('telemetryDashTitle precedence: unavailable > no reports > no spans > not recorded > value', () => {
    expect(telemetryDashTitle({ telemetry: tel(), loading: false, unavailable: true }, true, '1')).toBe(TELEMETRY_UNAVAILABLE_TITLE);
    expect(telemetryDashTitle({ telemetry: undefined, loading: false, unavailable: false }, true, '1')).toBe(TELEMETRY_NO_REPORTS_TITLE);
    expect(telemetryDashTitle({ telemetry: tel({ hasSpans: false }), loading: false, unavailable: false }, true, '1')).toBe(TELEMETRY_NO_SPANS_TITLE);
    expect(telemetryDashTitle({ telemetry: tel({ hasSpans: false }), loading: false, unavailable: false }, false, '22 s')).toBe('');
    expect(telemetryDashTitle({ telemetry: tel(), loading: false, unavailable: false }, true, null)).toBe('Not recorded for this run');
    expect(telemetryDashTitle({ telemetry: tel(), loading: false, unavailable: false }, true, '1')).toBe('');
  });

  it('clicking the Tokens header sorts by tokens; sortRunRows orders by telemetry with no-span runs last', () => {
    const a = buildRunTableRow(mkRun({ id: 'a' }), resolvers);
    const b = buildRunTableRow(mkRun({ id: 'b' }), resolvers);
    const c = buildRunTableRow(mkRun({ id: 'c' }), resolvers);
    const telemetry = { a: tel({ totalTokens: 100 }), b: tel({ totalTokens: 900 }), c: tel({ hasSpans: false, totalTokens: 0 }) };
    const { props } = renderTable({ rows: [a, b, c], telemetryByRunId: telemetry });
    fireEvent.click(screen.getByRole('columnheader', { name: /Tokens/ }));
    expect(props.onSort).toHaveBeenCalledWith('tokens');

    expect(sortRunRows([a, b, c], { field: 'tokens', dir: 'desc' }, telemetry).map(r => r.run.id)).toEqual(['b', 'a', 'c']);
    expect(sortRunRows([a, b, c], { field: 'tokens', dir: 'asc' }, telemetry).map(r => r.run.id)).toEqual(['a', 'b', 'c']);
    // Time/case sorts by wall-clock, which a no-span run still has.
    const t2 = { a: tel({ medianDurationMs: 30_000 }), b: tel({ medianDurationMs: 10_000 }), c: tel({ hasSpans: false, medianDurationMs: 50_000 }) };
    expect(sortRunRows([a, b, c], { field: 'timePerCase', dir: 'desc' }, t2).map(r => r.run.id)).toEqual(['c', 'a', 'b']);
    // Cost / LLM calls follow the same rule; missing telemetry sinks to the bottom either way.
    expect(sortRunRows([a, b, c], { field: 'cost', dir: 'desc' }, { a: tel({ costUsd: 1 }), b: tel({ costUsd: 2 }) }).map(r => r.run.id)).toEqual(['b', 'a', 'c']);
    expect(sortRunRows([a, b, c], { field: 'llmCalls', dir: 'asc' }, { a: tel({ llmCalls: 5 }), b: tel({ llmCalls: 1 }) }).map(r => r.run.id)).toEqual(['b', 'a', 'c']);
  });
});
