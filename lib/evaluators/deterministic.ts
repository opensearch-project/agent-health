/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Validation + normalization for `kind: 'deterministic'` evaluator documents.
 *
 * Shared by the storage routes (POST/PUT /api/storage/evaluators → 400 with
 * the first error), the evaluator editor (client-side preflight) and the
 * scoring engine (which trusts only a document that passed here).
 *
 * Deliberately pure and dependency-free (no crypto, no storage) so it can be
 * bundled into the browser.
 */

import type {
  DeterministicEvaluatorInputs,
  DeterministicMetricSpec,
  Evaluator,
  ScoringConfig,
  ScoringPassPolicy,
} from '@/types';
import { validateMetricCompute, MetricValidationError } from '@/lib/metrics/index';

export const DEFAULT_METRIC_SCALE = { min: 0, max: 1 } as const;

export type DeterministicEvaluatorDoc = Pick<Evaluator, 'kind' | 'metrics' | 'passPolicy' | 'inputs'> &
  Partial<Pick<Evaluator, 'id' | 'name' | 'description' | 'systemPrompt' | 'scoringConfig' | 'inferenceConfig'>>;

export function isDeterministicEvaluator(
  evaluator: Pick<Evaluator, 'kind'> | null | undefined
): evaluator is Pick<Evaluator, 'kind'> & { kind: 'deterministic' } {
  return evaluator?.kind === 'deterministic';
}

const isFinite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isNonEmptyString);

/**
 * Validate a deterministic evaluator body. Returns the list of human-readable
 * problems (empty = valid). Does not mutate the input.
 */
export function validateDeterministicEvaluator(doc: unknown): string[] {
  const errors: string[] = [];
  if (!doc || typeof doc !== 'object') return ['evaluator must be an object'];
  const d = doc as Record<string, unknown>;
  if (d.kind !== 'deterministic') return ["kind must be 'deterministic'"];

  // metrics
  const metrics = d.metrics;
  if (!Array.isArray(metrics) || metrics.length === 0) {
    errors.push('metrics must be a non-empty array');
  } else {
    const names = new Set<string>();
    metrics.forEach((m, i) => {
      const where = `metrics[${i}]`;
      if (!m || typeof m !== 'object') {
        errors.push(`${where} must be an object`);
        return;
      }
      const mm = m as Record<string, unknown>;
      if (!isNonEmptyString(mm.name)) errors.push(`${where}.name must be a non-empty string`);
      else if (names.has(mm.name)) errors.push(`${where}.name '${mm.name}' is duplicated`);
      else names.add(mm.name);
      try {
        validateMetricCompute(mm.compute);
      } catch (e) {
        errors.push(`${where}.compute: ${e instanceof MetricValidationError ? e.message : String(e)}`);
      }
      if (!isFinite(mm.weight) || mm.weight <= 0) errors.push(`${where}.weight must be a finite number > 0`);
      if (mm.scale !== undefined) {
        const s = mm.scale as Record<string, unknown> | null;
        if (!s || typeof s !== 'object' || !isFinite(s.min) || !isFinite(s.max) || !(s.max > s.min)) {
          errors.push(`${where}.scale must be { min, max } with max > min`);
        }
      }
      if (mm.primary !== undefined && typeof mm.primary !== 'boolean') errors.push(`${where}.primary must be a boolean`);
    });

    // passPolicy (needs metric names for gate checks)
    const pp = d.passPolicy as Record<string, unknown> | undefined;
    if (!pp || typeof pp !== 'object') {
      errors.push("passPolicy is required ({ kind: 'threshold', minScore } or { kind: 'gates', gates })");
    } else if (pp.kind === 'llm-verdict') {
      errors.push("passPolicy.kind 'llm-verdict' is not allowed for deterministic evaluators (use 'threshold' or 'gates')");
    } else if (pp.kind === 'threshold') {
      if (!isFinite(pp.minScore) || pp.minScore < 0 || pp.minScore > 1) errors.push('passPolicy.minScore must be a number in [0, 1] (normalized score)');
    } else if (pp.kind === 'gates') {
      const gates = pp.gates;
      if (!Array.isArray(gates) || gates.length === 0) errors.push('passPolicy.gates must be a non-empty array');
      else {
        gates.forEach((g, i) => {
          const gg = g as Record<string, unknown> | null;
          if (!gg || typeof gg !== 'object') { errors.push(`passPolicy.gates[${i}] must be an object`); return; }
          if (!isNonEmptyString(gg.metric)) errors.push(`passPolicy.gates[${i}].metric must be a non-empty string`);
          else if (!names.has(gg.metric)) errors.push(`passPolicy.gates[${i}].metric '${gg.metric}' does not name a declared metric`);
          if (!isFinite(gg.min)) errors.push(`passPolicy.gates[${i}].min must be a finite number`);
        });
      }
    } else {
      errors.push(`passPolicy.kind must be 'threshold' or 'gates' (got ${JSON.stringify(pp.kind)})`);
    }
  }

  // inputs
  const inputs = d.inputs as Record<string, unknown> | undefined;
  if (!inputs || typeof inputs !== 'object') {
    errors.push('inputs is required ({ gold, prediction })');
  } else {
    const gold = inputs.gold as Record<string, unknown> | undefined;
    if (!gold || typeof gold !== 'object') errors.push('inputs.gold is required');
    else if (gold.source === 'testCase.expected.ids') {
      /* ok */
    } else if (gold.source === 'expectedOutcomes-pattern') {
      if (!isNonEmptyString(gold.pattern)) errors.push('inputs.gold.pattern is required for expectedOutcomes-pattern');
      else {
        try {
          const re = new RegExp(gold.pattern);
          // Require exactly one capture group so the id list is unambiguous.
          const groups = new RegExp(`${re.source}|`).exec('')!.length - 1;
          if (groups !== 1) errors.push(`inputs.gold.pattern must contain exactly one capture group (found ${groups})`);
        } catch (e: any) {
          errors.push(`inputs.gold.pattern is not a valid regular expression: ${e?.message ?? e}`);
        }
      }
    } else {
      errors.push(`inputs.gold.source must be 'testCase.expected.ids' or 'expectedOutcomes-pattern' (got ${JSON.stringify(gold.source)})`);
    }

    const pred = inputs.prediction as Record<string, unknown> | undefined;
    if (!pred || typeof pred !== 'object') errors.push('inputs.prediction is required');
    else if (pred.source !== 'tool-hits-ordered') {
      errors.push(`inputs.prediction.source must be 'tool-hits-ordered' (got ${JSON.stringify(pred.source)})`);
    } else {
      if (pred.idFields !== undefined && !isStringArray(pred.idFields)) errors.push('inputs.prediction.idFields must be an array of non-empty strings');
      if (pred.hitsPaths !== undefined && !isStringArray(pred.hitsPaths)) errors.push('inputs.prediction.hitsPaths must be an array of non-empty strings');
      if (pred.anchorTools !== undefined) {
        if (!Array.isArray(pred.anchorTools)) errors.push('inputs.prediction.anchorTools must be an array');
        else pred.anchorTools.forEach((a, i) => {
          const aa = a as Record<string, unknown> | null;
          if (!aa || typeof aa !== 'object' || !isNonEmptyString(aa.tool) || !isNonEmptyString(aa.argKey)) {
            errors.push(`inputs.prediction.anchorTools[${i}] must be { tool, argKey }`);
          }
        });
      }
    }
  }

  return errors;
}

/** Scale of a metric spec (declared or the 0–1 default). */
export function metricScale(spec: Pick<DeterministicMetricSpec, 'scale'>): { min: number; max: number } {
  const s = spec.scale;
  if (s && isFinite(s.min) && isFinite(s.max) && s.max > s.min) return { min: s.min, max: s.max };
  return { ...DEFAULT_METRIC_SCALE };
}

/**
 * A `scoringConfig` mirror of `metrics[]` so every legacy consumer of
 * `evaluator.scoringConfig.metrics` (list page, run inspector, exports)
 * keeps rendering a deterministic evaluator. `passThreshold` is the
 * threshold policy's `minScore` on the 0–100 scale, or 0 for gates.
 */
export function synthesizeScoringConfig(
  metrics: ReadonlyArray<DeterministicMetricSpec>,
  passPolicy: ScoringPassPolicy | undefined
): ScoringConfig {
  return {
    metrics: metrics.map(m => ({
      name: m.name,
      description: `${m.compute.type}${'k' in m.compute ? `@${m.compute.k}` : ''}`,
      weight: m.weight,
      scale: metricScale(m).max,
    })),
    passThreshold: passPolicy?.kind === 'threshold' ? Math.round(passPolicy.minScore * 100) : 0,
    scale: 100,
  };
}

/**
 * Normalize a validated deterministic evaluator body into the stored shape:
 * `systemPrompt: ''`, synthesized `scoringConfig`, `inferenceConfig: {}`,
 * defaults filled on metrics (`scale`, `primary`). Call ONLY after
 * {@link validateDeterministicEvaluator} returned no errors.
 */
export function normalizeDeterministicEvaluator<T extends Record<string, unknown>>(body: T): T & {
  kind: 'deterministic';
  systemPrompt: string;
  scoringConfig: ScoringConfig;
  inferenceConfig: Record<string, never>;
  metrics: DeterministicMetricSpec[];
  passPolicy: ScoringPassPolicy;
  inputs: DeterministicEvaluatorInputs;
} {
  const metrics = (body.metrics as DeterministicMetricSpec[]).map(m => ({
    name: m.name.trim(),
    compute: validateMetricCompute(m.compute),
    weight: m.weight,
    scale: metricScale(m),
    primary: m.primary === true,
  }));
  const passPolicy = body.passPolicy as ScoringPassPolicy;
  return {
    ...body,
    kind: 'deterministic',
    systemPrompt: '',
    inferenceConfig: {},
    metrics,
    passPolicy,
    inputs: body.inputs as DeterministicEvaluatorInputs,
    scoringConfig: synthesizeScoringConfig(metrics, passPolicy),
  };
}

/** Canonical JSON (sorted keys) of the parts of a deterministic evaluator that affect scoring. */
export function deterministicEvaluatorCanonical(evaluator: DeterministicEvaluatorDoc): string {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === 'object') {
      return Object.keys(v as Record<string, unknown>).sort().reduce<Record<string, unknown>>((acc, k) => {
        const val = (v as Record<string, unknown>)[k];
        if (val !== undefined) acc[k] = canon(val);
        return acc;
      }, {});
    }
    return v;
  };
  return JSON.stringify(canon({ kind: 'deterministic', metrics: evaluator.metrics, passPolicy: evaluator.passPolicy, inputs: evaluator.inputs }));
}
