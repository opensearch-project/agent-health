/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DeclarativeExpectedOutcome, ExpectedOutcome } from '@/types';

export type SupportedDeclarativeCheck = 'workspace-diff';

export interface NormalizedExpectedOutcome {
  outcome: string;
  role: 'gate' | 'observe';
  check?: SupportedDeclarativeCheck;
}

/** Return the author-visible claim text without discarding object metadata. */
export function expectedOutcomeText(value: ExpectedOutcome): string {
  return typeof value === 'string' ? value : value.outcome;
}

/**
 * Normalize the backwards-compatible JSON authoring forms into matcher specs.
 * Import validation rejects unsupported checks; this function remains strict
 * for callers that construct TestCase objects without going through import.
 */
export function normalizeExpectedOutcomes(
  values: readonly ExpectedOutcome[] | undefined,
): NormalizedExpectedOutcome[] {
  return (values ?? [])
    .map((value): NormalizedExpectedOutcome => {
      if (typeof value === 'string') {
        return { outcome: value, role: 'gate' };
      }
      if (value.check === 'traces') {
        throw new Error(
          `Expected outcome "${value.outcome}" uses check "traces", which is reserved but not supported yet`,
        );
      }
      return {
        outcome: value.outcome,
        role: value.role ?? 'gate',
        ...(value.check ? { check: value.check } : {}),
      };
    })
    // Preserve the existing authoring behaviour: empty strings may be stored,
    // but they are not claims sent to a judge.
    .filter((value) => value.outcome.trim().length > 0)
    .map((value) => ({ ...value, outcome: value.outcome.trim() }));
}

/** Claims that belong in an LLM judge request (deterministic checks excluded). */
export function judgedExpectedOutcomeTexts(
  values: readonly ExpectedOutcome[] | undefined,
): string[] {
  // Older persisted reports/tests may still carry the pre-flat shape
  // `{ rootCauses, requiredFacts, conclusions }`. Keep that read-only legacy
  // path here; new imports are validated as arrays.
  if (values && !Array.isArray(values) && typeof values === 'object') {
    return Object.values(values as unknown as Record<string, unknown>)
      .flatMap((value) => Array.isArray(value) ? value : [])
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map((value) => value.trim());
  }
  return normalizeExpectedOutcomes(values)
    .filter((value) => value.check === undefined)
    .map((value) => value.outcome);
}

/** Type guard used by import/editor surfaces. */
export function isDeclarativeExpectedOutcome(value: ExpectedOutcome): value is DeclarativeExpectedOutcome {
  return typeof value !== 'string';
}
