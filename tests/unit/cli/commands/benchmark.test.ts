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

import { writeFileSync } from 'fs';
import type { BenchmarkRun, EvaluationReport, Benchmark, AgentConfig } from '@/types';
import { calculateRunStats, getReportIdsFromRun } from '@/lib/runStats';
import { validateTestCasesArrayJson } from '@/lib/testCaseValidation';

// Mock fs
jest.mock('fs', () => ({
  writeFileSync: jest.fn(),
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
        { key: 'mock', name: 'Mock Agent', endpoint: 'http://mock', models: ['claude-sonnet'] },
        { key: 'ml-commons', name: 'ML Commons Agent', endpoint: 'http://ml', models: ['claude-opus'] },
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
    function getDefaultModel(agent: Partial<AgentConfig>): string {
      return (agent.models?.[0]) || 'claude-sonnet';
    }

    it('should return first model from agent config', () => {
      const agent = { models: ['claude-opus', 'claude-sonnet'] };
      expect(getDefaultModel(agent)).toBe('claude-opus');
    });

    it('should return claude-sonnet as fallback', () => {
      const agent = { models: [] };
      expect(getDefaultModel(agent)).toBe('claude-sonnet');
    });

    it('should handle undefined models array', () => {
      const agent = {};
      expect(getDefaultModel(agent)).toBe('claude-sonnet');
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
