/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Beaker, FlaskConical, CheckCircle2, AlertTriangle, ChevronRight, Rocket, Clock, TrendingUp, TrendingDown, Minus, CircleDot, DollarSign, Activity } from 'lucide-react';
import { asyncRunStorage, asyncExperimentStorage, asyncTestCaseStorage } from '@/services/storage';
import { EvaluationReport, Experiment } from '@/types';
import { fetchBatchMetrics, formatCost, formatTokens } from '@/services/metrics';
import { MetricsTrendChart, TrendDataPoint } from './charts/MetricsTrendChart';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { formatRelativeTime } from '@/lib/utils';

// ==================== Sub-Components ====================

const QuickActions = () => (
  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
    <Card className="group hover:border-primary/50 transition-colors">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-primary/10 text-primary">
            <Beaker className="h-5 w-5" />
          </div>
          <div>
            <CardTitle className="text-base">Test Cases</CardTitle>
            <CardDescription>Create and organize tests</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0 flex gap-2">
        <Button asChild className="flex-1">
          <Link to="/test-cases?action=create">Create New</Link>
        </Button>
        <Button asChild variant="outline" className="flex-1">
          <Link to="/test-cases">View All</Link>
        </Button>
      </CardContent>
    </Card>

    <Card className="group hover:border-primary/50 transition-colors">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-primary/10 text-primary">
            <FlaskConical className="h-5 w-5" />
          </div>
          <div>
            <CardTitle className="text-base">Experiments</CardTitle>
            <CardDescription>Batch test multiple cases</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0 flex gap-2">
        <Button asChild className="flex-1">
          <Link to="/experiments?action=create">Create New</Link>
        </Button>
        <Button asChild variant="outline" className="flex-1">
          <Link to="/experiments">View All</Link>
        </Button>
      </CardContent>
    </Card>
  </div>
);

const EmptyState = () => (
  <Alert>
    <Rocket />
    <AlertTitle>Welcome to Agent Evaluation</AlertTitle>
    <AlertDescription>
      <p className="mb-4">
        Test your AI agents with defined scenarios and get LLM-powered evaluation.
      </p>
      <div className="space-y-3 mb-4">
        <div className="flex items-center gap-3">
          <Badge variant="outline" className="rounded-full h-6 w-6 p-0 justify-center shrink-0">1</Badge>
          <span className="text-sm">Create a test case to define what you want to test</span>
        </div>
        <div className="flex items-center gap-3">
          <Badge variant="outline" className="rounded-full h-6 w-6 p-0 justify-center shrink-0">2</Badge>
          <span className="text-sm">Run an evaluation to see how your agent performs</span>
        </div>
        <div className="flex items-center gap-3">
          <Badge variant="outline" className="rounded-full h-6 w-6 p-0 justify-center shrink-0">3</Badge>
          <span className="text-sm">Create experiments to batch test and compare over time</span>
        </div>
      </div>
      <div className="flex gap-2">
        <Button asChild size="sm">
          <Link to="/test-cases">Create Test Case</Link>
        </Button>
        <Button asChild variant="outline" size="sm">
          <Link to="/experiments">Create Experiment</Link>
        </Button>
      </div>
    </AlertDescription>
  </Alert>
);

interface ExperimentWithStats extends Experiment {
  passRate: number;
  passed: number;
  total: number;
  lastRunTime?: string;
  // Phase 2: Regression tracking
  previousPassRate?: number;
  delta?: number; // positive = improvement, negative = regression
  regressionCount?: number;
  improvementCount?: number;
}

interface ExperimentCardProps {
  experiment: ExperimentWithStats;
}

// Status determination logic
type ExperimentStatus = 'passing' | 'degraded' | 'failing' | 'no-data';

const getExperimentStatus = (experiment: ExperimentWithStats): ExperimentStatus => {
  if (!experiment.lastRunTime) return 'no-data';
  if (experiment.passRate === 100) return 'passing';
  if (experiment.passRate >= 50) return 'degraded';
  return 'failing';
};

const statusConfig: Record<ExperimentStatus, { label: string; icon: React.ReactNode; className: string }> = {
  'passing': {
    label: 'Passing',
    icon: <CheckCircle2 size={12} />,
    className: 'bg-blue-900/30 text-opensearch-blue border-blue-800/50',
  },
  'degraded': {
    label: 'Degraded',
    icon: <AlertTriangle size={12} />,
    className: 'bg-yellow-900/30 text-yellow-400 border-yellow-800/50',
  },
  'failing': {
    label: 'Failing',
    icon: <AlertTriangle size={12} />,
    className: 'bg-red-900/30 text-red-400 border-red-800/50',
  },
  'no-data': {
    label: 'No Data',
    icon: <CircleDot size={12} />,
    className: 'bg-muted text-muted-foreground border-border',
  },
};

// Trend component
const TrendIndicator = ({ delta, regressionCount }: { delta?: number; regressionCount?: number }) => {
  if (delta === undefined || delta === 0) {
    return (
      <span className="text-xs text-muted-foreground flex items-center gap-1">
        <Minus size={12} />
        Stable
      </span>
    );
  }

  const isRegression = delta < 0;

  return (
    <span className={`text-xs flex items-center gap-1 ${isRegression ? 'text-red-400' : 'text-opensearch-blue'}`}>
      {isRegression ? <TrendingDown size={12} /> : <TrendingUp size={12} />}
      {isRegression ? 'Regression' : 'Improved'}
      {isRegression && regressionCount != null && regressionCount > 0 && (
        <span className="text-muted-foreground">({regressionCount} test{regressionCount > 1 ? 's' : ''})</span>
      )}
    </span>
  );
};

const ExperimentCard = ({ experiment }: ExperimentCardProps) => {
  const status = getExperimentStatus(experiment);
  const config = statusConfig[status];
  const hasRuns = !!experiment.lastRunTime;

  return (
    <Link to={`/experiments/${experiment.id}/runs`} className="block mb-4">
      <Card className="hover:border-primary/50 transition-colors cursor-pointer">
        <CardHeader className="py-3 pb-0">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-sm truncate">{experiment.name}</CardTitle>
            <Badge className={`shrink-0 text-xs ${config.className}`}>
              {config.icon}
              <span className="ml-1">{config.label}</span>
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="pt-2 pb-3 space-y-2">
          {hasRuns ? (
            <>
              {/* Row 2: Time + Tests passing + Trend */}
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-3">
                  <span className="text-muted-foreground flex items-center gap-1">
                    <Clock size={10} />
                    {formatRelativeTime(experiment.lastRunTime!)}
                  </span>
                  <span className="font-medium">
                    {experiment.passed}/{experiment.total} passing
                  </span>
                </div>
                <TrendIndicator delta={experiment.delta} regressionCount={experiment.regressionCount} />
              </div>
              {/* Row 3: Progress bar */}
              <Progress value={experiment.passRate} className="h-1.5" />
            </>
          ) : (
            <div className="text-xs text-muted-foreground flex items-center gap-1">
              <Clock size={10} />
              Never run · {experiment.testCaseIds.length} test case{experiment.testCaseIds.length !== 1 ? 's' : ''} configured
            </div>
          )}
        </CardContent>
      </Card>
    </Link>
  );
};

// ==================== Skeleton Components ====================

const QuickActionsSkeleton = () => (
  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
    {[1, 2].map((i) => (
      <Card key={i}>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-3">
            <Skeleton className="h-9 w-9 rounded-lg" />
            <div className="space-y-2">
              <Skeleton className="h-4 w-[120px]" />
              <Skeleton className="h-3 w-[160px]" />
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          <Skeleton className="h-9 w-full" />
        </CardContent>
      </Card>
    ))}
  </div>
);

const ExperimentCardSkeleton = () => (
  <Card>
    <CardHeader className="pb-2">
      <div className="flex items-center justify-between">
        <Skeleton className="h-5 w-[180px]" />
        <Skeleton className="h-5 w-[80px]" />
      </div>
      <Skeleton className="h-3 w-[120px]" />
    </CardHeader>
    <CardContent>
      <Skeleton className="h-2 w-full" />
      <div className="flex justify-between mt-2">
        <Skeleton className="h-3 w-[80px]" />
        <Skeleton className="h-3 w-[60px]" />
      </div>
    </CardContent>
  </Card>
);

const OverviewSkeleton = () => (
  <div className="space-y-6">
    <QuickActionsSkeleton />
    <Separator />
    <div>
      <Skeleton className="h-6 w-[140px] mb-3" />
      <div className="space-y-3">
        <ExperimentCardSkeleton />
        <ExperimentCardSkeleton />
      </div>
    </div>
  </div>
);

// ==================== Quick Stats Component ====================

interface StatItemProps {
  icon: React.ElementType;
  label: string;
  value: string | number;
  subtext?: string;
}

const StatItem = ({ icon: Icon, label, value, subtext }: StatItemProps) => (
  <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
    <div className="p-2 rounded-md bg-primary/10 text-primary">
      <Icon size={16} />
    </div>
    <div>
      <p className="text-lg font-semibold">{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
      {subtext && <p className="text-xs text-muted-foreground">{subtext}</p>}
    </div>
  </div>
);

interface QuickStatsProps {
  experiments: ExperimentWithStats[];
  recentReports: EvaluationReport[];
  testCaseCount: number;
  aggregateMetrics?: {
    totalCostUsd: number;
    avgTokens: number;
  } | null;
}

const QuickStats = ({ experiments, recentReports, testCaseCount, aggregateMetrics }: QuickStatsProps) => {
  const runsToday = recentReports.filter(
    (r) => new Date(r.timestamp).toDateString() === new Date().toDateString()
  ).length;

  const experimentsWithRuns = experiments.filter((e) => e.lastRunTime);
  const avgPassRate =
    experimentsWithRuns.length > 0
      ? Math.round(
          experimentsWithRuns.reduce((sum, e) => sum + e.passRate, 0) / experimentsWithRuns.length
        )
      : 0;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Quick Stats</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-3">
        <StatItem icon={FlaskConical} label="Experiments" value={experiments.length} />
        <StatItem icon={Beaker} label="Test Cases" value={testCaseCount} />
        <StatItem
          icon={CheckCircle2}
          label="Avg Pass Rate"
          value={experimentsWithRuns.length > 0 ? `${avgPassRate}%` : '—'}
        />
        <StatItem icon={Clock} label="Runs Today" value={runsToday} />
        {aggregateMetrics && (
          <>
            <StatItem
              icon={DollarSign}
              label="Total Cost"
              value={formatCost(aggregateMetrics.totalCostUsd)}
            />
            <StatItem
              icon={Activity}
              label="Avg Tokens"
              value={formatTokens(aggregateMetrics.avgTokens)}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
};

// ==================== Main Overview Component ====================

export const Dashboard: React.FC = () => {
  const [isLoading, setIsLoading] = useState(true);
  const [experiments, setExperiments] = useState<ExperimentWithStats[]>([]);
  const [recentReports, setRecentReports] = useState<EvaluationReport[]>([]);
  const [testCaseCount, setTestCaseCount] = useState(0);
  const [aggregateMetrics, setAggregateMetrics] = useState<{
    totalCostUsd: number;
    avgTokens: number;
  } | null>(null);
  const [trendData, setTrendData] = useState<TrendDataPoint[]>([]);
  const [trendMetric, setTrendMetric] = useState<'tokens' | 'cost' | 'duration'>('cost');

  useEffect(() => {
    const loadOverviewData = async () => {
      setIsLoading(true);
      try {
        // Load experiments
        const allExperiments = await asyncExperimentStorage.getAll();

        // Load all reports to calculate stats
        const allReports = await asyncRunStorage.getAllReports({ sortBy: 'timestamp', order: 'desc' });
        setRecentReports(allReports.slice(0, 10));

        // Get test case count for quick stats
        const allTestCases = await asyncTestCaseStorage.getAll();
        setTestCaseCount(allTestCases.length);

        // Calculate stats for each experiment with regression detection
        const experimentsWithStats: ExperimentWithStats[] = allExperiments.map((exp) => {
          const runs = exp.runs || [];
          const latestRun = runs[runs.length - 1];
          const previousRun = runs.length > 1 ? runs[runs.length - 2] : undefined;

          let passed = 0;
          let total = 0;
          let lastRunTime: string | undefined;
          let previousPassRate: number | undefined;
          let delta: number | undefined;
          let regressionCount = 0;
          let improvementCount = 0;

          // Calculate latest run stats
          if (latestRun) {
            const latestRunReports = allReports.filter(
              (r) => exp.testCaseIds.includes(r.testCaseId) && r.experimentRunId === latestRun.id
            );

            passed = latestRunReports.filter((r) => r.passFailStatus === 'passed').length;
            total = latestRunReports.length || exp.testCaseIds.length;
            lastRunTime = latestRun.createdAt;

            // Calculate previous run stats for comparison
            if (previousRun) {
              const previousRunReports = allReports.filter(
                (r) => exp.testCaseIds.includes(r.testCaseId) && r.experimentRunId === previousRun.id
              );

              const prevPassed = previousRunReports.filter((r) => r.passFailStatus === 'passed').length;
              const prevTotal = previousRunReports.length || exp.testCaseIds.length;
              previousPassRate = prevTotal > 0 ? (prevPassed / prevTotal) * 100 : 0;

              // Calculate delta
              const currentPassRate = total > 0 ? (passed / total) * 100 : 0;
              delta = currentPassRate - previousPassRate;

              // Count regressions and improvements per test case
              exp.testCaseIds.forEach((testCaseId) => {
                const latestResult = latestRunReports.find((r) => r.testCaseId === testCaseId);
                const prevResult = previousRunReports.find((r) => r.testCaseId === testCaseId);

                if (latestResult && prevResult) {
                  if (prevResult.passFailStatus === 'passed' && latestResult.passFailStatus === 'failed') {
                    regressionCount++;
                  } else if (prevResult.passFailStatus === 'failed' && latestResult.passFailStatus === 'passed') {
                    improvementCount++;
                  }
                }
              });
            }
          } else {
            // No runs yet, show potential total
            total = exp.testCaseIds.length;
          }

          return {
            ...exp,
            passRate: total > 0 ? (passed / total) * 100 : 0,
            passed,
            total,
            lastRunTime,
            previousPassRate,
            delta,
            regressionCount,
            improvementCount,
          };
        });

        // Sort by most recent activity
        experimentsWithStats.sort((a, b) => {
          if (!a.lastRunTime && !b.lastRunTime) return 0;
          if (!a.lastRunTime) return 1;
          if (!b.lastRunTime) return -1;
          return new Date(b.lastRunTime).getTime() - new Date(a.lastRunTime).getTime();
        });

        setExperiments(experimentsWithStats);

        // Fetch aggregate metrics for all reports with runIds
        const runIds = allReports.filter(r => r.runId).map(r => r.runId!);
        if (runIds.length > 0) {
          try {
            const { aggregate } = await fetchBatchMetrics(runIds);
            setAggregateMetrics({
              totalCostUsd: aggregate.totalCostUsd,
              avgTokens: aggregate.avgTokens,
            });
          } catch (error) {
            console.warn('[Overview] Failed to fetch aggregate metrics:', error);
          }
        }

        // Build trend data from last 5 experiments with runs
        const expWithRuns = experimentsWithStats.filter(e => e.lastRunTime).slice(0, 5);
        const trendDataPoints: TrendDataPoint[] = [];

        for (const exp of expWithRuns) {
          // Get reports for this experiment's latest run
          const latestRun = exp.runs?.[exp.runs.length - 1];
          if (!latestRun) continue;

          const expReports = allReports.filter(r => r.experimentRunId === latestRun.id);
          const expRunIds = expReports.filter(r => r.runId).map(r => r.runId!);

          if (expRunIds.length > 0) {
            try {
              const { aggregate } = await fetchBatchMetrics(expRunIds);
              trendDataPoints.push({
                name: exp.name.substring(0, 15) + (exp.name.length > 15 ? '...' : ''),
                tokens: aggregate.avgTokens,
                cost: aggregate.totalCostUsd,
                duration: aggregate.avgDurationMs,
              });
            } catch (error) {
              // Skip experiments with fetch errors
            }
          }
        }

        // Reverse to show oldest first (left to right)
        setTrendData(trendDataPoints.reverse());
      } catch (error) {
        console.error('Failed to load overview data:', error);
      } finally {
        setIsLoading(false);
      }
    };

    loadOverviewData();
  }, []);

  const hasNoData = experiments.length === 0 && recentReports.length === 0;

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Agent Evaluation Overview</h2>
        <p className="text-muted-foreground">Monitor agent performance and run evaluations</p>
      </div>

      {isLoading ? (
        <OverviewSkeleton />
      ) : (
        <>
          <QuickActions />

          <Separator />

          {hasNoData ? (
            <EmptyState />
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Experiments Section */}
              <div className="lg:col-span-2 space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-lg font-semibold">Your Experiments</h3>
                  <Button variant="link" asChild className="text-xs p-0 h-auto">
                    <Link to="/experiments">
                      View All
                      <ChevronRight size={12} className="ml-0.5" />
                    </Link>
                  </Button>
                </div>

                {experiments.length > 0 ? (
                  <div>
                    {experiments.slice(0, 5).map((exp) => (
                      <ExperimentCard key={exp.id} experiment={exp} />
                    ))}
                  </div>
                ) : (
                  <Card className="p-6 text-center">
                    <FlaskConical className="h-10 w-10 mx-auto mb-3 text-muted-foreground/50" />
                    <p className="text-sm text-muted-foreground mb-3">No experiments yet</p>
                    <Button asChild size="sm" variant="outline">
                      <Link to="/experiments">Create Your First Experiment</Link>
                    </Button>
                  </Card>
                )}
              </div>

              {/* Quick Stats Section */}
              <div className="space-y-4">
                <QuickStats
                  experiments={experiments}
                  recentReports={recentReports}
                  testCaseCount={testCaseCount}
                  aggregateMetrics={aggregateMetrics}
                />

                {/* Metrics Trend Chart */}
                {trendData.length > 0 && (
                  <Card>
                    <CardHeader className="pb-3">
                      <div className="flex items-center justify-between">
                        <CardTitle className="text-base">Metrics Trend</CardTitle>
                        <Select value={trendMetric} onValueChange={(v) => setTrendMetric(v as typeof trendMetric)}>
                          <SelectTrigger className="w-24 h-7 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="cost">Cost</SelectItem>
                            <SelectItem value="tokens">Tokens</SelectItem>
                            <SelectItem value="duration">Duration</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <CardDescription className="text-xs">Last {trendData.length} experiments</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <MetricsTrendChart data={trendData} metric={trendMetric} height={150} />
                    </CardContent>
                  </Card>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};
