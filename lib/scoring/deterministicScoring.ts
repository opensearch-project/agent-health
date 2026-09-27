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
 *   1. resolves gold ids (`lib/scoring/gold.ts`) — ids, EXPLICITLY none, or
 *      not declared,
 *   2. extracts the ranked prediction by `inputs.prediction.source`
 *      (`prediction/toolHitsOrdered.ts` | `prediction/responseResults.ts`),
 *   3. computes each APPLICABLE metric through the typed registry
 *      (`lib/metrics`; `metricApplies` decides — ranked metrics need gold,
 *      `abstain` needs the gold set to be explicitly empty),
 *   4. normalizes via each metric's `scale` (default 0–1), weighted mean →
 *      `score` in [0,1]; verdict by `passPolicy` (threshold | gates),
 *   5. returns the report patch: `metrics` (in each metric's own scale),
 *      `scoringSnapshot`, `passFailStatus`, `matcherResults` rows, and a
 *      one-line generated summary.
 *
 * Three per-metric states:
 *   - VALUE — computed; in the mean, gated by the policy.
 *   - NOT APPLICABLE — the metric does not speak to this case by its own
 *     definition (a ranked metric when the test case explicitly has no gold;
 *     `abstain` when it has gold). Skipped: not in the mean, not a failure
 *     reason, listed in `snapshot.notApplicable`, matcher row flagged
 *     `notApplicable: true`. Without this state an evaluator could never mix
 *     `abstain` with ranked metrics. A `gates` policy whose EVERY gate is not
 *     applicable to the case yields NO verdict (see below) — a gate that was
 *     never enforced must not read as a pass.
 *   - UNEVALUABLE — the metric applies but an input is missing (gold not
 *     declared at all; no ranked list recognised / no candidates to score).
 *     Semantics unchanged from the pilot (never a silent pass, never a fake
 *     zero):
 *       · SOME metrics unevaluable ⇒ verdict `failed`, reason
 *         `unevaluable:<metric>`; listed in `snapshot.unevaluable`, excluded
 *         from the mean.
 *       · NO metric produced a value (or no gate applies) ⇒ NOT a verdict:
 *         `passFailStatus: null`, `metricsStatus: 'error'`, `traceError`
 *         explains why. The report renders as "errored/not evaluable", the
 *         run's pass rate excludes it — flipping it to `failed` would punish
 *         the agent for a missing gold label or an un-parseable artifact.
 *
 * Empty prediction vs absent prediction: `response-results` distinguishes an
 * agent that RETURNED an explicit empty list (`present: true`, ranked metrics
 * compute to 0 via `emptyRanking: 'zero'`, `abstain` = 1) from a report whose
 * answer carried no recognisable ranked list at all (`present: false` ⇒
 * unevaluable — "could not extract" is never scored). `tool-hits-ordered`
 * keeps its pilot behaviour: no candidates ⇒ ranked metrics unevaluable.
 */

import { createHash } from 'crypto';
import type {
  DeterministicEvaluatorInputs,
  DeterministicMetricSpec,
  Evaluator,
  EvaluationReport,
  PassFailStatus,
  ScoringSnapshot,
  TestCase,
} from '@/types';
import type { MatcherResult } from '@/lib/matchers/types';
import { computeMetric, describeMetricCompute, metricApplies } from '@/lib/metrics/index';
import { resolveGold } from '@/lib/scoring/gold';
import { extractToolHitsOrdered, toolHitsOptionsFromInputs, type ExtractedPrediction } from '@/lib/scoring/prediction/toolHitsOrdered';
import {
  extractResponseResults,
  responseResultsOptionsFromInputs,
  RESPONSE_RESULTS_FORMS,
  type ResponseResultsPrediction,
} from '@/lib/scoring/prediction/responseResults';
import { deterministicEvaluatorCanonical, metricScale } from '@/lib/evaluators/deterministic';

/** Either extractor's output, unified for the engine and the matcher rows. */
export type DeterministicPrediction =
  | (ExtractedPrediction & { present: boolean })
  | ResponseResultsPrediction;

/**
 * Run the extractor named by `inputs.prediction.source`. `present` = there
 * was SOMETHING to score (for `tool-hits-ordered`: any stored candidate or
 * any answer; for `response-results`: a final response step or raw payload).
 */
export function extractPrediction(
  report: Pick<EvaluationReport, 'trajectory'> & { rawEvents?: unknown[] },
  prediction: DeterministicEvaluatorInputs['prediction']
): DeterministicPrediction {
  if (prediction.source === 'response-results') {
    return extractResponseResults(report, responseResultsOptionsFromInputs(prediction));
  }
  const p = extractToolHitsOrdered(report.trajectory, toolHitsOptionsFromInputs(prediction));
  return { ...p, present: p.candidateCount > 0 || p.hasAnswer };
}

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
  /** Metrics skipped because they do not speak to this case (see module doc). */
  notApplicable: string[];
  snapshot: ScoringSnapshot;
  matcherResults: MatcherResult[];
  summary: string;
  gold: string[];
  /** `null` when the test case declares no gold source at all (vs `[]` = explicitly no gold). */
  goldDeclared: boolean;
  prediction: DeterministicPrediction;
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
  report: Pick<EvaluationReport, 'trajectory'> & { rawEvents?: unknown[] }
): DeterministicScoreResult {
  if (evaluator.kind !== 'deterministic' || !evaluator.metrics || !evaluator.passPolicy || !evaluator.inputs) {
    throw new Error(`Evaluator ${evaluator.id} is not a valid deterministic evaluator`);
  }
  const specs: DeterministicMetricSpec[] = evaluator.metrics;
  const passPolicy = evaluator.passPolicy;

  const gold = resolveGold(testCase, evaluator.inputs.gold);
  const prediction = extractPrediction(report, evaluator.inputs.prediction);
  const goldIds = gold?.ids ?? [];
  const goldDeclared = gold !== null;
  const ranked = prediction.ranked;
  // `response-results`: an explicitly returned empty list scores 0 on the
  // ranked metrics; `tool-hits-ordered`: no candidates stays unevaluable.
  const emptyRanking = prediction.rule === 'response-results' ? 'zero' : 'unevaluable';

  const metrics: Record<string, number> = {};
  const normalizedByName: Record<string, number> = {};
  const unevaluable: string[] = [];
  const notApplicable: string[] = [];
  const weights: Record<string, number> = {};
  const scale: Record<string, { min: number; max: number }> = {};
  let weightSum = 0;
  let weighted = 0;

  for (const spec of specs) {
    weights[spec.name] = spec.weight;
    scale[spec.name] = metricScale(spec);
    if (goldDeclared && prediction.present && !metricApplies(spec.compute, goldIds)) {
      notApplicable.push(spec.name);
      continue;
    }
    // `abstain` is about what the agent RETURNED; `tool-hits-ordered` cannot
    // observe that (the validator rejects the pairing — this is the guard for
    // documents stored before it existed).
    const observable = !(spec.compute.type === 'abstain' && prediction.rule !== 'response-results');
    const value = goldDeclared && prediction.present && observable
      ? computeMetric(spec.compute, { gold: goldIds, ranked, emptyRanking })
      : null;
    if (value === null) {
      unevaluable.push(spec.name);
      continue;
    }
    normalizedByName[spec.name] = value;
    metrics[spec.name] = toScale(value, scale[spec.name]);
    weightSum += spec.weight;
    weighted += spec.weight * value;
  }

  // A gates policy needs at least one gate that applies to this case; a case
  // whose every gate is not applicable has no verdict (never a silent pass).
  const applicableGates = passPolicy.kind === 'gates' ? passPolicy.gates.filter(g => !notApplicable.includes(g.metric)) : null;
  const noApplicableGate = applicableGates !== null && applicableGates.length === 0;
  const evaluable = Object.keys(metrics).length > 0 && !noApplicableGate;
  const score = Object.keys(metrics).length > 0 && weightSum > 0 ? weighted / weightSum : null;

  // Verdict.
  const failReasons: string[] = [];
  for (const name of unevaluable) failReasons.push(`unevaluable:${name}`);
  const gateOutcomes: Record<string, boolean | undefined> = {};
  if (evaluable) {
    if (passPolicy.kind === 'threshold') {
      if (score === null || score < passPolicy.minScore) failReasons.push(`threshold:${fmt(score ?? 0)}<${fmt(passPolicy.minScore)}`);
    } else if (applicableGates) {
      for (const g of applicableGates) {
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
    extraction: extractionStats(prediction),
    unevaluable,
    ...(notApplicable.length > 0 ? { notApplicable } : {}),
  };

  // Matcher rows — one per metric so the Judge tab lists them with gold/predicted ids.
  const goldList = goldIds.slice(0, MATCHER_ID_LIST_LIMIT);
  const predictedList = ranked.slice(0, MATCHER_ID_LIST_LIMIT);
  const matcherResults: MatcherResult[] = specs.map(spec => {
    const isGate = passPolicy.kind === 'gates' && passPolicy.gates.some(g => g.metric === spec.name);
    const isUnevaluable = unevaluable.includes(spec.name);
    const isNotApplicable = notApplicable.includes(spec.name);
    const value = metrics[spec.name];
    const gateMin = passPolicy.kind === 'gates' ? passPolicy.gates.find(g => g.metric === spec.name)?.min : undefined;
    // Not-applicable rows never fail (they were skipped, not judged).
    const pass = isUnevaluable ? false : isNotApplicable ? true : gateMin !== undefined ? value >= gateMin : true;
    const k = 'k' in spec.compute ? spec.compute.k : undefined;
    const row: MatcherResult = {
      description: `${spec.name} (${describeMetricCompute(spec.compute)})${gateMin !== undefined ? ` ≥ ${fmt(gateMin)}` : ''}`,
      pass,
      method: 'code-assertion',
      role: isGate && !isNotApplicable ? 'primary' : 'observe',
      ...(isNotApplicable ? { notApplicable: true } : {}),
      ...(isUnevaluable ? { errored: true, errorMessage: unevaluableReason(goldDeclared, goldIds, prediction, spec) } : {}),
      score: isUnevaluable || isNotApplicable ? undefined : normalizedByName[spec.name],
      actual: isUnevaluable || isNotApplicable ? undefined : value,
      expected: isNotApplicable ? undefined : gateMin,
      details: {
        gold: goldList,
        goldTotal: goldIds.length,
        predicted: predictedList,
        predictedTotal: ranked.length,
        ...(k !== undefined ? { k } : {}),
        extractionRule: prediction.rule,
        ...(prediction.rule === 'response-results' ? { parsedFrom: prediction.parsedFrom } : {}),
        ...(isNotApplicable ? { notApplicable: true, notApplicableReason: notApplicableReason(spec, goldIds) } : {}),
      },
    };
    return row;
  });

  const summary = buildSummary(goldDeclared, goldIds, prediction, metrics, unevaluable, notApplicable, passFailStatus, failReasons, noApplicableGate);

  return {
    evaluable,
    metrics,
    score,
    passFailStatus,
    failReasons,
    unevaluable,
    notApplicable,
    snapshot,
    matcherResults,
    summary,
    gold: goldIds,
    goldDeclared,
    prediction,
  };
}

function extractionStats(prediction: DeterministicPrediction): NonNullable<ScoringSnapshot['extraction']> {
  if (prediction.rule === 'response-results') {
    return { candidateCount: prediction.candidateCount, parsedFrom: prediction.parsedFrom };
  }
  return { candidateCount: prediction.candidateCount, citedCount: prediction.citedCount, anchorsRemoved: prediction.anchorsRemoved };
}

function notApplicableReason(spec: DeterministicMetricSpec, goldIds: string[]): string {
  return spec.compute.type === 'abstain'
    ? `abstain only scores cases whose gold is explicitly empty (this case has ${goldIds.length} gold id${goldIds.length === 1 ? '' : 's'})`
    : 'ranked metrics only score cases with gold ids (this case explicitly declares none)';
}

function unevaluableReason(goldDeclared: boolean, goldIds: string[], prediction: DeterministicPrediction, spec?: DeterministicMetricSpec): string {
  if (!goldDeclared) return 'no gold ids on the test case (expected.ids / matching expectedOutcomes line)';
  if (spec?.compute.type === 'abstain' && prediction.rule !== 'response-results') {
    return `abstain cannot be observed through ${prediction.rule} (use prediction source response-results)`;
  }
  if (prediction.rule === 'response-results') {
    if (!prediction.present) {
      return prediction.hasAnswer
        ? `no ranked list recognised in the final response (expected ${RESPONSE_RESULTS_FORMS}; an explicit empty list scores as an abstention) (rule: response-results)`
        : 'no final response step in the stored trajectory (rule: response-results)';
    }
    return 'metric could not be computed';
  }
  if (prediction.ranked.length === 0) {
    return prediction.candidateCount > 0
      ? `every retrieved id was an anchor (${prediction.anchorsRemoved} removed)`
      : `no candidate ids found in the stored tool results (rule: ${prediction.rule})`;
  }
  return 'metric could not be computed';
}

function buildSummary(
  goldDeclared: boolean,
  goldIds: string[],
  prediction: DeterministicPrediction,
  metrics: Record<string, number>,
  unevaluable: string[],
  notApplicable: string[],
  verdict: PassFailStatus | null,
  failReasons: string[],
  noApplicableGate: boolean
): string {
  if (verdict === null) {
    if (noApplicableGate && Object.keys(metrics).length > 0) {
      const metricText = Object.entries(metrics).map(([k, v]) => `${k}=${fmt(v)}`).join(', ');
      return `Not evaluable: none of the pass-policy gates applies to this case (not applicable: ${notApplicable.join(', ')}); observed ${metricText}. Add a gate on a metric that speaks to ${goldIds.length === 0 ? 'gold-empty cases (e.g. abstain)' : 'cases with gold ids'}.`;
    }
    if (unevaluable.length === 0 && notApplicable.length > 0) {
      return `Not evaluable: no metric applies to this case (${goldIds.length === 0 ? 'gold is explicitly empty and the evaluator declares no abstain metric' : 'the evaluator declares only abstain metrics and this case has gold ids'}).`;
    }
    return `Not evaluable: ${unevaluableReason(goldDeclared, goldIds, prediction)}.`;
  }
  const goldSet = new Set(goldIds);
  const firstHit = prediction.ranked.findIndex(id => goldSet.has(id));
  const hits = prediction.ranked.filter(id => goldSet.has(id)).length;
  const parts = goldIds.length === 0
    ? [`gold is explicitly empty; the agent returned ${prediction.ranked.length} candidate${prediction.ranked.length === 1 ? '' : 's'}`]
    : [
        `${hits} of ${goldIds.length} gold id${goldIds.length === 1 ? '' : 's'} among ${prediction.ranked.length} candidate${prediction.ranked.length === 1 ? '' : 's'}`,
        firstHit >= 0 ? `first hit at rank ${firstHit + 1}` : 'no gold id ranked',
      ];
  if (prediction.rule === 'response-results') {
    parts.push(`ranked list parsed from ${prediction.parsedFrom === 'none' ? 'the response (no list found)' : `the response (${prediction.parsedFrom})`}`);
  } else {
    parts.push(`${prediction.citedCount} cited in the answer`);
    if (prediction.anchorsRemoved > 0) parts.push(`${prediction.anchorsRemoved} anchor${prediction.anchorsRemoved === 1 ? '' : 's'} removed`);
  }
  const metricText = Object.entries(metrics).map(([k, v]) => `${k}=${fmt(v)}`).join(', ');
  const tail = `${unevaluable.length > 0 ? `; unevaluable: ${unevaluable.join(', ')}` : ''}${notApplicable.length > 0 ? `; not applicable: ${notApplicable.join(', ')}` : ''}`;
  const why = verdict === 'failed' && failReasons.length > 0 ? ` (${failReasons.join('; ')})` : '';
  return `Deterministic scoring: ${parts.join('; ')}. ${metricText}${tail}. Verdict ${verdict}${why}.`;
}
