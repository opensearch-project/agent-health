/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OpenSearch Storage Client
 *
 * Frontend client for OpenSearch storage operations.
 * All requests go through the backend API at /api/storage/*
 */

import { ENV_CONFIG } from '@/lib/config';

const STORAGE_BASE_URL = ENV_CONFIG.storageApiUrl;

/**
 * Generic HTTP client for storage API
 * Backend handles config resolution (file or env vars) - no headers needed from frontend
 */
async function request<T>(
  method: string,
  endpoint: string,
  body?: unknown
): Promise<T> {
  const url = `${STORAGE_BASE_URL}${endpoint}`;

  const options: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
    },
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(errorData.error || `Storage request failed: ${response.status}`);
  }

  return response.json();
}

// ==================== Types ====================

export interface StorageTestCase {
  id: string;
  name: string;
  description?: string;
  version: number;
  initialPrompt: string;
  tools?: unknown[];
  messages?: unknown[];
  context?: unknown[];
  forwardedProps?: Record<string, unknown>;
  expectedPPL?: string;  // Expected PPL query
  expectedOutcomes?: string[];  // NEW: Simple text descriptions of expected behavior
  expectedTrajectory?: unknown[];  // Legacy: step-by-step trajectory
  labels?: string[];  // Unified labels system (replaces category/subcategory/difficulty)
  category?: string;  // Legacy - kept for backward compatibility
  subcategory?: string;  // Legacy - kept for backward compatibility
  difficulty?: 'Easy' | 'Medium' | 'Hard';  // Legacy - kept for backward compatibility
  tags?: string[];
  author?: string;
  createdAt: string;
  updatedAt: string;
}

export interface StorageBenchmarkRunConfig {
  id: string;
  name: string;
  description?: string;
  agentKey: string;  // Agent key (matches server route behavior)
  agentId?: string;  // Legacy field name (for backwards compatibility)
  modelId: string;
  headers?: Record<string, string>;
  iterationCount?: number;
  createdAt: string;
  results?: Record<string, { reportId: string; status: string }>;
  status?: string;
  stats?: { passed: number; failed: number; pending: number; total: number };
}

export interface StorageBenchmark {
  id: string;
  name: string;
  description?: string;
  author?: string;
  createdAt: string;
  llmJudgePrompt?: string;
  testCaseIds: string[];
  runs: StorageBenchmarkRunConfig[];
}

// Backwards compatibility aliases
/** @deprecated Use StorageBenchmarkRunConfig instead */
export type StorageExperimentRunConfig = StorageBenchmarkRunConfig;
/** @deprecated Use StorageBenchmark instead */
export type StorageExperiment = StorageBenchmark;

export interface StorageRunAnnotation {
  id: string;
  text: string;
  tags?: string[];
  author?: string;
  createdAt: string;
  updatedAt: string;
}

export interface StorageRun {
  id: string;
  name?: string;
  description?: string;
  experimentId: string;
  experimentRunId: string;
  testCaseId: string;
  testCaseVersionId: string;
  agentId: string;
  modelId: string;
  iteration: number;
  author?: string;
  createdAt: string;
  status: 'running' | 'completed' | 'failed';
  passFailStatus?: 'passed' | 'failed';
  traceId?: string;
  tags?: string[];
  actualOutcomes?: unknown[];
  llmJudgeReasoning?: string;
  metrics?: {
    accuracy?: number;
    faithfulness?: number;
    latency_score?: number;
    trajectory_alignment_score?: number;
  };
  annotations?: StorageRunAnnotation[];
  trajectory?: unknown[];
  rawEvents?: unknown[];
  logs?: unknown[];
  improvementStrategies?: {
    category: string;
    issue: string;
    recommendation: string;
    priority: 'high' | 'medium' | 'low';
  }[];
}

export interface StorageAnalyticsRecord {
  analyticsId: string;
  runId: string;
  experimentId: string;
  experimentRunId: string;
  testCaseId: string;
  testCaseVersionId?: string;
  traceId?: string;
  experimentName?: string;
  testCaseName?: string;
  testCaseCategory?: string;
  testCaseDifficulty?: string;
  agentId: string;
  modelId: string;
  iteration: number;
  tags?: string[];
  passFailStatus?: string;
  status?: string;
  createdAt: string;
  author?: string;
  [key: string]: unknown; // For metric_* fields
}

// ==================== Admin API ====================

export const storageAdmin = {
  /**
   * Check storage health/connectivity
   */
  async health(): Promise<{ status: string; cluster?: unknown; error?: string }> {
    return request('GET', '/health');
  },

  /**
   * Initialize all indexes with mappings
   */
  async initIndexes(): Promise<{ success: boolean; results: Record<string, { status: string; error?: string }> }> {
    return request('POST', '/init-indexes');
  },

  /**
   * Get storage statistics
   */
  async stats(): Promise<{ stats: Record<string, { count: number; error?: string }> }> {
    return request('GET', '/stats');
  },
};

// ==================== Test Cases API ====================

export const testCaseStorage = {
  /**
   * Get all test cases (latest versions only)
   * @param options.fields - 'summary' for lightweight list-view payload
   * @param options.size - page size for pagination
   * @param options.after - cursor token for next page
   */
  async getAll(options?: { fields?: 'summary'; size?: number; after?: string }): Promise<{
    testCases: StorageTestCase[];
    total: number;
    after?: string | null;
    hasMore?: boolean;
  }> {
    const params = new URLSearchParams();
    if (options?.fields) params.append('fields', options.fields);
    if (options?.size) params.append('size', options.size.toString());
    if (options?.after) params.append('after', options.after);
    const query = params.toString() ? `?${params.toString()}` : '';
    return request('GET', `/test-cases${query}`);
  },

  /**
   * Get test cases by specific IDs (latest versions only)
   * Used for efficient filtered fetching (e.g., only test cases in a benchmark)
   */
  async getByIds(ids: string[]): Promise<StorageTestCase[]> {
    if (ids.length === 0) return [];
    const idsParam = ids.join(',');
    const result = await request<{ testCases: StorageTestCase[]; total: number }>('GET', `/test-cases?ids=${idsParam}`);
    return result.testCases;
  },

  /**
   * Get test case by ID (latest version)
   */
  async getById(id: string): Promise<StorageTestCase | null> {
    try {
      return await request<StorageTestCase>('GET', `/test-cases/${id}`);
    } catch (error) {
      const msg = (error as Error).message.toLowerCase();
      if (msg.includes('404') || msg.includes('not found')) {
        return null;
      }
      throw error;
    }
  },

  /**
   * Get all versions of a test case
   */
  async getVersions(id: string): Promise<StorageTestCase[]> {
    const result = await request<{ versions: StorageTestCase[]; total: number }>('GET', `/test-cases/${id}/versions`);
    return result.versions;
  },

  /**
   * Get specific version of a test case
   */
  async getVersion(id: string, version: number): Promise<StorageTestCase | null> {
    try {
      return await request<StorageTestCase>('GET', `/test-cases/${id}/versions/${version}`);
    } catch (error) {
      const msg = (error as Error).message.toLowerCase();
      if (msg.includes('404') || msg.includes('not found')) {
        return null;
      }
      throw error;
    }
  },

  /**
   * Create new test case (starts at version 1)
   */
  async create(testCase: Omit<StorageTestCase, 'id' | 'version' | 'createdAt' | 'updatedAt'>): Promise<StorageTestCase> {
    return request<StorageTestCase>('POST', '/test-cases', testCase);
  },

  /**
   * Update test case (creates new version)
   */
  async update(id: string, testCase: Partial<StorageTestCase>): Promise<StorageTestCase> {
    return request<StorageTestCase>('PUT', `/test-cases/${id}`, testCase);
  },

  /**
   * Delete test case (all versions)
   */
  async delete(id: string): Promise<{ deleted: number }> {
    return request<{ deleted: number }>('DELETE', `/test-cases/${id}`);
  },

  /**
   * Bulk create test cases
   */
  async bulkCreate(testCases: Partial<StorageTestCase>[]): Promise<{ created: number; errors: boolean }> {
    return request<{ created: number; errors: boolean }>('POST', '/test-cases/bulk', { testCases });
  },
};

// ==================== Benchmarks API ====================

export const benchmarkStorage = {
  /**
   * Get all benchmarks
   */
  async getAll(): Promise<StorageBenchmark[]> {
    const result = await request<{ benchmarks: StorageBenchmark[]; total: number }>('GET', '/benchmarks');
    return result.benchmarks;
  },

  /**
   * Get benchmark by ID
   * @param options.fields - 'polling' for lightweight payload (excludes versions, testCaseSnapshots, headers)
   * @param options.runsSize - max number of runs to return
   * @param options.runsOffset - offset into runs array for pagination
   */
  async getById(id: string, options?: { fields?: 'polling'; runsSize?: number; runsOffset?: number }): Promise<StorageBenchmark | null> {
    try {
      const params = new URLSearchParams();
      if (options?.fields) params.append('fields', options.fields);
      if (options?.runsSize !== undefined) params.append('runsSize', options.runsSize.toString());
      if (options?.runsOffset !== undefined) params.append('runsOffset', options.runsOffset.toString());
      const query = params.toString() ? `?${params.toString()}` : '';
      return await request<StorageBenchmark>('GET', `/benchmarks/${id}${query}`);
    } catch (error) {
      const msg = (error as Error).message.toLowerCase();
      if (msg.includes('404') || msg.includes('not found')) {
        return null;
      }
      throw error;
    }
  },

  /**
   * Create benchmark
   */
  async create(benchmark: Omit<StorageBenchmark, 'id' | 'createdAt'>): Promise<StorageBenchmark> {
    return request<StorageBenchmark>('POST', '/benchmarks', benchmark);
  },

  /**
   * Update benchmark (for run management)
   */
  async update(id: string, benchmark: Partial<StorageBenchmark>): Promise<StorageBenchmark> {
    return request<StorageBenchmark>('PUT', `/benchmarks/${id}`, benchmark);
  },

  /**
   * Delete benchmark
   */
  async delete(id: string): Promise<{ deleted: boolean }> {
    return request<{ deleted: boolean }>('DELETE', `/benchmarks/${id}`);
  },

  /**
   * Bulk create benchmarks
   */
  async bulkCreate(benchmarks: Partial<StorageBenchmark>[]): Promise<{ created: number; errors: boolean }> {
    return request<{ created: number; errors: boolean }>('POST', '/benchmarks/bulk', { benchmarks });
  },

  /**
   * Update benchmark metadata only (name, description)
   */
  async updateMetadata(id: string, updates: { name?: string; description?: string }): Promise<StorageBenchmark> {
    return request<StorageBenchmark>('PATCH', `/benchmarks/${id}/metadata`, updates);
  },

  /**
   * Get all versions of a benchmark
   */
  async getVersions(id: string): Promise<{ versions: any[]; total: number }> {
    return request<{ versions: any[]; total: number }>('GET', `/benchmarks/${id}/versions`);
  },

  /**
   * Get specific version of a benchmark
   */
  async getVersion(id: string, version: number): Promise<any> {
    return request<any>('GET', `/benchmarks/${id}/versions/${version}`);
  },
};

// Backwards compatibility alias
/** @deprecated Use benchmarkStorage instead */
export const experimentStorage = benchmarkStorage;

// ==================== Runs API ====================

export const runStorage = {
  /**
   * Get all runs with pagination
   */
  async getAll(options: { size?: number; from?: number } = {}): Promise<{
    runs: StorageRun[];
    total: number;
    size: number;
    from: number;
  }> {
    const params = new URLSearchParams();
    if (options.size) params.append('size', options.size.toString());
    if (options.from) params.append('from', options.from.toString());
    const query = params.toString() ? `?${params.toString()}` : '';
    return request('GET', `/runs${query}`);
  },

  /**
   * Get run by ID
   */
  async getById(id: string): Promise<StorageRun | null> {
    try {
      return await request<StorageRun>('GET', `/runs/${id}`);
    } catch (error) {
      const msg = (error as Error).message.toLowerCase();
      if (msg.includes('404') || msg.includes('not found')) {
        return null;
      }
      throw error;
    }
  },

  /**
   * Create run
   */
  async create(run: Omit<StorageRun, 'id' | 'createdAt' | 'annotations'>, options?: { analytics?: boolean }): Promise<StorageRun> {
    const query = options?.analytics === false ? '?analytics=false' : '';
    return request<StorageRun>('POST', `/runs${query}`, run);
  },

  /**
   * Delete run
   */
  async delete(id: string): Promise<{ deleted: boolean }> {
    return request<{ deleted: boolean }>('DELETE', `/runs/${id}`);
  },

  /**
   * Partial update of a run
   * Used for updating trace-mode runs after traces become available
   */
  async partialUpdate(id: string, updates: Partial<StorageRun>): Promise<StorageRun> {
    return request<StorageRun>('PATCH', `/runs/${id}`, updates);
  },

  /**
   * Get run counts grouped by test case ID (single aggregation query)
   */
  async getCountsByTestCase(): Promise<Record<string, number>> {
    const result = await request<{ counts: Record<string, number> }>('GET', '/runs/counts-by-test-case');
    return result.counts;
  },

  /**
   * Get runs by test case ID
   */
  async getByTestCase(testCaseId: string, size?: number, from?: number): Promise<{ runs: StorageRun[]; total: number }> {
    const params = new URLSearchParams();
    if (size !== undefined) params.set('size', String(size));
    if (from !== undefined) params.set('from', String(from));
    const query = params.toString() ? `?${params}` : '';
    return request<{ runs: StorageRun[]; total: number }>('GET', `/runs/by-test-case/${testCaseId}${query}`);
  },

  /**
   * Get runs by benchmark ID
   */
  async getByBenchmark(benchmarkId: string, size?: number): Promise<StorageRun[]> {
    const query = size ? `?size=${size}` : '';
    const result = await request<{ runs: StorageRun[]; total: number }>('GET', `/runs/by-benchmark/${benchmarkId}${query}`);
    return result.runs;
  },

  /**
   * Get runs by benchmark run config ID
   */
  async getByBenchmarkRun(benchmarkId: string, runId: string, size?: number): Promise<StorageRun[]> {
    const query = size ? `?size=${size}` : '';
    const result = await request<{ runs: StorageRun[]; total: number }>('GET', `/runs/by-benchmark-run/${benchmarkId}/${runId}${query}`);
    return result.runs;
  },

  /**
   * Get all iterations for a test case in a benchmark
   */
  async getIterations(benchmarkId: string, testCaseId: string, benchmarkRunId?: string): Promise<{
    runs: StorageRun[];
    total: number;
    maxIteration: number;
  }> {
    const params = new URLSearchParams();
    if (benchmarkRunId) params.append('benchmarkRunId', benchmarkRunId);
    const query = params.toString() ? `?${params.toString()}` : '';
    return request('GET', `/runs/iterations/${benchmarkId}/${testCaseId}${query}`);
  },

  // Backwards compatibility aliases
  /** @deprecated Use getByBenchmark instead */
  async getByExperiment(experimentId: string, size?: number): Promise<StorageRun[]> {
    return this.getByBenchmark(experimentId, size);
  },

  /** @deprecated Use getByBenchmarkRun instead */
  async getByExperimentRun(experimentId: string, runId: string, size?: number): Promise<StorageRun[]> {
    return this.getByBenchmarkRun(experimentId, runId, size);
  },

  /**
   * Search runs with filters
   */
  async search(filters: {
    experimentId?: string;
    testCaseId?: string;
    experimentRunId?: string;
    agentId?: string;
    modelId?: string;
    status?: string;
    passFailStatus?: string;
    tags?: string[];
    dateRange?: { start: string; end: string };
    size?: number;
    from?: number;
  }): Promise<{ runs: StorageRun[]; total: number }> {
    return request('POST', '/runs/search', filters);
  },

  /**
   * Add annotation to run
   */
  async addAnnotation(runId: string, annotation: Omit<StorageRunAnnotation, 'id' | 'createdAt' | 'updatedAt'>): Promise<StorageRunAnnotation> {
    return request<StorageRunAnnotation>('POST', `/runs/${runId}/annotations`, annotation);
  },

  /**
   * Update annotation
   */
  async updateAnnotation(runId: string, annotationId: string, updates: Partial<StorageRunAnnotation>): Promise<StorageRunAnnotation> {
    return request<StorageRunAnnotation>('PUT', `/runs/${runId}/annotations/${annotationId}`, updates);
  },

  /**
   * Delete annotation
   */
  async deleteAnnotation(runId: string, annotationId: string): Promise<{ deleted: boolean }> {
    return request<{ deleted: boolean }>('DELETE', `/runs/${runId}/annotations/${annotationId}`);
  },

  /**
   * Bulk create runs
   */
  async bulkCreate(runs: Partial<StorageRun>[]): Promise<{ created: number; errors: boolean }> {
    return request<{ created: number; errors: boolean }>('POST', '/runs/bulk', { runs });
  },
};

// ==================== Analytics API ====================

export const analyticsStorage = {
  /**
   * Query analytics records
   */
  async query(filters: {
    experimentId?: string;
    testCaseId?: string;
    agentId?: string;
    modelId?: string;
    passFailStatus?: string;
    size?: number;
    from?: number;
  }): Promise<{ records: StorageAnalyticsRecord[]; total: number }> {
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]) => {
      if (value !== undefined) params.append(key, value.toString());
    });
    const query = params.toString() ? `?${params.toString()}` : '';
    return request('GET', `/analytics${query}`);
  },

  /**
   * Get aggregated metrics
   */
  async aggregations(experimentId?: string, groupBy?: string): Promise<{
    aggregations: Array<{
      key: string;
      metrics: {
        avgAccuracy?: number;
        avgFaithfulness?: number;
        avgLatency?: number;
        avgTrajectory?: number;
      };
      passCount: number;
      failCount: number;
      totalRuns: number;
    }>;
    groupBy: string;
  }> {
    const params = new URLSearchParams();
    if (experimentId) params.append('experimentId', experimentId);
    if (groupBy) params.append('groupBy', groupBy);
    const query = params.toString() ? `?${params.toString()}` : '';
    return request('GET', `/analytics/aggregations${query}`);
  },

  /**
   * Complex search with custom filters and aggregations
   */
  async search(options: {
    filters?: Record<string, unknown>;
    aggs?: Record<string, unknown>;
    size?: number;
    from?: number;
  }): Promise<{
    records: StorageAnalyticsRecord[];
    total: number;
    aggregations: Record<string, unknown>;
  }> {
    return request('POST', '/analytics/search', options);
  },

  /**
   * Backfill analytics from existing runs
   */
  async backfill(): Promise<{ backfilled: number; errors: number; total: number }> {
    return request('POST', '/backfill-analytics');
  },
};

// ==================== Combined Export ====================

export const opensearchStorage = {
  admin: storageAdmin,
  testCases: testCaseStorage,
  benchmarks: benchmarkStorage,
  runs: runStorage,
  analytics: analyticsStorage,
  // Backwards compatibility alias
  /** @deprecated Use benchmarks instead */
  experiments: benchmarkStorage,
};

export default opensearchStorage;
