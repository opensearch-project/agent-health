/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The deterministic-evaluator fields that belong on each immutable
 * `versions[]` entry alongside `systemPrompt` / `scoringConfig` /
 * `inferenceConfig`. Shared by the file and OpenSearch storage adapters so
 * both persist the same version shape. Returns `{}` for LLM evaluators.
 */

import type { Evaluator, EvaluatorVersion } from '../../types/index.js';

export function deterministicVersionFields(
  evaluator: Partial<Pick<Evaluator, 'kind' | 'metrics' | 'passPolicy' | 'inputs'>>
): Pick<EvaluatorVersion, 'kind' | 'metrics' | 'passPolicy' | 'inputs'> | Record<string, never> {
  if (evaluator.kind !== 'deterministic') return {};
  return {
    kind: 'deterministic',
    metrics: evaluator.metrics,
    passPolicy: evaluator.passPolicy,
    inputs: evaluator.inputs,
  };
}
