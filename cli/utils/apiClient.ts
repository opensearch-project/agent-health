/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CLI HTTP Client for Server API
 *
 * Thin wrapper around the Agent Health server HTTP API.
 * Follows the server-mediated architecture pattern.
 */

import type { Benchmark, BenchmarkRun, BenchmarkProgress, RunConfigInput, TestCaseRun, StorageMetadata, AgentConfig, ModelConfig, TestCase } from '@/types/index.js';

/**
 * Health check response from server
 */
export interface HealthResponse {
  status: string;
  version: string;
  service: string;
}

/**
 * SSE event types from benchmark execution
 */
export type BenchmarkExecutionEvent =
  | { type: 'started'; runId: string; testCases: Array<{ id: string; name: string; status: string }> }
  | { type: 'progress'; currentTestCaseIndex: number; totalTestCases: number; currentTestCase: { id: string; name: string }; result?: any }
  | { type: 'completed'; run: BenchmarkRun }
  | { type: 'cancelled'; run: BenchmarkRun }
  | { type: 'error'; error: string; runId?: string };

/**
 * Progress callback for benchmark execution
 */
export type ProgressCallback = (event: BenchmarkExecutionEvent) => void;

/**
 * Response wrapper with storage metadata
 */
export interface ListResponseWithMeta<T> {
  data: T[];
  total: number;
  meta: StorageMetadata;
}

/**
 * Model config with key included
 */
export interface ModelWithKey extends ModelConfig {
  key: string;
}

/**
 * Evaluation progress events from SSE stream
 */
export type EvaluationProgressEvent =
  | { type: 'started'; testCase: string; agent: string }
  | { type: 'step'; stepIndex: number; step: { type: string; content: string } }
  | { type: 'completed'; report: EvaluationResult }
  | { type: 'error'; error: string };

/**
 * Evaluation result summary from server
 */
export interface EvaluationResult {
  id: string;
  status: string;
  passFailStatus?: 'passed' | 'failed';
  metrics?: {
    accuracy: number;
    faithfulness?: number;
    latency_score?: number;
    trajectory_alignment_score?: number;
  };
  trajectorySteps: number;
  llmJudgeReasoning?: string;
}

/**
 * API Client for Agent Health server
 */
export class ApiClient {
  constructor(private baseUrl: string) {}

  /**
   * Check if server is healthy
   */
  async checkHealth(): Promise<HealthResponse> {
    const res = await fetch(`${this.baseUrl}/health`);
    if (!res.ok) {
      throw new Error(`Server health check failed: ${res.status} ${res.statusText}`);
    }
    return res.json();
  }

  /**
   * List all benchmarks
   */
  async listBenchmarks(): Promise<Benchmark[]> {
    const res = await fetch(`${this.baseUrl}/api/storage/benchmarks`);
    if (!res.ok) {
      throw new Error(`Failed to list benchmarks: ${res.status} ${res.statusText}`);
    }
    const data = await res.json();
    return data.benchmarks || [];
  }

  /**
   * Get benchmark by ID
   */
  async getBenchmark(id: string): Promise<Benchmark | null> {
    const res = await fetch(`${this.baseUrl}/api/storage/benchmarks/${encodeURIComponent(id)}`);
    if (res.status === 404) {
      return null;
    }
    if (!res.ok) {
      throw new Error(`Failed to get benchmark: ${res.status} ${res.statusText}`);
    }
    return res.json();
  }

  /**
   * Find benchmark by name or ID
   *
   * Prioritizes:
   * 1. Exact ID match
   * 2. Exact name match (case-sensitive)
   */
  async findBenchmark(identifier: string): Promise<Benchmark | null> {
    // 1. Exact ID match
    const byId = await this.getBenchmark(identifier);
    if (byId) {
      return byId;
    }

    // 2. Exact name match (case-sensitive)
    const benchmarks = await this.listBenchmarks();
    return benchmarks.find((b) => b.name === identifier) || null;
  }

  /**
   * Execute benchmark run (SSE stream)
   *
   * Streams progress events and returns the completed run.
   * If the SSE stream disconnects, falls back to polling for status.
   */
  async executeBenchmark(
    benchmarkId: string,
    runConfig: RunConfigInput,
    onProgress?: ProgressCallback
  ): Promise<BenchmarkRun> {
    const res = await fetch(
      `${this.baseUrl}/api/storage/benchmarks/${encodeURIComponent(benchmarkId)}/execute`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(runConfig),
      }
    );

    if (!res.ok) {
      const errorBody = await res.text();
      let errorMessage: string;
      try {
        const parsed = JSON.parse(errorBody);
        errorMessage = parsed.error || errorBody;
      } catch {
        errorMessage = errorBody;
      }
      throw new Error(`Failed to execute benchmark: ${errorMessage}`);
    }

    // Parse SSE stream
    if (!res.body) {
      throw new Error('Response body is missing');
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalRun: BenchmarkRun | null = null;
    let runId: string | null = null;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const event: BenchmarkExecutionEvent = JSON.parse(line.slice(6));
              onProgress?.(event);

              // Capture runId from started event for fallback polling
              if (event.type === 'started') {
                runId = event.runId;
              } else if (event.type === 'completed' || event.type === 'cancelled') {
                finalRun = event.run;
              } else if (event.type === 'error') {
                throw new Error(event.error);
              }
            } catch (e) {
              // Skip non-JSON lines (incomplete chunks)
              if (e instanceof SyntaxError) continue;
              throw e;
            }
          }
        }
      }
    } catch (streamError) {
      // Stream disconnected - check if we can recover by polling
      if (runId) {
        console.warn(`[ApiClient] SSE stream disconnected: ${streamError instanceof Error ? streamError.message : streamError}`);
        console.warn(`[ApiClient] Falling back to polling for run ${runId}...`);

        // Wait a moment for any in-flight operations to settle
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Poll for final status
        const polledRun = await this.pollRunStatus(benchmarkId, runId, (run) => {
          // Create a progress event from the polled run state
          const completedCount = Object.values(run.results || {}).filter(
            r => r.status === 'completed' || r.status === 'failed'
          ).length;
          const totalCount = Object.keys(run.results || {}).length;

          onProgress?.({
            type: 'progress',
            currentTestCaseIndex: completedCount - 1,
            totalTestCases: totalCount,
            currentTestCase: { id: 'polling', name: 'Polling for status...' },
          });
        });

        if (polledRun) {
          return polledRun;
        }
      }

      // Re-throw if we couldn't recover
      throw streamError;
    } finally {
      try {
        await reader.cancel();
      } catch {
        // Ignore cancellation errors
      }
    }

    if (!finalRun) {
      // Stream ended without final event - try polling
      if (runId) {
        console.warn('[ApiClient] SSE stream ended without completion event, polling for status...');
        const polledRun = await this.pollRunStatus(benchmarkId, runId);
        if (polledRun) {
          return polledRun;
        }
      }
      throw new Error('No final run received from server');
    }

    return finalRun;
  }

  /**
   * Cancel an in-progress benchmark run
   */
  async cancelRun(benchmarkId: string, runId: string): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}/api/storage/benchmarks/${encodeURIComponent(benchmarkId)}/cancel`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId }),
      }
    );

    if (!res.ok) {
      const errorBody = await res.text();
      throw new Error(`Failed to cancel run: ${errorBody}`);
    }
  }

  /**
   * Get a specific run from a benchmark by ID.
   *
   * Fetches the benchmark and extracts the run with the matching ID.
   *
   * @param benchmarkId - The benchmark ID
   * @param runId - The run ID within the benchmark
   * @returns The run if found, null otherwise
   */
  async getRun(benchmarkId: string, runId: string): Promise<BenchmarkRun | null> {
    const benchmark = await this.getBenchmark(benchmarkId);
    if (!benchmark) {
      return null;
    }

    return benchmark.runs?.find(r => r.id === runId) || null;
  }

  /**
   * Poll a run until it reaches a terminal state (completed, failed, cancelled).
   *
   * Used as a fallback when SSE stream connection is lost but server continues
   * processing in the background.
   *
   * @param benchmarkId - The benchmark ID
   * @param runId - The run ID to poll
   * @param onProgress - Optional callback for progress updates during polling
   * @param timeoutMs - Maximum time to wait (default: 10 minutes)
   * @returns The final run state, or null if not found
   */
  async pollRunStatus(
    benchmarkId: string,
    runId: string,
    onProgress?: (run: BenchmarkRun) => void,
    timeoutMs = 600000
  ): Promise<BenchmarkRun | null> {
    const startTime = Date.now();
    const pollInterval = 5000; // 5 seconds

    while (Date.now() - startTime < timeoutMs) {
      const run = await this.getRun(benchmarkId, runId);
      if (!run) return null;

      // Notify progress callback
      onProgress?.(run);

      // Check for terminal states
      if (run.status && ['completed', 'failed', 'cancelled'].includes(run.status)) {
        return run;
      }

      // Wait before next poll
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    // Timeout reached - return current state
    return this.getRun(benchmarkId, runId);
  }

  /**
   * Get a single report (TestCaseRun) by ID.
   *
   * This is the preferred method for fetching reports - use report IDs
   * from run.results[testCaseId].reportId.
   *
   * @param reportId - The report ID to fetch
   * @returns The report if found, null otherwise
   */
  async getReportById(reportId: string): Promise<TestCaseRun | null> {
    const res = await fetch(
      `${this.baseUrl}/api/storage/runs/${encodeURIComponent(reportId)}`
    );

    if (res.status === 404) {
      return null;
    }

    if (!res.ok) {
      throw new Error(`Failed to get report: ${res.status} ${res.statusText}`);
    }

    return res.json();
  }

  /**
   * List all test cases (basic)
   */
  async listTestCases(): Promise<Array<{ id: string; name: string }>> {
    const res = await fetch(`${this.baseUrl}/api/storage/test-cases`);
    if (!res.ok) {
      throw new Error(`Failed to list test cases: ${res.status} ${res.statusText}`);
    }
    const data = await res.json();
    return data.testCases || [];
  }

  /**
   * List all test cases with full data and metadata
   */
  async listTestCasesWithMeta(): Promise<ListResponseWithMeta<TestCase>> {
    const res = await fetch(`${this.baseUrl}/api/storage/test-cases`);
    if (!res.ok) {
      throw new Error(`Failed to list test cases: ${res.status} ${res.statusText}`);
    }
    const data = await res.json();
    return {
      data: data.testCases || [],
      total: data.total || 0,
      meta: data.meta || {
        storageConfigured: false,
        storageReachable: false,
        realDataCount: 0,
        sampleDataCount: data.testCases?.length || 0,
      },
    };
  }

  /**
   * List all benchmarks with metadata
   */
  async listBenchmarksWithMeta(): Promise<ListResponseWithMeta<Benchmark>> {
    const res = await fetch(`${this.baseUrl}/api/storage/benchmarks`);
    if (!res.ok) {
      throw new Error(`Failed to list benchmarks: ${res.status} ${res.statusText}`);
    }
    const data = await res.json();
    return {
      data: data.benchmarks || [],
      total: data.total || 0,
      meta: data.meta || {
        storageConfigured: false,
        storageReachable: false,
        realDataCount: 0,
        sampleDataCount: data.benchmarks?.length || 0,
      },
    };
  }

  /**
   * List all configured agents
   */
  async listAgents(): Promise<AgentConfig[]> {
    const res = await fetch(`${this.baseUrl}/api/agents`);
    if (!res.ok) {
      throw new Error(`Failed to list agents: ${res.status} ${res.statusText}`);
    }
    const data = await res.json();
    return data.agents || [];
  }

  /**
   * List all configured models
   */
  async listModels(): Promise<ModelWithKey[]> {
    const res = await fetch(`${this.baseUrl}/api/models`);
    if (!res.ok) {
      throw new Error(`Failed to list models: ${res.status} ${res.statusText}`);
    }
    const data = await res.json();
    return data.models || [];
  }

  /**
   * Get a single test case by ID
   */
  async getTestCase(id: string): Promise<TestCase | null> {
    const res = await fetch(`${this.baseUrl}/api/storage/test-cases/${encodeURIComponent(id)}`);
    if (res.status === 404) {
      return null;
    }
    if (!res.ok) {
      throw new Error(`Failed to get test case: ${res.status} ${res.statusText}`);
    }
    return res.json();
  }

  /**
   * Find test case by ID or name
   */
  async findTestCase(identifier: string): Promise<TestCase | null> {
    // Try by ID first
    const byId = await this.getTestCase(identifier);
    if (byId) {
      return byId;
    }

    // Fall back to name match
    const response = await this.listTestCasesWithMeta();
    return response.data.find(tc =>
      tc.name.toLowerCase() === identifier.toLowerCase()
    ) || null;
  }

  /**
   * Evaluation progress event types
   */

  /**
   * Run a single test case evaluation via server API (SSE stream)
   */
  async runEvaluation(
    testCaseId: string,
    agentKey: string,
    modelId: string,
    onProgress?: (event: EvaluationProgressEvent) => void
  ): Promise<EvaluationResult> {
    const res = await fetch(`${this.baseUrl}/api/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ testCaseId, agentKey, modelId }),
    });

    if (!res.ok) {
      const errorBody = await res.text();
      let errorMessage: string;
      try {
        const parsed = JSON.parse(errorBody);
        errorMessage = parsed.error || errorBody;
      } catch {
        errorMessage = errorBody;
      }
      throw new Error(`Failed to run evaluation: ${errorMessage}`);
    }

    // Parse SSE stream
    if (!res.body) {
      throw new Error('Response body is missing');
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let result: EvaluationResult | null = null;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const event = JSON.parse(line.slice(6));
              onProgress?.(event);

              if (event.type === 'completed') {
                result = event.report;
              } else if (event.type === 'error') {
                throw new Error(event.error);
              }
            } catch (e) {
              // Skip non-JSON lines (incomplete chunks)
              if (e instanceof SyntaxError) continue;
              throw e;
            }
          }
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        // Ignore cancellation errors
      }
    }

    if (!result) {
      throw new Error('No result received from evaluation');
    }

    return result;
  }

  /**
   * Create a new benchmark
   */
  async createBenchmark(input: {
    name: string;
    description?: string;
    testCaseIds: string[];
  }): Promise<Benchmark> {
    const res = await fetch(`${this.baseUrl}/api/storage/benchmarks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });

    if (!res.ok) {
      const errorBody = await res.text();
      throw new Error(`Failed to create benchmark: ${errorBody}`);
    }

    return res.json();
  }
}
