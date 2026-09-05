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
  BenchmarkImage,
  EvaluationRun,
  TestCaseRun,
  RunAnnotation,
  SessionMetadata,
  OpenSearchLog,
  Span,
  HealthStatus,
  DataSourceAdapterType,
  DataSourceConfig,
  StorageClusterConfig,
  ObservabilityClusterConfig,
  Evaluator,
} from '../../types/index.js';

// ============================================================================
// Query Types
// ============================================================================

export interface PaginationOptions {
  size?: number;
  from?: number;
  _source?: string[];
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
  sessionId?: string;
  startTime?: number;
  endTime?: number;
  size?: number;
  serviceName?: string;
  textSearch?: string;
  cursor?: string;
  /** Strategy C (opt-in): service.name + time-window correlation. See AGENTS.md. */
  /** Strategy D: per-agent `sessionId` correlates on `attributes.session.id`. */
  agents?: Array<{ serviceName: string; startedAt: number; endedAt: number; sessionId?: string }>;
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
  /**
   * Bulk create test cases.
   * NOTE: Returns the created TestCase entities (unlike Benchmark/Run bulkCreate)
   * because callers need the server-generated IDs immediately to build benchmark references.
   * See cli/commands/benchmark.ts for usage.
   */
  bulkCreate(testCases: Partial<TestCase>[]): Promise<{ created: number; errors: number; testCases: TestCase[] }>;
  bulkUpsert(testCases: Partial<TestCase>[]): Promise<{ created: number; updated: number; unchanged: number; testCases: TestCase[] }>;
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
  /**
   * Atomically union `testCaseIds` into BOTH the top-level `testCaseIds`
   * array AND the current version's own `testCaseIds` entry (synthesizing
   * a v1 from the top level first for legacy docs with no `versions[]`
   * yet) — no version bump. This is a single atomic server-side mutation
   * (a Painless scripted `_update` for the OpenSearch adapter, a
   * process-serialized read-modify-write for the file adapter), NOT a
   * client-side read-then-full-document-overwrite like `update()` — it is
   * safe to call concurrently for the same benchmark from multiple
   * requests (see `services/benchmarkPromotion.ts`'s `linkTestCaseIdsToBenchmark`,
   * which now delegates here after a codex_review finding that its
   * previous client-side optimistic-retry implementation could still lose
   * a concurrent writer's ids). Returns `null` if the benchmark doesn't
   * exist. `added` reflects ids newly introduced at the top level,
   * computed best-effort from a pre-mutation read — purely informational
   * (used only for a debug log at the call site), not relied on for
   * correctness.
   */
  linkTestCaseIds(benchmarkId: string, testCaseIds: string[]): Promise<{ benchmark: Benchmark; added: string[] } | null>;
}

/**
 * Evaluation Run operations (stored in same index as benchmarks with docType discriminator)
 */
export interface IEvaluationRunOperations {
  create(run: EvaluationRun): Promise<EvaluationRun>;
  getById(id: string): Promise<EvaluationRun | null>;
  update(id: string, updates: Partial<EvaluationRun>): Promise<EvaluationRun>;
  delete(id: string): Promise<{ deleted: boolean }>;
  list(options?: PaginationOptions & {
    benchmarkId?: string;
    agentKey?: string;
    status?: string;
    testCaseId?: string;
    trigger?: string;
    imageDigest?: string;
    sort?: 'createdAt' | 'completedAt';
    order?: 'asc' | 'desc';
  }): Promise<{ items: EvaluationRun[]; total: number }>;
  /**
   * Atomically set ONE entry of `results` (server-side merge on the live doc;
   * never a read-modify-write of the whole map). Safe to call concurrently
   * for different test cases of the same run.
   */
  updateResult(runId: string, testCaseId: string, result: EvaluationRunResultEntry): Promise<boolean>;
  /**
   * Atomically add every entry of `results` whose key is NOT already present
   * on the persisted doc. Existing entries are never overwritten — this is
   * the finalization write that (a) stamps `status: 'cancelled'` markers for
   * never-started cases and (b) heals any per-case `updateResult` that was
   * lost, without ever clobbering a concurrently persisted verdict.
   */
  mergeMissingResults(runId: string, results: Record<string, EvaluationRunResultEntry>): Promise<boolean>;
}

/** One `EvaluationRun.results[testCaseId]` entry (see types/index.ts). */
export type EvaluationRunResultEntry = EvaluationRun['results'][string];

/**
 * Benchmark Image operations (stored in same index as benchmarks with
 * docType 'benchmark-image'; content-addressed by digest).
 */
export interface IBenchmarkImageOperations {
  /** Find-or-create keyed on digest — never mints a duplicate. */
  create(image: BenchmarkImage): Promise<BenchmarkImage>;
  getByDigest(digest: string): Promise<BenchmarkImage | null>;
  getAll(options?: PaginationOptions): Promise<{ items: BenchmarkImage[]; total: number }>;
  update(digest: string, updates: Partial<Pick<BenchmarkImage, 'tags' | 'lastRunAt'>>): Promise<BenchmarkImage>;
  delete(digest: string): Promise<{ deleted: boolean }>;
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
  getByTestCase(testCaseId: string, size?: number, from?: number): Promise<{ items: TestCaseRun[]; total: number }>;
  getByExperiment(experimentId: string, size?: number): Promise<TestCaseRun[]>;
  getByExperimentRun(experimentId: string, runId: string, size?: number): Promise<TestCaseRun[]>;
  getIterations(experimentId: string, testCaseId: string, experimentRunId?: string): Promise<{
    items: TestCaseRun[];
    total: number;
    maxIteration: number;
  }>;
  bulkCreate(runs: Partial<TestCaseRun>[]): Promise<{ created: number; errors: number }>;
  countsByTestCase(): Promise<Record<string, number>>;
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
 * Evaluator CRUD operations
 */
export interface IEvaluatorOperations {
  getAll(options?: PaginationOptions): Promise<{ items: Evaluator[]; total: number }>;
  getById(id: string): Promise<Evaluator | null>;
  getVersions(id: string): Promise<Evaluator[]>;
  getVersion(id: string, version: number): Promise<Evaluator | null>;
  create(evaluator: Partial<Evaluator>): Promise<Evaluator>;
  update(id: string, updates: Partial<Evaluator>): Promise<Evaluator>;
  delete(id: string): Promise<{ deleted: number }>;
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
  query(options: TracesQueryOptions): Promise<{ spans: Span[]; total: number; nextCursor?: string | null; hasMore?: boolean }>;
  getByTraceId(traceId: string): Promise<Span[]>;
  getByRunIds(runIds: string[]): Promise<Span[]>;
}

/**
 * Metrics query operations (placeholder for future)
 */
export interface IMetricsOperations {
  // Future: Add metrics query operations
}

/**
 * @experimental Session metadata operations (generic sidecar for coding agent sessions)
 */
export interface ISessionMetadataOperations {
  get(agentKind: string, sessionId: string): Promise<SessionMetadata | null>;
  put(agentKind: string, sessionId: string, data: Record<string, unknown>): Promise<SessionMetadata>;
  list(options?: PaginationOptions): Promise<{ items: SessionMetadata[]; total: number }>;
  delete(agentKind: string, sessionId: string): Promise<{ deleted: boolean }>;
}

// ============================================================================
// Storage Module Interface
// ============================================================================

/**
 * Storage module - handles test cases, benchmarks, runs, analytics, and evaluators
 */
export interface IStorageModule {
  testCases: ITestCaseOperations;
  benchmarks: IBenchmarkOperations;
  evaluationRuns: IEvaluationRunOperations;
  images: IBenchmarkImageOperations;
  runs: IRunOperations;
  analytics: IAnalyticsOperations;
  evaluators: IEvaluatorOperations;
  sessionMetadata: ISessionMetadataOperations;
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
