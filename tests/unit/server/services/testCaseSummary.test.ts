/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit coverage for the shared test-case summary projection
 * (server/services/testCaseSummary.ts) — the contract both storage adapters
 * and the `?fields=summary` route lean on (issue #591).
 */

import {
  SUMMARY_PROMPT_MAX_CHARS,
  TEST_CASE_SUMMARY_EXCLUDED_FIELDS,
  stripTestCaseSummaryFields,
  toTestCaseSummary,
} from '@/server/services/testCaseSummary';

const fullDoc = () => ({
  id: 'tc-1',
  name: 'A case',
  description: 'desc',
  labels: ['category:RCA'],
  version: 3,
  currentVersion: 3,
  createdAt: '2025-01-01T00:00:00Z',
  updatedAt: '2025-01-02T00:00:00Z',
  initialPrompt: 'p'.repeat(SUMMARY_PROMPT_MAX_CHARS + 50),
  context: [{ description: 'runbook', value: 'x'.repeat(10_000) }],
  expectedOutcomes: ['finds the root cause'],
  versions: [{ version: 1 }, { version: 2 }, { version: 3 }],
  sourceCode: 'x'.repeat(400_000),
  sourceFile: 'evals/a.eval.ts',
  sourceFileName: 'a.eval.ts',
  sourceHash: 'abc',
  sourceLanguage: 'typescript',
  definition: { options: {}, evaluateSource: 'async () => {}' },
  describePath: ['Suite'],
});

describe('TEST_CASE_SUMMARY_EXCLUDED_FIELDS', () => {
  it('names exactly the heavy fields a list view never renders', () => {
    expect([...TEST_CASE_SUMMARY_EXCLUDED_FIELDS].sort()).toEqual(
      ['context', 'definition', 'expectedOutcomes', 'sourceCode', 'versions'].sort(),
    );
  });

  it('never excludes the fields the adapters need to pick the latest version per id', () => {
    for (const keep of ['id', 'version', 'currentVersion', 'createdAt', 'updatedAt']) {
      expect(TEST_CASE_SUMMARY_EXCLUDED_FIELDS).not.toContain(keep);
    }
  });

  it('is frozen so an adapter cannot mutate the shared contract', () => {
    expect(Object.isFrozen(TEST_CASE_SUMMARY_EXCLUDED_FIELDS)).toBe(true);
  });
});

describe('stripTestCaseSummaryFields', () => {
  it('removes every excluded field and nothing else', () => {
    const doc = fullDoc();
    const out = stripTestCaseSummaryFields(doc);

    for (const field of TEST_CASE_SUMMARY_EXCLUDED_FIELDS) {
      expect(out).not.toHaveProperty(field);
    }
    // Provenance + identity + prompt survive (prompt truncation is the
    // route's job, not the storage layer's).
    expect(out).toMatchObject({
      id: 'tc-1',
      name: 'A case',
      version: 3,
      currentVersion: 3,
      sourceFile: 'evals/a.eval.ts',
      sourceFileName: 'a.eval.ts',
      sourceHash: 'abc',
      sourceLanguage: 'typescript',
      describePath: ['Suite'],
      initialPrompt: doc.initialPrompt,
    });
  });

  it('does not mutate its input', () => {
    const doc = fullDoc();
    stripTestCaseSummaryFields(doc);
    expect(doc.sourceCode).toHaveLength(400_000);
    expect(doc.versions).toHaveLength(3);
  });

  it('is a no-op on a document that already lacks the heavy fields', () => {
    const lean = { id: 'tc-2', name: 'lean', version: 1 };
    expect(stripTestCaseSummaryFields(lean)).toEqual(lean);
  });
});

describe('toTestCaseSummary', () => {
  it('pins the response shape: empty collections, no sourceCode/definition, truncated prompt', () => {
    const out = toTestCaseSummary(fullDoc());

    expect(out.context).toEqual([]);
    expect(out.expectedOutcomes).toEqual([]);
    expect(out.versions).toEqual([]);
    expect(out.sourceCode).toBeUndefined();
    expect(out.definition).toBeUndefined();
    expect(out.initialPrompt).toHaveLength(SUMMARY_PROMPT_MAX_CHARS + 3);
    expect(out.initialPrompt.endsWith('...')).toBe(true);
    // Provenance survives so list views can show "code-imported" badges.
    expect(out.sourceFile).toBe('evals/a.eval.ts');
    expect(out.sourceFileName).toBe('a.eval.ts');
    expect(out.sourceLanguage).toBe('typescript');
  });

  it('leaves a prompt at or under the limit untouched', () => {
    const exact = 'q'.repeat(SUMMARY_PROMPT_MAX_CHARS);
    expect(toTestCaseSummary({ id: 'x', initialPrompt: exact }).initialPrompt).toBe(exact);
    expect(toTestCaseSummary({ id: 'x', initialPrompt: 'short' }).initialPrompt).toBe('short');
  });

  it('tolerates a missing prompt (deterministic-only code SDK cases)', () => {
    expect(toTestCaseSummary({ id: 'x' }).initialPrompt).toBeUndefined();
  });

  it('produces the same shape whether the adapter already projected the document or not', () => {
    const full = fullDoc();
    const fromFull = toTestCaseSummary(full);
    const fromProjected = toTestCaseSummary(stripTestCaseSummaryFields(full));
    expect(fromProjected).toEqual(fromFull);
  });
});
