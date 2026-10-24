/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Typed ranked-retrieval metric registry.
 *
 * Pure functions, one implementation each, shared by every scoring path in
 * Agent Health — the deterministic evaluator engine
 * (`lib/scoring/deterministicScoring.ts`) AND code-SDK tests that import
 * `@opensearch-project/agent-health/metrics` — so a matcher row and an
 * evaluator row computed over the same inputs are guaranteed to agree.
 *
 * Contract shared by every metric:
 *   - `gold`   — the expected ids (a set; order and duplicates ignored).
 *   - `ranked` — the predicted ids in rank order, best first. Callers are
 *                expected to have already removed anchors / excluded ids;
 *                duplicates are collapsed here (first occurrence keeps its
 *                rank) so a repeated id can never be counted twice.
 *   - Result   — a number in [0, 1], or `null` when the metric is
 *                UNEVALUABLE (empty gold or empty ranking). `null` is
 *                deliberately not 0: "nothing to score against" must never
 *                look like "scored zero".
 *
 * Metric NAMES are not defined here on purpose. Agent Health only knows
 * compute TYPES (`ranked-hit`, `ranked-recall`, `mrr`); the human-facing name
 * ("Hit@5", "recall_at_20", …) is free-form data on the evaluator document.
 */

export type MetricInputs = {
  /** Expected ids. */
  gold: ReadonlyArray<string>;
  /** Predicted ids in rank order (best first). */
  ranked: ReadonlyArray<string>;
};

/** Denominator semantics for `rankedRecall`. */
export type RecallDenominator = 'full-gold' | 'min-k-gold';

export type MetricCompute =
  | { type: 'ranked-hit'; k: number }
  | { type: 'ranked-recall'; k: number; denominator?: RecallDenominator }
  | { type: 'mrr' };

export type MetricComputeType = MetricCompute['type'];

export const METRIC_COMPUTE_TYPES: ReadonlyArray<MetricComputeType> = ['ranked-hit', 'ranked-recall', 'mrr'];

export class MetricValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetricValidationError';
  }
}

const normalizeId = (id: unknown): string | null => {
  if (typeof id === 'number' && Number.isFinite(id)) return String(id);
  if (typeof id !== 'string') return null;
  const t = id.trim();
  return t.length > 0 ? t : null;
};

/** Distinct, trimmed, non-empty ids in first-occurrence order. */
export function dedupeIds(ids: ReadonlyArray<unknown>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ids ?? []) {
    const id = normalizeId(raw);
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function prepare(inputs: MetricInputs): { gold: Set<string>; ranked: string[] } | null {
  const gold = new Set(dedupeIds(inputs?.gold ?? []));
  const ranked = dedupeIds(inputs?.ranked ?? []);
  if (gold.size === 0 || ranked.length === 0) return null;
  return { gold, ranked };
}

function assertK(k: unknown, type: string): number {
  if (typeof k !== 'number' || !Number.isInteger(k) || k < 1) {
    throw new MetricValidationError(`${type}: k must be a positive integer (got ${JSON.stringify(k)})`);
  }
  return k;
}

/**
 * Hit@k — 1 when any gold id appears among the first `k` ranked ids, else 0.
 * `null` when unevaluable.
 */
export function rankedHit(args: MetricInputs & { k: number }): number | null {
  const k = assertK(args.k, 'ranked-hit');
  const p = prepare(args);
  if (!p) return null;
  const top = p.ranked.slice(0, k);
  return top.some(id => p.gold.has(id)) ? 1 : 0;
}

/**
 * Recall@k — gold ids found among the first `k` ranked ids, divided by
 *   - `'full-gold'` (default): the size of the whole gold set (a gold set
 *     larger than `k` therefore caps recall below 1 — the standard
 *     definition used by ranked-retrieval benchmarks), or
 *   - `'min-k-gold'`: `min(k, |gold|)` (recall of what could be retrieved).
 * `null` when unevaluable.
 */
export function rankedRecall(args: MetricInputs & { k: number; denominator?: RecallDenominator }): number | null {
  const k = assertK(args.k, 'ranked-recall');
  const denominator = args.denominator ?? 'full-gold';
  if (denominator !== 'full-gold' && denominator !== 'min-k-gold') {
    throw new MetricValidationError(`ranked-recall: denominator must be 'full-gold' or 'min-k-gold' (got ${JSON.stringify(denominator)})`);
  }
  const p = prepare(args);
  if (!p) return null;
  const top = p.ranked.slice(0, k);
  let hits = 0;
  for (const id of top) if (p.gold.has(id)) hits++;
  const denom = denominator === 'full-gold' ? p.gold.size : Math.min(k, p.gold.size);
  return denom > 0 ? Math.min(1, hits / denom) : null;
}

/**
 * MRR — reciprocal rank of the FIRST gold id in the ranking (1 / rank,
 * 1-based); 0 when no gold id is ranked at all. `null` when unevaluable.
 */
export function mrr(args: MetricInputs): number | null {
  const p = prepare(args);
  if (!p) return null;
  for (let i = 0; i < p.ranked.length; i++) {
    if (p.gold.has(p.ranked[i])) return 1 / (i + 1);
  }
  return 0;
}

/**
 * Validate a `compute` descriptor (as stored on an evaluator document).
 * Throws {@link MetricValidationError} with a human-readable message.
 */
export function validateMetricCompute(compute: unknown): MetricCompute {
  if (!compute || typeof compute !== 'object') {
    throw new MetricValidationError('compute must be an object with a `type`');
  }
  const c = compute as Record<string, unknown>;
  switch (c.type) {
    case 'ranked-hit':
      return { type: 'ranked-hit', k: assertK(c.k, 'ranked-hit') };
    case 'ranked-recall': {
      const k = assertK(c.k, 'ranked-recall');
      const denominator = c.denominator ?? 'full-gold';
      if (denominator !== 'full-gold' && denominator !== 'min-k-gold') {
        throw new MetricValidationError(`ranked-recall: denominator must be 'full-gold' or 'min-k-gold' (got ${JSON.stringify(c.denominator)})`);
      }
      return { type: 'ranked-recall', k, denominator };
    }
    case 'mrr':
      return { type: 'mrr' };
    default:
      throw new MetricValidationError(
        `unknown compute type ${JSON.stringify(c.type)}; supported: ${METRIC_COMPUTE_TYPES.join(', ')}`
      );
  }
}

/**
 * Registry entry point: compute one metric by its typed descriptor.
 * Unknown types and malformed params throw {@link MetricValidationError};
 * unevaluable inputs return `null`.
 */
export function computeMetric(compute: MetricCompute | Record<string, unknown>, inputs: MetricInputs): number | null {
  const c = validateMetricCompute(compute);
  switch (c.type) {
    case 'ranked-hit':
      return rankedHit({ ...inputs, k: c.k });
    case 'ranked-recall':
      return rankedRecall({ ...inputs, k: c.k, denominator: c.denominator });
    case 'mrr':
      return mrr(inputs);
  }
}

/** Short human label for a compute descriptor, e.g. "ranked-hit@5". */
export function describeMetricCompute(compute: MetricCompute): string {
  switch (compute.type) {
    case 'ranked-hit':
      return `ranked-hit@${compute.k}`;
    case 'ranked-recall':
      return `ranked-recall@${compute.k}${compute.denominator === 'min-k-gold' ? ' (min-k-gold)' : ''}`;
    case 'mrr':
      return 'mrr';
  }
}
