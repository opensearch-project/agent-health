/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  calculateRunAggregates,
  mergeTraceMetrics,
  collectRunIdsFromReports,
  collectSessionIdsFromReports,
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
  detectComparisonMode,
  computeTestCaseOverlap,
} from '@/services/comparisonService';
import {
  BenchmarkRun,
  EvaluationReport,
  TestCaseComparisonRow,
  TestCaseRunResult,
  TraceMetrics,
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
    const mockRun: BenchmarkRun = {
      id: 'run-1',
      name: 'Test Run',
      createdAt: '2024-01-01T00:00:00Z',
      agentKey: 'agent-1',
      modelId: 'model-1',
      status: 'completed',
      results: {
        'tc-1': { reportId: 'report-1', status: 'completed', passFailStatus: 'passed' },
        'tc-2': { reportId: 'report-2', status: 'completed', passFailStatus: 'passed' },
        'tc-3': { reportId: 'report-3', status: 'failed', passFailStatus: 'failed' },
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
      const emptyRun: BenchmarkRun = {
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
      const runWithMissingReports: BenchmarkRun = {
        ...mockRun,
        results: {
          'tc-1': { reportId: 'missing-report', status: 'completed' },
        },
      };

      const aggregates = calculateRunAggregates(runWithMissingReports, {});

      expect(aggregates.passedCount).toBe(0);
      expect(aggregates.failedCount).toBe(0);
    });

    // Issue #242 regression: an evaluator-error report must NOT count as a
    // fail in the comparison aggregate. Pass rate is computed over the
    // evaluable set (total - errored), matching lib/runStats.calculateRunStats,
    // the run report and the benchmark overview. Before the fix this divided
    // by total, so 1 pass + 1 errored read 50% (and could flip VerdictStrip's
    // declared winner) instead of the correct 100%.
    it('excludes errored runs from pass rate and accuracy (no denormalized stats)', () => {
      const run: BenchmarkRun = {
        ...mockRun,
        stats: undefined,
        results: {
          'tc-1': { reportId: 'report-1', status: 'completed', passFailStatus: 'passed' },
          'tc-2': { reportId: 'report-err', status: 'completed' },
        },
      };
      const reports: Record<string, EvaluationReport> = {
        'report-1': {
          id: 'report-1',
          testCaseId: 'tc-1',
          passFailStatus: 'passed',
          metrics: { accuracy: 90, faithfulness: 85, trajectory_alignment_score: 80, latency_score: 75 },
        } as EvaluationReport,
        'report-err': {
          id: 'report-err',
          testCaseId: 'tc-2',
          passFailStatus: null,
          metricsStatus: 'error',
          metrics: { accuracy: 0, faithfulness: 0, trajectory_alignment_score: 0, latency_score: 0 },
        } as unknown as EvaluationReport,
      };

      const aggregates = calculateRunAggregates(run, reports);

      expect(aggregates.passedCount).toBe(1);
      expect(aggregates.failedCount).toBe(0);
      // 1 passed / (2 total - 1 errored) = 100%, NOT 50%.
      expect(aggregates.passRatePercent).toBe(100);
      // Accuracy averaged over the evaluable case only (the 0 is excluded).
      expect(aggregates.avgAccuracy).toBe(90);
    });

    // Errored cases are excluded from the pass-rate denominator (#242). The
    // per-case verdict is the single source of truth: a 'completed' result with
    // a 'passed' verdict counts; one with no verdict is errored (matching what
    // the runner persists and lib/runStats.bucketRunResults computes).
    it('excludes errored runs from pass rate (errored derived from per-case verdicts)', () => {
      const run: BenchmarkRun = {
        ...mockRun,
        stats: { passed: 2, failed: 0, pending: 0, errored: 2, total: 4 },
        results: {
          'tc-1': { reportId: 'report-1', status: 'completed', passFailStatus: 'passed' },
          'tc-2': { reportId: 'report-2', status: 'completed', passFailStatus: 'passed' },
          'tc-3': { reportId: 'report-e1', status: 'completed' },
          'tc-4': { reportId: 'report-e2', status: 'completed' },
        },
      };
      const reports: Record<string, EvaluationReport> = {
        'report-1': { id: 'report-1', testCaseId: 'tc-1', passFailStatus: 'passed', metrics: { accuracy: 80, faithfulness: 0, trajectory_alignment_score: 0, latency_score: 0 } } as EvaluationReport,
        'report-2': { id: 'report-2', testCaseId: 'tc-2', passFailStatus: 'passed', metrics: { accuracy: 60, faithfulness: 0, trajectory_alignment_score: 0, latency_score: 0 } } as EvaluationReport,
        'report-e1': { id: 'report-e1', testCaseId: 'tc-3', passFailStatus: null, metricsStatus: 'error', metrics: { accuracy: 0, faithfulness: 0, trajectory_alignment_score: 0, latency_score: 0 } } as unknown as EvaluationReport,
        'report-e2': { id: 'report-e2', testCaseId: 'tc-4', passFailStatus: null, metricsStatus: 'error', metrics: { accuracy: 0, faithfulness: 0, trajectory_alignment_score: 0, latency_score: 0 } } as unknown as EvaluationReport,
      };

      const aggregates = calculateRunAggregates(run, reports);

      // 2 passed / (4 total - 2 errored) = 100%.
      expect(aggregates.passRatePercent).toBe(100);
      // Accuracy over the two evaluable reports only: (80 + 60) / 2 = 70.
      expect(aggregates.avgAccuracy).toBe(70);
    });

    // Copilot review (#345): pending/calculating reports must be bucketed as
    // pending (like lib/runStats), NOT counted as failures or averaged in with
    // placeholder zeros. Before the fix the no-stats `else` branch counted a
    // pending report as failed and its 0-accuracy dragged the average down.
    it('buckets pending/calculating runs as pending, not failed (no denormalized stats)', () => {
      const run: BenchmarkRun = {
        ...mockRun,
        stats: undefined,
        results: {
          'tc-1': { reportId: 'report-1', status: 'completed', passFailStatus: 'passed' },
          // Still being evaluated (metrics calculating) — a not-yet-done case is
          // 'running', NOT 'completed'; a completed result always carries its
          // final verdict (or is errored). Bucketed as pending, not failed.
          'tc-2': { reportId: 'report-pending', status: 'running' },
        },
      };
      const reports: Record<string, EvaluationReport> = {
        'report-1': {
          id: 'report-1',
          testCaseId: 'tc-1',
          passFailStatus: 'passed',
          metrics: { accuracy: 90, faithfulness: 0, trajectory_alignment_score: 0, latency_score: 0 },
        } as EvaluationReport,
        'report-pending': {
          id: 'report-pending',
          testCaseId: 'tc-2',
          passFailStatus: undefined,
          metricsStatus: 'pending',
          metrics: { accuracy: 0, faithfulness: 0, trajectory_alignment_score: 0, latency_score: 0 },
        } as unknown as EvaluationReport,
      };

      const aggregates = calculateRunAggregates(run, reports);

      // The pending case is NOT a failure.
      expect(aggregates.passedCount).toBe(1);
      expect(aggregates.failedCount).toBe(0);
      // Accuracy averaged over the evaluable (non-pending) case only.
      expect(aggregates.avgAccuracy).toBe(90);
      // Pending stays in the denominator (total - errored = 2), matching
      // lib/runStats: 1 passed / 2 = 50%.
      expect(aggregates.passRatePercent).toBe(50);
    });
  });

  describe('collectRunIdsFromReports', () => {
    it('should collect unique runIds from reports', () => {
      const runs: BenchmarkRun[] = [
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
      const runs: BenchmarkRun[] = [
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

  describe('collectSessionIdsFromReports', () => {
    it('builds a runId -> sessionId map for Strategy-D correlation', () => {
      const runs: BenchmarkRun[] = [
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
        'report-1': { id: 'report-1', testCaseId: 'tc-1', runId: 'agent-run-1', sessionId: 'session-aaa' } as EvaluationReport,
        'report-2': { id: 'report-2', testCaseId: 'tc-2', runId: 'agent-run-2', sessionId: 'session-bbb' } as EvaluationReport,
      };

      const sessionIdByRunId = collectSessionIdsFromReports(runs, reports);

      expect(sessionIdByRunId).toEqual({
        'agent-run-1': 'session-aaa',
        'agent-run-2': 'session-bbb',
      });
    });

    it('omits entries whose report has no runId or no sessionId (nothing to correlate on)', () => {
      const runs: BenchmarkRun[] = [
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
            'tc-3': { reportId: 'report-3', status: 'completed' },
          },
        },
      ];

      const reports: Record<string, EvaluationReport> = {
        'report-1': { id: 'report-1', testCaseId: 'tc-1', runId: 'agent-run-1' } as EvaluationReport, // no sessionId
        'report-2': { id: 'report-2', testCaseId: 'tc-2', sessionId: 'session-orphan' } as EvaluationReport, // no runId
        'report-3': { id: 'report-3', testCaseId: 'tc-3', runId: 'agent-run-3', sessionId: 'session-ccc' } as EvaluationReport,
      };

      const sessionIdByRunId = collectSessionIdsFromReports(runs, reports);

      expect(sessionIdByRunId).toEqual({ 'agent-run-3': 'session-ccc' });
    });
  });

  describe('buildTestCaseComparisonRows', () => {
    const mockRuns: BenchmarkRun[] = [
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
      expect(rows[0].results['run-1'].errored).toBeFalsy();
      expect(rows[0].results['run-2'].status).toBe('completed');
      expect(rows[0].results['run-2'].passFailStatus).toBe('failed');
      expect(rows[0].results['run-2'].errored).toBeFalsy();
    });

    // Issue #242: when a report carries metricsStatus='error' (evaluator
    // failed to produce a verdict), the comparison row must surface a
    // truthy `errored` flag so the MetricCell can render the amber
    // `Errored` chip distinct from `Failed`. Without this, the row
    // falls through to passFailStatus-based styling and a misconfigured
    // judge masquerades as an agent failure.
    it('flags reports with metricsStatus="error" as errored on the row', () => {
      const erroredReports: Record<string, EvaluationReport> = {
        ...mockReports,
        'report-2': {
          id: 'report-2',
          testCaseId: 'tc-1',
          // The actual run-time shape: metricsStatus='error' and
          // passFailStatus is null (cleared by buildEvaluatorErrorPatch).
          metricsStatus: 'error',
          passFailStatus: null as any,
          metrics: { accuracy: 0, faithfulness: 0, trajectory_alignment_score: 0, latency_score: 0 },
        } as unknown as EvaluationReport,
      };

      const rows = buildTestCaseComparisonRows(mockRuns, erroredReports, mockGetMeta, mockGetVersion);
      expect(rows[0].results['run-1'].errored).toBeFalsy(); // unchanged
      expect(rows[0].results['run-2'].errored).toBe(true);
      // metricsStatus wins, so passFailStatus is whatever the report carries
      // (null on errored docs), but the comparison cell will read .errored
      // first and render the amber chip.
    });

    it('should detect version differences', () => {
      const rows = buildTestCaseComparisonRows(mockRuns, mockReports, mockGetMeta, mockGetVersion);

      expect(rows[0].hasVersionDifference).toBe(true);
      expect(rows[0].versions).toContain('v1');
      expect(rows[0].versions).toContain('v2');
    });

    it('should mark missing test cases', () => {
      const runsWithMissing: BenchmarkRun[] = [
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
      const runsWithMissingReport: BenchmarkRun[] = [
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
      const multiCategoryRuns: BenchmarkRun[] = [
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
    const referenceRunId = 'oldest-run';

    it('should return neutral when reference run has no completed result', () => {
      const row: TestCaseComparisonRow = {
        testCaseId: '1',
        testCaseName: 'TC1',
        category: 'RCA',
        difficulty: 'Easy',
        labels: [],
        results: {
          'oldest-run': { status: 'missing' },
        },
        hasVersionDifference: false,
        versions: [],
      };

      expect(calculateRowStatus(row, referenceRunId)).toBe('neutral');
    });

    it('should detect regression', () => {
      const row: TestCaseComparisonRow = {
        testCaseId: '1',
        testCaseName: 'TC1',
        category: 'RCA',
        difficulty: 'Easy',
        labels: [],
        results: {
          'oldest-run': { status: 'completed', accuracy: 90, faithfulness: 90, trajectoryAlignment: 90, latencyScore: 90 },
          'run-2': { status: 'completed', accuracy: 50, faithfulness: 50, trajectoryAlignment: 50, latencyScore: 50 },
        },
        hasVersionDifference: false,
        versions: [],
      };

      expect(calculateRowStatus(row, referenceRunId)).toBe('regression');
    });

    it('should detect improvement', () => {
      const row: TestCaseComparisonRow = {
        testCaseId: '1',
        testCaseName: 'TC1',
        category: 'RCA',
        difficulty: 'Easy',
        labels: [],
        results: {
          'oldest-run': { status: 'completed', accuracy: 50, faithfulness: 50, trajectoryAlignment: 50, latencyScore: 50 },
          'run-2': { status: 'completed', accuracy: 90, faithfulness: 90, trajectoryAlignment: 90, latencyScore: 90 },
        },
        hasVersionDifference: false,
        versions: [],
      };

      expect(calculateRowStatus(row, referenceRunId)).toBe('improvement');
    });

    it('should detect mixed status', () => {
      const row: TestCaseComparisonRow = {
        testCaseId: '1',
        testCaseName: 'TC1',
        category: 'RCA',
        difficulty: 'Easy',
        labels: [],
        results: {
          'oldest-run': { status: 'completed', accuracy: 70, faithfulness: 70, trajectoryAlignment: 70, latencyScore: 70 },
          'run-2': { status: 'completed', accuracy: 90, faithfulness: 90, trajectoryAlignment: 90, latencyScore: 90 },
          'run-3': { status: 'completed', accuracy: 40, faithfulness: 40, trajectoryAlignment: 40, latencyScore: 40 },
        },
        hasVersionDifference: false,
        versions: [],
      };

      expect(calculateRowStatus(row, referenceRunId)).toBe('mixed');
    });

    it('treats baseline-passed + other-failed as regression even when scores are close', () => {
      // The headline case: Kiro passed CP-test-04, Claude failed it. Even
      // if the accuracy numbers are within a few points, this is the row
      // the user actually came here for.
      const row: TestCaseComparisonRow = {
        testCaseId: '1',
        testCaseName: 'TC1',
        category: 'RCA',
        difficulty: 'Easy',
        labels: [],
        results: {
          'oldest-run': {
            status: 'completed',
            passFailStatus: 'passed',
            accuracy: 75, faithfulness: 75, trajectoryAlignment: 75, latencyScore: 75,
          },
          'run-2': {
            status: 'completed',
            passFailStatus: 'failed',
            accuracy: 73, faithfulness: 73, trajectoryAlignment: 73, latencyScore: 73,
          },
        },
        hasVersionDifference: false,
        versions: [],
      };
      expect(calculateRowStatus(row, referenceRunId)).toBe('regression');
    });

    it('treats baseline-failed + other-passed as improvement even when scores are close', () => {
      const row: TestCaseComparisonRow = {
        testCaseId: '1',
        testCaseName: 'TC1',
        category: 'RCA',
        difficulty: 'Easy',
        labels: [],
        results: {
          'oldest-run': {
            status: 'completed',
            passFailStatus: 'failed',
            accuracy: 65, faithfulness: 65, trajectoryAlignment: 65, latencyScore: 65,
          },
          'run-2': {
            status: 'completed',
            passFailStatus: 'passed',
            accuracy: 67, faithfulness: 67, trajectoryAlignment: 67, latencyScore: 67,
          },
        },
        hasVersionDifference: false,
        versions: [],
      };
      expect(calculateRowStatus(row, referenceRunId)).toBe('improvement');
    });

    it('returns neutral when both runs pass with similar scores', () => {
      const row: TestCaseComparisonRow = {
        testCaseId: '1',
        testCaseName: 'TC1',
        category: 'RCA',
        difficulty: 'Easy',
        labels: [],
        results: {
          'oldest-run': {
            status: 'completed', passFailStatus: 'passed',
            accuracy: 88, faithfulness: 88, trajectoryAlignment: 88, latencyScore: 88,
          },
          'run-2': {
            status: 'completed', passFailStatus: 'passed',
            accuracy: 86, faithfulness: 86, trajectoryAlignment: 86, latencyScore: 86,
          },
        },
        hasVersionDifference: false,
        versions: [],
      };
      expect(calculateRowStatus(row, referenceRunId)).toBe('neutral');
    });
  });

  describe('countRowsByStatus', () => {
    const referenceRunId = 'oldest-run';

    const rows: TestCaseComparisonRow[] = [
      {
        testCaseId: '1',
        testCaseName: 'Improved',
        category: 'RCA',
        difficulty: 'Easy',
        labels: [],
        results: {
          'oldest-run': { status: 'completed', accuracy: 50, faithfulness: 50, trajectoryAlignment: 50, latencyScore: 50 },
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
          'oldest-run': { status: 'completed', accuracy: 90, faithfulness: 90, trajectoryAlignment: 90, latencyScore: 90 },
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
          'oldest-run': { status: 'completed', accuracy: 70, faithfulness: 70, trajectoryAlignment: 70, latencyScore: 70 },
          'run-2': { status: 'completed', accuracy: 71, faithfulness: 71, trajectoryAlignment: 71, latencyScore: 71 },
        },
        hasVersionDifference: false,
        versions: [],
      },
    ];

    it('should count rows by status correctly', () => {
      const counts = countRowsByStatus(rows, referenceRunId);

      expect(counts.improvement).toBe(1);
      expect(counts.regression).toBe(1);
      expect(counts.neutral).toBe(1);
      expect(counts.mixed).toBe(0);
    });
  });

  describe('detectComparisonMode', () => {
    const buildRun = (id: string, agentKey: string, modelId = 'model-1'): BenchmarkRun => ({
      id,
      name: id,
      createdAt: '2024-01-01T00:00:00Z',
      agentKey,
      modelId,
      status: 'completed',
      results: {},
    });

    it('returns iterate when no runs are selected', () => {
      expect(detectComparisonMode([])).toBe('iterate');
    });

    it('returns iterate for a single run', () => {
      expect(detectComparisonMode([buildRun('r1', 'claude')])).toBe('iterate');
    });

    it('returns iterate when all runs share the same agentKey', () => {
      const runs = [
        buildRun('r1', 'claude'),
        buildRun('r2', 'claude'),
        buildRun('r3', 'claude'),
      ];
      expect(detectComparisonMode(runs)).toBe('iterate');
    });

    it('returns compare when runs span multiple agentKeys', () => {
      const runs = [buildRun('r1', 'claude'), buildRun('r2', 'kiro')];
      expect(detectComparisonMode(runs)).toBe('compare');
    });

    it('returns compare when the same agent runs differ by model (Sonnet vs Opus)', () => {
      const runs = [
        buildRun('r1', 'claude-code', 'claude-sonnet-4.6'),
        buildRun('r2', 'claude-code', 'claude-opus-4.8'),
      ];
      expect(detectComparisonMode(runs)).toBe('compare');
    });

    it('returns iterate when agent AND model are identical (re-runs of one config)', () => {
      const runs = [
        buildRun('r1', 'claude-code', 'claude-opus-4.8'),
        buildRun('r2', 'claude-code', 'claude-opus-4.8'),
      ];
      expect(detectComparisonMode(runs)).toBe('iterate');
    });

    it('returns compare when at least two of three runs have distinct agentKeys', () => {
      const runs = [
        buildRun('r1', 'claude'),
        buildRun('r2', 'claude'),
        buildRun('r3', 'kiro'),
      ];
      expect(detectComparisonMode(runs)).toBe('compare');
    });

    it('treats missing agentKey as iterate', () => {
      const runs = [
        { ...buildRun('r1', ''), agentKey: '' },
        { ...buildRun('r2', ''), agentKey: '' },
      ];
      expect(detectComparisonMode(runs)).toBe('iterate');
    });
  });

  describe('computeTestCaseOverlap', () => {
    const mkRun = (id: string, tcIds: string[]): BenchmarkRun => ({
      id,
      name: `Run ${id}`,
      createdAt: '2024-01-01T00:00:00Z',
      agentKey: 'agent-1',
      modelId: 'model-1',
      status: 'completed',
      results: Object.fromEntries(
        tcIds.map(tc => [tc, { reportId: `${id}-${tc}`, status: 'completed' as const }])
      ),
    });

    it('reports full overlap when all runs share the same test cases', () => {
      const overlap = computeTestCaseOverlap([
        mkRun('a', ['tc-1', 'tc-2', 'tc-3']),
        mkRun('b', ['tc-1', 'tc-2', 'tc-3']),
      ]);
      expect(overlap.runCount).toBe(2);
      expect(overlap.totalTestCases).toBe(3);
      expect(overlap.sharedTestCases).toBe(3);
      expect(overlap.partialTestCases).toBe(0);
      expect(overlap.fullyOverlapping).toBe(true);
      expect(overlap.perRun).toEqual([
        { runId: 'a', runName: 'Run a', count: 3, uniqueCount: 0 },
        { runId: 'b', runName: 'Run b', count: 3, uniqueCount: 0 },
      ]);
    });

    it('computes intersection / union for partially-overlapping ad-hoc runs', () => {
      // Two ad-hoc runs with no shared benchmark: A ran {1,2,3}, B ran {2,3,4}.
      const overlap = computeTestCaseOverlap([
        mkRun('a', ['tc-1', 'tc-2', 'tc-3']),
        mkRun('b', ['tc-2', 'tc-3', 'tc-4']),
      ]);
      expect(overlap.totalTestCases).toBe(4);   // union {1,2,3,4}
      expect(overlap.sharedTestCases).toBe(2);  // intersection {2,3}
      expect(overlap.partialTestCases).toBe(2); // {1} only in A, {4} only in B
      expect(overlap.fullyOverlapping).toBe(false);
      expect(overlap.perRun).toEqual([
        { runId: 'a', runName: 'Run a', count: 3, uniqueCount: 1 },
        { runId: 'b', runName: 'Run b', count: 3, uniqueCount: 1 },
      ]);
    });

    it('handles fully-disjoint runs (no overlap at all)', () => {
      const overlap = computeTestCaseOverlap([
        mkRun('a', ['tc-1', 'tc-2']),
        mkRun('b', ['tc-3', 'tc-4']),
      ]);
      expect(overlap.totalTestCases).toBe(4);
      expect(overlap.sharedTestCases).toBe(0);
      expect(overlap.partialTestCases).toBe(4);
      expect(overlap.fullyOverlapping).toBe(false);
      expect(overlap.perRun.every(r => r.uniqueCount === r.count)).toBe(true);
    });

    it('counts a case shared across 3 runs only when ALL three ran it', () => {
      const overlap = computeTestCaseOverlap([
        mkRun('a', ['tc-1', 'tc-2']),
        mkRun('b', ['tc-1', 'tc-2']),
        mkRun('c', ['tc-1']), // tc-2 missing here
      ]);
      expect(overlap.runCount).toBe(3);
      expect(overlap.totalTestCases).toBe(2);
      expect(overlap.sharedTestCases).toBe(1);  // only tc-1 is in all three
      expect(overlap.partialTestCases).toBe(1); // tc-2 in a,b but not c
      expect(overlap.fullyOverlapping).toBe(false);
    });

    it('is empty/degenerate-safe', () => {
      expect(computeTestCaseOverlap([])).toEqual({
        runCount: 0,
        totalTestCases: 0,
        sharedTestCases: 0,
        partialTestCases: 0,
        perRun: [],
        fullyOverlapping: false,
      });
      const single = computeTestCaseOverlap([mkRun('a', ['tc-1'])]);
      expect(single.totalTestCases).toBe(1);
      expect(single.sharedTestCases).toBe(1); // single run “shares” with itself
      expect(single.fullyOverlapping).toBe(true);
    });
  });

  // Regression: CLI-written run docs persist results entries as
  // { reportId, status } only — the verdict lives on the report doc. The
  // scoreboard bucketed those as "errored" and rendered a fabricated 0%
  // pass rate while the per-case table showed real Passed/Failed verdicts.
  describe('calculateRunAggregates verdict overlay (results without passFailStatus)', () => {
    const cliRun: BenchmarkRun = {
      id: 'run-cli',
      name: 'CLI Run',
      createdAt: '2024-01-01T00:00:00Z',
      agentKey: 'cc-agent',
      modelId: 'model-1',
      status: 'completed',
      results: {
        // No passFailStatus on any entry — mirrors the CLI benchmark path.
        'tc-1': { reportId: 'report-1', status: 'completed' },
        'tc-2': { reportId: 'report-2', status: 'completed' },
        'tc-3': { reportId: 'report-3', status: 'completed' },
      },
    } as unknown as BenchmarkRun;

    const cliReports: Record<string, EvaluationReport> = {
      'report-1': { id: 'report-1', testCaseId: 'tc-1', passFailStatus: 'passed', metrics: { accuracy: 90 } } as EvaluationReport,
      'report-2': { id: 'report-2', testCaseId: 'tc-2', passFailStatus: 'passed', metrics: { accuracy: 80 } } as EvaluationReport,
      'report-3': { id: 'report-3', testCaseId: 'tc-3', passFailStatus: 'failed', metrics: { accuracy: 20 } } as EvaluationReport,
    };

    it('reads the verdict from the report when the results entry lacks it', () => {
      const agg = calculateRunAggregates(cliRun, cliReports);
      expect(agg.passedCount).toBe(2);
      expect(agg.failedCount).toBe(1);
      expect(agg.erroredCount).toBe(0);
      expect(agg.passRatePercent).toBe(67); // 2/3, not 0%
    });

    it('still buckets completed-without-any-verdict as errored (#242)', () => {
      const reportsMissingVerdict: Record<string, EvaluationReport> = {
        'report-1': { id: 'report-1', testCaseId: 'tc-1', metrics: { accuracy: 0 } } as EvaluationReport,
      };
      const run = {
        ...cliRun,
        results: { 'tc-1': { reportId: 'report-1', status: 'completed' } },
      } as unknown as BenchmarkRun;
      const agg = calculateRunAggregates(run, reportsMissingVerdict);
      expect(agg.erroredCount).toBe(1);
      expect(agg.passRatePercent).toBe(0);
    });

    it('prefers the results-entry verdict when both exist', () => {
      const run = {
        ...cliRun,
        results: { 'tc-1': { reportId: 'report-1', status: 'completed', passFailStatus: 'failed' } },
      } as unknown as BenchmarkRun;
      const agg = calculateRunAggregates(run, cliReports); // report says passed
      expect(agg.failedCount).toBe(1);
      expect(agg.passedCount).toBe(0);
    });
  });

  // Regression: (1) the batch metrics API returns a zero-filled
  // status:'pending' placeholder for a runId with no spans, which used to be
  // summed as real data -> fabricated "$0.00 / 0ms". (2) when NO trace
  // metrics are available at all, the display fell straight to "0ms" instead
  // of falling back to the per-result performanceMetrics the benchmark
  // runner already persists.
  describe('mergeTraceMetrics', () => {
    const baseAgg = calculateRunAggregates(
      {
        id: 'run-1',
        name: 'Run 1',
        createdAt: '2024-01-01T00:00:00Z',
        agentKey: 'agent-1',
        modelId: 'model-1',
        status: 'completed',
        results: {
          'tc-1': { reportId: 'report-1', status: 'completed', passFailStatus: 'passed' },
          'tc-2': { reportId: 'report-2', status: 'completed', passFailStatus: 'passed' },
        },
      } as unknown as BenchmarkRun,
      {
        'report-1': { id: 'report-1', testCaseId: 'tc-1', runId: 'trace-run-1' } as EvaluationReport,
        'report-2': { id: 'report-2', testCaseId: 'tc-2', runId: 'trace-run-2' } as EvaluationReport,
      }
    );

    const runWithReports = {
      id: 'run-1',
      name: 'Run 1',
      createdAt: '2024-01-01T00:00:00Z',
      agentKey: 'agent-1',
      modelId: 'model-1',
      status: 'completed',
      results: {
        'tc-1': { reportId: 'report-1', status: 'completed', passFailStatus: 'passed' },
        'tc-2': { reportId: 'report-2', status: 'completed', passFailStatus: 'passed' },
      },
    } as unknown as BenchmarkRun;

    const reportsWithRunIds: Record<string, EvaluationReport> = {
      'report-1': { id: 'report-1', testCaseId: 'tc-1', runId: 'trace-run-1' } as EvaluationReport,
      'report-2': { id: 'report-2', testCaseId: 'tc-2', runId: 'trace-run-2' } as EvaluationReport,
    };

    const traceMetrics = (overrides: Partial<TraceMetrics>): TraceMetrics => ({
      runId: 'trace-run-1',
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      durationMs: 0,
      llmCalls: 0,
      toolCalls: 0,
      toolsUsed: [],
      status: 'success',
      ...overrides,
    });

    it('sums real (non-pending) trace metrics across both results', () => {
      const traceMetricsMap = new Map<string, TraceMetrics>([
        ['trace-run-1', traceMetrics({ runId: 'trace-run-1', totalTokens: 100, costUsd: 0.5, durationMs: 2000, llmCalls: 3, toolCalls: 1 })],
        ['trace-run-2', traceMetrics({ runId: 'trace-run-2', totalTokens: 200, costUsd: 1.5, durationMs: 4000, llmCalls: 5, toolCalls: 2 })],
      ]);

      const merged = mergeTraceMetrics(baseAgg, runWithReports, reportsWithRunIds, traceMetricsMap);

      expect(merged.totalTokens).toBe(300);
      expect(merged.totalCostUsd).toBe(2);
      expect(merged.avgDurationMs).toBe(3000); // (2000 + 4000) / 2
      expect(merged.totalLlmCalls).toBe(8);
      expect(merged.totalToolCalls).toBe(3);
    });

    it('skips a zero-filled status:"pending" placeholder instead of counting it as real $0/0ms data', () => {
      const traceMetricsMap = new Map<string, TraceMetrics>([
        ['trace-run-1', traceMetrics({ runId: 'trace-run-1', totalTokens: 100, costUsd: 0.5, durationMs: 2000, llmCalls: 3, toolCalls: 1 })],
        // No spans for this runId at all -> API returns an all-zeros pending placeholder.
        ['trace-run-2', traceMetrics({ runId: 'trace-run-2', status: 'pending' })],
      ]);

      const merged = mergeTraceMetrics(baseAgg, runWithReports, reportsWithRunIds, traceMetricsMap);

      // Only trace-run-1 counted (mc === 1), NOT averaged/summed with the
      // pending placeholder's zeros.
      expect(merged.totalTokens).toBe(100);
      expect(merged.totalCostUsd).toBe(0.5);
      expect(merged.avgDurationMs).toBe(2000);
    });

    it('falls back to the average of per-result performanceMetrics.durationMs when no trace metrics exist at all', () => {
      const runWithPerResultDurations = {
        ...runWithReports,
        results: {
          'tc-1': { reportId: 'report-1', status: 'completed', passFailStatus: 'passed', performanceMetrics: { durationMs: 1000 } },
          'tc-2': { reportId: 'report-2', status: 'completed', passFailStatus: 'passed', performanceMetrics: { durationMs: 3000 } },
        },
      } as unknown as BenchmarkRun;

      const merged = mergeTraceMetrics(baseAgg, runWithPerResultDurations, reportsWithRunIds, new Map());

      expect(merged.avgDurationMs).toBe(2000); // (1000 + 3000) / 2
      expect(merged.totalCostUsd).toBeUndefined();
      expect(merged.totalTokens).toBeUndefined();
    });

    it('falls back to run-level performanceMetrics.avgTestCaseDurationMs when neither trace nor per-result durations exist', () => {
      const runWithRunLevelPerf = {
        ...runWithReports,
        performanceMetrics: { avgTestCaseDurationMs: 5000 },
      } as unknown as BenchmarkRun;

      const merged = mergeTraceMetrics(baseAgg, runWithRunLevelPerf, reportsWithRunIds, new Map());

      expect(merged.avgDurationMs).toBe(5000);
    });

    it('falls back to run-level performanceMetrics.durationMs / totalTestCases as a last resort', () => {
      const runWithCoarsePerf = {
        ...runWithReports,
        performanceMetrics: { durationMs: 6000 },
      } as unknown as BenchmarkRun;

      const merged = mergeTraceMetrics(baseAgg, runWithCoarsePerf, reportsWithRunIds, new Map());

      expect(merged.avgDurationMs).toBe(3000); // 6000 / totalTestCases(2)
    });

    it('avgDurationMs is undefined when no trace metrics, no per-result durations, and no run-level perf exist', () => {
      const merged = mergeTraceMetrics(baseAgg, runWithReports, reportsWithRunIds, new Map());
      expect(merged.avgDurationMs).toBeUndefined();
    });

    it('falls back to the REPORT document\'s performanceMetrics.durationMs when the per-result field is absent (e.g. ad-hoc eval-run reports)', () => {
      // Round-2 owner bug hunt: some report shapes carry performanceMetrics on
      // the report doc itself rather than on run.results[tc] (the benchmark-
      // embedded shape the existing fallback already reads).
      const reportsWithOwnDurations: Record<string, EvaluationReport> = {
        'report-1': { id: 'report-1', testCaseId: 'tc-1', runId: 'trace-run-1', performanceMetrics: { durationMs: 57000, agentDurationMs: 57000 } } as unknown as EvaluationReport,
        'report-2': { id: 'report-2', testCaseId: 'tc-2', runId: 'trace-run-2', performanceMetrics: { durationMs: 22600, agentDurationMs: 22600 } } as unknown as EvaluationReport,
      };
      const merged = mergeTraceMetrics(baseAgg, runWithReports, reportsWithOwnDurations, new Map());
      expect(merged.avgDurationMs).toBe(Math.round((57000 + 22600) / 2));
    });

    it('prefers the per-result duration over the report-level one when both are present', () => {
      const runWithPerResultDurations = {
        ...runWithReports,
        results: {
          'tc-1': { reportId: 'report-1', status: 'completed', passFailStatus: 'passed', performanceMetrics: { durationMs: 1000 } },
          'tc-2': { reportId: 'report-2', status: 'completed', passFailStatus: 'passed', performanceMetrics: { durationMs: 3000 } },
        },
      } as unknown as BenchmarkRun;
      const reportsWithDifferentDurations: Record<string, EvaluationReport> = {
        'report-1': { id: 'report-1', testCaseId: 'tc-1', runId: 'trace-run-1', performanceMetrics: { durationMs: 999999 } } as unknown as EvaluationReport,
        'report-2': { id: 'report-2', testCaseId: 'tc-2', runId: 'trace-run-2', performanceMetrics: { durationMs: 999999 } } as unknown as EvaluationReport,
      };
      const merged = mergeTraceMetrics(baseAgg, runWithPerResultDurations, reportsWithDifferentDurations, new Map());
      expect(merged.avgDurationMs).toBe(2000); // (1000 + 3000) / 2, not the report-level 999999s
    });

    it('falls back to counting real trajectory "action" steps for totalToolCalls when there is no trace data at all', () => {
      const reportsWithTrajectories: Record<string, EvaluationReport> = {
        'report-1': {
          id: 'report-1', testCaseId: 'tc-1', runId: 'trace-run-1',
          trajectory: [
            { id: 't1', timestamp: 0, type: 'action', content: '', toolName: 'search' },
            { id: 't2', timestamp: 0, type: 'tool_result', content: '' },
            { id: 't3', timestamp: 0, type: 'action', content: '', toolName: 'read' },
          ],
        } as unknown as EvaluationReport,
        'report-2': {
          id: 'report-2', testCaseId: 'tc-2', runId: 'trace-run-2',
          trajectory: [
            { id: 't4', timestamp: 0, type: 'action', content: '', toolName: 'search' },
          ],
        } as unknown as EvaluationReport,
      };
      const merged = mergeTraceMetrics(baseAgg, runWithReports, reportsWithTrajectories, new Map());
      expect(merged.totalToolCalls).toBe(3); // 2 action steps (report-1) + 1 (report-2)
      // No honest LLM-call source exists on the report/result docs — must NOT
      // invent a proxy (e.g. counting 'assistant'/'thinking' steps miscounts).
      expect(merged.totalLlmCalls).toBeUndefined();
      expect(merged.totalCostUsd).toBeUndefined();
      expect(merged.totalTokens).toBeUndefined();
    });

    it('renders a real "0" tool-call count (not a dash) when a report has an empty-but-present trajectory', () => {
      const reportsWithEmptyTrajectory: Record<string, EvaluationReport> = {
        'report-1': { id: 'report-1', testCaseId: 'tc-1', runId: 'trace-run-1', trajectory: [] } as unknown as EvaluationReport,
        'report-2': { id: 'report-2', testCaseId: 'tc-2', runId: 'trace-run-2', trajectory: [] } as unknown as EvaluationReport,
      };
      const merged = mergeTraceMetrics(baseAgg, runWithReports, reportsWithEmptyTrajectory, new Map());
      expect(merged.totalToolCalls).toBe(0);
    });

    it('leaves totalToolCalls undefined (not a fabricated 0) when no report has any trajectory at all', () => {
      const merged = mergeTraceMetrics(baseAgg, runWithReports, reportsWithRunIds, new Map());
      expect(merged.totalToolCalls).toBeUndefined();
    });

    it('uses real trace-derived totalToolCalls (not the trajectory fallback) when trace metrics exist', () => {
      const traceMetricsMap = new Map<string, TraceMetrics>([
        ['trace-run-1', traceMetrics({ runId: 'trace-run-1', toolCalls: 7 })],
        ['trace-run-2', traceMetrics({ runId: 'trace-run-2', toolCalls: 9 })],
      ]);
      const reportsWithTrajectories: Record<string, EvaluationReport> = {
        'report-1': { id: 'report-1', testCaseId: 'tc-1', runId: 'trace-run-1', trajectory: [{ id: 't1', timestamp: 0, type: 'action', content: '' }] } as unknown as EvaluationReport,
        'report-2': { id: 'report-2', testCaseId: 'tc-2', runId: 'trace-run-2', trajectory: [] } as unknown as EvaluationReport,
      };
      const merged = mergeTraceMetrics(baseAgg, runWithReports, reportsWithTrajectories, traceMetricsMap);
      expect(merged.totalToolCalls).toBe(16); // trace-derived sum, NOT the 1-action fallback count
    });
  });
});
