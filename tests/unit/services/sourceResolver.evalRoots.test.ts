/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * sourceResolver × eval roots: a stored RELATIVE `sourceFile` is located
 * under the configured eval roots (AGENT_HEALTH_EVAL_ROOTS > config > cwd),
 * the loader receives the ABSOLUTE path that matched, and the
 * `(sourceFile, name)` join key stays the relative spelling as stored.
 * Real temp dirs on disk (so `fs.existsSync` is the real thing); the module
 * loader is mocked so no eval code executes.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';

jest.mock('@/lib/debug', () => ({ debug: jest.fn() }));
jest.mock('@/lib/testCases/loader', () => ({
  loadTestCasesFromModule: jest.fn(),
  detectSourceLanguage: jest.fn(() => 'javascript'),
}));
jest.mock('@/lib/config/statePaths', () => ({ readLayeredState: jest.fn(() => ({})) }));

import { loadTestCasesFromModule } from '@/lib/testCases/loader';
import { debug } from '@/lib/debug';
import { EVAL_ROOTS_ENV, __resetEvalRootsForTests, setConfiguredEvalRoots } from '@/lib/config/evalRoots';
import { resolveCodeFnMapForStoredTestCases, resolveTestCaseSources } from '@/services/sourceResolver';
import type { TestCase } from '@/types';

const mockLoad = loadTestCasesFromModule as jest.Mock;
const mockDebug = debug as jest.Mock;

function stored(id: string, name: string, sourceFile: string): TestCase {
  return { id, name, sourceFile, currentVersion: 1, labels: [], context: [] } as unknown as TestCase;
}

describe('sourceResolver × eval roots', () => {
  let tmp: string;
  let cwd: string;
  let evalRepo: string;
  const REL = 'dist/suite.eval.js';
  const originalCwd = process.cwd();
  const originalEnv = process.env[EVAL_ROOTS_ENV];

  beforeAll(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'ah-sr-eval-roots-'));
    cwd = path.join(tmp, 'agent-health-checkout');
    evalRepo = path.join(tmp, 'eval-repo');
    mkdirSync(cwd, { recursive: true });
    mkdirSync(path.join(evalRepo, 'dist'), { recursive: true });
    writeFileSync(path.join(evalRepo, REL), '// suite');
    process.chdir(cwd);
  });

  afterAll(() => {
    process.chdir(originalCwd);
    rmSync(tmp, { recursive: true, force: true });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    __resetEvalRootsForTests();
    if (originalEnv === undefined) delete process.env[EVAL_ROOTS_ENV];
    else process.env[EVAL_ROOTS_ENV] = originalEnv;
  });

  describe('resolveCodeFnMapForStoredTestCases (stored-case re-materialization)', () => {
    it('loads the file from the eval root that contains it and keys the join on the stored relative path', async () => {
      process.env[EVAL_ROOTS_ENV] = evalRepo;
      const body = jest.fn();
      mockLoad.mockResolvedValue({
        filePath: path.join(evalRepo, REL),
        testCases: [{ name: 'passes', evaluate: body, benchmarkPath: 'Suite' }],
        hooks: [],
      });

      const r = await resolveCodeFnMapForStoredTestCases([stored('tc-1', 'passes', REL)]);

      expect(mockLoad).toHaveBeenCalledWith(path.join(evalRepo, REL)); // absolute, under the ROOT — not cwd
      expect(r.evaluateFnMap.get('tc-1')).toBe(body);
      expect(r.testHookScopes.get('tc-1')).toEqual({ sourceFile: path.join(evalRepo, REL), describePath: 'Suite' });
    });

    it('config evalRoots (code-first bridge) are honoured when the env var is unset', async () => {
      setConfiguredEvalRoots([evalRepo]);
      mockLoad.mockResolvedValue({ filePath: path.join(evalRepo, REL), testCases: [{ name: 'x', evaluate: jest.fn() }], hooks: [] });
      const r = await resolveCodeFnMapForStoredTestCases([stored('tc-1', 'x', REL)]);
      expect(mockLoad).toHaveBeenCalledWith(path.join(evalRepo, REL));
      expect(r.evaluateFnMap.size).toBe(1);
    });

    it('with no roots configured the default root is cwd: a file that lives elsewhere is not loaded and the debug log names the roots tried', async () => {
      const r = await resolveCodeFnMapForStoredTestCases([stored('tc-1', 'passes', REL)]);
      expect(mockLoad).not.toHaveBeenCalled();
      expect(r.evaluateFnMap.size).toBe(0);
      const msg = mockDebug.mock.calls.map(c => String(c[1])).find(m => m.includes('Failed to re-resolve'));
      expect(msg).toContain(REL);
      expect(msg).toContain(`not found under eval roots ${JSON.stringify(cwd)}`);
    });

    it('multi-root: first hit wins', async () => {
      const other = path.join(tmp, 'other-root');
      mkdirSync(path.join(other, 'dist'), { recursive: true });
      writeFileSync(path.join(other, REL), '// other');
      process.env[EVAL_ROOTS_ENV] = [other, evalRepo].join(path.delimiter);
      mockLoad.mockResolvedValue({ filePath: path.join(other, REL), testCases: [], hooks: [] });
      await resolveCodeFnMapForStoredTestCases([stored('tc-1', 'x', REL)]);
      expect(mockLoad).toHaveBeenCalledWith(path.join(other, REL));
    });

    it('absolute stored sourceFiles keep working without any root', async () => {
      const abs = path.join(evalRepo, REL);
      mockLoad.mockResolvedValue({ filePath: abs, testCases: [{ name: 'x', evaluate: jest.fn() }], hooks: [] });
      const r = await resolveCodeFnMapForStoredTestCases([stored('tc-1', 'x', abs)]);
      expect(mockLoad).toHaveBeenCalledWith(abs);
      expect(r.evaluateFnMap.size).toBe(1);
    });
  });

  describe('code-import source (fresh import)', () => {
    function storage() {
      return {
        testCases: {
          bulkUpsert: jest.fn(async (input: any[]) => ({
            created: input.length, updated: 0, unchanged: 0,
            testCases: input.map((tc, i) => ({ ...tc, id: `tc-${i}` })),
          })),
        },
      } as any;
    }

    it('resolves a relative filename under the eval roots and persists the ROOT-relative sourceFile (+ describePath)', async () => {
      process.env[EVAL_ROOTS_ENV] = evalRepo;
      mockLoad.mockResolvedValue({
        filePath: path.join(evalRepo, REL),
        fileSource: '// suite',
        testCases: [{ name: 'grouped', options: { prompt: 'p', labels: [] }, evaluate: jest.fn(), hash: 'h', describePath: ['Suite', 'Inner'] }],
        hooks: [],
      });
      const s = storage();
      const r = await resolveTestCaseSources([{ type: 'code-import', filenames: [REL], testCaseIds: [] }], s);
      expect(mockLoad).toHaveBeenCalledWith(path.join(evalRepo, REL));
      const upserted = s.testCases.bulkUpsert.mock.calls[0][0][0];
      expect(upserted.sourceFile).toBe(REL); // relative to the ROOT, not `../eval-repo/dist/...` from cwd
      expect(upserted.describePath).toEqual(['Suite', 'Inner']);
      expect(r.evaluateFnMap.size).toBe(1);
    });

    it('a filename under no root → "Code file not found" naming the roots tried (no silent fall-through)', async () => {
      await expect(
        resolveTestCaseSources([{ type: 'code-import', filenames: ['dist/missing.eval.js'], testCaseIds: [] }], storage()),
      ).rejects.toThrow(`Code file not found: dist/missing.eval.js (looked under eval roots ${JSON.stringify(cwd)})`);
      expect(mockLoad).not.toHaveBeenCalled();
    });
  });
});
