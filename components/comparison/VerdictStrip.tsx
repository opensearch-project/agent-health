/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Trophy, Coins, Clock, CheckCircle2, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { cn, getModelName } from '@/lib/utils';
import { DEFAULT_CONFIG } from '@/lib/constants';
import type { RunAggregateMetrics } from '@/types';
import type { ComparisonMode } from '@/services/comparisonService';

interface VerdictStripProps {
  mode: ComparisonMode;
  runs: RunAggregateMetrics[];
}

const getAgentName = (agentKey: string): string =>
  DEFAULT_CONFIG.agents.find(a => a.key === agentKey)?.name || agentKey;

const formatCost = (usd: number | undefined): string => {
  if (usd === undefined) return '—';
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return '<$0.01';
  if (usd < 1) return `$${usd.toFixed(3)}`;
  if (usd < 100) return `$${usd.toFixed(2)}`;
  return `$${Math.round(usd)}`;
};

const formatDuration = (ms: number | undefined): string => {
  if (ms === undefined) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
};

interface DeltaBadgeProps {
  delta: number;
  /** When true, a positive delta is bad (cost, duration). */
  invert?: boolean;
  format: (v: number) => string;
}

const DeltaBadge: React.FC<DeltaBadgeProps> = ({ delta, invert = false, format }) => {
  if (!isFinite(delta) || delta === 0) {
    return (
      <span className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground">
        <Minus size={10} /> {format(0)}
      </span>
    );
  }
  const goodDirection = invert ? delta < 0 : delta > 0;
  const Icon = delta > 0 ? TrendingUp : TrendingDown;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 text-[10px] font-medium',
        goodDirection ? 'text-opensearch-blue' : 'text-red-400'
      )}
    >
      <Icon size={10} />
      {delta > 0 ? '+' : ''}
      {format(delta)}
    </span>
  );
};

interface MetricChipProps {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  primaryValue: string;
  secondaryValue?: string;
  delta?: React.ReactNode;
  tooltip?: string;
}

const MetricChip: React.FC<MetricChipProps> = ({
  icon: Icon,
  label,
  primaryValue,
  secondaryValue,
  delta,
  tooltip,
}) => (
  <div
    className="flex flex-col gap-0.5 rounded-md border border-border bg-muted/30 px-3 py-2 min-w-[140px]"
    title={tooltip}
  >
    <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
      <Icon size={11} />
      <span>{label}</span>
    </div>
    <div className="flex items-baseline gap-2">
      <span className="text-base font-semibold text-foreground tabular-nums">{primaryValue}</span>
      {secondaryValue && (
        <span className="text-[10px] text-muted-foreground tabular-nums">vs {secondaryValue}</span>
      )}
    </div>
    {delta && <div className="-mt-0.5">{delta}</div>}
  </div>
);

// ─── Compare mode (head-to-head) ──────────────────────────────────────────

const CompareVerdict: React.FC<{ runs: RunAggregateMetrics[] }> = ({ runs }) => {
  if (runs.length < 2) return null;

  // Pick winner by pass rate; tie-break on accuracy, then on cost (lower).
  const sorted = [...runs].sort((a, b) => {
    if (b.passRatePercent !== a.passRatePercent) return b.passRatePercent - a.passRatePercent;
    if (b.avgAccuracy !== a.avgAccuracy) return b.avgAccuracy - a.avgAccuracy;
    const aCost = a.totalCostUsd ?? Infinity;
    const bCost = b.totalCostUsd ?? Infinity;
    return aCost - bCost;
  });

  const winner = sorted[0];
  const loser = sorted[sorted.length - 1];

  const deltaPassRate = winner.passRatePercent - loser.passRatePercent;
  const winnerCost = winner.totalCostUsd;
  const loserCost = loser.totalCostUsd;
  const deltaCost =
    winnerCost !== undefined && loserCost !== undefined
      ? winnerCost - loserCost
      : undefined;
  const winnerDur = winner.avgDurationMs;
  const loserDur = loser.avgDurationMs;
  const deltaDur =
    winnerDur !== undefined && loserDur !== undefined ? winnerDur - loserDur : undefined;

  const isTie = deltaPassRate === 0 && winner.avgAccuracy === loser.avgAccuracy;
  const totalCases = winner.totalTestCases;

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <div className="flex items-center gap-2 min-w-0">
          <Trophy size={16} className={isTie ? 'text-muted-foreground' : 'text-amber-400 shrink-0'} />
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {isTie ? 'Tie' : 'Winner'}
            </div>
            <div className="text-sm font-semibold leading-tight truncate">
              {isTie ? (
                <>
                  {getAgentName(winner.agentKey)} ≈ {getAgentName(loser.agentKey)}
                </>
              ) : (
                <>
                  <span title={getAgentName(winner.agentKey)}>{getAgentName(winner.agentKey)}</span>
                  <span className="text-muted-foreground font-normal"> beats </span>
                  <span title={getAgentName(loser.agentKey)}>{getAgentName(loser.agentKey)}</span>
                </>
              )}
            </div>
            <div className="text-[10px] text-muted-foreground truncate">
              {winner.runName} ({getModelName(winner.modelId)}) vs {loser.runName} ({getModelName(loser.modelId)}) · n={totalCases}
            </div>
          </div>
        </div>

        <div className="ml-auto flex flex-wrap items-stretch gap-2">
          <MetricChip
            icon={CheckCircle2}
            label="Pass rate"
            primaryValue={`${winner.passRatePercent}%`}
            secondaryValue={`${loser.passRatePercent}%`}
            delta={
              <DeltaBadge
                delta={deltaPassRate}
                format={(v) => `${Math.abs(Math.round(v))}pp`}
              />
            }
            tooltip="Winner pass rate vs loser pass rate, with delta in percentage points"
          />
          {(winnerCost !== undefined || loserCost !== undefined) && (
            <MetricChip
              icon={Coins}
              label="Cost"
              primaryValue={formatCost(winnerCost)}
              secondaryValue={loserCost !== undefined ? formatCost(loserCost) : undefined}
              delta={
                deltaCost !== undefined ? (
                  <DeltaBadge
                    delta={deltaCost}
                    invert
                    format={(v) => formatCost(Math.abs(v))}
                  />
                ) : undefined
              }
              tooltip="Total cost — flagged red if winner is also more expensive"
            />
          )}
          {(winnerDur !== undefined || loserDur !== undefined) && (
          <MetricChip
            icon={Clock}
            label="Avg duration"
            primaryValue={formatDuration(winnerDur)}
            secondaryValue={loserDur !== undefined ? formatDuration(loserDur) : undefined}
            delta={
              deltaDur !== undefined ? (
                <DeltaBadge
                  delta={deltaDur}
                  invert
                  format={(v) => formatDuration(Math.abs(v))}
                />
              ) : undefined
            }
            tooltip="Average per-case duration"
          />
          )}
        </div>
      </div>
    </div>
  );
};

// ─── Iterate mode (one agent over time) ───────────────────────────────────

interface SparklineProps {
  values: number[];
  color: string;
}

const Sparkline: React.FC<SparklineProps> = ({ values, color }) => {
  if (values.length < 2) {
    return <div className="h-6 w-full text-[10px] text-muted-foreground">—</div>;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const w = 100;
  const h = 24;
  const stepX = w / (values.length - 1);
  const points = values
    .map((v, i) => `${(i * stepX).toFixed(2)},${(h - ((v - min) / range) * h).toFixed(2)}`)
    .join(' ');

  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="h-6 w-full">
      <polyline
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        points={points}
      />
    </svg>
  );
};

const IterateVerdict: React.FC<{ runs: RunAggregateMetrics[] }> = ({ runs }) => {
  if (runs.length === 0) return null;

  const sorted = [...runs].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );
  const latest = sorted[sorted.length - 1];
  const previous = sorted.length >= 2 ? sorted[sorted.length - 2] : undefined;

  const passRates = sorted.map(r => r.passRatePercent);
  const costs = sorted.map(r => r.totalCostUsd ?? 0);
  const durations = sorted.map(r => r.avgDurationMs ?? 0);

  const passDelta = previous ? latest.passRatePercent - previous.passRatePercent : 0;
  const costDelta =
    previous && latest.totalCostUsd !== undefined && previous.totalCostUsd !== undefined
      ? latest.totalCostUsd - previous.totalCostUsd
      : undefined;
  const durDelta =
    previous && latest.avgDurationMs !== undefined && previous.avgDurationMs !== undefined
      ? latest.avgDurationMs - previous.avgDurationMs
      : undefined;

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-stretch gap-3 px-4 py-3">
        <div className="flex flex-col justify-center min-w-[180px]">
          <div className="flex items-center gap-2">
            <TrendingUp size={14} className="text-opensearch-blue" />
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Iteration trend
            </div>
          </div>
          <div className="text-sm font-semibold leading-tight mt-1">
            {getAgentName(latest.agentKey)}
          </div>
          <div className="text-[10px] text-muted-foreground">
            {sorted.length} runs · latest: {latest.runName}
          </div>
        </div>

        <div className="flex-1 grid grid-cols-1 sm:grid-cols-3 gap-2">
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2">
            <div className="flex items-center justify-between text-[10px] uppercase tracking-wide text-muted-foreground">
              <span className="flex items-center gap-1"><CheckCircle2 size={11} /> Pass rate</span>
              <span className="text-base font-semibold text-foreground tabular-nums normal-case">
                {latest.passRatePercent}%
              </span>
            </div>
            <Sparkline values={passRates} color="rgb(96 165 250)" />
            {previous && (
              <div className="text-[10px] mt-0.5">
                <DeltaBadge delta={passDelta} format={(v) => `${Math.abs(Math.round(v))}pp`} />
                <span className="text-muted-foreground ml-1">vs prev</span>
              </div>
            )}
          </div>

          <div className="rounded-md border border-border bg-muted/30 px-3 py-2">
            <div className="flex items-center justify-between text-[10px] uppercase tracking-wide text-muted-foreground">
              <span className="flex items-center gap-1"><Coins size={11} /> Cost</span>
              <span className="text-base font-semibold text-foreground tabular-nums normal-case">
                {formatCost(latest.totalCostUsd)}
              </span>
            </div>
            <Sparkline values={costs} color="rgb(251 191 36)" />
            {costDelta !== undefined && (
              <div className="text-[10px] mt-0.5">
                <DeltaBadge delta={costDelta} invert format={(v) => formatCost(Math.abs(v))} />
                <span className="text-muted-foreground ml-1">vs prev</span>
              </div>
            )}
          </div>

          <div className="rounded-md border border-border bg-muted/30 px-3 py-2">
            <div className="flex items-center justify-between text-[10px] uppercase tracking-wide text-muted-foreground">
              <span className="flex items-center gap-1"><Clock size={11} /> Avg duration</span>
              <span className="text-base font-semibold text-foreground tabular-nums normal-case">
                {formatDuration(latest.avgDurationMs)}
              </span>
            </div>
            <Sparkline values={durations} color="rgb(248 113 113)" />
            {durDelta !== undefined && (
              <div className="text-[10px] mt-0.5">
                <DeltaBadge delta={durDelta} invert format={(v) => formatDuration(Math.abs(v))} />
                <span className="text-muted-foreground ml-1">vs prev</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

// ─── Public component ─────────────────────────────────────────────────────

export const VerdictStrip: React.FC<VerdictStripProps> = ({ mode, runs }) => {
  if (runs.length === 0) return null;
  if (mode === 'compare' && runs.length >= 2) return <CompareVerdict runs={runs} />;
  return <IterateVerdict runs={runs} />;
};
