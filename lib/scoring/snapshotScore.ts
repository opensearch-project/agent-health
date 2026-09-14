/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Snapshot scoring read model.
 *
 * The ONLY place a report's rubric values are turned into a single score.
 * Everything here is pure arithmetic over the report's own `metrics` and its
 * frozen `scoringSnapshot` — no evaluator fetch, no defaults borrowed from
 * today's (mutable) evaluator document. A report without a snapshot is
 * `legacy`: its rubric values may be displayed by name, but they are never
 * averaged, picked alphabetically, or otherwise relabelled as "the score".
 *
 * Normalization: each rubric is mapped to [0,1] via its declared scale
 * (default 0–100) and clamped; the score is the weight-normalized mean over
 * the rubrics that produced a value. Rubrics listed in
 * `snapshot.unevaluable`, missing from `metrics`, or with an invalid scale
 * are EXCLUDED from the mean (never scored as 0) but still counted in
 * `total`, so callers can render "scored X / Y rubrics" truthfully.
 */

import type { EvaluationReport, ScoringSnapshot } from '@/types';

export const DEFAULT_SCALE = { min: 0, max: 100 } as const;

export type ReportScore =
  | {
      source: 'snapshot';
      /** Weighted mean in [0,1]; `null` when no rubric could be scored. */
      score: number | null;
      /** Rubrics that contributed to the mean. */
      scored: number;
      /** Rubrics the snapshot weights declare (weight > 0). */
      total: number;
      /** Rubrics excluded from the mean (declared unevaluable, missing, or bad scale). */
      unevaluable: string[];
    }
  | { source: 'legacy' };

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A snapshot is usable iff it declares at least one positively-weighted rubric. */
export function hasUsableSnapshot(
  report: Pick<EvaluationReport, 'scoringSnapshot'> | undefined | null
): report is Pick<EvaluationReport, 'scoringSnapshot'> & { scoringSnapshot: ScoringSnapshot } {
  const snap = report?.scoringSnapshot;
  if (!snap || typeof snap !== 'object' || !snap.weights || typeof snap.weights !== 'object') return false;
  return Object.values(snap.weights).some(w => isFiniteNumber(w) && w > 0);
}

/** Rubric names the snapshot scores (finite weight > 0), in declaration order. */
export function scoredRubricNames(snapshot: ScoringSnapshot): string[] {
  return Object.keys(snapshot.weights).filter(k => isFiniteNumber(snapshot.weights[k]) && snapshot.weights[k] > 0);
}

/** Scale for a rubric — the snapshot's declared one or the 0–100 default. */
export function rubricScale(snapshot: ScoringSnapshot, rubric: string): { min: number; max: number } {
  const s = snapshot.scale?.[rubric];
  if (s && isFiniteNumber(s.min) && isFiniteNumber(s.max)) return { min: s.min, max: s.max };
  return { ...DEFAULT_SCALE };
}

/** Map a raw rubric value onto [0,1] (clamped); `null` for an invalid scale. */
export function normalizeRubric(value: number, scale: { min: number; max: number }): number | null {
  if (!(scale.max > scale.min)) return null;
  const n = (value - scale.min) / (scale.max - scale.min);
  return Math.min(1, Math.max(0, n));
}

/**
 * Score a single report from its snapshot. Never consults anything but the
 * report itself.
 */
export function scoreFromSnapshot(
  report: Pick<EvaluationReport, 'metrics' | 'scoringSnapshot'> | undefined | null
): ReportScore {
  if (!hasUsableSnapshot(report)) return { source: 'legacy' };
  const snapshot = report.scoringSnapshot;
  const metrics = (report.metrics ?? {}) as Record<string, unknown>;
  const declaredUnevaluable = new Set(Array.isArray(snapshot.unevaluable) ? snapshot.unevaluable : []);

  const rubrics = scoredRubricNames(snapshot);
  const unevaluable: string[] = [];
  let weightSum = 0;
  let weighted = 0;
  let scored = 0;

  for (const rubric of rubrics) {
    const raw = metrics[rubric];
    if (declaredUnevaluable.has(rubric) || !isFiniteNumber(raw)) {
      unevaluable.push(rubric);
      continue;
    }
    const normalized = normalizeRubric(raw, rubricScale(snapshot, rubric));
    if (normalized === null) {
      unevaluable.push(rubric);
      continue;
    }
    const w = snapshot.weights[rubric];
    weightSum += w;
    weighted += w * normalized;
    scored++;
  }

  return {
    source: 'snapshot',
    score: scored > 0 && weightSum > 0 ? weighted / weightSum : null,
    scored,
    total: rubrics.length,
    unevaluable,
  };
}

export type RunScoreAggregate =
  | {
      source: 'snapshot';
      /** Mean of per-report scores in [0,1]; `null` when no report scored. */
      score: number | null;
      /** Reports that produced a score. */
      scoredReports: number;
      /** Reports that were evaluated (judge produced metrics) — the population `scoredReports` is drawn from. */
      evaluatedReports: number;
      /** Rubric coverage summed over the evaluated reports. */
      scoredRubrics: number;
      totalRubrics: number;
      /** One representative snapshot per distinct `contentHash`, in first-seen order. */
      snapshots: ScoringSnapshot[];
    }
  | {
      source: 'legacy';
      evaluatedReports: number;
      /** How many of the evaluated reports DID carry a usable snapshot (0 for fully legacy runs). */
      withSnapshot: number;
    };

/**
 * A report the judge never finished on contributes nothing to any score and
 * does not decide whether a run is snapshot- or legacy-scored.
 */
export function isEvaluatedReport(report: Pick<EvaluationReport, 'metricsStatus'> | undefined | null): boolean {
  if (!report) return false;
  const s = report.metricsStatus;
  return s !== 'error' && s !== 'pending' && s !== 'calculating';
}

/**
 * Aggregate a run's reports. The run is `snapshot`-scored only when EVERY
 * evaluated report carries a usable snapshot; a single legacy report makes
 * the run-level score `legacy` (a mean over half the cases would be a lie).
 * A run with zero evaluated reports is `legacy` too (nothing to score).
 */
export function runAggregate(
  reports: ReadonlyArray<Pick<EvaluationReport, 'metrics' | 'scoringSnapshot' | 'metricsStatus'> | undefined | null>
): RunScoreAggregate {
  const evaluated = reports.filter((r): r is NonNullable<typeof r> => isEvaluatedReport(r));
  const withSnapshot = evaluated.filter(r => hasUsableSnapshot(r)).length;
  if (evaluated.length === 0 || withSnapshot !== evaluated.length) {
    return { source: 'legacy', evaluatedReports: evaluated.length, withSnapshot };
  }

  let sum = 0;
  let scoredReports = 0;
  let scoredRubrics = 0;
  let totalRubrics = 0;
  const snapshots: ScoringSnapshot[] = [];
  const seenHashes = new Set<string>();

  for (const report of evaluated) {
    const rs = scoreFromSnapshot(report);
    if (rs.source !== 'snapshot') continue; // unreachable given the guard above; keeps TS honest
    scoredRubrics += rs.scored;
    totalRubrics += rs.total;
    if (rs.score !== null) {
      sum += rs.score;
      scoredReports++;
    }
    const snap = report.scoringSnapshot as ScoringSnapshot;
    const hash = String(snap.contentHash ?? '');
    if (!seenHashes.has(hash)) {
      seenHashes.add(hash);
      snapshots.push(snap);
    }
  }

  return {
    source: 'snapshot',
    score: scoredReports > 0 ? sum / scoredReports : null,
    scoredReports,
    evaluatedReports: evaluated.length,
    scoredRubrics,
    totalRubrics,
    snapshots,
  };
}

/**
 * Run-level mean of each declared primary metric (raw scale, NOT normalized)
 * over the evaluated reports that carry a finite value for it. Names are
 * passed through verbatim — nothing here knows what "Hit@1" means.
 */
export function primaryMetricMeans(
  reports: ReadonlyArray<Pick<EvaluationReport, 'metrics' | 'metricsStatus'> | undefined | null>,
  names: ReadonlyArray<string>
): Record<string, number | undefined> {
  const out: Record<string, number | undefined> = {};
  const evaluated = reports.filter((r): r is NonNullable<typeof r> => isEvaluatedReport(r));
  for (const name of names) {
    let sum = 0;
    let n = 0;
    for (const r of evaluated) {
      const v = (r.metrics as Record<string, unknown> | undefined)?.[name];
      if (isFiniteNumber(v)) { sum += v; n++; }
    }
    out[name] = n > 0 ? sum / n : undefined;
  }
  return out;
}

/**
 * Every finite numeric metric on a report, by name, in stored order. This is
 * the legacy read: values are shown under their own names and never combined.
 */
export function rubricValuesByName(
  metrics: Record<string, number | undefined> | undefined | null
): Record<string, number> {
  const out: Record<string, number> = {};
  if (!metrics) return out;
  for (const [k, v] of Object.entries(metrics)) {
    if (isFiniteNumber(v)) out[k] = v;
  }
  return out;
}
