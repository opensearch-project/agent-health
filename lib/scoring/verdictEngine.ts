/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Canonical verdict engine.
 *
 * The ONE place a report's pass/fail verdict is decided from its rubric
 * values. Every judgement producer (classic judge, trace judge, SDK `judge()`,
 * re-judge) feeds the judge's parsed metrics + the evaluator's frozen
 * snapshot through {@link computeVerdict}; nothing else may derive a verdict.
 *
 * Truth table (`policy.kind`):
 *
 * | policy        | passFailStatus                                                        | verdictConflict            |
 * |---------------|-----------------------------------------------------------------------|----------------------------|
 * | `llm-verdict` | the judge's own `pass_fail_status` (frozen historical behaviour)      | always `false`             |
 * | `threshold`   | `passed` iff score ≥ minScore AND no weighted rubric is unevaluable   | llmVerdict ≠ passFailStatus |
 * | `gates`       | `passed` iff every gate metric (normalized) ≥ its normalized `min`;   | llmVerdict ≠ passFailStatus |
 * |               | an unevaluable gate metric fails the gate                             |                            |
 *
 * Score (all policies): weight-normalized mean over the rubrics that produced
 * a finite, normalizable value (see `snapshotScore.ts`). A rubric the judge
 * did not return, returned non-numeric, or whose scale is invalid is
 * `unevaluable` — excluded from the mean and NEVER coerced to 0. Under
 * `threshold` an unevaluable weighted rubric makes the verdict `failed` with
 * reason `unevaluable:<metric>` — a partial rubric never silently passes.
 *
 * `verdictConflict` is recorded, never acted on: the computed verdict wins
 * under a computed policy, and the LLM's verdict is kept as `llmVerdict`.
 */

import type { PassFailStatus, ScoringPassPolicy, ScoringSnapshot } from '@/types';
import { normalizeRubric, rubricScale, scoreFromSnapshot } from './snapshotScore';

const LLM_VERDICT_POLICY: ScoringPassPolicy = { kind: 'llm-verdict' };

/** The subset of a snapshot the engine needs; a full {@link ScoringSnapshot} qualifies. */
export type VerdictSnapshot = Pick<ScoringSnapshot, 'weights' | 'scale' | 'passPolicy' | 'unevaluable'>;

export interface VerdictInput {
  /** Parsed rubric values by name (the report's `metrics`). */
  metrics: Record<string, unknown> | undefined | null;
  /** Frozen weights / scales / policy (the report's `scoringSnapshot`). */
  snapshot: VerdictSnapshot;
  /** The judge's own `pass_fail_status`, when the judge produced one. */
  llmVerdict?: PassFailStatus;
}

export interface VerdictResult {
  /** Weighted mean in [0,1]; `null` when no rubric could be scored. */
  score: number | null;
  passFailStatus: PassFailStatus;
  llmVerdict?: PassFailStatus;
  /** `true` when the LLM's verdict differs from the computed one. */
  verdictConflict: boolean;
  /** Weighted rubrics (and gate metrics) that could not be evaluated. */
  unevaluable: string[];
  /** Weighted rubrics that contributed to the score. */
  scored: number;
  /** Weighted rubrics the snapshot declares. */
  total: number;
  /** Machine-readable reasons behind a `failed` computed verdict (empty for llm-verdict / passes). */
  reasons: string[];
}

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Normalize a policy value read from storage/config: anything malformed is the frozen default. */
export function normalizePassPolicy(policy: unknown): ScoringPassPolicy {
  if (!policy || typeof policy !== 'object') return LLM_VERDICT_POLICY;
  const p = policy as Record<string, unknown>;
  if (p.kind === 'threshold' && isFiniteNumber(p.minScore)) {
    return { kind: 'threshold', minScore: p.minScore };
  }
  if (p.kind === 'gates' && Array.isArray(p.gates)) {
    const gates = p.gates
      .filter((g): g is { metric: string; min: number } =>
        !!g && typeof g === 'object' && typeof (g as any).metric === 'string' && isFiniteNumber((g as any).min))
      .map(g => ({ metric: g.metric, min: g.min }));
    return { kind: 'gates', gates };
  }
  return LLM_VERDICT_POLICY;
}

/**
 * Decide a report's verdict. Pure: reads only its arguments.
 */
export function computeVerdict(input: VerdictInput): VerdictResult {
  const policy = normalizePassPolicy(input.snapshot.passPolicy);
  const snapshot: ScoringSnapshot = {
    evaluatorId: '',
    evaluatorVersion: 0,
    contentHash: '',
    weights: input.snapshot.weights ?? {},
    scale: input.snapshot.scale,
    passPolicy: policy,
    unevaluable: input.snapshot.unevaluable,
  };
  const metrics = (input.metrics ?? {}) as Record<string, unknown>;
  const scored = scoreFromSnapshot({ metrics: metrics as any, scoringSnapshot: snapshot });
  const score = scored.source === 'snapshot' ? scored.score : null;
  const unevaluable = scored.source === 'snapshot' ? [...scored.unevaluable] : [];
  const scoredCount = scored.source === 'snapshot' ? scored.scored : 0;
  const total = scored.source === 'snapshot' ? scored.total : 0;
  const reasons: string[] = [];

  let passFailStatus: PassFailStatus;
  switch (policy.kind) {
    case 'threshold': {
      for (const u of unevaluable) reasons.push(`unevaluable:${u}`);
      if (score === null) {
        reasons.push('no-scored-rubrics');
      } else if (score < policy.minScore) {
        reasons.push(`score ${score.toFixed(3)} < ${policy.minScore}`);
      }
      passFailStatus = reasons.length === 0 ? 'passed' : 'failed';
      break;
    }
    case 'gates': {
      for (const gate of policy.gates) {
        const raw = metrics[gate.metric];
        const scale = rubricScale(snapshot, gate.metric);
        const value = isFiniteNumber(raw) ? normalizeRubric(raw, scale) : null;
        const min = normalizeRubric(gate.min, scale);
        if (value === null || min === null) {
          if (!unevaluable.includes(gate.metric)) unevaluable.push(gate.metric);
          reasons.push(`unevaluable:${gate.metric}`);
        } else if (value < min) {
          reasons.push(`gate ${gate.metric} ${raw} < ${gate.min}`);
        }
      }
      if (policy.gates.length === 0) reasons.push('no-gates-declared');
      passFailStatus = reasons.length === 0 ? 'passed' : 'failed';
      break;
    }
    case 'llm-verdict':
    default:
      // Frozen historical behaviour: whatever the judge said. A missing
      // verdict under this policy has always read as `failed` (parser); the
      // reason makes a deterministic evaluator mis-configured with
      // `llm-verdict` (rejected at validation) visible if it ever gets here.
      if (input.llmVerdict === undefined) reasons.push('no-llm-verdict');
      passFailStatus = input.llmVerdict === 'passed' ? 'passed' : 'failed';
      break;
  }

  const verdictConflict =
    policy.kind !== 'llm-verdict' && input.llmVerdict !== undefined && input.llmVerdict !== passFailStatus;

  return {
    score,
    passFailStatus,
    ...(input.llmVerdict !== undefined ? { llmVerdict: input.llmVerdict } : {}),
    verdictConflict,
    unevaluable,
    scored: scoredCount,
    total,
    reasons,
  };
}

/**
 * The verdict-engine fields exactly as they land on a report document. Every
 * producer spreads THIS onto its report / update payload instead of copying
 * `passFailStatus` / `metrics` by hand, so no producer can drift from the
 * engine (e.g. by persisting the LLM's verdict as the report's).
 *
 * Every scoring field is ALWAYS present — `null` when this judgement did not
 * produce it. Both storage backends merge updates over the existing document
 * (`{...existing, ...updates}`) and drop `undefined` keys on serialization,
 * so an omitted key would silently keep the PREVIOUS judgement's snapshot /
 * score / verdict on a re-judge. Explicit `null` clears it.
 */
export interface ReportScoringFields {
  passFailStatus: PassFailStatus;
  metrics: Record<string, number | undefined>;
  llmVerdict: PassFailStatus | null;
  verdictConflict: boolean | null;
  score: number | null;
  scoringSnapshot: ScoringSnapshot | null;
}

export function scoringFieldsFromJudgment(judgment: {
  passFailStatus: PassFailStatus;
  metrics: Record<string, number | undefined>;
  llmVerdict?: PassFailStatus;
  verdictConflict?: boolean;
  score?: number | null;
  scoringSnapshot?: ScoringSnapshot;
}): ReportScoringFields {
  return {
    passFailStatus: judgment.passFailStatus,
    metrics: judgment.metrics ?? {},
    llmVerdict: judgment.llmVerdict ?? null,
    verdictConflict: typeof judgment.verdictConflict === 'boolean' ? judgment.verdictConflict : null,
    score: isFiniteNumber(judgment.score) ? judgment.score : null,
    scoringSnapshot: judgment.scoringSnapshot ?? null,
  };
}

/**
 * Report-level scoring provenance for an SDK matcher-session run.
 *
 * Unlike {@link scoringFieldsFromJudgment} this returns only the keys it can
 * assert (the SDK report is built fresh per run, never merged over an older
 * judgement, so omitted keys cannot resurrect stale values).
 *
 * In the SDK path the verdict is the matcher session's gate outcome (every
 * `expect()` / `judge()` gate must pass) — the evaluator's pass policy is
 * applied PER `judge()` call by `/api/judge`, so each judge matcher's `pass`
 * already follows it. What the report still needs is the frozen evaluator
 * snapshot + the weighted score over the report-level rubric means, so SDK
 * runs are snapshot-scored on the compare page like classic-judge runs.
 *
 * Returns `{}` when no judge matcher carries a snapshot (pure code tests,
 * pre-R2 servers) or when the judge matchers were scored by DIFFERENT
 * evaluator versions (one report cannot honestly carry two snapshots).
 * `llmVerdict` is lifted only when exactly one judge matcher ran (it is a
 * per-judgement fact); `verdictConflict` is `true` when ANY judge matcher
 * disagreed with its LLM, so a disagreement never disappears behind an
 * aggregate.
 */
export interface SdkSessionScoringFields {
  scoringSnapshot?: ScoringSnapshot;
  score?: number;
  llmVerdict?: PassFailStatus;
  verdictConflict?: boolean;
}

export function sdkSessionScoring(
  matcherResults: ReadonlyArray<{
    method: string;
    errored?: boolean;
    notReached?: boolean;
    scoringSnapshot?: ScoringSnapshot;
    llmVerdict?: PassFailStatus;
    verdictConflict?: boolean;
  }>,
  metrics: Record<string, number | undefined> | undefined
): SdkSessionScoringFields {
  const judged = matcherResults.filter(m => m.method === 'llm-judge' && !m.errored && !m.notReached && m.scoringSnapshot);
  if (judged.length === 0) return {};
  const hashes = new Set(judged.map(m => m.scoringSnapshot!.contentHash));
  if (hashes.size !== 1) return {};

  const { unevaluable: _perCall, ...frozen } = judged[0].scoringSnapshot!;
  const snapshot: ScoringSnapshot = { ...frozen };
  const scored = scoreFromSnapshot({ metrics: (metrics ?? {}) as any, scoringSnapshot: snapshot });
  const out: SdkSessionScoringFields = {};
  if (scored.source === 'snapshot') {
    if (scored.unevaluable.length > 0) snapshot.unevaluable = scored.unevaluable;
    if (scored.score !== null) out.score = scored.score;
  }
  out.scoringSnapshot = snapshot;
  if (judged.length === 1 && judged[0].llmVerdict !== undefined) out.llmVerdict = judged[0].llmVerdict;
  const conflicts = judged.filter(m => typeof m.verdictConflict === 'boolean');
  if (conflicts.length > 0) out.verdictConflict = conflicts.some(m => m.verdictConflict === true);
  return out;
}
