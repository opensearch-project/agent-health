/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unobtrusive bottom-right HUD showing the current page's latency, visible
 * ONLY when debug mode is enabled or this is a dev build (mirrors
 * PerformanceOverlay's localStorage-poll pattern so a debug-mode toggle in
 * another tab/the Settings page is picked up without a hard refresh).
 * Click (or hover) to expand the last 10 navigations.
 */

import React, { useEffect, useState } from 'react';
import {
  isPageLatencyActive,
  getCurrentRecord,
  getHistory,
  subscribe,
  type PageLatencyRecord,
} from '@/lib/pageLatency';

function formatRecord(r: PageLatencyRecord): string {
  const render = r.renderMs === null ? '—' : `${r.renderMs} ms`;
  const ready = r.readyMs === null ? '—' : `${r.readyMs} ms`;
  return `${r.route} · render ${render} · ready ${ready} · ${r.apiCount} api / ${r.apiTotalMs} ms`;
}

export const DebugLatencyHud: React.FC = () => {
  const [active, setActive] = useState(isPageLatencyActive());
  const [current, setCurrent] = useState<PageLatencyRecord | null>(getCurrentRecord());
  const [history, setHistory] = useState<PageLatencyRecord[]>(getHistory());
  const [expanded, setExpanded] = useState(false);

  // Poll for the debug-mode toggle (Settings page / another tab flips
  // localStorage; import.meta.env.DEV never changes at runtime) — same
  // pattern as PerformanceOverlay.
  useEffect(() => {
    const id = setInterval(() => setActive(isPageLatencyActive()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!active) return;
    const refresh = () => {
      setCurrent(getCurrentRecord());
      setHistory(getHistory());
    };
    refresh();
    return subscribe(refresh);
  }, [active]);

  if (!active || !current) return null;

  return (
    <div
      data-testid="debug-latency-hud"
      onClick={() => setExpanded(v => !v)}
      onMouseEnter={() => setExpanded(true)}
      onMouseLeave={() => setExpanded(false)}
      className="fixed bottom-3 right-3 z-50 select-none"
    >
      {expanded && history.length > 0 && (
        <div
          data-testid="debug-latency-hud-history"
          className="mb-1 w-80 max-h-64 overflow-auto rounded-md border border-slate-700 bg-slate-900/95 backdrop-blur text-[10px] text-slate-200 shadow-xl p-2 space-y-1 font-mono"
        >
          {history.map((r, i) => (
            <div key={`${r.route}-${r.startedAt}-${i}`} className="truncate">{formatRecord(r)}</div>
          ))}
        </div>
      )}
      <div className="rounded-md border border-slate-700 bg-slate-900/90 backdrop-blur text-[10px] text-slate-200 font-mono px-2 py-1 shadow-lg cursor-pointer">
        {formatRecord(current)}
      </div>
    </div>
  );
};

export default DebugLatencyHud;
