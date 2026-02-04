/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Evaluation Service
 * Main orchestrator for running agent evaluations
 */

import { v4 as uuidv4 } from 'uuid';
import { AgentConfig, EvaluationReport, TestCase, TrajectoryStep, OpenSearchLog, LLMJudgeResponse, ConnectorProtocol } from '@/types';
import { AGUIToTrajectoryConverter, consumeSSEStream, buildAgentPayload } from '@/services/agent';
import { AGUIEvent } from '@/types/agui';
import { generateMockTrajectory } from './mockTrajectory';
import { callBedrockJudge } from './bedrockJudge';

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
} from '@/services/connectors';

// Toggle between mock and real agent
const USE_MOCK_AGENT = false;

/**
 * Build ConnectorAuth from AgentConfig headers
 */
function buildConnectorAuth(agent: AgentConfig): ConnectorAuth {
  // Check for common auth patterns in headers
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

/**
 * Options for running evaluation with connector
 */
export interface RunEvaluationWithConnectorOptions {
  /** The connector registry to use (required for CLI/server execution) */
  registry: ConnectorRegistry;
  /** Callback for raw events from the connector */
  onRawEvent?: (event: any) => void;
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
export async function runEvaluationWithConnector(
  agent: AgentConfig,
  modelId: string,
  testCase: TestCase,
  onStep: (step: TrajectoryStep) => void,
  options: RunEvaluationWithConnectorOptions
): Promise<EvaluationReport> {
  console.log('[Eval] ========== runEvaluationWithConnector STARTED ==========');
  console.log('[Eval] Agent:', agent.name, '(', agent.key, ')');
  console.log('[Eval] Agent endpoint:', agent.endpoint);
  console.log('[Eval] Agent connectorType:', agent.connectorType);
  console.log('[Eval] Model:', modelId);
  console.log('[Eval] Test case:', testCase.name, '(', testCase.id, ')');

  const { registry: connectorRegistry, onRawEvent } = options;

  const reportId = uuidv4();
  let fullTrajectory: TrajectoryStep[] = [];
  let rawEvents: any[] = [];
  let agentRunId: string | null = null;

  console.info('[Eval] Starting evaluation with connector:', testCase.name);
  debug('Eval', 'Config:', { agent: agent.name, model: modelId, testCase: testCase.id });

  const evalStartTime = Date.now();

  try {
    // Get connector for this agent
    console.log('[Eval] Getting connector from registry...');
    console.log('[Eval] Registered connectors:', connectorRegistry.getRegisteredTypes());
    const agentWithConnector = agent as AgentConfigWithConnector;
    const connector = connectorRegistry.getForAgent(agentWithConnector);

    console.info('[Eval] Using connector:', connector.name, `(${connector.type})`);

    // Build connector request
    const request: ConnectorRequest = {
      testCase,
      modelId,
    };

    // Build auth from agent config
    const auth = buildConnectorAuth(agent);
    console.log('[Eval] Auth type:', auth.type);

    // Execute via connector
    console.log('[Eval] Calling connector.execute()...');
    console.log('[Eval] Endpoint:', agent.endpoint);
    console.log('[Eval] Request test case:', request.testCase.name);
    const result = await connector.execute(
      agent.endpoint,
      request,
      auth,
      onStep,
      onRawEvent
    );
    console.log('[Eval] connector.execute() returned');

    fullTrajectory = result.trajectory;
    agentRunId = result.runId;
    rawEvents = result.rawEvents || [];
    console.log('[Eval] Result trajectory steps:', fullTrajectory.length);
    console.log('[Eval] Result runId:', agentRunId);

    // Log summary
    const stepCounts = fullTrajectory.reduce((acc, step) => {
      acc[step.type] = (acc[step.type] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    console.info('[Eval] Trajectory captured:', fullTrajectory.length, 'steps', stepCounts);
    debug('Eval', 'Raw events captured:', rawEvents.length);
    console.info('[Eval] Agent run ID:', agentRunId || 'NOT CAPTURED');

    // TRACE MODE: Skip logs fetch and judge, return pending report
    if (agent.useTraces) {
      console.info('[Eval] TRACE MODE: Skipping logs/judge, will poll for traces');
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
        rawEvents,
        connectorProtocol: connector.type as ConnectorProtocol,
      };
    }

    // STANDARD MODE: Call judge
    const models = getModels();
    const modelConfig = models[modelId];
    const judgeModelId = modelConfig?.model_id || modelId;
    const provider = modelConfig?.provider || 'bedrock';
    console.info('[Eval] Calling judge with model:', judgeModelId, 'provider:', provider);
    const judgeStartTime = Date.now();
    const judgment = await callBedrockJudge(
      fullTrajectory,
      {
        expectedOutcomes: testCase.expectedOutcomes,
        expectedTrajectory: testCase.expectedTrajectory,
      },
      undefined, // No logs in direct connector mode
      (chunk) => debug('Eval', 'Judge progress:', chunk.slice(0, 100)),
      judgeModelId
    );
    const judgeLatencyMs = Date.now() - judgeStartTime;
    const totalEvalTime = Date.now() - evalStartTime;

    console.info('[Eval] Complete:', judgment.passFailStatus?.toUpperCase(), `(${totalEvalTime}ms)`);
    debug('Eval', 'Metrics:', judgment.metrics);

    const llmJudgeResponse: LLMJudgeResponse = {
      modelId: judgeModelId,
      timestamp: new Date().toISOString(),
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: judgeLatencyMs,
      rawResponse: judgment.llmJudgeReasoning,
      parsedMetrics: {
        accuracy: judgment.metrics.accuracy,
        faithfulness: judgment.metrics.faithfulness,
        latency_score: judgment.metrics.latency_score,
        trajectory_alignment_score: judgment.metrics.trajectory_alignment_score,
      },
      improvementStrategies: judgment.improvementStrategies,
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
      improvementStrategies: judgment.improvementStrategies,
      llmJudgeResponse,
      runId: agentRunId || undefined,
      rawEvents,
      connectorProtocol: connector.type as ConnectorProtocol,
    };
  } catch (error) {
    console.error('[Eval] Error:', error);

    // Get connector type for error case (may not be available if error was in getting connector)
    let connectorType: ConnectorProtocol | undefined;
    try {
      const agentWithConnector = agent as AgentConfigWithConnector;
      const connector = connectorRegistry.getForAgent(agentWithConnector);
      connectorType = connector.type as ConnectorProtocol;
    } catch {
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

  console.info('[Eval] Starting evaluation:', testCase.name);
  debug('Eval', 'Config:', { agent: agent.name, model: modelId, testCase: testCase.id });

  const evalStartTime = Date.now();

  try {
    if (USE_MOCK_AGENT) {
      console.info('[Eval] Using mock agent');
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

    // Log summary
    const stepCounts = fullTrajectory.reduce((acc, step) => {
      acc[step.type] = (acc[step.type] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    console.info('[Eval] Trajectory captured:', fullTrajectory.length, 'steps', stepCounts);
    debug('Eval', 'Raw events captured:', rawEvents.length);
    console.info('[Eval] Agent run ID:', agentRunId || 'NOT CAPTURED');

    // TRACE MODE: Skip logs fetch and judge, return pending report
    // Traces take ~5 minutes to propagate, so we'll poll for them later
    if (agent.useTraces) {
      console.info('[Eval] TRACE MODE: Skipping logs/judge, will poll for traces');

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
        rawEvents,
      };
    }

    // STANDARD MODE: Fetch logs and call judge immediately
    let logs: OpenSearchLog[] | undefined;
    if (agentRunId) {
      try {
        console.info('[Eval] Fetching logs from OpenSearch for runId:', agentRunId);
        logs = await openSearchClient.fetchLogsForRun(agentRunId);
        console.info('[Eval] OpenSearch logs fetched:', logs?.length || 0);
      } catch (error) {
        console.error('[Eval] Failed to fetch logs:', error);
      }
    } else {
      console.warn('[Eval] No runId captured from agent - skipping log fetch');
    }

    // Call judge
    // Resolve model key to full Bedrock model ID and get provider
    const models = getModels();
    const modelConfig = models[modelId];
    const judgeModelId = modelConfig?.model_id || modelId;
    const provider = modelConfig?.provider || 'bedrock';
    console.info('[Eval] Calling judge with model:', judgeModelId, 'provider:', provider);
    const judgeStartTime = Date.now();
    const judgment = await callBedrockJudge(
      fullTrajectory,
      {
        expectedOutcomes: testCase.expectedOutcomes,
        expectedTrajectory: testCase.expectedTrajectory,
      },
      logs,
      (chunk) => debug('Eval', 'Judge progress:', chunk.slice(0, 100)),
      judgeModelId
    );
    const judgeLatencyMs = Date.now() - judgeStartTime;
    const totalEvalTime = Date.now() - evalStartTime;

    console.info('[Eval] Complete:', judgment.passFailStatus?.toUpperCase(), `(${totalEvalTime}ms)`);
    debug('Eval', 'Metrics:', judgment.metrics);

    const llmJudgeResponse: LLMJudgeResponse = {
      modelId: judgeModelId,
      timestamp: new Date().toISOString(),
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: judgeLatencyMs,
      rawResponse: judgment.llmJudgeReasoning,
      parsedMetrics: {
        accuracy: judgment.metrics.accuracy,
        faithfulness: judgment.metrics.faithfulness,
        latency_score: judgment.metrics.latency_score,
        trajectory_alignment_score: judgment.metrics.trajectory_alignment_score,
      },
      improvementStrategies: judgment.improvementStrategies,
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
      improvementStrategies: judgment.improvementStrategies,
      llmJudgeResponse,
      openSearchLogs: logs,
      runId: agentRunId || undefined,
      logs: logs || undefined,
      rawEvents, // Include raw events for debugging
    };
  } catch (error) {
    console.error('[Eval] Error:', error);

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
