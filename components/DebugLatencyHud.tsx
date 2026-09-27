/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unobtrusive bottom-right HUD for the CURRENT page's latency, visible ONLY
 * when debug mode is enabled, this is a dev build, or the legacy
 * `localStorage.DEBUG_PERFORMANCE` flag is set. It polls that rule once a
 * second so a debug-mode toggle in another tab / the Settings page is picked
 * up without a hard refresh.
 *
 * Collapsed pill: colour dot + `benchmark-runs · 13.6 s` — one number, the
 * time from route change until the page's data settled and rendered.
 * Expanded (click to pin, hover or hold ⌥/Alt to peek), still the current
 * page only:
 *   Page ready   13.6 s
 *   First paint  9 ms
 *   API          37 requests · 13.2 s wall     + the 5 slowest requests
 *   Slow steps on this page                     (only if the page recorded any)
 * Everything resets on every route change.
 */

import React, { useEffect, useLayoutEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import {
  isPageLatencyActive,
  getCurrentRecord,
  getOperationStats,
  startNavigation,
  classifyDuration,
  classifyPageReady,
  formatMs,
  exposeConsoleApi,
  removeConsoleApi,
  subscribe,
  type PageLatencyRecord,
  type OperationStat,
  type ApiRequestRecord,
  type DurationBand,
} from '@/lib/pageLatency';

/**
 * Opens the latency window for each navigation. Rendered by Layout as a
 * sibling BEFORE the page content, in a layout effect: React runs children's
 * effects before their parent's, so a plain useEffect in Layout fired AFTER
 * the new page's own effects had already started its first fetches -- those
 * were then charged to the previous, already-final record. Layout effects of
 * an earlier sibling run before any passive effect of a later one, and this
 * is a commit-phase call (never a render-phase side effect). Keyed on
 * `location.key` so same-path navigations (query changes) start a new window.
 */
export const PageLatencyNavigationBoundary: React.FC = () => {
  const location = useLocation();
  useLayoutEffect(() => {
    startNavigation(location.pathname);
  }, [location.key, location.pathname]);
  return null;
};

const SLOWEST_REQUESTS = 5;
const MAX_STEPS = 3;

const BAND_CLASS: Record<DurationBand, string> = {
  fast: 'text-green-400',
  ok: 'text-yellow-400',
  slow: 'text-red-400',
};

const Dot: React.FC<{ band: DurationBand | null }> = ({ band }) => (
  <span data-testid="debug-latency-hud-dot" data-band={band ?? 'pending'} className={band ? BAND_CLASS[band] : 'text-slate-500'}>
    ●
  </span>
);

/** The one number the pill shows: explicit page-ready, else the automatic settle estimate. */
function readyMsOf(r: PageLatencyRecord): number | null {
  return r.readyMs ?? r.settledMs;
}

function slowestRequests(r: PageLatencyRecord): ApiRequestRecord[] {
  return [...r.apiRequests].sort((a, b) => b.ms - a.ms).slice(0, SLOWEST_REQUESTS);
}

const Row: React.FC<{ label: string; title?: string; children: React.ReactNode; testId?: string }> = ({ label, title, children, testId }) => (
  <div data-testid={testId} className="flex items-baseline justify-between gap-3" title={title}>
    <span className="text-slate-400">{label}</span>
    <span className="tabular-nums text-right">{children}</span>
  </div>
);

const StepRow: React.FC<{ stat: OperationStat }> = ({ stat }) => {
  const band = classifyDuration(stat.avgMs);
  return (
    <div data-testid="debug-latency-hud-op" className="flex items-baseline justify-between gap-2 truncate pl-2" title={stat.name}>
      <span className="truncate">
        <Dot band={band} /> {stat.label}
        {stat.group && <span className="text-slate-500"> · {stat.group}</span>}
      </span>
      <span className="shrink-0 tabular-nums">
        <span className={BAND_CLASS[band]}>{formatMs(stat.avgMs)}</span>
        {stat.count > 1 && <span className="text-slate-500"> ×{stat.count}</span>}
      </span>
    </div>
  );
};

export const DebugLatencyHud: React.FC = () => {
  const [active, setActive] = useState(() => isPageLatencyActive());
  const [current, setCurrent] = useState<PageLatencyRecord | null>(() => getCurrentRecord());
  const [ops, setOps] = useState(() => getOperationStats());
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [altHeld, setAltHeld] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const expanded = pinned || hovered || altHeld;

  // Poll for the debug-mode toggle (Settings page / another tab flips
  // localStorage; import.meta.env.DEV never changes at runtime).
  useEffect(() => {
    const id = setInterval(() => setActive(isPageLatencyActive()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!active) return;
    const refresh = () => {
      setCurrent(getCurrentRecord());
      setOps(getOperationStats());
    };
    refresh();
    // Notifications arrive in bursts (every settled request) and from other
    // components' commit phases -- defer + coalesce to a microtask so the HUD
    // re-renders once per burst.
    let queued = false;
    let unsubscribed = false;
    const onChange = () => {
      if (queued) return;
      queued = true;
      Promise.resolve().then(() => {
        queued = false;
        if (!unsubscribed) refresh();
      });
    };
    const unsubscribe = subscribe(onChange);
    return () => {
      unsubscribed = true;
      unsubscribe();
    };
  }, [active]);

  // DevTools console API lives exactly as long as the HUD is active.
  useEffect(() => {
    if (!active) return;
    exposeConsoleApi();
    return removeConsoleApi;
  }, [active]);

  // Hold ⌥ / Alt to peek at the expanded view without reaching for the mouse.
  // `blur` resets the flag in case the keyup is swallowed (e.g. Alt+Tab).
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Alt' && !e.repeat) setAltHeld(true);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Alt') setAltHeld(false);
    };
    const onBlur = () => setAltHeld(false);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [active]);

  if (!active || dismissed) return null;

  const ready = current ? readyMsOf(current) : null;
  const band = ready === null ? null : classifyPageReady(ready);
  const steps = ops.stats.slice(0, MAX_STEPS);

  return (
    <div
      data-testid="debug-latency-hud"
      data-expanded={expanded ? 'true' : 'false'}
      onClick={() => setPinned(v => !v)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="fixed bottom-3 right-3 z-50 select-none"
    >
      {expanded && current && (
        <div
          data-testid="debug-latency-hud-panel"
          className="mb-1 w-[24rem] rounded-md border border-slate-700 bg-slate-900/95 backdrop-blur text-[10px] text-slate-200 shadow-xl p-2 space-y-0.5 font-mono"
        >
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-slate-400" title="Route change → the page's data settled and its content rendered (reported by the page, or estimated from first paint + last API response + 1 s of quiet)">
              Page ready
            </span>
            <span className="flex items-baseline gap-2">
              <span data-testid="debug-latency-hud-ready" className={`tabular-nums ${band ? BAND_CLASS[band] : 'text-slate-500'}`}>
                {ready === null ? '…' : formatMs(ready)}
                {current.readyMs === null && current.settledMs !== null && <span className="text-slate-500" title="Estimated: this page does not report readiness"> ~</span>}
              </span>
              <button
                type="button"
                data-testid="debug-latency-hud-hide"
                title="Hide until the next page load"
                onClick={e => {
                  e.stopPropagation();
                  setDismissed(true);
                }}
                className="rounded border border-slate-600 px-1 leading-4 text-slate-400 hover:bg-slate-700"
              >
                hide
              </button>
            </span>
          </div>
          <Row
            label="First paint"
            testId="debug-latency-hud-paint"
            title="Route change → the new page's first frame on screen (before any data arrived)"
          >
            {current.renderMs === null ? '…' : formatMs(current.renderMs)}
          </Row>
          <Row
            label="API"
            testId="debug-latency-hud-api"
            title="/api/* requests this page made while loading; wall = first request start → last response end (requests overlap, so durations are not summed)"
          >
            {current.apiCount === 0
              ? 'no requests'
              : `${current.apiCount} request${current.apiCount === 1 ? '' : 's'} · ${formatMs(current.apiWallMs)} wall`}
          </Row>
          {slowestRequests(current).map((req, i) => (
            <div key={`${req.method}-${req.path}-${req.startMs}-${i}`} data-testid="debug-latency-hud-request" className="flex items-baseline justify-between gap-2 pl-2 truncate text-slate-300">
              <span className="truncate">
                <span className="text-slate-500">{req.method}</span> {req.path}
              </span>
              <span className={`shrink-0 tabular-nums ${BAND_CLASS[classifyDuration(req.ms)]}`}>{formatMs(req.ms)}</span>
            </div>
          ))}
          {steps.length > 0 && (
            <div data-testid="debug-latency-hud-operations" className="pt-1">
              <div className="text-slate-400">Slow steps on this page</div>
              {steps.map(stat => <StepRow key={stat.name} stat={stat} />)}
            </div>
          )}
        </div>
      )}
      <div
        data-testid="debug-latency-hud-pill"
        className="rounded-md border border-slate-700 bg-slate-900/90 backdrop-blur text-[10px] text-slate-200 font-mono px-2 py-1 shadow-lg cursor-pointer"
      >
        {current ? (
          <>
            <Dot band={band} /> {current.route} · {ready === null ? '…' : formatMs(ready)}
          </>
        ) : (
          '— · navigate to start measuring'
        )}
      </div>
    </div>
  );
};

export default DebugLatencyHud;
