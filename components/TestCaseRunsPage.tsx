/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Play, Calendar, CheckCircle2, XCircle, Trash2, FileText, Pencil, Loader2, X } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { asyncTestCaseStorage, asyncRunStorage } from '@/services/storage';
import { TestCase, EvaluationReport } from '@/types';
import { DEFAULT_CONFIG } from '@/lib/constants';
import { getLabelColor, formatDate, formatRelativeTime } from '@/lib/utils';
import { QuickRunModal } from './QuickRunModal';
import { TestCaseEditor } from './TestCaseEditor';

// ==================== Sub-Components ====================

interface RunCardProps {
  run: EvaluationReport;
  isLatest: boolean;
  onClick: () => void;
  onDelete: () => void;
  isDeleting?: boolean;
}

const RunCard = ({ run, isLatest, onClick, onDelete, isDeleting }: RunCardProps) => {
  const isPassed = run.passFailStatus === 'passed';
  const modelDisplayName = DEFAULT_CONFIG.models[run.modelName]?.display_name || run.modelName;

  return (
    <Card
      className="group hover:border-primary/50 transition-colors cursor-pointer"
      onClick={onClick}
    >
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4 flex-1">
            {/* Status Icon */}
            <div className={`p-2 rounded-full ${isPassed ? 'bg-opensearch-blue/20' : 'bg-red-500/20'}`}>
              {isPassed ? (
                <CheckCircle2 size={20} className="text-opensearch-blue" />
              ) : (
                <XCircle size={20} className="text-red-400" />
              )}
            </div>

            {/* Info */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className={`text-sm font-semibold ${isPassed ? 'text-opensearch-blue' : 'text-red-400'}`}>
                  {isPassed ? 'PASSED' : 'FAILED'}
                </span>
                {isLatest && (
                  <Badge variant="outline" className="text-xs bg-blue-500/10 text-blue-400 border-blue-500/30">
                    Latest
                  </Badge>
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
                <div className="text-opensearch-blue font-semibold">{run.metrics.accuracy}%</div>
                <div className="text-xs text-muted-foreground">Accuracy</div>
              </div>
              <div className="text-center">
                <div className="text-blue-400 font-semibold">{run.metrics.faithfulness}%</div>
                <div className="text-xs text-muted-foreground">Faithfulness</div>
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

  const [testCase, setTestCase] = useState<TestCase | null>(null);
  const [runs, setRuns] = useState<EvaluationReport[]>([]);
  const [isLoading, setIsLoading] = useState(true);

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
      const [tc, reports] = await Promise.all([
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
    navigate(`/runs/${run.id}`);
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
          <Button variant="ghost" size="icon" onClick={() => navigate('/test-cases')} data-testid="back-button">
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
        <div className="w-[30%] flex-shrink-0 overflow-y-auto border-r border-border pr-4 space-y-4">
          {/* Labels */}
          {(testCase.labels || []).length > 0 && (
            <div className="space-y-1">
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Labels</h4>
              <div className="flex items-center gap-2 flex-wrap">
                {testCase.labels.map((label) => (
                  <Badge key={label} variant="outline" className={getLabelColor(label)}>
                    {label}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {/* Metadata */}
          <div className="space-y-1 text-xs text-muted-foreground">
            <div className="flex items-center gap-2">
              <Calendar size={12} />
              <span>Created {formatDate(testCase.createdAt)}</span>
            </div>
            <div className="flex items-center gap-2">
              <Play size={12} />
              <span>{runs.length} run{runs.length !== 1 ? 's' : ''}</span>
            </div>
          </div>

          {/* Description */}
          {testCase.description && (
            <div className="space-y-1">
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Description</h4>
              <p className="text-sm text-muted-foreground">{testCase.description}</p>
            </div>
          )}

          {/* Initial Prompt */}
          <div className="space-y-1">
            <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Prompt</h4>
            <Card className="bg-muted/30">
              <CardContent className="p-3">
                <p className="text-sm whitespace-pre-wrap">{testCase.initialPrompt}</p>
              </CardContent>
            </Card>
          </div>

          {/* Expected Outcomes */}
          {testCase.expectedOutcomes && testCase.expectedOutcomes.length > 0 && (
            <div className="space-y-1">
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Expected Outcomes</h4>
              <ul className="space-y-1">
                {testCase.expectedOutcomes.map((outcome, i) => (
                  <li key={i} className="text-sm text-muted-foreground flex items-start gap-2">
                    <span className="text-opensearch-blue mt-0.5">•</span>
                    <span>{outcome}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Context */}
          {testCase.context && testCase.context.length > 0 && (
            <div className="space-y-1">
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Context ({testCase.context.length})</h4>
              <div className="space-y-2">
                {testCase.context.map((ctx, i) => (
                  <Card key={i} className="bg-muted/30">
                    <CardContent className="p-2">
                      <p className="text-xs font-medium text-muted-foreground mb-1">{ctx.description}</p>
                      <pre className="text-xs overflow-x-auto max-h-20 overflow-y-auto">{ctx.value.slice(0, 200)}{ctx.value.length > 200 ? '...' : ''}</pre>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          )}

          {/* Tools */}
          {testCase.tools && testCase.tools.length > 0 && (
            <div className="space-y-1">
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Tools ({testCase.tools.length})</h4>
              <div className="flex flex-wrap gap-1">
                {testCase.tools.map((tool, i) => (
                  <Badge key={i} variant="secondary" className="text-xs">
                    {tool.name}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {/* Expected PPL */}
          {testCase.expectedPPL && (
            <div className="space-y-1">
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Expected PPL</h4>
              <Card className="bg-muted/30">
                <CardContent className="p-2">
                  <pre className="text-xs overflow-x-auto">{testCase.expectedPPL}</pre>
                </CardContent>
              </Card>
            </div>
          )}
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
            runs.map((run, index) => (
              <RunCard
                key={run.id}
                run={run}
                isLatest={index === 0}
                onClick={() => handleRunClick(run)}
                onDelete={() => handleDeleteRun(run)}
                isDeleting={deleteState.isDeleting && deleteState.deletingId === run.id}
              />
            ))
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
