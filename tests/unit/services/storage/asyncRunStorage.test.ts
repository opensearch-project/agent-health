/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// @ts-nocheck - Test file uses simplified mock objects for storage types
import { asyncRunStorage } from '@/services/storage/asyncRunStorage';
import { runStorage as opensearchRuns } from '@/services/storage/opensearchClient';
import type { EvaluationReport, TrajectoryStep } from '@/types';

// Mock the OpenSearch client
jest.mock('@/services/storage/opensearchClient', () => ({
  runStorage: {
    create: jest.fn(),
    getByTestCase: jest.fn(),
    getAll: jest.fn(),
    getById: jest.fn(),
    delete: jest.fn(),
    partialUpdate: jest.fn(),
    count: jest.fn(),
    search: jest.fn(),
    addAnnotation: jest.fn(),
    updateAnnotation: jest.fn(),
    deleteAnnotation: jest.fn(),
    getByBenchmarkRun: jest.fn(),
    getByBenchmark: jest.fn(),
    getIterations: jest.fn(),
    bulkCreate: jest.fn(),
    deleteMany: jest.fn(),
  },
}));

const mockOsRuns = opensearchRuns as jest.Mocked<typeof opensearchRuns>;

describe('AsyncRunStorage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // Helper to create a mock storage run
  const createMockStorageRun = (id: string = 'run-1') => ({
    id,
    createdAt: '2024-01-01T00:00:00Z',
    testCaseId: 'tc-1',
    testCaseVersionId: 'tc-1-v1',
    experimentId: '',
    experimentRunId: '',
    agentId: 'test-agent',
    modelId: 'test-model',
    iteration: 1,
    status: 'completed' as const,
    passFailStatus: 'passed' as const,
    traceId: 'trace-1',
    tags: [],
    actualOutcomes: [],
    llmJudgeReasoning: 'Good performance',
    metrics: {
      accuracy: 0.95,
      faithfulness: 0.9,
      latency_score: 0.85,
      trajectory_alignment_score: 0.88,
    },
    trajectory: [
      { type: 'action', content: 'Test action' },
    ] as TrajectoryStep[],
    annotations: [],
  });

  // Helper to create a mock evaluation report
  const createMockReport = (id: string = 'report-1'): EvaluationReport => ({
    id,
    testCaseId: 'tc-1',
    testCaseVersion: 1,
    agentKey: 'test-agent',
    modelId: 'test-model',
    status: 'completed',
    passFailStatus: 'passed',
    runId: 'trace-1',
    llmJudgeReasoning: 'Good performance',
    metrics: {
      accuracy: 0.95,
      faithfulness: 0.9,
      latency_score: 0.85,
      trajectory_alignment_score: 0.88,
    },
    trajectory: [
      { type: 'action', content: 'Test action' },
    ] as TrajectoryStep[],
    evaluatedAt: '2024-01-01T00:00:00Z',
  });

  describe('saveReport', () => {
    it('saves a report and returns the created document', async () => {
      const mockStorageRun = createMockStorageRun('new-run-1');
      mockOsRuns.create.mockResolvedValue(mockStorageRun);

      const report = createMockReport('new-report-1');
      const result = await asyncRunStorage.saveReport(report);

      expect(mockOsRuns.create).toHaveBeenCalledTimes(1);
      expect(result.id).toBe('new-run-1');
      expect(result.testCaseId).toBe('tc-1');
      expect(result.status).toBe('completed');
    });

    it('includes experiment context when provided', async () => {
      const mockStorageRun = createMockStorageRun('run-exp');
      mockOsRuns.create.mockResolvedValue(mockStorageRun);

      const report = createMockReport();
      await asyncRunStorage.saveReport(report, {
        experimentId: 'exp-1',
        experimentRunId: 'exp-run-1',
        iteration: 3,
      });

      expect(mockOsRuns.create).toHaveBeenCalledWith(
        expect.objectContaining({
          experimentId: 'exp-1',
          experimentRunId: 'exp-run-1',
          iteration: 3,
        })
      );
    });
  });

  describe('getReportsByTestCase', () => {
    it('returns reports for a test case', async () => {
      const mockRuns = [createMockStorageRun('run-1'), createMockStorageRun('run-2')];
      mockOsRuns.getByTestCase.mockResolvedValue(mockRuns);

      const result = await asyncRunStorage.getReportsByTestCase('tc-1');

      expect(mockOsRuns.getByTestCase).toHaveBeenCalledWith('tc-1', 100);
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('run-1');
      expect(result[1].id).toBe('run-2');
    });

    it('respects limit option', async () => {
      mockOsRuns.getByTestCase.mockResolvedValue([]);

      await asyncRunStorage.getReportsByTestCase('tc-1', { limit: 50 });

      expect(mockOsRuns.getByTestCase).toHaveBeenCalledWith('tc-1', 50);
    });
  });

  describe('getAllReports', () => {
    it('returns all reports with default pagination', async () => {
      const mockRuns = [createMockStorageRun('run-1')];
      mockOsRuns.getAll.mockResolvedValue({ runs: mockRuns, total: 1 });

      const result = await asyncRunStorage.getAllReports();

      expect(mockOsRuns.getAll).toHaveBeenCalledWith({ size: 100, from: 0 });
      expect(result).toHaveLength(1);
    });

    it('respects pagination options', async () => {
      mockOsRuns.getAll.mockResolvedValue({ runs: [], total: 0 });

      await asyncRunStorage.getAllReports({ limit: 50, offset: 10 });

      expect(mockOsRuns.getAll).toHaveBeenCalledWith({ size: 50, from: 10 });
    });
  });

  describe('getReportById', () => {
    it('returns a report when found', async () => {
      const mockRun = createMockStorageRun('run-1');
      mockOsRuns.getById.mockResolvedValue(mockRun);

      const result = await asyncRunStorage.getReportById('run-1');

      expect(mockOsRuns.getById).toHaveBeenCalledWith('run-1');
      expect(result).not.toBeNull();
      expect(result?.id).toBe('run-1');
    });

    it('returns null when not found', async () => {
      mockOsRuns.getById.mockResolvedValue(null);

      const result = await asyncRunStorage.getReportById('non-existent');

      expect(result).toBeNull();
    });
  });

  describe('deleteReport', () => {
    it('returns true when deletion succeeds', async () => {
      mockOsRuns.delete.mockResolvedValue({ deleted: true });

      const result = await asyncRunStorage.deleteReport('run-1');

      expect(mockOsRuns.delete).toHaveBeenCalledWith('run-1');
      expect(result).toBe(true);
    });

    it('returns false when deletion fails', async () => {
      mockOsRuns.delete.mockResolvedValue({ deleted: false });

      const result = await asyncRunStorage.deleteReport('non-existent');

      expect(result).toBe(false);
    });
  });

  describe('updateReport', () => {
    it('updates a report with new values', async () => {
      const mockUpdated = {
        ...createMockStorageRun('run-1'),
        status: 'completed' as const,
        passFailStatus: 'failed' as const,
      };
      mockOsRuns.partialUpdate.mockResolvedValue(mockUpdated);

      const result = await asyncRunStorage.updateReport('run-1', {
        status: 'completed',
        passFailStatus: 'failed',
      });

      expect(mockOsRuns.partialUpdate).toHaveBeenCalledWith('run-1', expect.objectContaining({
        status: 'completed',
        passFailStatus: 'failed',
      }));
      expect(result?.passFailStatus).toBe('failed');
    });

    it('updates trace-mode fields', async () => {
      const mockUpdated = createMockStorageRun('run-1');
      mockOsRuns.partialUpdate.mockResolvedValue({
        ...mockUpdated,
        metricsStatus: 'ready',
        traceFetchAttempts: 5,
      });

      await asyncRunStorage.updateReport('run-1', {
        metricsStatus: 'ready',
        traceFetchAttempts: 5,
      });

      expect(mockOsRuns.partialUpdate).toHaveBeenCalledWith('run-1', expect.objectContaining({
        metricsStatus: 'ready',
        traceFetchAttempts: 5,
      }));
    });

    it('maps metrics correctly', async () => {
      const mockUpdated = createMockStorageRun('run-1');
      mockOsRuns.partialUpdate.mockResolvedValue(mockUpdated);

      await asyncRunStorage.updateReport('run-1', {
        metrics: {
          accuracy: 0.98,
          faithfulness: 0.95,
          latency_score: 0.90,
          trajectory_alignment_score: 0.92,
        },
      });

      expect(mockOsRuns.partialUpdate).toHaveBeenCalledWith('run-1', expect.objectContaining({
        metrics: {
          accuracy: 0.98,
          faithfulness: 0.95,
          latency_score: 0.90,
          trajectory_alignment_score: 0.92,
        },
      }));
    });
  });

  describe('format conversion', () => {
    it('converts storage format to app format correctly', async () => {
      const mockStorageRun = {
        ...createMockStorageRun('run-1'),
        annotations: [
          {
            id: 'ann-1',
            text: 'Test annotation',
            createdAt: '2024-01-01T12:00:00Z',
            tags: ['tag1'],
            author: 'user1',
          },
        ],
      };
      mockOsRuns.getById.mockResolvedValue(mockStorageRun);

      const result = await asyncRunStorage.getReportById('run-1');

      expect(result).toMatchObject({
        id: 'run-1',
        testCaseId: 'tc-1',
        testCaseVersion: 1,
        agentKey: 'test-agent',
        modelId: 'test-model',
        status: 'completed',
        passFailStatus: 'passed',
        runId: 'trace-1',
        annotations: expect.arrayContaining([
          expect.objectContaining({
            id: 'ann-1',
            text: 'Test annotation',
            tags: ['tag1'],
          }),
        ]),
      });
    });

    it('handles trace-mode fields in conversion', async () => {
      const mockStorageRun = {
        ...createMockStorageRun('run-1'),
        metricsStatus: 'ready',
        traceFetchAttempts: 3,
        lastTraceFetchAt: '2024-01-01T12:00:00Z',
        traceError: undefined,
        spans: [{ spanId: 'span-1' }],
      };
      mockOsRuns.getById.mockResolvedValue(mockStorageRun);

      const result = await asyncRunStorage.getReportById('run-1');

      expect(result).toMatchObject({
        metricsStatus: 'ready',
        traceFetchAttempts: 3,
        lastTraceFetchAt: '2024-01-01T12:00:00Z',
        spans: [{ spanId: 'span-1' }],
      });
    });
  });

  describe('getReportCount', () => {
    it('returns total count of reports', async () => {
      mockOsRuns.getAll.mockResolvedValue({ runs: [], total: 42 });

      const result = await asyncRunStorage.getReportCount();

      expect(mockOsRuns.getAll).toHaveBeenCalledWith({ size: 0 });
      expect(result).toBe(42);
    });
  });

  describe('getReportCountByTestCase', () => {
    it('returns count for a specific test case', async () => {
      const mockRuns = [createMockStorageRun('run-1'), createMockStorageRun('run-2')];
      mockOsRuns.getByTestCase.mockResolvedValue(mockRuns);

      const result = await asyncRunStorage.getReportCountByTestCase('tc-1');

      expect(mockOsRuns.getByTestCase).toHaveBeenCalledWith('tc-1', 0);
      expect(result).toBe(2);
    });
  });

  describe('getByBenchmark', () => {
    it('returns runs for an experiment', async () => {
      const mockRuns = [createMockStorageRun('run-1'), createMockStorageRun('run-2')];
      mockOsRuns.getByBenchmark.mockResolvedValue(mockRuns);

      const result = await asyncRunStorage.getByExperiment('exp-1');

      expect(mockOsRuns.getByBenchmark).toHaveBeenCalledWith('exp-1', undefined);
      expect(result).toHaveLength(2);
    });

    it('respects size option', async () => {
      mockOsRuns.getByBenchmark.mockResolvedValue([]);

      await asyncRunStorage.getByExperiment('exp-1', 50);

      expect(mockOsRuns.getByBenchmark).toHaveBeenCalledWith('exp-1', 50);
    });
  });

  describe('getByBenchmarkRun', () => {
    it('returns runs for a specific experiment run', async () => {
      const mockRuns = [createMockStorageRun('run-1')];
      mockOsRuns.getByBenchmarkRun.mockResolvedValue(mockRuns);

      const result = await asyncRunStorage.getByBenchmarkRun('exp-1', 'run-1');

      expect(mockOsRuns.getByBenchmarkRun).toHaveBeenCalledWith('exp-1', 'run-1', undefined);
      expect(result).toHaveLength(1);
    });

    it('respects size option', async () => {
      mockOsRuns.getByBenchmarkRun.mockResolvedValue([]);

      await asyncRunStorage.getByBenchmarkRun('exp-1', 'run-1', 25);

      expect(mockOsRuns.getByBenchmarkRun).toHaveBeenCalledWith('exp-1', 'run-1', 25);
    });
  });

  describe('getIterations', () => {
    it('returns iterations for a test case in an experiment', async () => {
      const mockRuns = [createMockStorageRun('run-1'), createMockStorageRun('run-2')];
      mockOsRuns.getIterations.mockResolvedValue({
        runs: mockRuns,
        total: 2,
        maxIteration: 2,
      });

      const result = await asyncRunStorage.getIterations('exp-1', 'tc-1');

      expect(mockOsRuns.getIterations).toHaveBeenCalledWith('exp-1', 'tc-1', undefined);
      expect(result.runs).toHaveLength(2);
      expect(result.total).toBe(2);
      expect(result.maxIteration).toBe(2);
    });

    it('filters by experiment run ID when provided', async () => {
      mockOsRuns.getIterations.mockResolvedValue({
        runs: [],
        total: 0,
        maxIteration: 0,
      });

      await asyncRunStorage.getIterations('exp-1', 'tc-1', 'exp-run-1');

      expect(mockOsRuns.getIterations).toHaveBeenCalledWith('exp-1', 'tc-1', 'exp-run-1');
    });
  });

  describe('annotation operations', () => {
    describe('addAnnotation', () => {
      it('adds an annotation to a report', async () => {
        const mockAnnotation = {
          id: 'ann-1',
          text: 'Test annotation',
          createdAt: '2024-01-01T12:00:00Z',
          tags: ['tag1', 'tag2'],
          author: 'user1',
        };
        mockOsRuns.addAnnotation.mockResolvedValue(mockAnnotation);

        const result = await asyncRunStorage.addAnnotation('run-1', {
          text: 'Test annotation',
          tags: ['tag1', 'tag2'],
          author: 'user1',
        });

        expect(mockOsRuns.addAnnotation).toHaveBeenCalledWith('run-1', {
          text: 'Test annotation',
          tags: ['tag1', 'tag2'],
          author: 'user1',
        });
        expect(result).toMatchObject({
          id: 'ann-1',
          reportId: 'run-1',
          text: 'Test annotation',
          tags: ['tag1', 'tag2'],
          author: 'user1',
        });
      });
    });

    describe('updateAnnotation', () => {
      it('returns true when update succeeds', async () => {
        mockOsRuns.updateAnnotation.mockResolvedValue(undefined);

        const result = await asyncRunStorage.updateAnnotation('run-1', 'ann-1', {
          text: 'Updated text',
          tags: ['new-tag'],
        });

        expect(mockOsRuns.updateAnnotation).toHaveBeenCalledWith('run-1', 'ann-1', {
          text: 'Updated text',
          tags: ['new-tag'],
        });
        expect(result).toBe(true);
      });

      it('returns false when update fails', async () => {
        mockOsRuns.updateAnnotation.mockRejectedValue(new Error('Update failed'));

        const result = await asyncRunStorage.updateAnnotation('run-1', 'non-existent', {
          text: 'Updated text',
        });

        expect(result).toBe(false);
      });
    });

    describe('deleteAnnotation', () => {
      it('returns true when deletion succeeds', async () => {
        mockOsRuns.deleteAnnotation.mockResolvedValue({ deleted: true });

        const result = await asyncRunStorage.deleteAnnotation('run-1', 'ann-1');

        expect(mockOsRuns.deleteAnnotation).toHaveBeenCalledWith('run-1', 'ann-1');
        expect(result).toBe(true);
      });

      it('returns false when deletion fails', async () => {
        mockOsRuns.deleteAnnotation.mockResolvedValue({ deleted: false });

        const result = await asyncRunStorage.deleteAnnotation('run-1', 'non-existent');

        expect(result).toBe(false);
      });
    });

    describe('getAnnotationsByReport', () => {
      it('returns annotations for a report', async () => {
        const mockStorageRun = {
          ...createMockStorageRun('run-1'),
          annotations: [
            {
              id: 'ann-1',
              text: 'Annotation 1',
              createdAt: '2024-01-01T12:00:00Z',
              tags: ['tag1'],
              author: 'user1',
            },
            {
              id: 'ann-2',
              text: 'Annotation 2',
              createdAt: '2024-01-01T13:00:00Z',
              tags: [],
              author: 'user2',
            },
          ],
        };
        mockOsRuns.getById.mockResolvedValue(mockStorageRun);

        const result = await asyncRunStorage.getAnnotationsByReport('run-1');

        expect(result).toHaveLength(2);
        expect(result[0]).toMatchObject({
          id: 'ann-1',
          reportId: 'run-1',
          text: 'Annotation 1',
          tags: ['tag1'],
        });
      });

      it('returns empty array when report not found', async () => {
        mockOsRuns.getById.mockResolvedValue(null);

        const result = await asyncRunStorage.getAnnotationsByReport('non-existent');

        expect(result).toEqual([]);
      });

      it('returns empty array when report has no annotations', async () => {
        const mockStorageRun = {
          ...createMockStorageRun('run-1'),
          annotations: undefined,
        };
        mockOsRuns.getById.mockResolvedValue(mockStorageRun);

        const result = await asyncRunStorage.getAnnotationsByReport('run-1');

        expect(result).toEqual([]);
      });
    });
  });

  describe('searchReports', () => {
    it('searches with test case filter', async () => {
      const mockRuns = [createMockStorageRun('run-1')];
      mockOsRuns.search.mockResolvedValue({ runs: mockRuns, total: 1 });

      const result = await asyncRunStorage.searchReports({
        testCaseIds: ['tc-1'],
      });

      expect(mockOsRuns.search).toHaveBeenCalledWith(
        expect.objectContaining({
          testCaseId: 'tc-1',
        })
      );
      expect(result).toHaveLength(1);
    });

    it('searches with date range filter', async () => {
      mockOsRuns.search.mockResolvedValue({ runs: [], total: 0 });

      await asyncRunStorage.searchReports({
        dateRange: { start: '2024-01-01', end: '2024-12-31' },
      });

      expect(mockOsRuns.search).toHaveBeenCalledWith(
        expect.objectContaining({
          dateRange: { start: '2024-01-01', end: '2024-12-31' },
        })
      );
    });

    it('searches with status filter', async () => {
      mockOsRuns.search.mockResolvedValue({ runs: [], total: 0 });

      await asyncRunStorage.searchReports({
        status: ['completed'],
      });

      expect(mockOsRuns.search).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'completed',
        })
      );
    });

    it('applies client-side agent name filter', async () => {
      const mockRuns = [
        { ...createMockStorageRun('run-1'), agentId: 'agent-1' },
        { ...createMockStorageRun('run-2'), agentId: 'agent-2' },
      ];
      mockOsRuns.search.mockResolvedValue({ runs: mockRuns, total: 2 });

      const result = await asyncRunStorage.searchReports({
        agentNames: ['agent-1'],
      });

      expect(result).toHaveLength(1);
      expect(result[0].agentName).toBe('agent-1');
    });

    it('applies client-side model name filter', async () => {
      const mockRuns = [
        { ...createMockStorageRun('run-1'), modelId: 'model-1' },
        { ...createMockStorageRun('run-2'), modelId: 'model-2' },
      ];
      mockOsRuns.search.mockResolvedValue({ runs: mockRuns, total: 2 });

      const result = await asyncRunStorage.searchReports({
        modelNames: ['model-1'],
      });

      expect(result).toHaveLength(1);
      expect(result[0].modelName).toBe('model-1');
    });

    it('applies client-side min accuracy filter', async () => {
      const mockRuns = [
        { ...createMockStorageRun('run-1'), metrics: { ...createMockStorageRun('run-1').metrics, accuracy: 0.8 } },
        { ...createMockStorageRun('run-2'), metrics: { ...createMockStorageRun('run-2').metrics, accuracy: 0.95 } },
      ];
      mockOsRuns.search.mockResolvedValue({ runs: mockRuns, total: 2 });

      const result = await asyncRunStorage.searchReports({
        minAccuracy: 0.9,
      });

      expect(result).toHaveLength(1);
      expect(result[0].metrics.accuracy).toBe(0.95);
    });
  });

  describe('generateReportId', () => {
    it('generates unique IDs', () => {
      const id1 = asyncRunStorage.generateReportId();
      const id2 = asyncRunStorage.generateReportId();

      expect(id1).toMatch(/^run-\d+-[a-z0-9]+$/);
      expect(id2).toMatch(/^run-\d+-[a-z0-9]+$/);
      expect(id1).not.toBe(id2);
    });
  });

  describe('bulkCreate', () => {
    it('creates multiple runs in bulk', async () => {
      mockOsRuns.bulkCreate.mockResolvedValue({ created: 2, errors: false });

      const reports = [createMockReport('report-1'), createMockReport('report-2')];
      const result = await asyncRunStorage.bulkCreate(reports);

      expect(mockOsRuns.bulkCreate).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ id: 'report-1' }),
          expect.objectContaining({ id: 'report-2' }),
        ])
      );
      expect(result).toEqual({ created: 2, errors: false });
    });

    it('handles bulk create with errors', async () => {
      mockOsRuns.bulkCreate.mockResolvedValue({ created: 1, errors: true });

      const reports = [createMockReport('report-1'), createMockReport('report-2')];
      const result = await asyncRunStorage.bulkCreate(reports);

      expect(result).toEqual({ created: 1, errors: true });
    });
  });

  describe('toStorageFormat', () => {
    it('correctly maps all trace-mode fields', async () => {
      const mockStorageRun = createMockStorageRun('run-1');
      mockOsRuns.create.mockResolvedValue(mockStorageRun);

      const reportWithTraceFields: EvaluationReport = {
        ...createMockReport('report-1'),
        metricsStatus: 'calculating',
        traceFetchAttempts: 2,
        lastTraceFetchAt: '2024-01-01T10:00:00Z',
        traceError: 'Timeout error',
        spans: [{ spanId: 'span-1', name: 'test' }] as any[],
        openSearchLogs: [{ message: 'test log' }] as any[],
      };

      await asyncRunStorage.saveReport(reportWithTraceFields);

      expect(mockOsRuns.create).toHaveBeenCalledWith(
        expect.objectContaining({
          metricsStatus: 'calculating',
          traceFetchAttempts: 2,
          lastTraceFetchAt: '2024-01-01T10:00:00Z',
          traceError: 'Timeout error',
          spans: [{ spanId: 'span-1', name: 'test' }],
          logs: [{ message: 'test log' }],
        })
      );
    });
  });
});
