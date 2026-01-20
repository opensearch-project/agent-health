/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getAllTestCases,
  getTestCaseById,
  createRun,
  getRunById,
  updateRun,
  saveReport,
  isStorageConfigured,
} from '@/server/services/storage';

// Mock the opensearchClient module
jest.mock('@/server/services/opensearchClient', () => ({
  getOpenSearchClient: jest.fn(),
  INDEXES: {
    testCases: 'test-cases',
    runs: 'runs',
    analytics: 'analytics',
  },
  isStorageConfigured: true,
}));

import { getOpenSearchClient, INDEXES } from '@/server/services/opensearchClient';

describe('Storage Service', () => {
  let mockClient: any;
  let consoleWarnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient = {
      search: jest.fn(),
      index: jest.fn(),
      get: jest.fn(),
      update: jest.fn(),
    };
    (getOpenSearchClient as jest.Mock).mockReturnValue(mockClient);
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
  });

  describe('isStorageConfigured', () => {
    it('should be re-exported from opensearchClient', () => {
      expect(isStorageConfigured).toBe(true);
    });
  });

  describe('getAllTestCases', () => {
    it('should fetch all test cases with aggregations', async () => {
      const mockTestCases = [
        { id: 'tc-1', name: 'Test Case 1', version: 1 },
        { id: 'tc-2', name: 'Test Case 2', version: 2 },
      ];

      mockClient.search.mockResolvedValue({
        body: {
          aggregations: {
            test_cases: {
              buckets: [
                { latest: { hits: { hits: [{ _source: mockTestCases[0] }] } } },
                { latest: { hits: { hits: [{ _source: mockTestCases[1] }] } } },
              ],
            },
          },
        },
      });

      const result = await getAllTestCases();

      expect(mockClient.search).toHaveBeenCalledWith({
        index: INDEXES.testCases,
        body: {
          size: 0,
          aggs: {
            test_cases: {
              terms: { field: 'id', size: 10000 },
              aggs: {
                latest: {
                  top_hits: { size: 1, sort: [{ version: { order: 'desc' } }] },
                },
              },
            },
          },
        },
      });
      expect(result).toEqual(mockTestCases);
    });

    it('should return empty array when no aggregations', async () => {
      mockClient.search.mockResolvedValue({
        body: {
          aggregations: null,
        },
      });

      const result = await getAllTestCases();
      expect(result).toEqual([]);
    });

    it('should return empty array when no buckets', async () => {
      mockClient.search.mockResolvedValue({
        body: {
          aggregations: {
            test_cases: {
              buckets: null,
            },
          },
        },
      });

      const result = await getAllTestCases();
      expect(result).toEqual([]);
    });

    it('should throw when storage is not configured', async () => {
      (getOpenSearchClient as jest.Mock).mockReturnValue(null);

      await expect(getAllTestCases()).rejects.toThrow('Storage not configured');
    });
  });

  describe('getTestCaseById', () => {
    it('should fetch test case by ID', async () => {
      const mockTestCase = { id: 'tc-123', name: 'Test Case', version: 1 };

      mockClient.search.mockResolvedValue({
        body: {
          hits: {
            hits: [{ _source: mockTestCase }],
          },
        },
      });

      const result = await getTestCaseById('tc-123');

      expect(mockClient.search).toHaveBeenCalledWith({
        index: INDEXES.testCases,
        body: {
          size: 1,
          sort: [{ version: { order: 'desc' } }],
          query: { term: { id: 'tc-123' } },
        },
      });
      expect(result).toEqual(mockTestCase);
    });

    it('should return null when test case not found', async () => {
      mockClient.search.mockResolvedValue({
        body: {
          hits: {
            hits: [],
          },
        },
      });

      const result = await getTestCaseById('non-existent');
      expect(result).toBeNull();
    });

    it('should return null when hits is undefined', async () => {
      mockClient.search.mockResolvedValue({
        body: {
          hits: null,
        },
      });

      const result = await getTestCaseById('tc-123');
      expect(result).toBeNull();
    });

    it('should throw when storage is not configured', async () => {
      (getOpenSearchClient as jest.Mock).mockReturnValue(null);

      await expect(getTestCaseById('tc-123')).rejects.toThrow('Storage not configured');
    });
  });

  describe('createRun', () => {
    beforeEach(() => {
      jest.spyOn(Date, 'now').mockReturnValue(1704067200000);
      jest.spyOn(Math, 'random').mockReturnValue(0.123456789);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('should create a run with generated ID', async () => {
      mockClient.index.mockResolvedValue({ body: { result: 'created' } });

      const run = { testCaseId: 'tc-1', status: 'completed' };
      const result = await createRun(run);

      expect(mockClient.index).toHaveBeenCalledWith({
        index: INDEXES.runs,
        id: expect.stringMatching(/^run-/),
        body: expect.objectContaining({
          testCaseId: 'tc-1',
          status: 'completed',
          annotations: [],
          createdAt: expect.any(String),
        }),
        refresh: true,
      });
      expect(result.id).toMatch(/^run-/);
      expect(result.createdAt).toBeDefined();
    });

    it('should use provided ID if available', async () => {
      mockClient.index.mockResolvedValue({ body: { result: 'created' } });

      const run = { id: 'custom-id', testCaseId: 'tc-1' };
      const result = await createRun(run);

      expect(mockClient.index).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'custom-id',
        })
      );
      expect(result.id).toBe('custom-id');
    });

    it('should preserve existing annotations', async () => {
      mockClient.index.mockResolvedValue({ body: { result: 'created' } });

      const run = { testCaseId: 'tc-1', annotations: ['note1', 'note2'] };
      const result = await createRun(run);

      expect(result.annotations).toEqual(['note1', 'note2']);
    });

    it('should write analytics record (non-blocking)', async () => {
      mockClient.index.mockResolvedValue({ body: { result: 'created' } });

      const run = {
        testCaseId: 'tc-1',
        metrics: { accuracy: 0.95, latency: 100 },
      };

      await createRun(run);

      // Wait for the non-blocking analytics write
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Should have been called twice: once for run, once for analytics
      expect(mockClient.index).toHaveBeenCalledTimes(2);
      expect(mockClient.index).toHaveBeenLastCalledWith(
        expect.objectContaining({
          index: INDEXES.analytics,
          body: expect.objectContaining({
            testCaseId: 'tc-1',
            metric_accuracy: 0.95,
            metric_latency: 100,
          }),
        })
      );
    });

    it('should handle analytics write failure gracefully', async () => {
      mockClient.index
        .mockResolvedValueOnce({ body: { result: 'created' } })
        .mockRejectedValueOnce(new Error('Analytics write failed'));

      const run = { testCaseId: 'tc-1' };
      const result = await createRun(run);

      // Wait for the non-blocking analytics write
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(result).toBeDefined();
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        '[StorageService] Analytics write failed:',
        'Analytics write failed'
      );
    });

    it('should throw when storage is not configured', async () => {
      (getOpenSearchClient as jest.Mock).mockReturnValue(null);

      await expect(createRun({ testCaseId: 'tc-1' })).rejects.toThrow('Storage not configured');
    });
  });

  describe('getRunById', () => {
    it('should fetch run by ID', async () => {
      const mockRun = { id: 'run-123', testCaseId: 'tc-1', status: 'completed' };

      mockClient.get.mockResolvedValue({
        body: {
          found: true,
          _source: mockRun,
        },
      });

      const result = await getRunById('run-123');

      expect(mockClient.get).toHaveBeenCalledWith({
        index: INDEXES.runs,
        id: 'run-123',
      });
      expect(result).toEqual(mockRun);
    });

    it('should return null when run not found (found: false)', async () => {
      mockClient.get.mockResolvedValue({
        body: {
          found: false,
        },
      });

      const result = await getRunById('non-existent');
      expect(result).toBeNull();
    });

    it('should return null on 404 error', async () => {
      const error = new Error('Not found');
      (error as any).meta = { statusCode: 404 };
      mockClient.get.mockRejectedValue(error);

      const result = await getRunById('non-existent');
      expect(result).toBeNull();
    });

    it('should rethrow non-404 errors', async () => {
      const error = new Error('Server error');
      (error as any).meta = { statusCode: 500 };
      mockClient.get.mockRejectedValue(error);

      await expect(getRunById('run-123')).rejects.toThrow('Server error');
    });

    it('should throw when storage is not configured', async () => {
      (getOpenSearchClient as jest.Mock).mockReturnValue(null);

      await expect(getRunById('run-123')).rejects.toThrow('Storage not configured');
    });
  });

  describe('updateRun', () => {
    it('should update run and return updated document', async () => {
      const updatedRun = { id: 'run-123', testCaseId: 'tc-1', status: 'completed' };

      mockClient.update.mockResolvedValue({ body: { result: 'updated' } });
      mockClient.get.mockResolvedValue({
        body: {
          _source: updatedRun,
        },
      });

      const result = await updateRun('run-123', { status: 'completed' });

      expect(mockClient.update).toHaveBeenCalledWith({
        index: INDEXES.runs,
        id: 'run-123',
        body: { doc: { status: 'completed' } },
        refresh: true,
      });
      expect(mockClient.get).toHaveBeenCalledWith({
        index: INDEXES.runs,
        id: 'run-123',
      });
      expect(result).toEqual(updatedRun);
    });

    it('should throw when storage is not configured', async () => {
      (getOpenSearchClient as jest.Mock).mockReturnValue(null);

      await expect(updateRun('run-123', { status: 'completed' })).rejects.toThrow(
        'Storage not configured'
      );
    });
  });

  describe('saveReport', () => {
    beforeEach(() => {
      jest.spyOn(Date, 'now').mockReturnValue(1704067200000);
      jest.spyOn(Math, 'random').mockReturnValue(0.123456789);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('should save report with all fields converted', async () => {
      mockClient.index.mockResolvedValue({ body: { result: 'created' } });

      const report = {
        testCaseId: 'tc-1',
        testCaseVersion: 2,
        agentKey: 'test-agent',
        modelId: 'test-model',
        status: 'completed',
        passFailStatus: 'passed',
        runId: 'trace-123',
        llmJudgeReasoning: 'Good reasoning',
        metrics: { accuracy: 0.95 },
        trajectory: [{ step: 1 }],
        rawEvents: [{ event: 1 }],
        logs: ['log1'],
        improvementStrategies: ['strategy1'],
      };

      const result = await saveReport(report, {
        experimentId: 'exp-1',
        experimentRunId: 'exprun-1',
        iteration: 3,
      });

      expect(mockClient.index).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            experimentId: 'exp-1',
            experimentRunId: 'exprun-1',
            testCaseId: 'tc-1',
            testCaseVersionId: 'tc-1-v2',
            agentId: 'test-agent',
            modelId: 'test-model',
            iteration: 3,
            status: 'completed',
            passFailStatus: 'passed',
            traceId: 'trace-123',
            llmJudgeReasoning: 'Good reasoning',
            metrics: { accuracy: 0.95 },
            trajectory: [{ step: 1 }],
            rawEvents: [{ event: 1 }],
            logs: ['log1'],
            improvementStrategies: ['strategy1'],
          }),
        })
      );

      expect(result.id).toMatch(/^run-/);
      expect(result.experimentId).toBe('exp-1');
      expect(result.experimentRunId).toBe('exprun-1');
    });

    it('should use default values when options not provided', async () => {
      mockClient.index.mockResolvedValue({ body: { result: 'created' } });

      const report = {
        testCaseId: 'tc-1',
        agentName: 'test-agent',
        modelName: 'test-model',
        status: 'completed',
      };

      await saveReport(report);

      expect(mockClient.index).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            experimentId: '',
            experimentRunId: '',
            testCaseVersionId: 'tc-1-v1',
            iteration: 1,
          }),
        })
      );
    });

    it('should include trace-mode fields when present', async () => {
      mockClient.index.mockResolvedValue({ body: { result: 'created' } });

      const report = {
        testCaseId: 'tc-1',
        metricsStatus: 'success',
        traceFetchAttempts: 3,
        lastTraceFetchAt: '2024-01-01T00:00:00Z',
        traceError: null,
        spans: [{ span: 1 }],
      };

      await saveReport(report);

      expect(mockClient.index).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            metricsStatus: 'success',
            traceFetchAttempts: 3,
            lastTraceFetchAt: '2024-01-01T00:00:00Z',
            traceError: null,
            spans: [{ span: 1 }],
          }),
        })
      );
    });

    it('should use openSearchLogs as fallback for logs', async () => {
      mockClient.index.mockResolvedValue({ body: { result: 'created' } });

      const report = {
        testCaseId: 'tc-1',
        openSearchLogs: ['osLog1', 'osLog2'],
      };

      await saveReport(report);

      expect(mockClient.index).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            logs: ['osLog1', 'osLog2'],
          }),
        })
      );
    });
  });
});
