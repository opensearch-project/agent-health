/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for resolveCodeFnMapForStoredTestCases — the benchmark-side
 * code-import re-resolution helper extracted from the benchmarks route
 * (#245/#246, RFC 004 phase 6).
 */

import { resolveCodeFnMapForStoredTestCases } from '@/services/sourceResolver';
import type { TestCase } from '@/types';

jest.mock('path', () => ({
  join: jest.fn((...args: string[]) => args.join('/')),
  resolve: jest.fn((p: string) => p),
  // The helper keys stored docs by path.relative(cwd, loaded.filePath); our
  // fixtures store the same relative path, so echo `to` back.
  relative: jest.fn((_from: string, to: string) => to),
}));

jest.mock('@/lib/debug', () => ({ debug: jest.fn() }));

jest.mock('@/lib/testCases/loader', () => ({
  loadTestCasesFromModule: jest.fn(),
}));

import { loadTestCasesFromModule } from '@/lib/testCases/loader';
const mockLoad = loadTestCasesFromModule as jest.Mock;

function stored(id: string, name: string, sourceFile?: string): TestCase {
  return { id, name, sourceFile, currentVersion: 1, labels: [], context: [] } as unknown as TestCase;
}

describe('resolveCodeFnMapForStoredTestCases', () => {
  beforeEach(() => jest.clearAllMocks());

  it('compiles stored non-code cases without loading a code module', async () => {
    const r = await resolveCodeFnMapForStoredTestCases([
      stored('tc-1', 'A'),                       // no sourceFile
      stored('tc-2', 'B', 'cases/data.json'),    // json provenance, not code
    ]);
    expect(r.evaluateFnMap.size).toBe(2);
    expect(r.evaluateFnMap.has('tc-1')).toBe(true);
    expect(r.evaluateFnMap.has('tc-2')).toBe(true);
    expect(r.hooksByFile.size).toBe(0);
    expect(r.testHookScopes.size).toBe(0);
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it('maps stored ids to evaluate fns by (sourceFile, name) and captures hooks/scopes', async () => {
    const evalA = jest.fn();
    const evalB = jest.fn();
    const hooks = [{ kind: 'beforeEach', fn: jest.fn(), sourceFile: 'evals/x.eval.js' }];
    mockLoad.mockResolvedValue({
      filePath: 'evals/x.eval.js',
      testCases: [
        { name: 'first', evaluate: evalA, benchmarkPath: undefined },
        { name: 'second', evaluate: evalB, benchmarkPath: 'Suite' },
      ],
      hooks,
    });

    const r = await resolveCodeFnMapForStoredTestCases([
      stored('id-1', 'first', 'evals/x.eval.js'),
      stored('id-2', 'second', 'evals/x.eval.js'),
    ]);

    expect(mockLoad).toHaveBeenCalledTimes(1);
    expect(r.evaluateFnMap.get('id-1')).toBe(evalA);
    expect(r.evaluateFnMap.get('id-2')).toBe(evalB);
    expect(r.testHookScopes.get('id-2')).toEqual({ sourceFile: 'evals/x.eval.js', describePath: 'Suite' });
    expect(r.hooksByFile.get('evals/x.eval.js')).toBe(hooks);
  });

  it('skips loaded tests with no matching stored doc (name mismatch)', async () => {
    mockLoad.mockResolvedValue({
      filePath: 'evals/y.eval.js',
      testCases: [{ name: 'renamed', evaluate: jest.fn(), benchmarkPath: undefined }],
      hooks: [],
    });
    const r = await resolveCodeFnMapForStoredTestCases([
      stored('id-1', 'old-name', 'evals/y.eval.js'),
    ]);
    expect(r.evaluateFnMap.size).toBe(0);
  });

  it('is non-fatal when a code file fails to load', async () => {
    mockLoad.mockRejectedValue(new Error('file gone'));
    const r = await resolveCodeFnMapForStoredTestCases([
      stored('id-1', 'first', 'evals/missing.eval.js'),
    ]);
    expect(r.evaluateFnMap.size).toBe(0); // swallowed, no throw
  });

  it('loads each unique source file once', async () => {
    mockLoad.mockResolvedValue({ filePath: 'evals/z.eval.js', testCases: [], hooks: [] });
    await resolveCodeFnMapForStoredTestCases([
      stored('id-1', 'a', 'evals/z.eval.js'),
      stored('id-2', 'b', 'evals/z.eval.js'),
    ]);
    expect(mockLoad).toHaveBeenCalledTimes(1);
  });
});
