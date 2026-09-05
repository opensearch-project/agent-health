/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pass rate over time, one line per agent — the graph that sits above the
 * benchmark Runs table. Legend entries are clickable and act as agent filters
 * (same toggle semantics as clicking an Agent cell in the table).
 */

import React from 'react';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer,
} from 'recharts';
import { formatDate } from '@/lib/utils';
import { PassRateSeries, PassRatePoint, seriesColor } from '@/lib/benchmarkRunsTable';

interface Props {
  series: PassRateSeries[];
  /** agentKeys currently used as active filters (highlighted in the legend). */
  activeAgentKeys: Set<string>;
  onToggleAgent: (agentKey: string, label: string) => void;
  height?: number;
}

const DAY_MS = 86_400_000;

/**
 * Explicit X-axis ticks. recharts' auto ticks on a `scale="time"` axis with
 * several independent `<Line data>` series picked two ticks on the same day
 * ("Aug 31 · Aug 31") and nothing further right, so we compute them: one tick
 * per local-midnight when the span covers ≥2 days (thinned to ≤8), else every
 * 6 hours labelled with the hour.
 */
export function computeTimeTicks(minT: number, maxT: number): { ticks: number[]; dense: boolean } {
  if (!Number.isFinite(minT) || !Number.isFinite(maxT) || maxT < minT) return { ticks: [], dense: false };
  const span = maxT - minT;
  const dense = span < 2 * DAY_MS;
  const step = dense ? 6 * 3_600_000 : DAY_MS;
  const start = new Date(minT);
  if (dense) start.setMinutes(0, 0, 0); else start.setHours(0, 0, 0, 0);
  const ticks: number[] = [];
  for (let t = start.getTime(); t <= maxT + step; t += step) {
    if (t >= minT - step) ticks.push(t);
  }
  // Thin to at most 8 labels so they never collide.
  const maxTicks = 8;
  if (ticks.length > maxTicks) {
    const every = Math.ceil(ticks.length / maxTicks);
    return { ticks: ticks.filter((_, i) => i % every === 0), dense };
  }
  return { ticks, dense };
}

export function makeTickFormatter(dense: boolean): (t: number) => string {
  return (t: number) => new Date(t).toLocaleString('en-US', dense
    ? { month: 'short', day: 'numeric', hour: 'numeric' }
    : { month: 'short', day: 'numeric' });
}

// Recharts hands the tooltip one payload entry per series that has a point at
// the hovered x — render them all rather than assuming payload[0] is "the" point
// (two agents can have runs at the same instant).
const PointTooltip: React.FC<{ active?: boolean; payload?: Array<{ payload: PassRatePoint; color?: string; name?: string }> }> = ({ active, payload }) => {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="rounded-md border bg-popover px-2.5 py-1.5 text-[11px] shadow-md space-y-1">
      {payload.map((p, i) => {
        const pt = p.payload;
        return (
          <div key={`${pt.runId}-${i}`}>
            <div className="font-medium truncate max-w-[260px]">{pt.runName}</div>
            <div className="text-muted-foreground">{p.name} · {formatDate(new Date(pt.t).toISOString())}</div>
            <div>
              <span style={{ color: p.color }} className="font-semibold">{pt.passRate}%</span>
              <span className="text-muted-foreground"> · {pt.passed} pass / {pt.failed} fail / {pt.total} total</span>
            </div>
          </div>
        );
      })}
    </div>
  );
};

export const BenchmarkPassRateChart: React.FC<Props> = ({
  series, activeAgentKeys, onToggleAgent, height = 150,
}) => {
  if (series.length === 0) {
    return (
      <div
        data-testid="benchmark-passrate-chart-empty"
        className="flex items-center justify-center text-muted-foreground text-xs border border-dashed rounded-md"
        style={{ height }}
      >
        No evaluated runs to chart yet
      </div>
    );
  }

  const hasActive = activeAgentKeys.size > 0;
  const allT = series.flatMap(s => s.points.map(p => p.t));
  const minT = Math.min(...allT);
  const maxT = Math.max(...allT);
  // A single point (or all runs in one instant) needs a non-zero domain or
  // recharts collapses the axis; pad by a day on each side.
  const pad = maxT - minT > 0 ? (maxT - minT) * 0.04 : 86_400_000;
  const { ticks, dense } = computeTimeTicks(minT, maxT);
  const tickTime = makeTickFormatter(dense);

  return (
    <div data-testid="benchmark-passrate-chart" className="rounded-md border bg-card px-2 pt-2 pb-1">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-1 sm:gap-3 px-1 mb-1">
        <span className="text-[11px] font-medium text-muted-foreground whitespace-nowrap pt-0.5">Pass rate over time</span>
        <ul className="flex flex-wrap items-center sm:justify-end gap-x-2 gap-y-0.5" aria-label="Agents">
          {series.map((s, i) => {
            const active = activeAgentKeys.has(s.key);
            const dim = hasActive && !active;
            return (
              <li key={s.key}>
                <button
                  type="button"
                  data-testid={`chart-legend-${s.key}`}
                  aria-pressed={active}
                  onClick={() => onToggleAgent(s.key, s.label)}
                  className={`inline-flex items-center gap-1.5 text-[11px] rounded px-1 py-0.5 hover:bg-muted transition-colors ${dim ? 'opacity-40' : ''} ${active ? 'bg-muted font-medium' : ''}`}
                  title={active ? 'Remove agent filter' : 'Filter table to this agent'}
                >
                  <span className="inline-block h-2 w-2 rounded-full" style={{ background: seriesColor(i) }} />
                  <span className="truncate max-w-[180px]">{s.label}</span>
                  <span className="text-muted-foreground">({s.points.length})</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      <ResponsiveContainer width="100%" height={height}>
        <LineChart margin={{ top: 6, right: 12, left: -18, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
          <XAxis
            dataKey="t"
            type="number"
            domain={[minT - pad, maxT + pad]}
            scale="time"
            ticks={ticks}
            tickFormatter={tickTime}
            tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }}
            tickLine={false}
            axisLine={{ stroke: 'hsl(var(--border))' }}
          />
          <YAxis
            domain={[0, 100]}
            ticks={[0, 25, 50, 75, 100]}
            tickFormatter={v => `${v}%`}
            tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }}
            tickLine={false}
            axisLine={false}
            width={52}
          />
          <Tooltip content={<PointTooltip />} cursor={{ stroke: 'hsl(var(--border))' }} />
          {series.map((s, i) => {
            const dim = hasActive && !activeAgentKeys.has(s.key);
            return (
              <Line
                key={s.key}
                data={s.points}
                dataKey="passRate"
                name={s.label}
                type="monotone"
                stroke={seriesColor(i)}
                strokeWidth={dim ? 1 : 2}
                strokeOpacity={dim ? 0.25 : 1}
                dot={{ r: 3, strokeWidth: 0, fill: seriesColor(i), fillOpacity: dim ? 0.25 : 1 }}
                activeDot={{ r: 5 }}
                isAnimationActive={false}
                connectNulls
              />
            );
          })}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
};
