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
import { getStorageConfigHeaders } from '@/lib/dataSourceConfig';

const STORAGE_BASE_URL = ENV_CONFIG.storageApiUrl;

/**
 * Generic HTTP client for storage API
 * Includes storage config headers from localStorage when available
 */
async function request<T>(
  method: string,
  endpoint: string,
  body?: unknown
): Promise<T> {
  const url = `${STORAGE_BASE_URL}${endpoint}`;

  // Get storage config headers from localStorage (if configured)
  const storageHeaders = getStorageConfigHeaders();

  const options: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...storageHeaders,
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

export interface StorageExperimentRunConfig {
  id: string;
  name: string;
  description?: string;
  agentId: string;
  modelId: string;
  headers?: Record<string, string>;
  iterationCount?: number;
  createdAt: string;
  results?: Record<string, { reportId: string; status: string }>;
}

export interface StorageExperiment {
  id: string;
  name: string;
  description?: string;
  author?: string;
  createdAt: string;
  llmJudgePrompt?: string;
  testCaseIds: string[];
  runs: StorageExperimentRunConfig[];
}

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
   */
  async getAll(): Promise<StorageTestCase[]> {
    const result = await request<{ testCases: StorageTestCase[]; total: number }>('GET', '/test-cases');
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

// ==================== Experiments API ====================

export const experimentStorage = {
  /**
   * Get all experiments
   */
  async getAll(): Promise<StorageExperiment[]> {
    const result = await request<{ experiments: StorageExperiment[]; total: number }>('GET', '/experiments');
    return result.experiments;
  },

  /**
   * Get experiment by ID
   */
  async getById(id: string): Promise<StorageExperiment | null> {
    try {
      return await request<StorageExperiment>('GET', `/experiments/${id}`);
    } catch (error) {
      const msg = (error as Error).message.toLowerCase();
      if (msg.includes('404') || msg.includes('not found')) {
        return null;
      }
      throw error;
    }
  },

  /**
   * Create experiment
   */
  async create(experiment: Omit<StorageExperiment, 'id' | 'createdAt'>): Promise<StorageExperiment> {
    return request<StorageExperiment>('POST', '/experiments', experiment);
  },

  /**
   * Update experiment (for run management)
   */
  async update(id: string, experiment: Partial<StorageExperiment>): Promise<StorageExperiment> {
    return request<StorageExperiment>('PUT', `/experiments/${id}`, experiment);
  },

  /**
   * Delete experiment
   */
  async delete(id: string): Promise<{ deleted: boolean }> {
    return request<{ deleted: boolean }>('DELETE', `/experiments/${id}`);
  },

  /**
   * Bulk create experiments
   */
  async bulkCreate(experiments: Partial<StorageExperiment>[]): Promise<{ created: number; errors: boolean }> {
    return request<{ created: number; errors: boolean }>('POST', '/experiments/bulk', { experiments });
  },
};

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
   * Get runs by test case ID
   */
  async getByTestCase(testCaseId: string, size?: number): Promise<StorageRun[]> {
    const query = size ? `?size=${size}` : '';
    const result = await request<{ runs: StorageRun[]; total: number }>('GET', `/runs/by-test-case/${testCaseId}${query}`);
    return result.runs;
  },

  /**
   * Get runs by experiment ID
   */
  async getByExperiment(experimentId: string, size?: number): Promise<StorageRun[]> {
    const query = size ? `?size=${size}` : '';
    const result = await request<{ runs: StorageRun[]; total: number }>('GET', `/runs/by-experiment/${experimentId}${query}`);
    return result.runs;
  },

  /**
   * Get runs by experiment run config ID
   */
  async getByExperimentRun(experimentId: string, runId: string, size?: number): Promise<StorageRun[]> {
    const query = size ? `?size=${size}` : '';
    const result = await request<{ runs: StorageRun[]; total: number }>('GET', `/runs/by-experiment-run/${experimentId}/${runId}${query}`);
    return result.runs;
  },

  /**
   * Get all iterations for a test case in an experiment
   */
  async getIterations(experimentId: string, testCaseId: string, experimentRunId?: string): Promise<{
    runs: StorageRun[];
    total: number;
    maxIteration: number;
  }> {
    const params = new URLSearchParams();
    if (experimentRunId) params.append('experimentRunId', experimentRunId);
    const query = params.toString() ? `?${params.toString()}` : '';
    return request('GET', `/runs/iterations/${experimentId}/${testCaseId}${query}`);
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
  experiments: experimentStorage,
  runs: runStorage,
  analytics: analyticsStorage,
};

export default opensearchStorage;
