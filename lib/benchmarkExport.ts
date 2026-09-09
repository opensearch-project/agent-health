/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TestCase } from '@/types';
import type { ValidatedTestCaseInput } from '@/lib/testCaseValidation';

/**
 * Convert full TestCase objects to the import-compatible export format.
 * The output matches the `testCaseSchema` shape from `lib/testCaseValidation.ts`,
 * ensuring exported JSON can be re-imported via "Import JSON".
 */
export function convertTestCasesToExportFormat(testCases: TestCase[]): ValidatedTestCaseInput[] {
  return testCases.map((tc) => {
    const exported: ValidatedTestCaseInput = {
      name: tc.name,
      description: tc.description || '',
      category: tc.category,
      difficulty: tc.difficulty,
      initialPrompt: tc.initialPrompt,
      context: tc.context || [],
      expectedOutcomes: tc.expectedOutcomes || [],
    };

    if (tc.subcategory) {
      exported.subcategory = tc.subcategory;
    }
    if (tc.fixture) {
      exported.fixture = tc.fixture;
    }

    return exported;
  });
}

/**
 * Generate a safe filename from a benchmark name.
 * Sanitizes the name by replacing unsafe characters and appends `.json`.
 */
export function generateExportFilename(benchmarkName: string): string {
  const sanitized = (benchmarkName || 'benchmark-export')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_\-\s]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return `${sanitized || 'benchmark-export'}.json`;
}
