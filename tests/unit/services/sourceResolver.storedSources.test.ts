/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * resolveTestCaseSources — stored sources (benchmark / test-case-ids /
 * label-filter) re-materialize code bodies for test cases carrying a code
 * `sourceFile`, and an unresolvable body fails resolution BEFORE the run
 * starts. Pre-fix only the legacy `/execute` route did this (and swallowed
 * failures), so a code-SDK benchmark launched from the UI always ran the
 * classic eager-judge path while the same benchmark launched via the CLI ran
 * the SDK body if — and only if — the server's cwd could see the file.
 */

import * as path from 'path';
import { resolveTestCaseSources, UnresolvableSourceFilesError } from '@/services/sourceResolver';
import type { TestCase, TestCaseSource } from '@/types';
import type { IStorageModule } from '@/server/adapters/types';

jest.mock('@/lib/debug', () => ({ debug: jest.fn() }));
jest.mock('@/lib/testCases/loader', () => ({
  loadTestCasesFromModule: jest.fn(),
  detectSourceLanguage: jest.fn(() => 'javascript'),
}));
jest.mock('@/lib/testCases/evaluators', () => ({ clearEvaluators: jest.fn() }));

import { loadTestCasesFromModule } from '@/lib/testCases/loader';
const mockLoad = loadTestCasesFromModule as jest.Mock;

const cwd = process.cwd();
const abs = (rel: string) => path.resolve(cwd, rel);

function tc(id: string, name: string, extra: Partial<TestCase> = {}): TestCase {
  return { id, name, currentVersion: 1, labels: [], context: [], ...extra } as unknown as TestCase;
}

function storage(testCases: TestCase[], benchmark?: { id: string; testCaseIds: string[] }): IStorageModule {
  const byId = new Map(testCases.map(t => [t.id, t]));
  return {
    testCases: {
      getById: jest.fn(async (id: string) => byId.get(id) ?? null),
      search: jest.fn(async () => ({ items: testCases, total: testCases.length })),
    },
    benchmarks: {
      getById: jest.fn(async (id: string) => (benchmark && benchmark.id === id ? benchmark : null)),
    },
  } as unknown as IStorageModule;
}

describe('resolveTestCaseSources — stored sources re-materialize code bodies', () => {
  beforeEach(() => jest.clearAllMocks());

  it('benchmark source: stored code test cases get their evaluate fn + hook scope', async () => {
    const evalFn = jest.fn();
    mockLoad.mockResolvedValue({
      filePath: abs('evals/a.eval.js'),
      testCases: [{ name: 'case-a', evaluate: evalFn, benchmarkPath: 'Suite' }],
      hooks: [],
    });
    const cases = [tc('tc-a', 'case-a', { sourceFile: 'evals/a.eval.js' }), tc('tc-json', 'json-case')];
    const st = storage(cases, { id: 'bench-1', testCaseIds: ['tc-a', 'tc-json'] });

    const r = await resolveTestCaseSources([{ type: 'benchmark', benchmarkId: 'bench-1' }], st);

    expect(r.testCases.map(t => t.id)).toEqual(['tc-a', 'tc-json']);
    expect(r.evaluateFnMap.get('tc-a')).toBe(evalFn);
    expect(r.evaluateFnMap.has('tc-json')).toBe(false);
    expect(r.testHookScopes.get('tc-a')).toEqual({ sourceFile: abs('evals/a.eval.js'), describePath: 'Suite' });
  });

  it('test-case-ids + label-filter sources re-materialize too, loading each file once', async () => {
    const evalFn = jest.fn();
    mockLoad.mockResolvedValue({
      filePath: abs('evals/a.eval.js'),
      testCases: [{ name: 'case-a', evaluate: evalFn }],
      hooks: [],
    });
    const cases = [tc('tc-a', 'case-a', { sourceFile: 'evals/a.eval.js' })];
    const st = storage(cases);

    const sources: TestCaseSource[] = [
      { type: 'test-case-ids', ids: ['tc-a'] },
      { type: 'label-filter', labels: ['x'] },
    ];
    const r = await resolveTestCaseSources(sources, st);
    expect(r.evaluateFnMap.get('tc-a')).toBe(evalFn);
    expect(mockLoad).toHaveBeenCalledTimes(1);
    expect(r.deduplicatedCount).toBe(1);
  });

  it('HARD ERROR: an unresolvable sourceFile rejects the whole resolution with the cwd-aware message', async () => {
    mockLoad.mockRejectedValue(new Error('ENOENT: no such file'));
    const cases = [tc('tc-m', 'missing-case', { sourceFile: 'tmp-evals/x.eval.mjs' })];
    const st = storage(cases, { id: 'bench-1', testCaseIds: ['tc-m'] });

    const p = resolveTestCaseSources([{ type: 'benchmark', benchmarkId: 'bench-1' }], st);
    await expect(p).rejects.toBeInstanceOf(UnresolvableSourceFilesError);
    await expect(p).rejects.toThrow(
      `Test case "missing-case" references source file "tmp-evals/x.eval.mjs" which is not resolvable from cwd ${cwd}`,
    );
  });

  it('stored test cases with NO code sourceFile never touch the loader (pure classic path unchanged)', async () => {
    const cases = [tc('tc-1', 'plain'), tc('tc-2', 'json', { sourceFile: 'cases/data.json' })];
    const st = storage(cases, { id: 'bench-1', testCaseIds: ['tc-1', 'tc-2'] });
    const r = await resolveTestCaseSources([{ type: 'benchmark', benchmarkId: 'bench-1' }], st);
    expect(r.evaluateFnMap.size).toBe(0);
    expect(mockLoad).not.toHaveBeenCalled();
  });
});
