/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  storageAdmin,
  testCaseStorage,
  benchmarkStorage,
  runStorage,
  analyticsStorage,
  opensearchStorage,
  StorageTestCase,
  StorageBenchmark,
  StorageRun,
  StorageAnalyticsRecord,
} from '@/services/storage/opensearchClient';

// Mock the config
jest.mock('@/lib/config', () => ({
  ENV_CONFIG: {
    storageApiUrl: 'http://localhost:4001/api/storage',
  },
}));

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

describe('OpenSearch Storage Client', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ==================== Helper Functions ====================

  const mockSuccessResponse = <T>(data: T) => ({
    ok: true,
    json: () => Promise.resolve(data),
  });

  const mockErrorResponse = (status: number, error: string) => ({
    ok: false,
    status,
    statusText: error,
    json: () => Promise.resolve({ error }),
  });

  const mockNetworkError = () => {
    mockFetch.mockRejectedValue(new Error('Network error'));
  };

  // ==================== storageAdmin Tests ====================

  describe('storageAdmin', () => {
    describe('health', () => {
      it('should return health status', async () => {
        const healthData = { status: 'ok', cluster: { name: 'test-cluster' } };
        mockFetch.mockResolvedValue(mockSuccessResponse(healthData));

        const result = await storageAdmin.health();

        expect(result).toEqual(healthData);
        expect(mockFetch).toHaveBeenCalledWith(
          'http://localhost:4001/api/storage/health',
          expect.objectContaining({ method: 'GET' })
        );
      });

      it('should handle health check errors', async () => {
        mockFetch.mockResolvedValue(mockErrorResponse(503, 'Service unavailable'));

        await expect(storageAdmin.health()).rejects.toThrow('Service unavailable');
      });
    });

    describe('initIndexes', () => {
      it('should initialize indexes', async () => {
        const initResult = {
          success: true,
          results: {
            'test-cases': { status: 'created' },
            experiments: { status: 'created' },
          },
        };
        mockFetch.mockResolvedValue(mockSuccessResponse(initResult));

        const result = await storageAdmin.initIndexes();

        expect(result).toEqual(initResult);
        expect(mockFetch).toHaveBeenCalledWith(
          'http://localhost:4001/api/storage/init-indexes',
          expect.objectContaining({ method: 'POST' })
        );
      });
    });

    describe('stats', () => {
      it('should return storage statistics', async () => {
        const statsData = {
          stats: {
            'test-cases': { count: 10 },
            experiments: { count: 5 },
            runs: { count: 100 },
          },
        };
        mockFetch.mockResolvedValue(mockSuccessResponse(statsData));

        const result = await storageAdmin.stats();

        expect(result).toEqual(statsData);
        expect(mockFetch).toHaveBeenCalledWith(
          'http://localhost:4001/api/storage/stats',
          expect.objectContaining({ method: 'GET' })
        );
      });
    });
  });

  // ==================== testCaseStorage Tests ====================

  describe('testCaseStorage', () => {
    const mockTestCase: StorageTestCase = {
      id: 'tc-123',
      name: 'Test Case 1',
      description: 'Test description',
      version: 1,
      initialPrompt: 'Test prompt',
      expectedOutcomes: ['Expected outcome 1'],
      labels: ['category:test'],
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    };

    describe('getAll', () => {
      it('should return all test cases', async () => {
        mockFetch.mockResolvedValue(
          mockSuccessResponse({ testCases: [mockTestCase], total: 1 })
        );

        const result = await testCaseStorage.getAll();

        expect(result).toEqual([mockTestCase]);
        expect(mockFetch).toHaveBeenCalledWith(
          'http://localhost:4001/api/storage/test-cases',
          expect.objectContaining({ method: 'GET' })
        );
      });
    });

    describe('getById', () => {
      it('should return test case by ID', async () => {
        mockFetch.mockResolvedValue(mockSuccessResponse(mockTestCase));

        const result = await testCaseStorage.getById('tc-123');

        expect(result).toEqual(mockTestCase);
        expect(mockFetch).toHaveBeenCalledWith(
          'http://localhost:4001/api/storage/test-cases/tc-123',
          expect.objectContaining({ method: 'GET' })
        );
      });

      it('should return null for 404 error', async () => {
        mockFetch.mockResolvedValue(mockErrorResponse(404, 'Not found'));

        const result = await testCaseStorage.getById('nonexistent');

        expect(result).toBeNull();
      });

      it('should throw for other errors', async () => {
        mockFetch.mockResolvedValue(mockErrorResponse(500, 'Server error'));

        await expect(testCaseStorage.getById('tc-123')).rejects.toThrow('Server error');
      });
    });

    describe('getVersions', () => {
      it('should return all versions of a test case', async () => {
        const versions = [
          { ...mockTestCase, version: 1 },
          { ...mockTestCase, version: 2 },
        ];
        mockFetch.mockResolvedValue(
          mockSuccessResponse({ versions, total: 2 })
        );

        const result = await testCaseStorage.getVersions('tc-123');

        expect(result).toEqual(versions);
        expect(mockFetch).toHaveBeenCalledWith(
          'http://localhost:4001/api/storage/test-cases/tc-123/versions',
          expect.objectContaining({ method: 'GET' })
        );
      });
    });

    describe('getVersion', () => {
      it('should return specific version', async () => {
        mockFetch.mockResolvedValue(mockSuccessResponse(mockTestCase));

        const result = await testCaseStorage.getVersion('tc-123', 1);

        expect(result).toEqual(mockTestCase);
        expect(mockFetch).toHaveBeenCalledWith(
          'http://localhost:4001/api/storage/test-cases/tc-123/versions/1',
          expect.objectContaining({ method: 'GET' })
        );
      });

      it('should return null for 404 error', async () => {
        mockFetch.mockResolvedValue(mockErrorResponse(404, 'Version not found'));

        const result = await testCaseStorage.getVersion('tc-123', 99);

        expect(result).toBeNull();
      });

      it('should throw for other errors', async () => {
        mockFetch.mockResolvedValue(mockErrorResponse(500, 'Server error'));

        await expect(testCaseStorage.getVersion('tc-123', 1)).rejects.toThrow('Server error');
      });
    });

    describe('create', () => {
      it('should create a new test case', async () => {
        mockFetch.mockResolvedValue(mockSuccessResponse(mockTestCase));

        const input = {
          name: 'Test Case 1',
          description: 'Test description',
          initialPrompt: 'Test prompt',
          expectedOutcomes: ['Expected outcome 1'],
          labels: ['category:test'],
        };

        const result = await testCaseStorage.create(input);

        expect(result).toEqual(mockTestCase);
        expect(mockFetch).toHaveBeenCalledWith(
          'http://localhost:4001/api/storage/test-cases',
          expect.objectContaining({
            method: 'POST',
            body: JSON.stringify(input),
          })
        );
      });
    });

    describe('update', () => {
      it('should update a test case', async () => {
        const updatedTestCase = { ...mockTestCase, version: 2 };
        mockFetch.mockResolvedValue(mockSuccessResponse(updatedTestCase));

        const result = await testCaseStorage.update('tc-123', { name: 'Updated Name' });

        expect(result).toEqual(updatedTestCase);
        expect(mockFetch).toHaveBeenCalledWith(
          'http://localhost:4001/api/storage/test-cases/tc-123',
          expect.objectContaining({
            method: 'PUT',
            body: JSON.stringify({ name: 'Updated Name' }),
          })
        );
      });
    });

    describe('delete', () => {
      it('should delete a test case', async () => {
        mockFetch.mockResolvedValue(mockSuccessResponse({ deleted: 2 }));

        const result = await testCaseStorage.delete('tc-123');

        expect(result).toEqual({ deleted: 2 });
        expect(mockFetch).toHaveBeenCalledWith(
          'http://localhost:4001/api/storage/test-cases/tc-123',
          expect.objectContaining({ method: 'DELETE' })
        );
      });
    });

    describe('bulkCreate', () => {
      it('should bulk create test cases', async () => {
        mockFetch.mockResolvedValue(mockSuccessResponse({ created: 3, errors: false }));

        const testCases = [
          { name: 'TC1', initialPrompt: 'Prompt 1' },
          { name: 'TC2', initialPrompt: 'Prompt 2' },
          { name: 'TC3', initialPrompt: 'Prompt 3' },
        ];

        const result = await testCaseStorage.bulkCreate(testCases);

        expect(result).toEqual({ created: 3, errors: false });
        expect(mockFetch).toHaveBeenCalledWith(
          'http://localhost:4001/api/storage/test-cases/bulk',
          expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ testCases }),
          })
        );
      });
    });
  });

  // ==================== benchmarkStorage Tests ====================

  describe('benchmarkStorage', () => {
    const mockExperiment: StorageBenchmark = {
      id: 'exp-123',
      name: 'Test Benchmark',
      description: 'Test description',
      createdAt: '2024-01-01T00:00:00Z',
      testCaseIds: ['tc-1', 'tc-2'],
      runs: [],
    };

    describe('getAll', () => {
      it('should return all experiments', async () => {
        mockFetch.mockResolvedValue(
          mockSuccessResponse({ benchmarks: [mockExperiment], total: 1 })
        );

        const result = await benchmarkStorage.getAll();

        expect(result).toEqual([mockExperiment]);
        expect(mockFetch).toHaveBeenCalledWith(
          'http://localhost:4001/api/storage/benchmarks',
          expect.objectContaining({ method: 'GET' })
        );
      });
    });

    describe('getById', () => {
      it('should return experiment by ID', async () => {
        mockFetch.mockResolvedValue(mockSuccessResponse(mockExperiment));

        const result = await benchmarkStorage.getById('exp-123');

        expect(result).toEqual(mockExperiment);
      });

      it('should return null for 404 error', async () => {
        mockFetch.mockResolvedValue(mockErrorResponse(404, 'Not found'));

        const result = await benchmarkStorage.getById('nonexistent');

        expect(result).toBeNull();
      });

      it('should throw for other errors', async () => {
        mockFetch.mockResolvedValue(mockErrorResponse(500, 'Server error'));

        await expect(benchmarkStorage.getById('exp-123')).rejects.toThrow('Server error');
      });
    });

    describe('create', () => {
      it('should create an experiment', async () => {
        mockFetch.mockResolvedValue(mockSuccessResponse(mockExperiment));

        const input = {
          name: 'Test Benchmark',
          description: 'Test description',
          testCaseIds: ['tc-1', 'tc-2'],
          runs: [],
        };

        const result = await benchmarkStorage.create(input);

        expect(result).toEqual(mockExperiment);
        expect(mockFetch).toHaveBeenCalledWith(
          'http://localhost:4001/api/storage/benchmarks',
          expect.objectContaining({
            method: 'POST',
            body: JSON.stringify(input),
          })
        );
      });
    });

    describe('update', () => {
      it('should update an experiment', async () => {
        mockFetch.mockResolvedValue(mockSuccessResponse(mockExperiment));

        const result = await benchmarkStorage.update('exp-123', { name: 'Updated' });

        expect(result).toEqual(mockExperiment);
        expect(mockFetch).toHaveBeenCalledWith(
          'http://localhost:4001/api/storage/benchmarks/exp-123',
          expect.objectContaining({
            method: 'PUT',
            body: JSON.stringify({ name: 'Updated' }),
          })
        );
      });
    });

    describe('delete', () => {
      it('should delete an experiment', async () => {
        mockFetch.mockResolvedValue(mockSuccessResponse({ deleted: true }));

        const result = await benchmarkStorage.delete('exp-123');

        expect(result).toEqual({ deleted: true });
      });
    });

    describe('bulkCreate', () => {
      it('should bulk create experiments', async () => {
        mockFetch.mockResolvedValue(mockSuccessResponse({ created: 2, errors: false }));

        const experiments = [
          { name: 'Exp1', testCaseIds: [], runs: [] },
          { name: 'Exp2', testCaseIds: [], runs: [] },
        ];

        const result = await benchmarkStorage.bulkCreate(experiments);

        expect(result).toEqual({ created: 2, errors: false });
      });
    });
  });

  // ==================== runStorage Tests ====================

  describe('runStorage', () => {
    const mockRun: StorageRun = {
      id: 'run-123',
      experimentId: 'exp-123',
      experimentRunId: 'er-123',
      testCaseId: 'tc-123',
      testCaseVersionId: 'tc-123-v1',
      agentId: 'agent-1',
      modelId: 'model-1',
      iteration: 1,
      createdAt: '2024-01-01T00:00:00Z',
      status: 'completed',
      passFailStatus: 'passed',
    };

    describe('getAll', () => {
      it('should return all runs with default pagination', async () => {
        mockFetch.mockResolvedValue(
          mockSuccessResponse({ runs: [mockRun], total: 1, size: 100, from: 0 })
        );

        const result = await runStorage.getAll();

        expect(result.runs).toEqual([mockRun]);
        expect(mockFetch).toHaveBeenCalledWith(
          'http://localhost:4001/api/storage/runs',
          expect.objectContaining({ method: 'GET' })
        );
      });

      it('should apply pagination parameters', async () => {
        mockFetch.mockResolvedValue(
          mockSuccessResponse({ runs: [], total: 100, size: 10, from: 20 })
        );

        await runStorage.getAll({ size: 10, from: 20 });

        expect(mockFetch).toHaveBeenCalledWith(
          'http://localhost:4001/api/storage/runs?size=10&from=20',
          expect.any(Object)
        );
      });
    });

    describe('getById', () => {
      it('should return run by ID', async () => {
        mockFetch.mockResolvedValue(mockSuccessResponse(mockRun));

        const result = await runStorage.getById('run-123');

        expect(result).toEqual(mockRun);
      });

      it('should return null for 404 error', async () => {
        mockFetch.mockResolvedValue(mockErrorResponse(404, 'Not found'));

        const result = await runStorage.getById('nonexistent');

        expect(result).toBeNull();
      });

      it('should throw for other errors', async () => {
        mockFetch.mockResolvedValue(mockErrorResponse(500, 'Server error'));

        await expect(runStorage.getById('run-123')).rejects.toThrow('Server error');
      });
    });

    describe('create', () => {
      it('should create a run', async () => {
        mockFetch.mockResolvedValue(mockSuccessResponse(mockRun));

        const input = {
          experimentId: 'exp-123',
          experimentRunId: 'er-123',
          testCaseId: 'tc-123',
          testCaseVersionId: 'tc-123-v1',
          agentId: 'agent-1',
          modelId: 'model-1',
          iteration: 1,
          status: 'completed' as const,
        };

        const result = await runStorage.create(input);

        expect(result).toEqual(mockRun);
        expect(mockFetch).toHaveBeenCalledWith(
          'http://localhost:4001/api/storage/runs',
          expect.objectContaining({
            method: 'POST',
            body: JSON.stringify(input),
          })
        );
      });

      it('should disable analytics when specified', async () => {
        mockFetch.mockResolvedValue(mockSuccessResponse(mockRun));

        const input = {
          experimentId: 'exp-123',
          experimentRunId: 'er-123',
          testCaseId: 'tc-123',
          testCaseVersionId: 'tc-123-v1',
          agentId: 'agent-1',
          modelId: 'model-1',
          iteration: 1,
          status: 'completed' as const,
        };

        await runStorage.create(input, { analytics: false });

        expect(mockFetch).toHaveBeenCalledWith(
          'http://localhost:4001/api/storage/runs?analytics=false',
          expect.any(Object)
        );
      });
    });

    describe('delete', () => {
      it('should delete a run', async () => {
        mockFetch.mockResolvedValue(mockSuccessResponse({ deleted: true }));

        const result = await runStorage.delete('run-123');

        expect(result).toEqual({ deleted: true });
      });
    });

    describe('partialUpdate', () => {
      it('should partially update a run', async () => {
        mockFetch.mockResolvedValue(mockSuccessResponse({ ...mockRun, status: 'failed' }));

        const result = await runStorage.partialUpdate('run-123', { status: 'failed' });

        expect(result.status).toBe('failed');
        expect(mockFetch).toHaveBeenCalledWith(
          'http://localhost:4001/api/storage/runs/run-123',
          expect.objectContaining({
            method: 'PATCH',
            body: JSON.stringify({ status: 'failed' }),
          })
        );
      });
    });

    describe('getByTestCase', () => {
      it('should get runs by test case ID', async () => {
        mockFetch.mockResolvedValue(
          mockSuccessResponse({ runs: [mockRun], total: 1 })
        );

        const result = await runStorage.getByTestCase('tc-123');

        expect(result).toEqual([mockRun]);
        expect(mockFetch).toHaveBeenCalledWith(
          'http://localhost:4001/api/storage/runs/by-test-case/tc-123',
          expect.any(Object)
        );
      });

      it('should apply size parameter', async () => {
        mockFetch.mockResolvedValue(
          mockSuccessResponse({ runs: [], total: 0 })
        );

        await runStorage.getByTestCase('tc-123', 50);

        expect(mockFetch).toHaveBeenCalledWith(
          'http://localhost:4001/api/storage/runs/by-test-case/tc-123?size=50',
          expect.any(Object)
        );
      });
    });

    describe('getByBenchmark', () => {
      it('should get runs by experiment ID', async () => {
        mockFetch.mockResolvedValue(
          mockSuccessResponse({ runs: [mockRun], total: 1 })
        );

        const result = await runStorage.getByBenchmark('exp-123');

        expect(result).toEqual([mockRun]);
      });

      it('should apply size parameter', async () => {
        mockFetch.mockResolvedValue(
          mockSuccessResponse({ runs: [], total: 0 })
        );

        await runStorage.getByBenchmark('exp-123', 25);

        expect(mockFetch).toHaveBeenCalledWith(
          'http://localhost:4001/api/storage/runs/by-benchmark/exp-123?size=25',
          expect.any(Object)
        );
      });
    });

    describe('getByBenchmarkRun', () => {
      it('should get runs by experiment run', async () => {
        mockFetch.mockResolvedValue(
          mockSuccessResponse({ runs: [mockRun], total: 1 })
        );

        const result = await runStorage.getByBenchmarkRun('exp-123', 'er-123');

        expect(result).toEqual([mockRun]);
        expect(mockFetch).toHaveBeenCalledWith(
          'http://localhost:4001/api/storage/runs/by-benchmark-run/exp-123/er-123',
          expect.any(Object)
        );
      });

      it('should apply size parameter', async () => {
        mockFetch.mockResolvedValue(
          mockSuccessResponse({ runs: [], total: 0 })
        );

        await runStorage.getByBenchmarkRun('exp-123', 'er-123', 10);

        expect(mockFetch).toHaveBeenCalledWith(
          'http://localhost:4001/api/storage/runs/by-benchmark-run/exp-123/er-123?size=10',
          expect.any(Object)
        );
      });
    });

    describe('getIterations', () => {
      it('should get iterations for a test case in experiment', async () => {
        mockFetch.mockResolvedValue(
          mockSuccessResponse({ runs: [mockRun], total: 1, maxIteration: 3 })
        );

        const result = await runStorage.getIterations('exp-123', 'tc-123');

        expect(result.runs).toEqual([mockRun]);
        expect(result.maxIteration).toBe(3);
      });

      it('should include benchmarkRunId when provided', async () => {
        mockFetch.mockResolvedValue(
          mockSuccessResponse({ runs: [], total: 0, maxIteration: 0 })
        );

        await runStorage.getIterations('exp-123', 'tc-123', 'er-456');

        expect(mockFetch).toHaveBeenCalledWith(
          'http://localhost:4001/api/storage/runs/iterations/exp-123/tc-123?benchmarkRunId=er-456',
          expect.any(Object)
        );
      });
    });

    describe('search', () => {
      it('should search runs with filters', async () => {
        mockFetch.mockResolvedValue(
          mockSuccessResponse({ runs: [mockRun], total: 1 })
        );

        const filters = {
          experimentId: 'exp-123',
          status: 'completed',
          size: 50,
        };

        const result = await runStorage.search(filters);

        expect(result.runs).toEqual([mockRun]);
        expect(mockFetch).toHaveBeenCalledWith(
          'http://localhost:4001/api/storage/runs/search',
          expect.objectContaining({
            method: 'POST',
            body: JSON.stringify(filters),
          })
        );
      });
    });

    describe('addAnnotation', () => {
      it('should add annotation to run', async () => {
        const annotation = {
          id: 'ann-123',
          text: 'Test annotation',
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        };
        mockFetch.mockResolvedValue(mockSuccessResponse(annotation));

        const result = await runStorage.addAnnotation('run-123', { text: 'Test annotation' });

        expect(result).toEqual(annotation);
        expect(mockFetch).toHaveBeenCalledWith(
          'http://localhost:4001/api/storage/runs/run-123/annotations',
          expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ text: 'Test annotation' }),
          })
        );
      });
    });

    describe('updateAnnotation', () => {
      it('should update annotation', async () => {
        const annotation = {
          id: 'ann-123',
          text: 'Updated annotation',
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-02T00:00:00Z',
        };
        mockFetch.mockResolvedValue(mockSuccessResponse(annotation));

        const result = await runStorage.updateAnnotation('run-123', 'ann-123', { text: 'Updated annotation' });

        expect(result).toEqual(annotation);
        expect(mockFetch).toHaveBeenCalledWith(
          'http://localhost:4001/api/storage/runs/run-123/annotations/ann-123',
          expect.objectContaining({
            method: 'PUT',
          })
        );
      });
    });

    describe('deleteAnnotation', () => {
      it('should delete annotation', async () => {
        mockFetch.mockResolvedValue(mockSuccessResponse({ deleted: true }));

        const result = await runStorage.deleteAnnotation('run-123', 'ann-123');

        expect(result).toEqual({ deleted: true });
        expect(mockFetch).toHaveBeenCalledWith(
          'http://localhost:4001/api/storage/runs/run-123/annotations/ann-123',
          expect.objectContaining({ method: 'DELETE' })
        );
      });
    });

    describe('bulkCreate', () => {
      it('should bulk create runs', async () => {
        mockFetch.mockResolvedValue(mockSuccessResponse({ created: 2, errors: false }));

        const runs = [
          { experimentId: 'exp-1', testCaseId: 'tc-1' },
          { experimentId: 'exp-1', testCaseId: 'tc-2' },
        ];

        const result = await runStorage.bulkCreate(runs);

        expect(result).toEqual({ created: 2, errors: false });
      });
    });
  });

  // ==================== analyticsStorage Tests ====================

  describe('analyticsStorage', () => {
    const mockAnalyticsRecord: StorageAnalyticsRecord = {
      analyticsId: 'analytics-123',
      runId: 'run-123',
      experimentId: 'exp-123',
      experimentRunId: 'er-123',
      testCaseId: 'tc-123',
      agentId: 'agent-1',
      modelId: 'model-1',
      iteration: 1,
      createdAt: '2024-01-01T00:00:00Z',
      passFailStatus: 'passed',
    };

    describe('query', () => {
      it('should query analytics with filters', async () => {
        mockFetch.mockResolvedValue(
          mockSuccessResponse({ records: [mockAnalyticsRecord], total: 1 })
        );

        const result = await analyticsStorage.query({ experimentId: 'exp-123' });

        expect(result.records).toEqual([mockAnalyticsRecord]);
        expect(mockFetch).toHaveBeenCalledWith(
          'http://localhost:4001/api/storage/analytics?experimentId=exp-123',
          expect.any(Object)
        );
      });

      it('should handle multiple filters', async () => {
        mockFetch.mockResolvedValue(
          mockSuccessResponse({ records: [], total: 0 })
        );

        await analyticsStorage.query({
          experimentId: 'exp-123',
          agentId: 'agent-1',
          size: 50,
          from: 10,
        });

        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining('experimentId=exp-123'),
          expect.any(Object)
        );
      });

      it('should handle empty filters', async () => {
        mockFetch.mockResolvedValue(
          mockSuccessResponse({ records: [], total: 0 })
        );

        await analyticsStorage.query({});

        expect(mockFetch).toHaveBeenCalledWith(
          'http://localhost:4001/api/storage/analytics',
          expect.any(Object)
        );
      });
    });

    describe('aggregations', () => {
      it('should get aggregations', async () => {
        const aggResult = {
          aggregations: [
            {
              key: 'agent-1',
              metrics: { avgAccuracy: 0.9 },
              passCount: 8,
              failCount: 2,
              totalRuns: 10,
            },
          ],
          groupBy: 'agentId',
        };
        mockFetch.mockResolvedValue(mockSuccessResponse(aggResult));

        const result = await analyticsStorage.aggregations('exp-123', 'agentId');

        expect(result).toEqual(aggResult);
        expect(mockFetch).toHaveBeenCalledWith(
          'http://localhost:4001/api/storage/analytics/aggregations?experimentId=exp-123&groupBy=agentId',
          expect.any(Object)
        );
      });

      it('should handle no parameters', async () => {
        mockFetch.mockResolvedValue(
          mockSuccessResponse({ aggregations: [], groupBy: '' })
        );

        await analyticsStorage.aggregations();

        expect(mockFetch).toHaveBeenCalledWith(
          'http://localhost:4001/api/storage/analytics/aggregations',
          expect.any(Object)
        );
      });
    });

    describe('search', () => {
      it('should perform complex search', async () => {
        mockFetch.mockResolvedValue(
          mockSuccessResponse({
            records: [mockAnalyticsRecord],
            total: 1,
            aggregations: { passRate: 0.9 },
          })
        );

        const options = {
          filters: { experimentId: 'exp-123' },
          aggs: { passRate: { avg: { field: 'passFailStatus' } } },
          size: 100,
        };

        const result = await analyticsStorage.search(options);

        expect(result.records).toEqual([mockAnalyticsRecord]);
        expect(mockFetch).toHaveBeenCalledWith(
          'http://localhost:4001/api/storage/analytics/search',
          expect.objectContaining({
            method: 'POST',
            body: JSON.stringify(options),
          })
        );
      });
    });

    describe('backfill', () => {
      it('should backfill analytics', async () => {
        mockFetch.mockResolvedValue(
          mockSuccessResponse({ backfilled: 50, errors: 2, total: 52 })
        );

        const result = await analyticsStorage.backfill();

        expect(result).toEqual({ backfilled: 50, errors: 2, total: 52 });
        expect(mockFetch).toHaveBeenCalledWith(
          'http://localhost:4001/api/storage/backfill-analytics',
          expect.objectContaining({ method: 'POST' })
        );
      });
    });
  });

  // ==================== opensearchStorage Combined Export ====================

  describe('opensearchStorage', () => {
    it('should export all storage modules', () => {
      expect(opensearchStorage.admin).toBe(storageAdmin);
      expect(opensearchStorage.testCases).toBe(testCaseStorage);
      expect(opensearchStorage.experiments).toBe(benchmarkStorage);
      expect(opensearchStorage.runs).toBe(runStorage);
      expect(opensearchStorage.analytics).toBe(analyticsStorage);
    });
  });

  // ==================== Error Handling Tests ====================

  describe('Error Handling', () => {
    it('should handle network errors', async () => {
      mockNetworkError();

      await expect(storageAdmin.health()).rejects.toThrow('Network error');
    });

    it('should handle JSON parse errors in error response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: () => Promise.reject(new Error('Invalid JSON')),
      });

      await expect(storageAdmin.health()).rejects.toThrow('Internal Server Error');
    });

    it('should use default error message when no error in response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.resolve({}),
      });

      await expect(storageAdmin.health()).rejects.toThrow('Storage request failed: 500');
    });

    it('should include body in POST requests', async () => {
      mockFetch.mockResolvedValue(mockSuccessResponse({ created: 1, errors: false }));

      await testCaseStorage.bulkCreate([{ name: 'Test' }]);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: { 'Content-Type': 'application/json' },
          body: expect.any(String),
        })
      );
    });

    it('should not include body in GET requests', async () => {
      mockFetch.mockResolvedValue(mockSuccessResponse({ testCases: [], total: 0 }));

      await testCaseStorage.getAll();

      const callArgs = mockFetch.mock.calls[0][1];
      expect(callArgs.body).toBeUndefined();
    });
  });
});
