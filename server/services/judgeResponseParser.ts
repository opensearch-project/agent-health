/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared judge-response parser.
 *
 * Every judge provider (bedrock, openai-compatible, litellm, claude-code, pi,
 * agentic, agent) gets back a JSON blob from the model and needs to coerce it
 * into the {@link JudgeResponse} shape. Before this module existed each
 * service duplicated its own parser and — worse — every spawned-CLI parser
 * (claudeCodeJudgeService, piJudgeService, agenticJudgeService,
 * piAgenticJudgeService) hardcoded the legacy four-metric schema
 * (`accuracy`, `faithfulness`, `latency_score`, `trajectory_alignment_score`).
 * That meant a saved evaluator with a custom `scoringConfig.metrics` set was
 * silently dropped on those providers, and any field the model emitted beyond
 * `pass_fail_status` / `reasoning` / `improvement_strategies` (e.g.
 * `improvement_candidates`, `failure_tags`, `confidence`) vanished into the
 * void.
 *
 * This parser fixes both:
 *
 *   1. Dynamic metric extraction driven by `evaluator.scoringConfig.metrics`
 *      (matches what bedrockService.ts already did for the bedrock provider).
 *   2. Any JSON key the model emits that is NOT a known wire field is captured
 *      into {@link JudgeResponse.extraFields} so callers can surface or persist
 *      them — i.e. iterating on a judge prompt that asks for new fields no
 *      longer requires a code change to see those fields.
 *
 * Also captures {@link JudgeResponse.rawResponse} so the run-detail UI's
 * "Judge debug" surface can show exactly what came back from the model.
 */

import { Evaluator, EvaluationMetrics, ImprovementStrategy } from '@/types';
import type { JudgeResponse } from '@/server/services/bedrockService';
import { debug } from '@/lib/debug';

/**
 * Wire-level fields every judge response is allowed to populate as typed
 * outputs. Anything outside this set is stuffed into `extraFields`. Keep this
 * in sync with the JSON schema each judge system prompt asks the model to
 * emit (see `server/prompts/judgePrompt.ts`).
 *
 * `scores` is included so a rubric-style prompt that emits
 * `"scores": { "tool_correctness": 80, ... }` doesn't double-surface those
 * values — they're already pulled into `metrics` by name in extractMetrics.
 */
const TYPED_RESPONSE_KEYS = new Set([
  'pass_fail_status',
  'reasoning',
  'metrics',
  'scores',
  'improvement_strategies',
  // Legacy: old prompts emit these at the top level instead of under `metrics`.
  'accuracy',
  'faithfulness',
  'latency_score',
  'trajectory_alignment_score',
]);

/**
 * Extract the JSON object from a raw judge response.
 *
 * Handles three observed shapes from the wild:
 *   - markdown ```json fenced blocks
 *   - bare `{...}` JSON
 *   - JSON with leading/trailing prose that some models still emit despite
 *     being told not to
 *
 * Returns `undefined` when no `{...}` substring is present at all.
 */
export function extractJsonFromResponse(raw: string): string | undefined {
  const trimmed = raw.trim();
  const fenceMatch = trimmed.match(/```json\s*([\s\S]*?)\s*```/);
  if (fenceMatch) return fenceMatch[1];
  const startIdx = trimmed.indexOf('{');
  const endIdx = trimmed.lastIndexOf('}');
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    return trimmed.slice(startIdx, endIdx + 1);
  }
  return undefined;
}

/** Coerce a value the model emitted into a finite number, or `undefined`. */
function coerceNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = typeof value === 'number' ? value : parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : undefined;
}

const VALID_STRATEGY_PRIORITIES = new Set(['high', 'medium', 'low']);

/**
 * Coerce whatever the model emitted for `improvement_strategies` into a
 * well-typed `ImprovementStrategy[]`. Non-object, non-string junk is
 * dropped; a legacy bare string (some older prompts/models emit an array of
 * plain strings instead of the structured object) is coerced into a valid
 * entry rather than dropped, so real content the model emitted isn't lost.
 *
 * Every judge provider funnels through this parser, and the run-detail UI
 * (RunDetailsContent's "Improvement Strategies" card, MatcherResultsPanel's
 * enriched row) indexes straight into `strategy.category` /
 * `strategy.priority` (e.g. `strategy.category.replace(...)`,
 * `priorityColors[strategy.priority]`) with no defensive checks — a
 * non-object entry, a missing `category`, or a `priority` outside
 * high/medium/low would throw or silently render `undefined` styling.
 * Rather than trust every judge model to emit a perfectly-shaped array on
 * every call, normalize here once so a malformed entry degrades gracefully
 * (string fields default to '', unknown priority defaults to 'medium')
 * instead of crashing the run-detail page.
 */
function normalizeImprovementStrategies(value: unknown): ImprovementStrategy[] {
  if (!Array.isArray(value)) return [];
  const out: ImprovementStrategy[] = [];
  for (const entry of value) {
    if (typeof entry === 'string' && entry.trim()) {
      // Legacy shape some older prompts/models still emit: a bare string
      // per strategy instead of the structured object. Coerce rather than
      // drop so the model's actual content survives — the string is by far
      // most naturally the `issue` being flagged.
      out.push({ category: 'general', issue: entry, recommendation: '', priority: 'medium' });
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const raw = entry as Record<string, unknown>;
    const priority = typeof raw.priority === 'string' && VALID_STRATEGY_PRIORITIES.has(raw.priority)
      ? (raw.priority as ImprovementStrategy['priority'])
      : 'medium';
    out.push({
      category: typeof raw.category === 'string' ? raw.category : 'general',
      issue: typeof raw.issue === 'string' ? raw.issue : '',
      recommendation: typeof raw.recommendation === 'string' ? raw.recommendation : '',
      priority,
    });
  }
  return out;
}

/**
 * Pull metric values out of the parsed JSON, driven by the evaluator's
 * `scoringConfig.metrics`.
 *
 * For each declared metric we look first at the top level (the new shape)
 * then at the nested `metrics` object (the legacy shape) — same precedence
 * the bedrock service has used since evaluators became pluggable. Missing or
 * non-numeric values are dropped silently (logged via `debug`) so
 * partially-failed responses still surface what the model did emit.
 */
function extractMetrics(parsed: any, evaluator: Evaluator | undefined, source: string): EvaluationMetrics {
  const metrics: EvaluationMetrics = {};

  // Provider-specific dynamic extraction when an evaluator is provided.
  if (evaluator?.scoringConfig?.metrics?.length) {
    for (const def of evaluator.scoringConfig.metrics) {
      // Look for the declared metric in three places, in priority order:
      //   1. top-level `parsed[name]` — the simplest shape we ask for in
      //      the default judge prompt.
      //   2. `parsed.metrics[name]` — the legacy nested shape every
      //      built-in template still uses.
      //   3. `parsed.scores[name]` — a common shape in user-authored
      //      rubric-style prompts (see the AES Oncall evaluator), where
      //      individual dimension scores live under a `scores` object.
      // Without (3) a custom prompt that says `"scores": { "tool_correctness": 80, ... }`
      // would parse into `metrics: {}` even though the values are clearly there.
      const v = coerceNumber(
        parsed?.[def.name] ??
        parsed?.metrics?.[def.name] ??
        parsed?.scores?.[def.name]
      );
      if (v !== undefined) {
        metrics[def.name] = v;
      } else {
        debug(source, `metric '${def.name}' missing or non-numeric in judge response`);
      }
    }
    return metrics;
  }

  // Back-compat: no evaluator (legacy callers / unit tests) → mirror the
  // historical 4-metric extraction every spawned-CLI service used to do.
  const legacy = ['accuracy', 'faithfulness', 'latency_score', 'trajectory_alignment_score'] as const;
  for (const k of legacy) {
    const v = coerceNumber(parsed?.[k] ?? parsed?.metrics?.[k]);
    if (v !== undefined) metrics[k] = v;
  }
  // accuracy is the canonical pass/fail metric on legacy reports, default 0
  // so downstream code that reads metrics.accuracy doesn't NaN.
  if (metrics.accuracy === undefined) metrics.accuracy = 0;
  return metrics;
}

/**
 * Capture every JSON key the model emitted that we did NOT consume into
 * typed fields. This is how prompt-iteration surfaces work without a code
 * change: ask the judge for a new field, see it flow through to the run
 * detail page.
 *
 * `metrics` is partially consumed (named metrics from scoringConfig are
 * pulled out) — any leftover keys inside `metrics` that the evaluator
 * didn't declare are also captured into `extraFields.metrics_unmapped` so
 * nothing the model wrote is silently dropped.
 */
function extractExtraFields(parsed: any, evaluator: Evaluator | undefined): Record<string, unknown> | undefined {
  if (!parsed || typeof parsed !== 'object') return undefined;
  const declaredMetricNames = new Set(
    (evaluator?.scoringConfig?.metrics ?? []).map((m) => m.name)
  );
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (TYPED_RESPONSE_KEYS.has(key)) continue;
    // The evaluator's declared metrics are also "typed outputs" — they
    // were just consumed by extractMetrics into JudgeResponse.metrics, so
    // re-capturing them under extraFields would double-surface them.
    if (declaredMetricNames.has(key)) continue;
    extra[key] = value;
  }
  // Surface unmapped metrics: anything inside `metrics` or `scores` that's
  // neither a legacy key nor declared by the evaluator is "stuff the model
  // invented". Both shapes (nested `metrics`, rubric-style `scores`) get the
  // same treatment.
  const declaredAndLegacy = new Set([
    ...declaredMetricNames,
    'accuracy',
    'faithfulness',
    'latency_score',
    'trajectory_alignment_score',
  ]);
  for (const subKey of ['metrics', 'scores'] as const) {
    const sub = parsed[subKey];
    if (sub && typeof sub === 'object') {
      const unmapped: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(sub)) {
        if (declaredAndLegacy.has(k)) continue;
        unmapped[k] = v;
      }
      if (Object.keys(unmapped).length > 0) {
        // Keyed under e.g. `metrics_unmapped` or `scores_unmapped` so the
        // UI can show which sub-object the model used.
        extra[`${subKey}_unmapped`] = unmapped;
      }
    }
  }
  return Object.keys(extra).length > 0 ? extra : undefined;
}

/**
 * Weighted overall score across the evaluator's declared metrics, on the
 * evaluator's scale. Uses each declared metric's `weight` (default 1 when
 * omitted/invalid). Returns `undefined` unless EVERY declared metric was
 * actually emitted by the judge — renormalizing over a partial set would
 * inflate the headline (a response emitting only its best dimension would
 * score as if the missing ones didn't exist), so a partial/malformed judge
 * response gets no overall rather than a flattering one. Callers must not
 * fabricate a 0 when this is undefined.
 */
export function computeWeightedOverall(
  metrics: EvaluationMetrics,
  evaluator: Evaluator | undefined
): number | undefined {
  const defs = evaluator?.scoringConfig?.metrics;
  if (!defs?.length) return undefined;
  let weighted = 0;
  let totalWeight = 0;
  for (const def of defs) {
    const v = metrics[def.name];
    if (typeof v !== 'number' || !Number.isFinite(v)) return undefined; // all-or-nothing
    const w = typeof def.weight === 'number' && Number.isFinite(def.weight) && def.weight > 0 ? def.weight : 1;
    weighted += v * w;
    totalWeight += w;
  }
  if (totalWeight <= 0) return undefined;
  return Math.round((weighted / totalWeight) * 100) / 100;
}

export interface ParseOptions {
  /** Evaluator whose scoringConfig drives metric extraction. */
  evaluator?: Evaluator;
  /** Wall-clock duration of the judge call, propagated into the response. */
  duration?: number;
  /** Debug source label (e.g. 'PiJudge', 'ClaudeCodeJudge'). */
  source?: string;
}

/**
 * Parse a raw judge text response into a typed {@link JudgeResponse}.
 *
 * Always sets `rawResponse` to the original text so downstream debug surfaces
 * (the run-detail "Judge debug" tab) can show exactly what the model emitted
 * — independent of whether we successfully coerced it into typed fields.
 */
export function parseJudgeResponse(
  raw: string,
  options: ParseOptions = {}
): JudgeResponse {
  const source = options.source ?? 'JudgeParser';
  const jsonText = extractJsonFromResponse(raw);
  if (!jsonText) {
    throw new Error(
      `${source}: judge response did not contain a JSON object. First 200 chars: ${raw.slice(0, 200)}`
    );
  }

  let parsed: any;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err: any) {
    throw new Error(
      `${source}: failed to parse judge JSON (${err.message}). First 200 chars: ${jsonText.slice(0, 200)}`
    );
  }

  const metrics = extractMetrics(parsed, options.evaluator, source);
  const extraFields = extractExtraFields(parsed, options.evaluator);

  const passFailStatus = (parsed.pass_fail_status === 'passed' ? 'passed' : 'failed') as
    | 'passed'
    | 'failed';

  const llmJudgeReasoning =
    typeof parsed.reasoning === 'string'
      ? parsed.reasoning
      : parsed.reasoning != null
        ? JSON.stringify(parsed.reasoning)
        : '';

  const improvementStrategies: ImprovementStrategy[] = normalizeImprovementStrategies(
    parsed.improvement_strategies
  );

  const response: JudgeResponse = {
    passFailStatus,
    metrics,
    llmJudgeReasoning,
    improvementStrategies,
    duration: options.duration ?? 0,
    rawResponse: raw,
  };
  if (extraFields) response.extraFields = extraFields;
  // Headline for custom evaluators: their declared dimensions rarely include
  // the legacy `accuracy` key, which left SDK judge() with nothing to
  // headline (it showed "score 0%" even on passes). Compute the weighted
  // overall from the evaluator's own weights so callers have a real number.
  const overallScore = computeWeightedOverall(metrics, options.evaluator);
  if (overallScore !== undefined) response.overallScore = overallScore;

  debug(source, 'parsed judge response: pass=', passFailStatus, 'metrics=', Object.keys(metrics));
  if (extraFields) debug(source, 'extra fields captured:', Object.keys(extraFields));
  return response;
}
