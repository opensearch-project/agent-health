/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * RunConfigDialog — THE run-configuration dialog, shared by every entry point
 * that starts a run from an existing context:
 *
 *   mode="create"  "Add Run" on the benchmark page (BenchmarkRunsPage). The
 *                  benchmark is the fixed test-case source; the parent owns
 *                  execution (it calls executeBenchmarkRun → POST
 *                  /api/storage/evaluation-runs and drives its inline
 *                  progress UI), so this dialog just hands back the values.
 *   mode="rerun"   "Re-run" from the RunActionsMenu kebab (runs list, run
 *                  report header, inspector header). Prepopulated from the
 *                  source run's ACTUAL persisted values — agent, evaluator,
 *                  judge model, concurrency, test-case source (benchmark
 *                  association) and name ('<name> (re-run)'). Submits POST
 *                  /api/storage/evaluation-runs/:id/rerun with ONLY the
 *                  fields that differ from the source run; the server records
 *                  `rerunOf` either way and flags `modified: true` when any
 *                  override changed the effective config
 *                  (lib/evaluationRerun.ts applyRerunOverrides).
 *
 * Owner feedback that shaped this: "Concurrency is also missing in the Run
 * dialog box, and re-run should open the same dialog box with prepopulated
 * box." Previously Add-Run and Re-run were two different components with
 * drifting field sets (the Add-Run dialog had no concurrency at all).
 *
 * Concurrency is a first-class field in BOTH modes (not behind a disclosure).
 * Empty = server default (the runner uses `run.concurrency ?? 1`,
 * services/evaluationRunner.ts); the route validator caps it at 20.
 *
 * If the source run's agent or evaluator no longer exists in config, the
 * select shows it as a disabled "(not in config)" entry with a hint instead
 * of silently picking a different one; a missing agent blocks submit.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Loader2, RotateCcw, Play, AlertTriangle, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { JudgeModelSelect } from '@/components/JudgeModelSelect';
import { EvaluationRun, Evaluator, Benchmark, RunConfigInput } from '@/types';
import { DEFAULT_CONFIG } from '@/lib/constants';
import { ENV_CONFIG } from '@/lib/config';
import { computeRerunName } from '@/lib/evaluationRerun';
import { rerunEvaluationRun, RerunOverrides } from '@/services/client';
import { asyncBenchmarkStorage } from '@/services/storage';

/** Server-side default when `concurrency` is omitted (services/evaluationRunner.ts). */
export const DEFAULT_CONCURRENCY = 1;
/** Server-side cap (server/routes/storage/benchmarks.ts validateRunConfig). */
export const MAX_CONCURRENCY = 20;

const NO_BENCHMARK = '__none__';
const DEFAULT_EVALUATOR = '__default__';

/**
 * Values the dialog edits. Superset of {@link RunConfigInput} (create mode
 * hands exactly that back) plus the rerun-only `benchmarkId` source swap.
 * `modelId`/`headers`/`agentEndpoint` are carried through untouched (no UI).
 */
export interface RunConfigValues extends RunConfigInput {
  benchmarkId?: string;
}

/**
 * Compute the rerun overrides body from the dialog's form state vs. the
 * source run: unchanged fields are OMITTED (so the server can tell a faithful
 * duplicate from a tweaked one); `null` clears an optional field. Exported
 * for unit tests.
 */
export function computeRerunOverrides(run: EvaluationRun, values: RunConfigValues): RerunOverrides {
  const srcConcurrency = run.concurrency ?? DEFAULT_CONCURRENCY;
  const nextConcurrency = values.concurrency ?? DEFAULT_CONCURRENCY;
  const nextJudge = values.judgeModelId || '';
  const nextEvaluator = values.evaluatorId || '';
  return {
    name: values.name.trim() || undefined,
    agentKey: values.agentKey !== run.agentKey ? values.agentKey : undefined,
    judgeModelId: nextJudge !== (run.judgeModelId || '') ? (nextJudge || null) : undefined,
    evaluatorId: nextEvaluator !== (run.evaluatorId || '') ? (nextEvaluator || null) : undefined,
    concurrency: nextConcurrency !== srcConcurrency ? nextConcurrency : undefined,
    // Only an explicit, DIFFERENT benchmark selection is sent. `undefined`
    // (the "keep source" sentinel) never becomes a `null` clear: for a
    // benchmark-sourced run `sources` and `benchmarkId` are the same field
    // in practice, and a `null` that cleared the association while leaving
    // `sources` alone produced an inconsistent run (earlier codex finding).
    benchmarkId: values.benchmarkId && values.benchmarkId !== run.benchmarkId ? values.benchmarkId : undefined,
  };
}

/** Whether any override in `o` (other than `name`) would change the run. */
export function hasRerunTweaks(o: RerunOverrides): boolean {
  return o.agentKey !== undefined || o.judgeModelId !== undefined || o.evaluatorId !== undefined
    || o.concurrency !== undefined || o.benchmarkId !== undefined;
}

/** Seed dialog values from a source run (rerun mode). Exported for tests. */
export function valuesFromRun(run: EvaluationRun): RunConfigValues {
  return {
    name: computeRerunName(run.name),
    description: run.description,
    agentKey: run.agentKey || '',
    modelId: run.modelId,
    judgeModelId: run.judgeModelId || undefined,
    evaluatorId: run.evaluatorId || undefined,
    concurrency: run.concurrency ?? undefined,
    headers: run.headers,
    agentEndpoint: run.agentEndpoint,
    benchmarkId: run.benchmarkId || undefined,
  };
}

export interface RunConfigDialogProps {
  mode: 'create' | 'rerun';
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * create mode: seed values (name/agent/evaluator/judge carried from the
   * latest run or persisted prefs — the parent decides). Re-applied every
   * time the dialog opens.
   */
  initialValues?: Partial<RunConfigValues>;
  /** create mode: the fixed test-case source (shown read-only). */
  benchmark?: Pick<Benchmark, 'id' | 'name' | 'testCaseIds'> | null;
  /** create mode: receives the final values; the parent starts the run. */
  onStart?: (values: RunConfigValues) => void | Promise<void>;
  /** rerun mode: the source run. Dialog renders nothing while null. */
  sourceRun?: EvaluationRun | null;
  /** rerun mode: called with the new run's id once POST …/rerun succeeds. */
  onRerun?: (newRunId: string) => void;
}

export const RunConfigDialog: React.FC<RunConfigDialogProps> = ({
  mode, open, onOpenChange, initialValues, benchmark, onStart, sourceRun, onRerun,
}) => {
  const isRerun = mode === 'rerun';
  const [values, setValues] = useState<RunConfigValues>({ name: '', agentKey: '', modelId: '' });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [evaluators, setEvaluators] = useState<Evaluator[]>([]);
  const [evaluatorsLoaded, setEvaluatorsLoaded] = useState(false);
  const [benchmarks, setBenchmarks] = useState<Benchmark[]>([]);

  // Seed on every open: from the source run (rerun) or the caller (create).
  useEffect(() => {
    if (!open) return;
    if (isRerun) {
      if (sourceRun) setValues(valuesFromRun(sourceRun));
    } else {
      setValues({ name: '', agentKey: '', modelId: '', ...initialValues });
    }
    setError(null);
  }, [open, isRerun, sourceRun]);

  // Evaluators (both modes) + benchmarks (rerun's source-swap select).
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
      } catch { /* dropdown just shows the default option */ }
      if (!cancelled) setEvaluatorsLoaded(true);
      if (isRerun) {
        try {
          const bms = await asyncBenchmarkStorage.getAll();
          if (!cancelled) setBenchmarks(bms);
        } catch { /* swap select just shows "keep source" */ }
      }
    })();
    return () => { cancelled = true; };
  }, [open, isRerun]);

  const set = <K extends keyof RunConfigValues>(key: K, val: RunConfigValues[K]) =>
    setValues(prev => ({ ...prev, [key]: val }));

  const agents = DEFAULT_CONFIG.agents;
  const agentMissing = !!values.agentKey && !agents.some(a => a.key === values.agentKey);
  const evaluatorMissing = evaluatorsLoaded && !!values.evaluatorId
    && !evaluators.some(e => e.id === values.evaluatorId);

  const overrides = useMemo(
    () => (isRerun && sourceRun ? computeRerunOverrides(sourceRun, values) : null),
    [isRerun, sourceRun, values],
  );
  const isModified = overrides ? hasRerunTweaks(overrides) : false;

  const handleOpenChange = (next: boolean) => {
    if (submitting) return; // never close mid-request
    if (!next) setError(null);
    onOpenChange(next);
  };

  const handleSubmit = async () => {
    setError(null);
    if (isRerun) {
      if (!sourceRun || !overrides) return;
      setSubmitting(true);
      try {
        const result = await rerunEvaluationRun(sourceRun.id, overrides);
        setSubmitting(false);
        onOpenChange(false);
        onRerun?.(result.runId);
      } catch (err: any) {
        setSubmitting(false);
        setError(err?.message || 'Failed to re-run evaluation run');
      }
      return;
    }
    // create: hand back a clean RunConfigInput (no dialog-only sentinels).
    const out: RunConfigValues = {
      ...values,
      name: values.name.trim(),
      description: values.description || undefined,
      evaluatorId: values.evaluatorId || undefined,
      judgeModelId: values.judgeModelId || undefined,
      concurrency: values.concurrency ?? undefined,
    };
    await onStart?.(out);
  };

  if (isRerun && !sourceRun) return null;

  const canSubmit = !submitting && !!values.name.trim() && !!values.agentKey && !agentMissing;
  const sourceTestCaseCount = sourceRun?.testCaseSnapshots?.length ?? 0;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent data-testid="run-config-dialog" data-mode={mode} className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isRerun ? <><RotateCcw size={16} /> Re-run evaluation</> : 'Configure Run'}
          </DialogTitle>
          <DialogDescription>
            {isRerun
              ? 'Prefilled from the source run\'s configuration — tweak anything below before launching. Test-case sources are re-resolved at launch, so results may differ if the underlying test cases changed.'
              : `Runs every test case in ${benchmark?.name ? `"${benchmark.name}"` : 'this benchmark'} against the selected agent.`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <div className="space-y-1.5">
            <Label htmlFor="run-config-name" className="text-xs">Run Name</Label>
            <Input
              id="run-config-name"
              className="h-8"
              data-testid="run-config-name-input"
              value={values.name}
              onChange={e => set('name', e.target.value)}
              placeholder="e.g., Baseline, With Fix"
            />
          </div>

          {!isRerun && (
            <div className="space-y-1.5">
              <Label htmlFor="run-config-description" className="text-xs">Description (optional)</Label>
              <Textarea
                id="run-config-description"
                data-testid="run-config-description-input"
                value={values.description || ''}
                onChange={e => set('description', e.target.value || undefined)}
                placeholder="Describe what this run tests or changes..."
                rows={2}
              />
            </div>
          )}

          <div className="space-y-1.5">
            {/* The agent's LLM is owned by its agent-health.config.ts
                connectorConfig — there is no agent-model picker. */}
            <Label className="text-xs">Agent</Label>
            <Select value={values.agentKey} onValueChange={val => set('agentKey', val)}>
              <SelectTrigger className="h-8" data-testid="run-config-agent-trigger"><SelectValue placeholder="Select an agent" /></SelectTrigger>
              <SelectContent>
                {agentMissing && (
                  <SelectItem value={values.agentKey} disabled data-testid="run-config-agent-missing-item">
                    {values.agentKey} (not in config)
                  </SelectItem>
                )}
                {agents.map(agent => (
                  <SelectItem key={agent.key} value={agent.key}>{agent.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {agentMissing && (
              <div className="text-[11px] text-amber-600 dark:text-amber-400 flex items-center gap-1" data-testid="run-config-agent-missing-hint">
                <AlertTriangle size={11} />
                Agent "{values.agentKey}" is no longer configured — pick another agent to continue.
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              {/* Evaluator — scoring config + default judge prompt/model.
                  "RCA Default" maps to undefined; the server resolves the
                  built-in default. Visible + editable in rerun mode too
                  (owner request), never carried silently. */}
              <Label className="text-xs">Evaluator</Label>
              <Select
                value={values.evaluatorId || DEFAULT_EVALUATOR}
                onValueChange={val => set('evaluatorId', val === DEFAULT_EVALUATOR ? undefined : val)}
              >
                <SelectTrigger className="h-8" data-testid="run-config-evaluator-trigger">
                  <SelectValue placeholder="RCA Default" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT_EVALUATOR}>RCA Default</SelectItem>
                  {evaluatorMissing && values.evaluatorId && (
                    <SelectItem value={values.evaluatorId} disabled data-testid="run-config-evaluator-missing-item">
                      {values.evaluatorId} (not found)
                    </SelectItem>
                  )}
                  {evaluators.map(evaluator => (
                    <SelectItem key={evaluator.id} value={evaluator.id}>
                      {evaluator.name}{evaluator.isSystem ? ' (System)' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {evaluatorMissing && (
                <div className="text-[11px] text-amber-600 dark:text-amber-400 flex items-center gap-1" data-testid="run-config-evaluator-missing-hint">
                  <AlertTriangle size={11} />
                  Evaluator "{values.evaluatorId}" no longer exists — the run will fail to judge unless you pick another.
                </div>
              )}
            </div>
            <div className="space-y-1.5">
              {/* Judge Model — the judge's LLM, distinct from the agent's
                  model. '' = "use evaluator default" (server resolves from
                  evaluator.inferenceConfig.modelId → BEDROCK_MODEL_ID). */}
              <Label className="text-xs">Judge Model</Label>
              <JudgeModelSelect
                value={values.judgeModelId ?? ''}
                onValueChange={val => set('judgeModelId', val || undefined)}
                allowDefault
                triggerClassName="h-8"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="run-config-concurrency" className="text-xs flex items-center gap-1">
                Concurrency
                <Info
                  size={11}
                  className="text-muted-foreground"
                  aria-label="How many test cases run in parallel within this run (1 = one at a time)."
                  data-testid="run-config-concurrency-tooltip"
                />
              </Label>
              <Input
                id="run-config-concurrency"
                type="number"
                min={1}
                max={MAX_CONCURRENCY}
                step={1}
                className="h-8"
                data-testid="run-config-concurrency-input"
                title="How many test cases run in parallel within this run (1 = one at a time)."
                placeholder={`${DEFAULT_CONCURRENCY} (default)`}
                value={values.concurrency ?? ''}
                onChange={e => {
                  const raw = e.target.value;
                  if (raw === '') { set('concurrency', undefined); return; }
                  const n = parseInt(raw, 10);
                  if (Number.isNaN(n)) return;
                  set('concurrency', Math.max(1, Math.min(MAX_CONCURRENCY, n)));
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Test Cases</Label>
              {isRerun ? (
                <Select
                  value={values.benchmarkId || NO_BENCHMARK}
                  onValueChange={val => set('benchmarkId', val === NO_BENCHMARK ? undefined : val)}
                >
                  <SelectTrigger className="h-8" data-testid="run-config-benchmark-trigger">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_BENCHMARK}>
                      {`Original sources (${sourceTestCaseCount} test case${sourceTestCaseCount === 1 ? '' : 's'})`}
                    </SelectItem>
                    {benchmarks.map(bm => (
                      <SelectItem key={bm.id} value={bm.id}>{bm.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <div
                  className="h-8 flex items-center rounded-md border bg-muted/40 px-2 text-xs text-muted-foreground truncate"
                  data-testid="run-config-source-summary"
                  title={benchmark?.name}
                >
                  {benchmark?.name || 'This benchmark'}
                  {benchmark?.testCaseIds ? ` · ${benchmark.testCaseIds.length} case${benchmark.testCaseIds.length === 1 ? '' : 's'}` : ''}
                </div>
              )}
            </div>
          </div>

          {isRerun && isModified && (
            <div className="text-[11px] text-amber-600 dark:text-amber-400 flex items-center gap-1" data-testid="run-config-modified-hint">
              <AlertTriangle size={11} />
              Config tweaked — this re-run will be linked to the source run but flagged as modified.
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 rounded-md border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-2 text-xs text-red-800 dark:text-red-300">
              <AlertTriangle size={14} className="shrink-0 mt-0.5" />
              <span data-testid="run-config-error">{error}</span>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!canSubmit}
            data-testid="run-config-submit-btn"
            className={isRerun ? undefined : 'bg-opensearch-blue hover:bg-blue-600'}
          >
            {submitting
              ? <Loader2 size={14} className="mr-1 animate-spin" />
              : isRerun ? <RotateCcw size={14} className="mr-1" /> : <Play size={14} className="mr-1" />}
            {submitting ? 'Starting...' : isRerun ? 'Re-run' : 'Start Run'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
