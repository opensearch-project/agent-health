/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Render tests for BenchmarkRunsPage2 (bug #6, 2026-09-01).
 *
 * Repro: a benchmark had 3 completed runs embedded in `benchmark.runs[]`
 * AND 3 more evaluation-runs associated via `evaluationRun.benchmarkId`
 * (created outside the "Add Run" embedded-run path — CLI/API/scheduled) —
 * the associated ones (including all 3 currently-running ones) never
 * rendered on this page at all, because it only ever read
 * `benchmark.runs[]` and never queried `/api/storage/evaluation-runs?
 * benchmarkId=...`.
 *
 * These tests cover:
 *  - associated (non-embedded) eval-runs are merged into the rendered list
 *  - a running associated eval-run shows the "Running" badge
 *  - Delete/Cancel are NOT offered on merged-in rows (they'd call
 *    benchmark-embedded-run-specific APIs that don't apply)
 */

import * as React from 'react';
import { render, screen, waitFor, act, fireEvent, within } from '@testing-library/react';
import type { Benchmark, BenchmarkRun } from '@/types';

const mockNavigate = jest.fn();
// The page derives the active tab from the URL; render it on the Runs tab.
jest.mock('react-router-dom', () => ({
  useParams: () => ({ benchmarkId: 'bench-1' }),
  useNavigate: () => mockNavigate,
  useLocation: () => ({ pathname: '/evaluations/benchmarks/bench-1/runs', search: '', hash: '', state: null, key: 'k' }),
  Link: ({ children, to, ...rest }: any) => React.createElement('a', { href: typeof to === 'string' ? to : '#', ...rest }, children),
}));

const mockGetById = jest.fn();
const mockGetByIds = jest.fn();
jest.mock('@/services/storage', () => ({
  asyncBenchmarkStorage: {
    getById: (...a: unknown[]) => mockGetById(...a),
    deleteRun: jest.fn(async () => true),
  },
  asyncTestCaseStorage: { getByIds: (...a: unknown[]) => mockGetByIds(...a) },
  asyncRunStorage: { getReportSummariesByIds: jest.fn(async () => ({})) },
}));

const mockListEvaluationRuns = jest.fn();
jest.mock('@/services/client', () => ({
  executeBenchmarkRun: jest.fn(),
  listEvaluationRuns: (...a: unknown[]) => mockListEvaluationRuns(...a),
}));

jest.mock('@/hooks/useBenchmarkCancellation', () => ({
  useBenchmarkCancellation: () => ({
    isCancelling: () => false,
    handleCancelRun: jest.fn(),
  }),
}));

jest.mock('@/lib/constants', () => ({
  DEFAULT_CONFIG: { agents: [{ key: 'agent-a', name: 'Agent A', enabled: true }], models: {} },
}));

jest.mock('@/lib/config', () => ({ ENV_CONFIG: { backendUrl: '' } }));

jest.mock('@/lib/utils', () => ({
  formatDate: jest.fn(() => 'Aug 31, 2026'),
  getModelName: jest.fn((id: string) => id),
  getLabelColor: jest.fn(() => ''),
  cn: jest.fn((...args: unknown[]) => args.filter(Boolean).join(' ')),
}));

// recharts' ResponsiveContainer measures the DOM (0×0 in jsdom → renders
// nothing and warns). The chart's own logic is covered by
// tests/unit/lib/benchmarkRunsTable.test.ts; here we only need the legend,
// so stub the SVG primitives.
jest.mock('recharts', () => {
  const R = require('react');
  const Passthrough = ({ children }: { children?: React.ReactNode }) => R.createElement('div', null, children);
  return {
    ResponsiveContainer: Passthrough, LineChart: Passthrough,
    Line: () => null, XAxis: () => null, YAxis: () => null, Tooltip: () => null, CartesianGrid: () => null,
  };
});

jest.mock('@/components/evals3/Breadcrumbs', () => ({
  Breadcrumbs: ({ actions }: { actions?: React.ReactNode }) =>
    React.createElement('nav', { 'data-testid': 'breadcrumbs' }, actions),
}));

jest.mock('@/components/BenchmarkEditor', () => ({
  BenchmarkEditor: () => null,
}));

jest.mock('@/components/JudgeModelSelect', () => ({
  JudgeModelSelect: () => null,
}));

// react-markdown is ESM-only; BenchmarkCasesTab → BenchmarkCaseDefinition →
// TestCaseDetailPanel pulls it in transitively. Stub the wrapper like
// TestCaseDetailPanel.test.ts does.
jest.mock('@/components/ui/markdown', () => ({
  Markdown: ({ children }: { children?: React.ReactNode }) => React.createElement('div', null, children),
}));

jest.mock('@/components/ui/resizable', () => ({
  ResizablePanelGroup: ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children),
  ResizablePanel: ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children),
  ResizableHandle: () => null,
}));

// fetch() for the evaluators-list effect (unrelated to this bug — stub it out).
global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ evaluators: [] }) })) as any;

import { BenchmarkRunsPage2 } from '@/components/evals3/BenchmarkRunsPage';

function makeEmbeddedRun(overrides: Partial<BenchmarkRun> = {}): BenchmarkRun {
  return {
    id: 'run-embedded-1',
    name: 'Embedded Run',
    createdAt: '2026-08-31T07:34:00.000Z',
    agentKey: 'agent-a',
    modelId: 'claude-3',
    status: 'completed',
    results: {
      'tc-1': { reportId: 'r-1', status: 'completed', passFailStatus: 'passed' } as any,
    },
    ...overrides,
  } as BenchmarkRun;
}

function makeBenchmark(overrides: Partial<Benchmark> = {}): Benchmark {
  return {
    id: 'bench-1',
    name: 'internal-benchmark-example',
    createdAt: '2026-08-31T06:08:00.000Z',
    updatedAt: '2026-08-31T06:08:00.000Z',
    currentVersion: 1,
    versions: [],
    testCaseIds: ['tc-1'],
    runs: [makeEmbeddedRun()],
    totalRuns: 1,
    hasMoreRuns: false,
    ...overrides,
  } as unknown as Benchmark;
}

function makeAssociatedEvalRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 'eval-run-running-1',
    docType: 'evaluation-run',
    name: 'Claude-code with traces',
    benchmarkId: 'bench-1',
    createdAt: '2026-08-31T22:31:18.455Z',
    status: 'running',
    agentKey: 'agent-a',
    modelId: 'claude-3',
    sources: [{ type: 'benchmark', benchmarkId: 'bench-1' }],
    trigger: 'ui',
    testCaseSnapshots: new Array(62).fill({ id: 'tc-x', version: 1, name: 'tc-x' }),
    results: Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [`tc-${i}`, { reportId: `r-${i}`, status: 'failed' }])
    ),
    ...overrides,
  };
}

async function renderPage() {
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(React.createElement(BenchmarkRunsPage2));
  });
  await waitFor(() => expect(mockGetById).toHaveBeenCalled());
  return result;
}

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  mockGetByIds.mockResolvedValue([]);
  mockListEvaluationRuns.mockResolvedValue({ evaluationRuns: [] });
});

describe('BenchmarkRunsPage2 — associated (non-embedded) eval-runs merge (bug #6)', () => {
  it('fetches evaluation-runs scoped to this benchmarkId alongside the embedded benchmark.runs', async () => {
    mockGetById.mockResolvedValue(makeBenchmark());
    await renderPage();

    await waitFor(() => {
      expect(mockListEvaluationRuns).toHaveBeenCalledWith(
        expect.objectContaining({ benchmarkId: 'bench-1' })
      );
    });
  });

  it('renders an associated running eval-run that is NOT embedded in benchmark.runs, with a Running badge', async () => {
    mockGetById.mockResolvedValue(makeBenchmark());
    mockListEvaluationRuns.mockResolvedValue({ evaluationRuns: [makeAssociatedEvalRun()] });
    await renderPage();

    await waitFor(() => expect(screen.getByText('Claude-code with traces')).toBeTruthy());
    const row = screen.getByText('Claude-code with traces').closest('[data-testid="run-row"]') as HTMLElement;
    expect(row.querySelector('[data-testid="run-status-running"]')).toBeTruthy();
    // Planned total (62) in the Size column, not just the 9 cases that have started.
    expect(row.querySelector('[data-testid="run-size-cell"]')!.textContent).toBe('62');
  });

  it('does not double-count an eval-run that has already been embedded into benchmark.runs', async () => {
    const embedded = makeEmbeddedRun({ id: 'eval-run-migrated', name: 'Migrated Run' });
    mockGetById.mockResolvedValue(makeBenchmark({ runs: [embedded] }));
    mockListEvaluationRuns.mockResolvedValue({
      evaluationRuns: [makeAssociatedEvalRun({ id: 'eval-run-migrated', name: 'Migrated Run', status: 'completed' })],
    });
    await renderPage();

    await waitFor(() => expect(screen.getByText('Migrated Run')).toBeTruthy());
    expect(screen.getAllByText('Migrated Run')).toHaveLength(1);
  });

  it('does not render Delete/Cancel for a merged-in (non-embedded) associated run — those APIs are benchmark-embedded-run-specific', async () => {
    mockGetById.mockResolvedValue(makeBenchmark());
    mockListEvaluationRuns.mockResolvedValue({ evaluationRuns: [makeAssociatedEvalRun()] });
    await renderPage();

    await waitFor(() => expect(screen.getByText('Claude-code with traces')).toBeTruthy());
    const row = screen.getByText('Claude-code with traces').closest('[data-testid="run-row"]') as HTMLElement;
    expect(row.querySelector('[title="Delete run"]')).toBeNull();
    expect(row.querySelector('[aria-label="Cancel run"]')).toBeNull();
  });

  it('still renders Delete for a genuinely embedded run', async () => {
    mockGetById.mockResolvedValue(makeBenchmark());
    await renderPage();

    await waitFor(() => expect(screen.getByText('Embedded Run')).toBeTruthy());
    const row = screen.getByText('Embedded Run').closest('[data-testid="run-row"]') as HTMLElement;
    expect(row.querySelector('[title="Delete run"]')).toBeTruthy();
  });

  it('is resilient to the evaluation-runs fetch failing (embedded runs still render)', async () => {
    mockGetById.mockResolvedValue(makeBenchmark());
    mockListEvaluationRuns.mockRejectedValue(new Error('network error'));
    await renderPage();

    await waitFor(() => expect(screen.getByText('Embedded Run')).toBeTruthy());
  });
});

// ─── Runs tab: table + chart + click-to-filter pills ─────────────────────────

describe('BenchmarkRunsPage2 — Runs tab table, chart and click-to-filter', () => {
  const ccRun = makeEmbeddedRun({
    id: 'run-cc', name: 'CC Run', agentKey: 'agent-a', modelId: 'model-x', judgeModelId: 'judge-m', evaluatorId: 'ev-1',
    createdAt: '2026-09-02T00:00:00.000Z',
    results: {
      'tc-1': { reportId: 'r-1', status: 'completed', passFailStatus: 'passed' } as any,
      'tc-2': { reportId: 'r-2', status: 'completed', passFailStatus: 'failed' } as any,
      'tc-3': { reportId: 'r-3', status: 'completed', passFailStatus: 'passed' } as any,
      'tc-4': { reportId: 'r-4', status: 'completed', passFailStatus: 'passed' } as any,
    },
  });
  const aisRun = makeEmbeddedRun({
    id: 'run-ais', name: 'AIS Run', agentKey: 'agent-b', modelId: 'model-y', judgeModelId: 'judge-m', evaluatorId: 'ev-2',
    createdAt: '2026-09-01T00:00:00.000Z',
    results: {
      'tc-1': { reportId: 'r-5', status: 'completed', passFailStatus: 'failed' } as any,
      'tc-2': { reportId: 'r-6', status: 'completed', passFailStatus: 'passed' } as any,
    },
  });

  beforeEach(() => {
    mockGetById.mockResolvedValue(makeBenchmark({ runs: [ccRun, aisRun], totalRuns: 2 }));
    (global.fetch as jest.Mock).mockImplementation(async () => ({
      ok: true,
      json: async () => ({ evaluators: [{ id: 'ev-1', name: 'Agent Persona' }, { id: 'ev-2', name: 'Human Persona' }] }),
    }));
  });

  it('renders one table row per run with the sketch columns: Run link, Agent, Model, Size, Pass %, Judge, J. Model, Date', async () => {
    await renderPage();
    await waitFor(() => expect(screen.getAllByTestId('run-row')).toHaveLength(2));

    const headers = Array.from(document.querySelectorAll('[data-testid="benchmark-runs-table"] thead th'))
      .map(th => th.textContent?.trim()).filter(Boolean);
    expect(headers).toEqual(['Run', 'Agent', 'Model', 'Size', 'Pass %', 'Judge', 'J. Model', 'Date']);

    const cc = screen.getByText('CC Run').closest('[data-testid="run-row"]') as HTMLElement;
    const link = within(cc).getByTestId('run-name-link');
    expect(link.getAttribute('href')).toBe('/evaluations/benchmarks/bench-1/runs/run-cc/inspect');
    expect(within(cc).getByTestId('run-cell-agent').textContent).toBe('Agent A');
    expect(within(cc).getByTestId('run-cell-model').textContent).toBe('model-x');
    expect(within(cc).getByTestId('run-size-cell').textContent).toBe('4');
    expect(within(cc).getByTestId('run-passrate-cell').textContent).toContain('75%');
    expect(within(cc).getByTestId('run-cell-evaluator').textContent).toBe('Agent Persona');
    expect(within(cc).getByTestId('run-cell-judge').textContent).toBe('judge-m');
    expect(within(cc).getByTestId('run-date-cell')).toBeTruthy();
  });

  it('sorts newest first by default and marks the newest run Latest', async () => {
    await renderPage();
    await waitFor(() => expect(screen.getAllByTestId('run-row')).toHaveLength(2));
    const names = screen.getAllByTestId('run-name-link').map(a => a.textContent);
    expect(names).toEqual(['CC Run', 'AIS Run']);
    const cc = screen.getByText('CC Run').closest('[data-testid="run-row"]') as HTMLElement;
    expect(within(cc).queryByTestId('run-latest-badge')).toBeTruthy();
  });

  it('Latest follows createdAt, not array position — a newer associated eval-run (appended after embedded runs) gets the badge', async () => {
    mockListEvaluationRuns.mockResolvedValue({
      evaluationRuns: [makeAssociatedEvalRun({ id: 'eval-newest', name: 'Newest Eval Run', status: 'completed', createdAt: '2026-09-05T00:00:00.000Z', results: { 'tc-1': { reportId: 'r', status: 'completed', passFailStatus: 'passed' } } })],
    });
    await renderPage();
    await waitFor(() => expect(screen.getAllByTestId('run-row')).toHaveLength(3));
    expect(screen.getAllByTestId('run-latest-badge')).toHaveLength(1);
    const newest = screen.getByText('Newest Eval Run').closest('[data-testid="run-row"]') as HTMLElement;
    expect(within(newest).queryByTestId('run-latest-badge')).toBeTruthy();
    // Default sort is newest-first too.
    expect(screen.getAllByTestId('run-name-link')[0].textContent).toBe('Newest Eval Run');
  });

  it('clicking the run name navigates to the inspector (and does not follow the href)', async () => {
    await renderPage();
    await waitFor(() => expect(screen.getAllByTestId('run-row')).toHaveLength(2));
    const cc = screen.getByText('CC Run').closest('[data-testid="run-row"]') as HTMLElement;
    fireEvent.click(within(cc).getByTestId('run-name-link'));
    expect(mockNavigate).toHaveBeenCalledWith('/evaluations/benchmarks/bench-1/runs/run-cc/inspect');
  });

  it('clicking an Agent cell filters the table and shows a removable pill; clicking the pill removes it', async () => {
    await renderPage();
    await waitFor(() => expect(screen.getAllByTestId('run-row')).toHaveLength(2));
    expect(screen.queryByTestId('run-filter-pills')).toBeNull();

    const cc = screen.getByText('CC Run').closest('[data-testid="run-row"]') as HTMLElement;
    fireEvent.click(within(cc).getByTestId('run-cell-agent'));

    await waitFor(() => expect(screen.getAllByTestId('run-row')).toHaveLength(1));
    expect(screen.getByText('CC Run')).toBeTruthy();
    expect(screen.queryByText('AIS Run')).toBeNull();

    const pills = screen.getAllByTestId('run-filter-pill');
    expect(pills).toHaveLength(1);
    expect(pills[0].getAttribute('data-filter-field')).toBe('agent');
    expect(pills[0].getAttribute('data-filter-value')).toBe('agent-a');
    expect(pills[0].textContent).toContain('Agent A');
    expect(screen.getByTestId('run-filter-count').textContent).toBe('1 of 2 runs');
    // The agent cell that is the active filter is marked pressed.
    expect(within(cc).getByTestId('run-cell-agent').getAttribute('aria-pressed')).toBe('true');
    // Row-click navigation must NOT fire when clicking a filter cell.
    expect(mockNavigate).not.toHaveBeenCalled();

    fireEvent.click(pills[0]);
    await waitFor(() => expect(screen.getAllByTestId('run-row')).toHaveLength(2));
    expect(screen.queryByTestId('run-filter-pills')).toBeNull();
  });

  it('filters on different fields AND together; Clear removes them all', async () => {
    await renderPage();
    await waitFor(() => expect(screen.getAllByTestId('run-row')).toHaveLength(2));
    const cc = screen.getByText('CC Run').closest('[data-testid="run-row"]') as HTMLElement;
    // Judge model is shared by both runs → still 2 rows.
    fireEvent.click(within(cc).getByTestId('run-cell-judge'));
    await waitFor(() => expect(screen.getAllByTestId('run-filter-pill')).toHaveLength(1));
    expect(screen.getAllByTestId('run-row')).toHaveLength(2);
    expect(screen.getAllByTestId('run-filter-pill')[0].textContent).toContain('J. Model:');
    // Evaluator (the "Judge" column) narrows to CC only.
    fireEvent.click(within(cc).getByTestId('run-cell-evaluator'));
    await waitFor(() => expect(screen.getAllByTestId('run-row')).toHaveLength(1));
    expect(screen.getAllByTestId('run-filter-pill')).toHaveLength(2);
    expect(screen.getAllByTestId('run-filter-pill')[1].textContent).toContain('Judge:');
    expect(screen.getAllByTestId('run-filter-pill')[1].textContent).toContain('Agent Persona');

    fireEvent.click(screen.getByTestId('run-filter-clear'));
    await waitFor(() => expect(screen.getAllByTestId('run-row')).toHaveLength(2));
    expect(screen.queryByTestId('run-filter-pills')).toBeNull();
  });

  it('renders the pass-rate chart with one legend entry per agent; the legend toggles the agent filter', async () => {
    await renderPage();
    await waitFor(() => expect(screen.getByTestId('benchmark-passrate-chart')).toBeTruthy());
    const legendA = screen.getByTestId('chart-legend-agent-a');
    const legendB = screen.getByTestId('chart-legend-agent-b');
    expect(legendA.textContent).toContain('Agent A');
    expect(legendB.textContent).toContain('agent-b'); // unknown agent key falls back to the key

    fireEvent.click(legendA);
    await waitFor(() => expect(screen.getAllByTestId('run-row')).toHaveLength(1));
    expect(legendA.getAttribute('aria-pressed')).toBe('true');
    // Agent filters DIM other lines but keep the legend intact so a second
    // agent can be toggled back in.
    expect(screen.getByTestId('chart-legend-agent-b')).toBeTruthy();
    fireEvent.click(screen.getByTestId('chart-legend-agent-b'));
    await waitFor(() => expect(screen.getAllByTestId('run-row')).toHaveLength(2));
    expect(screen.getAllByTestId('run-filter-pill')).toHaveLength(2);
  });

  it('expands a row to reveal the per-case verdict heat strip on demand', async () => {
    mockGetByIds.mockResolvedValue([
      { id: 'tc-1', name: 'Case 1' }, { id: 'tc-2', name: 'Case 2' },
    ]);
    mockGetById.mockResolvedValue(makeBenchmark({ runs: [ccRun, aisRun], totalRuns: 2, testCaseIds: ['tc-1', 'tc-2'] }));
    await renderPage();
    await waitFor(() => expect(screen.getAllByTestId('run-row')).toHaveLength(2));
    expect(screen.queryByTestId('run-row-cases')).toBeNull();
    const cc = screen.getByText('CC Run').closest('[data-testid="run-row"]') as HTMLElement;
    fireEvent.click(within(cc).getByTestId('run-expand-cases'));
    await waitFor(() => expect(screen.getAllByTestId('run-row-cases')).toHaveLength(1));
    expect(screen.getByLabelText('CC Run case verdicts')).toBeTruthy();
    fireEvent.click(within(cc).getByTestId('run-expand-cases'));
    await waitFor(() => expect(screen.queryByTestId('run-row-cases')).toBeNull());
  });

  it('the inactive Cases panel is hidden (regression: it used to stay display:flex and push the runs list ~400px down)', async () => {
    await renderPage();
    await waitFor(() => expect(screen.getAllByTestId('run-row')).toHaveLength(2));
    const casesPanel = document.querySelector('[role="tabpanel"][data-state="inactive"]') as HTMLElement | null;
    expect(casesPanel).toBeTruthy();
    expect(casesPanel!.className).toContain('data-[state=inactive]:hidden');
  });
});
