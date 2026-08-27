/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { isEvaluationRunActiveInThisProcess } from '@/server/routes/storage/evaluationRuns';

describe('evaluation run active registry', () => {
  it('reports an unknown persisted run as inactive after process startup', () => {
    expect(isEvaluationRunActiveInThisProcess('persisted-before-restart')).toBe(false);
  });
});
