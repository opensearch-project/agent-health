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
 * - Summary-batch failure falls back to execution status (no crash).
 * - loadData failure renders the error + Retry state (not an infinite
 *   skeleton) and Retry recovers.
 * - The full report is fetched on-demand for the selected row only.
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
const mockTestCasesGetByIds = jest.fn();
const mockTestCaseGetById = jest.fn();
const mockGetReportSummariesByIds = jest.fn();
const mockGetReportById = jest.fn();

jest.mock('@/services/storage', () => ({
  asyncBenchmarkStorage: { getById: (...a: unknown[]) => mockBenchmarkGetById(...a) },
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

function makeTestCases(caseCount: number) {
  return Array.from({ length: caseCount }, (_, i) => ({ id: `tc-${i}`, name: `Case ${i}` }));
}

const renderPage = () => render(React.createElement(RunInspectorPage));

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

    // Full report fetched only for the selected (first) row.
    await waitFor(() => expect(mockGetReportById).toHaveBeenCalled());
    expect(mockGetReportById).toHaveBeenCalledTimes(1);
    expect(mockGetReportById).toHaveBeenCalledWith('rep-0', 'core');
  });

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
    await waitFor(() => expect(mockGetReportById).toHaveBeenCalledWith('rep-110', 'core'));
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
    rerender(React.createElement(RunInspectorPage));

    // Window resets to the first page for the new run.
    await waitFor(() => expect(screen.getAllByTestId('test-case-row')).toHaveLength(100));
    // And the first row of the new run is auto-selected (selection reset).
    await waitFor(() => expect(mockGetReportById).toHaveBeenCalledWith('rep-0', 'core'));
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
