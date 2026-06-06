/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { isCodeFile, computeTestCaseHash } from '@/lib/testCases/loader';
import type { CodeTestCase } from '@/lib/testCases/types';

describe('isCodeFile', () => {
  it('returns true for .ts files', () => {
    expect(isCodeFile('evals.eval.ts')).toBe(true);
    expect(isCodeFile('/path/to/tests.ts')).toBe(true);
  });

  it('returns true for .js files', () => {
    expect(isCodeFile('evals.js')).toBe(true);
    expect(isCodeFile('/path/to/tests.eval.js')).toBe(true);
  });

  it('returns true for .mjs files', () => {
    expect(isCodeFile('module.mjs')).toBe(true);
    expect(isCodeFile('/path/to/evals.mjs')).toBe(true);
  });

  it('returns false for .json files', () => {
    expect(isCodeFile('test-cases.json')).toBe(false);
    expect(isCodeFile('/path/to/data.json')).toBe(false);
  });

  it('returns false for other extensions', () => {
    expect(isCodeFile('readme.md')).toBe(false);
    expect(isCodeFile('data.csv')).toBe(false);
    expect(isCodeFile('config.yaml')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isCodeFile('evals.TS')).toBe(true);
    expect(isCodeFile('evals.Js')).toBe(true);
    expect(isCodeFile('evals.MJS')).toBe(true);
  });
});

describe('computeTestCaseHash', () => {
  const baseTc: CodeTestCase = {
    name: 'Test',
    options: {
      prompt: 'Analyze this',
      labels: ['category:RCA', 'difficulty:Medium'],
    },
    evaluate: () => {},
  };

  it('returns a SHA-256 hex string', () => {
    const hash = computeTestCaseHash(baseTc);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('produces same hash for same content', () => {
    const hash1 = computeTestCaseHash(baseTc);
    const hash2 = computeTestCaseHash({ ...baseTc });
    expect(hash1).toBe(hash2);
  });

  it('produces different hash when prompt changes', () => {
    const modified = { ...baseTc, options: { ...baseTc.options, prompt: 'Different prompt' } };
    expect(computeTestCaseHash(baseTc)).not.toBe(computeTestCaseHash(modified));
  });

  it('produces different hash when labels change', () => {
    const modified = { ...baseTc, options: { ...baseTc.options, labels: ['category:Security', 'difficulty:Medium'] } };
    expect(computeTestCaseHash(baseTc)).not.toBe(computeTestCaseHash(modified));
  });

  it('produces different hash when name changes', () => {
    const modified = { ...baseTc, name: 'Different Name' };
    expect(computeTestCaseHash(baseTc)).not.toBe(computeTestCaseHash(modified));
  });

  it('does not change when evaluate function changes', () => {
    const modified = { ...baseTc, evaluate: async () => { throw new Error('fail'); } };
    expect(computeTestCaseHash(baseTc)).toBe(computeTestCaseHash(modified));
  });

  it('changes when optional fields are added', () => {
    const withLabels = { ...baseTc, options: { ...baseTc.options, labels: ['security'] } };
    expect(computeTestCaseHash(baseTc)).not.toBe(computeTestCaseHash(withLabels));
  });

  // Regression for issue #245: editing expectedOutcomes / expectedTrajectory
  // on an existing eval file must invalidate the hash so the upsert path
  // picks up the change and re-persists. Without this, users would set
  // these fields and the test case would silently keep its old version.
  it('changes when expectedOutcomes is added', () => {
    const modified = { ...baseTc, options: { ...baseTc.options, expectedOutcomes: ['outcome A'] } };
    expect(computeTestCaseHash(baseTc)).not.toBe(computeTestCaseHash(modified));
  });

  it('changes when expectedTrajectory is added', () => {
    const modified = {
      ...baseTc,
      options: {
        ...baseTc.options,
        expectedTrajectory: [{ step: 1, description: 'search', requiredTools: ['search_logs'] }],
      },
    };
    expect(computeTestCaseHash(baseTc)).not.toBe(computeTestCaseHash(modified));
  });
});
