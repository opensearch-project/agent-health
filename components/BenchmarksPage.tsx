/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Trash2, Eye, Calendar, FlaskConical, RefreshCw, CheckCircle, CheckCircle2, XCircle, Loader2, Circle, X, Play, Pencil, StopCircle, Ban, Upload, Download } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { asyncBenchmarkStorage, asyncTestCaseStorage } from '@/services/storage';
import { validateTestCasesArrayJson } from '@/lib/testCaseValidation';
import { executeBenchmarkRun } from '@/services/client';
import { useBenchmarkCancellation } from '@/hooks/useBenchmarkCancellation';
import { Benchmark, BenchmarkRun, BenchmarkProgress, TestCase } from '@/types';
import { BenchmarkEditor, RunConfigForExecution } from './BenchmarkEditor';
import { BenchmarkResultsView } from './BenchmarkResultsView';
import { DEFAULT_CONFIG } from '@/lib/constants';
import { formatDate } from '@/lib/utils';

// Track individual use case status during run
interface UseCaseRunStatus {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
}

const POLL_INTERVAL_MS = 2000; // Poll every 2 seconds when running

export const BenchmarksPage: React.FC = () => {
  const navigate = useNavigate();
  const [benchmarks, setBenchmarks] = useState<Benchmark[]>([]);
  const [testCases, setTestCases] = useState<TestCase[]>([]);
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [editingBenchmark, setEditingBenchmark] = useState<Benchmark | null>(null);
  const [viewingResultsFor, setViewingResultsFor] = useState<Benchmark | null>(null);
  const [runningBenchmarkId, setRunningBenchmarkId] = useState<string | null>(null);
  const [runProgress, setRunProgress] = useState<BenchmarkProgress | null>(null);
  const [useCaseStatuses, setUseCaseStatuses] = useState<UseCaseRunStatus[]>([]);
  const [editingDescriptionId, setEditingDescriptionId] = useState<string | null>(null);
  const [editingDescriptionValue, setEditingDescriptionValue] = useState('');
  const { cancellingRunId, handleCancelRun: cancelRun } = useBenchmarkCancellation();
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  // Delete operation state
  const [deleteState, setDeleteState] = useState<{
    isDeleting: boolean;
    deletingId: string | null;
    status: 'idle' | 'success' | 'error';
    message: string;
  }>({ isDeleting: false, deletingId: null, status: 'idle', message: '' });

  // Load test cases on mount
  useEffect(() => {
    asyncTestCaseStorage.getAll().then(setTestCases);
  }, []);

  // Run configuration dialog state
  const [isRunConfigOpen, setIsRunConfigOpen] = useState(false);
  const [runConfigBenchmark, setRunConfigBenchmark] = useState<Benchmark | null>(null);
  const [runConfigValues, setRunConfigValues] = useState<RunConfigForExecution>({
    name: '',
    description: '',
    agentKey: '',
    modelId: '',
  });

  const loadBenchmarks = useCallback(async () => {
    const benchs = await asyncBenchmarkStorage.getAll();
    setBenchmarks(benchs);
  }, []);

  useEffect(() => {
    loadBenchmarks();
  }, [loadBenchmarks]);

  // Check if any benchmarks have server-side in-progress runs
  const hasServerInProgressRuns = benchmarks.some(bench =>
    bench.runs?.some(run => run.status === 'running')
  );

  // Polling effect: refresh benchmark data when running OR when there are server-side in-progress runs
  useEffect(() => {
    const shouldPoll = runningBenchmarkId || hasServerInProgressRuns;

    // Always clear existing interval first to prevent stacking
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }

    if (shouldPoll) {
      // Use 5s polling for background sync (SSE disconnected), 2s for active runs
      const interval = runningBenchmarkId ? POLL_INTERVAL_MS : 5000;

      pollIntervalRef.current = setInterval(() => {
        loadBenchmarks();
      }, interval);
    }

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, [runningBenchmarkId, hasServerInProgressRuns, loadBenchmarks]);

  const handleNewBenchmark = () => {
    setEditingBenchmark(null);
    setIsEditorOpen(true);
  };

  const handleImportFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setIsImporting(true);
    setImportError(null);

    try {
      const text = await file.text();
      const json = JSON.parse(text);
      const validation = validateTestCasesArrayJson(json);

      if (!validation.valid || !validation.data) {
        setImportError(`Validation failed: ${validation.errors[0]?.message || 'Invalid format'}`);
        return;
      }

      // Step 1: Create test cases
      const result = await asyncTestCaseStorage.bulkCreate(validation.data);

      if (result.created === 0) {
        setImportError('No test cases were created. They may already exist.');
        return;
      }

      // Step 2: Get IDs of created test cases (fetch latest to get generated IDs)
      const allTestCases = await asyncTestCaseStorage.getAll();
      const createdTestCaseIds = allTestCases
        .filter((tc) => validation.data!.some((d) => d.name === tc.name))
        .map((tc) => tc.id);

      // Step 3: Auto-create benchmark with imported test cases
      const benchmarkName = file.name.replace(/\.json$/i, '') || 'Imported Benchmark';
      const benchmark = await asyncBenchmarkStorage.create({
        name: benchmarkName,
        description: `Auto-created from import of ${result.created} test case(s)`,
        currentVersion: 1,
        versions: [
          {
            version: 1,
            createdAt: new Date().toISOString(),
            testCaseIds: createdTestCaseIds,
          },
        ],
        testCaseIds: createdTestCaseIds,
        runs: [],
      });

      // Navigate directly to the benchmark runs page
      navigate(`/benchmarks/${benchmark.id}/runs`);
    } catch (error) {
      console.error('Failed to import test cases:', error);
      setImportError(`Import failed: ${(error as Error).message}`);
    } finally {
      setIsImporting(false);
      event.target.value = ''; // Reset for re-upload
    }
  };

  const handleExportBenchmark = async (bench: Benchmark) => {
    try {
      const res = await fetch(`/api/storage/benchmarks/${bench.id}/export`);
      if (!res.ok) {
        throw new Error(`Export failed: ${res.statusText}`);
      }
      const data = await res.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${bench.name.replace(/[^a-z0-9_\-\s]/gi, '').replace(/\s+/g, '-').toLowerCase() || 'benchmark-export'}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Failed to export benchmark:', error);
    }
  };

  const handleEditBenchmark = (bench: Benchmark) => {
    setEditingBenchmark(bench);
    setIsEditorOpen(true);
  };

  const handleDeleteBenchmark = async (bench: Benchmark) => {
    if (!window.confirm(`Delete benchmark "${bench.name}"? This will also delete all associated runs.`)) return;

    setDeleteState({ isDeleting: true, deletingId: bench.id, status: 'idle', message: '' });

    try {
      const success = await asyncBenchmarkStorage.delete(bench.id);
      if (success) {
        setDeleteState({ isDeleting: false, deletingId: null, status: 'success', message: `"${bench.name}" deleted` });
        setTimeout(() => setDeleteState(s => ({ ...s, status: 'idle', message: '' })), 3000);
        loadBenchmarks();
      } else {
        setDeleteState({ isDeleting: false, deletingId: null, status: 'error', message: `Failed to delete "${bench.name}"` });
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

  // Helper to derive run status from results if status field is missing (legacy data)
  const getEffectiveRunStatus = (run: BenchmarkRun): BenchmarkRun['status'] => {
    // If status is explicitly set, use it (includes 'cancelled')
    if (run.status) return run.status;
    // Derive from results for legacy data
    const results = Object.values(run.results || {});
    if (results.some(r => r.status === 'running')) return 'running';
    if (results.some(r => r.status === 'pending') &&
        !results.some(r => r.status === 'completed' || r.status === 'failed')) {
      return 'running';
    }
    return results.some(r => r.status === 'completed') ? 'completed' : 'failed';
  };

  // Find a running run in a benchmark (server-side detection)
  const getRunningRun = (bench: Benchmark): BenchmarkRun | null => {
    return bench.runs?.find(run => getEffectiveRunStatus(run) === 'running') || null;
  };

  // Check if the latest run was cancelled
  const getLatestRunStatus = (bench: Benchmark): BenchmarkRun['status'] | null => {
    const latestRun = getLatestRun(bench);
    return latestRun ? getEffectiveRunStatus(latestRun) : null;
  };

  const handleCancelRun = async (benchmarkId: string, runId: string) => {
    // Clear local running state if this was a locally-initiated run
    if (runningBenchmarkId === benchmarkId) {
      setRunningBenchmarkId(null);
      setUseCaseStatuses(prev => prev.map(uc =>
        uc.status === 'pending' || uc.status === 'running'
          ? { ...uc, status: 'cancelled' as const }
          : uc
      ));
    }

    await cancelRun(benchmarkId, runId, loadBenchmarks);
  };

  const handleSaveBenchmark = async (bench: Benchmark) => {
    await asyncBenchmarkStorage.save(bench);
    loadBenchmarks();
    setIsEditorOpen(false);
  };

  // Handle creating and immediately running a new benchmark with multiple runs
  const handleSaveAndRun = async (bench: Benchmark, runConfigs: RunConfigForExecution[]) => {
    // Save the benchmark first
    await asyncBenchmarkStorage.save(bench);
    loadBenchmarks();
    setIsEditorOpen(false);

    // Start running
    setRunningBenchmarkId(bench.id);

    // Execute each run sequentially
    for (let runIndex = 0; runIndex < runConfigs.length; runIndex++) {
      const runConfig = runConfigs[runIndex];

      // Initialize use case statuses for this run
      const initialStatuses: UseCaseRunStatus[] = bench.testCaseIds.map(id => {
        const testCase = testCases.find(tc => tc.id === id);
        return {
          id,
          name: testCase?.name || id,
          status: 'pending' as const,
        };
      });
      setUseCaseStatuses(initialStatuses);
      setRunProgress(null);

      try {
        const completedRun = await executeBenchmarkRun(bench.id, runConfig, (progress: BenchmarkProgress) => {
          setRunProgress(progress);
          // Update use case statuses based on progress
          setUseCaseStatuses(prev => prev.map((uc, index) => {
            if (index < progress.currentTestCaseIndex) {
              return { ...uc, status: 'completed' as const };
            } else if (index === progress.currentTestCaseIndex) {
              // Map progress status to use case status
              const statusMap: Record<BenchmarkProgress['status'], UseCaseRunStatus['status']> = {
                'running': 'running',
                'completed': 'completed',
                'failed': 'failed',
                'cancelled': 'cancelled',
              };
              return { ...uc, status: statusMap[progress.status] };
            }
            return uc;
          }));
        });

        // Mark all as completed when this run is done (server already saved the run)
        setUseCaseStatuses(prev => prev.map(uc => ({ ...uc, status: 'completed' as const })));
        loadBenchmarks();
      } catch (error) {
        console.error(`[BenchmarksPage] Error running benchmark run ${runIndex + 1}:`, error);
        // Mark current and remaining as failed
        setUseCaseStatuses(prev => prev.map(uc =>
          uc.status === 'pending' || uc.status === 'running'
            ? { ...uc, status: 'failed' as const }
            : uc
        ));
        // Continue to next run even if this one failed
      }
    }

    setRunningBenchmarkId(null);
    setRunProgress(null);
  };

  const handleStartDescriptionEdit = (bench: Benchmark) => {
    setEditingDescriptionId(bench.id);
    setEditingDescriptionValue(bench.description || '');
  };

  const handleSaveDescription = async (bench: Benchmark) => {
    const updated = { ...bench, description: editingDescriptionValue || undefined, updatedAt: new Date().toISOString() };
    await asyncBenchmarkStorage.save(updated);
    loadBenchmarks();
    setEditingDescriptionId(null);
  };

  const handleCancelDescriptionEdit = () => {
    setEditingDescriptionId(null);
    setEditingDescriptionValue('');
  };

  // Open run configuration dialog
  const handleAddRun = (bench: Benchmark) => {
    if (runningBenchmarkId) {
      alert('A benchmark is already running. Please wait for it to complete.');
      return;
    }

    const latestRun = getLatestRun(bench);
    const runNumber = (bench.runs?.length || 0) + 1;

    // Pre-fill with latest run config if available, otherwise use defaults
    setRunConfigValues({
      name: `Run ${runNumber}`,
      description: '',
      agentKey: latestRun?.agentKey || DEFAULT_CONFIG.agents[0]?.key || '',
      modelId: latestRun?.modelId || Object.keys(DEFAULT_CONFIG.models)[0] || '',
      headers: latestRun?.headers,
    });
    setRunConfigBenchmark(bench);
    setIsRunConfigOpen(true);
  };

  // Execute the run with configured values
  const handleStartRun = async () => {
    if (!runConfigBenchmark) return;

    const bench = runConfigBenchmark;
    setIsRunConfigOpen(false);
    setRunConfigBenchmark(null);

    // Initialize use case statuses
    const initialStatuses: UseCaseRunStatus[] = bench.testCaseIds.map(id => {
      const testCase = testCases.find(tc => tc.id === id);
      return {
        id,
        name: testCase?.name || id,
        status: 'pending' as const,
      };
    });
    setUseCaseStatuses(initialStatuses);

    setRunningBenchmarkId(bench.id);
    setRunProgress(null);

    try {
      const completedRun = await executeBenchmarkRun(bench.id, runConfigValues, (progress: BenchmarkProgress) => {
        setRunProgress(progress);
        // Update use case statuses based on progress
        setUseCaseStatuses(prev => prev.map((uc, index) => {
          if (index < progress.currentTestCaseIndex) {
            return { ...uc, status: 'completed' as const };
          } else if (index === progress.currentTestCaseIndex) {
            // Map progress status to use case status
            const statusMap: Record<BenchmarkProgress['status'], UseCaseRunStatus['status']> = {
              'running': 'running',
              'completed': 'completed',
              'failed': 'failed',
              'cancelled': 'cancelled',
            };
            return { ...uc, status: statusMap[progress.status] };
          }
          return uc;
        }));
      });

      // Mark all as completed when done (server already saved the run)
      setUseCaseStatuses(prev => prev.map(uc => ({ ...uc, status: 'completed' as const })));
      loadBenchmarks();
    } catch (error) {
      console.error('Error running benchmark:', error);
      // Mark current and remaining as failed
      setUseCaseStatuses(prev => prev.map(uc =>
        uc.status === 'pending' || uc.status === 'running'
          ? { ...uc, status: 'failed' as const }
          : uc
      ));
    } finally {
      setRunningBenchmarkId(null);
      setRunProgress(null);
    }
  };

  const getUseCaseCount = (bench: Benchmark) => {
    return bench.testCaseIds.length;
  };

  const getRunNames = (bench: Benchmark) => {
    if (!bench.runs || bench.runs.length === 0) return 'No runs yet';
    return bench.runs.map(r => r.name).join(', ');
  };

  const getLatestRun = (bench: Benchmark): BenchmarkRun | null => {
    if (!bench.runs || bench.runs.length === 0) return null;
    return bench.runs.reduce((latest, run) =>
      new Date(run.createdAt) > new Date(latest.createdAt) ? run : latest
    );
  };

  // Show results view if viewing a benchmark
  if (viewingResultsFor) {
    return (
      <BenchmarkResultsView
        benchmark={viewingResultsFor}
        onBack={() => setViewingResultsFor(null)}
      />
    );
  }

  return (
    <div className="p-6 h-full flex flex-col" data-testid="benchmarks-page">
      {/* Header */}
      <div className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-2xl font-bold" data-testid="benchmarks-title">Benchmarks</h2>
          <p className="text-xs text-muted-foreground mt-1">
            {benchmarks.length} benchmark{benchmarks.length !== 1 ? 's' : ''} created
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            className="hidden"
            onChange={handleImportFile}
          />
          <Button
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
            disabled={isImporting}
            data-testid="import-json-button"
          >
            <Upload size={16} className="mr-2" />
            {isImporting ? 'Importing...' : 'Import JSON'}
          </Button>
          <Button
            onClick={handleNewBenchmark}
            className="bg-opensearch-blue hover:bg-blue-600 text-white"
            data-testid="new-benchmark-button"
          >
            <Plus size={18} className="mr-2" />
            New Benchmark
          </Button>
        </div>
      </div>

      {/* Delete Feedback */}
      {deleteState.message && (
        <div className={`flex items-center gap-2 text-sm p-3 rounded-lg ${
          deleteState.status === 'success'
            ? 'bg-green-100 text-green-700 border border-green-300 dark:bg-green-500/10 dark:text-green-400 dark:border-green-500/20'
            : 'bg-red-100 text-red-700 border border-red-300 dark:bg-red-500/10 dark:text-red-400 dark:border-red-500/20'
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

      {/* Benchmark List */}
      <div className="flex-1 overflow-y-auto space-y-4">
        {benchmarks.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <FlaskConical size={48} className="mb-4 opacity-20" />
              <p className="text-lg font-medium">No benchmarks yet</p>
              <p className="text-sm">Create your first benchmark to compare agent runs</p>
              <Button
                onClick={handleNewBenchmark}
                variant="outline"
                className="mt-4"
              >
                <Plus size={16} className="mr-2" />
                Create Benchmark
              </Button>
            </CardContent>
          </Card>
        ) : (
          benchmarks.map(bench => {
            const latestRun = getLatestRun(bench);
            const serverRunningRun = getRunningRun(bench);
            const isRunning = runningBenchmarkId === bench.id || serverRunningRun !== null;
            const latestRunStatus = getLatestRunStatus(bench);
            const isCancelled = latestRunStatus === 'cancelled';

            const completedCount = useCaseStatuses.filter(uc => uc.status === 'completed').length;
            const failedCount = useCaseStatuses.filter(uc => uc.status === 'failed').length;
            const totalCount = useCaseStatuses.length;
            const progressPercent = totalCount > 0 ? ((completedCount + failedCount) / totalCount) * 100 : 0;

            return (
              <Card key={bench.id} className={isRunning ? 'border-blue-500/50' : isCancelled ? 'border-orange-500/30' : ''}>
                <CardContent className="p-4">
                  <div className="flex items-start gap-4">
                    {/* Main Content - Clickable to view runs */}
                    <div
                      className="flex-1 min-w-0 cursor-pointer hover:opacity-80"
                      onClick={() => navigate(`/benchmarks/${bench.id}/runs`)}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="text-lg font-semibold truncate">{bench.name}</h3>
                        {isRunning && (
                          <Badge variant="outline" className="text-xs bg-blue-100 text-blue-700 border-blue-300 dark:bg-blue-500/10 dark:text-blue-400 dark:border-blue-500/30">
                            <Loader2 size={10} className="mr-1 animate-spin" />
                            Running
                          </Badge>
                        )}
                        {!isRunning && isCancelled && (
                          <Badge variant="outline" className="text-xs bg-orange-100 text-orange-700 border-orange-300 dark:bg-orange-500/10 dark:text-orange-400 dark:border-orange-500/30">
                            <Ban size={10} className="mr-1" />
                            Cancelled
                          </Badge>
                        )}
                        {!isRunning && !isCancelled && bench.runs && bench.runs.length > 0 && (
                          <Badge variant="outline" className="text-xs">
                            {bench.runs.length} run{bench.runs.length !== 1 ? 's' : ''}
                          </Badge>
                        )}
                        <Badge variant="outline" className="text-xs text-muted-foreground">
                          v{bench.currentVersion || 1}
                        </Badge>
                      </div>

                      {/* Inline description editing */}
                      {editingDescriptionId === bench.id ? (
                        <div className="flex items-center gap-2 mb-2" onClick={e => e.stopPropagation()}>
                          <Input
                            value={editingDescriptionValue}
                            onChange={e => setEditingDescriptionValue(e.target.value)}
                            placeholder="Add a description..."
                            className="h-7 text-sm"
                            autoFocus
                            onKeyDown={e => {
                              if (e.key === 'Enter') handleSaveDescription(bench);
                              if (e.key === 'Escape') handleCancelDescriptionEdit();
                            }}
                          />
                          <Button size="sm" variant="ghost" onClick={() => handleSaveDescription(bench)}>Save</Button>
                          <Button size="sm" variant="ghost" onClick={handleCancelDescriptionEdit}>Cancel</Button>
                        </div>
                      ) : (
                        <p
                          className="text-sm text-muted-foreground mb-2 line-clamp-1 cursor-pointer hover:text-foreground"
                          onClick={(e) => { e.stopPropagation(); handleStartDescriptionEdit(bench); }}
                          title="Click to edit description"
                        >
                          {bench.description || 'Click to add description...'}
                        </p>
                      )}

                      {/* Show progress when running */}
                      {isRunning && useCaseStatuses.length > 0 && (
                        <div className="mb-3 p-3 bg-muted/30 rounded-lg">
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-sm font-medium">
                              Progress: {completedCount + failedCount} / {totalCount}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {completedCount} passed{failedCount > 0 && `, ${failedCount} failed`}
                            </span>
                          </div>
                          <Progress value={progressPercent} className="h-2 mb-3" />
                          <div className="space-y-1 max-h-32 overflow-y-auto">
                            {useCaseStatuses.map(uc => (
                              <div key={uc.id} className="flex items-center gap-2 text-xs">
                                {uc.status === 'pending' && <Circle size={12} className="text-muted-foreground" />}
                                {uc.status === 'running' && <Loader2 size={12} className="text-blue-700 dark:text-blue-400 animate-spin" />}
                                {uc.status === 'completed' && <CheckCircle size={12} className="text-green-700 dark:text-green-400" />}
                                {uc.status === 'failed' && <XCircle size={12} className="text-red-700 dark:text-red-400" />}
                                {uc.status === 'cancelled' && <Ban size={12} className="text-amber-700 dark:text-amber-400" />}
                                <span className={uc.status === 'running' ? 'text-blue-700 dark:text-blue-400' : uc.status === 'cancelled' ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground'}>
                                  {uc.name}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      <div className="flex items-center gap-4 text-xs text-muted-foreground">
                        <span>
                          {getUseCaseCount(bench)} use case{getUseCaseCount(bench) !== 1 ? 's' : ''}
                        </span>
                        <span className="text-muted-foreground/50">·</span>
                        <span>
                          Runs: {getRunNames(bench)}
                        </span>
                        {latestRun && (
                          <>
                            <span className="text-muted-foreground/50">·</span>
                            <span className="flex items-center gap-1">
                              <Calendar size={12} />
                              Last run: {formatDate(latestRun.createdAt, 'date')}
                            </span>
                          </>
                        )}
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-2">
                      {!isRunning && bench.runs && bench.runs.length > 0 && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setViewingResultsFor(bench)}
                        >
                          <Eye size={14} className="mr-1" />
                          View Latest
                        </Button>
                      )}
                      {/* Edit button - opens editor to modify test cases */}
                      {!isRunning && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleEditBenchmark(bench)}
                          title="Edit benchmark"
                        >
                          <Pencil size={14} />
                        </Button>
                      )}
                      {/* Export button - downloads test cases as JSON */}
                      {!isRunning && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleExportBenchmark(bench)}
                          title="Export test cases as JSON"
                          data-testid="export-benchmark-button"
                        >
                          <Download size={14} />
                        </Button>
                      )}
                      {/* Run button - creates new run */}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleAddRun(bench)}
                        disabled={runningBenchmarkId !== null}
                        title="Run benchmark"
                      >
                        {isRunning ? (
                          <RefreshCw size={14} className="animate-spin" />
                        ) : (
                          <Play size={14} />
                        )}
                      </Button>
                      {/* Cancel button - shown when run is in progress */}
                      {isRunning && serverRunningRun && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={cancellingRunId === serverRunningRun.id}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleCancelRun(bench.id, serverRunningRun.id);
                          }}
                          className="text-red-400 hover:text-red-300 hover:bg-red-500/10 border-red-500/30 disabled:opacity-50"
                        >
                          {cancellingRunId === serverRunningRun.id ? (
                            <Loader2 size={14} className="mr-1 animate-spin" />
                          ) : (
                            <StopCircle size={14} className="mr-1" />
                          )}
                          {cancellingRunId === serverRunningRun.id ? 'Cancelling...' : 'Cancel'}
                        </Button>
                      )}
                      {!isRunning && (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleDeleteBenchmark(bench)}
                          disabled={deleteState.isDeleting && deleteState.deletingId === bench.id}
                          className="text-red-400 hover:text-red-300 hover:bg-red-500/10"
                        >
                          {deleteState.isDeleting && deleteState.deletingId === bench.id ? (
                            <Loader2 size={14} className="animate-spin" />
                          ) : (
                            <Trash2 size={14} />
                          )}
                        </Button>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })
        )}
      </div>

      {/* Benchmark Editor Dialog */}
      {isEditorOpen && (
        <BenchmarkEditor
          benchmark={editingBenchmark}
          onSave={handleSaveBenchmark}
          onSaveAndRun={handleSaveAndRun}
          onCancel={() => setIsEditorOpen(false)}
        />
      )}

      {/* Import Error Dialog */}
      <AlertDialog open={!!importError} onOpenChange={() => setImportError(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Import Failed</AlertDialogTitle>
            <AlertDialogDescription>{importError}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setImportError(null)}>OK</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Run Configuration Dialog */}
      {isRunConfigOpen && runConfigBenchmark && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <Card className="w-full max-w-md">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-lg">Configure Run</CardTitle>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => {
                  setIsRunConfigOpen(false);
                  setRunConfigBenchmark(null);
                }}
              >
                <X size={18} />
              </Button>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="run-name">Run Name</Label>
                <Input
                  id="run-name"
                  value={runConfigValues.name}
                  onChange={e => setRunConfigValues(prev => ({ ...prev, name: e.target.value }))}
                  placeholder="e.g., Baseline, With Fix, Claude 4 Test"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="run-description">Description (optional)</Label>
                <Textarea
                  id="run-description"
                  value={runConfigValues.description || ''}
                  onChange={e => setRunConfigValues(prev => ({ ...prev, description: e.target.value || undefined }))}
                  placeholder="Describe what this run tests or changes..."
                  rows={2}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Agent</Label>
                  <Select
                    value={runConfigValues.agentKey}
                    onValueChange={val => setRunConfigValues(prev => ({ ...prev, agentKey: val }))}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DEFAULT_CONFIG.agents.map(agent => (
                        <SelectItem key={agent.key} value={agent.key}>
                          {agent.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>Judge Model</Label>
                  <Select
                    value={runConfigValues.modelId}
                    onValueChange={val => setRunConfigValues(prev => ({ ...prev, modelId: val }))}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(DEFAULT_CONFIG.models).map(([key, model]) => (
                        <SelectItem key={key} value={key}>
                          {model.display_name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <Button
                  variant="ghost"
                  onClick={() => {
                    setIsRunConfigOpen(false);
                    setRunConfigBenchmark(null);
                  }}
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleStartRun}
                  disabled={!runConfigValues.name.trim()}
                  className="bg-opensearch-blue hover:bg-blue-600"
                >
                  <Play size={16} className="mr-1" />
                  Start Run
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
};

// Backwards compatibility alias
/** @deprecated Use BenchmarksPage instead */
export const ExperimentsPage = BenchmarksPage;
