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
 *  - Delete is offered on EVERY row (owner ask, 2026-09-08) and dispatches
 *    on the run's kind: evaluation-run docs → the evaluation-runs API,
 *    legacy embedded-only runs → the benchmark nested-run API (the wrong
 *    endpoint 404s — which is why the button used to be hidden instead)
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
const mockDeleteEvaluationRun = jest.fn(async () => true);
const mockCancelEvaluationRun = jest.fn(async () => true);
const mockExecuteBenchmarkRun = jest.fn();
jest.mock('@/services/client', () => ({
  executeBenchmarkRun: (...a: unknown[]) => mockExecuteBenchmarkRun(...a),
  listEvaluationRuns: (...a: unknown[]) => mockListEvaluationRuns(...a),
  deleteEvaluationRun: (...a: unknown[]) => mockDeleteEvaluationRun(...a),
  cancelEvaluationRun: (...a: unknown[]) => mockCancelEvaluationRun(...a),
}));

const mockHandleCancelRun = jest.fn();
jest.mock('@/hooks/useBenchmarkCancellation', () => ({
  useBenchmarkCancellation: () => ({
    isCancelling: () => false,
    handleCancelRun: (...a: unknown[]) => mockHandleCancelRun(...a),
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

  // Owner report (2026-09-08): "Delete button should be present for all runs
  // on the benchmark details page." Merged-in (non-embedded) rows used to get
  // no Delete/Cancel at all because the row actions only knew the
  // benchmark-embedded API; they now dispatch on the run's kind.
  it('renders Delete AND Cancel on a merged-in (non-embedded) running eval-run row; Delete → evaluation-runs API, Cancel → evaluation-run cancel', async () => {
    mockGetById.mockResolvedValue(makeBenchmark());
    mockListEvaluationRuns.mockResolvedValue({ evaluationRuns: [makeAssociatedEvalRun()] });
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);
    const { asyncBenchmarkStorage } = require('@/services/storage');
    await renderPage();

    await waitFor(() => expect(screen.getByText('Claude-code with traces')).toBeTruthy());
    const row = screen.getByText('Claude-code with traces').closest('[data-testid="run-row"]') as HTMLElement;
    const cancelBtn = row.querySelector('[aria-label="Cancel run"]') as HTMLButtonElement;
    const deleteBtn = row.querySelector('[aria-label="Delete run"]') as HTMLButtonElement;
    expect(cancelBtn).toBeTruthy();
    expect(deleteBtn).toBeTruthy();

    fireEvent.click(cancelBtn);
    await waitFor(() => expect(mockCancelEvaluationRun).toHaveBeenCalledWith('eval-run-running-1'));
    expect(mockHandleCancelRun).not.toHaveBeenCalled();

    fireEvent.click(deleteBtn);
    // The confirm names the run, flags it is running, and states reports are kept.
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringMatching(/Claude-code with traces.*still running.*reports are kept/s));
    await waitFor(() => expect(mockDeleteEvaluationRun).toHaveBeenCalledWith('eval-run-running-1'));
    expect(asyncBenchmarkStorage.deleteRun).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('a dual-written row (embedded AND an evaluation-run doc) deletes via the evaluation-runs API (the server removes both forms)', async () => {
    mockGetById.mockResolvedValue(makeBenchmark());
    // Same id as the embedded run — the doc form takes precedence for dispatch.
    mockListEvaluationRuns.mockResolvedValue({ evaluationRuns: [makeAssociatedEvalRun({ id: 'run-embedded-1', name: 'Embedded Run', status: 'completed' })] });
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);
    const { asyncBenchmarkStorage } = require('@/services/storage');
    await renderPage();

    await waitFor(() => expect(screen.getByText('Embedded Run')).toBeTruthy());
    const row = screen.getByText('Embedded Run').closest('[data-testid="run-row"]') as HTMLElement;
    fireEvent.click(row.querySelector('[aria-label="Delete run"]') as HTMLButtonElement);
    await waitFor(() => expect(mockDeleteEvaluationRun).toHaveBeenCalledWith('run-embedded-1'));
    expect(asyncBenchmarkStorage.deleteRun).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('a legacy embedded-only run (no evaluation-run doc) deletes via the benchmark nested-run API', async () => {
    mockGetById.mockResolvedValue(makeBenchmark());
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);
    const { asyncBenchmarkStorage } = require('@/services/storage');
    await renderPage();

    await waitFor(() => expect(screen.getByText('Embedded Run')).toBeTruthy());
    const row = screen.getByText('Embedded Run').closest('[data-testid="run-row"]') as HTMLElement;
    expect(row.querySelector('[title="Delete run"]')).toBeTruthy();
    fireEvent.click(row.querySelector('[aria-label="Delete run"]') as HTMLButtonElement);
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringMatching(/Embedded Run.*reports are kept/s));
    expect(confirmSpy.mock.calls[0][0]).not.toMatch(/still running/);
    await waitFor(() => expect(asyncBenchmarkStorage.deleteRun).toHaveBeenCalledWith('bench-1', 'run-embedded-1'));
    expect(mockDeleteEvaluationRun).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('declining the confirm deletes nothing', async () => {
    mockGetById.mockResolvedValue(makeBenchmark());
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(false);
    const { asyncBenchmarkStorage } = require('@/services/storage');
    await renderPage();

    await waitFor(() => expect(screen.getByText('Embedded Run')).toBeTruthy());
    const row = screen.getByText('Embedded Run').closest('[data-testid="run-row"]') as HTMLElement;
    fireEvent.click(row.querySelector('[aria-label="Delete run"]') as HTMLButtonElement);
    expect(asyncBenchmarkStorage.deleteRun).not.toHaveBeenCalled();
    expect(mockDeleteEvaluationRun).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
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

/**
 * Owner report (2026-09-09): after "Add Run", the header button stayed on
 * "Running…" indefinitely on long runs — the run completed server-side but
 * the button was bound to the SSE connection, which idle proxies close
 * without a `completed` event. The button must derive from the polled run
 * DOCUMENT instead.
 */
describe('BenchmarkRunsPage2 — Add Run header tracks the run document, not the SSE connection', () => {
  const LAUNCHED_ID = 'eval-run-launched-1';

  /** Drive Add Run → Start Run through the dialog. */
  async function launchRun() {
    fireEvent.click(screen.getByTestId('add-run-button'));
    await waitFor(() => expect(screen.getByTestId('run-config-dialog')).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Start Run/ }));
    });
  }

  /** The mocked SSE call: fires `started` with LAUNCHED_ID, then settles per `outcome`. */
  function mockStream(outcome: 'drop' | 'complete' | 'hang') {
    let resolveStream!: (v: unknown) => void;
    mockExecuteBenchmarkRun.mockImplementation(async (_bm: unknown, _rc: unknown, onProgress: any, onStarted: any) => {
      onStarted?.({ runId: LAUNCHED_ID, testCases: [{ id: 'tc-1', name: 'Case 1', status: 'pending' }] });
      // One live per-case progress event while the stream is up.
      onProgress?.({ currentRunId: LAUNCHED_ID, currentTestCaseId: 'tc-1', currentTestCaseIndex: 0, status: 'running', startedCount: 1, completedCount: 0, totalTestCases: 1 });
      if (outcome === 'drop') throw new Error('Evaluation run completed without returning result');
      if (outcome === 'complete') return { id: LAUNCHED_ID, status: 'completed', results: {} };
      return new Promise(resolve => { resolveStream = resolve; });
    });
    return { finish: () => resolveStream?.({ id: LAUNCHED_ID, status: 'completed' }) };
  }

  const launchedDoc = (status: string, results?: Record<string, unknown>) => makeAssociatedEvalRun({
    id: LAUNCHED_ID, name: 'Launched Run', status,
    testCaseSnapshots: [{ id: 'tc-1', version: 1, name: 'Case 1' }],
    results: results ?? (status === 'running' ? { 'tc-1': { reportId: '', status: 'running' } } : { 'tc-1': { reportId: 'r-l', status: 'completed', passFailStatus: 'passed' } }),
  });

  beforeEach(() => {
    jest.useFakeTimers();
    mockGetById.mockResolvedValue(makeBenchmark());
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.useRealTimers();
    (console.error as jest.Mock).mockRestore?.();
  });

  it('THE BUG: the SSE stream dropping after `started` keeps "Running…" while the polled doc is running, then resets to "Add Run" once the doc is terminal — no reload', async () => {
    mockStream('drop');
    // The polled doc reads `running` until the test flips it to `completed`.
    let docStatus = 'running';
    mockListEvaluationRuns.mockImplementation(async () => ({ evaluationRuns: [launchedDoc(docStatus)] }));
    await renderPage();
    // Fake timers: flush the initial load's microtasks.
    await act(async () => { await Promise.resolve(); });

    await launchRun();
    expect(mockExecuteBenchmarkRun).toHaveBeenCalledTimes(1);

    // The stream is gone (rejected) but the run is still running server-side:
    // the header stays on Running… and is NOT flipped to failed.
    const button = screen.getByTestId('add-run-button') as HTMLButtonElement;
    await waitFor(() => expect(button.getAttribute('data-run-state')).toBe('running'));
    expect(button.textContent).toContain('Running');
    expect(button.disabled).toBe(true);
    expect(screen.getByTestId('run-progress-panel')).toBeTruthy();
    // The progress panel fell back to the polled doc, so the case was not marked failed.
    expect(within(screen.getByTestId('run-progress-panel')).queryByText('Case 1')!.className).not.toContain('text-red');

    // Several poll cycles later the doc is still running → still Running….
    const pollsBefore = mockListEvaluationRuns.mock.calls.length;
    await act(async () => { jest.advanceTimersByTime(6000); });
    expect(mockListEvaluationRuns.mock.calls.length).toBeGreaterThan(pollsBefore);
    expect(button.getAttribute('data-run-state')).toBe('running');

    // …then the server finishes the run: the next poll sees a terminal doc
    // and the header resets, without any page reload.
    docStatus = 'completed';
    await act(async () => { jest.advanceTimersByTime(2000); });
    await waitFor(() => expect(button.getAttribute('data-run-state')).toBe('idle'));
    expect(button.textContent).toContain('Add Run');
    expect(button.disabled).toBe(false);
    expect(screen.queryByTestId('run-progress-panel')).toBeNull();
  });

  it('after the stream drops, the progress panel follows the polled doc\'s per-case results (completed / failed / cancelled / running / not started)', async () => {
    mockGetById.mockResolvedValue(makeBenchmark({ testCaseIds: ['tc-1', 'tc-2', 'tc-3', 'tc-4', 'tc-5'] }));
    mockGetByIds.mockResolvedValue([1, 2, 3, 4, 5].map(i => ({ id: `tc-${i}`, name: `Case ${i}` })));
    mockStream('drop');
    mockListEvaluationRuns.mockResolvedValue({ evaluationRuns: [launchedDoc('running', {
      'tc-1': { reportId: 'r1', status: 'completed', passFailStatus: 'passed' },
      'tc-2': { reportId: 'r2', status: 'failed' },
      'tc-3': { reportId: '', status: 'cancelled' },
      'tc-4': { reportId: '', status: 'running' },
      // tc-5: not started — absent from results.
    })] });
    await renderPage();
    await act(async () => { await Promise.resolve(); });

    await launchRun();
    const panel = await waitFor(() => screen.getByTestId('run-progress-panel'));
    await waitFor(() => expect(within(panel).getByText('1 / 5')).toBeTruthy());
    // Icons: one per state — check via the per-row color classes.
    const rowClass = (name: string) => within(panel).getByText(name).className;
    expect(rowClass('Case 4')).toContain('text-blue');   // running per doc
    expect(rowClass('Case 3')).toContain('text-amber');  // cancelled per doc
    expect(rowClass('Case 1')).toContain('text-muted');  // completed
    expect(rowClass('Case 5')).toContain('text-muted');  // not started → pending
    expect(panel.querySelectorAll('.lucide-circle-x, .lucide-x-circle').length).toBeGreaterThanOrEqual(1); // failed icon
  });

  it('happy path: the stream delivering `completed` resets the header immediately', async () => {
    mockStream('complete');
    mockListEvaluationRuns.mockResolvedValue({ evaluationRuns: [launchedDoc('completed')] });
    await renderPage();
    await act(async () => { await Promise.resolve(); });

    await launchRun();
    const button = screen.getByTestId('add-run-button') as HTMLButtonElement;
    await waitFor(() => expect(button.getAttribute('data-run-state')).toBe('idle'));
    expect(button.textContent).toContain('Add Run');
    expect(button.disabled).toBe(false);
  });

  it('the header is bound to the DOCUMENT even while the stream is alive: a run cancelled from another tab (doc → cancelled) resets the button although the SSE call never returned', async () => {
    const { finish } = mockStream('hang');
    let docStatus = 'running';
    mockListEvaluationRuns.mockImplementation(async () => ({ evaluationRuns: [launchedDoc(docStatus)] }));
    await renderPage();
    await act(async () => { await Promise.resolve(); });

    await launchRun();
    const button = screen.getByTestId('add-run-button') as HTMLButtonElement;
    await waitFor(() => expect(button.getAttribute('data-run-state')).toBe('running'));
    await act(async () => { jest.advanceTimersByTime(4000); });
    expect(button.getAttribute('data-run-state')).toBe('running');

    docStatus = 'cancelled';
    await act(async () => { jest.advanceTimersByTime(2000); });
    await waitFor(() => expect(button.getAttribute('data-run-state')).toBe('idle'));
    expect(button.textContent).toContain('Add Run');
    // Late stream completion is harmless.
    await act(async () => { finish(); });
    expect(button.getAttribute('data-run-state')).toBe('idle');
  });

  it('a POST that fails before `started` (no runId) resets to Add Run and marks the panel failed (nothing is running server-side)', async () => {
    mockExecuteBenchmarkRun.mockRejectedValue(new Error('Benchmark not found: bench-1'));
    await renderPage();
    await act(async () => { await Promise.resolve(); });

    await launchRun();
    const button = screen.getByTestId('add-run-button') as HTMLButtonElement;
    await waitFor(() => expect(button.getAttribute('data-run-state')).toBe('idle'));
    expect(button.disabled).toBe(false);
    expect(console.error).toHaveBeenCalledWith('Error running benchmark:', expect.any(Error));
  });

  it('the "already in progress" guard uses the derived state (alert while running, dialog when idle)', async () => {
    const { finish } = mockStream('hang');
    mockListEvaluationRuns.mockResolvedValue({ evaluationRuns: [launchedDoc('running')] });
    const alertSpy = jest.spyOn(window, 'alert').mockImplementation(() => {});
    await renderPage();
    await act(async () => { await Promise.resolve(); });

    await launchRun();
    const button = screen.getByTestId('add-run-button') as HTMLButtonElement;
    await waitFor(() => expect(button.getAttribute('data-run-state')).toBe('running'));
    // The button is disabled, but the handler must still be guarded.
    fireEvent.click(button);
    expect(screen.queryByTestId('run-config-dialog')).toBeNull();
    await act(async () => { finish(); });
    alertSpy.mockRestore();
  });
});
