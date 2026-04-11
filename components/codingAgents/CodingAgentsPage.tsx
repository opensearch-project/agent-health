/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { ENV_CONFIG } from '@/lib/config';
import { RefreshCw } from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid, Cell, PieChart, Pie,
  LineChart, Line, Legend,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

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

// ─── Types ───────────────────────────────────────────────────────────────────

interface AgentInfo { name: string; displayName: string }
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
interface Insight {
  type: 'warning' | 'tip' | 'info' | 'success';
  title: string;
  description: string;
  agent?: string;
  linkTab?: string;
}
interface CombinedStats {
  agents: AgentStats[];
  dailyActivity: Array<{ date: string; sessionCount: number; messageCount: number }>;
  totalCost: number;
  totalSessions: number;
  totalTokens: number;
  wastedCost: number;
  abandonedSessions: number;
  insights: Insight[];
  warming?: boolean;
  loadedDays?: number;
}
interface Session {
  agent: string;
  session_id: string;
  project_path: string;
  start_time: string;
  duration_minutes: number;
  user_message_count: number;
  assistant_message_count: number;
  input_tokens: number;
  output_tokens: number;
  first_prompt: string;
  estimated_cost: number;
  session_completed: boolean;
  tool_counts: Record<string, number>;
  server_name?: string;
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
interface ActivityData {
  daily_activity: Array<{ date: string; sessionCount: number; messageCount: number }>;
  hour_counts: Array<{ hour: number; count: number }>;
  dow_counts: Array<{ day: string; count: number }>;
  streaks: { current: number; longest: number };
  total_active_days: number;
}
interface ToolData {
  agent: string;
  name: string;
  category: string;
  total_calls: number;
  session_count: number;
  error_count: number;
  success_rate: number;
}
interface ToolsData {
  tools: ToolData[];
  total_tool_calls: number;
  total_tool_errors: number;
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
// Phase 2
interface SessionMessage {
  role: 'user' | 'assistant' | 'tool_result';
  text: string;
  timestamp?: string;
  toolName?: string;
  isError?: boolean;
}
interface SessionDetail {
  session: Session;
  messages: SessionMessage[];
}
interface ProjectAnalytics {
  project_path: string;
  display_name: string;
  agents: string[];
  total_sessions: number;
  completed_sessions: number;
  completion_rate: number;
  total_cost: number;
  wasted_cost: number;
  total_tool_calls: number;
  total_tool_errors: number;
  avg_session_minutes: number;
}
interface SessionsResponse {
  sessions: Session[];
  total: number;
  offset: number;
  limit: number;
}
// Phase 3
interface McpServerSummary {
  server: string;
  agent: string;
  total_calls: number;
  error_count: number;
  success_rate: number;
  tools: Array<{ name: string; calls: number; errors: number }>;
  session_count: number;
}
interface HourlyEffectiveness {
  hour: number;
  total_sessions: number;
  completed_sessions: number;
  completion_rate: number;
  avg_cost: number;
}
interface DurationBucket {
  label: string;
  session_count: number;
  completed_count: number;
  completion_rate: number;
  avg_cost: number;
  total_cost: number;
}
interface ConversationDepthStats {
  avg_depth: number;
  high_backforth_sessions: number;
  high_backforth_completion_rate: number;
  low_backforth_completion_rate: number;
  depth_buckets: Array<{ label: string; session_count: number; completion_rate: number; avg_cost: number }>;
}
interface AdvancedAnalytics {
  mcp: { servers: McpServerSummary[]; total_mcp_calls: number; total_mcp_errors: number };
  hourly_effectiveness: HourlyEffectiveness[];
  duration_distribution: DurationBucket[];
  conversation_depth: ConversationDepthStats;
}
// Phase 4
interface FailurePattern {
  tool: string;
  error_snippet: string;
  occurrences: number;
  sessions: number;
  agent: string;
}
// Team types
interface UserStats {
  username: string;
  total_sessions: number;
  completed_sessions: number;
  completion_rate: number;
  total_cost: number;
  wasted_cost: number;
  total_tool_calls: number;
  total_tool_errors: number;
  tool_success_rate: number;
  avg_session_minutes: number;
  agents_used: string[];
  active_days: number;
  top_projects: string[];
}
interface TeamAnalytics {
  users: UserStats[];
  total_users: number;
  is_multi_user: boolean;
}
// Workspace types
interface MemoryFile {
  name: string;
  description: string;
  type: string;
  content: string;
  filePath: string;
}
interface MemoryProject {
  slug: string;
  projectPath: string;
  memories: MemoryFile[];
}
interface PlanFile {
  name: string;
  content: string;
  modifiedAt: string;
}
interface TaskItem {
  id: string;
  subject: string;
  description: string;
  status: string;
  activeForm?: string;
  owner?: string;
}
interface SkillInfo { name: string; description: string }
interface PluginInfo { name: string; scope: string; version: string; installedAt: string }
interface ClaudeSettings {
  settings: Record<string, unknown>;
  skills: SkillInfo[];
  plugins: PluginInfo[];
  storage_bytes: number;
}
interface ActiveSessionInfo {
  session_id: string;
  project_path: string;
  last_activity_ago: string;
  model?: string;
}
// Kiro workspace
interface KiroMcpServer {
  name: string;
  command: string;
  disabled: boolean;
  disabledToolCount: number;
}
interface KiroAgent {
  name: string;
  description: string;
  hasMcpServers: boolean;
  hasHooks: boolean;
  resourceCount: number;
}
interface KiroPower { name: string; registryId: string }
interface KiroExtension { id: string; name: string; version: string }
interface KiroWorkspace {
  settings: Record<string, unknown>;
  mcpServers: KiroMcpServer[];
  agents: KiroAgent[];
  powers: KiroPower[];
  extensions: KiroExtension[];
  recentCommands: string[];
}

// ─── Formatters ──────────────────────────────────────────────────────────────

function formatCost(cost: number): string {
  if (cost === 0) return '$0.00';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(tokens);
}

function formatDuration(minutes: number): string {
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function formatPct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

/** Pluralize helper: pluralize(1, 'day') → '1 day', pluralize(3, 'day') → '3 days' */
function pluralize(n: number, singular: string, plural?: string): string {
  return `${n} ${n === 1 ? singular : (plural || singular + 's')}`;
}

/** Relative time helper: "2 hours ago", "3 days ago", or full date */
function relativeTime(dateStr: string): string {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

/** User-friendly category label mapping */
const CATEGORY_LABELS: Record<string, string> = {
  'file-io': 'File I/O',
  'shell': 'Shell',
  'agent': 'Agent',
  'web': 'Web',
  'planning': 'Planning',
  'todo': 'Tasks',
  'skill': 'Skills',
  'mcp': 'MCP',
  'cli': 'CLI',
  'other': 'Other',
};

function friendlyCategory(cat: string): string {
  return CATEGORY_LABELS[cat] ?? cat.charAt(0).toUpperCase() + cat.slice(1);
}

type DateRangePreset = 'today' | '7d' | '30d' | 'all';

// ─── Sortable Table Utilities ────────────────────────────────────────────────

type SortDir = 'asc' | 'desc';
interface SortState<K extends string = string> { key: K; dir: SortDir }

function useSort<K extends string>(defaultKey: K, defaultDir: SortDir = 'desc') {
  const [sort, setSort] = useState<SortState<K>>({ key: defaultKey, dir: defaultDir });
  const toggle = (key: K) => {
    setSort(prev => prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' });
  };
  return { sort, toggle };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sortRows<T extends Record<string, any>>(rows: T[], key: string, dir: SortDir, accessor?: (row: T, key: string) => number | string): T[] {
  const sorted = [...rows].sort((a, b) => {
    const va = accessor ? accessor(a, key) : a[key];
    const vb = accessor ? accessor(b, key) : b[key];
    if (typeof va === 'number' && typeof vb === 'number') return va - vb;
    return String(va).localeCompare(String(vb));
  });
  return dir === 'desc' ? sorted.reverse() : sorted;
}

function SortableHead({ label, sortKey, sort, onSort, className }: {
  label: string;
  sortKey: string;
  sort: SortState;
  onSort: (key: string) => void;
  className?: string;
}) {
  const active = sort.key === sortKey;
  return (
    <TableHead
      className={`cursor-pointer select-none hover:text-foreground ${className ?? ''}`}
      onClick={() => onSort(sortKey)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        <span className={`text-xs ${active ? 'text-foreground' : 'text-muted-foreground/40'}`}>
          {active ? (sort.dir === 'asc' ? '\u25B2' : '\u25BC') : '\u25BC'}
        </span>
      </span>
    </TableHead>
  );
}

// Shared chart styling (matches app-wide recharts patterns)
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

/** Format a Date as YYYY-MM-DD in local timezone (NOT UTC). */
function localDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getDateRange(preset: DateRangePreset): { from?: string; to?: string } {
  if (preset === 'all') return {};
  const today = new Date();
  const to = localDateStr(today);
  if (preset === 'today') return { from: to, to };
  const d = new Date(today);
  d.setDate(d.getDate() - (preset === '7d' ? 6 : 29));
  return { from: localDateStr(d), to };
}

function buildQuery(basePath: string, range: { from?: string; to?: string }, extra?: Record<string, string>): string {
  const params = new URLSearchParams();
  if (range.from) params.set('from', range.from);
  if (range.to) params.set('to', range.to);
  if (extra) for (const [k, v] of Object.entries(extra)) params.set(k, v);
  const qs = params.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${ENV_CONFIG.backendUrl}${path}`);
  if (!res.ok) throw new Error(`Failed to fetch ${path}`);
  return res.json();
}

// ─── Insight Icons ───────────────────────────────────────────────────────────

const INSIGHT_STYLES: Record<Insight['type'], { bg: string; border: string; icon: string }> = {
  warning: { bg: 'bg-amber-50 dark:bg-amber-950/30', border: 'border-amber-200 dark:border-amber-800', icon: '!!' },
  tip:     { bg: 'bg-blue-50 dark:bg-blue-950/30',   border: 'border-blue-200 dark:border-blue-800',   icon: '?' },
  info:    { bg: 'bg-gray-50 dark:bg-gray-900/30',    border: 'border-gray-200 dark:border-gray-700',   icon: 'i' },
  success: { bg: 'bg-green-50 dark:bg-green-950/30',  border: 'border-green-200 dark:border-green-800', icon: '*' },
};

const INSIGHT_ICON_COLORS: Record<Insight['type'], string> = {
  warning: 'text-amber-600 dark:text-amber-400',
  tip:     'text-blue-600 dark:text-blue-400',
  info:    'text-gray-500 dark:text-gray-400',
  success: 'text-green-600 dark:text-green-400',
};

// ─── Insights Banner ─────────────────────────────────────────────────────────

function InsightsBanner({ insights, onTabChange }: { insights: Insight[]; onTabChange: (tab: string) => void }) {
  if (!insights || insights.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">Insights & Recommendations</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {insights.map((insight, i) => {
          const style = INSIGHT_STYLES[insight.type];
          return (
            <div
              key={i}
              className={`flex items-start gap-3 p-3 rounded-md border ${style.bg} ${style.border} ${insight.linkTab ? 'cursor-pointer hover:opacity-80' : ''}`}
              onClick={() => insight.linkTab && onTabChange(insight.linkTab)}
            >
              <span className={`font-mono font-bold text-sm mt-0.5 w-5 text-center flex-shrink-0 ${INSIGHT_ICON_COLORS[insight.type]}`}>
                {style.icon}
              </span>
              <div className="min-w-0">
                <p className="text-sm font-medium">{insight.title}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{insight.description}</p>
              </div>
              {insight.linkTab && (
                <span className="text-xs text-muted-foreground ml-auto flex-shrink-0 self-center">&rarr;</span>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

// ─── Today Summary ───────────────────────────────────────────────────────────

function TodaySummary({ stats }: { stats: CombinedStats }) {
  const totalCompleted = stats.agents.reduce((s, a) => s + a.completedSessions, 0);

  return (
    <Card className="border-l-4 border-l-blue-500">
      <CardContent className="pt-4 pb-3">
        <div className="flex items-center justify-between mb-2">
          <p className="text-sm font-medium text-muted-foreground">Today&apos;s Summary</p>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <div>
            <p className="text-2xl font-bold">{stats.totalSessions}</p>
            <p className="text-xs text-muted-foreground">sessions</p>
          </div>
          <div>
            <p className="text-2xl font-bold">{formatCost(stats.totalCost)}</p>
            <p className="text-xs text-muted-foreground">spent</p>
          </div>
          <div>
            <p className="text-2xl font-bold text-green-600">{totalCompleted}</p>
            <p className="text-xs text-muted-foreground">completed</p>
          </div>
          <div>
            <p className={`text-2xl font-bold ${stats.abandonedSessions > 0 ? 'text-amber-600' : ''}`}>
              {stats.abandonedSessions}
            </p>
            <p className="text-xs text-muted-foreground">abandoned</p>
          </div>
          <div>
            <p className={`text-2xl font-bold ${stats.wastedCost > 0 ? 'text-red-600' : ''}`}>
              {formatCost(stats.wastedCost)}
            </p>
            <p className="text-xs text-muted-foreground">wasted cost</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Overview Tab ─────────────────────────────────────────────────────────────

const GETTING_STARTED_KEY = 'agent-health:getting-started-dismissed';

function GettingStartedBanner({ agents, rangePreset, onRangeChange, onDismiss, hasData }: {
  agents: AgentInfo[]; rangePreset: DateRangePreset; onRangeChange: (p: DateRangePreset) => void; onDismiss: () => void; hasData: boolean;
}) {
  return (
    <Card className="border-dashed relative">
      <button
        onClick={onDismiss}
        className="absolute top-3 right-3 text-muted-foreground hover:text-foreground text-sm px-1.5"
        title="Dismiss"
      >&times;</button>
      <CardContent className="pt-5 pb-5">
        <p className="text-sm font-medium mb-3">Getting Started</p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs text-muted-foreground">
          {agents.map(a => (
            <div key={a.name} className="flex items-start gap-2">
              <span className="text-green-500 mt-0.5">&#x2713;</span>
              <span><span className="font-medium text-foreground">{a.displayName || a.name}</span> — detected and tracking sessions</span>
            </div>
          ))}
          {!agents.some(a => a.name === 'claude-code') && (
            <div className="flex items-start gap-2">
              <span className="text-muted-foreground/50 mt-0.5">&#x25CB;</span>
              <span>Claude Code — <code className="text-[11px] bg-muted px-1 rounded">npm i -g @anthropic-ai/claude-code</code></span>
            </div>
          )}
          {!agents.some(a => a.name === 'kiro') && (
            <div className="flex items-start gap-2">
              <span className="text-muted-foreground/50 mt-0.5">&#x25CB;</span>
              <span>Kiro — download from kiro.dev</span>
            </div>
          )}
          {!agents.some(a => a.name === 'codex') && (
            <div className="flex items-start gap-2">
              <span className="text-muted-foreground/50 mt-0.5">&#x25CB;</span>
              <span>Codex — <code className="text-[11px] bg-muted px-1 rounded">npm i -g @openai/codex</code></span>
            </div>
          )}
        </div>
        {!hasData && rangePreset !== 'all' && (
          <div className="flex items-center gap-2 mt-4 pt-3 border-t border-border/50">
            <span className="text-xs text-muted-foreground">No sessions in this range. Try:</span>
            {(['7d', '30d', 'all'] as DateRangePreset[]).filter(p => p !== rangePreset).map(p => (
              <button
                key={p}
                onClick={() => onRangeChange(p)}
                className="text-xs px-2.5 py-1 rounded-md border border-border hover:bg-muted transition-colors"
              >
                {p === '7d' ? 'Last 7 Days' : p === '30d' ? 'Last 30 Days' : 'All Time'}
              </button>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function OverviewTab({ stats, agents, onTabChange, rangePreset, onRangeChange, onAgentFilter }: { stats: CombinedStats | null; agents: AgentInfo[]; onTabChange: (tab: string) => void; rangePreset: DateRangePreset; onRangeChange: (p: DateRangePreset) => void; onAgentFilter?: (agent: string) => void }) {
  const [showGuide, setShowGuide] = useState(() => {
    try { return localStorage.getItem(GETTING_STARTED_KEY) !== 'true'; } catch { return true; }
  });
  if (!stats) return <OverviewSkeleton />;

  const rangeDays: Record<DateRangePreset, number> = { today: 1, '7d': 7, '30d': 30, all: Infinity };
  const isIncomplete = !!(stats.warming && (stats.loadedDays ?? Infinity) < rangeDays[rangePreset]);
  const hasData = stats.totalSessions > 0;

  // When backfill is in progress for non-today ranges, show skeletons
  if (isIncomplete && !hasData) return <TabSkeleton label="Loading historical data…" cards={6} charts={2} />;

  const agentPieData = stats.agents.map(a => ({
    name: AGENT_LABELS[a.agent] ?? a.agent,
    value: a.totalSessions,
    fill: AGENT_COLORS[a.agent] ?? '#6b7280',
  }));

  const recentActivity = stats.dailyActivity.slice(-30);

  // Compute combined metrics for stat cards
  const totalToolCalls = stats.agents.reduce((s, a) => s + a.totalToolCalls, 0);
  const totalToolErrors = stats.agents.reduce((s, a) => s + a.totalToolErrors, 0);
  const toolSuccessRate = totalToolCalls > 0 ? (totalToolCalls - totalToolErrors) / totalToolCalls : 1;
  const totalCompleted = stats.agents.reduce((s, a) => s + a.completedSessions, 0);
  const cacheSavings = stats.agents.reduce((s, a) => s + a.totalCacheSavings, 0);

  const dismissGuide = () => {
    setShowGuide(false);
    try { localStorage.setItem(GETTING_STARTED_KEY, 'true'); } catch { /* ignore */ }
  };
  const enableGuide = () => {
    setShowGuide(true);
    try { localStorage.removeItem(GETTING_STARTED_KEY); } catch { /* ignore */ }
  };

  return (
    <div className="space-y-6">
      {/* Getting started banner — always visible when no data, dismissable when data exists */}
      {(showGuide || !hasData) && (
        <GettingStartedBanner agents={agents} rangePreset={rangePreset} onRangeChange={onRangeChange} onDismiss={dismissGuide} hasData={hasData} />
      )}
      {/* Loading indicator for non-today ranges */}
      {isIncomplete && (
        <div className="flex items-center gap-2">
          <div className="h-4 w-4 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
          <span className="text-sm text-muted-foreground">Loading historical data…</span>
        </div>
      )}

      {/* Show guide toggle when dismissed and there is data */}
      {!showGuide && hasData && (
        <div className="flex justify-end">
          <button onClick={enableGuide} className="text-xs text-muted-foreground hover:text-foreground transition-colors">
            Show getting started guide
          </button>
        </div>
      )}

      {/* Today summary card — shown when "Today" range is selected */}
      {rangePreset === 'today' && <TodaySummary stats={stats} />}

      {/* Key metric cards — grouped by Usage and Cost */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div>
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Usage</h3>
          <div className="grid grid-cols-3 gap-3">
            <StatCard title="Total Sessions" value={String(stats.totalSessions)} onClick={() => onTabChange('sessions')} loading={isIncomplete} />
            <StatCard title="Agents Detected" value={String(agents.length)} onClick={() => onTabChange('workspace')} />
            <StatCard title="Tool Success" value={formatPct(toolSuccessRate)} accent={toolSuccessRate < 0.9 ? 'red' : toolSuccessRate < 0.95 ? 'yellow' : 'green'} onClick={() => onTabChange('tools')} tooltip="Percentage of tool calls that completed without errors" loading={isIncomplete} />
          </div>
        </div>
        <div>
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Cost</h3>
          <div className="grid grid-cols-3 gap-3">
            <StatCard title="Estimated Cost" value={formatCost(stats.totalCost)} onClick={() => onTabChange('costs')} loading={isIncomplete} />
            <StatCard title="Wasted Cost" value={stats.wastedCost > 0 ? formatCost(stats.wastedCost) : '$0.00'} accent={stats.wastedCost > 0.5 ? 'red' : stats.wastedCost > 0 ? 'yellow' : undefined} onClick={() => onTabChange('costs')} loading={isIncomplete} />
            <StatCard title="Cost / Completion" value={totalCompleted > 0 ? formatCost(stats.totalCost / totalCompleted) : 'N/A'} onClick={() => onTabChange('costs')} loading={isIncomplete} />
          </div>
        </div>
      </div>

      {/* Token cache breakdown */}
      {cacheSavings > 0 && <TokenCacheBar stats={stats} />}

      {/* Per-agent breakdown — click to view sessions for that agent */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {stats.agents.map(a => (
          <Card key={a.agent} className="cursor-pointer hover:border-primary/50 transition-colors" onClick={() => { onAgentFilter?.(a.agent); onTabChange('sessions'); }}>
            <CardHeader className="pb-2 relative">
              {isIncomplete && (
                <div className="absolute top-2 right-2 h-3 w-3 rounded-full border-[1.5px] border-muted-foreground/30 border-t-muted-foreground animate-spin" />
              )}
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full" style={{ backgroundColor: AGENT_COLORS[a.agent] }} />
                <CardTitle className="text-sm font-medium">{AGENT_LABELS[a.agent] ?? a.agent}</CardTitle>
                <span className="text-[10px] text-muted-foreground ml-auto">View sessions &rarr;</span>
              </div>
            </CardHeader>
            <CardContent className="space-y-1 text-sm">
              <div className="flex justify-between"><span className="text-muted-foreground">Sessions</span><span>{a.totalSessions}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Completed</span><span>{a.completedSessions}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Cost</span><span>{a.totalCost > 0 ? formatCost(a.totalCost) : 'N/A'}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Tool Success</span>
                <span className={a.toolSuccessRate < 0.9 ? 'text-red-600' : a.toolSuccessRate < 0.95 ? 'text-yellow-600' : 'text-green-600'}>
                  {formatPct(a.toolSuccessRate)}
                </span>
              </div>
              <div className="flex justify-between"><span className="text-muted-foreground">Tool Errors</span><span>{a.totalToolErrors}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Avg Session</span><span>{formatDuration(a.avgSessionMinutes)}</span></div>
              {a.totalCacheSavings > 0 && (
                <div className="flex justify-between"><span className="text-muted-foreground">Cache Savings</span><span className="text-green-600">{formatCost(a.totalCacheSavings)}</span></div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="cursor-pointer hover:border-primary/50 transition-colors" onClick={() => onTabChange('sessions')}>
          <CardHeader className="pb-2 relative">
            {isIncomplete && <div className="absolute top-2 right-2 h-3 w-3 rounded-full border-[1.5px] border-muted-foreground/30 border-t-muted-foreground animate-spin" />}
            <CardTitle className="text-sm font-medium">Sessions by Agent</CardTitle>
          </CardHeader>
          <CardContent>
            {agentPieData.length <= 1 ? (
              <div className="flex items-center justify-center h-[200px]">
                <div className="text-center">
                  <div className="w-4 h-4 rounded-full mx-auto mb-2" style={{ backgroundColor: agentPieData[0]?.fill ?? '#6b7280' }} />
                  <p className="text-lg font-bold">{agentPieData[0]?.name ?? 'No agents'}</p>
                  <p className="text-2xl font-bold">{agentPieData[0]?.value ?? 0} sessions</p>
                </div>
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={200}>
                <PieChart>
                  <Pie data={agentPieData} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={40} outerRadius={80} paddingAngle={2} label={({ name, value }) => `${name}: ${value}`}>
                    {agentPieData.map((entry, i) => (
                      <Cell key={i} fill={entry.fill} />
                    ))}
                  </Pie>
                  <Tooltip {...TOOLTIP_STYLE} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card className="cursor-pointer hover:border-primary/50 transition-colors" onClick={() => onTabChange('performance')}>
          <CardHeader className="pb-2 relative">
            {isIncomplete && <div className="absolute top-2 right-2 h-3 w-3 rounded-full border-[1.5px] border-muted-foreground/30 border-t-muted-foreground animate-spin" />}
            <CardTitle className="text-sm font-medium">Daily Activity (Last 30 Days)</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={recentActivity} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
                <XAxis dataKey="date" {...AXIS_PROPS} tickFormatter={(d: string) => d.slice(5)} />
                <YAxis {...AXIS_PROPS} />
                <Tooltip {...TOOLTIP_STYLE} labelFormatter={(d: string) => d} />
                <Bar dataKey="sessionCount" fill="#3b82f6" name="Sessions" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      {/* Insights — below charts */}
      <InsightsBanner insights={stats.insights} onTabChange={onTabChange} />
    </div>
  );
}

// ─── Session Detail Panel ────────────────────────────────────────────────────

function SessionDetailPanel({ session, onClose }: { session: Session; onClose: () => void }) {
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [msgSearch, setMsgSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<string>('all');
  const [panelWidth, setPanelWidth] = useState(672); // ~max-w-2xl
  const [activeMatchIdx, setActiveMatchIdx] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const matchRefs = useRef<(HTMLElement | null)[]>([]);
  const isResizing = useRef(false);

  useEffect(() => {
    setLoading(true);
    const serverParam = session.server_name && session.server_name !== 'local' ? `?server=${encodeURIComponent(session.server_name)}` : '';
    fetchJson<SessionDetail>(`/api/coding-agents/sessions/${session.agent}/${session.session_id}${serverParam}`)
      .then(d => setDetail(d))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [session.agent, session.session_id, session.server_name]);

  // Close on click outside
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (isResizing.current) return;
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose]);

  // Resize drag handler
  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizing.current = true;
    const startX = e.clientX;
    const startWidth = panelWidth;
    const onMouseMove = (ev: MouseEvent) => {
      const delta = startX - ev.clientX;
      setPanelWidth(Math.max(400, Math.min(window.innerWidth - 100, startWidth + delta)));
    };
    const onMouseUp = () => {
      isResizing.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [panelWidth]);

  const filteredMessages = (detail?.messages ?? []).filter(msg => {
    if (roleFilter !== 'all' && msg.role !== roleFilter) return false;
    if (msgSearch && !msg.text.toLowerCase().includes(msgSearch.toLowerCase()) &&
        !(msg.toolName && msg.toolName.toLowerCase().includes(msgSearch.toLowerCase()))) return false;
    return true;
  });

  // Count total matches across all filtered messages for prev/next navigation
  const matchPositions = useMemo(() => {
    if (!msgSearch) return [];
    const positions: { msgIdx: number; offset: number }[] = [];
    const needle = msgSearch.toLowerCase();
    filteredMessages.forEach((msg, mi) => {
      let start = 0;
      const hay = msg.text.toLowerCase();
      while (true) {
        const idx = hay.indexOf(needle, start);
        if (idx === -1) break;
        positions.push({ msgIdx: mi, offset: idx });
        start = idx + 1;
      }
    });
    return positions;
  }, [filteredMessages, msgSearch]);

  // Reset active match when search changes
  useEffect(() => { setActiveMatchIdx(0); }, [msgSearch]);

  // Scroll active match into view
  useEffect(() => {
    if (matchPositions.length > 0 && matchRefs.current[activeMatchIdx]) {
      matchRefs.current[activeMatchIdx]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [activeMatchIdx, matchPositions.length]);

  // Track which global match index a given message starts at
  const msgMatchStart = useMemo(() => {
    const starts: number[] = [];
    let count = 0;
    if (!msgSearch) return starts;
    const needle = msgSearch.toLowerCase();
    filteredMessages.forEach(msg => {
      starts.push(count);
      let s = 0;
      const hay = msg.text.toLowerCase();
      while (true) {
        const idx = hay.indexOf(needle, s);
        if (idx === -1) break;
        count++;
        s = idx + 1;
      }
    });
    return starts;
  }, [filteredMessages, msgSearch]);

  matchRefs.current = [];

  const highlightText = (text: string, globalStart: number) => {
    if (!msgSearch) return <>{text}</>;
    const needle = msgSearch.toLowerCase();
    const parts: React.ReactNode[] = [];
    let last = 0;
    let localMatch = 0;
    const hay = text.toLowerCase();
    while (true) {
      const idx = hay.indexOf(needle, last);
      if (idx === -1) break;
      if (idx > last) parts.push(text.slice(last, idx));
      const gIdx = globalStart + localMatch;
      const isActive = gIdx === activeMatchIdx;
      parts.push(
        <mark
          key={`${idx}-${localMatch}`}
          ref={el => { matchRefs.current[gIdx] = el; }}
          className={isActive ? 'bg-yellow-400 text-black rounded-sm px-0.5' : 'bg-yellow-200/60 dark:bg-yellow-700/40 rounded-sm px-0.5'}
        >
          {text.slice(idx, idx + msgSearch.length)}
        </mark>
      );
      last = idx + msgSearch.length;
      localMatch++;
    }
    if (last < text.length) parts.push(text.slice(last));
    return <>{parts}</>;
  };

  const goToMatch = (dir: 1 | -1) => {
    if (matchPositions.length === 0) return;
    setActiveMatchIdx(prev => (prev + dir + matchPositions.length) % matchPositions.length);
  };

  return (
    <>
    {/* Backdrop */}
    <div className="fixed inset-0 bg-black/20 z-40" />
    <div
      ref={panelRef}
      className="fixed inset-y-0 right-0 bg-background border-l shadow-xl z-50 overflow-y-auto flex"
      style={{ width: panelWidth }}
    >
      {/* Resize handle */}
      <div
        className="w-1.5 flex-shrink-0 cursor-col-resize hover:bg-primary/20 active:bg-primary/30 transition-colors"
        onMouseDown={startResize}
      />
      <div className="flex-1 min-w-0 flex flex-col">
      <div className="sticky top-0 bg-background border-b p-4 flex items-center justify-between z-10">
        <div>
          <h3 className="font-semibold text-sm">Session Detail</h3>
          <p className="text-xs text-muted-foreground">
            {AGENT_LABELS[session.agent] ?? session.agent} &middot; {new Date(session.start_time).toLocaleString()} &middot; {formatDuration(session.duration_minutes)}
            {session.estimated_cost > 0 && ` \u00b7 ${formatCost(session.estimated_cost)}`}
          </p>
        </div>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-lg px-2">&times;</button>
      </div>

      <div className="p-4 space-y-2">
        {/* Session metadata */}
        <div className="grid grid-cols-2 gap-2 text-sm mb-4">
          <div><span className="text-muted-foreground">Project:</span> {session.project_path.split('/').pop()}</div>
          <div><span className="text-muted-foreground">Status:</span> {session.session_completed ?
            <span className="text-green-600">Completed</span> :
            <span className="text-amber-600">Abandoned</span>}
          </div>
          <div><span className="text-muted-foreground">Messages:</span> {session.user_message_count + session.assistant_message_count}</div>
          <div><span className="text-muted-foreground">Tokens:</span> {formatTokens(session.input_tokens + session.output_tokens)}</div>
        </div>

        {loading ? (
          <TabSkeleton label="Loading conversation..." cards={3} />
        ) : detail?.messages && detail.messages.length > 0 ? (
          <>
            {/* Search & filter for conversation */}
            <div className="flex items-center gap-2 mb-3 sticky top-[73px] bg-background py-2 z-10">
              <div className="relative flex-1">
                <input
                  className="border rounded px-3 py-1.5 text-sm w-full bg-background pr-20"
                  placeholder="Search messages..."
                  value={msgSearch}
                  onChange={e => setMsgSearch(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && matchPositions.length > 0) {
                      goToMatch(e.shiftKey ? -1 : 1);
                      e.preventDefault();
                    }
                  }}
                />
                {msgSearch && matchPositions.length > 0 && (
                  <div className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
                    <span className="text-[10px] text-muted-foreground tabular-nums mr-1">
                      {activeMatchIdx + 1}/{matchPositions.length}
                    </span>
                    <button onClick={() => goToMatch(-1)} className="text-muted-foreground hover:text-foreground p-0.5 text-xs" title="Previous match (Shift+Enter)">&#x25B2;</button>
                    <button onClick={() => goToMatch(1)} className="text-muted-foreground hover:text-foreground p-0.5 text-xs" title="Next match (Enter)">&#x25BC;</button>
                  </div>
                )}
                {msgSearch && matchPositions.length === 0 && (
                  <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">No matches</span>
                )}
              </div>
              <Select value={roleFilter} onValueChange={setRoleFilter}>
                <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Roles</SelectItem>
                  <SelectItem value="user">User</SelectItem>
                  <SelectItem value="assistant">Assistant</SelectItem>
                  <SelectItem value="tool_result">Tool Result</SelectItem>
                </SelectContent>
              </Select>
              <span className="text-xs text-muted-foreground whitespace-nowrap">
                {filteredMessages.length}/{detail.messages.length}
              </span>
            </div>
            <div className="space-y-2">
              {filteredMessages.map((msg, i) => (
                <div key={i} className={`rounded-md p-3 text-sm ${
                  msg.role === 'user' ? 'bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800' :
                  msg.role === 'tool_result' ? `border ${msg.isError ? 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800' : 'bg-gray-50 dark:bg-gray-900/30 border-gray-200 dark:border-gray-700'}` :
                  'bg-muted/50 border border-border'
                }`}>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-medium text-muted-foreground uppercase">{msg.role}</span>
                    {msg.toolName && <Badge variant="secondary" className="text-xs">{msg.toolName}</Badge>}
                    {msg.timestamp && <span className="text-xs text-muted-foreground ml-auto">{new Date(msg.timestamp).toLocaleTimeString()}</span>}
                  </div>
                  <pre className="whitespace-pre-wrap text-xs font-mono break-all">{highlightText(msg.text, msgMatchStart[i] ?? 0)}</pre>
                </div>
              ))}
              {filteredMessages.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-4">No messages match your search.</p>
              )}
            </div>
          </>
        ) : (
          <div className="text-center py-8">
            <div className="text-2xl mb-2 opacity-20">[...]</div>
            <p className="text-sm text-muted-foreground">No conversation data available</p>
            <p className="text-xs text-muted-foreground/70 mt-1">The session JSONL file may have been removed or is in an unsupported format.</p>
          </div>
        )}
      </div>
      </div>{/* flex-1 */}
    </div>{/* panel */}
    </>
  );
}

// ─── Sessions Tab ─────────────────────────────────────────────────────────────

function SessionsTab({ range, loading: initialLoading, initialProject, initialAgent, onClearFilters }: { range: { from?: string; to?: string }; loading: boolean; initialProject?: string; initialAgent?: string; onClearFilters?: () => void }) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [agentFilter, setAgentFilter] = useState<string>(initialAgent ?? 'all');
  const [completedFilter, setCompletedFilter] = useState<string>('all');
  const [projectFilter, setProjectFilter] = useState<string>(initialProject ?? '');
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [loading, setLoading] = useState(initialLoading);
  const [selectedSession, setSelectedSession] = useState<Session | null>(null);
  const [expandedPrompts, setExpandedPrompts] = useState<Set<string>>(new Set());
  const { sort: sessSort, toggle: toggleSessSort } = useSort<string>('start_time');
  const pageSize = 50;

  useEffect(() => { if (initialProject) setProjectFilter(initialProject); }, [initialProject]);
  useEffect(() => { if (initialAgent) setAgentFilter(initialAgent); }, [initialAgent]);

  const hasActiveFilters = agentFilter !== 'all' || completedFilter !== 'all' || !!projectFilter || !!search;
  const clearAllFilters = () => {
    setAgentFilter('all');
    setCompletedFilter('all');
    setProjectFilter('');
    setSearch('');
    setSearchInput('');
    setPage(0);
    onClearFilters?.();
  };

  const loadSessions = useCallback(async () => {
    setLoading(true);
    try {
      const extra: Record<string, string> = { limit: String(pageSize), offset: String(page * pageSize) };
      if (agentFilter !== 'all') extra.agent = agentFilter;
      if (completedFilter !== 'all') extra.completed = completedFilter;
      if (projectFilter) extra.project = projectFilter;
      if (search) extra.search = search;
      const data = await fetchJson<SessionsResponse>(buildQuery('/api/coding-agents/sessions', range, extra));
      setSessions(data.sessions);
      setTotal(data.total);
    } catch { /* ignore */ }
    setLoading(false);
  }, [page, agentFilter, completedFilter, projectFilter, search, range]);

  useEffect(() => { loadSessions(); }, [loadSessions]);

  const handleSearch = () => { setSearch(searchInput); setPage(0); };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <input
          className="border rounded px-3 py-1.5 text-sm w-64 bg-background"
          placeholder="Search prompts..."
          value={searchInput}
          onChange={e => setSearchInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSearch()}
        />
        <button onClick={handleSearch} className="px-3 py-1.5 text-sm border rounded hover:bg-muted">Search</button>
        <Select value={agentFilter} onValueChange={v => { setAgentFilter(v); setPage(0); }}>
          <SelectTrigger className="w-40"><SelectValue placeholder="Agent" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Agents</SelectItem>
            <SelectItem value="claude-code">Claude Code</SelectItem>
            <SelectItem value="kiro">Kiro</SelectItem>
            <SelectItem value="codex">Codex CLI</SelectItem>
          </SelectContent>
        </Select>
        <Select value={completedFilter} onValueChange={v => { setCompletedFilter(v); setPage(0); }}>
          <SelectTrigger className="w-36"><SelectValue placeholder="Status" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="true">Completed</SelectItem>
            <SelectItem value="false">Abandoned</SelectItem>
          </SelectContent>
        </Select>
        {projectFilter && (
          <Badge variant="secondary" className="text-xs flex items-center gap-1">
            Project: {projectFilter.split('/').pop()}
            <button onClick={() => { setProjectFilter(''); setPage(0); onClearFilters?.(); }} className="ml-1 hover:text-foreground">&times;</button>
          </Badge>
        )}
        {agentFilter !== 'all' && (
          <Badge variant="secondary" className="text-xs flex items-center gap-1">
            Agent: {AGENT_LABELS[agentFilter] ?? agentFilter}
            <button onClick={() => { setAgentFilter('all'); setPage(0); onClearFilters?.(); }} className="ml-1 hover:text-foreground">&times;</button>
          </Badge>
        )}
        {hasActiveFilters && (
          <button onClick={clearAllFilters} className="text-xs text-muted-foreground hover:text-foreground underline">Clear all filters</button>
        )}
        <span className="text-sm text-muted-foreground ml-auto">{total} sessions</span>
      </div>

      {loading ? <TabSkeleton label="Loading sessions..." table /> : (
        <>
          <Card>
            <Table>
              <TableHeader>
                <TableRow>
                  <SortableHead label="Agent" sortKey="agent" sort={sessSort} onSort={toggleSessSort} />
                  <TableHead className="min-w-[300px]">First Prompt</TableHead>
                  <SortableHead label="Project" sortKey="project_path" sort={sessSort} onSort={toggleSessSort} />
                  <SortableHead label="Wall Time" sortKey="duration_minutes" sort={sessSort} onSort={toggleSessSort} className="text-right" />
                  <SortableHead label="Messages" sortKey="messages" sort={sessSort} onSort={toggleSessSort} className="text-right" />
                  <SortableHead label="Tokens" sortKey="tokens" sort={sessSort} onSort={toggleSessSort} className="text-right" />
                  <SortableHead label="Cost" sortKey="estimated_cost" sort={sessSort} onSort={toggleSessSort} className="text-right" />
                  <SortableHead label="Status" sortKey="session_completed" sort={sessSort} onSort={toggleSessSort} />
                  <SortableHead label="Date" sortKey="start_time" sort={sessSort} onSort={toggleSessSort} />
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortRows(sessions, sessSort.key, sessSort.dir, (s, k) => {
                  if (k === 'messages') return s.user_message_count + s.assistant_message_count;
                  if (k === 'tokens') return s.input_tokens + s.output_tokens;
                  if (k === 'session_completed') return s.session_completed ? 1 : 0;
                  return s[k as keyof Session] as number | string;
                }).map(s => (
                  <TableRow key={`${s.agent}-${s.session_id}`} className="cursor-pointer hover:bg-muted/50" onClick={() => setSelectedSession(s)}>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Badge variant="outline" style={{ borderColor: AGENT_COLORS[s.agent], color: AGENT_COLORS[s.agent] }}>
                          {AGENT_LABELS[s.agent] ?? s.agent}
                        </Badge>
                        {s.server_name && s.server_name !== 'local' && (
                          <Badge variant="secondary" className="text-[10px] px-1">{s.server_name}</Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="max-w-xs text-sm">
                      {s.first_prompt ? (
                        <div
                          className={`cursor-pointer ${expandedPrompts.has(s.session_id) ? '' : 'line-clamp-2'}`}
                          onClick={(e) => { e.stopPropagation(); setExpandedPrompts(prev => { const next = new Set(prev); if (next.has(s.session_id)) next.delete(s.session_id); else next.add(s.session_id); return next; }); }}
                          title={expandedPrompts.has(s.session_id) ? 'Click to collapse' : s.first_prompt}
                        >
                          {s.first_prompt}
                        </div>
                      ) : <span className="text-muted-foreground italic">No prompt</span>}
                    </TableCell>
                    <TableCell className="max-w-[120px] truncate text-sm" title={s.project_path}>
                      {s.project_path.split('/').pop()}
                    </TableCell>
                    <TableCell className="text-right text-sm">{formatDuration(s.duration_minutes)}</TableCell>
                    <TableCell className="text-right text-sm">{s.user_message_count + s.assistant_message_count}</TableCell>
                    <TableCell className="text-right text-sm">
                      {s.input_tokens + s.output_tokens > 0 ? formatTokens(s.input_tokens + s.output_tokens) : '-'}
                    </TableCell>
                    <TableCell className="text-right text-sm">
                      {s.estimated_cost > 0 ? formatCost(s.estimated_cost) : '-'}
                    </TableCell>
                    <TableCell className="text-sm">
                      {s.session_completed
                        ? <Badge className="bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/20 text-xs">Completed</Badge>
                        : <Badge className="bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/20 text-xs">Abandoned</Badge>}
                    </TableCell>
                    <TableCell className="text-sm whitespace-nowrap">
                      <span className="text-foreground">{relativeTime(s.start_time)}</span>
                      <br />
                      <span className="text-xs text-muted-foreground">{new Date(s.start_time).toLocaleDateString()}</span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {sessions.length === 0 && (
              <div className="text-center py-8">
                <div className="text-2xl mb-2 opacity-20">&gt;_</div>
                <p className="text-sm text-muted-foreground">No sessions found</p>
                <p className="text-xs text-muted-foreground/70 mt-1">Try adjusting your filters or date range.</p>
              </div>
            )}
          </Card>

          {/* Pagination */}
          {total > pageSize && (
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">
                Showing {page * pageSize + 1}-{Math.min((page + 1) * pageSize, total)} of {total}
              </span>
              <div className="flex gap-2">
                <button className="px-3 py-1 text-sm border rounded disabled:opacity-50" disabled={page === 0} onClick={() => setPage(p => p - 1)}>Prev</button>
                <button className="px-3 py-1 text-sm border rounded disabled:opacity-50" disabled={(page + 1) * pageSize >= total} onClick={() => setPage(p => p + 1)}>Next</button>
              </div>
            </div>
          )}
        </>
      )}

      {selectedSession && <SessionDetailPanel session={selectedSession} onClose={() => setSelectedSession(null)} />}
    </div>
  );
}

// ─── Costs Tab ────────────────────────────────────────────────────────────────

function CostTrendChart({ dailyCosts }: { dailyCosts: DailyCost[] }) {
  if (!dailyCosts || dailyCosts.length === 0) return null;

  // Pivot daily costs into { date, claude-code, kiro, codex } for stacked line chart
  const dateMap = new Map<string, Record<string, string | number>>();
  const agentsInData = new Set<string>();
  for (const dc of dailyCosts) {
    agentsInData.add(dc.agent);
    const entry = dateMap.get(dc.date) ?? { date: dc.date };
    entry[dc.agent] = ((entry[dc.agent] as number) ?? 0) + dc.cost;
    dateMap.set(dc.date, entry);
  }
  const chartData = Array.from(dateMap.values()).sort((a, b) => (a.date as string).localeCompare(b.date as string));

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">Daily Cost Trend</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={250}>
          <LineChart data={chartData} margin={{ top: 10, right: 10, left: 10, bottom: 10 }}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
            <XAxis dataKey="date" {...AXIS_PROPS} tickFormatter={(d: string) => d.slice(5)} />
            <YAxis {...AXIS_PROPS} tickFormatter={(v: number) => `$${v.toFixed(2)}`} width={60} />
            <Tooltip {...TOOLTIP_STYLE} formatter={(v: number) => formatCost(v)} labelFormatter={(d: string) => d} />
            <Legend wrapperStyle={{ paddingTop: '10px' }} formatter={(value) => <span className="text-sm text-muted-foreground">{value}</span>} />
            {[...agentsInData].map(agent => (
              <Line
                key={agent}
                type="monotone"
                dataKey={agent}
                name={AGENT_LABELS[agent] ?? agent}
                stroke={AGENT_COLORS[agent] ?? '#6b7280'}
                strokeWidth={2}
                dot={{ fill: AGENT_COLORS[agent] ?? '#6b7280', strokeWidth: 2, r: 3 }}
                activeDot={{ r: 5, strokeWidth: 0 }}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

function CostsTab({ costs, loading, onTabChange, onSelectProject, cacheSavings }: { costs: CostAnalytics | null; loading: boolean; onTabChange: (tab: string) => void; onSelectProject: (projectPath: string) => void; cacheSavings?: number }) {
  if (loading || !costs) return <TabSkeleton label="Loading cost analytics..." cards={2} charts={2} />;

  const modelData = costs.models.filter(m => m.estimated_cost > 0);
  const projectData = costs.by_project.slice(0, 10);
  // Use the same cache savings as Overview (computed from agent stats) for consistency
  const displaySavings = cacheSavings ?? costs.total_savings;

  // Cost forecast: (total / days with data) * 30
  const uniqueDays = new Set(costs.daily_costs.map(d => d.date)).size;
  const monthlyProjection = uniqueDays >= 2 ? (costs.total_cost / uniqueDays) * 30 : null;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4">
        <StatCard title="Total Estimated Cost" value={formatCost(costs.total_cost)} onClick={() => onTabChange('sessions')} />
        <StatCard title="Cache Savings" value={formatCost(displaySavings)} accent={displaySavings > 0 ? 'green' : undefined} onClick={() => onTabChange('overview')} />
      </div>

      {monthlyProjection !== null && (
        <p className="text-xs text-muted-foreground">At current rate: ~{formatCost(monthlyProjection)}/month projected ({uniqueDays} days of data)</p>
      )}

      {/* Cost trend chart — click to see activity */}
      <div className="cursor-pointer" onClick={() => onTabChange('performance')}>
        <CostTrendChart dailyCosts={costs.daily_costs} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Cost by Model</CardTitle>
          </CardHeader>
          <CardContent>
            {modelData.length <= 1 ? (
              <div className="flex items-center justify-center h-[250px]">
                <div className="text-center">
                  <p className="text-sm text-muted-foreground">All costs from</p>
                  <p className="text-lg font-bold font-mono">{modelData[0]?.model ?? 'unknown'}</p>
                  <p className="text-2xl font-bold mt-1">{formatCost(modelData[0]?.estimated_cost ?? 0)}</p>
                </div>
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={250}>
                <BarChart data={modelData} layout="vertical" margin={{ top: 5, right: 30, left: 20, bottom: 5 }} className="cursor-pointer">
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" horizontal={false} />
                  <XAxis type="number" {...AXIS_PROPS} tickFormatter={(v: number) => formatCost(v)} domain={[0, (dataMax: number) => dataMax === 0 ? 10 : Math.ceil(dataMax * 1.2)]} />
                  <YAxis type="category" dataKey="model" width={150} {...AXIS_PROPS} />
                  <Tooltip {...TOOLTIP_STYLE} formatter={(v: number) => [formatCost(v), 'Cost']} />
                  <Bar dataKey="estimated_cost" name="Cost" radius={[0, 4, 4, 0]} onClick={(_data, idx) => { const agent = modelData[idx]?.agent; if (agent) onTabChange('sessions'); }}>
                    {modelData.map((m, i) => (
                      <Cell key={i} fill={AGENT_COLORS[m.agent] ?? '#6b7280'} className="cursor-pointer" />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Top Projects by Cost</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={projectData} layout="vertical" margin={{ top: 5, right: 30, left: 20, bottom: 5 }} className="cursor-pointer">
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" horizontal={false} />
                <XAxis type="number" {...AXIS_PROPS} tickFormatter={(v: number) => formatCost(v)} domain={[0, (dataMax: number) => dataMax === 0 ? 10 : Math.ceil(dataMax * 1.2)]} />
                <YAxis type="category" dataKey="display_name" width={120} {...AXIS_PROPS} />
                <Tooltip {...TOOLTIP_STYLE} formatter={(v: number) => [formatCost(v), 'Cost']} />
                <Bar dataKey="estimated_cost" name="Cost" radius={[0, 4, 4, 0]} onClick={(_data, idx) => { const p = projectData[idx]; if (p) onSelectProject(p.project_path); }}>
                  {projectData.map((p, i) => (
                    <Cell key={i} fill={AGENT_COLORS[p.agent] ?? '#6b7280'} className="cursor-pointer" />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ─── Activity Tab ─────────────────────────────────────────────────────────────

function ActivityTab({ activity, loading, onTabChange }: { activity: ActivityData | null; loading: boolean; onTabChange: (tab: string) => void }) {
  if (loading || !activity) return <TabSkeleton label="Loading activity data..." cards={3} charts={2} />;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-3 gap-4">
        <StatCard title="Current Streak" value={pluralize(activity.streaks.current, 'day')} onClick={() => onTabChange('sessions')} />
        <StatCard title="Longest Streak" value={pluralize(activity.streaks.longest, 'day')} onClick={() => onTabChange('sessions')} />
        <StatCard title="Active Days" value={String(activity.total_active_days)} onClick={() => onTabChange('sessions')} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {(() => {
          const totalHourSessions = activity.hour_counts.reduce((s, h) => s + h.count, 0);
          const peakHour = activity.hour_counts.reduce((a, b) => b.count > a.count ? b : a, activity.hour_counts[0]);
          if (totalHourSessions < 10) {
            return (
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-sm font-medium">Sessions by Hour</CardTitle></CardHeader>
                <CardContent className="flex items-center justify-center h-[200px]">
                  <div className="text-center">
                    {peakHour && peakHour.count > 0 ? (
                      <>
                        <p className="text-sm text-muted-foreground">Most active hour</p>
                        <p className="text-2xl font-bold">{peakHour.hour}:00–{peakHour.hour + 1}:00</p>
                        <p className="text-sm text-muted-foreground">{peakHour.count} sessions</p>
                      </>
                    ) : (
                      <p className="text-sm text-muted-foreground">Hourly patterns appear after more sessions</p>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          }
          return (
            <Card className="cursor-pointer hover:border-primary/50 transition-colors" onClick={() => onTabChange('tools')}>
              <CardHeader className="pb-2"><CardTitle className="text-sm font-medium">Sessions by Hour</CardTitle></CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={activity.hour_counts} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
                    <XAxis dataKey="hour" {...AXIS_PROPS} />
                    <YAxis {...AXIS_PROPS} domain={[0, (dataMax: number) => dataMax === 0 ? 5 : Math.ceil(dataMax * 1.2)]} />
                    <Tooltip {...TOOLTIP_STYLE} />
                    <Bar dataKey="count" fill="#8b5cf6" name="Sessions" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          );
        })()}

        {(() => {
          const totalDowSessions = activity.dow_counts.reduce((s, d) => s + d.count, 0);
          const peakDay = activity.dow_counts.reduce((a, b) => b.count > a.count ? b : a, activity.dow_counts[0]);
          if (totalDowSessions < 10) {
            return (
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-sm font-medium">Sessions by Day of Week</CardTitle></CardHeader>
                <CardContent className="flex items-center justify-center h-[200px]">
                  <div className="text-center">
                    {peakDay && peakDay.count > 0 ? (
                      <>
                        <p className="text-sm text-muted-foreground">Most active day</p>
                        <p className="text-2xl font-bold">{peakDay.day}</p>
                        <p className="text-sm text-muted-foreground">{peakDay.count} sessions</p>
                      </>
                    ) : (
                      <p className="text-sm text-muted-foreground">Daily patterns appear after more sessions</p>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          }
          return (
            <Card className="cursor-pointer hover:border-primary/50 transition-colors" onClick={() => onTabChange('sessions')}>
              <CardHeader className="pb-2"><CardTitle className="text-sm font-medium">Sessions by Day of Week</CardTitle></CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={activity.dow_counts} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
                    <XAxis dataKey="day" {...AXIS_PROPS} />
                    <YAxis {...AXIS_PROPS} domain={[0, (dataMax: number) => dataMax === 0 ? 5 : Math.ceil(dataMax * 1.2)]} />
                    <Tooltip {...TOOLTIP_STYLE} />
                    <Bar dataKey="count" fill="#f97316" name="Sessions" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          );
        })()}
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Daily Activity (Last 90 Days)</CardTitle>
        </CardHeader>
        <CardContent>
          <ActivityHeatmap data={activity.daily_activity} onTabChange={onTabChange} />
        </CardContent>
      </Card>
    </div>
  );
}

function ActivityHeatmap({ data, onTabChange }: { data: Array<{ date: string; sessionCount: number }>; onTabChange: (tab: string) => void }) {
  const last90 = data.slice(-90);
  const maxCount = Math.max(...last90.map(d => d.sessionCount), 1);

  return (
    <div className="flex flex-wrap gap-1">
      {last90.map(d => {
        const intensity = d.sessionCount / maxCount;
        const bg = d.sessionCount === 0
          ? 'bg-muted'
          : intensity < 0.33
          ? 'bg-green-200 dark:bg-green-900'
          : intensity < 0.66
          ? 'bg-green-400 dark:bg-green-700'
          : 'bg-green-600 dark:bg-green-500';
        return (
          <div
            key={d.date}
            className={`w-3 h-3 rounded-sm ${bg} ${d.sessionCount > 0 ? 'cursor-pointer hover:ring-2 hover:ring-primary' : ''}`}
            title={`${d.date}: ${d.sessionCount} sessions`}
            onClick={() => d.sessionCount > 0 && onTabChange('sessions')}
          />
        );
      })}
    </div>
  );
}

// ─── Efficiency Tab ──────────────────────────────────────────────────────────

function EfficiencyTab({ efficiency, loading, onTabChange, onAgentFilter }: { efficiency: EfficiencyData | null; loading: boolean; onTabChange: (tab: string) => void; onAgentFilter?: (agent: string) => void }) {
  if (loading || !efficiency) return <TabSkeleton label="Loading efficiency metrics..." cards={3} charts={1} />;

  const chartData = efficiency.agents.map(a => ({
    agent: AGENT_LABELS[a.agent] ?? a.agent,
    agentKey: a.agent,
    'Tool Success': Math.round(a.toolSuccessRate * 100),
    'Completion': Math.round(a.completionRate * 100),
    fill: AGENT_COLORS[a.agent] ?? '#6b7280',
  }));

  return (
    <div className="space-y-6">
      {/* Combined metrics */}
      <div className="grid grid-cols-3 gap-4">
        <StatCard
          title="Overall Tool Success"
          value={formatPct(efficiency.combined.toolSuccessRate)}
          accent={efficiency.combined.toolSuccessRate < 0.9 ? 'red' : efficiency.combined.toolSuccessRate < 0.95 ? 'yellow' : 'green'}
          onClick={() => onTabChange('tools')}
          tooltip="Percentage of tool calls that completed without errors. Includes all tool types (Bash, Read, Edit, etc.)"
        />
        <StatCard
          title="Overall Completion Rate"
          value={formatPct(efficiency.combined.completionRate)}
          accent={efficiency.combined.completionRate < 0.6 ? 'red' : efficiency.combined.completionRate < 0.8 ? 'yellow' : 'green'}
          onClick={() => onTabChange('sessions')}
          tooltip="Percentage of sessions that completed successfully vs. abandoned"
        />
        <StatCard
          title="Avg Cost / Completion"
          value={efficiency.combined.avgCostPerCompletion > 0 ? formatCost(efficiency.combined.avgCostPerCompletion) : 'N/A'}
          onClick={() => onTabChange('costs')}
        />
      </div>

      {/* Per-agent comparison cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {efficiency.agents.map(a => (
          <Card key={a.agent} className="cursor-pointer hover:border-primary/50 transition-colors" onClick={() => { onAgentFilter?.(a.agent); onTabChange('sessions'); }}>
            <CardHeader className="pb-2">
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full" style={{ backgroundColor: AGENT_COLORS[a.agent] }} />
                <CardTitle className="text-sm font-medium">{AGENT_LABELS[a.agent] ?? a.agent}</CardTitle>
                <span className="text-xs text-muted-foreground ml-auto">View sessions →</span>
              </div>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <MetricRow label="Tool Success" value={formatPct(a.toolSuccessRate)} accent={a.toolSuccessRate < 0.9 ? 'red' : a.toolSuccessRate < 0.95 ? 'yellow' : 'green'} />
              <MetricRow label="Completion Rate" value={formatPct(a.completionRate)} accent={a.completionRate < 0.6 ? 'red' : a.completionRate < 0.8 ? 'yellow' : 'green'} />
              <MetricRow label="Cost / Completion" value={a.costPerCompletion > 0 ? formatCost(a.costPerCompletion) : 'N/A'} />
              <div className="flex justify-between">
                <span className="text-muted-foreground">Tool Errors</span>
                <span className={`cursor-pointer hover:underline ${a.totalToolErrors > 0 ? 'text-yellow-600 dark:text-yellow-400' : ''}`} onClick={(e) => { e.stopPropagation(); onTabChange('tools'); }}>{a.totalToolErrors}</span>
              </div>
              <MetricRow label="Sessions" value={`${a.completedSessions} of ${a.totalSessions}`} />
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Comparison chart — only show when 2+ agents */}
      {chartData.length > 1 ? (
        <Card className="cursor-pointer hover:border-primary/50 transition-colors" onClick={() => onTabChange('tools')}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Agent Comparison (%)</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={chartData} margin={{ top: 5, right: 10, left: 10, bottom: 5 }} barGap={4} barCategoryGap="20%">
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
                <XAxis dataKey="agent" {...AXIS_PROPS} />
                <YAxis domain={[0, 100]} {...AXIS_PROPS} tickFormatter={(v: number) => `${v}%`} />
                <Tooltip {...TOOLTIP_STYLE} formatter={(v: number) => [`${v}%`]} />
                <Legend wrapperStyle={{ paddingTop: '10px' }} formatter={(value) => <span className="text-sm text-muted-foreground">{value}</span>} />
                <Bar dataKey="Tool Success" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                <Bar dataKey="Completion" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      ) : chartData.length === 1 && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium">Agent Performance</CardTitle></CardHeader>
          <CardContent>
            <div className="flex items-center gap-6">
              <div className="w-3 h-3 rounded-full" style={{ backgroundColor: chartData[0].fill }} />
              <span className="text-sm font-medium">{chartData[0].agent}</span>
              <span className="text-sm">Tool Success: <strong>{chartData[0]['Tool Success']}%</strong></span>
              <span className="text-sm">Completion: <strong>{chartData[0]['Completion']}%</strong></span>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function MetricRow({ label, value, accent }: { label: string; value: string; accent?: 'red' | 'yellow' | 'green' }) {
  const colorClass = accent === 'red' ? 'text-red-600 dark:text-red-400'
    : accent === 'yellow' ? 'text-yellow-600 dark:text-yellow-400'
    : accent === 'green' ? 'text-green-600 dark:text-green-400'
    : '';
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className={colorClass}>{value}</span>
    </div>
  );
}

// ─── Tools Tab (Enhanced) ────────────────────────────────────────────────────

const CATEGORY_COLORS: Record<string, string> = {
  'file-io': '#60a5fa',
  'shell': '#d97706',
  'agent': '#a78bfa',
  'web': '#22c55e',
  'planning': '#fbbf24',
  'todo': '#fb923c',
  'skill': '#38bdf8',
  'mcp': '#34d399',
  'other': '#6b7280',
};

function successRateColor(rate: number): string {
  if (rate >= 0.95) return 'text-green-600 dark:text-green-400';
  if (rate >= 0.80) return 'text-yellow-600 dark:text-yellow-400';
  return 'text-red-600 dark:text-red-400';
}

function ToolsTab({ tools, loading, onTabChange, onAgentFilter }: { tools: ToolsData | null; loading: boolean; onTabChange: (tab: string) => void; onAgentFilter?: (agent: string) => void }) {
  const { sort: toolSort, toggle: toggleToolSort } = useSort<string>('total_calls');
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  if (loading || !tools) return <TabSkeleton label="Loading tool analytics..." cards={3} charts={1} table />;

  const byCategory = new Map<string, number>();
  for (const t of tools.tools) {
    byCategory.set(t.category, (byCategory.get(t.category) ?? 0) + t.total_calls);
  }
  const categoryData = Array.from(byCategory.entries())
    .map(([category, count]) => ({ category, displayName: friendlyCategory(category), count, fill: CATEGORY_COLORS[category] ?? '#6b7280' }))
    .sort((a, b) => b.count - a.count);

  const filteredTools = categoryFilter
    ? tools.tools.filter(t => t.category === categoryFilter)
    : tools.tools;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-3 gap-4">
        <StatCard title="Total Tool Calls" value={formatTokens(tools.total_tool_calls)} />
        <StatCard title="Total Tool Errors" value={String(tools.total_tool_errors)} accent={tools.total_tool_errors > 0 ? 'yellow' : undefined} onClick={() => onTabChange('tools')} />
        <StatCard title="Overall Success Rate" value={tools.total_tool_calls > 0 ? formatPct((tools.total_tool_calls - tools.total_tool_errors) / tools.total_tool_calls) : '100%'} accent={tools.total_tool_calls > 0 && (tools.total_tool_calls - tools.total_tool_errors) / tools.total_tool_calls < 0.9 ? 'red' : 'green'} onClick={() => onTabChange('performance')} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">
              Calls by Category
              {categoryFilter && (
                <button className="ml-2 text-xs text-primary hover:underline" onClick={() => setCategoryFilter(null)}>Clear filter</button>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={categoryData} layout="vertical" margin={{ top: 5, right: 10, left: 10, bottom: 5 }} className="cursor-pointer">
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" horizontal={false} />
                <XAxis type="number" {...AXIS_PROPS} domain={[0, (dataMax: number) => dataMax === 0 ? 10 : Math.ceil(dataMax * 1.2)]} />
                <YAxis type="category" dataKey="displayName" width={80} {...AXIS_PROPS} />
                <Tooltip {...TOOLTIP_STYLE} />
                <Bar dataKey="count" name="Calls" radius={[0, 4, 4, 0]} onClick={(_data, idx) => { const cat = categoryData[idx]?.category; if (cat) setCategoryFilter(cat === categoryFilter ? null : cat); }}>
                  {categoryData.map((entry, i) => (
                    <Cell key={i} fill={entry.fill} opacity={categoryFilter && entry.category !== categoryFilter ? 0.3 : 1} className="cursor-pointer" />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">
              {categoryFilter ? `Tools: ${categoryFilter}` : 'Top Tools'}
              <span className="ml-2 text-xs text-muted-foreground font-normal">{filteredTools.length} tools</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <SortableHead label="Agent" sortKey="agent" sort={toolSort} onSort={toggleToolSort} />
                  <SortableHead label="Tool" sortKey="name" sort={toolSort} onSort={toggleToolSort} />
                  <SortableHead label="Category" sortKey="category" sort={toolSort} onSort={toggleToolSort} />
                  <SortableHead label="Calls" sortKey="total_calls" sort={toolSort} onSort={toggleToolSort} className="text-right" />
                  <SortableHead label="Errors" sortKey="error_count" sort={toolSort} onSort={toggleToolSort} className="text-right" />
                  <SortableHead label="Success %" sortKey="success_rate" sort={toolSort} onSort={toggleToolSort} className="text-right" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortRows(filteredTools, toolSort.key, toolSort.dir).slice(0, 20).map((t, i) => (
                  <TableRow key={i} className="cursor-pointer hover:bg-muted/50" onClick={() => { onAgentFilter?.(t.agent); onTabChange('sessions'); }}>
                    <TableCell>
                      <Badge variant="outline" style={{ borderColor: AGENT_COLORS[t.agent], color: AGENT_COLORS[t.agent] }} className="text-xs">
                        {AGENT_LABELS[t.agent] ?? t.agent}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm font-mono">{t.name}</TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="text-xs cursor-pointer hover:bg-secondary/80" onClick={(e) => { e.stopPropagation(); setCategoryFilter(t.category === categoryFilter ? null : t.category); }}>{friendlyCategory(t.category)}</Badge>
                    </TableCell>
                    <TableCell className="text-right text-sm">{t.total_calls}</TableCell>
                    <TableCell className="text-right text-sm">{t.error_count > 0 ? t.error_count : '-'}</TableCell>
                    <TableCell className={`text-right text-sm font-medium ${successRateColor(t.success_rate)}`}>
                      {formatPct(t.success_rate)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ─── Projects Tab ───────────────────────────────────────────────────────────

function ProjectsTab({ projects, loading, onSelectProject }: { projects: ProjectAnalytics[] | null; loading: boolean; onSelectProject: (projectPath: string) => void }) {
  const { sort: projSort, toggle: toggleProjSort } = useSort<string>('total_cost');
  if (loading || !projects) return <TabSkeleton label="Loading project analytics..." table />;

  const sorted = sortRows(projects, projSort.key, projSort.dir, (p, k) => {
    if (k === 'error_rate') return p.total_tool_calls > 0 ? p.total_tool_errors / p.total_tool_calls : 0;
    return p[k as keyof ProjectAnalytics] as number | string;
  });

  return (
    <div className="space-y-4">
      <span className="text-sm text-muted-foreground">{projects.length} projects</span>
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <SortableHead label="Project" sortKey="display_name" sort={projSort} onSort={toggleProjSort} />
              <TableHead>Agents</TableHead>
              <SortableHead label="Sessions" sortKey="total_sessions" sort={projSort} onSort={toggleProjSort} className="text-right" />
              <SortableHead label="Completion" sortKey="completion_rate" sort={projSort} onSort={toggleProjSort} className="text-right" />
              <SortableHead label="Cost" sortKey="total_cost" sort={projSort} onSort={toggleProjSort} className="text-right" />
              <SortableHead label="Wasted" sortKey="wasted_cost" sort={projSort} onSort={toggleProjSort} className="text-right" />
              <SortableHead label="Avg Session" sortKey="avg_session_minutes" sort={projSort} onSort={toggleProjSort} className="text-right" />
              <SortableHead label="Tool Errors" sortKey="error_rate" sort={projSort} onSort={toggleProjSort} className="text-right" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map(p => (
              <TableRow key={p.project_path} className="cursor-pointer hover:bg-muted/50" onClick={() => onSelectProject(p.project_path)}>
                <TableCell className="text-sm font-medium" title={p.project_path}>{p.display_name}</TableCell>
                <TableCell>
                  <div className="flex gap-1">
                    {p.agents.map(a => (
                      <div key={a} className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: AGENT_COLORS[a] }} title={AGENT_LABELS[a] ?? a} />
                    ))}
                  </div>
                </TableCell>
                <TableCell className="text-right text-sm">{p.completed_sessions} of {p.total_sessions}</TableCell>
                <TableCell className={`text-right text-sm font-medium ${p.completion_rate < 0.6 ? 'text-red-600' : p.completion_rate < 0.8 ? 'text-yellow-600' : 'text-green-600'}`}>
                  {formatPct(p.completion_rate)}
                </TableCell>
                <TableCell className="text-right text-sm">{p.total_cost > 0 ? formatCost(p.total_cost) : '-'}</TableCell>
                <TableCell className={`text-right text-sm ${p.wasted_cost > 0 ? 'text-red-600' : ''}`}>
                  {p.wasted_cost > 0 ? formatCost(p.wasted_cost) : '-'}
                </TableCell>
                <TableCell className="text-right text-sm">{formatDuration(p.avg_session_minutes)}</TableCell>
                <TableCell className="text-right text-sm">
                  {p.total_tool_errors > 0 ? (
                    <span className="text-yellow-600" title={`${p.total_tool_errors} errors out of ${p.total_tool_calls} calls`}>
                      {p.total_tool_errors} / {p.total_tool_calls} ({p.total_tool_calls > 0 ? formatPct(p.total_tool_errors / p.total_tool_calls) : '0%'})
                    </span>
                  ) : '-'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {projects.length === 0 && (
          <div className="text-center py-8">
            <div className="text-2xl mb-2 opacity-20">[  ]</div>
            <p className="text-sm text-muted-foreground">No projects found</p>
          </div>
        )}
      </Card>
    </div>
  );
}

// ─── Advanced Analytics Tab ─────────────────────────────────────────────────

function AdvancedTab({ advanced, failurePatterns, loading, onTabChange, onAgentFilter }: {
  advanced: AdvancedAnalytics | null;
  failurePatterns: FailurePattern[] | null;
  loading: boolean;
  onTabChange: (tab: string) => void;
  onAgentFilter?: (agent: string) => void;
}) {
  const { sort: mcpSort, toggle: toggleMcpSort } = useSort<string>('total_calls');
  const { sort: fpSort, toggle: toggleFpSort } = useSort<string>('occurrences');

  if (loading || !advanced) return <TabSkeleton label="Loading advanced analytics..." cards={3} charts={2} table />;

  const { mcp, hourly_effectiveness, duration_distribution, conversation_depth } = advanced;

  return (
    <div className="space-y-6">
      {/* MCP Servers */}
      {mcp.servers.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">MCP Servers ({mcp.servers.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <SortableHead label="Server" sortKey="server" sort={mcpSort} onSort={toggleMcpSort} />
                  <SortableHead label="Agent" sortKey="agent" sort={mcpSort} onSort={toggleMcpSort} />
                  <SortableHead label="Calls" sortKey="total_calls" sort={mcpSort} onSort={toggleMcpSort} className="text-right" />
                  <SortableHead label="Errors" sortKey="error_count" sort={mcpSort} onSort={toggleMcpSort} className="text-right" />
                  <SortableHead label="Success %" sortKey="success_rate" sort={mcpSort} onSort={toggleMcpSort} className="text-right" />
                  <SortableHead label="Sessions" sortKey="session_count" sort={mcpSort} onSort={toggleMcpSort} className="text-right" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortRows(mcp.servers, mcpSort.key, mcpSort.dir).map((s, i) => (
                  <TableRow key={i} className="cursor-pointer hover:bg-muted/50" onClick={() => { onAgentFilter?.(s.agent); onTabChange('sessions'); }}>
                    <TableCell className="font-mono text-sm">{s.server}</TableCell>
                    <TableCell>
                      <Badge variant="outline" style={{ borderColor: AGENT_COLORS[s.agent], color: AGENT_COLORS[s.agent] }} className="text-xs">
                        {AGENT_LABELS[s.agent] ?? s.agent}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right text-sm">{s.total_calls}</TableCell>
                    <TableCell className="text-right text-sm" title="Errors include connection failures and timeouts that may not count as completed calls">{s.error_count > 0 ? s.error_count : '-'}</TableCell>
                    <TableCell className={`text-right text-sm font-medium ${successRateColor(s.success_rate)}`}>{formatPct(s.success_rate)}</TableCell>
                    <TableCell className="text-right text-sm">{s.session_count}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Hourly Effectiveness */}
        <Card className="cursor-pointer hover:border-primary/50 transition-colors" onClick={() => onTabChange('performance')}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Completion Rate by Hour</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={hourly_effectiveness.filter(h => h.total_sessions > 0)} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
                <XAxis dataKey="hour" {...AXIS_PROPS} />
                <YAxis domain={[0, 1]} {...AXIS_PROPS} tickFormatter={(v: number) => formatPct(v)} />
                <Tooltip {...TOOLTIP_STYLE} formatter={(v: number) => formatPct(v)} />
                <Bar dataKey="completion_rate" name="Completion Rate" radius={[4, 4, 0, 0]}>
                  {hourly_effectiveness.filter(h => h.total_sessions > 0).map((h, i) => (
                    <Cell key={i} fill={h.completion_rate >= 0.8 ? '#22c55e' : h.completion_rate >= 0.5 ? '#f59e0b' : '#ef4444'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {/* Duration Distribution */}
        <Card className="cursor-pointer hover:border-primary/50 transition-colors" onClick={() => onTabChange('sessions')}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Session Duration Distribution</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={duration_distribution} margin={{ top: 5, right: 10, left: 10, bottom: 5 }} barGap={4} barCategoryGap="20%">
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
                <XAxis dataKey="label" {...AXIS_PROPS} />
                <YAxis {...AXIS_PROPS} />
                <Tooltip {...TOOLTIP_STYLE} />
                <Legend wrapperStyle={{ paddingTop: '10px' }} formatter={(value) => <span className="text-sm text-muted-foreground">{value}</span>} />
                <Bar dataKey="session_count" fill="#3b82f6" name="Sessions" radius={[4, 4, 0, 0]} />
                <Bar dataKey="completed_count" fill="#22c55e" name="Completed" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      {/* Conversation Depth */}
      <Card className="cursor-pointer hover:border-primary/50 transition-colors" onClick={() => onTabChange('sessions')}>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Conversation Depth</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-4 mb-4">
            <div className="text-center">
              <p className="text-2xl font-bold">{conversation_depth.avg_depth.toFixed(1)}</p>
              <p className="text-xs text-muted-foreground">Avg turns/session</p>
              {conversation_depth.avg_depth > 100 && (
                <p className="text-[10px] text-muted-foreground/70 mt-0.5">Extended multi-step sessions</p>
              )}
            </div>
            <div className="text-center">
              <p className="text-2xl font-bold text-green-600">{formatPct(conversation_depth.low_backforth_completion_rate)}</p>
              <p className="text-xs text-muted-foreground">Quick sessions ({'<'}5 turns)</p>
            </div>
            <div className="text-center">
              <p className={`text-2xl font-bold ${conversation_depth.high_backforth_completion_rate < 0.5 ? 'text-red-600' : 'text-amber-600'}`}>
                {formatPct(conversation_depth.high_backforth_completion_rate)}
              </p>
              <p className="text-xs text-muted-foreground">Deep sessions (5+ turns)</p>
            </div>
          </div>
          <ResponsiveContainer width="100%" height={150}>
            <BarChart data={conversation_depth.depth_buckets} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
              <XAxis dataKey="label" {...AXIS_PROPS} />
              <YAxis {...AXIS_PROPS} />
              <Tooltip {...TOOLTIP_STYLE} />
              <Bar dataKey="session_count" fill="#8b5cf6" name="Sessions" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* Failure Patterns — ensure visible with bottom padding */}
      {failurePatterns && failurePatterns.length > 0 && (
        <Card className="mb-8">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Recurring Failure Patterns</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <SortableHead label="Agent" sortKey="agent" sort={fpSort} onSort={toggleFpSort} />
                  <SortableHead label="Tool" sortKey="tool" sort={fpSort} onSort={toggleFpSort} />
                  <SortableHead label="Occurrences" sortKey="occurrences" sort={fpSort} onSort={toggleFpSort} className="text-right" />
                  <SortableHead label="Sessions Affected" sortKey="sessions" sort={fpSort} onSort={toggleFpSort} className="text-right" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortRows(failurePatterns, fpSort.key, fpSort.dir).slice(0, 10).map((fp, i) => (
                  <TableRow key={i} className="cursor-pointer hover:bg-muted/50" onClick={() => { onAgentFilter?.(fp.agent); onTabChange('tools'); }}>
                    <TableCell>
                      <Badge variant="outline" style={{ borderColor: AGENT_COLORS[fp.agent], color: AGENT_COLORS[fp.agent] }} className="text-xs">
                        {AGENT_LABELS[fp.agent] ?? fp.agent}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-sm">{fp.tool}</TableCell>
                    <TableCell className="text-right text-sm text-red-600">{fp.occurrences}</TableCell>
                    <TableCell className="text-right text-sm">{fp.sessions}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Team Tab ────────────────────────────────────────────────────────────────

function TeamTab({ team, loading }: { team: TeamAnalytics | null; loading: boolean }) {
  if (loading || !team) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {[1, 2, 3].map(i => <Skeleton key={i} className="h-64 w-full" />)}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <h3 className="text-lg font-semibold">Team Overview</h3>
        <Badge variant="outline">{team.total_users} users</Badge>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-4">
            <div className="text-2xl font-bold">{team.total_users}</div>
            <div className="text-sm text-muted-foreground">Active Users</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="text-2xl font-bold">{team.users.reduce((s, u) => s + u.total_sessions, 0)}</div>
            <div className="text-sm text-muted-foreground">Total Sessions</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="text-2xl font-bold">${team.users.reduce((s, u) => s + u.total_cost, 0).toFixed(2)}</div>
            <div className="text-sm text-muted-foreground">Total Cost</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="text-2xl font-bold">
              {team.users.length > 0
                ? (team.users.reduce((s, u) => s + u.completion_rate, 0) / team.users.length * 100).toFixed(0)
                : 0}%
            </div>
            <div className="text-sm text-muted-foreground">Avg Completion Rate</div>
          </CardContent>
        </Card>
      </div>

      {/* Per-user table */}
      <Card>
        <CardHeader><CardTitle>Per-User Breakdown</CardTitle></CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead className="text-right">Sessions</TableHead>
                <TableHead className="text-right">Completion</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead className="text-right">Wasted</TableHead>
                <TableHead className="text-right">Tool Success</TableHead>
                <TableHead className="text-right">Active Days</TableHead>
                <TableHead>Agents</TableHead>
                <TableHead>Top Projects</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {team.users.map(u => (
                <TableRow key={u.username}>
                  <TableCell className="font-medium">{u.username}</TableCell>
                  <TableCell className="text-right">
                    {u.completed_sessions}/{u.total_sessions}
                  </TableCell>
                  <TableCell className="text-right">
                    <span className={u.completion_rate >= 0.8 ? 'text-green-600' : u.completion_rate >= 0.5 ? 'text-yellow-600' : 'text-red-600'}>
                      {(u.completion_rate * 100).toFixed(0)}%
                    </span>
                  </TableCell>
                  <TableCell className="text-right">${u.total_cost.toFixed(2)}</TableCell>
                  <TableCell className="text-right text-red-500">${u.wasted_cost.toFixed(2)}</TableCell>
                  <TableCell className="text-right">
                    <span className={u.tool_success_rate >= 0.95 ? 'text-green-600' : 'text-yellow-600'}>
                      {(u.tool_success_rate * 100).toFixed(1)}%
                    </span>
                  </TableCell>
                  <TableCell className="text-right">{u.active_days}</TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      {u.agents_used.map(a => (
                        <Badge key={a} variant="outline" className="text-xs" style={{ borderColor: AGENT_COLORS[a], color: AGENT_COLORS[a] }}>
                          {AGENT_LABELS[a] || a}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1 flex-wrap">
                      {u.top_projects.map(p => (
                        <Badge key={p} variant="secondary" className="text-xs">{p}</Badge>
                      ))}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Cost distribution bar chart */}
      {team.users.length > 1 && (
        <Card>
          <CardHeader><CardTitle>Cost by User</CardTitle></CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={team.users} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis type="number" tickFormatter={v => `$${v.toFixed(0)}`} />
                <YAxis dataKey="username" type="category" width={100} />
                <Tooltip formatter={(v: number) => `$${v.toFixed(2)}`} />
                <Bar dataKey="total_cost" name="Total Cost" fill="#f97316" />
                <Bar dataKey="wasted_cost" name="Wasted Cost" fill="#ef4444" />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Workspace Tab (Multi-agent) ─────────────────────────────────────────────

function WorkspaceTab() {
  const [agentTab, setAgentTab] = useState<'claude-code' | 'kiro'>('claude-code');
  // Claude Code state
  const [section, setSection] = useState<'active' | 'memory' | 'plans' | 'tasks' | 'settings'>('active');
  const [activeSessions, setActiveSessions] = useState<ActiveSessionInfo[] | null>(null);
  const [memoryProjects, setMemoryProjects] = useState<MemoryProject[] | null>(null);
  const [plans, setPlans] = useState<PlanFile[] | null>(null);
  const [tasks, setTasks] = useState<TaskItem[] | null>(null);
  const [settings, setSettings] = useState<ClaudeSettings | null>(null);
  const [editingMemory, setEditingMemory] = useState<MemoryFile | null>(null);
  const [editContent, setEditContent] = useState('');
  const [expandedPlan, setExpandedPlan] = useState<string | null>(null);
  // Kiro state
  const [kiroSection, setKiroSection] = useState<'mcp' | 'agents' | 'powers' | 'extensions' | 'settings'>('mcp');
  const [kiroWorkspace, setKiroWorkspace] = useState<KiroWorkspace | null>(null);
  const [kiroLoaded, setKiroLoaded] = useState(false);
  const { sort: taskSort, toggle: toggleTaskSort } = useSort<string>('status');
  const { sort: kiroMcpSort, toggle: toggleKiroMcpSort } = useSort<string>('name', 'asc');
  const { sort: kiroExtSort, toggle: toggleKiroExtSort } = useSort<string>('name', 'asc');

  // Claude Code data loading
  useEffect(() => {
    if (agentTab !== 'claude-code') return;
    if (section === 'active' && !activeSessions) {
      fetchJson<{ sessions: ActiveSessionInfo[] }>('/api/coding-agents/claude-code/active-sessions')
        .then(d => setActiveSessions(d.sessions)).catch(() => setActiveSessions([]));
    }
    if (section === 'memory' && !memoryProjects) {
      fetchJson<{ projects: MemoryProject[] }>('/api/coding-agents/claude-code/memory')
        .then(d => setMemoryProjects(d.projects)).catch(() => setMemoryProjects([]));
    }
    if (section === 'plans' && !plans) {
      fetchJson<{ plans: PlanFile[] }>('/api/coding-agents/claude-code/plans')
        .then(d => setPlans(d.plans)).catch(() => setPlans([]));
    }
    if (section === 'tasks' && !tasks) {
      fetchJson<{ tasks: TaskItem[] }>('/api/coding-agents/claude-code/tasks')
        .then(d => setTasks(d.tasks)).catch(() => setTasks([]));
    }
    if (section === 'settings' && !settings) {
      fetchJson<ClaudeSettings>('/api/coding-agents/claude-code/settings')
        .then(d => setSettings(d)).catch(() => {});
    }
  }, [agentTab, section]);

  // Kiro data loading
  useEffect(() => {
    if (agentTab === 'kiro' && !kiroLoaded) {
      setKiroLoaded(true);
      fetchJson<KiroWorkspace>('/api/coding-agents/kiro/workspace')
        .then(d => setKiroWorkspace(d))
        .catch(() => setKiroWorkspace({ settings: {}, mcpServers: [], agents: [], powers: [], extensions: [], recentCommands: [] }));
    }
  }, [agentTab, kiroLoaded]);

  const saveMemory = async () => {
    if (!editingMemory) return;
    const res = await fetch(`${ENV_CONFIG.backendUrl}/api/coding-agents/claude-code/memory`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: editingMemory.filePath, content: editContent }),
    });
    if (res.ok) {
      setEditingMemory(null);
      setMemoryProjects(null); // refresh
    }
  };

  const TASK_STATUS_COLORS: Record<string, string> = {
    completed: 'text-green-600',
    in_progress: 'text-blue-600',
    pending: 'text-muted-foreground',
    deleted: 'text-red-600 line-through',
  };

  return (
    <div className="space-y-4">
      {/* Agent selector */}
      <div className="flex items-center gap-4 border-b pb-3">
        {(['claude-code', 'kiro'] as const).map(agent => (
          <button
            key={agent}
            onClick={() => setAgentTab(agent)}
            className={`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md transition-colors ${agentTab === agent ? 'bg-primary/10 border border-primary/30 text-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-muted'}`}
          >
            <div className="w-3 h-3 rounded-full" style={{ backgroundColor: AGENT_COLORS[agent] }} />
            {AGENT_LABELS[agent] ?? agent}
          </button>
        ))}
      </div>

      {/* Claude Code workspace */}
      {agentTab === 'claude-code' && <>
      <div className="flex gap-2 flex-wrap">
        {(['active', 'memory', 'plans', 'tasks', 'settings'] as const).map(s => (
          <button
            key={s}
            onClick={() => setSection(s)}
            className={`px-3 py-1.5 text-sm border rounded capitalize ${section === s ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
          >
            {s === 'active' ? 'Active Sessions' : s}
          </button>
        ))}
      </div>

      {/* Active Sessions */}
      {section === 'active' && (
        !activeSessions ? <TabSkeleton label="Checking active sessions..." cards={2} /> :
        activeSessions.length === 0 ? (
          <EmptyState icon="~" title="No active sessions" description="No Claude Code sessions have been active in the last 30 minutes." />
        ) : (
          <div className="space-y-2">
            <span className="text-sm text-muted-foreground">{activeSessions.length} active session{activeSessions.length > 1 ? 's' : ''}</span>
            {activeSessions.map(s => {
              const projectName = s.project_path.split('/').pop() ?? s.project_path;
              const modelDisplay = s.model?.replace('claude-code-', 'Claude ')?.replace(/-/g, ' ') ?? '';
              return (
                <Card key={s.session_id}>
                  <CardContent className="pt-3 pb-3 flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium">{projectName}</p>
                      <p className="text-xs text-muted-foreground" title={s.session_id}>{s.project_path}</p>
                    </div>
                    <div className="text-right">
                      <Badge variant="outline" className="text-green-600 border-green-600">Active</Badge>
                      <p className="text-xs text-muted-foreground mt-1">Duration: {s.last_activity_ago}</p>
                      {modelDisplay && <p className="text-xs text-muted-foreground">Model: {modelDisplay}</p>}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )
      )}

      {/* Memory */}
      {section === 'memory' && (
        !memoryProjects ? <TabSkeleton label="Loading memory files..." cards={3} /> :
        memoryProjects.length === 0 ? (
          <EmptyState icon="[]" title="No memory files" description="Claude Code memory files will appear here once created. Memory helps Claude remember context across sessions." />
        ) : (
          <div className="space-y-4">
            {memoryProjects.map(proj => (
              <Card key={proj.slug}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium truncate" title={proj.projectPath}>{proj.projectPath.split('/').pop()}</CardTitle>
                  <p className="text-xs text-muted-foreground">{proj.memories.length} memory file{proj.memories.length > 1 ? 's' : ''}</p>
                </CardHeader>
                <CardContent className="space-y-2">
                  {proj.memories.map(mem => (
                    <div key={mem.filePath} className="border rounded p-3">
                      <div className="flex items-center justify-between mb-2">
                        <div>
                          <span className="text-sm font-medium">{mem.name}</span>
                          {mem.type !== 'index' && <Badge variant="secondary" className="ml-2 text-xs">{mem.type}</Badge>}
                        </div>
                        <button
                          onClick={() => { setEditingMemory(mem); setEditContent(mem.content); }}
                          className="text-xs text-blue-600 hover:underline"
                        >Edit</button>
                      </div>
                      {mem.description && <p className="text-xs text-muted-foreground mb-1">{mem.description}</p>}
                      <pre className="text-xs font-mono bg-muted/50 p-2 rounded max-h-40 overflow-y-auto whitespace-pre-wrap">{mem.content.slice(0, 1000)}</pre>
                    </div>
                  ))}
                </CardContent>
              </Card>
            ))}

            {/* Memory editor modal */}
            {editingMemory && (
              <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
                <Card className="w-full max-w-2xl max-h-[80vh] flex flex-col">
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-sm">Edit: {editingMemory.name}</CardTitle>
                      <button onClick={() => setEditingMemory(null)} className="text-muted-foreground hover:text-foreground">&times;</button>
                    </div>
                  </CardHeader>
                  <CardContent className="flex-1 overflow-hidden flex flex-col gap-2">
                    <textarea
                      className="flex-1 w-full border rounded p-3 font-mono text-sm bg-background resize-none min-h-[300px]"
                      value={editContent}
                      onChange={e => setEditContent(e.target.value)}
                    />
                    <div className="flex justify-end gap-2">
                      <button onClick={() => setEditingMemory(null)} className="px-4 py-2 text-sm border rounded hover:bg-muted">Cancel</button>
                      <button onClick={saveMemory} className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded hover:opacity-90">Save</button>
                    </div>
                  </CardContent>
                </Card>
              </div>
            )}
          </div>
        )
      )}

      {/* Plans — left list + right markdown viewer */}
      {section === 'plans' && (
        !plans ? <TabSkeleton label="Loading plans..." cards={2} /> :
        plans.length === 0 ? (
          <EmptyState icon="{ }" title="No plans" description="Plans are created by Claude Code when working on complex tasks. They'll appear here automatically." />
        ) : (
          <div className="flex gap-4 min-h-[500px]">
            {/* Left pane — plan list */}
            <div className="w-72 flex-shrink-0 space-y-1 overflow-y-auto max-h-[calc(100vh-250px)]">
              <p className="text-xs text-muted-foreground mb-2">{plans.length} plan{plans.length > 1 ? 's' : ''}</p>
              {plans.map(plan => {
                const titleMatch = plan.content.match(/^#\s+(.+?)$/m);
                const planTitle = titleMatch ? titleMatch[1].replace(/^Plan:\s*/i, '') : plan.name;
                return (
                  <div
                    key={plan.name}
                    className={`p-3 rounded-md border cursor-pointer transition-colors ${expandedPlan === plan.name ? 'bg-primary/10 border-primary/30' : 'hover:bg-muted'}`}
                    onClick={() => setExpandedPlan(expandedPlan === plan.name ? null : plan.name)}
                  >
                    <p className="text-sm font-medium line-clamp-2" title={planTitle}>{planTitle}</p>
                    <p className="text-xs text-muted-foreground mt-1">{new Date(plan.modifiedAt).toLocaleString()}</p>
                  </div>
                );
              })}
            </div>
            {/* Right pane — rendered markdown */}
            <Card className="flex-1 overflow-hidden">
              {expandedPlan ? (
                <CardContent className="overflow-y-auto max-h-[calc(100vh-250px)] pt-6">
                  <div className="prose prose-sm dark:prose-invert max-w-none prose-headings:text-sm prose-p:text-sm prose-p:leading-relaxed prose-code:text-opensearch-blue prose-code:bg-muted prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-xs prose-ul:text-sm prose-ol:text-sm prose-table:text-sm">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {plans.find(p => p.name === expandedPlan)?.content ?? ''}
                    </ReactMarkdown>
                  </div>
                </CardContent>
              ) : (
                <CardContent className="flex items-center justify-center h-full">
                  <p className="text-sm text-muted-foreground">Select a plan to view</p>
                </CardContent>
              )}
            </Card>
          </div>
        )
      )}

      {/* Tasks */}
      {section === 'tasks' && (
        !tasks ? <TabSkeleton label="Loading tasks..." table /> :
        tasks.length === 0 ? (
          <EmptyState icon="#" title="No tasks" description="Tasks are created by Claude Code to track work progress. Start a coding session to see tasks here." />
        ) : (
          <div className="space-y-2">
            <div className="flex gap-4 text-sm text-muted-foreground">
              <span>{tasks.filter(t => t.status === 'completed').length} done</span>
              <span>{tasks.filter(t => t.status === 'in_progress').length} in progress</span>
              <span>{tasks.filter(t => t.status === 'pending').length} pending</span>
            </div>
            <Card>
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortableHead label="ID" sortKey="id" sort={taskSort} onSort={toggleTaskSort} className="w-12" />
                    <SortableHead label="Task" sortKey="subject" sort={taskSort} onSort={toggleTaskSort} />
                    <SortableHead label="Status" sortKey="status" sort={taskSort} onSort={toggleTaskSort} />
                    <SortableHead label="Owner" sortKey="owner" sort={taskSort} onSort={toggleTaskSort} />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortRows(tasks.filter(t => t.status !== 'deleted'), taskSort.key, taskSort.dir, (t, k) => {
                    if (k === 'owner') return t.owner ?? '';
                    return t[k as keyof TaskItem] as string;
                  }).map(t => (
                    <TableRow key={t.id}>
                      <TableCell className="text-sm text-muted-foreground">#{t.id}</TableCell>
                      <TableCell>
                        <p className="text-sm">{t.subject}</p>
                        {t.description && <p className="text-xs text-muted-foreground truncate max-w-md">{t.description}</p>}
                      </TableCell>
                      <TableCell className={`text-sm ${TASK_STATUS_COLORS[t.status] ?? ''}`}>{t.status}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{t.owner ?? '-'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          </div>
        )
      )}

      {/* Settings */}
      {section === 'settings' && (
        !settings ? <TabSkeleton label="Loading settings..." cards={3} /> : (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-4">
              <StatCard title="Storage" value={`${(settings.storage_bytes / 1024).toFixed(0)} KB`} />
              <StatCard title="Skills" value={String(settings.skills.length)} />
              <StatCard title="Plugins" value={String(settings.plugins.length)} />
            </div>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">Settings</CardTitle>
              </CardHeader>
              <CardContent>
                <pre className="text-xs font-mono bg-muted/50 p-3 rounded max-h-60 overflow-y-auto whitespace-pre-wrap">
                  {JSON.stringify(settings.settings, null, 2)}
                </pre>
              </CardContent>
            </Card>

            {settings.skills.length > 0 && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium">Skills ({settings.skills.length})</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {settings.skills.map((s, i) => (
                    <div key={i} className="flex items-start gap-2">
                      <div className="w-2 h-2 rounded-full bg-amber-500 mt-1.5 flex-shrink-0" />
                      <div>
                        <p className="text-sm font-medium font-mono">{s.name}</p>
                        {s.description && <p className="text-xs text-muted-foreground">{s.description}</p>}
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            {settings.plugins.length > 0 && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium">Plugins ({settings.plugins.length})</CardTitle>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Plugin</TableHead>
                        <TableHead>Scope</TableHead>
                        <TableHead>Version</TableHead>
                        <TableHead>Installed</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {settings.plugins.map((p, i) => (
                        <TableRow key={i}>
                          <TableCell className="text-sm font-mono">{p.name}</TableCell>
                          <TableCell className="text-sm">{p.scope}</TableCell>
                          <TableCell className="text-sm text-muted-foreground">{p.version || '-'}</TableCell>
                          <TableCell className="text-sm text-muted-foreground">{p.installedAt ? new Date(p.installedAt).toLocaleDateString() : '-'}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            )}
          </div>
        )
      )}
      </>}

      {/* Kiro workspace */}
      {agentTab === 'kiro' && <>
        <div className="flex gap-2 flex-wrap">
          {(['mcp', 'agents', 'powers', 'extensions', 'settings'] as const).map(s => (
            <button
              key={s}
              onClick={() => setKiroSection(s)}
              className={`px-3 py-1.5 text-sm border rounded capitalize ${kiroSection === s ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
            >
              {s === 'mcp' ? 'MCP Servers' : s}
            </button>
          ))}
        </div>

        {!kiroWorkspace ? <TabSkeleton label="Loading Kiro workspace..." cards={3} table /> : <>
          {/* MCP Servers */}
          {kiroSection === 'mcp' && (
            kiroWorkspace.mcpServers.length === 0 ? (
              <EmptyState icon="<>" title="No MCP servers" description="Configure MCP servers in ~/.kiro/settings/mcp.json to connect external tools." />
            ) : (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium">MCP Servers ({kiroWorkspace.mcpServers.length})</CardTitle>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <SortableHead label="Server" sortKey="name" sort={kiroMcpSort} onSort={toggleKiroMcpSort} />
                        <SortableHead label="Command" sortKey="command" sort={kiroMcpSort} onSort={toggleKiroMcpSort} />
                        <SortableHead label="Status" sortKey="disabled" sort={kiroMcpSort} onSort={toggleKiroMcpSort} />
                        <SortableHead label="Disabled Tools" sortKey="disabledToolCount" sort={kiroMcpSort} onSort={toggleKiroMcpSort} className="text-right" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {sortRows(kiroWorkspace.mcpServers, kiroMcpSort.key, kiroMcpSort.dir, (s, k) => {
                        if (k === 'disabled') return s.disabled ? 1 : 0;
                        return s[k as keyof KiroMcpServer] as string | number;
                      }).map(s => (
                        <TableRow key={s.name}>
                          <TableCell className="text-sm font-mono font-medium">{s.name}</TableCell>
                          <TableCell className="text-sm text-muted-foreground font-mono">{s.command}</TableCell>
                          <TableCell>
                            {s.disabled
                              ? <Badge variant="secondary" className="text-xs">Disabled</Badge>
                              : <Badge variant="outline" className="text-xs text-green-600 border-green-600">Active</Badge>}
                          </TableCell>
                          <TableCell className="text-right text-sm">{s.disabledToolCount > 0 ? s.disabledToolCount : '-'}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            )
          )}

          {/* Agents */}
          {kiroSection === 'agents' && (
            kiroWorkspace.agents.length === 0 ? (
              <EmptyState icon="@" title="No agents configured" description="Add agent configurations in ~/.kiro/agents/ to customize Kiro's behavior." />
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {kiroWorkspace.agents.map(a => (
                  <Card key={a.name}>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm font-medium font-mono">{a.name}</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-1 text-sm">
                      {a.description && <p className="text-xs text-muted-foreground mb-2 line-clamp-2">{a.description}</p>}
                      <MetricRow label="MCP Servers" value={a.hasMcpServers ? 'Yes' : 'No'} />
                      <MetricRow label="Hooks" value={a.hasHooks ? 'Yes' : 'No'} />
                      <MetricRow label="Resources" value={String(a.resourceCount)} />
                    </CardContent>
                  </Card>
                ))}
              </div>
            )
          )}

          {/* Powers */}
          {kiroSection === 'powers' && (
            kiroWorkspace.powers.length === 0 ? (
              <EmptyState icon="+" title="No powers installed" description="Install powers from the Kiro registry to extend functionality." />
            ) : (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium">Installed Powers ({kiroWorkspace.powers.length})</CardTitle>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Power</TableHead>
                        <TableHead>Registry</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {kiroWorkspace.powers.map(p => (
                        <TableRow key={p.name}>
                          <TableCell className="text-sm font-mono font-medium">{p.name}</TableCell>
                          <TableCell className="text-sm text-muted-foreground">{p.registryId}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            )
          )}

          {/* Extensions */}
          {kiroSection === 'extensions' && (
            kiroWorkspace.extensions.length === 0 ? (
              <EmptyState icon="[]" title="No extensions found" description="Kiro extensions will appear here once installed." />
            ) : (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium">Extensions ({kiroWorkspace.extensions.length})</CardTitle>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <SortableHead label="Extension" sortKey="name" sort={kiroExtSort} onSort={toggleKiroExtSort} />
                        <SortableHead label="ID" sortKey="id" sort={kiroExtSort} onSort={toggleKiroExtSort} />
                        <SortableHead label="Version" sortKey="version" sort={kiroExtSort} onSort={toggleKiroExtSort} />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {sortRows(kiroWorkspace.extensions, kiroExtSort.key, kiroExtSort.dir).map(e => (
                        <TableRow key={`${e.id}-${e.version}`}>
                          <TableCell className="text-sm font-medium">{e.name}</TableCell>
                          <TableCell className="text-sm text-muted-foreground font-mono">{e.id}</TableCell>
                          <TableCell className="text-sm text-muted-foreground">{e.version}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            )
          )}

          {/* Settings */}
          {kiroSection === 'settings' && (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-4">
                <StatCard title="MCP Servers" value={String(kiroWorkspace.mcpServers.length)} />
                <StatCard title="Agents" value={String(kiroWorkspace.agents.length)} />
                <StatCard title="Powers" value={String(kiroWorkspace.powers.length)} />
              </div>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium">CLI Settings</CardTitle>
                </CardHeader>
                <CardContent>
                  <pre className="text-xs font-mono bg-muted/50 p-3 rounded max-h-60 overflow-y-auto whitespace-pre-wrap">
                    {JSON.stringify(kiroWorkspace.settings, null, 2)}
                  </pre>
                </CardContent>
              </Card>
              {kiroWorkspace.recentCommands.length > 0 && (
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium">Recent CLI Commands ({kiroWorkspace.recentCommands.length})</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-1">
                      {kiroWorkspace.recentCommands.map((cmd, i) => (
                        <div key={i} className="text-xs font-mono bg-muted/50 px-3 py-1.5 rounded truncate" title={cmd}>{cmd}</div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>
          )}
        </>}
      </>}
    </div>
  );
}

// ─── Advanced Section (collapsible wrapper) ────────────────────────────────

function AdvancedSection({ advanced, failurePatterns, loading, onTabChange, onAgentFilter }: {
  advanced: AdvancedAnalytics | null; failurePatterns: FailurePattern[] | null; loading: boolean; onTabChange: (tab: string) => void; onAgentFilter?: (agent: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="border-t pt-4">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors w-full text-left"
      >
        <span className={`transition-transform ${expanded ? 'rotate-90' : ''}`}>&#x25B6;</span>
        Advanced Analytics
        {advanced?.mcp.servers.length ? <Badge variant="secondary" className="text-[10px] ml-1">{advanced.mcp.servers.length} MCP</Badge> : null}
      </button>
      {expanded && (
        <div className="mt-4">
          <AdvancedTab advanced={advanced} failurePatterns={failurePatterns} loading={loading} onTabChange={onTabChange} onAgentFilter={onAgentFilter} />
        </div>
      )}
    </div>
  );
}

// ─── Token Cache Breakdown ──────────────────────────────────────────────────

function TokenCacheBar({ stats }: { stats: CombinedStats }) {
  const totalInput = stats.agents.reduce((s, a) => s + a.totalInputTokens, 0);
  const totalOutput = stats.agents.reduce((s, a) => s + a.totalOutputTokens, 0);
  const totalTokens = totalInput + totalOutput;
  if (totalTokens === 0) return null;

  const inputPct = (totalInput / totalTokens) * 100;
  const outputPct = (totalOutput / totalTokens) * 100;

  return (
    <div>
      <div className="flex items-center gap-3 text-xs">
        <div className="flex-1 h-3 rounded-full overflow-hidden bg-muted flex">
          <div className="bg-blue-500 h-full" style={{ width: `${inputPct}%` }} title={`Input: ${formatTokens(totalInput)}`} />
          <div className="bg-orange-500 h-full" style={{ width: `${outputPct}%` }} title={`Output: ${formatTokens(totalOutput)}`} />
        </div>
        <div className="flex gap-3 text-muted-foreground flex-shrink-0">
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-500 inline-block" />input: {formatTokens(totalInput)}</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-orange-500 inline-block" />output: {formatTokens(totalOutput)}</span>
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground/70 mt-1">
        {totalOutput > totalInput * 2 ? 'Output-heavy — sessions have verbose responses'
          : totalInput > totalOutput ? 'Input-heavy — large context provided to agents'
          : 'Balanced token usage across sessions'}
      </p>
    </div>
  );
}

// ─── Shared Components ────────────────────────────────────────────────────────

function StatCard({ title, value, accent, onClick, trend, trendLabel, tooltip, loading }: {
  title: string; value: string; accent?: 'red' | 'yellow' | 'green'; onClick?: () => void;
  trend?: number; trendLabel?: string; tooltip?: string; loading?: boolean;
}) {
  const colorClass = accent === 'red' ? 'text-red-600 dark:text-red-400'
    : accent === 'yellow' ? 'text-yellow-600 dark:text-yellow-400'
    : accent === 'green' ? 'text-green-600 dark:text-green-400'
    : '';
  return (
    <Card className={onClick ? 'cursor-pointer hover:border-primary/50 transition-colors' : ''} onClick={onClick}>
      <CardContent className="pt-4 pb-3 relative">
        {loading && (
          <div className="absolute top-2 right-2 h-3 w-3 rounded-full border-[1.5px] border-muted-foreground/30 border-t-muted-foreground animate-spin" />
        )}
        <p className="text-xs text-muted-foreground flex items-center gap-1">
          {title}
          {tooltip && (
            <span className="inline-block w-3.5 h-3.5 rounded-full bg-muted text-[9px] text-center leading-[14px] cursor-help" title={tooltip}>i</span>
          )}
        </p>
        <p className={`text-2xl font-bold ${colorClass}`}>{value}</p>
        {trend !== undefined && trend !== 0 && (
          <p className={`text-xs mt-0.5 flex items-center gap-1 ${
            trend > 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
          }`}>
            {trend > 0 ? '↑' : '↓'} {Math.abs(trend).toFixed(0)}%
            {trendLabel && <span className="text-muted-foreground">{trendLabel}</span>}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function EmptyState({ title, description, icon }: { title: string; description?: string; icon?: string }) {
  return (
    <Card>
      <CardContent className="pt-10 pb-10 text-center">
        <div className="text-3xl mb-3 opacity-30">{icon ?? '--'}</div>
        <p className="text-sm font-medium text-muted-foreground">{title}</p>
        {description && <p className="text-xs text-muted-foreground/70 mt-1 max-w-sm mx-auto">{description}</p>}
      </CardContent>
    </Card>
  );
}

function TabSkeleton({ label, cards = 0, charts = 0, table = false }: { label: string; cards?: number; charts?: number; table?: boolean }) {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="h-4 w-4 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
        <span className="text-sm text-muted-foreground animate-pulse">{label}</span>
      </div>
      {cards > 0 && (
        <div className={`grid grid-cols-2 md:grid-cols-${Math.min(cards, 6)} gap-4`}>
          {Array.from({ length: cards }, (_, i) => <Skeleton key={i} className="h-20 rounded-lg" />)}
        </div>
      )}
      {charts > 0 && (
        <div className={`grid grid-cols-1 ${charts > 1 ? 'lg:grid-cols-2' : ''} gap-4`}>
          {Array.from({ length: charts }, (_, i) => <Skeleton key={i} className="h-52 rounded-lg" />)}
        </div>
      )}
      {table && <Skeleton className="h-64 rounded-lg" />}
    </div>
  );
}

function OverviewSkeleton() {
  return <TabSkeleton label="Loading overview..." cards={6} charts={2} />;
}

// ─── Main Page ────────────────────────────────────────────────────────────────

const DATE_RANGE_LABELS: Record<DateRangePreset, string> = {
  today: 'Today',
  '7d': 'Last 7 Days',
  '30d': 'Last 30 Days',
  all: 'All Time',
};

export const CodingAgentsPage: React.FC = () => {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [stats, setStats] = useState<CombinedStats | null>(null);
  const [costs, setCosts] = useState<CostAnalytics | null>(null);
  const [activity, setActivity] = useState<ActivityData | null>(null);
  const [tools, setTools] = useState<ToolsData | null>(null);
  const [efficiency, setEfficiency] = useState<EfficiencyData | null>(null);
  const [projects, setProjects] = useState<ProjectAnalytics[] | null>(null);
  const [advanced, setAdvanced] = useState<AdvancedAnalytics | null>(null);
  const [failurePatterns, setFailurePatterns] = useState<FailurePattern[] | null>(null);
  const [team, setTeam] = useState<TeamAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  // Read initial tab from URL query param (e.g., ?tab=workspace)
  const [activeTab, setActiveTab] = useState(() => {
    try { return new URLSearchParams(window.location.search).get('tab') || 'overview'; } catch { return 'overview'; }
  });
  const [error, setError] = useState<string | null>(null);
  const [rangePreset, setRangePreset] = useState<DateRangePreset>('today');
  const [refreshKey, setRefreshKey] = useState(0);
  const [sessionProjectFilter, setSessionProjectFilter] = useState<string | undefined>();
  const [sessionAgentFilter, setSessionAgentFilter] = useState<string | undefined>();

  const handleSelectProject = (projectPath: string) => {
    setSessionAgentFilter(undefined);
    setSessionProjectFilter(projectPath);
    setActiveTab('sessions');
  };
  const handleAgentFilter = (agent: string) => {
    setSessionProjectFilter(undefined);
    setSessionAgentFilter(agent);
  };
  // Navigate to a tab without carrying over stale filters
  const navigateTab = (tab: string) => {
    setSessionAgentFilter(undefined);
    setSessionProjectFilter(undefined);
    setActiveTab(tab);
  };

  const range = getDateRange(rangePreset);

  // Reset lazy-loaded tab data when range changes
  const handleRangeChange = (preset: DateRangePreset) => {
    setRangePreset(preset);
    setCosts(null);
    setActivity(null);
    setTools(null);
    setEfficiency(null);
    setProjects(null);
    setAdvanced(null);
    setFailurePatterns(null);
    setTeam(null);
  };

  const handleExport = (format: 'json' | 'csv') => {
    const url = `${ENV_CONFIG.backendUrl}${buildQuery('/api/coding-agents/export', range, { format })}`;
    window.open(url, '_blank');
  };

  useEffect(() => {
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    let isInitial = true;
    const load = async () => {
      try {
        if (isInitial) setLoading(true);
        const [agentData, statsData, teamData] = await Promise.all([
          fetchJson<{ agents: AgentInfo[] }>('/api/coding-agents/available'),
          fetchJson<CombinedStats>(buildQuery('/api/coding-agents/stats', range)),
          fetchJson<TeamAnalytics>(buildQuery('/api/coding-agents/team', range)),
        ]);
        if (cancelled) return;
        isInitial = false;
        setAgents(agentData.agents);
        setStats(statsData);
        setTeam(teamData);

        if (agentData.agents.length === 0) {
          setError('No coding agents detected. Install Claude Code, Kiro, or Codex CLI to see analytics.');
        }

        // Auto-refresh while server is still loading historical data
        if (statsData.warming && !cancelled) {
          retryTimer = setTimeout(() => { if (!cancelled) load(); }, 5000);
        }
      } catch (e: any) {
        if (!cancelled) setError(e.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();

    return () => { cancelled = true; if (retryTimer) clearTimeout(retryTimer); };
  }, [rangePreset, refreshKey]);

  // Lazy-load tab data
  useEffect(() => {
    // Sessions tab manages its own data loading now
    if (activeTab === 'costs' && !costs) {
      fetchJson<CostAnalytics>(buildQuery('/api/coding-agents/costs', range))
        .then(d => setCosts(d))
        .catch(() => {});
    }
    // Performance tab loads both activity + efficiency
    if (activeTab === 'performance') {
      if (!activity) {
        fetchJson<ActivityData>(buildQuery('/api/coding-agents/activity', range))
          .then(d => setActivity(d))
          .catch(() => {});
      }
      if (!efficiency) {
        fetchJson<EfficiencyData>(buildQuery('/api/coding-agents/efficiency', range))
          .then(d => setEfficiency(d))
          .catch(() => {});
      }
    }
    // Tools tab loads tools + advanced
    if (activeTab === 'tools') {
      if (!tools) {
        fetchJson<ToolsData>(buildQuery('/api/coding-agents/tools', range))
          .then(d => setTools(d))
          .catch(() => {});
      }
      if (!advanced) {
        Promise.all([
          fetchJson<AdvancedAnalytics>(buildQuery('/api/coding-agents/advanced', range)),
          fetchJson<{ patterns: FailurePattern[] }>(buildQuery('/api/coding-agents/failure-patterns', range)),
        ]).then(([adv, fp]) => {
          setAdvanced(adv);
          setFailurePatterns(fp.patterns);
        }).catch(() => {});
      }
    }
    if (activeTab === 'projects' && !projects) {
      fetchJson<{ projects: ProjectAnalytics[] }>(buildQuery('/api/coding-agents/projects', range))
        .then(d => setProjects(d.projects))
        .catch(() => {});
    }
    if (activeTab === 'team' && !team) {
      fetchJson<TeamAnalytics>(buildQuery('/api/coding-agents/team', range))
        .then(d => setTeam(d))
        .catch(() => {});
    }
  }, [activeTab, rangePreset]);

  return (
    <div className="p-6 space-y-6 max-w-7xl">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Coding Agent Analytics</h1>
          <p className="text-muted-foreground">
            Usage analytics across your coding agents
            {agents.length > 0 && (
              <span className="ml-2">
                {agents.map(a => (
                  <Badge key={a.name} variant="outline" className="ml-1" style={{ borderColor: AGENT_COLORS[a.name], color: AGENT_COLORS[a.name] }}>
                    {a.displayName}
                  </Badge>
                ))}
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            onClick={() => { setRefreshKey(k => k + 1); }}
            disabled={loading}
            title="Refresh data"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </Button>
          <Select value={rangePreset} onValueChange={(v) => handleRangeChange(v as DateRangePreset)}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(DATE_RANGE_LABELS) as DateRangePreset[]).map(k => (
                <SelectItem key={k} value={k}>{DATE_RANGE_LABELS[k]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select onValueChange={(v) => handleExport(v as 'json' | 'csv')}>
            <SelectTrigger className="w-28">
              <SelectValue placeholder="Export" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="json">JSON</SelectItem>
              <SelectItem value="csv">CSV</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {error && agents.length === 0 ? (
        <Card>
          <CardContent className="pt-10 pb-10">
            <div className="text-center">
              <div className="text-4xl mb-4 opacity-20">&gt;_</div>
              <p className="text-lg font-medium text-muted-foreground mb-2">No coding agents detected</p>
              <p className="text-sm text-muted-foreground max-w-md mx-auto mb-4">
                Install a coding agent to start tracking your AI-assisted development sessions, costs, and productivity.
              </p>
              <div className="flex justify-center gap-6 text-xs text-muted-foreground/70">
                <span>Claude Code <span className="font-mono">~/.claude</span></span>
                <span>Kiro <span className="font-mono">~/.kiro</span></span>
                <span>Codex CLI <span className="font-mono">~/.codex</span></span>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Tabs value={activeTab} onValueChange={navigateTab}>
          <TabsList className="flex-wrap">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="sessions">Sessions</TabsTrigger>
            <TabsTrigger value="projects">Projects</TabsTrigger>
            <TabsTrigger value="costs">Costs</TabsTrigger>
            <TabsTrigger value="performance">Performance</TabsTrigger>
            <TabsTrigger value="tools">Tools</TabsTrigger>
            {team?.is_multi_user && <TabsTrigger value="team">Team</TabsTrigger>}
            <TabsTrigger value="workspace">Workspace</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="mt-4">
            <OverviewTab stats={stats} agents={agents} onTabChange={setActiveTab} rangePreset={rangePreset} onRangeChange={setRangePreset} onAgentFilter={handleAgentFilter} />
          </TabsContent>
          <TabsContent value="sessions" className="mt-4">
            <SessionsTab range={range} loading={loading} initialProject={sessionProjectFilter} initialAgent={sessionAgentFilter} onClearFilters={() => { setSessionAgentFilter(undefined); setSessionProjectFilter(undefined); }} />
          </TabsContent>
          <TabsContent value="projects" className="mt-4">
            <ProjectsTab projects={projects} loading={activeTab === 'projects' && !projects} onSelectProject={handleSelectProject} />
          </TabsContent>
          <TabsContent value="costs" className="mt-4">
            <CostsTab costs={costs} loading={activeTab === 'costs' && !costs} onTabChange={setActiveTab} onSelectProject={handleSelectProject} cacheSavings={stats ? stats.agents.reduce((s, a) => s + a.totalCacheSavings, 0) : undefined} />
          </TabsContent>
          <TabsContent value="performance" className="mt-4">
            {/* Merged Activity + Efficiency */}
            <div className="space-y-8">
              <div>
                <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-4">Activity Patterns</h2>
                <ActivityTab activity={activity} loading={(activeTab === 'performance') && !activity} onTabChange={setActiveTab} />
              </div>
              <div className="border-t pt-6">
                <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-4">Efficiency Metrics</h2>
                <EfficiencyTab efficiency={efficiency} loading={(activeTab === 'performance') && !efficiency} onTabChange={setActiveTab} onAgentFilter={handleAgentFilter} />
              </div>
            </div>
          </TabsContent>
          <TabsContent value="tools" className="mt-4">
            <div className="space-y-8">
              <ToolsTab tools={tools} loading={activeTab === 'tools' && !tools} onTabChange={setActiveTab} onAgentFilter={handleAgentFilter} />
              {/* Advanced Analytics — collapsible section within Tools */}
              <AdvancedSection advanced={advanced} failurePatterns={failurePatterns} loading={activeTab === 'tools' && !advanced} onTabChange={setActiveTab} onAgentFilter={handleAgentFilter} />
            </div>
          </TabsContent>
          {team?.is_multi_user && (
            <TabsContent value="team" className="mt-4">
              <TeamTab team={team} loading={activeTab === 'team' && !team} />
            </TabsContent>
          )}
          <TabsContent value="workspace" className="mt-4">
            <WorkspaceTab />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
};
