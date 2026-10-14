/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Render tests for DebugLatencyHud -- visible only when page-latency
 * instrumentation is active; a one-number pill for the CURRENT page, and
 * an expanded panel (click pins, hover / Alt peeks) with plain-language rows.
 */

import * as React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';

const mockIsActive = jest.fn();
const mockGetCurrentRecord = jest.fn();
const mockStartNavigation = jest.fn();
const mockSubscribe = jest.fn();
const mockGetOperationStats = jest.fn();
const mockExposeConsoleApi = jest.fn();
const mockRemoveConsoleApi = jest.fn();

jest.mock('@/lib/pageLatency', () => {
  const actual = jest.requireActual('@/lib/pageLatency');
  return {
    exposeConsoleApi: () => mockExposeConsoleApi(),
    removeConsoleApi: () => mockRemoveConsoleApi(),
    isPageLatencyActive: () => mockIsActive(),
    getCurrentRecord: () => mockGetCurrentRecord(),
    startNavigation: (p: string) => mockStartNavigation(p),
    getOperationStats: () => mockGetOperationStats(),
    subscribe: (fn: () => void) => mockSubscribe(fn),
    // pure helpers: use the real ones so the rendered text is the real text
    classifyDuration: actual.classifyDuration,
    classifyPageReady: actual.classifyPageReady,
    formatMs: actual.formatMs,
  };
});

import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { DebugLatencyHud, PageLatencyNavigationBoundary } from '@/components/DebugLatencyHud';

const NO_OPS = { stats: [], totalMeasurements: 0 };

/** A benchmark Runs tab that took 13.6 s, with 37 overlapping requests. */
const SLOW_PAGE = {
  route: 'benchmark-runs',
  startedAt: 0,
  renderMs: 9,
  readyMs: 13_612,
  settledMs: null,
  apiCount: 37,
  apiWallMs: 13_204,
  apiRequests: [
    { method: 'GET', path: '/api/storage/benchmarks/:id', startMs: 12, ms: 310 },
    { method: 'GET', path: '/api/storage/evaluation-runs/:id', startMs: 400, ms: 4_210 },
    { method: 'POST', path: '/api/storage/runs/search', startMs: 420, ms: 3_950 },
    { method: 'GET', path: '/api/storage/evaluation-runs/:id', startMs: 430, ms: 2_100 },
    { method: 'GET', path: '/api/storage/evaluation-runs/:id', startMs: 440, ms: 1_900 },
    { method: 'GET', path: '/api/storage/evaluation-runs/:id', startMs: 450, ms: 1_500 },
    { method: 'GET', path: '/api/storage/evaluators', startMs: 20, ms: 40 },
  ],
};

const FAST_PAGE = {
  route: 'benchmarks', startedAt: 0, renderMs: 36, readyMs: 44, settledMs: null, apiCount: 2, apiWallMs: 30,
  apiRequests: [
    { method: 'GET', path: '/api/storage/benchmarks', startMs: 10, ms: 25 },
    { method: 'GET', path: '/api/storage/evaluators', startMs: 12, ms: 20 },
  ],
};

describe('DebugLatencyHud', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockIsActive.mockReset().mockReturnValue(false);
    mockGetCurrentRecord.mockReset().mockReturnValue(null);
    mockStartNavigation.mockReset();
    mockSubscribe.mockReset().mockReturnValue(() => {});
    mockGetOperationStats.mockReset().mockReturnValue(NO_OPS);
    mockExposeConsoleApi.mockReset();
    mockRemoveConsoleApi.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('renders nothing when instrumentation is inactive', () => {
    const { container } = render(React.createElement(DebugLatencyHud));
    expect(container.innerHTML).toBe('');
  });

  it('renders a placeholder pill when active but no navigation has been recorded yet', () => {
    mockIsActive.mockReturnValue(true);
    render(React.createElement(DebugLatencyHud));
    expect(screen.getByTestId('debug-latency-hud-pill').textContent).toContain('navigate to start measuring');
    fireEvent.click(screen.getByTestId('debug-latency-hud'));
    expect(screen.queryByTestId('debug-latency-hud-panel')).toBeNull(); // nothing to expand yet
  });

  describe('collapsed pill', () => {
    beforeEach(() => mockIsActive.mockReturnValue(true));

    it('is the current route + ONE number (time-to-ready) with a colour dot -- no first paint, no api numbers, no legend', () => {
      mockGetCurrentRecord.mockReturnValue(SLOW_PAGE);
      render(React.createElement(DebugLatencyHud));
      const pill = screen.getByTestId('debug-latency-hud-pill');
      expect(pill.textContent).toBe('● benchmark-runs · 13.6 s');
      expect(screen.getByTestId('debug-latency-hud-dot').getAttribute('data-band')).toBe('slow');
      expect(pill.textContent).not.toMatch(/render|paint|api|ms/i);
    });

    it('bands the dot by page-level thresholds (a 44 ms page is green, not "slow" by the 50 ms step threshold)', () => {
      mockGetCurrentRecord.mockReturnValue(FAST_PAGE);
      render(React.createElement(DebugLatencyHud));
      expect(screen.getByTestId('debug-latency-hud-pill').textContent).toBe('● benchmarks · 44 ms');
      expect(screen.getByTestId('debug-latency-hud-dot').getAttribute('data-band')).toBe('fast');
    });

    it('shows an ellipsis and a neutral dot until the page is ready', () => {
      mockGetCurrentRecord.mockReturnValue({ ...FAST_PAGE, readyMs: null, settledMs: null });
      render(React.createElement(DebugLatencyHud));
      expect(screen.getByTestId('debug-latency-hud-pill').textContent).toBe('● benchmarks · …');
      expect(screen.getByTestId('debug-latency-hud-dot').getAttribute('data-band')).toBe('pending');
    });

    it('falls back to the automatic settle estimate for pages that never report ready', () => {
      mockGetCurrentRecord.mockReturnValue({ ...FAST_PAGE, route: '/settings', readyMs: null, settledMs: 812 });
      render(React.createElement(DebugLatencyHud));
      expect(screen.getByTestId('debug-latency-hud-pill').textContent).toBe('● /settings · 812 ms');
    });
  });

  describe('expanded panel', () => {
    beforeEach(() => {
      mockIsActive.mockReturnValue(true);
      mockGetCurrentRecord.mockReturnValue(SLOW_PAGE);
    });

    it('click pins it open (second click unpins), independent of hover', () => {
      render(React.createElement(DebugLatencyHud));
      const hud = screen.getByTestId('debug-latency-hud');
      expect(screen.queryByTestId('debug-latency-hud-panel')).toBeNull();

      fireEvent.click(hud);
      expect(screen.getByTestId('debug-latency-hud-panel')).toBeTruthy();
      fireEvent.mouseLeave(hud); // pinned: leaving does not collapse it
      expect(screen.getByTestId('debug-latency-hud-panel')).toBeTruthy();

      fireEvent.click(hud);
      expect(screen.queryByTestId('debug-latency-hud-panel')).toBeNull();
    });

    it('holding \u2325 / Alt peeks; releasing (or window blur) collapses; auto-repeat and other keys are ignored', () => {
      render(React.createElement(DebugLatencyHud));
      fireEvent.keyDown(window, { key: 'Alt', repeat: true });
      expect(screen.queryByTestId('debug-latency-hud-panel')).toBeNull();
      fireEvent.keyDown(window, { key: 'Alt' });
      expect(screen.getByTestId('debug-latency-hud-panel')).toBeTruthy();
      fireEvent.keyUp(window, { key: 'Alt' });
      expect(screen.queryByTestId('debug-latency-hud-panel')).toBeNull();

      fireEvent.keyDown(window, { key: 'Alt' });
      fireEvent.blur(window);
      expect(screen.queryByTestId('debug-latency-hud-panel')).toBeNull();
      fireEvent.keyDown(window, { key: 'Shift' });
      expect(screen.queryByTestId('debug-latency-hud-panel')).toBeNull();
    });

    it('shows plain-language rows for the current page: Page ready, First paint, API count + wall span, and the 5 slowest requests', () => {
      render(React.createElement(DebugLatencyHud));
      fireEvent.click(screen.getByTestId('debug-latency-hud'));

      expect(screen.getByTestId('debug-latency-hud-ready').textContent).toBe('13.6 s');
      expect(screen.getByTestId('debug-latency-hud-paint').textContent).toBe('First paint9 ms');
      expect(screen.getByTestId('debug-latency-hud-paint').getAttribute('title')).toMatch(/first frame/i);
      expect(screen.getByTestId('debug-latency-hud-api').textContent).toBe('API37 requests · 13.2 s wall');

      const requests = screen.getAllByTestId('debug-latency-hud-request');
      expect(requests).toHaveLength(5);
      expect(requests.map(r => r.textContent)).toEqual([
        'GET /api/storage/evaluation-runs/:id4.2 s',
        'POST /api/storage/runs/search4.0 s',
        'GET /api/storage/evaluation-runs/:id2.1 s',
        'GET /api/storage/evaluation-runs/:id1.9 s',
        'GET /api/storage/evaluation-runs/:id1.5 s',
      ]);
      // the wall span can never exceed the page's own time-to-ready
      expect(SLOW_PAGE.apiWallMs).toBeLessThanOrEqual(SLOW_PAGE.readyMs);
    });

    it('never shows a legend, a navigation history, a previous page, or a summed API duration', () => {
      render(React.createElement(DebugLatencyHud));
      fireEvent.click(screen.getByTestId('debug-latency-hud'));
      const text = screen.getByTestId('debug-latency-hud-panel').textContent!;
      expect(text).not.toMatch(/< 50 ms|< 200 ms|≥ 200 ms|Last \d+ navigations|prev page|Operations|measurements|render /);
      expect(text).not.toContain('185'); // 37 × ~5 s summed would be ~185 s -- must not appear anywhere
    });

    it('marks an automatic (estimated) readiness with ~ and says "no requests" for a page without API calls', () => {
      mockGetCurrentRecord.mockReturnValue({ ...FAST_PAGE, route: '/settings', readyMs: null, settledMs: 812, apiCount: 0, apiWallMs: 0, apiRequests: [] });
      render(React.createElement(DebugLatencyHud));
      fireEvent.click(screen.getByTestId('debug-latency-hud'));
      expect(screen.getByTestId('debug-latency-hud-ready').textContent).toBe('812 ms ~');
      expect(screen.getByTestId('debug-latency-hud-api').textContent).toBe('APIno requests');
      expect(screen.queryAllByTestId('debug-latency-hud-request')).toHaveLength(0);
    });

    it('renders the "Slow steps on this page" section only when the page recorded steps (no placeholder otherwise), capped at 3 rows', () => {
      render(React.createElement(DebugLatencyHud));
      fireEvent.click(screen.getByTestId('debug-latency-hud'));
      expect(screen.queryByTestId('debug-latency-hud-operations')).toBeNull();
      expect(screen.getByTestId('debug-latency-hud-panel').textContent).not.toMatch(/No operation timings|Slow steps/);
    });

    it('lists recorded steps slowest first with a colour dot, capped at 3', () => {
      mockGetOperationStats.mockReturnValue({
        totalMeasurements: 5,
        stats: [
          { name: 'AgentTracesPage.fetchMore', label: 'fetchMore', group: 'AgentTracesPage', avgMs: 312.4, minMs: 300, maxMs: 324.8, count: 2 },
          { name: 'TraceFlowView.flowTransform', label: 'flowTransform', group: 'TraceFlowView', avgMs: 120, minMs: 120, maxMs: 120, count: 1 },
          { name: 'TraceFlowView.preprocessing', label: 'preprocessing', group: 'TraceFlowView', avgMs: 41.7, minMs: 35, maxMs: 48, count: 1 },
          { name: 'x.y', label: 'y', group: 'x', avgMs: 1, minMs: 1, maxMs: 1, count: 1 },
        ],
      });
      render(React.createElement(DebugLatencyHud));
      fireEvent.click(screen.getByTestId('debug-latency-hud'));
      const ops = screen.getByTestId('debug-latency-hud-operations');
      expect(ops.textContent).toContain('Slow steps on this page');
      const rows = screen.getAllByTestId('debug-latency-hud-op');
      expect(rows).toHaveLength(3);
      expect(rows[0].textContent).toBe('● fetchMore · AgentTracesPage312 ms ×2');
      expect(rows[0].querySelector('.text-red-400')).toBeTruthy();
      expect(rows[1].querySelector('.text-yellow-400')).toBeTruthy();
      expect(rows[2].querySelector('.text-green-400')).toBeTruthy();
      expect(ops.textContent).not.toMatch(/< 50 ms/); // no legend
    });

    it('"hide" dismisses the HUD for the rest of the page load without toggling anything else', () => {
      render(React.createElement(DebugLatencyHud));
      fireEvent.click(screen.getByTestId('debug-latency-hud'));
      fireEvent.click(screen.getByTestId('debug-latency-hud-hide'));
      expect(screen.queryByTestId('debug-latency-hud')).toBeNull();
      act(() => { jest.advanceTimersByTime(2100); });
      expect(screen.queryByTestId('debug-latency-hud')).toBeNull();
    });

    it('re-reads the record when the subscription fires, deferred to a microtask and coalesced (never setState mid-render)', async () => {
      let notifyFn: (() => void) | null = null;
      mockSubscribe.mockImplementation((fn: () => void) => { notifyFn = fn; return () => {}; });
      mockGetCurrentRecord.mockReturnValue({ ...SLOW_PAGE, readyMs: null });
      render(React.createElement(DebugLatencyHud));
      expect(screen.getByTestId('debug-latency-hud-pill').textContent).toBe('● benchmark-runs · …');

      mockGetCurrentRecord.mockReturnValue(SLOW_PAGE);
      notifyFn!();
      notifyFn!();
      notifyFn!(); // a burst of settled requests
      expect(mockGetCurrentRecord).toHaveBeenCalledTimes(2); // initial useState + refresh(); the burst has NOT read yet
      expect(screen.getByTestId('debug-latency-hud-pill').textContent).toBe('● benchmark-runs · …');
      await act(async () => { await Promise.resolve(); });
      expect(mockGetCurrentRecord).toHaveBeenCalledTimes(3); // one coalesced re-read for the whole burst
      expect(screen.getByTestId('debug-latency-hud-pill').textContent).toBe('● benchmark-runs · 13.6 s');
    });
  });

  it('polls isPageLatencyActive so a debug-mode toggle in another tab is picked up without a remount', () => {
    render(React.createElement(DebugLatencyHud));
    expect(screen.queryByTestId('debug-latency-hud')).toBeNull();
    mockIsActive.mockReturnValue(true);
    mockGetCurrentRecord.mockReturnValue(FAST_PAGE);
    act(() => { jest.advanceTimersByTime(1100); });
    expect(screen.getByTestId('debug-latency-hud')).toBeTruthy();
  });

  describe('PageLatencyNavigationBoundary', () => {
    it('opens the navigation window BEFORE a sibling page rendered after it runs its own effect (where pages fire their first fetches)', () => {
      const order: string[] = [];
      mockStartNavigation.mockImplementation((p: string) => order.push(`startNavigation:${p}`));
      const Page: React.FC = () => {
        React.useEffect(() => { order.push('page-effect'); }, []);
        return null;
      };
      render(
        React.createElement(MemoryRouter, { initialEntries: ['/evaluations/benchmarks'] },
          React.createElement(PageLatencyNavigationBoundary),
          React.createElement(Routes, null, React.createElement(Route, { path: '*', element: React.createElement(Page) })),
        ),
      );
      expect(order).toEqual(['startNavigation:/evaluations/benchmarks', 'page-effect']);
    });
  });

  it('exposes the DevTools console API while active and removes it on unmount', () => {
    mockIsActive.mockReturnValue(true);
    const { unmount } = render(React.createElement(DebugLatencyHud));
    expect(mockExposeConsoleApi).toHaveBeenCalledTimes(1);
    unmount();
    expect(mockRemoveConsoleApi).toHaveBeenCalledTimes(1);
  });
});
