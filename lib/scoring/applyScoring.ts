/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Snapshot WRITE path: freeze an evaluator version into a per-report
 * {@link ScoringSnapshot} and run the canonical verdict engine over a judge
 * response. Called from exactly one place per judgement — the `/api/judge`
 * route, which every judgement producer (classic judge, trace judge, SDK
 * `judge()`, re-judge, recovery) funnels through — so no producer can carry
 * its own copy of the verdict logic.
 *
 * Node-only (uses `crypto` for the content hash); browser code reads
 * snapshots via `lib/scoring/snapshotScore.ts` and never imports this.
 */

import { createHash } from 'crypto';
import type { Evaluator, PassFailStatus, ScoringConfig, ScoringSnapshot } from '@/types';
import { computeVerdict, normalizePassPolicy } from './verdictEngine';

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * The scoring-relevant content of an evaluator version, in canonical form.
 * Two evaluator versions score reports comparably iff this is identical, so
 * it is what {@link evaluatorContentHash} hashes: prompt, rubric names,
 * weights, scales, pass policy and primary metrics. Ordering is normalized
 * (metrics sorted by name, object keys sorted) so cosmetic reorderings
 * don't change the hash; anything that changes a number or the prompt does.
 */
function evaluatorScoringContent(evaluator: Pick<Evaluator, 'systemPrompt' | 'scoringConfig'>) {
  const sc: Partial<ScoringConfig> = evaluator.scoringConfig ?? {};
  const metrics = [...(sc.metrics ?? [])]
    .map(m => ({
      name: m.name,
      weight: isFiniteNumber(m.weight) ? m.weight : 1,
      scale: isFiniteNumber(m.scale) && m.scale > 0 ? m.scale : 100,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    systemPrompt: evaluator.systemPrompt ?? '',
    metrics,
    passPolicy: normalizePassPolicy(sc.passPolicy),
    primaryMetrics: Array.isArray(sc.primaryMetrics) ? [...sc.primaryMetrics] : [],
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Deterministic `sha256:<16 hex>` over {@link evaluatorScoringContent}. */
export function evaluatorContentHash(evaluator: Pick<Evaluator, 'systemPrompt' | 'scoringConfig'>): string {
  const digest = createHash('sha256').update(canonicalJson(evaluatorScoringContent(evaluator))).digest('hex');
  return `sha256:${digest.slice(0, 16)}`;
}

export interface BuildSnapshotOptions {
  /** The judge model that actually produced the metrics (resolved id). */
  judgeModelId?: string;
  /** Rubrics the judge did not return / returned non-numeric. */
  unevaluable?: string[];
}

/**
 * Freeze the evaluator AS USED into a report snapshot. Identity is
 * `evaluatorId` + `contentHash` (no separate versioning scheme is introduced
 * here); `evaluatorVersion` is copied from the evaluator document's own
 * `currentVersion` purely as a human-readable hint.
 */
export function buildScoringSnapshot(evaluator: Evaluator, options: BuildSnapshotOptions = {}): ScoringSnapshot {
  const content = evaluatorScoringContent(evaluator);
  const weights: Record<string, number> = {};
  const scale: Record<string, { min: number; max: number }> = {};
  for (const m of content.metrics) {
    weights[m.name] = m.weight;
    scale[m.name] = { min: 0, max: m.scale };
  }
  const snapshot: ScoringSnapshot = {
    evaluatorId: evaluator.id,
    evaluatorVersion: evaluator.currentVersion ?? 1,
    contentHash: evaluatorContentHash(evaluator),
    evaluatorName: evaluator.name,
    weights,
    scale,
    passPolicy: content.passPolicy,
  };
  if (content.primaryMetrics.length > 0) snapshot.primaryMetrics = content.primaryMetrics;
  if (options.judgeModelId) snapshot.judgeModelId = options.judgeModelId;
  if (options.unevaluable && options.unevaluable.length > 0) snapshot.unevaluable = [...options.unevaluable];
  return snapshot;
}

export interface ApplyScoringOptions {
  /** The judge model that actually produced the metrics (resolved id); omit for deterministic scoring. */
  judgeModelId?: string;
}

export interface ScoringResult {
  passFailStatus: PassFailStatus;
  /** Present only when an LLM verdict was supplied. */
  llmVerdict?: PassFailStatus;
  verdictConflict: boolean;
  /** Normalized weighted mean in [0,1]; `null` when nothing was scorable. */
  score: number | null;
  scoringSnapshot: ScoringSnapshot;
}

/**
 * Score a set of rubric values against an evaluator AS USED: freeze the
 * evaluator into a snapshot (identity = `evaluatorId` + `contentHash`) and
 * run the verdict engine. `llmVerdict` is optional so deterministic scoring
 * (no LLM involved) uses the same path; under a `threshold` / `gates`
 * policy it is only recorded for the conflict flag. Rubric values the
 * evaluator declares but `metrics` lacks are `unevaluable` — never 0.
 */
export function applyScoring(
  metrics: Record<string, unknown> | undefined | null,
  evaluator: Evaluator,
  llmVerdict?: PassFailStatus,
  options: ApplyScoringOptions = {}
): ScoringResult {
  const values = (metrics ?? {}) as Record<string, unknown>;
  const declared = (evaluator.scoringConfig?.metrics ?? []).map(m => m.name);
  const missing = declared.filter(name => !isFiniteNumber(values[name]));
  const snapshot = buildScoringSnapshot(evaluator, { judgeModelId: options.judgeModelId, unevaluable: missing });
  const verdict = computeVerdict({ metrics: values, snapshot, llmVerdict });
  if (verdict.unevaluable.length > 0) snapshot.unevaluable = verdict.unevaluable;
  else delete snapshot.unevaluable;
  return {
    passFailStatus: verdict.passFailStatus,
    ...(llmVerdict !== undefined ? { llmVerdict } : {}),
    verdictConflict: verdict.verdictConflict,
    score: verdict.score,
    scoringSnapshot: snapshot,
  };
}

/** The judge-response fields the engine reads and writes. */
export interface ScorableJudgeResponse {
  passFailStatus: PassFailStatus;
  metrics: Record<string, number | undefined>;
  judgeDebug?: { modelId?: string };
  llmVerdict?: PassFailStatus;
  verdictConflict?: boolean;
  score?: number;
  scoringSnapshot?: ScoringSnapshot;
}

/**
 * {@link applyScoring} over a parsed LLM judge response: `passFailStatus`
 * becomes the engine's verdict (identical to the LLM's under `llm-verdict`),
 * the LLM's own verdict moves to `llmVerdict`, and `score` /
 * `verdictConflict` / `scoringSnapshot` are added. Rubric values (`metrics`)
 * are left exactly as parsed — never filled with 0.
 */
export function applyScoringToJudgeResponse<T extends ScorableJudgeResponse>(
  response: T,
  evaluator: Evaluator,
  resolvedJudgeModelId?: string
): T {
  const llmVerdict: PassFailStatus = response.passFailStatus === 'passed' ? 'passed' : 'failed';
  const judgeModelId = response.judgeDebug?.modelId || resolvedJudgeModelId || undefined;
  const result = applyScoring(response.metrics, evaluator, llmVerdict, { judgeModelId });
  const out: T = {
    ...response,
    passFailStatus: result.passFailStatus,
    llmVerdict,
    verdictConflict: result.verdictConflict,
    scoringSnapshot: result.scoringSnapshot,
  };
  if (result.score !== null) out.score = result.score;
  else delete (out as ScorableJudgeResponse).score;
  return out;
}
