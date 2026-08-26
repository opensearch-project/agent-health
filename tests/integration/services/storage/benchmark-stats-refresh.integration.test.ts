/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for benchmark stats refresh functionality
 * Tests the full flow from HTTP request through the storage adapter
 */

import { jest } from '@jest/globals';
import type { Application } from 'express';
import type { BenchmarkRun } from '@/types';

// Use require for CommonJS module compatibility in Jest
const request = require('supertest');

// Mock adapter functions
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

// Still need storageClient mock for execute/cancel paths (not tested here but imported by route)
const mockGet = jest.fn();
const mockSearch = jest.fn();
const mockUpdate = jest.fn();

jest.mock('@/server/middleware/storageClient', () => ({
  isStorageAvailable: jest.fn().mockReturnValue(true),
  requireStorageClient: jest.fn().mockReturnValue({
    get: mockGet,
    search: mockSearch,
    update: mockUpdate,
  }),
  INDEXES: {
    benchmarks: 'evals_benchmarks',
    runs: 'evals_runs',
  },
}));

jest.mock('@/lib/debug', () => ({
  debug: jest.fn(),
}));

describe('Benchmark Stats Refresh Integration', () => {
  let app: Application;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockBenchmarkUpdateRun.mockResolvedValue(true);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const express = require('express');
    app = express();
    app.use(express.json());

    const router = await import('@/server/routes/storage/benchmarks');
    app.use(router.default);
  });

  describe('End-to-end stats backfill flow', () => {
    it('should automatically fix stale stats on GET request', async () => {
      // Scenario: User opens benchmark runs page with stale stats
      const benchmarkId = 'bench-stale-e2e';

      const benchmarkData = {
        id: benchmarkId,
        name: 'E2E Test Benchmark',
        testCaseIds: ['tc-1', 'tc-2', 'tc-3'],
        runs: [
          {
            id: 'run-1',
            name: 'Run 1',
            status: 'completed',
            agentKey: 'test-agent',
            modelId: 'test-model',
            createdAt: '2025-01-01T00:00:00Z',
            stats: { passed: 0, failed: 0, pending: 3, total: 3 }, // STALE
            results: {
              'tc-1': { reportId: 'report-1', status: 'completed' },
              'tc-2': { reportId: 'report-2', status: 'completed' },
              'tc-3': { reportId: 'report-3', status: 'completed' },
            },
          },
        ],
      };

      // Step 1: GET benchmark via adapter
      mockBenchmarkGetById.mockResolvedValueOnce(benchmarkData);

      // Step 2: Backfill detects stale stats and fetches reports via adapter
      mockRunGetById
        .mockResolvedValueOnce({ id: 'report-1', passFailStatus: 'passed', metricsStatus: 'ready' })
        .mockResolvedValueOnce({ id: 'report-2', passFailStatus: 'passed', metricsStatus: 'ready' })
        .mockResolvedValueOnce({ id: 'report-3', passFailStatus: 'failed', metricsStatus: 'ready' });

      // Execute request
      const response = await request(app).get(`/api/storage/benchmarks/${benchmarkId}`);

      // Verify response
      expect(response.status).toBe(200);
      expect(response.body.runs[0].stats).toEqual({
        passed: 2,
        failed: 1,
        pending: 0,
        errored: 0,
        total: 3,
      });

      // Verify adapter updateRun was called with correct stats
      expect(mockBenchmarkUpdateRun).toHaveBeenCalledWith(
        benchmarkId,
        'run-1',
        expect.objectContaining({
          stats: {
            passed: 2,
            failed: 1,
            pending: 0,
            errored: 0,
            total: 3,
          },
        })
      );
    });

    it('should handle multiple runs with mixed stale/correct stats', async () => {
      const benchmarkId = 'bench-mixed-e2e';

      const benchmarkData = {
        id: benchmarkId,
        name: 'Mixed Stats Benchmark',
        testCaseIds: ['tc-1', 'tc-2'],
        runs: [
          {
            id: 'run-stale',
            name: 'Stale Run',
            status: 'completed',
            agentKey: 'test-agent',
            modelId: 'test-model',
            createdAt: '2025-01-01T00:00:00Z',
            stats: { passed: 0, failed: 0, pending: 2, total: 2 }, // STALE
            results: {
              'tc-1': { reportId: 'report-1', status: 'completed' },
              'tc-2': { reportId: 'report-2', status: 'completed' },
            },
          },
          {
            id: 'run-correct',
            name: 'Correct Run',
            status: 'completed',
            agentKey: 'test-agent',
            modelId: 'test-model',
            createdAt: '2025-01-02T00:00:00Z',
            stats: { passed: 1, failed: 1, pending: 0, total: 2 }, // CORRECT
            results: {
              'tc-1': { reportId: 'report-3', status: 'completed' },
              'tc-2': { reportId: 'report-4', status: 'completed' },
            },
          },
        ],
      };

      mockBenchmarkGetById.mockResolvedValueOnce(benchmarkData);

      // Only fetch reports for stale run
      mockRunGetById
        .mockResolvedValueOnce({ id: 'report-1', passFailStatus: 'passed', metricsStatus: 'ready' })
        .mockResolvedValueOnce({ id: 'report-2', passFailStatus: 'passed', metricsStatus: 'ready' });

      const response = await request(app).get(`/api/storage/benchmarks/${benchmarkId}`);

      expect(response.status).toBe(200);
      expect(response.body.runs[0].stats.pending).toBe(0); // Fixed
      expect(response.body.runs[1].stats.pending).toBe(0); // Unchanged
      expect(mockBenchmarkUpdateRun).toHaveBeenCalledTimes(1); // Only stale run updated
    });
  });

  describe('Manual refresh flow', () => {
    it('should refresh all runs on demand', async () => {
      const benchmarkId = 'bench-manual-all';

      const benchmarkData = {
        id: benchmarkId,
        name: 'Manual Refresh Test',
        testCaseIds: ['tc-1'],
        runs: [
          {
            id: 'run-1',
            status: 'completed',
            agentKey: 'test-agent',
            modelId: 'test-model',
            createdAt: '2025-01-01T00:00:00Z',
            results: {
              'tc-1': { reportId: 'report-1', status: 'completed' },
            },
          },
          {
            id: 'run-2',
            status: 'completed',
            agentKey: 'test-agent',
            modelId: 'test-model',
            createdAt: '2025-01-02T00:00:00Z',
            results: {
              'tc-1': { reportId: 'report-2', status: 'completed' },
            },
          },
        ],
      };

      mockBenchmarkGetById.mockResolvedValueOnce(benchmarkData);

      // Mock report fetches for each run
      mockRunGetById
        .mockResolvedValueOnce({ id: 'report-1', passFailStatus: 'passed', metricsStatus: 'ready' })
        .mockResolvedValueOnce({ id: 'report-2', passFailStatus: 'failed', metricsStatus: 'ready' });

      const response = await request(app)
        .post(`/api/storage/benchmarks/${benchmarkId}/refresh-all-stats`);

      expect(response.status).toBe(200);
      expect(response.body.refreshed).toBe(2);
      expect(mockBenchmarkUpdateRun).toHaveBeenCalledTimes(2);
    });

    it('should refresh single run on demand', async () => {
      const benchmarkId = 'bench-manual-single';
      const targetRunId = 'run-target';

      const benchmarkData = {
        id: benchmarkId,
        name: 'Single Run Refresh Test',
        testCaseIds: ['tc-1', 'tc-2'],
        runs: [
          {
            id: targetRunId,
            status: 'completed',
            agentKey: 'test-agent',
            modelId: 'test-model',
            createdAt: '2025-01-01T00:00:00Z',
            results: {
              'tc-1': { reportId: 'report-1', status: 'completed' },
              'tc-2': { reportId: 'report-2', status: 'completed' },
            },
          },
          {
            id: 'run-other',
            status: 'completed',
            agentKey: 'test-agent',
            modelId: 'test-model',
            createdAt: '2025-01-02T00:00:00Z',
            results: {
              'tc-1': { reportId: 'report-3', status: 'completed' },
              'tc-2': { reportId: 'report-4', status: 'completed' },
            },
          },
        ],
      };

      mockBenchmarkGetById.mockResolvedValueOnce(benchmarkData);

      mockRunGetById
        .mockResolvedValueOnce({ id: 'report-1', passFailStatus: 'passed', metricsStatus: 'ready' })
        .mockResolvedValueOnce({ id: 'report-2', passFailStatus: 'failed', metricsStatus: 'ready' });

      const response = await request(app)
        .post(`/api/storage/benchmarks/${benchmarkId}/runs/${targetRunId}/refresh-stats`);

      expect(response.status).toBe(200);
      expect(response.body.refreshed).toBe(true);
      expect(response.body.runId).toBe(targetRunId);
      expect(response.body.stats).toEqual({
        passed: 1,
        failed: 1,
        pending: 0,
        errored: 0,
        total: 2,
      });
      expect(mockBenchmarkUpdateRun).toHaveBeenCalledTimes(1); // Only target run
    });
  });

  describe('Trace-mode report completion flow', () => {
    it('should update stats when trace-mode report completes', async () => {
      // This tests the service-layer function directly (still uses raw client)
      const benchmarkId = 'bench-trace';
      const reportId = 'report-trace-1';

      const benchmarkData = {
        id: benchmarkId,
        name: 'Trace Mode Test',
        testCaseIds: ['tc-1'],
        runs: [
          {
            id: 'run-trace',
            status: 'completed',
            agentKey: 'test-agent',
            modelId: 'test-model',
            createdAt: '2025-01-01T00:00:00Z',
            results: {
              'tc-1': { reportId, status: 'completed' },
            },
          },
        ],
      };

      // Import and call the function directly (simulates what PATCH endpoint does)
      // This still uses raw OpenSearch client
      mockGet.mockResolvedValueOnce({
        body: { found: true, _source: benchmarkData },
      });

      mockSearch.mockResolvedValueOnce({
        body: {
          hits: {
            hits: [
              { _source: { id: reportId, passFailStatus: 'passed', metricsStatus: 'ready' } },
            ],
          },
        },
      });

      mockUpdate.mockResolvedValueOnce({ body: {} });

      const { updateBenchmarkRunStatsForReport } = await import('@/server/services/storage/index');
      const mockClient = { get: mockGet, search: mockSearch, update: mockUpdate };

      await updateBenchmarkRunStatsForReport(mockClient as any, benchmarkId, reportId);

      // Verify stats were updated via raw client (service layer still uses raw OpenSearch)
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            script: expect.objectContaining({
              params: expect.objectContaining({
                stats: expect.objectContaining({
                  passed: 1,
                  failed: 0,
                  pending: 0,
                  total: 1,
                }),
              }),
            }),
          }),
        })
      );
    });
  });

  describe('Error handling', () => {
    it('should handle storage errors gracefully', async () => {
      const benchmarkId = 'bench-error';

      mockBenchmarkGetById.mockRejectedValueOnce(new Error('Connection refused'));

      const response = await request(app).get(`/api/storage/benchmarks/${benchmarkId}`);

      // Should return error, not crash
      expect(response.status).toBeGreaterThanOrEqual(400);
    });

    it('should handle report fetch failures during backfill', async () => {
      const benchmarkId = 'bench-report-error';

      const benchmarkData = {
        id: benchmarkId,
        name: 'Report Error Test',
        testCaseIds: ['tc-1'],
        runs: [
          {
            id: 'run-1',
            status: 'completed',
            agentKey: 'test-agent',
            modelId: 'test-model',
            createdAt: '2025-01-01T00:00:00Z',
            results: {
              'tc-1': { reportId: 'report-1', status: 'completed' },
            },
          },
        ],
      };

      mockBenchmarkGetById.mockResolvedValueOnce(benchmarkData);

      // Report fetch fails
      mockRunGetById.mockRejectedValueOnce(new Error('Report index unavailable'));

      const response = await request(app).get(`/api/storage/benchmarks/${benchmarkId}`);

      // Should still return benchmark, just without backfilled stats
      expect(response.status).toBe(200);
    });
  });
});
