/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for lib/pageLatency.ts -- the debug/dev-only per-page latency
 * instrumentation behind the DebugLatencyHud.
 *
 * Covers: complete no-op when inactive (the "zero behaviour change when
 * debug is off" contract), routeKeyFromPath's route-pattern mapping,
 * render/ready timing, /api/* fetch aggregation scoped to the active
 * navigation, the stale-routeKey guard, the automatic settle estimate for
 * non-instrumented routes, request templating / wall-clock span, and the
 * debug() logger call on finalize.
 */

jest.mock('@/lib/debug', () => ({
  isDebugEnabled: jest.fn(() => false),
  debug: jest.fn(),
}));

import { isDebugEnabled, debug as debugLog } from '@/lib/debug';
import * as pageLatency from '@/lib/pageLatency';
import * as perf from '@/lib/performance';

/** Records one lib/performance measurement of exactly `ms` (mocking performance.now). */
function record(name: string, ms: number): void {
  const nowSpy = jest.spyOn(performance, 'now');
  nowSpy.mockReturnValueOnce(1000).mockReturnValueOnce(1000 + ms);
  perf.startMeasure(name);
  perf.endMeasure(name, false);
  nowSpy.mockRestore();
}

describe('lib/pageLatency', () => {
  const mockIsDebugEnabled = isDebugEnabled as jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    mockIsDebugEnabled.mockReset().mockReturnValue(false);
    (debugLog as jest.Mock).mockReset();
    pageLatency.__resetPageLatencyForTests();
  });

  afterEach(() => {
    pageLatency.__resetPageLatencyForTests();
    jest.useRealTimers();
  });

  describe('routeKeyFromPath', () => {
    it('maps benchmark/eval-run inspector routes (most specific) to run-inspector', () => {
      expect(pageLatency.routeKeyFromPath('/evaluations/benchmarks/bench-1/runs/run-1/inspect')).toBe('run-inspector');
      expect(pageLatency.routeKeyFromPath('/evaluations/runs/run-1/inspect')).toBe('run-inspector');
    });

    it('maps benchmark detail/cases/runs routes to benchmark-runs', () => {
      expect(pageLatency.routeKeyFromPath('/evaluations/benchmarks/bench-1')).toBe('benchmark-runs');
      expect(pageLatency.routeKeyFromPath('/evaluations/benchmarks/bench-1/cases/case-1')).toBe('benchmark-runs');
      expect(pageLatency.routeKeyFromPath('/evaluations/benchmarks/bench-1/runs')).toBe('benchmark-runs');
    });

    it('maps the bare list routes to benchmarks / eval-runs', () => {
      expect(pageLatency.routeKeyFromPath('/evaluations/benchmarks')).toBe('benchmarks');
      expect(pageLatency.routeKeyFromPath('/evaluations/runs')).toBe('eval-runs');
    });

    it('maps /compare routes to comparison and /agent-traces to traces', () => {
      expect(pageLatency.routeKeyFromPath('/compare')).toBe('comparison');
      expect(pageLatency.routeKeyFromPath('/compare/bench-1')).toBe('comparison');
      expect(pageLatency.routeKeyFromPath('/agent-traces')).toBe('traces');
    });

    it('falls back to the raw pathname for an unmapped route', () => {
      expect(pageLatency.routeKeyFromPath('/settings')).toBe('/settings');
    });
  });

  describe('templatePath', () => {
    it('drops the query string and collapses id-like segments to :id', () => {
      expect(pageLatency.templatePath('http://localhost:4001/api/storage/benchmarks/bench-1716800000000-k3j2h1/runs?limit=50')).toBe('/api/storage/benchmarks/:id/runs');
      expect(pageLatency.templatePath('/api/storage/runs/3f2504e0-4f89-11d3-9a0c-0305e82c3301')).toBe('/api/storage/runs/:id');
      expect(pageLatency.templatePath('/api/storage/test-cases/42/versions/7')).toBe('/api/storage/test-cases/:id/versions/:id');
      expect(pageLatency.templatePath('/api/storage/test-cases/tc%201%20with%20spaces')).toBe('/api/storage/test-cases/:id');
      expect(pageLatency.templatePath('/api/traces/a1b2c3d4e5f6a7b8c9d0e1f2')).toBe('/api/traces/:id');
    });

    it('leaves plain resource segments alone', () => {
      expect(pageLatency.templatePath('/api/storage/runs/search')).toBe('/api/storage/runs/search');
      expect(pageLatency.templatePath('/api/debug')).toBe('/api/debug');
      // human slugs with a few digits are names, not ids
      expect(pageLatency.templatePath('/api/storage/benchmarks/my-benchmark-2024/runs')).toBe('/api/storage/benchmarks/my-benchmark-2024/runs');
    });
  });

  describe('formatMs / classifyPageReady', () => {
    it('formats sub-second values in ms and the rest in seconds with one decimal', () => {
      expect(pageLatency.formatMs(9.4)).toBe('9 ms');
      expect(pageLatency.formatMs(840)).toBe('840 ms');
      expect(pageLatency.formatMs(13_612)).toBe('13.6 s');
    });

    it('bands a whole page at 1 s / 3 s (not the 50 / 200 ms step thresholds)', () => {
      expect(pageLatency.classifyPageReady(999)).toBe('fast');
      expect(pageLatency.classifyPageReady(1000)).toBe('ok');
      expect(pageLatency.classifyPageReady(2999)).toBe('ok');
      expect(pageLatency.classifyPageReady(3000)).toBe('slow');
    });
  });

  describe('when inactive (debug off, not a dev build)', () => {
    it('startNavigation is a complete no-op: no current record, fetch left untouched', () => {
      const originalFetch = window.fetch;
      pageLatency.startNavigation('/evaluations/benchmarks');
      expect(pageLatency.getCurrentRecord()).toBeNull();
      expect(window.fetch).toBe(originalFetch);
    });

    it('markPageReady is a no-op with no active record', () => {
      pageLatency.markPageReady('benchmarks');
      expect(pageLatency.getCurrentRecord()).toBeNull();
      expect(debugLog).not.toHaveBeenCalled();
    });

    it('turning debug off mid-session unwraps fetch and clears the current record on the next navigation', () => {
      window.fetch = jest.fn(() => Promise.resolve({})) as unknown as typeof fetch;
      const original = window.fetch;
      mockIsDebugEnabled.mockReturnValue(true);
      pageLatency.startNavigation('/evaluations/benchmarks');
      const wrapped = window.fetch;
      expect(wrapped).not.toBe(original);
      expect(pageLatency.getCurrentRecord()).not.toBeNull();

      mockIsDebugEnabled.mockReturnValue(false);
      pageLatency.startNavigation('/evaluations/runs');
      expect(pageLatency.getCurrentRecord()).toBeNull();
      expect(window.fetch).toBe(original);
    });
  });

  describe('when active (debug enabled)', () => {
    beforeEach(() => {
      mockIsDebugEnabled.mockReturnValue(true);
    });

    it('starts a record with the mapped route key and a null renderMs/readyMs until measured', () => {
      pageLatency.startNavigation('/evaluations/benchmarks/bench-1/runs');
      const rec = pageLatency.getCurrentRecord();
      expect(rec).toMatchObject({ route: 'benchmark-runs', renderMs: null, readyMs: null, settledMs: null, apiCount: 0, apiWallMs: 0, apiRequests: [] });
    });

    it('measures renderMs two animation frames after navigation start', () => {
      pageLatency.startNavigation('/evaluations/benchmarks');
      expect(pageLatency.getCurrentRecord()!.renderMs).toBeNull();
      jest.advanceTimersByTime(50);
      expect(pageLatency.getCurrentRecord()!.renderMs).not.toBeNull();
      expect(typeof pageLatency.getCurrentRecord()!.renderMs).toBe('number');
    });

    it('markPageReady finalizes readyMs and logs via debug() -- but only once per navigation', () => {
      pageLatency.startNavigation('/evaluations/benchmarks');
      jest.advanceTimersByTime(50);

      pageLatency.markPageReady('benchmarks');
      const rec1 = pageLatency.getCurrentRecord();
      expect(rec1!.readyMs).not.toBeNull();
      expect(debugLog).toHaveBeenCalledTimes(1);
      expect(debugLog).toHaveBeenCalledWith('pageLatency', expect.stringMatching(/^benchmarks · ready \d+ ms · first paint \d+ ms · 0 api requests \/ 0 ms wall$/));

      const readyMsAfterFirstCall = rec1!.readyMs;
      jest.advanceTimersByTime(1000);
      pageLatency.markPageReady('benchmarks'); // duplicate call (e.g. a manual refresh)
      expect(pageLatency.getCurrentRecord()!.readyMs).toBe(readyMsAfterFirstCall);
      expect(debugLog).toHaveBeenCalledTimes(1);
    });

    it('ignores a markPageReady call whose routeKey does not match the CURRENT navigation (stale page)', () => {
      pageLatency.startNavigation('/evaluations/benchmarks'); // -> 'benchmarks'
      pageLatency.startNavigation('/evaluations/runs'); // user already navigated on; current is now 'eval-runs'

      pageLatency.markPageReady('benchmarks'); // late call from the unmounted page
      expect(pageLatency.getCurrentRecord()!.readyMs).toBeNull();

      pageLatency.markPageReady('eval-runs');
      expect(pageLatency.getCurrentRecord()!.readyMs).not.toBeNull();
    });

    it('records /api/* fetch calls (count, method, templated path, duration) made during the active window, ignoring non-api calls', async () => {
      const apiResponse = { ok: true, status: 200 };
      let resolveApi: (() => void) | null = null;
      window.fetch = jest.fn((url: string) => {
        if (url.includes('/api/')) {
          return new Promise(resolve => { resolveApi = () => resolve(apiResponse); });
        }
        return Promise.resolve({ ok: true });
      }) as unknown as typeof fetch;

      pageLatency.startNavigation('/evaluations/benchmarks'); // wraps fetch

      const p1 = fetch('/api/storage/benchmarks/bench-1716800000000-abc12/runs?limit=50', { method: 'POST' });
      const p2 = fetch('https://example.com/not-api');
      await p2;
      expect(pageLatency.getCurrentRecord()!.apiCount).toBe(0); // non-api call doesn't count

      resolveApi!();
      await p1;
      const rec = pageLatency.getCurrentRecord()!;
      expect(rec.apiCount).toBe(1);
      expect(rec.apiRequests).toEqual([
        { method: 'POST', path: '/api/storage/benchmarks/:id/runs', startMs: expect.any(Number), ms: expect.any(Number) },
      ]);
      expect(rec.apiWallMs).toBeGreaterThanOrEqual(0);
    });

    it('attributes an in-flight fetch to the navigation that STARTED it, not whichever is current when it resolves (codex_review finding)', async () => {
      let resolveApi: ((v: unknown) => void) | null = null;
      window.fetch = jest.fn((url: string) => {
        if (url.includes('/api/')) return new Promise(resolve => { resolveApi = resolve; });
        return Promise.resolve({ ok: true });
      }) as unknown as typeof fetch;

      pageLatency.startNavigation('/evaluations/benchmarks'); // record A
      const pending = fetch('/api/storage/benchmarks'); // starts under A

      pageLatency.startNavigation('/evaluations/runs'); // user already navigated on; record B is now current
      const recordB = pageLatency.getCurrentRecord();

      resolveApi!({ ok: true });
      await pending;

      // B (the page the user is looking at NOW) must not be charged for a
      // request it never made.
      expect(recordB!.apiCount).toBe(0);
    });

    it('does not count a request that STARTS after markPageReady (background poll), but keeps one still in flight when the page reports ready', async () => {
      let resolveApi: ((v: unknown) => void) | null = null;
      window.fetch = jest.fn((url: string) => {
        if (url.includes('/in-flight')) return new Promise(resolve => { resolveApi = resolve; });
        return Promise.resolve({ ok: true });
      }) as unknown as typeof fetch;

      pageLatency.startNavigation('/evaluations/benchmarks'); // wraps the mock above
      const inFlight = fetch('/api/storage/in-flight'); // started BEFORE ready: the page's own request
      pageLatency.markPageReady('benchmarks');
      await fetch('/api/storage/benchmarks'); // started AFTER ready: a late poll/refresh
      expect(pageLatency.getCurrentRecord()!.apiCount).toBe(0);

      resolveApi!({ ok: true });
      await inFlight;
      expect(pageLatency.getCurrentRecord()!.apiCount).toBe(1);
      expect(pageLatency.getCurrentRecord()!.apiRequests[0].path).toBe('/api/storage/in-flight');
    });

    it('stops counting fetches the instant debug mode is turned off, even before the next navigation restores window.fetch', async () => {
      let resolveApi: ((v: unknown) => void) | null = null;
      window.fetch = jest.fn((url: string) => {
        if (url.includes('/api/')) return new Promise(resolve => { resolveApi = resolve; });
        return Promise.resolve({ ok: true });
      }) as unknown as typeof fetch;

      pageLatency.startNavigation('/evaluations/benchmarks');
      const pending = fetch('/api/storage/benchmarks'); // in flight while still active

      mockIsDebugEnabled.mockReturnValue(false); // toggled off mid-flight, no navigation yet
      resolveApi!({ ok: true });
      await pending;

      expect(pageLatency.getCurrentRecord()!.apiCount).toBe(0);
    });

    it('finalizes renderMs immediately in markPageReady if the page reports ready before the 2-frame render measurement fired (fast page)', () => {
      pageLatency.startNavigation('/evaluations/benchmarks');
      expect(pageLatency.getCurrentRecord()!.renderMs).toBeNull();

      pageLatency.markPageReady('benchmarks'); // fires before any timer advance

      const rec = pageLatency.getCurrentRecord()!;
      expect(rec.renderMs).not.toBeNull();
    });

    it('keeps nothing about earlier pages: no history, no previous-page accessor', () => {
      pageLatency.startNavigation('/evaluations/benchmarks');
      pageLatency.markPageReady('benchmarks');
      pageLatency.startNavigation('/evaluations/runs');
      const api = pageLatency as unknown as Record<string, unknown>;
      expect(api.getHistory).toBeUndefined();
      expect(api.getPreviousPage).toBeUndefined();
      expect(pageLatency.getCurrentRecord()!.route).toBe('eval-runs');
    });

    it('resets the lib/performance step timings on every navigation so "Slow steps" only covers the current page', () => {
      pageLatency.startNavigation('/agent-traces');
      record('TraceFlowView.flowTransform', 120);
      expect(pageLatency.getOperationStats().totalMeasurements).toBe(1);

      pageLatency.startNavigation('/evaluations/benchmarks');
      expect(pageLatency.getOperationStats()).toEqual({ stats: [], totalMeasurements: 0 });
    });

    it('computes apiWallMs as first-request-start → last-response-end (overlapping requests are NOT summed)', async () => {
      const resolvers: Array<(v: unknown) => void> = [];
      window.fetch = jest.fn(() => new Promise(resolve => { resolvers.push(resolve); })) as unknown as typeof fetch;
      const nowSpy = jest.spyOn(performance, 'now');
      let now = 1000;
      nowSpy.mockImplementation(() => now);

      pageLatency.startNavigation('/evaluations/benchmarks/bench-1'); // t=0
      now = 1100; const a = fetch('/api/storage/benchmarks/bench-1');          // starts +100
      now = 1200; const b = fetch('/api/storage/evaluation-runs/run-1');      // starts +200
      now = 1300; const c = fetch('/api/storage/evaluation-runs/run-2');      // starts +300
      now = 4100; resolvers[0]({ ok: true }); await a;                        // a: 3000 ms
      now = 4200; resolvers[1]({ ok: true }); await b;                        // b: 3000 ms
      now = 4300; resolvers[2]({ ok: true }); await c;                        // c: 3000 ms

      const rec = pageLatency.getCurrentRecord()!;
      expect(rec.apiCount).toBe(3);
      // A naive sum would say 9000 ms; the page actually waited from +100 to +3300.
      expect(rec.apiWallMs).toBe(3200);
      expect(rec.apiRequests.map(r => r.ms)).toEqual([3000, 3000, 3000]);
      expect(rec.apiRequests.map(r => r.startMs)).toEqual([100, 200, 300]);
      nowSpy.mockRestore();
    });

    it('settledMs (automatic readiness for pages that never call markPageReady) is stamped 1 s after the last response, and yields to an explicit markPageReady', async () => {
      window.fetch = jest.fn(() => Promise.resolve({ ok: true })) as unknown as typeof fetch;
      pageLatency.startNavigation('/settings'); // not an instrumented page
      jest.advanceTimersByTime(50); // first paint
      await fetch('/api/debug');
      expect(pageLatency.getCurrentRecord()!.settledMs).toBeNull();

      jest.advanceTimersByTime(999);
      expect(pageLatency.getCurrentRecord()!.settledMs).toBeNull();
      jest.advanceTimersByTime(1);
      const settled = pageLatency.getCurrentRecord()!.settledMs;
      expect(typeof settled).toBe('number');
      expect(pageLatency.getCurrentRecord()!.readyMs).toBeNull();

      pageLatency.markPageReady('/settings'); // an explicit signal wins
      expect(pageLatency.getCurrentRecord()!.readyMs).not.toBeNull();
    });

    it('settledMs falls back to first paint for a page that makes no API requests at all', () => {
      pageLatency.startNavigation('/settings');
      jest.advanceTimersByTime(50); // first paint
      const paint = pageLatency.getCurrentRecord()!.renderMs;
      expect(paint).not.toBeNull();
      jest.advanceTimersByTime(1000);
      expect(pageLatency.getCurrentRecord()!.settledMs).toBe(paint);
    });

    it('a settle timer from the previous page never stamps the next page', async () => {
      window.fetch = jest.fn(() => Promise.resolve({ ok: true })) as unknown as typeof fetch;
      pageLatency.startNavigation('/settings');
      await fetch('/api/debug');
      pageLatency.startNavigation('/evaluators'); // navigated on before the 1 s quiet period
      jest.advanceTimersByTime(1500);
      const rec = pageLatency.getCurrentRecord()!;
      expect(rec.apiCount).toBe(0); // the previous page's request was not carried over
      expect(rec.settledMs).toBe(rec.renderMs); // settled at ITS OWN first paint, not the old page's response
    });

    it('never auto-settles an instrumented route: a >1 s pause between its request bursts must not cut it short', async () => {
      window.fetch = jest.fn(() => Promise.resolve({ ok: true })) as unknown as typeof fetch;
      pageLatency.startNavigation('/evaluations/benchmarks/bench-1/runs'); // benchmark-runs reports ready itself
      jest.advanceTimersByTime(50);
      await fetch('/api/storage/benchmarks/bench-1');
      jest.advanceTimersByTime(5000); // long quiet gap (e.g. before a per-run cascade)
      expect(pageLatency.getCurrentRecord()!.settledMs).toBeNull();

      await fetch('/api/storage/evaluation-runs/run-1'); // second burst still counts
      expect(pageLatency.getCurrentRecord()!.apiCount).toBe(2);
      pageLatency.markPageReady('benchmark-runs');
      expect(pageLatency.getCurrentRecord()!.readyMs).not.toBeNull();
    });

    it('once auto-settled, the estimate is final: a later background request is not counted and does not move the number', async () => {
      window.fetch = jest.fn(() => Promise.resolve({ ok: true })) as unknown as typeof fetch;
      pageLatency.startNavigation('/settings');
      jest.advanceTimersByTime(50);
      await fetch('/api/debug');
      jest.advanceTimersByTime(1000);
      const rec = pageLatency.getCurrentRecord()!;
      const settled = rec.settledMs;
      expect(settled).not.toBeNull();

      jest.advanceTimersByTime(30_000);
      await fetch('/api/debug'); // a 30 s poll
      expect(rec.apiCount).toBe(1);
      expect(rec.settledMs).toBe(settled);
    });

    it('caps the request list at 200 but always keeps the slowest ones (apiCount stays exact)', async () => {
      const nowSpy = jest.spyOn(performance, 'now');
      let now = 1000;
      nowSpy.mockImplementation(() => now);
      let durationMs = 1;
      window.fetch = jest.fn(() => { now += durationMs; return Promise.resolve({ ok: true }); }) as unknown as typeof fetch;

      pageLatency.startNavigation('/evaluators');
      for (let i = 0; i < 200; i++) { durationMs = 10; await fetch(`/api/storage/evaluators/${i}`); }
      durationMs = 9999; await fetch('/api/storage/slow'); // #201, the slowest of all
      durationMs = 1; await fetch('/api/storage/fast');    // #202, faster than everything kept

      const rec = pageLatency.getCurrentRecord()!;
      expect(rec.apiCount).toBe(202);
      expect(rec.apiRequests).toHaveLength(200);
      expect(rec.apiRequests.some(r => r.path === '/api/storage/slow' && r.ms === 9999)).toBe(true);
      expect(rec.apiRequests.some(r => r.path === '/api/storage/fast')).toBe(false);
      nowSpy.mockRestore();
    });

    it('subscribe() fires on navigation start and on markPageReady, and unsubscribe stops further notifications', () => {
      const listener = jest.fn();
      const unsubscribe = pageLatency.subscribe(listener);

      pageLatency.startNavigation('/evaluations/benchmarks');
      expect(listener).toHaveBeenCalled();

      const callsBeforeReady = listener.mock.calls.length;
      pageLatency.markPageReady('benchmarks');
      expect(listener.mock.calls.length).toBeGreaterThan(callsBeforeReady);

      unsubscribe();
      const callsAfterUnsubscribe = listener.mock.calls.length;
      pageLatency.startNavigation('/evaluations/runs');
      expect(listener.mock.calls.length).toBe(callsAfterUnsubscribe);
    });

    it('exposeConsoleApi / removeConsoleApi install and remove window.__agentHealthPerf', () => {
      pageLatency.exposeConsoleApi();
      const api = (window as unknown as Record<string, any>).__agentHealthPerf;
      expect(api).toBeDefined();
      expect(typeof api.startMeasure).toBe('function');
      expect(typeof api.getOperationStats).toBe('function');
      pageLatency.exposeConsoleApi(); // idempotent
      expect((window as unknown as Record<string, any>).__agentHealthPerf).toBe(api);

      pageLatency.removeConsoleApi();
      expect((window as unknown as Record<string, any>).__agentHealthPerf).toBeUndefined();
    });
  });

  describe('activation via the legacy DEBUG_PERFORMANCE flag (former PerformanceOverlay path)', () => {
    afterEach(() => localStorage.removeItem('DEBUG_PERFORMANCE'));

    it('is active when only localStorage.DEBUG_PERFORMANCE is set', () => {
      expect(pageLatency.isPageLatencyActive()).toBe(false);
      localStorage.setItem('DEBUG_PERFORMANCE', 'true');
      expect(pageLatency.isPageLatencyActive()).toBe(true);
      pageLatency.startNavigation('/evaluations/benchmarks');
      expect(pageLatency.getCurrentRecord()?.route).toBe('benchmarks');
    });
  });

  describe('operation stats (merged from the former PerformanceOverlay)', () => {
    beforeEach(() => {
      mockIsDebugEnabled.mockReturnValue(true);
    });

    it('classifyDuration bands at 50 / 200 ms', () => {
      expect(pageLatency.classifyDuration(0)).toBe('fast');
      expect(pageLatency.classifyDuration(49.9)).toBe('fast');
      expect(pageLatency.classifyDuration(50)).toBe('ok');
      expect(pageLatency.classifyDuration(199.9)).toBe('ok');
      expect(pageLatency.classifyDuration(200)).toBe('slow');
    });

    it('lib/performance records when debug mode alone is on (no DEBUG_PERFORMANCE flag), and not when both are off', () => {
      expect(localStorage.getItem('DEBUG_PERFORMANCE')).toBeNull();
      mockIsDebugEnabled.mockReturnValue(false);
      record('TraceFlowView.preprocessing', 10);
      expect(pageLatency.getOperationStats().totalMeasurements).toBe(0);

      mockIsDebugEnabled.mockReturnValue(true);
      record('TraceFlowView.preprocessing', 10);
      expect(pageLatency.getOperationStats().totalMeasurements).toBe(1);
    });

    it('returns no stats and a zero total when nothing has been measured', () => {
      expect(pageLatency.getOperationStats()).toEqual({ stats: [], totalMeasurements: 0 });
    });

    it('groups measurements by name into avg / min / max / count, sorted slowest-average first, with label/group split', () => {
      record('TraceFlowView.preprocessing', 10);
      record('TraceFlowView.preprocessing', 30);
      record('AgentTracesPage.fetchMore', 300);
      record('flat', 5);

      const { stats, totalMeasurements } = pageLatency.getOperationStats();
      expect(totalMeasurements).toBe(4);
      expect(stats.map(s => s.name)).toEqual(['AgentTracesPage.fetchMore', 'TraceFlowView.preprocessing', 'flat']);

      const pre = stats[1];
      expect(pre).toMatchObject({ label: 'preprocessing', group: 'TraceFlowView', count: 2 });
      expect(pre.avgMs).toBeCloseTo(20);
      expect(pre.minMs).toBeCloseTo(10);
      expect(pre.maxMs).toBeCloseTo(30);

      expect(stats[2]).toMatchObject({ name: 'flat', label: 'flat', group: '', count: 1 });
    });

    it('subscribe() fires when a measurement is recorded and when stats are cleared; clearOperationStats empties them', () => {
      const listener = jest.fn();
      const unsubscribe = pageLatency.subscribe(listener);

      record('TraceFlowView.preprocessing', 10);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(pageLatency.getOperationStats().totalMeasurements).toBe(1);

      pageLatency.clearOperationStats();
      expect(listener).toHaveBeenCalledTimes(2);
      expect(pageLatency.getOperationStats()).toEqual({ stats: [], totalMeasurements: 0 });

      unsubscribe();
      record('TraceFlowView.preprocessing', 10);
      expect(listener).toHaveBeenCalledTimes(2);
    });
  });
});
