/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for benchmark versioning in asyncBenchmarkStorage
 *
 * These tests require the backend server to be running:
 *   npm run dev:server
 *
 * Run tests:
 *   npm test -- --testPathPattern=benchmarkVersions.integration
 */

import { asyncBenchmarkStorage } from '@/services/storage/asyncBenchmarkStorage';
import { storageAdmin } from '@/services/storage/opensearchClient';
import type { BenchmarkRun } from '@/types';

const checkBackend = async (): Promise<boolean> => {
  try {
    const health = await storageAdmin.health();
    return health.status === 'connected';
  } catch {
    return false;
  }
};

/** Build a minimal BenchmarkRun for testing */
function buildRun(overrides: Partial<BenchmarkRun> = {}): BenchmarkRun {
  const id = `run-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  return {
    id,
    name: overrides.name ?? 'Integration Test Run',
    createdAt: new Date().toISOString(),
    agentKey: 'integration-test-agent',
    modelId: 'test-model',
    results: {},
    ...overrides,
  };
}

describe('Benchmark Versions Integration Tests', () => {
  let backendAvailable = false;
  const createdBenchmarkIds: string[] = [];

  beforeAll(async () => {
    backendAvailable = await checkBackend();
    if (!backendAvailable) {
      console.warn('Backend not available - skipping benchmark version integration tests');
    }
  });

  afterAll(async () => {
    if (!backendAvailable) return;
    // Cleanup all created benchmarks by tracked ID
    for (const id of createdBenchmarkIds) {
      try {
        await asyncBenchmarkStorage.delete(id);
      } catch {
        // Ignore cleanup errors
      }
    }
    // Fallback: clean up leftovers from previous failed runs by name
    try {
      const names = ['Version Integration Test', 'Run Embed Test', 'Run Delete Test', 'Delete Test'];
      const allBenchmarks = await asyncBenchmarkStorage.getAll();
      for (const b of allBenchmarks) {
        if (names.includes(b.name)) {
          await asyncBenchmarkStorage.delete(b.id).catch(() => {});
        }
      }
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('create benchmark with version', () => {
    it('should create a benchmark with currentVersion 1 and a versions array', async () => {
      if (!backendAvailable) return;

      const benchmark = await asyncBenchmarkStorage.create({
        name: 'Version Integration Test',
        description: 'Test versioning',
        testCaseIds: ['tc-001', 'tc-002'],
        runs: [],
        currentVersion: 1,
        versions: [{
          version: 1,
          createdAt: new Date().toISOString(),
          testCaseIds: ['tc-001', 'tc-002'],
        }],
      });

      expect(benchmark).toBeDefined();
      expect(benchmark.id).toBeDefined();
      expect(benchmark.currentVersion).toBe(1);
      expect(benchmark.versions).toBeDefined();
      expect(benchmark.versions.length).toBeGreaterThanOrEqual(1);
      expect(benchmark.versions[0].version).toBe(1);
      expect(benchmark.versions[0].testCaseIds).toEqual(['tc-001', 'tc-002']);

      createdBenchmarkIds.push(benchmark.id);
    });
  });

  describe('add run to benchmark', () => {
    it('should embed a run in the benchmark and verify via getById', async () => {
      if (!backendAvailable) return;

      const benchmark = await asyncBenchmarkStorage.create({
        name: 'Run Embed Test',
        description: 'Test run embedding',
        testCaseIds: ['tc-001'],
        runs: [],
        currentVersion: 1,
        versions: [{
          version: 1,
          createdAt: new Date().toISOString(),
          testCaseIds: ['tc-001'],
        }],
      });
      createdBenchmarkIds.push(benchmark.id);

      const run = buildRun({ name: 'Embedded Run' });
      const added = await asyncBenchmarkStorage.addRun(benchmark.id, run);
      expect(added).toBe(true);

      const fetched = await asyncBenchmarkStorage.getById(benchmark.id);
      expect(fetched).toBeDefined();
      expect(fetched!.runs.length).toBe(1);
      expect(fetched!.runs[0].id).toBe(run.id);
      expect(fetched!.runs[0].name).toBe('Embedded Run');
    });
  });

  describe('delete run from benchmark', () => {
    it('should remove a run from the benchmark', async () => {
      if (!backendAvailable) return;

      const benchmark = await asyncBenchmarkStorage.create({
        name: 'Run Delete Test',
        description: 'Test run deletion',
        testCaseIds: ['tc-001'],
        runs: [],
        currentVersion: 1,
        versions: [{
          version: 1,
          createdAt: new Date().toISOString(),
          testCaseIds: ['tc-001'],
        }],
      });
      createdBenchmarkIds.push(benchmark.id);

      // Add a run first
      const run = buildRun({ name: 'Run To Delete' });
      await asyncBenchmarkStorage.addRun(benchmark.id, run);

      // Verify it was added
      const beforeDelete = await asyncBenchmarkStorage.getById(benchmark.id);
      expect(beforeDelete!.runs.length).toBe(1);

      // Delete the run
      const deleted = await asyncBenchmarkStorage.deleteRun(benchmark.id, run.id);
      expect(deleted).toBe(true);

      // Verify it was removed
      const afterDelete = await asyncBenchmarkStorage.getById(benchmark.id);
      expect(afterDelete!.runs.length).toBe(0);
    });
  });

  describe('get all benchmarks', () => {
    it('should include created benchmark in getAll results', async () => {
      if (!backendAvailable) return;

      const benchmark = await asyncBenchmarkStorage.create({
        name: `GetAll Test ${Date.now()}`,
        description: 'Test getAll',
        testCaseIds: ['tc-001'],
        runs: [],
        currentVersion: 1,
        versions: [{
          version: 1,
          createdAt: new Date().toISOString(),
          testCaseIds: ['tc-001'],
        }],
      });
      createdBenchmarkIds.push(benchmark.id);

      const all = await asyncBenchmarkStorage.getAll();
      expect(Array.isArray(all)).toBe(true);
      const found = all.find(b => b.id === benchmark.id);
      expect(found).toBeDefined();
      expect(found!.name).toBe(benchmark.name);
    });
  });

  describe('benchmark deletion', () => {
    it('should delete a benchmark and return null on subsequent getById', async () => {
      if (!backendAvailable) return;

      const benchmark = await asyncBenchmarkStorage.create({
        name: 'Delete Test',
        description: 'Test deletion',
        testCaseIds: [],
        runs: [],
        currentVersion: 1,
        versions: [{
          version: 1,
          createdAt: new Date().toISOString(),
          testCaseIds: [],
        }],
      });

      const deleted = await asyncBenchmarkStorage.delete(benchmark.id);
      expect(deleted).toBe(true);

      const retrieved = await asyncBenchmarkStorage.getById(benchmark.id);
      expect(retrieved).toBeNull();
    });
  });
});
