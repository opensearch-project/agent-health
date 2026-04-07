/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pricing engine for coding agent models.
 * Covers Claude, Kiro (Bedrock), and Codex (OpenAI) models.
 */

export interface ModelPricing {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export const PRICING: Record<string, ModelPricing> = {
  // Claude models
  'claude-opus-4-6': {
    input: 15.00 / 1_000_000,
    output: 75.00 / 1_000_000,
    cacheWrite: 18.75 / 1_000_000,
    cacheRead: 1.50 / 1_000_000,
  },
  'claude-opus-4-5-20251101': {
    input: 15.00 / 1_000_000,
    output: 75.00 / 1_000_000,
    cacheWrite: 18.75 / 1_000_000,
    cacheRead: 1.50 / 1_000_000,
  },
  'claude-sonnet-4-6': {
    input: 3.00 / 1_000_000,
    output: 15.00 / 1_000_000,
    cacheWrite: 3.75 / 1_000_000,
    cacheRead: 0.30 / 1_000_000,
  },
  'claude-haiku-4-5': {
    input: 0.80 / 1_000_000,
    output: 4.00 / 1_000_000,
    cacheWrite: 1.00 / 1_000_000,
    cacheRead: 0.08 / 1_000_000,
  },
  // Kiro models (Bedrock pricing - Claude under the hood)
  'us.anthropic.claude-sonnet-4-6-v1': {
    input: 3.00 / 1_000_000,
    output: 15.00 / 1_000_000,
    cacheWrite: 3.75 / 1_000_000,
    cacheRead: 0.30 / 1_000_000,
  },
  // OpenAI models (Codex uses these)
  'o3': {
    input: 2.00 / 1_000_000,
    output: 8.00 / 1_000_000,
    cacheWrite: 0,
    cacheRead: 0,
  },
  'o4-mini': {
    input: 1.10 / 1_000_000,
    output: 4.40 / 1_000_000,
    cacheWrite: 0,
    cacheRead: 0,
  },
  'gpt-4.1': {
    input: 2.00 / 1_000_000,
    output: 8.00 / 1_000_000,
    cacheWrite: 0,
    cacheRead: 0,
  },
};

export function getPricing(model: string): ModelPricing {
  if (PRICING[model]) return PRICING[model];
  // fuzzy match on prefix
  for (const key of Object.keys(PRICING)) {
    if (model.startsWith(key) || key.startsWith(model.split('-').slice(0, 3).join('-'))) {
      return PRICING[key];
    }
  }
  // Default to a mid-range estimate
  return PRICING['claude-sonnet-4-6'];
}

export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheWriteTokens = 0,
  cacheReadTokens = 0,
): number {
  const p = getPricing(model);
  return (
    inputTokens * p.input +
    outputTokens * p.output +
    cacheWriteTokens * p.cacheWrite +
    cacheReadTokens * p.cacheRead
  );
}

export function estimateCacheSavings(model: string, cacheReadTokens: number): number {
  const p = getPricing(model);
  return cacheReadTokens * (p.input - p.cacheRead);
}
