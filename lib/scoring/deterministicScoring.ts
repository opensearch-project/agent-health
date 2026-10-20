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
 *   2. extracts the ranked prediction through the ORDERED CANDIDATE CHAIN
 *      (`prediction/candidates.ts`: typed `report.output` → the final answer
 *      → a results tool → the evaluator's configured tool hits → a weak
 *      generic scan), recording every source tried; the declared
 *      `inputs.prediction.source` configures the chain (field names, anchor
 *      tools, results-tool pattern) rather than being the only place looked,
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
 * Empty prediction vs absent prediction: a RETURNED source (`report.output`,
 * the final answer, a results tool) distinguishes an agent that returned an
 * explicit empty list (`present: true`, ranked metrics compute to 0 via
 * `emptyRanking: 'zero'`, `abstain` = 1) from a report with no recognisable
 * ranked list anywhere (`present: false` ⇒ unevaluable — "could not extract"
 * is never scored). RETRIEVED sources (tool hits, generic scan) cannot
 * express an abstention: no candidates ⇒ ranked metrics unevaluable.
 *
 * Implicit abstain: a case whose gold is EXPLICITLY empty (`NONE …` line,
 * `expected.ids: []`) is an abstain case even when the evaluator declares no
 * `abstain` metric — the ranked metrics are not applicable to it, so the
 * engine judges the one thing that is: did the agent return nothing? An
 * implicit `abstain` metric (weight 1, 0–1) is recorded and the verdict
 * follows it. Only a RETURNED source can observe that; otherwise the case is
 * not evaluable with the reason spelled out. Owner incident: such a case was
 * reported as "no gold ids on the test case".
 *
 * Every result carries `diagnostics` (gold source, every candidate source
 * tried with counts, tools scanned) — the dialog and the Judge tab render it,
 * so a miss never reads as a bare "no candidate ids found".
 */

import { createHash } from 'crypto';
import type {
  DeterministicMetricSpec,
  Evaluator,
  EvaluationReport,
  PassFailStatus,
  ScoringDiagnostics,
  ScoringSnapshot,
  TestCase,
} from '@/types';
import type { MatcherResult } from '@/lib/matchers/types';
import { computeMetric, describeMetricCompute, metricApplies } from '@/lib/metrics/index';
import { resolveGold, type ResolvedGold } from '@/lib/scoring/gold';
import { RESPONSE_RESULTS_FORMS } from '@/lib/scoring/prediction/responseResults';
import { describeCandidateSources, extractCandidates, type CandidateExtraction } from '@/lib/scoring/prediction/candidates';
import { deterministicEvaluatorCanonical, metricScale } from '@/lib/evaluators/deterministic';

/** Ids listed on a matcher row's `details` / `expected` / `actual`. */
export const MATCHER_ID_LIST_LIMIT = 20;

/** Name of the metric the engine records for an abstain case when the evaluator declares none. */
export const IMPLICIT_ABSTAIN_METRIC = 'abstain';

/** What kind of result this is — the retry summary groups on it. */
export type DeterministicScoreKind = 'scored' | 'abstain' | 'not-evaluable';

export interface DeterministicScoreResult {
  kind: DeterministicScoreKind;
  /** True when at least one metric produced a value (`kind !== 'not-evaluable'`). */
  evaluable: boolean;
  /** Metric values in each metric's own scale (only evaluable metrics; includes the implicit `abstain` on abstain cases). */
  metrics: Record<string, number>;
  /** Weighted mean over evaluable metrics, normalized to [0,1]; null when none. */
  score: number | null;
  passFailStatus: PassFailStatus | null;
  /** `unevaluable:<metric>` / `gate:<metric>` / `threshold` / `abstain` reasons behind a failed verdict. */
  failReasons: string[];
  unevaluable: string[];
  /** Metrics skipped because they do not speak to this case (see module doc). */
  notApplicable: string[];
  snapshot: ScoringSnapshot;
  matcherResults: MatcherResult[];
  summary: string;
  /**
   * Why NOTHING could be scored (set iff `evaluable === false`). Stable
   * wording (no per-report numbers) so callers can group cases by it; the
   * per-report specifics live in `diagnostics`.
   */
  notEvaluableReason?: string;
  diagnostics: ScoringDiagnostics;
  gold: string[];
  /** `false` when the test case declares no gold source at all (vs `[]` = explicitly no gold). */
  goldDeclared: boolean;
  prediction: CandidateExtraction;
}

export function deterministicContentHash(evaluator: Pick<Evaluator, 'kind' | 'metrics' | 'passPolicy' | 'inputs'>): string {
  return `sha256:${createHash('sha256').update(deterministicEvaluatorCanonical(evaluator), 'utf8').digest('hex')}`;
}

const toScale = (normalized: number, scale: { min: number; max: number }) => scale.min + normalized * (scale.max - scale.min);
const fmt = (v: number) => (Math.round(v * 1000) / 1000).toString();

/** Stable not-evaluable reasons (grouped on by the retry summary / pre-flight). */
export const NOT_EVALUABLE_REASONS = {
  noGold: 'no gold ids on the test case (no expected.ids, no line matching the gold pattern, no explicit NONE line)',
  noCandidates: 'no candidate ids found in the final answer, a results tool or the stored tool results',
  allAnchors: 'every candidate id was an anchor (removed by the anchor filter)',
  abstainUnobservable: 'abstention cannot be observed: the only candidates came from retrieved tool hits, not a returned list',
  noAnswerList: `no ranked list recognised in the final response (expected ${RESPONSE_RESULTS_FORMS}; an explicit empty list scores as an abstention)`,
  noGateApplies: 'none of the pass-policy gates applies to this case',
  noMetricApplies: 'no metric applies to this case',
} as const;

/** The gold-source label humans read: `expectedOutcomes[0]`, `expected.ids`, `not declared`. */
export function describeGoldSource(gold: ResolvedGold | null): string {
  if (!gold) return 'not declared';
  if (gold.rule === 'expected.ids') return gold.ids.length === 0 ? 'expected.ids (explicitly empty)' : 'expected.ids';
  const line = gold.lineIndex !== undefined ? `expectedOutcomes[${gold.lineIndex}]` : 'expectedOutcomes';
  return gold.ids.length === 0 ? `${line} (explicitly none)` : line;
}

export function buildDiagnostics(gold: ResolvedGold | null, prediction: CandidateExtraction): ScoringDiagnostics {
  return {
    gold: { source: describeGoldSource(gold), ids: gold?.ids ?? [], explicitlyEmpty: !!gold && gold.ids.length === 0 },
    candidates: {
      sourceTried: prediction.sourceTried.map(a => ({ ...a })),
      sourceUsed: prediction.sourceUsed,
      count: prediction.candidateCount,
      anchorRemoved: prediction.anchorRemoved,
      returned: prediction.returned,
      weak: prediction.weak,
    },
    toolsScanned: [...prediction.toolsScanned],
  };
}

/** "gold 2 ids from expectedOutcomes[0]; candidates: 0 from tool 'search' hits, 3 from tool 'return_results' records (used); anchor removed 1". */
export function describeDiagnostics(d: ScoringDiagnostics): string {
  const gold = d.gold.explicitlyEmpty
    ? `gold explicitly empty (${d.gold.source})`
    : d.gold.ids.length > 0
      ? `gold ${d.gold.ids.length} id${d.gold.ids.length === 1 ? '' : 's'} from ${d.gold.source}`
      : 'gold not declared';
  const candidates = describeCandidateSources({
    sourceTried: d.candidates.sourceTried as CandidateExtraction['sourceTried'],
    sourceUsed: d.candidates.sourceUsed as CandidateExtraction['sourceUsed'],
    anchorRemoved: d.candidates.anchorRemoved,
    candidateCount: d.candidates.count,
  });
  return `${gold}; candidates: ${candidates}${d.candidates.weak ? ' (weak: generic scan)' : ''}`;
}

/**
 * Score one report with a deterministic evaluator. Pure: reads the
 * evaluator/test case/report, returns the patch pieces; the caller persists.
 */
export function scoreDeterministic(
  evaluator: Evaluator,
  testCase: Pick<TestCase, 'expected' | 'expectedOutcomes'>,
  report: Pick<EvaluationReport, 'trajectory'> & { rawEvents?: unknown[]; output?: unknown }
): DeterministicScoreResult {
  if (evaluator.kind !== 'deterministic' || !evaluator.metrics || !evaluator.passPolicy || !evaluator.inputs) {
    throw new Error(`Evaluator ${evaluator.id} is not a valid deterministic evaluator`);
  }
  const specs: DeterministicMetricSpec[] = evaluator.metrics;
  const passPolicy = evaluator.passPolicy;

  const gold = resolveGold(testCase, evaluator.inputs.gold);
  const prediction = extractCandidates(report, { prediction: evaluator.inputs.prediction });
  const diagnostics = buildDiagnostics(gold, prediction);
  const goldIds = gold?.ids ?? [];
  const goldDeclared = gold !== null;
  const goldEmpty = goldDeclared && goldIds.length === 0;
  const ranked = prediction.ranked;
  // A RETURNED empty list is a real answer (scores 0 / abstain 1); an empty
  // RETRIEVED list is "nothing found to score".
  const emptyRanking = prediction.returned ? 'zero' : 'unevaluable';
  const declaresAbstain = specs.some(s => s.compute.type === 'abstain');
  // Implicit abstain: gold explicitly empty, no abstain metric declared.
  const implicitAbstain = goldEmpty && !declaresAbstain;

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
    // `abstain` is about what the agent RETURNED; a retrieved-only source
    // (tool hits / generic scan) cannot observe that.
    const observable = !(spec.compute.type === 'abstain' && !prediction.returned);
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

  // Implicit abstain metric (see module doc).
  let implicitAbstainValue: number | null = null;
  if (implicitAbstain && prediction.present && prediction.returned) {
    implicitAbstainValue = ranked.length === 0 ? 1 : 0;
    weights[IMPLICIT_ABSTAIN_METRIC] = 1;
    scale[IMPLICIT_ABSTAIN_METRIC] = { min: 0, max: 1 };
    normalizedByName[IMPLICIT_ABSTAIN_METRIC] = implicitAbstainValue;
    metrics[IMPLICIT_ABSTAIN_METRIC] = implicitAbstainValue;
    weightSum += 1;
    weighted += implicitAbstainValue;
  }

  // A gates policy needs at least one gate that applies to this case; a case
  // whose every gate is not applicable has no verdict (never a silent pass) —
  // EXCEPT on an abstain case, where the abstain metric (declared or implicit)
  // is the one check that speaks to it and decides the verdict.
  const applicableGates = passPolicy.kind === 'gates' ? passPolicy.gates.filter(g => !notApplicable.includes(g.metric)) : null;
  const gatesExhausted = applicableGates !== null && applicableGates.length === 0;
  const declaredAbstainValue = declaresAbstain ? (normalizedByName[specs.find(sp => sp.compute.type === 'abstain')!.name] ?? null) : null;
  const abstainVerdictValue: number | null = goldEmpty
    ? (implicitAbstainValue ?? (gatesExhausted ? declaredAbstainValue : null))
    : null;
  const noApplicableGate = gatesExhausted && abstainVerdictValue === null;
  const evaluable = Object.keys(metrics).length > 0 && !noApplicableGate;
  const score = Object.keys(metrics).length > 0 && weightSum > 0 ? weighted / weightSum : null;

  // Verdict.
  const failReasons: string[] = [];
  for (const name of unevaluable) failReasons.push(`unevaluable:${name}`);
  if (evaluable) {
    if (abstainVerdictValue !== null) {
      if (abstainVerdictValue < 1) failReasons.push(`abstain:returned ${ranked.length} candidate${ranked.length === 1 ? '' : 's'} for a gold-empty case`);
    } else if (passPolicy.kind === 'threshold') {
      if (score === null || score < passPolicy.minScore) failReasons.push(`threshold:${fmt(score ?? 0)}<${fmt(passPolicy.minScore)}`);
    } else if (applicableGates) {
      for (const g of applicableGates) {
        const v = metrics[g.metric];
        const ok = typeof v === 'number' && v >= g.min;
        if (!ok && !unevaluable.includes(g.metric)) failReasons.push(`gate:${g.metric}<${fmt(g.min)}`);
      }
    }
  }
  const passFailStatus: PassFailStatus | null = !evaluable ? null : failReasons.length === 0 ? 'passed' : 'failed';
  const kind: DeterministicScoreKind = !evaluable ? 'not-evaluable' : goldEmpty ? 'abstain' : 'scored';

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
    extractionRule: evaluator.inputs.prediction.source,
    extraction: {
      candidateCount: prediction.candidateCount,
      ...(prediction.sourceUsed === 'tool-hits' ? { citedCount: prediction.citedCount } : {}),
      anchorsRemoved: prediction.anchorRemoved,
      ...(prediction.parsedFrom ? { parsedFrom: prediction.parsedFrom } : {}),
      sourceUsed: prediction.sourceUsed,
      ...(prediction.weak ? { weak: true } : {}),
    },
    unevaluable,
    ...(notApplicable.length > 0 ? { notApplicable } : {}),
    ...(implicitAbstainValue !== null ? { implicitMetrics: [IMPLICIT_ABSTAIN_METRIC] } : {}),
    diagnostics,
  };

  // Matcher rows — one per metric so the Judge tab lists them with gold/predicted ids.
  const goldList = goldIds.slice(0, MATCHER_ID_LIST_LIMIT);
  const predictedList = ranked.slice(0, MATCHER_ID_LIST_LIMIT);
  const baseDetails = {
    gold: goldList,
    goldTotal: goldIds.length,
    goldSource: diagnostics.gold.source,
    predicted: predictedList,
    predictedTotal: ranked.length,
    extractionRule: evaluator.inputs.prediction.source,
    candidateSource: prediction.sourceUsed,
    ...(prediction.parsedFrom ? { parsedFrom: prediction.parsedFrom } : {}),
  };
  const notEvaluableReason = evaluable ? undefined : stableNotEvaluableReason(goldDeclared, goldEmpty, prediction, noApplicableGate, unevaluable, notApplicable, metrics);
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
      ...(isUnevaluable ? { errored: true, errorMessage: `${unevaluableReasonFor(spec, goldDeclared, prediction)} — ${describeDiagnostics(diagnostics)}` } : {}),
      score: isUnevaluable || isNotApplicable ? undefined : normalizedByName[spec.name],
      actual: isUnevaluable || isNotApplicable ? undefined : value,
      expected: isNotApplicable ? undefined : gateMin,
      details: {
        ...baseDetails,
        ...(k !== undefined ? { k } : {}),
        ...(isNotApplicable ? { notApplicable: true, notApplicableReason: notApplicableReason(spec, goldIds) } : {}),
      },
    };
    return row;
  });
  if (implicitAbstainValue !== null) {
    matcherResults.push({
      description: `${IMPLICIT_ABSTAIN_METRIC} (implicit — gold is explicitly empty, the right answer is nothing)`,
      pass: implicitAbstainValue === 1,
      method: 'code-assertion',
      role: 'primary',
      score: implicitAbstainValue,
      actual: implicitAbstainValue,
      expected: 1,
      details: { ...baseDetails, implicit: true },
    });
  }

  const summary = buildSummary(goldIds, prediction, metrics, unevaluable, notApplicable, passFailStatus, failReasons, notEvaluableReason, diagnostics, abstainVerdictValue);

  return {
    kind,
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
    ...(notEvaluableReason ? { notEvaluableReason } : {}),
    diagnostics,
    gold: goldIds,
    goldDeclared,
    prediction,
  };
}

function notApplicableReason(spec: DeterministicMetricSpec, goldIds: string[]): string {
  return spec.compute.type === 'abstain'
    ? `abstain only scores cases whose gold is explicitly empty (this case has ${goldIds.length} gold id${goldIds.length === 1 ? '' : 's'})`
    : 'ranked metrics only score cases with gold ids (this case explicitly declares none)';
}

/**
 * Nothing was found anywhere: for an evaluator that scores RETURNED lists only,
 * or a trajectory with no tool results, the answer is what should have carried
 * the list; otherwise the whole chain came up empty.
 */
function noListReason(prediction: CandidateExtraction): string {
  return prediction.hasAnswer && (prediction.toolsScanned.length === 0 || prediction.returnedOnly)
    ? NOT_EVALUABLE_REASONS.noAnswerList
    : NOT_EVALUABLE_REASONS.noCandidates;
}

/** Per-metric reason for an unevaluable matcher row. */
function unevaluableReasonFor(spec: DeterministicMetricSpec, goldDeclared: boolean, prediction: CandidateExtraction): string {
  if (!goldDeclared) return NOT_EVALUABLE_REASONS.noGold;
  if (spec.compute.type === 'abstain' && !prediction.returned) return NOT_EVALUABLE_REASONS.abstainUnobservable;
  if (!prediction.present) return noListReason(prediction);
  if (prediction.ranked.length === 0 && prediction.anchorRemoved > 0) return NOT_EVALUABLE_REASONS.allAnchors;
  return 'metric could not be computed';
}

/** The ONE stable reason a case is not evaluable (grouping key). */
function stableNotEvaluableReason(
  goldDeclared: boolean,
  goldEmpty: boolean,
  prediction: CandidateExtraction,
  noApplicableGate: boolean,
  unevaluable: string[],
  notApplicable: string[],
  metrics: Record<string, number>
): string {
  if (!goldDeclared) return NOT_EVALUABLE_REASONS.noGold;
  if (!prediction.present) return noListReason(prediction);
  if (goldEmpty && !prediction.returned) return NOT_EVALUABLE_REASONS.abstainUnobservable;
  if (noApplicableGate && Object.keys(metrics).length > 0) return `${NOT_EVALUABLE_REASONS.noGateApplies} (not applicable: ${notApplicable.join(', ')}; add a gate on a metric that speaks to ${goldEmpty ? 'gold-empty cases' : 'cases with gold ids'})`;
  if (unevaluable.length === 0 && notApplicable.length > 0) return `${NOT_EVALUABLE_REASONS.noMetricApplies} (${goldEmpty ? 'gold is explicitly empty and the evaluator declares only ranked metrics' : 'the evaluator declares only abstain metrics and this case has gold ids'})`;
  if (prediction.ranked.length === 0 && prediction.anchorRemoved > 0) return NOT_EVALUABLE_REASONS.allAnchors;
  if (unevaluable.length > 0 && !prediction.returned && prediction.ranked.length === 0) return NOT_EVALUABLE_REASONS.noCandidates;
  return 'no metric could be computed';
}

function buildSummary(
  goldIds: string[],
  prediction: CandidateExtraction,
  metrics: Record<string, number>,
  unevaluable: string[],
  notApplicable: string[],
  verdict: PassFailStatus | null,
  failReasons: string[],
  notEvaluableReason: string | undefined,
  diagnostics: ScoringDiagnostics,
  abstainVerdictValue: number | null
): string {
  if (verdict === null) {
    return `Not evaluable: ${notEvaluableReason ?? 'no metric could be computed'}. ${describeDiagnostics(diagnostics)}.`;
  }
  const goldSet = new Set(goldIds);
  const firstHit = prediction.ranked.findIndex(id => goldSet.has(id));
  const hits = prediction.ranked.filter(id => goldSet.has(id)).length;
  const parts = goldIds.length === 0
    ? [`gold is explicitly empty (${diagnostics.gold.source}); the agent returned ${prediction.ranked.length} candidate${prediction.ranked.length === 1 ? '' : 's'}${abstainVerdictValue !== null ? ' (verdict by abstain)' : ''}`]
    : [
        `${hits} of ${goldIds.length} gold id${goldIds.length === 1 ? '' : 's'} (${diagnostics.gold.source}) among ${prediction.ranked.length} candidate${prediction.ranked.length === 1 ? '' : 's'}`,
        firstHit >= 0 ? `first hit at rank ${firstHit + 1}` : 'no gold id ranked',
      ];
  parts.push(`candidates from ${prediction.sourceUsed}${prediction.parsedFrom ? ` (${prediction.parsedFrom})` : ''}${prediction.weak ? ' (weak)' : ''}`);
  if (prediction.sourceUsed === 'tool-hits') parts.push(`${prediction.citedCount} cited in the answer`);
  if (prediction.anchorRemoved > 0) parts.push(`${prediction.anchorRemoved} anchor${prediction.anchorRemoved === 1 ? '' : 's'} removed`);
  const metricText = Object.entries(metrics).map(([k, v]) => `${k}=${fmt(v)}`).join(', ');
  const tail = `${unevaluable.length > 0 ? `; unevaluable: ${unevaluable.join(', ')}` : ''}${notApplicable.length > 0 ? `; not applicable: ${notApplicable.join(', ')}` : ''}`;
  const why = verdict === 'failed' && failReasons.length > 0 ? ` (${failReasons.join('; ')})` : '';
  return `Deterministic scoring: ${parts.join('; ')}. ${metricText}${tail}. Verdict ${verdict}${why}.`;
}
