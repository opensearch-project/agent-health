/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  InvalidTestCaseFixtureError,
  assertValidTestCaseFixture,
  validateTestCaseFixture,
} from '@/lib/testCaseFixture';

const validFixture = {
  type: 'filesystem-workspace',
  ref: 'workspace-v1',
  integrity: 'sha256:abc123',
  payload: { files: ['src/index.ts'] },
};

describe('test-case fixture envelope validation', () => {
  it.each([
    undefined,
    null,
    'not-an-object',
    {},
    { fixture: undefined },
  ])('accepts input without a fixture field: %p', input => {
    expect(validateTestCaseFixture(input)).toEqual({ valid: true, errors: [] });
    expect(() => assertValidTestCaseFixture(input)).not.toThrow();
  });

  it('accepts a complete pinned fixture envelope', () => {
    expect(validateTestCaseFixture({ fixture: validFixture })).toEqual({
      valid: true,
      errors: [],
    });
    expect(() => assertValidTestCaseFixture({ fixture: validFixture })).not.toThrow();
  });

  it('returns field-qualified validation errors and throws the typed error on assertion', () => {
    const input = {
      fixture: {
        type: '',
        ref: 'workspace-v1',
        integrity: 'not pinned',
      },
    };

    const validation = validateTestCaseFixture(input);
    expect(validation.valid).toBe(false);
    expect(validation.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('fixture.type:'),
      expect.stringContaining('fixture.integrity:'),
    ]));

    try {
      assertValidTestCaseFixture(input);
      throw new Error('expected fixture assertion to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidTestCaseFixtureError);
      expect(error).toMatchObject({
        name: 'InvalidTestCaseFixtureError',
        validationErrors: validation.errors,
      });
      expect((error as Error).message).toContain(validation.errors[0]);
    }
  });
});
