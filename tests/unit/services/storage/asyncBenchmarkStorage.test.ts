/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// @ts-nocheck - Test file uses simplified mock objects
import { asyncBenchmarkStorage } from '@/services/storage/asyncBenchmarkStorage';
import { benchmarkStorage as opensearchExperiments } from '@/services/storage/opensearchClient';
import { ENV_CONFIG } from '@/lib/config';
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

    it('carries a run\'s concurrency through the storage mapper (regression: toBenchmarkRun is an allow-list mapper that silently dropped it)', async () => {
      const withConcurrency = createMockStorageExperiment();
      (withConcurrency.runs[0] as any).concurrency = 3;
      mockOsExperiments.getById.mockResolvedValueOnce(withConcurrency);

      const result = await asyncBenchmarkStorage.getById('exp-1');
      expect(result?.runs[0].concurrency).toBe(3);

      // A legacy run with no concurrency field at all stays undefined --
      // never coerced to 0/null, which the UI would render as a real value
      // instead of the "—" legacy fallback.
      mockOsExperiments.getById.mockResolvedValueOnce(createMockStorageExperiment());
      const legacyResult = await asyncBenchmarkStorage.getById('exp-1');
      expect(legacyResult?.runs[0].concurrency).toBeUndefined();
    });

    it('normalizes a schemaless stored `null` concurrency to `undefined` (codex_review finding: render sites only check `=== undefined`)', async () => {
      const withNullConcurrency = createMockStorageExperiment();
      (withNullConcurrency.runs[0] as any).concurrency = null;
      mockOsExperiments.getById.mockResolvedValueOnce(withNullConcurrency);

      const result = await asyncBenchmarkStorage.getById('exp-1');
      expect(result?.runs[0].concurrency).toBeUndefined();
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

    it('preserves judgeModelId/evaluatorId when converting runs to storage format (regression: toStorageFormat used to silently drop both)', async () => {
      const createdExp = createMockStorageExperiment('new-exp');
      mockOsExperiments.create.mockResolvedValue(createdExp);

      await asyncBenchmarkStorage.create({
        name: 'Test',
        description: 'Test',
        testCaseIds: [],
        runs: [{ ...createMockBenchmarkRun(), judgeModelId: 'us.anthropic.claude-sonnet-4-6', evaluatorId: 'example-evaluator-persona' }],
      });

      expect(mockOsExperiments.create).toHaveBeenCalledWith(
        expect.objectContaining({
          runs: expect.arrayContaining([
            expect.objectContaining({
              judgeModelId: 'us.anthropic.claude-sonnet-4-6',
              evaluatorId: 'example-evaluator-persona',
            }),
          ]),
        })
      );
    });

    it('preserves concurrency when converting runs to storage format (regression: toStorageFormat is an allow-list mapper)', async () => {
      const createdExp = createMockStorageExperiment('new-exp');
      mockOsExperiments.create.mockResolvedValue(createdExp);

      await asyncBenchmarkStorage.create({
        name: 'Test',
        description: 'Test',
        testCaseIds: [],
        runs: [{ ...createMockBenchmarkRun(), concurrency: 5 }],
      });

      expect(mockOsExperiments.create).toHaveBeenCalledWith(
        expect.objectContaining({
          runs: expect.arrayContaining([
            expect.objectContaining({ concurrency: 5 }),
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

    it('preserves judgeModelId/evaluatorId when adding a run (regression: this inline storage mapper had its own separate whitelist that dropped both)', async () => {
      const exp = createMockStorageExperiment();
      mockOsExperiments.getById.mockResolvedValue(exp);
      mockOsExperiments.update.mockResolvedValue(undefined);
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      const newRun = { ...createMockBenchmarkRun('run-2'), judgeModelId: 'us.anthropic.claude-sonnet-4-6', evaluatorId: 'example-evaluator-persona' };
      const result = await asyncBenchmarkStorage.addRun('exp-1', newRun);

      expect(result).toBe(true);
      expect(mockOsExperiments.update).toHaveBeenCalledWith(
        'exp-1',
        expect.objectContaining({
          runs: expect.arrayContaining([
            expect.objectContaining({ id: 'run-2', judgeModelId: 'us.anthropic.claude-sonnet-4-6', evaluatorId: 'example-evaluator-persona' }),
          ]),
        })
      );
      consoleSpy.mockRestore();
    });

    it('preserves concurrency when adding a run (regression: this inline storage mapper had its own separate whitelist too)', async () => {
      const exp = createMockStorageExperiment();
      mockOsExperiments.getById.mockResolvedValue(exp);
      mockOsExperiments.update.mockResolvedValue(undefined);
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      const newRun = { ...createMockBenchmarkRun('run-2'), concurrency: 4 };
      const result = await asyncBenchmarkStorage.addRun('exp-1', newRun);

      expect(result).toBe(true);
      expect(mockOsExperiments.update).toHaveBeenCalledWith(
        'exp-1',
        expect.objectContaining({
          runs: expect.arrayContaining([
            expect.objectContaining({ id: 'run-2', concurrency: 4 }),
          ]),
        })
      );
      consoleSpy.mockRestore();
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
      // Must be an ABSOLUTE URL built from ENV_CONFIG.storageApiUrl: a bare
      // relative fetch('/api/storage/…') works in a browser but throws
      // ERR_INVALID_URL in Node (jest/CLI/SDK), which made deleteRun return
      // false unconditionally outside the browser. In Node the base resolves
      // to http://localhost:<AH_PORT>/api/storage; in a browser bundle it
      // stays the relative '/api/storage' — same path, working both places.
      expect(mockFetch).toHaveBeenCalledWith(
        `${ENV_CONFIG.storageApiUrl}/benchmarks/exp-1/runs/run-1`,
        { method: 'DELETE' }
      );
      expect(ENV_CONFIG.storageApiUrl).toMatch(/^http/); // node context → absolute
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

    it('preserves error field in results when present in storage', async () => {
      const expWithErrorResults = {
        ...createMockStorageExperiment(),
        runs: [
          {
            id: 'run-1',
            name: 'Run 1',
            description: 'Run with error results',
            agentId: 'agent-1',
            modelId: 'model-1',
            headers: {},
            createdAt: '2024-01-01T00:00:00Z',
            results: {
              'tc-1': { reportId: 'report-1', status: 'failed', error: 'Agent timed out after 30s' },
              'tc-2': { reportId: 'report-2', status: 'completed' },
            },
          },
        ],
      };
      mockOsExperiments.getById.mockResolvedValue(expWithErrorResults);

      const result = await asyncBenchmarkStorage.getById('exp-1');

      expect(result?.runs[0].results['tc-1'].error).toBe('Agent timed out after 30s');
      expect(result?.runs[0].results['tc-2'].error).toBeUndefined();
    });

    it('does not add error key to results when error is absent in storage', async () => {
      const expWithNoErrors = {
        ...createMockStorageExperiment(),
        runs: [
          {
            id: 'run-1',
            name: 'Run 1',
            description: 'Run with clean results',
            agentId: 'agent-1',
            modelId: 'model-1',
            headers: {},
            createdAt: '2024-01-01T00:00:00Z',
            results: {
              'tc-1': { reportId: 'report-1', status: 'completed' },
              'tc-2': { reportId: 'report-2', status: 'pending' },
            },
          },
        ],
      };
      mockOsExperiments.getById.mockResolvedValue(expWithNoErrors);

      const result = await asyncBenchmarkStorage.getById('exp-1');

      // Verify no error key exists on any result (no undefined pollution)
      expect(result?.runs[0].results['tc-1']).not.toHaveProperty('error');
      expect(result?.runs[0].results['tc-2']).not.toHaveProperty('error');
    });

    it('preserves error field on the run itself when present', async () => {
      const expWithRunError = {
        ...createMockStorageExperiment(),
        runs: [
          {
            id: 'run-1',
            name: 'Run 1',
            description: 'Failed run',
            agentId: 'agent-1',
            modelId: 'model-1',
            headers: {},
            createdAt: '2024-01-01T00:00:00Z',
            status: 'failed',
            error: 'Benchmark execution aborted: too many failures',
            results: {
              'tc-1': { reportId: 'report-1', status: 'failed', error: 'Connection refused' },
            },
          },
        ],
      };
      mockOsExperiments.getById.mockResolvedValue(expWithRunError);

      const result = await asyncBenchmarkStorage.getById('exp-1');

      expect(result?.runs[0].error).toBe('Benchmark execution aborted: too many failures');
      expect(result?.runs[0].status).toBe('failed');
    });

    it('sets run error to undefined when not present in storage', async () => {
      const expWithNoRunError = {
        ...createMockStorageExperiment(),
        runs: [
          {
            id: 'run-1',
            name: 'Run 1',
            description: 'Successful run',
            agentId: 'agent-1',
            modelId: 'model-1',
            headers: {},
            createdAt: '2024-01-01T00:00:00Z',
            status: 'completed',
            results: {
              'tc-1': { reportId: 'report-1', status: 'completed' },
            },
          },
        ],
      };
      mockOsExperiments.getById.mockResolvedValue(expWithNoRunError);

      const result = await asyncBenchmarkStorage.getById('exp-1');

      expect(result?.runs[0].error).toBeUndefined();
      expect(result?.runs[0].status).toBe('completed');
    });

    it('round-trips all fields including error through toBenchmarkRun', async () => {
      const storedRun = {
        id: 'run-full',
        name: 'Full Run',
        description: 'Complete run with all fields',
        agentKey: 'my-agent',
        modelId: 'claude-sonnet',
        headers: { Authorization: 'Bearer token' },
        createdAt: '2024-06-15T12:00:00Z',
        status: 'failed',
        error: 'Run-level error message',
        benchmarkVersion: 3,
        testCaseSnapshots: [{ id: 'tc-1', version: 2 }],
        stats: { passed: 1, failed: 2, pending: 0, total: 3 },
        results: {
          'tc-1': { reportId: 'report-1', status: 'completed' },
          'tc-2': { reportId: 'report-2', status: 'failed', error: 'Evaluation error: judge unavailable' },
          'tc-3': { reportId: 'report-3', status: 'failed', error: 'Agent returned empty response' },
        },
      };
      const expWithFullRun = {
        ...createMockStorageExperiment(),
        runs: [storedRun],
      };
      mockOsExperiments.getById.mockResolvedValue(expWithFullRun);

      const result = await asyncBenchmarkStorage.getById('exp-1');
      const run = result?.runs[0];

      // Verify all top-level fields
      expect(run?.id).toBe('run-full');
      expect(run?.name).toBe('Full Run');
      expect(run?.description).toBe('Complete run with all fields');
      expect(run?.agentKey).toBe('my-agent');
      expect(run?.modelId).toBe('claude-sonnet');
      expect(run?.headers).toEqual({ Authorization: 'Bearer token' });
      expect(run?.createdAt).toBe('2024-06-15T12:00:00Z');
      expect(run?.status).toBe('failed');
      expect(run?.error).toBe('Run-level error message');
      expect(run?.benchmarkVersion).toBe(3);
      expect(run?.testCaseSnapshots).toEqual([{ id: 'tc-1', version: 2 }]);
      expect(run?.stats).toEqual({ passed: 1, failed: 2, pending: 0, total: 3 });

      // Verify results with mixed error states
      expect(run?.results['tc-1']).toEqual({ reportId: 'report-1', status: 'completed' });
      expect(run?.results['tc-1']).not.toHaveProperty('error');
      expect(run?.results['tc-2']).toEqual({
        reportId: 'report-2',
        status: 'failed',
        error: 'Evaluation error: judge unavailable',
      });
      expect(run?.results['tc-3']).toEqual({
        reportId: 'report-3',
        status: 'failed',
        error: 'Agent returned empty response',
      });
    });

    it('round-trips judgeModelId and evaluatorId through toBenchmarkRun (regression: these were silently dropped, so the Evaluation Runs page Judge/Evaluator columns showed — for populated benchmark-embedded runs)', async () => {
      const storedRun = {
        id: 'run-with-judge',
        name: 'Run With Judge',
        agentKey: 'my-agent',
        modelId: 'claude-sonnet',
        createdAt: '2024-06-15T12:00:00Z',
        judgeModelId: 'us.anthropic.claude-sonnet-4-6',
        evaluatorId: 'example-evaluator-persona',
        results: {},
      };
      const expWithJudgeRun = {
        ...createMockStorageExperiment(),
        runs: [storedRun],
      };
      mockOsExperiments.getById.mockResolvedValue(expWithJudgeRun);

      const result = await asyncBenchmarkStorage.getById('exp-1');
      const run = result?.runs[0];

      expect(run?.judgeModelId).toBe('us.anthropic.claude-sonnet-4-6');
      expect(run?.evaluatorId).toBe('example-evaluator-persona');
    });

    it('leaves judgeModelId/evaluatorId undefined for legacy runs that predate these fields', async () => {
      const legacyRun = {
        id: 'run-legacy',
        name: 'Legacy Run',
        agentId: 'agent-1',
        modelId: 'model-1',
        createdAt: '2024-01-01T00:00:00Z',
        results: {},
      };
      const expWithLegacyRun = {
        ...createMockStorageExperiment(),
        runs: [legacyRun],
      };
      mockOsExperiments.getById.mockResolvedValue(expWithLegacyRun);

      const result = await asyncBenchmarkStorage.getById('exp-1');
      const run = result?.runs[0];

      expect(run?.judgeModelId).toBeUndefined();
      expect(run?.evaluatorId).toBeUndefined();
    });

    it('does not spread empty string error into results', async () => {
      const expWithEmptyError = {
        ...createMockStorageExperiment(),
        runs: [
          {
            id: 'run-1',
            name: 'Run 1',
            description: 'Run with empty error string',
            agentId: 'agent-1',
            modelId: 'model-1',
            headers: {},
            createdAt: '2024-01-01T00:00:00Z',
            results: {
              'tc-1': { reportId: 'report-1', status: 'failed', error: '' },
            },
          },
        ],
      };
      mockOsExperiments.getById.mockResolvedValue(expWithEmptyError);

      const result = await asyncBenchmarkStorage.getById('exp-1');

      // Empty string is falsy, so the conditional spread should not include it
      expect(result?.runs[0].results['tc-1']).not.toHaveProperty('error');
    });
  });
});
