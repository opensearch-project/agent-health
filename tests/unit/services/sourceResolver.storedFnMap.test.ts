/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for resolveCodeFnMapForStoredTestCases — the benchmark-side
 * code-import re-resolution helper (#245/#246, RFC 004 phase 6).
 *
 * Since the judge-precedence / source-resolution fix, an unresolvable code
 * body is a HARD ERROR (the same stored test cases used to be judged by the
 * SDK body on one server and by the classic eager judge on another,
 * depending only on the server's cwd). Keys are normalised so a separator /
 * `./` difference between the stored `sourceFile` and the loader's absolute
 * path cannot silently miss.
 */

import * as path from 'path';
import {
  resolveCodeFnMapForStoredTestCases,
  UnresolvableSourceFilesError,
  sourceFileKey,
} from '@/services/sourceResolver';
import type { TestCase } from '@/types';

jest.mock('@/lib/debug', () => ({ debug: jest.fn() }));

jest.mock('@/lib/testCases/loader', () => ({
  loadTestCasesFromModule: jest.fn(),
}));
jest.mock('@/lib/testCases/evaluators', () => ({
  clearEvaluators: jest.fn(),
}));

import { loadTestCasesFromModule } from '@/lib/testCases/loader';
import { clearEvaluators } from '@/lib/testCases/evaluators';
const mockLoad = loadTestCasesFromModule as jest.Mock;
const mockClear = clearEvaluators as jest.Mock;

const cwd = process.cwd();
const abs = (rel: string) => path.resolve(cwd, rel);

function stored(id: string, name: string, sourceFile?: string): TestCase {
  return { id, name, sourceFile, currentVersion: 1, labels: [], context: [] } as unknown as TestCase;
}

describe('sourceFileKey', () => {
  it('normalises relative, ./-prefixed, absolute and backslash spellings to one cwd-relative posix key', () => {
    const expected = 'evals/x.eval.js';
    expect(sourceFileKey('evals/x.eval.js', cwd)).toBe(expected);
    expect(sourceFileKey('./evals/x.eval.js', cwd)).toBe(expected);
    expect(sourceFileKey(abs('evals/x.eval.js'), cwd)).toBe(expected);
    expect(sourceFileKey('evals\\x.eval.js', cwd)).toBe(expected);
    expect(sourceFileKey('evals/../evals/x.eval.js', cwd)).toBe(expected);
  });
});

describe('resolveCodeFnMapForStoredTestCases', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns empty maps when no stored test case has a code sourceFile', async () => {
    const r = await resolveCodeFnMapForStoredTestCases([
      stored('tc-1', 'A'),                       // no sourceFile
      stored('tc-2', 'B', 'cases/data.json'),    // json provenance, not code
    ]);
    expect(r.evaluateFnMap.size).toBe(0);
    expect(r.hooksByFile.size).toBe(0);
    expect(r.testHookScopes.size).toBe(0);
    expect(mockLoad).not.toHaveBeenCalled();
    expect(mockClear).not.toHaveBeenCalled();
  });

  it('maps stored ids to evaluate fns by (sourceFile, name) and captures hooks/scopes', async () => {
    const evalA = jest.fn();
    const evalB = jest.fn();
    const hooks = [{ kind: 'beforeEach', fn: jest.fn(), sourceFile: abs('evals/x.eval.js') }];
    mockLoad.mockResolvedValue({
      filePath: abs('evals/x.eval.js'),
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
    // Resolved against process.cwd(), not passed through raw.
    expect(mockLoad).toHaveBeenCalledWith(abs('evals/x.eval.js'));
    expect(r.evaluateFnMap.get('id-1')).toBe(evalA);
    expect(r.evaluateFnMap.get('id-2')).toBe(evalB);
    expect(r.testHookScopes.get('id-2')).toEqual({ sourceFile: abs('evals/x.eval.js'), describePath: 'Suite' });
    expect(r.hooksByFile.get(abs('evals/x.eval.js'))).toBe(hooks);
    // Evaluator registry reset by default (fresh fn identities would trip the duplicate-id guard).
    expect(mockClear).toHaveBeenCalledTimes(1);
  });

  it('honours clearEvaluatorRegistry: false', async () => {
    mockLoad.mockResolvedValue({ filePath: abs('evals/z.eval.js'), testCases: [{ name: 'a', evaluate: jest.fn() }], hooks: [] });
    await resolveCodeFnMapForStoredTestCases([stored('id-1', 'a', 'evals/z.eval.js')], { clearEvaluatorRegistry: false });
    expect(mockClear).not.toHaveBeenCalled();
  });

  it('cwd-relative key normalisation: a stored "./" or backslash spelling still joins to the loaded file', async () => {
    const evalA = jest.fn();
    mockLoad.mockResolvedValue({
      filePath: abs('evals/norm.eval.js'),
      testCases: [{ name: 'first', evaluate: evalA }],
      hooks: [],
    });
    const r = await resolveCodeFnMapForStoredTestCases([
      stored('id-dot', 'first', './evals/norm.eval.js'),
    ]);
    expect(r.evaluateFnMap.get('id-dot')).toBe(evalA);

    jest.clearAllMocks();
    mockLoad.mockResolvedValue({
      filePath: abs('evals/norm.eval.js'),
      testCases: [{ name: 'first', evaluate: evalA }],
      hooks: [],
    });
    const r2 = await resolveCodeFnMapForStoredTestCases([
      stored('id-bs', 'first', 'evals\\norm.eval.js'),
    ]);
    expect(r2.evaluateFnMap.get('id-bs')).toBe(evalA);
    // Loader asked for the cwd-resolved posix path, not the raw backslash string.
    expect(mockLoad).toHaveBeenCalledWith(abs('evals/norm.eval.js'));
  });

  it('loads each unique source file once even when spelled differently', async () => {
    mockLoad.mockResolvedValue({
      filePath: abs('evals/z.eval.js'),
      testCases: [{ name: 'a', evaluate: jest.fn() }, { name: 'b', evaluate: jest.fn() }],
      hooks: [],
    });
    await resolveCodeFnMapForStoredTestCases([
      stored('id-1', 'a', 'evals/z.eval.js'),
      stored('id-2', 'b', './evals/z.eval.js'),
    ]);
    expect(mockLoad).toHaveBeenCalledTimes(1);
  });

  it('warns (does not fail) when the file on disk no longer matches the stored sourceHash — the CURRENT file runs', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const evalA = jest.fn();
    mockLoad.mockResolvedValue({
      filePath: abs('evals/drift.eval.js'),
      testCases: [{ name: 'first', evaluate: evalA, hash: 'hash-on-disk' }, { name: 'second', evaluate: jest.fn(), hash: 'same' }],
      hooks: [],
    });
    const r = await resolveCodeFnMapForStoredTestCases([
      { ...stored('id-1', 'first', 'evals/drift.eval.js'), sourceHash: 'hash-at-import' } as any,
      { ...stored('id-2', 'second', 'evals/drift.eval.js'), sourceHash: 'same' } as any,
    ]);
    expect(r.evaluateFnMap.get('id-1')).toBe(evalA);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('source drift');
    expect(String(warn.mock.calls[0][0])).toContain('"first"');
    expect(String(warn.mock.calls[0][0])).not.toContain('"second"');
    warn.mockRestore();
  });

  it('HARD ERROR: a code file that fails to load throws UnresolvableSourceFilesError naming the test case, file and cwd', async () => {
    mockLoad.mockRejectedValue(new Error("Cannot find module '/x/evals/missing.eval.js'"));
    const p = resolveCodeFnMapForStoredTestCases([
      stored('id-1', 'first', 'evals/missing.eval.js'),
    ]);
    await expect(p).rejects.toBeInstanceOf(UnresolvableSourceFilesError);
    await expect(p).rejects.toThrow(
      `Test case "first" references source file "evals/missing.eval.js" which is not resolvable from cwd ${cwd}`,
    );
    await expect(p).rejects.toThrow(/start the server from the eval project root or re-import the test cases/i);
    const err = await p.catch(e => e) as UnresolvableSourceFilesError;
    expect(err.cwd).toBe(cwd);
    expect(err.unresolvable).toEqual([
      expect.objectContaining({
        testCaseId: 'id-1',
        testCaseName: 'first',
        sourceFile: 'evals/missing.eval.js',
        reason: 'load-failed',
        detail: expect.stringContaining('Cannot find module'),
      }),
    ]);
  });

  it('HARD ERROR: a file that loads but defines no test with the stored name throws too', async () => {
    mockLoad.mockResolvedValue({
      filePath: abs('evals/y.eval.js'),
      testCases: [{ name: 'renamed', evaluate: jest.fn(), benchmarkPath: undefined }],
      hooks: [],
    });
    const p = resolveCodeFnMapForStoredTestCases([
      stored('id-1', 'old-name', 'evals/y.eval.js'),
    ]);
    await expect(p).rejects.toBeInstanceOf(UnresolvableSourceFilesError);
    await expect(p).rejects.toThrow('defines no test named "old-name"');
    const err = await p.catch(e => e) as UnresolvableSourceFilesError;
    expect(err.unresolvable[0]).toEqual(expect.objectContaining({ reason: 'no-matching-test', testCaseName: 'old-name' }));
  });

  it('lists EVERY unresolvable test case in one error (not just the first)', async () => {
    mockLoad.mockImplementation(async (p: string) => {
      if (p.endsWith('ok.eval.js')) {
        return { filePath: abs('evals/ok.eval.js'), testCases: [{ name: 'ok-case', evaluate: jest.fn() }], hooks: [] };
      }
      throw new Error('ENOENT');
    });
    const p = resolveCodeFnMapForStoredTestCases([
      stored('id-ok', 'ok-case', 'evals/ok.eval.js'),
      stored('id-m1', 'm1', 'evals/gone-a.eval.js'),
      stored('id-m2', 'm2', 'evals/gone-b.eval.mjs'),
    ]);
    const err = await p.catch(e => e) as UnresolvableSourceFilesError;
    expect(err).toBeInstanceOf(UnresolvableSourceFilesError);
    expect(err.unresolvable.map(u => u.testCaseId).sort()).toEqual(['id-m1', 'id-m2']);
    expect(err.message).toContain('Cannot run 2 code-SDK test case(s)');
    expect(err.message).toContain('"evals/gone-a.eval.js"');
    expect(err.message).toContain('"evals/gone-b.eval.mjs"');
  });
});
