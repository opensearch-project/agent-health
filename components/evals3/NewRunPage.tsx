/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * NewRunPage — Dynamic Run Composer
 *
 * Multi-step wizard for creating evaluation runs with composable sources:
 *   Step 1: Select sources (benchmark, test cases, file upload, labels)
 *   Step 2: Configure agent/model/concurrency
 *   Step 3: Execute (redirects to run detail with live updates)
 *
 * Route: /evaluations/new-run
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { usePersistedState } from '@/hooks/usePersistedState';
import { PREFS_KEYS } from '@/lib/preferences';
import { useNavigate, useLocation } from 'react-router-dom';
import { useClusterContext } from '@/hooks/useClusterContext';
import { ClusterContextBanner } from '@/components/comparison/ClusterContextBanner';
import {
  Loader2, Plus, X, FileText, FolderOpen, Tag, Database, ArrowRight, ArrowLeft,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { asyncBenchmarkStorage, asyncTestCaseStorage } from '@/services/storage';
import { Benchmark, TestCase, TestCaseSource } from '@/types';
import { DEFAULT_CONFIG } from '@/lib/constants';
import { executeEvaluationRun } from '@/services/client/evaluationRunsApi';
import { Breadcrumbs } from './Breadcrumbs';

// ─── Types ──────────────────────────────────────────────────────────────────

interface SourceEntry {
  id: string;
  source: TestCaseSource;
  label: string;
  count?: number;
}

// ─── Main Component ──────────────────────────────────────────────────────────

export const NewRunPage: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();

  // Step state
  const [step, setStep] = useState<1 | 2>(1);

  // Source selection (Step 1)
  const [sources, setSources] = useState<SourceEntry[]>([]);
  const [benchmarks, setBenchmarks] = useState<Benchmark[]>([]);
  const [testCases, setTestCases] = useState<TestCase[]>([]);
  const [loadingData, setLoadingData] = useState(true);

  // Source input states
  const [selectedBenchmark, setSelectedBenchmark] = useState('');
  const [selectedTestCases, setSelectedTestCases] = useState<string[]>([]);
  const [labelInput, setLabelInput] = useState('');
  const [labels, setLabels] = useState<string[]>([]);

  // Configuration (Step 2) - persisted across sessions, shared with QuickRunModal
  // and other run-config dropdowns via the `prefs:*` namespace.
  const [agentKey, setAgentKey] = usePersistedState(PREFS_KEYS.agentKey, DEFAULT_CONFIG.agents.find(a => a.enabled !== false)?.key || '');
  // The agent's LLM comes from the AGENT's own config (connectorConfig.model /
  // env.ANTHROPIC_MODEL), NOT a user-picked selector — picking a model
  // separately is misleading (subprocess agents ignore it and use their own).
  const agentModel = (key: string): string => {
    const a = DEFAULT_CONFIG.agents.find(x => x.key === key);
    return (a?.connectorConfig?.model as string) || (a?.connectorConfig?.env?.ANTHROPIC_MODEL as string) || '';
  };
  // Judge's LLM — distinct from the agent's `modelId`. `undefined` means
  // "use the evaluator's inferenceConfig.modelId, falling back to
  // BEDROCK_MODEL_ID env" (the right setting for agentic-provider judges,
  // which pick their own model regardless). See QuickRunModal for the same
  // pattern — same pref key so the choice is shared across run-config
  // surfaces.
  const [judgeModelId, setJudgeModelId] = usePersistedState<string | undefined>('quick-run:judgeModelId', undefined);
  // Evaluator isn't user-selectable in the composer, but a Re-run preserves
  // the source run's evaluator silently so the re-run is faithful.
  const [evaluatorId, setEvaluatorId] = useState<string | undefined>(undefined);
  const [concurrency, setConcurrency] = usePersistedState('new-run:concurrency', 1);
  const [runName, setRunName] = useState('');
  const [benchmarkAssociation, setBenchmarkAssociation] = useState('none');

  // Execution state
  const [executing, setExecuting] = useState(false);
  const [executeError, setExecuteError] = useState<string | null>(null);

  // Cluster context — when present, auto-add the cluster's failing test
  // cases as a source so the user lands on Step 2 with the right scope.
  const { context: clusterContext } = useClusterContext();
  const hasSeededFromCluster = useRef(false);

  // Re-run seeding — EvalRunDetailPage's "Re-run" navigates here with the
  // source run's stored config so the composer opens pre-filled. Shape is
  // a subset of the run document; loose-typed (location.state is `unknown`).
  const restartFrom = (location.state as any)?.restartFrom as
    | Partial<{ name: string; sources: TestCaseSource[]; agentKey: string; evaluatorId: string; judgeModelId: string; benchmarkId: string }>
    | undefined;
  const hasSeededFromRestart = useRef(false);

  const enabledAgents = DEFAULT_CONFIG.agents.filter(a => a.enabled !== false);

  // Build a SourceEntry from a raw TestCaseSource. Used by the Re-run seeder
  // (which receives heterogenous source types from a stored run document).
  // The cluster seeder only ever produces a `test-case-ids` source with a
  // richer label that includes the cluster name, so it stays inline below.
  const buildSourceEntry = useCallback((src: TestCaseSource, idPrefix: string, idx: number): SourceEntry => {
    let label = 'Source';
    let count: number | undefined;
    if (src.type === 'test-case-ids') {
      count = (src as any).ids?.length || 0;
      label = `${count} test case${count === 1 ? '' : 's'}`;
    } else if (src.type === 'benchmark') {
      const bm = benchmarks.find(b => b.id === (src as any).benchmarkId);
      label = `Benchmark: ${bm?.name || (src as any).benchmarkId}`;
      count = bm?.testCaseIds?.length;
    } else if (src.type === 'label-filter') {
      label = `Labels: ${((src as any).labels || []).join(', ')}`;
    }
    return { id: `${idPrefix}-${idx}`, source: src, label, count };
  }, [benchmarks]);

  // Seed sources from cluster context exactly once after the page loads
  // its data. Auto-advances to Step 2 because the source is already chosen.
  useEffect(() => {
    if (!clusterContext) return;
    if (hasSeededFromCluster.current) return;
    if (loadingData) return;
    if (clusterContext.caseIds.length === 0) return;
    hasSeededFromCluster.current = true;
    const seededSource: SourceEntry = {
      id: `cluster-${clusterContext.id}`,
      source: { type: 'test-case-ids', ids: [...clusterContext.caseIds] },
      label: `${clusterContext.caseIds.length} case${clusterContext.caseIds.length === 1 ? '' : 's'} from "${clusterContext.name}"`,
      count: clusterContext.caseIds.length,
    };
    setSources([seededSource]);
    setRunName(`Re-run: ${clusterContext.name}`);
    setStep(2);
  }, [clusterContext, loadingData]);

  // Seed the whole composer from a source run (the "Re-run" action). Restores
  // sources, agent, evaluator, judge model, and benchmark association, then
  // lands on Step 2. The agent's model is resolved from the agent config.
  useEffect(() => {
    if (!restartFrom) return;
    if (hasSeededFromRestart.current) return;
    if (loadingData) return;
    hasSeededFromRestart.current = true;
    const entries = (restartFrom.sources || []).map((src, i) => buildSourceEntry(src, 'restart', i));
    if (entries.length > 0) setSources(entries);
    if (restartFrom.agentKey) setAgentKey(restartFrom.agentKey);
    if (restartFrom.judgeModelId) setJudgeModelId(restartFrom.judgeModelId);
    if (restartFrom.evaluatorId) setEvaluatorId(restartFrom.evaluatorId);
    if (restartFrom.benchmarkId) setBenchmarkAssociation(restartFrom.benchmarkId);
    setRunName(`Re-run: ${restartFrom.name || 'run'}`);
    setStep(2);
  }, [restartFrom, loadingData, buildSourceEntry]);

  // Load benchmarks and test cases
  useEffect(() => {
    (async () => {
      setLoadingData(true);
      try {
        const [bms, tcs] = await Promise.all([
          asyncBenchmarkStorage.getAll(),
          asyncTestCaseStorage.getAll(),
        ]);
        setBenchmarks(bms);
        setTestCases(tcs);
      } catch (err) {
        console.error('Failed to load data:', err);
      } finally {
        setLoadingData(false);
      }
    })();
  }, []);

  // Source management
  const addBenchmarkSource = () => {
    if (!selectedBenchmark) return;
    const bm = benchmarks.find(b => b.id === selectedBenchmark);
    if (!bm) return;
    const entry: SourceEntry = {
      id: `bm-${bm.id}`,
      source: { type: 'benchmark', benchmarkId: bm.id },
      label: `Benchmark: ${bm.name}`,
      count: bm.testCaseIds?.length || 0,
    };
    setSources(prev => [...prev.filter(s => s.id !== entry.id), entry]);
    setSelectedBenchmark('');
  };

  const addTestCaseSources = () => {
    if (selectedTestCases.length === 0) return;
    const entry: SourceEntry = {
      id: `tc-ids-${selectedTestCases.join(',')}`,
      source: { type: 'test-case-ids', ids: [...selectedTestCases] },
      label: `${selectedTestCases.length} test case(s)`,
      count: selectedTestCases.length,
    };
    setSources(prev => [...prev.filter(s => !s.id.startsWith('tc-ids-')), entry]);
    setSelectedTestCases([]);
  };

  const addLabelSource = () => {
    if (labels.length === 0) return;
    const entry: SourceEntry = {
      id: `labels-${labels.join(',')}`,
      source: { type: 'label-filter', labels: [...labels] },
      label: `Labels: ${labels.join(', ')}`,
    };
    setSources(prev => [...prev.filter(s => !s.id.startsWith('labels-')), entry]);
    setLabels([]);
  };

  const removeSource = (id: string) => {
    setSources(prev => prev.filter(s => s.id !== id));
  };

  const handleLabelKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && labelInput.trim()) {
      e.preventDefault();
      setLabels(prev => [...prev, labelInput.trim()]);
      setLabelInput('');
    }
  };

  // Execute
  const handleExecute = async () => {
    if (sources.length === 0) return;
    setExecuting(true);
    setExecuteError(null);

    try {
      const sourcesPayload: TestCaseSource[] = sources.map(s => s.source);

      const result = await executeEvaluationRun(
        {
          name: runName || `Run ${new Date().toLocaleDateString()}`,
          sources: sourcesPayload,
          agentKey,
          modelId: agentModel(agentKey),
          // Customer-supplied judge model (separate dropdown).
          judgeModelId,
          // Preserved from a Re-run so the re-run uses the same evaluator.
          evaluatorId,
          concurrency,
          benchmarkId: benchmarkAssociation !== 'none' ? benchmarkAssociation : undefined,
          trigger: 'ui',
        },
        () => {}, // progress handled on detail page
      );

      navigate(`/evaluations/runs/${result.id}`);
    } catch (err: any) {
      setExecuteError(err.message);
      setExecuting(false);
    }
  };

  if (loadingData) {
    return (
      <div className="flex-1 p-6 flex items-center justify-center">
        <Loader2 size={24} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        <Breadcrumbs items={[
          { label: 'Runs', href: '/evaluations/runs' },
          { label: 'New Run' },
        ]} />

        <h1 className="text-xl font-semibold">Create Evaluation Run</h1>

        {clusterContext && (
          <ClusterContextBanner context={clusterContext} />
        )}

        {step === 1 && (
          <div className="space-y-6">
            {/* Source Selection */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Left: Add Sources */}
              <div className="space-y-4">
                <h2 className="text-sm font-medium">Add Sources</h2>

                {/* From Benchmark */}
                <div className="bg-card border rounded-lg p-4 space-y-2">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Database size={14} /> From Benchmark
                  </div>
                  <div className="flex gap-2">
                    <Select value={selectedBenchmark} onValueChange={setSelectedBenchmark}>
                      <SelectTrigger className="flex-1 h-8 text-xs">
                        <SelectValue placeholder="Select benchmark..." />
                      </SelectTrigger>
                      <SelectContent>
                        {benchmarks.map(bm => (
                          <SelectItem key={bm.id} value={bm.id}>
                            {bm.name} ({bm.testCaseIds?.length || 0} cases)
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button size="sm" variant="outline" onClick={addBenchmarkSource} disabled={!selectedBenchmark}>
                      <Plus size={14} />
                    </Button>
                  </div>
                </div>

                {/* From Test Cases */}
                <div className="bg-card border rounded-lg p-4 space-y-2">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <FileText size={14} /> Specific Test Cases
                  </div>
                  <div className="max-h-32 overflow-y-auto space-y-1">
                    {testCases.map(tc => (
                      <label key={tc.id} className="flex items-center gap-2 text-xs cursor-pointer hover:bg-muted/50 px-1 rounded">
                        <input
                          type="checkbox"
                          className="rounded"
                          checked={selectedTestCases.includes(tc.id)}
                          onChange={e => {
                            if (e.target.checked) setSelectedTestCases(prev => [...prev, tc.id]);
                            else setSelectedTestCases(prev => prev.filter(id => id !== tc.id));
                          }}
                        />
                        {tc.name}
                      </label>
                    ))}
                  </div>
                  {selectedTestCases.length > 0 && (
                    <Button size="sm" variant="outline" onClick={addTestCaseSources}>
                      <Plus size={14} className="mr-1" /> Add {selectedTestCases.length} selected
                    </Button>
                  )}
                </div>

                {/* By Labels */}
                <div className="bg-card border rounded-lg p-4 space-y-2">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Tag size={14} /> Filter by Labels
                  </div>
                  <div className="flex gap-2">
                    <Input
                      className="h-8 text-xs"
                      placeholder="Type label and press Enter..."
                      value={labelInput}
                      onChange={e => setLabelInput(e.target.value)}
                      onKeyDown={handleLabelKeyDown}
                    />
                  </div>
                  {labels.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {labels.map(l => (
                        <Badge key={l} variant="secondary" className="text-xs">
                          {l}
                          <button className="ml-1" onClick={() => setLabels(prev => prev.filter(x => x !== l))}>
                            <X size={10} />
                          </button>
                        </Badge>
                      ))}
                      <Button size="sm" variant="outline" className="h-5 text-xs" onClick={addLabelSource}>
                        <Plus size={10} className="mr-1" /> Add
                      </Button>
                    </div>
                  )}
                </div>
              </div>

              {/* Right: Preview */}
              <div className="space-y-4">
                <h2 className="text-sm font-medium">Selected Sources ({sources.length})</h2>
                <div className="bg-card border rounded-lg p-4 min-h-[200px]">
                  {sources.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-8">
                      No sources added yet. Select test cases from the left panel.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {sources.map(s => (
                        <div key={s.id} className="flex items-center justify-between bg-muted/30 rounded px-3 py-2">
                          <div className="flex items-center gap-2">
                            <Badge variant="outline" className="text-xs">{s.source.type}</Badge>
                            <span className="text-sm">{s.label}</span>
                            {s.count !== undefined && (
                              <span className="text-xs text-muted-foreground">({s.count})</span>
                            )}
                          </div>
                          <button className="text-muted-foreground hover:text-foreground" onClick={() => removeSource(s.id)}>
                            <X size={14} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="flex justify-end">
              <Button onClick={() => setStep(2)} disabled={sources.length === 0}>
                Next: Configure <ArrowRight size={14} className="ml-1" />
              </Button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-6 max-w-lg">
            <h2 className="text-sm font-medium">Configuration</h2>

            <div className="space-y-4">
              <div>
                <label className="text-xs text-muted-foreground">Run Name</label>
                <Input
                  className="mt-1"
                  placeholder="My evaluation run"
                  value={runName}
                  onChange={e => setRunName(e.target.value)}
                />
              </div>

              <div>
                <label className="text-xs text-muted-foreground">Agent</label>
                <Select value={agentKey} onValueChange={setAgentKey}>
                  <SelectTrigger className="mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {enabledAgents.map(a => (
                      <SelectItem key={a.key} value={a.key}>{a.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <label className="text-xs text-muted-foreground">Judge Model</label>
                <Select
                  value={judgeModelId || '__default__'}
                  onValueChange={val => setJudgeModelId(val === '__default__' ? undefined : val)}
                >
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder="Use evaluator default" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__default__">Use evaluator default</SelectItem>
                    {Object.entries(DEFAULT_CONFIG.models).map(([key, m]) => (
                      <SelectItem key={key} value={key}>{(m as any).display_name || key}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <label className="text-xs text-muted-foreground">Concurrency</label>
                <Input
                  type="number"
                  min={1}
                  max={20}
                  className="mt-1 w-24"
                  value={concurrency}
                  onChange={e => setConcurrency(Math.max(1, Math.min(20, parseInt(e.target.value) || 1)))}
                />
              </div>

              <div>
                <label className="text-xs text-muted-foreground">Associate with Benchmark (optional)</label>
                <Select value={benchmarkAssociation} onValueChange={setBenchmarkAssociation}>
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder="None (ad-hoc run)" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None (ad-hoc run)</SelectItem>
                    {benchmarks.map(bm => (
                      <SelectItem key={bm.id} value={bm.id}>{bm.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {executeError && (
              <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded p-3 text-sm text-red-700 dark:text-red-300">
                {executeError}
              </div>
            )}

            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => setStep(1)}>
                <ArrowLeft size={14} className="mr-1" /> Back
              </Button>
              <Button onClick={handleExecute} disabled={executing}>
                {executing ? <Loader2 size={14} className="mr-1 animate-spin" /> : null}
                Launch Run
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
