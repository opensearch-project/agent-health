/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Per-page latency instrumentation, active ONLY when debug mode is enabled
 * (see lib/debug.ts), this is a dev build (`import.meta.env.DEV`), or the
 * legacy `localStorage.DEBUG_PERFORMANCE` flag is set. When none is true every
 * exported function is a no-op: no timers, no `fetch` wrapping, no state kept
 * — zero behaviour change for normal users.
 *
 * ONE record per navigation — the current page only, nothing is kept about
 * earlier pages:
 *   1. `startNavigation(pathname)` — called from `PageLatencyNavigationBoundary`
 *      (a sibling rendered BEFORE the page in Layout, in a layout effect, so it
 *      runs before the new page's own effects fire its first fetches) on every
 *      route change. Resets everything (record, in-flight bookkeeping, the
 *      `lib/performance` step timings), maps the pathname to a stable route
 *      key so dynamic segments don't fragment the same page into many routes,
 *      and schedules a first-paint timestamp two animation frames out.
 *   2. `markPageReady(routeKey)` — a one-line call each instrumented page
 *      makes once its own primary data fetch(es) settle. `routeKey` must be
 *      the SAME key `routeKeyFromPath` produces for that page's route: a
 *      stale call from a page the user has since navigated away from is
 *      ignored. Pages whose route is NOT in `ROUTE_KEY_PATTERNS` (i.e. that
 *      don't report readiness) get an automatic, final estimate instead
 *      (`settledMs`): first paint + every `/api/*` request settled, then 1 s
 *      of quiet — i.e. "route change → last data fetch settled". The HUD
 *      shows `readyMs ?? settledMs`. Instrumented routes never auto-settle
 *      (a >1 s pause between their request bursts must not cut them short).
 *   3. While a navigation is active, `window.fetch` calls to `/api/*` that
 *      START before the record is final (`readyMs` / `settledMs` stamped) are
 *      recorded (method, path template with ids collapsed to `:id`,
 *      duration) into whichever record was current WHEN THE CALL STARTED — a
 *      slow request must count against the page that made it, not whichever
 *      page the user has since navigated to, and a request still in flight
 *      when the page reports ready still belongs to it. Requests that start
 *      AFTER the record is final (background polls) are not counted.
 *      `apiWallMs` is the wall-clock span from the first request start to
 *      the last response end (requests overlap, so a plain sum of durations
 *      is meaningless).
 *
 * The named step timings recorded through `lib/performance.ts`
 * (`startMeasure` / `endMeasure`, e.g. `TraceFlowView.flowTransform`) are
 * scoped to the current page too: `startNavigation` clears them, and
 * `getOperationStats()` groups what the current page recorded into
 * avg / min / max / count for the HUD's "Slow steps on this page" section.
 */

import { isDebugEnabled, debug } from './debug';
import { isViteDev } from '@/lib/viteEnv';
import {
  getMetrics,
  clearMetrics,
  subscribeToMetrics,
  startMeasure,
  endMeasure,
  logSummary,
} from './performance';

/** One `/api/*` request observed during the current navigation. */
export interface ApiRequestRecord {
  method: string;
  /** Path with the query string dropped and id-like segments collapsed to `:id`. */
  path: string;
  /** Offset (ms from navigation start) at which the request started. */
  startMs: number;
  /** Request duration in ms. */
  ms: number;
}

export interface PageLatencyRecord {
  /** Stable route key (see {@link routeKeyFromPath}), NOT the raw pathname. */
  route: string;
  /** Epoch ms (Date.now()) when the navigation started. */
  startedAt: number;
  /** ms from navigation start to first paint (2 animation frames), or null until measured. */
  renderMs: number | null;
  /** ms from navigation start to the page reporting itself ready via markPageReady, or null. */
  readyMs: number | null;
  /**
   * Automatic readiness estimate for pages that don't call markPageReady:
   * first paint + all `/api/*` requests settled, after a 1 s quiet period.
   * Updated (not final) until an explicit readyMs arrives; null until then.
   */
  settledMs: number | null;
  /** Count of `/api/*` fetch() calls observed during this navigation's window. */
  apiCount: number;
  /** Wall-clock span (ms) from the first `/api/*` request start to the last response end. */
  apiWallMs: number;
  /**
   * Observed requests, capped at {@link API_REQUEST_CAP}; once full, a new
   * request only replaces the fastest kept one, so the slowest requests are
   * always retained (the HUD lists the slowest 5). `apiCount` is uncapped.
   */
  apiRequests: ApiRequestRecord[];
}

/** Per-operation aggregate of `lib/performance` measurements (one row in the HUD's "Slow steps" section). */
export interface OperationStat {
  /** Full measurement name, e.g. `TraceFlowView.preprocessing`. */
  name: string;
  /** Last dotted segment (`preprocessing`) -- the row's headline. */
  label: string;
  /** Everything before the last segment (`TraceFlowView`), '' if undotted. */
  group: string;
  avgMs: number;
  minMs: number;
  maxMs: number;
  count: number;
}

/** Colour band. Steps: fast < 50 ms, ok < 200 ms. Page ready: fast < 1 s, ok < 3 s. */
export type DurationBand = 'fast' | 'ok' | 'slow';

/** Band for an internal step / single request (the former overlay's thresholds). */
export function classifyDuration(ms: number): DurationBand {
  if (ms < 50) return 'fast';
  if (ms < 200) return 'ok';
  return 'slow';
}

/** Band for a whole page's time-to-ready (a page is not a 50 ms operation). */
export function classifyPageReady(ms: number): DurationBand {
  if (ms < 1000) return 'fast';
  if (ms < 3000) return 'ok';
  return 'slow';
}

/** `840 ms` below a second, `13.6 s` from there on. */
export function formatMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/**
 * Groups every `lib/performance` measurement recorded since the current
 * navigation started by name into avg / min / max / count, slowest-average
 * first. `totalMeasurements` is the raw sample count across all names.
 */
export function getOperationStats(): { stats: OperationStat[]; totalMeasurements: number } {
  const metrics = getMetrics();
  const byName = new Map<string, number[]>();
  for (const m of metrics) {
    const list = byName.get(m.name);
    if (list) list.push(m.duration);
    else byName.set(m.name, [m.duration]);
  }
  const stats: OperationStat[] = [];
  byName.forEach((durations, name) => {
    const dot = name.lastIndexOf('.');
    stats.push({
      name,
      label: dot === -1 ? name : name.slice(dot + 1),
      group: dot === -1 ? '' : name.slice(0, dot),
      avgMs: durations.reduce((a, b) => a + b, 0) / durations.length,
      minMs: Math.min(...durations),
      maxMs: Math.max(...durations),
      count: durations.length,
    });
  });
  stats.sort((a, b) => b.avgMs - a.avgMs);
  return { stats, totalMeasurements: metrics.length };
}

/** Drops every recorded step measurement. */
export function clearOperationStats(): void {
  clearMetrics();
}

const API_REQUEST_CAP = 200;
const SETTLE_QUIET_MS = 1000;

let current: PageLatencyRecord | null = null;
let currentStartPerf = 0; // performance.now() at navigation start (monotonic, for accurate deltas)
let settleTimer: ReturnType<typeof setTimeout> | null = null;

/** Per-record request bookkeeping (not displayed), kept off the public record shape. */
interface Bookkeeping {
  startPerf: number;
  inFlight: number;
  firstRequestStartPerf: number | null;
  lastResponseEndPerf: number | null;
  /** Route is one of the instrumented pages that will call markPageReady itself. */
  reportsReady: boolean;
}
const bookkeeping = new WeakMap<PageLatencyRecord, Bookkeeping>();

type Listener = () => void;
let listeners: Listener[] = [];

let fetchWrapped = false;
let originalFetch: typeof fetch | null = null;

/** Route-pattern → stable key. Order matters: most specific patterns first. */
const ROUTE_KEY_PATTERNS: Array<[RegExp, string]> = [
  [/^\/evaluations\/benchmarks\/[^/]+\/runs\/[^/]+\/inspect\/?$/, 'run-inspector'],
  [/^\/evaluations\/runs\/[^/]+\/inspect\/?$/, 'run-inspector'],
  [/^\/evaluations\/benchmarks\/[^/]+(\/cases\/[^/]+)?(\/runs)?\/?$/, 'benchmark-runs'],
  [/^\/evaluations\/benchmarks\/?$/, 'benchmarks'],
  [/^\/evaluations\/runs\/?$/, 'eval-runs'],
  [/^\/compare(\/[^/]+)?\/?$/, 'comparison'],
  [/^\/agent-traces\/?$/, 'traces'],
];

/** Maps a raw pathname to the stable key instrumented pages call `markPageReady` with. */
export function routeKeyFromPath(pathname: string): string {
  for (const [pattern, key] of ROUTE_KEY_PATTERNS) {
    if (pattern.test(pathname)) return key;
  }
  return pathname;
}

/** Whether a route key belongs to a page that reports readiness itself (so it must not auto-settle). */
function isInstrumentedRoute(routeKey: string): boolean {
  return ROUTE_KEY_PATTERNS.some(([, key]) => key === routeKey);
}

/**
 * Collapses id-like path segments (uuids, numbers, `tc-<ts>-<rand>`-style
 * generated ids, percent-encoded values) to `:id` and drops the query string,
 * so the HUD's request list groups the same endpoint regardless of which
 * entity was fetched.
 */
export function templatePath(url: string): string {
  let pathname: string;
  try {
    pathname = new URL(url, 'http://placeholder.local').pathname;
  } catch {
    pathname = url.split('?')[0];
  }
  return pathname
    .split('/')
    .map(seg => {
      if (!seg) return seg;
      if (/^\d+$/.test(seg)) return ':id';
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ':id';
      if (seg.includes('%')) return ':id'; // percent-encoded user-chosen ids (names with spaces, …)
      if (/^[a-z]+[-_]\d{6,}/i.test(seg)) return ':id'; // tc-1716800000000-abc123 style generated ids
      if (seg.length >= 16 && /^[0-9a-f]+$/i.test(seg)) return ':id'; // long hex (trace/span ids)
      if ((seg.match(/\d/g) ?? []).length >= 6) return ':id'; // digit-heavy opaque ids
      return seg; // resource names and human slugs (`my-benchmark-2024`) stay as-is
    })
    .join('/');
}

function isDevBuild(): boolean {
  return isViteDev();
}

/**
 * The pre-HUD PerformanceOverlay was switched on by setting
 * `localStorage.DEBUG_PERFORMANCE = 'true'` from the browser console (still
 * documented, and still written by the Settings debug toggle) -- keep that
 * path working for the merged HUD.
 */
function isLegacyPerfFlagSet(): boolean {
  try {
    return typeof window !== 'undefined' && localStorage.getItem('DEBUG_PERFORMANCE') === 'true';
  } catch {
    return false;
  }
}

/** Whether instrumentation should be doing ANYTHING right now. */
export function isPageLatencyActive(): boolean {
  return isDebugEnabled() || isDevBuild() || isLegacyPerfFlagSet();
}

function notify(): void {
  for (const l of listeners) l();
}

/**
 * Subscribe to record updates (navigation start / paint / api / ready) AND
 * to `lib/performance` measurement changes. Returns an unsubscribe fn.
 */
export function subscribe(fn: Listener): () => void {
  listeners.push(fn);
  const unsubscribeMetrics = subscribeToMetrics(fn);
  return () => {
    listeners = listeners.filter(l => l !== fn);
    unsubscribeMetrics();
  };
}

/**
 * Console API (`window.__agentHealthPerf`) for ad-hoc `startMeasure` /
 * `endMeasure` timings from DevTools that then show up in the HUD. The HUD
 * exposes it while it is active and removes it when it deactivates.
 */
const CONSOLE_API_KEY = '__agentHealthPerf';

export function exposeConsoleApi(): void {
  if (typeof window === 'undefined') return;
  const w = window as unknown as Record<string, unknown>;
  if (w[CONSOLE_API_KEY]) return;
  w[CONSOLE_API_KEY] = {
    startMeasure,
    endMeasure,
    getMetrics,
    getOperationStats,
    getCurrentRecord,
    clearMetrics,
    logSummary,
  };
}

export function removeConsoleApi(): void {
  if (typeof window === 'undefined') return;
  delete (window as unknown as Record<string, unknown>)[CONSOLE_API_KEY];
}

function apiUrlFrom(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  // Request object
  return (input as Request).url || '';
}

function apiMethodFrom(input: Parameters<typeof fetch>[0], init?: RequestInit): string {
  const m = init?.method || (typeof input === 'object' && !(input instanceof URL) ? (input as Request).method : undefined);
  return (m || 'GET').toUpperCase();
}

function clearSettleTimer(): void {
  if (settleTimer !== null) {
    clearTimeout(settleTimer);
    settleTimer = null;
  }
}

/**
 * (Re)arms the automatic-readiness timer for the current record: fires after
 * {@link SETTLE_QUIET_MS} of no `/api/*` activity and stamps `settledMs` with
 * the moment the last thing settled (last response end, or first paint when
 * the page made no requests). Never used for instrumented routes -- they
 * report readiness themselves -- and ignored once a record is final.
 */
function scheduleSettle(record: PageLatencyRecord): void {
  clearSettleTimer();
  const bk = bookkeeping.get(record);
  if (!bk || bk.reportsReady || record.readyMs !== null || record.settledMs !== null) return;
  settleTimer = setTimeout(() => {
    settleTimer = null;
    if (current !== record || record.readyMs !== null || record.settledMs !== null || bk.inFlight > 0) return;
    const settled = bk.lastResponseEndPerf !== null
      ? Math.round(bk.lastResponseEndPerf - bk.startPerf)
      : record.renderMs;
    if (settled === null) return; // no paint observed yet (background tab): the paint callback re-arms
    record.settledMs = Math.max(settled, record.renderMs ?? 0);
    notify();
  }, SETTLE_QUIET_MS);
}

/** A record is final once the page reported ready or the automatic estimate was stamped. */
function isFinal(record: PageLatencyRecord): boolean {
  return record.readyMs !== null || record.settledMs !== null;
}

/** Keeps the request list bounded while guaranteeing the slowest requests survive. */
function pushRequest(record: PageLatencyRecord, req: ApiRequestRecord): void {
  if (record.apiRequests.length < API_REQUEST_CAP) {
    record.apiRequests.push(req);
    return;
  }
  let fastest = 0;
  for (let i = 1; i < record.apiRequests.length; i++) {
    if (record.apiRequests[i].ms < record.apiRequests[fastest].ms) fastest = i;
  }
  if (req.ms > record.apiRequests[fastest].ms) record.apiRequests[fastest] = req;
}

function wrapFetch(): void {
  if (fetchWrapped || typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  originalFetch = window.fetch;
  const boundOriginal = originalFetch.bind(window);
  const wrapped: typeof fetch = async (...args: Parameters<typeof fetch>) => {
    const url = apiUrlFrom(args[0]);
    const isApiCall = url.includes('/api/');
    // Attribute to whichever navigation is active WHEN THE CALL STARTS, not
    // whichever is active when it resolves -- a slow request started on
    // page A that resolves after the user has already navigated to page B
    // must count against A's window, not silently pollute B's. Captured
    // once, up front, deliberately NOT re-read from the mutable
    // module-level `current` inside `finally`.
    const recordAtCallStart = current;
    const bk = recordAtCallStart ? bookkeeping.get(recordAtCallStart) : undefined;
    // Only requests that START before the record is final belong to it: a
    // background poll firing after "ready" must not inflate a number already
    // reported as final -- but a request still in flight WHEN the page
    // reports ready is the page's own and is kept.
    const counts = isApiCall && recordAtCallStart !== null && bk !== undefined && !isFinal(recordAtCallStart);
    const t0 = performance.now();
    if (counts) {
      bk!.inFlight += 1;
      if (bk!.firstRequestStartPerf === null) bk!.firstRequestStartPerf = t0;
    }
    try {
      return await boundOriginal(...args);
    } finally {
      if (counts) {
        const record = recordAtCallStart!;
        const b = bk!;
        b.inFlight = Math.max(0, b.inFlight - 1);
        const t1 = performance.now();
        // Stop recording the instant debug/dev mode is turned off, even
        // before the next navigation gets a chance to unwrap `window.fetch`.
        if (isPageLatencyActive()) {
          record.apiCount += 1;
          pushRequest(record, {
            method: apiMethodFrom(args[0], args[1]),
            path: templatePath(url),
            startMs: Math.round(t0 - b.startPerf),
            ms: Math.round(t1 - t0),
          });
          if (b.lastResponseEndPerf === null || t1 > b.lastResponseEndPerf) b.lastResponseEndPerf = t1;
          if (b.firstRequestStartPerf !== null) {
            record.apiWallMs = Math.round(b.lastResponseEndPerf - b.firstRequestStartPerf);
          }
          if (current === record && b.inFlight === 0) scheduleSettle(record);
          notify();
        }
      }
    }
  };
  window.fetch = wrapped;
  fetchWrapped = true;
}

function unwrapFetch(): void {
  if (fetchWrapped && originalFetch && typeof window !== 'undefined') {
    window.fetch = originalFetch;
  }
  fetchWrapped = false;
  originalFetch = null;
}


/**
 * Called on every route change (Layout). Resets everything to the new page:
 * the record, the request bookkeeping and the `lib/performance` step
 * timings. No-op (and unwraps `fetch` if it was previously wrapped) when
 * instrumentation isn't active — e.g. the user just turned debug mode off.
 */
export function startNavigation(pathname: string): void {
  clearSettleTimer();
  if (!isPageLatencyActive()) {
    current = null;
    unwrapFetch();
    return;
  }
  wrapFetch();
  clearMetrics();
  const route = routeKeyFromPath(pathname);
  currentStartPerf = performance.now();
  current = {
    route,
    startedAt: Date.now(),
    renderMs: null,
    readyMs: null,
    settledMs: null,
    apiCount: 0,
    apiWallMs: 0,
    apiRequests: [],
  };
  const record = current;
  const bk: Bookkeeping = {
    startPerf: currentStartPerf,
    inFlight: 0,
    firstRequestStartPerf: null,
    lastResponseEndPerf: null,
    reportsReady: isInstrumentedRoute(route),
  };
  bookkeeping.set(record, bk);
  if (typeof requestAnimationFrame === 'function') {
    // Two frames: the first fires before the browser has necessarily
    // painted the just-committed DOM; by the second, paint has happened.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (current === record && record.renderMs === null) {
          record.renderMs = Math.round(performance.now() - currentStartPerf);
          // A page that never fetches anything is "ready" at first paint.
          if (bk.inFlight === 0 && record.apiCount === 0) scheduleSettle(record);
          notify();
        }
      });
    });
  }
  notify();
}

/**
 * One-line call an instrumented page makes once its primary load resolves.
 * `routeKey` must match what {@link routeKeyFromPath} produces for that
 * page's route — a mismatch (stale call from a page the user has since
 * navigated away from) is silently ignored, and a record is only finalized
 * once (a page calling this more than once, e.g. on a manual refresh
 * button, doesn't overwrite the number already reported).
 */
export function markPageReady(routeKey: string): void {
  if (!isPageLatencyActive() || !current) return;
  if (current.route !== routeKey) return;
  if (current.readyMs !== null) return;
  // First paint is measured 2 animation frames after navigation start; by
  // the time a page's primary data load resolves that has virtually always
  // already fired, but finalize it here too for the rare case a page
  // reports ready before its own first paint has been observed.
  if (current.renderMs === null) {
    current.renderMs = Math.round(performance.now() - currentStartPerf);
  }
  current.readyMs = Math.round(performance.now() - currentStartPerf);
  clearSettleTimer();
  debug(
    'pageLatency',
    `${current.route} · ready ${formatMs(current.readyMs)} · first paint ${formatMs(current.renderMs)} · ${current.apiCount} api requests / ${formatMs(current.apiWallMs)} wall`,
  );
  notify();
}

/** The in-progress (or last-started) navigation's record, or null. */
export function getCurrentRecord(): PageLatencyRecord | null {
  return current;
}

/** Test-only: reset all module state (record, timers, fetch wrapping, listeners). */
export function __resetPageLatencyForTests(): void {
  current = null;
  currentStartPerf = 0;
  clearSettleTimer();
  unwrapFetch();
  removeConsoleApi();
  clearMetrics();
  listeners = [];
}
