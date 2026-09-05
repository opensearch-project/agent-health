/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { calculateRunStats, getReportIdsFromRun, bucketRunResults, computeRunStats, getEffectiveRunStatus, isRunInProgress, isTerminalRunStatus, passRateOverJudged } from '@/lib/runStats';
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

    it('treats failed results as failed and cancelled (never-started) results as notRun', () => {
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
      expect(stats.failed).toBe(1);
      expect(stats.notRun).toBe(1);
      expect(stats.pending).toBe(0);
      expect(stats.total).toBe(3);
      // Pass rate over the evaluable set: the cancelled case never ran, so
      // it is excluded from the denominator (1 of 2 executed = 50%).
      expect(stats.passRate).toBe(50);
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
      expect(b).toEqual({ passed: 2, failed: 0, errored: 1, notRun: 0, pending: 0, total: 3 });
    });

    it('buckets failed as failed, cancelled (never started) as notRun, and pending/running as pending', () => {
      const b = bucketRunResults({
        a: { status: 'completed', passFailStatus: 'passed' },
        b: { status: 'failed', passFailStatus: 'failed' },
        c: { status: 'cancelled' },
        d: { status: 'running' },
        e: { status: 'pending' },
      });
      expect(b).toEqual({ passed: 1, failed: 1, errored: 0, notRun: 1, pending: 2, total: 5 });
    });

    it('handles empty/undefined results', () => {
      expect(bucketRunResults({})).toEqual({ passed: 0, failed: 0, errored: 0, notRun: 0, pending: 0, total: 0 });
      expect(bucketRunResults(undefined)).toEqual({ passed: 0, failed: 0, errored: 0, notRun: 0, pending: 0, total: 0 });
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
        expect(b).toEqual({ passed: 0, failed: 2, errored: 0, notRun: 0, pending: 60, total: 62 });
      });

      it('is a no-op when plannedTotal equals the observed count (a genuinely completed run)', () => {
        const b = bucketRunResults(
          { a: { status: 'completed', passFailStatus: 'passed' }, b: { status: 'completed', passFailStatus: 'failed' } },
          2
        );
        expect(b).toEqual({ passed: 1, failed: 1, errored: 0, notRun: 0, pending: 0, total: 2 });
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
        expect(b).toEqual({ passed: 0, failed: 1, errored: 0, notRun: 0, pending: 0, total: 1 });
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

      expect(computeRunStats(run)).toEqual({ passed: 2, failed: 2, errored: 0, notRun: 0, pending: 0, total: 4 });
    });

    it('falls back to run.stats when results is empty (run has not started / legacy data)', () => {
      const run = {
        results: {},
        stats: { passed: 3, failed: 1, pending: 0, errored: 0, total: 4 },
      };

      expect(computeRunStats(run)).toEqual({ passed: 3, failed: 1, errored: 0, notRun: 0, pending: 0, total: 4 });
    });

    it('returns all-zero stats when neither results nor stats are present', () => {
      expect(computeRunStats({})).toEqual({ passed: 0, failed: 0, errored: 0, notRun: 0, pending: 0, total: 0 });
    });

    it('treats an explicit empty results object the same as absent results (falls back to stats)', () => {
      const run = { results: {}, stats: { passed: 2, failed: 0, pending: 0, errored: 0, total: 2 } };
      expect(computeRunStats(run)).toEqual({ passed: 2, failed: 0, errored: 0, notRun: 0, pending: 0, total: 2 });
    });

    it('falls through to all-zero when results is empty and stats.total is 0 (run not started)', () => {
      const run = { results: {}, stats: { passed: 0, failed: 0, pending: 0, errored: 0, total: 0 } };
      expect(computeRunStats(run)).toEqual({ passed: 0, failed: 0, errored: 0, notRun: 0, pending: 0, total: 0 });
    });

    it('falls through to all-zero when results is empty and stats is entirely absent', () => {
      const run = { results: {} };
      expect(computeRunStats(run)).toEqual({ passed: 0, failed: 0, errored: 0, notRun: 0, pending: 0, total: 0 });
    });

    it('defaults missing individual stats fields to 0 (partial/legacy stats blob)', () => {
      const run = { results: {}, stats: { total: 5 } as any };
      expect(computeRunStats(run)).toEqual({ passed: 0, failed: 0, errored: 0, notRun: 0, pending: 0, total: 5 });
    });

    // Regression for the benchmark-runs-list "every row shows 0 passed / 0
    // failed / N errored" bug (owner-reported on a Feb 2026 pulsar benchmark,
    // v8, exp-1765401828206-yq9ychdhu). Root cause: these runs predate
    // evaluationRunner.ts's per-result passFailStatus write, so their
    // persisted `results[testCaseId]` only ever carried
    // `{ reportId, status: 'completed' }` -- the exact shape below, taken
    // from the live doc (run-1772045410778-kndnkja4w). The linked reports
    // DO have real verdicts (verified live: 4 reports with passFailStatus
    // 'passed', 3 with 'failed', all metricsStatus 'ready') and that split
    // is exactly what the denormalized `run.stats` already recorded --
    // bucketRunResults just can't see it because it never looks at reports,
    // only at `results`.
    it('falls back to run.stats for legacy runs whose results carry no passFailStatus at all (all-errored bucketing) but stats has real verdict evidence', () => {
      const run = {
        results: {
          'tc-1765401719989-2pw5h9dmk': { reportId: 'run-1772045530260-bvf4ko26q', status: 'completed' },
          'tc-1765309559268-sc3iqnxp4': { reportId: 'run-1772045613371-li31jemot', status: 'completed' },
          'tc-1765309559361-qo2zet9n0': { reportId: 'run-1772046217427-n4tv7vvtr', status: 'completed' },
          'tc-1768926669257-idup9grc7': { reportId: 'run-1772045768365-yho8vdydu', status: 'completed' },
          'tc-1765322629983-iall3egke': { reportId: 'run-1772045435841-0vizambtl', status: 'completed' },
          'tc-1765309559452-7s5c5irsj': { reportId: 'run-1772046000950-fj058hzfg', status: 'completed' },
          'tc-1765309559544-75a9fafl5': { reportId: 'run-1772045939125-f7cooj9hr', status: 'completed' },
        },
        // Denormalized at run-completion time by the (correct, report-fetching)
        // computeStatsForRun -- matches the live doc's run.stats exactly.
        stats: { total: 7, pending: 0, passed: 4, failed: 3 },
      };

      // bucketRunResults(run.results) alone would say { passed: 0, failed: 0,
      // errored: 7, pending: 0, total: 7 } -- every case wrongly marked
      // "errored: no judge verdict" despite 7/7 having real verdicts.
      expect(bucketRunResults(run.results)).toEqual({ passed: 0, failed: 0, errored: 7, notRun: 0, pending: 0, total: 7 });

      expect(computeRunStats(run)).toEqual({ passed: 4, failed: 3, errored: 0, notRun: 0, pending: 0, total: 7 });
    });

    it('does NOT fall back to run.stats when a run is genuinely all-errored (no verdict evidence anywhere)', () => {
      const run = {
        results: {
          'tc-1': { reportId: 'report-1', status: 'completed' },
          'tc-2': { reportId: 'report-2', status: 'completed' },
        },
        // Never refreshed / no verdicts ever resolved -- stats agrees it's all-errored.
        stats: { total: 2, pending: 0, passed: 0, failed: 0, errored: 2 },
      };

      expect(computeRunStats(run)).toEqual({ passed: 0, failed: 0, errored: 2, notRun: 0, pending: 0, total: 2 });
    });

    it('does not use the legacy fallback when results already carry a mix of real verdicts and errors (not all-errored)', () => {
      const run = {
        results: {
          'tc-1': { status: 'completed', passFailStatus: 'passed' },
          'tc-2': { status: 'completed' }, // genuinely errored (judge failure)
        },
        // Stale/irrelevant stats blob -- must be ignored since results already
        // resolved real (non-all-errored) verdicts.
        stats: { total: 2, pending: 0, passed: 0, failed: 0, errored: 0 },
      };

      expect(computeRunStats(run)).toEqual({ passed: 1, failed: 0, errored: 1, notRun: 0, pending: 0, total: 2 });
    });

    it('threads run.testCaseSnapshots.length through as plannedTotal for an in-progress run', () => {
      const run = {
        results: { 'tc-1': { status: 'failed' }, 'tc-2': { status: 'failed' } },
        testCaseSnapshots: new Array(62).fill({ id: 'x', version: 1, name: 'x' }),
      };
      expect(computeRunStats(run)).toEqual({ passed: 0, failed: 2, errored: 0, notRun: 0, pending: 60, total: 62 });
    });

    it('does not affect a completed run whose testCaseSnapshots length already matches results', () => {
      const run = {
        results: { 'tc-1': { status: 'completed', passFailStatus: 'passed' }, 'tc-2': { status: 'completed', passFailStatus: 'failed' } },
        testCaseSnapshots: [{}, {}],
      };
      expect(computeRunStats(run)).toEqual({ passed: 1, failed: 1, errored: 0, notRun: 0, pending: 0, total: 2 });
    });

    it('reports the planned total (not 0) when a run has testCaseSnapshots but no results yet at all', () => {
      const run = { results: {}, testCaseSnapshots: new Array(10).fill({}) };
      // No explicit status → not known to be terminal → the planned cases are
      // still to come (pending), not "not run".
      expect(computeRunStats(run)).toEqual({ passed: 0, failed: 0, errored: 0, notRun: 0, pending: 10, total: 10 });
    });
  });

  // ─── Terminal-aware bucketing (phantom-pending on cancelled/failed runs) ──
  //
  // Bug (2026-09-04, live runs list): a run cancelled at 34/62 showed a
  // "Cancelled" badge AND "28 pending ⟳" — the planned-but-never-started
  // remainder was folded into `pending` regardless of the run's TERMINAL
  // status. Same for a `failed` run (executor crash) at 37/62. Nothing will
  // ever start those cases; they are `notRun`, never a spinner.
  describe('bucketRunResults / computeRunStats — terminal-aware (no phantom pending)', () => {
    const partial = {
      'tc-1': { status: 'completed', passFailStatus: 'passed' },
      'tc-2': { status: 'completed', passFailStatus: 'failed' },
      'tc-3': { status: 'completed' }, // errored (no verdict)
      'tc-4': { status: 'failed' },
    } as Record<string, { status?: string; passFailStatus?: string }>;
    const PLANNED = 10;

    it.each([
      ['running',   { pending: 6, notRun: 0 }],
      ['pending',   { pending: 6, notRun: 0 }],
      [undefined,   { pending: 6, notRun: 0 }],
      ['cancelled', { pending: 0, notRun: 6 }],
      ['failed',    { pending: 0, notRun: 6 }],
      ['completed', { pending: 0, notRun: 6 }],
    ] as const)('status=%s: planned-but-absent remainder buckets as %o', (status, expected) => {
      const b = bucketRunResults(partial, PLANNED, status as any);
      expect(b).toEqual({ passed: 1, failed: 2, errored: 1, total: PLANNED, ...expected });
      // Invariant holds in every row of the matrix.
      expect(b.passed + b.failed + b.errored + b.pending + b.notRun).toBe(b.total);
    });

    it('on a terminal run, entries left in pending/running by a dead executor are notRun, not pending', () => {
      const results = { a: { status: 'running' }, b: { status: 'pending' }, c: { status: 'completed', passFailStatus: 'passed' } };
      expect(bucketRunResults(results, 3, 'cancelled')).toEqual({ passed: 1, failed: 0, errored: 0, pending: 0, notRun: 2, total: 3 });
      expect(bucketRunResults(results, 3, 'failed')).toEqual({ passed: 1, failed: 0, errored: 0, pending: 0, notRun: 2, total: 3 });
      // …but while the run is genuinely running they ARE pending.
      expect(bucketRunResults(results, 3, 'running')).toEqual({ passed: 1, failed: 0, errored: 0, pending: 2, notRun: 0, total: 3 });
    });

    it('explicit `status: cancelled` result markers (written for never-started cases at finalization) bucket as notRun in every run status', () => {
      const results = { a: { status: 'cancelled' }, b: { status: 'completed', passFailStatus: 'passed' } };
      for (const status of ['running', 'cancelled', 'completed', undefined] as const) {
        expect(bucketRunResults(results, 2, status as any).notRun).toBe(1);
        expect(bucketRunResults(results, 2, status as any).failed).toBe(0);
      }
    });

    it('computeRunStats threads run.status: the live S1 shape (cancelled, 34/62) has zero pending and 28 notRun', () => {
      const results: Record<string, { status: string; passFailStatus?: string }> = {};
      for (let i = 0; i < 34; i++) results[`tc-${i}`] = { status: 'completed', passFailStatus: i % 3 === 0 ? 'failed' : 'passed' };
      const run = {
        status: 'cancelled' as const,
        completedAt: '2026-09-04T00:00:00Z',
        results,
        testCaseSnapshots: new Array(62).fill({ id: 'x', version: 1, name: 'x' }),
      };
      const stats = computeRunStats(run);
      expect(stats.pending).toBe(0);
      expect(stats.notRun).toBe(28);
      expect(stats.total).toBe(62);
      expect(stats.passed + stats.failed).toBe(34);
      // A cancelled run's pass rate is over the EXECUTED cases only.
      expect(passRateOverJudged(stats)).toBe(Math.round((stats.passed / 34) * 100));
      expect(isRunInProgress(run)).toBe(false);
      expect(getEffectiveRunStatus(run)).toBe('cancelled');
    });

    it('computeRunStats: the live S2 shape (failed run, 37/62 with 5 execution failures) has zero pending', () => {
      const results: Record<string, { status: string; passFailStatus?: string }> = {};
      for (let i = 0; i < 32; i++) results[`tc-${i}`] = { status: 'completed' }; // no verdict → errored
      for (let i = 32; i < 37; i++) results[`tc-${i}`] = { status: 'failed' };
      const run = { status: 'failed' as const, results, testCaseSnapshots: new Array(62).fill({}) };
      expect(computeRunStats(run)).toEqual({ passed: 0, failed: 5, errored: 32, pending: 0, notRun: 25, total: 62 });
      expect(isRunInProgress(run)).toBe(false);
    });

    it('computeRunStats: the SAME partial results on a running run are still pending (regression guard for the in-flight fix)', () => {
      const run = { status: 'running' as const, results: { 'tc-1': { status: 'failed' } }, testCaseSnapshots: new Array(5).fill({}) };
      expect(computeRunStats(run)).toEqual({ passed: 0, failed: 1, errored: 0, pending: 4, notRun: 0, total: 5 });
      expect(isRunInProgress(run)).toBe(true);
    });

    it('computeRunStats re-homes stale `pending` in a legacy denormalized stats blob when the run is terminal', () => {
      const run = { status: 'cancelled' as const, results: {}, stats: { passed: 3, failed: 1, pending: 6, total: 10 } };
      expect(computeRunStats(run)).toEqual({ passed: 3, failed: 1, errored: 0, pending: 0, notRun: 6, total: 10 });
      const running = { status: 'running' as const, results: {}, stats: { passed: 3, failed: 1, pending: 6, total: 10 } };
      expect(computeRunStats(running)).toEqual({ passed: 3, failed: 1, errored: 0, pending: 6, notRun: 0, total: 10 });
    });

    it('computeRunStats: a cancelled run that never started a single case is all notRun', () => {
      const run = { status: 'cancelled' as const, results: {}, testCaseSnapshots: new Array(7).fill({}) };
      expect(computeRunStats(run)).toEqual({ passed: 0, failed: 0, errored: 0, pending: 0, notRun: 7, total: 7 });
    });

    it('an entry with an unrecognised status is pending on a live run but surfaces as errored (not hidden in notRun) on a terminal run', () => {
      const results = { a: { status: 'bogus' }, b: { status: 'completed', passFailStatus: 'passed' } };
      expect(bucketRunResults(results, 2, 'running')).toEqual({ passed: 1, failed: 0, errored: 0, pending: 1, notRun: 0, total: 2 });
      expect(bucketRunResults(results, 2, 'completed')).toEqual({ passed: 1, failed: 0, errored: 1, pending: 0, notRun: 0, total: 2 });
    });

    it('isTerminalRunStatus', () => {
      expect(isTerminalRunStatus('completed')).toBe(true);
      expect(isTerminalRunStatus('cancelled')).toBe(true);
      expect(isTerminalRunStatus('failed')).toBe(true);
      expect(isTerminalRunStatus('running')).toBe(false);
      expect(isTerminalRunStatus('pending')).toBe(false);
      expect(isTerminalRunStatus(undefined)).toBe(false);
    });

    it('passRateOverJudged: judged-only denominator, null when nothing judged', () => {
      expect(passRateOverJudged({ passed: 3, failed: 1 })).toBe(75);
      expect(passRateOverJudged({ passed: 0, failed: 0 })).toBeNull();
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
        notRun: 0, pending: producerStats.pending,
        total: producerStats.total,
      });
      // Pin the actual numbers so a change in bucketing semantics is caught
      // even if both sides regressed identically.
      expect(consumerStats).toEqual({ passed: 2, failed: 2, errored: 1, notRun: 0, pending: 1, total: 6 });
    });

    it('agrees even when computeRunStats falls back to the producer-written run.stats (no results persisted)', () => {
      const producerStats = { passed: 5, failed: 1, errored: 1, pending: 0, notRun: 0, total: 7 };
      const run = { results: {}, stats: producerStats };
      expect(computeRunStats(run)).toEqual(producerStats);
    });
  });
});
