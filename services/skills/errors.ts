/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Typed error classes for the skill evaluator.
 *
 * Skills authoring principle: structured metadata over stringly-typed flags.
 * The runner needs to distinguish three outcomes for every eval case:
 *
 *   1. passed   — agent ran, all assertions hold
 *   2. failed   — agent ran, at least one assertion missed (the skill is
 *                 the suspect; this is what the improver should learn from)
 *   3. errored  — agent itself crashed / endpoint unreachable / timeout
 *                 (skill quality is unknowable until the agent is fixed)
 *
 * Throwing `SkillExecutionError` lets the runner mark an eval as `errored`
 * deterministically instead of stuffing the error string into a fake
 * trajectory step and letting the assertion grader (incorrectly) blame
 * the skill for an unrelated failure.
 */

export class SkillExecutionError extends Error {
  readonly evalStatus = 'errored' as const;
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'SkillExecutionError';
    this.cause = cause;
  }
}

/**
 * Type guard — preferred over `(err as any).evalStatus === 'errored'`.
 */
export function isSkillExecutionError(err: unknown): err is SkillExecutionError {
  return err instanceof SkillExecutionError;
}
