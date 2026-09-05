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
    onToggleSelect: jest.fn(), onOpenRun: jest.fn(), onOpenEvaluator: jest.fn(), actionsDisabledIds: new Set(),
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

  it('status badges filter by status; Running row offers Cancel, terminal row offers Delete; disabled ids get neither', () => {
    const running = buildRunTableRow(mkRun({ id: 'run-running', status: 'running' }), resolvers);
    const done = buildRunTableRow(mkRun({ id: 'run-done' }), resolvers);
    const ext = buildRunTableRow(mkRun({ id: 'run-ext', status: 'cancelled' }), resolvers);
    const { props } = renderTable({ rows: [running, done, ext], actionsDisabledIds: new Set(['run-ext']) });

    const rows = screen.getAllByTestId('run-row');
    fireEvent.click(within(rows[0]).getByTestId('run-status-running'));
    expect(props.onToggleFilter).toHaveBeenCalledWith({ field: 'status', value: 'running', label: 'Running' });
    expect(within(rows[0]).getByLabelText('Cancel run')).toBeTruthy();
    fireEvent.click(within(rows[0]).getByLabelText('Cancel run'));
    expect(props.onCancel).toHaveBeenCalledWith(running);

    expect(within(rows[1]).queryByLabelText('Cancel run')).toBeNull();
    fireEvent.click(within(rows[1]).getByLabelText('Delete run'));
    expect(props.onDelete).toHaveBeenCalledWith(done);

    fireEvent.click(within(rows[2]).getByTestId('run-status-cancelled'));
    expect(props.onToggleFilter).toHaveBeenCalledWith({ field: 'status', value: 'cancelled', label: 'Cancelled' });
    expect(within(rows[2]).queryByLabelText('Delete run')).toBeNull();
    expect(within(rows[2]).queryByLabelText('Cancel run')).toBeNull();
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
