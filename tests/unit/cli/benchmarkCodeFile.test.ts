/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

jest.mock('chalk', () => ({
  default: { cyan: (s: string) => s, red: (s: string) => s, green: (s: string) => s, gray: (s: string) => s, yellow: (s: string) => s, bold: (s: string) => s },
  cyan: (s: string) => s, red: (s: string) => s, green: (s: string) => s, gray: (s: string) => s, yellow: (s: string) => s, bold: (s: string) => s,
}));
jest.mock('ora', () => () => ({ start: jest.fn().mockReturnThis(), succeed: jest.fn(), fail: jest.fn(), warn: jest.fn(), info: jest.fn(), text: '' }));
jest.mock('cli-table3', () => jest.fn().mockImplementation(() => ({ push: jest.fn(), toString: () => '' })));
jest.mock('fs', () => ({ readFileSync: jest.fn(), writeFileSync: jest.fn(), existsSync: jest.fn(), statSync: jest.fn() }));
jest.mock('@/lib/config/index.js', () => ({ loadConfig: jest.fn(), DEFAULT_SERVER_CONFIG: {} }));
jest.mock('@/cli/utils/serverLifecycle.js', () => ({ ensureServer: jest.fn(), createServerCleanup: jest.fn(), isServerRunning: jest.fn() }));
jest.mock('@/cli/utils/apiClient.js', () => ({ ApiClient: jest.fn() }));
jest.mock('@/lib/testCaseValidation.js', () => ({ validateTestCasesArrayJson: jest.fn() }));
jest.mock('@/lib/runStats.js', () => ({ calculateRunStats: jest.fn(), getReportIdsFromRun: jest.fn() }));
jest.mock('@/cli/utils/formatOutput.js', () => ({ formatJson: jest.fn(), formatMarkdownTable: jest.fn(), parseOutputFormat: jest.fn(), OUTPUT_FORMAT_DESCRIPTION: '' }));
jest.mock('@/lib/testCases/loader.js', () => ({ isCodeFile: jest.requireActual('@/lib/testCases/loader').isCodeFile }));

import { isFilePath, buildFileSources } from '@/cli/commands/benchmark';

describe('isFilePath - code file detection', () => {
  it('returns true for .json files', () => {
    expect(isFilePath('test-cases.json')).toBe(true);
    expect(isFilePath('/path/to/data.json')).toBe(true);
  });

  it('returns true for .ts files', () => {
    expect(isFilePath('evals.eval.ts')).toBe(true);
    expect(isFilePath('/path/to/tests.ts')).toBe(true);
  });

  it('returns true for .js files', () => {
    expect(isFilePath('evals.js')).toBe(true);
    expect(isFilePath('/path/to/tests.eval.js')).toBe(true);
  });

  it('returns true for .mjs files', () => {
    expect(isFilePath('module.mjs')).toBe(true);
    expect(isFilePath('/path/to/evals.mjs')).toBe(true);
  });

  it('returns false for benchmark names', () => {
    expect(isFilePath('My Benchmark')).toBe(false);
    expect(isFilePath('baseline-v2')).toBe(false);
    expect(isFilePath('demo-security')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isFilePath('data.JSON')).toBe(true);
    expect(isFilePath('evals.TS')).toBe(true);
    expect(isFilePath('test.JS')).toBe(true);
    expect(isFilePath('mod.MJS')).toBe(true);
  });
});

describe('buildFileSources — code vs JSON routing (#245/#246)', () => {
  it('routes .eval.js/.ts/.mjs to code-import (executes bodies)', () => {
    const sources = buildFileSources(['a.eval.js', 'b.eval.ts', 'c.eval.mjs']);
    expect(sources).toEqual([
      { type: 'code-import', filenames: ['a.eval.js', 'b.eval.ts', 'c.eval.mjs'], testCaseIds: [] },
    ]);
  });

  it('routes .json to file-import (static data)', () => {
    const sources = buildFileSources(['cases.json']);
    expect(sources).toEqual([
      { type: 'file-import', filenames: ['cases.json'], testCaseIds: [] },
    ]);
  });

  it('splits a mixed batch into both source types', () => {
    const sources = buildFileSources(['x.eval.js', 'data.json']);
    expect(sources).toContainEqual({ type: 'code-import', filenames: ['x.eval.js'], testCaseIds: [] });
    expect(sources).toContainEqual({ type: 'file-import', filenames: ['data.json'], testCaseIds: [] });
  });

  it('returns no sources for an empty file list', () => {
    expect(buildFileSources([])).toEqual([]);
  });
});
