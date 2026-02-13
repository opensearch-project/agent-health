/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Node, Edge } from '@xyflow/react';

// Shared type for difficulty levels
export type Difficulty = 'Easy' | 'Medium' | 'Hard';

// Date formatting variants
export type DateFormatVariant = 'date' | 'datetime' | 'detailed';

// Judge provider determines which backend service handles evaluation
export type JudgeProvider = 'demo' | 'bedrock' | 'ollama' | 'openai';

// Connector protocol for agent communication
export type ConnectorProtocol = 'agui-streaming' | 'rest' | 'subprocess' | 'claude-code' | 'mock';

export interface ModelConfig {
  model_id: string;
  display_name: string;
  provider: JudgeProvider;
  context_window: number;
  max_output_tokens: number;
}

// ============ Agent Lifecycle Hook Types ============

export interface BeforeRequestContext {
  endpoint: string;
  payload: any;
  headers: Record<string, string>;
}

export interface AgentHooks {
  beforeRequest?: (context: BeforeRequestContext) => Promise<BeforeRequestContext>;
}

export interface AgentConfig {
  key: string; // Unique identifier for the agent (used for env var prefix)
  name: string;
  endpoint: string;
  description?: string;
  enabled?: boolean;
  models: string[]; // Keys referring to ModelConfig
  headers?: Record<string, string>; // Custom headers for agent endpoint (e.g., AWS credentials)
  useTraces?: boolean; // When true, fetch traces instead of logs for evaluation
  connectorType?: ConnectorProtocol; // Connector protocol (defaults to 'agui-streaming')
  connectorConfig?: Record<string, any>; // Connector-specific configuration
  hooks?: AgentHooks; // Lifecycle hooks for custom setup/transform logic
  isCustom?: boolean; // True for user-added custom endpoints (not from config file)
}

export interface AppConfig {
  agents: AgentConfig[];
  models: Record<string, ModelConfig>;
  defaults: {
    retry_attempts: number;
    retry_delay_ms: number;
  };
}

export enum ToolCallStatus {
  SUCCESS = 'SUCCESS',
  FAILURE = 'FAILURE',
}

export interface TrajectoryStep {
  id: string;
  timestamp: number;
  type: 'tool_result' | 'assistant' | 'action' | 'response' | 'thinking';
  content: string;
  toolName?: string;
  toolArgs?: Record<string, any>;
  toolOutput?: any;
  status?: ToolCallStatus;
  latencyMs?: number;
}

export interface EvaluationMetrics {
  accuracy: number; // 0-100
  // Legacy metrics - kept for backwards compatibility with old reports
  faithfulness?: number; // 0-100 (deprecated)
  latency_score?: number; // 0-100 (deprecated)
  trajectory_alignment_score?: number; // 0-100 (deprecated)
}

export interface ImprovementStrategy {
  category: string;
  issue: string;
  recommendation: string;
  priority: 'high' | 'medium' | 'low';
}

export type PassFailStatus = 'passed' | 'failed';

// Storage feature - LLM Judge Response tracking
export interface LLMJudgeResponse {
  modelId: string;
  timestamp: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  rawResponse: string;
  parsedMetrics?: {
    accuracy: number;
    faithfulness: number;
    latency_score: number;
    trajectory_alignment_score: number;
  };
  improvementStrategies?: ImprovementStrategy[];
  error?: string;
}

// Storage feature - User annotations on runs
export interface RunAnnotation {
  id: string;
  reportId: string;
  text: string;
  timestamp: string;
  tags?: string[];
  author?: string;
}

// Metrics status for trace-mode runs (traces take ~5 min to propagate)
export type MetricsStatus = 'pending' | 'calculating' | 'ready' | 'error';

// TestCaseRun = result of running a specific test case version (renamed from EvaluationReport)
export interface TestCaseRun {
  id: string;
  timestamp: string;
  testCaseId: string;
  testCaseVersion?: number;          // Which version was run (optional for backwards compatibility)
  experimentId?: string;             // ID of the benchmark (field name preserved for storage compatibility)
  experimentRunId?: string;          // ID of the benchmark run (field name preserved for storage compatibility)

  // Execution context
  agentName: string;
  agentKey?: string;
  modelName: string;
  modelId?: string;
  agentEndpoint?: string;

  // Results
  status: 'running' | 'completed' | 'failed';
  passFailStatus?: PassFailStatus; // LLM judge determination of pass/fail
  trajectory: TrajectoryStep[];
  metrics: EvaluationMetrics;
  llmJudgeReasoning: string;
  improvementStrategies?: ImprovementStrategy[];
  llmJudgeResponse?: LLMJudgeResponse; // Storage: Raw Bedrock judge response
  openSearchLogs?: OpenSearchLog[]; // Storage: Persisted logs (alternative to logs)
  annotations?: RunAnnotation[]; // Storage: User notes on this run
  runId?: string; // Agent's run ID from AG UI events (for log correlation)
  logs?: OpenSearchLog[]; // OpenSearch logs for the run (master version)
  rawEvents?: any[]; // Raw AG UI events for debugging
  connectorProtocol?: ConnectorProtocol; // Protocol used to execute this run (for trajectory parsing)

  // Trace mode fields (for agents with useTraces: true)
  metricsStatus?: MetricsStatus; // Status of deferred metrics/judge calculation
  traceFetchAttempts?: number; // Number of polling attempts for traces
  lastTraceFetchAt?: string; // Timestamp of last trace fetch attempt
  traceError?: string; // Error message if trace fetch failed
  spans?: Span[]; // Fetched trace spans for debugging
}

// Alias for backwards compatibility during migration
export type EvaluationReport = TestCaseRun;

export interface AgentContextItem {
  description: string;
  value: string; // JSON stringified context data
}

// Tool definition matching AG-UI/CopilotKit format
export interface AgentToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, {
      type: string;
      description: string;
      enum?: string[];
    }>;
    required?: string[];
  };
}

// Category = grouping for use cases (e.g., 'Group by Error Type')
export type Category = 'Baseline' | 'Smart Contextual Menu' | 'RCA' | 'Conversational Queries' | 'Top 10 Browsed Products' | 'Errors by Service' | 'Group by Error Type' | string;

// Version snapshot - immutable record of test case content at a point in time
export interface TestCaseVersion {
  version: number;
  createdAt: string;

  // Content fields (snapshot)
  initialPrompt: string;
  context: AgentContextItem[];
  tools?: AgentToolDefinition[];
  expectedPPL?: string;
  expectedOutcomes?: string[];  // NEW: Simple text descriptions of expected behavior
  expectedTrajectory?: {  // Keep for backwards compat
    step: number;
    description: string;
    requiredTools: string[];
  }[];
  followUpQuestions?: {
    trigger: 'results_available' | 'error' | 'always';
    question: string;
    businessValue: string;
  }[];
}

// TestCase is referred to as "Use Case" in the UI
export interface TestCase {
  id: string;
  name: string;
  description: string;

  // Labels - unified tagging system (replaces category/subcategory/difficulty)
  labels: string[];

  // Legacy fields - kept for backward compatibility during migration
  // These are derived from labels if labels exist, otherwise from stored values
  /** @deprecated Use labels with 'category:' prefix instead */
  category: Category;
  /** @deprecated Use labels with 'subcategory:' prefix instead */
  subcategory?: string;
  /** @deprecated Use labels with 'difficulty:' prefix instead */
  difficulty: Difficulty;

  // Versioning
  currentVersion: number;           // Latest version number
  versions: TestCaseVersion[];      // All versions (immutable history)

  // Metadata
  isPromoted: boolean;              // Available for experiments
  createdAt: string;
  updatedAt: string;

  // Current version content (convenience accessors - mirrors latest version)
  initialPrompt: string;
  context: AgentContextItem[]; // AG-UI format context passed to agent
  tools?: AgentToolDefinition[]; // Tools available to the agent (client-provided)
  expectedPPL?: string; // Expected PPL query for validation
  expectedOutcomes?: string[];  // NEW: Simple text descriptions of expected behavior
  expectedTrajectory?: {  // Keep for backwards compat
    step: number;
    description: string;
    requiredTools: string[];
  }[];
  followUpQuestions?: { // Suggested follow-ups after results
    trigger: 'results_available' | 'error' | 'always';
    question: string;
    businessValue: string;
  }[];
}

export interface OpenSearchLog {
  timestamp: string;
  index: string;
  message: string;
  level?: string;
  source?: string;
  [key: string]: any; // Allow additional fields
}

export interface LogQueryParams {
  startTime: Date;
  endTime: Date;
  size?: number;
  query?: string;
}

// ============ Trace Metrics ============

export interface TraceMetrics {
  runId: string;
  traceId?: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  durationMs: number;
  llmCalls: number;
  toolCalls: number;
  toolsUsed: string[];
  status: 'success' | 'error' | 'pending';
}

// ============ Trace Types ============

export interface SpanEvent {
  name: string;
  time: string;
  attributes?: Record<string, any>;
}

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTime: string;
  endTime: string;
  duration?: number;
  status: 'OK' | 'ERROR' | 'UNSET';
  attributes?: Record<string, any>;
  events?: SpanEvent[];
  children?: Span[];
  depth?: number;
  hasChildren?: boolean;
}

export interface TimeRange {
  startTime: number;
  endTime: number;
  duration: number;
}

export interface TraceQueryParams {
  traceId?: string;
  runIds?: string[];
  startTime?: number;  // Unix timestamp ms
  endTime?: number;    // Unix timestamp ms
  size?: number;
  serviceName?: string;
  textSearch?: string;
}

export interface TraceSearchResult {
  spans: Span[];
  total: number;
}

/**
 * Summary of a single trace (grouped spans)
 * Used for trace list display before selecting one for detailed view
 */
export interface TraceSummary {
  traceId: string;
  serviceName: string;
  spanCount: number;
  rootSpanName: string;
  startTime: string;
  duration: number;
  hasErrors: boolean;
  spans: Span[];
}

// ============ Trace Tree View Types ============

/**
 * Span category based on OTel GenAI semantic conventions
 * @see https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/
 */
export type SpanCategory = 'AGENT' | 'LLM' | 'TOOL' | 'ERROR' | 'OTHER';

/**
 * Extended span with category metadata for tree visualization
 */
export interface CategorizedSpan extends Span {
  category: SpanCategory;
  categoryLabel: string;
  categoryColor: string;
  categoryIcon: string; // lucide-react icon name
  displayName: string; // Constructed label using OTel attributes
}

/**
 * Configuration for tool similarity grouping
 */
export interface ToolSimilarityConfig {
  /** Which tool arguments to use for determining "sameness" */
  keyArguments: string[];
  /** Whether grouping is enabled */
  enabled: boolean;
}

/**
 * Grouped tool spans for similarity view
 */
export interface ToolGroup {
  toolName: string;
  keyArgsValues: Record<string, any>;
  spans: CategorizedSpan[];
  count: number;
  totalDuration: number;
  avgDuration: number;
}

// ============ Trace Comparison Types ============

/**
 * Aligned span pair for tree comparison
 */
export interface AlignedSpanPair {
  type: 'matched' | 'added' | 'removed' | 'modified';
  leftSpan?: CategorizedSpan;
  rightSpan?: CategorizedSpan;
  similarity?: number;
  children?: AlignedSpanPair[];
}

/**
 * Result of comparing two trace trees
 */
export interface TraceComparisonResult {
  alignedTree: AlignedSpanPair[];
  stats: {
    totalLeft: number;
    totalRight: number;
    matched: number;
    added: number;
    removed: number;
    modified: number;
  };
}

// ============ Trace Flow View Types ============

/**
 * Data payload for span nodes in React Flow
 * Index signature required for React Flow compatibility
 */
export interface SpanNodeData extends Record<string, unknown> {
  span: CategorizedSpan;
  totalDuration: number;
}

/**
 * Result of transforming spans to React Flow format
 */
export interface FlowTransformResult {
  nodes: Node<SpanNodeData>[];
  edges: Edge[];
}

/**
 * Options for flow transformation
 */
export interface FlowTransformOptions {
  direction?: 'TB' | 'LR'; // Top-to-bottom or Left-to-right
  mode?: 'hierarchy' | 'execution-order'; // Flow mode: parent-child hierarchy or execution-order linking
  nodeWidth?: number;
  nodeHeight?: number;
  nodeSpacingX?: number;
  nodeSpacingY?: number;
}

/**
 * Group of spans detected as parallel execution
 */
export interface ParallelGroup {
  spans: CategorizedSpan[];
  startTime: number;
  endTime: number;
}

// ============ Intent View Types ============

/**
 * Result of checking OTEL GenAI semantic convention compliance
 */
export interface OTelComplianceResult {
  isCompliant: boolean;
  missingAttributes: string[];
}

/**
 * Compressed node for Intent view - represents one or more consecutive same-category spans
 */
export interface IntentNode {
  id: string;
  category: SpanCategory;
  spans: CategorizedSpan[];      // 1 or more spans in this group
  count: number;                 // Number of spans (for "×N" badge)
  displayName: string;           // e.g., "LLM" or "TOOL ×2"
  subtitle: string;              // e.g., "callModel" or "search_api, list_items"
  hasWarnings: boolean;          // Any span missing OTEL conventions
  executionOrder: number;        // Position in time-series sequence
  startIndex: number;            // 0-based index of first span in global sequence
  totalDuration: number;         // Combined duration of all spans in this node (ms)
}

// ============ Storage Metadata Types ============

/**
 * Metadata about storage availability and data source
 * Included in list responses to inform clients about data provenance
 */
export interface StorageMetadata {
  /** Whether storage backend is configured (env vars set) */
  storageConfigured: boolean;
  /** Whether storage backend was reachable on this request */
  storageReachable: boolean;
  /** Count of items from persistent storage */
  realDataCount: number;
  /** Count of items from built-in sample data */
  sampleDataCount: number;
  /** Optional warning messages (e.g., connection errors) */
  warnings?: string[];
}

/**
 * Generic list response wrapper with metadata
 */
export interface ListResponse<T> {
  data: T[];
  total: number;
  meta: StorageMetadata;
}

// ============ Benchmark Types ============

// Denormalized stats for a benchmark run (computed from reports, stored on run for fast access)
export interface RunStats {
  /** Number of test cases that passed (passFailStatus === 'passed') */
  passed: number;
  /** Number of test cases that failed (passFailStatus === 'failed' or execution failed) */
  failed: number;
  /** Number of test cases still pending (running, or report not yet available) */
  pending: number;
  /** Total number of test cases in the run */
  total: number;
}

// Result status for a single use case within a run
export type RunResultStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

// Overall status for a benchmark run (tracks server-side execution state)
export type BenchmarkRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

// Version snapshot - immutable record of benchmark test case list at a point in time
export interface BenchmarkVersion {
  version: number;
  createdAt: string;
  testCaseIds: string[];
}

// Test case snapshot captured at run execution time (for reproducibility)
export interface TestCaseSnapshot {
  id: string;
  version: number;  // Which version of the test case was used
  name: string;     // Captured at run time for display
}

// Point-in-time snapshot (renamed from ExperimentVariant)
// Each run captures config + results at a moment in time
export interface BenchmarkRun {
  id: string;
  name: string;                    // e.g., "Baseline", "With Fix v1", "Claude 4 Test"
  description?: string;            // Optional description of what this run tests
  createdAt: string;               // When this run was created

  // Execution status (tracks server-side execution progress)
  status?: BenchmarkRunStatus;     // Overall run status (undefined = legacy data, treat as completed)
  error?: string;                  // Error message if status is 'failed'

  // Configuration snapshot
  agentKey: string;                // Reference to AgentConfig.key
  agentEndpoint?: string;          // Override agent endpoint (optional)
  modelId: string;                 // Model to use (also determines judge provider)
  headers?: Record<string, string>; // Custom headers

  // Version tracking (for reproducibility)
  benchmarkVersion?: number;       // Which benchmark version was executed (undefined = legacy data)
  testCaseSnapshots?: TestCaseSnapshot[];  // Snapshot of each test case at execution time

  // Results (directly embedded, no separate VariantRun type)
  results: Record<string, {        // testCaseId → result
    reportId: string;              // References EvaluationReport.id
    status: RunResultStatus;
  }>;

  // Denormalized stats (computed from reports, stored for fast list display)
  // Optional during migration period - will be populated by migration CLI or on next run completion
  stats?: RunStats;
}

// Parent entity - persisted to localStorage['benchmarks']
export interface Benchmark {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;

  // Versioning (test case list changes create new versions; metadata edits don't)
  currentVersion: number;          // Latest version number (1-indexed)
  versions: BenchmarkVersion[];    // All versions (immutable history)

  // Current version content (convenience accessor - mirrors latest version)
  testCaseIds: string[];           // Selected test case IDs (TestCase.id)
  runs: BenchmarkRun[];            // Point-in-time snapshots (can add more anytime)
}

// Progress callback for benchmark runner
export interface BenchmarkProgress {
  currentTestCaseIndex: number;
  totalTestCases: number;
  currentRunId: string;
  currentTestCaseId: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
}

// SSE event payload when benchmark run starts
export interface BenchmarkStartedEvent {
  runId: string;
  testCases: Array<{ id: string; name: string; status: 'pending' }>;
}

// Backwards compatibility aliases
/** @deprecated Use BenchmarkRunStatus instead */
export type ExperimentRunStatus = BenchmarkRunStatus;
/** @deprecated Use BenchmarkRun instead */
export type ExperimentRun = BenchmarkRun;
/** @deprecated Use Benchmark instead */
export type Experiment = Benchmark;
/** @deprecated Use BenchmarkProgress instead */
export type ExperimentProgress = BenchmarkProgress;
/** @deprecated Use BenchmarkStartedEvent instead */
export type ExperimentStartedEvent = BenchmarkStartedEvent;

// ============ Comparison Types ============

// Test case version reference for detecting changes between runs in comparisons
export interface TestCaseVersionRef {
  id: string;
  version: string;      // e.g., "v1", "v2"
  hash: string;         // Hash of expectedTrajectory for change detection
}

// Aggregate metrics for a single run
export interface RunAggregateMetrics {
  runId: string;
  runName: string;
  createdAt: string;
  modelId: string;
  agentKey: string;
  totalTestCases: number;
  passedCount: number;
  failedCount: number;
  avgAccuracy: number;
  passRatePercent: number;
  // Trace metrics (optional - populated from metrics API)
  totalTokens?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCostUsd?: number;
  avgDurationMs?: number;
  totalLlmCalls?: number;
  totalToolCalls?: number;
}

// Result for a single test case within a run
export interface TestCaseRunResult {
  reportId?: string;
  status: 'completed' | 'failed' | 'missing';
  passFailStatus?: PassFailStatus;
  accuracy?: number;
  faithfulness?: number;
  trajectoryAlignment?: number;
  latencyScore?: number;
  testCaseVersion?: string;
}

// Per-test-case comparison row
export interface TestCaseComparisonRow {
  testCaseId: string;
  testCaseName: string;
  labels: string[]; // Unified labels system
  /** @deprecated Use labels instead */
  category: Category;
  /** @deprecated Use labels instead */
  difficulty: Difficulty;
  results: Record<string, TestCaseRunResult>; // keyed by runId
  hasVersionDifference: boolean;
  versions: string[]; // unique versions across runs
}

// ============ Derived Types ============

// Derived type for creating new benchmark runs - stays in sync with BenchmarkRun
export type RunConfigInput = Pick<BenchmarkRun,
  'name' | 'description' | 'agentKey' | 'modelId' | 'agentEndpoint' | 'headers'
>;

// ============ Server/API Types ============

// Express type helpers (for server routes)
import type { Request, Response } from 'express';

export interface TypedRequest<T = any> extends Request {
  body: T;
}

export interface TypedResponse<T = any> extends Response {
  json: (body: T) => this;
}

// Expected step format for judge evaluation
export interface ExpectedStep {
  description: string;
  requiredTools?: string[];
}

// API request/response types
export interface JudgeRequest {
  trajectory: TrajectoryStep[];
  expectedTrajectory: ExpectedStep[];
  logs?: OpenSearchLog[];
}

export interface JudgeResponse {
  passFailStatus: PassFailStatus;
  metrics: EvaluationMetrics;
  llmJudgeReasoning: string;
  improvementStrategies: ImprovementStrategy[];
  duration: number;
}

export interface AgentProxyRequest {
  endpoint: string;
  payload: any;
  headers?: Record<string, string>;
}

export interface StorageConfig {
  endpoint?: string;
  username?: string;
  password?: string;
  indexes: {
    testCases: string;
    benchmarks: string;
    runs: string;
    analytics: string;
  };
}

export interface OpenSearchConfig {
  endpoint: string;
  username: string;
  password: string;
  indexPattern: string;
}

export interface LogsQuery {
  runId?: string;
  query?: string;
  startTime?: number;
  endTime?: number;
  size?: number;
}

export interface LogsResponse {
  hits: { hits: any[]; total: any };
  logs: OpenSearchLog[];
  total: number;
}

export interface HealthStatus {
  status: 'ok' | 'error' | 'not_configured';
  error?: string;
  index?: string;
  cluster?: any;
}

export interface AggregateMetrics {
  totalRuns: number;
  successRate: number;
  totalCostUsd: number;
  avgCostUsd: number;
  avgDurationMs: number;
  p50DurationMs: number;
  p95DurationMs: number;
  avgTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  avgLlmCalls: number;
  avgToolCalls: number;
}

export interface MetricsResult {
  runId: string;
  traceId: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  durationMs: number;
  llmCalls: number;
  toolCalls: number;
  toolsUsed: string[];
  status: 'pending' | 'success' | 'error';
}

// ============ Data Source Configuration Types ============

/**
 * Base cluster configuration (endpoint + credentials)
 * Used for connecting to OpenSearch or other data sources
 */
export interface ClusterConfig {
  endpoint: string;
  username?: string;
  password?: string;
  tlsSkipVerify?: boolean; // default: false (verify certs)
}

/**
 * Storage cluster configuration - endpoint + credentials only
 * Index names (evals_test_cases, evals_experiments, evals_runs, evals_analytics)
 * are hardcoded in the adapter and not user-configurable.
 */
export type StorageClusterConfig = ClusterConfig;

/**
 * Observability cluster configuration - endpoint + credentials + OTEL index patterns
 * Used for traces, logs, and metrics from OpenTelemetry instrumentation
 */
export interface ObservabilityClusterConfig extends ClusterConfig {
  indexes?: {
    traces?: string;   // default: 'otel-v1-apm-span-*'
    logs?: string;     // default: 'ml-commons-logs-*'
    metrics?: string;  // default: 'otel-v1-apm-service-map*'
  };
}

/**
 * Full data source configuration stored in localStorage
 * Both storage and observability can point to the same or different clusters
 */
export interface DataSourceConfig {
  storage?: StorageClusterConfig;
  observability?: ObservabilityClusterConfig;
}

/**
 * Adapter type for data sources
 * 'opensearch' is the default, 'memory' is for testing/demo
 */
export type DataSourceAdapterType = 'opensearch' | 'memory';