/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Evaluation Service
 * Main orchestrator for running agent evaluations
 */

import { v4 as uuidv4 } from 'uuid';
import { AgentConfig, EvaluationReport, TestCase, TrajectoryStep, OpenSearchLog, LLMJudgeResponse, ConnectorProtocol, BeforeRequestContext, AfterResponseContext, TestCasePerformanceMetrics } from '@/types';
import { executeBeforeRequestHook, executeAfterResponseHook } from '@/lib/hooks';
import { AGUIToTrajectoryConverter, consumeSSEStream, buildAgentPayload } from '@/services/agent';
import { AGUIEvent } from '@/types/agui';
import { generateMockTrajectory } from './mockTrajectory';
import { callBedrockJudge } from './bedrockJudge';
import { buildJudgeMatcherEntry, formatExpectedOutcomesAsClaim } from '@/lib/matchers/judgeAccessor';
import type { MatcherResult } from '@/lib/matchers/types';
import { buildJudgeAgentsHints } from '@/services/traces/judgeAgentsHints';
import { resolveConnectorWorkspaceDir } from '@/services/connectors/types';

// Re-export for use by experimentRunner when calling judge after trace polling
export { callBedrockJudge };
import { openSearchClient } from '@/services/opensearch';
import { debug } from '@/lib/debug';
import { ENV_CONFIG } from '@/lib/config';
import { DEFAULT_CONFIG } from '@/lib/constants';

// For browser/Vite builds, use DEFAULT_CONFIG directly.
// For server/CLI (Node.js), we can use loadConfigSync from lib/config/index.
// This is a runtime check to avoid importing Node.js modules in browser builds.
const getModels = () => {
  // Check if we're in a Node.js environment with file system access
  if (typeof window === 'undefined' && typeof process !== 'undefined' && process.versions?.node) {
    try {
      // Dynamic import to avoid bundling issues
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { loadConfigSync } = require('@/lib/config/index');
      return loadConfigSync().models;
    } catch {
      // Fall back to defaults
    }
  }
  return DEFAULT_CONFIG.models;
};

// Connector type imports for direct agent execution (CLI mode)
// NOTE: We only import types here to keep this file browser-compatible.
// The actual connector registry is loaded dynamically in runEvaluationWithConnector()
// to avoid bundling Node.js-only modules (subprocess, claude-code) in browser builds.
import type {
  ConnectorAuth,
  ConnectorRequest,
  AgentConfigWithConnector,
  ConnectorRegistry,
  AgentConnector,
} from '@/services/connectors';

// Toggle between mock and real agent
const USE_MOCK_AGENT = false;

/**
 * Build ConnectorAuth from AgentConfig.
 * Prefers explicit `auth` field if present, falls back to header inference.
 */
function buildConnectorAuth(agent: AgentConfig): ConnectorAuth {
  // Prefer explicit auth config (new pattern)
  if (agent.auth && agent.auth.type !== 'none') {
    return {
      ...agent.auth,
      // Merge any extra headers on top
      headers: { ...agent.headers, ...agent.auth.headers },
    };
  }

  // Legacy: infer from headers
  const headers = agent.headers || {};

  if (headers['Authorization']?.startsWith('Bearer ')) {
    return {
      type: 'bearer',
      token: headers['Authorization'].replace('Bearer ', ''),
    };
  }

  if (headers['Authorization']?.startsWith('Basic ')) {
    return {
      type: 'basic',
      token: headers['Authorization'].replace('Basic ', ''),
    };
  }

  if (headers['x-api-key']) {
    return {
      type: 'api-key',
      token: headers['x-api-key'],
    };
  }

  // Pass through all headers
  return {
    type: 'none',
    headers,
  };
}

// ─── SDK matcher-session report-level metrics shim ─────────────────────────────
//
// SDK runs (.bench.js / .eval.js with a code body) collect per-matcher
// verdicts in `report.matcherResults` and the runner then writes a
// report-level `report.metrics` with the legacy 4-key shape
// `{accuracy, faithfulness, latency_score, trajectory_alignment_score}` so
// older list/aggregate UIs keep working.
//
// Pre-fix this shim was a hardcoded `{0,0,0,0}` (failed) / `{100,100,100,100}`
// (passed). Two consequences:
//   1. A 5-of-6-passing run was indistinguishable from a 0-of-6 run — every
//      failing run looked identical in the metrics tile. (Only meaningful
//      for `judge()` matchers, which are non-throwing per RFC 004 §4.4 —
//      `expect()` is fail-fast and chai-throw goes through the evalError
//      branch below.)
//   2. A custom evaluator that emits per-claim dimensional scores via
//      `MatcherResult.judgeMetrics` (e.g. a multi-dimensional RCA rubric with
//      `routing_accuracy` / `tool_correctness` / `diagnostic_completeness`)
//      had its dimensions silently dropped at the report-level boundary.
//
// Post-fix:
//   - Aggregate `accuracy` is the percentage of GATE matchers that passed
//     (rounded to integer 0..100). `observe`-role matchers and `errored`
//     matchers are excluded from the denominator (RFC 004 §4.8).
//   - The other three legacy keys mirror `accuracy` (BC; consumers reading
//     them historically got 0/100, they now get a meaningful integer).
//   - If any matcher emitted `judgeMetrics` (per-claim dimensions, see
//     `lib/matchers/types.ts`), each dimension's MEAN across emitting gate
//     matchers overrides the BC stub for THAT key. So a 9-dimension custom
//     rubric ends up on `report.metrics` with `routing_accuracy: 87`,
//     `tool_correctness: 92`, etc., not flattened to `accuracy: <yes/no>`.
//
// `evalError` (the bench body itself threw — includes a chai `expect()`
// fail-fast assertion) bypasses the aggregate and returns `{0,0,0,0}` — the
// run never reached its conclusion so a partial aggregate is misleading.
export function computeSdkMatcherSessionMetrics(
  matcherResults: MatcherResult[],
  opts?: { hasEvalError?: boolean },
): Record<string, number> {
  if (opts?.hasEvalError) {
    return {
      accuracy: 0,
      faithfulness: 0,
      latency_score: 0,
      trajectory_alignment_score: 0,
    };
  }

  const gates = matcherResults.filter(m => m.role !== 'observe' && !m.errored);
  const total = gates.length;
  const passing = gates.filter(m => m.pass).length;
  // Vacuous pass when there are no gates (e.g. body just calls the agent
  // without any judge/expect claims, or every matcher is `observe`-role).
  // The pre-fix code returned 100 here via the `!failed` branch; keep that.
  // When some gates DID fail, return the pass-rate percentage — the actual
  // post-fix improvement, since pre-fix this collapsed to a flat 0.
  const passRatePct =
    total === 0 ? 100 : Math.round((passing / total) * 100);

  // BC stub — same number for all four legacy keys.
  const out: Record<string, number> = {
    accuracy: passRatePct,
    faithfulness: passRatePct,
    latency_score: passRatePct,
    trajectory_alignment_score: passRatePct,
  };

  // Dimensional pass-through: aggregate any per-matcher `judgeMetrics`
  // dimensions across emitting gates. Each dimension's mean (rounded) wins
  // over the BC stub for the same key.
  const sums: Record<string, number> = Object.create(null);
  const counts: Record<string, number> = Object.create(null);
  for (const m of gates) {
    const dims = (m as any).judgeMetrics as Record<string, number | undefined> | undefined;
    if (!dims) continue;
    for (const [k, v] of Object.entries(dims)) {
      if (typeof v === 'number' && Number.isFinite(v)) {
        sums[k] = (sums[k] ?? 0) + v;
        counts[k] = (counts[k] ?? 0) + 1;
      }
    }
  }
  for (const k of Object.keys(sums)) {
    out[k] = Math.round(sums[k] / counts[k]);
  }
  return out;
}

/**
 * Options for running evaluation with connector
 */
export interface RunEvaluationWithConnectorOptions {
  /** The connector registry to use (required for CLI/server execution) */
  registry: ConnectorRegistry;
  /** Callback for raw events from the connector */
  onRawEvent?: (event: any) => void;
  /** Optional evaluator ID for custom evaluation criteria */
  evaluatorId?: string;
  /**
   * Optional judge model id, distinct from the agent's `modelId` argument.
   * When set, this is the judge LLM (the model the LLM judge uses to grade
   * the trajectory). When unset the judge falls back to the evaluator's
   * `inferenceConfig.modelId` (resolved server-side in `/api/judge`),
   * then the server-default `BEDROCK_MODEL_ID` env var — NEVER to the
   * agent's `modelId`. Customer input via UI dropdown / CLI
   * `--judge-model` / API `judgeModelId` field.
   *
   * Pre-fix the agent's `modelId` was reused as the judge model id, which
   * meant picking a judge-only pseudo-model like `pi-judge` from the UI
   * dropdown ALSO got passed to the agent and broke the agent's Bedrock
   * call (Bedrock doesn't know what `pi-judge` is). Now the two are
   * fully decoupled.
   */
  judgeModelId?: string;
  /** When true, skip the LLM judge (caller will handle evaluation) */
  skipJudge?: boolean;
}

/**
 * Run evaluation using connector pattern (for CLI/direct execution)
 * This bypasses the browser proxy and calls agents directly
 *
 * @param agent - Agent configuration
 * @param modelId - Model ID to use
 * @param testCase - Test case to evaluate
 * @param onStep - Callback for trajectory steps
 * @param options - Options including the connector registry
 */
/**
 * Result of a single agent invocation — the pure, report-agnostic output of
 * driving a connector once. This is the primitive behind both the legacy
 * {@link runEvaluationWithConnector} (which then runs the judge + builds a
 * report) and the RFC-004 `agent.run()` fixture (which hands it to the test
 * body as a `RunResult`). It performs NO judging and builds NO report.
 */
export interface InvokeAgentResult {
  /** Final trajectory after the afterResponse hook (if any). */
  trajectory: TrajectoryStep[];
  /** Agent-supplied run id for log/trace correlation, or null. */
  runId: string | null;
  /** Protocol-specific raw events for debugging. */
  rawEvents: any[];
  /** Wall-clock duration of the connector.execute() call in ms. */
  agentDurationMs: number;
  /** Connector-supplied metadata (e.g. Claude Code `sessionId`, exitCode). */
  metadata?: Record<string, any>;
  /** The connector that handled the request (for protocol metadata). */
  connector: AgentConnector;
}

export interface InvokeAgentOptions {
  /** Connector registry (required for CLI/server execution). */
  registry: ConnectorRegistry;
  /** Streaming step callback. */
  onStep?: (step: TrajectoryStep) => void;
  /** Raw event callback (debugging). */
  onRawEvent?: (event: any) => void;
  /**
   * Per-invocation environment variables forwarded to the connector. Merged
   * into `connectorConfig.env` so subprocess connectors inherit them on the
   * spawned child (the lowest common denominator every subprocess connector
   * already honours). Sourced from the SDK's `AgentRunOptions.env`.
   */
  env?: Record<string, string>;
}

/**
 * Drive a single agent invocation through its connector and return the raw
 * trajectory/runId/rawEvents — no judge, no report synthesis.
 *
 * Owns the connector resolution, request building, auth, the
 * `beforeRequest`/`afterResponse` hooks, and execution timing. Extracted from
 * {@link runEvaluationWithConnector} so the RFC-004 engine can offer an
 * `agent.run()` fixture that captures exactly the same trajectory/trace
 * correlation the legacy path produces (see RFC 004 §4.1, #256).
 */
export async function invokeAgent(
  agent: AgentConfig,
  modelId: string,
  testCase: TestCase,
  options: InvokeAgentOptions
): Promise<InvokeAgentResult> {
  const { registry: connectorRegistry, onStep, onRawEvent, env: runEnv } = options;

  // Get connector for this agent
  const agentWithConnector = agent as AgentConfigWithConnector;
  const connector = connectorRegistry.getForAgent(agentWithConnector);

  // Merge any per-invocation env (from the SDK's AgentRunOptions.env) into the
  // connector config so subprocess connectors forward it to the spawned child.
  // Static config env stays the base; per-call env wins on key collisions.
  const baseConnectorConfig = agentWithConnector.connectorConfig as Record<string, any> | undefined;
  const mergedConnectorConfig: Record<string, any> | undefined =
    runEnv && Object.keys(runEnv).length > 0
      ? {
          ...(baseConnectorConfig || {}),
          env: { ...((baseConnectorConfig?.env as Record<string, string>) || {}), ...runEnv },
        }
      : baseConnectorConfig;

  // Build connector request
  let request: ConnectorRequest = {
    testCase,
    modelId,
    connectorConfig: mergedConnectorConfig,
  };

  // Build auth from agent config
  const auth = buildConnectorAuth(agent);

  // Execute beforeRequest hook if defined
  let effectiveEndpoint = agent.endpoint;
  if (agent.hooks?.beforeRequest) {
    const previewPayload = connector.buildPayload(request);

    const hookContext: BeforeRequestContext = {
      endpoint: agent.endpoint,
      payload: previewPayload,
      headers: auth.headers || agent.headers || {},
    };
    const hookResult = await executeBeforeRequestHook(agent.hooks, hookContext, agent.key);
    effectiveEndpoint = hookResult.endpoint;

    // Pass the hook-modified payload through to the connector so it skips
    // its internal buildPayload() call. This preserves ALL modifications the
    // hook made to the payload (threadId, runId, custom fields, etc.)
    request = {
      ...request,
      payload: hookResult.payload,
    };

    // Merge any hook-modified headers into auth
    if (hookResult.headers) {
      auth.headers = { ...auth.headers, ...hookResult.headers };
    }
  }

  // Execute via connector (with timing)
  const agentStartTime = Date.now();
  let result = await connector.execute(
    effectiveEndpoint,
    request,
    auth,
    onStep,
    onRawEvent
  );
  const agentDurationMs = Date.now() - agentStartTime;

  // Execute afterResponse hook if defined
  if (agent.hooks?.afterResponse) {
    debug('Eval', `Executing afterResponse hook for agent "${agent.key}"`);
    try {
      const hookContext: AfterResponseContext = {
        response: (result.rawEvents?.length ? result.rawEvents[result.rawEvents.length - 1] : null) || result.metadata || {},
        trajectory: result.trajectory,
        runId: result.runId || undefined,
        rawEvents: result.rawEvents || [],
        metadata: result.metadata,
      };
      const hookResult = await executeAfterResponseHook(agent.hooks, hookContext, agent.key);

      // Apply hook modifications
      result = {
        ...result,
        trajectory: hookResult.trajectory,
        runId: hookResult.runId || result.runId,
      };

      debug('Eval', 'afterResponse hook applied:', {
        trajectorySteps: hookResult.trajectory.length,
        runId: hookResult.runId
      });
    } catch (hookError: any) {
      const errorMsg = hookError instanceof Error ? hookError.message : String(hookError);
      console.error(`[Eval] afterResponse hook failed for agent "${agent.key}":`, errorMsg);
      debug('Eval', `afterResponse hook error details:`, {
        agent: agent.key,
        error: errorMsg,
        rawEventsCount: result.rawEvents?.length ?? 0,
        hasMetadata: !!result.metadata,
      });
      // Re-throw so the caller knows the hook failed — don't silently swallow
      throw hookError instanceof Error ? hookError : new Error(errorMsg);
    }
  }

  return {
    trajectory: result.trajectory,
    runId: result.runId,
    rawEvents: result.rawEvents || [],
    agentDurationMs,
    metadata: result.metadata,
    connector,
  };
}

export async function runEvaluationWithConnector(
  agent: AgentConfig,
  modelId: string,
  testCase: TestCase,
  onStep: (step: TrajectoryStep) => void,
  options: RunEvaluationWithConnectorOptions
): Promise<EvaluationReport> {
  const { registry: connectorRegistry, onRawEvent, evaluatorId, skipJudge } = options;
  // Pull `judgeModelId` once so the closure inside the standard-mode call
  // below uses the run-level value rather than the agent's `modelId`.
  const optionsJudgeModelId = options.judgeModelId;

  const reportId = uuidv4();
  let fullTrajectory: TrajectoryStep[] = [];
  let rawEvents: any[] = [];
  let agentRunId: string | null = null;
  let agentSessionId: string | undefined;

  debug('Eval', 'Config:', { agent: agent.name, model: modelId, testCase: testCase.id });

  const evalStartTime = Date.now();

  try {
    // Drive the agent through its connector (connector resolution, request
    // building, auth, before/afterResponse hooks, timing) via the shared
    // primitive. Judge + report synthesis stay here in the legacy path.
    const invocation = await invokeAgent(agent, modelId, testCase, {
      registry: connectorRegistry,
      onStep,
      onRawEvent,
    });
    const connector = invocation.connector;
    const agentDurationMs = invocation.agentDurationMs;
    const connectorMetadata = invocation.metadata;

    fullTrajectory = invocation.trajectory;
    agentRunId = invocation.runId;
    agentSessionId = invocation.metadata?.sessionId ?? undefined;
    rawEvents = invocation.rawEvents;

    debug('Eval', 'Trajectory captured:', fullTrajectory.length, 'steps');
    debug('Eval', 'Raw events captured:', rawEvents.length);

    // TRACE MODE: Skip logs fetch and judge, return pending report
    if (agent.useTraces) {
      return {
        id: reportId,
        timestamp: new Date().toISOString(),
        agentName: agent.name,
        agentKey: agent.key,
        modelName: modelId,
        modelId: modelId,
        testCaseId: testCase.id,
        testCaseVersion: testCase.currentVersion ?? 1,
        status: 'completed',
        metricsStatus: 'pending',
        trajectory: fullTrajectory,
        metrics: {
          accuracy: 0,
          faithfulness: 0,
          latency_score: 0,
          trajectory_alignment_score: 0,
        },
        llmJudgeReasoning: 'Waiting for traces to become available...',
        improvementStrategies: [],
        runId: agentRunId || undefined,
        sessionId: agentSessionId || undefined,
        rawEvents,
        connectorProtocol: connector.type as ConnectorProtocol,
        performanceMetrics: {
          durationMs: Date.now() - evalStartTime,
          agentDurationMs,
        },
      };
    }

    // SKIP JUDGE MODE: Return report without judge evaluation (caller handles it)
    if (skipJudge) {
      return {
        id: reportId,
        timestamp: new Date().toISOString(),
        agentName: agent.name,
        agentKey: agent.key,
        modelName: modelId,
        modelId,
        testCaseId: testCase.id,
        testCaseVersion: testCase.currentVersion ?? 1,
        status: 'completed',
        trajectory: fullTrajectory,
        metrics: { accuracy: 0, faithfulness: 0, latency_score: 0, trajectory_alignment_score: 0 },
        llmJudgeReasoning: '',
        improvementStrategies: [],
        runId: agentRunId || undefined,
        sessionId: agentSessionId || undefined,
        rawEvents,
        connectorProtocol: connector.type as ConnectorProtocol,
        performanceMetrics: {
          durationMs: Date.now() - evalStartTime,
          agentDurationMs,
        },
      };
    }

    // STANDARD MODE: Call judge
    const models = getModels();
    const modelConfig = models[modelId];
    // Judge model resolution — SEPARATE from the agent's `modelId`. Priority:
    //   1. options.judgeModelId  (run-level customer input)
    //   2. server default `BEDROCK_MODEL_ID`  (env, falls back to a recent Claude)
    //   3. agent's modelId  (last-resort BC fallback for old callers that didn't
    //                       split agent vs judge model; tolerated for one release
    //                       so behavior of pre-existing benchmark runs is
    //                       preserved when neither cx input nor server default
    //                       is available)
    // Anything else (evaluator's own `inferenceConfig.modelId`, agentic-provider
    // model picking) is resolved server-side in /api/judge from the evaluator.
    const judgeModelId =
      optionsJudgeModelId ||
      process.env.BEDROCK_MODEL_ID ||
      modelConfig?.model_id ||
      modelId;
    const judgment = await callBedrockJudge(
      fullTrajectory,
      {
        expectedOutcomes: testCase.expectedOutcomes,
        expectedTrajectory: testCase.expectedTrajectory,
      },
      undefined, // No logs in direct connector mode
      (chunk) => debug('Eval', 'Judge progress:', chunk.slice(0, 100)),
      judgeModelId,
      evaluatorId,
      // Forward agent runId so the `agent` (trace) judge provider can
      // scope its query_spans/query_logs tools. See callBedrockJudge.
      agentRunId || undefined,
      // Strategy C correlation hints (#264) so the trace judge tool can
      // find spans the agent emits under its OWN correlation (claude-code
      // session ids etc.), not just spans matching agent-health's runId
      // via gen_ai.request.id.
      buildJudgeAgentsHints(
        {
          agentKey: agent.key,
          connectorProtocol: (agent.connectorType as any),
          timestamp: new Date().toISOString(),
          performanceMetrics: { durationMs: Date.now() - evalStartTime, agentDurationMs },
        },
        agent.traceServiceName
      ),
      {
        prompt: testCase.initialPrompt,
        agentKey: agent.key,
        timings: { agentDurationMs, evaluationElapsedMs: Date.now() - evalStartTime },
        metadata: connectorMetadata,
        workspaceDir: resolveConnectorWorkspaceDir(connectorMetadata, agent.connectorConfig),
      }
    );

    debug('Eval', 'Metrics:', judgment.metrics);

    const llmJudgeResponse: LLMJudgeResponse = {
      modelId: judgeModelId,
      timestamp: new Date().toISOString(),
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: judgment.judgeDurationMs ?? 0,
      // Prefer the actual unparsed model output when present (post
      // evaluator-prompt-plumbing). Pre-fix code stuffed the parsed
      // reasoning here — fall back to that for back-compat with judges
      // that don't yet forward the raw text.
      rawResponse: judgment.rawResponse ?? judgment.llmJudgeReasoning,
      parsedMetrics: judgment.metrics as any,
      improvementStrategies: judgment.improvementStrategies,
      ...(judgment.extraFields ? { extraFields: judgment.extraFields } : {}),
      ...(judgment.judgeDebug ? { judgeDebug: judgment.judgeDebug } : {}),
    };

    return {
      id: reportId,
      timestamp: new Date().toISOString(),
      agentName: agent.name,
      agentKey: agent.key,
      modelName: modelId,
      modelId,
      testCaseId: testCase.id,
      testCaseVersion: testCase.currentVersion ?? 1,
      status: 'completed',
      passFailStatus: judgment.passFailStatus,
      trajectory: fullTrajectory,
      metrics: judgment.metrics,
      llmJudgeReasoning: judgment.llmJudgeReasoning,
      // Unified judge surface (Option-B BC: legacy field above kept).
      matcherResults: [
        buildJudgeMatcherEntry(judgment, {
          claim: formatExpectedOutcomesAsClaim(testCase.expectedOutcomes),
          model: judgeModelId,
        }),
      ],
      improvementStrategies: judgment.improvementStrategies,
      llmJudgeResponse,
      runId: agentRunId || undefined,
      sessionId: agentSessionId || undefined,
      rawEvents,
      connectorProtocol: connector.type as ConnectorProtocol,
      performanceMetrics: {
        durationMs: Date.now() - evalStartTime,
        agentDurationMs,
        judgeDurationMs: judgment.judgeDurationMs,
        judgeAttempts: judgment.judgeAttempts,
      },
    };
  } catch (error) {
    console.error('[Eval] Error:', error instanceof Error ? error.message : error);

    // Enhanced debug logging for connection failures
    if (error instanceof Error) {
      debug('Eval', 'Error details:', {
        name: error.name,
        message: error.message,
        stack: error.stack,
        cause: (error as any).cause,
        agent: agent.name,
        endpoint: agent.endpoint,
        modelId,
        testCaseId: testCase.id,
      });
    } else {
      debug('Eval', 'Unknown error:', error);
    }

    // Get connector type for error case (may not be available if error was in getting connector)
    let connectorType: ConnectorProtocol | undefined;
    try {
      const agentWithConnector = agent as AgentConfigWithConnector;
      const connector = connectorRegistry.getForAgent(agentWithConnector);
      connectorType = connector.type as ConnectorProtocol;
      debug('Eval', 'Connector type:', connectorType);
    } catch (connectorError) {
      debug('Eval', 'Failed to get connector type:', connectorError);
      // Connector lookup failed, leave undefined
    }

    return {
      id: reportId,
      timestamp: new Date().toISOString(),
      agentName: agent.name,
      agentKey: agent.key,
      modelName: modelId,
      modelId,
      testCaseId: testCase.id,
      testCaseVersion: testCase.currentVersion ?? 1,
      status: 'failed',
      trajectory: fullTrajectory,
      metrics: {
        accuracy: 0,
        faithfulness: 0,
        latency_score: 0,
        trajectory_alignment_score: 0,
      },
      llmJudgeReasoning: `Evaluation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      improvementStrategies: [],
      rawEvents,
      connectorProtocol: connectorType,
    };
  }
}

/**
 * Run real agent evaluation by streaming AG UI events
 * @deprecated Use runEvaluationWithConnector() via the server's /api/evaluate endpoint instead.
 * This browser-side path is kept for backwards compatibility but has no active callers.
 */
async function runRealAgentEvaluation(
  agent: AgentConfig,
  modelId: string,
  testCase: TestCase,
  onStep: (step: TrajectoryStep) => void,
  onRawEvent?: (event: AGUIEvent) => void
): Promise<{ trajectory: TrajectoryStep[], runId: string | null, rawEvents: AGUIEvent[] }> {
  const trajectory: TrajectoryStep[] = [];
  const rawEvents: AGUIEvent[] = [];
  const converter = new AGUIToTrajectoryConverter();

  const agentPayload = buildAgentPayload(testCase, modelId);

  debug('Eval', 'Agent payload:', JSON.stringify(agentPayload).substring(0, 500));

  // Use proxy to avoid CORS issues when calling agent endpoint
  const proxyPayload = {
    endpoint: agent.endpoint,
    payload: agentPayload,
    headers: agent.headers,
    agentKey: agent.key,
  };

  debug('Eval', 'Using proxy:', ENV_CONFIG.agentProxyUrl);

  await consumeSSEStream(
    ENV_CONFIG.agentProxyUrl,
    proxyPayload,
    (event: AGUIEvent) => {
      // Capture raw event for debugging
      rawEvents.push(event);
      onRawEvent?.(event);

      // Convert to trajectory steps
      const steps = converter.processEvent(event);
      steps.forEach(step => {
        trajectory.push(step);
        onStep(step);
      });
    }
  );

  const runId = converter.getRunId();
  return { trajectory, runId, rawEvents };
}

/**
 * Run evaluation with selected agent, model, and test case
 * Streams trajectory steps to UI in real-time via onStep callback
 *
 * @deprecated Use runServerEvaluation() from services/client/evaluationApi instead.
 * The server-side path (/api/evaluate) consolidates all evaluation logic through the
 * connector system, ensuring consistent behavior for hooks, storage, and all agent types.
 */
export async function runEvaluation(
  agent: AgentConfig,
  modelId: string,
  testCase: TestCase,
  onStep: (step: TrajectoryStep) => void,
  onRawEvent?: (event: AGUIEvent) => void
): Promise<EvaluationReport> {

  const reportId = uuidv4();
  let fullTrajectory: TrajectoryStep[] = [];
  let rawEvents: AGUIEvent[] = [];
  let agentRunId: string | null = null;
  let agentSessionId: string | undefined;

  debug('Eval', 'Config:', { agent: agent.name, model: modelId, testCase: testCase.id });

  const evalStartTime = Date.now();

  try {
    if (USE_MOCK_AGENT) {
      fullTrajectory = await generateMockTrajectory(testCase);
      for (const step of fullTrajectory) {
        onStep(step);
        await new Promise(r => setTimeout(r, 300));
      }
    } else {
      const result = await runRealAgentEvaluation(agent, modelId, testCase, onStep, onRawEvent);
      fullTrajectory = result.trajectory;
      agentRunId = result.runId;
      rawEvents = result.rawEvents;
    }

    debug('Eval', 'Trajectory captured:', fullTrajectory.length, 'steps');
    debug('Eval', 'Raw events captured:', rawEvents.length);

    // TRACE MODE: Skip logs fetch and judge, return pending report
    // Traces take ~5 minutes to propagate, so we'll poll for them later
    if (agent.useTraces) {
      return {
        id: reportId,
        timestamp: new Date().toISOString(),
        agentName: agent.name,
        agentKey: agent.key,
        modelName: modelId,
        modelId: modelId,
        testCaseId: testCase.id,
        testCaseVersion: testCase.currentVersion ?? 1,
        status: 'completed',
        metricsStatus: 'pending', // Will be updated after traces are available
        trajectory: fullTrajectory,
        metrics: {
          accuracy: 0,
          faithfulness: 0,
          latency_score: 0,
          trajectory_alignment_score: 0,
        },
        llmJudgeReasoning: 'Waiting for traces to become available...',
        improvementStrategies: [],
        runId: agentRunId || undefined,
        sessionId: agentSessionId || undefined,
        rawEvents,
      };
    }

    // STANDARD MODE: Fetch logs and call judge immediately
    let logs: OpenSearchLog[] | undefined;
    if (agentRunId) {
      try {
        logs = await openSearchClient.fetchLogsForRun(agentRunId);
      } catch (error) {
        console.error('[Eval] Failed to fetch logs:', error instanceof Error ? error.message : error);
      }
    }

    // Call judge
    const models = getModels();
    const modelConfig = models[modelId];
    // Deprecated path — mirror the standard-mode judgeModelId resolution
    // chain so this stays consistent if anyone still hits this code path.
    // The agent's `modelId` is NOT used as the judge model here either.
    const judgeModelId =
      process.env.BEDROCK_MODEL_ID ||
      modelConfig?.model_id ||
      modelId;
    const judgment = await callBedrockJudge(
      fullTrajectory,
      {
        expectedOutcomes: testCase.expectedOutcomes,
        expectedTrajectory: testCase.expectedTrajectory,
      },
      logs,
      (chunk) => debug('Eval', 'Judge progress:', chunk.slice(0, 100)),
      judgeModelId,
      undefined, // evaluatorId not threaded on the legacy path
      // Same forwarding as the standard branch above.
      agentRunId || undefined
    );

    debug('Eval', 'Metrics:', judgment.metrics);

    const llmJudgeResponse: LLMJudgeResponse = {
      modelId: judgeModelId,
      timestamp: new Date().toISOString(),
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: judgment.judgeDurationMs ?? 0,
      // Prefer the actual unparsed model output when present (post
      // evaluator-prompt-plumbing). Pre-fix code stuffed the parsed
      // reasoning here — fall back to that for back-compat.
      rawResponse: judgment.rawResponse ?? judgment.llmJudgeReasoning,
      parsedMetrics: judgment.metrics as any,
      improvementStrategies: judgment.improvementStrategies,
      ...(judgment.extraFields ? { extraFields: judgment.extraFields } : {}),
      ...(judgment.judgeDebug ? { judgeDebug: judgment.judgeDebug } : {}),
    };

    return {
      id: reportId,
      timestamp: new Date().toISOString(),
      agentName: agent.name,
      agentKey: agent.key,
      modelName: modelId,
      modelId,
      testCaseId: testCase.id,
      testCaseVersion: testCase.currentVersion ?? 1,
      status: 'completed',
      passFailStatus: judgment.passFailStatus,
      trajectory: fullTrajectory,
      metrics: judgment.metrics,
      llmJudgeReasoning: judgment.llmJudgeReasoning,
      // Unified judge surface (Option-B BC: legacy field above kept).
      matcherResults: [
        buildJudgeMatcherEntry(judgment, {
          claim: formatExpectedOutcomesAsClaim(testCase.expectedOutcomes),
          model: judgeModelId,
        }),
      ],
      improvementStrategies: judgment.improvementStrategies,
      llmJudgeResponse,
      openSearchLogs: logs,
      runId: agentRunId || undefined,
      sessionId: agentSessionId || undefined,
      logs: logs || undefined,
      rawEvents,
    };
  } catch (error) {
    console.error('[Eval] Error:', error instanceof Error ? error.message : error);

    return {
      id: reportId,
      timestamp: new Date().toISOString(),
      agentName: agent.name,
      agentKey: agent.key,
      modelName: modelId,
      modelId,
      testCaseId: testCase.id,
      testCaseVersion: testCase.currentVersion ?? 1,
      status: 'failed',
      trajectory: fullTrajectory,
      metrics: {
        accuracy: 0,
        faithfulness: 0,
        latency_score: 0,
        trajectory_alignment_score: 0,
      },
      llmJudgeReasoning: `Evaluation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      improvementStrategies: [],
      rawEvents,
    };
  }
}
