/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'path';
import {
  EVAL_ROOTS_HINT_MAX_CASES,
  collectEvalRootsHints,
  findUnresolvableSourceFiles,
  formatEvalRootsHint,
} from '@/cli/utils/evalRootsHint';
import type { TestCase, TestCaseSource } from '@/types';

const ROOTS = ['/srv/agent-health', '/srv/eval-repo'];
const existsIn = (present: string[]) => (p: string) => present.includes(p);

describe('findUnresolvableSourceFiles', () => {
  it('reports a code sourceFile found under NONE of the roots, grouping test-case names; ignores json/no-source cases', () => {
    const hints = findUnresolvableSourceFiles(
      [
        { name: 'a', sourceFile: 'dist/suite.eval.js' },
        { name: 'b', sourceFile: 'dist/suite.eval.js' },
        { name: 'ok', sourceFile: 'dist/other.eval.js' },
        { name: 'json', sourceFile: 'cases/data.json' },
        { name: 'ui' },
      ],
      ROOTS,
      existsIn([path.resolve('/srv/eval-repo', 'dist/other.eval.js')]),
    );
    expect(hints).toEqual([{ sourceFile: 'dist/suite.eval.js', testCaseNames: ['a', 'b'], roots: ROOTS }]);
  });

  it('checks absolute sourceFiles verbatim and normalises Windows separators', () => {
    expect(findUnresolvableSourceFiles([{ name: 'x', sourceFile: '/abs/x.eval.js' }], ROOTS, existsIn(['/abs/x.eval.js']))).toEqual([]);
    expect(findUnresolvableSourceFiles([{ name: 'x', sourceFile: 'dist\\win.eval.js' }], ROOTS, existsIn([path.resolve('/srv/agent-health', 'dist/win.eval.js')]))).toEqual([]);
  });

  it('formats a single actionable line', () => {
    const line = formatEvalRootsHint({ sourceFile: 'dist/suite.eval.js', testCaseNames: ['a', 'b'], roots: ROOTS });
    expect(line).toContain('2 stored test cases reference "dist/suite.eval.js"');
    expect(line).toContain('"/srv/agent-health", "/srv/eval-repo"');
    expect(line).toContain('AGENT_HEALTH_EVAL_ROOTS');
    expect(line.split('\n')).toHaveLength(1);
    expect(formatEvalRootsHint({ sourceFile: 'f', testCaseNames: ['a'], roots: [] })).toContain('1 stored test case reference');
  });
});

describe('collectEvalRootsHints', () => {
  const tc = (id: string, sourceFile?: string): TestCase => ({ id, name: `case-${id}`, sourceFile } as unknown as TestCase);
  function api(overrides: Partial<{ status: any; benchmark: any; cases: Record<string, TestCase> }> = {}) {
    const cases = overrides.cases ?? { t1: tc('t1', 'dist/suite.eval.js'), t2: tc('t2') };
    return {
      getConfigStatus: jest.fn(async () => overrides.status === undefined ? { evalRoots: { roots: ROOTS, source: 'environment' } } : overrides.status),
      getBenchmark: jest.fn(async () => overrides.benchmark === undefined ? { testCaseIds: Object.keys(cases) } : overrides.benchmark),
      getTestCaseSummaries: jest.fn(async (ids: string[]) => ids.map(id => cases[id]).filter(Boolean)),
    };
  }

  it('walks benchmark + test-case-ids sources, dedupes ids, and returns hints for unresolvable files', async () => {
    const a = api();
    const sources: TestCaseSource[] = [
      { type: 'benchmark', benchmarkId: 'bm' },
      { type: 'test-case-ids', ids: ['t1'] },
      { type: 'code-import', filenames: ['x.eval.js'], testCaseIds: [] }, // skipped: server resolves this itself
    ];
    const hints = await collectEvalRootsHints(a, sources, () => false);
    // ONE batched request for the deduped id set — not a GET per test case.
    expect(a.getTestCaseSummaries).toHaveBeenCalledTimes(1);
    expect((a.getTestCaseSummaries.mock.calls[0][0] as string[]).sort()).toEqual(['t1', 't2']);
    expect(hints).toEqual([{ sourceFile: 'dist/suite.eval.js', testCaseNames: ['case-t1'], roots: ROOTS }]);
  });

  it('is silent when the server reports no evalRoots, when there are no stored sources, or when anything fails', async () => {
    expect(await collectEvalRootsHints(api({ status: null }), [{ type: 'benchmark', benchmarkId: 'bm' }], () => false)).toEqual([]);
    expect(await collectEvalRootsHints(api(), [{ type: 'label-filter', labels: ['x'] }], () => false)).toEqual([]);
    const failing = api();
    failing.getBenchmark.mockRejectedValue(new Error('boom'));
    expect(await collectEvalRootsHints(failing, [{ type: 'benchmark', benchmarkId: 'bm' }], () => false)).toEqual([]);
  });

  it('skips the check for very large benchmarks instead of hammering the server', async () => {
    const ids = Array.from({ length: EVAL_ROOTS_HINT_MAX_CASES + 1 }, (_, i) => `t${i}`);
    const a = api({ benchmark: { testCaseIds: ids } });
    expect(await collectEvalRootsHints(a, [{ type: 'benchmark', benchmarkId: 'bm' }], () => false)).toEqual([]);
    expect(a.getTestCaseSummaries).not.toHaveBeenCalled();
  });
});
