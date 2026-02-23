/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo } from 'react';
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
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { EvaluationReport, RunAnnotation, TestCase, Span, TimeRange, TraceMetrics } from '@/types';
import { fetchRunMetrics, formatCost, formatDuration, formatTokens } from '@/services/metrics';
import { TrajectoryView } from './TrajectoryView';
import { RawEventsPanel } from './RawEventsPanel';
import TraceVisualization from './traces/TraceVisualization';
import ViewToggle, { ViewMode } from './traces/ViewToggle';
import TraceFullScreenView from './traces/TraceFullScreenView';
import { computeTrajectoryFromRawEvents } from '@/services/agent';
import { fetchTracesByRunIds, processSpansIntoTree, calculateTimeRange } from '@/services/traces';
import { DEFAULT_CONFIG } from '@/lib/constants';
import { formatDate, getLabelColor, getDifficultyColor } from '@/lib/utils';
import { asyncRunStorage, asyncTestCaseStorage } from '@/services/storage';
import { callBedrockJudge } from '@/services/evaluation';
import { tracePollingManager } from '@/services/traces/tracePoller';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';

interface RunDetailsContentProps {
  report: EvaluationReport;
  className?: string;
  showViewAllReports?: boolean;
  onViewAllReports?: () => void;
  onEditTestCase?: (testCase: TestCase) => void;
}

export const RunDetailsContent: React.FC<RunDetailsContentProps> = ({
  report,
  className = '',
  showViewAllReports = false,
  onViewAllReports,
  onEditTestCase,
}) => {
  const [annotations, setAnnotations] = useState<RunAnnotation[]>([]);
  const [newAnnotation, setNewAnnotation] = useState('');
  const [testCase, setTestCase] = useState<TestCase | null>(null);
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
  const [activeTab, setActiveTab] = useState('summary');
  const [traceViewMode, setTraceViewMode] = useState<ViewMode>('info');
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

  // Auto-recover trace polling for pending reports when page loads
  // This handles the case where the browser was closed before polling completed
  useEffect(() => {
    // Only for pending trace-mode reports with a runId
    if (liveReport.metricsStatus !== 'pending' || !liveReport.runId || !testCase) return;

    // Check if polling is already running for this report
    const existingState = tracePollingManager.getState(liveReport.id);
    if (existingState?.running) {
      console.info('[RunDetails] Polling already running for report:', liveReport.id);
      return;
    }

    console.info('[RunDetails] Starting auto-recovery polling for pending report:', liveReport.id);

    // Start/resume polling with callbacks
    tracePollingManager.startPolling(
      liveReport.id,
      liveReport.runId,
      {
        onTracesFound: async (spans, updatedReport) => {
          console.info(`[RunDetails] Traces found for report ${liveReport.id}: ${spans.length} spans`);

          try {
            // Call the Bedrock judge with the trajectory and expectedOutcomes
            // Resolve model key to full Bedrock model ID
            const judgeModelId = liveReport.modelId
              ? (DEFAULT_CONFIG.models[liveReport.modelId]?.model_id || liveReport.modelId)
              : undefined;
            console.info(`[RunDetails] Calling Bedrock judge for report ${liveReport.id} with model: ${judgeModelId || '(default)'}`);

            const judgment = await callBedrockJudge(
              updatedReport.trajectory,
              {
                expectedOutcomes: testCase.expectedOutcomes,
                expectedTrajectory: testCase.expectedTrajectory,
              },
              [], // No logs for trace-mode
              (chunk) => console.debug('[RunDetails] Judge progress:', chunk.slice(0, 100)),
              judgeModelId
            );

            console.info(`[RunDetails] Judge result: ${judgment.passFailStatus}, accuracy: ${judgment.metrics.accuracy}%`);

            // Update report with judge results
            await asyncRunStorage.updateReport(liveReport.id, {
              metricsStatus: 'ready',
              passFailStatus: judgment.passFailStatus,
              metrics: judgment.metrics,
              llmJudgeReasoning: judgment.llmJudgeReasoning,
              improvementStrategies: judgment.improvementStrategies,
            });

            // Update local state
            const freshReport = await asyncRunStorage.getReportById(liveReport.id);
            if (freshReport) {
              setLiveReport(freshReport);
            }

            console.info(`[RunDetails] Report ${liveReport.id} updated with judge results`);
          } catch (error) {
            console.error(`[RunDetails] Failed to judge report ${liveReport.id}:`, error);
            await asyncRunStorage.updateReport(liveReport.id, {
              metricsStatus: 'error',
              traceError: `Judge evaluation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
            });

            // Update local state
            const freshReport = await asyncRunStorage.getReportById(liveReport.id);
            if (freshReport) {
              setLiveReport(freshReport);
            }
          }
        },
        onAttempt: (attempt, maxAttempts) => {
          console.info(`[RunDetails] Polling attempt ${attempt}/${maxAttempts} for report ${liveReport.id}`);
        },
        onError: (error) => {
          console.error(`[RunDetails] Trace polling failed for report ${liveReport.id}:`, error);
        },
      }
    );

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
  }, [report.runId, isTraceMode]);

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
      console.info('[RunDetails] Fetching traces for runId:', report.runId);
      const result = await fetchTracesByRunIds([report.runId]);
      
      console.info('[RunDetails] Trace fetch result:', {
        spansCount: result.spans?.length || 0,
        total: result.total,
        warning: result.warning,
        hasSpans: !!(result.spans && result.spans.length > 0)
      });

      if (result.spans && result.spans.length > 0) {
        setTraceSpans(result.spans);
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
      {/* Header */}
      <div className="bg-card border-b p-4">
        <div className="flex items-start justify-between mb-3">
          <h2 className="text-xl font-semibold">{testCase?.name || 'Unknown Test Case'}</h2>
          <p className="text-xs text-muted-foreground">
            Report ID: <span className="font-mono">{report.id}</span>
          </p>
        </div>

        {/* Trace Mode: Waiting for traces banner */}
        {!reportLoading && liveReport.metricsStatus === 'pending' && (
          <Card className="bg-yellow-50 dark:bg-yellow-500/10 border-yellow-300 dark:border-yellow-500/30 mt-4">
            <CardContent className="p-3 flex items-center gap-3">
              <Loader2 className="animate-spin text-yellow-700 dark:text-yellow-400" size={18} />
              <div>
                <div className="text-sm font-medium text-yellow-700 dark:text-yellow-400">Waiting for traces to become available...</div>
                <div className="text-xs text-muted-foreground">
                  Traces take ~5 minutes to propagate after the run completes.
                  {liveReport.traceFetchAttempts && (
                    <span className="ml-2">
                      (Attempt {liveReport.traceFetchAttempts}/20)
                    </span>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Trace Mode: Error state */}
        {liveReport.metricsStatus === 'error' && (
          <Card className="bg-red-50 dark:bg-red-500/10 border-red-300 dark:border-red-500/30 mt-4">
            <CardContent className="p-3 flex items-center gap-3">
              <AlertCircle className="text-red-700 dark:text-red-400" size={18} />
              <div>
                <div className="text-sm font-medium text-red-700 dark:text-red-400">Failed to fetch traces</div>
                <div className="text-xs text-muted-foreground">
                  {liveReport.traceError || 'Unknown error'}
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Trace Mode: Spans received */}
        {liveReport.spans && liveReport.spans.length > 0 && (
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
        <div className={`grid gap-2 ${isTraceMode ? 'grid-cols-10' : 'grid-cols-8'}`}>
          <Card className="bg-muted/50 col-span-2">
            <CardContent className="p-2">
              <div className="text-[10px] text-muted-foreground mb-0.5">Status</div>
              {reportLoading ? (
                <Loader2 className="animate-spin text-muted-foreground" size={12} />
              ) : liveReport.metricsStatus === 'pending' ? (
                <div className="flex items-center gap-1 text-xs font-semibold text-yellow-700 dark:text-yellow-400">
                  <Clock size={12} />
                  PENDING
                </div>
              ) : (
                <div className={`flex items-center gap-1 text-xs font-semibold ${
                  liveReport.passFailStatus === 'passed' ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400'
                }`}>
                  {liveReport.passFailStatus === 'passed' ? (
                    <CheckCircle2 size={12} />
                  ) : (
                    <XCircle size={12} />
                  )}
                  {liveReport.passFailStatus?.toUpperCase() || liveReport.status.toUpperCase()}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="bg-muted/50 col-span-2">
            <CardContent className="p-2">
              <div className="text-[10px] text-muted-foreground mb-0.5">Accuracy</div>
              <div className="text-xs font-semibold text-blue-700 dark:text-blue-400">{liveReport.metrics.accuracy}%</div>
            </CardContent>
          </Card>

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
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col overflow-hidden">
        <TabsList className="w-full justify-start rounded-none border-b bg-card h-auto p-0">
          <TabsTrigger value="summary" className="rounded-none border-b-2 border-transparent data-[state=active]:border-opensearch-blue data-[state=active]:text-opensearch-blue">
            <FileText size={14} className="mr-2" /> Summary
          </TabsTrigger>
          <TabsTrigger value="trajectory" className="rounded-none border-b-2 border-transparent data-[state=active]:border-opensearch-blue data-[state=active]:text-opensearch-blue">
            <GitBranch size={14} className="mr-2" /> Conversation History
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
            <Scale size={14} className="mr-2" /> LLM Judge
          </TabsTrigger>
          <TabsTrigger value="annotations" className="rounded-none border-b-2 border-transparent data-[state=active]:border-opensearch-blue data-[state=active]:text-opensearch-blue">
            <MessageSquare size={14} className="mr-2" /> Annotations
            {annotations.length > 0 && <Badge variant="secondary" className="ml-2">{annotations.length}</Badge>}
          </TabsTrigger>
        </TabsList>

        <ScrollArea className="flex-1">
          <TabsContent value="summary" className="p-6 mt-0 space-y-6">
            {/* Run Info */}
            <div>
              <h3 className="text-lg font-semibold mb-3">Run Information</h3>
              <div className="grid grid-cols-2 gap-4">
                <Card><CardContent className="p-4">
                  <div className="text-xs text-muted-foreground mb-1">Agent</div>
                  <div className="text-sm">{report.agentName}</div>
                </CardContent></Card>
                <Card><CardContent className="p-4">
                  <div className="text-xs text-muted-foreground mb-1">Model</div>
                  <div className="text-sm">{modelDisplayName}</div>
                </CardContent></Card>
                <Card><CardContent className="p-4">
                  <div className="text-xs text-muted-foreground mb-1">Timestamp</div>
                  <div className="text-sm flex items-center">
                    <Clock size={12} className="mr-1.5 text-muted-foreground" />
                    {formatDate(report.timestamp, 'detailed')}
                  </div>
                </CardContent></Card>
                <Card><CardContent className="p-4">
                  <div className="text-xs text-muted-foreground mb-1">Total Steps</div>
                  <div className="text-sm">{trajectory.length}</div>
                </CardContent></Card>
              </div>

              {/* View All Reports Link */}
              {showViewAllReports && onViewAllReports && (
                <Button
                  variant="link"
                  onClick={onViewAllReports}
                  className="mt-4 p-0 h-auto text-opensearch-blue hover:text-emerald-300"
                >
                  View all reports <ExternalLink size={14} className="ml-1" />
                </Button>
              )}
            </div>

            {/* Test Case Info */}
            {testCase && (
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-lg font-semibold">Test Case Details</h3>
                  {onEditTestCase && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onEditTestCase(testCase)}
                      className="gap-1.5"
                    >
                      <Pencil size={14} />
                      Edit Test Case
                    </Button>
                  )}
                </div>
                <Card><CardContent className="p-4 space-y-4">
                  {/* Header with badges */}
                  <div className="flex items-center gap-3 flex-wrap">
                    <Badge variant="outline" className={getDifficultyColor(testCase.difficulty)}>
                      {testCase.difficulty}
                    </Badge>
                    <Badge variant="outline" className={getLabelColor(`category:${testCase.category}`)}>
                      {testCase.category}
                    </Badge>
                    {testCase.subcategory && (
                      <Badge variant="outline" className={getLabelColor(`subcategory:${testCase.subcategory}`)}>
                        {testCase.subcategory}
                      </Badge>
                    )}
                    <Badge variant="outline" className="bg-slate-500/5 text-slate-400 border-slate-500/20">
                      <Hash size={10} className="mr-1" />
                      v{testCase.currentVersion || 1}
                    </Badge>
                  </div>

                  {/* Description */}
                  {testCase.description && (
                    <p className="text-sm text-muted-foreground">{testCase.description}</p>
                  )}

                  {/* Initial Prompt */}
                  <Card className="bg-muted/50"><CardContent className="p-3">
                    <div className="text-xs text-muted-foreground mb-1.5">Initial Prompt</div>
                    <p className="text-sm">{testCase.initialPrompt}</p>
                  </CardContent></Card>

                  {/* Expected Outcomes */}
                  {testCase.expectedOutcomes && testCase.expectedOutcomes.length > 0 && (
                    <div>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
                        <Target size={12} />
                        Expected Outcomes ({testCase.expectedOutcomes.length})
                      </div>
                      <div className="space-y-2">
                        {testCase.expectedOutcomes.map((outcome, index) => (
                          <div
                            key={index}
                            className="flex items-start gap-2 text-sm pl-2 border-l-2 border-opensearch-blue/30"
                          >
                            <CheckCircle2 size={14} className="text-opensearch-blue mt-0.5 shrink-0" />
                            <span>{outcome}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Context (if any) */}
                  {testCase.context && testCase.context.length > 0 && (
                    <div>
                      <div className="text-xs text-muted-foreground mb-2">
                        Context ({testCase.context.length} items)
                      </div>
                      <div className="space-y-2">
                        {testCase.context.map((ctx, index) => (
                          <Card key={index} className="bg-muted/30">
                            <CardContent className="p-2">
                              <div className="text-xs text-muted-foreground">{ctx.description}</div>
                              <div className="text-sm font-mono truncate" title={ctx.value}>
                                {ctx.value.slice(0, 100) + (ctx.value.length > 100 ? '...' : '')}
                              </div>
                            </CardContent>
                          </Card>
                        ))}
                      </div>
                    </div>
                  )}
                </CardContent></Card>
              </div>
            )}

          </TabsContent>

          <TabsContent value="trajectory" className="p-6 mt-0">
            {/* Header with Toggle */}
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold">Conversation History</h3>
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

          <TabsContent value="logs" className="p-6 mt-0 flex-1 flex flex-col min-h-0">
            {isTraceMode ? (
              /* TRACE MODE: Show trace visualization */
              <div className="space-y-4 flex-1 flex flex-col min-h-0">
                <div className="flex items-center justify-between flex-shrink-0">
                  <h3 className="text-lg font-semibold">Traces</h3>
                  {spanTree.length > 0 && !tracesLoading && (
                    <ViewToggle viewMode={traceViewMode} onChange={setTraceViewMode} />
                  )}
                </div>

                {/* Loading state */}
                {tracesLoading && (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 className="animate-spin mr-2" size={20} />
                    <span className="text-muted-foreground">Loading traces...</span>
                  </div>
                )}

                {/* Error state */}
                {tracesError && !tracesLoading && (
                  <Card className="bg-red-500/10 border-red-500/30">
                    <CardContent className="p-4 flex items-center gap-3">
                      <AlertCircle className="text-red-400" size={18} />
                      <div>
                        <div className="text-sm font-medium text-red-400">Failed to load traces</div>
                        <div className="text-xs text-muted-foreground">{tracesError}</div>
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

                {/* Trace visualization */}
                {spanTree.length > 0 && !tracesLoading && (
                  <div className="space-y-4 flex-1 flex flex-col min-h-0">
                    <Card className="flex-1 flex flex-col min-h-0">
                      <CardContent className="p-0 flex-1 flex flex-col min-h-0">
                        <div className="flex-1 min-h-0">
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
                            showSpanDetailsPanel={true}
                            runId={report.runId}
                          />
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
                          <span className={`text-xs font-semibold ${
                            log.level === 'ERROR' ? 'text-red-400' :
                            log.level === 'WARN' ? 'text-yellow-400' :
                            'text-muted-foreground'
                          }`}>
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

          <TabsContent value="judge" className="p-6 mt-0 space-y-6">
            {/* LLM Judge Reasoning */}
            <div>
              <h3 className="text-lg font-semibold mb-3">LLM Judge Reasoning</h3>
              <Card><CardContent className="p-4">
                <div className="prose dark:prose-invert max-w-none prose-headings:text-sm prose-p:text-sm prose-p:leading-relaxed prose-code:text-opensearch-blue prose-code:bg-muted prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-xs prose-ul:text-sm prose-ol:text-sm">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {liveReport.llmJudgeReasoning}
                  </ReactMarkdown>
                </div>
              </CardContent></Card>
            </div>

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
          </TabsContent>

          <TabsContent value="annotations" className="p-6 mt-0 space-y-4">
            <h3 className="text-lg font-semibold mb-4">Annotations</h3>

            {/* Add Annotation */}
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
        </ScrollArea>
      </Tabs>
    </div>
  );
};
