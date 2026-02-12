/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// @ts-nocheck - Test file uses simplified mock objects
import { asyncBenchmarkStorage } from '@/services/storage/asyncBenchmarkStorage';
import { benchmarkStorage as opensearchExperiments } from '@/services/storage/opensearchClient';
import type { Benchmark, BenchmarkRun } from '@/types';

// Mock the OpenSearch client
jest.mock('@/services/storage/opensearchClient', () => ({
  benchmarkStorage: {
    getAll: jest.fn(),
    getById: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    bulkCreate: jest.fn(),
  },
}));

const mockOsExperiments = opensearchExperiments as jest.Mocked<typeof opensearchExperiments>;

describe('AsyncBenchmarkStorage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // Helper to create a mock storage experiment
  const createMockStorageExperiment = (id: string = 'exp-1') => ({
    id,
    name: 'Test Benchmark',
    description: 'Test description',
    createdAt: '2024-01-01T00:00:00Z',
    testCaseIds: ['tc-1', 'tc-2'],
    runs: [
      {
        id: 'run-1',
        name: 'Run 1',
        description: 'First run',
        agentId: 'agent-1',
        modelId: 'model-1',
        headers: { 'x-custom': 'value' },
        createdAt: '2024-01-01T10:00:00Z',
        results: {
          'tc-1': { reportId: 'report-1', status: 'completed' },
          'tc-2': { reportId: 'report-2', status: 'pending' },
        },
      },
    ],
  });

  // Helper to create a mock experiment run
  const createMockBenchmarkRun = (id: string = 'run-1'): BenchmarkRun => ({
    id,
    name: 'Test Run',
    description: 'Test run description',
    agentKey: 'agent-1',
    modelId: 'model-1',
    headers: { 'x-custom': 'value' },
    createdAt: '2024-01-01T10:00:00Z',
    results: {
      'tc-1': { reportId: 'report-1', status: 'completed' },
    },
  });

  describe('getAll', () => {
    it('returns all experiments converted to app format', async () => {
      const mockStorageExperiments = [
        createMockStorageExperiment('exp-1'),
        createMockStorageExperiment('exp-2'),
      ];
      mockOsExperiments.getAll.mockResolvedValue(mockStorageExperiments);

      const result = await asyncBenchmarkStorage.getAll();

      expect(mockOsExperiments.getAll).toHaveBeenCalledTimes(1);
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('exp-1');
      expect(result[1].id).toBe('exp-2');
    });

    it('converts runs correctly', async () => {
      mockOsExperiments.getAll.mockResolvedValue([createMockStorageExperiment()]);

      const result = await asyncBenchmarkStorage.getAll();

      expect(result[0].runs).toHaveLength(1);
      expect(result[0].runs[0].agentKey).toBe('agent-1');
      expect(result[0].runs[0].results['tc-1'].status).toBe('completed');
    });

    it('handles experiments with no runs', async () => {
      const expWithNoRuns = { ...createMockStorageExperiment(), runs: undefined };
      mockOsExperiments.getAll.mockResolvedValue([expWithNoRuns]);

      const result = await asyncBenchmarkStorage.getAll();

      expect(result[0].runs).toEqual([]);
    });
  });

  describe('getById', () => {
    it('returns experiment when found', async () => {
      mockOsExperiments.getById.mockResolvedValue(createMockStorageExperiment());

      const result = await asyncBenchmarkStorage.getById('exp-1');

      expect(mockOsExperiments.getById).toHaveBeenCalledWith('exp-1', undefined);
      expect(result).not.toBeNull();
      expect(result?.id).toBe('exp-1');
      expect(result?.name).toBe('Test Benchmark');
    });

    it('returns null when not found', async () => {
      mockOsExperiments.getById.mockResolvedValue(null);

      const result = await asyncBenchmarkStorage.getById('non-existent');

      expect(result).toBeNull();
    });

    it('converts run results with proper status typing', async () => {
      mockOsExperiments.getById.mockResolvedValue(createMockStorageExperiment());

      const result = await asyncBenchmarkStorage.getById('exp-1');

      expect(result?.runs[0].results['tc-1'].status).toBe('completed');
      expect(result?.runs[0].results['tc-2'].status).toBe('pending');
    });
  });

  describe('create', () => {
    it('creates a new experiment', async () => {
      const createdExp = createMockStorageExperiment('new-exp');
      mockOsExperiments.create.mockResolvedValue(createdExp);

      const result = await asyncBenchmarkStorage.create({
        name: 'Test Benchmark',
        description: 'Test description',
        testCaseIds: ['tc-1', 'tc-2'],
      });

      expect(mockOsExperiments.create).toHaveBeenCalledTimes(1);
      expect(result.id).toBe('new-exp');
    });

    it('converts runs to storage format during create', async () => {
      const createdExp = createMockStorageExperiment('new-exp');
      mockOsExperiments.create.mockResolvedValue(createdExp);

      await asyncBenchmarkStorage.create({
        name: 'Test',
        description: 'Test',
        testCaseIds: [],
        runs: [createMockBenchmarkRun()],
      });

      // Storage format now uses agentKey consistently (not agentId)
      expect(mockOsExperiments.create).toHaveBeenCalledWith(
        expect.objectContaining({
          runs: expect.arrayContaining([
            expect.objectContaining({
              agentKey: 'agent-1',
            }),
          ]),
        })
      );
    });
  });

  describe('save', () => {
    it('returns existing experiment if already exists', async () => {
      const existingExp = createMockStorageExperiment('exp-1');
      mockOsExperiments.getById.mockResolvedValue(existingExp);
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

      const experiment: Benchmark = {
        id: 'exp-1',
        name: 'Updated Name',
        description: 'Updated',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        testCaseIds: [],
        runs: [],
      };

      const result = await asyncBenchmarkStorage.save(experiment);

      expect(mockOsExperiments.create).not.toHaveBeenCalled();
      expect(result.id).toBe('exp-1');
      expect(consoleSpy).toHaveBeenCalledWith(
        'Benchmark already exists and cannot be updated:',
        'exp-1'
      );
      consoleSpy.mockRestore();
    });

    it('creates new experiment if not exists', async () => {
      mockOsExperiments.getById.mockResolvedValue(null);
      const createdExp = createMockStorageExperiment('new-exp');
      mockOsExperiments.create.mockResolvedValue(createdExp);

      const experiment: Benchmark = {
        id: 'new-exp',
        name: 'New Benchmark',
        description: 'New',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        testCaseIds: [],
        runs: [],
      };

      const result = await asyncBenchmarkStorage.save(experiment);

      expect(mockOsExperiments.create).toHaveBeenCalled();
      expect(result.id).toBe('new-exp');
    });
  });

  describe('delete', () => {
    it('returns true when deletion succeeds', async () => {
      mockOsExperiments.delete.mockResolvedValue({ deleted: true });

      const result = await asyncBenchmarkStorage.delete('exp-1');

      expect(mockOsExperiments.delete).toHaveBeenCalledWith('exp-1');
      expect(result).toBe(true);
    });

    it('returns false when deletion fails', async () => {
      mockOsExperiments.delete.mockResolvedValue({ deleted: false });

      const result = await asyncBenchmarkStorage.delete('non-existent');

      expect(result).toBe(false);
    });
  });

  describe('getCount', () => {
    it('returns the count of experiments', async () => {
      mockOsExperiments.getAll.mockResolvedValue([
        createMockStorageExperiment('exp-1'),
        createMockStorageExperiment('exp-2'),
        createMockStorageExperiment('exp-3'),
      ]);

      const result = await asyncBenchmarkStorage.getCount();

      expect(result).toBe(3);
    });

    it('returns 0 when no experiments exist', async () => {
      mockOsExperiments.getAll.mockResolvedValue([]);

      const result = await asyncBenchmarkStorage.getCount();

      expect(result).toBe(0);
    });
  });

  describe('getRuns', () => {
    it('returns runs for an experiment', async () => {
      mockOsExperiments.getById.mockResolvedValue(createMockStorageExperiment());

      const result = await asyncBenchmarkStorage.getRuns('exp-1');

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('run-1');
    });

    it('returns empty array when experiment not found', async () => {
      mockOsExperiments.getById.mockResolvedValue(null);

      const result = await asyncBenchmarkStorage.getRuns('non-existent');

      expect(result).toEqual([]);
    });

    it('returns empty array when experiment has no runs', async () => {
      const expWithNoRuns = { ...createMockStorageExperiment(), runs: undefined };
      mockOsExperiments.getById.mockResolvedValue(expWithNoRuns);

      const result = await asyncBenchmarkStorage.getRuns('exp-1');

      expect(result).toEqual([]);
    });
  });

  describe('getRunById', () => {
    it('returns run when found', async () => {
      mockOsExperiments.getById.mockResolvedValue(createMockStorageExperiment());

      const result = await asyncBenchmarkStorage.getRunById('exp-1', 'run-1');

      expect(result).not.toBeNull();
      expect(result?.id).toBe('run-1');
    });

    it('returns null when experiment not found', async () => {
      mockOsExperiments.getById.mockResolvedValue(null);

      const result = await asyncBenchmarkStorage.getRunById('non-existent', 'run-1');

      expect(result).toBeNull();
    });

    it('returns null when run not found', async () => {
      mockOsExperiments.getById.mockResolvedValue(createMockStorageExperiment());

      const result = await asyncBenchmarkStorage.getRunById('exp-1', 'non-existent-run');

      expect(result).toBeNull();
    });
  });

  describe('addRun', () => {
    it('adds a new run to experiment', async () => {
      const exp = createMockStorageExperiment();
      mockOsExperiments.getById.mockResolvedValue(exp);
      mockOsExperiments.update.mockResolvedValue(undefined);
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      const newRun = createMockBenchmarkRun('run-2');
      const result = await asyncBenchmarkStorage.addRun('exp-1', newRun);

      expect(result).toBe(true);
      expect(mockOsExperiments.update).toHaveBeenCalledWith(
        'exp-1',
        expect.objectContaining({
          runs: expect.arrayContaining([
            expect.objectContaining({ id: 'run-1' }),
            expect.objectContaining({ id: 'run-2' }),
          ]),
        })
      );
      consoleSpy.mockRestore();
    });

    it('updates existing run', async () => {
      const exp = createMockStorageExperiment();
      mockOsExperiments.getById.mockResolvedValue(exp);
      mockOsExperiments.update.mockResolvedValue(undefined);
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      const updatedRun = { ...createMockBenchmarkRun('run-1'), name: 'Updated Run Name' };
      const result = await asyncBenchmarkStorage.addRun('exp-1', updatedRun);

      expect(result).toBe(true);
      expect(mockOsExperiments.update).toHaveBeenCalledWith(
        'exp-1',
        expect.objectContaining({
          runs: expect.arrayContaining([
            expect.objectContaining({ id: 'run-1', name: 'Updated Run Name' }),
          ]),
        })
      );
      consoleSpy.mockRestore();
    });

    it('returns false when experiment not found', async () => {
      mockOsExperiments.getById.mockResolvedValue(null);
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

      const result = await asyncBenchmarkStorage.addRun('non-existent', createMockBenchmarkRun());

      expect(result).toBe(false);
      expect(mockOsExperiments.update).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    });

    it('handles experiment with no existing runs', async () => {
      const expWithNoRuns = { ...createMockStorageExperiment(), runs: undefined };
      mockOsExperiments.getById.mockResolvedValue(expWithNoRuns);
      mockOsExperiments.update.mockResolvedValue(undefined);
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      const newRun = createMockBenchmarkRun('run-1');
      const result = await asyncBenchmarkStorage.addRun('exp-1', newRun);

      expect(result).toBe(true);
      expect(mockOsExperiments.update).toHaveBeenCalledWith(
        'exp-1',
        expect.objectContaining({
          runs: expect.arrayContaining([expect.objectContaining({ id: 'run-1' })]),
        })
      );
      consoleSpy.mockRestore();
    });
  });

  describe('deleteRun', () => {
    // deleteRun uses fetch to call the API endpoint for atomic server-side deletion
    let mockFetch: jest.SpyInstance;

    beforeEach(() => {
      mockFetch = jest.spyOn(global, 'fetch');
    });

    afterEach(() => {
      mockFetch.mockRestore();
    });

    it('deletes a run from experiment via API', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
      });

      const result = await asyncBenchmarkStorage.deleteRun('exp-1', 'run-1');

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/storage/benchmarks/exp-1/runs/run-1',
        { method: 'DELETE' }
      );
    });

    it('returns false when API returns 404', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
      });

      const result = await asyncBenchmarkStorage.deleteRun('non-existent', 'run-1');

      expect(result).toBe(false);
    });

    it('returns false when API returns error', async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        json: jest.fn().mockResolvedValue({ error: 'Internal server error' }),
      });

      const result = await asyncBenchmarkStorage.deleteRun('exp-1', 'run-1');

      expect(result).toBe(false);
      consoleSpy.mockRestore();
    });

    it('returns false when fetch throws an error', async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      mockFetch.mockRejectedValue(new Error('Network error'));

      const result = await asyncBenchmarkStorage.deleteRun('exp-1', 'run-1');

      expect(result).toBe(false);
      consoleSpy.mockRestore();
    });
  });

  describe('generateBenchmarkId', () => {
    it('generates unique benchmark IDs', () => {
      const id1 = asyncBenchmarkStorage.generateBenchmarkId();
      const id2 = asyncBenchmarkStorage.generateBenchmarkId();

      expect(id1).toMatch(/^bench-\d+-[a-z0-9]+$/);
      expect(id2).toMatch(/^bench-\d+-[a-z0-9]+$/);
      expect(id1).not.toBe(id2);
    });
  });

  describe('generateRunId', () => {
    it('generates unique run IDs', () => {
      const id1 = asyncBenchmarkStorage.generateRunId();
      const id2 = asyncBenchmarkStorage.generateRunId();

      expect(id1).toMatch(/^run-\d+-[a-z0-9]+$/);
      expect(id2).toMatch(/^run-\d+-[a-z0-9]+$/);
      expect(id1).not.toBe(id2);
    });
  });

  describe('bulkCreate', () => {
    it('bulk creates experiments', async () => {
      mockOsExperiments.bulkCreate.mockResolvedValue({ created: 3, errors: false });

      const experiments: Benchmark[] = [
        {
          id: 'exp-1',
          name: 'Exp 1',
          description: 'Desc 1',
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
          testCaseIds: [],
          runs: [],
        },
        {
          id: 'exp-2',
          name: 'Exp 2',
          description: 'Desc 2',
          createdAt: '2024-01-02T00:00:00Z',
          updatedAt: '2024-01-02T00:00:00Z',
          testCaseIds: ['tc-1'],
          runs: [createMockBenchmarkRun()],
        },
      ];

      const result = await asyncBenchmarkStorage.bulkCreate(experiments);

      expect(mockOsExperiments.bulkCreate).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ created: 3, errors: false });
    });
  });

  describe('format conversion - toBenchmarkRun', () => {
    it('handles run with empty results', async () => {
      const expWithEmptyResults = {
        ...createMockStorageExperiment(),
        runs: [
          {
            id: 'run-1',
            name: 'Run 1',
            description: 'Run with no results',
            agentId: 'agent-1',
            modelId: 'model-1',
            headers: {},
            createdAt: '2024-01-01T00:00:00Z',
            results: undefined,
          },
        ],
      };
      mockOsExperiments.getById.mockResolvedValue(expWithEmptyResults);

      const result = await asyncBenchmarkStorage.getById('exp-1');

      expect(result?.runs[0].results).toEqual({});
    });
  });
});
