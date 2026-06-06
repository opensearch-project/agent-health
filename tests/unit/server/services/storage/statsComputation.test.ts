/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { computeStatsForRun, RunStats } from '@/server/services/storage/statsComputation';

jest.mock('@/server/services/opensearchClient', () => ({
  INDEXES: {
    testCases: 'evals_test_cases',
    benchmarks: 'evals_experiments',
    runs: 'evals_runs',
    analytics: 'evals_analytics',
  },
}));

describe('statsComputation', () => {
  let mockClient: { search: jest.Mock };
  let consoleWarnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient = {
      search: jest.fn(),
    };
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
  });

  describe('computeStatsForRun', () => {
    it('should return all zeros when run has no results', async () => {
      const run = {};
      const stats = await computeStatsForRun(mockClient as any, run);

      expect(stats).toEqual({ passed: 0, failed: 0, pending: 0, errored: 0, total: 0 });
      expect(mockClient.search).not.toHaveBeenCalled();
    });

    it('should return all zeros when results is undefined', async () => {
      const run = { results: undefined };
      const stats = await computeStatsForRun(mockClient as any, run);

      expect(stats).toEqual({ passed: 0, failed: 0, pending: 0, errored: 0, total: 0 });
      expect(mockClient.search).not.toHaveBeenCalled();
    });

    it('should return all zeros when results is an empty object', async () => {
      const run = { results: {} };
      const stats = await computeStatsForRun(mockClient as any, run);

      expect(stats).toEqual({ passed: 0, failed: 0, pending: 0, errored: 0, total: 0 });
      expect(mockClient.search).not.toHaveBeenCalled();
    });

    it('should count passed and failed from fetched reports', async () => {
      const run = {
        results: {
          'tc-1': { reportId: 'report-1', status: 'completed' },
          'tc-2': { reportId: 'report-2', status: 'completed' },
          'tc-3': { reportId: 'report-3', status: 'completed' },
        },
      };

      mockClient.search.mockResolvedValue({
        body: {
          hits: {
            hits: [
              { _source: { id: 'report-1', passFailStatus: 'passed' } },
              { _source: { id: 'report-2', passFailStatus: 'failed' } },
              { _source: { id: 'report-3', passFailStatus: 'passed' } },
            ],
          },
        },
      });

      const stats = await computeStatsForRun(mockClient as any, run);

      expect(stats).toEqual({ passed: 2, failed: 1, pending: 0, errored: 0, total: 3 });
      expect(mockClient.search).toHaveBeenCalledWith({
        index: 'evals_runs',
        body: {
          size: 3,
          query: {
            terms: { id: ['report-1', 'report-2', 'report-3'] },
          },
          _source: ['id', 'passFailStatus', 'metricsStatus', 'status'],
        },
      });
    });

    it('should count pending and running status results as pending', async () => {
      const run = {
        results: {
          'tc-1': { reportId: 'report-1', status: 'pending' },
          'tc-2': { reportId: 'report-2', status: 'running' },
          'tc-3': { reportId: 'report-3', status: 'completed' },
        },
      };

      mockClient.search.mockResolvedValue({
        body: {
          hits: {
            hits: [
              { _source: { id: 'report-3', passFailStatus: 'passed' } },
            ],
          },
        },
      });

      const stats = await computeStatsForRun(mockClient as any, run);

      expect(stats).toEqual({ passed: 1, failed: 0, pending: 2, errored: 0, total: 3 });
    });

    it('should count failed and cancelled status results as failed', async () => {
      const run = {
        results: {
          'tc-1': { reportId: 'report-1', status: 'failed' },
          'tc-2': { reportId: 'report-2', status: 'cancelled' },
          'tc-3': { reportId: 'report-3', status: 'completed' },
        },
      };

      mockClient.search.mockResolvedValue({
        body: {
          hits: {
            hits: [
              { _source: { id: 'report-3', passFailStatus: 'passed' } },
            ],
          },
        },
      });

      const stats = await computeStatsForRun(mockClient as any, run);

      expect(stats).toEqual({ passed: 1, failed: 2, pending: 0, errored: 0, total: 3 });
    });

    it('should count completed results with missing reports as pending', async () => {
      const run = {
        results: {
          'tc-1': { reportId: 'report-1', status: 'completed' },
          'tc-2': { reportId: 'report-2', status: 'completed' },
        },
      };

      // Only one report returned from OpenSearch; report-2 is missing
      mockClient.search.mockResolvedValue({
        body: {
          hits: {
            hits: [
              { _source: { id: 'report-1', passFailStatus: 'passed' } },
            ],
          },
        },
      });

      const stats = await computeStatsForRun(mockClient as any, run);

      expect(stats).toEqual({ passed: 1, failed: 0, pending: 1, errored: 0, total: 2 });
    });

    it('should count completed results with no reportId as pending', async () => {
      const run = {
        results: {
          'tc-1': { reportId: 'report-1', status: 'completed' },
          'tc-2': { reportId: '', status: 'completed' },
        },
      };

      mockClient.search.mockResolvedValue({
        body: {
          hits: {
            hits: [
              { _source: { id: 'report-1', passFailStatus: 'passed' } },
            ],
          },
        },
      });

      const stats = await computeStatsForRun(mockClient as any, run);

      expect(stats).toEqual({ passed: 1, failed: 0, pending: 1, errored: 0, total: 2 });
    });

    it('should count results with metricsStatus pending as pending', async () => {
      const run = {
        results: {
          'tc-1': { reportId: 'report-1', status: 'completed' },
        },
      };

      mockClient.search.mockResolvedValue({
        body: {
          hits: {
            hits: [
              { _source: { id: 'report-1', passFailStatus: 'passed', metricsStatus: 'pending' } },
            ],
          },
        },
      });

      const stats = await computeStatsForRun(mockClient as any, run);

      expect(stats).toEqual({ passed: 0, failed: 0, pending: 1, errored: 0, total: 1 });
    });

    it('should count results with metricsStatus calculating as pending', async () => {
      const run = {
        results: {
          'tc-1': { reportId: 'report-1', status: 'completed' },
        },
      };

      mockClient.search.mockResolvedValue({
        body: {
          hits: {
            hits: [
              { _source: { id: 'report-1', passFailStatus: 'passed', metricsStatus: 'calculating' } },
            ],
          },
        },
      });

      const stats = await computeStatsForRun(mockClient as any, run);

      expect(stats).toEqual({ passed: 0, failed: 0, pending: 1, errored: 0, total: 1 });
    });

    it('should handle mixed statuses correctly in a single run', async () => {
      const run = {
        results: {
          'tc-1': { reportId: 'report-1', status: 'completed' },   // passed via report
          'tc-2': { reportId: 'report-2', status: 'completed' },   // failed via report
          'tc-3': { reportId: 'report-3', status: 'pending' },     // pending (status)
          'tc-4': { reportId: 'report-4', status: 'running' },     // pending (status)
          'tc-5': { reportId: 'report-5', status: 'failed' },      // failed (status)
          'tc-6': { reportId: 'report-6', status: 'cancelled' },   // failed (status)
          'tc-7': { reportId: 'report-7', status: 'completed' },   // pending (metricsStatus)
          'tc-8': { reportId: 'report-8', status: 'completed' },   // pending (missing report)
        },
      };

      mockClient.search.mockResolvedValue({
        body: {
          hits: {
            hits: [
              { _source: { id: 'report-1', passFailStatus: 'passed' } },
              { _source: { id: 'report-2', passFailStatus: 'failed' } },
              { _source: { id: 'report-7', passFailStatus: 'passed', metricsStatus: 'calculating' } },
              // report-8 not returned (missing)
            ],
          },
        },
      });

      const stats = await computeStatsForRun(mockClient as any, run);

      // passed: tc-1
      // failed: tc-2 (report), tc-5 (status), tc-6 (status) = 3
      // pending: tc-3 (pending status), tc-4 (running status), tc-7 (metricsStatus calculating), tc-8 (missing report) = 4
      expect(stats).toEqual({ passed: 1, failed: 3, pending: 4, errored: 0, total: 8 });
    });

    describe('no reportIds path (behavioral fix)', () => {
      it('should count failed/cancelled status as failed when no reportIds exist', async () => {
        const run = {
          results: {
            'tc-1': { reportId: '', status: 'failed' },
            'tc-2': { reportId: '', status: 'cancelled' },
            'tc-3': { reportId: '', status: 'pending' },
          },
        };

        const stats = await computeStatsForRun(mockClient as any, run);

        // The critical behavioral fix: failed/cancelled results should be counted
        // as failed even when there are no reportIds, not all as pending.
        expect(stats).toEqual({ passed: 0, failed: 2, pending: 1, errored: 0, total: 3 });
        expect(mockClient.search).not.toHaveBeenCalled();
      });

      it('should count all results as pending when all have non-terminal status and no reportIds', async () => {
        const run = {
          results: {
            'tc-1': { reportId: '', status: 'pending' },
            'tc-2': { reportId: '', status: 'running' },
          },
        };

        const stats = await computeStatsForRun(mockClient as any, run);

        expect(stats).toEqual({ passed: 0, failed: 0, pending: 2, errored: 0, total: 2 });
        expect(mockClient.search).not.toHaveBeenCalled();
      });

      it('should count all results as failed when all have terminal failure status and no reportIds', async () => {
        const run = {
          results: {
            'tc-1': { reportId: '', status: 'failed' },
            'tc-2': { reportId: '', status: 'cancelled' },
            'tc-3': { reportId: '', status: 'failed' },
          },
        };

        const stats = await computeStatsForRun(mockClient as any, run);

        expect(stats).toEqual({ passed: 0, failed: 3, pending: 0, errored: 0, total: 3 });
        expect(mockClient.search).not.toHaveBeenCalled();
      });

      it('should handle mixed statuses without reportIds', async () => {
        const run = {
          results: {
            'tc-1': { reportId: '', status: 'failed' },
            'tc-2': { reportId: '', status: 'pending' },
            'tc-3': { reportId: '', status: 'cancelled' },
            'tc-4': { reportId: '', status: 'running' },
            'tc-5': { reportId: '', status: 'completed' },
          },
        };

        const stats = await computeStatsForRun(mockClient as any, run);

        // failed: tc-1, tc-3 = 2
        // pending: tc-2, tc-4, tc-5 (completed but no reportId, falls to else) = 3
        expect(stats).toEqual({ passed: 0, failed: 2, pending: 3, errored: 0, total: 5 });
        expect(mockClient.search).not.toHaveBeenCalled();
      });
    });

    describe('error fetching reports fallback', () => {
      it('should fall back to status-only counting on search error', async () => {
        const run = {
          results: {
            'tc-1': { reportId: 'report-1', status: 'completed' },
            'tc-2': { reportId: 'report-2', status: 'failed' },
            'tc-3': { reportId: 'report-3', status: 'cancelled' },
            'tc-4': { reportId: 'report-4', status: 'pending' },
          },
        };

        mockClient.search.mockRejectedValue(new Error('Connection refused'));

        const stats = await computeStatsForRun(mockClient as any, run);

        // Fallback: completed → pending, failed → failed, cancelled → failed, pending → pending
        expect(stats).toEqual({ passed: 0, failed: 2, pending: 2, errored: 0, total: 4 });
        expect(consoleWarnSpy).toHaveBeenCalledWith(
          '[StatsComputation] Failed to fetch reports for stats computation:',
          'Connection refused'
        );
      });

      it('should treat completed as pending in error fallback', async () => {
        const run = {
          results: {
            'tc-1': { reportId: 'report-1', status: 'completed' },
            'tc-2': { reportId: 'report-2', status: 'completed' },
          },
        };

        mockClient.search.mockRejectedValue(new Error('Timeout'));

        const stats = await computeStatsForRun(mockClient as any, run);

        expect(stats).toEqual({ passed: 0, failed: 0, pending: 2, errored: 0, total: 2 });
      });

      it('should count running as pending in error fallback', async () => {
        const run = {
          results: {
            'tc-1': { reportId: 'report-1', status: 'running' },
          },
        };

        mockClient.search.mockRejectedValue(new Error('Network error'));

        const stats = await computeStatsForRun(mockClient as any, run);

        expect(stats).toEqual({ passed: 0, failed: 0, pending: 1, errored: 0, total: 1 });
      });
    });

    describe('edge cases', () => {
      it('should handle empty hits array from OpenSearch', async () => {
        const run = {
          results: {
            'tc-1': { reportId: 'report-1', status: 'completed' },
          },
        };

        mockClient.search.mockResolvedValue({
          body: {
            hits: {
              hits: [],
            },
          },
        });

        const stats = await computeStatsForRun(mockClient as any, run);

        // Completed but report not found → pending
        expect(stats).toEqual({ passed: 0, failed: 0, pending: 1, errored: 0, total: 1 });
      });

      it('should handle undefined hits from OpenSearch', async () => {
        const run = {
          results: {
            'tc-1': { reportId: 'report-1', status: 'completed' },
          },
        };

        mockClient.search.mockResolvedValue({
          body: {
            hits: undefined,
          },
        });

        const stats = await computeStatsForRun(mockClient as any, run);

        // Completed but report not found (hits undefined) → pending
        expect(stats).toEqual({ passed: 0, failed: 0, pending: 1, errored: 0, total: 1 });
      });

      it('should only include truthy reportIds in the search query', async () => {
        const run = {
          results: {
            'tc-1': { reportId: 'report-1', status: 'completed' },
            'tc-2': { reportId: '', status: 'completed' },
            'tc-3': { reportId: 'report-3', status: 'completed' },
          },
        };

        mockClient.search.mockResolvedValue({
          body: {
            hits: {
              hits: [
                { _source: { id: 'report-1', passFailStatus: 'passed' } },
                { _source: { id: 'report-3', passFailStatus: 'failed' } },
              ],
            },
          },
        });

        const stats = await computeStatsForRun(mockClient as any, run);

        // Verify only truthy reportIds are searched
        expect(mockClient.search).toHaveBeenCalledWith(
          expect.objectContaining({
            body: expect.objectContaining({
              size: 2,
              query: {
                terms: { id: ['report-1', 'report-3'] },
              },
            }),
          })
        );

        // tc-1: passed, tc-2: pending (no reportId), tc-3: failed
        expect(stats).toEqual({ passed: 1, failed: 1, pending: 1, errored: 0, total: 3 });
      });

      it('should treat a report with non-passed passFailStatus as failed', async () => {
        const run = {
          results: {
            'tc-1': { reportId: 'report-1', status: 'completed' },
          },
        };

        mockClient.search.mockResolvedValue({
          body: {
            hits: {
              hits: [
                { _source: { id: 'report-1', passFailStatus: 'some-other-status' } },
              ],
            },
          },
        });

        const stats = await computeStatsForRun(mockClient as any, run);

        // Non-'passed' passFailStatus counts as failed
        expect(stats).toEqual({ passed: 0, failed: 1, pending: 0, errored: 0, total: 1 });
      });

      // Issue #242: evaluator could not produce a verdict (e.g. judge
      // validation error, trace timeout) is bucketed as `errored`, NOT
      // `failed`, so misconfigured evaluators don't poison pass rates.
      it('should count metricsStatus="error" as errored, not failed', async () => {
        const run = {
          results: {
            'tc-1': { reportId: 'report-1', status: 'completed' },
            'tc-2': { reportId: 'report-2', status: 'completed' },
            'tc-3': { reportId: 'report-3', status: 'completed' },
          },
        };

        mockClient.search.mockResolvedValue({
          body: {
            hits: {
              hits: [
                // A genuine pass
                { _source: { id: 'report-1', passFailStatus: 'passed' } },
                // A genuine fail (agent answered wrong)
                { _source: { id: 'report-2', passFailStatus: 'failed' } },
                // Evaluator never ran (judge validation error). passFailStatus
                // may be 'failed', 'passed', or undefined here — metricsStatus
                // wins and the result must bucket as errored.
                { _source: { id: 'report-3', passFailStatus: 'failed', metricsStatus: 'error' } },
              ],
            },
          },
        });

        const stats = await computeStatsForRun(mockClient as any, run);

        expect(stats).toEqual({ passed: 1, failed: 1, pending: 0, errored: 1, total: 3 });
      });

      it('does not let metricsStatus="error" sneak into passed even if passFailStatus is passed', async () => {
        // Defensive: if some upstream code forgot to clear passFailStatus when
        // marking the run errored, metricsStatus must still take precedence.
        const run = {
          results: { 'tc-1': { reportId: 'report-1', status: 'completed' } },
        };
        mockClient.search.mockResolvedValue({
          body: {
            hits: {
              hits: [
                { _source: { id: 'report-1', passFailStatus: 'passed', metricsStatus: 'error' } },
              ],
            },
          },
        });
        const stats = await computeStatsForRun(mockClient as any, run);
        expect(stats).toEqual({ passed: 0, failed: 0, pending: 0, errored: 1, total: 1 });
      });
    });
  });
});
