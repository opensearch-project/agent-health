/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for RunInspectorPage lazy report loading + infinite scroll.
 *
 * Covers:
 * - Statuses come from ONE getReportSummariesByIds batch (never a
 *   getReportById per row) and header tallies count ALL rows immediately.
 * - The test-case list is windowed (100 rows/page) with a sentinel; an
 *   IntersectionObserver hit reveals the next page.
 * - `?reportId=` deep links beyond the first window bump the window.
 * - A bare load (no `?reportId=`) selects NOTHING — verdict-first landing,
 *   no auto-opened first row (regression companion to #443's fix on the
 *   legacy /benchmarks/:id/runs/:id page).
 * - Summary-batch failure falls back to execution status (no crash).
 * - loadData failure renders the error + Retry state (not an infinite
 *   skeleton) and Retry recovers.
 * - The full report is fetched on-demand for the selected row only, and
 *   only once a row is actually selected (deep link or click).
 */

import * as React from 'react';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';

// ── Router mocks ─────────────────────────────────────────────────────────────

const mockNavigate = jest.fn();
let mockParams: Record<string, string | undefined> = { benchmarkId: 'bench-1', runId: 'run-1' };
let mockSearchParams = new URLSearchParams();

jest.mock('react-router-dom', () => ({
  useParams: () => mockParams,
  useNavigate: () => mockNavigate,
  useSearchParams: () => [mockSearchParams, jest.fn()],
}));

// ── Service mocks ────────────────────────────────────────────────────────────

const mockBenchmarkGetById = jest.fn();
const mockBenchmarkDeleteRun = jest.fn();
const mockTestCasesGetByIds = jest.fn();
const mockTestCaseGetById = jest.fn();
const mockGetReportSummariesByIds = jest.fn();
const mockGetReportById = jest.fn();

jest.mock('@/services/storage', () => ({
  asyncBenchmarkStorage: {
    getById: (...a: unknown[]) => mockBenchmarkGetById(...a),
    deleteRun: (...a: unknown[]) => mockBenchmarkDeleteRun(...a),
  },
  asyncTestCaseStorage: {
    getByIds: (...a: unknown[]) => mockTestCasesGetByIds(...a),
    getById: (...a: unknown[]) => mockTestCaseGetById(...a),
  },
  asyncRunStorage: {
    getReportSummariesByIds: (...a: unknown[]) => mockGetReportSummariesByIds(...a),
    getReportById: (...a: unknown[]) => mockGetReportById(...a),
  },
}));

jest.mock('@/services/client', () => ({
  getEvaluationRun: jest.fn(),
  updateEvaluationRun: jest.fn(),
  cancelEvaluationRun: jest.fn(),
  deleteEvaluationRun: jest.fn(),
}));

// Telemetry strip: the inspector hands its report summaries to useRunTelemetry
// (one POST /api/metrics/batch). Default: no spans anywhere.
const mockFetchBatchMetrics = jest.fn();
jest.mock('@/services/metrics', () => ({
  fetchBatchMetrics: (...a: unknown[]) => mockFetchBatchMetrics(...a),
}));

const mockEnsurePolling = jest.fn();
jest.mock('@/services/traces/browserRecovery', () => ({
  ensureTracePollingForReport: (...a: unknown[]) => mockEnsurePolling(...a),
}));

jest.mock('@/lib/constants', () => ({
  DEFAULT_CONFIG: { agents: [], models: {} },
}));

jest.mock('@/lib/utils', () => ({
  formatDate: jest.fn().mockReturnValue('2024-01-01'),
  getModelName: jest.fn((id: string) => id),
  cn: jest.fn((...args: unknown[]) => args.filter(Boolean).join(' ')),
}));

// ── UI mocks (avoid radix/layout side effects in jsdom) ─────────────────────

jest.mock('@/components/ui/skeleton', () => ({
  Skeleton: () => React.createElement('div', { 'data-testid': 'skeleton' }),
}));
jest.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: any) => React.createElement('button', props, children),
  // The kebab's delete-confirm AlertDialog composes buttonVariants().
  buttonVariants: () => '',
}));
jest.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: any) => React.createElement('div', null, children),
}));
jest.mock('@/components/ui/resizable', () => ({
  ResizablePanelGroup: ({ children }: any) => React.createElement('div', null, children),
  ResizablePanel: ({ children }: any) => React.createElement('div', null, children),
  ResizableHandle: () => null,
}));
jest.mock('@/components/evals3/TestCaseInspectorPanel', () => ({
  TestCaseInspectorPanel: () => React.createElement('div', { 'data-testid': 'inspector-panel' }),
}));
jest.mock('@/components/evals3/Breadcrumbs', () => ({
  Breadcrumbs: () => React.createElement('nav', { 'data-testid': 'breadcrumbs' }),
}));

jest.mock('@/components/evals3/RunConfigDialog', () => ({
  RunConfigDialog: ({ mode, sourceRun, open, onOpenChange }: any) => (
    open && sourceRun ? React.createElement(
      'div',
      { 'data-testid': 'run-config-dialog', 'data-mode': mode, onClick: () => onOpenChange(false) },
      `Dialog for ${sourceRun.id}`,
    ) : null
  ),
}));

jest.mock('@/components/evals3/RetryJudgementConfirmDialog', () => ({
  RetryJudgementConfirmDialog: ({ run, count, open, onOpenChange, onComplete }: any) => (
    open && run ? React.createElement(
      'div',
      {
        'data-testid': 'retry-judgement-confirm-dialog',
        onClick: () => {
          onComplete({ retried: count, succeeded: count, failed: 0, results: [] });
          onOpenChange(false);
        },
      },
      `Retry dialog for ${run.id} (${count})`,
    ) : null
  ),
}));

// The header's lifecycle actions live in the RunActionsMenu kebab (Radix
// DropdownMenu). Radix needs real pointer events + portals to open in jsdom,
// so render the menu content inline: each item becomes a plain <button>
// carrying the same data-testid / disabled / title, with onClick mapped to
// Radix's onSelect. The gating under test is the page's, not Radix's.
jest.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: any) => React.createElement('div', { 'data-testid': 'run-actions-menu' }, children),
  DropdownMenuTrigger: ({ children }: any) => React.createElement('div', null, children),
  DropdownMenuContent: ({ children }: any) => React.createElement('div', { role: 'menu' }, children),
  DropdownMenuSeparator: () => null,
  DropdownMenuItem: ({ children, onSelect, disabled, title, className, ...props }: any) =>
    React.createElement(
      'button',
      {
        role: 'menuitem',
        disabled,
        title,
        onClick: (e: any) => { if (!disabled) onSelect?.({ preventDefault: () => e?.preventDefault?.() }); },
        ...props,
      },
      children,
    ),
}));

// IntersectionObserver stub that records instances so tests can fire hits.
type IOCallback = (entries: Array<{ isIntersecting: boolean }>) => void;
const ioInstances: { callback: IOCallback; observed: Element[] }[] = [];
class MockIntersectionObserver {
  callback: IOCallback;
  observed: Element[] = [];
  constructor(cb: IOCallback) {
    this.callback = cb;
    ioInstances.push({ callback: cb, observed: this.observed });
  }
  observe(el: Element) { this.observed.push(el); }
  disconnect() { /* noop */ }
}
(globalThis as any).IntersectionObserver = MockIntersectionObserver;

import { RunInspectorPage } from '@/components/evals3/RunInspectorPage';

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeBenchmark(caseCount: number) {
  const results: Record<string, { reportId: string; status: string }> = {};
  for (let i = 0; i < caseCount; i++) {
    results[`tc-${i}`] = { reportId: `rep-${i}`, status: 'completed' };
  }
  return {
    id: 'bench-1',
    name: 'Bench',
    testCaseIds: Object.keys(results),
    runs: [{
      id: 'run-1',
      name: 'Run 1',
      agentKey: 'demo',
      modelId: 'demo-model',
      createdAt: '2024-01-01T00:00:00Z',
      status: 'completed',
      results,
    }],
  };
}

function makeSummaries(caseCount: number, failedIdx: number[] = []) {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < caseCount; i++) {
    out[`rep-${i}`] = {
      id: `rep-${i}`,
      status: 'completed',
      passFailStatus: failedIdx.includes(i) ? 'failed' : 'passed',
      metricsStatus: 'ready',
      trajectory: [],
    };
  }
  return out;
}

// Report summaries where `erroredIdx` cases carry `metricsStatus: 'error'`
// (getResultStatus() -> 'errored', the bucket Retry judgement salvages).
function makeErroredSummaries(caseCount: number, erroredIdx: number[] = []) {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < caseCount; i++) {
    out[`rep-${i}`] = erroredIdx.includes(i)
      ? { id: `rep-${i}`, status: 'completed', passFailStatus: null, metricsStatus: 'error', trajectory: [{ type: 'assistant', content: 'x' }] }
      : { id: `rep-${i}`, status: 'completed', passFailStatus: 'passed', metricsStatus: 'ready', trajectory: [] };
  }
  return out;
}

// An EvaluationRun (docType: 'evaluation-run') fixture, resolvable from
// `getEvaluationRun`. Used both for the eval-run-mode route and (the fix
// under test) the benchmark-scoped route when a first-class doc exists for
// a benchmark-linked run.
function makeEvaluationRunFixture(id: string, caseCount: number, erroredIdx: number[] = []) {
  const results: Record<string, { reportId: string; status: string }> = {};
  for (let i = 0; i < caseCount; i++) {
    results[`tc-${i}`] = { reportId: `rep-${i}`, status: 'completed' };
  }
  return {
    id,
    docType: 'evaluation-run' as const,
    name: 'Eval Run',
    agentKey: 'demo',
    modelId: 'demo-model',
    createdAt: '2024-01-01T00:00:00Z',
    status: 'completed' as const,
    sources: [],
    trigger: 'ui' as const,
    testCaseSnapshots: [],
    results,
  };
}

function makeTestCases(caseCount: number) {
  return Array.from({ length: caseCount }, (_, i) => ({ id: `tc-${i}`, name: `Case ${i}` }));
}

const renderPage = () => render(React.createElement(RunInspectorPage));

// Kebab items (data-testid is suffixed with the run id, which varies per
// fixture). `get*` throws when absent so they compose with waitFor().
const rerunItem = () => screen.getByTestId(/^run-action-rerun-/) as HTMLButtonElement;
const retryJudgementItem = () => screen.getByTestId(/^run-action-retry-judgement-/) as HTMLButtonElement;
const cancelItem = () => screen.queryByTestId(/^run-action-cancel-/) as HTMLButtonElement | null;
const deleteItem = () => screen.getByTestId(/^run-action-delete-/) as HTMLButtonElement;

beforeEach(() => {
  jest.clearAllMocks();
  ioInstances.length = 0;
  mockParams = { benchmarkId: 'bench-1', runId: 'run-1' };
  mockSearchParams = new URLSearchParams();
  mockGetReportById.mockResolvedValue({ id: 'rep-0', status: 'completed', passFailStatus: 'passed', trajectory: [] });
  // Default: no full test-case override (matches the summary already in
  // `results` for most tests). Tests exercising the eval-source lazy fetch
  // set a specific resolved value.
  mockTestCaseGetById.mockResolvedValue(null);
  mockFetchBatchMetrics.mockReset();
  mockFetchBatchMetrics.mockResolvedValue({ metrics: [], aggregate: {} });
  // `jest.clearAllMocks()` clears call history but NOT a persistent
  // `mockResolvedValue` set by an earlier test (that needs `mockReset()`).
  // Explicitly reset + default `getEvaluationRun` to "not found" every test
  // so a leftover implementation from one test (e.g. the eval-run-mode
  // fixtures below) can never leak into a benchmark-mode test that now
  // also calls `getEvaluationRun` (loadData's benchmark branch probes for
  // a first-class EvaluationRun doc to key Retry judgement's docType
  // check). Tests that care override this per-test as before.
  const { getEvaluationRun } = require('@/services/client');
  getEvaluationRun.mockReset();
  getEvaluationRun.mockRejectedValue(new Error('not found'));
});

describe('RunInspectorPage — lazy report loading', () => {
  it('loads statuses via ONE summary batch and never per-row full fetches', async () => {
    mockBenchmarkGetById.mockResolvedValue(makeBenchmark(5));
    mockTestCasesGetByIds.mockResolvedValue(makeTestCases(5));
    mockGetReportSummariesByIds.mockResolvedValue(makeSummaries(5, [1]));

    renderPage();

    await waitFor(() => expect(screen.getAllByTestId('test-case-row')).toHaveLength(5));

    expect(mockGetReportSummariesByIds).toHaveBeenCalledTimes(1);
    expect(mockGetReportSummariesByIds).toHaveBeenCalledWith(['rep-0', 'rep-1', 'rep-2', 'rep-3', 'rep-4']);

    // Row statuses come from the summaries.
    const rows = screen.getAllByTestId('test-case-row');
    expect(rows.filter(r => r.getAttribute('data-status') === 'failed')).toHaveLength(1);
    expect(rows.filter(r => r.getAttribute('data-status') === 'passed')).toHaveLength(4);

    // Bare load (no `?reportId=`): nothing is auto-selected, so no full
    // report fetch happens at all — verdict-first landing, not an
    // auto-opened first row.
    expect(mockGetReportById).not.toHaveBeenCalled();
    expect(screen.getByText(/Select a test case/i)).toBeTruthy();
  });

  // NOTE: an earlier draft of this branch added a regression test here
  // locking in "the inspector auto-selects the first case on load". That
  // assumption was superseded by the verdict-first run-report redesign
  // (#443, landed on main after this branch was cut): a bare run URL now
  // deliberately lands on the "Select a test case" overview pane rather
  // than auto-opening the first row (see the `initialSelectionDone`
  // comment in RunInspectorPage.tsx). The removed test asserted the
  // opposite of that intentional behavior and is dropped as stale scope
  // rather than reintroduced as a regression.

  it('falls back to execution status when the summary batch fails', async () => {
    mockBenchmarkGetById.mockResolvedValue(makeBenchmark(3));
    mockTestCasesGetByIds.mockResolvedValue(makeTestCases(3));
    mockGetReportSummariesByIds.mockRejectedValue(new Error('batch down'));

    renderPage();

    await waitFor(() => expect(screen.getAllByTestId('test-case-row')).toHaveLength(3));
    // completed + no report → pending_traces (per getResultStatus)
    for (const row of screen.getAllByTestId('test-case-row')) {
      expect(row.getAttribute('data-status')).toBe('pending_traces');
    }
  });

  it('windows the list at 100 rows and reveals more when the sentinel intersects', async () => {
    mockBenchmarkGetById.mockResolvedValue(makeBenchmark(120));
    mockTestCasesGetByIds.mockResolvedValue(makeTestCases(120));
    mockGetReportSummariesByIds.mockResolvedValue(makeSummaries(120));

    renderPage();

    await waitFor(() => expect(screen.getAllByTestId('test-case-row')).toHaveLength(100));
    expect(screen.getByTestId('test-case-list-sentinel')).toBeTruthy();

    // Header tallies count ALL 120 rows, not just the rendered window.
    expect(screen.getByText('120✓')).toBeTruthy();

    // Fire the sentinel's IntersectionObserver → remaining rows revealed.
    const sentinelObserver = ioInstances[ioInstances.length - 1];
    act(() => sentinelObserver.callback([{ isIntersecting: true }]));

    await waitFor(() => expect(screen.getAllByTestId('test-case-row')).toHaveLength(120));
    expect(screen.queryByTestId('test-case-list-sentinel')).toBeNull();
  });

  it('reveals a deep-linked ?reportId row beyond the first window', async () => {
    mockSearchParams = new URLSearchParams('reportId=rep-110');
    mockBenchmarkGetById.mockResolvedValue(makeBenchmark(120));
    mockTestCasesGetByIds.mockResolvedValue(makeTestCases(120));
    mockGetReportSummariesByIds.mockResolvedValue(makeSummaries(120));

    renderPage();

    // Row 110 is beyond the 100-row window; the deep link bumps the window.
    await waitFor(() => expect(screen.getAllByTestId('test-case-row')).toHaveLength(120));
    await waitFor(() => expect(mockGetReportById).toHaveBeenCalledWith('rep-110'));
  });

  it('shows error + Retry instead of an infinite skeleton, and Retry recovers', async () => {
    mockBenchmarkGetById.mockRejectedValueOnce(new Error('server restarting'));
    mockBenchmarkGetById.mockResolvedValue(makeBenchmark(2));
    mockTestCasesGetByIds.mockResolvedValue(makeTestCases(2));
    mockGetReportSummariesByIds.mockResolvedValue(makeSummaries(2));

    renderPage();

    await waitFor(() => expect(screen.getByTestId('run-inspector-error')).toBeTruthy());
    expect(screen.queryByTestId('skeleton')).toBeNull();

    fireEvent.click(screen.getByText('Retry'));

    await waitFor(() => expect(screen.getAllByTestId('test-case-row')).toHaveLength(2));
    expect(screen.queryByTestId('run-inspector-error')).toBeNull();
  });

  it('shows error + Retry even when the failure happens AFTER the run loaded', async () => {
    // benchmark + run resolve fine, but the test-cases fetch throws — the
    // error UI must still be reachable (previously only pre-`run` failures
    // reached it; post-`run` failures rendered a broken page with no retry).
    mockBenchmarkGetById.mockResolvedValue(makeBenchmark(2));
    mockTestCasesGetByIds.mockRejectedValueOnce(new Error('tc fetch down'));
    mockTestCasesGetByIds.mockResolvedValue(makeTestCases(2));
    mockGetReportSummariesByIds.mockResolvedValue(makeSummaries(2));

    renderPage();

    await waitFor(() => expect(screen.getByTestId('run-inspector-error')).toBeTruthy());

    fireEvent.click(screen.getByText('Retry'));

    await waitFor(() => expect(screen.getAllByTestId('test-case-row')).toHaveLength(2));
  });

  it('resets selection and window when navigating to a different run', async () => {
    mockBenchmarkGetById.mockResolvedValue(makeBenchmark(120));
    mockTestCasesGetByIds.mockResolvedValue(makeTestCases(120));
    mockGetReportSummariesByIds.mockResolvedValue(makeSummaries(120));

    const { rerender } = renderPage();
    await waitFor(() => expect(screen.getAllByTestId('test-case-row')).toHaveLength(100));

    // Grow the window, then navigate to run-2 (same component instance).
    act(() => ioInstances[ioInstances.length - 1].callback([{ isIntersecting: true }]));
    await waitFor(() => expect(screen.getAllByTestId('test-case-row')).toHaveLength(120));

    mockParams = { benchmarkId: 'bench-1', runId: 'run-2' };
    const bm2 = makeBenchmark(120);
    bm2.runs[0].id = 'run-2';
    mockBenchmarkGetById.mockResolvedValue(bm2);
    mockGetReportById.mockClear();
    rerender(React.createElement(RunInspectorPage));

    // Window resets to the first page for the new run.
    await waitFor(() => expect(screen.getAllByTestId('test-case-row')).toHaveLength(100));
    // Selection is cleared (verdict-first landing) rather than re-auto-selecting
    // the new run's first row.
    await waitFor(() => expect(screen.getByText(/Select a test case/i)).toBeTruthy());
    expect(mockGetReportById).not.toHaveBeenCalled();
  });

  it('fans out trace-polling recovery for pending rows using the summary report', async () => {
    mockBenchmarkGetById.mockResolvedValue(makeBenchmark(2));
    mockTestCasesGetByIds.mockResolvedValue(makeTestCases(2));
    mockGetReportSummariesByIds.mockResolvedValue({
      'rep-0': { id: 'rep-0', status: 'completed', passFailStatus: undefined, metricsStatus: 'pending', runId: 'otel-0', trajectory: [] },
      'rep-1': { id: 'rep-1', status: 'completed', passFailStatus: 'passed', metricsStatus: 'ready', trajectory: [] },
    });

    renderPage();

    await waitFor(() => expect(screen.getAllByTestId('test-case-row')).toHaveLength(2));
    await waitFor(() => expect(mockEnsurePolling).toHaveBeenCalledTimes(1));
    expect(mockEnsurePolling.mock.calls[0][0]).toEqual(expect.objectContaining({ id: 'rep-0', metricsStatus: 'pending' }));
  });
});

describe('RunInspectorPage — eval-source lazy fetch (summary bulk load + full fetch on selection)', () => {
  it('bulk-loads test cases as a SUMMARY (no sourceCode) to avoid duplicating shared eval-file source across every row', async () => {
    mockBenchmarkGetById.mockResolvedValue(makeBenchmark(3));
    mockTestCasesGetByIds.mockResolvedValue(makeTestCases(3));
    mockGetReportSummariesByIds.mockResolvedValue(makeSummaries(3));

    renderPage();

    await waitFor(() => expect(screen.getAllByTestId('test-case-row')).toHaveLength(3));
    expect(mockTestCasesGetByIds).toHaveBeenCalledWith(
      expect.arrayContaining(['tc-0', 'tc-1', 'tc-2']),
      { summary: true }
    );
  });

  it('lazily fetches the FULL test case (with sourceCode) for the selected row only', async () => {
    mockBenchmarkGetById.mockResolvedValue(makeBenchmark(2));
    mockTestCasesGetByIds.mockResolvedValue(makeTestCases(2)); // summary shape -- no sourceCode
    mockGetReportSummariesByIds.mockResolvedValue(makeSummaries(2));
    mockTestCaseGetById.mockResolvedValue({
      id: 'tc-1',
      name: 'Case 1',
      sourceFile: 'evals/foo.eval.ts',
      sourceCode: "test('a', () => {});",
    });

    renderPage();
    await waitFor(() => expect(screen.getAllByTestId('test-case-row')).toHaveLength(2));

    fireEvent.click(screen.getAllByTestId('test-case-row')[1]);

    await waitFor(() => expect(mockTestCaseGetById).toHaveBeenCalledWith('tc-1'));
  });

  it('does not fetch a full test case when nothing is selected', async () => {
    mockBenchmarkGetById.mockResolvedValue(makeBenchmark(2));
    mockTestCasesGetByIds.mockResolvedValue(makeTestCases(2));
    mockGetReportSummariesByIds.mockResolvedValue(makeSummaries(2));

    renderPage();
    await waitFor(() => expect(screen.getAllByTestId('test-case-row')).toHaveLength(2));

    // Auto-selection of the first row is existing behavior for benchmark-run
    // mode elsewhere in this suite; guard here is just that we never call
    // getById with an empty/undefined id.
    expect(mockTestCaseGetById).not.toHaveBeenCalledWith(undefined);
    expect(mockTestCaseGetById).not.toHaveBeenCalledWith(null);
  });
});

describe('RunInspectorPage — Re-run button (eval-run mode)', () => {
  beforeEach(() => {
    // Switch to eval-run mode (no benchmarkId)
    mockParams = { benchmarkId: undefined, runId: 'eval-run-1' };
  });

  it('renders Re-run button for eval-run mode', async () => {
    const { getEvaluationRun } = require('@/services/client');
    getEvaluationRun.mockResolvedValue({
      id: 'eval-run-1',
      docType: 'evaluation-run',
      name: 'Test Run',
      agentKey: 'demo',
      modelId: 'model-1',
      createdAt: '2024-01-01T00:00:00Z',
      status: 'completed',
      sources: [],
      trigger: 'ui',
      testCaseSnapshots: [],
      results: {},
    });

    mockTestCasesGetByIds.mockResolvedValue([]);
    mockGetReportSummariesByIds.mockResolvedValue({});

    renderPage();

    await waitFor(() => expect(rerunItem()).toBeTruthy());
    expect((rerunItem()).disabled).toBe(false);
  });

  it('opens re-run dialog when Re-run button clicked', async () => {
    const { getEvaluationRun } = require('@/services/client');
    getEvaluationRun.mockResolvedValue({
      id: 'eval-run-1',
      docType: 'evaluation-run',
      name: 'Test Run',
      agentKey: 'demo',
      modelId: 'model-1',
      createdAt: '2024-01-01T00:00:00Z',
      status: 'completed',
      sources: [],
      trigger: 'ui',
      testCaseSnapshots: [],
      results: {},
    });

    mockTestCasesGetByIds.mockResolvedValue([]);
    mockGetReportSummariesByIds.mockResolvedValue({});

    renderPage();

    await waitFor(() => expect(rerunItem()).toBeTruthy());

    fireEvent.click(rerunItem());

    await waitFor(() => expect(screen.getByTestId('run-config-dialog')).toBeTruthy());
  });

  it('renders provenance chip when rerunOf is present', async () => {
    const { getEvaluationRun } = require('@/services/client');
    const sourceRun = {
      id: 'eval-run-0',
      name: 'Original Run',
    };
    getEvaluationRun
      .mockResolvedValueOnce({
        id: 'eval-run-1',
        docType: 'evaluation-run',
        name: 'Test Run (re-run)',
        agentKey: 'demo',
        modelId: 'model-1',
        createdAt: '2024-01-01T00:00:00Z',
        status: 'completed',
        sources: [],
        trigger: 'ui',
        testCaseSnapshots: [],
        results: {},
        rerunOf: 'eval-run-0',
      })
      .mockResolvedValueOnce(sourceRun);

    mockTestCasesGetByIds.mockResolvedValue([]);
    mockGetReportSummariesByIds.mockResolvedValue({});

    renderPage();

    await waitFor(() => expect(screen.getByTestId('rerun-provenance-chip')).toBeTruthy());
    await waitFor(() => expect(screen.getByText(/re-run of Original Run/)).toBeTruthy());
  });

  // Papercut #2: a long source-run name used to blow the pill onto multiple
  // lines and crowd the title above it. The chip must stay single-line
  // (truncated label, bounded width) and the full source name must only
  // ever show up in a tooltip -- never forcing a taller header.
  it('keeps the re-run chip single-line and truncated, with the full source name only in the tooltip', async () => {
    const { getEvaluationRun } = require('@/services/client');
    const LONG_SOURCE_NAME = 'Regression sweep across the full staging benchmark with trajectory capture and judge validation enabled end to end';
    getEvaluationRun
      .mockResolvedValueOnce({
        id: 'eval-run-1',
        docType: 'evaluation-run',
        name: 'Claude…',
        agentKey: 'demo',
        modelId: 'model-1',
        createdAt: '2024-01-01T00:00:00Z',
        status: 'completed',
        sources: [],
        trigger: 'ui',
        testCaseSnapshots: [],
        results: {},
        rerunOf: 'eval-run-0',
      })
      .mockResolvedValueOnce({ id: 'eval-run-0', name: LONG_SOURCE_NAME });

    mockTestCasesGetByIds.mockResolvedValue([]);
    mockGetReportSummariesByIds.mockResolvedValue({});

    renderPage();

    const chip = await screen.findByTestId('rerun-provenance-chip');
    // Single-line, bounded width: `truncate` + a max-width class on the
    // chip itself, not left to grow (and wrap) with the source name length.
    expect(chip.className).toMatch(/max-w-\[\d+px\]/);
    // The visible label lives on an inner span that truncates on overflow --
    // the CHIP truncates, not the run title. The source-run-name fetch
    // resolves asynchronously, so wait for it to land in the label.
    await waitFor(() => expect(chip.querySelector('span')?.textContent).toContain(LONG_SOURCE_NAME));
    const label = chip.querySelector('span');
    expect(label?.className).toMatch(/truncate/);
    // The full source name is only reachable via the tooltip.
    expect(chip.getAttribute('title')).toContain(LONG_SOURCE_NAME);

    // The rename field (the run's own title) keeps its `truncate` class and
    // gets its own tooltip with the full (untruncated) name -- the chip
    // does not eat into its space.
    const titleText = screen.getByTestId('run-inspector-rename-text');
    expect(titleText.className).toMatch(/truncate/);
    expect(titleText.getAttribute('title')).toBe('Claude…');
  });

  it('shows missing-source style when rerunOf source run no longer exists', async () => {
    const { getEvaluationRun } = require('@/services/client');
    getEvaluationRun
      .mockResolvedValueOnce({
        id: 'eval-run-1',
        docType: 'evaluation-run',
        name: 'Test Run (re-run)',
        agentKey: 'demo',
        modelId: 'model-1',
        createdAt: '2024-01-01T00:00:00Z',
        status: 'completed',
        sources: [],
        trigger: 'ui',
        testCaseSnapshots: [],
        results: {},
        rerunOf: 'eval-run-0',
      })
      .mockRejectedValueOnce(new Error('Run not found'));

    mockTestCasesGetByIds.mockResolvedValue([]);
    mockGetReportSummariesByIds.mockResolvedValue({});

    renderPage();

    await waitFor(() => expect(screen.getByTestId('rerun-provenance-chip')).toBeTruthy());
    const chip = screen.getByTestId('rerun-provenance-chip');
    // Chip should have muted styling when source is missing
    await waitFor(() => expect(chip.className).toMatch(/border-muted-foreground|bg-muted/));
  });
});

describe('RunInspectorPage — benchmark-mode fallback for not-yet-linked runs', () => {
  const originalFetch = (globalThis as any).fetch;
  afterEach(() => {
    // These tests stub `global.fetch` directly (the fallback path fetches
    // /api/storage/evaluation-runs/:id inline rather than through the
    // shared getEvaluationRun() helper, so status codes stay distinguishable
    // — see codex_review finding on conflating 404 with other failures).
    // Restore afterwards so later tests/files never inherit this stub.
    (globalThis as any).fetch = originalFetch;
  });

  // Regression coverage for the "Claude Code run row not clickable" bug:
  // benchmark.runs[] only gets an entry once a run-first evaluation-run
  // completes (linkCompletedRunToBenchmark runs at completion, not create
  // time), so a still-`running` run is absent from bm.runs even though it
  // already exists as a standalone evaluation-run document AND is already
  // shown as a row on the runs list page (which unions both sources). The
  // inspector page used to `navigate()` straight back to the runs list the
  // instant `bm.runs.find(...)` came up empty — from the user's
  // perspective, clicking the row did nothing.

  function makeStandaloneEvalRun(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: 'run-not-embedded',
      docType: 'evaluation-run',
      name: 'ClaudeCode-WithTraces-001',
      agentKey: 'cc-os-rag-stark-retail',
      modelId: 'us.anthropic.claude-sonnet-4-6',
      createdAt: '2024-01-01T00:00:00Z',
      status: 'running',
      sources: [{ type: 'benchmark', benchmarkId: 'bench-1' }],
      trigger: 'ui',
      benchmarkId: 'bench-1',
      testCaseSnapshots: [{ id: 'tc-0', version: 1, name: 'Case 0' }],
      results: { 'tc-0': { reportId: 'rep-0', status: 'running' } },
      ...overrides,
    };
  }

  it('falls back to the standalone evaluation-run document when the run is missing from benchmark.runs[], instead of bouncing to the runs list', async () => {
    mockParams = { benchmarkId: 'bench-1', runId: 'run-not-embedded' };
    // benchmark.runs[] does NOT contain this run id — it's still running.
    mockBenchmarkGetById.mockResolvedValue({ id: 'bench-1', name: 'Bench', testCaseIds: ['tc-0'], runs: [] });
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => makeStandaloneEvalRun(),
    });
    (globalThis as any).fetch = fetchMock;
    mockTestCasesGetByIds.mockResolvedValue([{ id: 'tc-0', name: 'Case 0' }]);
    mockGetReportSummariesByIds.mockResolvedValue({
      'rep-0': { id: 'rep-0', status: 'running', metricsStatus: 'pending', trajectory: [] },
    });

    renderPage();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/storage/evaluation-runs/run-not-embedded'));
    await waitFor(() => expect(screen.getAllByTestId('test-case-row')).toHaveLength(1));

    // The old silent-bounce behavior must NOT fire.
    expect(mockNavigate).not.toHaveBeenCalledWith('/evaluations/benchmarks/bench-1/runs');
    expect(screen.queryByTestId('run-inspector-not-found')).toBeNull();
    expect(screen.getByText('ClaudeCode-WithTraces-001')).toBeTruthy();

    // Re-run capability is keyed on isEvaluationRun(run) (a doc concern,
    // not a route concern) after the #466 predicate unification -- this
    // fallback-loaded run genuinely IS a first-class EvaluationRun doc, so
    // Re-run is correctly ENABLED here, consistent with the eval-run-mode
    // and benchmark-mode-with-embedded-doc cases covered elsewhere in this
    // file. (Superseded expectation: this run used to stay artificially
    // disabled because Re-run was gated on route `mode` instead of the
    // run's actual doc type.)
    const rerunBtn = rerunItem();
    expect(rerunBtn.disabled).toBe(false);
  });

  it('rejects a standalone run that exists but is NOT associated with this benchmark (cross-benchmark data must never render) — codex_review finding', async () => {
    mockParams = { benchmarkId: 'bench-1', runId: 'belongs-to-other-benchmark' };
    mockBenchmarkGetById.mockResolvedValue({ id: 'bench-1', name: 'Bench', testCaseIds: [], runs: [] });
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      // A real, fetchable standalone run — but tied to a DIFFERENT benchmark.
      json: async () => makeStandaloneEvalRun({ benchmarkId: 'bench-OTHER', sources: [{ type: 'benchmark', benchmarkId: 'bench-OTHER' }] }),
    });
    (globalThis as any).fetch = fetchMock;

    renderPage();

    await waitFor(() => expect(screen.getByTestId('run-inspector-not-found')).toBeTruthy());
    // Never renders the other benchmark's run data under this URL.
    expect(screen.queryByText('ClaudeCode-WithTraces-001')).toBeNull();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('treats a non-404 fallback failure (transient 500/network error) as a load error with Retry, NOT as "not found" — codex_review finding', async () => {
    mockParams = { benchmarkId: 'bench-1', runId: 'run-not-embedded' };
    mockBenchmarkGetById.mockResolvedValue({ id: 'bench-1', name: 'Bench', testCaseIds: [], runs: [] });
    const fetchMock = jest.fn().mockResolvedValue({ ok: false, status: 500, statusText: 'Internal Server Error' });
    (globalThis as any).fetch = fetchMock;

    renderPage();

    await waitFor(() => expect(screen.getByTestId('run-inspector-error')).toBeTruthy());
    expect(screen.queryByTestId('run-inspector-not-found')).toBeNull();
  });

  it('renders an explicit not-found state (not a silent bounce) when the run is missing from BOTH benchmark.runs[] and the standalone evaluation-run store', async () => {
    mockParams = { benchmarkId: 'bench-1', runId: 'truly-gone' };
    mockBenchmarkGetById.mockResolvedValue({ id: 'bench-1', name: 'Bench', testCaseIds: [], runs: [] });
    const fetchMock = jest.fn().mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' });
    (globalThis as any).fetch = fetchMock;

    renderPage();

    await waitFor(() => expect(screen.getByTestId('run-inspector-not-found')).toBeTruthy());
    expect(screen.getByText(/truly-gone/)).toBeTruthy();
    // No silent navigate away — the user gets an explicit reason and an
    // explicit way back, not an invisible redirect.
    expect(mockNavigate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Back to runs'));
    expect(mockNavigate).toHaveBeenCalledWith('/evaluations/benchmarks/bench-1/runs');
  });
});

describe('RunInspectorPage — Re-run button (benchmark mode)', () => {
  beforeEach(() => {
    mockParams = { benchmarkId: 'bench-1', runId: 'run-1' };
    const { getEvaluationRun } = require('@/services/client');
    // Default: no first-class doc exists for this run id (true legacy
    // BenchmarkRun, pre-#399) -- loadData() must fall back to the embedded
    // projection, not get stuck. Individual tests override this to
    // simulate a dual-written evaluation-run.
    const notFound = Object.assign(new Error('not found'), { status: 404 });
    getEvaluationRun.mockReset().mockRejectedValue(notFound);
  });

  it('logs a warning (but still falls back to the embedded projection) when the first-class fetch fails with a non-404 error', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { getEvaluationRun } = require('@/services/client');
    const serverError = Object.assign(new Error('Internal Server Error'), { status: 500 });
    getEvaluationRun.mockReset().mockRejectedValue(serverError);
    mockBenchmarkGetById.mockResolvedValue(makeBenchmark(2));
    mockTestCasesGetByIds.mockResolvedValue(makeTestCases(2));
    mockGetReportSummariesByIds.mockResolvedValue(makeSummaries(2));

    renderPage();

    await waitFor(() => expect(screen.getAllByTestId('test-case-row').length).toBeGreaterThan(0));
    expect((rerunItem()).disabled).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('disables Re-run button for a true benchmark-embedded run (no first-class doc)', async () => {
    mockBenchmarkGetById.mockResolvedValue(makeBenchmark(2));
    mockTestCasesGetByIds.mockResolvedValue(makeTestCases(2));
    mockGetReportSummariesByIds.mockResolvedValue(makeSummaries(2));

    renderPage();

    await waitFor(() => expect(screen.getAllByTestId('test-case-row').length).toBeGreaterThan(0));

    const rerunBtn = rerunItem();
    expect(rerunBtn.disabled).toBe(true);
    expect(rerunBtn.getAttribute('title')).toBe(
      "Re-run isn't available for legacy benchmark-embedded runs"
    );
    expect(screen.queryByTestId('rerun-provenance-chip')).toBeNull();
  });
})

/*
 * Retry judgement (#462) is keyed on `run.docType === 'evaluation-run'`
 * rather than route `mode` — same bug class as the Re-run button fix
 * (goyamegh/rerun-idspace-fix): an evaluation-run doc created WITH a
 * benchmarkId is dual-written (first-class `evaluation-runs` doc +
 * legacy-shaped BenchmarkRun projection embedded in `benchmark.runs[]`),
 * so it can be viewed from EITHER the eval-run route or the
 * benchmark-scoped route (/evaluations/benchmarks/<id>/runs/<runId>/inspect).
 * `mode` alone (derived purely from the URL's benchmarkId param) can't
 * tell those two doc shapes apart. `loadData()`'s benchmark branch now
 * best-effort-fetches the first-class doc via `getEvaluationRun` and
 * prefers it when found, falling back to the embedded projection for
 * true legacy BenchmarkRun-only runs (pre-#399, no first-class doc).
 *
 * Test matrix:
 * - eval-run via eval route            -> Retry judgement enabled
 * - eval-run via benchmark route       -> Retry judgement enabled (was broken — the fix)
 * - benchmark-run via benchmark route  -> Retry judgement absent (no judge-failed cases to salvage on a doc-less legacy run)
 */
describe('RunInspectorPage — Retry judgement button (docType-keyed, not route-mode-keyed)', () => {
  it('renders "Retry judgement (N)" for an eval-run via the EVAL route', async () => {
    mockParams = { benchmarkId: undefined, runId: 'eval-run-1' };
    const { getEvaluationRun } = require('@/services/client');
    getEvaluationRun.mockResolvedValue(makeEvaluationRunFixture('eval-run-1', 3, [1]));
    mockTestCasesGetByIds.mockResolvedValue(makeTestCases(3));
    mockGetReportSummariesByIds.mockResolvedValue(makeErroredSummaries(3, [1]));

    renderPage();

    await waitFor(() => expect(retryJudgementItem()).toBeTruthy());
    const btn = retryJudgementItem();
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toContain('Retry judgement (1)');
  });

  it('renders "Retry judgement (N)" for the SAME eval-run doc via the BENCHMARK route (regression: was broken pre-fix)', async () => {
    // Benchmark-scoped route: benchmarkId present in the URL params.
    mockParams = { benchmarkId: 'bench-1', runId: 'run-1' };
    // Legacy embedded projection still exists in benchmark.runs[] (no
    // docType) — loadData must prefer the first-class doc below, not this.
    mockBenchmarkGetById.mockResolvedValue(makeBenchmark(3));
    const { getEvaluationRun } = require('@/services/client');
    getEvaluationRun.mockResolvedValue(makeEvaluationRunFixture('run-1', 3, [0, 2]));
    mockTestCasesGetByIds.mockResolvedValue(makeTestCases(3));
    mockGetReportSummariesByIds.mockResolvedValue(makeErroredSummaries(3, [0, 2]));

    renderPage();

    await waitFor(() => expect(retryJudgementItem()).toBeTruthy());
    const btn = retryJudgementItem();
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toContain('Retry judgement (2)');
  });

  it('opens the Retry judgement dialog and refreshes the run on completion, via the BENCHMARK route', async () => {
    mockParams = { benchmarkId: 'bench-1', runId: 'run-1' };
    mockBenchmarkGetById.mockResolvedValue(makeBenchmark(3));
    const { getEvaluationRun } = require('@/services/client');
    getEvaluationRun.mockResolvedValue(makeEvaluationRunFixture('run-1', 3, [0]));
    mockTestCasesGetByIds.mockResolvedValue(makeTestCases(3));
    mockGetReportSummariesByIds.mockResolvedValue(makeErroredSummaries(3, [0]));

    renderPage();

    await waitFor(() => expect(retryJudgementItem()).toBeTruthy());
    fireEvent.click(retryJudgementItem());

    await waitFor(() => expect(screen.getByTestId('retry-judgement-confirm-dialog')).toBeTruthy());
    expect(screen.getByTestId('retry-judgement-confirm-dialog').textContent).toContain('run-1');

    // The mocked dialog calls onComplete then onOpenChange(false) on click,
    // which the real RunInspectorPage wires to `loadData()` — assert it
    // re-fetches (getEvaluationRun called again) rather than going stale.
    const callsBefore = getEvaluationRun.mock.calls.length;
    fireEvent.click(screen.getByTestId('retry-judgement-confirm-dialog'));

    await waitFor(() => expect(getEvaluationRun.mock.calls.length).toBeGreaterThan(callsBefore));
  });

  it('renders Retry judgement DISABLED (with the legacy-run reason) for a true legacy BenchmarkRun (no first-class doc) via the BENCHMARK route', async () => {
    mockParams = { benchmarkId: 'bench-1', runId: 'run-1' };
    mockBenchmarkGetById.mockResolvedValue(makeBenchmark(2));
    // Default beforeEach already rejects getEvaluationRun ("not found") —
    // simulates a run that only ever exists as an embedded BenchmarkRun.
    mockTestCasesGetByIds.mockResolvedValue(makeTestCases(2));
    mockGetReportSummariesByIds.mockResolvedValue(makeSummaries(2));

    renderPage();

    await waitFor(() => expect(screen.getAllByTestId('test-case-row').length).toBeGreaterThan(0));
    const item = retryJudgementItem();
    expect(item.disabled).toBe(true);
    expect(item.getAttribute('title')).toBe("Retry judgement isn't available for legacy benchmark-embedded runs");
    expect(item.textContent).toContain('Retry judgement (0)');
  });
});

/*
 * Re-run an evaluation run (duplicate config, provenance link) — keyed on
 * `isEvaluationRun(run)` like Retry judgement. Same dual-write seam: a
 * first-class EvaluationRun doc can be reached via either the eval route
 * (direct) or the benchmark-scoped route (via the benchmark's embedded
 * projection). loadData() must prefer the first-class doc so isEvaluationRun()
 * is true on both routes, and Re-run affordances work consistently.
 */
describe('RunInspectorPage — Re-run button (isEvaluationRun-keyed)', () => {
  // Regression matrix for the route-vs-doc-type bug: RunInspectorPage serves
  // both /evaluations/benchmarks/:benchmarkId/runs/:runId/inspect (mode
  // 'benchmark') and /evaluations/runs/:runId/inspect (mode 'evalRun'), but
  // since #399 a run created WITH a benchmarkId is dual-written as BOTH an
  // embedded BenchmarkRun projection (benchmark.runs[], no docType) AND a
  // first-class EvaluationRun doc (docType: 'evaluation-run') -- so `mode`
  // alone cannot tell you whether the run supports EvaluationRun-only
  // capabilities (rerun, provenance). isEvaluationRun(run) is the fix;
  // loadData() must also prefer the first-class doc on the benchmark route
  // for that predicate to ever be true there. Cells:
  //   route scope   x   run docType            x   load state
  //   eval route    x   evaluation-run         x   loaded          -> covered above
  //   benchmark rt  x   true benchmark-run     x   loaded (404 on first-class fetch) -> below
  //   benchmark rt  x   evaluation-run (dual)  x   loaded (first-class fetch succeeds) -> below (was broken)
  //   benchmark rt  x   evaluation-run (dual)  x   first-class fetch resolves falsy (test-double edge case) -> below
  const evalRunFixture = (overrides: Record<string, unknown> = {}) => ({
    id: 'run-1',
    docType: 'evaluation-run',
    name: 'Run 1',
    agentKey: 'demo',
    modelId: 'model-1',
    createdAt: '2024-01-01T00:00:00Z',
    status: 'completed',
    sources: [],
    trigger: 'ui',
    testCaseSnapshots: [],
    results: { 'tc-0': { reportId: 'rep-0', status: 'completed' }, 'tc-1': { reportId: 'rep-1', status: 'completed' } },
    ...overrides,
  });

  it('disables Re-run for a legacy BenchmarkRun (no docType) via the benchmark-scoped route', async () => {
    mockParams = { benchmarkId: 'bench-1', runId: 'run-1' };
    mockBenchmarkGetById.mockResolvedValue(makeBenchmark(2));
    mockTestCasesGetByIds.mockResolvedValue(makeTestCases(2));
    mockGetReportSummariesByIds.mockResolvedValue(makeSummaries(2));

    renderPage();

    await waitFor(() => expect(screen.getAllByTestId('test-case-row').length).toBeGreaterThan(0));
    expect((rerunItem()).disabled).toBe(true);
    expect(screen.queryByTestId('rerun-provenance-chip')).toBeNull();
  });

  it('enables Re-run for a dual-written evaluation-run reached via the benchmark-scoped route (regression -- was broken)', async () => {
    // Benchmark still resolves the LEGACY embedded projection here (real
    // shape: no docType) -- the fix must come from loadData() preferring
    // the first-class doc, not from the benchmark fixture itself.
    mockBenchmarkGetById.mockResolvedValue(makeBenchmark(2));
    const { getEvaluationRun } = require('@/services/client');
    getEvaluationRun.mockReset().mockResolvedValue(evalRunFixture());
    mockTestCasesGetByIds.mockResolvedValue(makeTestCases(2));
    mockGetReportSummariesByIds.mockResolvedValue(makeSummaries(2));

    renderPage();

    await waitFor(() => expect(screen.getAllByTestId('test-case-row').length).toBeGreaterThan(0));
    expect((rerunItem()).disabled).toBe(false);
  });

  it('shows the provenance chip for a dual-written evaluation-run reached via the benchmark-scoped route', async () => {
    mockBenchmarkGetById.mockResolvedValue(makeBenchmark(2));
    const { getEvaluationRun } = require('@/services/client');
    getEvaluationRun.mockReset()
      .mockResolvedValueOnce(evalRunFixture({ rerunOf: 'eval-run-0' }))
      .mockResolvedValueOnce({ id: 'eval-run-0', name: 'Original Run' });
    mockTestCasesGetByIds.mockResolvedValue(makeTestCases(2));
    mockGetReportSummariesByIds.mockResolvedValue(makeSummaries(2));

    renderPage();

    await waitFor(() => expect(screen.getByTestId('rerun-provenance-chip')).toBeTruthy());
    await waitFor(() => expect(screen.getByText(/re-run of Original Run/)).toBeTruthy());

    fireEvent.click(screen.getByTestId('rerun-provenance-chip'));
    expect(mockNavigate).toHaveBeenCalledWith('/evaluations/runs/eval-run-0');
  });

  it('opens the Re-run confirm dialog for a dual-written evaluation-run reached via the benchmark-scoped route', async () => {
    mockBenchmarkGetById.mockResolvedValue(makeBenchmark(2));
    const { getEvaluationRun } = require('@/services/client');
    getEvaluationRun.mockReset().mockResolvedValue(evalRunFixture());
    mockTestCasesGetByIds.mockResolvedValue(makeTestCases(2));
    mockGetReportSummariesByIds.mockResolvedValue(makeSummaries(2));

    renderPage();

    await waitFor(() => expect((rerunItem()).disabled).toBe(false));
    fireEvent.click(rerunItem());

    await waitFor(() => expect(screen.getByTestId('run-config-dialog')).toBeTruthy());
  });
});


describe('RunInspectorPage — inline rename (eval-run mode only)', () => {
  it('renders the title as plain text (no rename pencil) in benchmark mode', async () => {
    mockParams = { benchmarkId: 'bench-1', runId: 'run-1' };
    mockBenchmarkGetById.mockResolvedValue(makeBenchmark(1));
    mockTestCasesGetByIds.mockResolvedValue(makeTestCases(1));
    mockGetReportSummariesByIds.mockResolvedValue(makeSummaries(1));

    renderPage();

    await waitFor(() => expect(screen.getByText('Run 1')).toBeTruthy());
    expect(screen.queryByTestId('run-inspector-rename-edit-btn')).toBeNull();
  });

  it('renders a rename pencil in eval-run mode and persists a rename via updateEvaluationRun', async () => {
    mockParams = { benchmarkId: undefined, runId: 'eval-run-1' };
    const { getEvaluationRun, updateEvaluationRun } = require('@/services/client');
    getEvaluationRun.mockResolvedValue({
      id: 'eval-run-1',
      docType: 'evaluation-run',
      name: 'Original Name',
      agentKey: 'demo',
      modelId: 'model-1',
      createdAt: '2024-01-01T00:00:00Z',
      status: 'completed',
      sources: [],
      trigger: 'ui',
      testCaseSnapshots: [],
      results: {},
    });
    updateEvaluationRun.mockResolvedValue({});

    mockTestCasesGetByIds.mockResolvedValue([]);
    mockGetReportSummariesByIds.mockResolvedValue({});

    renderPage();

    await waitFor(() => expect(screen.getByTestId('run-inspector-rename-edit-btn')).toBeTruthy());
    fireEvent.click(screen.getByTestId('run-inspector-rename-edit-btn'));

    const input = screen.getByTestId('run-inspector-rename-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Renamed via Inspector' } });
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }); });

    expect(updateEvaluationRun).toHaveBeenCalledWith('eval-run-1', { name: 'Renamed via Inspector' });
    await waitFor(() => expect(screen.getByText('Renamed via Inspector')).toBeTruthy());
  });

  it('reverts the header title and shows an error when the rename PATCH fails', async () => {
    mockParams = { benchmarkId: undefined, runId: 'eval-run-1' };
    const { getEvaluationRun, updateEvaluationRun } = require('@/services/client');
    getEvaluationRun.mockResolvedValue({
      id: 'eval-run-1',
      docType: 'evaluation-run',
      name: 'Original Name',
      agentKey: 'demo',
      modelId: 'model-1',
      createdAt: '2024-01-01T00:00:00Z',
      status: 'completed',
      sources: [],
      trigger: 'ui',
      testCaseSnapshots: [],
      results: {},
    });
    updateEvaluationRun.mockRejectedValue(new Error('name must be 200 characters or fewer'));

    mockTestCasesGetByIds.mockResolvedValue([]);
    mockGetReportSummariesByIds.mockResolvedValue({});

    renderPage();

    await waitFor(() => expect(screen.getByTestId('run-inspector-rename-edit-btn')).toBeTruthy());
    fireEvent.click(screen.getByTestId('run-inspector-rename-edit-btn'));

    const input = screen.getByTestId('run-inspector-rename-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'x'.repeat(201) } });
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }); });

    await waitFor(() => expect(screen.getByTestId('run-inspector-rename-error')).toBeTruthy());
    expect(screen.getByTestId('run-inspector-rename-error').textContent).toMatch(/200 characters or fewer/);
  });
});

/*
 * Header composition (owner papercut on PR #468): the standalone Re-run /
 * Retry judgement / Compare header buttons are gone; the "…" kebab is the
 * ONLY home for lifecycle actions, and it carries exactly four entries with
 * the gating the buttons used to have. Compare is not a lifecycle action
 * and is intentionally absent from the kebab (still reachable from the runs
 * list / compare nav).
 */
describe('RunInspectorPage — header actions live only in the kebab', () => {
  const headerButtonsAbsent = () => {
    expect(screen.queryByTestId('inspector-rerun-btn')).toBeNull();
    expect(screen.queryByTestId('inspector-retry-judgement-btn')).toBeNull();
    // Compare: no header button (text or icon) — only the kebab's items
    // render "menuitem" roles, and none of them is Compare.
    expect(screen.queryByRole('button', { name: /compare/i })).toBeNull();
    expect(screen.queryByText(/^Compare$/)).toBeNull();
  };

  const kebabHasExactlyFourKinds = (expectCancel: boolean) => {
    const items = screen.getAllByRole('menuitem');
    const kinds = items.map(el => (el.getAttribute('data-testid') || '').replace(/^run-action-/, '').replace(/-run-1$|-eval-run-1$/, ''));
    const expected = expectCancel
      ? ['rerun', 'cancel', 'retry-judgement', 'delete']
      : ['rerun', 'retry-judgement', 'delete'];
    expect(kinds).toEqual(expected);
    expect(kinds).not.toContain('compare');
  };

  it('RUNNING eval-run: Re-run enabled, Cancel present, Retry judgement disabled ("finished" reason), Delete present', async () => {
    mockParams = { runId: 'eval-run-1' };
    const { getEvaluationRun } = require('@/services/client');
    getEvaluationRun.mockResolvedValue({ ...makeEvaluationRunFixture('eval-run-1', 2, [0]), status: 'running' });
    mockTestCasesGetByIds.mockResolvedValue(makeTestCases(2));
    mockGetReportSummariesByIds.mockResolvedValue(makeErroredSummaries(2, [0]));

    renderPage();

    await waitFor(() => expect(rerunItem()).toBeTruthy());
    headerButtonsAbsent();
    kebabHasExactlyFourKinds(true);
    expect(rerunItem().disabled).toBe(false);
    expect(cancelItem()).not.toBeNull();
    expect(retryJudgementItem().disabled).toBe(true);
    expect(retryJudgementItem().getAttribute('title')).toBe('Retry judgement is only available once the run has finished');
    expect(retryJudgementItem().textContent).toContain('Retry judgement (1)');
    expect(deleteItem()).toBeTruthy();
    expect(screen.getByLabelText('Run actions')).toBeTruthy();
  });

  it('COMPLETED eval-run WITH judge failures: Re-run + Retry judgement (N) enabled, no Cancel', async () => {
    mockParams = { runId: 'eval-run-1' };
    const { getEvaluationRun } = require('@/services/client');
    getEvaluationRun.mockResolvedValue(makeEvaluationRunFixture('eval-run-1', 3, [0, 2]));
    mockTestCasesGetByIds.mockResolvedValue(makeTestCases(3));
    mockGetReportSummariesByIds.mockResolvedValue(makeErroredSummaries(3, [0, 2]));

    renderPage();

    await waitFor(() => expect(rerunItem()).toBeTruthy());
    headerButtonsAbsent();
    kebabHasExactlyFourKinds(false);
    expect(rerunItem().disabled).toBe(false);
    expect(cancelItem()).toBeNull();
    expect(retryJudgementItem().disabled).toBe(false);
    expect(retryJudgementItem().textContent).toContain('Retry judgement (2)');
  });

  it('COMPLETED eval-run, CLEAN: Retry judgement (0) disabled with the "no judge-failed" reason; Re-run enabled', async () => {
    mockParams = { runId: 'eval-run-1' };
    const { getEvaluationRun } = require('@/services/client');
    getEvaluationRun.mockResolvedValue(makeEvaluationRunFixture('eval-run-1', 2));
    mockTestCasesGetByIds.mockResolvedValue(makeTestCases(2));
    mockGetReportSummariesByIds.mockResolvedValue(makeSummaries(2));

    renderPage();

    await waitFor(() => expect(rerunItem()).toBeTruthy());
    headerButtonsAbsent();
    kebabHasExactlyFourKinds(false);
    expect(rerunItem().disabled).toBe(false);
    expect(cancelItem()).toBeNull();
    expect(retryJudgementItem().disabled).toBe(true);
    expect(retryJudgementItem().getAttribute('title')).toBe('No judge-failed cases to retry');
    expect(retryJudgementItem().textContent).toContain('Retry judgement (0)');
  });

  it('kebab Retry judgement opens the SAME RetryJudgementConfirmDialog with the count (one pipeline, not a second fire-and-forget path)', async () => {
    mockParams = { runId: 'eval-run-1' };
    const { getEvaluationRun } = require('@/services/client');
    getEvaluationRun.mockResolvedValue(makeEvaluationRunFixture('eval-run-1', 3, [1]));
    mockTestCasesGetByIds.mockResolvedValue(makeTestCases(3));
    mockGetReportSummariesByIds.mockResolvedValue(makeErroredSummaries(3, [1]));

    renderPage();

    await waitFor(() => expect(retryJudgementItem().disabled).toBe(false));
    fireEvent.click(retryJudgementItem());
    await waitFor(() => expect(screen.getByTestId('retry-judgement-confirm-dialog')).toBeTruthy());
    expect(screen.getByTestId('retry-judgement-confirm-dialog').textContent).toContain('(1)');
  });

  it('kebab Delete opens a confirm (no bare-click delete) — the destructive call is NOT made until confirmed', async () => {
    mockParams = { runId: 'eval-run-1' };
    const { getEvaluationRun } = require('@/services/client');
    getEvaluationRun.mockResolvedValue(makeEvaluationRunFixture('eval-run-1', 1));
    mockTestCasesGetByIds.mockResolvedValue(makeTestCases(1));
    mockGetReportSummariesByIds.mockResolvedValue(makeSummaries(1));

    renderPage();

    await waitFor(() => expect(deleteItem()).toBeTruthy());
    fireEvent.click(deleteItem());
    await waitFor(() => expect(screen.getByTestId('run-delete-confirm-eval-run-1')).toBeTruthy());
    const { deleteEvaluationRun } = require('@/services/client');
    expect(deleteEvaluationRun).not.toHaveBeenCalled();
  });
});

// Owner report: "the run doesn't get deleted when I go inside the run page
// and try it myself." On the benchmark-scoped inspector route the kebab's
// Delete dispatched on the ROUTE (benchmark → nested-run DELETE), but the
// run shown there is the first-class evaluation-run doc — usually NOT
// embedded in benchmark.runs[] — so that call 404ed, asyncBenchmarkStorage
// .deleteRun swallowed it as `false`, and the page navigated away with the
// run intact. Delete must dispatch on the RUN's kind.
describe('RunInspectorPage — kebab Delete dispatches on the run kind, not the route', () => {
  const confirmDelete = async (runId: string) => {
    await waitFor(() => expect(deleteItem()).toBeTruthy());
    fireEvent.click(deleteItem());
    await waitFor(() => expect(screen.getByTestId(`run-delete-confirm-btn-${runId}`)).toBeTruthy());
    fireEvent.click(screen.getByTestId(`run-delete-confirm-btn-${runId}`));
  };

  it('benchmark route + first-class evaluation-run doc → DELETE via the evaluation-runs API, then back to the benchmark runs list', async () => {
    mockParams = { benchmarkId: 'bench-1', runId: 'run-1' };
    mockBenchmarkGetById.mockResolvedValue(makeBenchmark(1));
    const { getEvaluationRun, deleteEvaluationRun } = require('@/services/client');
    getEvaluationRun.mockResolvedValue(makeEvaluationRunFixture('run-1', 1));
    deleteEvaluationRun.mockResolvedValue(true);
    mockTestCasesGetByIds.mockResolvedValue(makeTestCases(1));
    mockGetReportSummariesByIds.mockResolvedValue(makeSummaries(1));

    renderPage();
    await confirmDelete('run-1');

    await waitFor(() => expect(deleteEvaluationRun).toHaveBeenCalledWith('run-1'));
    expect(mockBenchmarkDeleteRun).not.toHaveBeenCalled();
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/evaluations/benchmarks/bench-1/runs'));
  });

  it('benchmark route + legacy embedded-only run (no doc) → the benchmark nested-run DELETE', async () => {
    mockParams = { benchmarkId: 'bench-1', runId: 'run-1' };
    mockBenchmarkGetById.mockResolvedValue(makeBenchmark(1));
    // getEvaluationRun rejects by default (beforeEach): no first-class doc.
    mockBenchmarkDeleteRun.mockResolvedValue(true);
    mockTestCasesGetByIds.mockResolvedValue(makeTestCases(1));
    mockGetReportSummariesByIds.mockResolvedValue(makeSummaries(1));

    renderPage();
    await confirmDelete('run-1');

    await waitFor(() => expect(mockBenchmarkDeleteRun).toHaveBeenCalledWith('bench-1', 'run-1'));
    const { deleteEvaluationRun } = require('@/services/client');
    expect(deleteEvaluationRun).not.toHaveBeenCalled();
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/evaluations/benchmarks/bench-1/runs'));
  });

  it('a swallowed failure (benchmark deleteRun → false) surfaces an error and does NOT navigate away', async () => {
    mockParams = { benchmarkId: 'bench-1', runId: 'run-1' };
    mockBenchmarkGetById.mockResolvedValue(makeBenchmark(1));
    mockBenchmarkDeleteRun.mockResolvedValue(false);
    mockTestCasesGetByIds.mockResolvedValue(makeTestCases(1));
    mockGetReportSummariesByIds.mockResolvedValue(makeSummaries(1));

    renderPage();
    await confirmDelete('run-1');

    await waitFor(() => expect(screen.getByTestId('run-action-error-run-1')).toBeTruthy());
    expect(mockNavigate).not.toHaveBeenCalledWith('/evaluations/benchmarks/bench-1/runs');
  });

  it('eval-run route → evaluation-runs API, then back to the runs list', async () => {
    mockParams = { runId: 'eval-run-1' };
    const { getEvaluationRun, deleteEvaluationRun } = require('@/services/client');
    getEvaluationRun.mockResolvedValue(makeEvaluationRunFixture('eval-run-1', 1));
    deleteEvaluationRun.mockResolvedValue(true);
    mockTestCasesGetByIds.mockResolvedValue(makeTestCases(1));
    mockGetReportSummariesByIds.mockResolvedValue(makeSummaries(1));

    renderPage();
    await confirmDelete('eval-run-1');

    await waitFor(() => expect(deleteEvaluationRun).toHaveBeenCalledWith('eval-run-1'));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/evaluations/runs'));
  });
});

describe('RunInspectorPage — telemetry strip (tokens · cost · LLM calls · tool calls · time/case · spans)', () => {
  it('requests metrics ONCE for the run\'s reports (keys = runId or report id, with hints) and renders the strip values', async () => {
    mockBenchmarkGetById.mockResolvedValue(makeBenchmark(2));
    mockTestCasesGetByIds.mockResolvedValue(makeTestCases(2));
    mockGetReportSummariesByIds.mockResolvedValue({
      'rep-0': { id: 'rep-0', status: 'completed', passFailStatus: 'passed', metricsStatus: 'ready', trajectory: [], runId: 'agent-run-0', sessionId: 'sess-0', connectorProtocol: 'claude-code', timestamp: '2024-01-01T00:00:00Z', performanceMetrics: { durationMs: 40_000, agentDurationMs: 1 } },
      'rep-1': { id: 'rep-1', status: 'completed', passFailStatus: 'failed', metricsStatus: 'ready', trajectory: [], connectorProtocol: 'rest', timestamp: '2024-01-01T00:01:00Z', performanceMetrics: { durationMs: 48_000, agentDurationMs: 1 } },
    });
    mockFetchBatchMetrics.mockResolvedValue({
      metrics: [
        { runId: 'agent-run-0', status: 'success', hasSpans: true, totalTokens: 3_000_000, costUsd: 10.10, llmCalls: 200, toolCalls: 70 },
        { runId: 'rep-1', status: 'success', hasSpans: true, totalTokens: 2_900_000, costUsd: 10.09, llmCalls: 112, toolCalls: 48 },
      ],
      aggregate: {},
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    renderPage();
    await waitFor(() => expect(mockFetchBatchMetrics).toHaveBeenCalledTimes(1));
    const [keys, sessionIds, , agents] = mockFetchBatchMetrics.mock.calls[0];
    expect(keys.sort()).toEqual(['agent-run-0', 'rep-1']);      // no runId → keyed by report id
    expect(sessionIds).toEqual({ 'agent-run-0': 'sess-0' });
    expect(agents['agent-run-0'][0]).toMatchObject({ serviceName: 'claude-code-agent', sessionId: 'sess-0' });

    await waitFor(() => expect(screen.getByTestId('run-telemetry-strip').getAttribute('data-state')).toBe('value'));
    expect(screen.getByTestId('strip-tokens').textContent).toBe('Tokens5.9M');
    expect(screen.getByTestId('strip-cost').textContent).toBe('Cost$20.19');
    expect(screen.getByTestId('strip-llmcalls').textContent).toBe('LLM calls312');
    expect(screen.getByTestId('strip-toolcalls').textContent).toBe('Tool calls118');
    expect(screen.getByTestId('strip-timepercase').textContent).toBe('Time/case44 s');
    expect(screen.getByTestId('strip-spans').textContent).toBe('spans: 2/2 cases');
    warn.mockRestore();
  });

  it('batch endpoint failure → strip reads "—" (Metrics unavailable) and the page still renders its rows', async () => {
    mockBenchmarkGetById.mockResolvedValue(makeBenchmark(2));
    mockTestCasesGetByIds.mockResolvedValue(makeTestCases(2));
    mockGetReportSummariesByIds.mockResolvedValue(makeSummaries(2));
    mockFetchBatchMetrics.mockRejectedValue(new Error('500'));
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    renderPage();
    await waitFor(() => expect(screen.getAllByTestId('test-case-row')).toHaveLength(2));
    await waitFor(() => expect(screen.getByTestId('run-telemetry-strip').getAttribute('data-state')).toBe('empty'));
    expect(screen.getByTestId('strip-tokens').getAttribute('title')).toBe('Metrics unavailable');
    expect(screen.queryByTestId('run-inspector-error')).toBeNull();
    // Retry is wired to the hook's refetch: one more request, then values.
    expect(mockFetchBatchMetrics).toHaveBeenCalledTimes(1);
    mockFetchBatchMetrics.mockResolvedValue({
      metrics: [
        { runId: 'rep-0', status: 'success', hasSpans: true, totalTokens: 10, costUsd: 0.01, llmCalls: 1, toolCalls: 0 },
        { runId: 'rep-1', status: 'success', hasSpans: true, totalTokens: 10, costUsd: 0.01, llmCalls: 1, toolCalls: 0 },
      ],
      aggregate: {},
    });
    fireEvent.click(screen.getByTestId('strip-retry'));
    await waitFor(() => expect(mockFetchBatchMetrics).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId('run-telemetry-strip').getAttribute('data-state')).toBe('value'));
    err.mockRestore();
  });
});
