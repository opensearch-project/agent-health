/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for benchmark stats backfill and refresh functionality
 *
 * The route now uses the storage adapter (getStorageModule()) instead of raw
 * OpenSearch client for stats-related operations:
 * - backfillRunStats() uses adapter for persistence
 * - computeStatsForRun(run) uses adapter to fetch reports (when no client param)
 * - refresh-all-stats / refresh-stats endpoints use adapter
 * - PATCH stats endpoint uses adapter
 */

import { jest } from '@jest/globals';

// Mock adapter storage operations
const mockBenchmarkGetById = jest.fn();
const mockBenchmarkUpdateRun = jest.fn();
const mockRunGetById = jest.fn();

jest.mock('@/server/adapters/index', () => ({
  getStorageModule: jest.fn().mockReturnValue({
    isConfigured: jest.fn().mockReturnValue(true),
    benchmarks: {
      getAll: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      getById: (...args: any[]) => mockBenchmarkGetById(...args),
      updateRun: (...args: any[]) => mockBenchmarkUpdateRun(...args),
    },
    runs: {
      getById: (...args: any[]) => mockRunGetById(...args),
    },
    testCases: {
      getAll: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    },
  }),
}));

// Mock the storageClient middleware (still used by execute endpoint and isStorageAvailable)
jest.mock('@/server/middleware/storageClient', () => ({
  isStorageAvailable: jest.fn().mockReturnValue(true),
  requireStorageClient: jest.fn().mockReturnValue({
    get: jest.fn(),
    search: jest.fn(),
    update: jest.fn(),
  }),
  INDEXES: {
    benchmarks: 'evals_benchmarks',
    runs: 'evals_runs',
  },
}));

jest.mock('@/lib/debug', () => ({
  debug: jest.fn(),
}));

// Mock sample data modules to avoid loading real sample data
jest.mock('@/cli/demo/sampleBenchmarks', () => ({
  SAMPLE_BENCHMARKS: [],
  isSampleBenchmarkId: (id: string) => id.startsWith('demo-'),
}));

jest.mock('@/cli/demo/sampleTestCases', () => ({
  SAMPLE_TEST_CASES: [],
}));

jest.mock('@/lib/benchmarkExport', () => ({
  convertTestCasesToExportFormat: jest.fn(),
  generateExportFilename: jest.fn(),
}));

jest.mock('@/services/benchmarkRunner', () => ({
  executeRun: jest.fn(),
  createCancellationToken: jest.fn(() => ({
    isCancelled: false,
    cancel: jest.fn(),
  })),
}));

import type { Application } from 'express';
import type { BenchmarkRun, RunStats } from '@/types';

// Use require for CommonJS module compatibility in Jest
const request = require('supertest');

// Silence console output
beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  jest.restoreAllMocks();
});

describe('Benchmark Stats Backfill', () => {
  let app: Application;

  beforeEach(() => {
    jest.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const express = require('express');
    app = express();
    app.use(express.json());

    // Default: adapter updateRun succeeds
    mockBenchmarkUpdateRun.mockResolvedValue(true);
  });

  describe('Stale Stats Detection', () => {
    it('should detect runs with missing stats', async () => {
      const runWithoutStats: Partial<BenchmarkRun> = {
        id: 'run-1',
        status: 'completed',
        results: {
          'tc-1': { reportId: 'report-1', status: 'completed' },
          'tc-2': { reportId: 'report-2', status: 'completed' },
        },
        // stats is missing
      };

      const benchmarkData = {
        id: 'bench-1',
        name: 'Test Benchmark',
        testCaseIds: ['tc-1', 'tc-2'],
        runs: [runWithoutStats],
      };

      // Mock adapter getById to return the benchmark
      mockBenchmarkGetById.mockResolvedValueOnce(benchmarkData);

      // Mock adapter runs.getById for each report (used by computeStatsForRun via adapter path)
      mockRunGetById
        .mockResolvedValueOnce({ id: 'report-1', passFailStatus: 'passed', metricsStatus: 'ready' })
        .mockResolvedValueOnce({ id: 'report-2', passFailStatus: 'failed', metricsStatus: 'ready' });

      const router = await import('@/server/routes/storage/benchmarks');
      app.use(router.default);

      const response = await request(app).get('/api/storage/benchmarks/bench-1');

      expect(response.status).toBe(200);
      expect(response.body.runs[0].stats).toBeDefined();
      expect(response.body.runs[0].stats.passed).toBe(1);
      expect(response.body.runs[0].stats.failed).toBe(1);
      expect(response.body.runs[0].stats.pending).toBe(0);
    });

    it('should detect runs with stale stats (pending > 0 when all completed)', async () => {
      const runWithStaleStats: Partial<BenchmarkRun> = {
        id: 'run-2',
        status: 'completed',
        stats: { passed: 1, failed: 0, pending: 1, errored: 0, total: 2 }, // STALE: shows 1 pending
        results: {
          'tc-1': { reportId: 'report-1', status: 'completed' },
          'tc-2': { reportId: 'report-2', status: 'completed' }, // Actually completed
        },
      };

      const benchmarkData = {
        id: 'bench-2',
        name: 'Test Benchmark',
        testCaseIds: ['tc-1', 'tc-2'],
        runs: [runWithStaleStats],
      };

      mockBenchmarkGetById.mockResolvedValueOnce(benchmarkData);

      // Mock adapter runs.getById for each report
      mockRunGetById
        .mockResolvedValueOnce({ id: 'report-1', passFailStatus: 'passed', metricsStatus: 'ready' })
        .mockResolvedValueOnce({ id: 'report-2', passFailStatus: 'passed', metricsStatus: 'ready' });

      const router = await import('@/server/routes/storage/benchmarks');
      app.use(router.default);

      const response = await request(app).get('/api/storage/benchmarks/bench-2');

      expect(response.status).toBe(200);
      expect(response.body.runs[0].stats).toBeDefined();
      expect(response.body.runs[0].stats.passed).toBe(2);
      expect(response.body.runs[0].stats.failed).toBe(0);
      expect(response.body.runs[0].stats.pending).toBe(0); // Fixed!
    });

    it('should NOT backfill runs with correct stats', async () => {
      const runWithCorrectStats: Partial<BenchmarkRun> = {
        id: 'run-3',
        status: 'completed',
        stats: { passed: 2, failed: 0, pending: 0, errored: 0, total: 2 }, // Correct
        results: {
          'tc-1': { reportId: 'report-1', status: 'completed' },
          'tc-2': { reportId: 'report-2', status: 'completed' },
        },
      };

      const benchmarkData = {
        id: 'bench-3',
        name: 'Test Benchmark',
        testCaseIds: ['tc-1', 'tc-2'],
        runs: [runWithCorrectStats],
      };

      mockBenchmarkGetById.mockResolvedValueOnce(benchmarkData);

      const router = await import('@/server/routes/storage/benchmarks');
      app.use(router.default);

      const response = await request(app).get('/api/storage/benchmarks/bench-3');

      expect(response.status).toBe(200);
      // Should NOT call updateRun since stats are correct
      expect(mockBenchmarkUpdateRun).not.toHaveBeenCalled();
    });

    it('should handle trace-mode pending reports correctly', async () => {
      const runWithPendingTrace: Partial<BenchmarkRun> = {
        id: 'run-4',
        status: 'completed',
        stats: { passed: 1, failed: 0, pending: 1, errored: 0, total: 2 }, // Correct (1 still pending traces)
        results: {
          'tc-1': { reportId: 'report-1', status: 'completed' },
          'tc-2': { reportId: 'report-2', status: 'completed' }, // Completed but traces pending
        },
      };

      const benchmarkData = {
        id: 'bench-4',
        name: 'Test Benchmark',
        testCaseIds: ['tc-1', 'tc-2'],
        runs: [runWithPendingTrace],
      };

      mockBenchmarkGetById.mockResolvedValueOnce(benchmarkData);

      // Mock adapter runs.getById for each report
      mockRunGetById
        .mockResolvedValueOnce({ id: 'report-1', passFailStatus: 'passed', metricsStatus: 'ready' })
        .mockResolvedValueOnce({ id: 'report-2', passFailStatus: undefined, metricsStatus: 'pending' }); // Still pending

      const router = await import('@/server/routes/storage/benchmarks');
      app.use(router.default);

      const response = await request(app).get('/api/storage/benchmarks/bench-4');

      expect(response.status).toBe(200);
      // Stats should remain correct (1 pending)
      expect(response.body.runs[0].stats.pending).toBe(1);
    });
  });

  describe('Manual Stats Refresh Endpoints', () => {
    describe('POST /api/storage/benchmarks/:id/refresh-all-stats', () => {
      it('should refresh stats for all runs in benchmark', async () => {
        const benchmarkData = {
          id: 'bench-5',
          name: 'Test Benchmark',
          testCaseIds: ['tc-1', 'tc-2'],
          runs: [
            {
              id: 'run-1',
              status: 'completed',
              stats: { passed: 0, failed: 0, pending: 2, errored: 0, total: 2 }, // Stale
              results: {
                'tc-1': { reportId: 'report-1', status: 'completed' },
                'tc-2': { reportId: 'report-2', status: 'completed' },
              },
            },
            {
              id: 'run-2',
              status: 'completed',
              stats: { passed: 1, failed: 0, pending: 1, errored: 0, total: 2 }, // Stale
              results: {
                'tc-1': { reportId: 'report-3', status: 'completed' },
                'tc-2': { reportId: 'report-4', status: 'completed' },
              },
            },
          ],
        };

        // Mock adapter getById to return the benchmark
        mockBenchmarkGetById.mockResolvedValueOnce(benchmarkData);

        // Mock adapter runs.getById for reports of run-1
        mockRunGetById
          .mockResolvedValueOnce({ id: 'report-1', passFailStatus: 'passed', metricsStatus: 'ready' })
          .mockResolvedValueOnce({ id: 'report-2', passFailStatus: 'passed', metricsStatus: 'ready' })
          // Mock adapter runs.getById for reports of run-2
          .mockResolvedValueOnce({ id: 'report-3', passFailStatus: 'passed', metricsStatus: 'ready' })
          .mockResolvedValueOnce({ id: 'report-4', passFailStatus: 'failed', metricsStatus: 'ready' });

        mockBenchmarkUpdateRun.mockResolvedValue(true);

        const router = await import('@/server/routes/storage/benchmarks');
        app.use(router.default);

        const response = await request(app)
          .post('/api/storage/benchmarks/bench-5/refresh-all-stats');

        expect(response.status).toBe(200);
        expect(response.body.refreshed).toBe(2); // Both runs refreshed
        expect(mockBenchmarkUpdateRun).toHaveBeenCalledTimes(2); // Once per run via adapter
      });

      it('should return 404 for non-existent benchmark', async () => {
        mockBenchmarkGetById.mockResolvedValueOnce(null);

        const router = await import('@/server/routes/storage/benchmarks');
        app.use(router.default);

        const response = await request(app)
          .post('/api/storage/benchmarks/non-existent/refresh-all-stats');

        expect(response.status).toBe(404);
        expect(response.body.error).toContain('not found');
      });
    });

    describe('POST /api/storage/benchmarks/:id/runs/:runId/refresh-stats', () => {
      it('should refresh stats for specific run', async () => {
        const benchmarkData = {
          id: 'bench-6',
          name: 'Test Benchmark',
          testCaseIds: ['tc-1', 'tc-2'],
          runs: [
            {
              id: 'run-target',
              status: 'completed',
              stats: { passed: 0, failed: 0, pending: 2, errored: 0, total: 2 }, // Stale
              results: {
                'tc-1': { reportId: 'report-1', status: 'completed' },
                'tc-2': { reportId: 'report-2', status: 'completed' },
              },
            },
            {
              id: 'run-other',
              status: 'completed',
              stats: { passed: 1, failed: 1, pending: 0, errored: 0, total: 2 }, // Correct
              results: {
                'tc-1': { reportId: 'report-3', status: 'completed' },
                'tc-2': { reportId: 'report-4', status: 'completed' },
              },
            },
          ],
        };

        mockBenchmarkGetById.mockResolvedValueOnce(benchmarkData);

        // Mock adapter runs.getById for reports of target run
        mockRunGetById
          .mockResolvedValueOnce({ id: 'report-1', passFailStatus: 'passed', metricsStatus: 'ready' })
          .mockResolvedValueOnce({ id: 'report-2', passFailStatus: 'failed', metricsStatus: 'ready' });

        mockBenchmarkUpdateRun.mockResolvedValue(true);

        const router = await import('@/server/routes/storage/benchmarks');
        app.use(router.default);

        const response = await request(app)
          .post('/api/storage/benchmarks/bench-6/runs/run-target/refresh-stats');

        expect(response.status).toBe(200);
        expect(response.body.refreshed).toBe(true);
        expect(response.body.runId).toBe('run-target');
        expect(response.body.stats).toEqual({
          passed: 1,
          failed: 1,
          pending: 0,
          errored: 0,
          total: 2,
        });
        expect(mockBenchmarkUpdateRun).toHaveBeenCalledTimes(1); // Only target run updated
      });

      it('should return 404 for non-existent run', async () => {
        const benchmarkData = {
          id: 'bench-7',
          name: 'Test Benchmark',
          testCaseIds: ['tc-1'],
          runs: [
            {
              id: 'run-exists',
              status: 'completed',
              results: {},
            },
          ],
        };

        mockBenchmarkGetById.mockResolvedValueOnce(benchmarkData);

        const router = await import('@/server/routes/storage/benchmarks');
        app.use(router.default);

        const response = await request(app)
          .post('/api/storage/benchmarks/bench-7/runs/non-existent/refresh-stats');

        expect(response.status).toBe(404);
        expect(response.body.error).toContain('not found');
      });
    });
  });

  describe('Stats Computation Logic', () => {
    it('should correctly count passed/failed/pending from reports', async () => {
      const run: Partial<BenchmarkRun> = {
        id: 'run-test',
        status: 'completed',
        results: {
          'tc-1': { reportId: 'report-1', status: 'completed' },
          'tc-2': { reportId: 'report-2', status: 'completed' },
          'tc-3': { reportId: 'report-3', status: 'completed' },
          'tc-4': { reportId: 'report-4', status: 'completed' },
        },
      };

      const benchmarkData = {
        id: 'bench-test',
        name: 'Test Benchmark',
        testCaseIds: ['tc-1', 'tc-2', 'tc-3', 'tc-4'],
        runs: [run],
      };

      mockBenchmarkGetById.mockResolvedValueOnce(benchmarkData);

      // Mock adapter runs.getById for each report
      mockRunGetById
        .mockResolvedValueOnce({ id: 'report-1', passFailStatus: 'passed', metricsStatus: 'ready' })
        .mockResolvedValueOnce({ id: 'report-2', passFailStatus: 'failed', metricsStatus: 'ready' })
        .mockResolvedValueOnce({ id: 'report-3', passFailStatus: undefined, metricsStatus: 'pending' })
        .mockResolvedValueOnce({ id: 'report-4', passFailStatus: 'passed', metricsStatus: 'ready' });

      const router = await import('@/server/routes/storage/benchmarks');
      app.use(router.default);

      const response = await request(app).get('/api/storage/benchmarks/bench-test');

      expect(response.status).toBe(200);
      const stats = response.body.runs[0].stats;
      expect(stats.passed).toBe(2);
      expect(stats.failed).toBe(1);
      expect(stats.pending).toBe(1);
      expect(stats.total).toBe(4);
    });

    it('should handle failed/cancelled results correctly', async () => {
      const run: Partial<BenchmarkRun> = {
        id: 'run-test2',
        status: 'cancelled',
        results: {
          'tc-1': { reportId: 'report-1', status: 'completed' },
          'tc-2': { reportId: 'report-2', status: 'failed' }, // Execution failed
          'tc-3': { reportId: 'report-3', status: 'cancelled' }, // Cancelled
        },
      };

      const benchmarkData = {
        id: 'bench-test2',
        name: 'Test Benchmark',
        testCaseIds: ['tc-1', 'tc-2', 'tc-3'],
        runs: [run],
      };

      mockBenchmarkGetById.mockResolvedValueOnce(benchmarkData);

      // Mock adapter runs.getById - only report-1 has completed status in result
      mockRunGetById
        .mockResolvedValueOnce({ id: 'report-1', passFailStatus: 'passed', metricsStatus: 'ready' });

      const router = await import('@/server/routes/storage/benchmarks');
      app.use(router.default);

      const response = await request(app).get('/api/storage/benchmarks/bench-test2');

      expect(response.status).toBe(200);
      const stats = response.body.runs[0].stats;
      expect(stats.passed).toBe(1);
      expect(stats.failed).toBe(2); // failed + cancelled count as failed
      expect(stats.pending).toBe(0);
      expect(stats.total).toBe(3);
    });
  });

  describe('PATCH Stats Endpoint', () => {
    it('should update run stats via adapter', async () => {
      mockBenchmarkUpdateRun.mockResolvedValueOnce(true);

      const router = await import('@/server/routes/storage/benchmarks');
      app.use(router.default);

      const stats = { passed: 3, failed: 1, pending: 0, errored: 0, total: 4 };
      const response = await request(app)
        .patch('/api/storage/benchmarks/bench-8/runs/run-1/stats')
        .send(stats);

      expect(response.status).toBe(200);
      expect(response.body.updated).toBe(true);
      expect(response.body.runId).toBe('run-1');
      expect(response.body.stats).toEqual(stats);
      expect(mockBenchmarkUpdateRun).toHaveBeenCalledWith('bench-8', 'run-1', { stats });
    });

    it('should return 404 when run not found', async () => {
      mockBenchmarkUpdateRun.mockResolvedValueOnce(false);

      const router = await import('@/server/routes/storage/benchmarks');
      app.use(router.default);

      const stats = { passed: 1, failed: 0, pending: 0, errored: 0, total: 1 };
      const response = await request(app)
        .patch('/api/storage/benchmarks/bench-9/runs/missing-run/stats')
        .send(stats);

      expect(response.status).toBe(404);
      expect(response.body.error).toContain('not found');
    });

    it('should reject invalid stats object', async () => {
      const router = await import('@/server/routes/storage/benchmarks');
      app.use(router.default);

      const response = await request(app)
        .patch('/api/storage/benchmarks/bench-10/runs/run-1/stats')
        .send({ passed: 1 }); // Missing required fields

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Invalid stats');
    });

    it('should reject modifying sample data', async () => {
      const router = await import('@/server/routes/storage/benchmarks');
      app.use(router.default);

      const stats = { passed: 1, failed: 0, pending: 0, errored: 0, total: 1 };
      const response = await request(app)
        .patch('/api/storage/benchmarks/demo-bench/runs/run-1/stats')
        .send(stats);

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('sample data');
    });
  });
});
