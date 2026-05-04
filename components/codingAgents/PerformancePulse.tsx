/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo } from 'react';
import {
  ComposedChart, Area, Line, Bar,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend,
  RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

// ─── Shared constants (must match CodingAgentsPage) ─────────────────────────

const AGENT_COLORS: Record<string, string> = {
  'claude-code': '#f97316',
  'kiro': '#8b5cf6',
  'codex': '#10b981',
};

const AGENT_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  'kiro': 'Kiro',
  'codex': 'Codex CLI',
};

const TOOLTIP_STYLE = {
  contentStyle: {
    backgroundColor: 'hsl(var(--card))',
    border: '1px solid hsl(var(--border))',
    borderRadius: '6px',
  },
  labelStyle: { color: 'hsl(var(--foreground))' },
  itemStyle: { color: 'hsl(var(--foreground))' },
};

const AXIS_PROPS = {
  tick: { fontSize: 12 },
  className: 'text-muted-foreground',
  tickLine: false as const,
  axisLine: false as const,
};

// ─── Types ──────────────────────────────────────────────────────────────────

export interface EvalTrendPoint {
  date: string;       // YYYY-MM-DD
  agentKey: string;
  passRate: number;   // 0-100
  runCount: number;
}

/** Re-exported subset of types from CodingAgentsPage to avoid circular deps */
interface AgentStats {
  agent: string;
  totalSessions: number;
  totalCost: number;
  totalCacheSavings: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalToolCalls: number;
  totalToolErrors: number;
  toolSuccessRate: number;
  completedSessions: number;
  costPerCompletion: number;
  activeDays: number;
  avgSessionMinutes: number;
  dailyActivity: Array<{ date: string; sessionCount: number; messageCount: number; toolCallCount: number }>;
}

interface CombinedStats {
  agents: AgentStats[];
  dailyActivity: Array<{ date: string; sessionCount: number; messageCount: number }>;
  totalCost: number;
  totalSessions: number;
  totalTokens: number;
  wastedCost: number;
  abandonedSessions: number;
}

interface EfficiencyAgent {
  agent: string;
  toolSuccessRate: number;
  completedSessions: number;
  totalSessions: number;
  completionRate: number;
  costPerCompletion: number;
  totalToolErrors: number;
  totalToolCalls: number;
}

interface EfficiencyData {
  agents: EfficiencyAgent[];
  combined: {
    toolSuccessRate: number;
    completionRate: number;
    avgCostPerCompletion: number;
  };
}

interface DailyCost {
  date: string;
  cost: number;
  agent: string;
}

interface CostAnalytics {
  total_cost: number;
  total_savings: number;
  models: Array<{ agent: string; model: string; estimated_cost: number; input_tokens: number; output_tokens: number }>;
  by_project: Array<{ agent: string; project_path: string; display_name: string; estimated_cost: number }>;
  daily_costs: DailyCost[];
}

// ─── Formatters ─────────────────────────────────────────────────────────────

function formatCost(cost: number): string {
  if (cost === 0) return '$0.00';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

function formatPct(n: number): string {
  return `${n.toFixed(0)}%`;
}

function formatDateLabel(dateStr: string): string {
  const date = new Date(dateStr + 'T00:00:00');
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ─── Data Transforms ────────────────────────────────────────────────────────

interface PulseDataPoint {
  date: string;
  [key: string]: number | string;
}

export function buildPulseData(
  stats: CombinedStats,
  costs: CostAnalytics | null,
  evalTrends: EvalTrendPoint[] | null,
): PulseDataPoint[] {
  const dateMap = new Map<string, PulseDataPoint>();

  // Collect daily activity per agent — derive daily completion rate
  for (const agent of stats.agents) {
    // Pre-compute per-day completion count from the overall ratio
    const completionRate = agent.totalSessions > 0
      ? agent.completedSessions / agent.totalSessions : 0;

    for (const day of agent.dailyActivity) {
      if (!dateMap.has(day.date)) dateMap.set(day.date, { date: day.date });
      const pt = dateMap.get(day.date)!;
      // Tool success: use agent-level rate (daily breakdown not available)
      pt[`${agent.agent}_toolSuccess`] = Math.round(agent.toolSuccessRate * 100);
      // Completion rate: use agent-level rate as daily proxy
      pt[`${agent.agent}_completion`] = Math.round(completionRate * 100);
    }
  }

  // Layer in daily cost data
  if (costs) {
    for (const dc of costs.daily_costs) {
      if (!dateMap.has(dc.date)) dateMap.set(dc.date, { date: dc.date });
      const pt = dateMap.get(dc.date)!;
      // Accumulate if multiple entries per agent per day
      const key = `${dc.agent}_cost`;
      pt[key] = ((pt[key] as number) || 0) + dc.cost;
    }
  }

  // Layer in eval pass rates (optional)
  if (evalTrends && evalTrends.length > 0) {
    for (const ev of evalTrends) {
      if (!dateMap.has(ev.date)) dateMap.set(ev.date, { date: ev.date });
      const pt = dateMap.get(ev.date)!;
      pt[`${ev.agentKey}_evalPass`] = Math.round(ev.passRate);
    }
  }

  return [...dateMap.values()].sort((a, b) => a.date.localeCompare(b.date));
}

const RADAR_DIMS_WITH_EVAL = ['Tool Success', 'Completion', 'Cost Efficiency', 'Speed', 'Eval Pass'] as const;
const RADAR_DIMS_NO_EVAL = ['Tool Success', 'Completion', 'Cost Efficiency', 'Speed'] as const;

export function buildRadarData(
  efficiency: EfficiencyData,
  stats: CombinedStats,
  evalTrends: EvalTrendPoint[] | null,
): Array<Record<string, number | string>> {
  const hasEval = evalTrends && evalTrends.length > 0;
  const dims = hasEval ? RADAR_DIMS_WITH_EVAL : RADAR_DIMS_NO_EVAL;

  const maxCost = Math.max(...efficiency.agents.map(a => a.costPerCompletion), 0.01);
  const maxDuration = Math.max(...stats.agents.map(a => a.avgSessionMinutes), 1);

  // Pre-compute average eval pass rate per agent
  const evalByAgent = new Map<string, number>();
  if (hasEval) {
    const sums = new Map<string, { total: number; count: number }>();
    for (const ev of evalTrends!) {
      const existing = sums.get(ev.agentKey) || { total: 0, count: 0 };
      existing.total += ev.passRate;
      existing.count += 1;
      sums.set(ev.agentKey, existing);
    }
    for (const [key, val] of sums) {
      evalByAgent.set(key, val.total / val.count);
    }
  }

  return dims.map(dim => {
    const point: Record<string, number | string> = { dimension: dim };

    for (const a of efficiency.agents) {
      const agentStats = stats.agents.find(s => s.agent === a.agent);
      switch (dim) {
        case 'Tool Success':
          point[a.agent] = Math.round(a.toolSuccessRate * 100);
          break;
        case 'Completion':
          point[a.agent] = Math.round(a.completionRate * 100);
          break;
        case 'Cost Efficiency':
          point[a.agent] = Math.round(maxCost > 0
            ? (1 - a.costPerCompletion / maxCost) * 100 : 100);
          break;
        case 'Speed':
          point[a.agent] = agentStats
            ? Math.round((1 - agentStats.avgSessionMinutes / maxDuration) * 100)
            : 50;
          break;
        case 'Eval Pass':
          point[a.agent] = Math.round(evalByAgent.get(a.agent) ?? 0);
          break;
      }
    }
    return point;
  });
}

type TrendDir = 'up' | 'down' | 'flat';

interface SparkData {
  agent: string;
  metric: string;
  points: number[];
  trend: TrendDir;
}

export function getTrend(points: number[]): TrendDir {
  if (points.length < 2) return 'flat';
  const windowSize = Math.min(3, Math.ceil(points.length / 2));
  const first = points.slice(0, windowSize).reduce((a, b) => a + b, 0) / windowSize;
  const last = points.slice(-windowSize).reduce((a, b) => a + b, 0) / windowSize;
  if (first === 0) return last > 0 ? 'up' : 'flat';
  const delta = (last - first) / first;
  if (delta > 0.05) return 'up';
  if (delta < -0.05) return 'down';
  return 'flat';
}

// ─── Component 1: Performance Pulse Chart ───────────────────────────────────

function PerformancePulseChart({ stats, costs, evalTrends }: {
  stats: CombinedStats;
  costs: CostAnalytics | null;
  evalTrends: EvalTrendPoint[] | null;
}) {
  const data = useMemo(
    () => buildPulseData(stats, costs, evalTrends),
    [stats, costs, evalTrends],
  );
  const agents = stats.agents.filter(a => a.totalSessions > 0).map(a => a.agent);
  const hasEval = evalTrends && evalTrends.length > 0;
  const hasCost = costs && costs.daily_costs.length > 0;

  if (data.length < 2) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center h-[200px]">
          <p className="text-sm text-muted-foreground">Need at least 2 days of data to show trends</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">Daily Trends</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={280}>
          <ComposedChart data={data} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
            <defs>
              {agents.map(agent => (
                <linearGradient key={`pulse-grad-${agent}`} id={`pulse-grad-${agent}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={AGENT_COLORS[agent] ?? '#3b82f6'} stopOpacity={0.2} />
                  <stop offset="100%" stopColor={AGENT_COLORS[agent] ?? '#3b82f6'} stopOpacity={0} />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
            <XAxis dataKey="date" {...AXIS_PROPS} tickFormatter={formatDateLabel} />
            <YAxis yAxisId="pct" domain={[0, 100]} {...AXIS_PROPS} tickFormatter={(v: number) => `${v}%`} width={45} />
            {hasCost && (
              <YAxis yAxisId="cost" orientation="right" {...AXIS_PROPS} tickFormatter={(v: number) => formatCost(v)} width={55} />
            )}
            <Tooltip
              {...TOOLTIP_STYLE}
              labelFormatter={(label) => formatDateLabel(label as string)}
              formatter={(value: number, name: string) => {
                if (name.endsWith('_cost')) return [formatCost(value), 'Cost'];
                return [`${value}%`, name.replace(/_/g, ' ').replace(/^[^ ]+ /, '')];
              }}
            />
            {agents.map(agent => {
              const color = AGENT_COLORS[agent] ?? '#3b82f6';
              const label = AGENT_LABELS[agent] ?? agent;
              return (
                <React.Fragment key={agent}>
                  {/* Tool success — filled area */}
                  <Area
                    yAxisId="pct"
                    type="monotone"
                    dataKey={`${agent}_toolSuccess`}
                    name={`${label} Tool Success`}
                    fill={`url(#pulse-grad-${agent})`}
                    stroke={color}
                    strokeWidth={1.5}
                    connectNulls
                    dot={false}
                  />
                  {/* Completion rate — solid line */}
                  <Line
                    yAxisId="pct"
                    type="monotone"
                    dataKey={`${agent}_completion`}
                    name={`${label} Completion`}
                    stroke={color}
                    strokeWidth={2}
                    strokeDasharray=""
                    connectNulls
                    dot={false}
                    legendType="plainline"
                  />
                  {/* Cost per session — translucent bars */}
                  {hasCost && (
                    <Bar
                      yAxisId="cost"
                      dataKey={`${agent}_cost`}
                      name={`${label} Cost`}
                      fill={color}
                      fillOpacity={0.15}
                      legendType="rect"
                    />
                  )}
                  {/* Eval pass rate — dashed line (conditional) */}
                  {hasEval && (
                    <Line
                      yAxisId="pct"
                      type="monotone"
                      dataKey={`${agent}_evalPass`}
                      name={`${label} Eval Pass`}
                      stroke={color}
                      strokeWidth={1.5}
                      strokeDasharray="6 3"
                      connectNulls
                      dot={false}
                      legendType="plainline"
                    />
                  )}
                </React.Fragment>
              );
            })}
            <Legend
              wrapperStyle={{ paddingTop: '10px' }}
              formatter={(value) => <span className="text-xs text-muted-foreground">{value}</span>}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

// ─── Component 2: Agent Scorecard (Radar) ───────────────────────────────────

function AgentScorecard({ efficiency, stats, evalTrends }: {
  efficiency: EfficiencyData;
  stats: CombinedStats;
  evalTrends: EvalTrendPoint[] | null;
}) {
  const data = useMemo(
    () => buildRadarData(efficiency, stats, evalTrends),
    [efficiency, stats, evalTrends],
  );
  const agents = efficiency.agents.filter(a => a.totalSessions > 0);

  if (agents.length === 0) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center h-[300px]">
          <p className="text-sm text-muted-foreground">No agent data for scorecard</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">Agent Scorecard</CardTitle>
        <p className="text-xs text-muted-foreground">Higher is better on all axes. Cost &amp; Speed are inverted (lower cost / faster = higher score).</p>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={300}>
          <RadarChart data={data} cx="50%" cy="50%" outerRadius="75%">
            <PolarGrid className="stroke-muted" />
            <PolarAngleAxis
              dataKey="dimension"
              tick={{ fontSize: 11 }}
              className="text-muted-foreground"
            />
            <PolarRadiusAxis
              domain={[0, 100]}
              tick={false}
              axisLine={false}
            />
            {agents.map(a => (
              <Radar
                key={a.agent}
                dataKey={a.agent}
                name={AGENT_LABELS[a.agent] ?? a.agent}
                stroke={AGENT_COLORS[a.agent] ?? '#3b82f6'}
                fill={AGENT_COLORS[a.agent] ?? '#3b82f6'}
                fillOpacity={0.1}
                strokeWidth={2}
              />
            ))}
            <Legend
              wrapperStyle={{ paddingTop: '10px' }}
              formatter={(value) => <span className="text-xs text-muted-foreground">{value}</span>}
            />
            <Tooltip {...TOOLTIP_STYLE} formatter={(value: number) => [`${value}%`]} />
          </RadarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

// ─── Component 3: Trend Pulse (Sparklines) ──────────────────────────────────

function MiniSparkline({ points, color }: { points: number[]; color: string }) {
  if (points.length < 2) return <div className="w-[60px] h-[20px]" />;
  const max = Math.max(...points);
  const min = Math.min(...points);
  const range = max - min || 1;
  const polyline = points
    .map((v, i) => `${(i / (points.length - 1)) * 60},${20 - ((v - min) / range) * 16 - 2}`)
    .join(' ');
  return (
    <svg width={60} height={20} viewBox="0 0 60 20" className="flex-shrink-0">
      <polyline points={polyline} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function TrendPulse({ stats }: { stats: CombinedStats }) {
  const sparkData = useMemo(() => {
    const result: SparkData[] = [];
    for (const agent of stats.agents) {
      if (agent.totalSessions === 0) continue;
      const last7 = agent.dailyActivity.slice(-7);
      if (last7.length === 0) continue;

      // Session count trend
      const sessionPts = last7.map(d => d.sessionCount);
      result.push({
        agent: agent.agent,
        metric: 'Sessions',
        points: sessionPts,
        trend: getTrend(sessionPts),
      });

      // Tool call volume trend
      const toolPts = last7.map(d => d.toolCallCount);
      result.push({
        agent: agent.agent,
        metric: 'Tool Calls',
        points: toolPts,
        trend: getTrend(toolPts),
      });

      // Message volume trend
      const msgPts = last7.map(d => d.messageCount);
      result.push({
        agent: agent.agent,
        metric: 'Messages',
        points: msgPts,
        trend: getTrend(msgPts),
      });
    }
    return result;
  }, [stats]);

  if (sparkData.length === 0) return null;

  const trendDotClass = (t: TrendDir) =>
    t === 'up' ? 'bg-green-500' : t === 'down' ? 'bg-red-500' : 'bg-gray-400';

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">7-Day Trend Pulse</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-3">
          {sparkData.map((s, i) => (
            <div
              key={i}
              className="flex items-center gap-2 px-3 py-2 bg-muted/30 border rounded-lg"
            >
              <div
                className="w-2 h-2 rounded-full flex-shrink-0"
                style={{ background: AGENT_COLORS[s.agent] ?? '#6b7280' }}
              />
              <span className="text-[11px] text-muted-foreground whitespace-nowrap">
                {(AGENT_LABELS[s.agent] ?? s.agent).split(' ')[0]} {s.metric}
              </span>
              <MiniSparkline
                points={s.points}
                color={AGENT_COLORS[s.agent] ?? '#6b7280'}
              />
              <div className={`w-2 h-2 rounded-full flex-shrink-0 ${trendDotClass(s.trend)}`}
                title={s.trend === 'up' ? 'Improving' : s.trend === 'down' ? 'Regressing' : 'Stable'}
              />
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Main Section Wrapper ───────────────────────────────────────────────────

export interface PerformancePulseSectionProps {
  stats: CombinedStats | null;
  efficiency: EfficiencyData | null;
  costs: CostAnalytics | null;
  evalTrends: EvalTrendPoint[] | null;
}

export function PerformancePulseSection({ stats, efficiency, costs, evalTrends }: PerformancePulseSectionProps) {
  if (!stats || stats.totalSessions === 0) return null;

  const loading = !efficiency;

  return (
    <div className="space-y-4">
      {/* Trend Pulse sparkline strip */}
      <TrendPulse stats={stats} />

      {/* Pulse chart + Radar side by side on large screens */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        <div className="lg:col-span-3">
          <PerformancePulseChart stats={stats} costs={costs} evalTrends={evalTrends} />
        </div>
        <div className="lg:col-span-2">
          {loading ? (
            <Card>
              <CardContent className="pt-6 space-y-4">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-[260px] w-full" />
              </CardContent>
            </Card>
          ) : (
            <AgentScorecard efficiency={efficiency} stats={stats} evalTrends={evalTrends} />
          )}
        </div>
      </div>
    </div>
  );
}
