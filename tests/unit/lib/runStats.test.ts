/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { calculateRunStats, getReportIdsFromRun, bucketRunResults, computeRunStats, getEffectiveRunStatus, isRunInProgress } from '@/lib/runStats';
import type { BenchmarkRun, EvaluationReport } from '@/types';

describe('runStats', () => {
  describe('calculateRunStats', () => {
    it('should count passed and failed based on passFailStatus', () => {
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
          agentName: 'Mock Agent',
          modelName: 'Claude Sonnet',
          timestamp: '2024-01-01T00:00:00Z',
          llmJudgeReasoning: 'Good',
        } as EvaluationReport,
        'report-2': {
          id: 'report-2',
          testCaseId: 'tc-2',
          status: 'completed',
          passFailStatus: 'failed',
          trajectory: [],
          metrics: { accuracy: 50 },
          agentName: 'Mock Agent',
          modelName: 'Claude Sonnet',
          timestamp: '2024-01-01T00:00:00Z',
          llmJudgeReasoning: 'Needs work',
        } as EvaluationReport,
        'report-3': {
          id: 'report-3',
          testCaseId: 'tc-3',
          status: 'completed',
          passFailStatus: 'passed',
          trajectory: [],
          metrics: { accuracy: 85 },
          agentName: 'Mock Agent',
          modelName: 'Claude Sonnet',
          timestamp: '2024-01-01T00:00:00Z',
          llmJudgeReasoning: 'Great',
        } as EvaluationReport,
      };

      const stats = calculateRunStats(run, reports);

      expect(stats.passed).toBe(2);
      expect(stats.failed).toBe(1);
      expect(stats.pending).toBe(0);
      expect(stats.total).toBe(3);
      expect(stats.passRate).toBe(67); // 2/3 = 66.67% rounded
    });

    it('should treat pending and running results as pending', () => {
      const run: BenchmarkRun = {
        id: 'run-1',
        name: 'Test Run',
        createdAt: '2024-01-01T00:00:00Z',
        agentKey: 'mock',
        modelId: 'claude-sonnet',
        results: {
          'tc-1': { reportId: 'report-1', status: 'completed' },
          'tc-2': { reportId: '', status: 'pending' },
          'tc-3': { reportId: '', status: 'running' },
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
          agentName: 'Mock Agent',
          modelName: 'Claude Sonnet',
          timestamp: '2024-01-01T00:00:00Z',
          llmJudgeReasoning: 'Good',
        } as EvaluationReport,
      };

      const stats = calculateRunStats(run, reports);

      expect(stats.passed).toBe(1);
      expect(stats.failed).toBe(0);
      expect(stats.pending).toBe(2);
      expect(stats.total).toBe(3);
      expect(stats.passRate).toBe(33); // 1/3 total test cases passed
    });

    it('should treat failed and cancelled results as failed', () => {
      const run: BenchmarkRun = {
        id: 'run-1',
        name: 'Test Run',
        createdAt: '2024-01-01T00:00:00Z',
        agentKey: 'mock',
        modelId: 'claude-sonnet',
        results: {
          'tc-1': { reportId: 'report-1', status: 'completed' },
          'tc-2': { reportId: '', status: 'failed' },
          'tc-3': { reportId: '', status: 'cancelled' },
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
          agentName: 'Mock Agent',
          modelName: 'Claude Sonnet',
          timestamp: '2024-01-01T00:00:00Z',
          llmJudgeReasoning: 'Good',
        } as EvaluationReport,
      };

      const stats = calculateRunStats(run, reports);

      expect(stats.passed).toBe(1);
      expect(stats.failed).toBe(2);
      expect(stats.pending).toBe(0);
      expect(stats.total).toBe(3);
      expect(stats.passRate).toBe(33); // 1/3 = 33.33% rounded
    });

    it('should treat missing reports as pending', () => {
      const run: BenchmarkRun = {
        id: 'run-1',
        name: 'Test Run',
        createdAt: '2024-01-01T00:00:00Z',
        agentKey: 'mock',
        modelId: 'claude-sonnet',
        results: {
          'tc-1': { reportId: 'report-1', status: 'completed' },
          'tc-2': { reportId: 'report-2', status: 'completed' }, // Report not in map
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
          agentName: 'Mock Agent',
          modelName: 'Claude Sonnet',
          timestamp: '2024-01-01T00:00:00Z',
          llmJudgeReasoning: 'Good',
        } as EvaluationReport,
        // report-2 is missing
      };

      const stats = calculateRunStats(run, reports);

      expect(stats.passed).toBe(1);
      expect(stats.failed).toBe(0);
      expect(stats.pending).toBe(1);
      expect(stats.total).toBe(2);
    });

    it('should treat trace mode pending metrics as pending', () => {
      const run: BenchmarkRun = {
        id: 'run-1',
        name: 'Test Run',
        createdAt: '2024-01-01T00:00:00Z',
        agentKey: 'mock',
        modelId: 'claude-sonnet',
        results: {
          'tc-1': { reportId: 'report-1', status: 'completed' },
          'tc-2': { reportId: 'report-2', status: 'completed' },
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
          agentName: 'Mock Agent',
          modelName: 'Claude Sonnet',
          timestamp: '2024-01-01T00:00:00Z',
          llmJudgeReasoning: 'Good',
        } as EvaluationReport,
        'report-2': {
          id: 'report-2',
          testCaseId: 'tc-2',
          status: 'completed',
          metricsStatus: 'calculating', // Trace mode - waiting for traces
          trajectory: [],
          metrics: { accuracy: 0 },
          agentName: 'Mock Agent',
          modelName: 'Claude Sonnet',
          timestamp: '2024-01-01T00:00:00Z',
          llmJudgeReasoning: '',
        } as EvaluationReport,
      };

      const stats = calculateRunStats(run, reports);

      expect(stats.passed).toBe(1);
      expect(stats.failed).toBe(0);
      expect(stats.pending).toBe(1);
      expect(stats.total).toBe(2);
    });

    it('should handle empty results', () => {
      const run: BenchmarkRun = {
        id: 'run-1',
        name: 'Test Run',
        createdAt: '2024-01-01T00:00:00Z',
        agentKey: 'mock',
        modelId: 'claude-sonnet',
        results: {},
      };

      const stats = calculateRunStats(run, {});

      expect(stats.passed).toBe(0);
      expect(stats.failed).toBe(0);
      expect(stats.pending).toBe(0);
      expect(stats.total).toBe(0);
      expect(stats.passRate).toBe(0);
    });

    it('should treat undefined passFailStatus as failed', () => {
      const run: BenchmarkRun = {
        id: 'run-1',
        name: 'Test Run',
        createdAt: '2024-01-01T00:00:00Z',
        agentKey: 'mock',
        modelId: 'claude-sonnet',
        results: {
          'tc-1': { reportId: 'report-1', status: 'completed' },
        },
      };

      const reports: Record<string, EvaluationReport | null> = {
        'report-1': {
          id: 'report-1',
          testCaseId: 'tc-1',
          status: 'completed',
          // passFailStatus is undefined
          trajectory: [],
          metrics: { accuracy: 50 },
          agentName: 'Mock Agent',
          modelName: 'Claude Sonnet',
          timestamp: '2024-01-01T00:00:00Z',
          llmJudgeReasoning: 'Unknown',
        } as EvaluationReport,
      };

      const stats = calculateRunStats(run, reports);

      expect(stats.passed).toBe(0);
      expect(stats.failed).toBe(1);
      expect(stats.total).toBe(1);
    });
  });

  describe('getReportIdsFromRun', () => {
    it('should extract all report IDs from run results', () => {
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

    it('should return empty array when no results', () => {
      const run: BenchmarkRun = {
        id: 'run-1',
        name: 'Test Run',
        createdAt: '2024-01-01T00:00:00Z',
        agentKey: 'mock',
        modelId: 'claude-sonnet',
        results: {},
      };

      const reportIds = getReportIdsFromRun(run);

      expect(reportIds).toHaveLength(0);
    });

    it('should handle undefined results', () => {
      const run: BenchmarkRun = {
        id: 'run-1',
        name: 'Test Run',
        createdAt: '2024-01-01T00:00:00Z',
        agentKey: 'mock',
        modelId: 'claude-sonnet',
        results: undefined as any,
      };

      const reportIds = getReportIdsFromRun(run);

      expect(reportIds).toHaveLength(0);
    });

    it('should deduplicate report IDs', () => {
      const run: BenchmarkRun = {
        id: 'run-1',
        name: 'Test Run',
        createdAt: '2024-01-01T00:00:00Z',
        agentKey: 'mock',
        modelId: 'claude-sonnet',
        results: {
          'tc-1': { reportId: 'report-1', status: 'completed' },
          'tc-2': { reportId: 'report-1', status: 'completed' }, // Same report ID
        },
      };

      const reportIds = getReportIdsFromRun(run);

      expect(reportIds).toHaveLength(1);
      expect(reportIds).toContain('report-1');
    });
  });

  describe('bucketRunResults', () => {
    // The single source of truth for pass/fail/errored counts (runs list AND
    // comparison), computed from persisted per-case verdicts — no reports.
    it('counts a completed result with no verdict as errored, not passed (#242)', () => {
      const b = bucketRunResults({
        a: { status: 'completed', passFailStatus: 'passed' },
        b: { status: 'completed', passFailStatus: 'passed' },
        c: { status: 'completed' }, // judge errored — no verdict persisted
      });
      expect(b).toEqual({ passed: 2, failed: 0, errored: 1, pending: 0, total: 3 });
    });

    it('buckets failed/cancelled as failed and pending/running as pending', () => {
      const b = bucketRunResults({
        a: { status: 'completed', passFailStatus: 'passed' },
        b: { status: 'failed', passFailStatus: 'failed' },
        c: { status: 'cancelled' },
        d: { status: 'running' },
        e: { status: 'pending' },
      });
      expect(b).toEqual({ passed: 1, failed: 2, errored: 0, pending: 2, total: 5 });
    });

    it('handles empty/undefined results', () => {
      expect(bucketRunResults({})).toEqual({ passed: 0, failed: 0, errored: 0, pending: 0, total: 0 });
      expect(bucketRunResults(undefined)).toEqual({ passed: 0, failed: 0, errored: 0, pending: 0, total: 0 });
    });

    // Bug (2026-09-01): the runs list showed no in-flight indication for a
    // genuinely running run — root cause was `total` reporting only the
    // count of test cases that have STARTED (i.e. have a `results` entry),
    // not the run's planned size. A run 9 cases into a planned 62 looked
    // identical to a tiny, already-finished 9-case run.
    describe('plannedTotal (in-flight total fix)', () => {
      it('folds the shortfall between plannedTotal and observed results into pending', () => {
        const b = bucketRunResults(
          { a: { status: 'failed' }, b: { status: 'failed' } },
          62
        );
        expect(b).toEqual({ passed: 0, failed: 2, errored: 0, pending: 60, total: 62 });
      });

      it('is a no-op when plannedTotal equals the observed count (a genuinely completed run)', () => {
        const b = bucketRunResults(
          { a: { status: 'completed', passFailStatus: 'passed' }, b: { status: 'completed', passFailStatus: 'failed' } },
          2
        );
        expect(b).toEqual({ passed: 1, failed: 1, errored: 0, pending: 0, total: 2 });
      });

      it('is a no-op when plannedTotal is smaller than the observed count (never shrinks total)', () => {
        const b = bucketRunResults(
          { a: { status: 'completed', passFailStatus: 'passed' }, b: { status: 'completed', passFailStatus: 'passed' } },
          1
        );
        expect(b.total).toBe(2);
      });

      it('is a no-op when plannedTotal is omitted (back-compat, existing callers unaffected)', () => {
        const b = bucketRunResults({ a: { status: 'failed' } });
        expect(b).toEqual({ passed: 0, failed: 1, errored: 0, pending: 0, total: 1 });
      });
    });
  });

  describe('computeRunStats', () => {
    // Regression for the trace-judged run.stats inflation bug: a run whose
    // denormalized `stats` says everything passed, but whose `results`
    // (the real source of truth) carry mixed verdicts, must display the
    // REAL numbers — never the stale denormalized ones.
    it('prefers results-derived verdicts over a stale/inflated run.stats blob', () => {
      const run = {
        results: {
          'tc-1': { status: 'completed', passFailStatus: 'passed' },
          'tc-2': { status: 'completed', passFailStatus: 'passed' },
          'tc-3': { status: 'completed', passFailStatus: 'failed' },
          'tc-4': { status: 'completed', passFailStatus: 'failed' },
        },
        // Buggy denormalized stats as written by the pre-fix trace-judged
        // path: every 'completed' result counted as passed.
        stats: { passed: 4, failed: 0, pending: 0, errored: 0, total: 4 },
      };

      expect(computeRunStats(run)).toEqual({ passed: 2, failed: 2, errored: 0, pending: 0, total: 4 });
    });

    it('falls back to run.stats when results is empty (run has not started / legacy data)', () => {
      const run = {
        results: {},
        stats: { passed: 3, failed: 1, pending: 0, errored: 0, total: 4 },
      };

      expect(computeRunStats(run)).toEqual({ passed: 3, failed: 1, errored: 0, pending: 0, total: 4 });
    });

    it('returns all-zero stats when neither results nor stats are present', () => {
      expect(computeRunStats({})).toEqual({ passed: 0, failed: 0, errored: 0, pending: 0, total: 0 });
    });

    it('treats an explicit empty results object the same as absent results (falls back to stats)', () => {
      const run = { results: {}, stats: { passed: 2, failed: 0, pending: 0, errored: 0, total: 2 } };
      expect(computeRunStats(run)).toEqual({ passed: 2, failed: 0, errored: 0, pending: 0, total: 2 });
    });

    it('falls through to all-zero when results is empty and stats.total is 0 (run not started)', () => {
      const run = { results: {}, stats: { passed: 0, failed: 0, pending: 0, errored: 0, total: 0 } };
      expect(computeRunStats(run)).toEqual({ passed: 0, failed: 0, errored: 0, pending: 0, total: 0 });
    });

    it('falls through to all-zero when results is empty and stats is entirely absent', () => {
      const run = { results: {} };
      expect(computeRunStats(run)).toEqual({ passed: 0, failed: 0, errored: 0, pending: 0, total: 0 });
    });

    it('defaults missing individual stats fields to 0 (partial/legacy stats blob)', () => {
      const run = { results: {}, stats: { total: 5 } as any };
      expect(computeRunStats(run)).toEqual({ passed: 0, failed: 0, errored: 0, pending: 0, total: 5 });
    });

    it('threads run.testCaseSnapshots.length through as plannedTotal for an in-progress run', () => {
      const run = {
        results: { 'tc-1': { status: 'failed' }, 'tc-2': { status: 'failed' } },
        testCaseSnapshots: new Array(62).fill({ id: 'x', version: 1, name: 'x' }),
      };
      expect(computeRunStats(run)).toEqual({ passed: 0, failed: 2, errored: 0, pending: 60, total: 62 });
    });

    it('does not affect a completed run whose testCaseSnapshots length already matches results', () => {
      const run = {
        results: { 'tc-1': { status: 'completed', passFailStatus: 'passed' }, 'tc-2': { status: 'completed', passFailStatus: 'failed' } },
        testCaseSnapshots: [{}, {}],
      };
      expect(computeRunStats(run)).toEqual({ passed: 1, failed: 1, errored: 0, pending: 0, total: 2 });
    });

    it('reports the planned total (not 0) when a run has testCaseSnapshots but no results yet at all', () => {
      const run = { results: {}, testCaseSnapshots: new Array(10).fill({}) };
      expect(computeRunStats(run)).toEqual({ passed: 0, failed: 0, errored: 0, pending: 0, total: 10 });
    });
  });

  describe('getEffectiveRunStatus / isRunInProgress (bug #5/#6: no in-flight indication on runs-list pages)', () => {
    it('trusts an explicit status field first', () => {
      expect(getEffectiveRunStatus({ status: 'running' })).toBe('running');
      expect(getEffectiveRunStatus({ status: 'completed' })).toBe('completed');
      expect(isRunInProgress({ status: 'running' })).toBe(true);
      expect(isRunInProgress({ status: 'completed' })).toBe(false);
    });

    it('falls back to inspecting results for legacy runs with no top-level status', () => {
      expect(getEffectiveRunStatus({ results: { a: { status: 'running' } } })).toBe('running');
      expect(getEffectiveRunStatus({ results: { a: { status: 'pending' } } })).toBe('running');
      expect(getEffectiveRunStatus({ results: { a: { status: 'completed' } } })).toBe('completed');
      expect(getEffectiveRunStatus({ results: {} })).toBe('failed');
    });
  });

  describe('producer/consumer agreement (double-correction regression)', () => {
    // evaluationRunner's run-completion writer (the "producer") now sets
    // `run.stats` to `{ ...bucketRunResults(run.results), total }` instead
    // of the old naive "every completed = passed" loop. `computeRunStats`
    // (the "consumer", used by the run detail/list pages) ALSO recomputes
    // from `run.results` via the same `bucketRunResults` when results are
    // present. Both paths must land on the exact same numbers for the same
    // run — if either side ever re-applies a correction on top of the
    // other's already-corrected output (e.g. consumer double-discounting
    // `errored`, or producer pre-aggregating before the consumer's
    // recompute), the two views would silently diverge again exactly like
    // the original trace-judged-stats bug this PR fixes.
    it('producer-side run.stats (bucketRunResults) and consumer-side computeRunStats agree for a seeded mixed-verdict run', () => {
      const results: Record<string, { status?: string; passFailStatus?: string }> = {
        'tc-1': { status: 'completed', passFailStatus: 'passed' },
        'tc-2': { status: 'completed', passFailStatus: 'passed' },
        'tc-3': { status: 'completed', passFailStatus: 'failed' },
        'tc-4': { status: 'completed' }, // trace-judged, judge errored: no verdict
        'tc-5': { status: 'running' },
        'tc-6': { status: 'failed' },
      };
      const totalTestCases = Object.keys(results).length;

      // Mirror evaluationRunner.ts's producer-side write exactly:
      //   const bucketed = bucketRunResults(run.results);
      //   run.stats = { ...bucketed, total: totalTestCases };
      const producerStats = { ...bucketRunResults(results), total: totalTestCases };

      // Consumer path: computeRunStats(run) recomputes from run.results
      // directly (bucketRunResults again), NOT from the just-written
      // run.stats — so this also proves the consumer doesn't trust a
      // possibly-stale denormalized blob when fresh results exist.
      const run = { results, stats: producerStats };
      const consumerStats = computeRunStats(run);

      expect(consumerStats).toEqual({
        passed: producerStats.passed,
        failed: producerStats.failed,
        errored: producerStats.errored,
        pending: producerStats.pending,
        total: producerStats.total,
      });
      // Pin the actual numbers so a change in bucketing semantics is caught
      // even if both sides regressed identically.
      expect(consumerStats).toEqual({ passed: 2, failed: 2, errored: 1, pending: 1, total: 6 });
    });

    it('agrees even when computeRunStats falls back to the producer-written run.stats (no results persisted)', () => {
      const producerStats = { passed: 5, failed: 1, errored: 1, pending: 0, total: 7 };
      const run = { results: {}, stats: producerStats };
      expect(computeRunStats(run)).toEqual(producerStats);
    });
  });
});
