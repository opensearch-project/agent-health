/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';

/**
 * A fixture integrity pin is deliberately algorithm-agnostic. The product
 * validates the stable `algorithm:digest` envelope while connectors decide
 * which algorithms and payload shapes they support.
 */
export const FIXTURE_INTEGRITY_PATTERN = /^[a-z0-9-]+:[A-Za-z0-9+/=_-]+$/;

export const testCaseFixtureSchema = z.object({
  type: z
    .string({ required_error: 'Fixture type is required' })
    .trim()
    .min(1, 'Fixture type must be a non-empty string'),
  ref: z
    .string({ required_error: 'Fixture ref is required' })
    .trim()
    .min(1, 'Fixture ref must be a non-empty string'),
  integrity: z
    .string({ required_error: 'Fixture integrity is required' })
    .regex(
      FIXTURE_INTEGRITY_PATTERN,
      'Fixture integrity must use algorithm:digest format (for example, sha256:abc123)',
    ),
  payload: z.record(z.unknown()).optional(),
});

export interface FixtureValidationResult {
  valid: boolean;
  errors: string[];
}

export class InvalidTestCaseFixtureError extends Error {
  constructor(readonly validationErrors: string[]) {
    super(`Invalid test-case fixture: ${validationErrors.join('; ')}`);
    this.name = 'InvalidTestCaseFixtureError';
  }
}

/** Validate only the optional fixture field on an import/create/update body. */
export function validateTestCaseFixture(input: unknown): FixtureValidationResult {
  if (!input || typeof input !== 'object' || !Object.prototype.hasOwnProperty.call(input, 'fixture')) {
    return { valid: true, errors: [] };
  }

  const fixture = (input as { fixture?: unknown }).fixture;
  if (fixture === undefined) {
    return { valid: true, errors: [] };
  }

  const result = testCaseFixtureSchema.safeParse(fixture);
  if (result.success) {
    return { valid: true, errors: [] };
  }

  return {
    valid: false,
    errors: result.error.errors.map((error) => {
      const suffix = error.path.length > 0 ? `.${error.path.join('.')}` : '';
      return `fixture${suffix}: ${error.message}`;
    }),
  };
}

export function assertValidTestCaseFixture(input: unknown): void {
  const result = validateTestCaseFixture(input);
  if (!result.valid) {
    throw new InvalidTestCaseFixtureError(result.errors);
  }
}
