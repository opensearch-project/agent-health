/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Data Source Adapter Types
 *
 * Defines interfaces for pluggable data source adapters.
 * Enables future support for backends other than OpenSearch.
 */

import type {
  TestCase,
  Benchmark,
  BenchmarkRun,
  TestCaseRun,
  RunAnnotation,
  OpenSearchLog,
  Span,
  HealthStatus,
  DataSourceAdapterType,
  DataSourceConfig,
  StorageClusterConfig,
  ObservabilityClusterConfig,
} from '../../types/index.js';

// ============================================================================
// Query Types
// ============================================================================

export interface PaginationOptions {
  size?: number;
  from?: number;
}

export interface DateRangeFilter {
  start: string;
  end: string;
}

export interface TestCaseSearchFilters {
  labels?: string[];
  category?: string;
  difficulty?: string;
  isPromoted?: boolean;
  textSearch?: string;
}

export interface RunSearchFilters {
  experimentId?: string;
  experimentRunId?: string;
  testCaseId?: string;
  agentId?: string;
  modelId?: string;
  status?: string;
  passFailStatus?: string;
  tags?: string[];
  dateRange?: DateRangeFilter;
}

export interface LogsQueryOptions {
  runId?: string;
  query?: string;
  startTime?: number;
  endTime?: number;
  size?: number;
}

export interface TracesQueryOptions {
  traceId?: string;
  runIds?: string[];
  startTime?: number;
  endTime?: number;
  size?: number;
  serviceName?: string;
  textSearch?: string;
}

// ============================================================================
// Operation Interfaces
// ============================================================================

/**
 * Test Case CRUD operations
 */
export interface ITestCaseOperations {
  getAll(options?: PaginationOptions): Promise<{ items: TestCase[]; total: number }>;
  getById(id: string): Promise<TestCase | null>;
  getVersions(id: string): Promise<TestCase[]>;
  getVersion(id: string, version: number): Promise<TestCase | null>;
  create(testCase: Partial<TestCase>): Promise<TestCase>;
  update(id: string, updates: Partial<TestCase>): Promise<TestCase>;
  delete(id: string): Promise<{ deleted: number }>;
  search(filters: TestCaseSearchFilters, options?: PaginationOptions): Promise<{ items: TestCase[]; total: number }>;
  bulkCreate(testCases: Partial<TestCase>[]): Promise<{ created: number; errors: number }>;
}

/**
 * Benchmark CRUD operations
 */
export interface IBenchmarkOperations {
  getAll(options?: PaginationOptions): Promise<{ items: Benchmark[]; total: number }>;
  getById(id: string): Promise<Benchmark | null>;
  create(benchmark: Partial<Benchmark>): Promise<Benchmark>;
  update(id: string, updates: Partial<Benchmark>): Promise<Benchmark>;
  delete(id: string): Promise<{ deleted: boolean }>;
  addRun(benchmarkId: string, run: BenchmarkRun): Promise<boolean>;
  updateRun(benchmarkId: string, runId: string, updates: Partial<BenchmarkRun>): Promise<boolean>;
  deleteRun(benchmarkId: string, runId: string): Promise<boolean>;
  bulkCreate(benchmarks: Partial<Benchmark>[]): Promise<{ created: number; errors: number }>;
}

// Backwards compatibility alias
/** @deprecated Use IBenchmarkOperations instead */
export type IExperimentOperations = IBenchmarkOperations;

/**
 * Run (TestCaseRun/EvaluationReport) CRUD operations
 */
export interface IRunOperations {
  getAll(options?: PaginationOptions): Promise<{ items: TestCaseRun[]; total: number }>;
  getById(id: string): Promise<TestCaseRun | null>;
  create(run: Partial<TestCaseRun>): Promise<TestCaseRun>;
  update(id: string, updates: Partial<TestCaseRun>): Promise<TestCaseRun>;
  delete(id: string): Promise<{ deleted: boolean }>;
  search(filters: RunSearchFilters, options?: PaginationOptions): Promise<{ items: TestCaseRun[]; total: number }>;
  getByTestCase(testCaseId: string, size?: number): Promise<TestCaseRun[]>;
  getByExperiment(experimentId: string, size?: number): Promise<TestCaseRun[]>;
  getByExperimentRun(experimentId: string, runId: string, size?: number): Promise<TestCaseRun[]>;
  getIterations(experimentId: string, testCaseId: string, experimentRunId?: string): Promise<{
    items: TestCaseRun[];
    total: number;
    maxIteration: number;
  }>;
  bulkCreate(runs: Partial<TestCaseRun>[]): Promise<{ created: number; errors: number }>;
  // Annotations
  addAnnotation(runId: string, annotation: Partial<RunAnnotation>): Promise<RunAnnotation>;
  updateAnnotation(runId: string, annotationId: string, updates: Partial<RunAnnotation>): Promise<RunAnnotation>;
  deleteAnnotation(runId: string, annotationId: string): Promise<{ deleted: boolean }>;
}

/**
 * Analytics operations
 */
export interface IAnalyticsOperations {
  query(filters: Record<string, unknown>, options?: PaginationOptions): Promise<{ items: Record<string, unknown>[]; total: number }>;
  aggregations(experimentId?: string, groupBy?: string): Promise<{ aggregations: Record<string, unknown>[]; groupBy: string }>;
  writeRecord(record: Record<string, unknown>): Promise<void>;
  backfill(): Promise<{ backfilled: number; errors: number; total: number }>;
}

/**
 * Logs query operations
 */
export interface ILogsOperations {
  query(options: LogsQueryOptions): Promise<{ logs: OpenSearchLog[]; total: number }>;
}

/**
 * Traces query operations
 */
export interface ITracesOperations {
  query(options: TracesQueryOptions): Promise<{ spans: Span[]; total: number }>;
  getByTraceId(traceId: string): Promise<Span[]>;
  getByRunIds(runIds: string[]): Promise<Span[]>;
}

/**
 * Metrics query operations (placeholder for future)
 */
export interface IMetricsOperations {
  // Future: Add metrics query operations
}

// ============================================================================
// Storage Module Interface
// ============================================================================

/**
 * Storage module - handles test cases, benchmarks, runs, and analytics
 */
export interface IStorageModule {
  testCases: ITestCaseOperations;
  benchmarks: IBenchmarkOperations;
  runs: IRunOperations;
  analytics: IAnalyticsOperations;
  health(): Promise<HealthStatus>;
  isConfigured(): boolean;
}

// ============================================================================
// Observability Module Interface
// ============================================================================

/**
 * Observability module - handles logs, traces, and metrics
 */
export interface IObservabilityModule {
  logs: ILogsOperations;
  traces: ITracesOperations;
  metrics: IMetricsOperations;
  health(): Promise<HealthStatus>;
  isConfigured(): boolean;
}

// ============================================================================
// Main Adapter Interface
// ============================================================================

/**
 * Data Source Adapter Interface
 *
 * Single adapter with two modules:
 * - storage: test cases, benchmarks, runs, analytics
 * - observability: logs, traces, metrics
 */
export interface IDataSourceAdapter {
  /** Adapter type identifier */
  readonly type: DataSourceAdapterType;

  /** Storage module (test cases, benchmarks, runs, analytics) */
  storage: IStorageModule;

  /** Observability module (logs, traces, metrics) */
  observability: IObservabilityModule;

  /**
   * Initialize the adapter with configuration
   * @param config Data source configuration with storage and observability settings
   */
  initialize(config: DataSourceConfig): Promise<void>;

  /**
   * Update storage configuration at runtime
   * @param config Storage cluster configuration
   */
  updateStorageConfig(config: StorageClusterConfig | null): void;

  /**
   * Update observability configuration at runtime
   * @param config Observability cluster configuration
   */
  updateObservabilityConfig(config: ObservabilityClusterConfig | null): void;

  /**
   * Close connections and clean up resources
   */
  close(): Promise<void>;
}

// ============================================================================
// Factory Types
// ============================================================================

export interface AdapterFactoryOptions {
  type: DataSourceAdapterType;
  config?: DataSourceConfig;
}
