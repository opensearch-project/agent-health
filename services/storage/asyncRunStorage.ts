/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Async Run Storage
 *
 * Async wrapper around OpenSearch storage for runs (test case executions).
 * Replaces the localStorage-based reportStorage.
 * Maps between app's EvaluationReport/TestCaseRun and OpenSearch StorageRun.
 */

import {
  runStorage as opensearchRuns,
  StorageRun,
  StorageRunAnnotation,
} from './opensearchClient';
import type {
  EvaluationReport,
  TestCaseRun,
  RunAnnotation,
  TrajectoryStep,
  EvaluationMetrics,
  ImprovementStrategy,
  OpenSearchLog,
  ConnectorProtocol,
} from '@/types';

// Re-export search types for convenience
export interface SearchQuery {
  testCaseIds?: string[];
  dateRange?: { start: string; end: string };
  agentNames?: string[];
  modelNames?: string[];
  minAccuracy?: number;
  status?: ('running' | 'completed' | 'failed')[];
  hasAnnotations?: boolean;
  annotationTags?: string[];
}

export interface GetReportsOptions {
  limit?: number;
  offset?: number;
  sortBy?: 'timestamp' | 'accuracy';
  order?: 'asc' | 'desc';
  fields?: string[]; // NEW: Optional field projection for payload optimization
}

/**
 * Optional fields for trace-mode runs (when useTraces: true)
 * These fields are dynamically added and not part of the base StorageRun schema
 */
interface TraceModeFields {
  metricsStatus?: string;
  traceFetchAttempts?: number;
  lastTraceFetchAt?: string;
  traceError?: string;
  spans?: unknown[];
}

/**
 * Coerce a stored metrics object — which may contain any subset of dynamic
 * metric names (driven by the evaluator's `scoringConfig.metrics`) — into
 * the app-side `EvaluationMetrics` shape.
 *
 * Two important guarantees:
 *   1. **Preserves all numeric metric names**, not just the four legacy ones
 *      (accuracy / faithfulness / latency_score / trajectory_alignment_score).
 *      Custom and non-RCA system evaluators emit names like
 *      `tool_selection_accuracy`, `reasoning_coherence`, `bias_detection`, etc.
 *   2. **Distinguishes "missing" from "zero"**. Previously the read-side
 *      whitelist defaulted every missing field to `0`, which made the runs
 *      list show `0%` for every run that didn't happen to have an `accuracy`
 *      metric — even runs the judge had passed. Missing entries are now
 *      simply absent (so UI consumers can render `—` instead of fabricated 0).
 */
function storedMetricsToApp(
  raw: Record<string, unknown> | undefined,
): TestCaseRun['metrics'] {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Convert OpenSearch storage format to app TestCaseRun format
 */
function toTestCaseRun(stored: StorageRun): TestCaseRun {
  // Cast to access trace-mode fields
  const storedAny = stored as StorageRun & {
    metricsStatus?: string;
    traceFetchAttempts?: number;
    lastTraceFetchAt?: string;
    traceError?: string;
    spans?: unknown[];
    connectorProtocol?: string;
  };

  return {
    id: stored.id,
    name: (stored as any).name,
    description: (stored as any).description,
    timestamp: stored.createdAt,
    testCaseId: stored.testCaseId,
    testCaseVersion: parseInt(stored.testCaseVersionId?.split('-v')[1] || '1'),
    experimentId: stored.experimentId || undefined,
    experimentRunId: stored.experimentRunId || undefined,
    agentName: (stored as any).agentName || stored.agentId,
    agentKey: stored.agentId,
    modelName: stored.modelId,
    modelId: stored.modelId,
    status: stored.status,
    passFailStatus: stored.passFailStatus as 'passed' | 'failed' | undefined,
    evaluatorId: (stored as any).evaluatorId,
    trajectory: (stored.trajectory || []) as TrajectoryStep[],
    // Preserve every metric the judge emitted, not just the four legacy keys.
    // Custom evaluators (and even system evaluators other than RCA Default)
    // produce dynamic metric names like `tool_selection_accuracy` or
    // `reasoning_coherence`; the previous shape whitelisted only
    // accuracy/faithfulness/latency_score/trajectory_alignment_score and
    // — worse — collapsed missing values to `0` via `|| 0`, which made
    // every run look like it had scored zero in the runs list.
    //
    // We spread the stored object directly and only filter out non-numeric
    // entries so the resulting shape matches `EvaluationMetrics`'s
    // `[key: string]: number | undefined` index signature without leaking
    // surprise types into downstream consumers.
    metrics: storedMetricsToApp(stored.metrics as Record<string, unknown> | undefined),
    llmJudgeReasoning: stored.llmJudgeReasoning || '',
    annotations: (stored.annotations || []).map(ann => ({
      id: ann.id,
      reportId: stored.id,
      text: ann.text,
      timestamp: ann.createdAt,
      tags: ann.tags,
      author: ann.author,
    })),
    runId: stored.traceId || (stored as any).runId,
    rawEvents: stored.rawEvents as any[] | undefined,
    logs: (stored.logs || []) as OpenSearchLog[],
    improvementStrategies: stored.improvementStrategies as any[] | undefined,
    // Per-matcher verdicts captured by the SDK during the test body
    matcherResults: (stored as any).matcherResults as any[] | undefined,
    // Trace-mode fields
    metricsStatus: storedAny.metricsStatus as 'pending' | 'calculating' | 'ready' | 'error' | undefined,
    traceFetchAttempts: storedAny.traceFetchAttempts,
    lastTraceFetchAt: storedAny.lastTraceFetchAt,
    traceError: storedAny.traceError,
    spans: storedAny.spans as any[] | undefined,
    connectorProtocol: storedAny.connectorProtocol as ConnectorProtocol | undefined,
  };
}

/**
 * Convert app TestCaseRun format to OpenSearch storage format
 */
function toStorageFormat(report: EvaluationReport): Omit<StorageRun, 'id' | 'createdAt' | 'annotations'> & Partial<TraceModeFields> {
  const base: Omit<StorageRun, 'id' | 'createdAt' | 'annotations'> & Partial<TraceModeFields> = {
    name: report.name,
    description: report.description,
    experimentId: '', // Storage field for benchmarkId (name preserved for data compatibility)
    experimentRunId: '', // Storage field for benchmarkRunId (name preserved for data compatibility)
    testCaseId: report.testCaseId,
    testCaseVersionId: `${report.testCaseId}-v${report.testCaseVersion || 1}`,
    agentId: report.agentKey || report.agentName,
    modelId: report.modelId || report.modelName,
    iteration: 1, // Default to 1, can be overridden
    status: report.status,
    passFailStatus: report.passFailStatus,
    traceId: report.runId,
    tags: [],
    actualOutcomes: [],
    llmJudgeReasoning: report.llmJudgeReasoning,
    // Pass the full dynamic metrics object through. Whitelisting fixed names
    // here used to silently drop any metric the evaluator emitted that wasn't
    // one of the four legacy keys (accuracy/faithfulness/latency_score/
    // trajectory_alignment_score), making per-evaluator scores invisible in
    // listing pages. The OpenSearch index uses dynamic mapping under
    // `metrics`, so arbitrary numeric fields are accepted by the cluster.
    metrics: report.metrics as StorageRun['metrics'],
    trajectory: report.trajectory,
    rawEvents: report.rawEvents,
    logs: report.logs || report.openSearchLogs,
    improvementStrategies: report.improvementStrategies,
  };

  // Add trace-mode fields if present
  if (report.metricsStatus !== undefined) base.metricsStatus = report.metricsStatus;
  if (report.traceFetchAttempts !== undefined) base.traceFetchAttempts = report.traceFetchAttempts;
  if (report.lastTraceFetchAt !== undefined) base.lastTraceFetchAt = report.lastTraceFetchAt;
  if (report.traceError !== undefined) base.traceError = report.traceError;
  if (report.spans !== undefined) base.spans = report.spans;
  if (report.connectorProtocol !== undefined) base.connectorProtocol = report.connectorProtocol;
  // SDK matcher verdicts: persist alongside the report
  if (report.matcherResults !== undefined) (base as any).matcherResults = report.matcherResults;

  return base;
}

class AsyncRunStorage {
  // ==================== Core CRUD Operations ====================

  /**
   * Save a report/run
   */
  async saveReport(
    report: EvaluationReport,
    options?: { experimentId?: string; experimentRunId?: string; iteration?: number }
  ): Promise<EvaluationReport> {
    const storageData = toStorageFormat(report);

    // Apply experiment context if provided
    if (options?.experimentId) {
      storageData.experimentId = options.experimentId;
    }
    if (options?.experimentRunId) {
      storageData.experimentRunId = options.experimentRunId;
    }
    if (options?.iteration) {
      storageData.iteration = options.iteration;
    }

    const created = await opensearchRuns.create(storageData);
    return toTestCaseRun(created);
  }

  /**
   * Get run counts grouped by test case ID (single bulk query)
   */
  async getRunCountsByTestCase(): Promise<Record<string, number>> {
    return opensearchRuns.getCountsByTestCase();
  }

  /**
   * Get all reports for a specific test case
   */
  async getReportsByTestCase(
    testCaseId: string,
    options: GetReportsOptions = {}
  ): Promise<{ reports: EvaluationReport[]; total: number }> {
    const { limit = 100, offset = 0 } = options;
    const result = await opensearchRuns.getByTestCase(testCaseId, limit, offset);
    return { reports: result.runs.map(toTestCaseRun), total: result.total };
  }

  /**
   * Get all reports across all test cases
   */
  async getAllReports(options: GetReportsOptions = {}): Promise<EvaluationReport[]> {
    const { limit = 100, offset = 0, fields } = options;

    // Build query options with optional field projection
    const queryOptions: any = { size: limit, from: offset };
    if (fields && fields.length > 0) {
      queryOptions._source = fields;
    }

    const result = await opensearchRuns.getAll(queryOptions);
    return result.runs.map(toTestCaseRun);
  }

  /**
   * Get a single report by ID
   */
  async getReportById(reportId: string): Promise<EvaluationReport | null> {
    const stored = await opensearchRuns.getById(reportId);
    return stored ? toTestCaseRun(stored) : null;
  }

  /**
   * Delete a report and its annotations
   */
  async deleteReport(reportId: string): Promise<boolean> {
    const result = await opensearchRuns.delete(reportId);
    return result.deleted;
  }

  /**
   * Partial update of a report
   * Used for updating trace-mode runs after traces become available
   */
  async updateReport(
    reportId: string,
    updates: Partial<EvaluationReport>
  ): Promise<EvaluationReport | null> {
    // Convert app format to storage format for the updates
    const storageUpdates: Record<string, unknown> = {};

    // Map fields from EvaluationReport to StorageRun format
    if (updates.status !== undefined) storageUpdates.status = updates.status;
    // `passFailStatus` accepts an explicit `null` to clear a stale verdict
    // on a run that just transitioned to `metricsStatus: 'error'` (issue
    // #242). Without this, `buildEvaluatorErrorPatch`'s `passFailStatus: null`
    // would still be filtered out by a strict `!== undefined` check and the
    // persisted document would keep its previous 'passed'/'failed' value.
    if ((updates as any).passFailStatus !== undefined) storageUpdates.passFailStatus = (updates as any).passFailStatus;
    if (updates.llmJudgeReasoning !== undefined) storageUpdates.llmJudgeReasoning = updates.llmJudgeReasoning;
    if (updates.trajectory !== undefined) storageUpdates.trajectory = updates.trajectory;
    if (updates.rawEvents !== undefined) storageUpdates.rawEvents = updates.rawEvents;
    if (updates.logs !== undefined) storageUpdates.logs = updates.logs;
    if (updates.runId !== undefined) storageUpdates.traceId = updates.runId;
    if (updates.improvementStrategies !== undefined) storageUpdates.improvementStrategies = updates.improvementStrategies;
    if ((updates as any).matcherResults !== undefined) (storageUpdates as any).matcherResults = (updates as any).matcherResults;

    // Map metrics
    if (updates.metrics) {
      storageUpdates.metrics = {
        accuracy: updates.metrics.accuracy,
        faithfulness: updates.metrics.faithfulness,
        latency_score: updates.metrics.latency_score,
        trajectory_alignment_score: updates.metrics.trajectory_alignment_score,
      };
    }

    // Pass through trace-mode specific fields directly
    if (updates.metricsStatus !== undefined) storageUpdates.metricsStatus = updates.metricsStatus;
    if (updates.traceFetchAttempts !== undefined) storageUpdates.traceFetchAttempts = updates.traceFetchAttempts;
    if (updates.lastTraceFetchAt !== undefined) storageUpdates.lastTraceFetchAt = updates.lastTraceFetchAt;
    if (updates.traceError !== undefined) storageUpdates.traceError = updates.traceError;
    if (updates.spans !== undefined) storageUpdates.spans = updates.spans;

    const updated = await opensearchRuns.partialUpdate(reportId, storageUpdates);
    return toTestCaseRun(updated);
  }

  /**
   * Get total count of reports
   */
  async getReportCount(): Promise<number> {
    const result = await opensearchRuns.getAll({ size: 0 });
    return result.total;
  }

  /**
   * Get report count for a specific test case
   */
  async getReportCountByTestCase(testCaseId: string): Promise<number> {
    const result = await opensearchRuns.getByTestCase(testCaseId, 0);
    return result.total;
  }

  // ==================== Benchmark-Specific Operations ====================

  /**
   * Get runs for a benchmark
   */
  async getByBenchmark(benchmarkId: string, size?: number): Promise<EvaluationReport[]> {
    const stored = await opensearchRuns.getByBenchmark(benchmarkId, size);
    return stored.map(toTestCaseRun);
  }

  /**
   * Get runs for a specific benchmark run config
   */
  async getByBenchmarkRun(
    benchmarkId: string,
    runId: string,
    size?: number
  ): Promise<EvaluationReport[]> {
    const stored = await opensearchRuns.getByBenchmarkRun(benchmarkId, runId, size);
    return stored.map(toTestCaseRun);
  }

  /**
   * Get all iterations for a test case in a benchmark
   */
  async getIterations(
    benchmarkId: string,
    testCaseId: string,
    benchmarkRunId?: string
  ): Promise<{ runs: EvaluationReport[]; total: number; maxIteration: number }> {
    const result = await opensearchRuns.getIterations(benchmarkId, testCaseId, benchmarkRunId);
    return {
      runs: result.runs.map(toTestCaseRun),
      total: result.total,
      maxIteration: result.maxIteration,
    };
  }

  // Backwards compatibility aliases
  /** @deprecated Use getByBenchmark instead */
  async getByExperiment(experimentId: string, size?: number): Promise<EvaluationReport[]> {
    return this.getByBenchmark(experimentId, size);
  }

  /** @deprecated Use getByBenchmarkRun instead */
  async getByExperimentRun(
    experimentId: string,
    runId: string,
    size?: number
  ): Promise<EvaluationReport[]> {
    return this.getByBenchmarkRun(experimentId, runId, size);
  }

  // ==================== Annotation Operations ====================

  /**
   * Add an annotation to a report
   */
  async addAnnotation(
    reportId: string,
    annotation: Omit<RunAnnotation, 'id' | 'timestamp' | 'reportId'>
  ): Promise<RunAnnotation> {
    const created = await opensearchRuns.addAnnotation(reportId, {
      text: annotation.text,
      tags: annotation.tags,
      author: annotation.author,
    });

    return {
      id: created.id,
      reportId,
      text: created.text,
      timestamp: created.createdAt,
      tags: created.tags,
      author: created.author,
    };
  }

  /**
   * Update an existing annotation
   */
  async updateAnnotation(
    reportId: string,
    annotationId: string,
    updates: Partial<RunAnnotation>
  ): Promise<boolean> {
    try {
      await opensearchRuns.updateAnnotation(reportId, annotationId, {
        text: updates.text,
        tags: updates.tags,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Delete an annotation
   */
  async deleteAnnotation(reportId: string, annotationId: string): Promise<boolean> {
    const result = await opensearchRuns.deleteAnnotation(reportId, annotationId);
    return result.deleted;
  }

  /**
   * Get all annotations for a report
   */
  async getAnnotationsByReport(reportId: string): Promise<RunAnnotation[]> {
    const report = await opensearchRuns.getById(reportId);
    if (!report || !report.annotations) return [];

    return report.annotations.map(ann => ({
      id: ann.id,
      reportId,
      text: ann.text,
      timestamp: ann.createdAt,
      tags: ann.tags,
      author: ann.author,
    }));
  }

  // ==================== Search and Filter ====================

  /**
   * Search reports with complex filtering
   */
  async searchReports(query: SearchQuery): Promise<EvaluationReport[]> {
    const filters: Parameters<typeof opensearchRuns.search>[0] = {};

    if (query.testCaseIds && query.testCaseIds.length > 0) {
      // Note: OpenSearch search supports single testCaseId, would need to loop
      filters.testCaseId = query.testCaseIds[0];
    }

    if (query.dateRange) {
      filters.dateRange = query.dateRange;
    }

    if (query.status && query.status.length > 0) {
      filters.status = query.status[0];
    }

    const result = await opensearchRuns.search(filters);
    let reports = result.runs.map(toTestCaseRun);

    // Apply additional client-side filters not supported by backend
    if (query.agentNames && query.agentNames.length > 0) {
      reports = reports.filter(r => query.agentNames!.includes(r.agentName));
    }

    if (query.modelNames && query.modelNames.length > 0) {
      reports = reports.filter(r => query.modelNames!.includes(r.modelName));
    }

    if (query.minAccuracy !== undefined) {
      reports = reports.filter(r => r.metrics.accuracy >= query.minAccuracy!);
    }

    return reports;
  }

  // ==================== Utility Functions ====================

  /**
   * Generate a unique report ID
   */
  generateReportId(): string {
    return `run-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }

  /**
   * Bulk create runs (for migration)
   */
  async bulkCreate(runs: EvaluationReport[]): Promise<{ created: number; errors: boolean }> {
    const storageData = runs.map(run => ({
      ...toStorageFormat(run),
      id: run.id,
      createdAt: run.timestamp,
    }));
    return opensearchRuns.bulkCreate(storageData);
  }
}

// Export singleton instance
export const asyncRunStorage = new AsyncRunStorage();

// Alias for backwards compatibility
export const asyncReportStorage = asyncRunStorage;
