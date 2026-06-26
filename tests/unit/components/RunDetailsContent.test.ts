/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for RunDetailsContent banner logic and status display.
 *
 * Covers:
 * - Duplicate banner prevention (red error vs yellow pending)
 * - Context-aware banner messaging (traces loaded vs waiting)
 * - JUDGING vs PENDING status display
 * - tracesError cleared when spans arrive
 * - Metrics effect re-fetch on metricsStatus change
 */

import * as React from 'react';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import { RunDetailsContent } from '@/components/RunDetailsContent';
import { EvaluationReport } from '@/types';

// ── Dependency mocks ──────────────────────────────────────────────────────────

jest.mock('@/services/metrics', () => ({
  fetchRunMetrics: jest.fn().mockResolvedValue(null),
  formatCost: jest.fn((v: number) => `$${v}`),
  formatDuration: jest.fn((v: number) => `${v}ms`),
  formatTokens: jest.fn((v: number) => `${v}`),
}));

jest.mock('@/services/agent', () => ({
  computeTrajectoryFromRawEvents: jest.fn().mockReturnValue([]),
}));

jest.mock('@/services/traces', () => ({
  fetchTracesByRunIds: jest.fn().mockResolvedValue({ spans: [], total: 0 }),
  // Strategy C correlation entrypoint used by RunDetailsContent's trace
  // fetch; added with the trace-correlation work after this mock was first
  // written. Return the same { spans, total } shape the component reads.
  fetchTracesForRun: jest.fn().mockResolvedValue({ spans: [], total: 0 }),
  processSpansIntoTree: jest.fn().mockReturnValue([]),
  calculateTimeRange: jest.fn().mockReturnValue({ startTime: 0, endTime: 0, duration: 0 }),
  groupSpansByTrace: jest.fn().mockReturnValue([]),
  getSpansForTrace: jest.fn().mockReturnValue([]),
}));

jest.mock('@/services/storage', () => ({
  asyncRunStorage: {
    getReportById: jest.fn().mockResolvedValue(null),
    getAnnotationsByReport: jest.fn().mockResolvedValue([]),
    addAnnotation: jest.fn(),
    deleteAnnotation: jest.fn(),
    updateReport: jest.fn(),
  },
  asyncTestCaseStorage: {
    getById: jest.fn().mockResolvedValue(null),
  },
}));

jest.mock('@/services/evaluation', () => ({
  callBedrockJudge: jest.fn(),
}));

jest.mock('@/services/traces/tracePoller', () => ({
  tracePollingManager: {
    startPolling: jest.fn(),
    stopPolling: jest.fn(),
    getState: jest.fn().mockReturnValue(null),
  },
}));

jest.mock('@/lib/constants', () => ({
  DEFAULT_CONFIG: {
    agents: [],
    models: {},
  },
}));

jest.mock('@/lib/utils', () => ({
  formatDate: jest.fn().mockReturnValue('2024-01-01'),
  getLabelColor: jest.fn().mockReturnValue(''),
  getDifficultyColor: jest.fn().mockReturnValue(''),
  cn: jest.fn((...args: any[]) => args.filter(Boolean).join(' ')),
  // RunScore (rendered by RunDetailsContent) reads these from @/lib/utils.
  // They were added to the component after this partial mock was written, so
  // omitting them left them undefined → "getRunOverallScore is not a
  // function". Provide faithful stubs: a numeric score and an empty breakdown.
  getRunOverallScore: jest.fn().mockReturnValue(null),
  formatMetricsBreakdown: jest.fn().mockReturnValue([]),
}));

jest.mock('react-markdown', () => {
  return function MockReactMarkdown({ children }: { children: string }) {
    return React.createElement('div', { 'data-testid': 'markdown' }, children);
  };
});

jest.mock('remark-gfm', () => () => {});

jest.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: any) => React.createElement(React.Fragment, null, children),
  Tooltip: ({ children }: any) => React.createElement(React.Fragment, null, children),
  TooltipTrigger: ({ children }: any) => React.createElement('span', null, children),
  TooltipContent: ({ children }: any) => React.createElement('span', null, children),
}));

jest.mock('react-router-dom', () => ({
  useSearchParams: () => [new URLSearchParams(), jest.fn()],
  // useClusterContext (transitively imported) calls useLocation; without it
  // the hook throws "useLocation is not a function". Return a minimal
  // location with an empty state object so `location.state?.fromCluster` works.
  useLocation: () => ({ pathname: '/', search: '', hash: '', state: null, key: 'test' }),
}));

jest.mock('@/components/TrajectoryView', () => ({
  TrajectoryView: () => React.createElement('div', { 'data-testid': 'trajectory-view' }),
}));

jest.mock('@/components/RawEventsPanel', () => ({
  RawEventsPanel: () => React.createElement('div', { 'data-testid': 'raw-events-panel' }),
}));

jest.mock('@/components/traces/TraceVisualization', () => {
  return {
    __esModule: true,
    default: () => React.createElement('div', { 'data-testid': 'trace-visualization' }),
  };
});

jest.mock('@/components/traces/ViewToggle', () => ({
  __esModule: true,
  default: () => React.createElement('div', { 'data-testid': 'view-toggle' }),
}));

jest.mock('@/components/traces/TraceFullScreenView', () => ({
  __esModule: true,
  default: () => React.createElement('div', { 'data-testid': 'trace-fullscreen' }),
}));

// ── Imports for mock control ──────────────────────────────────────────────────

import { fetchTracesByRunIds, fetchTracesForRun, processSpansIntoTree, calculateTimeRange } from '@/services/traces';
import { asyncRunStorage, asyncTestCaseStorage } from '@/services/storage';
import { fetchRunMetrics } from '@/services/metrics';

const mockFetchTraces = fetchTracesByRunIds as jest.MockedFunction<typeof fetchTracesByRunIds>;
// RunDetailsContent's trace fetch goes through fetchTracesForRun (Strategy C),
// not fetchTracesByRunIds — tests that load spans must drive this one.
const mockFetchTracesForRun = fetchTracesForRun as jest.MockedFunction<typeof fetchTracesForRun>;
const mockProcessSpans = processSpansIntoTree as jest.MockedFunction<typeof processSpansIntoTree>;
const mockCalcTimeRange = calculateTimeRange as jest.MockedFunction<typeof calculateTimeRange>;
const mockGetReportById = asyncRunStorage.getReportById as jest.MockedFunction<typeof asyncRunStorage.getReportById>;
const mockGetTestCaseById = asyncTestCaseStorage.getById as jest.MockedFunction<typeof asyncTestCaseStorage.getById>;
const mockFetchRunMetrics = fetchRunMetrics as jest.MockedFunction<typeof fetchRunMetrics>;

// ── Test data ─────────────────────────────────────────────────────────────────

function createReport(overrides: Partial<EvaluationReport> = {}): EvaluationReport {
  return {
    id: 'report-1',
    timestamp: '2024-01-01T00:00:00Z',
    testCaseId: 'tc-1',
    status: 'completed',
    passFailStatus: 'passed',
    agentName: 'Test Agent',
    agentKey: 'test-agent',
    modelName: 'test-model',
    modelId: 'test-model',
    trajectory: [],
    metrics: { accuracy: 85 },
    llmJudgeReasoning: 'Good performance',
    runId: 'run-123',
    ...overrides,
  };
}

const mockSpans = [
  {
    traceId: 'trace-1',
    spanId: 'span-1',
    name: 'root-span',
    startTime: '2024-01-01T00:00:00Z',
    endTime: '2024-01-01T00:00:01Z',
    duration: 1000,
    status: 'OK',
    attributes: {},
  },
];

const mockSpanTree = [
  {
    ...mockSpans[0],
    children: [],
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

async function renderAndWait(report: EvaluationReport, extraProps: Record<string, any> = {}) {
  await act(async () => {
    render(React.createElement(RunDetailsContent, { report, ...extraProps }));
  });
  // Let initial useEffects settle
  await act(async () => {
    await new Promise(r => setTimeout(r, 0));
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('RunDetailsContent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetReportById.mockResolvedValue(null);
    mockGetTestCaseById.mockResolvedValue(null);
    mockFetchRunMetrics.mockResolvedValue(null);
    mockFetchTraces.mockResolvedValue({ spans: [], total: 0 });
    mockProcessSpans.mockReturnValue([]);
    mockCalcTimeRange.mockReturnValue({ startTime: 0, endTime: 0, duration: 0 });
  });

  describe('pending banner messaging', () => {
    it('should show "Waiting for traces" when metricsStatus is pending and no spans loaded', async () => {
      const report = createReport({ metricsStatus: 'pending' });
      // getReportById returns the same pending report
      mockGetReportById.mockResolvedValue(report);

      await renderAndWait(report);

      await waitFor(() => {
        expect(screen.getByText(/Waiting for traces to become available/i)).toBeTruthy();
      });
    });

    it('should show "Running LLM judge evaluation" when metricsStatus is pending but spans are loaded', async () => {
      const report = createReport({ metricsStatus: 'pending' });
      mockGetReportById.mockResolvedValue(report);

      // When user clicks Traces tab, traces are found. The component fetches
      // via fetchTracesForRun (Strategy C), so drive that one too.
      mockFetchTraces.mockResolvedValue({ spans: mockSpans as any, total: 1 });
      mockFetchTracesForRun.mockResolvedValue({ spans: mockSpans as any, total: 1 } as any);
      mockProcessSpans.mockReturnValue(mockSpanTree as any);

      await renderAndWait(report);

      // Click the Traces tab to trigger trace fetch
      const tracesTab = screen.getByText('Traces');
      await act(async () => {
        fireEvent.click(tracesTab);
      });

      await waitFor(() => {
        expect(screen.getByText(/Running LLM judge evaluation/i)).toBeTruthy();
      });
    });

    it('should show attempt count in pending banner when traceFetchAttempts is set', async () => {
      const report = createReport({
        metricsStatus: 'pending',
        traceFetchAttempts: 5,
      });
      mockGetReportById.mockResolvedValue(report);

      await renderAndWait(report);

      await waitFor(() => {
        expect(screen.getByText(/Attempt 5\/20/)).toBeTruthy();
      });
    });
  });

  describe('status display', () => {
    it('should show PENDING when metricsStatus is pending and no spans', async () => {
      const report = createReport({ metricsStatus: 'pending' });
      mockGetReportById.mockResolvedValue(report);

      await renderAndWait(report);

      await waitFor(() => {
        expect(screen.getByText('PENDING')).toBeTruthy();
      });
    });

    it('should show JUDGING when metricsStatus is pending but spans are loaded', async () => {
      const report = createReport({ metricsStatus: 'pending' });
      mockGetReportById.mockResolvedValue(report);

      mockFetchTraces.mockResolvedValue({ spans: mockSpans as any, total: 1 });
      mockFetchTracesForRun.mockResolvedValue({ spans: mockSpans as any, total: 1 } as any);
      mockProcessSpans.mockReturnValue(mockSpanTree as any);

      await renderAndWait(report);

      // Click Traces tab to load spans
      const tracesTab = screen.getByText('Traces');
      await act(async () => {
        fireEvent.click(tracesTab);
      });

      await waitFor(() => {
        expect(screen.getByText('JUDGING')).toBeTruthy();
      });
    });

    it('should show PASSED when metricsStatus is not pending and passFailStatus is passed', async () => {
      const report = createReport({
        metricsStatus: 'ready',
        passFailStatus: 'passed',
      });
      mockGetReportById.mockResolvedValue(report);

      await renderAndWait(report);

      await waitFor(() => {
        expect(screen.getByText('PASSED')).toBeTruthy();
      });
    });

    it('should show FAILED when metricsStatus is not pending and passFailStatus is failed', async () => {
      const report = createReport({
        metricsStatus: 'ready',
        passFailStatus: 'failed',
      });
      mockGetReportById.mockResolvedValue(report);

      await renderAndWait(report);

      await waitFor(() => {
        expect(screen.getByText('FAILED')).toBeTruthy();
      });
    });
  });

  describe('traces tab banners', () => {
    it('should not show red error banner when metricsStatus is pending', async () => {
      // The red "Failed to load traces" banner in the Traces tab has condition:
      //   tracesError && !tracesLoading && liveReport.metricsStatus !== 'pending'
      // So when metricsStatus is 'pending', the red banner is suppressed even
      // if tracesError is set. We verify this by checking the header area which
      // is always visible (not behind a tab).
      const report = createReport({ metricsStatus: 'pending' });
      mockGetReportById.mockResolvedValue(report);

      await renderAndWait(report);

      // The pending header banner should be visible
      expect(screen.getByText(/Waiting for traces to become available/i)).toBeTruthy();
      // No error-state header banner should be visible
      expect(screen.queryByText(/Failed to fetch traces/i)).toBeNull();
    });

    it('should show error banner in header when metricsStatus is error', async () => {
      // When polling exhausted all attempts, metricsStatus is set to 'error'
      // and the header shows a red error banner. Post-#335 the title is derived
      // from the error-kind label (NOT a blanket "Failed to fetch traces"), with
      // the raw traceError shown beneath.
      const report = createReport({
        metricsStatus: 'error',
        traceError: 'Traces never arrived (kind=trace_timeout): polling exhausted after 30 attempts',
      });
      mockGetReportById.mockResolvedValue(report);

      await renderAndWait(report);

      await waitFor(() => {
        expect(screen.getByText('Traces never arrived')).toBeTruthy();
        expect(screen.getByText(/polling exhausted after 30 attempts/)).toBeTruthy();
      });
    });

    it('should show yellow pending banner in traces tab only when no spans are loaded', async () => {
      const report = createReport({ metricsStatus: 'pending' });
      mockGetReportById.mockResolvedValue(report);

      // Traces will be found when tab is clicked
      mockFetchTraces.mockResolvedValue({ spans: mockSpans as any, total: 1 });
      mockProcessSpans.mockReturnValue(mockSpanTree as any);

      await renderAndWait(report);

      // Click Traces tab - traces will be found
      const tracesTab = screen.getByText('Traces');
      await act(async () => {
        fireEvent.click(tracesTab);
      });

      await waitFor(() => {
        // After traces load, the pending banner in Traces tab should NOT show
        // (it has !traceSpans.length condition)
        expect(screen.queryByText(/Traces not yet available/i)).toBeNull();
      });
    });
  });

  describe('metrics re-fetch on status change', () => {
    it('should call fetchRunMetrics when report has runId', async () => {
      const report = createReport({ runId: 'run-abc' });
      mockGetReportById.mockResolvedValue(report);

      await renderAndWait(report);

      expect(mockFetchRunMetrics).toHaveBeenCalledWith('run-abc');
    });
  });

  describe('error metricsStatus banner', () => {
    it('should show error banner when metricsStatus is error', async () => {
      const report = createReport({
        metricsStatus: 'error',
        traceError: 'Traces not available after 30 attempts',
      });
      mockGetReportById.mockResolvedValue(report);

      await renderAndWait(report);

      await waitFor(() => {
        // No `(kind=...)` prefix in traceError → banner title falls back to the
        // generic "Evaluation error", with the raw message beneath.
        expect(screen.getByText('Evaluation error')).toBeTruthy();
        expect(screen.getByText(/Traces not available after 30 attempts/)).toBeTruthy();
      });
    });
  });

  describe('no pending banner when report is ready', () => {
    it('should not show pending banner when metricsStatus is ready', async () => {
      const report = createReport({
        metricsStatus: 'ready',
        passFailStatus: 'passed',
      });
      mockGetReportById.mockResolvedValue(report);

      await renderAndWait(report);

      expect(screen.queryByText(/Waiting for traces/i)).toBeNull();
      expect(screen.queryByText(/Running LLM judge evaluation/i)).toBeNull();
    });
  });

  describe('per-test-case performance metrics', () => {
    it('should show Eval Duration and agent time in Duration card when performanceMetrics is present', async () => {
      const report = createReport({
        performanceMetrics: {
          durationMs: 12500,
          agentDurationMs: 8000,
        },
      });
      mockGetReportById.mockResolvedValue(report);

      await renderAndWait(report);

      expect(screen.getByText('Eval Duration')).toBeTruthy();
      expect(screen.getByText('12500ms')).toBeTruthy();
      // Agent time shown in parentheses next to Duration
      expect(screen.getByText(/agent 8000ms/)).toBeTruthy();
    });

    it('should show Judge Time when judgeDurationMs is present', async () => {
      const report = createReport({
        performanceMetrics: {
          durationMs: 15000,
          agentDurationMs: 8000,
          judgeDurationMs: 6000,
        },
      });
      mockGetReportById.mockResolvedValue(report);

      await renderAndWait(report);

      expect(screen.getByText('Judge Time')).toBeTruthy();
      expect(screen.getByText('6000ms')).toBeTruthy();
    });

    it('should not show Judge Time when judgeDurationMs is undefined', async () => {
      const report = createReport({
        performanceMetrics: {
          durationMs: 12500,
          agentDurationMs: 8000,
        },
      });
      mockGetReportById.mockResolvedValue(report);

      await renderAndWait(report);

      expect(screen.queryByText('Judge Time')).toBeNull();
    });

    it('should show Judge Retries when judgeAttempts is greater than 1', async () => {
      const report = createReport({
        performanceMetrics: {
          durationMs: 20000,
          agentDurationMs: 8000,
          judgeDurationMs: 11000,
          judgeAttempts: 3,
        },
      });
      mockGetReportById.mockResolvedValue(report);

      await renderAndWait(report);

      expect(screen.getByText('Judge Retries')).toBeTruthy();
      expect(screen.getByText('3')).toBeTruthy();
    });

    it('should not show Judge Retries when judgeAttempts is 1', async () => {
      const report = createReport({
        performanceMetrics: {
          durationMs: 15000,
          agentDurationMs: 8000,
          judgeDurationMs: 6000,
          judgeAttempts: 1,
        },
      });
      mockGetReportById.mockResolvedValue(report);

      await renderAndWait(report);

      expect(screen.queryByText('Judge Retries')).toBeNull();
    });

    it('should not show performance metrics row when performanceMetrics is absent', async () => {
      const report = createReport();
      mockGetReportById.mockResolvedValue(report);

      await renderAndWait(report);

      expect(screen.queryByText('Eval Duration')).toBeNull();
      expect(screen.queryByText('Agent Time')).toBeNull();
      expect(screen.queryByText('Judge Time')).toBeNull();
      expect(screen.queryByText('Judge Retries')).toBeNull();
    });

    it('should show metrics from performanceMetrics prop when report lacks them', async () => {
      // Simulates benchmark runs where metrics live on the run results, not the report
      const report = createReport(); // no performanceMetrics on report
      mockGetReportById.mockResolvedValue(report);

      await renderAndWait(report, {
        performanceMetrics: {
          durationMs: 49556,
          agentDurationMs: 49154,
        },
      });

      expect(screen.getByText('Eval Duration')).toBeTruthy();
      expect(screen.getByText('49556ms')).toBeTruthy();
      // Agent time shown in parentheses next to Duration
      expect(screen.getByText(/agent 49154ms/)).toBeTruthy();
    });
  });
});
