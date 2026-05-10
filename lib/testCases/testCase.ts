/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ValidatedTestCaseInput } from '@/lib/testCaseValidation.js';
import type { TestCaseInput } from './types.js';

/**
 * Define a single test case with type-safe field mapping.
 *
 * Maps developer-friendly SDK fields to the internal `ValidatedTestCaseInput` type
 * used by the benchmark pipeline, validation layer, and storage system.
 *
 * @param name - Unique name for the test case (used for idempotent upsert on re-run)
 * @param input - Test case definition with prompt, expectations, and metadata
 * @returns A validated test case input compatible with the Agent Health pipeline
 *
 * @example
 * ```typescript
 * import { testCase } from '@opensearch-project/agent-health';
 *
 * testCase('High CPU Investigation', {
 *   prompt: 'Investigate high CPU on web-server-01',
 *   category: 'RCA',
 *   difficulty: 'Medium',
 *   context: [{ description: 'Metrics', value: 'CPU at 95%' }],
 *   expect: ['Identify root cause process', 'Suggest remediation'],
 * })
 * ```
 */
export function testCase(name: string, input: TestCaseInput): ValidatedTestCaseInput {
  return {
    name,
    description: input.description ?? '',
    category: input.category,
    subcategory: input.subcategory,
    difficulty: input.difficulty,
    initialPrompt: input.prompt,
    context: input.context ?? [],
    expectedOutcomes: input.expect,
  };
}
