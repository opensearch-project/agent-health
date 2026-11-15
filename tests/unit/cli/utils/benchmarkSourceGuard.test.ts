/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * #620 — `benchmark -f other.eval.ts -n "<existing>"` guard: the CLI compares
 * the `-f` code files against the `sourceFile`s of the benchmark's stored
 * test cases (the only durable record of which file a benchmark came from)
 * and refuses unless --force.
 */

import * as path from 'path';
import {
  allBenchmarkTestCaseIds,
  checkBenchmarkSourceMismatch,
  describeAddedTestCases,
  findForeignSourceFiles,
  formatSourceMismatchForced,
  formatSourceMismatchRefusal,
} from '@/cli/utils/benchmarkSourceGuard';

const CWD = '/work/shop';
const ROOTS = [CWD];

describe('findForeignSourceFiles', () => {
  const casesFromA = [{ sourceFile: 'a.eval.ts' }, { sourceFile: 'a.eval.ts' }];

  it('a different eval file under an existing benchmark name is a mismatch naming both files', () => {
    expect(findForeignSourceFiles(casesFromA, ['b.eval.ts'], ROOTS, CWD)).toEqual({
      existingSourceFiles: ['a.eval.ts'],
      foreignFiles: ['b.eval.ts'],
    });
  });

  it('the SAME file spelled differently is never a mismatch (./a, a, absolute, subdir-relative via a root)', () => {
    expect(findForeignSourceFiles(casesFromA, ['a.eval.ts'], ROOTS, CWD)).toBeNull();
    expect(findForeignSourceFiles(casesFromA, ['./a.eval.ts'], ROOTS, CWD)).toBeNull();
    expect(findForeignSourceFiles(casesFromA, [path.join(CWD, 'a.eval.ts')], ROOTS, CWD)).toBeNull();
    // Stored root-relative under a configured eval root, run from a nested cwd.
    expect(findForeignSourceFiles([{ sourceFile: 'evals/a.eval.ts' }], ['../evals/a.eval.ts'], ['/repo'], '/repo/sub')).toBeNull();
    // Stored absolute (legacy), given relative.
    expect(findForeignSourceFiles([{ sourceFile: '/work/shop/a.eval.ts' }], ['a.eval.ts'], ROOTS, CWD)).toBeNull();
  });

  it('a benchmark that holds cases from several files accepts any of them and flags only the foreign ones', () => {
    const cases = [{ sourceFile: 'a.eval.ts' }, { sourceFile: 'c.eval.ts' }];
    expect(findForeignSourceFiles(cases, ['c.eval.ts'], ROOTS, CWD)).toBeNull();
    expect(findForeignSourceFiles(cases, ['a.eval.ts', 'b.eval.ts', 'c.eval.ts'], ROOTS, CWD)).toEqual({
      existingSourceFiles: ['a.eval.ts', 'c.eval.ts'],
      foreignFiles: ['b.eval.ts'],
    });
  });

  it('nothing to object to when the benchmark has no code cases (fresh shell, JSON-only, UI-authored) or only JSON files are given', () => {
    expect(findForeignSourceFiles([], ['b.eval.ts'], ROOTS, CWD)).toBeNull();
    expect(findForeignSourceFiles([{ sourceFile: undefined }, { sourceFile: 'cases.json' }], ['b.eval.ts'], ROOTS, CWD)).toBeNull();
    expect(findForeignSourceFiles(casesFromA, ['more.json'], ROOTS, CWD)).toBeNull();
  });
});

describe('checkBenchmarkSourceMismatch', () => {
  const bm = {
    testCaseIds: ['tc-b1'],
    versions: [{ version: 1, createdAt: '', testCaseIds: ['tc-a1', 'tc-a2'] }],
  };
  const api = (summaries: Record<string, string | undefined>, roots: string[] | undefined = ROOTS) => ({
    getConfigStatus: jest.fn(async () => (roots ? { evalRoots: { roots, source: 'default' } } : null)),
    getTestCaseSummaries: jest.fn(async (ids: string[]) => ids.map(id => ({ name: id, sourceFile: summaries[id] }))),
  });

  it('every id the benchmark ever linked is consulted (top level + versions), in one batched request', async () => {
    const a = api({ 'tc-a1': 'a.eval.ts', 'tc-a2': 'a.eval.ts', 'tc-b1': 'a.eval.ts' });
    expect(allBenchmarkTestCaseIds(bm).sort()).toEqual(['tc-a1', 'tc-a2', 'tc-b1']);
    const m = await checkBenchmarkSourceMismatch(a, bm, ['b.eval.ts'], CWD);
    expect(m).toEqual({ existingSourceFiles: ['a.eval.ts'], foreignFiles: ['b.eval.ts'] });
    expect(a.getTestCaseSummaries).toHaveBeenCalledTimes(1);
    expect((a.getTestCaseSummaries.mock.calls[0] as any)[0].sort()).toEqual(['tc-a1', 'tc-a2', 'tc-b1']);
  });

  it('uses the server eval roots when reported, the cwd otherwise', async () => {
    // Server root /repo; stored 'evals/a.eval.ts'; user runs `-f /repo/evals/a.eval.ts` from elsewhere → same file.
    const withRoots = api({ 'tc-a1': 'evals/a.eval.ts', 'tc-a2': 'evals/a.eval.ts', 'tc-b1': 'evals/a.eval.ts' }, ['/repo']);
    expect(await checkBenchmarkSourceMismatch(withRoots, bm, ['/repo/evals/a.eval.ts'], '/elsewhere')).toBeNull();
    const noRoots = api({ 'tc-a1': 'a.eval.ts', 'tc-a2': 'a.eval.ts', 'tc-b1': 'a.eval.ts' }, undefined);
    expect(await checkBenchmarkSourceMismatch(noRoots, bm, ['a.eval.ts'], CWD)).toBeNull();
    expect(await checkBenchmarkSourceMismatch(noRoots, bm, ['b.eval.ts'], CWD)).not.toBeNull();
  });

  it('skips the lookup entirely for JSON-only -f or an empty benchmark; an API failure never blocks the run', async () => {
    const a = api({});
    expect(await checkBenchmarkSourceMismatch(a, bm, ['cases.json'], CWD)).toBeNull();
    expect(await checkBenchmarkSourceMismatch(a, { testCaseIds: [], versions: [] }, ['b.eval.ts'], CWD)).toBeNull();
    expect(a.getTestCaseSummaries).not.toHaveBeenCalled();
    const broken = { getConfigStatus: async () => null, getTestCaseSummaries: async () => { throw new Error('boom'); } };
    expect(await checkBenchmarkSourceMismatch(broken, bm, ['b.eval.ts'], CWD)).toBeNull();
  });
});

describe('messages', () => {
  const m = { existingSourceFiles: ['a.eval.ts'], foreignFiles: ['b.eval.ts'] };

  it('refusal names both files, explains the merge, and suggests a different -n or --force', () => {
    const lines = formatSourceMismatchRefusal('shop', m);
    expect(lines[0]).toBe('Error: benchmark "shop" was created from "a.eval.ts"; "b.eval.ts" is a different source file.');
    expect(lines[1]).toMatch(/add its test cases to "shop" and mix two question sets/);
    expect(lines[2]).toBe('Use a different name (e.g. -n "shop-b") or pass --force to add "b.eval.ts" to "shop" anyway.');
  });

  it('forced warning names both files', () => {
    expect(formatSourceMismatchForced('shop', m)).toBe(
      'Warning: --force — adding the test cases of "b.eval.ts" to benchmark "shop", which was created from "a.eval.ts".',
    );
  });

  it('"Added …" lists exactly the run test cases the benchmark did not hold before; null when nothing new', () => {
    const run = [{ id: 'tc-a1', name: 'old' }, { id: 'tc-b1', name: 'new one' }, { id: 'tc-b2', name: 'new two' }];
    expect(describeAddedTestCases(['tc-a1'], run, 'shop')).toBe('Added 2 test cases to "shop": new one, new two');
    expect(describeAddedTestCases(['tc-a1', 'tc-b1', 'tc-b2'], run, 'shop')).toBeNull();
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `n${i}`, name: `case ${i}` }));
    expect(describeAddedTestCases([], many, 'shop')).toMatch(/^Added 12 test cases to "shop": case 0, .*case 9, \+2 more$/);
  });
});
