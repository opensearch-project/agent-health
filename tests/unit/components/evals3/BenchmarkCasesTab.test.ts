/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { BenchmarkCasesTab, CaseHeatStrip } from '@/components/evals3/BenchmarkCasesTab';
import type { BenchmarkRun, EvaluationReport, TestCase } from '@/types';

jest.mock('@/components/ui/markdown', () => ({
  Markdown: ({ children }: { children: string }) => React.createElement('div', null, children),
}));

// The tab receives the SUMMARY projection and fetches the selected case in
// full by id (#591). Default: resolve with the fixture case of that id.
const mockGetById = jest.fn();
jest.mock('@/services/storage', () => ({
  asyncTestCaseStorage: { getById: (...a: unknown[]) => mockGetById(...a) },
}));

const onSelectCase = jest.fn();
const onClearCase = jest.fn();
const onOpenRuns = jest.fn();

const testCases: TestCase[] = [
  {
    id: 'case-failing',
    name: 'Failing cache case',
    description: 'Inspect the cache implementation',
    labels: ['difficulty:Easy'],
    category: 'RCA',
    difficulty: 'Easy',
    currentVersion: 1,
    versions: [],
    isPromoted: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    initialPrompt: 'Find the cache bug',
    expectedOutcomes: ['Identify stale reads'],
    context: [],
    sourceFile: 'benchmarks/cache.eval.ts',
    sourceHash: 'abc123',
    expectedTrajectory: [
      { step: 1, description: 'Inspect cache', requiredTools: ['read_file'] },
      { step: 2, description: 'Explain fix', requiredTools: [] },
    ],
    followUpQuestions: [
      {
        trigger: 'on_failure',
        question: 'What guard would prevent recurrence?',
        businessValue: 'Reduce repeat incidents',
      },
    ],
  } as TestCase,
  {
    id: 'case-stable',
    name: 'Stable auth case',
    labels: [],
    category: 'RCA',
    difficulty: 'Medium',
    currentVersion: 1,
    versions: [],
    isPromoted: false,
    createdAt: '2026-01-02T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    initialPrompt: 'Validate the token',
    context: [],
  } as TestCase,
  {
    id: 'case-unrun',
    name: 'Unrun storage case',
    labels: [],
    category: 'RCA',
    difficulty: undefined,
    currentVersion: 1,
    versions: [],
    isPromoted: false,
    createdAt: '2026-01-03T00:00:00.000Z',
    updatedAt: '2026-01-03T00:00:00.000Z',
    initialPrompt: 'Inspect storage',
    context: [],
  } as TestCase,
];

const runs: BenchmarkRun[] = [
  {
    id: 'run-new',
    name: 'Newest run',
    createdAt: '2026-02-03T00:00:00.000Z',
    status: 'completed',
    results: {
      'case-failing': { status: 'completed', reportId: 'report-fail' },
      'case-stable': { status: 'completed', reportId: 'report-pass-new' },
    },
  } as BenchmarkRun,
  {
    id: 'run-old',
    name: 'Older run',
    createdAt: '2026-02-02T00:00:00.000Z',
    status: 'completed',
    results: {
      'case-failing': { status: 'completed', reportId: 'report-pass-old' },
      'case-stable': { status: 'completed', reportId: 'report-pass-old' },
    },
  } as BenchmarkRun,
];

const reportsById = {
  'report-fail': { passFailStatus: 'failed', metricsStatus: 'completed' },
  'report-pass-new': { passFailStatus: 'passed', metricsStatus: 'completed' },
  'report-pass-old': { passFailStatus: 'passed', metricsStatus: 'completed' },
} as Record<string, EvaluationReport>;

beforeEach(() => {
  mockGetById.mockReset();
  mockGetById.mockImplementation(async (id: string) => testCases.find(tc => tc.id === id) ?? null);
});

function renderTab(selectedCaseId?: string) {
  return render(React.createElement(
    MemoryRouter,
    null,
    React.createElement(BenchmarkCasesTab, {
      benchmarkId: 'bench-review',
      testCases,
      recentRuns: runs,
      allRuns: runs,
      totalRuns: 7,
      reportsById,
      selectedCaseId,
      onSelectCase,
      onClearCase,
      onOpenRuns,
    }),
  ));
}

function touchEvent(type: string, touches: Array<{ clientX: number; clientY: number }>) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, type === 'touchend' ? 'changedTouches' : 'touches', {
    value: touches,
  });
  if (type === 'touchend') Object.defineProperty(event, 'touches', { value: [] });
  return event;
}

class MockIntersectionObserver implements IntersectionObserver {
  static instances: MockIntersectionObserver[] = [];
  readonly root: Element | Document | null = null;
  readonly rootMargin = '';
  readonly thresholds: ReadonlyArray<number> = [];
  private readonly callback: IntersectionObserverCallback;

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    MockIntersectionObserver.instances.push(this);
  }

  observe = jest.fn();
  unobserve = jest.fn();
  disconnect = jest.fn();
  takeRecords = jest.fn(() => []);

  trigger(isIntersecting: boolean) {
    this.callback([{ isIntersecting } as IntersectionObserverEntry], this);
  }
}

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: jest.fn().mockImplementation((query: string) => ({
      matches: query.includes('max-width'),
      media: query,
      onchange: null,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      addListener: jest.fn(),
      removeListener: jest.fn(),
      dispatchEvent: jest.fn(),
    })),
  });
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    value: jest.fn(),
  });
  (globalThis as any).CSS ??= {};
  (globalThis as any).CSS.escape = (value: string) => value;
  globalThis.requestAnimationFrame = callback => {
    callback(0);
    return 1;
  };
  globalThis.cancelAnimationFrame = jest.fn();
  (globalThis as any).IntersectionObserver = MockIntersectionObserver;
});

beforeEach(() => {
  jest.clearAllMocks();
  MockIntersectionObserver.instances = [];
});

describe('BenchmarkCasesTab', () => {
  it('renders suite health, difficulty rollups, attention cases, and recent runs', () => {
    renderTab();

    expect(screen.getByTestId('benchmark-cases-tab')).toBeTruthy();
    expect(screen.getAllByText('Suite health')).toHaveLength(2);
    expect(screen.getAllByText('7')).not.toHaveLength(0);
    expect(screen.getAllByText('Easy')).not.toHaveLength(0);
    expect(screen.getAllByText('Medium')).not.toHaveLength(0);
    expect(screen.getAllByText('Unspecified')).not.toHaveLength(0);
    expect(screen.getAllByText('Failing cache case')).not.toHaveLength(0);
    expect(screen.getAllByText('Newest run')).not.toHaveLength(0);

    fireEvent.click(screen.getAllByRole('button', { name: 'View Runs' })[0]);
    expect(onOpenRuns).toHaveBeenCalledTimes(1);

    const attentionCase = screen.getAllByRole('button', { name: /Failing cache case/ })
      .find(button => !button.hasAttribute('role'))!;
    fireEvent.click(attentionCase);
    expect(onSelectCase).toHaveBeenCalledWith('case-failing');
  });

  it('filters and searches the master list and handles keyboard navigation', () => {
    renderTab();

    fireEvent.click(screen.getByRole('button', { name: /Stable 1/ }));
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByRole('option', { name: /Stable auth case/ })).toBeTruthy();

    fireEvent.change(screen.getByRole('textbox', { name: 'Search cases by name or prompt' }), {
      target: { value: 'does not exist' },
    });
    expect(screen.getByText('No cases match this view.')).toBeTruthy();

    fireEvent.change(screen.getByRole('textbox', { name: 'Search cases by name or prompt' }), {
      target: { value: '' },
    });
    fireEvent.keyDown(document.body, { key: 'ArrowDown' });
    expect(onSelectCase).toHaveBeenCalledWith('case-stable');
  });

  it('renders full selected-case provenance, trajectory, follow-ups, and pager controls', async () => {
    renderTab('case-failing');

    expect(screen.getByTestId('case-detail-pane')).toBeTruthy();
    expect(await screen.findByText('Provenance')).toBeTruthy();
    expect(mockGetById).toHaveBeenCalledWith('case-failing');
    expect(screen.getByText('benchmarks/cache.eval.ts')).toBeTruthy();
    expect(screen.getByText('sha256:abc123')).toBeTruthy();
    expect(screen.getByText('Expected Trajectory')).toBeTruthy();
    expect(screen.getByText('read_file')).toBeTruthy();
    expect(screen.getByText('Follow-up Questions')).toBeTruthy();
    expect(screen.getByText('What guard would prevent recurrence?')).toBeTruthy();
    expect(screen.getByTitle('Newest run: Failed — open run report').getAttribute('href')).toBe(
      '/evaluations/benchmarks/bench-review/runs/run-new/inspect',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Next case' }));
    expect(onSelectCase).toHaveBeenCalledWith('case-stable');
    fireEvent.click(screen.getByRole('button', { name: /Suite health/ }));
    expect(onClearCase).toHaveBeenCalled();
  });

  it('moves the mobile pager to the next case after a horizontal swipe', async () => {
    jest.useFakeTimers();
    renderTab('case-failing');
    await act(async () => {}); // let the per-id full fetch settle
    const pager = document.querySelector('[data-mobile-case-pager]')!;

    pager.dispatchEvent(touchEvent('touchstart', [{ clientX: 120, clientY: 20 }]));
    pager.dispatchEvent(touchEvent('touchmove', [{ clientX: 40, clientY: 22 }]));
    pager.dispatchEvent(touchEvent('touchend', [{ clientX: 40, clientY: 22 }]));
    act(() => jest.advanceTimersByTime(1000));

    expect(onSelectCase).toHaveBeenCalledWith('case-stable');
    jest.useRealTimers();
  });

  it('shows the needs-attention filter predicate as a tooltip (PR #447 review question)', () => {
    renderTab();
    const button = screen.getByTestId('case-filter-needs-attention');
    expect(button.getAttribute('title')).toMatch(/last 3 completed runs/);
  });

  it('shows no historical-version notice when every run matches the current case version', async () => {
    renderTab('case-failing');
    await act(async () => {}); // let the per-id full fetch settle
    expect(screen.queryByTestId('historical-version-notice')).toBeNull();
  });

  it('shows a historical-version notice when a run evaluated an older case definition', async () => {
    const versionedCase = {
      id: 'case-versioned',
      name: 'Versioned case',
      labels: [],
      category: 'RCA',
      difficulty: 'Easy',
      currentVersion: 2,
      versions: [],
      isPromoted: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      initialPrompt: 'Prompt',
      context: [],
    } as TestCase;

    const versionedRuns: BenchmarkRun[] = [{
      id: 'run-v1',
      name: 'Run at v1',
      createdAt: '2026-01-05T00:00:00.000Z',
      status: 'completed',
      results: { 'case-versioned': { status: 'completed', reportId: 'report-v1' } },
    } as BenchmarkRun];

    const versionedReports = {
      'report-v1': { passFailStatus: 'passed', testCaseVersion: 1 },
    } as Record<string, EvaluationReport>;

    render(React.createElement(
      MemoryRouter,
      null,
      React.createElement(BenchmarkCasesTab, {
        benchmarkId: 'bench-versioned',
        testCases: [versionedCase],
        recentRuns: versionedRuns,
        allRuns: versionedRuns,
        totalRuns: 1,
        reportsById: versionedReports,
        selectedCaseId: 'case-versioned',
        onSelectCase,
        onClearCase,
        onOpenRuns,
      }),
    ));

    await act(async () => {}); // let the per-id full fetch settle
    const notice = screen.getByTestId('historical-version-notice');
    expect(notice.textContent).toMatch(/v2/);
  });

  describe('selected-case definition comes from a per-id full fetch (#591)', () => {
    /** What the list hands the tab: the summary projection of the fixture. */
    const summaryOf = (tc: TestCase): TestCase => ({
      ...tc,
      initialPrompt: tc.initialPrompt.length > 20 ? `${tc.initialPrompt.slice(0, 20)}...` : tc.initialPrompt,
      expectedOutcomes: [],
      context: [],
      versions: [],
    });
    const fullCases: TestCase[] = [
      { ...testCases[0], id: 'case-a', name: 'Duplicate name', initialPrompt: 'Full prompt for case A, long enough to be truncated', expectedOutcomes: ['Outcome only A has'] },
      { ...testCases[1], id: 'case-b', name: 'Duplicate name', initialPrompt: 'Full prompt for case B, long enough to be truncated', expectedOutcomes: ['Outcome only B has'] },
      { ...testCases[2], id: 'case-c', name: 'Third case', initialPrompt: 'Full prompt for case C, long enough to be truncated', expectedOutcomes: ['Outcome only C has'] },
    ];
    const summaries = fullCases.map(summaryOf);
    const deferred = () => {
      let resolve!: (v: TestCase | null) => void;
      let reject!: (e: unknown) => void;
      const promise = new Promise<TestCase | null>((res, rej) => { resolve = res; reject = rej; });
      return { promise, resolve, reject };
    };

    function renderSummaries(selectedCaseId?: string) {
      return render(React.createElement(
        MemoryRouter,
        null,
        React.createElement(BenchmarkCasesTab, {
          benchmarkId: 'bench-summary',
          testCases: summaries,
          recentRuns: [],
          allRuns: [],
          totalRuns: 0,
          reportsById: {},
          selectedCaseId,
          onSelectCase,
          onClearCase,
          onOpenRuns,
        }),
      ));
    }

    it('shows a loading row (never the truncated summary) until the full document arrives, then its prompt and outcomes', async () => {
      const pending = deferred();
      mockGetById.mockReturnValueOnce(pending.promise);
      renderSummaries('case-a');

      expect(mockGetById).toHaveBeenCalledTimes(1);
      expect(mockGetById).toHaveBeenCalledWith('case-a');
      expect(screen.getByTestId('case-definition-loading')).toBeTruthy();
      expect(screen.getByTestId('case-definition').getAttribute('data-status')).toBe('loading');
      expect(screen.queryByText(/Full prompt for case A, long/)).toBeNull();

      await act(async () => { pending.resolve(fullCases[0]); });

      expect(screen.queryByTestId('case-definition-loading')).toBeNull();
      expect(screen.getByText('Full prompt for case A, long enough to be truncated')).toBeTruthy();
      expect(screen.getByText('Outcome only A has')).toBeTruthy();
      expect(screen.getByTestId('case-definition').getAttribute('data-case-id')).toBe('case-a');
      expect(screen.getByTestId('case-definition').getAttribute('data-status')).toBe('ready');
    });

    it('ignores a late response for a previous selection and caches per id (two cases share a name)', async () => {
      const a = deferred();
      const b = deferred();
      mockGetById.mockImplementation((id: string) => (id === 'case-a' ? a.promise : id === 'case-b' ? b.promise : Promise.resolve(null)));
      const view = renderSummaries('case-a');
      const rerenderWith = (id: string) => view.rerender(React.createElement(
        MemoryRouter,
        null,
        React.createElement(BenchmarkCasesTab, {
          benchmarkId: 'bench-summary',
          testCases: summaries,
          recentRuns: [],
          allRuns: [],
          totalRuns: 0,
          reportsById: {},
          selectedCaseId: id,
          onSelectCase,
          onClearCase,
          onOpenRuns,
        }),
      ));

      // Select B before A's document arrives, then let A's response land late.
      rerenderWith('case-b');
      expect(mockGetById).toHaveBeenCalledWith('case-b');
      await act(async () => { a.resolve(fullCases[0]); });
      expect(screen.getByTestId('case-definition').getAttribute('data-case-id')).toBe('case-b');
      expect(screen.getByTestId('case-definition-loading')).toBeTruthy();
      expect(screen.queryByText('Outcome only A has')).toBeNull();

      await act(async () => { b.resolve(fullCases[1]); });
      expect(screen.getByText('Outcome only B has')).toBeTruthy();
      expect(screen.queryByText('Outcome only A has')).toBeNull();

      // Back to A: served from the per-id cache, no second request, no loader.
      const callsBefore = mockGetById.mock.calls.length;
      rerenderWith('case-a');
      expect(screen.queryByTestId('case-definition-loading')).toBeNull();
      expect(screen.getByText('Outcome only A has')).toBeTruthy();
      expect(mockGetById.mock.calls.length).toBe(callsBefore);
    });

    it('shows an error note with Retry when the full fetch fails (never the summary dressed as the full doc), and Retry refetches', async () => {
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
      mockGetById.mockRejectedValueOnce(new Error('storage down'));
      renderSummaries('case-c');

      await waitFor(() => expect(screen.getByTestId('case-definition-error')).toBeTruthy());
      const pane = screen.getByTestId('case-definition');
      expect(pane.getAttribute('data-status')).toBe('error');
      expect(screen.queryByTestId('case-definition-loading')).toBeNull();
      // Neither the truncated summary prompt nor the (absent) outcomes are shown as if they were the definition.
      expect(pane.textContent).not.toContain('Full prompt for case');
      expect(pane.textContent).not.toContain('Outcome only C has');
      expect(consoleError).toHaveBeenCalled();

      // Retry: the mock now succeeds (default implementation) and the pane becomes ready.
      mockGetById.mockImplementation(async (id: string) => fullCases.find(tc => tc.id === id) ?? null);
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
      await waitFor(() => expect(pane.getAttribute('data-status')).toBe('ready'));
      expect(screen.getByText('Outcome only C has')).toBeTruthy();
      expect(mockGetById).toHaveBeenCalledTimes(2);
      consoleError.mockRestore();
    });

    it('A → B → A while A is still in flight reuses A\'s request (one fetch per case) and treats a 404 as an error', async () => {
      const a = deferred();
      mockGetById.mockImplementation((id: string) => (id === 'case-a' ? a.promise : Promise.resolve(null)));
      const view = renderSummaries('case-a');
      const rerenderWith = (id: string, cases: TestCase[] = summaries) => view.rerender(React.createElement(
        MemoryRouter,
        null,
        React.createElement(BenchmarkCasesTab, {
          benchmarkId: 'bench-summary',
          testCases: cases,
          recentRuns: [],
          allRuns: [],
          totalRuns: 0,
          reportsById: {},
          selectedCaseId: id,
          onSelectCase,
          onClearCase,
          onOpenRuns,
        }),
      ));

      rerenderWith('case-b');
      await waitFor(() => expect(screen.getByTestId('case-definition-error')).toBeTruthy()); // 404 → error, not a blank pane
      rerenderWith('case-a');
      expect(screen.getByTestId('case-definition').getAttribute('data-status')).toBe('loading');
      // Exactly one request for A despite leaving and coming back while it was pending.
      expect(mockGetById.mock.calls.filter(c => c[0] === 'case-a')).toHaveLength(1);

      await act(async () => { a.resolve(fullCases[0]); });
      expect(screen.getByText('Outcome only A has')).toBeTruthy();

      // A new version of the same case on the polled list invalidates the cached document.
      mockGetById.mockImplementation(async (id: string) => (id === 'case-a' ? { ...fullCases[0], currentVersion: 2, expectedOutcomes: ['Outcome of A v2'] } : null));
      rerenderWith('case-a', summaries.map(tc => (tc.id === 'case-a' ? { ...tc, currentVersion: 2 } : tc)));
      expect(screen.getByTestId('case-definition').getAttribute('data-status')).toBe('loading');
      await waitFor(() => expect(screen.getByText('Outcome of A v2')).toBeTruthy());
      expect(mockGetById.mock.calls.filter(c => c[0] === 'case-a')).toHaveLength(2);
    });
  });

  it('renders a 400-case benchmark incrementally and loads more when the sentinel intersects', () => {
    const manyCases: TestCase[] = Array.from({ length: 130 }, (_, index) => ({
      id: `case-bulk-${index}`,
      name: `Bulk case ${index}`,
      labels: [],
      category: 'RCA',
      difficulty: 'Easy',
      currentVersion: 1,
      versions: [],
      isPromoted: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      initialPrompt: `Prompt ${index}`,
      context: [],
    } as TestCase));

    render(React.createElement(
      MemoryRouter,
      null,
      React.createElement(BenchmarkCasesTab, {
        benchmarkId: 'bench-bulk',
        testCases: manyCases,
        recentRuns: [],
        allRuns: [],
        totalRuns: 0,
        reportsById: {},
        onSelectCase,
        onClearCase,
        onOpenRuns,
      }),
    ));

    // Only a bounded window renders up front, not all 130 cases at once.
    expect(screen.getAllByRole('option')).toHaveLength(60);
    expect(screen.getByTestId('case-list-load-more-sentinel')).toBeTruthy();

    const observer = MockIntersectionObserver.instances.at(-1);
    expect(observer).toBeDefined();
    act(() => observer!.trigger(true));

    // Crossing the sentinel (infinite scroll) grows the window by another page.
    expect(screen.getAllByRole('option')).toHaveLength(120);
    expect(screen.getByTestId('case-list-load-more-sentinel')).toBeTruthy();

    act(() => MockIntersectionObserver.instances.at(-1)!.trigger(true));

    // The final page renders everything and drops the sentinel.
    expect(screen.getAllByRole('option')).toHaveLength(130);
    expect(screen.queryByTestId('case-list-load-more-sentinel')).toBeNull();
  });
});

describe('CaseHeatStrip', () => {
  it('renders exact case verdict buttons, stops row clicks, and selects a case', () => {
    const onRowClick = jest.fn();
    const renderHeatStrip = (cases: TestCase[]) => React.createElement(
      MemoryRouter,
      null,
      React.createElement(
        'div',
        { onClick: onRowClick },
        React.createElement(CaseHeatStrip, {
          benchmarkId: 'bench-review',
          run: runs[0],
          testCases: cases,
          reportsById,
          onSelectCase,
        }),
      ),
    );
    const { rerender } = render(renderHeatStrip([]));
    expect(screen.queryByLabelText('Newest run case verdicts')).toBeNull();

    rerender(renderHeatStrip(testCases));

    const failed = screen.getByRole('button', { name: 'Failing cache case: Failed' });
    expect(failed.getAttribute('data-case-path')).toBe(
      '/evaluations/benchmarks/bench-review/cases/case-failing',
    );
    fireEvent.click(failed);
    expect(onSelectCase).toHaveBeenCalledWith('case-failing');
    expect(onRowClick).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Stable auth case: Passed' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Unrun storage case: Not run' })).toBeTruthy();
  });
});
