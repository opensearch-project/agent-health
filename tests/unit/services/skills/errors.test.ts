/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { SkillExecutionError, isSkillExecutionError } from '@/services/skills/errors';

describe('SkillExecutionError', () => {
  it('carries the evalStatus tag for in-band routing', () => {
    const err = new SkillExecutionError('agent timed out');
    expect(err.evalStatus).toBe('errored');
    expect(err.message).toBe('agent timed out');
    expect(err.name).toBe('SkillExecutionError');
  });

  it('preserves an underlying cause when provided', () => {
    const root = new Error('socket hang up');
    const err = new SkillExecutionError('agent endpoint unreachable', root);
    expect(err.cause).toBe(root);
  });

  it('isSkillExecutionError type guard discriminates correctly', () => {
    expect(isSkillExecutionError(new SkillExecutionError('x'))).toBe(true);
    expect(isSkillExecutionError(new Error('x'))).toBe(false);
    expect(isSkillExecutionError('x')).toBe(false);
    expect(isSkillExecutionError(null)).toBe(false);
    expect(isSkillExecutionError(undefined)).toBe(false);
  });
});
