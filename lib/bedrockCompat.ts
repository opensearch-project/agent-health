/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Bedrock model compatibility helpers shared by every Bedrock Converse call
 * site (judge, skill eval generator, skill improver, failure clustering,
 * assistant fallback).
 *
 * Two concerns live here so the policy is defined exactly once:
 *
 * 1. **Temperature deprecation** — newer Anthropic models (Claude Opus 4.5+,
 *    Sonnet 4.6+, and the Claude 5 family incl. Fable/Mythos) reject an
 *    explicit `temperature` with `ValidationException: 'temperature' is
 *    deprecated for this model`. `buildInferenceConfig()` omits the field for
 *    those models and lets the model use its default. (GitHub issue #299)
 *
 * 2. **Region-aware inference profiles** — the default model registry pins
 *    `us.`-prefixed cross-region inference profile ids, which only resolve
 *    from US regions. `resolveRegionAwareModelId()` swaps the prefix to the
 *    one matching the active AWS region (`eu.` / `apac.`) at call time, so
 *    the registry itself stays region-neutral. (GitHub issue #298)
 */

/**
 * Model-id patterns that have deprecated the `temperature` parameter.
 * Matched case-insensitively against the full model/inference-profile id.
 */
const TEMPERATURE_DEPRECATED_PATTERNS: RegExp[] = [
  /claude-opus-4-[5-9]/, // Opus 4.5, 4.6, 4.7, 4.8, ...
  /claude-sonnet-4-[6-9]/, // Sonnet 4.6+ (4.5 still accepts temperature)
  /claude-[a-z]+-5(?![0-9])/, // Claude 5 family: fable-5, mythos-5, opus-5, sonnet-5, ...
];

/** Whether the given Bedrock model still accepts an explicit `temperature`. */
export function modelSupportsTemperature(modelId: string): boolean {
  const id = (modelId || '').toLowerCase();
  return !TEMPERATURE_DEPRECATED_PATTERNS.some((p) => p.test(id));
}

/**
 * Build a Converse `inferenceConfig`, including `temperature` only when the
 * target model accepts it. Callers pass their preferred temperature; for
 * models that have deprecated the parameter it is silently omitted (the
 * model's own default applies).
 */
export function buildInferenceConfig(
  modelId: string,
  opts: { maxTokens: number; temperature?: number },
): { maxTokens: number; temperature?: number } {
  const cfg: { maxTokens: number; temperature?: number } = { maxTokens: opts.maxTokens };
  if (opts.temperature !== undefined && modelSupportsTemperature(modelId)) {
    cfg.temperature = opts.temperature;
  }
  return cfg;
}

/** Inference-profile prefix appropriate for the given (or current) AWS region. */
export function regionInferencePrefix(region?: string): string {
  const r = (
    region ||
    process.env.AWS_REGION ||
    process.env.AWS_DEFAULT_REGION ||
    'us-east-1'
  ).toLowerCase();
  if (r.startsWith('eu-')) return 'eu.';
  if (r.startsWith('ap-')) return 'apac.';
  return 'us.';
}

const CROSS_REGION_PREFIXES = ['us.', 'eu.', 'apac.'] as const;

/**
 * Re-home a cross-region inference-profile id to the active AWS region.
 *
 * `us.anthropic.claude-...` → `eu.anthropic.claude-...` when running in an
 * EU region, etc. Ids that carry no regional prefix (bare model ids,
 * `global.` profiles, non-Bedrock ids like `mock://` or `gpt-4o`) are
 * returned unchanged.
 */
export function resolveRegionAwareModelId(modelId: string, region?: string): string {
  if (!modelId) return modelId;
  const target = regionInferencePrefix(region);
  for (const prefix of CROSS_REGION_PREFIXES) {
    if (modelId.startsWith(prefix)) {
      return prefix === target ? modelId : target + modelId.slice(prefix.length);
    }
  }
  return modelId;
}
