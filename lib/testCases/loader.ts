/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Dynamic module loader for .eval.ts/.js/.mjs test case files.
 *
 * Uses the same import() pattern as config loading (lib/config/loader.ts).
 * Validates loaded modules against the shared Zod schema.
 */

import { pathToFileURL } from 'url';
import { resolve } from 'path';
import { testCasesArraySchema, type ValidatedTestCaseInput } from '@/lib/testCaseValidation.js';

/**
 * Load test cases from a TypeScript/JavaScript module file.
 *
 * The module must export (default or named) an array of `ValidatedTestCaseInput` objects,
 * typically produced by `defineTestCases()` or `defineTestSuite()`.
 *
 * @param filePath - Path to the .ts/.js/.mjs file (relative or absolute)
 * @returns Validated array of test case inputs
 * @throws If the file cannot be imported or validation fails
 *
 * @example
 * ```typescript
 * const testCases = await loadTestCasesFromModule('./evals/kubernetes.eval.ts');
 * ```
 */
export async function loadTestCasesFromModule(filePath: string): Promise<ValidatedTestCaseInput[]> {
  const absolutePath = resolve(filePath);
  const fileUrl = pathToFileURL(absolutePath).href;

  let module: any;
  try {
    module = await import(fileUrl);
  } catch (err: any) {
    throw new Error(
      `Failed to import test case module: ${filePath}\n${err.message}`
    );
  }

  // Support both default export and named 'testCases' export
  const exported = module.default ?? module.testCases ?? module;

  // Must be an array
  if (!Array.isArray(exported)) {
    throw new Error(
      `Test case module must export an array. Got ${typeof exported} from: ${filePath}`
    );
  }

  // Validate against same Zod schema used by JSON imports
  const result = testCasesArraySchema.safeParse(exported);
  if (!result.success) {
    const errors = result.error.errors
      .map((e) => `  [${e.path.join('.')}] ${e.message}`)
      .join('\n');
    throw new Error(
      `Test case validation failed for: ${filePath}\n${errors}`
    );
  }

  return result.data as ValidatedTestCaseInput[];
}
