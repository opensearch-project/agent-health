/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { resolveTestCaseSources } from '@/services/sourceResolver';
import type { TestCaseSource, TestCase } from '@/types';
import type { IStorageModule } from '@/server/adapters/types';

jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  statSync: jest.fn(),
  readdirSync: jest.fn(),
}));

jest.mock('path', () => ({
  join: jest.fn((...args: string[]) => args.join('/')),
  resolve: jest.fn((p: string) => p),
  relative: jest.fn((_from: string, to: string) => to),
  basename: jest.fn((p: string) => p.split('/').pop() || p),
}));

jest.mock('@/lib/testCaseValidation', () => ({
  validateTestCasesArrayJson: jest.fn(),
}));

jest.mock('@/lib/debug', () => ({
  debug: jest.fn(),
}));

jest.mock('@/lib/testCases/loader', () => ({
  loadTestCasesFromModule: jest.fn(),
  detectSourceLanguage: jest.fn((fileName: string) => {
    const lower = fileName.toLowerCase();
    return lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs') ? 'javascript' : 'typescript';
  }),
}));

import * as fs from 'fs';
import { loadTestCasesFromModule } from '@/lib/testCases/loader';

const mockFs = fs as jest.Mocked<typeof fs>;
const mockLoadModule = loadTestCasesFromModule as jest.Mock;

function makeTestCase(id: string, name = `Test Case ${id}`): TestCase {
  return {
    id,
    name,
    description: `Description for ${name}`,
    currentVersion: 1,
    versions: [],
    isPromoted: false,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    initialPrompt: 'Test prompt',
    context: [],
    expectedTrajectory: [],
    labels: [],
  } as unknown as TestCase;
}

function createMockStorage(): IStorageModule {
  return {
    testCases: {
      getById: jest.fn(),
      getAll: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      bulkCreate: jest.fn(),
      bulkUpsert: jest.fn(),
      search: jest.fn(),
      getVersionHistory: jest.fn(),
    },
    benchmarks: {
      getById: jest.fn(),
      getAll: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      bulkCreate: jest.fn(),
      getRun: jest.fn(),
      addRun: jest.fn(),
      updateRun: jest.fn(),
      deleteRun: jest.fn(),
    },
    runs: {
      getById: jest.fn(),
      getAll: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      bulkCreate: jest.fn(),
      getByBenchmarkRun: jest.fn(),
      countsByTestCase: jest.fn(),
      addAnnotation: jest.fn(),
      getAnnotations: jest.fn(),
    },
    analytics: {
      record: jest.fn(),
      query: jest.fn(),
    },
  } as unknown as IStorageModule;
}

describe('resolveTestCaseSources - code-import', () => {
  let storage: IStorageModule;

  beforeEach(() => {
    jest.clearAllMocks();
    storage = createMockStorage();
    mockFs.existsSync.mockReturnValue(true);
  });

  it('loads code test cases and returns evaluateFnMap', async () => {
    const evaluateFn = jest.fn();
    const tc1 = makeTestCase('code-tc-1', 'CyberGym Task 1');

    mockLoadModule.mockResolvedValue({
      testCases: [{
        name: 'CyberGym Task 1',
        options: { prompt: 'Exploit the vulnerability', category: 'Security', difficulty: 'Hard' },
        evaluate: evaluateFn,
        hash: 'abc123hash',
      }],
      filePath: '/path/to/evals.eval.ts',
    });

    (storage.testCases.bulkUpsert as jest.Mock).mockResolvedValue({
      created: 1,
      updated: 0,
      unchanged: 0,
      testCases: [tc1],
    });

    const sources: TestCaseSource[] = [
      { type: 'code-import', filenames: ['/path/to/evals.eval.ts'], testCaseIds: [] },
    ];
    const result = await resolveTestCaseSources(sources, storage);

    expect(result.testCases).toEqual([tc1]);
    expect(result.evaluateFnMap.size).toBe(1);
    expect(result.evaluateFnMap.get('code-tc-1')).toBe(evaluateFn);
    expect(result.sources[0]).toMatchObject({
      type: 'code-import',
      testCaseIds: ['code-tc-1'],
    });
  });

  it('passes sourceFile and sourceHash to bulkUpsert', async () => {
    const tc1 = makeTestCase('upserted-1');
    mockLoadModule.mockResolvedValue({
      testCases: [{
        name: 'Test',
        options: {
          prompt: 'Analyze',
          category: 'RCA',
          difficulty: 'Medium',
          fixture: {
            type: 'filesystem-workspace',
            ref: 'workspace',
            integrity: 'sha256:abc123',
            payload: { files: ['a.ts'] },
          },
        },
        evaluate: jest.fn(),
        hash: 'sha256hash',
      }],
      filePath: '/abs/path/tests.eval.ts',
    });

    (storage.testCases.bulkUpsert as jest.Mock).mockResolvedValue({
      created: 1,
      updated: 0,
      unchanged: 0,
      testCases: [tc1],
    });

    const sources: TestCaseSource[] = [
      { type: 'code-import', filenames: ['/abs/path/tests.eval.ts'], testCaseIds: [] },
    ];
    await resolveTestCaseSources(sources, storage);

    expect(storage.testCases.bulkUpsert).toHaveBeenCalledWith([
      expect.objectContaining({
        name: 'Test',
        initialPrompt: 'Analyze',
        fixture: {
          type: 'filesystem-workspace',
          ref: 'workspace',
          integrity: 'sha256:abc123',
          payload: { files: ['a.ts'] },
        },
        sourceFile: '/abs/path/tests.eval.ts',
        sourceHash: 'sha256hash',
      }),
    ]);
  });

  // Eval-source IDE view feature: the loader's fileSource (whole-file text)
  // must be forwarded as sourceCode on this import path too, not just the
  // CLI's file-mode path (cli/commands/benchmark.ts) -- resolveCodeImport is
  // a second, independent producer of upsert input for the same TestCase
  // shape (used by the server-side code-import job type).
  it('forwards sourceCode/sourceFileName/sourceLanguage from loader.fileSource to bulkUpsert', async () => {
    const tc1 = makeTestCase('upserted-source-1');
    mockLoadModule.mockResolvedValue({
      testCases: [{
        name: 'Test',
        options: { prompt: 'Analyze', category: 'RCA', difficulty: 'Medium' },
        evaluate: jest.fn(),
        hash: 'sha256hash',
      }],
      filePath: '/abs/path/tests.eval.ts',
      fileSource: "import { test } from '@opensearch-project/agent-health';\ntest('Test', () => {});\n",
    });

    (storage.testCases.bulkUpsert as jest.Mock).mockResolvedValue({
      created: 1,
      updated: 0,
      unchanged: 0,
      testCases: [tc1],
    });

    const sources: TestCaseSource[] = [
      { type: 'code-import', filenames: ['/abs/path/tests.eval.ts'], testCaseIds: [] },
    ];
    await resolveTestCaseSources(sources, storage);

    expect(storage.testCases.bulkUpsert).toHaveBeenCalledWith([
      expect.objectContaining({
        sourceCode: "import { test } from '@opensearch-project/agent-health';\ntest('Test', () => {});\n",
        sourceFileName: 'tests.eval.ts',
        sourceLanguage: 'typescript',
      }),
    ]);
  });

  it('handles multiple test cases from a single file', async () => {
    const evaluateFn1 = jest.fn();
    const evaluateFn2 = jest.fn();
    const tc1 = makeTestCase('multi-1');
    const tc2 = makeTestCase('multi-2');

    mockLoadModule.mockResolvedValue({
      testCases: [
        { name: 'Task 1', options: { prompt: 'P1', category: 'Security', difficulty: 'Easy' }, evaluate: evaluateFn1, hash: 'h1' },
        { name: 'Task 2', options: { prompt: 'P2', category: 'Security', difficulty: 'Hard' }, evaluate: evaluateFn2, hash: 'h2' },
      ],
      filePath: '/path/to/multi.eval.ts',
    });

    (storage.testCases.bulkUpsert as jest.Mock).mockResolvedValue({
      created: 2,
      updated: 0,
      unchanged: 0,
      testCases: [tc1, tc2],
    });

    const sources: TestCaseSource[] = [
      { type: 'code-import', filenames: ['/path/to/multi.eval.ts'], testCaseIds: [] },
    ];
    const result = await resolveTestCaseSources(sources, storage);

    expect(result.testCases).toHaveLength(2);
    expect(result.evaluateFnMap.size).toBe(2);
    expect(result.evaluateFnMap.get('multi-1')).toBe(evaluateFn1);
    expect(result.evaluateFnMap.get('multi-2')).toBe(evaluateFn2);
  });

  it('only maps evaluate functions for test cases that have one', async () => {
    const evaluateFn = jest.fn();
    const tc1 = makeTestCase('with-eval');
    const tc2 = makeTestCase('without-eval');

    mockLoadModule.mockResolvedValue({
      testCases: [
        { name: 'Has Eval', options: { prompt: 'P1', category: 'RCA', difficulty: 'Medium' }, evaluate: evaluateFn, hash: 'h1' },
        { name: 'No Eval', options: { prompt: 'P2', category: 'RCA', difficulty: 'Easy' }, evaluate: undefined, hash: 'h2' },
      ],
      filePath: '/path/to/mixed.eval.ts',
    });

    (storage.testCases.bulkUpsert as jest.Mock).mockResolvedValue({
      created: 2,
      updated: 0,
      unchanged: 0,
      testCases: [tc1, tc2],
    });

    const sources: TestCaseSource[] = [
      { type: 'code-import', filenames: ['/path/to/mixed.eval.ts'], testCaseIds: [] },
    ];
    const result = await resolveTestCaseSources(sources, storage);

    expect(result.evaluateFnMap.size).toBe(1);
    expect(result.evaluateFnMap.has('with-eval')).toBe(true);
    expect(result.evaluateFnMap.has('without-eval')).toBe(false);
  });

  it('handles multiple files in a single code-import source', async () => {
    const tc1 = makeTestCase('file1-tc');
    const tc2 = makeTestCase('file2-tc');

    mockLoadModule
      .mockResolvedValueOnce({
        testCases: [{ name: 'F1', options: { prompt: 'P1', category: 'RCA', difficulty: 'Easy' }, evaluate: jest.fn(), hash: 'hash1' }],
        filePath: '/path/file1.eval.ts',
      })
      .mockResolvedValueOnce({
        testCases: [{ name: 'F2', options: { prompt: 'P2', category: 'RCA', difficulty: 'Hard' }, evaluate: jest.fn(), hash: 'hash2' }],
        filePath: '/path/file2.eval.ts',
      });

    (storage.testCases.bulkUpsert as jest.Mock)
      .mockResolvedValueOnce({ created: 1, updated: 0, unchanged: 0, testCases: [tc1] })
      .mockResolvedValueOnce({ created: 1, updated: 0, unchanged: 0, testCases: [tc2] });

    mockFs.existsSync.mockReturnValue(true);

    const sources: TestCaseSource[] = [
      { type: 'code-import', filenames: ['/path/file1.eval.ts', '/path/file2.eval.ts'], testCaseIds: [] },
    ];
    const result = await resolveTestCaseSources(sources, storage);

    expect(result.testCases).toHaveLength(2);
    expect(result.evaluateFnMap.size).toBe(2);
  });

  it('returns empty evaluateFnMap for non-code sources', async () => {
    const tc1 = makeTestCase('tc-1');
    (storage.testCases.getById as jest.Mock).mockResolvedValue(tc1);

    const sources: TestCaseSource[] = [
      { type: 'test-case-ids', ids: ['tc-1'] },
    ];
    const result = await resolveTestCaseSources(sources, storage);

    expect(result.evaluateFnMap.size).toBe(0);
  });
});
