/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Benchmark, BenchmarkRun } from '@/types';

// Storage key - only benchmarks now (runs embedded within)
const BENCHMARKS_KEY = 'benchmarks';

// Types for storage
interface BenchmarksStorage {
  [benchmarkId: string]: Benchmark;
}

class BenchmarkStorage {
  // ==================== Benchmark CRUD Operations ====================

  /**
   * Get all benchmarks
   */
  getAll(): Benchmark[] {
    const benchmarks = this.getBenchmarksRaw();
    return Object.values(benchmarks).sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
  }

  /**
   * Get a single benchmark by ID
   */
  getById(id: string): Benchmark | null {
    const benchmarks = this.getBenchmarksRaw();
    return benchmarks[id] || null;
  }

  /**
   * Save a benchmark (create or update)
   */
  save(benchmark: Benchmark): void {
    try {
      const benchmarks = this.getBenchmarksRaw();

      // Update timestamp
      benchmark.updatedAt = new Date().toISOString();

      // If new, set createdAt and initialize runs array
      if (!benchmarks[benchmark.id]) {
        benchmark.createdAt = benchmark.createdAt || new Date().toISOString();
        if (!benchmark.runs) {
          benchmark.runs = [];
        }
      }

      benchmarks[benchmark.id] = benchmark;
      localStorage.setItem(BENCHMARKS_KEY, JSON.stringify(benchmarks));
    } catch (error) {
      console.error('Error saving benchmark:', error);
      throw new Error(`Failed to save benchmark: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Delete a benchmark
   */
  delete(id: string): boolean {
    try {
      const benchmarks = this.getBenchmarksRaw();

      if (!benchmarks[id]) {
        return false;
      }

      delete benchmarks[id];
      localStorage.setItem(BENCHMARKS_KEY, JSON.stringify(benchmarks));

      return true;
    } catch (error) {
      console.error('Error deleting benchmark:', error);
      return false;
    }
  }

  /**
   * Get total count of benchmarks
   */
  getCount(): number {
    const benchmarks = this.getBenchmarksRaw();
    return Object.keys(benchmarks).length;
  }

  // ==================== Run Operations (embedded in benchmark) ====================

  /**
   * Get all runs for a benchmark
   */
  getRuns(benchmarkId: string): BenchmarkRun[] {
    const benchmark = this.getById(benchmarkId);
    if (!benchmark) return [];

    return [...(benchmark.runs || [])].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  /**
   * Get a specific run by ID from a benchmark
   */
  getRunById(benchmarkId: string, runId: string): BenchmarkRun | null {
    const benchmark = this.getById(benchmarkId);
    if (!benchmark) return null;

    return benchmark.runs?.find(r => r.id === runId) || null;
  }

  /**
   * Add or update a run in a benchmark
   */
  saveRun(benchmarkId: string, run: BenchmarkRun): void {
    const benchmark = this.getById(benchmarkId);
    if (!benchmark) {
      throw new Error(`Benchmark not found: ${benchmarkId}`);
    }

    // Ensure runs array exists
    if (!benchmark.runs) {
      benchmark.runs = [];
    }

    // Check if run already exists (update case)
    const existingIndex = benchmark.runs.findIndex(r => r.id === run.id);

    if (existingIndex >= 0) {
      // Update existing run
      benchmark.runs[existingIndex] = run;
    } else {
      // Add new run
      benchmark.runs.push(run);
    }

    this.save(benchmark);
  }

  /**
   * Delete a run from a benchmark
   */
  deleteRun(benchmarkId: string, runId: string): boolean {
    const benchmark = this.getById(benchmarkId);
    if (!benchmark || !benchmark.runs) return false;

    const index = benchmark.runs.findIndex(r => r.id === runId);
    if (index < 0) return false;

    benchmark.runs.splice(index, 1);
    this.save(benchmark);
    return true;
  }

  // ==================== Utility Functions ====================

  /**
   * Generate a unique benchmark ID
   */
  generateBenchmarkId(): string {
    return `bench-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Generate a unique run ID
   */
  generateRunId(): string {
    return `run-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  // ==================== Private Helpers ====================

  private getBenchmarksRaw(): BenchmarksStorage {
    const data = localStorage.getItem(BENCHMARKS_KEY);
    if (!data) {
      return {};
    }

    try {
      return JSON.parse(data);
    } catch (error) {
      console.error('Error parsing benchmarks:', error);
      return {};
    }
  }

  /**
   * Clear all benchmarks
   */
  clearAll(): void {
    try {
      localStorage.removeItem(BENCHMARKS_KEY);
      console.log('All benchmarks cleared');
    } catch (error) {
      console.error('Error clearing benchmarks:', error);
    }
  }
}

// Export singleton instance
export const benchmarkStorage = new BenchmarkStorage();

// Backwards compatibility alias
/** @deprecated Use benchmarkStorage instead */
export const experimentStorage = benchmarkStorage;
