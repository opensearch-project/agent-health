/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Info, BarChart3, Play, FileText, AlertTriangle, Clock,
  CheckCircle2, XCircle, ArrowRight, TrendingDown, Activity,
} from 'lucide-react';
import {
  asyncBenchmarkStorage,
  asyncRunStorage,
  asyncTestCaseStorage,
} from '@/services/storage';
import { Benchmark, BenchmarkRun, EvaluationReport } from '@/types';
import { fetchBatchMetrics } from '@/services/metrics';
import { AgentTrendsBand } from './dashboard/AgentTrendsBand';
import { FirstRunExperience } from './dashboard/FirstRunExperience';
import { ReadyToRun } from './dashboard/ReadyToRun';
import { useDataState } from '@/hooks/useDataState';
import { isSampleDataActive } from '@/config/sampleData';
import { DEFAULT_CONFIG } from '@/lib/constants';
import { cn, formatRelativeTime, getModelName } from '@/lib/utils';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

// ==================== Types ====================

interface RunRow {
  run: BenchmarkRun;
  benchmarkId: string;
  benchmarkName: string;
  agentName: string;
  passed: number;
  failed: number;
  total: number;
  passRate: number;
}

interface RegressionRow extends RunRow {
  prevPassRate: number;
  delta: number; // negative
}

interface AgentImprovementRow {
  agentKey: string;
  agentName: string;
  totalRuns: number;
  failingRuns: number;       // runs with failed > 0
  failedTestCases: number;   // sum of failed across all runs
  totalTestCases: number;    // sum of total across all runs
  passRate: number;          // failedTestCases excluded from numerator
  latestPassRate: number;    // latest run only
  latestRunAt: string;
  benchmarkCount: number;
  bestRow: RunRow;           // most-recent failing row, for click-through
}

interface AgentRegressionRow extends AgentImprovementRow {
  prevAggregatePassRate: number;
  delta: number;
}

// ==================== Helpers ====================

function computeRunStats(run: BenchmarkRun): { passed: number; failed: number; total: number } {
  if (run.stats && run.stats.total > 0) {
    return { passed: run.stats.passed, failed: run.stats.failed, total: run.stats.total };
  }
  const results = Object.values(run.results || {});
  let passed = 0, failed = 0;
  for (const r of results) {
    if (r.status === 'completed') passed++;
    else if (r.status === 'failed' || r.status === 'cancelled') failed++;
  }
  return { passed, failed, total: results.length };
}

function buildRunRows(benchmarks: Benchmark[]): RunRow[] {
  const rows: RunRow[] = [];
  for (const bm of benchmarks) {
    for (const run of bm.runs || []) {
      const stats = computeRunStats(run);
      const agentName =
        DEFAULT_CONFIG.agents.find(a => a.key === run.agentKey)?.name ||
        run.agentKey ||
        'Unknown';
      rows.push({
        run,
        benchmarkId: bm.id,
        benchmarkName: bm.name,
        agentName,
        passed: stats.passed,
        failed: stats.failed,
        total: stats.total,
        passRate: stats.total > 0 ? stats.passed / stats.total : 0,
      });
    }
  }
  return rows;
}

// Tailwind-friendly bar color from pass rate
function rateColor(rate: number): string {
  if (rate >= 0.9) return 'bg-emerald-500';
  if (rate >= 0.7) return 'bg-lime-500';
  if (rate >= 0.5) return 'bg-amber-500';
  if (rate >= 0.25) return 'bg-orange-500';
  return 'bg-red-500';
}

// ==================== Skeletons ====================

const DashboardSkeleton = () => (
  <div className="space-y-4">
    <div className="grid gap-4 lg:grid-cols-3">
      <Skeleton className="h-[260px] lg:col-span-2" />
      <Skeleton className="h-[260px]" />
    </div>
    <Skeleton className="h-[300px]" />
  </div>
);

// ==================== Stat Pill ====================

interface StatPillProps {
  to?: string;
  label: string;
  value: string | number;
  icon: React.ComponentType<{ className?: string }>;
  testId?: string;
}

const StatPill: React.FC<StatPillProps> = ({ to, label, value, icon: Icon, testId }) => {
  const inner = (
    <div
      className="inline-flex items-center gap-1.5 rounded-full border bg-background/60 backdrop-blur-sm px-2.5 py-1 text-[11px] hover:bg-muted/70 transition-colors"
      data-testid={testId}
    >
      <Icon className="h-3 w-3 text-muted-foreground" />
      <span className="text-muted-foreground">{label}</span>
      <span className="font-semibold tabular-nums">{value}</span>
    </div>
  );
  return to ? <Link to={to}>{inner}</Link> : inner;
};

// ==================== Status Icon ====================

const StatusIcon: React.FC<{ row: Pick<RunRow, 'failed' | 'passed'> }> = ({ row }) => {
  const allPassed = row.failed === 0 && row.passed > 0;
  if (allPassed) return <CheckCircle2 className="h-3 w-3 text-emerald-500 shrink-0" />;
  if (row.failed > 0) return <XCircle className="h-3 w-3 text-red-500 shrink-0" />;
  return <Clock className="h-3 w-3 text-muted-foreground shrink-0" />;
};

// ==================== Truncate-with-tooltip ====================

const TruncText: React.FC<{ text: string; className?: string; testId?: string }> = ({ text, className, testId }) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <span data-testid={testId} className={cn('inline-block max-w-full align-bottom', className)}>
        {text}
      </span>
    </TooltipTrigger>
    <TooltipContent>{text}</TooltipContent>
  </Tooltip>
);

// ==================== Mini pass-rate bar ====================

const RateBar: React.FC<{ rate: number; passed: number; failed: number; total: number }> = ({
  rate, passed, failed, total,
}) => {
  const pct = Math.round(rate * 100);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center gap-1.5 w-full">
          <div className="h-1 flex-1 rounded-full overflow-hidden bg-muted/60 min-w-[24px]">
            <div
              className={`h-full ${rateColor(rate)} transition-[width]`}
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="text-[10px] tabular-nums text-muted-foreground shrink-0 w-7 text-right">
            {pct}%
          </span>
        </div>
      </TooltipTrigger>
      <TooltipContent>
        <span className="text-emerald-400">{passed} passed</span>
        {' · '}
        <span className="text-red-400">{failed} failed</span>
        {' · '}
        <span>{total} total</span>
      </TooltipContent>
    </Tooltip>
  );
};

// ==================== Compact Run Row (widget) ====================

interface WidgetRowProps {
  row: RunRow;
  onClick: () => void;
  trailing?: React.ReactNode;
}

const WidgetRow: React.FC<WidgetRowProps> = ({ row, onClick, trailing }) => (
  <button
    onClick={onClick}
    className="group w-full grid items-center gap-2 px-3 h-8 text-left text-[11px] border-b last:border-b-0 hover:bg-muted/50 transition-colors"
    style={{ gridTemplateColumns: '12px minmax(0,1fr) auto 56px' }}
  >
    <StatusIcon row={row} />
    <div className="min-w-0">
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="truncate">
            <span className="font-medium">{row.run.name}</span>
            <span className="text-muted-foreground"> · </span>
            <span className="text-muted-foreground">{row.benchmarkName}</span>
          </div>
        </TooltipTrigger>
        <TooltipContent>
          <div className="text-[11px]">
            <div className="font-medium">{row.run.name}</div>
            <div className="text-muted-foreground">{row.benchmarkName} · {row.agentName}</div>
          </div>
        </TooltipContent>
      </Tooltip>
    </div>
    {trailing}
    <RateBarMini rate={row.passRate} />
  </button>
);

const RateBarMini: React.FC<{ rate: number }> = ({ rate }) => {
  const pct = Math.round(rate * 100);
  return (
    <div className="flex items-center gap-1 w-full">
      <div className="h-0.5 flex-1 rounded-full overflow-hidden bg-muted/60">
        <div className={`h-full ${rateColor(rate)}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[9px] tabular-nums text-muted-foreground tracking-tight w-6 text-right">
        {pct}%
      </span>
    </div>
  );
};

// ==================== Recent Run Row (table) ====================

interface RecentRowProps {
  row: RunRow;
  onClick: () => void;
}

export const RecentRow: React.FC<RecentRowProps> = ({ row, onClick }) => {
  const verdict = row.failed === 0 && row.passed > 0
    ? 'Passed'
    : row.failed > 0
      ? `${row.failed} failed`
      : 'Pending';

  return (
    <button
      onClick={onClick}
      data-testid="recent-run-row"
      data-run-id={row.run.id}
      className="group mx-3 mb-2 grid w-[calc(100%-1.5rem)] min-w-0 grid-cols-[14px_minmax(0,1fr)_14px] items-start gap-x-2 gap-y-2 rounded-md border bg-muted/10 p-2.5 text-left text-[11px] transition-colors hover:bg-muted/50 sm:mx-0 sm:mb-0 sm:h-6 sm:w-full sm:min-w-[720px] sm:grid-cols-[14px_minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_130px_80px_14px] sm:items-center sm:gap-3 sm:rounded-none sm:border-0 sm:border-b sm:bg-transparent sm:px-3 sm:py-0 sm:last:border-b-0"
    >
      <span className="mt-0.5 sm:mt-0"><StatusIcon row={row} /></span>
      <div className="min-w-0 sm:flex sm:items-center sm:overflow-hidden sm:whitespace-nowrap">
        <TruncText testId="recent-run-name" text={row.run.name} className="block break-words text-xs font-medium leading-tight sm:min-w-0 sm:truncate sm:text-[11px]" />
        <span className="hidden shrink-0 text-muted-foreground sm:inline"> · </span>
        <TruncText testId="recent-run-benchmark" text={row.benchmarkName} className="mt-0.5 block break-words text-[10px] leading-tight text-muted-foreground sm:mt-0 sm:min-w-0 sm:truncate" />
      </div>

      <div className="col-start-2 row-start-2 grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-3 sm:contents">
        <div className="min-w-0 sm:col-start-3 sm:row-start-1">
          <span className="text-[9px] text-muted-foreground sm:hidden">Agent</span>
          <TruncText testId="recent-run-agent" text={row.agentName} className="break-words sm:truncate" />
        </div>
        <div className="min-w-0 sm:col-start-4 sm:row-start-1">
          <span className="text-[9px] text-muted-foreground sm:hidden">Model</span>
          <TruncText testId="recent-run-model" text={getModelName(row.run.modelId)} className="break-words text-muted-foreground sm:truncate" />
        </div>
      </div>

      <div className="col-start-2 row-start-3 flex min-w-0 items-center gap-2 sm:contents">
        <Badge
          variant="outline"
          className={`h-5 shrink-0 px-1.5 text-[9px] sm:hidden ${row.failed > 0 ? 'border-red-500/40 text-red-600 dark:text-red-400' : row.passed > 0 ? 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}`}
        >
          {verdict}
        </Badge>
        <div data-testid="recent-run-pass-rate" className="min-w-0 flex-1 sm:col-start-5 sm:row-start-1">
          <RateBar rate={row.passRate} passed={row.passed} failed={row.failed} total={row.total} />
        </div>
        <span data-testid="recent-run-time" className="shrink-0 whitespace-nowrap text-right text-[10px] tabular-nums text-muted-foreground sm:col-start-6 sm:row-start-1">
          {formatRelativeTime(row.run.createdAt)}
        </span>
      </div>

      <ArrowRight className="col-start-3 row-start-1 h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 sm:col-start-7 sm:h-3 sm:w-3 sm:opacity-0 sm:transition-opacity sm:group-hover:translate-x-0 sm:group-hover:opacity-60" />
    </button>
  );
};

// Header row for the recent runs table
const RecentHeader: React.FC = () => (
  <div
    className="hidden h-5 min-w-[720px] items-center gap-3 border-b bg-muted/20 px-3 text-[10px] uppercase tracking-wider text-muted-foreground sm:grid"
    style={{ gridTemplateColumns: '14px minmax(0,1.6fr) minmax(0,1fr) minmax(0,1fr) 130px 80px 14px' }}
  >
    <span />
    <span>Run · Benchmark</span>
    <span>Agent</span>
    <span>Model</span>
    <span>Pass rate</span>
    <span className="text-right">Time</span>
    <span />
  </div>
);

// ==================== Needs Improvement Widget (agent-centric) ====================

export const IMPROVEMENT_ROW_BADGE_CLASS = 'h-4 shrink-0 whitespace-nowrap border-red-500/40 px-1.5 py-0 text-[9px] leading-none text-red-600 dark:text-red-400';

interface NeedsImprovementWidgetProps {
  failingAgents: AgentImprovementRow[];
  regressingAgents: AgentRegressionRow[];
  onAgentClick: (agentKey: string) => void;
  onRowClick: (row: RunRow) => void;
}

const AgentRow: React.FC<{
  row: AgentImprovementRow | AgentRegressionRow;
  onClick: () => void;
  trailing: React.ReactNode;
}> = ({ row, onClick, trailing }) => (
  <button
    onClick={onClick}
    className="group grid min-h-12 w-full grid-cols-[12px_minmax(0,1fr)] items-center gap-x-2 gap-y-1 border-b px-3 py-2 text-left text-[11px] transition-colors last:border-b-0 hover:bg-muted/50 sm:h-8 sm:min-h-0 sm:grid-cols-[12px_minmax(0,1fr)_auto_56px] sm:gap-2 sm:py-0"
  >
    <Activity className="h-3 w-3 shrink-0 text-muted-foreground" />
    <div className="min-w-0">
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex flex-wrap items-baseline gap-x-1 leading-tight sm:block sm:truncate">
            <span className="break-words font-medium">{row.agentName}</span>
            <span className="hidden text-muted-foreground sm:inline"> · </span>
            <span className="shrink-0 text-muted-foreground">
              {row.totalRuns} run{row.totalRuns === 1 ? '' : 's'} · {row.benchmarkCount} bench
            </span>
          </div>
        </TooltipTrigger>
        <TooltipContent>
          <div className="text-[11px]">
            <div className="font-medium">{row.agentName}</div>
            <div className="text-muted-foreground">
              {row.totalRuns} runs across {row.benchmarkCount} benchmark{row.benchmarkCount === 1 ? '' : 's'}
            </div>
            <div className="text-muted-foreground">
              {row.failedTestCases} failing test case{row.failedTestCases === 1 ? '' : 's'} of {row.totalTestCases}
            </div>
          </div>
        </TooltipContent>
      </Tooltip>
    </div>
    <div className="col-start-2 flex min-w-0 items-center gap-2 sm:contents">
      {trailing}
      <RateBarMini rate={row.passRate} />
    </div>
  </button>
);

const NeedsImprovementWidget: React.FC<NeedsImprovementWidgetProps> = ({
  failingAgents, regressingAgents, onAgentClick,
}) => {
  const navigate = useNavigate();
  const initialTab = failingAgents.length > 0 ? 'failing' : 'regressions';
  const empty = failingAgents.length === 0 && regressingAgents.length === 0;

  return (
    <Card className="flex min-w-0 flex-col overflow-hidden" data-testid="needs-improvement-card">
      <CardHeader className="pb-2 px-4 pt-3 space-y-1">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
            Agents Needing Improvement
          </CardTitle>
          <Button
            variant="ghost"
            size="sm"
            className="gap-1 text-[10px] h-6 px-1.5 -mr-1.5"
            onClick={() => navigate('/evaluations/runs')}
          >
            All <ArrowRight className="h-3 w-3" />
          </Button>
        </div>
        <CardDescription className="text-[11px] leading-tight">
          Agents with the most failing test cases or biggest regressions.
        </CardDescription>
      </CardHeader>

      <CardContent className="px-0 pt-0 pb-0 flex-1 min-h-0 flex flex-col">
        {empty ? (
          <div className="flex-1 flex flex-col items-center justify-center px-4 py-6">
            <CheckCircle2 className="h-6 w-6 text-emerald-500 mb-1.5 opacity-70" />
            <p className="text-[11px] text-muted-foreground text-center">
              All agents are passing cleanly. Nothing to fix right now.
            </p>
          </div>
        ) : (
          <Tabs defaultValue={initialTab} className="flex-1 min-h-0 flex flex-col">
            <TabsList className="mx-3 h-7 p-0.5 self-start">
              <TabsTrigger value="failing" className="h-6 px-2 text-[11px] gap-1">
                Failing
                <Badge variant="secondary" className="h-4 px-1 text-[9px] tabular-nums">
                  {failingAgents.length}
                </Badge>
              </TabsTrigger>
              <TabsTrigger value="regressions" className="h-6 px-2 text-[11px] gap-1">
                Regressions
                <Badge variant="secondary" className="h-4 px-1 text-[9px] tabular-nums">
                  {regressingAgents.length}
                </Badge>
              </TabsTrigger>
            </TabsList>

            <TabsContent value="failing" className="mt-2 flex-1 min-h-0">
              {failingAgents.length === 0 ? (
                <p className="px-4 py-4 text-center text-[11px] text-muted-foreground">
                  No agents have failing runs.
                </p>
              ) : (
                <ScrollArea className="h-full border-t">
                  {failingAgents.map(a => (
                    <AgentRow
                      key={`fail-${a.agentKey}`}
                      row={a}
                      onClick={() => onAgentClick(a.agentKey)}
                      trailing={
                        <Badge
                          variant="outline"
                          className={IMPROVEMENT_ROW_BADGE_CLASS}
                          data-testid="improvement-row-badge"
                        >
                          {a.failedTestCases} failing
                        </Badge>
                      }
                    />
                  ))}
                </ScrollArea>
              )}
            </TabsContent>

            <TabsContent value="regressions" className="mt-2 flex-1 min-h-0">
              {regressingAgents.length === 0 ? (
                <p className="px-4 py-4 text-center text-[11px] text-muted-foreground">
                  No agent regressions vs prior runs.
                </p>
              ) : (
                <ScrollArea className="h-full border-t">
                  {regressingAgents.map(a => (
                    <AgentRow
                      key={`reg-${a.agentKey}`}
                      row={a}
                      onClick={() => onAgentClick(a.agentKey)}
                      trailing={
                        <Badge
                          variant="outline"
                          className={`${IMPROVEMENT_ROW_BADGE_CLASS} gap-0.5`}
                          data-testid="improvement-row-badge"
                        >
                          <TrendingDown className="h-2.5 w-2.5" />
                          {Math.round(a.delta * 100)}pp
                        </Badge>
                      }
                    />
                  ))}
                </ScrollArea>
              )}
            </TabsContent>
          </Tabs>
        )}
      </CardContent>
    </Card>
  );
};

// ==================== Main Dashboard ====================

export const Dashboard: React.FC = () => {
  const { dataState, isLoading: isCheckingData } = useDataState();
  const navigate = useNavigate();

  const [isLoading, setIsLoading] = useState(true);
  const [benchmarks, setBenchmarks] = useState<Benchmark[]>([]);
  const [reports, setReports] = useState<EvaluationReport[]>([]);
  const [metricsMap, setMetricsMap] = useState<Map<string, { costUsd: number; durationMs: number; tokens: number }>>(new Map());
  const [testCaseCount, setTestCaseCount] = useState<number | null>(null);

  const isSampleMode = isSampleDataActive();

  const agentDisplayName = useMemo(() => {
    const names = new Map(DEFAULT_CONFIG.agents.map(a => [a.key, a.name]));
    return (key: string) => names.get(key) || key;
  }, []);

  // Test case count — kept for backward-compat with stats-summary-bar tests; not
  // surfaced in pills. Only the total count is needed, so request a single
  // summary record and read `.total` from the paginated response instead of
  // pulling every test case's full content across the wire.
  useEffect(() => {
    let cancelled = false;
    asyncTestCaseStorage.getAll({ summary: true, size: 1 })
      .then(page => { if (!cancelled) setTestCaseCount(page.total); })
      .catch(() => { if (!cancelled) setTestCaseCount(0); });
    return () => { cancelled = true; };
  }, []);

  // Phase 1: Benchmarks + reports
  useEffect(() => {
    if (isCheckingData || !dataState.hasData) return;
    let cancelled = false;
    setIsLoading(true);
    (async () => {
      try {
        const [allBenchmarks, allReports] = await Promise.all([
          asyncBenchmarkStorage.getAll(),
          asyncRunStorage.getAllReports({
            sortBy: 'timestamp',
            order: 'desc',
            limit: 500,
            fields: [
              'id', 'runId', 'experimentId', 'experimentRunId', 'testCaseId',
              'passFailStatus', 'accuracy', 'timestamp', 'agentConfig',
            ],
          }),
        ]);
        if (cancelled) return;
        setBenchmarks(allBenchmarks);
        setReports(allReports);
      } catch (err) {
        console.error('[Dashboard] Failed to load:', err);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isCheckingData, dataState.hasData]);

  // Phase 2: deferred metrics
  useEffect(() => {
    const reportsWithRunId = reports.filter(r => r.runId).slice(0, 100);
    const runIds = reportsWithRunId.map(r => r.runId!);
    if (runIds.length === 0) return;
    const traceIdByRunId: Record<string, string> = {};
    for (const r of reportsWithRunId) {
      if (r.traceId && !traceIdByRunId[r.runId!]) traceIdByRunId[r.runId!] = r.traceId;
    }
    fetchBatchMetrics(runIds, undefined, traceIdByRunId)
      .then(({ metrics }) => {
        const m = new Map<string, { costUsd: number; durationMs: number; tokens: number }>();
        for (const x of metrics) {
          m.set(x.runId, { costUsd: x.costUsd, durationMs: x.durationMs, tokens: x.totalTokens });
        }
        setMetricsMap(m);
      })
      .catch(err => console.warn('[Dashboard] Metrics load failed:', err));
  }, [reports]);

  const allRows = useMemo(() => buildRunRows(benchmarks), [benchmarks]);
  const totalRuns = allRows.length;

  const failingRows = useMemo<RunRow[]>(
    () =>
      allRows
        .filter(r => r.failed > 0)
        .sort((a, b) => {
          if (b.failed !== a.failed) return b.failed - a.failed;
          return new Date(b.run.createdAt).getTime() - new Date(a.run.createdAt).getTime();
        })
        .slice(0, 20),
    [allRows],
  );

  const regressions = useMemo<RegressionRow[]>(() => {
    const groups = new Map<string, RunRow[]>();
    for (const r of allRows) {
      const key = `${r.benchmarkId}::${r.run.agentKey}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(r);
    }
    const out: RegressionRow[] = [];
    for (const rows of groups.values()) {
      if (rows.length < 2) continue;
      const sorted = [...rows].sort(
        (a, b) => new Date(b.run.createdAt).getTime() - new Date(a.run.createdAt).getTime(),
      );
      const latest = sorted[0];
      const prev = sorted[1];
      if (latest.passRate < prev.passRate) {
        out.push({ ...latest, prevPassRate: prev.passRate, delta: latest.passRate - prev.passRate });
      }
    }
    return out.sort((a, b) => a.delta - b.delta).slice(0, 20);
  }, [allRows]);

  const failingAgents = useMemo<AgentImprovementRow[]>(() => {
    type Agg = {
      agentKey: string;
      agentName: string;
      runs: RunRow[];
      benchmarks: Set<string>;
      passed: number;
      failed: number;
      total: number;
    };
    const groups = new Map<string, Agg>();
    for (const r of allRows) {
      const key = r.run.agentKey || 'unknown';
      let g = groups.get(key);
      if (!g) {
        g = { agentKey: key, agentName: r.agentName, runs: [], benchmarks: new Set(), passed: 0, failed: 0, total: 0 };
        groups.set(key, g);
      }
      g.runs.push(r);
      g.benchmarks.add(r.benchmarkId);
      g.passed += r.passed;
      g.failed += r.failed;
      g.total += r.total;
    }
    const out: AgentImprovementRow[] = [];
    for (const g of groups.values()) {
      if (g.failed === 0) continue;
      const sortedRuns = [...g.runs].sort(
        (a, b) => new Date(b.run.createdAt).getTime() - new Date(a.run.createdAt).getTime(),
      );
      const latest = sortedRuns[0];
      const failingRow = sortedRuns.find(r => r.failed > 0) || latest;
      out.push({
        agentKey: g.agentKey,
        agentName: g.agentName,
        totalRuns: g.runs.length,
        failingRuns: g.runs.filter(r => r.failed > 0).length,
        failedTestCases: g.failed,
        totalTestCases: g.total,
        passRate: g.total > 0 ? g.passed / g.total : 0,
        latestPassRate: latest.passRate,
        latestRunAt: latest.run.createdAt,
        benchmarkCount: g.benchmarks.size,
        bestRow: failingRow,
      });
    }
    // Worst pass rate first; ties broken by absolute failure count.
    return out
      .sort((a, b) => a.passRate - b.passRate || b.failedTestCases - a.failedTestCases)
      .slice(0, 20);
  }, [allRows]);

  const regressingAgents = useMemo<AgentRegressionRow[]>(() => {
    // Per agent, compare aggregate pass rate of latest run vs aggregate pass rate of all earlier runs.
    const groups = new Map<string, RunRow[]>();
    for (const r of allRows) {
      const key = r.run.agentKey || 'unknown';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(r);
    }
    const out: AgentRegressionRow[] = [];
    for (const [agentKey, runs] of groups.entries()) {
      if (runs.length < 2) continue;
      const sorted = [...runs].sort(
        (a, b) => new Date(b.run.createdAt).getTime() - new Date(a.run.createdAt).getTime(),
      );
      const latest = sorted[0];
      const earlier = sorted.slice(1);
      const earlierTotal = earlier.reduce((s, r) => s + r.total, 0);
      const earlierPassed = earlier.reduce((s, r) => s + r.passed, 0);
      if (earlierTotal === 0) continue;
      const earlierRate = earlierPassed / earlierTotal;
      if (latest.passRate >= earlierRate) continue;
      const totalPassed = sorted.reduce((s, r) => s + r.passed, 0);
      const totalAll = sorted.reduce((s, r) => s + r.total, 0);
      const totalFailed = sorted.reduce((s, r) => s + r.failed, 0);
      out.push({
        agentKey,
        agentName: latest.agentName,
        totalRuns: runs.length,
        failingRuns: runs.filter(r => r.failed > 0).length,
        failedTestCases: totalFailed,
        totalTestCases: totalAll,
        passRate: totalAll > 0 ? totalPassed / totalAll : 0,
        latestPassRate: latest.passRate,
        latestRunAt: latest.run.createdAt,
        benchmarkCount: new Set(runs.map(r => r.benchmarkId)).size,
        bestRow: latest,
        prevAggregatePassRate: earlierRate,
        delta: latest.passRate - earlierRate,
      });
    }
    return out.sort((a, b) => a.delta - b.delta).slice(0, 20);
  }, [allRows]);

  const recentRows = useMemo<RunRow[]>(
    () =>
      [...allRows]
        .sort((a, b) => new Date(b.run.createdAt).getTime() - new Date(a.run.createdAt).getTime())
        .slice(0, 15),
    [allRows],
  );

  const goToAgent = (agentKey: string) =>
    navigate(`/evaluations/runs?agent=${encodeURIComponent(agentKey)}`);

  const goToRun = (row: RunRow) =>
    navigate(`/evaluations/benchmarks/${row.benchmarkId}/runs/${row.run.id}/inspect`);

  const hasData = benchmarks.length > 0 && benchmarks.some(b => b.runs && b.runs.length > 0);

  if (isCheckingData) {
    return (
      <div className="p-5 max-w-7xl mx-auto space-y-4" data-testid="dashboard-page">
        <div>
          <h2 className="text-xl font-bold" data-testid="dashboard-title">Leaderboard Overview</h2>
          <p className="text-[12px] text-muted-foreground">
            See where each agent is failing or regressing, and improve them fast
          </p>
        </div>
        <DashboardSkeleton />
      </div>
    );
  }

  if (dataState.overviewState === 'onboarding') {
    return <FirstRunExperience showCodingAgentsBanner={false} />;
  }

  if (dataState.overviewState === 'ready-to-run') {
    return <ReadyToRun />;
  }

  return (
    <TooltipProvider delayDuration={200}>
      <div className="p-4 sm:p-5 max-w-7xl mx-auto space-y-4" data-testid="dashboard-page">
        {isSampleMode && (
          <Alert className="bg-blue-50 dark:bg-blue-950 border-blue-200 dark:border-blue-800 py-2">
            <Info className="h-4 w-4 text-blue-600 dark:text-blue-400" />
            <AlertTitle className="text-blue-900 dark:text-blue-100 text-[13px]">
              You're viewing sample data
            </AlertTitle>
            <AlertDescription className="text-blue-800 dark:text-blue-200 text-[12px]">
              This is demonstration data to help you explore Agent Health.{' '}
              <Link
                to="/settings/clusters"
                className="underline font-medium hover:text-blue-600 dark:hover:text-blue-300"
              >
                Connect your own data
              </Link>{' '}
              to start tracking your agents.
            </AlertDescription>
          </Alert>
        )}

        {/* Header row */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-xl font-bold leading-tight" data-testid="dashboard-title">
              Leaderboard Overview
            </h2>
            <p className="text-[12px] text-muted-foreground leading-tight mt-0.5">
              See where each agent is failing or regressing, and improve them fast
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5" data-testid="stats-summary-bar">
            <StatPill
              to="/evaluations/benchmarks"
              icon={BarChart3}
              label="Benchmarks"
              value={benchmarks.length}
              testId="stats-benchmarks"
            />
            <StatPill
              to="/evaluations/runs"
              icon={Play}
              label="Evaluation Runs"
              value={totalRuns.toLocaleString()}
              testId="stats-runs"
            />
          </div>
        </div>

        {isLoading ? (
          <DashboardSkeleton />
        ) : !hasData ? (
          <Card>
            <CardContent className="py-8 text-center space-y-2">
              <p className="text-[12px] text-muted-foreground">
                You have benchmarks but no runs yet. Kick off a run to start tracking agent health.
              </p>
              <Button asChild size="sm">
                <Link to="/evaluations/benchmarks">Go to Benchmarks</Link>
              </Button>
            </CardContent>
          </Card>
        ) : (
          <>
            {/* Agent Trends (chart) + Agents Needing Improvement (table) — side by
                side on desktop, stacked on mobile (owner feedback: these rendered
                as two full-width stacked rows; same lg: breakpoint + 2/1 column
                split already used by DashboardSkeleton above, so mobile stacking
                behavior from #400 is unaffected — grid-cols-1 below lg). Grid
                items default to align-items: stretch, so NeedsImprovementWidget
                (which is already `flex flex-col` + an internal `ScrollArea h-full`)
                naturally matches AgentTrendsBand's height without a hard-coded
                row height to keep in sync with the new, taller trends card. */}
            <div className="grid min-w-0 gap-4 lg:grid-cols-3 lg:items-stretch" data-testid="agent-trends-and-needs-improvement-row">
              <div className="min-w-0 lg:col-span-2">
                <AgentTrendsBand
                  benchmarks={benchmarks}
                  reports={reports}
                  metricsMap={metricsMap}
                  getAgentDisplayName={agentDisplayName}
                />
              </div>
              <NeedsImprovementWidget
                failingAgents={failingAgents}
                regressingAgents={regressingAgents}
                onAgentClick={goToAgent}
                onRowClick={goToRun}
              />
            </div>

            {/* Recent Evaluation Runs — full width */}
            <Card className="min-w-0 overflow-hidden" data-testid="recent-runs-card">
              <CardHeader className="pb-2 px-4 pt-3 space-y-1">
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-sm flex items-center gap-1.5">
                      <Play className="h-3.5 w-3.5 text-muted-foreground" />
                      Recent Evaluation Runs
                    </CardTitle>
                    <CardDescription className="text-[11px] leading-tight">
                      Latest {recentRows.length} run{recentRows.length === 1 ? '' : 's'}. Click a row to inspect.
                    </CardDescription>
                  </div>
                  <Button asChild variant="ghost" size="sm" className="gap-1 text-[11px] h-7 -mr-1.5">
                    <Link to="/evaluations/runs">View all <ArrowRight className="h-3 w-3" /></Link>
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="overflow-hidden px-0 pb-0 pt-0 sm:overflow-x-auto sm:overscroll-x-contain" tabIndex={0} aria-label="Recent evaluation runs; table columns scroll horizontally on larger screens">
                <RecentHeader />
                {recentRows.map(r => (
                  <RecentRow
                    key={`recent-${r.benchmarkId}-${r.run.id}`}
                    row={r}
                    onClick={() => goToRun(r)}
                  />
                ))}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </TooltipProvider>
  );
};
