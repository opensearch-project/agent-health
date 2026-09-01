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
  updateEvaluationRun: jest.fn(),
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

jest.mock('@/components/evals3/RerunConfirmDialog', () => ({
  RerunConfirmDialog: ({ run, open, onOpenChange, onRerun }: any) => (
    open && run ? React.createElement(
      'div',
      { 'data-testid': 'rerun-confirm-dialog', onClick: () => onOpenChange(false) },
      `Dialog for ${run.id}`,
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

    // Full report fetched only for the selected (first) row.
    await waitFor(() => expect(mockGetReportById).toHaveBeenCalled());
    expect(mockGetReportById).toHaveBeenCalledTimes(1);
    expect(mockGetReportById).toHaveBeenCalledWith('rep-0');
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
    rerender(React.createElement(RunInspectorPage));

    // Window resets to the first page for the new run.
    await waitFor(() => expect(screen.getAllByTestId('test-case-row')).toHaveLength(100));
    // And the first row of the new run is auto-selected (selection reset).
    await waitFor(() => expect(mockGetReportById).toHaveBeenCalledWith('rep-0'));
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

    await waitFor(() => expect(screen.getByTestId('inspector-rerun-btn')).toBeTruthy());
    expect((screen.getByTestId('inspector-rerun-btn') as HTMLButtonElement).disabled).toBe(false);
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

    await waitFor(() => expect(screen.getByTestId('inspector-rerun-btn')).toBeTruthy());

    fireEvent.click(screen.getByTestId('inspector-rerun-btn'));

    await waitFor(() => expect(screen.getByTestId('rerun-confirm-dialog')).toBeTruthy());
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
    const rerunBtn = screen.getByTestId('inspector-rerun-btn') as HTMLButtonElement;
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
    expect((screen.getByTestId('inspector-rerun-btn') as HTMLButtonElement).disabled).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('disables Re-run button for a true benchmark-embedded run (no first-class doc)', async () => {
    mockBenchmarkGetById.mockResolvedValue(makeBenchmark(2));
    mockTestCasesGetByIds.mockResolvedValue(makeTestCases(2));
    mockGetReportSummariesByIds.mockResolvedValue(makeSummaries(2));

    renderPage();

    await waitFor(() => expect(screen.getAllByTestId('test-case-row').length).toBeGreaterThan(0));

    const rerunBtn = screen.getByTestId('inspector-rerun-btn') as HTMLButtonElement;
    expect(rerunBtn.disabled).toBe(true);
    expect(rerunBtn.parentElement?.getAttribute('title')).toBe(
      'Re-run is only available for evaluation runs, not benchmark-embedded runs'
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

    await waitFor(() => expect(screen.getByTestId('inspector-retry-judgement-btn')).toBeTruthy());
    const btn = screen.getByTestId('inspector-retry-judgement-btn') as HTMLButtonElement;
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

    await waitFor(() => expect(screen.getByTestId('inspector-retry-judgement-btn')).toBeTruthy());
    const btn = screen.getByTestId('inspector-retry-judgement-btn') as HTMLButtonElement;
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

    await waitFor(() => expect(screen.getByTestId('inspector-retry-judgement-btn')).toBeTruthy());
    fireEvent.click(screen.getByTestId('inspector-retry-judgement-btn'));

    await waitFor(() => expect(screen.getByTestId('retry-judgement-confirm-dialog')).toBeTruthy());
    expect(screen.getByTestId('retry-judgement-confirm-dialog').textContent).toContain('run-1');

    // The mocked dialog calls onComplete then onOpenChange(false) on click,
    // which the real RunInspectorPage wires to `loadData()` — assert it
    // re-fetches (getEvaluationRun called again) rather than going stale.
    const callsBefore = getEvaluationRun.mock.calls.length;
    fireEvent.click(screen.getByTestId('retry-judgement-confirm-dialog'));

    await waitFor(() => expect(getEvaluationRun.mock.calls.length).toBeGreaterThan(callsBefore));
  });

  it('does NOT render Retry judgement for a true legacy BenchmarkRun (no first-class doc) via the BENCHMARK route', async () => {
    mockParams = { benchmarkId: 'bench-1', runId: 'run-1' };
    mockBenchmarkGetById.mockResolvedValue(makeBenchmark(2));
    // Default beforeEach already rejects getEvaluationRun ("not found") —
    // simulates a run that only ever exists as an embedded BenchmarkRun.
    mockTestCasesGetByIds.mockResolvedValue(makeTestCases(2));
    mockGetReportSummariesByIds.mockResolvedValue(makeSummaries(2));

    renderPage();

    await waitFor(() => expect(screen.getAllByTestId('test-case-row').length).toBeGreaterThan(0));
    expect(screen.queryByTestId('inspector-retry-judgement-btn')).toBeNull();
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
    expect((screen.getByTestId('inspector-rerun-btn') as HTMLButtonElement).disabled).toBe(true);
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
    expect((screen.getByTestId('inspector-rerun-btn') as HTMLButtonElement).disabled).toBe(false);
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

    await waitFor(() => expect((screen.getByTestId('inspector-rerun-btn') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('inspector-rerun-btn'));

    await waitFor(() => expect(screen.getByTestId('rerun-confirm-dialog')).toBeTruthy());
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
