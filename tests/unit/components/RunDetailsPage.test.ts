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
  },
  asyncTestCaseStorage: {
    getAll: jest.fn().mockResolvedValue([]),
    getById: jest.fn().mockResolvedValue(null),
  },
}));

jest.mock('@/services/client', () => ({
  cancelExperimentRun: jest.fn(),
}));

jest.mock('@/services/metrics', () => ({
  formatDuration: jest.fn((v: number) => `${v}ms`),
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
  // RunScore reads these from @/lib/utils; added to the component after this
  // partial mock was written, so omitting them threw "getRunOverallScore is
  // not a function".
  getRunOverallScore: jest.fn().mockReturnValue(null),
  formatMetricsBreakdown: jest.fn().mockReturnValue([]),
}));

// Mock child components to avoid their own async side effects
jest.mock('@/components/RunDetailsContent', () => ({
  RunDetailsContent: () => React.createElement('div', { 'data-testid': 'run-details-content' }),
}));

jest.mock('@/components/RunSummaryPanel', () => ({
  RunSummaryPanel: () => React.createElement('div', { 'data-testid': 'run-summary-panel' }),
}));

jest.mock('@/components/ui/card', () => ({
  Card: ({ children, ...props }: any) => React.createElement('div', props, children),
  CardContent: ({ children, ...props }: any) => React.createElement('div', props, children),
}));

jest.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: any) => React.createElement('button', props, children),
}));

jest.mock('@/components/ui/badge', () => ({
  Badge: ({ children, ...props }: any) => React.createElement('span', props, children),
}));

jest.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: any) => React.createElement('div', null, children),
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
const mockGetByExperimentRun = asyncRunStorage.getByExperimentRun as jest.MockedFunction<typeof asyncRunStorage.getByExperimentRun>;
const mockGetAllTestCases = asyncTestCaseStorage.getAll as jest.MockedFunction<typeof asyncTestCaseStorage.getAll>;
const mockGetReportById = asyncRunStorage.getReportById as jest.MockedFunction<typeof asyncRunStorage.getReportById>;

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
      mockGetByExperimentRun.mockResolvedValue(reports);

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
      mockGetByExperimentRun.mockResolvedValue(reports);

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
      mockGetByExperimentRun.mockResolvedValue(reports);

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
      mockGetByExperimentRun.mockResolvedValue(reports);

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
      mockGetByExperimentRun.mockResolvedValue(reports);

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
      mockGetByExperimentRun.mockResolvedValue(reports);

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
});
