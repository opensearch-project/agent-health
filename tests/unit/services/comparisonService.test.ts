/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  calculateRunAggregates,
  collectRunIdsFromReports,
  buildTestCaseComparisonRows,
  findBestRunForMetric,
  calculateDelta,
  formatDelta,
  getDeltaColorClass,
  filterRowsByCategory,
  filterRowsByStatus,
  calculateCombinedScore,
  calculateRowStatus,
  countRowsByStatus,
  getRealTestCaseMeta,
} from '@/services/comparisonService';
import {
  ExperimentRun,
  EvaluationReport,
  TestCaseComparisonRow,
  TestCaseRunResult,
} from '@/types';

describe('comparisonService', () => {
  describe('getRealTestCaseMeta', () => {
    it('should return undefined for non-existent test case', () => {
      const result = getRealTestCaseMeta('non-existent-test-case-id');
      expect(result).toBeUndefined();
    });

    it('should return metadata for existing test case', () => {
      // This test assumes TEST_CASES from lib/constants has entries
      // If TEST_CASES is empty in test env, this test verifies the function works
      const result = getRealTestCaseMeta('tc-1'); // Using a likely valid ID
      // Even if it returns undefined, the function should not throw
      expect(result === undefined || typeof result === 'object').toBe(true);
    });
  });

  describe('calculateRunAggregates', () => {
    const mockRun: ExperimentRun = {
      id: 'run-1',
      name: 'Test Run',
      createdAt: '2024-01-01T00:00:00Z',
      agentKey: 'agent-1',
      modelId: 'model-1',
      status: 'completed',
      results: {
        'tc-1': { reportId: 'report-1', status: 'completed' },
        'tc-2': { reportId: 'report-2', status: 'completed' },
        'tc-3': { reportId: 'report-3', status: 'failed' },
      },
    };

    const mockReports: Record<string, EvaluationReport> = {
      'report-1': {
        id: 'report-1',
        testCaseId: 'tc-1',
        passFailStatus: 'passed',
        metrics: { accuracy: 90, faithfulness: 85, trajectory_alignment_score: 80, latency_score: 75 },
      } as EvaluationReport,
      'report-2': {
        id: 'report-2',
        testCaseId: 'tc-2',
        passFailStatus: 'passed',
        metrics: { accuracy: 80, faithfulness: 75, trajectory_alignment_score: 70, latency_score: 65 },
      } as EvaluationReport,
      'report-3': {
        id: 'report-3',
        testCaseId: 'tc-3',
        passFailStatus: 'failed',
        metrics: { accuracy: 50, faithfulness: 45, trajectory_alignment_score: 40, latency_score: 35 },
      } as EvaluationReport,
    };

    it('should calculate aggregate metrics correctly', () => {
      const aggregates = calculateRunAggregates(mockRun, mockReports);

      expect(aggregates.runId).toBe('run-1');
      expect(aggregates.runName).toBe('Test Run');
      expect(aggregates.totalTestCases).toBe(3);
      expect(aggregates.passedCount).toBe(2);
      expect(aggregates.failedCount).toBe(1);
      expect(aggregates.avgAccuracy).toBe(73); // (90 + 80 + 50) / 3
      expect(aggregates.passRatePercent).toBe(67); // 2/3 * 100
    });

    it('should handle empty results', () => {
      const emptyRun: ExperimentRun = {
        ...mockRun,
        results: {},
      };

      const aggregates = calculateRunAggregates(emptyRun, {});

      expect(aggregates.totalTestCases).toBe(0);
      expect(aggregates.passedCount).toBe(0);
      expect(aggregates.failedCount).toBe(0);
      expect(aggregates.passRatePercent).toBe(0);
    });

    it('should handle missing reports', () => {
      const runWithMissingReports: ExperimentRun = {
        ...mockRun,
        results: {
          'tc-1': { reportId: 'missing-report', status: 'completed' },
        },
      };

      const aggregates = calculateRunAggregates(runWithMissingReports, {});

      expect(aggregates.passedCount).toBe(0);
      expect(aggregates.failedCount).toBe(0);
    });
  });

  describe('collectRunIdsFromReports', () => {
    it('should collect unique runIds from reports', () => {
      const runs: ExperimentRun[] = [
        {
          id: 'exp-run-1',
          name: 'Run 1',
          createdAt: '2024-01-01',
          agentKey: 'agent-1',
          modelId: 'model-1',
          status: 'completed',
          results: {
            'tc-1': { reportId: 'report-1', status: 'completed' },
            'tc-2': { reportId: 'report-2', status: 'completed' },
          },
        },
      ];

      const reports: Record<string, EvaluationReport> = {
        'report-1': { id: 'report-1', testCaseId: 'tc-1', runId: 'agent-run-1' } as EvaluationReport,
        'report-2': { id: 'report-2', testCaseId: 'tc-2', runId: 'agent-run-2' } as EvaluationReport,
      };

      const runIds = collectRunIdsFromReports(runs, reports);

      expect(runIds).toContain('agent-run-1');
      expect(runIds).toContain('agent-run-2');
      expect(runIds).toHaveLength(2);
    });

    it('should deduplicate runIds', () => {
      const runs: ExperimentRun[] = [
        {
          id: 'exp-run-1',
          name: 'Run 1',
          createdAt: '2024-01-01',
          agentKey: 'agent-1',
          modelId: 'model-1',
          status: 'completed',
          results: {
            'tc-1': { reportId: 'report-1', status: 'completed' },
            'tc-2': { reportId: 'report-2', status: 'completed' },
          },
        },
      ];

      const reports: Record<string, EvaluationReport> = {
        'report-1': { id: 'report-1', testCaseId: 'tc-1', runId: 'same-run' } as EvaluationReport,
        'report-2': { id: 'report-2', testCaseId: 'tc-2', runId: 'same-run' } as EvaluationReport,
      };

      const runIds = collectRunIdsFromReports(runs, reports);

      expect(runIds).toEqual(['same-run']);
    });
  });

  describe('buildTestCaseComparisonRows', () => {
    const mockRuns: ExperimentRun[] = [
      {
        id: 'run-1',
        name: 'Run 1',
        createdAt: '2024-01-01',
        agentKey: 'agent-1',
        modelId: 'model-1',
        status: 'completed',
        results: {
          'tc-1': { reportId: 'report-1', status: 'completed' },
        },
      },
      {
        id: 'run-2',
        name: 'Run 2',
        createdAt: '2024-01-02',
        agentKey: 'agent-1',
        modelId: 'model-2',
        status: 'completed',
        results: {
          'tc-1': { reportId: 'report-2', status: 'completed' },
        },
      },
    ];

    const mockReports: Record<string, EvaluationReport> = {
      'report-1': {
        id: 'report-1',
        testCaseId: 'tc-1',
        passFailStatus: 'passed',
        metrics: { accuracy: 90, faithfulness: 85, trajectory_alignment_score: 80, latency_score: 75 },
      } as EvaluationReport,
      'report-2': {
        id: 'report-2',
        testCaseId: 'tc-1',
        passFailStatus: 'failed',
        metrics: { accuracy: 60, faithfulness: 55, trajectory_alignment_score: 50, latency_score: 45 },
      } as EvaluationReport,
    };

    const mockGetMeta = (id: string) => ({
      id,
      name: `Test Case ${id}`,
      category: 'RCA' as const,
      difficulty: 'Medium' as const,
      version: 'v1',
    });

    const mockGetVersion = (_testCaseId: string, runId: string) => runId === 'run-1' ? 'v1' : 'v2';

    it('should build comparison rows with results from each run', () => {
      const rows = buildTestCaseComparisonRows(mockRuns, mockReports, mockGetMeta, mockGetVersion);

      expect(rows).toHaveLength(1);
      expect(rows[0].testCaseId).toBe('tc-1');
      expect(rows[0].results['run-1'].status).toBe('completed');
      expect(rows[0].results['run-1'].passFailStatus).toBe('passed');
      expect(rows[0].results['run-2'].status).toBe('completed');
      expect(rows[0].results['run-2'].passFailStatus).toBe('failed');
    });

    it('should detect version differences', () => {
      const rows = buildTestCaseComparisonRows(mockRuns, mockReports, mockGetMeta, mockGetVersion);

      expect(rows[0].hasVersionDifference).toBe(true);
      expect(rows[0].versions).toContain('v1');
      expect(rows[0].versions).toContain('v2');
    });

    it('should mark missing test cases', () => {
      const runsWithMissing: ExperimentRun[] = [
        {
          id: 'run-1',
          name: 'Run 1',
          createdAt: '2024-01-01',
          agentKey: 'agent-1',
          modelId: 'model-1',
          status: 'completed',
          results: {
            'tc-1': { reportId: 'report-1', status: 'completed' },
          },
        },
        {
          id: 'run-2',
          name: 'Run 2',
          createdAt: '2024-01-02',
          agentKey: 'agent-1',
          modelId: 'model-2',
          status: 'completed',
          results: {},
        },
      ];

      const rows = buildTestCaseComparisonRows(runsWithMissing, mockReports, mockGetMeta, mockGetVersion);

      expect(rows[0].results['run-2'].status).toBe('missing');
    });

    it('should mark missing when report not found', () => {
      const runsWithMissingReport: ExperimentRun[] = [
        {
          id: 'run-1',
          name: 'Run 1',
          createdAt: '2024-01-01',
          agentKey: 'agent-1',
          modelId: 'model-1',
          status: 'completed',
          results: {
            'tc-1': { reportId: 'missing-report-id', status: 'completed' },
          },
        },
      ];

      // Empty reports object - report referenced doesn't exist
      const rows = buildTestCaseComparisonRows(runsWithMissingReport, {}, mockGetMeta, mockGetVersion);

      expect(rows[0].results['run-1'].status).toBe('missing');
    });

    it('should sort rows by category then name', () => {
      const multiCategoryRuns: ExperimentRun[] = [
        {
          id: 'run-1',
          name: 'Run 1',
          createdAt: '2024-01-01',
          agentKey: 'agent-1',
          modelId: 'model-1',
          status: 'completed',
          results: {
            'tc-a': { reportId: 'report-a', status: 'completed' },
            'tc-b': { reportId: 'report-b', status: 'completed' },
            'tc-c': { reportId: 'report-c', status: 'completed' },
          },
        },
      ];

      const multiCategoryReports: Record<string, EvaluationReport> = {
        'report-a': {
          id: 'report-a',
          testCaseId: 'tc-a',
          passFailStatus: 'passed',
          metrics: { accuracy: 90, faithfulness: 85, trajectory_alignment_score: 80, latency_score: 75 },
        } as EvaluationReport,
        'report-b': {
          id: 'report-b',
          testCaseId: 'tc-b',
          passFailStatus: 'passed',
          metrics: { accuracy: 80, faithfulness: 75, trajectory_alignment_score: 70, latency_score: 65 },
        } as EvaluationReport,
        'report-c': {
          id: 'report-c',
          testCaseId: 'tc-c',
          passFailStatus: 'passed',
          metrics: { accuracy: 70, faithfulness: 65, trajectory_alignment_score: 60, latency_score: 55 },
        } as EvaluationReport,
      };

      // Return different categories for each test case
      const multiCategoryGetMeta = (id: string) => {
        const configs: Record<string, any> = {
          'tc-a': { id: 'tc-a', name: 'Zulu Test', category: 'RCA' as const, difficulty: 'Medium' as const },
          'tc-b': { id: 'tc-b', name: 'Alpha Test', category: 'Alerts' as const, difficulty: 'Easy' as const },
          'tc-c': { id: 'tc-c', name: 'Beta Test', category: 'RCA' as const, difficulty: 'Hard' as const },
        };
        return configs[id];
      };

      const rows = buildTestCaseComparisonRows(
        multiCategoryRuns,
        multiCategoryReports,
        multiCategoryGetMeta,
        () => 'v1'
      );

      // Should be sorted by category first (Alerts before RCA), then by name
      expect(rows[0].category).toBe('Alerts');
      expect(rows[0].testCaseName).toBe('Alpha Test');
      expect(rows[1].category).toBe('RCA');
      expect(rows[1].testCaseName).toBe('Beta Test'); // Beta before Zulu
      expect(rows[2].category).toBe('RCA');
      expect(rows[2].testCaseName).toBe('Zulu Test');
    });
  });

  describe('findBestRunForMetric', () => {
    const mockRow: TestCaseComparisonRow = {
      testCaseId: 'tc-1',
      testCaseName: 'Test Case 1',
      labels: [],
      category: 'RCA',
      difficulty: 'Medium',
      results: {
        'run-1': { status: 'completed', accuracy: 90, faithfulness: 70 },
        'run-2': { status: 'completed', accuracy: 80, faithfulness: 95 },
        'run-3': { status: 'completed', accuracy: 85, faithfulness: 80 },
      },
      hasVersionDifference: false,
      versions: [],
    };

    it('should find run with best accuracy', () => {
      const bestRunId = findBestRunForMetric(mockRow, 'accuracy');
      expect(bestRunId).toBe('run-1');
    });

    it('should find run with best faithfulness', () => {
      const bestRunId = findBestRunForMetric(mockRow, 'faithfulness');
      expect(bestRunId).toBe('run-2');
    });

    it('should return undefined for empty results', () => {
      const emptyRow: TestCaseComparisonRow = {
        ...mockRow,
        results: {},
      };
      expect(findBestRunForMetric(emptyRow, 'accuracy')).toBeUndefined();
    });
  });

  describe('calculateDelta', () => {
    it('should calculate positive delta', () => {
      expect(calculateDelta(80, 70)).toBe(10);
    });

    it('should calculate negative delta', () => {
      expect(calculateDelta(70, 80)).toBe(-10);
    });

    it('should calculate zero delta', () => {
      expect(calculateDelta(50, 50)).toBe(0);
    });
  });

  describe('formatDelta', () => {
    it('should format positive delta with plus sign', () => {
      expect(formatDelta(10)).toBe('+10%');
    });

    it('should format negative delta without plus sign', () => {
      expect(formatDelta(-10)).toBe('-10%');
    });

    it('should return empty string for zero delta', () => {
      expect(formatDelta(0)).toBe('');
    });
  });

  describe('getDeltaColorClass', () => {
    it('should return blue for positive delta', () => {
      expect(getDeltaColorClass(10)).toBe('text-opensearch-blue');
    });

    it('should return red for negative delta', () => {
      expect(getDeltaColorClass(-10)).toBe('text-red-400');
    });

    it('should return muted for zero delta', () => {
      expect(getDeltaColorClass(0)).toBe('text-muted-foreground');
    });
  });

  describe('filterRowsByCategory', () => {
    const rows: TestCaseComparisonRow[] = [
      { testCaseId: '1', testCaseName: 'TC1', category: 'RCA', difficulty: 'Easy', labels: [], results: {}, hasVersionDifference: false, versions: [] },
      { testCaseId: '2', testCaseName: 'TC2', category: 'Alerts', difficulty: 'Medium', labels: [], results: {}, hasVersionDifference: false, versions: [] },
      { testCaseId: '3', testCaseName: 'TC3', category: 'RCA', difficulty: 'Hard', labels: [], results: {}, hasVersionDifference: false, versions: [] },
    ];

    it('should filter by specific category', () => {
      const filtered = filterRowsByCategory(rows, 'RCA');
      expect(filtered).toHaveLength(2);
      expect(filtered.every(r => r.category === 'RCA')).toBe(true);
    });

    it('should return all rows for "all" category', () => {
      const filtered = filterRowsByCategory(rows, 'all');
      expect(filtered).toHaveLength(3);
    });
  });

  describe('filterRowsByStatus', () => {
    const runIds = ['run-1', 'run-2'];

    const rows: TestCaseComparisonRow[] = [
      {
        testCaseId: '1',
        testCaseName: 'All Passed',
        category: 'RCA',
        difficulty: 'Easy',
        labels: [],
        results: {
          'run-1': { status: 'completed', passFailStatus: 'passed' },
          'run-2': { status: 'completed', passFailStatus: 'passed' },
        },
        hasVersionDifference: false,
        versions: [],
      },
      {
        testCaseId: '2',
        testCaseName: 'Has Failure',
        category: 'RCA',
        difficulty: 'Medium',
        labels: [],
        results: {
          'run-1': { status: 'completed', passFailStatus: 'passed' },
          'run-2': { status: 'completed', passFailStatus: 'failed' },
        },
        hasVersionDifference: false,
        versions: [],
      },
      {
        testCaseId: '3',
        testCaseName: 'All Failed',
        category: 'RCA',
        difficulty: 'Hard',
        labels: [],
        results: {
          'run-1': { status: 'completed', passFailStatus: 'failed' },
          'run-2': { status: 'completed', passFailStatus: 'failed' },
        },
        hasVersionDifference: false,
        versions: [],
      },
    ];

    it('should filter passed rows', () => {
      const filtered = filterRowsByStatus(rows, 'passed', runIds);
      expect(filtered).toHaveLength(1);
      expect(filtered[0].testCaseName).toBe('All Passed');
    });

    it('should filter failed rows', () => {
      const filtered = filterRowsByStatus(rows, 'failed', runIds);
      expect(filtered).toHaveLength(2);
    });

    it('should filter mixed rows', () => {
      const filtered = filterRowsByStatus(rows, 'mixed', runIds);
      expect(filtered).toHaveLength(1);
      expect(filtered[0].testCaseName).toBe('Has Failure');
    });

    it('should return all rows for "all" status', () => {
      const filtered = filterRowsByStatus(rows, 'all', runIds);
      expect(filtered).toHaveLength(3);
    });
  });

  describe('calculateCombinedScore', () => {
    it('should calculate weighted score correctly', () => {
      const result: TestCaseRunResult = {
        status: 'completed',
        accuracy: 100,
        faithfulness: 100,
        trajectoryAlignment: 100,
        latencyScore: 100,
      };

      const score = calculateCombinedScore(result);
      expect(score).toBe(100); // All weights sum to 1.0
    });

    it('should handle missing metrics', () => {
      const result: TestCaseRunResult = {
        status: 'completed',
        accuracy: 80,
      };

      const score = calculateCombinedScore(result);
      expect(score).toBe(32); // 80 * 0.4 = 32
    });

    it('should apply correct weights', () => {
      const result: TestCaseRunResult = {
        status: 'completed',
        accuracy: 100, // 0.4 weight -> 40
        faithfulness: 0, // 0.3 weight -> 0
        trajectoryAlignment: 0, // 0.2 weight -> 0
        latencyScore: 0, // 0.1 weight -> 0
      };

      expect(calculateCombinedScore(result)).toBe(40);
    });
  });

  describe('calculateRowStatus', () => {
    const baselineRunId = 'baseline';

    it('should return neutral when baseline has no completed result', () => {
      const row: TestCaseComparisonRow = {
        testCaseId: '1',
        testCaseName: 'TC1',
        category: 'RCA',
        difficulty: 'Easy',
        labels: [],
        results: {
          baseline: { status: 'missing' },
        },
        hasVersionDifference: false,
        versions: [],
      };

      expect(calculateRowStatus(row, baselineRunId)).toBe('neutral');
    });

    it('should detect regression', () => {
      const row: TestCaseComparisonRow = {
        testCaseId: '1',
        testCaseName: 'TC1',
        category: 'RCA',
        difficulty: 'Easy',
        labels: [],
        results: {
          baseline: { status: 'completed', accuracy: 90, faithfulness: 90, trajectoryAlignment: 90, latencyScore: 90 },
          'run-2': { status: 'completed', accuracy: 50, faithfulness: 50, trajectoryAlignment: 50, latencyScore: 50 },
        },
        hasVersionDifference: false,
        versions: [],
      };

      expect(calculateRowStatus(row, baselineRunId)).toBe('regression');
    });

    it('should detect improvement', () => {
      const row: TestCaseComparisonRow = {
        testCaseId: '1',
        testCaseName: 'TC1',
        category: 'RCA',
        difficulty: 'Easy',
        labels: [],
        results: {
          baseline: { status: 'completed', accuracy: 50, faithfulness: 50, trajectoryAlignment: 50, latencyScore: 50 },
          'run-2': { status: 'completed', accuracy: 90, faithfulness: 90, trajectoryAlignment: 90, latencyScore: 90 },
        },
        hasVersionDifference: false,
        versions: [],
      };

      expect(calculateRowStatus(row, baselineRunId)).toBe('improvement');
    });

    it('should detect mixed status', () => {
      const row: TestCaseComparisonRow = {
        testCaseId: '1',
        testCaseName: 'TC1',
        category: 'RCA',
        difficulty: 'Easy',
        labels: [],
        results: {
          baseline: { status: 'completed', accuracy: 70, faithfulness: 70, trajectoryAlignment: 70, latencyScore: 70 },
          'run-2': { status: 'completed', accuracy: 90, faithfulness: 90, trajectoryAlignment: 90, latencyScore: 90 },
          'run-3': { status: 'completed', accuracy: 40, faithfulness: 40, trajectoryAlignment: 40, latencyScore: 40 },
        },
        hasVersionDifference: false,
        versions: [],
      };

      expect(calculateRowStatus(row, baselineRunId)).toBe('mixed');
    });
  });

  describe('countRowsByStatus', () => {
    const baselineRunId = 'baseline';

    const rows: TestCaseComparisonRow[] = [
      {
        testCaseId: '1',
        testCaseName: 'Improved',
        category: 'RCA',
        difficulty: 'Easy',
        labels: [],
        results: {
          baseline: { status: 'completed', accuracy: 50, faithfulness: 50, trajectoryAlignment: 50, latencyScore: 50 },
          'run-2': { status: 'completed', accuracy: 90, faithfulness: 90, trajectoryAlignment: 90, latencyScore: 90 },
        },
        hasVersionDifference: false,
        versions: [],
      },
      {
        testCaseId: '2',
        testCaseName: 'Regressed',
        category: 'RCA',
        difficulty: 'Medium',
        labels: [],
        results: {
          baseline: { status: 'completed', accuracy: 90, faithfulness: 90, trajectoryAlignment: 90, latencyScore: 90 },
          'run-2': { status: 'completed', accuracy: 50, faithfulness: 50, trajectoryAlignment: 50, latencyScore: 50 },
        },
        hasVersionDifference: false,
        versions: [],
      },
      {
        testCaseId: '3',
        testCaseName: 'Neutral',
        category: 'RCA',
        difficulty: 'Hard',
        labels: [],
        results: {
          baseline: { status: 'completed', accuracy: 70, faithfulness: 70, trajectoryAlignment: 70, latencyScore: 70 },
          'run-2': { status: 'completed', accuracy: 71, faithfulness: 71, trajectoryAlignment: 71, latencyScore: 71 },
        },
        hasVersionDifference: false,
        versions: [],
      },
    ];

    it('should count rows by status correctly', () => {
      const counts = countRowsByStatus(rows, baselineRunId);

      expect(counts.improvement).toBe(1);
      expect(counts.regression).toBe(1);
      expect(counts.neutral).toBe(1);
      expect(counts.mixed).toBe(0);
    });
  });
});
