/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ValidatedTestCaseInput } from '@/lib/testCaseValidation.js';

/**
 * Define an array of test cases with full type safety.
 *
 * This is an identity function that provides TypeScript type checking
 * on the default export of `.eval.ts` files. It mirrors the `defineConfig()`
 * pattern used for `agent-health.config.ts`.
 *
 * @param cases - Array of test case inputs (typically produced by `testCase()`)
 * @returns The same array, type-checked
 *
 * @example
 * ```typescript
 * // my-evals.eval.ts
 * import { defineTestCases, testCase } from '@opensearch-project/agent-health';
 *
 * export default defineTestCases([
 *   testCase('Test A', { prompt: '...', category: 'RCA', difficulty: 'Easy', expect: ['...'] }),
 *   testCase('Test B', { prompt: '...', category: 'RCA', difficulty: 'Hard', expect: ['...'] }),
 * ]);
 * ```
 */
export function defineTestCases(cases: ValidatedTestCaseInput[]): ValidatedTestCaseInput[] {
  return cases;
}
