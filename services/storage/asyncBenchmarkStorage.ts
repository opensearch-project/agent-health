/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Async Benchmark Storage
 *
 * Async wrapper around OpenSearch storage for benchmarks.
 * Maps between app's Benchmark type and OpenSearch StorageBenchmark.
 */

import { benchmarkStorage as opensearchBenchmarks, StorageBenchmark, StorageBenchmarkRunConfig } from './opensearchClient';
import type { Benchmark, BenchmarkRun, BenchmarkVersion, TestCaseSnapshot, RunResultStatus } from '@/types';

/** API response for benchmark list */
interface BenchmarkListResponse {
  benchmarks: Benchmark[];
  total: number;
}

/** API response for version list */
interface VersionListResponse {
  versions: BenchmarkVersion[];
  total: number;
}

/**
 * Convert OpenSearch storage format to app Benchmark format.
 * Normalizes legacy data without version fields.
 */
function toBenchmark(stored: StorageBenchmark): Benchmark {
  const version = (stored as any).currentVersion ?? (stored as any).version ?? 1;
  return {
    id: stored.id,
    name: stored.name,
    description: stored.description,
    createdAt: stored.createdAt,
    updatedAt: (stored as any).updatedAt ?? stored.createdAt,
    currentVersion: version,
    versions: (stored as any).versions ?? [{
      version: 1,
      createdAt: stored.createdAt,
      testCaseIds: stored.testCaseIds || [],
    }],
    testCaseIds: stored.testCaseIds,
    runs: (stored.runs || []).map(toBenchmarkRun),
  };
}

/**
 * Convert OpenSearch run config to app BenchmarkRun format.
 * Normalizes legacy data without version tracking fields.
 */
function toBenchmarkRun(stored: StorageBenchmarkRunConfig): BenchmarkRun {
  // Convert results with proper typing for status field
  const results: Record<string, { reportId: string; status: RunResultStatus }> = {};
  if (stored.results) {
    Object.entries(stored.results).forEach(([key, value]) => {
      results[key] = {
        reportId: value.reportId,
        status: value.status as RunResultStatus,
      };
    });
  }

  return {
    id: stored.id,
    name: stored.name,
    description: stored.description,
    createdAt: stored.createdAt,
    agentKey: stored.agentId,
    modelId: stored.modelId,
    headers: stored.headers,
    benchmarkVersion: (stored as any).benchmarkVersion ?? 1,
    testCaseSnapshots: (stored as any).testCaseSnapshots ?? [],
    results,
  };
}

/**
 * Convert app Benchmark format to OpenSearch storage format
 */
function toStorageFormat(benchmark: Partial<Benchmark>): Record<string, any> {
  const result: Record<string, any> = {
    name: benchmark.name,
    description: benchmark.description,
    testCaseIds: benchmark.testCaseIds,
  };

  // Include versioning fields
  if (benchmark.currentVersion !== undefined) {
    result.currentVersion = benchmark.currentVersion;
  }
  if (benchmark.versions !== undefined) {
    result.versions = benchmark.versions;
  }
  if (benchmark.updatedAt !== undefined) {
    result.updatedAt = benchmark.updatedAt;
  }

  // Convert runs with version tracking fields
  if (benchmark.runs) {
    result.runs = benchmark.runs.map(run => ({
      id: run.id,
      name: run.name,
      description: run.description,
      agentId: run.agentKey,
      modelId: run.modelId,
      headers: run.headers,
      createdAt: run.createdAt,
      benchmarkVersion: run.benchmarkVersion,
      testCaseSnapshots: run.testCaseSnapshots,
      results: run.results,
    }));
  }

  return result;
}

class AsyncBenchmarkStorage {
  // ==================== Benchmark CRUD Operations ====================

  /**
   * Get all benchmarks, sorted by updatedAt descending (most recently active first)
   */
  async getAll(): Promise<Benchmark[]> {
    const stored = await opensearchBenchmarks.getAll();
    const benchmarks = stored.map(toBenchmark);
    // Sort by updatedAt descending (most recently active first), fallback to createdAt
    return benchmarks.sort((a, b) =>
      new Date(b.updatedAt || b.createdAt || 0).getTime() - new Date(a.updatedAt || a.createdAt || 0).getTime()
    );
  }

  /**
   * Get a single benchmark by ID
   */
  async getById(id: string): Promise<Benchmark | null> {
    const stored = await opensearchBenchmarks.getById(id);
    return stored ? toBenchmark(stored) : null;
  }

  /**
   * Create a new benchmark (immutable)
   */
  async create(benchmark: Omit<Benchmark, 'id' | 'createdAt' | 'updatedAt'>): Promise<Benchmark> {
    const storageData = toStorageFormat(benchmark as Benchmark) as Omit<StorageBenchmark, 'id' | 'createdAt'>;
    const created = await opensearchBenchmarks.create(storageData);
    return toBenchmark(created);
  }

  /**
   * Save a benchmark (create only - benchmarks are immutable)
   * For compatibility with existing code that calls save()
   */
  async save(benchmark: Benchmark): Promise<Benchmark> {
    // Check if exists
    const existing = await this.getById(benchmark.id);
    if (existing) {
      // Benchmarks are immutable - return existing
      console.warn('Benchmark already exists and cannot be updated:', benchmark.id);
      return existing;
    }

    const storageData = toStorageFormat(benchmark);
    // Include id for existing benchmarks being saved
    const dataWithId = {
      ...storageData,
      id: benchmark.id,
    } as unknown as Omit<StorageBenchmark, 'id' | 'createdAt'>;
    const created = await opensearchBenchmarks.create(dataWithId);
    return toBenchmark(created);
  }

  /**
   * Delete a benchmark
   */
  async delete(id: string): Promise<boolean> {
    const result = await opensearchBenchmarks.delete(id);
    return result.deleted;
  }

  /**
   * Get total count of benchmarks
   */
  async getCount(): Promise<number> {
    const benchmarks = await this.getAll();
    return benchmarks.length;
  }

  // ==================== Run Operations ====================
  // Note: In OpenSearch model, runs are embedded in benchmark.
  // Actual execution results go to evals_runs index, not here.

  /**
   * Get all run configs for a benchmark
   */
  async getRuns(benchmarkId: string): Promise<BenchmarkRun[]> {
    const benchmark = await this.getById(benchmarkId);
    if (!benchmark) return [];
    return benchmark.runs || [];
  }

  /**
   * Get a specific run config by ID from a benchmark
   */
  async getRunById(benchmarkId: string, runId: string): Promise<BenchmarkRun | null> {
    const benchmark = await this.getById(benchmarkId);
    if (!benchmark) return null;
    return benchmark.runs?.find(r => r.id === runId) || null;
  }

  /**
   * Add or update a run in a benchmark
   */
  async addRun(benchmarkId: string, run: BenchmarkRun): Promise<boolean> {
    console.log('[asyncBenchmarkStorage] addRun called', { benchmarkId, runId: run.id });

    const benchmark = await this.getById(benchmarkId);
    if (!benchmark) {
      console.error('[asyncBenchmarkStorage] Benchmark not found:', benchmarkId);
      return false;
    }
    console.log('[asyncBenchmarkStorage] Found benchmark, current runs:', benchmark.runs?.length || 0);

    const currentRuns = benchmark.runs || [];
    const existingIndex = currentRuns.findIndex(r => r.id === run.id);

    let updatedRuns: BenchmarkRun[];
    if (existingIndex >= 0) {
      // Update existing run
      console.log('[asyncBenchmarkStorage] Updating existing run at index:', existingIndex);
      updatedRuns = [...currentRuns];
      updatedRuns[existingIndex] = run;
    } else {
      // Add new run
      console.log('[asyncBenchmarkStorage] Adding new run');
      updatedRuns = [...currentRuns, run];
    }

    // Convert to storage format
    const storageRuns = updatedRuns.map(r => ({
      id: r.id,
      name: r.name,
      description: r.description,
      agentId: r.agentKey,
      modelId: r.modelId,
      headers: r.headers,
      createdAt: r.createdAt,
      results: r.results,
    }));

    console.log('[asyncBenchmarkStorage] Saving updated runs:', storageRuns.length);
    await opensearchBenchmarks.update(benchmarkId, { runs: storageRuns });
    console.log('[asyncBenchmarkStorage] Runs saved successfully');
    return true;
  }

  /**
   * Delete a run config from a benchmark
   */
  async deleteRun(benchmarkId: string, runId: string): Promise<boolean> {
    const benchmark = await this.getById(benchmarkId);
    if (!benchmark) return false;

    const currentRuns = benchmark.runs || [];
    const filteredRuns = currentRuns.filter(r => r.id !== runId);

    // If no run was removed, return false
    if (filteredRuns.length === currentRuns.length) return false;

    // Update the benchmark with the filtered runs
    const updatedRuns = filteredRuns.map(run => ({
      id: run.id,
      name: run.name,
      description: run.description,
      agentId: run.agentKey,
      modelId: run.modelId,
      headers: run.headers,
      createdAt: run.createdAt,
      results: run.results,
    }));

    await opensearchBenchmarks.update(benchmarkId, { runs: updatedRuns });
    return true;
  }

  // ==================== Utility Functions ====================

  /**
   * Generate a unique benchmark ID
   */
  generateBenchmarkId(): string {
    return `bench-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }

  /**
   * Generate a unique run ID
   */
  generateRunId(): string {
    return `run-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }

  /**
   * Bulk create benchmarks (for migration)
   */
  async bulkCreate(benchmarks: Benchmark[]): Promise<{ created: number; errors: boolean }> {
    const storageData = benchmarks.map(bench => ({
      ...toStorageFormat(bench),
      id: bench.id,
      createdAt: bench.createdAt,
    }));
    return opensearchBenchmarks.bulkCreate(storageData);
  }

  // ==================== Version Operations ====================

  /**
   * Update benchmark metadata only (name, description) - no version change
   * Uses centralized opensearchClient for consistent API handling
   */
  async updateMetadata(id: string, updates: { name?: string; description?: string }): Promise<Benchmark | null> {
    try {
      const result = await opensearchBenchmarks.updateMetadata(id, updates);
      return toBenchmark(result);
    } catch (error) {
      console.error('[asyncBenchmarkStorage] updateMetadata failed:', error);
      return null;
    }
  }

  /**
   * Update test case list - creates a new version
   * Uses centralized opensearchClient for consistent API handling
   */
  async updateTestCases(id: string, testCaseIds: string[]): Promise<Benchmark | null> {
    try {
      const result = await opensearchBenchmarks.update(id, { testCaseIds });
      return toBenchmark(result);
    } catch (error) {
      console.error('[asyncBenchmarkStorage] updateTestCases failed:', error);
      return null;
    }
  }

  /**
   * Get all versions of a benchmark
   * Uses centralized opensearchClient for consistent API handling
   */
  async getVersions(benchmarkId: string): Promise<BenchmarkVersion[]> {
    try {
      const result = await opensearchBenchmarks.getVersions(benchmarkId);
      return result.versions;
    } catch (error: any) {
      // Handle 404 gracefully
      if (error.message?.includes('404') || error.message?.includes('not found')) {
        return [];
      }
      console.error('[asyncBenchmarkStorage] getVersions failed:', error);
      return [];
    }
  }

  /**
   * Get a specific version of a benchmark
   * Uses centralized opensearchClient for consistent API handling
   */
  async getVersion(benchmarkId: string, version: number): Promise<BenchmarkVersion | null> {
    try {
      return await opensearchBenchmarks.getVersion(benchmarkId, version);
    } catch (error: any) {
      // Handle 404 gracefully
      if (error.message?.includes('404') || error.message?.includes('not found')) {
        return null;
      }
      console.error('[asyncBenchmarkStorage] getVersion failed:', error);
      return null;
    }
  }

  /**
   * Update a benchmark (name, description, or testCaseIds).
   * If testCaseIds changed, creates a new version.
   * Uses centralized opensearchClient for consistent API handling
   */
  async update(id: string, updates: { name?: string; description?: string; testCaseIds?: string[] }): Promise<Benchmark | null> {
    try {
      const result = await opensearchBenchmarks.update(id, updates);
      return toBenchmark(result);
    } catch (error) {
      console.error('[asyncBenchmarkStorage] update failed:', error);
      return null;
    }
  }
}

// Export singleton instance
export const asyncBenchmarkStorage = new AsyncBenchmarkStorage();

// Backwards compatibility alias
/** @deprecated Use asyncBenchmarkStorage instead */
export const asyncExperimentStorage = asyncBenchmarkStorage;
