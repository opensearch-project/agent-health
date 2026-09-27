/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Benchmark } from '@/types/index.js';
import {
  QUICK_MODE_BENCHMARK_DESCRIPTION,
  QUICK_MODE_BENCHMARK_NAME,
  resolveQuickModeBenchmark,
  sameTestCaseSet,
  type QuickModeBenchmarkApi,
} from '@/cli/utils/quickModeBenchmark.js';

function makeBenchmark(overrides: Partial<Benchmark> = {}): Benchmark {
  return {
    id: 'bench-quick',
    name: QUICK_MODE_BENCHMARK_NAME,
    description: QUICK_MODE_BENCHMARK_DESCRIPTION,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    currentVersion: 1,
    versions: [],
    testCaseIds: ['tc-1', 'tc-2'],
    runs: [],
    ...overrides,
  };
}

function makeApi(overrides: Partial<jest.Mocked<QuickModeBenchmarkApi>> = {}) {
  return {
    findBenchmarkDetailed: jest.fn().mockResolvedValue({ benchmark: null, ambiguousMatches: [] }),
    createBenchmark: jest.fn(),
    updateBenchmark: jest.fn(),
    ...overrides,
  } as jest.Mocked<QuickModeBenchmarkApi>;
}

describe('quick-mode stable benchmark', () => {
  it('uses a fixed, human-readable name (never a timestamp)', () => {
    expect(QUICK_MODE_BENCHMARK_NAME).toBe('Quick run — all test cases');
    expect(QUICK_MODE_BENCHMARK_NAME).not.toMatch(/\d{10,}/);
  });

  describe('sameTestCaseSet', () => {
    it('is order- and duplicate-insensitive', () => {
      expect(sameTestCaseSet(['b', 'a'], ['a', 'b'])).toBe(true);
      expect(sameTestCaseSet(['a', 'a', 'b'], ['a', 'b'])).toBe(true);
      expect(sameTestCaseSet(undefined, [])).toBe(true);
    });

    it('detects added and removed ids', () => {
      expect(sameTestCaseSet(['a'], ['a', 'b'])).toBe(false);
      expect(sameTestCaseSet(['a', 'b'], ['a'])).toBe(false);
      expect(sameTestCaseSet(undefined, ['a'])).toBe(false);
    });
  });

  describe('resolveQuickModeBenchmark', () => {
    it('creates the benchmark (once, under the stable name, with the full sorted set) when nothing matches', async () => {
      const created = makeBenchmark();
      const api = makeApi({ createBenchmark: jest.fn().mockResolvedValue(created) });

      const result = await resolveQuickModeBenchmark(api, ['tc-2', 'tc-1', 'tc-2']);

      expect(api.findBenchmarkDetailed).toHaveBeenCalledWith(QUICK_MODE_BENCHMARK_NAME);
      expect(api.createBenchmark).toHaveBeenCalledTimes(1);
      expect(api.createBenchmark).toHaveBeenCalledWith({
        name: QUICK_MODE_BENCHMARK_NAME,
        description: QUICK_MODE_BENCHMARK_DESCRIPTION,
        testCaseIds: ['tc-1', 'tc-2'],
      });
      expect(api.updateBenchmark).not.toHaveBeenCalled();
      expect(result).toEqual({ outcome: 'created', benchmark: created });
    });

    it('reuses an existing benchmark untouched when its case set already equals the stored set (any order)', async () => {
      const existing = makeBenchmark({ testCaseIds: ['tc-2', 'tc-1'] });
      const api = makeApi({
        findBenchmarkDetailed: jest.fn().mockResolvedValue({ benchmark: existing, ambiguousMatches: [] }),
      });

      const result = await resolveQuickModeBenchmark(api, ['tc-1', 'tc-2']);

      expect(api.createBenchmark).not.toHaveBeenCalled();
      expect(api.updateBenchmark).not.toHaveBeenCalled();
      expect(result).toEqual({ outcome: 'reused', benchmark: existing, refreshed: false });
    });

    it('refreshes a drifted benchmark to the current full stored set via the update API', async () => {
      const stale = makeBenchmark({ testCaseIds: ['tc-1', 'tc-removed'] });
      const updated = makeBenchmark({ testCaseIds: ['tc-1', 'tc-2', 'tc-3'], currentVersion: 2 });
      const api = makeApi({
        findBenchmarkDetailed: jest.fn().mockResolvedValue({ benchmark: stale, ambiguousMatches: [] }),
        updateBenchmark: jest.fn().mockResolvedValue(updated),
      });

      const result = await resolveQuickModeBenchmark(api, ['tc-3', 'tc-1', 'tc-2']);

      expect(api.createBenchmark).not.toHaveBeenCalled();
      expect(api.updateBenchmark).toHaveBeenCalledWith('bench-quick', { testCaseIds: ['tc-1', 'tc-2', 'tc-3'] });
      expect(result).toEqual({ outcome: 'reused', benchmark: updated, refreshed: true });
    });

    it('reports ambiguity instead of guessing or creating a third near-duplicate', async () => {
      const a = makeBenchmark({ id: 'bench-a', name: 'quick run — all test cases' });
      const b = makeBenchmark({ id: 'bench-b', name: 'Quick Run — All Test Cases ' });
      const api = makeApi({
        findBenchmarkDetailed: jest.fn().mockResolvedValue({ benchmark: null, ambiguousMatches: [a, b] }),
      });

      const result = await resolveQuickModeBenchmark(api, ['tc-1']);

      expect(result).toEqual({ outcome: 'ambiguous', matches: [a, b] });
      expect(api.createBenchmark).not.toHaveBeenCalled();
      expect(api.updateBenchmark).not.toHaveBeenCalled();
    });

    it('propagates API failures (the caller reports and exits)', async () => {
      const api = makeApi({ createBenchmark: jest.fn().mockRejectedValue(new Error('boom')) });
      await expect(resolveQuickModeBenchmark(api, ['tc-1'])).rejects.toThrow('boom');
    });
  });
});
