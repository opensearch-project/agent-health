/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Deterministic scoring — MINIMAL engine for `kind: 'deterministic'`
 * evaluators (R3 pilot).
 *
 * RECONCILIATION NOTE: the general verdict engine (R2, canonical
 * normalization / truth table / snapshot write path for LLM judgements) is
 * being built in parallel. This module is intentionally small and
 * self-contained so it can be re-based onto R2's engine with a mechanical
 * change; do not grow it.
 *
 * Given an evaluator, a test case and a stored report it:
 *   1. resolves gold ids (`lib/scoring/gold.ts`),
 *   2. extracts the ranked prediction (`prediction/toolHitsOrdered.ts`),
 *   3. computes each metric through the typed registry (`lib/metrics`),
 *   4. normalizes via each metric's `scale` (default 0–1), weighted mean →
 *      `score` in [0,1]; verdict by `passPolicy` (threshold | gates),
 *   5. returns the report patch: `metrics` (in each metric's own scale),
 *      `scoringSnapshot`, `passFailStatus`, `matcherResults` rows, and a
 *      one-line generated summary.
 *
 * Unevaluable semantics (never a silent pass, never a fake zero):
 *   - SOME metrics unevaluable ⇒ verdict `failed`, reason
 *     `unevaluable:<metric>`; they are listed in `snapshot.unevaluable` and
 *     excluded from the mean.
 *   - ALL metrics unevaluable (no gold, or no candidates) ⇒ NOT a verdict:
 *     `passFailStatus: null`, `metricsStatus: 'error'`, `traceError`
 *     explains why. The report renders as "errored/not evaluable", the run's
 *     pass rate excludes it — flipping it to `failed` would punish the agent
 *     for a missing gold label or an un-parseable artifact.
 */

import { createHash } from 'crypto';
import type {
  DeterministicMetricSpec,
  Evaluator,
  EvaluationReport,
  PassFailStatus,
  ScoringSnapshot,
  TestCase,
} from '@/types';
import type { MatcherResult } from '@/lib/matchers/types';
import { computeMetric, describeMetricCompute } from '@/lib/metrics/index';
import { resolveGold } from '@/lib/scoring/gold';
import { extractToolHitsOrdered, toolHitsOptionsFromInputs, type ExtractedPrediction } from '@/lib/scoring/prediction/toolHitsOrdered';
import { deterministicEvaluatorCanonical, metricScale } from '@/lib/evaluators/deterministic';

/** Ids listed on a matcher row's `details` / `expected` / `actual`. */
export const MATCHER_ID_LIST_LIMIT = 20;

export interface DeterministicScoreResult {
  /** True when at least one metric produced a value. */
  evaluable: boolean;
  /** Metric values in each metric's own scale (only evaluable metrics). */
  metrics: Record<string, number>;
  /** Weighted mean over evaluable metrics, normalized to [0,1]; null when none. */
  score: number | null;
  passFailStatus: PassFailStatus | null;
  /** `unevaluable:<metric>` / `gate:<metric>` / `threshold` reasons behind a failed verdict. */
  failReasons: string[];
  unevaluable: string[];
  snapshot: ScoringSnapshot;
  matcherResults: MatcherResult[];
  summary: string;
  gold: string[];
  prediction: ExtractedPrediction;
}

export function deterministicContentHash(evaluator: Pick<Evaluator, 'kind' | 'metrics' | 'passPolicy' | 'inputs'>): string {
  return `sha256:${createHash('sha256').update(deterministicEvaluatorCanonical(evaluator), 'utf8').digest('hex')}`;
}

const toScale = (normalized: number, scale: { min: number; max: number }) => scale.min + normalized * (scale.max - scale.min);
const fmt = (v: number) => (Math.round(v * 1000) / 1000).toString();

/**
 * Score one report with a deterministic evaluator. Pure: reads the
 * evaluator/test case/report, returns the patch pieces; the caller persists.
 */
export function scoreDeterministic(
  evaluator: Evaluator,
  testCase: Pick<TestCase, 'expected' | 'expectedOutcomes'>,
  report: Pick<EvaluationReport, 'trajectory'>
): DeterministicScoreResult {
  if (evaluator.kind !== 'deterministic' || !evaluator.metrics || !evaluator.passPolicy || !evaluator.inputs) {
    throw new Error(`Evaluator ${evaluator.id} is not a valid deterministic evaluator`);
  }
  const specs: DeterministicMetricSpec[] = evaluator.metrics;
  const passPolicy = evaluator.passPolicy;

  const gold = resolveGold(testCase, evaluator.inputs.gold);
  const prediction = extractToolHitsOrdered(report.trajectory, toolHitsOptionsFromInputs(evaluator.inputs.prediction));
  const goldIds = gold?.ids ?? [];
  const ranked = prediction.ranked;

  const metrics: Record<string, number> = {};
  const normalizedByName: Record<string, number> = {};
  const unevaluable: string[] = [];
  const weights: Record<string, number> = {};
  const scale: Record<string, { min: number; max: number }> = {};
  let weightSum = 0;
  let weighted = 0;

  for (const spec of specs) {
    weights[spec.name] = spec.weight;
    scale[spec.name] = metricScale(spec);
    const value = goldIds.length > 0 && ranked.length > 0 ? computeMetric(spec.compute, { gold: goldIds, ranked }) : null;
    if (value === null) {
      unevaluable.push(spec.name);
      continue;
    }
    normalizedByName[spec.name] = value;
    metrics[spec.name] = toScale(value, scale[spec.name]);
    weightSum += spec.weight;
    weighted += spec.weight * value;
  }

  const evaluable = Object.keys(metrics).length > 0;
  const score = evaluable && weightSum > 0 ? weighted / weightSum : null;

  // Verdict.
  const failReasons: string[] = [];
  for (const name of unevaluable) failReasons.push(`unevaluable:${name}`);
  const gateOutcomes: Record<string, boolean | undefined> = {};
  if (evaluable) {
    if (passPolicy.kind === 'threshold') {
      if (score === null || score < passPolicy.minScore) failReasons.push(`threshold:${fmt(score ?? 0)}<${fmt(passPolicy.minScore)}`);
    } else if (passPolicy.kind === 'gates') {
      for (const g of passPolicy.gates) {
        const v = metrics[g.metric];
        const ok = typeof v === 'number' && v >= g.min;
        gateOutcomes[g.metric] = ok;
        if (!ok && !unevaluable.includes(g.metric)) failReasons.push(`gate:${g.metric}<${fmt(g.min)}`);
      }
    }
  }
  const passFailStatus: PassFailStatus | null = !evaluable ? null : failReasons.length === 0 ? 'passed' : 'failed';

  // Snapshot.
  const snapshot: ScoringSnapshot = {
    evaluatorId: evaluator.id,
    evaluatorVersion: evaluator.currentVersion ?? 1,
    evaluatorName: evaluator.name,
    contentHash: deterministicContentHash(evaluator),
    weights,
    scale,
    passPolicy,
    primaryMetrics: specs.filter(s => s.primary).map(s => s.name),
    goldIdsUsed: goldIds,
    ...(gold ? { goldRule: gold.rule } : {}),
    extractionRule: prediction.rule,
    extraction: {
      candidateCount: prediction.candidateCount,
      citedCount: prediction.citedCount,
      anchorsRemoved: prediction.anchorsRemoved,
    },
    unevaluable,
  };

  // Matcher rows — one per metric so the Judge tab lists them with gold/predicted ids.
  const goldList = goldIds.slice(0, MATCHER_ID_LIST_LIMIT);
  const predictedList = ranked.slice(0, MATCHER_ID_LIST_LIMIT);
  const matcherResults: MatcherResult[] = specs.map(spec => {
    const isGate = passPolicy.kind === 'gates' && passPolicy.gates.some(g => g.metric === spec.name);
    const isUnevaluable = unevaluable.includes(spec.name);
    const value = metrics[spec.name];
    const gateMin = passPolicy.kind === 'gates' ? passPolicy.gates.find(g => g.metric === spec.name)?.min : undefined;
    const pass = isUnevaluable ? false : gateMin !== undefined ? value >= gateMin : true;
    const k = 'k' in spec.compute ? spec.compute.k : undefined;
    const row: MatcherResult = {
      description: `${spec.name} (${describeMetricCompute(spec.compute)})${gateMin !== undefined ? ` ≥ ${fmt(gateMin)}` : ''}`,
      pass,
      method: 'code-assertion',
      role: isGate ? 'primary' : 'observe',
      ...(isUnevaluable ? { errored: true, errorMessage: unevaluableReason(goldIds, prediction) } : {}),
      score: isUnevaluable ? undefined : normalizedByName[spec.name],
      actual: isUnevaluable ? undefined : value,
      expected: gateMin,
      details: {
        gold: goldList,
        goldTotal: goldIds.length,
        predicted: predictedList,
        predictedTotal: ranked.length,
        ...(k !== undefined ? { k } : {}),
        extractionRule: prediction.rule,
      },
    };
    return row;
  });

  const summary = buildSummary(goldIds, prediction, metrics, unevaluable, passFailStatus, failReasons);

  return {
    evaluable,
    metrics,
    score,
    passFailStatus,
    failReasons,
    unevaluable,
    snapshot,
    matcherResults,
    summary,
    gold: goldIds,
    prediction,
  };
}

function unevaluableReason(goldIds: string[], prediction: ExtractedPrediction): string {
  if (goldIds.length === 0) return 'no gold ids on the test case (expected.ids / matching expectedOutcomes line)';
  if (prediction.ranked.length === 0) {
    return prediction.candidateCount > 0
      ? `every retrieved id was an anchor (${prediction.anchorsRemoved} removed)`
      : `no candidate ids found in the stored tool results (rule: ${prediction.rule})`;
  }
  return 'metric could not be computed';
}

function buildSummary(
  goldIds: string[],
  prediction: ExtractedPrediction,
  metrics: Record<string, number>,
  unevaluable: string[],
  verdict: PassFailStatus | null,
  failReasons: string[]
): string {
  if (verdict === null) return `Not evaluable: ${unevaluableReason(goldIds, prediction)}.`;
  const goldSet = new Set(goldIds);
  const firstHit = prediction.ranked.findIndex(id => goldSet.has(id));
  const hits = prediction.ranked.filter(id => goldSet.has(id)).length;
  const parts = [
    `${hits} of ${goldIds.length} gold id${goldIds.length === 1 ? '' : 's'} among ${prediction.ranked.length} candidate${prediction.ranked.length === 1 ? '' : 's'}`,
    firstHit >= 0 ? `first hit at rank ${firstHit + 1}` : 'no gold id ranked',
    `${prediction.citedCount} cited in the answer`,
    ...(prediction.anchorsRemoved > 0 ? [`${prediction.anchorsRemoved} anchor${prediction.anchorsRemoved === 1 ? '' : 's'} removed`] : []),
  ];
  const metricText = Object.entries(metrics).map(([k, v]) => `${k}=${fmt(v)}`).join(', ');
  const tail = unevaluable.length > 0 ? `; unevaluable: ${unevaluable.join(', ')}` : '';
  const why = verdict === 'failed' && failReasons.length > 0 ? ` (${failReasons.join('; ')})` : '';
  return `Deterministic scoring: ${parts.join('; ')}. ${metricText}${tail}. Verdict ${verdict}${why}.`;
}
