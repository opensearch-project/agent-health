/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, GitCompare, Calendar, CheckCircle2, XCircle, Play, Trash2, Plus, X, Loader2, Circle, Check, ChevronRight, Clock, StopCircle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { asyncExperimentStorage, asyncRunStorage, asyncTestCaseStorage } from '@/services/storage';
import { executeExperimentRun, cancelExperimentRun } from '@/services/client';
import { Experiment, ExperimentRun, EvaluationReport, TestCase, ExperimentProgress, ExperimentStartedEvent } from '@/types';
import { DEFAULT_CONFIG } from '@/lib/constants';
import { getLabelColor, formatDate, getModelName } from '@/lib/utils';
import { RunConfigForExecution } from './ExperimentEditor';

// Track individual use case status during run
interface UseCaseRunStatus {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
}

const POLL_INTERVAL_MS = 2000;

/**
 * Get effective run status - normalizes legacy data (status: undefined) to proper enum values.
 * Returns: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
 */
const getEffectiveRunStatus = (run: ExperimentRun): ExperimentRun['status'] => {
  // If status is explicitly set, use it (modern data - backend always sets this now)
  if (run.status) {
    return run.status;
  }

  // Legacy/fallback: derive status from child results
  const results = Object.values(run.results || {});

  // If any result is running, run is running
  if (results.some(r => r.status === 'running')) {
    return 'running';
  }

  // If any result is pending (and none running/completed/failed), treat as running
  // This handles the edge case where run.status wasn't persisted yet
  if (results.some(r => r.status === 'pending') &&
      !results.some(r => r.status === 'completed' || r.status === 'failed')) {
    return 'running';
  }

  const hasAnyCompleted = results.some(r => r.status === 'completed');
  const hasAnyFailed = results.some(r => r.status === 'failed');

  if (hasAnyCompleted || hasAnyFailed) {
    return 'completed';
  }

  // Truly legacy data with no results - treat as failed (stuck)
  return 'failed';
};

export const ExperimentRunsPage: React.FC = () => {
  const { experimentId } = useParams<{ experimentId: string }>();
  const navigate = useNavigate();

  const [experiment, setExperiment] = useState<Experiment | null>(null);
  const [reports, setReports] = useState<Record<string, EvaluationReport | null>>({});
  const [testCases, setTestCases] = useState<TestCase[]>([]);

  // Run configuration dialog state
  const [isRunConfigOpen, setIsRunConfigOpen] = useState(false);
  const [runConfigValues, setRunConfigValues] = useState<RunConfigForExecution>({
    name: '',
    description: '',
    agentKey: '',
    modelId: '',
  });

  // Running state
  const [isRunning, setIsRunning] = useState(false);
  const [runProgress, setRunProgress] = useState<ExperimentProgress | null>(null);
  const [useCaseStatuses, setUseCaseStatuses] = useState<UseCaseRunStatus[]>([]);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Selected runs for comparison
  const [selectedRunIds, setSelectedRunIds] = useState<string[]>([]);

  // Load test cases on mount
  useEffect(() => {
    asyncTestCaseStorage.getAll().then(setTestCases);
  }, []);

  const loadExperiment = useCallback(async () => {
    if (!experimentId) return;

    const exp = await asyncExperimentStorage.getById(experimentId);
    if (!exp) {
      navigate('/experiments');
      return;
    }

    setExperiment(exp);

    // Load all reports for this experiment in a single batch request
    // (avoids ERR_INSUFFICIENT_RESOURCES from too many concurrent fetches)
    const allReports = await asyncRunStorage.getByExperiment(experimentId);
    const loadedReports: Record<string, EvaluationReport | null> = {};
    allReports.forEach(report => {
      loadedReports[report.id] = report;
    });
    setReports(loadedReports);
  }, [experimentId, navigate]);

  useEffect(() => {
    loadExperiment();
  }, [loadExperiment]);

  // Filter test cases to only those in this experiment
  const experimentTestCases = useMemo(() =>
    testCases.filter(tc => experiment?.testCaseIds.includes(tc.id)),
    [testCases, experiment]
  );

  const handleDeleteRun = async (run: ExperimentRun) => {
    if (!experimentId) return;

    if (window.confirm(`Delete run "${run.name}"? This cannot be undone.`)) {
      await asyncExperimentStorage.deleteRun(experimentId, run.id);
      // Reload experiment to get updated runs
      loadExperiment();
    }
  };

  const getRunStats = (run: ExperimentRun) => {
    let passed = 0;
    let failed = 0;
    let pending = 0;
    let running = 0;
    let total = 0;

    Object.entries(run.results || {}).forEach(([testCaseId, result]) => {
      total++;  // Count ALL results

      if (result.status === 'pending') {
        pending++;
      } else if (result.status === 'running') {
        running++;
      } else if (result.status === 'completed' && result.reportId) {
        const report = reports[result.reportId];
        if (report) {
          // Check if evaluation is still pending (trace mode)
          if (report.metricsStatus === 'pending' || report.metricsStatus === 'calculating') {
            pending++;
          } else if (report.passFailStatus === 'passed') {
            passed++;
          } else {
            failed++;
          }
        } else {
          pending++;  // Report not loaded yet
        }
      } else if (result.status === 'failed') {
        failed++;
      }
    });

    return { passed, failed, pending, running, total };
  };

  // Check if any reports have pending evaluations (trace mode)
  const hasPendingEvaluations = useMemo(() => {
    return Object.values(reports).some(
      report => report && (report.metricsStatus === 'pending' || report.metricsStatus === 'calculating')
    );
  }, [reports]);

  // Check if any runs are still executing on the server
  // This catches runs that are in-progress even if our SSE connection was lost
  const hasServerInProgressRuns = useMemo(() => {
    if (!experiment?.runs) return false;
    return experiment.runs.some(run => getEffectiveRunStatus(run) === 'running');
  }, [experiment?.runs]);

  // Polling effect: refresh experiment data when running OR when there are pending evaluations/in-progress runs
  useEffect(() => {
    const shouldPoll = isRunning || hasPendingEvaluations || hasServerInProgressRuns;

    if (shouldPoll) {
      // Use 5s polling for background sync scenarios (SSE disconnected, pending evaluations)
      // Use faster polling (2s) only when actively running with SSE connected
      const interval = isRunning ? POLL_INTERVAL_MS : 5000;

      pollIntervalRef.current = setInterval(() => {
        loadExperiment();
      }, interval);

      // Polling active for background sync scenarios
    } else {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    }

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, [isRunning, hasPendingEvaluations, hasServerInProgressRuns, loadExperiment]);

  const getLatestRun = (exp: Experiment): ExperimentRun | null => {
    if (!exp.runs || exp.runs.length === 0) return null;
    return exp.runs.reduce((latest, run) =>
      new Date(run.createdAt) > new Date(latest.createdAt) ? run : latest
    );
  };

  // Open run configuration dialog
  const handleAddRun = () => {
    if (!experiment) return;
    if (isRunning) {
      alert('A run is already in progress. Please wait for it to complete.');
      return;
    }

    const latestRun = getLatestRun(experiment);
    const runNumber = (experiment.runs?.length || 0) + 1;

    // Pre-fill with latest run config if available, otherwise use defaults
    setRunConfigValues({
      name: `Run ${runNumber}`,
      description: '',
      agentKey: latestRun?.agentKey || DEFAULT_CONFIG.agents[0]?.key || '',
      modelId: latestRun?.modelId || Object.keys(DEFAULT_CONFIG.models)[0] || '',
      headers: latestRun?.headers,
    });
    setIsRunConfigOpen(true);
  };

  // Execute the run with configured values
  const handleStartRun = async () => {
    if (!experiment) return;

    setIsRunConfigOpen(false);

    // Initialize use case statuses
    const initialStatuses: UseCaseRunStatus[] = experiment.testCaseIds.map(id => {
      const testCase = testCases.find(tc => tc.id === id);
      return {
        id,
        name: testCase?.name || id,
        status: 'pending' as const,
      };
    });
    setUseCaseStatuses(initialStatuses);

    setIsRunning(true);
    setRunProgress(null);

    try {
      const completedRun = await executeExperimentRun(
        experiment.id,
        runConfigValues,
        (progress: ExperimentProgress) => {
          setRunProgress(progress);
          // Update use case statuses based on progress
          setUseCaseStatuses(prev => prev.map((uc, index) => {
            if (index < progress.currentTestCaseIndex) {
              return { ...uc, status: 'completed' as const };
            } else if (index === progress.currentTestCaseIndex) {
              return { ...uc, status: progress.status === 'completed' ? 'completed' : 'running' as const };
            }
            return uc;
          }));
        },
        (startedEvent: ExperimentStartedEvent) => {
          // Initialize use case statuses from server response (ensures consistency)
          setUseCaseStatuses(startedEvent.testCases.map(tc => ({
            id: tc.id,
            name: tc.name,
            status: 'pending' as const,
          })));
        }
      );

      // Mark all as completed when done (server already saved the run)
      setUseCaseStatuses(prev => prev.map(uc => ({ ...uc, status: 'completed' as const })));
      loadExperiment();
    } catch (error) {
      console.error('Error running experiment:', error);
      // Mark current and remaining as failed
      setUseCaseStatuses(prev => prev.map(uc =>
        uc.status === 'pending' || uc.status === 'running'
          ? { ...uc, status: 'failed' as const }
          : uc
      ));
    } finally {
      setIsRunning(false);
      setRunProgress(null);
    }
  };

  // Toggle run selection for comparison
  const toggleRunSelection = (runId: string) => {
    setSelectedRunIds(prev =>
      prev.includes(runId)
        ? prev.filter(id => id !== runId)
        : [...prev, runId]
    );
  };

  // Toggle select all / deselect all
  const handleToggleSelectAll = () => {
    const allRunIds = (experiment?.runs || []).map(r => r.id);
    if (selectedRunIds.length === allRunIds.length) {
      setSelectedRunIds([]);
    } else {
      setSelectedRunIds(allRunIds);
    }
  };

  // Navigate to comparison with selected runs
  const handleCompareSelected = () => {
    if (selectedRunIds.length >= 2) {
      navigate(`/compare/${experimentId}?runs=${selectedRunIds.join(',')}`);
    }
  };

  if (!experiment) {
    return (
      <div className="p-6 flex items-center justify-center h-full">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    );
  }

  const runs = experiment.runs || [];
  const hasMultipleRuns = runs.length >= 2;

  return (
    <div className="p-6 h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate('/experiments')}>
            <ArrowLeft size={18} />
          </Button>
          <div>
            <h2 className="text-2xl font-bold">{experiment.name}</h2>
            <p className="text-xs text-muted-foreground">
              {runs.length} run{runs.length !== 1 ? 's' : ''}
              {experiment.description && ` · ${experiment.description}`}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {hasMultipleRuns && (
            <>
              <Button
                variant="outline"
                onClick={handleToggleSelectAll}
              >
                {selectedRunIds.length === runs.length ? (
                  <>
                    <X size={16} className="mr-2" />
                    Deselect All
                  </>
                ) : (
                  <>
                    <Check size={16} className="mr-2" />
                    Select All
                  </>
                )}
              </Button>
              <Button
                variant="outline"
                onClick={handleCompareSelected}
                disabled={selectedRunIds.length < 2}
              >
                <GitCompare size={16} className="mr-2" />
                Compare ({selectedRunIds.length})
              </Button>
            </>
          )}
          <Button
            onClick={handleAddRun}
            disabled={isRunning}
            className="bg-opensearch-blue hover:bg-blue-600"
          >
            {isRunning ? (
              <>
                <Loader2 size={16} className="mr-2 animate-spin" />
                Running...
              </>
            ) : (
              <>
                <Plus size={16} className="mr-2" />
                Add Run
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Main Content - Side by Side Layout */}
      <div className="flex gap-4 flex-1 overflow-hidden">
        {/* Left Panel - Test Cases (30%) */}
        <div className="w-[30%] flex-shrink-0 overflow-y-auto border-r border-border pr-4">
          {/* Metadata */}
          <div className="space-y-2 mb-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Calendar size={12} />
              <span>Created {formatDate(experiment.createdAt)}</span>
            </div>
            <div className="text-sm font-medium">
              {experimentTestCases.length} test case{experimentTestCases.length !== 1 ? 's' : ''}
            </div>
          </div>

          {/* Test Cases List */}
          <div className="space-y-2">
            {experimentTestCases.length === 0 ? (
              <p className="text-sm text-muted-foreground">No test cases in this experiment</p>
            ) : (
              experimentTestCases.map(tc => (
                <Card
                  key={tc.id}
                  className="cursor-pointer hover:border-primary/50 transition-colors"
                  onClick={() => navigate(`/test-cases/${tc.id}/runs`)}
                >
                  <CardContent className="p-3">
                    <div className="flex items-center justify-between">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{tc.name}</p>
                        <div className="flex items-center gap-2 mt-1 flex-wrap">
                          {(tc.labels || []).slice(0, 2).map((label) => (
                            <Badge key={label} className={`text-xs ${getLabelColor(label)}`}>
                              {label}
                            </Badge>
                          ))}
                          {(tc.labels || []).length > 2 && (
                            <span className="text-xs text-muted-foreground">
                              +{(tc.labels || []).length - 2}
                            </span>
                          )}
                        </div>
                      </div>
                      <ChevronRight size={16} className="text-muted-foreground flex-shrink-0" />
                    </div>
                  </CardContent>
                </Card>
              ))
            )}
          </div>
        </div>

        {/* Right Panel - Runs (70%) */}
        <div className="flex-1 overflow-y-auto flex flex-col">
          {/* Running Progress */}
          {isRunning && useCaseStatuses.length > 0 && (
            <Card className="mb-4 border-blue-500/50">
              <CardContent className="p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium flex items-center gap-2">
                    <Loader2 size={14} className="animate-spin" />
                    Running...
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {useCaseStatuses.filter(uc => uc.status === 'completed').length} / {useCaseStatuses.length}
                  </span>
                </div>
                <Progress
                  value={(useCaseStatuses.filter(uc => uc.status === 'completed' || uc.status === 'failed').length / useCaseStatuses.length) * 100}
                  className="h-2 mb-3"
                />
                <div className="space-y-1 max-h-32 overflow-y-auto">
                  {useCaseStatuses.map(uc => (
                    <div key={uc.id} className="flex items-center gap-2 text-xs">
                      {uc.status === 'pending' && <Circle size={12} className="text-muted-foreground" />}
                      {uc.status === 'running' && <Loader2 size={12} className="text-blue-400 animate-spin" />}
                      {uc.status === 'completed' && <CheckCircle2 size={12} className="text-opensearch-blue" />}
                      {uc.status === 'failed' && <XCircle size={12} className="text-red-400" />}
                      <span className={uc.status === 'running' ? 'text-blue-400' : 'text-muted-foreground'}>
                        {uc.name}
                      </span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Runs List */}
          <div className="flex-1 space-y-3">
        {runs.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <Play size={48} className="mb-4 opacity-20" />
              <p className="text-lg font-medium">No runs yet</p>
              <p className="text-sm">Run this experiment to see results here</p>
            </CardContent>
          </Card>
        ) : (
          runs
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
            .map((run, index) => {
              const stats = getRunStats(run);
              const isLatest = index === 0;
              const isSelected = selectedRunIds.includes(run.id);

              return (
                <Card
                  key={run.id}
                  className={`transition-colors cursor-pointer ${
                    isSelected
                      ? 'border-primary bg-primary/5'
                      : 'hover:border-primary/50'
                  }`}
                  onClick={() => {
                    // Navigate with ExperimentRun.id - RunDetailsPage handles all states
                    navigate(`/experiments/${experimentId}/runs/${run.id}`);
                  }}
                >
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3 flex-1">
                        {/* Checkbox for selection - always visible when multiple runs */}
                        {hasMultipleRuns && (
                          <Checkbox
                            checked={isSelected}
                            onCheckedChange={() => toggleRunSelection(run.id)}
                            onClick={(e) => e.stopPropagation()}
                            className="h-5 w-5"
                          />
                        )}
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <h3 className="font-semibold">{run.name}</h3>
                            {getEffectiveRunStatus(run) === 'running' && (
                              <Badge className="text-xs bg-blue-500/20 text-blue-400 border-blue-500/30 animate-pulse">
                                <Loader2 size={12} className="mr-1 animate-spin" />
                                Running
                              </Badge>
                            )}
                            {getEffectiveRunStatus(run) === 'cancelled' && (
                              <Badge className="text-xs bg-gray-500/20 text-gray-400 border-gray-500/30">
                                <XCircle size={12} className="mr-1" />
                                Cancelled
                              </Badge>
                            )}
                            {isLatest && (
                              <Badge variant="outline" className="text-xs bg-blue-500/10 text-blue-400 border-blue-500/30">
                                Latest
                              </Badge>
                            )}
                          </div>
                          {run.description && (
                            <p className="text-sm text-muted-foreground mb-2">{run.description}</p>
                          )}
                          <div className="flex items-center gap-4 text-xs text-muted-foreground">
                            <span className="flex items-center gap-1">
                              <Calendar size={12} />
                              {formatDate(run.createdAt)}
                            </span>
                            <span>Agent: {DEFAULT_CONFIG.agents.find(a => a.key === run.agentKey)?.name || run.agentKey}</span>
                            <span>Model: {getModelName(run.modelId)}</span>
                          </div>
                        </div>
                      </div>

                      {/* Stats and Actions */}
                      <div className="flex items-center gap-4">
                        {(stats.total > 0 || getEffectiveRunStatus(run) === 'running') && (
                          <div className="flex items-center gap-4 text-sm">
                            {/* Show running indicator */}
                            {stats.running > 0 && (
                              <span className="flex items-center gap-1 text-blue-400" title="Running">
                                <Loader2 size={14} className="animate-spin" />
                                {stats.running}
                              </span>
                            )}
                            {/* Show pending */}
                            {stats.pending > 0 && (
                              <span className="flex items-center gap-1 text-yellow-400" title="Pending">
                                <Clock size={14} />
                                {stats.pending}
                              </span>
                            )}
                            {/* Show passed/failed */}
                            <span className="flex items-center gap-1 text-opensearch-blue">
                              <CheckCircle2 size={14} />
                              {stats.passed}
                            </span>
                            <span className="flex items-center gap-1 text-red-400">
                              <XCircle size={14} />
                              {stats.failed}
                            </span>
                            <span className="text-muted-foreground">
                              / {stats.total}
                            </span>
                          </div>
                        )}
                        {/* Cancel button for running runs */}
                        {getEffectiveRunStatus(run) === 'running' && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={async (e) => {
                              e.stopPropagation();
                              try {
                                await cancelExperimentRun(experimentId!, run.id);
                                loadExperiment();
                              } catch (error) {
                                console.error('Failed to cancel run:', error);
                              }
                            }}
                            className="text-red-400 hover:text-red-300 hover:bg-red-500/10 border-red-500/30"
                          >
                            <StopCircle size={14} className="mr-1" />
                            Cancel
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteRun(run);
                          }}
                          className="text-red-400 hover:text-red-300 hover:bg-red-500/10"
                          title="Delete run"
                        >
                          <Trash2 size={14} />
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })
          )}
          </div>

          {/* Footer hint */}
          {runs.length === 1 && (
            <p className="text-xs text-muted-foreground text-center mt-4">
              Add more runs to enable comparison
            </p>
          )}
        </div>
      </div>

      {/* Run Configuration Dialog */}
      {isRunConfigOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <Card className="w-full max-w-md">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-lg">Configure Run</CardTitle>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setIsRunConfigOpen(false)}
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
                <Button variant="ghost" onClick={() => setIsRunConfigOpen(false)}>
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
