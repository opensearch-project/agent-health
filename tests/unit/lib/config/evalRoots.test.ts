/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';

jest.mock('@/lib/config/statePaths', () => ({
  readLayeredState: jest.fn(() => ({})),
}));

import { readLayeredState } from '@/lib/config/statePaths';
import {
  EVAL_ROOTS_ENV,
  __resetEvalRootsForTests,
  getEvalRoots,
  getEvalRootsStatus,
  lookupSourceFile,
  resolveSourceFile,
  setConfiguredEvalRoots,
  toStoredSourceFile,
  formatEvalRootsHint,
} from '@/lib/config/evalRoots';

const mockState = readLayeredState as jest.Mock;

describe('lib/config/evalRoots', () => {
  let tmp: string;
  let cwd: string;
  let rootA: string;
  let rootB: string;

  beforeAll(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'ah-eval-roots-'));
    cwd = path.join(tmp, 'server-cwd');
    rootA = path.join(tmp, 'root-a');
    rootB = path.join(tmp, 'root-b');
    for (const d of [cwd, rootA, rootB]) mkdirSync(path.join(d, 'evals'), { recursive: true });
    writeFileSync(path.join(rootA, 'evals', 'only-a.eval.mjs'), '// a');
    writeFileSync(path.join(rootB, 'evals', 'only-b.eval.mjs'), '// b');
    writeFileSync(path.join(rootA, 'evals', 'both.eval.mjs'), '// a-both');
    writeFileSync(path.join(rootB, 'evals', 'both.eval.mjs'), '// b-both');
    writeFileSync(path.join(cwd, 'evals', 'in-cwd.eval.mjs'), '// cwd');
  });

  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  beforeEach(() => {
    __resetEvalRootsForTests();
    mockState.mockReturnValue({});
  });

  describe('getEvalRootsStatus precedence', () => {
    it('defaults to [cwd] with source=default', () => {
      expect(getEvalRootsStatus({ cwd, env: {} })).toEqual({ roots: [cwd], source: 'default' });
      expect(getEvalRoots({ cwd, env: {} })).toEqual([cwd]);
    });

    it('state.json evalRoots (ui-first) beats the default and resolves relative entries against cwd', () => {
      mockState.mockReturnValue({ evalRoots: ['../root-b', rootA] });
      expect(getEvalRootsStatus({ cwd, env: {} })).toEqual({ roots: [rootB, rootA], source: 'file' });
    });

    it('agent-health.config.ts evalRoots (code-first bridge) beats state.json', () => {
      mockState.mockReturnValue({ evalRoots: [rootB] });
      setConfiguredEvalRoots([rootA]);
      expect(getEvalRootsStatus({ cwd, env: {} })).toEqual({ roots: [rootA], source: 'typescript' });
    });

    it('AGENT_HEALTH_EVAL_ROOTS env beats everything; path.delimiter separated, blanks dropped, dupes collapsed', () => {
      setConfiguredEvalRoots([rootA]);
      mockState.mockReturnValue({ evalRoots: [rootA] });
      const env = { [EVAL_ROOTS_ENV]: [rootB, '', rootA, rootB].join(path.delimiter) };
      expect(getEvalRootsStatus({ cwd, env })).toEqual({ roots: [rootB, rootA], source: 'environment' });
    });

    it('an env var that is set but empty/blank does not shadow lower layers', () => {
      setConfiguredEvalRoots([rootA]);
      expect(getEvalRootsStatus({ cwd, env: { [EVAL_ROOTS_ENV]: ' ' } }).source).toBe('typescript');
    });

    it('ignores malformed state/config values (non-array, non-string entries) and falls through', () => {
      mockState.mockReturnValue({ evalRoots: 'not-an-array' });
      expect(getEvalRootsStatus({ cwd, env: {} }).source).toBe('default');
      setConfiguredEvalRoots([42 as unknown as string, '  ']);
      expect(getEvalRootsStatus({ cwd, env: {} }).source).toBe('default');
      setConfiguredEvalRoots(null);
      mockState.mockImplementation(() => { throw new Error('unreadable'); });
      expect(getEvalRootsStatus({ cwd, env: {} })).toEqual({ roots: [cwd], source: 'default' });
    });
  });

  describe('lookupSourceFile / resolveSourceFile', () => {
    it('multi-root: first hit wins and the matching root is recorded', () => {
      const roots = [rootA, rootB];
      expect(lookupSourceFile('evals/both.eval.mjs', roots)).toEqual({
        resolved: { abs: path.join(rootA, 'evals', 'both.eval.mjs'), root: rootA },
        tried: [rootA],
      });
      expect(lookupSourceFile('evals/only-b.eval.mjs', roots)).toEqual({
        resolved: { abs: path.join(rootB, 'evals', 'only-b.eval.mjs'), root: rootB },
        tried: [rootA, rootB],
      });
    });

    it('missing everywhere → resolved=null with every root listed in tried', () => {
      const r = lookupSourceFile('evals/nope.eval.mjs', [rootA, rootB]);
      expect(r).toEqual({ resolved: null, tried: [rootA, rootB] });
      expect(resolveSourceFile('evals/nope.eval.mjs', [rootA, rootB])).toBeNull();
      expect(formatEvalRootsHint(r.tried)).toBe(`${JSON.stringify(rootA)}, ${JSON.stringify(rootB)}`);
      expect(formatEvalRootsHint([])).toBe('(no eval roots)');
    });

    it('absolute sourceFiles are used verbatim (root=null) regardless of roots', () => {
      const abs = path.join(rootB, 'evals', 'only-b.eval.mjs');
      expect(lookupSourceFile(abs, [rootA])).toEqual({ resolved: { abs, root: null }, tried: [abs] });
      const missing = path.join(rootB, 'evals', 'gone.eval.mjs');
      expect(lookupSourceFile(missing, [rootA])).toEqual({ resolved: null, tried: [missing] });
    });

    it('normalises Windows separators from the importing machine', () => {
      expect(resolveSourceFile('evals\\only-a.eval.mjs', [rootA])).toEqual({
        abs: path.join(rootA, 'evals', 'only-a.eval.mjs'),
        root: rootA,
      });
    });

    it('uses the effective roots (env) when none are passed', () => {
      process.env[EVAL_ROOTS_ENV] = rootB;
      try {
        expect(resolveSourceFile('evals/only-b.eval.mjs')?.root).toBe(rootB);
        expect(resolveSourceFile('evals/only-a.eval.mjs')).toBeNull();
      } finally {
        delete process.env[EVAL_ROOTS_ENV];
      }
    });
  });

  describe('toStoredSourceFile', () => {
    it('spells the stored path relative to the first containing root, forward slashes', () => {
      const abs = path.join(rootB, 'evals', 'only-b.eval.mjs');
      expect(toStoredSourceFile(abs, [rootA, rootB], cwd)).toEqual({ sourceFile: 'evals/only-b.eval.mjs', root: rootB });
    });

    it('falls back to cwd-relative (legacy behaviour) when no root contains the file', () => {
      const abs = path.join(cwd, 'evals', 'in-cwd.eval.mjs');
      expect(toStoredSourceFile(abs, [rootA], cwd)).toEqual({ sourceFile: 'evals/in-cwd.eval.mjs', root: cwd });
      const outside = path.join(tmp, 'elsewhere.eval.mjs');
      expect(toStoredSourceFile(outside, [rootA], cwd)).toEqual({ sourceFile: '../elsewhere.eval.mjs', root: cwd });
    });
  });
});
