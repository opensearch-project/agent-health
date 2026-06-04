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

import type { Benchmark, BenchmarkRun, BenchmarkProgress, RunConfigInput, TestCaseRun, StorageMetadata, AgentConfig, ModelConfig, TestCase, Evaluator, EvaluationRun, TestCaseSource } from '@/types/index.js';

/**
 * Error thrown when the server sends an explicit error event via SSE.
 * Distinguished from network/stream disconnects so the CLI can handle them differently.
 */
export class ServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServerError';
  }
}

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
  | { type: 'progress'; currentTestCaseIndex: number; totalTestCases: number; currentTestCase: { id: string; name: string }; completedCount?: number; result?: any }
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
  | { type: 'started'; testCase: string; agent: string; reportId?: string }
  | { type: 'heartbeat' }
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
 * Response from bulk importing test cases.
 *
 * The same `/api/storage/test-cases/bulk` endpoint serves two modes:
 *  - JSON imports / UI uploads (no `sourceFile`) → `created` / `errors` only.
 *  - SDK / code imports (`sourceFile` set on at least one item) → also returns
 *    `updated` and `unchanged` from the underlying `bulkUpsert`. Callers can
 *    branch on `typeof updated !== 'undefined'` to render the upsert summary.
 */
export interface BulkCreateTestCasesResponse {
  created: number;
  errors: number;
  testCases: Array<{ id: string; name: string }>;
  /** Present only on the SDK / code-import upsert path. */
  updated?: number;
  /** Present only on the SDK / code-import upsert path. */
  unchanged?: number;
}

/**
 * API Client for Agent Health server
 */
export class ApiClient {
  constructor(private baseUrl: string) {}

  /**
   * Generic polling loop: fetches a resource repeatedly until it reaches a terminal state.
   * Shared by pollRunStatus (benchmarks) and pollReportStatus (single evaluations).
   */
  private async pollUntilTerminal<T>(
    fetchFn: () => Promise<T | null>,
    isTerminal: (item: T) => boolean,
    options?: { timeoutMs?: number; intervalMs?: number; onPoll?: (item: T) => void }
  ): Promise<T | null> {
    const timeoutMs = options?.timeoutMs ?? 600000;
    const intervalMs = options?.intervalMs ?? 5000;
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const item = await fetchFn();
      if (!item) return null;

      options?.onPoll?.(item);

      if (isTerminal(item)) return item;

      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }

    // Timeout — return whatever we have now
    return fetchFn();
  }

  /**
   * Check if server is healthy, with optional retries and exponential backoff.
   */
  async checkHealth(retries = 2, delayMs = 500): Promise<HealthResponse> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(`${this.baseUrl}/health`);
        if (!res.ok) {
          throw new Error(`Server health check failed: ${res.status} ${res.statusText}`);
        }
        return res.json();
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < retries) {
          await new Promise(resolve => setTimeout(resolve, delayMs * Math.pow(2, attempt)));
        }
      }
    }
    throw lastError!;
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
                throw new ServerError(event.error);
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
      // Server-sent error events are explicit failures - don't attempt recovery
      if (streamError instanceof ServerError) {
        throw streamError;
      }

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
   */
  async pollRunStatus(
    benchmarkId: string,
    runId: string,
    onProgress?: (run: BenchmarkRun) => void,
    timeoutMs = 600000
  ): Promise<BenchmarkRun | null> {
    return this.pollUntilTerminal(
      () => this.getRun(benchmarkId, runId),
      (run) => !!run.status && ['completed', 'failed', 'cancelled'].includes(run.status),
      { timeoutMs, onPoll: onProgress }
    );
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
   * Bulk create test cases
   */
  async bulkCreateTestCases(testCases: object[]): Promise<BulkCreateTestCasesResponse> {
    const res = await fetch(`${this.baseUrl}/api/storage/test-cases/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ testCases }),
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
      throw new Error(`Failed to bulk create test cases: ${errorMessage}`);
    }

    return res.json();
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
   * List all evaluators (system + custom)
   */
  async listEvaluators(): Promise<{ evaluators: Evaluator[]; total: number; meta: StorageMetadata }> {
    const res = await fetch(`${this.baseUrl}/api/storage/evaluators`);
    if (!res.ok) {
      throw new Error(`Failed to list evaluators: ${res.status} ${res.statusText}`);
    }
    const data = await res.json();
    return {
      evaluators: data.evaluators || [],
      total: data.total || 0,
      meta: data.meta || {
        storageConfigured: false,
        storageReachable: false,
        realDataCount: data.customCount || 0,
        sampleDataCount: data.systemCount || 0,
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
      tc.name?.toLowerCase() === identifier.toLowerCase()
    ) || null;
  }

  /**
   * Evaluation progress event types
   */

  /**
   * Run a single test case evaluation via server API (SSE stream).
   * Falls back to polling if the SSE stream disconnects mid-evaluation.
   */
  async runEvaluation(
    testCaseId: string,
    agentKey: string,
    modelId: string,
    onProgress?: (event: EvaluationProgressEvent) => void,
    evaluatorId?: string
  ): Promise<EvaluationResult> {
    const res = await fetch(`${this.baseUrl}/api/evaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ testCaseId, agentKey, modelId, evaluatorId }),
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
    let reportId: string | null = null;

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

              // Capture reportId from started event for polling fallback
              if (event.type === 'started' && event.reportId) {
                reportId = event.reportId;
              }

              // Skip heartbeat events (they just keep the connection alive)
              if (event.type === 'heartbeat') continue;

              onProgress?.(event);

              if (event.type === 'completed') {
                result = event.report;
              } else if (event.type === 'error') {
                throw new ServerError(event.error);
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
      // Server-sent error events are explicit failures — don't attempt recovery
      if (streamError instanceof ServerError) {
        throw streamError;
      }

      // If we already have a completed result, return it despite the stream error
      if (result) {
        return result;
      }

      // Stream disconnected — fall back to polling if we have a reportId
      if (reportId) {
        console.warn(`[ApiClient] SSE stream disconnected: ${streamError instanceof Error ? streamError.message : streamError}`);
        console.warn(`[ApiClient] Falling back to polling for report ${reportId} — server is still processing in the background...`);

        // Notify any progress listener so the CLI/UI can update its spinner
        onProgress?.({ type: 'reconnecting', reportId } as any);

        // No artificial delay before polling: pollUntilTerminal already waits
        // 5s between fetches and the report may already be complete on the server.
        const polledResult = await this.pollReportStatus(reportId, undefined, (report) => {
          // Forward intermediate polled status as a progress event
          onProgress?.({ type: 'polling', reportId: report.id, status: report.status } as any);
        });
        if (polledResult) {
          return polledResult;
        }
      }

      throw streamError;
    } finally {
      try {
        await reader.cancel();
      } catch {
        // Ignore cancellation errors
      }
    }

    if (!result) {
      // Stream ended without completed event — try polling
      if (reportId) {
        console.warn('[ApiClient] SSE stream ended without completion event, polling for status...');
        onProgress?.({ type: 'reconnecting', reportId } as any);
        const polledResult = await this.pollReportStatus(reportId, undefined, (report) => {
          onProgress?.({ type: 'polling', reportId: report.id, status: report.status } as any);
        });
        if (polledResult) {
          return polledResult;
        }
      }
      throw new Error('No result received from evaluation');
    }

    return result;
  }

  /**
   * Poll for a single evaluation report's completion status.
   * Used as fallback when the SSE stream disconnects during evaluation.
   *
   * @param reportId   The reportId returned from the SSE 'started' event
   * @param timeoutMs  Max time to keep polling (defaults to 10 minutes)
   * @param onPoll     Optional callback fired on every poll cycle with the latest report
   */
  async pollReportStatus(
    reportId: string,
    timeoutMs: number = 600000,
    onPoll?: (report: TestCaseRun) => void
  ): Promise<EvaluationResult | null> {
    const report = await this.pollUntilTerminal(
      () => this.getReportById(reportId),
      (r) => !!r.status && ['completed', 'failed', 'cancelled'].includes(r.status),
      { timeoutMs, onPoll }
    );

    if (!report) return null;
    return {
      id: report.id,
      status: report.status || 'unknown',
      passFailStatus: report.passFailStatus as 'passed' | 'failed' | undefined,
      metrics: report.metrics as EvaluationResult['metrics'],
      trajectorySteps: report.trajectory?.length || 0,
      llmJudgeReasoning: report.llmJudgeReasoning,
    };
  }

  /**
   * Export benchmark test cases as import-compatible JSON
   */
  async exportBenchmark(benchmarkId: string): Promise<object[]> {
    const res = await fetch(
      `${this.baseUrl}/api/storage/benchmarks/${encodeURIComponent(benchmarkId)}/export`
    );

    if (res.status === 404) {
      throw new Error(`Benchmark not found: ${benchmarkId}`);
    }

    if (!res.ok) {
      throw new Error(`Failed to export benchmark: ${res.status} ${res.statusText}`);
    }

    return res.json();
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

  /**
   * Update an existing benchmark
   */
  async updateBenchmark(id: string, input: {
    name?: string;
    description?: string;
    testCaseIds?: string[];
  }): Promise<Benchmark> {
    const res = await fetch(`${this.baseUrl}/api/storage/benchmarks/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });

    if (!res.ok) {
      const errorBody = await res.text();
      throw new Error(`Failed to update benchmark: ${errorBody}`);
    }

    return res.json();
  }

  /**
   * Fetch traces from OpenSearch with optional filters
   */
  async fetchTraces(params: {
    traceId?: string;
    runIds?: string[];
    serviceName?: string;
    startTime?: string;
    endTime?: string;
    textSearch?: string;
    cursor?: string;
    size?: number;
  }): Promise<{
    spans: any[];
    total: number;
    nextCursor?: string;
    hasMore: boolean;
  }> {
    const res = await fetch(`${this.baseUrl}/api/traces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
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
      throw new Error(`Failed to fetch traces: ${errorMessage}`);
    }

    return res.json();
  }

  // ─── Evaluation Runs ────────────────────────────────────────────────────────

  /**
   * Create and execute an evaluation run with SSE streaming.
   */
  async createEvaluationRun(
    params: {
      name?: string;
      sources: TestCaseSource[];
      agentKey: string;
      modelId: string;
      evaluatorId?: string;
      concurrency?: number;
      benchmarkId?: string;
      trigger?: string;
    },
    onEvent: (event: { type: string; data: any }) => void
  ): Promise<EvaluationRun | null> {
    const res = await fetch(`${this.baseUrl}/api/storage/evaluation-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
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
      throw new ServerError(`Failed to create evaluation run: ${errorMessage}`);
    }

    if (!res.body) {
      throw new Error('No response body for SSE stream');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let completedRun: EvaluationRun | null = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop() || '';

      for (const event of events) {
        const lines = event.split('\n');
        let eventType = '';
        let eventData = '';

        for (const line of lines) {
          if (line.startsWith('event: ')) eventType = line.slice(7);
          else if (line.startsWith('data: ')) eventData = line.slice(6);
        }

        if (!eventData) continue;

        try {
          const data = JSON.parse(eventData);
          onEvent({ type: eventType, data });

          if (eventType === 'completed') {
            completedRun = data;
          } else if (eventType === 'error') {
            throw new ServerError(data.error || 'Evaluation run failed');
          }
        } catch (e) {
          if (e instanceof ServerError) throw e;
          // Ignore JSON parse errors from incomplete chunks
        }
      }
    }

    return completedRun;
  }

  /**
   * Promote an ad-hoc evaluation run to a benchmark.
   */
  async promoteEvaluationRun(runId: string, benchmarkName: string): Promise<{ benchmark: Benchmark; run: EvaluationRun }> {
    const res = await fetch(`${this.baseUrl}/api/storage/evaluation-runs/${runId}/promote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ benchmarkName }),
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
      throw new Error(`Failed to promote run: ${errorMessage}`);
    }

    return res.json();
  }
}
