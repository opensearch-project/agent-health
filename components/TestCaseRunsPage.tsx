/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { ArrowLeft, Play, Calendar, CheckCircle2, XCircle, Trash2, FileText, Pencil, Loader2, X, AlertTriangle, Clock, Info } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { asyncTestCaseStorage, asyncRunStorage } from '@/services/storage';
import { TestCase, EvaluationReport } from '@/types';
import { DEFAULT_CONFIG } from '@/lib/constants';
import { RunScore } from '@/components/RunScore';
import { formatDate, formatRelativeTime } from '@/lib/utils';
import { QuickRunModal } from './QuickRunModal';
import { TestCaseEditor } from './TestCaseEditor';
import { TestCaseDetailPanel } from './TestCaseDetailPanel';
import { getJudgeVerdict, getTraceNotice } from '@/lib/reportVerdict';

// ==================== Sub-Components ====================

interface RunCardProps {
  run: EvaluationReport;
  isLatest: boolean;
  onClick: () => void;
  onDelete: () => void;
  isDeleting?: boolean;
}

export const RunCard = ({ run, isLatest, onClick, onDelete, isDeleting }: RunCardProps) => {
  const verdict = getJudgeVerdict(run);
  const traceNotice = getTraceNotice(run);
  // A real judge verdict always wins. metricsStatus is lifecycle/diagnostic
  // metadata and can only produce ERRORED when no verdict exists.
  const isErrored = !verdict && run.metricsStatus === 'error';
  const isPending = !verdict && !isErrored;
  const isPassed = verdict?.status === 'passed';
  const modelDisplayName = DEFAULT_CONFIG.models[run.modelName]?.display_name || run.modelName;

  const statusVisual = isErrored
    ? {
        ring: 'bg-amber-500/20',
        icon: <AlertTriangle size={20} className="text-amber-500" />,
        label: 'ERRORED',
        labelClass: 'text-amber-500',
      }
    : isPending
      ? {
          ring: 'bg-muted',
          icon: <Clock size={20} className="text-muted-foreground" />,
          label: 'PENDING',
          labelClass: 'text-muted-foreground',
        }
      : isPassed
        ? {
            ring: 'bg-opensearch-blue/20',
            icon: <CheckCircle2 size={20} className="text-opensearch-blue" />,
            label: 'PASSED',
            labelClass: 'text-opensearch-blue',
          }
        : {
            ring: 'bg-red-500/20',
            icon: <XCircle size={20} className="text-red-400" />,
            label: 'FAILED',
            labelClass: 'text-red-400',
          };

  return (
    <Card
      className="group hover:border-primary/50 transition-colors cursor-pointer"
      onClick={onClick}
    >
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4 flex-1">
            {/* Status Icon */}
            <div
              className={`p-2 rounded-full ${statusVisual.ring}`}
              title={isErrored ? 'Evaluator could not produce a judge verdict' : statusVisual.label}
              aria-label={isErrored ? 'Evaluator could not produce a judge verdict' : statusVisual.label}
            >
              {statusVisual.icon}
            </div>

            {/* Info */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className={`text-sm font-semibold ${statusVisual.labelClass}`}>
                  {statusVisual.label}
                </span>
                {isLatest && (
                  <Badge variant="outline" className="text-xs bg-blue-500/10 text-blue-400 border-blue-500/30">
                    Latest
                  </Badge>
                )}
                {traceNotice && (
                  <span
                    className={traceNotice.tone === 'warning' ? 'text-amber-500' : 'text-muted-foreground'}
                    title={`${traceNotice.title} — ${traceNotice.description}`}
                    aria-label={`${traceNotice.title}. ${traceNotice.description}`}
                    data-testid="metrics-diagnostic"
                  >
                    {traceNotice.tone === 'warning' ? <AlertTriangle size={13} /> : <Info size={13} />}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  <Calendar size={12} />
                  {formatRelativeTime(run.timestamp)}
                </span>
                <span>Model: {modelDisplayName}</span>
                <span>Agent: {run.agentName}</span>
              </div>
            </div>

            {/* Metrics */}
            <div className="flex items-center gap-4 text-sm">
              <div className="text-center">
                {/* Overall score = mean of every metric this run's evaluator
                    emitted, with a hover tooltip that lists each metric and
                    value. Replaces the previous hardcoded `accuracy` display
                    that read `0%` for any non-RCA-Default evaluator. */}
                <RunScore
                  report={run}
                  showLabel={false}
                  className="text-opensearch-blue font-semibold"
                />
                <div className="text-xs text-muted-foreground">Score</div>
              </div>
            </div>
          </div>

          {/* Delete Button */}
          <Button
            variant="ghost"
            size="icon"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            disabled={isDeleting}
            className="opacity-0 group-hover:opacity-100 text-red-400 hover:text-red-300 hover:bg-red-500/10 ml-2 disabled:opacity-100"
            title="Delete run"
          >
            {isDeleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};

const PageSkeleton = () => (
  <div className="p-6 h-full flex flex-col">
    <div className="flex items-center justify-between mb-6">
      <div className="flex items-center gap-4">
        <Skeleton className="h-10 w-10 rounded" />
        <div>
          <Skeleton className="h-8 w-[200px] mb-2" />
          <Skeleton className="h-4 w-[300px]" />
        </div>
      </div>
      <Skeleton className="h-10 w-[100px]" />
    </div>
    <div className="space-y-3">
      {[1, 2, 3].map((i) => (
        <Skeleton key={i} className="h-20 w-full" />
      ))}
    </div>
  </div>
);

const EmptyState = ({ onRun }: { onRun: () => void }) => (
  <Card className="border-dashed">
    <CardContent className="flex flex-col items-center justify-center py-12 text-muted-foreground">
      <FileText size={48} className="mb-4 opacity-20" />
      <p className="text-lg font-medium">No runs yet</p>
      <p className="text-sm mb-4">Run this test case to see results here</p>
      <Button onClick={onRun} className="bg-opensearch-blue hover:bg-blue-600">
        <Play size={16} className="mr-2" />
        Run Test
      </Button>
    </CardContent>
  </Card>
);

// ==================== Main Component ====================

export const TestCaseRunsPage: React.FC = () => {
  const { testCaseId } = useParams<{ testCaseId: string }>();
  const navigate = useNavigate();
  const location = useLocation();

  const [testCase, setTestCase] = useState<TestCase | null>(null);
  const [runs, setRuns] = useState<EvaluationReport[]>([]);
  const [totalRuns, setTotalRuns] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  // Modal states
  const [runningTestCase, setRunningTestCase] = useState<TestCase | null>(null);
  const [showEditor, setShowEditor] = useState(false);

  // Delete operation state
  const [deleteState, setDeleteState] = useState<{
    isDeleting: boolean;
    deletingId: string | null;
    status: 'idle' | 'success' | 'error';
    message: string;
  }>({ isDeleting: false, deletingId: null, status: 'idle', message: '' });

  const loadData = useCallback(async () => {
    if (!testCaseId) return;

    setIsLoading(true);
    try {
      const [tc, { reports, total }] = await Promise.all([
        asyncTestCaseStorage.getById(testCaseId),
        asyncRunStorage.getReportsByTestCase(testCaseId),
      ]);

      if (!tc) {
        navigate('/test-cases');
        return;
      }

      setTestCase(tc);
      setRuns(
        reports.sort(
          (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
        )
      );
      setTotalRuns(total);
    } catch (error) {
      console.error('Failed to load test case runs:', error);
    } finally {
      setIsLoading(false);
    }
  }, [testCaseId, navigate]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleRunClick = (run: EvaluationReport) => {
    navigate(`/runs/${run.id}`, {
      state: {
        from: `/test-cases/${testCaseId}/runs`,
        ...(location.state?.from && { parentFrom: location.state.from }),
      },
    });
  };

  const handleDeleteRun = async (run: EvaluationReport) => {
    if (!window.confirm(`Delete this run from ${formatDate(run.timestamp)}? This cannot be undone.`)) return;

    setDeleteState({ isDeleting: true, deletingId: run.id, status: 'idle', message: '' });

    try {
      const success = await asyncRunStorage.deleteReport(run.id);
      if (success) {
        setDeleteState({ isDeleting: false, deletingId: null, status: 'success', message: 'Run deleted successfully' });
        setTimeout(() => setDeleteState(s => ({ ...s, status: 'idle', message: '' })), 3000);
        loadData();
      } else {
        setDeleteState({ isDeleting: false, deletingId: null, status: 'error', message: 'Failed to delete run' });
      }
    } catch (error) {
      setDeleteState({
        isDeleting: false,
        deletingId: null,
        status: 'error',
        message: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });
    }
  };

  const handleRunModalClose = () => {
    setRunningTestCase(null);
    loadData();
  };

  const handleEditorSave = async () => {
    setShowEditor(false);
    loadData();
  };

  const loadMore = useCallback(async () => {
    if (!testCaseId || isLoadingMore) return;
    setIsLoadingMore(true);
    try {
      const { reports } = await asyncRunStorage.getReportsByTestCase(testCaseId, {
        limit: 100,
        offset: runs.length,
      });
      setRuns(prev => [...prev, ...reports.sort(
        (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      )]);
    } catch (error) {
      console.error('Failed to load more runs:', error);
    } finally {
      setIsLoadingMore(false);
    }
  }, [testCaseId, runs.length, isLoadingMore]);

  if (isLoading) {
    return <PageSkeleton />;
  }

  if (!testCase) {
    return null;
  }

  return (
    <div className="p-6 h-full flex flex-col" data-testid="test-case-runs-page">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate(location.state?.from ?? '/test-cases')} data-testid="back-button">
            <ArrowLeft size={18} />
          </Button>
          <div>
            <h2 className="text-2xl font-bold" data-testid="test-case-name">{testCase.name}</h2>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowEditor(true)}
          >
            <Pencil size={14} className="mr-1" />
            Edit
          </Button>
          <Button
            onClick={() => setRunningTestCase(testCase)}
            className="bg-opensearch-blue hover:bg-blue-600"
          >
            <Play size={16} className="mr-2" />
            Run Test
          </Button>
        </div>
      </div>

      {/* Main Content - Side by Side Layout */}
      <div className="flex gap-4 flex-1 overflow-hidden">
        {/* Left Panel - Test Case Details (30%) */}
        <div className="w-[30%] flex-shrink-0 overflow-y-auto border-r border-border pr-4">
          <TestCaseDetailPanel testCase={testCase} totalRuns={totalRuns} />
        </div>

        {/* Right Panel - Runs (70%) */}
        <div className="flex-1 overflow-y-auto space-y-3">
          {/* Delete Feedback */}
          {deleteState.message && (
            <div className={`flex items-center gap-2 text-sm p-3 rounded-lg ${
              deleteState.status === 'success'
                ? 'bg-green-500/10 text-green-400 border border-green-500/20'
                : 'bg-red-500/10 text-red-400 border border-red-500/20'
            }`}>
              {deleteState.status === 'success' ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
              <span>{deleteState.message}</span>
              {deleteState.status === 'error' && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDeleteState(s => ({ ...s, status: 'idle', message: '' }))}
                  className="ml-auto h-6 px-2"
                >
                  <X size={14} />
                </Button>
              )}
            </div>
          )}

          {runs.length === 0 ? (
            <EmptyState onRun={() => setRunningTestCase(testCase)} />
          ) : (
            <>
              {runs.map((run, index) => (
                <RunCard
                  key={run.id}
                  run={run}
                  isLatest={index === 0}
                  onClick={() => handleRunClick(run)}
                  onDelete={() => handleDeleteRun(run)}
                  isDeleting={deleteState.isDeleting && deleteState.deletingId === run.id}
                />
              ))}
              {runs.length < totalRuns && !isLoadingMore && (
                <div className="flex justify-center pt-4">
                  <Button variant="outline" onClick={loadMore}>
                    Load More
                  </Button>
                </div>
              )}
              {isLoadingMore && (
                <div className="flex justify-center pt-4">
                  <Loader2 size={20} className="animate-spin text-muted-foreground" />
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Quick Run Modal */}
      {runningTestCase && (
        <QuickRunModal
          testCase={runningTestCase}
          onClose={handleRunModalClose}
          onSaveAsTestCase={() => {}}
        />
      )}

      {/* Editor Modal */}
      {showEditor && (
        <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm">
          <div className="fixed inset-4 z-50 overflow-auto bg-background border rounded-lg shadow-lg">
            <TestCaseEditor
              testCase={testCase}
              onSave={handleEditorSave}
              onCancel={() => setShowEditor(false)}
            />
          </div>
        </div>
      )}
    </div>
  );
};
