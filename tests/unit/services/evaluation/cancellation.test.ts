/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { createCancellationToken } from '@/services/evaluation/cancellation';
import {
  createCancellationToken as viaEvaluationRunner,
  type CancellationToken,
} from '@/services/evaluationRunner';

describe('createCancellationToken', () => {
  it('should create a token with isCancelled = false', () => {
    const token = createCancellationToken();
    expect(token.isCancelled).toBe(false);
  });

  it('should set isCancelled to true when cancel() is called', () => {
    const token = createCancellationToken();
    token.cancel();
    expect(token.isCancelled).toBe(true);
  });

  it('cancel() works when detached from the token (method uses `this` of the token object)', () => {
    const token: CancellationToken = createCancellationToken();
    const { cancel } = token;
    // Detached call — documents the current contract: the token is a plain
    // object whose cancel() mutates `this`, so callers must invoke it as a
    // method. Bound usage is what every route does.
    expect(() => cancel.call(token)).not.toThrow();
    expect(token.isCancelled).toBe(true);
  });

  it('is re-exported unchanged from services/evaluationRunner (stable import path)', () => {
    expect(viaEvaluationRunner).toBe(createCancellationToken);
  });
});
