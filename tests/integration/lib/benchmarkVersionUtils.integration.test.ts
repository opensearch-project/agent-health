/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for benchmark version utilities
 *
 * These tests verify the end-to-end workflow of version data computation
 * and filtering, simulating real-world scenarios.
 */

import {
  computeVersionData,
  getSelectedVersionData,
  getVersionTestCases,
  filterRunsByVersion,
  VersionData,
} from '@/lib/benchmarkVersionUtils';
import type { Benchmark, BenchmarkRun, TestCase } from '@/types';

describe('BenchmarkVersionUtils Integration', () => {
  // Realistic multi-version benchmark scenario
  const testCases: TestCase[] = [
    {
      id: 'tc-rca-1',
      name: 'RCA for Node CPU Spike',
      description: 'Diagnose root cause of CPU spike on node',
      labels: ['category:RCA', 'difficulty:Medium'],
      category: 'RCA',
      difficulty: 'Medium',
      currentVersion: 1,
      versions: [],
      isPromoted: true,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      initialPrompt: 'Why is CPU high on node-1?',
      context: [],
    },
    {
      id: 'tc-rca-2',
      name: 'RCA for Memory Leak',
      description: 'Identify memory leak source',
      labels: ['category:RCA', 'difficulty:Hard'],
      category: 'RCA',
      difficulty: 'Hard',
      currentVersion: 1,
      versions: [],
      isPromoted: true,
      createdAt: '2026-01-02T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
      initialPrompt: 'Find the memory leak',
      context: [],
    },
    {
      id: 'tc-query-1',
      name: 'Simple PPL Query',
      description: 'Parse and execute basic PPL',
      labels: ['category:Queries', 'difficulty:Easy'],
      category: 'Conversational Queries',
      difficulty: 'Easy',
      currentVersion: 1,
      versions: [],
      isPromoted: true,
      createdAt: '2026-01-03T00:00:00Z',
      updatedAt: '2026-01-03T00:00:00Z',
      initialPrompt: 'Show me top 10 errors',
      context: [],
    },
    {
      id: 'tc-query-2',
      name: 'Complex PPL Query',
      description: 'Parse complex PPL with joins',
      labels: ['category:Queries', 'difficulty:Hard'],
      category: 'Conversational Queries',
      difficulty: 'Hard',
      currentVersion: 1,
      versions: [],
      isPromoted: true,
      createdAt: '2026-01-04T00:00:00Z',
      updatedAt: '2026-01-04T00:00:00Z',
      initialPrompt: 'Join logs with traces',
      context: [],
    },
  ];

  const benchmark: Benchmark = {
    id: 'bench-integration-test',
    name: 'Agent Performance Benchmark',
    description: 'Full benchmark with multiple versions',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-20T00:00:00Z',
    currentVersion: 3,
    testCaseIds: ['tc-rca-1', 'tc-rca-2', 'tc-query-2'], // v3: removed tc-query-1, kept others
    versions: [
      {
        version: 1,
        createdAt: '2026-01-01T00:00:00Z',
        testCaseIds: ['tc-rca-1', 'tc-query-1'], // Initial: 2 test cases
      },
      {
        version: 2,
        createdAt: '2026-01-10T00:00:00Z',
        testCaseIds: ['tc-rca-1', 'tc-rca-2', 'tc-query-1', 'tc-query-2'], // Added 2 more
      },
      {
        version: 3,
        createdAt: '2026-01-20T00:00:00Z',
        testCaseIds: ['tc-rca-1', 'tc-rca-2', 'tc-query-2'], // Removed tc-query-1
      },
    ],
    runs: [
      // v1 runs
      {
        id: 'run-v1-baseline',
        name: 'v1 Baseline',
        createdAt: '2026-01-02T10:00:00Z',
        agentKey: 'mlcommons',
        modelId: 'claude-3-sonnet',
        benchmarkVersion: 1,
        results: {
          'tc-rca-1': { reportId: 'report-1', status: 'completed' },
          'tc-query-1': { reportId: 'report-2', status: 'completed' },
        },
      },
      {
        id: 'run-v1-retry',
        name: 'v1 Retry Run',
        createdAt: '2026-01-03T14:00:00Z',
        agentKey: 'mlcommons',
        modelId: 'claude-3-sonnet',
        benchmarkVersion: 1,
        results: {
          'tc-rca-1': { reportId: 'report-3', status: 'completed' },
          'tc-query-1': { reportId: 'report-4', status: 'completed' },
        },
      },
      // v2 runs
      {
        id: 'run-v2-new-tests',
        name: 'v2 With New Tests',
        createdAt: '2026-01-11T09:00:00Z',
        agentKey: 'mlcommons',
        modelId: 'claude-4',
        benchmarkVersion: 2,
        results: {
          'tc-rca-1': { reportId: 'report-5', status: 'completed' },
          'tc-rca-2': { reportId: 'report-6', status: 'completed' },
          'tc-query-1': { reportId: 'report-7', status: 'completed' },
          'tc-query-2': { reportId: 'report-8', status: 'completed' },
        },
      },
      // v3 runs
      {
        id: 'run-v3-refined',
        name: 'v3 Refined Suite',
        createdAt: '2026-01-21T11:00:00Z',
        agentKey: 'mlcommons',
        modelId: 'claude-4',
        benchmarkVersion: 3,
        results: {
          'tc-rca-1': { reportId: 'report-9', status: 'completed' },
          'tc-rca-2': { reportId: 'report-10', status: 'completed' },
          'tc-query-2': { reportId: 'report-11', status: 'completed' },
        },
      },
      {
        id: 'run-v3-comparison',
        name: 'v3 Model Comparison',
        createdAt: '2026-01-22T16:00:00Z',
        agentKey: 'mlcommons',
        modelId: 'claude-opus',
        benchmarkVersion: 3,
        results: {
          'tc-rca-1': { reportId: 'report-12', status: 'completed' },
          'tc-rca-2': { reportId: 'report-13', status: 'completed' },
          'tc-query-2': { reportId: 'report-14', status: 'completed' },
        },
      },
    ],
  };

  describe('Full workflow: Viewing test cases for different versions', () => {
    let versionData: VersionData[];

    beforeAll(() => {
      versionData = computeVersionData(benchmark);
    });

    it('should compute version data with correct diff information', () => {
      expect(versionData).toHaveLength(3);

      // v3 (latest)
      const v3 = versionData[0];
      expect(v3.version).toBe(3);
      expect(v3.isLatest).toBe(true);
      expect(v3.testCaseIds).toHaveLength(3);
      expect(v3.added).toEqual([]); // No new additions in v3
      expect(v3.removed).toEqual(['tc-query-1']); // Removed tc-query-1
      expect(v3.runCount).toBe(2);

      // v2
      const v2 = versionData[1];
      expect(v2.version).toBe(2);
      expect(v2.isLatest).toBe(false);
      expect(v2.testCaseIds).toHaveLength(4);
      expect(v2.added.sort()).toEqual(['tc-query-2', 'tc-rca-2'].sort()); // Added 2 test cases
      expect(v2.removed).toEqual([]); // No removals
      expect(v2.runCount).toBe(1);

      // v1
      const v1 = versionData[2];
      expect(v1.version).toBe(1);
      expect(v1.isLatest).toBe(false);
      expect(v1.testCaseIds).toHaveLength(2);
      expect(v1.added).toEqual([]); // First version, no previous to compare
      expect(v1.removed).toEqual([]);
      expect(v1.runCount).toBe(2);
    });

    it('should get test cases for v3 (latest)', () => {
      const selectedVersion = getSelectedVersionData(versionData, null);
      const testCasesForVersion = getVersionTestCases(testCases, selectedVersion);

      expect(testCasesForVersion).toHaveLength(3);
      expect(testCasesForVersion.map(tc => tc.id).sort()).toEqual([
        'tc-query-2',
        'tc-rca-1',
        'tc-rca-2',
      ].sort());
    });

    it('should get test cases for v2 (includes removed tc-query-1)', () => {
      const selectedVersion = getSelectedVersionData(versionData, 2);
      const testCasesForVersion = getVersionTestCases(testCases, selectedVersion);

      expect(testCasesForVersion).toHaveLength(4);
      expect(testCasesForVersion.map(tc => tc.id).sort()).toEqual([
        'tc-query-1',
        'tc-query-2',
        'tc-rca-1',
        'tc-rca-2',
      ].sort());
    });

    it('should get test cases for v1 (original minimal set)', () => {
      const selectedVersion = getSelectedVersionData(versionData, 1);
      const testCasesForVersion = getVersionTestCases(testCases, selectedVersion);

      expect(testCasesForVersion).toHaveLength(2);
      expect(testCasesForVersion.map(tc => tc.id).sort()).toEqual([
        'tc-query-1',
        'tc-rca-1',
      ].sort());
    });
  });

  describe('Full workflow: Filtering runs by version', () => {
    it('should return all runs when filtering by "all"', () => {
      const runs = filterRunsByVersion(benchmark.runs, 'all');
      expect(runs).toHaveLength(5);

      // Verify sorted by date (newest first)
      expect(runs[0].id).toBe('run-v3-comparison'); // 2026-01-22
      expect(runs[1].id).toBe('run-v3-refined'); // 2026-01-21
      expect(runs[2].id).toBe('run-v2-new-tests'); // 2026-01-11
      expect(runs[3].id).toBe('run-v1-retry'); // 2026-01-03
      expect(runs[4].id).toBe('run-v1-baseline'); // 2026-01-02
    });

    it('should filter runs by v1', () => {
      const runs = filterRunsByVersion(benchmark.runs, 1);
      expect(runs).toHaveLength(2);
      expect(runs.every(r => r.benchmarkVersion === 1)).toBe(true);
      expect(runs[0].id).toBe('run-v1-retry'); // Newer first
      expect(runs[1].id).toBe('run-v1-baseline');
    });

    it('should filter runs by v2', () => {
      const runs = filterRunsByVersion(benchmark.runs, 2);
      expect(runs).toHaveLength(1);
      expect(runs[0].id).toBe('run-v2-new-tests');
    });

    it('should filter runs by v3', () => {
      const runs = filterRunsByVersion(benchmark.runs, 3);
      expect(runs).toHaveLength(2);
      expect(runs.every(r => r.benchmarkVersion === 3)).toBe(true);
      expect(runs[0].id).toBe('run-v3-comparison'); // Newer first
      expect(runs[1].id).toBe('run-v3-refined');
    });
  });

  describe('Edge case: Benchmark with no versions', () => {
    it('should handle benchmark without versions array', () => {
      const emptyBenchmark: Benchmark = {
        ...benchmark,
        versions: [],
        runs: [],
      };

      const versionData = computeVersionData(emptyBenchmark);
      expect(versionData).toEqual([]);

      const selectedVersion = getSelectedVersionData(versionData, null);
      expect(selectedVersion).toBeNull();

      const testCasesForVersion = getVersionTestCases(testCases, selectedVersion);
      expect(testCasesForVersion).toEqual([]);
    });
  });

  describe('Edge case: Single version benchmark', () => {
    it('should correctly handle single version benchmark', () => {
      const singleVersionBenchmark: Benchmark = {
        id: 'bench-single',
        name: 'Single Version Benchmark',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        currentVersion: 1,
        testCaseIds: ['tc-rca-1'],
        versions: [
          {
            version: 1,
            createdAt: '2026-01-01T00:00:00Z',
            testCaseIds: ['tc-rca-1'],
          },
        ],
        runs: [
          {
            id: 'run-1',
            name: 'Only Run',
            createdAt: '2026-01-02T00:00:00Z',
            agentKey: 'test',
            modelId: 'test',
            benchmarkVersion: 1,
            results: {},
          },
        ],
      };

      const versionData = computeVersionData(singleVersionBenchmark);
      expect(versionData).toHaveLength(1);
      expect(versionData[0].isLatest).toBe(true);
      expect(versionData[0].added).toEqual([]);
      expect(versionData[0].removed).toEqual([]);
      expect(versionData[0].runCount).toBe(1);
    });
  });

  describe('Edge case: Legacy runs without benchmarkVersion', () => {
    it('should treat legacy runs as version 1', () => {
      const legacyBenchmark: Benchmark = {
        id: 'bench-legacy',
        name: 'Legacy Benchmark',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        currentVersion: 1,
        testCaseIds: ['tc-rca-1'],
        versions: [
          {
            version: 1,
            createdAt: '2026-01-01T00:00:00Z',
            testCaseIds: ['tc-rca-1'],
          },
        ],
        runs: [
          {
            id: 'run-legacy',
            name: 'Legacy Run',
            createdAt: '2026-01-02T00:00:00Z',
            agentKey: 'test',
            modelId: 'test',
            // No benchmarkVersion - legacy data
            results: {},
          } as BenchmarkRun,
        ],
      };

      const versionData = computeVersionData(legacyBenchmark);
      expect(versionData[0].runCount).toBe(1); // Legacy run counted as v1

      const runs = filterRunsByVersion(legacyBenchmark.runs, 1);
      expect(runs).toHaveLength(1);
      expect(runs[0].id).toBe('run-legacy');
    });
  });
});
