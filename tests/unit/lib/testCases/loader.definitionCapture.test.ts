/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the per-test `definition` capture on the loader
 * (run-report "Test Case Definition" feature for code-SDK tests):
 *   - each registered test gets its OWN `definition.options` (the resolved
 *     `test()` options, JSON-serializable only) and `definition.bodySource`
 *     (the evaluate callback text) — not the file's, not a sibling's.
 *   - the two-arg `test(name, body)` form yields `options: {}`.
 *   - `bodySource` is bounded and flagged when truncated.
 *   - `computeTestCaseHash` does NOT depend on `definition`: a re-import of
 *     an unchanged file after this field shipped must classify as
 *     `unchanged`, never version-bump every test in the suite.
 */

import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  loadTestCasesFromModule,
  computeTestCaseHash,
  captureTestDefinition,
  DEFINITION_BODY_SOURCE_MAX_CHARS,
} from '@/lib/testCases/loader';
import { clearRegistry } from '@/lib/testCases/define';
import type { CodeTestCase } from '@/lib/testCases/types';

let tmp: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ah-loader-definition-'));
});

beforeEach(() => clearRegistry());

function write(name: string, content: string): string {
  const p = join(tmp, name);
  writeFileSync(p, content, 'utf8');
  return p;
}

const THREE_TEST_FILE = `
  const { test } = require('@opensearch-project/agent-health');
  const CASES = [
    { name: 'alpha', prompt: 'Prompt for alpha', outcomes: ['alpha passes'] },
    { name: 'beta',  prompt: 'Prompt for beta',  outcomes: ['beta passes'] },
  ];
  for (const c of CASES) {
    test(c.name, {
      prompt: c.prompt,
      expectedOutcomes: c.outcomes,
      labels: ['category:Synthetic', 'difficulty:Easy'],
      timeout: 12345,
      description: 'generated from a table',
    }, async ({ result }) => {
      if (!result) throw new Error('no result for ' + c.name);
    });
  }
  test('gamma', ({ result }) => { /* gamma body marker */ return result; });
`;

describe('loadTestCasesFromModule — per-test definition capture', () => {
  it('captures each test\'s OWN resolved options, even when registered from a loop', async () => {
    const filePath = write('three.eval.js', THREE_TEST_FILE);
    const { testCases } = await loadTestCasesFromModule(filePath);
    expect(testCases.map(t => t.name)).toEqual(['alpha', 'beta', 'gamma']);

    const alpha = testCases[0].definition;
    const beta = testCases[1].definition;
    expect(alpha.registeredAs).toBe('sdk');
    expect(alpha.options).toEqual({
      prompt: 'Prompt for alpha',
      expectedOutcomes: ['alpha passes'],
      labels: ['category:Synthetic', 'difficulty:Easy'],
      timeout: 12345,
      description: 'generated from a table',
    });
    expect(beta.options.prompt).toBe('Prompt for beta');
    expect(beta.options.expectedOutcomes).toEqual(['beta passes']);
    // Not the sibling's data.
    expect(JSON.stringify(alpha.options)).not.toContain('beta');
  });

  it('captures the evaluate callback text as bodySource (not the whole file)', async () => {
    const filePath = write('three-body.eval.js', THREE_TEST_FILE);
    const { testCases, fileSource } = await loadTestCasesFromModule(filePath);
    const gamma = testCases[2].definition;
    expect(gamma.bodySource).toContain('gamma body marker');
    expect(gamma.bodySource).not.toContain('Prompt for alpha');
    expect(gamma.bodySource.length).toBeLessThan(fileSource.length);
    // Loop-registered tests share one callback source text — expected: the
    // per-test difference lives in `options`, the body is the same closure.
    expect(testCases[0].definition.bodySource).toContain("no result for ' + c.name");
    expect(testCases[0].definition.bodySource).toBe(testCases[1].definition.bodySource);
  });

  it('two-arg form yields empty options and still captures the body', async () => {
    const filePath = write('two-arg.eval.js', THREE_TEST_FILE);
    const { testCases } = await loadTestCasesFromModule(filePath);
    const gamma = testCases[2].definition;
    expect(gamma.options).toEqual({});
    expect(gamma.bodySource).toMatch(/^\(\{ result \}\) =>/);
    expect(gamma.bodyTruncated).toBeUndefined();
  });
});

describe('captureTestDefinition — edge cases', () => {
  const mk = (over: Partial<CodeTestCase>): CodeTestCase => ({
    name: 't',
    options: {},
    evaluate: () => {},
    ...over,
  });

  it('drops non-JSON-serializable option values (functions, undefined)', () => {
    const def = captureTestDefinition(mk({
      options: { prompt: 'p', helper: (() => 1) as any, missing: undefined } as any,
    }));
    expect(def.options).toEqual({ prompt: 'p' });
  });

  it('bounds bodySource and flags truncation', () => {
    const huge = 'x'.repeat(DEFINITION_BODY_SOURCE_MAX_CHARS + 500);
    // Build a function whose toString() is deterministic and huge.
    const fn = new Function(`/* ${huge} */ return 1;`);
    const def = captureTestDefinition(mk({ evaluate: fn as any }));
    expect(def.bodyTruncated).toBe(true);
    expect(def.bodySource.length).toBeLessThan(DEFINITION_BODY_SOURCE_MAX_CHARS + 100);
    expect(def.bodySource).toContain('truncated');
  });

  it('survives circular options without throwing', () => {
    const circular: any = { prompt: 'p' };
    circular.self = circular;
    const def = captureTestDefinition(mk({ options: circular }));
    expect(def.options).toEqual({});
    expect(def.registeredAs).toBe('sdk');
  });
});

describe('computeTestCaseHash — definition does NOT participate', () => {
  it('produces the same hash with or without a definition attached (re-import of an unchanged file is `unchanged`)', () => {
    const tc: CodeTestCase = {
      name: 'stable',
      options: { prompt: 'p', expectedOutcomes: ['o'], labels: ['category:X'] },
      evaluate: () => {},
    };
    const fileSource = "test('stable', { prompt: 'p' }, () => {});";
    const before = computeTestCaseHash(tc, fileSource);
    const withDefinition = { ...tc, definition: captureTestDefinition(tc) } as CodeTestCase;
    const after = computeTestCaseHash(withDefinition, fileSource);
    expect(after).toBe(before);
  });

  it('is stable across two loads of the identical file', async () => {
    const filePath = write('stable.eval.js', THREE_TEST_FILE);
    const first = await loadTestCasesFromModule(filePath);
    clearRegistry();
    const second = await loadTestCasesFromModule(filePath);
    expect(second.testCases.map(t => t.hash)).toEqual(first.testCases.map(t => t.hash));
    // And each carries a definition both times.
    expect(second.testCases.every(t => t.definition?.registeredAs === 'sdk')).toBe(true);
  });
});
