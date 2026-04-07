/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo } from 'react';
import { X, ChevronRight, ChevronLeft, Plus, Trash2, Check, Loader2, AlertTriangle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Benchmark, TestCase, RunConfigInput } from '@/types';
import { asyncBenchmarkStorage, asyncTestCaseStorage } from '@/services/storage';
import { DEFAULT_CONFIG } from '@/lib/constants';

interface BenchmarkEditorProps {
  benchmark: Benchmark | null;
  onSave: (benchmark: Benchmark) => void;
  onSaveAndRun?: (benchmark: Benchmark, runConfigs: RunConfigForExecution[]) => void;
  onCancel: () => void;
}

// Re-export for backwards compatibility - now using shared type from @/types
export type RunConfigForExecution = RunConfigInput;

type Step = 'info' | 'useCases' | 'runs';

// Partial run config (without results, which are filled during execution)
interface RunConfig {
  id: string;
  name: string;
  description?: string;
  agentKey: string;
  modelId: string;
  headers?: Record<string, string>;
}

export const BenchmarkEditor: React.FC<BenchmarkEditorProps> = ({
  benchmark,
  onSave,
  onSaveAndRun,
  onCancel,
}) => {
  const [step, setStep] = useState<Step>('info');
  const [name, setName] = useState(benchmark?.name || '');
  const [description, setDescription] = useState(benchmark?.description || '');
  const [selectedUseCaseIds, setSelectedUseCaseIds] = useState<Set<string>>(
    new Set(benchmark?.testCaseIds || [])
  );
  // Always start with a fresh default run - the Runs step is for defining NEW runs to execute,
  // not for viewing historical runs (which are shown on the BenchmarkRunsPage)
  const [runs, setRuns] = useState<RunConfig[]>([createDefaultRun()]);
  const [categoryFilter, setCategoryFilter] = useState<string>('all');

  // Load all test cases from storage (previously only promoted, but TestCasesPage doesn't have promotion)
  const [allTestCases, setAllTestCases] = useState<TestCase[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Track if test cases changed from original (will create new version)
  const testCasesChanged = useMemo(() => {
    if (!benchmark) return false;
    const original = new Set(benchmark.testCaseIds);
    if (original.size !== selectedUseCaseIds.size) return true;
    for (const id of selectedUseCaseIds) {
      if (!original.has(id)) return true;
    }
    return false;
  }, [benchmark, selectedUseCaseIds]);

  // Track if only metadata changed (won't create new version)
  const metadataChanged = useMemo(() => {
    if (!benchmark) return false;
    return name !== benchmark.name || description !== (benchmark.description || '');
  }, [benchmark, name, description]);

  useEffect(() => {
    const loadTestCases = async () => {
      setIsLoading(true);
      try {
        const testCases = await asyncTestCaseStorage.getAll();
        setAllTestCases(testCases);
        // Extract unique categories from test cases
        const uniqueCategories = Array.from(new Set(testCases.map(tc => tc.category))).sort();
        setCategories(uniqueCategories);
      } finally {
        setIsLoading(false);
      }
    };
    loadTestCases();
  }, []);

  function createDefaultRun(): RunConfig {
    const defaultAgent = DEFAULT_CONFIG.agents[1] || DEFAULT_CONFIG.agents[0];
    return {
      id: asyncBenchmarkStorage.generateRunId(),
      name: 'Baseline',
      agentKey: defaultAgent.key,
      modelId: defaultAgent.models[0] || 'claude-sonnet-4.5',
    };
  }

  const filteredTestCases = categoryFilter === 'all'
    ? allTestCases
    : allTestCases.filter(tc => tc.category === categoryFilter);

  const handleToggleUseCase = (id: string) => {
    setSelectedUseCaseIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleSelectAllInCategory = () => {
    const ids = filteredTestCases.map(tc => tc.id);
    setSelectedUseCaseIds(prev => {
      const next = new Set(prev);
      ids.forEach(id => next.add(id));
      return next;
    });
  };

  const handleDeselectAllInCategory = () => {
    const ids = new Set(filteredTestCases.map(tc => tc.id));
    setSelectedUseCaseIds(prev => {
      const next = new Set(prev);
      ids.forEach(id => next.delete(id));
      return next;
    });
  };

  const handleAddRun = () => {
    const runNum = runs.length + 1;
    const defaultAgent = DEFAULT_CONFIG.agents[1] || DEFAULT_CONFIG.agents[0];
    setRuns(prev => [...prev, {
      id: asyncBenchmarkStorage.generateRunId(),
      name: `Run ${runNum}`,
      agentKey: defaultAgent.key,
      modelId: defaultAgent.models[0] || 'claude-sonnet-4.5',
    }]);
  };

  const handleRemoveRun = (runId: string) => {
    if (runs.length <= 1) return;
    setRuns(prev => prev.filter(r => r.id !== runId));
  };

  const handleUpdateRun = (runId: string, updates: Partial<RunConfig>) => {
    setRuns(prev => prev.map(r =>
      r.id === runId ? { ...r, ...updates } : r
    ));
  };

  const handleSave = async () => {
    // For new benchmarks, we don't include runs - they'll be created during execution
    // For existing benchmarks, we keep the runs
    const isNewBenchmark = !benchmark;

    if (isNewBenchmark) {
      // Create new benchmark with initial version
      const bench: Benchmark = {
        id: asyncBenchmarkStorage.generateBenchmarkId(),
        name,
        description: description || undefined,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        currentVersion: 1,
        versions: [{
          version: 1,
          createdAt: new Date().toISOString(),
          testCaseIds: Array.from(selectedUseCaseIds),
        }],
        testCaseIds: Array.from(selectedUseCaseIds),
        runs: [],
      };

      if (onSaveAndRun && runs.length > 0) {
        // For new benchmarks, save and immediately trigger all configured runs
        const runConfigs: RunConfigForExecution[] = runs.map(run => ({
          name: run.name,
          description: run.description,
          agentKey: run.agentKey,
          modelId: run.modelId,
          headers: run.headers,
        }));
        onSaveAndRun(bench, runConfigs);
      } else {
        onSave(bench);
      }
    } else {
      // Update existing benchmark - let backend handle versioning
      const updated = await asyncBenchmarkStorage.update(benchmark.id, {
        name,
        description: description || undefined,
        testCaseIds: testCasesChanged ? Array.from(selectedUseCaseIds) : undefined,
      });

      if (updated) {
        // If test cases changed (new version), run the new version with configured runs
        if (testCasesChanged && onSaveAndRun && runs.length > 0) {
          const runConfigs: RunConfigForExecution[] = runs.map(run => ({
            name: run.name,
            description: run.description,
            agentKey: run.agentKey,
            modelId: run.modelId,
            headers: run.headers,
          }));
          onSaveAndRun(updated, runConfigs);
        } else {
          onSave(updated);
        }
      }
    }
  };

  const canProceedFromInfo = name.trim().length > 0;
  const canProceedFromUseCases = selectedUseCaseIds.size > 0;
  const canSave = canProceedFromInfo && canProceedFromUseCases && runs.length > 0;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <Card className="w-full max-w-3xl max-h-[90vh] flex flex-col">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <div className="flex items-center gap-3">
            <CardTitle>
              {benchmark ? 'Edit Benchmark' : 'Create Benchmark'}
            </CardTitle>
            {benchmark && (
              <Badge variant="outline" className="text-xs">
                v{benchmark.currentVersion}
              </Badge>
            )}
          </div>
          <Button variant="ghost" size="icon" onClick={onCancel}>
            <X size={18} />
          </Button>
        </CardHeader>

        {/* Step Indicator */}
        <div className="px-6 pb-4 border-b">
          <div className="flex items-center gap-2">
            <StepIndicator
              step={1}
              label="Info"
              isActive={step === 'info'}
              isComplete={step !== 'info'}
            />
            <ChevronRight size={16} className="text-muted-foreground" />
            <StepIndicator
              step={2}
              label="Use Cases"
              isActive={step === 'useCases'}
              isComplete={step === 'runs'}
            />
            <ChevronRight size={16} className="text-muted-foreground" />
            <StepIndicator
              step={3}
              label="Runs"
              isActive={step === 'runs'}
              isComplete={false}
            />
          </div>
        </div>

        <CardContent className="flex-1 overflow-hidden p-0">
          <ScrollArea className="h-[60vh] p-6">
            {/* Step 1: Basic Info */}
            {step === 'info' && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="name">Benchmark Name *</Label>
                  <Input
                    id="name"
                    value={name}
                    onChange={e => setName(e.target.value)}
                    placeholder="e.g., PPL Parse Context Ablation"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="description">Description (optional)</Label>
                  <Textarea
                    id="description"
                    value={description}
                    onChange={e => setDescription(e.target.value)}
                    placeholder="Describe what this benchmark tests..."
                    rows={3}
                  />
                </div>
              </div>
            )}

            {/* Step 2: Select Use Cases */}
            {step === 'useCases' && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div className="space-y-1">
                    <Label>Filter by Category</Label>
                    <Select value={categoryFilter} onValueChange={setCategoryFilter}>
                      <SelectTrigger className="w-64">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All Categories</SelectItem>
                        {categories.map(cat => (
                          <SelectItem key={cat} value={cat}>{cat}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={handleSelectAllInCategory}>
                      Select All
                    </Button>
                    <Button variant="outline" size="sm" onClick={handleDeselectAllInCategory}>
                      Deselect All
                    </Button>
                  </div>
                </div>

                <div className="flex items-center justify-between">
                  <div className="text-sm text-muted-foreground">
                    Selected: {selectedUseCaseIds.size} use case{selectedUseCaseIds.size !== 1 ? 's' : ''}
                  </div>
                  {benchmark && testCasesChanged && (
                    <div className="flex items-center gap-2 text-sm text-yellow-500">
                      <AlertTriangle size={14} />
                      <span>Will create v{benchmark.currentVersion + 1}</span>
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  {filteredTestCases.map(tc => (
                    <div
                      key={tc.id}
                      className={`p-3 rounded border cursor-pointer transition-colors ${
                        selectedUseCaseIds.has(tc.id)
                          ? 'bg-opensearch-blue/10 border-opensearch-blue/50'
                          : 'bg-muted/30 border-border hover:border-muted-foreground/30'
                      }`}
                      onClick={() => handleToggleUseCase(tc.id)}
                    >
                      <div className="flex items-center gap-3">
                        <Checkbox
                          checked={selectedUseCaseIds.has(tc.id)}
                          onClick={(e) => e.stopPropagation()}
                          onCheckedChange={() => handleToggleUseCase(tc.id)}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-medium truncate">{tc.name}</span>
                            <Badge variant="outline" className="text-xs">
                              {tc.difficulty}
                            </Badge>
                          </div>
                          <div className="text-xs text-muted-foreground truncate mt-0.5">
                            {tc.category}
                            {tc.subcategory && ` · ${tc.subcategory}`}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Step 3: Define Runs */}
            {step === 'runs' && (
              <div className="space-y-4">
                {runs.map((run, index) => (
                  <Card key={run.id} className="bg-muted/30">
                    <CardContent className="p-4">
                      <div className="flex items-center justify-between mb-4">
                        <h4 className="font-medium">Run {index + 1}</h4>
                        {runs.length > 1 && (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleRemoveRun(run.id)}
                            className="text-red-400 hover:text-red-300 hover:bg-red-500/10"
                          >
                            <Trash2 size={14} />
                          </Button>
                        )}
                      </div>

                      <div className="grid gap-4">
                        <div className="space-y-2">
                          <Label>Run Name</Label>
                          <Input
                            value={run.name}
                            onChange={e => handleUpdateRun(run.id, { name: e.target.value })}
                            placeholder="e.g., Baseline, With Fix, Claude 4 Test"
                          />
                        </div>

                        <div className="space-y-2">
                          <Label>Description (optional)</Label>
                          <Textarea
                            value={run.description || ''}
                            onChange={e => handleUpdateRun(run.id, { description: e.target.value || undefined })}
                            placeholder="Describe what this run tests or changes..."
                            rows={2}
                          />
                        </div>

                        <div className="grid grid-cols-2 gap-4">
                          <div className="space-y-2">
                            <Label>Agent</Label>
                            <Select
                              value={run.agentKey}
                              onValueChange={val => handleUpdateRun(run.id, { agentKey: val })}
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
                              value={run.modelId}
                              onValueChange={val => handleUpdateRun(run.id, { modelId: val })}
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
                      </div>
                    </CardContent>
                  </Card>
                ))}

                <Button variant="outline" onClick={handleAddRun} className="w-full">
                  <Plus size={16} className="mr-2" />
                  Add Run
                </Button>
              </div>
            )}
          </ScrollArea>
        </CardContent>

        {/* Footer Navigation */}
        <div className="p-4 border-t flex justify-between">
          <div>
            {step !== 'info' && (
              <Button
                variant="outline"
                onClick={() => setStep(step === 'runs' ? 'useCases' : 'info')}
              >
                <ChevronLeft size={16} className="mr-1" />
                Back
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            {step === 'info' && (
              <Button
                onClick={() => setStep('useCases')}
                disabled={!canProceedFromInfo}
              >
                Next: Select Use Cases
                <ChevronRight size={16} className="ml-1" />
              </Button>
            )}
            {step === 'useCases' && (
              benchmark && !testCasesChanged ? (
                <Button
                  onClick={handleSave}
                  disabled={!canProceedFromUseCases}
                  className="bg-opensearch-blue hover:bg-blue-600"
                >
                  <Check size={16} className="mr-1" />
                  Save Changes
                </Button>
              ) : (
                <Button
                  onClick={() => setStep('runs')}
                  disabled={!canProceedFromUseCases}
                >
                  Next: Define Runs
                  <ChevronRight size={16} className="ml-1" />
                </Button>
              )
            )}
            {step === 'runs' && (
              <Button
                onClick={handleSave}
                disabled={!canSave}
                className="bg-opensearch-blue hover:bg-blue-600"
              >
                <Check size={16} className="mr-1" />
                {!benchmark
                  ? 'Create & Run Benchmark'
                  : testCasesChanged
                    ? `Save & Run v${benchmark.currentVersion + 1}`
                    : 'Save Changes'}
              </Button>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
};

// Step Indicator Component
const StepIndicator: React.FC<{
  step: number;
  label: string;
  isActive: boolean;
  isComplete: boolean;
}> = ({ step, label, isActive, isComplete }) => (
  <div className={`flex items-center gap-2 ${isActive ? 'text-opensearch-blue' : isComplete ? 'text-muted-foreground' : 'text-muted-foreground/50'}`}>
    <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium ${
      isActive ? 'bg-opensearch-blue text-white' :
      isComplete ? 'bg-muted text-muted-foreground' :
      'bg-muted/50 text-muted-foreground/50'
    }`}>
      {isComplete ? <Check size={12} /> : step}
    </div>
    <span className="text-sm font-medium">{label}</span>
  </div>
);

// Backwards compatibility alias
/** @deprecated Use BenchmarkEditor instead */
export const ExperimentEditor = BenchmarkEditor;
