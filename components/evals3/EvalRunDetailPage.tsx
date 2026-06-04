/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * EvalRunDetailPage — Unified evaluation run detail page.
 *
 * Shows run metadata, source badges, per-test-case results grid,
 * and "Convert to Benchmark" button for ad-hoc runs.
 *
 * Route: /evaluations/runs/:runId
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Loader2, CheckCircle2, XCircle, Clock, AlertTriangle,
  ChevronDown, ChevronRight, ArrowLeft, Bookmark,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { EvaluationRun, TestCaseSnapshot } from '@/types';
import { DEFAULT_CONFIG } from '@/lib/constants';
import { formatRelativeTime, getModelName } from '@/lib/utils';
import {
  getEvaluationRun,
  cancelEvaluationRun,
  promoteEvaluationRun,
} from '@/services/client/evaluationRunsApi';
import { Breadcrumbs } from './Breadcrumbs';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    completed: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
    running: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
    failed: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
    cancelled: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300',
    pending: 'bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-300',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${colors[status] || colors.pending}`}>
      {status}
    </span>
  );
}

function SourceBadge({ source }: { source: any }) {
  const labels: Record<string, string> = {
    'benchmark': 'Benchmark',
    'test-case-ids': 'Test Cases',
    'file-import': 'File',
    'directory-import': 'Directory',
    'label-filter': 'Labels',
  };
  return (
    <Badge variant="outline" className="text-xs">
      {labels[source.type] || source.type}
    </Badge>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────

export const EvalRunDetailPage: React.FC = () => {
  const { runId } = useParams<{ runId: string }>();
  const navigate = useNavigate();

  const [run, setRun] = useState<EvaluationRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [configOpen, setConfigOpen] = useState(false);
  const [promoteOpen, setPromoteOpen] = useState(false);
  const [promoteName, setPromoteName] = useState('');
  const [promoting, setPromoting] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const loadRun = useCallback(async () => {
    if (!runId) return;
    setLoading(true);
    try {
      const data = await getEvaluationRun(runId);
      setRun(data);
      setError(null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => { loadRun(); }, [loadRun]);

  // Poll for updates if running
  useEffect(() => {
    if (!run || run.status !== 'running') return;
    const interval = setInterval(loadRun, 3000);
    return () => clearInterval(interval);
  }, [run?.status, loadRun]);

  const handleCancel = async () => {
    if (!runId) return;
    setCancelling(true);
    try {
      await cancelEvaluationRun(runId);
      await loadRun();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setCancelling(false);
    }
  };

  const handlePromote = async () => {
    if (!runId || !promoteName.trim()) return;
    setPromoting(true);
    try {
      await promoteEvaluationRun(runId, promoteName.trim());
      setPromoteOpen(false);
      await loadRun();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setPromoting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex-1 p-6 space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (error || !run) {
    return (
      <div className="flex-1 p-6">
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4">
          <p className="text-red-800 dark:text-red-300">{error || 'Run not found'}</p>
          <Button variant="outline" size="sm" className="mt-2" onClick={() => navigate('/evaluations/runs')}>
            <ArrowLeft size={14} className="mr-1" /> Back to Runs
          </Button>
        </div>
      </div>
    );
  }

  const agentName = DEFAULT_CONFIG.agents.find(a => a.key === run.agentKey)?.name || run.agentKey;
  const modelName = getModelName(run.modelId);
  const stats = run.stats || { passed: 0, failed: 0, total: 0, pending: 0, errored: 0 };
  const errored = stats.errored ?? 0;
  // Pass rate ignores errored runs entirely (issue #242): they had no
  // verdict, so neither numerator nor denominator should include them.
  const evaluable = Math.max(0, stats.total - errored);
  const passRate = evaluable > 0 ? Math.round((stats.passed / evaluable) * 100) : 0;

  const results = Object.entries(run.results || {}).map(([testCaseId, result]) => {
    const snapshot = run.testCaseSnapshots?.find(s => s.id === testCaseId);
    return { testCaseId, name: snapshot?.name || testCaseId, ...result };
  });

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {/* Breadcrumbs */}
        <Breadcrumbs items={[
          { label: 'Runs', href: '/evaluations/runs' },
          { label: run.name || run.id },
        ]} />

        {/* Header Card */}
        <div className="bg-card border rounded-lg p-5 space-y-4">
          <div className="flex items-start justify-between">
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="text-xs bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-300 border-purple-200 dark:border-purple-700">
                  EVALUATION RUN
                </Badge>
                <StatusBadge status={run.status} />
                {run.trigger && (
                  <Badge variant="secondary" className="text-xs">{run.trigger}</Badge>
                )}
              </div>
              <h1 className="text-xl font-semibold">{run.name || `Run ${run.id.slice(0, 8)}`}</h1>
              <div className="flex items-center gap-4 text-sm text-muted-foreground">
                <span>{agentName}</span>
                <span>{modelName}</span>
                <span>{formatRelativeTime(run.createdAt)}</span>
                {run.completedAt && (
                  <span>Duration: {Math.round((new Date(run.completedAt).getTime() - new Date(run.createdAt).getTime()) / 1000)}s</span>
                )}
              </div>
            </div>

            {/* Actions */}
            <div className="flex items-center gap-2">
              {run.status === 'running' && (
                <Button variant="destructive" size="sm" onClick={handleCancel} disabled={cancelling}>
                  {cancelling ? <Loader2 size={14} className="mr-1 animate-spin" /> : null}
                  Cancel
                </Button>
              )}
              {!run.benchmarkId && run.status === 'completed' && (
                <Button variant="outline" size="sm" onClick={() => setPromoteOpen(true)}>
                  <Bookmark size={14} className="mr-1" /> Convert to Benchmark
                </Button>
              )}
              {run.benchmarkId && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => navigate(`/evaluations/benchmarks/${run.benchmarkId}/runs`)}
                >
                  View Benchmark
                </Button>
              )}
            </div>
          </div>

          {/* Stats Row */}
          <div className="flex items-center gap-6 pt-2 border-t">
            <div className="text-center">
              <div className="text-2xl font-bold text-green-600">{stats.passed}</div>
              <div className="text-xs text-muted-foreground">Passed</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-red-600">{stats.failed}</div>
              <div className="text-xs text-muted-foreground">Failed</div>
            </div>
            {errored > 0 && (
              <div
                className="text-center"
                title="Evaluator could not produce a verdict (e.g. judge validation error). Excluded from pass-rate."
              >
                <div className="text-2xl font-bold text-amber-600">{errored}</div>
                <div className="text-xs text-muted-foreground">Errored</div>
              </div>
            )}
            <div className="text-center">
              <div className="text-2xl font-bold">{stats.total}</div>
              <div className="text-xs text-muted-foreground">Total</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold">{passRate}%</div>
              <div className="text-xs text-muted-foreground">
                Pass Rate{errored > 0 ? ' †' : ''}
              </div>
            </div>
          </div>
          {errored > 0 && (
            <div className="text-[11px] text-muted-foreground -mt-2">
              † Pass rate excludes {errored} errored run{errored === 1 ? '' : 's'} (evaluator could not produce a verdict).
            </div>
          )}

          {/* Sources */}
          {run.sources && run.sources.length > 0 && (
            <div className="flex items-center gap-2 pt-2 border-t">
              <span className="text-xs text-muted-foreground">Sources:</span>
              {run.sources.map((s, i) => <SourceBadge key={i} source={s} />)}
            </div>
          )}
        </div>

        {/* Config Section */}
        <div className="bg-card border rounded-lg">
          <button
            className="w-full flex items-center justify-between p-3 hover:bg-muted/50 transition-colors"
            onClick={() => setConfigOpen(!configOpen)}
          >
            <span className="text-sm font-medium">Run Configuration</span>
            {configOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </button>
          {configOpen && (
            <div className="p-3 border-t text-sm space-y-1">
              <div><span className="text-muted-foreground">Agent:</span> {agentName} ({run.agentKey})</div>
              <div><span className="text-muted-foreground">Model:</span> {modelName} ({run.modelId})</div>
              {run.evaluatorId && <div><span className="text-muted-foreground">Evaluator:</span> {run.evaluatorId}</div>}
              <div><span className="text-muted-foreground">Concurrency:</span> {run.concurrency || 1}</div>
              {run.benchmarkId && <div><span className="text-muted-foreground">Benchmark:</span> {run.benchmarkId}</div>}
            </div>
          )}
        </div>

        {/* Results Table */}
        <div className="bg-card border rounded-lg overflow-hidden">
          <div className="p-3 border-b">
            <h2 className="text-sm font-medium">Test Case Results ({results.length})</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/30">
                  <th className="text-left p-2 font-medium text-xs text-muted-foreground">Test Case</th>
                  <th className="text-left p-2 font-medium text-xs text-muted-foreground">Status</th>
                  <th className="text-left p-2 font-medium text-xs text-muted-foreground">Report</th>
                  <th className="text-left p-2 font-medium text-xs text-muted-foreground">Error</th>
                </tr>
              </thead>
              <tbody>
                {results.map(r => (
                  <tr key={r.testCaseId} className="border-b last:border-0 hover:bg-muted/20">
                    <td className="p-2 font-medium">{r.name}</td>
                    <td className="p-2">
                      <span className="inline-flex items-center gap-1">
                        {r.status === 'completed' && <CheckCircle2 size={14} className="text-green-600" />}
                        {r.status === 'failed' && <XCircle size={14} className="text-red-600" />}
                        {r.status === 'running' && <Loader2 size={14} className="text-blue-600 animate-spin" />}
                        {r.status === 'pending' && <Clock size={14} className="text-gray-400" />}
                        <span className="text-xs">{r.status}</span>
                      </span>
                    </td>
                    <td className="p-2">
                      {r.reportId ? (
                        <Button
                          variant="link"
                          size="sm"
                          className="h-auto p-0 text-xs"
                          onClick={() => navigate(`/evaluations/runs/${runId}/inspect?reportId=${r.reportId}`)}
                        >
                          View
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="p-2 text-xs text-red-600 max-w-xs truncate">{r.error || ''}</td>
                  </tr>
                ))}
                {results.length === 0 && (
                  <tr>
                    <td colSpan={4} className="p-4 text-center text-muted-foreground">
                      {run.status === 'running' ? 'Execution in progress...' : 'No results'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Promote Dialog */}
      <Dialog open={promoteOpen} onOpenChange={setPromoteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Convert to Benchmark</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This will create a named benchmark from the test cases in this run.
            If a benchmark with this name exists, its test case list will be updated.
          </p>
          <Input
            placeholder="Benchmark name"
            value={promoteName}
            onChange={e => setPromoteName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handlePromote()}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setPromoteOpen(false)}>Cancel</Button>
            <Button onClick={handlePromote} disabled={!promoteName.trim() || promoting}>
              {promoting ? <Loader2 size={14} className="mr-1 animate-spin" /> : null}
              Create Benchmark
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
