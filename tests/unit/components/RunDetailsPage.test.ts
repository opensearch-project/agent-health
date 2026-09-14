/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for RunDetailsPage header performance metrics display
 * and download report functionality.
 *
 * Covers:
 * - Run duration display in header subtitle
 * - Concurrency display when > 1
 * - Hiding concurrency when sequential (concurrency = 1)
 * - No metrics display when performanceMetrics is absent
 * - Download report button rendering and fetch behavior
 */

import * as React from 'react';
import { render, screen, waitFor, act, cleanup } from '@testing-library/react';
import { Experiment, ExperimentRun, EvaluationReport } from '@/types';

// ── Stable mock references (must be defined before jest.mock calls) ──────────
// React hooks that return functions must return STABLE references across renders,
// otherwise useCallback dependencies change every render causing infinite loops.

const mockNavigate = jest.fn();
const mockSetSearchParams = jest.fn();
const mockSearchParams = new URLSearchParams();
const mockSetSidebarOpen = jest.fn();

// ── Dependency mocks ──────────────────────────────────────────────────────────

const mockUseParams = jest.fn().mockReturnValue({ benchmarkId: 'bench-1', runId: 'run-1' });

jest.mock('react-router-dom', () => ({
  useParams: () => mockUseParams(),
  useNavigate: () => mockNavigate,
  useSearchParams: () => [mockSearchParams, mockSetSearchParams],
  useLocation: () => ({ state: null }),
}));

jest.mock('@/components/ui/sidebar', () => ({
  useSidebar: () => ({ setOpen: mockSetSidebarOpen }),
}));

jest.mock('@/services/storage', () => ({
  asyncExperimentStorage: {
    getById: jest.fn().mockResolvedValue(null),
  },
  asyncRunStorage: {
    getByExperimentRun: jest.fn().mockResolvedValue([]),
    getReportById: jest.fn().mockResolvedValue(null),
    getReportSummariesByIds: jest.fn().mockResolvedValue({}),
    getReportReasoningsByIds: jest.fn().mockResolvedValue({}),
  },
  asyncTestCaseStorage: {
    getAll: jest.fn().mockResolvedValue([]),
    getByIds: jest.fn().mockResolvedValue([]),
    getById: jest.fn().mockResolvedValue(null),
  },
}));

jest.mock('@/services/client', () => ({
  cancelExperimentRun: jest.fn(),
}));

jest.mock('@/lib/constants', () => ({
  DEFAULT_CONFIG: {
    agents: [],
    models: {},
  },
}));

jest.mock('@/lib/utils', () => ({
  formatDate: jest.fn().mockReturnValue('2024-01-01'),
  getDifficultyColor: jest.fn().mockReturnValue(''),
  getModelName: jest.fn((id: string) => id),
  cn: jest.fn((...args: any[]) => args.filter(Boolean).join(' ')),
  // Judge/evaluator label helpers (lib/utils.ts) reused by RunSummaryBand /
  // JudgeModelLabel. getJudgeModelDisplay renders "judge kind · underlying LLM".
  getJudgeModelLabel: jest.fn((id?: string | null) => (id ? `judge:${id}` : '—')),
  getJudgeModelDisplay: jest.fn((run?: { judgeModel?: string | null; judgeModelId?: string | null } | null) => {
    const id = run?.judgeModelId;
    if (!id && !run?.judgeModel) return { label: '—', title: 'none' };
    return { label: `judge:${id}`, detail: run?.judgeModel || undefined, title: `judge:${id}` };
  }),
  getEvaluatorLabel: jest.fn((id?: string | null) => (id ? `evaluator:${id}` : '—')),
  // Used by RunInsightsPane's "Avg Score" detail (run-report-insights).
  getRunOverallScore: jest.fn().mockReturnValue(null),
}));

jest.mock('@/services/metrics', () => ({
  formatDuration: jest.fn((v: number) => `${v}ms`),
  formatCost: jest.fn((v: number) => `$${v.toFixed(2)}`),
  formatTokens: jest.fn((v: number) => `${v}`),
  fetchBatchMetrics: jest.fn().mockResolvedValue({ aggregate: null, metrics: {} }),
}));

// Mock child components to avoid their own async side effects
jest.mock('@/components/RunDetailsContent', () => ({
  RunDetailsContent: () => React.createElement('div', { 'data-testid': 'run-details-content' }),
}));

jest.mock('@/components/ui/card', () => ({
  Card: React.forwardRef(({ children, ...props }: any, ref: any) => React.createElement('div', { ref, ...props }, children)),
  CardContent: ({ children, ...props }: any) => React.createElement('div', props, children),
}));

jest.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: any) => React.createElement('button', props, children),
}));

jest.mock('@/components/ui/badge', () => ({
  Badge: ({ children, ...props }: any) => React.createElement('span', props, children),
}));

jest.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children, ...props }: any) => React.createElement('div', props, children),
}));

jest.mock('@/components/ui/skeleton', () => ({
  Skeleton: () => React.createElement('div', { 'data-testid': 'skeleton' }),
}));

jest.mock('@/components/ui/resizable', () => ({
  ResizablePanelGroup: ({ children }: any) => React.createElement('div', null, children),
  ResizablePanel: ({ children }: any) => React.createElement('div', null, children),
  ResizableHandle: () => null,
}));

jest.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: any) => React.createElement('div', null, children),
  DropdownMenuTrigger: ({ children }: any) => React.createElement('div', null, children),
  DropdownMenuContent: ({ children }: any) => React.createElement('div', null, children),
  DropdownMenuItem: ({ children, onClick, ...props }: any) => React.createElement('button', { onClick, ...props }, children),
}));

// ── Imports for mock control ──────────────────────────────────────────────────

import { asyncExperimentStorage, asyncRunStorage, asyncTestCaseStorage } from '@/services/storage';
import { RunDetailsPage } from '@/components/RunDetailsPage';

const mockGetExperiment = asyncExperimentStorage.getById as jest.MockedFunction<typeof asyncExperimentStorage.getById>;
const mockGetAllTestCases = asyncTestCaseStorage.getAll as jest.MockedFunction<typeof asyncTestCaseStorage.getAll>;
const mockGetByIdsTestCases = asyncTestCaseStorage.getByIds as jest.MockedFunction<typeof asyncTestCaseStorage.getByIds>;
const mockGetReportById = asyncRunStorage.getReportById as jest.MockedFunction<typeof asyncRunStorage.getReportById>;
const mockGetReportSummariesByIds = asyncRunStorage.getReportSummariesByIds as jest.MockedFunction<typeof asyncRunStorage.getReportSummariesByIds>;

// Helper: given the array of full reports a test wants "in storage", wire up
// both the summary batch (initial paint) and the per-id full fetch (on
// selection) so existing tests exercising `reports` keep working under the
// new lazy-loading data path.
function wireReports(reports: EvaluationReport[]) {
  const byId: Record<string, EvaluationReport> = {};
  for (const r of reports) byId[r.id] = r;
  mockGetReportSummariesByIds.mockResolvedValue(byId);
  mockGetReportById.mockImplementation((id: string) => Promise.resolve(byId[id] || null));
}

// ── Test data ─────────────────────────────────────────────────────────────────

function createExperimentRun(overrides: Partial<ExperimentRun> = {}): ExperimentRun {
  return {
    id: 'run-1',
    name: 'Test Run',
    agentId: 'test-agent',
    modelId: 'test-model',
    status: 'completed',
    createdAt: '2024-01-01T00:00:00Z',
    results: {
      'tc-1': {
        reportId: 'report-1',
        status: 'completed',
      },
      'tc-2': {
        reportId: 'report-2',
        status: 'completed',
      },
    },
    ...overrides,
  };
}

function createExperiment(run: ExperimentRun): Experiment {
  return {
    id: 'bench-1',
    name: 'Test Benchmark',
    testCaseIds: ['tc-1', 'tc-2'],
    createdAt: '2024-01-01T00:00:00Z',
    runs: [run],
  };
}

function createReport(id: string, testCaseId: string): EvaluationReport {
  return {
    id,
    timestamp: '2024-01-01T00:00:00Z',
    testCaseId,
    status: 'completed',
    passFailStatus: 'passed',
    agentName: 'Test Agent',
    agentKey: 'test-agent',
    modelName: 'test-model',
    modelId: 'test-model',
    trajectory: [],
    metrics: { accuracy: 90 },
    llmJudgeReasoning: 'Good',
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function renderAndWait() {
  await act(async () => {
    render(React.createElement(RunDetailsPage));
  });
  // Flush cascading async effects (storage calls resolve in sequence)
  await act(async () => {
    await new Promise(r => setTimeout(r, 0));
  });
  await act(async () => {
    await new Promise(r => setTimeout(r, 0));
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('RunDetailsPage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAllTestCases.mockResolvedValue([]);
    mockGetByIdsTestCases.mockResolvedValue([]);
    mockGetReportSummariesByIds.mockResolvedValue({});
    // RunDetailsPage fetches the evaluator id->name map once on mount
    // (mirrors EvalRunsPage); default to an empty list so tests that don't
    // care about evaluator labels aren't affected. Individual tests may
    // override global.fetch for their own scenarios (e.g. download-report).
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ evaluators: [] }),
    }) as any;
    // `mockSearchParams` is a shared singleton mutated in-place by the
    // component itself (searchParams.set/delete inside handleSelectItem) -
    // reset it before every test so a prior test's case selection can't
    // leak into the next test's initial ?testCase read.
    mockSearchParams.delete('testCase');
  });

  afterEach(() => {
    cleanup();
  });

  describe('run-level performance metrics in header', () => {
    it('should show run duration when performanceMetrics.durationMs is present', async () => {
      const run = createExperimentRun({
        performanceMetrics: {
          durationMs: 45000,
          concurrency: 1,
          avgTestCaseDurationMs: 22500,
          maxTestCaseDurationMs: 30000,
          minTestCaseDurationMs: 15000,
        },
      });
      const experiment = createExperiment(run);
      const reports = [createReport('report-1', 'tc-1'), createReport('report-2', 'tc-2')];

      mockGetExperiment.mockResolvedValue(experiment);
      wireReports(reports);

      await renderAndWait();

      await waitFor(() => {
        expect(screen.getByText(/Run duration: 45000ms/)).toBeTruthy();
      });
    });

    it('should show concurrency when greater than 1', async () => {
      const run = createExperimentRun({
        performanceMetrics: {
          durationMs: 20000,
          concurrency: 3,
          avgTestCaseDurationMs: 10000,
          maxTestCaseDurationMs: 12000,
          minTestCaseDurationMs: 8000,
        },
      });
      const experiment = createExperiment(run);
      const reports = [createReport('report-1', 'tc-1'), createReport('report-2', 'tc-2')];

      mockGetExperiment.mockResolvedValue(experiment);
      wireReports(reports);

      await renderAndWait();

      await waitFor(() => {
        expect(screen.getByText(/Concurrency: 3/)).toBeTruthy();
      });
    });

    it('should not show concurrency when equal to 1', async () => {
      const run = createExperimentRun({
        performanceMetrics: {
          durationMs: 45000,
          concurrency: 1,
          avgTestCaseDurationMs: 22500,
          maxTestCaseDurationMs: 30000,
          minTestCaseDurationMs: 15000,
        },
      });
      const experiment = createExperiment(run);
      const reports = [createReport('report-1', 'tc-1'), createReport('report-2', 'tc-2')];

      mockGetExperiment.mockResolvedValue(experiment);
      wireReports(reports);

      await renderAndWait();

      await waitFor(() => {
        expect(screen.getByText(/Run duration: 45000ms/)).toBeTruthy();
      });

      expect(screen.queryByText(/Concurrency/)).toBeNull();
    });

    it('should not show duration or concurrency when performanceMetrics is absent', async () => {
      const run = createExperimentRun();
      const experiment = createExperiment(run);
      const reports = [createReport('report-1', 'tc-1'), createReport('report-2', 'tc-2')];

      mockGetExperiment.mockResolvedValue(experiment);
      wireReports(reports);

      await renderAndWait();

      await waitFor(() => {
        expect(screen.getByText('Test Run')).toBeTruthy();
      });

      expect(screen.queryByText(/Concurrency/)).toBeNull();
    });
  });

  describe('download report button', () => {
    it('should render download report button for benchmark runs', async () => {
      const run = createExperimentRun();
      const experiment = createExperiment(run);
      const reports = [createReport('report-1', 'tc-1'), createReport('report-2', 'tc-2')];

      mockGetExperiment.mockResolvedValue(experiment);
      wireReports(reports);

      await renderAndWait();

      await waitFor(() => {
        expect(screen.getByTestId('download-report-button')).toBeTruthy();
      });

      // Verify format options are rendered
      expect(screen.getByTestId('download-json')).toBeTruthy();
      expect(screen.getByTestId('download-html')).toBeTruthy();
      expect(screen.getByTestId('download-pdf')).toBeTruthy();
    });

    it('should not render download report button for standalone runs', async () => {
      // Override useParams to simulate standalone run (no benchmarkId)
      mockUseParams.mockReturnValue({ runId: 'report-1' });
      mockGetExperiment.mockResolvedValue(null);

      const standaloneReport = createReport('report-1', 'tc-1');
      mockGetReportById.mockResolvedValue(standaloneReport);

      await renderAndWait();

      await waitFor(() => {
        expect(screen.queryByTestId('skeleton')).toBeNull();
      });

      expect(screen.queryByTestId('download-report-button')).toBeNull();

      // Restore default useParams
      mockUseParams.mockReturnValue({ benchmarkId: 'bench-1', runId: 'run-1' });
    });

    it('should call fetch with correct URL when downloading JSON report', async () => {
      const mockBlob = new Blob(['{}'], { type: 'application/json' });
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-disposition': 'attachment; filename="Test_Run_report.json"' }),
        blob: () => Promise.resolve(mockBlob),
      });
      global.fetch = mockFetch;

      // Mock URL.createObjectURL and URL.revokeObjectURL
      const mockCreateObjectURL = jest.fn().mockReturnValue('blob:test');
      const mockRevokeObjectURL = jest.fn();
      global.URL.createObjectURL = mockCreateObjectURL;
      global.URL.revokeObjectURL = mockRevokeObjectURL;

      const run = createExperimentRun();
      const experiment = createExperiment(run);
      const reports = [createReport('report-1', 'tc-1'), createReport('report-2', 'tc-2')];

      mockGetExperiment.mockResolvedValue(experiment);
      wireReports(reports);

      await renderAndWait();

      await waitFor(() => {
        expect(screen.getByTestId('download-json')).toBeTruthy();
      });

      // Click the JSON download option
      await act(async () => {
        screen.getByTestId('download-json').click();
      });

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining('/api/storage/benchmarks/bench-1/report?format=json&runIds=run-1')
        );
      });
    });
  });

  describe('loading state (regression: large run rendered a silent blank pane)', () => {
    it('shows a human-readable loading label instead of a bare skeleton while the run loads', async () => {
      let resolveExp: (v: Experiment) => void = () => {};
      mockGetExperiment.mockImplementation(() => new Promise(resolve => { resolveExp = resolve; }));

      act(() => {
        render(React.createElement(RunDetailsPage));
      });

      // Still loading: the skeleton must be accompanied by explicit text,
      // never a bare/void render.
      expect(screen.getByTestId('run-details-loading')).toBeTruthy();
      expect(screen.getByTestId('run-details-loading-label').textContent).toMatch(/Loading/i);

      await act(async () => {
        resolveExp(createExperiment(createExperimentRun()));
        await new Promise(r => setTimeout(r, 0));
        await new Promise(r => setTimeout(r, 0));
      });

      await waitFor(() => {
        expect(screen.queryByTestId('run-details-loading')).toBeNull();
      });
    });

    it('surfaces an inline error with Retry instead of a silent blank pane when the fetch fails', async () => {
      mockGetExperiment.mockRejectedValueOnce(new Error('network boom'));

      await renderAndWait();

      await waitFor(() => {
        expect(screen.getByTestId('run-details-error')).toBeTruthy();
      });
      expect(screen.getByText(/network boom/)).toBeTruthy();

      // Retry re-invokes the loader; a second, successful attempt clears the
      // error and renders real content instead of leaving the void in place.
      const run = createExperimentRun();
      const experiment = createExperiment(run);
      wireReports([createReport('report-1', 'tc-1'), createReport('report-2', 'tc-2')]);
      mockGetExperiment.mockResolvedValueOnce(experiment);

      await act(async () => {
        screen.getByTestId('run-details-retry').click();
        await new Promise(r => setTimeout(r, 0));
        await new Promise(r => setTimeout(r, 0));
      });

      await waitFor(() => {
        expect(screen.queryByTestId('run-details-error')).toBeNull();
        expect(screen.getByText('Test Run')).toBeTruthy();
      });
    });
  });

  describe('summary-first rendering + lazy full-report fetch', () => {
    it('paints the case list from batched summaries without fetching every full report up front', async () => {
      const run = createExperimentRun();
      const experiment = createExperiment(run);
      // Summary reports lack trajectory/metrics (mirrors the real server-side
      // field projection) - the sidebar must still render fine from these.
      const summaries: Record<string, EvaluationReport> = {
        'report-1': { ...createReport('report-1', 'tc-1'), trajectory: undefined as any, metrics: undefined },
        'report-2': { ...createReport('report-2', 'tc-2'), trajectory: undefined as any, metrics: undefined },
      };
      mockGetExperiment.mockResolvedValue(experiment);
      mockGetReportSummariesByIds.mockResolvedValue(summaries);

      await renderAndWait();

      // Case list rendered promptly from summaries alone.
      await waitFor(() => {
        expect(screen.getByText('tc-1')).toBeTruthy();
        expect(screen.getByText('tc-2')).toBeTruthy();
      });
      // No full-report fetch happened yet - the run starts on the Summary tab.
      expect(mockGetReportById).not.toHaveBeenCalled();

      // Selecting a case triggers exactly one on-demand full-report fetch.
      mockGetReportById.mockResolvedValueOnce(createReport('report-1', 'tc-1'));
      await act(async () => {
        screen.getByText('tc-1').click();
        await new Promise(r => setTimeout(r, 0));
        await new Promise(r => setTimeout(r, 0));
      });

      expect(mockGetReportById).toHaveBeenCalledWith('report-1');
      await waitFor(() => {
        expect(screen.getByTestId('run-details-content')).toBeTruthy();
      });
    });

    it('shows a "Loading report" state for the selected case while its full body is in flight', async () => {
      const run = createExperimentRun();
      const experiment = createExperiment(run);
      mockGetExperiment.mockResolvedValue(experiment);
      mockGetReportSummariesByIds.mockResolvedValue({
        'report-1': { ...createReport('report-1', 'tc-1'), trajectory: undefined as any },
        'report-2': { ...createReport('report-2', 'tc-2'), trajectory: undefined as any },
      });

      let resolveFull: (v: EvaluationReport) => void = () => {};
      mockGetReportById.mockImplementation(() => new Promise(resolve => { resolveFull = resolve; }));

      await renderAndWait();

      await act(async () => {
        screen.getByText('tc-1').click();
        await new Promise(r => setTimeout(r, 0));
      });

      expect(screen.getByText(/Loading report/i)).toBeTruthy();

      await act(async () => {
        resolveFull(createReport('report-1', 'tc-1'));
        await new Promise(r => setTimeout(r, 0));
        await new Promise(r => setTimeout(r, 0));
      });

      await waitFor(() => {
        expect(screen.getByTestId('run-details-content')).toBeTruthy();
      });
    });

    it('shows the same "Loading report" state in the full-width (single test case, no sidebar) layout', async () => {
      // A run with exactly one result auto-selects that case and renders the
      // full-width layout (no ResizablePanel sidebar) - a separate code path
      // that mirrors the sidebar layout's pending/loading/error branches.
      const run = createExperimentRun({ results: { 'tc-solo': { reportId: 'report-solo', status: 'completed' } } });
      const experiment = createExperiment(run);
      mockGetExperiment.mockResolvedValue(experiment);
      mockGetReportSummariesByIds.mockResolvedValue({
        'report-solo': { ...createReport('report-solo', 'tc-solo'), trajectory: undefined as any },
      });

      let resolveFull: (v: EvaluationReport) => void = () => {};
      mockGetReportById.mockImplementation(() => new Promise(resolve => { resolveFull = resolve; }));

      await renderAndWait();

      await waitFor(() => {
        expect(screen.getByText(/Loading report/i)).toBeTruthy();
      });

      await act(async () => {
        resolveFull(createReport('report-solo', 'tc-solo'));
        await new Promise(r => setTimeout(r, 0));
        await new Promise(r => setTimeout(r, 0));
      });

      await waitFor(() => {
        expect(screen.getByTestId('run-details-content')).toBeTruthy();
      });
    });
  });

  describe('run summary band (redesign: bare route renders summary + list directly)', () => {
    it('renders the summary band with agent/model/judge/evaluator labels and verdict counts, no click-through needed', async () => {
      const run = createExperimentRun({
        agentKey: 'test-agent',
        modelId: 'test-model',
        judgeModelId: 'judge-model-x',
        evaluatorId: 'evaluator-y',
      });
      const experiment = createExperiment(run);
      const reports = [
        { ...createReport('report-1', 'tc-1'), passFailStatus: 'passed' as const },
        { ...createReport('report-2', 'tc-2'), passFailStatus: 'failed' as const },
      ];

      mockGetExperiment.mockResolvedValue(experiment);
      wireReports(reports);

      await renderAndWait();

      // Band renders directly on the bare route - no need to select anything.
      await waitFor(() => {
        expect(screen.getByTestId('run-summary-band')).toBeTruthy();
      });

      // Judge/evaluator labels come from lib/utils' getJudgeModelDisplay /
      // getEvaluatorLabel helpers (mocked above) - assert they were fed the
      // run's judgeModelId/evaluatorId, and rendered.
      expect(screen.getByTestId('run-summary-band-judge').textContent).toContain('judge:judge-model-x');
      expect(screen.getByTestId('run-summary-band-evaluator').textContent).toContain('evaluator:evaluator-y');

      // Verdict counts: 1 passed, 1 failed, 0 errored, 2 total.
      const verdicts = screen.getByTestId('run-summary-band-verdicts');
      expect(verdicts.textContent).toContain('1');
      expect(verdicts.textContent).toContain('/ 2');

      // The test-case list is rendered directly below the band - no
      // "Select a test case" empty pane, no detail pane (nothing selected).
      expect(screen.getByTestId('run-test-case-list')).toBeTruthy();
      expect(screen.getByText('tc-1')).toBeTruthy();
      expect(screen.getByText('tc-2')).toBeTruthy();
      expect(screen.queryByTestId('run-details-content')).toBeNull();
      expect(screen.queryByText(/Select a test case/i)).toBeNull();
    });

    it('shows an em dash for judge/evaluator when the run has neither set', async () => {
      const run = createExperimentRun({ judgeModelId: undefined, evaluatorId: undefined });
      const experiment = createExperiment(run);
      mockGetExperiment.mockResolvedValue(experiment);
      wireReports([createReport('report-1', 'tc-1'), createReport('report-2', 'tc-2')]);

      await renderAndWait();

      await waitFor(() => {
        expect(screen.getByTestId('run-summary-band-judge').textContent).toContain('\u2014');
        expect(screen.getByTestId('run-summary-band-evaluator').textContent).toContain('\u2014');
      });
    });
  });

  describe('?testCase param sync (redesign: deep-linkable case selection)', () => {
    afterEach(() => {
      mockSearchParams.delete('testCase');
    });

    it('clicking a case row pushes ?testCase=<id> (not a history replace) and renders the case detail', async () => {
      const run = createExperimentRun();
      const experiment = createExperiment(run);
      mockGetExperiment.mockResolvedValue(experiment);
      wireReports([createReport('report-1', 'tc-1'), createReport('report-2', 'tc-2')]);

      await renderAndWait();

      await act(async () => {
        screen.getByText('tc-1').click();
        await new Promise(r => setTimeout(r, 0));
        await new Promise(r => setTimeout(r, 0));
      });

      expect(mockSetSearchParams).toHaveBeenCalled();
      const [paramsArg, optionsArg] = mockSetSearchParams.mock.calls[mockSetSearchParams.mock.calls.length - 1];
      expect(paramsArg.get('testCase')).toBe('tc-1');
      // Push semantics (no `{ replace: true }`) so browser back/forward can
      // walk between "no case selected" and each selected case.
      expect(optionsArg).toBeUndefined();

      await waitFor(() => {
        expect(screen.getByTestId('run-details-content')).toBeTruthy();
      });
    });

    it('deep-links: a ?testCase=<id> present on load preselects that case and renders its detail immediately', async () => {
      mockSearchParams.set('testCase', 'tc-2');

      const run = createExperimentRun();
      const experiment = createExperiment(run);
      mockGetExperiment.mockResolvedValue(experiment);
      wireReports([createReport('report-1', 'tc-1'), createReport('report-2', 'tc-2')]);

      await renderAndWait();

      await waitFor(() => {
        expect(screen.getByTestId('run-details-content')).toBeTruthy();
      });
      // The deep-linked case's full report was fetched (not just its summary).
      expect(mockGetReportById).toHaveBeenCalledWith('report-2');
    });
  });
});
