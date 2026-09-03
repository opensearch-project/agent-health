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
import { render, screen, waitFor, act } from '@testing-library/react';
import type { Benchmark, BenchmarkRun } from '@/types';

const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({
  useParams: () => ({ benchmarkId: 'bench-1' }),
  useNavigate: () => mockNavigate,
  useLocation: () => ({ pathname: '/evaluations/benchmarks/bench-1/runs' }),
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

jest.mock('@/components/evals3/Breadcrumbs', () => ({
  Breadcrumbs: ({ actions }: { actions?: React.ReactNode }) =>
    React.createElement('nav', { 'data-testid': 'breadcrumbs' }, actions),
}));

jest.mock('@/components/BenchmarkEditor', () => ({
  BenchmarkEditor: () => null,
}));

// BenchmarkCasesTab/CaseHeatStrip pull in a deep chain (BenchmarkCaseDefinition
// -> TestCaseDetailPanel -> ContextDispositionGroups -> components/ui/markdown.tsx
// -> react-markdown, which is ESM-only and not in this suite's ts-jest
// transformIgnorePatterns allow-list). This test suite doesn't exercise the
// Cases tab UI at all, so stub both out rather than pull that chain in for
// every test in this file.
jest.mock('@/components/evals3/BenchmarkCasesTab', () => ({
  BenchmarkCasesTab: () => null,
  CaseHeatStrip: () => null,
}));

jest.mock('@/components/JudgeModelSelect', () => ({
  JudgeModelSelect: () => null,
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
    const card = screen.getByText('Claude-code with traces').closest('.p-4') as HTMLElement;
    expect(card.textContent).toContain('Running');
    // Planned total (62), not just the 9 cases that have started.
    expect(card.textContent).toContain('62');
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
    const card = screen.getByText('Claude-code with traces').closest('.p-4') as HTMLElement;
    expect(card.querySelector('[title="Delete run"]')).toBeNull();
    expect(card.textContent).not.toContain('Cancel');
  });

  it('still renders Delete for a genuinely embedded run', async () => {
    mockGetById.mockResolvedValue(makeBenchmark());
    await renderPage();

    await waitFor(() => expect(screen.getByText('Embedded Run')).toBeTruthy());
    const card = screen.getByText('Embedded Run').closest('.p-4') as HTMLElement;
    expect(card.querySelector('[title="Delete run"]')).toBeTruthy();
  });

  it('is resilient to the evaluation-runs fetch failing (embedded runs still render)', async () => {
    mockGetById.mockResolvedValue(makeBenchmark());
    mockListEvaluationRuns.mockRejectedValue(new Error('network error'));
    await renderPage();

    await waitFor(() => expect(screen.getByText('Embedded Run')).toBeTruthy());
  });
});
