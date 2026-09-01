/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  X,
  FileText,
  GitBranch,
  Terminal,
  Scale,
  MessageSquare,
  CheckCircle2,
  XCircle,
  Clock,
  Lightbulb,
  AlertTriangle,
  AlertCircle,
  Info,
  ExternalLink,
  Loader2,
  Activity,
  Coins,
  Cpu,
  Wrench,
  Pencil,
  Target,
  Hash,
  Maximize2,
  FlaskConical,
  Shield,
  Brain,
  ListChecks,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { EvaluationReport, RunAnnotation, TestCase, TestCasePerformanceMetrics, Span, TimeRange, TraceMetrics, Evaluator } from '@/types';
import { fetchRunMetrics, formatCost, formatDuration, formatTokens } from '@/services/metrics';
import { TrajectoryView } from './TrajectoryView';
import { RawEventsPanel } from './RawEventsPanel';
import { MatcherResultsPanel } from './MatcherResultsPanel';
import { getJudgeReasoningText, getJudgeMatcherResults } from '@/lib/matchers/judgeAccessor';
import TraceVisualization from './traces/TraceVisualization';
import SimpleSpanAttributesTable from './traces/SimpleSpanAttributesTable';
import ViewToggle, { ViewMode } from './traces/ViewToggle';
import TraceFullScreenView from './traces/TraceFullScreenView';
import { computeTrajectoryFromRawEvents } from '@/connectors/agui/aguiConverter';
import { fetchTracesByRunIds, fetchTracesForRun, processSpansIntoTree, calculateTimeRange } from '@/services/traces';
import { DEFAULT_CONFIG } from '@/lib/constants';
import { ENV_CONFIG } from '@/lib/config';
import { formatDate, getLabelColor, getDifficultyColor } from '@/lib/utils';
import { RunScore } from '@/components/RunScore';
import { asyncRunStorage, asyncTestCaseStorage } from '@/services/storage';
import { tracePollingManager } from '@/services/traces/tracePoller';
import { ensureTracePollingForReport } from '@/services/traces/browserRecovery';
import { getResultStatus as getSharedResultStatus, StatusIcon as SharedStatusIcon, StatusLabel as SharedStatusLabel } from '@/components/evals3/ResultStatus';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import { CollapsibleTestCaseDefinition } from '@/components/evals3/CollapsibleTestCaseDefinition';

interface RunDetailsContentProps {
  report: EvaluationReport;
  className?: string;
  showViewAllReports?: boolean;
  onViewAllReports?: () => void;
  onEditTestCase?: (testCase: TestCase) => void;
  performanceMetrics?: TestCasePerformanceMetrics;
  hideMetrics?: boolean;
}

const EVALUATOR_ICONS: Record<string, React.ComponentType<any>> = {
  'system-rca-default': FlaskConical,
  'system-factuality': Target,
  'system-tool-usage': ListChecks,
  'system-reasoning-depth': Brain,
  'system-safety': Shield,
};

const getEvaluatorIcon = (evaluatorId: string) => {
  const Icon = EVALUATOR_ICONS[evaluatorId];
  return Icon ? Icon : FlaskConical;
};

/**
 * Color class for the OpenSearch-logs level badge (standard, non-trace mode).
 * Extracted to a pure function so it's directly unit-testable: the JSX branch
 * that renders it (isTraceMode === false) is currently unreachable in the app
 * (isTraceMode is hardcoded true below), so a render test can't exercise it.
 */
export const getLogLevelColor = (level: string | undefined): string => {
  if (level === 'ERROR') return 'text-red-600 dark:text-red-400';
  if (level === 'WARN') return 'text-amber-600 dark:text-amber-400';
  return 'text-muted-foreground';
};

export const RunDetailsContent: React.FC<RunDetailsContentProps> = ({
  report,
  className = '',
  showViewAllReports = false,
  onViewAllReports,
  onEditTestCase,
  performanceMetrics: performanceMetricsProp,
  hideMetrics = false,
}) => {
  const [annotations, setAnnotations] = useState<RunAnnotation[]>([]);
  const [newAnnotation, setNewAnnotation] = useState('');
  const [testCase, setTestCase] = useState<TestCase | null>(null);
  const [evaluator, setEvaluator] = useState<Evaluator | null>(null);
  const [trajectoryViewMode, setTrajectoryViewMode] = useState<'processed' | 'raw'>('processed');
  const [traceMetrics, setTraceMetrics] = useState<TraceMetrics | null>(null);
  const [traceMetricsLoading, setTraceMetricsLoading] = useState(false);

  // Trace visualization state (for trace-mode agents)
  const [traceSpans, setTraceSpans] = useState<Span[]>([]);
  const [spanTree, setSpanTree] = useState<Span[]>([]);
  const [timeRange, setTimeRange] = useState<TimeRange>({ startTime: 0, endTime: 0, duration: 0 });
  const [selectedSpan, setSelectedSpan] = useState<Span | null>(null);
  const [expandedSpans, setExpandedSpans] = useState<Set<string>>(new Set());
  const [tracesLoading, setTracesLoading] = useState(false);
  const [tracesError, setTracesError] = useState<string | null>(null);
  const [tracesFetched, setTracesFetched] = useState(false);
  // Strategy C (always-on): include all spans from the agent's service during
  // the run's wall-clock window. Was opt-in via a checkbox originally, but in
  // practice the run-report Traces tab landed effectively empty (just the
  // eval `test_case` span) until the user noticed and clicked the toggle
  // — the noise risk that motivated opt-in (concurrent runs, cross-team
  // traffic on a shared OTel cluster) is a smaller cost than the user-visible
  // "empty" state we always ship by default. See AGENTS.md → Trace correlation.
  const [searchParams] = useSearchParams();
  // Default to the Trajectory tab — the prior "summary" / Overview tab has
  // been removed because everything it surfaced (agent, model, evaluator,
  // timestamp, duration) is already visible in the compact run-card header
  // above the tab strip on TestCaseInspectorPanel and on the legacy
  // /runs/:runId page header. Keeping a near-empty Overview was extra
  // navigation friction with no payoff.
  const initialTab = searchParams.get('tab') || 'trajectory';
  const [activeTab, setActiveTab] = useState(initialTab);
  // Default the Traces sub-view to the trace tree (was 'info'). This is the
  // view users want first — the per-span info card is one click away on the
  // tree itself, but landing on it bypasses the tree entirely and obscures
  // the structure of the trace.
  const [traceViewMode, setTraceViewMode] = useState<ViewMode>('tree');
  const [traceFullscreenOpen, setTraceFullscreenOpen] = useState(false);

  // Live report state for auto-refresh when judge completes
  // This allows the UI to update without a page refresh when metricsStatus changes
  const [liveReport, setLiveReport] = useState<EvaluationReport>(report);
  const [reportLoading, setReportLoading] = useState(false);

  // Sync liveReport when prop changes (switching between reports)
  // Immediately fetch fresh data from storage to avoid stale metricsStatus
  useEffect(() => {
    // Mark as loading to prevent showing stale "pending" banner
    setReportLoading(true);

    // Fetch the latest from storage to get updated metricsStatus
    asyncRunStorage.getReportById(report.id).then(freshReport => {
      if (freshReport) {
        setLiveReport(freshReport);
      } else {
        // Fall back to prop if not found in storage
        setLiveReport(report);
      }
    }).catch(error => {
      console.warn('[RunDetails] Failed to fetch fresh report:', error);
      setLiveReport(report);
    }).finally(() => {
      setReportLoading(false);
    });
  }, [report.id]);

  // Poll for report status changes when metricsStatus is 'pending'
  useEffect(() => {
    if (liveReport.metricsStatus !== 'pending') return;

    console.info('[RunDetails] Starting status poll for pending report:', liveReport.id);

    const interval = setInterval(async () => {
      try {
        const updated = await asyncRunStorage.getReportById(liveReport.id);
        if (updated && updated.metricsStatus !== 'pending') {
          console.info('[RunDetails] Report status changed to:', updated.metricsStatus);
          setLiveReport(updated);
        }
      } catch (error) {
        console.warn('[RunDetails] Failed to poll report status:', error);
      }
    }, 5000); // Check every 5 seconds

    return () => {
      console.info('[RunDetails] Stopping status poll');
      clearInterval(interval);
    };
  }, [liveReport.id, liveReport.metricsStatus]);

  // Auto-recover trace polling for pending reports when page loads.
  // Handles the case where the browser was closed before polling completed.
  //
  // Issue #320: this used to inline its own judge call that wrote a
  // DIVERGENT field set (no matcherResults) and could race the server-side
  // poller, flipping verdicts on refresh. It now delegates to the shared
  // ensureTracePollingForReport, which writes the canonical judge surface
  // and re-checks the persisted report before judging so it never
  // overwrites a server-produced verdict.
  useEffect(() => {
    // Only for pending trace-mode reports with a runId
    if (liveReport.metricsStatus !== 'pending' || !liveReport.runId || !testCase) return;

    console.info('[RunDetails] Ensuring recovery polling for pending report:', liveReport.id);

    ensureTracePollingForReport(liveReport, testCase, {
      onSpans: (spans) => {
        // Update trace visualization state so UI reflects traces immediately
        setTraceSpans(spans);
        const tree = processSpansIntoTree(spans);
        setSpanTree(tree);
        setTimeRange(calculateTimeRange(spans));
        const rootIds = new Set(tree.map(s => s.spanId));
        setExpandedSpans(rootIds);
        setTracesError(null);
        setTracesFetched(true);
      },
      onUpdated: (fresh) => {
        setLiveReport(fresh);
      },
      onError: (error) => {
        console.error(`[RunDetails] Trace recovery failed for report ${liveReport.id}:`, error);
      },
    });

    // Cleanup: stop polling when component unmounts or report changes
    return () => {
      console.info('[RunDetails] Stopping polling on unmount for report:', liveReport.id);
      tracePollingManager.stopPolling(liveReport.id);
    };
  }, [liveReport.id, liveReport.metricsStatus, liveReport.runId, testCase]);

  // Compute trajectory from rawEvents if available (source of truth)
  // Fall back to stored trajectory for backward compatibility
  // NOTE: Only AG-UI protocol rawEvents can be converted to trajectory;
  // subprocess/claude-code rawEvents are stdout/stderr and should use report.trajectory directly
  const trajectory = useMemo(() => {
    // Determine if this is AG-UI protocol (which has convertible rawEvents)
    const isAguiProtocol = (() => {
      // Explicit connector protocol (new reports)
      if (report.connectorProtocol) {
        return report.connectorProtocol === 'agui-streaming';
      }
      // Infer from rawEvents structure (legacy reports without connectorProtocol)
      if (report.rawEvents && report.rawEvents.length > 0) {
        const firstEvent = report.rawEvents[0];
        // Subprocess/claude-code rawEvents have type: 'stdout' | 'stderr'
        // AG-UI rawEvents have different event types (e.g., 'RUN_STARTED', 'TEXT_MESSAGE_CONTENT', etc.)
        return firstEvent.type !== 'stdout' && firstEvent.type !== 'stderr';
      }
      return false;
    })();

    // Only compute trajectory from rawEvents for AG-UI protocol
    if (isAguiProtocol && report.rawEvents && report.rawEvents.length > 0) {
      const computed = computeTrajectoryFromRawEvents(report.rawEvents);
      // Fall back to stored trajectory if computation returns empty (e.g., malformed events)
      return computed.length > 0 ? computed : report.trajectory;
    }

    // Use stored trajectory directly for subprocess/claude-code/other protocols
    return report.trajectory;
  }, [report.rawEvents, report.trajectory, report.connectorProtocol]);

  const modelDisplayName = DEFAULT_CONFIG.models[report.modelName]?.display_name || report.modelName;

  // Always use trace-based UI layout for consistency
  // The useTraces flag only affects backend judge execution, not UI display
  const isTraceMode = true;

  // Load test case and annotations on mount
  useEffect(() => {
    asyncTestCaseStorage.getById(report.testCaseId).then(tc => setTestCase(tc));
    asyncRunStorage.getAnnotationsByReport(report.id).then(setAnnotations);
  }, [report.id, report.testCaseId]);

  // Load evaluator if evaluatorId is present
  useEffect(() => {
    if (report.evaluatorId) {
      fetch(`${ENV_CONFIG.backendUrl}/api/storage/evaluators/${report.evaluatorId}`)
        .then(res => res.ok ? res.json() : null)
        .then(evaluatorData => setEvaluator(evaluatorData))
        .catch(err => {
          console.warn('Failed to load evaluator:', err);
          setEvaluator(null);
        });
    } else {
      setEvaluator(null);
    }
  }, [report.evaluatorId]);

  // Fetch trace metrics when runId is available
  useEffect(() => {
    if (report.runId && isTraceMode) {
      setTraceMetricsLoading(true);
      fetchRunMetrics(report.runId)
        .then(setTraceMetrics)
        .catch((error) => {
          console.warn('[RunDetails] Failed to fetch trace metrics:', error);
          setTraceMetrics(null);
        })
        .finally(() => setTraceMetricsLoading(false));
    } else {
      setTraceMetrics(null);
    }
  }, [report.runId, isTraceMode, liveReport.metricsStatus]);

  // Reset trace state when report changes (switching test cases)
  // If already on Traces tab, auto-fetch new traces
  useEffect(() => {
    setTraceSpans([]);
    setSpanTree([]);
    setTimeRange({ startTime: 0, endTime: 0, duration: 0 });
    setSelectedSpan(null);
    setExpandedSpans(new Set());
    setTracesLoading(false);
    setTracesError(null);
    setTracesFetched(false);

    // Auto-fetch if already on traces tab
    if (activeTab === 'logs' && isTraceMode && report.runId) {
      // Use setTimeout to ensure state is reset before fetching
      setTimeout(() => {
        fetchTracesForReport();
      }, 0);
    }
  }, [report.id, report.runId]);

  // Core trace fetching logic
  const fetchTracesForReport = async () => {
    if (!report.runId) return;

    setTracesLoading(true);
    setTracesError(null);

    try {
      // Resolve the agent's OpenSearch service.name for the time-window
      // fallback (Strategy C). Priority order:
      //   1. AgentConfig.traceServiceName — the explicit override declared
      //      in lib/constants.ts (or user-provided via agent-health.config.ts).
      //      Required for managed/3rd-party agents whose service.name doesn't
      //      match our naming convention.
      //   2. Per-protocol convention map below — covers the connector types
      //      this PR ships with built-in defaults.
      //   3. <agentKey>-agent fallback — best-effort.
      const protocolToServiceName: Record<string, string> = {
        'claude-code': 'claude-code-agent',
        'kiro': 'kiro-agent',
        'pi': 'pi-agent',
        'agui-streaming': 'observio-sample-agent',
      };
      const agentConfig = report.agentKey
        ? DEFAULT_CONFIG.agents.find(a => a.key === report.agentKey)
        : undefined;
      const serviceName =
        agentConfig?.traceServiceName ||
        (report.connectorProtocol && protocolToServiceName[report.connectorProtocol]) ||
        (report.agentKey ? `${report.agentKey}-agent` : undefined);

      // Run wall-clock window for the time-window-fallback correlation
      // (Strategy C). We derive `[startedAt, endedAt]` from the saved report's
      // metadata. Two important quirks:
      //  - report.timestamp is when the run was *saved* (after agent + judge),
      //    not when it started. Treating it as endedAt is correct.
      //  - performanceMetrics.durationMs is missing on older runs (the field
      //    was added later). When it's missing we'd compute a tiny
      //    centered-on-timestamp window and miss every agent span. So when
      //    durationMs is unknown we fall back to a 30-minute lookback — wide
      //    enough to cover any realistic agent run, narrow enough to keep
      //    cross-team noise on a shared OTel cluster minimal.
      const SLACK_MS = 60_000;
      const FALLBACK_LOOKBACK_MS = 30 * 60_000;
      const endedAt = Date.parse(report.timestamp || '') || Date.now();
      const durationMs = report.performanceMetrics?.durationMs ?? 0;
      const lookbackMs = durationMs > 0 ? durationMs + SLACK_MS : FALLBACK_LOOKBACK_MS;
      const startedAt = endedAt - lookbackMs;
      const windowAgents = serviceName
        ? [{ serviceName, startedAt, endedAt: endedAt + SLACK_MS, ...(report.sessionId ? { sessionId: report.sessionId } : {}) }]
        : undefined;

      console.info('[RunDetails] Fetching traces for runId:', report.runId,
        windowAgents ? `(+window fallback for ${serviceName}${report.sessionId ? ` +session ${report.sessionId}` : ''})` : '');
      const result = await fetchTracesForRun({
        runId: report.runId,
        includeWindowFallback: true,
        windowAgents,
      });
      
      console.info('[RunDetails] Trace fetch result:', {
        spansCount: result.spans?.length || 0,
        total: result.total,
        warning: result.warning,
        hasSpans: !!(result.spans && result.spans.length > 0)
      });

      if (result.spans && result.spans.length > 0) {
        setTraceSpans(result.spans);
        setTracesError(null);
        const tree = processSpansIntoTree(result.spans);
        setSpanTree(tree);
        setTimeRange(calculateTimeRange(result.spans));
        // Auto-expand root spans
        const rootIds = new Set(tree.map(s => s.spanId));
        setExpandedSpans(rootIds);
        console.info('[RunDetails] Traces loaded successfully:', result.spans.length, 'spans');
      } else {
        const errorMsg = result.warning 
          ? `No traces found: ${result.warning}`
          : 'No traces found for this run. Traces may take ~5 minutes to propagate after the run completes.';
        console.warn('[RunDetails] No traces found:', errorMsg);
        setTracesError(errorMsg);
      }
    } catch (error) {
      console.error('[RunDetails] Failed to fetch traces:', error);
      setTracesError(error instanceof Error ? error.message : 'Failed to fetch traces');
    } finally {
      setTracesLoading(false);
      setTracesFetched(true);
    }
  };

  // Fetch traces on-demand (only when needed and not already fetched)
  const fetchTracesOnDemand = async () => {
    if (tracesFetched || tracesLoading) return;
    await fetchTracesForReport();
  };

  const handleToggleExpand = (spanId: string) => {
    setExpandedSpans(prev => {
      const next = new Set(prev);
      if (next.has(spanId)) {
        next.delete(spanId);
      } else {
        next.add(spanId);
      }
      return next;
    });
  };

  const handleAddAnnotation = async () => {
    if (!newAnnotation.trim()) return;

    const annotation = await asyncRunStorage.addAnnotation(report.id, {
      text: newAnnotation,
      tags: [],
    });

    if (annotation) {
      setAnnotations([...annotations, annotation]);
      setNewAnnotation('');
    }
  };

  const handleDeleteAnnotation = async (annotationId: string) => {
    const success = await asyncRunStorage.deleteAnnotation(report.id, annotationId);
    if (success) {
      setAnnotations(annotations.filter(a => a.id !== annotationId));
    }
  };

  const totalLatencyMs = trajectory.reduce((acc, s) => acc + (s.latencyMs || 0), 0);

  return (
    <div className={`flex flex-col h-full ${className}`}>
      {/* Header — hidden entirely when used inside TestCaseInspectorPanel */}
      {!hideMetrics && (
      <div className="bg-card border-b p-4">
        {!hideMetrics && (
        <div className="flex items-start justify-between mb-3">
          <h2 className="text-xl font-semibold">{testCase?.name || 'Unknown Test Case'}</h2>
          <p className="text-xs text-muted-foreground">
            Report ID: <span className="font-mono">{report.id}</span>
          </p>
        </div>
        )}

        {/* Trace Mode: Waiting for traces / running judge banner */}
        {!hideMetrics && !reportLoading && liveReport.metricsStatus === 'pending' && (
          <Card className="bg-yellow-50 dark:bg-yellow-500/10 border-yellow-300 dark:border-yellow-500/30 mt-4">
            <CardContent className="p-3 flex items-center gap-3">
              <Loader2 className="animate-spin text-yellow-700 dark:text-yellow-400" size={18} />
              <div>
                {traceSpans.length > 0 ? (
                  <>
                    <div className="text-sm font-medium text-yellow-700 dark:text-yellow-400">Traces received. Running LLM judge evaluation...</div>
                    <div className="text-xs text-muted-foreground">
                      {traceSpans.length} spans captured. Evaluation results will appear shortly.
                    </div>
                  </>
                ) : (
                  <>
                    <div className="text-sm font-medium text-yellow-700 dark:text-yellow-400">Waiting for traces to become available...</div>
                    <div className="text-xs text-muted-foreground">
                      Traces take ~5 minutes to propagate after the run completes.
                      {liveReport.traceFetchAttempts && (
                        <span className="ml-2">
                          (Attempt {liveReport.traceFetchAttempts}/20)
                        </span>
                      )}
                    </div>
                  </>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Trace Mode: Error state */}
        {!hideMetrics && liveReport.metricsStatus === 'error' && (
          <Card className="bg-red-50 dark:bg-red-500/10 border-red-300 dark:border-red-500/30 mt-4">
            <CardContent className="p-3 flex items-center gap-3">
              <AlertCircle className="text-red-700 dark:text-red-400" size={18} />
              <div>
                <div className="text-sm font-medium text-red-700 dark:text-red-400">
                  {/* Derive the title from the error kind label (e.g. "Agent run
                      did not complete", "Judge evaluation failed") instead of
                      always saying "Failed to fetch traces" — which is wrong for
                      agent timeouts / judge errors (#335). */}
                  {(liveReport.traceError || '').match(/^(.*?) \(kind=/)?.[1] || 'Evaluation error'}
                </div>
                <div className="text-xs text-muted-foreground">
                  {liveReport.traceError || 'Unknown error'}
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Evaluation Error: Agent endpoint failed — hidden in inspector panel (status shown in compact bar) */}
        {!hideMetrics && liveReport.status === 'failed' && getJudgeReasoningText(liveReport) && (
          <Card className="bg-red-500/10 border-red-500/30 mt-4">
            <CardContent className="p-3 flex items-start gap-3">
              <AlertCircle className="text-red-400 shrink-0 mt-0.5" size={18} />
              <div className="flex-1">
                <div className="text-sm font-medium text-red-400 mb-1">Evaluation Failed</div>
                <div className="text-xs text-muted-foreground whitespace-pre-wrap">
                  {getJudgeReasoningText(liveReport)}
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Trace Mode: Spans received */}
        {!hideMetrics && liveReport.spans && liveReport.spans.length > 0 && (
          <Card className="bg-opensearch-blue/10 border-opensearch-blue/30 mt-4">
            <CardContent className="p-3 flex items-center gap-3">
              <CheckCircle2 className="text-opensearch-blue" size={18} />
              <div>
                <div className="text-sm font-medium text-opensearch-blue">Traces received</div>
                <div className="text-xs text-muted-foreground">
                  {liveReport.spans.length} spans captured
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Metrics Row - Compact */}
        {!hideMetrics && (<>
        <div className={`grid gap-2 ${isTraceMode ? 'grid-cols-10' : 'grid-cols-8'}`}>
          <Card className="bg-muted/50 col-span-2">
            <CardContent className="p-2">
              <div className="text-[10px] text-muted-foreground mb-0.5">Status</div>
              {reportLoading ? (
                <Loader2 className="animate-spin text-muted-foreground" size={12} />
              ) : (() => {
                const derivedStatus = getSharedResultStatus(
                  { status: liveReport.status },
                  liveReport,
                );
                // Refine: if metricsStatus is pending but we already have traces, it's judging
                const finalStatus = derivedStatus === 'pending_traces' && traceSpans.length > 0
                  ? 'pending_judgment' : derivedStatus;
                return (
                  <div className="flex items-center gap-1 text-xs font-semibold">
                    <SharedStatusIcon status={finalStatus} size={12} />
                    <SharedStatusLabel status={finalStatus} />
                  </div>
                );
              })()}
            </CardContent>
          </Card>

          {/* Dynamic Metrics from Evaluator */}
          {evaluator ? (
            evaluator.scoringConfig.metrics.map((metric, idx) => {
              const metricValue = (liveReport.metrics as any)[metric.name];
              const displayValue = metricValue != null ? `${metricValue}%` : '—';
              return (
                <Card key={metric.name} className="bg-muted/50 col-span-2">
                  <CardContent className="p-2">
                    <div className="text-[10px] text-muted-foreground mb-0.5 capitalize">
                      {metric.name.replace(/_/g, ' ')}
                    </div>
                    <div className="text-xs font-semibold text-blue-700 dark:text-blue-400">
                      {displayValue}
                    </div>
                  </CardContent>
                </Card>
              );
            })
          ) : (
            /* Fallback for legacy runs without evaluator */
            <Card className="bg-muted/50 col-span-2">
              <CardContent className="p-2">
                <div className="text-[10px] text-muted-foreground mb-0.5">Score</div>
                {/* Renders the run's overall score (mean of every metric the
                    evaluator emitted) with a tooltip listing each contributing
                    metric, instead of hardcoding `accuracy` — which only the
                    RCA Default evaluator emits. */}
                <RunScore
                  metrics={liveReport.metrics as Record<string, number | undefined>}
                  showLabel={false}
                  className="text-xs font-semibold text-blue-700 dark:text-blue-400"
                />
              </CardContent>
            </Card>
          )}

          {/* Non-trace-mode: show Latency and Steps */}
          {!isTraceMode && (
            <>
              <Card className="bg-muted/50 col-span-2">
                <CardContent className="p-2">
                  <div className="text-[10px] text-muted-foreground mb-0.5">Latency</div>
                  <div className="text-xs font-semibold text-amber-700 dark:text-amber-400">{(totalLatencyMs / 1000).toFixed(2)}s</div>
                </CardContent>
              </Card>
              <Card className="bg-muted/50 col-span-2">
                <CardContent className="p-2">
                  <div className="text-[10px] text-muted-foreground mb-0.5">Steps</div>
                  <div className="text-xs font-semibold text-blue-700 dark:text-blue-400">{trajectory.length}</div>
                </CardContent>
              </Card>
            </>
          )}

          {/* Trace-mode: Duration, Cost, Tool Calls in first row */}
          {isTraceMode && (
            <>
              <Card className="bg-muted/50 col-span-2">
                <CardContent className="p-2">
                  <div className="text-[10px] text-muted-foreground mb-0.5">Duration</div>
                  {traceMetricsLoading ? (
                    <Loader2 className="animate-spin text-muted-foreground" size={12} />
                  ) : (
                    <div className="text-xs font-semibold text-purple-700 dark:text-purple-400">
                      {traceMetrics ? formatDuration(traceMetrics.durationMs) : '—'}
                      {(performanceMetricsProp || report.performanceMetrics)?.agentDurationMs != null && (
                        <span className="text-[10px] font-normal text-muted-foreground ml-1">
                          (agent {formatDuration((performanceMetricsProp || report.performanceMetrics)!.agentDurationMs)})
                        </span>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card className="bg-muted/50 col-span-2">
                <CardContent className="p-2">
                  <div className="text-[10px] text-muted-foreground mb-0.5">Cost</div>
                  {traceMetricsLoading ? (
                    <Loader2 className="animate-spin text-muted-foreground" size={12} />
                  ) : (
                    <div className="text-xs font-semibold text-amber-700 dark:text-amber-400">
                      {traceMetrics ? formatCost(traceMetrics.costUsd) : '—'}
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card className="bg-muted/50 col-span-2">
                <CardContent className="p-2">
                  <div className="text-[10px] text-muted-foreground mb-0.5">Tool Calls</div>
                  {traceMetricsLoading ? (
                    <Loader2 className="animate-spin text-muted-foreground" size={12} />
                  ) : (
                    <div className="text-xs font-semibold text-blue-700 dark:text-blue-400">
                      {traceMetrics ? traceMetrics.toolCalls : '—'}
                    </div>
                  )}
                </CardContent>
              </Card>
            </>
          )}
        </div>

        {/* Trace Metrics Row 2 (for trace-mode agents) - Compact */}
        {isTraceMode && (
          <div className="grid grid-cols-10 gap-2 mt-2">
            <Card className="bg-muted/50 col-span-2">
              <CardContent className="p-2">
                <div className="text-[10px] text-muted-foreground mb-0.5">Input Tokens</div>
                {traceMetricsLoading ? (
                  <Loader2 className="animate-spin text-muted-foreground" size={12} />
                ) : (
                  <div className="text-xs font-semibold text-cyan-700 dark:text-cyan-400">
                    {traceMetrics ? formatTokens(traceMetrics.inputTokens) : '—'}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="bg-muted/50 col-span-2">
              <CardContent className="p-2">
                <div className="text-[10px] text-muted-foreground mb-0.5">Output Tokens</div>
                {traceMetricsLoading ? (
                  <Loader2 className="animate-spin text-muted-foreground" size={12} />
                ) : (
                  <div className="text-xs font-semibold text-cyan-700 dark:text-cyan-400">
                    {traceMetrics ? formatTokens(traceMetrics.outputTokens) : '—'}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="bg-muted/50 col-span-2">
              <CardContent className="p-2">
                <div className="text-[10px] text-muted-foreground mb-0.5">Total Tokens</div>
                {traceMetricsLoading ? (
                  <Loader2 className="animate-spin text-muted-foreground" size={12} />
                ) : (
                  <div className="text-xs font-semibold text-cyan-700 dark:text-cyan-400">
                    {traceMetrics ? formatTokens(traceMetrics.totalTokens) : '—'}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="bg-muted/50 col-span-2">
              <CardContent className="p-2">
                <div className="text-[10px] text-muted-foreground mb-0.5">LLM Calls</div>
                {traceMetricsLoading ? (
                  <Loader2 className="animate-spin text-muted-foreground" size={12} />
                ) : (
                  <div className="text-xs font-semibold text-blue-700 dark:text-blue-400">
                    {traceMetrics ? traceMetrics.llmCalls : '—'}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="bg-muted/50 col-span-2">
              <CardContent className="p-2">
                <div className="text-[10px] text-muted-foreground mb-0.5">Tools Used</div>
                {traceMetricsLoading ? (
                  <Loader2 className="animate-spin text-muted-foreground" size={12} />
                ) : (
                  <div className="text-xs font-semibold text-indigo-700 dark:text-indigo-400 truncate" title={traceMetrics?.toolsUsed?.join(', ')}>
                    {traceMetrics?.toolsUsed?.length ? traceMetrics.toolsUsed.length : '—'}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}

        {/* Server Performance Metrics Row (per-test-case) */}
        {(performanceMetricsProp || report.performanceMetrics) && (() => {
          const perfMetrics = performanceMetricsProp || report.performanceMetrics!;
          return (
          <div className="grid grid-cols-8 gap-2 mt-2">
            <Card className="bg-muted/50 col-span-2">
              <CardContent className="p-2">
                <div className="text-[10px] text-muted-foreground mb-0.5 flex items-center gap-1">
                  Eval Duration
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Info size={10} className="text-muted-foreground/60 cursor-help" />
                      </TooltipTrigger>
                      <TooltipContent side="top" className="max-w-[200px] text-xs">
                        Total server-side wall-clock time: agent call + judge evaluation + overhead
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
                <div className="text-xs font-semibold text-purple-700 dark:text-purple-400">
                  {formatDuration(perfMetrics.durationMs)}
                </div>
              </CardContent>
            </Card>
            {perfMetrics.judgeDurationMs != null && (
              <Card className="bg-muted/50 col-span-2">
                <CardContent className="p-2">
                  <div className="text-[10px] text-muted-foreground mb-0.5">Judge Time</div>
                  <div className="text-xs font-semibold text-amber-700 dark:text-amber-400">
                    {formatDuration(perfMetrics.judgeDurationMs)}
                  </div>
                </CardContent>
              </Card>
            )}
            {perfMetrics.judgeAttempts != null && perfMetrics.judgeAttempts > 1 && (
              <Card className="bg-muted/50 col-span-2">
                <CardContent className="p-2">
                  <div className="text-[10px] text-muted-foreground mb-0.5">Judge Retries</div>
                  <div className="text-xs font-semibold text-red-700 dark:text-red-400">
                    {perfMetrics.judgeAttempts}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
          );
        })()}
        </>)}
      </div>
      )}

      {/* The standalone /runs/:runId surface does not have the inspector's
          outer definition card, so expose the same reader-oriented task here.
          hideMetrics means TestCaseInspectorPanel already rendered it. */}
      {!hideMetrics && (
        <CollapsibleTestCaseDefinition testCase={testCase} />
      )}

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col overflow-hidden">
        <TabsList className="w-full justify-start rounded-none border-b bg-card h-auto p-0">
          <TabsTrigger value="trajectory" className="rounded-none border-b-2 border-transparent data-[state=active]:border-opensearch-blue data-[state=active]:text-opensearch-blue">
            <GitBranch size={14} className="mr-2" /> Test Case Output
            <Badge variant="secondary" className="ml-2">{trajectory.length}</Badge>
          </TabsTrigger>
          <TabsTrigger
            value="logs"
            className="rounded-none border-b-2 border-transparent data-[state=active]:border-opensearch-blue data-[state=active]:text-opensearch-blue"
            onClick={isTraceMode ? fetchTracesOnDemand : undefined}
          >
            {isTraceMode ? <Activity size={14} className="mr-2" /> : <Terminal size={14} className="mr-2" />}
            {isTraceMode ? 'Traces' : 'OpenSearch Logs'}
            {isTraceMode
              ? traceSpans.length > 0 && <Badge variant="secondary" className="ml-2">{traceSpans.length}</Badge>
              : report.logs && <Badge variant="secondary" className="ml-2">{report.logs.length}</Badge>
            }
          </TabsTrigger>
          <TabsTrigger value="judge" className="rounded-none border-b-2 border-transparent data-[state=active]:border-opensearch-blue data-[state=active]:text-opensearch-blue">
            <Scale size={14} className="mr-2" /> Judge Evaluation
          </TabsTrigger>
          <TabsTrigger value="annotations" className="rounded-none border-b-2 border-transparent data-[state=active]:border-opensearch-blue data-[state=active]:text-opensearch-blue">
            <MessageSquare size={14} className="mr-2" /> Annotations
            {annotations.length > 0 && <Badge variant="secondary" className="ml-2">{annotations.length}</Badge>}
          </TabsTrigger>
        </TabsList>

        {/* Inner flex container for the active TabsContent. The Traces tab
            (value="logs") manages its own internal scroll on the chart and
            wants a constrained height — wrapping it in a ScrollArea here lets
            the chart's intrinsic height push the page scroll, which makes
            tall trace trees overflow the dialog/page viewport. The other
            tabs (Trajectory / LLM Judge / Annotations) are simple top-down
            documents, so they get their own `overflow-y-auto` per-TabsContent
            instead of relying on a shared scroll container. */}
        <div className="flex-1 flex flex-col overflow-hidden min-h-0">
          <TabsContent value="trajectory" className="p-6 mt-0 overflow-y-auto">
            {/* Header with Toggle */}
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold">Test Case Output</h3>
              <div className="flex items-center gap-1 bg-muted rounded-lg p-1">
                <button
                  onClick={() => setTrajectoryViewMode('processed')}
                  className={`px-3 py-1.5 text-xs rounded-md transition-colors ${
                    trajectoryViewMode === 'processed'
                      ? 'bg-opensearch-blue text-white'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  Processed
                </button>
                <button
                  onClick={() => setTrajectoryViewMode('raw')}
                  className={`px-3 py-1.5 text-xs rounded-md transition-colors ${
                    trajectoryViewMode === 'raw'
                      ? 'bg-opensearch-blue text-white'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  Raw Events
                </button>
              </div>
            </div>

            {/* Conditional View */}
            {trajectoryViewMode === 'processed' ? (
              <TrajectoryView steps={trajectory} loading={false} />
            ) : (
              report.rawEvents && report.rawEvents.length > 0 ? (
                <RawEventsPanel events={report.rawEvents} />
              ) : (
                <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                  <Terminal size={48} className="mb-4 opacity-20" />
                  <p>No raw events captured for this run</p>
                  <p className="text-sm mt-1">Raw events are only available for new runs</p>
                </div>
              )
            )}
          </TabsContent>

          {/*
           * NOTE: use data-[state=active]:* prefixes for the flex/min-h-0 layout
           * classes. Without them, the unconditional `flex` class wins over
           * radix's `[hidden]` attribute (same specificity, later in source
           * order) and the *inactive* panel keeps a non-zero height — which
           * shows up as a phantom gap above the active tab's content (e.g.
           * the LLM Judge / Annotations tabs would render with ~48px – 430px
           * of empty space depending on the trace panel's intrinsic size).
           */}
          <TabsContent value="logs" className="p-6 mt-0 data-[state=active]:flex-1 data-[state=active]:flex data-[state=active]:flex-col data-[state=active]:min-h-0">
            {isTraceMode ? (
              /* TRACE MODE: Show trace visualization */
              <div className="space-y-4 flex-1 flex flex-col min-h-0">
                <div className="flex items-center justify-between flex-shrink-0">
                  <h3 className="text-lg font-semibold">Traces</h3>
                  {spanTree.length > 0 && !tracesLoading && (
                    <div className="flex items-center gap-2">
                      <ViewToggle viewMode={traceViewMode} onChange={setTraceViewMode} />
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setTraceFullscreenOpen(true)}
                        className="gap-1.5"
                      >
                        <Maximize2 size={14} />
                        Fullscreen
                      </Button>
                    </div>
                  )}
                </div>

                {/* Loading state */}
                {tracesLoading && (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 className="animate-spin mr-2" size={20} />
                    <span className="text-muted-foreground">Loading traces...</span>
                  </div>
                )}

                {/* Error state - only show when NOT in pending polling state */}
                {tracesError && !tracesLoading && liveReport.metricsStatus !== 'pending' && (
                  <Card className="bg-muted/50 border-border">
                    <CardContent className="p-4 flex items-center gap-3">
                      <AlertCircle className="text-muted-foreground" size={18} />
                      <div>
                        <div className="text-sm font-medium text-muted-foreground">No traces available</div>
                        <div className="text-xs text-muted-foreground">Traces may take a few minutes to appear after the run completes, or may not be available for this run.</div>
                      </div>
                    </CardContent>
                  </Card>
                )}

                {/* No runId state */}
                {!report.runId && !tracesLoading && (
                  <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                    <Activity size={48} className="mb-4 opacity-20" />
                    <p>No run ID available for trace lookup</p>
                  </div>
                )}

                {/* Pending traces state */}
                {!reportLoading && liveReport.metricsStatus === 'pending' && !tracesLoading && !traceSpans.length && (
                  <Card className="bg-yellow-500/10 border-yellow-500/30">
                    <CardContent className="p-4 flex items-center gap-3">
                      <Loader2 className="animate-spin text-yellow-400" size={18} />
                      <div>
                        <div className="text-sm font-medium text-yellow-400">Traces not yet available</div>
                        <div className="text-xs text-muted-foreground">
                          Traces take ~5 minutes to propagate. Check back shortly.
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                )}

                {/* Trace visualization. Span details now slide up from the
                    bottom of the trace card (`absolute bottom-0` overlay)
                    rather than appearing as an adjacent side panel. The
                    side panel cramped the timeline at typical viewport
                    widths; the bottom drawer matches the fullscreen UX so
                    inline and fullscreen feel like the same surface. */}
                {spanTree.length > 0 && !tracesLoading && (
                  <div className="space-y-4 flex-1 flex flex-col min-h-0">
                    <Card className="flex-1 flex flex-col min-h-0">
                      <CardContent className="p-0 flex-1 flex flex-col min-h-0">
                        <div className="flex-1 min-h-0 relative">
                          <TraceVisualization
                            spanTree={spanTree}
                            timeRange={timeRange}
                            initialViewMode={traceViewMode}
                            onViewModeChange={setTraceViewMode}
                            showViewToggle={false}
                            selectedSpan={selectedSpan}
                            onSelectSpan={setSelectedSpan}
                            expandedSpans={expandedSpans}
                            onToggleExpand={handleToggleExpand}
                            showSpanDetailsPanel={false}
                            runId={report.runId}
                          />
                          {/* Bottom drawer for selected span details. Same
                              SimpleSpanAttributesTable as fullscreen, so the
                              user gets the same flat attribute table + the
                              Pretty/Raw toggle in both surfaces. Click the
                              row again to deselect, or press Esc. */}
                          {selectedSpan && (
                            <div
                              className="absolute inset-x-0 bottom-0 h-[55%] bg-background border-t shadow-2xl flex flex-col z-20 animate-in slide-in-from-bottom-4 duration-200"
                              role="dialog"
                              aria-label="Span details"
                            >
                              <SimpleSpanAttributesTable span={selectedSpan} />
                            </div>
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  </div>
                )}

                {/* Not fetched yet - prompt to click */}
                {!tracesFetched && !tracesLoading && report.runId && liveReport.metricsStatus !== 'pending' && (
                  <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                    <Activity size={48} className="mb-4 opacity-20" />
                    <p>Click to load traces</p>
                    <Button
                      variant="outline"
                      className="mt-4"
                      onClick={fetchTracesOnDemand}
                    >
                      Load Traces
                    </Button>
                  </div>
                )}

                {/* Fullscreen Trace View */}
                <TraceFullScreenView
                  open={traceFullscreenOpen}
                  onOpenChange={setTraceFullscreenOpen}
                  title={`Traces: ${testCase?.name || 'Unknown Test Case'}`}
                  subtitle={`Run ID: ${report.runId}`}
                  spanTree={spanTree}
                  timeRange={timeRange}
                  selectedSpan={selectedSpan}
                  onSelectSpan={setSelectedSpan}
                  initialViewMode={traceViewMode}
                  onViewModeChange={setTraceViewMode}
                  spanCount={traceSpans.length}
                />
              </div>
            ) : (
              /* STANDARD MODE: Show OpenSearch logs */
              <>
                <h3 className="text-lg font-semibold mb-4">OpenSearch Logs</h3>
                {report.logs && report.logs.length > 0 ? (
                  <div className="space-y-2">
                    {report.logs.map((log, index) => (
                      <Card key={index}><CardContent className="p-3">
                        <div className="flex items-start gap-3">
                          <span className="text-xs text-muted-foreground whitespace-nowrap">
                            {new Date(log.timestamp).toLocaleTimeString()}
                          </span>
                          <span className={`text-xs font-semibold ${getLogLevelColor(log.level)}`}>
                            [{log.level || 'INFO'}]
                          </span>
                          <span className="text-sm flex-1 font-mono">{log.message}</span>
                        </div>
                        {log.source && (
                          <div className="mt-1 ml-24 text-xs text-muted-foreground">
                            Source: {log.source}
                          </div>
                        )}
                      </CardContent></Card>
                    ))}
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                    <Terminal size={48} className="mb-4 opacity-20" />
                    <p>No OpenSearch logs available for this run</p>
                  </div>
                )}
              </>
            )}
          </TabsContent>

          <TabsContent value="judge" className="p-6 mt-0 space-y-6 overflow-y-auto">
            {/* Evaluator Info */}
            {evaluator && (
              <div>
                <h3 className="text-lg font-semibold mb-3">Evaluator</h3>
                <Card><CardContent className="p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    {React.createElement(getEvaluatorIcon(evaluator.id), { className: 'h-5 w-5 text-muted-foreground' })}
                    <span className="font-semibold">{evaluator.name}</span>
                    {evaluator.isSystem && (
                      <Badge variant="secondary" className="text-xs">System</Badge>
                    )}
                  </div>
                  {evaluator.description && (
                    <p className="text-sm text-muted-foreground">{evaluator.description}</p>
                  )}
                  <div className="pt-2 border-t">
                    <div className="text-xs text-muted-foreground mb-2">Scoring Metrics</div>
                    <div className="space-y-1">
                      {evaluator.scoringConfig.metrics.map((metric) => (
                        <div key={metric.name} className="flex items-center justify-between text-sm">
                          <span className="capitalize">{metric.name.replace(/_/g, ' ')}</span>
                          <span className="text-muted-foreground">
                            Weight: {metric.weight} | Scale: {metric.scale}
                          </span>
                        </div>
                      ))}
                    </div>
                    <div className="mt-2 text-xs text-muted-foreground">
                      Pass Threshold: {evaluator.scoringConfig.passThreshold}%
                    </div>
                  </div>
                </CardContent></Card>
              </div>
            )}

            {/* Matcher results — the canonical surface for SDK matchers AND
                LLM judge entries (legacy auto-judge results are pushed into
                the same array via lib/matchers/judgeAccessor). For old
                reports that only have the legacy `llmJudgeReasoning` field,
                getJudgeMatcherResults() synthesizes a virtual entry on read
                so they still render here. */}
            {(() => {
              const judgeEntries = getJudgeMatcherResults(liveReport);
              const codeEntries = (liveReport.matcherResults ?? []).filter(
                m => m.method !== 'llm-judge'
              );
              const merged = [...codeEntries, ...judgeEntries];
              return merged.length > 0 ? <MatcherResultsPanel results={merged} /> : null;
            })()}

            {/* Judge Reasoning card removed — judge data now flows through
                the unified MatcherResultsPanel above as `[llm-judge]`
                entries (see lib/matchers/judgeAccessor.ts). Keeping a
                dedicated card on top of that would be a duplicate surface,
                exactly the architectural duplication that caused issue #230. */}

            {/* Improvement Strategies */}
            {liveReport.improvementStrategies && liveReport.improvementStrategies.length > 0 && (
              <div>
                <h3 className="text-lg font-semibold mb-3 flex items-center">
                  <Lightbulb size={18} className="mr-2" />
                  Improvement Strategies
                </h3>
                <div className="space-y-3">
                  {liveReport.improvementStrategies.map((strategy, index) => {
                    const priorityColors = {
                      high: 'text-red-700 dark:text-red-400 border-red-300 dark:border-red-900 bg-red-50 dark:bg-red-950/20',
                      medium: 'text-yellow-700 dark:text-yellow-400 border-yellow-300 dark:border-yellow-900 bg-yellow-50 dark:bg-yellow-950/20',
                      low: 'text-blue-700 dark:text-blue-400 border-blue-300 dark:border-blue-900 bg-blue-50 dark:bg-blue-950/20',
                    };
                    const priorityIcons = {
                      high: <AlertTriangle size={16} />,
                      medium: <AlertCircle size={16} />,
                      low: <Info size={16} />,
                    };
                    const priorityTextColors = {
                      high: 'text-red-700 dark:text-red-400',
                      medium: 'text-yellow-700 dark:text-yellow-400',
                      low: 'text-blue-700 dark:text-blue-400',
                    };
                    return (
                      <div key={index} className={`p-4 rounded-lg border-l-4 ${priorityColors[strategy.priority]}`}>
                        <div className="flex items-start gap-3">
                          <div className={`mt-0.5 ${priorityTextColors[strategy.priority]}`}>
                            {priorityIcons[strategy.priority]}
                          </div>
                          <div className="flex-1">
                            <div className="flex items-center justify-between mb-2">
                              <span className="text-sm font-semibold text-foreground">
                                {strategy.category.replace(/_/g, ' ').toUpperCase()}
                              </span>
                              <Badge variant="outline" className={priorityTextColors[strategy.priority]}>
                                {strategy.priority}
                              </Badge>
                            </div>
                            <div className="text-sm text-muted-foreground mb-2">
                              <span className="font-medium text-foreground">Issue:</span> {strategy.issue}
                            </div>
                            <div className="text-sm text-muted-foreground">
                              <span className="font-medium text-foreground">Recommendation:</span> {strategy.recommendation}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Judge output — every field the judge emitted, rendered
               flat (no collapsibles) so users see the complete picture
               upfront. Pre-fix the judge response was scattered across
               the page and partially hidden behind expand toggles, which
               made it hard to confirm "did my prompt edit actually
               reach the model?" / "what custom fields are in the JSON?"
               in one glance.

               Renders:
                 - identity strip (provider · model · evaluator · tokens · latency)
                 - parsed metrics (mirror of the metrics already in the run
                   summary, kept here so the judge tab is self-contained)
                 - additional judge output (extraFields) — every key the
                   prompt asked the judge for that doesn't fit the typed
                   wire shape (improvement_candidates, failure_tags,
                   weighted_score, scores_unmapped, etc.) shown as a
                   key/value list rather than a JSON blob
                 - system prompt (capped height, scrollable in place)
                 - user prompt (capped height, scrollable in place)
                 - raw judge response (capped height, scrollable in place)

               Long blocks use `max-h-80 overflow-y-auto` so the section
               doesn't push the rest of the page off-screen on a 10–20 KB
               saved prompt. */}
            {(liveReport.llmJudgeResponse?.judgeDebug ||
              liveReport.llmJudgeResponse?.extraFields ||
              liveReport.llmJudgeResponse?.rawResponse ||
              liveReport.llmJudgeResponse?.parsedMetrics) && (
              <div>
                <h3 className="text-lg font-semibold mb-3">Judge Output</h3>
                <Card>
                  <CardContent className="p-4 space-y-5">
                    {/* Identity / metadata strip — always visible. */}
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground border-b pb-3">
                      {liveReport.llmJudgeResponse?.judgeDebug?.provider && (
                        <span><strong>Provider:</strong> {liveReport.llmJudgeResponse.judgeDebug.provider}</span>
                      )}
                      {(liveReport.llmJudgeResponse?.judgeDebug?.modelId || liveReport.llmJudgeResponse?.modelId) && (
                        <span><strong>Judge model:</strong> {liveReport.llmJudgeResponse?.judgeDebug?.modelId || liveReport.llmJudgeResponse?.modelId}</span>
                      )}
                      {liveReport.llmJudgeResponse?.judgeDebug?.evaluatorId && (
                        <span><strong>Evaluator:</strong> {liveReport.llmJudgeResponse.judgeDebug.evaluatorId}</span>
                      )}
                      {typeof liveReport.llmJudgeResponse?.promptTokens === 'number' && (
                        <span><strong>Tokens:</strong> {liveReport.llmJudgeResponse.promptTokens.toLocaleString()} prompt + {(liveReport.llmJudgeResponse.completionTokens || 0).toLocaleString()} completion</span>
                      )}
                      {typeof liveReport.llmJudgeResponse?.latencyMs === 'number' && liveReport.llmJudgeResponse.latencyMs > 0 && (
                        <span><strong>Latency:</strong> {liveReport.llmJudgeResponse.latencyMs.toLocaleString()} ms</span>
                      )}
                    </div>

                    {/* Parsed metrics — typed wire fields the run summary
                        already shows, mirrored here so the judge tab is
                        self-contained without scrolling back up. */}
                    {liveReport.llmJudgeResponse?.parsedMetrics && Object.keys(liveReport.llmJudgeResponse.parsedMetrics).length > 0 && (
                      <div>
                        <div className="text-sm font-semibold mb-1.5">Parsed metrics</div>
                        <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
                          {Object.entries(liveReport.llmJudgeResponse.parsedMetrics)
                            .filter(([, v]) => v !== undefined && v !== null)
                            .map(([k, v]) => (
                              <div key={k} className="flex items-center justify-between border-b border-border/40 pb-1">
                                <span className="text-muted-foreground">{k}</span>
                                <span className="font-mono font-semibold">{typeof v === 'number' ? v : String(v)}</span>
                              </div>
                            ))}
                        </div>
                      </div>
                    )}

                    {/* Additional judge output — the escape hatch. Every
                        key the model emitted that doesn't map onto a
                        typed wire field or a declared metric. Rendered
                        as a key/value list with values pretty-printed
                        rather than dumped as a single JSON blob. */}
                    {liveReport.llmJudgeResponse?.extraFields && Object.keys(liveReport.llmJudgeResponse.extraFields).length > 0 && (
                      <div>
                        <div className="text-sm font-semibold mb-1.5">
                          Additional judge output
                          <span className="text-xs font-normal text-muted-foreground ml-2">
                            ({Object.keys(liveReport.llmJudgeResponse.extraFields).length} field{Object.keys(liveReport.llmJudgeResponse.extraFields).length === 1 ? '' : 's'} the prompt asked for, beyond the typed shape)
                          </span>
                        </div>
                        <div className="space-y-1.5">
                          {Object.entries(liveReport.llmJudgeResponse.extraFields).map(([key, value]) => {
                            const isPrimitive = value === null || (typeof value !== 'object');
                            const display = isPrimitive
                              ? String(value)
                              : JSON.stringify(value, null, 2);
                            return (
                              <div key={key} className="text-xs">
                                <code className="text-muted-foreground font-semibold">{key}</code>
                                {isPrimitive ? (
                                  <span className="ml-2 font-mono">{display}</span>
                                ) : (
                                  <pre className="mt-1 bg-muted/30 p-2 rounded whitespace-pre-wrap break-words max-h-48 overflow-y-auto">{display}</pre>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* System prompt the judge model received — always
                        rendered when present (AH_JUDGE_DEBUG=1) so users
                        can confirm their saved evaluator prompt actually
                        flowed through. Capped height keeps a 20 KB prompt
                        from blowing out the page. */}
                    {liveReport.llmJudgeResponse?.judgeDebug?.systemPrompt && (
                      <div>
                        <div className="text-sm font-semibold mb-1.5">
                          System prompt the model received
                          <span className="text-xs font-normal text-muted-foreground ml-2">
                            ({liveReport.llmJudgeResponse.judgeDebug.systemPrompt.length.toLocaleString()} chars)
                          </span>
                        </div>
                        <pre className="text-xs bg-muted/30 p-3 rounded whitespace-pre-wrap break-words max-h-80 overflow-y-auto">
                          {liveReport.llmJudgeResponse.judgeDebug.systemPrompt}
                        </pre>
                      </div>
                    )}

                    {liveReport.llmJudgeResponse?.judgeDebug?.userPrompt && (
                      <div>
                        <div className="text-sm font-semibold mb-1.5">
                          User prompt
                          <span className="text-xs font-normal text-muted-foreground ml-2">
                            ({liveReport.llmJudgeResponse.judgeDebug.userPrompt.length.toLocaleString()} chars)
                          </span>
                        </div>
                        <pre className="text-xs bg-muted/30 p-3 rounded whitespace-pre-wrap break-words max-h-80 overflow-y-auto">
                          {liveReport.llmJudgeResponse.judgeDebug.userPrompt}
                        </pre>
                      </div>
                    )}

                    {liveReport.llmJudgeResponse?.rawResponse && (
                      <div>
                        <div className="text-sm font-semibold mb-1.5">
                          Raw judge response
                          <span className="text-xs font-normal text-muted-foreground ml-2">
                            ({liveReport.llmJudgeResponse.rawResponse.length.toLocaleString()} chars)
                          </span>
                        </div>
                        <pre className="text-xs bg-muted/30 p-3 rounded whitespace-pre-wrap break-words max-h-80 overflow-y-auto">
                          {liveReport.llmJudgeResponse.rawResponse}
                        </pre>
                      </div>
                    )}

                    {!liveReport.llmJudgeResponse?.judgeDebug && (
                      <p className="text-xs text-muted-foreground border-t pt-3">
                        Set <code>AH_JUDGE_DEBUG=1</code> on the server to capture the
                        system/user prompts the judge received on future runs.
                      </p>
                    )}
                  </CardContent>
                </Card>
              </div>
            )}
          </TabsContent>

          <TabsContent value="annotations" className="p-6 mt-0 space-y-4 overflow-y-auto">
            {/* Add Annotation — the tab itself is already labelled
               "Annotations", so we don't repeat the heading inside. */}
            <Card><CardContent className="p-4">
              <Textarea
                value={newAnnotation}
                onChange={(e) => setNewAnnotation(e.target.value)}
                placeholder="Add a note or observation about this run..."
                rows={3}
              />
              <div className="flex justify-end mt-2">
                <Button
                  onClick={handleAddAnnotation}
                  disabled={!newAnnotation.trim()}
                  className="bg-opensearch-blue hover:bg-blue-600"
                >
                  Add Annotation
                </Button>
              </div>
            </CardContent></Card>

            {/* Annotations List */}
            {annotations.length > 0 ? (
              <div className="space-y-3">
                {annotations.map(annotation => (
                  <Card key={annotation.id}><CardContent className="p-4">
                    <div className="flex items-start justify-between">
                      <p className="text-sm flex-1">{annotation.text}</p>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleDeleteAnnotation(annotation.id)}
                        className="ml-4 text-muted-foreground hover:text-red-400"
                      >
                        <X size={16} />
                      </Button>
                    </div>
                    <div className="mt-2 text-xs text-muted-foreground">
                      {formatDate(annotation.timestamp, 'detailed')}
                    </div>
                  </CardContent></Card>
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <MessageSquare size={48} className="mb-4 opacity-20" />
                <p>No annotations yet</p>
                <p className="text-sm mt-1">Add notes or observations about this run</p>
              </div>
            )}
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
};
