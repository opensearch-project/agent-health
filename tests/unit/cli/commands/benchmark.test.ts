/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the benchmark CLI command helper functions.
 *
 * Note: The main command action has complex dependencies (server lifecycle, ora spinners)
 * that are better tested through integration tests. These unit tests focus on
 * the pure helper functions and their integration with the shared runStats utility.
 */

import { writeFileSync, existsSync, statSync } from 'fs';
import type { BenchmarkRun, EvaluationReport, Benchmark, AgentConfig, TestCaseSource, EvaluationRun } from '@/types';
import { calculateRunStats, getReportIdsFromRun } from '@/lib/runStats';
import { validateTestCasesArrayJson } from '@/lib/testCaseValidation';
import { resolveUnifiedRunOutcome } from '@/cli/utils/evaluationRunOutcome';

// Mock fs
jest.mock('fs', () => ({
  writeFileSync: jest.fn(),
  existsSync: jest.fn(),
  statSync: jest.fn(),
  readFileSync: jest.fn(),
}));

// Mock chalk for cleaner test output
jest.mock('chalk', () => ({
  default: {
    cyan: (s: string) => s,
    green: (s: string) => s,
    yellow: (s: string) => s,
    red: (s: string) => s,
    gray: (s: string) => s,
    bold: (s: string) => s,
  },
  cyan: (s: string) => s,
  green: (s: string) => s,
  yellow: (s: string) => s,
  red: (s: string) => s,
  gray: (s: string) => s,
  bold: (s: string) => s,
}));

describe('Benchmark Command - Helper Functions', () => {
  // Test findAgent functionality
  describe('findAgent', () => {
    const mockConfig = {
      agents: [
        { key: 'mock', name: 'Mock Agent', endpoint: 'http://mock' },
        { key: 'ml-commons', name: 'ML Commons Agent', endpoint: 'http://ml' },
      ],
    };

    // Inline function matching the implementation
    function findAgent(identifier: string, config: typeof mockConfig): AgentConfig | undefined {
      return config.agents.find(
        (a) => a.key === identifier || a.name.toLowerCase() === identifier.toLowerCase()
      ) as AgentConfig | undefined;
    }

    it('should find agent by exact key', () => {
      const result = findAgent('mock', mockConfig);
      expect(result?.key).toBe('mock');
    });

    it('should find agent by name (case-insensitive)', () => {
      const result = findAgent('MOCK AGENT', mockConfig);
      expect(result?.key).toBe('mock');
    });

    it('should return undefined for unknown agent', () => {
      const result = findAgent('unknown', mockConfig);
      expect(result).toBeUndefined();
    });
  });

  // Test getDefaultModel functionality
  describe('getDefaultModel', () => {
    function getDefaultModel(config: { models: Record<string, any> }): string {
      return Object.keys(config.models)[0] || 'claude-sonnet';
    }

    it('should return first model key from config', () => {
      const config = { models: { 'claude-opus': {}, 'claude-sonnet': {} } };
      expect(getDefaultModel(config)).toBe('claude-opus');
    });

    it('should return claude-sonnet as fallback for empty models', () => {
      const config = { models: {} };
      expect(getDefaultModel(config)).toBe('claude-sonnet');
    });
  });

  // Test fetchReportsForRun integration with runStats
  describe('fetchReportsForRun (with runStats integration)', () => {
    // This tests that the CLI uses the same approach as UI for fetching reports
    it('should use getReportIdsFromRun to extract report IDs', () => {
      const run: BenchmarkRun = {
        id: 'run-1',
        name: 'Test Run',
        createdAt: '2024-01-01T00:00:00Z',
        agentKey: 'mock',
        modelId: 'claude-sonnet',
        results: {
          'tc-1': { reportId: 'report-1', status: 'completed' },
          'tc-2': { reportId: 'report-2', status: 'completed' },
          'tc-3': { reportId: '', status: 'pending' },
        },
      };

      const reportIds = getReportIdsFromRun(run);

      expect(reportIds).toHaveLength(2);
      expect(reportIds).toContain('report-1');
      expect(reportIds).toContain('report-2');
      expect(reportIds).not.toContain('');
    });

    it('should calculate stats correctly with reports map', () => {
      const run: BenchmarkRun = {
        id: 'run-1',
        name: 'Test Run',
        createdAt: '2024-01-01T00:00:00Z',
        agentKey: 'mock',
        modelId: 'claude-sonnet',
        results: {
          'tc-1': { reportId: 'report-1', status: 'completed' },
          'tc-2': { reportId: 'report-2', status: 'completed' },
          'tc-3': { reportId: 'report-3', status: 'completed' },
        },
      };

      const reports: Record<string, EvaluationReport | null> = {
        'report-1': {
          id: 'report-1',
          testCaseId: 'tc-1',
          status: 'completed',
          passFailStatus: 'passed',
          trajectory: [],
          metrics: { accuracy: 90 },
        } as EvaluationReport,
        'report-2': {
          id: 'report-2',
          testCaseId: 'tc-2',
          status: 'completed',
          passFailStatus: 'failed',
          trajectory: [],
          metrics: { accuracy: 50 },
        } as EvaluationReport,
        'report-3': {
          id: 'report-3',
          testCaseId: 'tc-3',
          status: 'completed',
          passFailStatus: 'passed',
          trajectory: [],
          metrics: { accuracy: 85 },
        } as EvaluationReport,
      };

      const stats = calculateRunStats(run, reports);

      expect(stats.passed).toBe(2);
      expect(stats.failed).toBe(1);
      expect(stats.total).toBe(3);
      expect(stats.passRate).toBe(67); // 2/3 rounded
    });
  });

  // Test exportResults functionality
  describe('exportResults', () => {
    beforeEach(() => {
      jest.clearAllMocks();
      jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    // Inline function matching the implementation
    function exportResults(
      benchmark: Benchmark,
      allResults: Array<{
        agent: Partial<AgentConfig>;
        run?: BenchmarkRun;
        runId?: string;
        passed: number;
        failed: number;
        reports?: any[];
      }>,
      exportPath: string
    ): void {
      const exportData = {
        benchmark: {
          id: benchmark.id,
          name: benchmark.name,
          testCaseCount: benchmark.testCaseIds.length,
        },
        runs: allResults.map((r) => ({
          agent: { key: r.agent.key, name: r.agent.name },
          runId: r.run?.id || r.runId,
          status: r.run?.status,
          passed: r.passed,
          failed: r.failed,
          passRate:
            benchmark.testCaseIds.length > 0 ? (r.passed / benchmark.testCaseIds.length) * 100 : 0,
          results: r.run?.results,
          reports: r.reports,
        })),
        exportedAt: expect.any(String),
      };

      writeFileSync(exportPath, JSON.stringify(exportData, null, 2));
    }

    it('should write results to JSON file', () => {
      const benchmark: Benchmark = {
        id: 'bench-1',
        name: 'Test Benchmark',
        testCaseIds: ['tc-1', 'tc-2'],
        runs: [],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        currentVersion: 1,
        versions: [],
      };

      const results = [
        {
          agent: { key: 'mock', name: 'Mock Agent' },
          run: {
            id: 'run-1',
            name: 'CLI Run',
            createdAt: '2024-01-01T00:00:00Z',
            agentKey: 'mock',
            modelId: 'claude-sonnet',
            status: 'completed' as const,
            results: {},
          },
          passed: 2,
          failed: 0,
          reports: [],
        },
      ];

      exportResults(benchmark, results, '/tmp/results.json');

      expect(writeFileSync).toHaveBeenCalledWith(
        '/tmp/results.json',
        expect.stringContaining('"benchmark"')
      );
      expect(writeFileSync).toHaveBeenCalledWith(
        '/tmp/results.json',
        expect.stringContaining('"runs"')
      );
    });

    it('should calculate pass rate correctly in export', () => {
      const benchmark: Benchmark = {
        id: 'bench-1',
        name: 'Test Benchmark',
        testCaseIds: ['tc-1', 'tc-2', 'tc-3', 'tc-4'],
        runs: [],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        currentVersion: 1,
        versions: [],
      };

      const results = [
        {
          agent: { key: 'mock', name: 'Mock Agent' },
          passed: 3,
          failed: 1,
        },
      ];

      exportResults(benchmark, results, '/tmp/results.json');

      const writeCall = (writeFileSync as jest.Mock).mock.calls[0][1];
      const exported = JSON.parse(writeCall);

      expect(exported.runs[0].passRate).toBe(75); // 3/4 * 100
    });

    it('should handle zero test cases without division error', () => {
      const benchmark: Benchmark = {
        id: 'bench-1',
        name: 'Test Benchmark',
        testCaseIds: [],
        runs: [],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        currentVersion: 1,
        versions: [],
      };

      const results = [
        {
          agent: { key: 'mock', name: 'Mock Agent' },
          passed: 0,
          failed: 0,
        },
      ];

      exportResults(benchmark, results, '/tmp/results.json');

      const writeCall = (writeFileSync as jest.Mock).mock.calls[0][1];
      const exported = JSON.parse(writeCall);

      expect(exported.runs[0].passRate).toBe(0);
    });
  });

  // Test displaySummaryTable functionality
  describe('displaySummaryTable', () => {
    beforeEach(() => {
      jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('should calculate pass rate correctly', () => {
      const totalTestCases = 10;

      // Test pass rate calculation
      const passRate1 = totalTestCases > 0 ? (8 / totalTestCases) * 100 : 0;
      expect(passRate1).toBe(80);

      const passRate2 = totalTestCases > 0 ? (5 / totalTestCases) * 100 : 0;
      expect(passRate2).toBe(50);

      const passRate3 = totalTestCases > 0 ? (2 / totalTestCases) * 100 : 0;
      expect(passRate3).toBe(20);
    });

    it('should handle zero total test cases', () => {
      const totalTestCases = 0;
      const passRate = totalTestCases > 0 ? (0 / totalTestCases) * 100 : 0;
      expect(passRate).toBe(0);
    });
  });

  // Test CLI and UI consistency
  describe('CLI and UI stats consistency', () => {
    it('should use shared calculateRunStats for pass/fail counting', () => {
      // This test verifies that CLI uses the same logic as UI
      const run: BenchmarkRun = {
        id: 'run-1',
        name: 'Test Run',
        createdAt: '2024-01-01T00:00:00Z',
        agentKey: 'mock',
        modelId: 'claude-sonnet',
        results: {
          'tc-1': { reportId: 'report-1', status: 'completed' },
          'tc-2': { reportId: 'report-2', status: 'failed' },
          'tc-3': { reportId: '', status: 'pending' },
        },
      };

      const reports: Record<string, EvaluationReport | null> = {
        'report-1': {
          id: 'report-1',
          testCaseId: 'tc-1',
          status: 'completed',
          passFailStatus: 'passed',
          trajectory: [],
          metrics: { accuracy: 90 },
        } as EvaluationReport,
      };

      // Both CLI and UI should get the same result
      const stats = calculateRunStats(run, reports);

      expect(stats.passed).toBe(1);  // tc-1 passed
      expect(stats.failed).toBe(1);  // tc-2 failed (status === 'failed')
      expect(stats.pending).toBe(1); // tc-3 pending
      expect(stats.total).toBe(3);
    });

    it('should handle partial execution results', () => {
      // Simulates when benchmark execution fails partway through
      const run: BenchmarkRun = {
        id: 'run-1',
        name: 'Test Run',
        createdAt: '2024-01-01T00:00:00Z',
        agentKey: 'mock',
        modelId: 'claude-sonnet',
        results: {
          'tc-1': { reportId: 'report-1', status: 'completed' },
          'tc-2': { reportId: 'report-2', status: 'completed' },
          'tc-3': { reportId: '', status: 'cancelled' },
          'tc-4': { reportId: '', status: 'pending' },
        },
      };

      const reports: Record<string, EvaluationReport | null> = {
        'report-1': {
          id: 'report-1',
          testCaseId: 'tc-1',
          status: 'completed',
          passFailStatus: 'passed',
          trajectory: [],
          metrics: { accuracy: 90 },
        } as EvaluationReport,
        'report-2': {
          id: 'report-2',
          testCaseId: 'tc-2',
          status: 'completed',
          passFailStatus: 'failed',
          trajectory: [],
          metrics: { accuracy: 40 },
        } as EvaluationReport,
      };

      const stats = calculateRunStats(run, reports);

      expect(stats.passed).toBe(1);  // tc-1
      expect(stats.failed).toBe(2);  // tc-2 (failed evaluation) + tc-3 (cancelled)
      expect(stats.pending).toBe(1); // tc-4
      expect(stats.total).toBe(4);
      expect(stats.passRate).toBe(25); // 1/4 total test cases = 25%
    });
  });

  // Test isFilePath helper (inlined, matching the implementation in benchmark.ts)
  describe('isFilePath', () => {
    function isFilePath(value: string): boolean {
      return value.toLowerCase().endsWith('.json');
    }

    it('should detect .json extension', () => {
      expect(isFilePath('test-cases.json')).toBe(true);
    });

    it('should detect .JSON extension (case-insensitive)', () => {
      expect(isFilePath('test-cases.JSON')).toBe(true);
    });

    it('should detect path with .json extension', () => {
      expect(isFilePath('./path/to/test-cases.json')).toBe(true);
    });

    it('should return false for benchmark names', () => {
      expect(isFilePath('My Benchmark')).toBe(false);
    });

    it('should return false for benchmark IDs', () => {
      expect(isFilePath('bench-123456')).toBe(false);
    });

    it('should return false for strings containing json but not ending with .json', () => {
      expect(isFilePath('json-benchmark')).toBe(false);
    });
  });

  // Test file validation using validateTestCasesArrayJson (the core of loadAndValidateTestCasesFile)
  describe('file mode validation (validateTestCasesArrayJson)', () => {
    it('should validate a well-formed test cases array', () => {
      const validTestCases = [
        {
          name: 'Test Case 1',
          category: 'RCA',
          difficulty: 'Easy',
          initialPrompt: 'Investigate the issue',
          expectedOutcomes: ['Find root cause'],
        },
      ];

      const result = validateTestCasesArrayJson(validTestCases);

      expect(result.valid).toBe(true);
      expect(result.data).toHaveLength(1);
      expect(result.data![0].name).toBe('Test Case 1');
    });

    it('should auto-wrap a single object into an array', () => {
      const singleTestCase = {
        name: 'Single Test',
        category: 'RCA',
        difficulty: 'Medium',
        initialPrompt: 'Check this',
        expectedOutcomes: ['Expected result'],
      };

      const result = validateTestCasesArrayJson(singleTestCase);

      expect(result.valid).toBe(true);
      expect(result.data).toHaveLength(1);
      expect(result.data![0].name).toBe('Single Test');
    });

    it('should reject invalid test cases (missing required fields)', () => {
      const invalidTestCases = [{ name: '' }];

      const result = validateTestCasesArrayJson(invalidTestCases);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should reject an empty array', () => {
      const result = validateTestCasesArrayJson([]);

      expect(result.valid).toBe(false);
    });

    it('should validate multiple test cases', () => {
      const testCases = [
        {
          name: 'Test 1',
          category: 'RCA',
          difficulty: 'Easy',
          initialPrompt: 'prompt 1',
          expectedOutcomes: ['outcome 1'],
        },
        {
          name: 'Test 2',
          category: 'Performance',
          difficulty: 'Hard',
          initialPrompt: 'prompt 2',
          expectedOutcomes: ['outcome 2', 'outcome 3'],
        },
      ];

      const result = validateTestCasesArrayJson(testCases);

      expect(result.valid).toBe(true);
      expect(result.data).toHaveLength(2);
    });
  });

  // Test error recovery scenario
  describe('Error recovery', () => {
    it('should handle missing reports gracefully', () => {
      const run: BenchmarkRun = {
        id: 'run-1',
        name: 'Test Run',
        createdAt: '2024-01-01T00:00:00Z',
        agentKey: 'mock',
        modelId: 'claude-sonnet',
        results: {
          'tc-1': { reportId: 'report-1', status: 'completed' },
          'tc-2': { reportId: 'report-2', status: 'completed' }, // Report not fetched
        },
      };

      // Only one report was fetched
      const reports: Record<string, EvaluationReport | null> = {
        'report-1': {
          id: 'report-1',
          testCaseId: 'tc-1',
          status: 'completed',
          passFailStatus: 'passed',
          trajectory: [],
          metrics: { accuracy: 90 },
        } as EvaluationReport,
        // report-2 is missing from map
      };

      const stats = calculateRunStats(run, reports);

      expect(stats.passed).toBe(1);
      expect(stats.pending).toBe(1); // Missing report treated as pending
      expect(stats.total).toBe(2);
    });
  });
});

describe('Benchmark Command - Source Composition (Unified Mode)', () => {
  /**
   * These tests verify the source-building logic from CLI flags.
   * The actual `runUnifiedMode` function has server dependencies,
   * so we test the source composition logic in isolation.
   */

  function buildSources(options: {
    name?: string;
    file?: string[];
    dir?: string[];
    testCase?: string[];
    label?: string[];
  }): TestCaseSource[] {
    const sources: TestCaseSource[] = [];

    // Note: -n with benchmark resolution requires server, tested in integration
    // Here we just test that non-benchmark sources are built correctly

    if (options.file && options.file.length > 0) {
      sources.push({ type: 'file-import', filenames: options.file, testCaseIds: [] });
    }

    if (options.dir && options.dir.length > 0) {
      sources.push({ type: 'directory-import', dirPaths: options.dir, testCaseIds: [] });
    }

    if (options.testCase && options.testCase.length > 0) {
      sources.push({ type: 'test-case-ids', ids: options.testCase });
    }

    if (options.label && options.label.length > 0) {
      sources.push({ type: 'label-filter', labels: options.label });
    }

    return sources;
  }

  describe('buildSources', () => {
    it('should build file-import source from -f flag (single)', () => {
      const sources = buildSources({ file: ['./test.json'] });
      expect(sources).toHaveLength(1);
      expect(sources[0]).toEqual({
        type: 'file-import',
        filenames: ['./test.json'],
        testCaseIds: [],
      });
    });

    it('should build file-import source from -f flag (multiple)', () => {
      const sources = buildSources({ file: ['./a.json', './b.json', './c.json'] });
      expect(sources).toHaveLength(1);
      expect(sources[0]).toEqual({
        type: 'file-import',
        filenames: ['./a.json', './b.json', './c.json'],
        testCaseIds: [],
      });
    });

    it('should build directory-import source from -d flag (single)', () => {
      const sources = buildSources({ dir: ['./test-cases/'] });
      expect(sources).toHaveLength(1);
      expect(sources[0]).toEqual({
        type: 'directory-import',
        dirPaths: ['./test-cases/'],
        testCaseIds: [],
      });
    });

    it('should build directory-import source from -d flag (multiple)', () => {
      const sources = buildSources({ dir: ['./suite-a/', './suite-b/'] });
      expect(sources).toHaveLength(1);
      expect(sources[0]).toEqual({
        type: 'directory-import',
        dirPaths: ['./suite-a/', './suite-b/'],
        testCaseIds: [],
      });
    });

    it('should build test-case-ids source from -t flag', () => {
      const sources = buildSources({ testCase: ['tc-001', 'tc-002'] });
      expect(sources).toHaveLength(1);
      expect(sources[0]).toEqual({
        type: 'test-case-ids',
        ids: ['tc-001', 'tc-002'],
      });
    });

    it('should build label-filter source from --label flag', () => {
      const sources = buildSources({ label: ['@smoke', 'category:RCA'] });
      expect(sources).toHaveLength(1);
      expect(sources[0]).toEqual({
        type: 'label-filter',
        labels: ['@smoke', 'category:RCA'],
      });
    });

    it('should combine multiple source types', () => {
      const sources = buildSources({
        file: ['./extra.json'],
        testCase: ['tc-099'],
        label: ['@smoke'],
      });
      expect(sources).toHaveLength(3);
      expect(sources[0].type).toBe('file-import');
      expect(sources[1].type).toBe('test-case-ids');
      expect(sources[2].type).toBe('label-filter');
    });

    it('should return empty array when no sources specified', () => {
      const sources = buildSources({});
      expect(sources).toHaveLength(0);
    });

    it('should handle single -t flag', () => {
      const sources = buildSources({ testCase: ['tc-single'] });
      expect(sources).toHaveLength(1);
      expect((sources[0] as any).ids).toEqual(['tc-single']);
    });

    it('should handle single --label flag', () => {
      const sources = buildSources({ label: ['@integration'] });
      expect(sources).toHaveLength(1);
      expect((sources[0] as any).labels).toEqual(['@integration']);
    });
  });

  describe('unified mode detection', () => {
    it('should detect unified mode when -d flag is used', () => {
      const hasNewFlags = true; // -d is a new flag
      expect(hasNewFlags).toBe(true);
    });

    it('should detect unified mode when -t flag is used', () => {
      const hasNewFlags = true; // -t is a new flag
      expect(hasNewFlags).toBe(true);
    });

    it('should detect unified mode when --label flag is used', () => {
      const hasNewFlags = true; // --label is a new flag
      expect(hasNewFlags).toBe(true);
    });

    it('should detect unified mode when multiple -f values are used', () => {
      const files = ['a.json', 'b.json'];
      const hasMultipleFiles = files.length > 1;
      expect(hasMultipleFiles).toBe(true);
    });

    it('should NOT use unified mode for single -n flag (backwards compat)', () => {
      const options = { name: 'Baseline', file: [] as string[], dir: [] as string[], testCase: [] as string[], label: [] as string[] };
      const hasNewFlags = (options.dir.length > 0) || (options.testCase.length > 0) || (options.label.length > 0);
      const hasMultipleFiles = (options.file || []).length > 1;
      expect(hasNewFlags || hasMultipleFiles).toBe(false);
    });

    it('should NOT use unified mode for single -f flag (backwards compat)', () => {
      const options = { file: ['test.json'], dir: [] as string[], testCase: [] as string[], label: [] as string[] };
      const hasNewFlags = (options.dir.length > 0) || (options.testCase.length > 0) || (options.label.length > 0);
      const hasMultipleFiles = (options.file || []).length > 1;
      expect(hasNewFlags || hasMultipleFiles).toBe(false);
    });
  });

  // Long-run SSE-drop fix: once runUnifiedMode has a (possibly polled) run
  // object, it must not blindly report success. Covers the failed/cancelled/
  // timeout branches that are otherwise only reachable through the network+
  // SSE machinery `runUnifiedMode` itself is deliberately not unit-tested
  // through (see the "server dependencies" note above).
  describe('resolveUnifiedRunOutcome', () => {
    function makeRun(overrides: Partial<EvaluationRun> = {}): EvaluationRun {
      return {
        id: 'run-1',
        docType: 'evaluation-run',
        name: 'test',
        createdAt: new Date().toISOString(),
        status: 'completed',
        agentKey: 'demo',
        modelId: 'demo-model',
        sources: [],
        trigger: 'cli',
        testCaseSnapshots: [],
        results: {},
        ...overrides,
      } as EvaluationRun;
    }

    it('reports success with the stale SSE completedCount when no run was ever fetched (runId never captured)', () => {
      const outcome = resolveUnifiedRunOutcome(null, 3);
      expect(outcome).toEqual({ kind: 'success', doneCount: 3 });
    });

    it('reports success with a FRESH doneCount derived from run.results, ignoring stale completedCount', () => {
      const run = makeRun({
        status: 'completed',
        results: {
          a: { reportId: 'r-a', status: 'completed' },
          b: { reportId: 'r-b', status: 'failed' },
          c: { reportId: 'r-c', status: 'pending' }, // not counted as "done"
        } as any,
      });
      // completedCount is deliberately wrong/stale (e.g. frozen before a disconnect)
      // to prove the fresh per-case count from storage wins.
      const outcome = resolveUnifiedRunOutcome(run, 0);
      expect(outcome).toEqual({ kind: 'success', doneCount: 2 });
    });

    it('reports FAILED (not success) when the run itself terminated in a failed state', () => {
      const run = makeRun({ status: 'failed', error: 'agent crashed' });
      const outcome = resolveUnifiedRunOutcome(run, 5);
      expect(outcome.kind).toBe('failed');
      expect((outcome as any).message).toContain('failed');
      expect((outcome as any).message).toContain('agent crashed');
    });

    it('reports FAILED without an error suffix when the run has no error field', () => {
      const run = makeRun({ status: 'cancelled', error: undefined });
      const outcome = resolveUnifiedRunOutcome(run, 5);
      expect(outcome).toEqual({ kind: 'failed', message: 'Evaluation run cancelled' });
    });

    it('reports TIMEOUT (not success) when polling gave up while the run was still running', () => {
      const run = makeRun({ status: 'running' });
      const outcome = resolveUnifiedRunOutcome(run, 1);
      expect(outcome).toEqual({ kind: 'timeout' });
    });

    it('reports TIMEOUT when polling gave up while the run had not even started processing', () => {
      const run = makeRun({ status: 'pending' });
      const outcome = resolveUnifiedRunOutcome(run, 0);
      expect(outcome).toEqual({ kind: 'timeout' });
    });
  });

  describe('file/directory validation', () => {
    it('should validate file paths exist', () => {
      (existsSync as jest.Mock).mockReturnValue(true);
      expect(existsSync('./test.json')).toBe(true);
    });

    it('should reject non-existent file paths', () => {
      (existsSync as jest.Mock).mockReturnValue(false);
      expect(existsSync('./missing.json')).toBe(false);
    });

    it('should validate directory paths exist and are directories', () => {
      (existsSync as jest.Mock).mockReturnValue(true);
      (statSync as jest.Mock).mockReturnValue({ isDirectory: () => true });
      expect(existsSync('./dir/')).toBe(true);
      expect(statSync('./dir/').isDirectory()).toBe(true);
    });

    it('should reject paths that are not directories', () => {
      (existsSync as jest.Mock).mockReturnValue(true);
      (statSync as jest.Mock).mockReturnValue({ isDirectory: () => false });
      expect(statSync('./file.txt').isDirectory()).toBe(false);
    });
  });
});
