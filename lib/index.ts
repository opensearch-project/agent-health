/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Public API for @opensearch-project/agent-health
 *
 * Users can import from this module in their agent-health.config.ts files:
 *
 * @example
 * ```typescript
 * import { defineConfig, RESTConnector } from '@opensearch-project/agent-health';
 *
 * export default defineConfig({
 *   agents: [
 *     {
 *       key: 'my-agent',
 *       name: 'My Agent',
 *       endpoint: 'https://api.example.com/chat',
 *       connectorType: 'rest',
 *     },
 *   ],
 * });
 * ```
 */

// Config helpers
export { defineConfig } from './config/defineConfig.js';

// Config types
export type {
  UserConfig,
  UserAgentConfig,
  UserModelConfig,
  ResolvedConfig,
  ReporterConfig,
  JudgeConfig,
} from './config/types.js';

// Hook types (for writing typed hooks in agent-health.config.ts)
export type {
  BeforeRequestContext,
  AgentHooks,
  JudgeContext,
  JudgeResult,
  BuildTrajectoryContext,
} from '../types/index.js';

// Trace types and SDK utilities (for custom judge hooks)
export type { Span, TrajectoryStep } from '../types/index.js';
export { fetchTracesByRunIds as fetchTraces } from '../services/traces/index.js';

// Connector types (for custom connector implementations)
export type {
  AgentConnector,
  ConnectorProtocol,
  ConnectorAuth,
  ConnectorRequest,
  ConnectorResponse,
} from '../services/connectors/types.js';

// Base connector class (for extending)
export { BaseConnector } from '../services/connectors/base/BaseConnector.js';

// Built-in connectors
export { AGUIStreamingConnector } from '../services/connectors/agui/AGUIStreamingConnector.js';
export { RESTConnector } from '../services/connectors/rest/RESTConnector.js';
export { SubprocessConnector } from '../services/connectors/subprocess/SubprocessConnector.js';
export { ClaudeCodeConnector } from '../services/connectors/claude-code/ClaudeCodeConnector.js';
export { MockConnector } from '../services/connectors/mock/MockConnector.js';

// Connector registry (for programmatic registration)
export { connectorRegistry, registerConnector } from '../services/connectors/registry.js';

// ConnectorRegistry type for custom implementations
export type { ConnectorRegistry } from '../services/connectors/types.js';

// Test case SDK (for writing .eval.ts/.eval.js files)
//
// @experimental The code-based test case SDK is experimental. The API surface
// (test signature, options shape, fixtures, matcher set) may change in a
// minor release without a deprecation cycle. Pin your @opensearch-project/
// agent-health version if you depend on it. To suppress the runtime warning
// emitted when the SDK is first used, set `AH_SUPPRESS_EXPERIMENTAL=1`
// (legacy `AGENT_HEALTH_SUPPRESS_EXPERIMENTAL=1` is still accepted).
export { test, describe, beforeAll, afterAll, beforeEach, afterEach, judge } from './testCases/index.js';
export type {
  TestOptions,
  CodeTestCase,
  EvalResult,
  TestFixtures,
  TestInfo,
  HookKind,
  HookFn,
  RegisteredHook,
} from './testCases/types.js';
export type { AgentFixture, AgentRunOptions } from './testCases/index.js';
export type { Verdict, JudgeVerdict, JudgeRole, JudgeFn } from './testCases/index.js';
export { defineEvaluator, evaluate } from './testCases/index.js';
export type { EvaluatorContext, EvaluatorResult, EvaluatorFn, EvaluateFn } from './testCases/index.js';

// Per-matcher results: chai-based `expect` with our recording plugin and
// custom matchers (haveCalledTool, haveStepsOfType, haveOutputMatching,
// haveCompletedWithin), plus the traces fixture type. Verdicts produced
// by these matchers and by judge() are persisted on TestCaseRun and
// shown in the UI as a per-matcher breakdown.
export { expect } from './matchers/index.js';
export type { TracesAccessor, MatcherResult, MatcherMethod } from './matchers/index.js';

// Workflow SDK (for writing .workflow.ts files: deterministic steps over a
// work source, with bounded-concurrency agent fan-out, a cumulative feedback
// ledger, staging, and consolidation into one PR per fix-class).
//
// @experimental Same stability caveat as the test-case SDK above.
export { source, workflow, FeedbackLedger, consolidate, mapPool } from './workflow/index.js';
export type {
  WorkItem,
  SourceFetchFn,
  SourceHandle,
  AgentRunResult,
  StagedItem,
  Cluster,
  WritesMode,
  RunAgentOptions,
  WorkflowConfig,
  PRRequest,
  LedgerEntry,
  PoolStats,
  Workflow,
  WorkflowContext,
  WorkflowRunOptions,
  WorkflowResult,
  ForEachOptions,
} from './workflow/index.js';
