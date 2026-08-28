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
export type JudgeProvider = 'demo' | 'bedrock' | 'openai-compatible' | 'litellm' | 'claude-code' | 'agentic' | 'pi' | 'agent';

// ============ AI Assistant Types ============

export interface AssistantMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export interface AssistantContext {
  currentUrl?: string;
  benchmarkId?: string;
  runId?: string;
  traceId?: string;
  testCaseId?: string;
  /**
   * On comparison pages (`/compare/:benchmarkId?runs=a,b,…`), the list of run
   * IDs the user is currently comparing. The assistant pre-loads these into
   * the grounded snapshot so it can answer cross-run questions even before
   * reaching for tools.
   */
  comparisonRunIds?: string[];
}

// Connector protocol for agent communication
export type ConnectorProtocol = 'agui-streaming' | 'rest' | 'openai-compatible' | 'subprocess' | 'claude-code' | 'pi' | 'strands' | 'langgraph' | 'mock';

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

export interface AfterResponseContext {
  response: any;
  trajectory: TrajectoryStep[];
  runId?: string;
  /** Full array of raw events from the connector (protocol-specific) */
  rawEvents?: any[];
  /** Connector metadata (e.g., threadId, sessionId, exitCode) */
  metadata?: Record<string, any>;
}

export interface BuildTrajectoryContext {
  spans: Span[];
  runId: string;
}

/**
 * Context passed to a custom judge hook.
 * Contains all data needed for evaluation: trajectory, traces, and expected outcomes.
 * Also provides fetchTraces as an SDK utility for additional trace fetching.
 */
export interface JudgeContext {
  trajectory: TrajectoryStep[];
  traces: Span[];
  expectedOutcomes: string[];
  expectedTrajectory?: string[];
  runId: string;
  /** SDK utility: fetch traces by run IDs from OpenSearch */
  fetchTraces: (runIds: string[]) => Promise<{ spans: Span[] }>;
}

/**
 * Result returned by a custom judge hook.
 */
export interface JudgeResult {
  passFailStatus: 'passed' | 'failed';
  metrics: {
    accuracy: number;
    faithfulness?: number;
    latency_score?: number;
    trajectory_alignment_score?: number;
    [key: string]: number | undefined;
  };
  llmJudgeReasoning: string;
  improvementStrategies?: string[];
}

export interface AgentHooks {
  /**
   * Called before sending request to agent.
   * Use to modify endpoint, payload, or headers.
   */
  beforeRequest?: (context: BeforeRequestContext) => Promise<BeforeRequestContext>;

  /**
   * Called after receiving response from agent.
   * Use to extract runId from custom response formats (e.g., PER memory_id).
   */
  afterResponse?: (context: AfterResponseContext) => Promise<AfterResponseContext>;

  /**
   * Called when building trajectory from OTEL traces.
   * Use to customize trajectory extraction for agents with custom span formats.
   */
  buildTrajectory?: (context: BuildTrajectoryContext) => Promise<TrajectoryStep[]>;

  /**
   * Custom judge hook. When defined, replaces the built-in Bedrock judge.
   * Receives trajectory + traces + expected outcomes, returns pass/fail evaluation.
   *
   * @example
   * ```typescript
   * hooks: {
   *   judge: async ({ trajectory, traces, expectedOutcomes, fetchTraces }) => {
   *     // Custom evaluation logic using traces
   *     const relevantSpans = traces.filter(s => s.attributes?.['gen_ai.system']);
   *     return {
   *       passFailStatus: relevantSpans.length > 0 ? 'passed' : 'failed',
   *       metrics: { accuracy: 85 },
   *       llmJudgeReasoning: 'Custom evaluation based on trace analysis',
   *     };
   *   }
   * }
   * ```
   */
  judge?: (context: JudgeContext) => Promise<JudgeResult>;
}

export interface AgentConfig {
  key: string; // Unique identifier for the agent (used for env var prefix)
  name: string;
  endpoint: string;
  description?: string;
  enabled?: boolean;
  headers?: Record<string, string>; // Custom headers for agent endpoint (e.g., AWS credentials)
  auth?: ConnectorAuthConfig; // Explicit auth config (preferred over headers inference)
  useTraces?: boolean; // When true, fetch traces instead of logs for evaluation
  /**
   * Configurable trace polling settings (used when `useTraces: true`).
   *
   * Two distinct polling paths honour these values, with different defaults
   * because they have different ergonomic constraints:
   *
   *   - **Judge poller** (`services/traces/tracePoller.ts`, runs in the
   *     background after the agent finishes, before the LLM judge fires)
   *     defaults to `intervalMs: 10000` and `maxAttempts: 60` — a 10-minute
   *     total budget that's fine because the user already sees a "pending"
   *     badge while it polls.
   *   - **SDK pre-load** (`services/traces/fetchSpansForRun.ts`, runs
   *     synchronously inside a deterministic test body before the body's
   *     first assertion) defaults to `intervalMs: 1000` and `maxAttempts:
   *     10` — a ~10-second total budget so the test isn't blocked.
   *
   * Both paths additionally honour `TRACE_POLL_INTERVAL_MS` and
   * `TRACE_POLL_MAX_ATTEMPTS` env vars (the env vars override the
   * code defaults), and both enforce a hard ceiling of 60 attempts so
   * a misconfigured agent can't lock a test for an unbounded time.
   *
   * Setting either field on this object overrides the path's own default
   * for that specific agent on both paths.
   */
  tracePolling?: {
    intervalMs?: number;
    maxAttempts?: number;
  };
  /**
   * OTel `service.name` resource attribute that this agent reports under.
   * Defaults to {@link AgentConfig.key} when not set, which is correct for
   * agents whose OTel SDK uses the same identifier as the config key (e.g.
   * `claude-code`). Override only when the agent's OTel service name differs
   * from its config key, e.g. `observio` -> `observio-sample-agent`.
   *
   * Used by the Agent Traces page to translate the user's cross-page agent
   * filter (`agent-health:prefs:agentFilter`, which stores agent keys) into
   * the actual `service.name` to filter by in OpenSearch queries.
   */
  traceServiceName?: string;
  connectorType?: ConnectorProtocol; // Connector protocol (defaults to 'agui-streaming')
  connectorConfig?: Record<string, any>; // Connector-specific configuration
  hooks?: AgentHooks; // Lifecycle hooks for custom setup/transform logic
  isCustom?: boolean; // True for user-added custom endpoints (not from config file)
  builtIn?: boolean; // True for built-in agents shipped with the tool
}

/**
 * Authentication config for agents (serializable subset of ConnectorAuth).
 * Used in AgentConfig for config files — avoids importing connector types.
 */
export interface ConnectorAuthConfig {
  type: 'none' | 'basic' | 'bearer' | 'api-key' | 'aws-sigv4';
  username?: string;
  password?: string;
  token?: string;
  awsRegion?: string;
  awsService?: string;
  headers?: Record<string, string>;
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
  accuracy?: number; // 0-100
  // Legacy metrics - kept for backwards compatibility with old reports
  faithfulness?: number; // 0-100 (deprecated)
  latency_score?: number; // 0-100 (deprecated)
  trajectory_alignment_score?: number; // 0-100 (deprecated)
  // Dynamic metrics - populated based on evaluator's scoring config
  [key: string]: number | undefined;
}

export interface ImprovementStrategy {
  category: string;
  issue: string;
  recommendation: string;
  priority: 'high' | 'medium' | 'low';
}

// ============ Evaluator Types (Pluggable Judge System) ============

/**
 * Scoring metric definition for evaluators
 */
export interface ScoringMetric {
  name: string;              // Metric name (e.g., 'accuracy', 'factual_accuracy')
  description?: string;      // Human-readable description
  weight: number;            // Weight in overall score (0-1)
  scale: number;             // Max value (e.g., 100 for 0-100 scale)
}

/**
 * Scoring configuration for an evaluator
 */
export interface ScoringConfig {
  metrics: ScoringMetric[];  // Metrics to evaluate
  passThreshold: number;     // Minimum score to pass (0-100)
  scale: number;             // Overall scale (typically 100)
}

/**
 * Inference configuration for an evaluator
 */
export interface InferenceConfig {
  provider?: JudgeProvider;  // Judge provider (bedrock, openai-compatible, demo)
  modelId?: string;          // Model ID override
  temperature?: number;      // Temperature for LLM
  maxTokens?: number;        // Max output tokens
}

/**
 * Evaluator version - immutable snapshot of evaluator configuration
 */
export interface EvaluatorVersion {
  version: number;
  createdAt: string;

  // Content fields (snapshot)
  systemPrompt: string;
  scoringConfig: ScoringConfig;
  inferenceConfig: InferenceConfig;
}

/**
 * Evaluator - pluggable judge configuration
 * Defines how agent performance is evaluated
 */
export interface Evaluator {
  id: string;
  name: string;
  description: string;

  // System flag - built-in evaluators that can't be deleted
  isSystem: boolean;

  // Tags for categorization
  tags?: string[];

  // Versioning (follows TestCase pattern)
  currentVersion: number;
  versions: EvaluatorVersion[];

  // Metadata
  createdAt: string;
  updatedAt: string;
  author?: string;

  // Current version content (convenience accessors - mirrors latest version)
  systemPrompt: string;
  scoringConfig: ScoringConfig;
  inferenceConfig: InferenceConfig;
}

export type PassFailStatus = 'passed' | 'failed';

// Storage feature - LLM Judge Response tracking
export interface LLMJudgeResponse {
  modelId: string;
  timestamp: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  /**
   * Raw judge text exactly as the model returned it (pre-JSON-parse). Set
   * by the routing layer from `JudgeResponse.rawResponse`. Older callers
   * stuffed the parsed `llmJudgeReasoning` into this field as a fallback;
   * post evaluator-prompt-plumbing the field carries the actual unparsed
   * model output for debugging "prompt edited but output didn't change"
   * scenarios.
   */
  rawResponse: string;
  /**
   * Parsed numeric metrics. Open-ended `[key: string]: number` so a saved
   * evaluator can declare arbitrary metric names in its `scoringConfig.metrics`
   * and they flow through here unchanged. Legacy keys (`accuracy`,
   * `faithfulness`, `latency_score`, `trajectory_alignment_score`) remain
   * conventional but are no longer required — evaluators are pluggable.
   */
  parsedMetrics?: { [key: string]: number | undefined };
  improvementStrategies?: ImprovementStrategy[];
  error?: string;
  /**
   * Any JSON keys the judge emitted that did NOT map onto a typed wire
   * field or a declared metric. Captured by
   * {@link parseJudgeResponse} (server/services/judgeResponseParser) so the
   * run-detail "Judge debug" surface can show prompt-iteration output (e.g.
   * `improvement_candidates`, `failure_tags`, `confidence`) without a code
   * change. Empty/undefined when the model emitted only typed fields.
   */
  extraFields?: Record<string, unknown>;
  /**
   * Optional debug breadcrumbs persisted when `AH_JUDGE_DEBUG=1` (or in dev
   * mode). Captures exactly what the run-detail UI needs to confirm "the
   * prompt I saved is the prompt that ran" — the system prompt the model
   * received, the user prompt, and which provider executed the call. The
   * raw response itself is on the parent {@link rawResponse}.
   *
   * Disabled by default to keep persisted run docs lean (system prompts
   * can be 10–20 KB).
   */
  judgeDebug?: {
    /** Provider that executed the call: 'bedrock' | 'claude-code' | 'pi' | 'agent' | 'agentic' | 'openai-compatible' | 'litellm'. */
    provider?: string;
    /** Effective model id passed to the provider (post-resolution). */
    modelId?: string;
    /** Evaluator id used (system or user). */
    evaluatorId?: string;
    /** The full system prompt the model received. */
    systemPrompt?: string;
    /** The user-message prompt the model received. */
    userPrompt?: string;
  };
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

/**
 * @experimental Generic sidecar metadata for coding agent sessions.
 * One document per session — stores annotations, status, tags, or any
 * user-defined fields. The shape is intentionally open so callers can
 * store whatever debug/analysis data they need.
 */
export interface SessionMetadata {
  agentKind: string;
  sessionId: string;
  /** Open-ended — callers define the schema. */
  [key: string]: unknown;
}

// Metrics status for trace-mode runs (traces take ~5 min to propagate)
export type MetricsStatus = 'pending' | 'calculating' | 'ready' | 'error';

// TestCaseRun = result of running a specific test case version (renamed from EvaluationReport)
export interface TestCaseRun {
  id: string;
  timestamp: string;
  /**
   * Human-readable name for this run (e.g. "Baseline", "Claude_02").
   * Set from the user-supplied value in the run config dialog, or auto-generated
   * server-side as `Run <short-id>` if not provided. Optional for backwards
   * compatibility with runs created before the field existed — UI consumers
   * should fall back to a generated label (see `getRunDisplayName`).
   */
  name?: string;
  /** Optional human-readable description of what this run was testing. */
  description?: string;
  testCaseId: string;
  testCaseVersion?: number;          // Which version was run (optional for backwards compatibility)
  experimentId?: string;             // ID of the benchmark (field name preserved for storage compatibility)
  experimentRunId?: string;          // ID of the benchmark run (field name preserved for storage compatibility)

  // Execution context
  agentName: string;
  agentKey?: string;
  modelName: string;
  modelId?: string;
  /**
   * Optional judge model id, separate from {@link modelId} (which is the
   * agent's LLM). Set explicitly via the run config (UI dropdown / CLI
   * `--judge-model` / API `judgeModelId` field) or left unset to fall back
   * to the evaluator's `inferenceConfig.modelId`, then the server-default
   * Bedrock judge model. For agentic providers (`pi`, `agent`, `agentic`,
   * `claude-code`) the value is informational — the provider picks its own
   * model from its credentialed registry. Stored on the run document so the
   * "Judge debug" surface and audit trail show which judge model was used.
   */
  judgeModelId?: string;
  agentEndpoint?: string;
  evaluatorId?: string;              // Which evaluator was used (optional for backwards compatibility)

  // Results
  status: 'running' | 'completed' | 'failed';
  passFailStatus?: PassFailStatus; // LLM judge determination of pass/fail
  trajectory: TrajectoryStep[];
  metrics: EvaluationMetrics;
  /**
   * @deprecated Use `getJudgeReasoningText(report)` /
   * `getJudgeMatcherResults(report)` from `lib/matchers/judgeAccessor`.
   * The canonical judge surface is now `matcherResults[]` with
   * `method: 'llm-judge'`. This flat-string field is kept as an
   * Option-B backward-compat shim — it carries the most recent judge
   * reasoning so old direct readers keep working, but new code MUST
   * use the accessor.
   */
  llmJudgeReasoning: string;
  improvementStrategies?: ImprovementStrategy[];
  llmJudgeResponse?: LLMJudgeResponse; // Storage: Raw Bedrock judge response
  /**
   * W3C OTel trace id (32 hex). Stamped onto the run document at save time
   * when polled spans expose one, used as the strongest correlation key for
   * the run-detail Traces tab and the agent (trace) judge's `query_spans`
   * tool. See #190 (this field as a top-level shortcut over re-extracting
   * from `spans[0]`) and #264 (unified trace correlation strategies).
   *
   * Distinct from {@link runId} (the connector's run id, e.g.
   * `subprocess-<timestamp>`); pre-fix the runner mis-stamped runId here
   * which broke `traceId`-based queries.
   */
  traceId?: string;
  openSearchLogs?: OpenSearchLog[]; // Storage: Persisted logs (alternative to logs)
  annotations?: RunAnnotation[]; // Storage: User notes on this run
  runId?: string; // Agent's run ID from AG UI events (for log correlation)
  /**
   * Agent-emitted session id (e.g. Claude Code stamps `session.id` on every
   * span of a run). Captured from the connector result and used as a precise
   * per-run trace correlator (Strategy D) for agents that emit it but don't
   * propagate W3C context or tag our `agent_health.run.id`.
   */
  sessionId?: string;
  logs?: OpenSearchLog[]; // OpenSearch logs for the run (master version)
  rawEvents?: any[]; // Raw AG UI events for debugging
  connectorProtocol?: ConnectorProtocol; // Protocol used to execute this run (for trajectory parsing)

  // Per-matcher verdicts captured by the SDK during the test body
  // execution. One entry per `expect(...).to.X(...)`, `judge(...)`, or
  // traces helper invocation. UI consumers render this as a breakdown.
  matcherResults?: import('../lib/matchers/types.js').MatcherResult[];

  // Server-side performance metrics (timing data from evaluation execution)
  performanceMetrics?: TestCasePerformanceMetrics;

  // Trace mode fields (for agents with useTraces: true)
  metricsStatus?: MetricsStatus; // Status of deferred metrics/judge calculation
  traceFetchAttempts?: number; // Number of polling attempts for traces
  lastTraceFetchAt?: string; // Timestamp of last trace fetch attempt
  traceError?: string; // Error message if trace fetch failed
  spans?: Span[]; // Fetched trace spans for debugging
}

// Alias for backwards compatibility during migration
export type EvaluationReport = TestCaseRun;

export type ContextItemDisposition = 'prompt' | 'connector' | 'documentation';

export interface AgentContextItem {
  description: string;
  value: string; // JSON stringified context data
  /** How this item is consumed. Absent is equivalent to `prompt`. */
  disposition?: ContextItemDisposition;
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
  // initialPrompt is optional: code-based test cases without a prompt cause
  // the runner to skip agent invocation entirely (deterministic-only tests).
  initialPrompt?: string;
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

  // Source provenance (code-imported test cases)
  sourceFile?: string;              // Relative path: "evals/cybergym.eval.ts"
  sourceHash?: string;              // SHA-256 of per-test-case content (for drift detection)

  // Metadata
  isPromoted: boolean;              // Available for experiments
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;               // Timestamp of the most recent evaluation run

  // Current version content (convenience accessors - mirrors latest version)
  // Optional because code-based test cases may have no prompt at all
  // (deterministic-only tests where the runner skips agent invocation).
  initialPrompt?: string;
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
  sessionId?: string;  // Claude Code session.id — fetches all traces in a session
  startTime?: number;  // Unix timestamp ms
  endTime?: number;    // Unix timestamp ms
  size?: number;
  serviceName?: string;
  textSearch?: string;
  cursor?: string; // For pagination
  /**
   * Strategy C (opt-in): include any spans where `serviceName` matches AND
   * `startTime` falls within `[startedAt, endedAt]`. Used by the run-report
   * Traces tab as a fallback for agents that don't propagate W3C trace context
   * (TRACEPARENT) and don't tag spans with `gen_ai.request.id` matching our
   * runId. May surface unrelated spans (concurrent runs, cross-team noise).
   * See AGENTS.md → Trace correlation conventions.
   *
   * Strategy D: when `sessionId` is set on an entry, correlate precisely on
   * `attributes.session.id` (unioned with the service.name + window fallback).
   */
  agents?: Array<{ serviceName: string; startedAt: number; endedAt: number; sessionId?: string }>;
}

export interface ConversationMessage {
  id: string;
  timestamp: string;
  role: 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'system';
  content: string;
  metadata?: {
    spanId?: string;
    spanName?: string;
    toolName?: string;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    durationMs?: number;
  };
}

export interface TraceSearchResult {
  spans: Span[];
  total: number;
  warning?: string;
  warningCategory?: 'auth' | 'connection' | 'index_not_found' | 'not_configured' | 'unknown';
  suggestion?: string;
  nextCursor?: string | null;
  hasMore?: boolean;
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
  hasEvalSpans?: boolean;
  spans: Span[];
}

// ============ Trace Tree View Types ============

/**
 * Span category based on OTel GenAI semantic conventions
 * @see https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/
 */
export type SpanCategory = 'AGENT' | 'LLM' | 'TOOL' | 'EVAL' | 'ERROR' | 'OTHER';

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
  /** Whether sample/demo data was included in this response */
  sampleDataIncluded?: boolean;
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

// ============ Server Performance Metrics ============

/** Server-side performance metrics for a single test case evaluation */
export interface TestCasePerformanceMetrics {
  durationMs: number;                    // Total wall-clock time
  agentDurationMs: number;               // Time in connector.execute()
  judgeDurationMs?: number;              // Time in callBedrockJudge() (absent in trace mode)
  judgeAttempts?: number;               // Number of judge retry attempts
}

/** Server-side performance metrics for an entire benchmark run */
export interface RunPerformanceMetrics {
  durationMs: number;                    // Total wall-clock time for the run
  concurrency: number;                   // Effective concurrency used
  avgTestCaseDurationMs: number;         // Mean per-test-case duration
  maxTestCaseDurationMs: number;         // Slowest test case
  minTestCaseDurationMs: number;         // Fastest test case
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
  /**
   * Number of test cases where the *evaluator* could not produce a verdict
   * (e.g. judge validation error, trace polling timeout, post-trace callback
   * failed). Excluded from `passed` and `failed` so a misconfigured evaluator
   * doesn't silently poison aggregate pass rates.
   *
   * Optional for backward-compat: older stored runs predate this field and
   * read as 0.
   */
  errored?: number;
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
  modelId: string;                 // Agent's LLM (passed to the connector)
  /**
   * Optional judge model id, distinct from {@link modelId} (the agent's
   * LLM). Customer input via the run config dialog / CLI `--judge-model` /
   * API. Falls back to `evaluator.inferenceConfig.modelId`, then the
   * server-default Bedrock judge model. Ignored by agentic providers
   * (`pi`, `agent`, `agentic`, `claude-code`) which pick their own model.
   */
  judgeModelId?: string;
  evaluatorId?: string;            // Evaluator to use for judging (optional, defaults to RCA Default)
  headers?: Record<string, string>; // Custom headers
  concurrency?: number;              // Parallel test case execution limit (1 = sequential, default)

  // Version tracking (for reproducibility)
  benchmarkVersion?: number;       // Which benchmark version was executed (undefined = legacy data)
  testCaseSnapshots?: TestCaseSnapshot[];  // Snapshot of each test case at execution time

  // Results (directly embedded, no separate VariantRun type)
  results: Record<string, {        // testCaseId → result
    reportId: string;              // References EvaluationReport.id
    status: RunResultStatus;
    error?: string;                // Error message if status is 'failed'
    performanceMetrics?: TestCasePerformanceMetrics;  // Per-test-case timing data
  }>;

  // Denormalized stats (computed from reports, stored for fast list display)
  // Optional during migration period - will be populated by migration CLI or on next run completion
  stats?: RunStats;

  // Server-side performance metrics (populated after run completes)
  performanceMetrics?: RunPerformanceMetrics;
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
  currentTestCaseIndex: number;  // Kept for backward compat
  startedCount?: number;         // Number of test cases that have begun execution
  completedCount?: number;       // Actual count of finished test cases
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

// ============ Evaluation Run Types (Unified Run Architecture) ============

/**
 * Discriminator for documents in evals_benchmarks index.
 * Legacy docs without this field default to 'benchmark' via normalization.
 */
export type EvalDocType = 'benchmark' | 'evaluation-run';

/**
 * Describes where test cases came from for an evaluation run.
 * Multiple sources can be combined (union, deduplicated by test case ID).
 */
export type TestCaseSource =
  | { type: 'benchmark'; benchmarkId: string; benchmarkVersion?: number }
  | { type: 'test-case-ids'; ids: string[] }
  | { type: 'file-import'; filenames: string[]; testCaseIds: string[] }
  | { type: 'code-import'; filenames: string[]; testCaseIds: string[] }
  | { type: 'directory-import'; dirPaths: string[]; testCaseIds: string[] }
  | { type: 'label-filter'; labels: string[] };

/**
 * EvaluationRun — first-class execution record.
 * Stored as top-level doc in evals_benchmarks index with docType: 'evaluation-run'.
 * Replaces embedded BenchmarkRun as primary execution entity.
 */
export interface EvaluationRun {
  id: string;
  docType: 'evaluation-run';
  name: string;
  description?: string;
  createdAt: string;
  completedAt?: string;
  status: BenchmarkRunStatus;
  error?: string;

  // Execution config
  agentKey: string;
  agentEndpoint?: string;
  modelId: string;
  /**
   * Optional judge model id, distinct from {@link modelId} (the agent's
   * LLM). Same precedence rules as on {@link BenchmarkRun.judgeModelId}.
   */
  judgeModelId?: string;
  evaluatorId?: string;
  headers?: Record<string, string>;
  concurrency?: number;

  // Provenance — where did the test cases come from?
  sources: TestCaseSource[];
  trigger: 'ui' | 'cli' | 'api' | 'schedule';

  // Resolved test cases (snapshotted at execution time for reproducibility)
  testCaseSnapshots: TestCaseSnapshot[];

  // Results (testCaseId → individual result)
  results: Record<string, {
    reportId: string;
    status: RunResultStatus;
    error?: string;
    performanceMetrics?: TestCasePerformanceMetrics;
  }>;

  // Denormalized stats
  stats?: RunStats;

  // Performance metrics
  performanceMetrics?: RunPerformanceMetrics;

  // Benchmark association (undefined for ad-hoc runs, set for benchmark runs)
  benchmarkId?: string;
  benchmarkVersion?: number;
}

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
  /** Test cases the evaluator couldn't verdict (#242); excluded from pass rate. */
  erroredCount?: number;
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
  /**
   * Issue #242: when the evaluator could not produce a verdict
   * (`metricsStatus: 'error'` on the report), the comparison row carries
   * this flag so MetricCell can render an amber `Errored` chip distinct
   * from `Failed`. The legacy `passFailStatus` field on these reports is
   * cleared (`null`), so without this flag the cell would silently fall
   * through to `Failed` styling.
   */
  errored?: boolean;
  accuracy?: number;
  faithfulness?: number;
  trajectoryAlignment?: number;
  latencyScore?: number;
  testCaseVersion?: string;
  /** Error message if status is 'failed' */
  error?: string;
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
  'name' | 'description' | 'agentKey' | 'modelId' | 'judgeModelId' | 'agentEndpoint' | 'headers' | 'concurrency' | 'evaluatorId'
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
  expectedOutcomes?: string[];
  logs?: OpenSearchLog[];
  modelId?: string;                // Model to use for judging
  evaluatorId?: string;            // Evaluator to use (optional, defaults to RCA Default)
}

export interface JudgeResponse {
  passFailStatus: PassFailStatus;
  metrics: EvaluationMetrics;
  llmJudgeReasoning: string;
  improvementStrategies: ImprovementStrategy[];
  duration: number;
  /**
   * Set only by the demo/mock judge to flag that this verdict was NOT produced
   * by a real LLM (semi-random pass). A real provider never sets this. The
   * CLI/UI surface it so a "100% pass" from the mock can't be mistaken for a
   * real score.
   */
  warning?: string;
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
    evaluators: string;
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
  errorCategory?: 'auth' | 'connection' | 'index_not_found' | 'unknown';
  suggestion?: string;
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
 * Authentication type for OpenSearch clusters
 * - 'none': No authentication (e.g. local development clusters)
 * - 'basic': Username/password authentication (default, backwards compatible)
 * - 'sigv4': AWS SigV4 request signing for managed OpenSearch / Serverless
 */
export type ClusterAuthType = 'none' | 'basic' | 'sigv4';

/**
 * Base cluster configuration (endpoint + credentials)
 * Used for connecting to OpenSearch or other data sources
 */
export interface ClusterConfig {
  endpoint: string;
  authType?: ClusterAuthType;       // default: 'basic' (backwards compatible)
  // Basic auth
  username?: string;
  password?: string;
  // SigV4 auth
  awsProfile?: string;              // AWS profile name; uses default chain if omitted
  awsRegion?: string;               // required when authType is 'sigv4'
  awsService?: 'es' | 'aoss';      // 'es' for managed, 'aoss' for serverless; default 'es'
  tlsSkipVerify?: boolean;          // default: false (verify certs)
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
 * 'file' is the default (JSON files in .agent-health/data/)
 * 'opensearch' when storage cluster is configured
 * 'memory' is for testing/demo
 */
export type DataSourceAdapterType = 'file' | 'opensearch' | 'memory';

// Skill evaluator types
export * from './skills';