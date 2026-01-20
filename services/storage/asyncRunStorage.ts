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
  };

  return {
    id: stored.id,
    timestamp: stored.createdAt,
    testCaseId: stored.testCaseId,
    testCaseVersion: parseInt(stored.testCaseVersionId?.split('-v')[1] || '1'),
    experimentId: stored.experimentId || undefined,
    experimentRunId: stored.experimentRunId || undefined,
    agentName: stored.agentId,
    agentKey: stored.agentId,
    modelName: stored.modelId,
    modelId: stored.modelId,
    status: stored.status,
    passFailStatus: stored.passFailStatus as 'passed' | 'failed' | undefined,
    trajectory: (stored.trajectory || []) as TrajectoryStep[],
    metrics: {
      accuracy: stored.metrics?.accuracy || 0,
      faithfulness: stored.metrics?.faithfulness || 0,
      latency_score: stored.metrics?.latency_score || 0,
      trajectory_alignment_score: stored.metrics?.trajectory_alignment_score || 0,
    },
    llmJudgeReasoning: stored.llmJudgeReasoning || '',
    annotations: (stored.annotations || []).map(ann => ({
      id: ann.id,
      reportId: stored.id,
      text: ann.text,
      timestamp: ann.createdAt,
      tags: ann.tags,
      author: ann.author,
    })),
    runId: stored.traceId,
    rawEvents: stored.rawEvents as any[] | undefined,
    logs: (stored.logs || []) as OpenSearchLog[],
    improvementStrategies: stored.improvementStrategies as any[] | undefined,
    // Trace-mode fields
    metricsStatus: storedAny.metricsStatus as 'pending' | 'calculating' | 'ready' | 'error' | undefined,
    traceFetchAttempts: storedAny.traceFetchAttempts,
    lastTraceFetchAt: storedAny.lastTraceFetchAt,
    traceError: storedAny.traceError,
    spans: storedAny.spans as any[] | undefined,
  };
}

/**
 * Convert app TestCaseRun format to OpenSearch storage format
 */
function toStorageFormat(report: EvaluationReport): Omit<StorageRun, 'id' | 'createdAt' | 'annotations'> & Partial<TraceModeFields> {
  const base: Omit<StorageRun, 'id' | 'createdAt' | 'annotations'> & Partial<TraceModeFields> = {
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
    metrics: {
      accuracy: report.metrics.accuracy,
      faithfulness: report.metrics.faithfulness,
      latency_score: report.metrics.latency_score,
      trajectory_alignment_score: report.metrics.trajectory_alignment_score,
    },
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
   * Get all reports for a specific test case
   */
  async getReportsByTestCase(
    testCaseId: string,
    options: GetReportsOptions = {}
  ): Promise<EvaluationReport[]> {
    const { limit = 100 } = options;
    const stored = await opensearchRuns.getByTestCase(testCaseId, limit);
    return stored.map(toTestCaseRun);
  }

  /**
   * Get all reports across all test cases
   */
  async getAllReports(options: GetReportsOptions = {}): Promise<EvaluationReport[]> {
    const { limit = 100, offset = 0 } = options;
    const result = await opensearchRuns.getAll({ size: limit, from: offset });
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
    if (updates.passFailStatus !== undefined) storageUpdates.passFailStatus = updates.passFailStatus;
    if (updates.llmJudgeReasoning !== undefined) storageUpdates.llmJudgeReasoning = updates.llmJudgeReasoning;
    if (updates.trajectory !== undefined) storageUpdates.trajectory = updates.trajectory;
    if (updates.rawEvents !== undefined) storageUpdates.rawEvents = updates.rawEvents;
    if (updates.logs !== undefined) storageUpdates.logs = updates.logs;
    if (updates.runId !== undefined) storageUpdates.traceId = updates.runId;
    if (updates.improvementStrategies !== undefined) storageUpdates.improvementStrategies = updates.improvementStrategies;

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
    const reports = await opensearchRuns.getByTestCase(testCaseId, 0);
    return reports.length;
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
