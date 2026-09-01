/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { jest } from '@jest/globals';

// Mock STORAGE_INDEXES before importing the module
jest.mock('@/server/middleware/dataSourceConfig', () => ({
  STORAGE_INDEXES: {
    testCases: 'evals_test_cases',
    benchmarks: 'evals_experiments',
    runs: 'evals_runs',
    analytics: 'evals_analytics',
  },
}));

// Mock migration lock — default: no migration in progress
const mockAssertNotMigrating = jest.fn();
jest.mock('@/server/services/migrationLock', () => ({
  assertNotMigrating: (...args: any[]) => mockAssertNotMigrating(...args),
  MigrationInProgressError: class MigrationInProgressError extends Error {
    constructor(message: string) { super(message); this.name = 'MigrationInProgressError'; }
  },
}));

// ============================================================================
// Mock Client Factory
// ============================================================================

function createMockClient() {
  return {
    search: jest.fn(),
    get: jest.fn(),
    index: jest.fn(),
    delete: jest.fn(),
    deleteByQuery: jest.fn(),
    update: jest.fn(),
    cluster: {
      health: jest.fn(),
    },
    cat: {
      indices: jest.fn(),
    },
  };
}

// Helper to build search response
function makeSearchResponse(hits: any[], total?: number) {
  return {
    body: {
      hits: {
        total: { value: total ?? hits.length, relation: 'eq' },
        hits: hits.map(h => ({ _source: h })),
      },
    },
  };
}

// Helper to build get response
function makeGetResponse(source: any, found = true) {
  return {
    body: {
      found,
      _source: found ? source : undefined,
    },
  };
}

// Helper to build 404 error
function make404Error() {
  const err = new Error('Not Found') as any;
  err.meta = { statusCode: 404 };
  return err;
}

// Helper to build index_not_found_exception error (different from a doc-level 404)
function makeIndexNotFoundError() {
  const err = new Error('index_not_found_exception') as any;
  err.meta = {
    statusCode: 404,
    body: { error: { type: 'index_not_found_exception', reason: 'no such index [evals_test_cases]' } },
  };
  return err;
}

describe('OpenSearchStorageModule', () => {
  let mockClient: ReturnType<typeof createMockClient>;
  let mod: any; // OpenSearchStorageModule instance

  beforeEach(async () => {
    jest.clearAllMocks();
    // clearAllMocks() resets call history but NOT a mockImplementation set by
    // an earlier test (e.g. the migration-lock-error test below) — reset it
    // explicitly so it doesn't leak its throwing behavior into later tests.
    mockAssertNotMigrating.mockReset();
    mockClient = createMockClient();

    // Dynamic import to get the class after mocks are set up
    const { OpenSearchStorageModule } = await import(
      '@/server/adapters/opensearch/StorageModule'
    );
    const mockSessionMetadata = { get: jest.fn(), put: jest.fn(), list: jest.fn() };
    mod = new OpenSearchStorageModule(mockClient as any, mockSessionMetadata as any);
  });

  // ==========================================================================
  // Module-level tests
  // ==========================================================================

  describe('constructor', () => {
    it('should create all four operation objects', () => {
      expect(mod.testCases).toBeDefined();
      expect(mod.benchmarks).toBeDefined();
      expect(mod.runs).toBeDefined();
      expect(mod.analytics).toBeDefined();
    });
  });

  describe('isConfigured', () => {
    it('should always return true', () => {
      expect(mod.isConfigured()).toBe(true);
    });
  });

  describe('health', () => {
    it('should return ok status with cluster info on success', async () => {
      mockClient.cluster.health.mockResolvedValue({
        body: {
          cluster_name: 'test-cluster',
          status: 'green',
        },
      });

      const result = await mod.health();

      expect(result).toEqual({
        status: 'ok',
        cluster: {
          name: 'test-cluster',
          status: 'green',
        },
      });
    });

    it('should return error status when cluster health fails', async () => {
      mockClient.cluster.health.mockRejectedValue(new Error('Connection refused'));

      const result = await mod.health();

      expect(result).toEqual({
        status: 'error',
        error: 'Connection refused',
      });
    });

    it('appends the HTTP status code (e.g. 403 for expired/rotated SigV4 credentials) so it is distinguishable from a cluster 5xx', async () => {
      const authError: any = new Error('Response Error');
      authError.meta = { statusCode: 403, body: {} };
      mockClient.cluster.health.mockRejectedValue(authError);

      const result = await mod.health();

      expect(result).toEqual({
        status: 'error',
        error: 'Response Error (HTTP 403)',
      });
    });

    it('falls back to "Unknown error" instead of an empty string when the error has neither a message nor a status code', async () => {
      mockClient.cluster.health.mockRejectedValue({});

      const result = await mod.health();

      expect(result).toEqual({
        status: 'error',
        error: 'Unknown error',
      });
    });
  });

  // ==========================================================================
  // Test Case Operations
  // ==========================================================================

  describe('testCases', () => {
    describe('getAll', () => {
      it('should return deduplicated test cases (latest version)', async () => {
        const hits = [
          { id: 'tc-1', name: 'TC 1', version: 2, currentVersion: 2, createdAt: '2025-01-02T00:00:00Z' },
          { id: 'tc-1', name: 'TC 1 old', version: 1, currentVersion: 1, createdAt: '2025-01-01T00:00:00Z' },
          { id: 'tc-2', name: 'TC 2', version: 1, currentVersion: 1, createdAt: '2025-01-03T00:00:00Z' },
        ];
        mockClient.search.mockResolvedValue(makeSearchResponse(hits, 3));

        const result = await mod.testCases.getAll();

        expect(result.items).toHaveLength(2);
        expect(result.items[0].id).toBe('tc-2'); // newest createdAt first
        expect(result.items[1].id).toBe('tc-1');
        expect(result.items[1].version).toBe(2); // latest version kept
      });

      it('should respect pagination options', async () => {
        mockClient.search.mockResolvedValue(makeSearchResponse([]));

        await mod.testCases.getAll({ size: 50, from: 10 });

        expect(mockClient.search).toHaveBeenCalledWith(
          expect.objectContaining({
            body: expect.objectContaining({ size: 50, from: 10 }),
          })
        );
      });

      it('should handle numeric total format', async () => {
        mockClient.search.mockResolvedValue({
          body: {
            hits: {
              total: 5,
              hits: [],
            },
          },
        });

        const result = await mod.testCases.getAll();

        expect(result.items).toHaveLength(0);
      });

      it('should return empty results on index_not_found', async () => {
        mockClient.search.mockRejectedValue(makeIndexNotFoundError());

        const result = await mod.testCases.getAll();

        expect(result).toEqual({ items: [], total: 0 });
      });

      it('should throw non-index-not-found errors', async () => {
        mockClient.search.mockRejectedValue(new Error('Cluster down'));

        await expect(mod.testCases.getAll()).rejects.toThrow('Cluster down');
      });
    });

    describe('getById', () => {
      it('should return the latest version of a test case', async () => {
        const tc = { id: 'tc-1', name: 'Test Case 1', version: 3 };
        mockClient.search.mockResolvedValue(makeSearchResponse([tc], 1));

        const result = await mod.testCases.getById('tc-1');

        expect(result).toEqual(tc);
        expect(mockClient.search).toHaveBeenCalledWith(
          expect.objectContaining({
            index: 'evals_test_cases',
            body: expect.objectContaining({
              size: 1,
              sort: [{ version: { order: 'desc' } }],
              query: { term: { id: 'tc-1' } },
            }),
          })
        );
      });

      it('should return null when no hits', async () => {
        mockClient.search.mockResolvedValue(makeSearchResponse([]));

        const result = await mod.testCases.getById('nonexistent');

        expect(result).toBeNull();
      });

      it('should return null on 404 error', async () => {
        mockClient.search.mockRejectedValue(make404Error());

        const result = await mod.testCases.getById('missing');

        expect(result).toBeNull();
      });

      it('should throw non-404 errors', async () => {
        mockClient.search.mockRejectedValue(new Error('Cluster down'));

        await expect(mod.testCases.getById('tc-1')).rejects.toThrow('Cluster down');
      });
    });

    describe('getVersions', () => {
      it('should return all versions sorted desc', async () => {
        const versions = [
          { id: 'tc-1', version: 3 },
          { id: 'tc-1', version: 2 },
          { id: 'tc-1', version: 1 },
        ];
        mockClient.search.mockResolvedValue(makeSearchResponse(versions, 3));

        const result = await mod.testCases.getVersions('tc-1');

        expect(result).toHaveLength(3);
        expect(mockClient.search).toHaveBeenCalledWith(
          expect.objectContaining({
            body: expect.objectContaining({
              size: 100,
              sort: [{ version: { order: 'desc' } }],
              query: { term: { id: 'tc-1' } },
            }),
          })
        );
      });

      it('should return empty array on index_not_found', async () => {
        mockClient.search.mockRejectedValue(makeIndexNotFoundError());

        const result = await mod.testCases.getVersions('tc-1');

        expect(result).toEqual([]);
      });
    });

    describe('getVersion', () => {
      it('should return a specific version by doc ID', async () => {
        const tc = { id: 'tc-1', version: 2, name: 'V2' };
        mockClient.get.mockResolvedValue(makeGetResponse(tc));

        const result = await mod.testCases.getVersion('tc-1', 2);

        expect(result).toEqual(tc);
        expect(mockClient.get).toHaveBeenCalledWith({
          index: 'evals_test_cases',
          id: 'tc-1-v2',
        });
      });

      it('should return null when not found', async () => {
        mockClient.get.mockResolvedValue(makeGetResponse(null, false));

        const result = await mod.testCases.getVersion('tc-1', 99);

        expect(result).toBeNull();
      });

      it('should return null on 404 error', async () => {
        mockClient.get.mockRejectedValue(make404Error());

        const result = await mod.testCases.getVersion('tc-1', 99);

        expect(result).toBeNull();
      });

      it('should throw non-404 errors', async () => {
        mockClient.get.mockRejectedValue(new Error('Server error'));

        await expect(mod.testCases.getVersion('tc-1', 1)).rejects.toThrow('Server error');
      });
    });

    describe('create', () => {
      it('should create with generated ID and version 1', async () => {
        mockClient.index.mockResolvedValue({});

        const result = await mod.testCases.create({ name: 'New TC', initialPrompt: 'Test' });

        expect(result.id).toMatch(/^tc-/);
        expect(result.version).toBe(1);
        expect(result.currentVersion).toBe(1);
        expect(result.createdAt).toBeDefined();
        expect(result.updatedAt).toBeDefined();
        expect(mockClient.index).toHaveBeenCalledWith(
          expect.objectContaining({
            index: 'evals_test_cases',
            id: `${result.id}-v1`,
            refresh: 'wait_for',
          })
        );
      });

      it('should use provided ID', async () => {
        mockClient.index.mockResolvedValue({});

        const result = await mod.testCases.create({ id: 'my-tc', name: 'Custom' });

        expect(result.id).toBe('my-tc');
        expect(mockClient.index).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'my-tc-v1' })
        );
      });

      it('should throw when name is missing', async () => {
        await expect(mod.testCases.create({ initialPrompt: 'test' })).rejects.toThrow('Test case name is required');
      });

      it('rejects an invalid fixture before indexing', async () => {
        await expect(mod.testCases.create({
          name: 'Invalid fixture',
          fixture: { type: 'filesystem-workspace', ref: '', integrity: 'not-pinned' } as any,
        })).rejects.toThrow('Invalid test-case fixture');
        expect(mockClient.index).not.toHaveBeenCalled();
      });
    });

    describe('update', () => {
      it('should create new version with incremented version number', async () => {
        const existing = { id: 'tc-1', version: 2, currentVersion: 2, name: 'Old' };
        mockClient.search.mockResolvedValue(makeSearchResponse([existing], 1));
        mockClient.index.mockResolvedValue({});

        const result = await mod.testCases.update('tc-1', { name: 'Updated' });

        expect(result.version).toBe(3);
        expect(result.currentVersion).toBe(3);
        expect(result.name).toBe('Updated');
        expect(mockClient.index).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'tc-1-v3' })
        );
      });

      it('should throw when test case not found', async () => {
        mockClient.search.mockResolvedValue(makeSearchResponse([]));

        await expect(mod.testCases.update('tc-new', { name: 'New' })).rejects.toThrow('Test case tc-new not found');
      });

      it('rejects an invalid fixture before loading the existing version', async () => {
        await expect(mod.testCases.update('tc-1', {
          fixture: { type: '', ref: 'workspace', integrity: 'sha256:abc123' } as any,
        })).rejects.toThrow('Invalid test-case fixture');
        expect(mockClient.search).not.toHaveBeenCalled();
      });
    });

    describe('delete', () => {
      it('should delete all versions by query', async () => {
        mockClient.deleteByQuery.mockResolvedValue({
          body: { deleted: 3 },
        });

        const result = await mod.testCases.delete('tc-1');

        expect(result).toEqual({ deleted: 3 });
        expect(mockClient.deleteByQuery).toHaveBeenCalledWith({
          index: 'evals_test_cases',
          body: { query: { term: { id: 'tc-1' } } },
          refresh: true,
        });
      });

      it('should return 0 when nothing deleted', async () => {
        mockClient.deleteByQuery.mockResolvedValue({ body: {} });

        const result = await mod.testCases.delete('nonexistent');

        expect(result).toEqual({ deleted: 0 });
      });
    });

    describe('search', () => {
      it('should filter by labels', async () => {
        const all = [
          { id: 'tc-1', name: 'A', labels: ['category:RCA'], createdAt: '2025-01-01T00:00:00Z' },
          { id: 'tc-2', name: 'B', labels: ['category:Other'], createdAt: '2025-01-02T00:00:00Z' },
        ];
        mockClient.search.mockResolvedValue(makeSearchResponse(all, 2));

        const result = await mod.testCases.search({ labels: ['category:RCA'] });

        expect(result.items).toHaveLength(1);
        expect(result.items[0].id).toBe('tc-1');
      });

      it('should filter by textSearch', async () => {
        const all = [
          { id: 'tc-1', name: 'Payment Error', description: 'desc', initialPrompt: 'prompt', createdAt: '2025-01-01T00:00:00Z' },
          { id: 'tc-2', name: 'Auth Bug', description: 'desc', initialPrompt: 'prompt', createdAt: '2025-01-02T00:00:00Z' },
        ];
        mockClient.search.mockResolvedValue(makeSearchResponse(all, 2));

        const result = await mod.testCases.search({ textSearch: 'payment' });

        expect(result.items).toHaveLength(1);
        expect(result.items[0].id).toBe('tc-1');
      });

      it('should filter by category', async () => {
        const all = [
          { id: 'tc-1', name: 'A', category: 'RCA', createdAt: '2025-01-01T00:00:00Z' },
          { id: 'tc-2', name: 'B', category: 'Other', createdAt: '2025-01-02T00:00:00Z' },
        ];
        mockClient.search.mockResolvedValue(makeSearchResponse(all, 2));

        const result = await mod.testCases.search({ category: 'RCA' });

        expect(result.items).toHaveLength(1);
        expect(result.items[0].id).toBe('tc-1');
      });

      it('should apply pagination', async () => {
        const all = [
          { id: 'tc-1', name: 'A', createdAt: '2025-01-01T00:00:00Z' },
          { id: 'tc-2', name: 'B', createdAt: '2025-01-02T00:00:00Z' },
          { id: 'tc-3', name: 'C', createdAt: '2025-01-03T00:00:00Z' },
        ];
        mockClient.search.mockResolvedValue(makeSearchResponse(all, 3));

        const result = await mod.testCases.search({}, { from: 1, size: 1 });

        expect(result.items).toHaveLength(1);
        expect(result.total).toBe(3);
      });

      it('should return all when no filters match', async () => {
        mockClient.search.mockResolvedValue(makeSearchResponse([]));

        const result = await mod.testCases.search({});

        expect(result.items).toHaveLength(0);
        expect(result.total).toBe(0);
      });
    });

    describe('bulkCreate', () => {
      it('should create multiple test cases and track success/failure', async () => {
        mockClient.index
          .mockResolvedValueOnce({})
          .mockRejectedValueOnce(new Error('fail'));

        const result = await mod.testCases.bulkCreate([
          { name: 'TC1' },
          { name: 'TC2' },
        ]);

        expect(result).toEqual(expect.objectContaining({ created: 1, errors: 1 }));
      });

      it('should handle empty array', async () => {
        const result = await mod.testCases.bulkCreate([]);

        expect(result).toEqual(expect.objectContaining({ created: 0, errors: 0 }));
      });

      it('rejects an invalid fixture on the bulk-upsert path', async () => {
        mockClient.search.mockResolvedValue(makeSearchResponse([]));

        await expect(mod.testCases.bulkUpsert([{
          name: 'Invalid fixture',
          fixture: { type: 'filesystem-workspace', ref: 'workspace', integrity: 'not-pinned' } as any,
        }])).rejects.toThrow('Invalid test-case fixture');
        expect(mockClient.index).not.toHaveBeenCalled();
      });
    });
  });

  // ==========================================================================
  // Benchmark Operations
  // ==========================================================================

  describe('benchmarks', () => {
    describe('getAll', () => {
      it('should return benchmarks with default pagination', async () => {
        const benchmarks = [{ id: 'bench-1', name: 'B1', createdAt: '2025-01-01T00:00:00Z' }];
        mockClient.search.mockResolvedValue(makeSearchResponse(benchmarks, 1));

        const result = await mod.benchmarks.getAll();

        expect(result.items).toHaveLength(1);
        expect(result.total).toBe(1);
        expect(mockClient.search).toHaveBeenCalledWith(
          expect.objectContaining({
            index: 'evals_experiments',
            body: expect.objectContaining({ size: 1000, from: 0 }),
          })
        );
      });

      it('excludes evaluation-run AND benchmark-image discriminated docs from the shared index', async () => {
        mockClient.search.mockResolvedValue(makeSearchResponse([], 0));
        await mod.benchmarks.getAll();
        const mustNot = mockClient.search.mock.calls[0][0].body.query.bool.must_not;
        expect(mustNot).toHaveLength(2);
        expect(JSON.stringify(mustNot)).toContain('evaluation-run');
        expect(JSON.stringify(mustNot)).toContain('benchmark-image');
      });

      it('should return empty results on index_not_found', async () => {
        mockClient.search.mockRejectedValue(makeIndexNotFoundError());

        const result = await mod.benchmarks.getAll();

        expect(result).toEqual({ items: [], total: 0 });
      });

      it('should rethrow non-index-not-found search errors', async () => {
        mockClient.search.mockRejectedValue(new Error('cluster unreachable'));

        await expect(mod.benchmarks.getAll()).rejects.toThrow('cluster unreachable');
      });
    });

    describe('getById', () => {
      it('should return a benchmark by ID', async () => {
        const bench = { id: 'bench-1', name: 'B1' };
        mockClient.get.mockResolvedValue(makeGetResponse(bench));

        const result = await mod.benchmarks.getById('bench-1');

        expect(result).toEqual(bench);
        expect(mockClient.get).toHaveBeenCalledWith({
          index: 'evals_experiments',
          id: 'bench-1',
        });
      });

      it('should return null when not found', async () => {
        mockClient.get.mockResolvedValue(makeGetResponse(null, false));

        const result = await mod.benchmarks.getById('nonexistent');

        expect(result).toBeNull();
      });

      it('should return null on 404 error', async () => {
        mockClient.get.mockRejectedValue(make404Error());

        const result = await mod.benchmarks.getById('missing');

        expect(result).toBeNull();
      });

      it('should return null for an evaluation-run doc (eval-run rendered as empty benchmark)', async () => {
        const evalRun = { id: 'eval-run-1', name: 'CLI eval-run', docType: 'evaluation-run' };
        mockClient.get.mockResolvedValue(makeGetResponse(evalRun));

        const result = await mod.benchmarks.getById('eval-run-1');

        expect(result).toBeNull();
      });

      it('should return null for a benchmark-image doc (image id is NOT a benchmark)', async () => {
        const image = { id: 'img-digest-abc', digest: 'digest-abc', docType: 'benchmark-image' };
        mockClient.get.mockResolvedValue(makeGetResponse(image));

        const result = await mod.benchmarks.getById('img-digest-abc');

        expect(result).toBeNull();
      });

      it('should return the doc when docType is explicitly "benchmark"', async () => {
        const bench = { id: 'bench-1', name: 'B1', docType: 'benchmark' };
        mockClient.get.mockResolvedValue(makeGetResponse(bench));

        const result = await mod.benchmarks.getById('bench-1');

        expect(result).toEqual(bench);
      });

      it('should throw non-404 errors', async () => {
        mockClient.get.mockRejectedValue(new Error('Cluster down'));

        await expect(mod.benchmarks.getById('bench-1')).rejects.toThrow('Cluster down');
      });
    });

    describe('create', () => {
      it('should create a benchmark with generated id', async () => {
        mockClient.index.mockResolvedValue({});

        const result = await mod.benchmarks.create({ name: 'New Bench' });

        expect(result.id).toMatch(/^bench-/);
        expect(result.name).toBe('New Bench');
        expect(result.runs).toEqual([]);
        expect(result.createdAt).toBeDefined();
        expect(result.updatedAt).toBeDefined();
      });

      it('should use provided id and runs', async () => {
        mockClient.index.mockResolvedValue({});
        const runs = [{ id: 'run-1', name: 'Run 1' }] as any;

        const result = await mod.benchmarks.create({ id: 'my-bench', name: 'B', runs });

        expect(result.id).toBe('my-bench');
        expect(result.runs).toEqual(runs);
      });
    });

    describe('update', () => {
      it('should merge updates with existing benchmark', async () => {
        const existing = { id: 'bench-1', name: 'Old', runs: [], createdAt: '2025-01-01T00:00:00Z' };
        mockClient.get.mockResolvedValue(makeGetResponse(existing));
        mockClient.index.mockResolvedValue({});

        const result = await mod.benchmarks.update('bench-1', { name: 'Updated' });

        expect(result.name).toBe('Updated');
        expect(result.id).toBe('bench-1');
        expect(result.updatedAt).toBeDefined();
      });

      it('should throw when benchmark not found', async () => {
        mockClient.get.mockResolvedValue(makeGetResponse(null, false));

        await expect(
          mod.benchmarks.update('nonexistent', { name: 'X' })
        ).rejects.toThrow('Benchmark nonexistent not found');
      });
    });

    describe('delete', () => {
      it('should delete a benchmark and return deleted true', async () => {
        mockClient.delete.mockResolvedValue({});

        const result = await mod.benchmarks.delete('bench-1');

        expect(result).toEqual({ deleted: true });
      });

      it('should return deleted false on 404', async () => {
        mockClient.delete.mockRejectedValue(make404Error());

        const result = await mod.benchmarks.delete('missing');

        expect(result).toEqual({ deleted: false });
      });

      it('should throw non-404 errors', async () => {
        mockClient.delete.mockRejectedValue(new Error('Server error'));

        await expect(mod.benchmarks.delete('bench-1')).rejects.toThrow('Server error');
      });
    });

    describe('addRun', () => {
      it('should add a run using Painless script', async () => {
        mockClient.update.mockResolvedValue({});
        const run = { id: 'run-1', name: 'Run 1' } as any;

        const result = await mod.benchmarks.addRun('bench-1', run);

        expect(result).toBe(true);
        expect(mockClient.update).toHaveBeenCalledWith(
          expect.objectContaining({
            index: 'evals_experiments',
            id: 'bench-1',
            retry_on_conflict: 3,
            refresh: 'wait_for',
          })
        );
      });

      it('should return false on 404', async () => {
        mockClient.update.mockRejectedValue(make404Error());

        const result = await mod.benchmarks.addRun('missing', {} as any);

        expect(result).toBe(false);
      });

      it('should throw non-404 errors', async () => {
        mockClient.update.mockRejectedValue(new Error('Conflict'));

        await expect(mod.benchmarks.addRun('bench-1', {} as any)).rejects.toThrow('Conflict');
      });
    });

    describe('updateRun', () => {
      it('should update a specific run within a benchmark', async () => {
        mockClient.update.mockResolvedValue({});

        const result = await mod.benchmarks.updateRun('bench-1', 'run-1', { name: 'Updated' } as any);

        expect(result).toBe(true);
        expect(mockClient.update).toHaveBeenCalledWith(
          expect.objectContaining({
            body: expect.objectContaining({
              script: expect.objectContaining({
                params: expect.objectContaining({
                  runId: 'run-1',
                  updates: { name: 'Updated' },
                }),
              }),
            }),
          })
        );
      });

      it('should return false on 404', async () => {
        mockClient.update.mockRejectedValue(make404Error());

        const result = await mod.benchmarks.updateRun('missing', 'run-1', {} as any);

        expect(result).toBe(false);
      });
    });

    describe('deleteRun', () => {
      it('should delete a run from a benchmark', async () => {
        mockClient.update.mockResolvedValue({});

        const result = await mod.benchmarks.deleteRun('bench-1', 'run-1');

        expect(result).toBe(true);
        expect(mockClient.update).toHaveBeenCalledWith(
          expect.objectContaining({
            body: expect.objectContaining({
              script: expect.objectContaining({
                params: expect.objectContaining({ runId: 'run-1' }),
              }),
            }),
          })
        );
      });

      it('should return false on 404', async () => {
        mockClient.update.mockRejectedValue(make404Error());

        const result = await mod.benchmarks.deleteRun('missing', 'run-1');

        expect(result).toBe(false);
      });
    });

    describe('bulkCreate', () => {
      it('should track success and failure counts', async () => {
        mockClient.index
          .mockResolvedValueOnce({})
          .mockRejectedValueOnce(new Error('fail'));

        const result = await mod.benchmarks.bulkCreate([{ name: 'B1' }, { name: 'B2' }]);

        expect(result).toEqual({ created: 1, errors: 1 });
      });
    });
  });

  // ==========================================================================
  // Run (TestCaseRun) Operations
  // ==========================================================================

  describe('runs', () => {
    describe('getAll', () => {
      it('should return runs with default pagination', async () => {
        const runs = [{ id: 'report-1', testCaseId: 'tc-1', createdAt: '2025-01-01T00:00:00Z' }];
        mockClient.search.mockResolvedValue(makeSearchResponse(runs, 1));

        const result = await mod.runs.getAll();

        expect(result.items).toHaveLength(1);
        expect(result.total).toBe(1);
        expect(mockClient.search).toHaveBeenCalledWith(
          expect.objectContaining({
            index: 'evals_runs',
            body: expect.objectContaining({ size: 100, from: 0 }),
          })
        );
      });

      it('should return empty results on index_not_found', async () => {
        mockClient.search.mockRejectedValue(makeIndexNotFoundError());

        const result = await mod.runs.getAll();

        expect(result).toEqual({ items: [], total: 0 });
      });
    });

    describe('getById', () => {
      it('should return a run by id', async () => {
        const run = { id: 'report-1', testCaseId: 'tc-1' };
        mockClient.get.mockResolvedValue(makeGetResponse(run));

        const result = await mod.runs.getById('report-1');

        expect(result).toEqual(run);
      });

      it('should return null when not found', async () => {
        mockClient.get.mockResolvedValue(makeGetResponse(null, false));

        const result = await mod.runs.getById('missing');

        expect(result).toBeNull();
      });

      it('should return null on 404 error', async () => {
        mockClient.get.mockRejectedValue(make404Error());

        const result = await mod.runs.getById('missing');

        expect(result).toBeNull();
      });

      it('should throw non-404 errors', async () => {
        mockClient.get.mockRejectedValue(new Error('Timeout'));

        await expect(mod.runs.getById('report-1')).rejects.toThrow('Timeout');
      });
    });

    describe('create', () => {
      it('should create a run with generated id', async () => {
        mockClient.index.mockResolvedValue({});

        const result = await mod.runs.create({ testCaseId: 'tc-1' });

        expect(result.id).toMatch(/^report-/);
        expect(result.testCaseId).toBe('tc-1');
        expect(result.timestamp).toBeDefined();
        expect((result as any).createdAt).toBeDefined();
      });

      it('should use provided id and timestamp', async () => {
        mockClient.index.mockResolvedValue({});

        const result = await mod.runs.create({
          id: 'my-report',
          timestamp: '2025-01-01T00:00:00Z',
          testCaseId: 'tc-1',
        } as any);

        expect(result.id).toBe('my-report');
        expect(result.timestamp).toBe('2025-01-01T00:00:00Z');
      });
    });

    describe('update', () => {
      it('should merge updates with existing run', async () => {
        const existing = { id: 'report-1', testCaseId: 'tc-1', status: 'running' };
        mockClient.get.mockResolvedValue(makeGetResponse(existing));
        mockClient.index.mockResolvedValue({});

        const result = await mod.runs.update('report-1', { status: 'completed' } as any);

        expect(result.id).toBe('report-1');
        expect((result as any).status).toBe('completed');
      });

      it('should throw when run not found', async () => {
        mockClient.get.mockResolvedValue(makeGetResponse(null, false));

        await expect(
          mod.runs.update('nonexistent', {} as any)
        ).rejects.toThrow('Run nonexistent not found');
      });
    });

    describe('delete', () => {
      it('should delete a run and return deleted true', async () => {
        mockClient.delete.mockResolvedValue({});

        const result = await mod.runs.delete('report-1');

        expect(result).toEqual({ deleted: true });
      });

      it('should return deleted false on 404', async () => {
        mockClient.delete.mockRejectedValue(make404Error());

        const result = await mod.runs.delete('missing');

        expect(result).toEqual({ deleted: false });
      });
    });

    describe('search', () => {
      it('should build bool query from all filter fields', async () => {
        mockClient.search.mockResolvedValue(makeSearchResponse([], 0));

        await mod.runs.search({
          experimentId: 'bench-1',
          experimentRunId: 'run-1',
          testCaseId: 'tc-1',
          agentId: 'agent-1',
          modelId: 'model-1',
          status: 'completed',
          passFailStatus: 'passed',
          dateRange: { start: '2025-01-01', end: '2025-01-31' },
        });

        const callBody = mockClient.search.mock.calls[0][0].body;
        expect(callBody.query.bool.must).toHaveLength(8);
      });

      it('should use match_all when no filters given', async () => {
        mockClient.search.mockResolvedValue(makeSearchResponse([]));

        await mod.runs.search({});

        const callBody = mockClient.search.mock.calls[0][0].body;
        expect(callBody.query).toEqual({ match_all: {} });
      });

      it('should return empty results on index_not_found', async () => {
        mockClient.search.mockRejectedValue(makeIndexNotFoundError());

        const result = await mod.runs.search({ experimentId: 'bench-1' });

        expect(result).toEqual({ items: [], total: 0 });
      });
    });

    describe('getByTestCase', () => {
      it('should delegate to search with testCaseId filter', async () => {
        const runs = [{ id: 'report-1', testCaseId: 'tc-1' }];
        mockClient.search.mockResolvedValue(makeSearchResponse(runs, 1));

        const result = await mod.runs.getByTestCase('tc-1', 10, 0);

        expect(result.items).toHaveLength(1);
      });
    });

    describe('getByExperiment', () => {
      it('should return array of runs for an experiment', async () => {
        const runs = [
          { id: 'report-1', experimentId: 'bench-1' },
          { id: 'report-2', experimentId: 'bench-1' },
        ];
        mockClient.search.mockResolvedValue(makeSearchResponse(runs, 2));

        const result = await mod.runs.getByExperiment('bench-1', 50);

        expect(result).toHaveLength(2);
      });
    });

    describe('getByExperimentRun', () => {
      it('should filter by both experimentId and experimentRunId', async () => {
        const runs = [{ id: 'report-1', experimentId: 'bench-1', experimentRunId: 'run-1' }];
        mockClient.search.mockResolvedValue(makeSearchResponse(runs, 1));

        const result = await mod.runs.getByExperimentRun('bench-1', 'run-1');

        expect(result).toHaveLength(1);
      });
    });

    describe('getIterations', () => {
      it('should return items, total, and maxIteration', async () => {
        const runs = [
          { id: 'r1', experimentId: 'bench-1', testCaseId: 'tc-1', iteration: 1 },
          { id: 'r2', experimentId: 'bench-1', testCaseId: 'tc-1', iteration: 3 },
          { id: 'r3', experimentId: 'bench-1', testCaseId: 'tc-1', iteration: 2 },
        ];
        mockClient.search.mockResolvedValue(makeSearchResponse(runs, 3));

        const result = await mod.runs.getIterations('bench-1', 'tc-1');

        expect(result.items).toHaveLength(3);
        expect(result.total).toBe(3);
        expect(result.maxIteration).toBe(3);
      });

      it('should return maxIteration 0 when no runs have iteration field', async () => {
        const runs = [{ id: 'r1', experimentId: 'bench-1', testCaseId: 'tc-1' }];
        mockClient.search.mockResolvedValue(makeSearchResponse(runs, 1));

        const result = await mod.runs.getIterations('bench-1', 'tc-1');

        expect(result.maxIteration).toBe(0);
      });
    });

    describe('bulkCreate', () => {
      it('should create multiple runs and track success/failure', async () => {
        mockClient.index
          .mockResolvedValueOnce({})
          .mockResolvedValueOnce({})
          .mockRejectedValueOnce(new Error('fail'));

        const result = await mod.runs.bulkCreate([
          { testCaseId: 'tc-1' },
          { testCaseId: 'tc-2' },
          { testCaseId: 'tc-3' },
        ]);

        expect(result).toEqual({ created: 2, errors: 1 });
      });
    });

    describe('addAnnotation', () => {
      it('should add an annotation to an existing run', async () => {
        const existing = { id: 'report-1', testCaseId: 'tc-1', annotations: [] };
        mockClient.get.mockResolvedValue(makeGetResponse(existing));
        mockClient.update.mockResolvedValue({});

        const result = await mod.runs.addAnnotation('report-1', { text: 'Good run' });

        expect(result.id).toMatch(/^ann-/);
        expect(result.reportId).toBe('report-1');
        expect(result.text).toBe('Good run');
        expect(result.timestamp).toBeDefined();
      });

      it('should handle run with no existing annotations', async () => {
        const existing = { id: 'report-1', testCaseId: 'tc-1' };
        mockClient.get.mockResolvedValue(makeGetResponse(existing));
        mockClient.update.mockResolvedValue({});

        const result = await mod.runs.addAnnotation('report-1', { text: 'First annotation' });

        expect(result.text).toBe('First annotation');
      });

      it('should throw when run not found', async () => {
        mockClient.get.mockResolvedValue(makeGetResponse(null, false));

        await expect(
          mod.runs.addAnnotation('nonexistent', { text: 'test' })
        ).rejects.toThrow('Run nonexistent not found');
      });
    });

    describe('updateAnnotation', () => {
      it('should update an existing annotation', async () => {
        const existing = {
          id: 'report-1',
          annotations: [
            { id: 'ann-1', reportId: 'report-1', text: 'Old text', timestamp: '2025-01-01T00:00:00Z' },
          ],
        };
        mockClient.get.mockResolvedValue(makeGetResponse(existing));
        mockClient.update.mockResolvedValue({});

        const result = await mod.runs.updateAnnotation('report-1', 'ann-1', { text: 'New text' });

        expect(result.text).toBe('New text');
      });

      it('should throw when run not found', async () => {
        mockClient.get.mockResolvedValue(makeGetResponse(null, false));

        await expect(
          mod.runs.updateAnnotation('missing', 'ann-1', { text: 'X' })
        ).rejects.toThrow('Run missing not found');
      });

      it('should throw when annotation not found', async () => {
        const existing = { id: 'report-1', annotations: [] };
        mockClient.get.mockResolvedValue(makeGetResponse(existing));

        await expect(
          mod.runs.updateAnnotation('report-1', 'ann-nonexistent', { text: 'X' })
        ).rejects.toThrow('Annotation ann-nonexistent not found');
      });
    });

    describe('deleteAnnotation', () => {
      it('should remove an annotation from a run', async () => {
        const existing = {
          id: 'report-1',
          annotations: [
            { id: 'ann-1', text: 'Keep' },
            { id: 'ann-2', text: 'Delete' },
          ],
        };
        mockClient.get.mockResolvedValue(makeGetResponse(existing));
        mockClient.update.mockResolvedValue({});

        const result = await mod.runs.deleteAnnotation('report-1', 'ann-2');

        expect(result).toEqual({ deleted: true });
      });

      it('should return deleted false when run not found', async () => {
        mockClient.get.mockResolvedValue(makeGetResponse(null, false));

        const result = await mod.runs.deleteAnnotation('missing', 'ann-1');

        expect(result).toEqual({ deleted: false });
      });

      it('should return deleted false when annotation not found', async () => {
        const existing = { id: 'report-1', annotations: [{ id: 'ann-1' }] };
        mockClient.get.mockResolvedValue(makeGetResponse(existing));

        const result = await mod.runs.deleteAnnotation('report-1', 'ann-nonexistent');

        expect(result).toEqual({ deleted: false });
      });
    });

    describe('countsByTestCase', () => {
      it('should return counts from aggregation buckets', async () => {
        mockClient.search.mockResolvedValue({
          body: {
            aggregations: {
              by_test_case: {
                buckets: [
                  { key: 'tc-1', doc_count: 5 },
                  { key: 'tc-2', doc_count: 3 },
                ],
              },
            },
          },
        });

        const result = await mod.runs.countsByTestCase();

        expect(result).toEqual({ 'tc-1': 5, 'tc-2': 3 });
      });

      it('should return empty object on index_not_found', async () => {
        mockClient.search.mockRejectedValue(makeIndexNotFoundError());

        const result = await mod.runs.countsByTestCase();

        expect(result).toEqual({});
      });

      it('should throw non-index-not-found errors', async () => {
        mockClient.search.mockRejectedValue(new Error('Cluster down'));

        await expect(mod.runs.countsByTestCase()).rejects.toThrow('Cluster down');
      });
    });
  });

  // ==========================================================================
  // Analytics Operations
  // ==========================================================================

  describe('analytics', () => {
    describe('query', () => {
      it('should build term queries from filter entries', async () => {
        mockClient.search.mockResolvedValue(makeSearchResponse([{ metric: 1 }], 1));

        const result = await mod.analytics.query({ agentId: 'agent-1', status: 'completed' });

        expect(result.items).toHaveLength(1);
        expect(result.total).toBe(1);
        const callBody = mockClient.search.mock.calls[0][0].body;
        expect(callBody.query.bool.must).toEqual(
          expect.arrayContaining([
            { term: { agentId: 'agent-1' } },
            { term: { status: 'completed' } },
          ])
        );
      });

      it('should skip null and undefined filter values', async () => {
        mockClient.search.mockResolvedValue(makeSearchResponse([]));

        await mod.analytics.query({ agentId: 'x', empty: null, undef: undefined } as any);

        const callBody = mockClient.search.mock.calls[0][0].body;
        expect(callBody.query.bool.must).toHaveLength(1);
      });

      it('should use match_all when no valid filters', async () => {
        mockClient.search.mockResolvedValue(makeSearchResponse([]));

        await mod.analytics.query({});

        const callBody = mockClient.search.mock.calls[0][0].body;
        expect(callBody.query).toEqual({ match_all: {} });
      });

      it('should return empty on 404', async () => {
        mockClient.search.mockRejectedValue(make404Error());

        const result = await mod.analytics.query({});

        expect(result).toEqual({ items: [], total: 0 });
      });

      it('should throw non-404 errors', async () => {
        mockClient.search.mockRejectedValue(new Error('Cluster error'));

        await expect(mod.analytics.query({})).rejects.toThrow('Cluster error');
      });
    });

    describe('aggregations', () => {
      it('should return aggregation results grouped by default field', async () => {
        mockClient.search.mockResolvedValue({
          body: {
            aggregations: {
              by_field: {
                buckets: [
                  {
                    key: 'agent-1',
                    doc_count: 10,
                    avg_accuracy: { value: 0.85 },
                    pass_count: { doc_count: 7 },
                    fail_count: { doc_count: 3 },
                  },
                ],
              },
            },
          },
        });

        const result = await mod.analytics.aggregations();

        expect(result.groupBy).toBe('agentId');
        expect(result.aggregations).toHaveLength(1);
        expect(result.aggregations[0]).toEqual({
          key: 'agent-1',
          metrics: { avgAccuracy: 0.85 },
          passCount: 7,
          failCount: 3,
          totalRuns: 10,
        });
      });

      it('should filter by experimentId and use custom groupBy', async () => {
        mockClient.search.mockResolvedValue({
          body: { aggregations: { by_field: { buckets: [] } } },
        });

        const result = await mod.analytics.aggregations('bench-1', 'modelId');

        expect(result.groupBy).toBe('modelId');
        const callBody = mockClient.search.mock.calls[0][0].body;
        expect(callBody.query.bool.must).toEqual([
          { term: { experimentId: 'bench-1' } },
        ]);
        expect(callBody.aggs.by_field.terms.field).toBe('modelId.keyword');
      });

      it('should return empty on 404', async () => {
        mockClient.search.mockRejectedValue(make404Error());

        const result = await mod.analytics.aggregations();

        expect(result).toEqual({ aggregations: [], groupBy: 'agentId' });
      });

      it('should handle missing buckets gracefully', async () => {
        mockClient.search.mockResolvedValue({
          body: { aggregations: { by_field: {} } },
        });

        const result = await mod.analytics.aggregations();

        expect(result.aggregations).toEqual([]);
      });
    });

    describe('writeRecord', () => {
      it('should index a record with a provided id', async () => {
        mockClient.index.mockResolvedValue({});

        await mod.analytics.writeRecord({ id: 'my-analytics-id', metric: 42 });

        expect(mockClient.index).toHaveBeenCalledWith({
          index: 'evals_analytics',
          id: 'my-analytics-id',
          body: { id: 'my-analytics-id', metric: 42 },
          refresh: 'wait_for',
        });
      });

      it('should generate an id when none is provided', async () => {
        mockClient.index.mockResolvedValue({});

        await mod.analytics.writeRecord({ metric: 99 });

        expect(mockClient.index).toHaveBeenCalledWith(
          expect.objectContaining({
            id: expect.stringMatching(/^analytics-/),
          })
        );
      });
    });

    describe('backfill', () => {
      it('should return zeros (no-op implementation)', async () => {
        const result = await mod.analytics.backfill();

        expect(result).toEqual({ backfilled: 0, errors: 0, total: 0 });
      });
    });
  });

  // ==========================================================================
  // Migration lock enforcement
  // ==========================================================================

  describe('migration lock enforcement', () => {
    it('should check migration lock on testCases.create', async () => {
      mockClient.index.mockResolvedValue({});
      await mod.testCases.create({ name: 'test' });
      expect(mockAssertNotMigrating).toHaveBeenCalledWith('evals_test_cases');
    });

    it('should check migration lock on testCases.update', async () => {
      mockClient.search.mockResolvedValue(
        makeSearchResponse([{ id: 'tc-1', version: 1, name: 'old' }])
      );
      mockClient.index.mockResolvedValue({});
      await mod.testCases.update('tc-1', { name: 'new' });
      expect(mockAssertNotMigrating).toHaveBeenCalledWith('evals_test_cases');
    });

    it('should check migration lock on testCases.delete', async () => {
      mockClient.deleteByQuery.mockResolvedValue({ body: { deleted: 1 } });
      await mod.testCases.delete('tc-1');
      expect(mockAssertNotMigrating).toHaveBeenCalledWith('evals_test_cases');
    });

    it('should check migration lock on benchmarks.create', async () => {
      mockClient.index.mockResolvedValue({});
      await mod.benchmarks.create({ name: 'bench' });
      expect(mockAssertNotMigrating).toHaveBeenCalledWith('evals_experiments');
    });

    it('should check migration lock on runs.create', async () => {
      mockClient.index.mockResolvedValue({});
      await mod.runs.create({ name: 'run' });
      expect(mockAssertNotMigrating).toHaveBeenCalledWith('evals_runs');
    });

    it('should check migration lock on analytics.writeRecord', async () => {
      mockClient.index.mockResolvedValue({});
      await mod.analytics.writeRecord({ id: 'a1', metric: 1 });
      expect(mockAssertNotMigrating).toHaveBeenCalledWith('evals_analytics');
    });

    it('should throw MigrationInProgressError when index is locked', async () => {
      const { MigrationInProgressError } = await import('@/server/services/migrationLock');
      mockAssertNotMigrating.mockImplementation(() => {
        throw new MigrationInProgressError('Index evals_test_cases is being migrated.');
      });

      await expect(mod.testCases.create({ name: 'test' })).rejects.toThrow(
        'Index evals_test_cases is being migrated.'
      );

      // client.index should NOT have been called
      expect(mockClient.index).not.toHaveBeenCalled();
    });
  });

  describe('evaluationRuns.list — docType mapping compatibility', () => {
    it('matches both current keyword and legacy text-only mapping shapes', async () => {
      mockClient.search.mockResolvedValue(makeSearchResponse([], 0));
      await mod.evaluationRuns.list();
      const must = mockClient.search.mock.calls[0][0].body.query.bool.must;
      expect(must[0]).toEqual({ bool: {
        should: [
          { term: { 'docType.keyword': 'evaluation-run' } },
          { match_phrase: { docType: 'evaluation-run' } },
        ],
        minimum_should_match: 1,
      } });
    });

    it('applies benchmarkId/agentKey/status/trigger filters via their .keyword sub-fields', async () => {
      mockClient.search.mockResolvedValue(makeSearchResponse([], 0));
      await mod.evaluationRuns.list({ benchmarkId: 'b1', agentKey: 'a1', status: 'completed', trigger: 'manual' });
      const must = mockClient.search.mock.calls[0][0].body.query.bool.must;
      expect(must).toContainEqual({ term: { 'benchmarkId.keyword': 'b1' } });
      expect(must).toContainEqual({ term: { 'agentKey.keyword': 'a1' } });
      expect(must).toContainEqual({ term: { 'status.keyword': 'completed' } });
      expect(must).toContainEqual({ term: { 'trigger.keyword': 'manual' } });
    });

    // Regression: `testCaseSnapshots` on EvaluationRun docs is a plain
    // dynamically-mapped `object` array, NOT `nested` (see indexMappings.ts).
    // A `nested` query against it 400s with "query_shard_exception: nested
    // object under path [testCaseSnapshots] is not of nested type" — verified
    // against a real OpenSearch 2.17.0 instance. `list()` must use a plain
    // `term` on the flattened `.keyword` multi-field instead.
    it('applies the testCaseId filter as a plain term on testCaseSnapshots.id.keyword, not a nested query', async () => {
      mockClient.search.mockResolvedValue(makeSearchResponse([], 0));
      await mod.evaluationRuns.list({ testCaseId: 'tc-1' });
      const must = mockClient.search.mock.calls[0][0].body.query.bool.must;
      expect(must).toContainEqual({ term: { 'testCaseSnapshots.id.keyword': 'tc-1' } });
      expect(JSON.stringify(must)).not.toContain('"nested"');
    });

    it('applies the imageDigest filter as a plain term on imageDigest.keyword', async () => {
      mockClient.search.mockResolvedValue(makeSearchResponse([], 0));
      await mod.evaluationRuns.list({ imageDigest: 'digest-abc' });
      const must = mockClient.search.mock.calls[0][0].body.query.bool.must;
      expect(must).toContainEqual({ term: { 'imageDigest.keyword': 'digest-abc' } });
    });
  });

  describe('images', () => {
    const baseImage = () => ({
      digest: 'digest-abc',
      testCaseFingerprints: [{ id: 'tc-1', name: 'TC 1', contentHash: 'hash1' }],
      testCaseCount: 1,
      evalConditions: { evaluatorId: 'ev-1' },
    });

    describe('create', () => {
      it('find-or-create: returns the existing image untouched when the digest already exists', async () => {
        mockClient.get.mockResolvedValue(
          makeGetResponse({ ...baseImage(), id: 'img-digest-abc', docType: 'benchmark-image', tags: ['nightly'], createdAt: '2020-01-01T00:00:00.000Z' })
        );

        const result = await mod.images.create({ ...baseImage(), tags: ['ignored'] } as any);

        expect(result.tags).toEqual(['nightly']);
        expect(mockClient.index).not.toHaveBeenCalled();
      });

      it('creates a new image doc (id=img-<digest>, docType, default tags/createdAt) when the digest is new', async () => {
        mockClient.get.mockResolvedValue(makeGetResponse(null, false));
        mockClient.index.mockResolvedValue({});

        const result = await mod.images.create(baseImage() as any);

        expect(result.id).toBe('img-digest-abc');
        expect(result.docType).toBe('benchmark-image');
        expect(result.tags).toEqual([]);
        expect(result.createdAt).toBeDefined();
        expect(mockClient.index).toHaveBeenCalledWith(expect.objectContaining({
          index: 'evals_experiments',
          id: 'img-digest-abc',
          refresh: 'wait_for',
        }));
      });
    });

    describe('getByDigest', () => {
      it('returns null on a doc-level 404', async () => {
        mockClient.get.mockRejectedValue(make404Error());
        const result = await mod.images.getByDigest('nope');
        expect(result).toBeNull();
      });

      it('rethrows non-404 errors', async () => {
        mockClient.get.mockRejectedValue(new Error('timeout'));
        await expect(mod.images.getByDigest('digest-abc')).rejects.toThrow('timeout');
      });

      it('returns null when found=false', async () => {
        mockClient.get.mockResolvedValue(makeGetResponse(null, false));
        const result = await mod.images.getByDigest('digest-abc');
        expect(result).toBeNull();
      });

      it('returns null when the doc at that id is not a benchmark-image (docType mismatch)', async () => {
        mockClient.get.mockResolvedValue(makeGetResponse({ id: 'img-digest-abc', docType: 'benchmark', name: 'Not an image' }));
        const result = await mod.images.getByDigest('digest-abc');
        expect(result).toBeNull();
      });

      it('returns the image when docType matches', async () => {
        const doc = { ...baseImage(), id: 'img-digest-abc', docType: 'benchmark-image', tags: [], createdAt: '2026-01-01T00:00:00.000Z' };
        mockClient.get.mockResolvedValue(makeGetResponse(doc));
        const result = await mod.images.getByDigest('digest-abc');
        expect(result).toEqual(doc);
      });
    });

    describe('getAll', () => {
      it('queries docType.keyword: benchmark-image with pagination defaults', async () => {
        mockClient.search.mockResolvedValue(makeSearchResponse([], 0));
        await mod.images.getAll();
        const call = mockClient.search.mock.calls[0][0];
        expect(call.body.query).toEqual({ term: { 'docType.keyword': 'benchmark-image' } });
        expect(call.body.size).toBe(1000);
        expect(call.body.from).toBe(0);
      });

      it('honors from/size overrides', async () => {
        mockClient.search.mockResolvedValue(makeSearchResponse([], 0));
        await mod.images.getAll({ from: 5, size: 10 });
        const call = mockClient.search.mock.calls[0][0];
        expect(call.body.size).toBe(10);
        expect(call.body.from).toBe(5);
      });

      it('returns items/total from the search response', async () => {
        const img = { ...baseImage(), id: 'img-digest-abc', docType: 'benchmark-image', tags: [] };
        mockClient.search.mockResolvedValue(makeSearchResponse([img], 1));
        const result = await mod.images.getAll();
        expect(result).toEqual({ items: [img], total: 1 });
      });

      it('returns empty results on index_not_found', async () => {
        mockClient.search.mockRejectedValue(makeIndexNotFoundError());
        const result = await mod.images.getAll();
        expect(result).toEqual({ items: [], total: 0 });
      });

      it('rethrows non-index-not-found search errors', async () => {
        mockClient.search.mockRejectedValue(new Error('cluster down'));
        await expect(mod.images.getAll()).rejects.toThrow('cluster down');
      });
    });

    describe('update', () => {
      it('throws when the image does not exist', async () => {
        mockClient.get.mockResolvedValue(makeGetResponse(null, false));
        await expect(mod.images.update('missing', { tags: ['x'] })).rejects.toThrow('Benchmark image missing not found');
      });

      it('merges only tags/lastRunAt, preserving identity fields, and re-indexes', async () => {
        const existing = { ...baseImage(), id: 'img-digest-abc', docType: 'benchmark-image', tags: ['old'], createdAt: '2020-01-01T00:00:00.000Z' };
        mockClient.get.mockResolvedValue(makeGetResponse(existing));
        mockClient.index.mockResolvedValue({});

        const result = await mod.images.update('digest-abc', { tags: ['new'], lastRunAt: '2026-01-01T00:00:00.000Z' });

        expect(result.tags).toEqual(['new']);
        expect(result.lastRunAt).toBe('2026-01-01T00:00:00.000Z');
        expect(result.digest).toBe('digest-abc');
        expect(mockClient.index).toHaveBeenCalledWith(expect.objectContaining({
          index: 'evals_experiments',
          id: 'img-digest-abc',
          refresh: 'wait_for',
        }));
      });

      it('leaves tags/lastRunAt unchanged when not provided in updates', async () => {
        const existing = { ...baseImage(), id: 'img-digest-abc', docType: 'benchmark-image', tags: ['keep'], lastRunAt: '2020-01-01T00:00:00.000Z', createdAt: '2020-01-01T00:00:00.000Z' };
        mockClient.get.mockResolvedValue(makeGetResponse(existing));
        mockClient.index.mockResolvedValue({});

        const result = await mod.images.update('digest-abc', {});

        expect(result.tags).toEqual(['keep']);
        expect(result.lastRunAt).toBe('2020-01-01T00:00:00.000Z');
      });
    });

    describe('delete', () => {
      it('deletes and returns deleted:true', async () => {
        mockClient.delete.mockResolvedValue({});
        const result = await mod.images.delete('digest-abc');
        expect(result).toEqual({ deleted: true });
        expect(mockClient.delete).toHaveBeenCalledWith(expect.objectContaining({ id: 'img-digest-abc', refresh: 'wait_for' }));
      });

      it('returns deleted:false on a doc-level 404', async () => {
        mockClient.delete.mockRejectedValue(make404Error());
        const result = await mod.images.delete('missing');
        expect(result).toEqual({ deleted: false });
      });

      it('rethrows non-404 delete errors', async () => {
        mockClient.delete.mockRejectedValue(new Error('cluster down'));
        await expect(mod.images.delete('digest-abc')).rejects.toThrow('cluster down');
      });
    });
  });
});
