/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ValidatedTestCaseInput } from '@/lib/testCaseValidation.js';
import type { TestSuiteInput } from './types.js';
import { testCase } from './testCase.js';

/**
 * Define a suite of test cases with shared defaults.
 *
 * Applies default values (category, difficulty, context, etc.) to all cases in the suite.
 * Individual cases can override any default by specifying their own value.
 *
 * @param suite - Suite configuration with defaults and case definitions
 * @returns Array of validated test case inputs
 *
 * @example
 * ```typescript
 * // kubernetes.eval.ts
 * import { defineTestSuite } from '@opensearch-project/agent-health';
 *
 * export default defineTestSuite({
 *   defaults: { category: 'Kubernetes', difficulty: 'Hard' },
 *   cases: [
 *     { name: 'Pod crash loop', prompt: 'Pod is CrashLoopBackOff', expect: ['Check OOM'] },
 *     { name: 'Node not ready', prompt: 'Node is NotReady', expect: ['Check kubelet'] },
 *   ],
 * });
 * ```
 */
export function defineTestSuite(suite: TestSuiteInput): ValidatedTestCaseInput[] {
  const { defaults = {} } = suite;

  return suite.cases.map((c) =>
    testCase(c.name, {
      prompt: c.prompt,
      category: c.category ?? defaults.category ?? 'General',
      difficulty: c.difficulty ?? defaults.difficulty ?? 'Medium',
      subcategory: c.subcategory ?? defaults.subcategory,
      context: c.context ?? defaults.context,
      description: c.description,
      expect: c.expect,
    })
  );
}
