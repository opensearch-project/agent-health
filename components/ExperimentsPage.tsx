/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Trash2, Eye, Calendar, FlaskConical, RefreshCw, CheckCircle, XCircle, Loader2, Circle, X, Play } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { asyncExperimentStorage, asyncTestCaseStorage } from '@/services/storage';
import { executeExperimentRun } from '@/services/client';
import { Experiment, ExperimentRun, ExperimentProgress, TestCase } from '@/types';
import { ExperimentEditor, RunConfigForExecution } from './ExperimentEditor';
import { ExperimentResultsView } from './ExperimentResultsView';
import { DEFAULT_CONFIG } from '@/lib/constants';
import { formatDate } from '@/lib/utils';

// Track individual use case status during run
interface UseCaseRunStatus {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
}

const POLL_INTERVAL_MS = 2000; // Poll every 2 seconds when running

export const ExperimentsPage: React.FC = () => {
  const navigate = useNavigate();
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [testCases, setTestCases] = useState<TestCase[]>([]);
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [editingExperiment, setEditingExperiment] = useState<Experiment | null>(null);
  const [viewingResultsFor, setViewingResultsFor] = useState<Experiment | null>(null);
  const [runningExperimentId, setRunningExperimentId] = useState<string | null>(null);
  const [runProgress, setRunProgress] = useState<ExperimentProgress | null>(null);
  const [useCaseStatuses, setUseCaseStatuses] = useState<UseCaseRunStatus[]>([]);
  const [editingDescriptionId, setEditingDescriptionId] = useState<string | null>(null);
  const [editingDescriptionValue, setEditingDescriptionValue] = useState('');
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Load test cases on mount
  useEffect(() => {
    asyncTestCaseStorage.getAll().then(setTestCases);
  }, []);

  // Run configuration dialog state
  const [isRunConfigOpen, setIsRunConfigOpen] = useState(false);
  const [runConfigExperiment, setRunConfigExperiment] = useState<Experiment | null>(null);
  const [runConfigValues, setRunConfigValues] = useState<RunConfigForExecution>({
    name: '',
    description: '',
    agentKey: '',
    modelId: '',
  });

  const loadExperiments = useCallback(async () => {
    const exps = await asyncExperimentStorage.getAll();
    setExperiments(exps);
  }, []);

  useEffect(() => {
    loadExperiments();
  }, [loadExperiments]);

  // Check if any experiments have server-side in-progress runs
  const hasServerInProgressRuns = experiments.some(exp =>
    exp.runs?.some(run => run.status === 'running')
  );

  // Polling effect: refresh experiment data when running OR when there are server-side in-progress runs
  useEffect(() => {
    const shouldPoll = runningExperimentId || hasServerInProgressRuns;

    if (shouldPoll) {
      // Use 5s polling for background sync (SSE disconnected), 2s for active runs
      const interval = runningExperimentId ? POLL_INTERVAL_MS : 5000;

      pollIntervalRef.current = setInterval(() => {
        loadExperiments();
      }, interval);

      // Polling active for background sync scenarios
    } else {
      // Stop polling
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
  }, [runningExperimentId, hasServerInProgressRuns, loadExperiments]);

  const handleNewExperiment = () => {
    setEditingExperiment(null);
    setIsEditorOpen(true);
  };

  const handleDeleteExperiment = async (exp: Experiment) => {
    if (window.confirm(`Delete experiment "${exp.name}"? This will also delete all associated runs.`)) {
      await asyncExperimentStorage.delete(exp.id);
      loadExperiments();
    }
  };

  const handleSaveExperiment = async (exp: Experiment) => {
    await asyncExperimentStorage.save(exp);
    loadExperiments();
    setIsEditorOpen(false);
  };

  // Handle creating and immediately running a new experiment with multiple runs
  const handleSaveAndRun = async (exp: Experiment, runConfigs: RunConfigForExecution[]) => {
    // Save the experiment first
    await asyncExperimentStorage.save(exp);
    loadExperiments();
    setIsEditorOpen(false);

    // Start running
    setRunningExperimentId(exp.id);

    // Execute each run sequentially
    for (let runIndex = 0; runIndex < runConfigs.length; runIndex++) {
      const runConfig = runConfigs[runIndex];

      // Initialize use case statuses for this run
      const initialStatuses: UseCaseRunStatus[] = exp.testCaseIds.map(id => {
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
        const completedRun = await executeExperimentRun(exp.id, runConfig, (progress: ExperimentProgress) => {
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
        });

        // Mark all as completed when this run is done (server already saved the run)
        setUseCaseStatuses(prev => prev.map(uc => ({ ...uc, status: 'completed' as const })));
        loadExperiments();
      } catch (error) {
        console.error(`[ExperimentsPage] Error running experiment run ${runIndex + 1}:`, error);
        // Mark current and remaining as failed
        setUseCaseStatuses(prev => prev.map(uc =>
          uc.status === 'pending' || uc.status === 'running'
            ? { ...uc, status: 'failed' as const }
            : uc
        ));
        // Continue to next run even if this one failed
      }
    }

    setRunningExperimentId(null);
    setRunProgress(null);
  };

  const handleStartDescriptionEdit = (exp: Experiment) => {
    setEditingDescriptionId(exp.id);
    setEditingDescriptionValue(exp.description || '');
  };

  const handleSaveDescription = async (exp: Experiment) => {
    const updated = { ...exp, description: editingDescriptionValue || undefined, updatedAt: new Date().toISOString() };
    await asyncExperimentStorage.save(updated);
    loadExperiments();
    setEditingDescriptionId(null);
  };

  const handleCancelDescriptionEdit = () => {
    setEditingDescriptionId(null);
    setEditingDescriptionValue('');
  };

  // Open run configuration dialog
  const handleAddRun = (exp: Experiment) => {
    if (runningExperimentId) {
      alert('An experiment is already running. Please wait for it to complete.');
      return;
    }

    const latestRun = getLatestRun(exp);
    const runNumber = (exp.runs?.length || 0) + 1;

    // Pre-fill with latest run config if available, otherwise use defaults
    setRunConfigValues({
      name: `Run ${runNumber}`,
      description: '',
      agentKey: latestRun?.agentKey || DEFAULT_CONFIG.agents[0]?.key || '',
      modelId: latestRun?.modelId || Object.keys(DEFAULT_CONFIG.models)[0] || '',
      headers: latestRun?.headers,
    });
    setRunConfigExperiment(exp);
    setIsRunConfigOpen(true);
  };

  // Execute the run with configured values
  const handleStartRun = async () => {
    if (!runConfigExperiment) return;

    const exp = runConfigExperiment;
    setIsRunConfigOpen(false);
    setRunConfigExperiment(null);

    // Initialize use case statuses
    const initialStatuses: UseCaseRunStatus[] = exp.testCaseIds.map(id => {
      const testCase = testCases.find(tc => tc.id === id);
      return {
        id,
        name: testCase?.name || id,
        status: 'pending' as const,
      };
    });
    setUseCaseStatuses(initialStatuses);

    setRunningExperimentId(exp.id);
    setRunProgress(null);

    try {
      const completedRun = await executeExperimentRun(exp.id, runConfigValues, (progress: ExperimentProgress) => {
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
      });

      // Mark all as completed when done (server already saved the run)
      setUseCaseStatuses(prev => prev.map(uc => ({ ...uc, status: 'completed' as const })));
      loadExperiments();
    } catch (error) {
      console.error('Error running experiment:', error);
      // Mark current and remaining as failed
      setUseCaseStatuses(prev => prev.map(uc =>
        uc.status === 'pending' || uc.status === 'running'
          ? { ...uc, status: 'failed' as const }
          : uc
      ));
    } finally {
      setRunningExperimentId(null);
      setRunProgress(null);
    }
  };

  const getUseCaseCount = (exp: Experiment) => {
    return exp.testCaseIds.length;
  };

  const getRunNames = (exp: Experiment) => {
    if (!exp.runs || exp.runs.length === 0) return 'No runs yet';
    return exp.runs.map(r => r.name).join(', ');
  };

  const getLatestRun = (exp: Experiment): ExperimentRun | null => {
    if (!exp.runs || exp.runs.length === 0) return null;
    return exp.runs.reduce((latest, run) =>
      new Date(run.createdAt) > new Date(latest.createdAt) ? run : latest
    );
  };

  // Show results view if viewing an experiment
  if (viewingResultsFor) {
    return (
      <ExperimentResultsView
        experiment={viewingResultsFor}
        onBack={() => setViewingResultsFor(null)}
      />
    );
  }

  return (
    <div className="p-6 h-full flex flex-col">
      {/* Header */}
      <div className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-2xl font-bold">Experiments</h2>
          <p className="text-xs text-muted-foreground mt-1">
            {experiments.length} experiment{experiments.length !== 1 ? 's' : ''} created
          </p>
        </div>
        <Button
          onClick={handleNewExperiment}
          className="bg-opensearch-blue hover:bg-blue-600 text-white"
        >
          <Plus size={18} className="mr-2" />
          New Experiment
        </Button>
      </div>

      {/* Experiment List */}
      <div className="flex-1 overflow-y-auto space-y-4">
        {experiments.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <FlaskConical size={48} className="mb-4 opacity-20" />
              <p className="text-lg font-medium">No experiments yet</p>
              <p className="text-sm">Create your first experiment to compare agent runs</p>
              <Button
                onClick={handleNewExperiment}
                variant="outline"
                className="mt-4"
              >
                <Plus size={16} className="mr-2" />
                Create Experiment
              </Button>
            </CardContent>
          </Card>
        ) : (
          [...experiments]
            .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime())
            .map(exp => {
            const latestRun = getLatestRun(exp);
            const isRunning = runningExperimentId === exp.id;

            const completedCount = useCaseStatuses.filter(uc => uc.status === 'completed').length;
            const failedCount = useCaseStatuses.filter(uc => uc.status === 'failed').length;
            const totalCount = useCaseStatuses.length;
            const progressPercent = totalCount > 0 ? ((completedCount + failedCount) / totalCount) * 100 : 0;

            return (
              <Card key={exp.id} className={isRunning ? 'border-blue-500/50' : ''}>
                <CardContent className="p-4">
                  <div className="flex items-start gap-4">
                    {/* Main Content - Clickable to view runs */}
                    <div
                      className="flex-1 min-w-0 cursor-pointer hover:opacity-80"
                      onClick={() => navigate(`/experiments/${exp.id}/runs`)}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="text-lg font-semibold truncate">{exp.name}</h3>
                        {isRunning && (
                          <Badge variant="outline" className="text-xs bg-blue-500/10 text-blue-400 border-blue-500/30">
                            <Loader2 size={10} className="mr-1 animate-spin" />
                            Running
                          </Badge>
                        )}
                        {!isRunning && exp.runs && exp.runs.length > 0 && (
                          <Badge variant="outline" className="text-xs">
                            {exp.runs.length} run{exp.runs.length !== 1 ? 's' : ''}
                          </Badge>
                        )}
                      </div>

                      {/* Inline description editing */}
                      {editingDescriptionId === exp.id ? (
                        <div className="flex items-center gap-2 mb-2" onClick={e => e.stopPropagation()}>
                          <Input
                            value={editingDescriptionValue}
                            onChange={e => setEditingDescriptionValue(e.target.value)}
                            placeholder="Add a description..."
                            className="h-7 text-sm"
                            autoFocus
                            onKeyDown={e => {
                              if (e.key === 'Enter') handleSaveDescription(exp);
                              if (e.key === 'Escape') handleCancelDescriptionEdit();
                            }}
                          />
                          <Button size="sm" variant="ghost" onClick={() => handleSaveDescription(exp)}>Save</Button>
                          <Button size="sm" variant="ghost" onClick={handleCancelDescriptionEdit}>Cancel</Button>
                        </div>
                      ) : (
                        <p
                          className="text-sm text-muted-foreground mb-2 line-clamp-1 cursor-pointer hover:text-foreground"
                          onClick={(e) => { e.stopPropagation(); handleStartDescriptionEdit(exp); }}
                          title="Click to edit description"
                        >
                          {exp.description || 'Click to add description...'}
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
                                {uc.status === 'running' && <Loader2 size={12} className="text-blue-400 animate-spin" />}
                                {uc.status === 'completed' && <CheckCircle size={12} className="text-opensearch-blue" />}
                                {uc.status === 'failed' && <XCircle size={12} className="text-red-400" />}
                                <span className={uc.status === 'running' ? 'text-blue-400' : 'text-muted-foreground'}>
                                  {uc.name}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      <div className="flex items-center gap-4 text-xs text-muted-foreground">
                        <span>
                          {getUseCaseCount(exp)} use case{getUseCaseCount(exp) !== 1 ? 's' : ''}
                        </span>
                        <span className="text-muted-foreground/50">·</span>
                        <span>
                          Runs: {getRunNames(exp)}
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
                      {!isRunning && exp.runs && exp.runs.length > 0 && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setViewingResultsFor(exp)}
                        >
                          <Eye size={14} className="mr-1" />
                          View Latest
                        </Button>
                      )}
                      {/* Add Run button - creates new run */}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleAddRun(exp)}
                        disabled={runningExperimentId !== null}
                      >
                        {isRunning ? (
                          <>
                            <RefreshCw size={14} className="mr-1 animate-spin" />
                            {runProgress ? (
                              `${runProgress.currentTestCaseIndex + 1}/${runProgress.totalTestCases}`
                            ) : (
                              'Starting...'
                            )}
                          </>
                        ) : (
                          <>
                            <Plus size={14} className="mr-1" />
                            Add Run
                          </>
                        )}
                      </Button>
                      {!isRunning && (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleDeleteExperiment(exp)}
                          className="text-red-400 hover:text-red-300 hover:bg-red-500/10"
                        >
                          <Trash2 size={14} />
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

      {/* Experiment Editor Dialog */}
      {isEditorOpen && (
        <ExperimentEditor
          experiment={editingExperiment}
          onSave={handleSaveExperiment}
          onSaveAndRun={handleSaveAndRun}
          onCancel={() => setIsEditorOpen(false)}
        />
      )}

      {/* Run Configuration Dialog */}
      {isRunConfigOpen && runConfigExperiment && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <Card className="w-full max-w-md">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-lg">Configure Run</CardTitle>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => {
                  setIsRunConfigOpen(false);
                  setRunConfigExperiment(null);
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
                    setRunConfigExperiment(null);
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
