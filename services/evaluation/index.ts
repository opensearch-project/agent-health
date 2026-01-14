/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Evaluation Service
 * Main orchestrator for running agent evaluations
 */

import { v4 as uuidv4 } from 'uuid';
import { AgentConfig, EvaluationReport, TestCase, TrajectoryStep, OpenSearchLog, LLMJudgeResponse } from '@/types';
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

// Toggle between mock and real agent
const USE_MOCK_AGENT = false;

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
  judgeKey: string,
  onStep: (step: TrajectoryStep) => void,
  onRawEvent?: (event: AGUIEvent) => void
): Promise<EvaluationReport> {

  const reportId = uuidv4();
  let fullTrajectory: TrajectoryStep[] = [];
  let rawEvents: AGUIEvent[] = [];
  let agentRunId: string | null = null;

  console.info('[Eval] Starting evaluation:', testCase.name);
  debug('Eval', 'Config:', { agent: agent.name, model: modelId, judge: judgeKey, testCase: testCase.id });

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
      const totalEvalTime = Date.now() - evalStartTime;
      const judge = DEFAULT_CONFIG.judges.find(j => j.key === judgeKey);

      return {
        id: reportId,
        timestamp: new Date().toISOString(),
        agentName: agent.name,
        agentKey: agent.key,
        judgeName: judge?.name,
        judgeKey,
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
    // Resolve model key to full Bedrock model ID
    const judgeModelId = DEFAULT_CONFIG.models[modelId]?.model_id || modelId;
    console.info('[Eval] Calling judge:', judgeKey, 'with model:', judgeModelId);
    const judgeStartTime = Date.now();
    const judgment = await callBedrockJudge(
      fullTrajectory,
      {
        expectedOutcomes: testCase.expectedOutcomes,
        expectedTrajectory: testCase.expectedTrajectory,
      },
      logs,
      (chunk) => debug('Eval', 'Judge progress:', chunk.slice(0, 100)),
      judgeModelId,
      judgeKey
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

    const judge = DEFAULT_CONFIG.judges.find(j => j.key === judgeKey);

    return {
      id: reportId,
      timestamp: new Date().toISOString(),
      agentName: agent.name,
      agentKey: agent.key,
      judgeName: judge?.name,
      judgeKey,
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
    const judgeForError = DEFAULT_CONFIG.judges.find(j => j.key === judgeKey);

    return {
      id: reportId,
      timestamp: new Date().toISOString(),
      agentName: agent.name,
      agentKey: agent.key,
      judgeName: judgeForError?.name,
      judgeKey,
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
