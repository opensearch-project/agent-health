/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * #620 — `benchmark -f other.eval.ts -n "<existing>"` guard: the CLI compares
 * the `-f` code files against the `sourceFile`s of the benchmark's current
 * test cases (the only durable record of which files a benchmark is made of)
 * and refuses unless --force.
 */

import * as path from 'path';
import {
  checkBenchmarkSourceMismatch,
  compareSourceFiles,
  currentBenchmarkTestCaseIds,
  describeAddedTestCases,
  describeForcedAddition,
  formatSourceCheckUnverified,
  formatSourceMismatchForced,
  formatSourceMismatchRefusal,
} from '@/cli/utils/benchmarkSourceGuard';

const CWD = '/work/shop';
const ROOTS = [CWD];
const existsIn = (present: string[]) => (p: string) => present.includes(p);
const A = path.join(CWD, 'a.eval.ts');
const B = path.join(CWD, 'b.eval.ts');
const C = path.join(CWD, 'c.eval.ts');

describe('compareSourceFiles', () => {
  const casesFromA = [{ sourceFile: 'a.eval.ts' }, { sourceFile: 'a.eval.ts' }];
  const fs = existsIn([A, B, C]);

  it('a different eval file under an existing benchmark name is a mismatch naming both files', () => {
    expect(compareSourceFiles(casesFromA, ['b.eval.ts'], ROOTS, CWD, fs)).toEqual({
      existingSourceFiles: ['a.eval.ts'],
      foreignFiles: ['b.eval.ts'],
      missingFiles: ['a.eval.ts'],
    });
  });

  it('the SAME file spelled differently is never a mismatch (./a, a, absolute, nested cwd via a root, stored absolute)', () => {
    expect(compareSourceFiles(casesFromA, ['a.eval.ts'], ROOTS, CWD, fs)).toBeNull();
    expect(compareSourceFiles(casesFromA, ['./a.eval.ts'], ROOTS, CWD, fs)).toBeNull();
    expect(compareSourceFiles(casesFromA, [A], ROOTS, CWD, fs)).toBeNull();
    expect(compareSourceFiles(casesFromA, [`${CWD}/./a.eval.ts`], ROOTS, CWD, fs)).toBeNull();
    // Stored root-relative under a configured eval root, given absolute from a nested cwd.
    expect(compareSourceFiles([{ sourceFile: 'evals/a.eval.ts' }], ['/repo/evals/a.eval.ts'], ['/repo'], '/repo/sub', existsIn(['/repo/evals/a.eval.ts']))).toBeNull();
    // Stored absolute (legacy), given relative.
    expect(compareSourceFiles([{ sourceFile: A }], ['a.eval.ts'], ROOTS, CWD, fs)).toBeNull();
    // Windows separators from an importing machine.
    expect(compareSourceFiles([{ sourceFile: 'sub\\a.eval.ts' }], ['sub/a.eval.ts'], ROOTS, CWD, existsIn([path.join(CWD, 'sub/a.eval.ts')]))).toBeNull();
  });

  it('resolves a relative spelling against the roots the way the server does — first root where the file EXISTS', () => {
    // Two roots each holding an a.eval.ts: the stored 'a.eval.ts' means r1's (first existing);
    // the user passing r2's absolute path is a DIFFERENT file and must be refused.
    const roots = ['/r1', '/r2'];
    const fs2 = existsIn(['/r1/a.eval.ts', '/r2/a.eval.ts']);
    expect(compareSourceFiles(casesFromA, ['/r2/a.eval.ts'], roots, '/elsewhere', fs2)).toMatchObject({ foreignFiles: ['/r2/a.eval.ts'] });
    expect(compareSourceFiles(casesFromA, ['/r1/a.eval.ts'], roots, '/elsewhere', fs2)).toBeNull();
    // Only under the second root → that one.
    expect(compareSourceFiles(casesFromA, ['/r2/a.eval.ts'], roots, '/elsewhere', existsIn(['/r2/a.eval.ts']))).toBeNull();
    // Exists nowhere any more → both sides fall back to the first root, so the same spelling still matches itself.
    expect(compareSourceFiles(casesFromA, ['a.eval.ts'], roots, '/elsewhere', existsIn([]))).toBeNull();
  });

  it('the run must bring exactly the benchmark\'s files: a subset is "missing", extra files are "foreign"', () => {
    const cases = [{ sourceFile: 'a.eval.ts' }, { sourceFile: 'c.eval.ts' }];
    expect(compareSourceFiles(cases, ['a.eval.ts', 'c.eval.ts'], ROOTS, CWD, fs)).toBeNull();
    expect(compareSourceFiles(cases, ['c.eval.ts', './a.eval.ts'], ROOTS, CWD, fs)).toBeNull();
    expect(compareSourceFiles(cases, ['c.eval.ts'], ROOTS, CWD, fs)).toEqual({
      existingSourceFiles: ['a.eval.ts', 'c.eval.ts'],
      foreignFiles: [],
      missingFiles: ['a.eval.ts'],
    });
    expect(compareSourceFiles(cases, ['a.eval.ts', 'b.eval.ts', 'c.eval.ts'], ROOTS, CWD, fs)).toEqual({
      existingSourceFiles: ['a.eval.ts', 'c.eval.ts'],
      foreignFiles: ['b.eval.ts'],
      missingFiles: [],
    });
  });

  it('nothing to object to when the benchmark has no code cases (fresh shell, JSON-only, UI-authored) or only JSON files are given', () => {
    expect(compareSourceFiles([], ['b.eval.ts'], ROOTS, CWD, fs)).toBeNull();
    expect(compareSourceFiles([{ sourceFile: undefined }, { sourceFile: 'cases.json' }], ['b.eval.ts'], ROOTS, CWD, fs)).toBeNull();
    expect(compareSourceFiles(casesFromA, ['more.json'], ROOTS, CWD, fs)).toBeNull();
    // JSON files alongside the right code file are ignored by the comparison.
    expect(compareSourceFiles(casesFromA, ['a.eval.ts', 'more.json'], ROOTS, CWD, fs)).toBeNull();
  });
});

describe('checkBenchmarkSourceMismatch', () => {
  const bm = {
    currentVersion: 2,
    testCaseIds: ['tc-b1'],
    versions: [
      { version: 1, createdAt: '', testCaseIds: ['tc-old'] },
      { version: 2, createdAt: '', testCaseIds: ['tc-a1', 'tc-a2'] },
    ],
  };
  const api = (summaries: Record<string, string | undefined>, roots: string[] | undefined = ROOTS) => ({
    getConfigStatus: jest.fn(async () => (roots ? { evalRoots: { roots, source: 'default' } } : null)),
    getTestCaseSummaries: jest.fn(async (ids: string[]) => ids.map(id => ({ name: id, sourceFile: summaries[id] }))),
  });

  it('consults the CURRENT version + top level (never historical versions), in one batched request', async () => {
    expect(currentBenchmarkTestCaseIds(bm).sort()).toEqual(['tc-a1', 'tc-a2', 'tc-b1']);
    const a = api({ 'tc-a1': 'a.eval.ts', 'tc-a2': 'a.eval.ts', 'tc-b1': 'a.eval.ts', 'tc-old': 'old.eval.ts' });
    const r = await checkBenchmarkSourceMismatch(a, bm, ['b.eval.ts'], CWD);
    expect(r).toEqual({ kind: 'mismatch', mismatch: { existingSourceFiles: ['a.eval.ts'], foreignFiles: ['b.eval.ts'], missingFiles: ['a.eval.ts'] } });
    expect(a.getTestCaseSummaries).toHaveBeenCalledTimes(1);
    expect((a.getTestCaseSummaries.mock.calls[0] as any)[0].sort()).toEqual(['tc-a1', 'tc-a2', 'tc-b1']);
    // old.eval.ts (version 1 only) does not authorise a run of old.eval.ts.
    expect(await checkBenchmarkSourceMismatch(a, bm, ['old.eval.ts'], CWD)).toMatchObject({ kind: 'mismatch', mismatch: { foreignFiles: ['old.eval.ts'] } });
  });

  it('uses the server eval roots when reported, the cwd otherwise', async () => {
    const withRoots = api({ 'tc-a1': 'evals/a.eval.ts', 'tc-a2': 'evals/a.eval.ts', 'tc-b1': 'evals/a.eval.ts' }, ['/repo']);
    expect(await checkBenchmarkSourceMismatch(withRoots, bm, ['/repo/evals/a.eval.ts'], '/elsewhere')).toEqual({ kind: 'ok' });
    const noRoots = api({ 'tc-a1': 'a.eval.ts', 'tc-a2': 'a.eval.ts', 'tc-b1': 'a.eval.ts' }, undefined);
    expect(await checkBenchmarkSourceMismatch(noRoots, bm, ['a.eval.ts'], CWD)).toEqual({ kind: 'ok' });
    expect(await checkBenchmarkSourceMismatch(noRoots, bm, ['b.eval.ts'], CWD)).toMatchObject({ kind: 'mismatch' });
  });

  it('skips the lookup for JSON-only -f or an empty benchmark; an API failure is reported as unverified, never swallowed', async () => {
    const a = api({});
    expect(await checkBenchmarkSourceMismatch(a, bm, ['cases.json'], CWD)).toEqual({ kind: 'ok' });
    expect(await checkBenchmarkSourceMismatch(a, { currentVersion: 1, testCaseIds: [], versions: [] }, ['b.eval.ts'], CWD)).toEqual({ kind: 'ok' });
    expect(a.getTestCaseSummaries).not.toHaveBeenCalled();
    const broken = { getConfigStatus: async () => null, getTestCaseSummaries: async () => { throw new Error('boom'); } };
    expect(await checkBenchmarkSourceMismatch(broken, bm, ['b.eval.ts'], CWD)).toEqual({ kind: 'unverified', reason: 'boom' });
  });
});

describe('messages', () => {
  const foreign = { existingSourceFiles: ['a.eval.ts'], foreignFiles: ['b.eval.ts'], missingFiles: ['a.eval.ts'] };
  const subset = { existingSourceFiles: ['a.eval.ts', 'c.eval.ts'], foreignFiles: [], missingFiles: ['c.eval.ts'] };

  it('refusal for a foreign file names both files, explains the merge, and suggests a different -n or --force', () => {
    const lines = formatSourceMismatchRefusal('shop', foreign);
    expect(lines[0]).toBe('Error: benchmark "shop" was created from "a.eval.ts"; "b.eval.ts" is a different source file.');
    expect(lines[1]).toMatch(/add its test cases to "shop" and mix two question sets/);
    expect(lines[2]).toBe('Use a different name (e.g. -n "shop-b") or pass --force to add "b.eval.ts" to "shop" anyway.');
  });

  it('refusal for a subset says which file the run leaves out', () => {
    const lines = formatSourceMismatchRefusal('shop', subset);
    expect(lines[0]).toBe('Error: benchmark "shop" holds test cases from "a.eval.ts", "c.eval.ts"; this run leaves out "c.eval.ts".');
    expect(lines[1]).toMatch(/pass rate over a different question set/);
    expect(lines[2]).toBe('Use a different name (e.g. -n "shop-c") or pass --force to run this subset under "shop" anyway.');
  });

  it('forced warning and unverified notice', () => {
    expect(formatSourceMismatchForced('shop', foreign)).toBe(
      'Warning: --force — adding the test cases of "b.eval.ts" to benchmark "shop", which was created from "a.eval.ts"; running "shop" without "a.eval.ts".',
    );
    expect(formatSourceMismatchForced('shop', subset)).toBe('Warning: --force — running "shop" without "c.eval.ts".');
    expect(formatSourceCheckUnverified('shop', 'HTTP 500')).toMatch(/could not verify .* "shop" \(HTTP 500\); continuing\./);
  });

  it('"Added …" lists exactly the run test cases the benchmark did not hold before; null when nothing new', () => {
    const run = [{ id: 'tc-a1', name: 'old' }, { id: 'tc-b1', name: 'new one' }, { id: 'tc-b2', name: 'new two' }];
    expect(describeAddedTestCases(['tc-a1'], run, 'shop')).toBe('Added 2 test cases to "shop": new one, new two');
    expect(describeAddedTestCases(['tc-a1', 'tc-b1', 'tc-b2'], run, 'shop')).toBeNull();
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `n${i}`, name: `case ${i}` }));
    expect(describeAddedTestCases([], many, 'shop')).toMatch(/^Added 12 test cases to "shop": case 0, .*case 9, \+2 more$/);
  });

  it('description records the added file once; a subset run leaves it untouched', () => {
    expect(describeForcedAddition('CLI benchmark run from a.eval.ts', foreign)).toBe('CLI benchmark run from a.eval.ts; b.eval.ts added with --force');
    expect(describeForcedAddition(undefined, foreign)).toBe('CLI benchmark run from a.eval.ts; b.eval.ts added with --force');
    expect(describeForcedAddition('keep me', subset)).toBe('keep me');
  });
});
