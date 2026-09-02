/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * RerunConfirmDialog — shared "re-run this evaluation run" dialog. Used from
 * the run report page header (EvalRunDetailPage), the evaluation-runs list's
 * row action (EvalRunsPage), and the inspector header (RunInspectorPage).
 *
 * Prefilled from the source run's config — agent, evaluator, judge model,
 * concurrency, and test-case source (benchmark association) — using the
 * SAME field set as the Add-Run "Configure Run" dialog (BenchmarkRunsPage's
 * Run Configuration Dialog): Select for Agent, Select for Evaluator,
 * JudgeModelSelect for the judge model. Every field is tweakable before
 * launch. POSTs /api/storage/evaluation-runs/:id/rerun with only the fields
 * that differ from the source run — the server records `rerunOf` either
 * way, and additionally flags `modified: true` when anything was tweaked
 * (see lib/evaluationRerun.ts applyRerunOverrides), so a faithful duplicate
 * is never confused with a tweaked one.
 */

import React, { useEffect, useState } from 'react';
import { Loader2, RotateCcw, AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { JudgeModelSelect } from '@/components/JudgeModelSelect';
import { EvaluationRun, Evaluator, Benchmark } from '@/types';
import { DEFAULT_CONFIG } from '@/lib/constants';
import { ENV_CONFIG } from '@/lib/config';
import { computeRerunName } from '@/lib/evaluationRerun';
import { rerunEvaluationRun, RerunOverrides } from '@/services/client';
import { asyncBenchmarkStorage } from '@/services/storage';

export interface RerunConfirmDialogProps {
  /** The source run to duplicate. Dialog renders nothing while this is null. */
  run: EvaluationRun | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the newly-created run's id once the POST succeeds. */
  onRerun: (newRunId: string) => void;
}

const NO_BENCHMARK = '__none__';

export const RerunConfirmDialog: React.FC<RerunConfirmDialogProps> = ({ run, open, onOpenChange, onRerun }) => {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Tweakable fields — seeded from the source run whenever the dialog opens
  // for a (possibly new) run. `null` sentinels for judgeModelId/evaluatorId
  // distinguish "use default" from "unset" the same way the Add-Run dialog
  // does.
  const [name, setName] = useState('');
  const [agentKey, setAgentKey] = useState('');
  const [evaluatorId, setEvaluatorId] = useState('');
  const [judgeModelId, setJudgeModelId] = useState('');
  const [concurrency, setConcurrency] = useState(1);
  const [benchmarkId, setBenchmarkId] = useState<string>(NO_BENCHMARK);

  const [evaluators, setEvaluators] = useState<Evaluator[]>([]);
  const [benchmarks, setBenchmarks] = useState<Benchmark[]>([]);

  useEffect(() => {
    if (!open || !run) return;
    setName(computeRerunName(run.name));
    setAgentKey(run.agentKey || '');
    setEvaluatorId(run.evaluatorId || '');
    setJudgeModelId(run.judgeModelId || '');
    setConcurrency(run.concurrency || 1);
    setBenchmarkId(run.benchmarkId || NO_BENCHMARK);
    setError(null);
    setAdvancedOpen(false);
  }, [open, run]);

  // Evaluators + benchmarks for the "tweak" selects — same data every other
  // run-config dialog in the app loads (see QuickRunModal, BenchmarkRunsPage).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`${ENV_CONFIG.backendUrl}/api/storage/evaluators`);
        if (response.ok) {
          const data = await response.json();
          if (!cancelled) setEvaluators(data.evaluators || []);
        }
      } catch { /* evaluator dropdown just shows the default option */ }
      try {
        const bms = await asyncBenchmarkStorage.getAll();
        if (!cancelled) setBenchmarks(bms);
      } catch { /* benchmark-swap dropdown just shows "no benchmark" */ }
    })();
    return () => { cancelled = true; };
  }, [open]);

  const handleOpenChange = (next: boolean) => {
    if (submitting) return; // Don't let a stray click close mid-request
    if (!next) setError(null);
    onOpenChange(next);
  };

  if (!run) return null;

  const agentName = DEFAULT_CONFIG.agents.find(a => a.key === agentKey)?.name || agentKey;
  const testCaseCount = run.testCaseSnapshots?.length ?? 0;

  // Whether the current form state differs from the source run's config —
  // purely a UI hint ("Modified" badge); the server recomputes this itself
  // authoritatively from the overrides it actually receives.
  const isModified =
    agentKey !== (run.agentKey || '') ||
    (evaluatorId || undefined) !== run.evaluatorId ||
    (judgeModelId || undefined) !== run.judgeModelId ||
    concurrency !== (run.concurrency || 1) ||
    benchmarkId !== (run.benchmarkId || NO_BENCHMARK);

  const handleConfirm = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const overrides: RerunOverrides = {
        name: name.trim() || undefined,
        agentKey: agentKey !== run.agentKey ? agentKey : undefined,
        judgeModelId: judgeModelId !== (run.judgeModelId || '') ? (judgeModelId || null) : undefined,
        evaluatorId: evaluatorId !== (run.evaluatorId || '') ? (evaluatorId || null) : undefined,
        concurrency: concurrency !== (run.concurrency || 1) ? concurrency : undefined,
        benchmarkId: benchmarkId !== (run.benchmarkId || NO_BENCHMARK)
          ? (benchmarkId === NO_BENCHMARK ? null : benchmarkId)
          : undefined,
      };
      const result = await rerunEvaluationRun(run.id, overrides);
      setSubmitting(false);
      onOpenChange(false);
      onRerun(result.runId);
    } catch (err: any) {
      setSubmitting(false);
      setError(err.message || 'Failed to re-run evaluation run');
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent data-testid="rerun-confirm-dialog" className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RotateCcw size={16} /> Re-run evaluation
          </DialogTitle>
          <DialogDescription>
            Prefilled from this run's configuration — tweak anything below before
            launching. Test-case sources are re-resolved at launch time, so results
            may differ if the underlying test cases changed since.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <div className="space-y-1.5">
            <Label htmlFor="rerun-name" className="text-xs">Run Name</Label>
            <Input
              id="rerun-name"
              className="h-8"
              data-testid="rerun-name-input"
              value={name}
              onChange={e => setName(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Agent</Label>
            <Select value={agentKey} onValueChange={setAgentKey}>
              <SelectTrigger className="h-8" data-testid="rerun-agent-trigger"><SelectValue /></SelectTrigger>
              <SelectContent>
                {DEFAULT_CONFIG.agents.map(agent => (
                  <SelectItem key={agent.key} value={agent.key}>{agent.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              {/* Evaluator: owner explicitly wants this visible + tweakable
                  on the rerun path, not just carried silently. */}
              <Label className="text-xs">Evaluator</Label>
              <Select
                value={evaluatorId || '__default__'}
                onValueChange={val => setEvaluatorId(val === '__default__' ? '' : val)}
              >
                <SelectTrigger className="h-8" data-testid="rerun-evaluator-trigger">
                  <SelectValue placeholder="RCA Default" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__default__">RCA Default</SelectItem>
                  {evaluators.map(evaluator => (
                    <SelectItem key={evaluator.id} value={evaluator.id}>
                      {evaluator.name}{evaluator.isSystem ? ' (System)' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Judge Model</Label>
              <JudgeModelSelect
                value={judgeModelId}
                onValueChange={setJudgeModelId}
                allowDefault
              />
            </div>
          </div>

          <button
            type="button"
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            data-testid="rerun-advanced-toggle"
            onClick={() => setAdvancedOpen(v => !v)}
          >
            {advancedOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            Advanced (concurrency, test cases)
          </button>
          {advancedOpen && (
            <div className="grid grid-cols-2 gap-3 pl-4 border-l">
              <div className="space-y-1.5">
                <Label className="text-xs">Concurrency</Label>
                <Input
                  type="number"
                  min={1}
                  max={20}
                  className="h-8"
                  data-testid="rerun-concurrency-input"
                  value={concurrency}
                  onChange={e => setConcurrency(Math.max(1, Math.min(20, parseInt(e.target.value, 10) || 1)))}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Test Cases (via Benchmark)</Label>
                <Select value={benchmarkId} onValueChange={setBenchmarkId}>
                  <SelectTrigger className="h-8" data-testid="rerun-benchmark-trigger">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_BENCHMARK}>
                      {run.benchmarkId ? 'Keep source run\'s sources' : `Original sources (${testCaseCount} test cases)`}
                    </SelectItem>
                    {benchmarks.map(bm => (
                      <SelectItem key={bm.id} value={bm.id}>{bm.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          {isModified && (
            <div className="text-[11px] text-amber-600 dark:text-amber-400 flex items-center gap-1" data-testid="rerun-modified-hint">
              <AlertTriangle size={11} />
              Config tweaked — this re-run will be linked to the source run but flagged as modified.
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 rounded-md border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-2 text-xs text-red-800 dark:text-red-300">
              <AlertTriangle size={14} className="shrink-0 mt-0.5" />
              <span data-testid="rerun-error">{error}</span>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={submitting || !agentKey} data-testid="rerun-confirm-btn">
            {submitting ? <Loader2 size={14} className="mr-1 animate-spin" /> : <RotateCcw size={14} className="mr-1" />}
            {submitting ? 'Starting...' : 'Re-run'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
