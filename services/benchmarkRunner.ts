/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Benchmark,
  BenchmarkRun,
  BenchmarkProgress,
  AgentConfig,
  TestCase,
  EvaluationReport,
  RunConfigInput,
} from '@/types';
import {
  getAllTestCasesWithClient,
  saveReportWithClient,
  updateRunWithClient,
} from '@/server/services/storage';
import type { Client } from '@opensearch-project/opensearch';
import { runEvaluationWithConnector, callBedrockJudge } from './evaluation';
import { connectorRegistry } from '@/services/connectors/server';
import { loadConfigSync } from '@/lib/config/index';
import { DEFAULT_CONFIG } from '@/lib/constants';
import { tracePollingManager } from './traces/tracePoller';
import { getCustomAgents } from '@/server/services/customAgentStore';
import { RunResultStatus } from '@/types';

/**
 * Safely load config with fallback to defaults.
 * Matches the defensive pattern used in services/evaluation/index.ts.
 */
function getConfig() {
  try {
    return loadConfigSync();
  } catch {
    return DEFAULT_CONFIG;
  }
}

/**
 * Callback invoked after each test case completes during benchmark execution.
 * Used to persist intermediate progress to OpenSearch for real-time polling.
 */
export type OnTestCaseCompleteCallback = (
  testCaseId: string,
  result: { reportId: string; status: RunResultStatus }
) => Promise<void>;

/**
 * Cancellation token for stopping execution
 */
export interface CancellationToken {
  isCancelled: boolean;
  cancel(): void;
}

/**
 * Create a new cancellation token
 */
export function createCancellationToken(): CancellationToken {
  const token = {
    isCancelled: false,
    cancel() {
      this.isCancelled = true;
    },
  };
  return token;
}

/**
 * Options for executeRun
 */
export interface ExecuteRunOptions {
  cancellationToken?: CancellationToken;
  /** OpenSearch client for storage operations (required) */
  client: Client;
  /** Callback invoked after each test case completes (for persisting intermediate progress) */
  onTestCaseComplete?: OnTestCaseCompleteCallback;
}

/**
 * Build an agent config from a run's configuration
 */
function buildAgentConfigForRun(run: BenchmarkRun): AgentConfig {
  // Find the base agent config (includes custom agents from JSON-backed store)
  const config = getConfig();
  const allAgents = [...config.agents, ...getCustomAgents()];
  const baseAgent = allAgents.find(a => a.key === run.agentKey);

  if (!baseAgent) {
    throw new Error(`Agent not found: ${run.agentKey}`);
  }

  // Apply run overrides
  return {
    ...baseAgent,
    endpoint: run.agentEndpoint || baseAgent.endpoint,
    headers: {
      ...baseAgent.headers,
      ...run.headers,
    },
  };
}

/**
 * Get the Bedrock model ID from a model key
 */
function getBedrockModelId(modelKey: string): string {
  const config = getConfig();
  const modelConfig = config.models[modelKey];
  return modelConfig?.model_id || modelKey;
}

/**
 * Execute a run for a benchmark
 *
 * A run executes a single configuration against all test cases in the benchmark.
 * Results are stored in the evals_runs index via asyncRunStorage.
 */
export async function executeRun(
  benchmark: Benchmark,
  run: BenchmarkRun,
  onProgress: (progress: BenchmarkProgress) => void,
  options: ExecuteRunOptions
): Promise<BenchmarkRun> {
  const totalTestCases = benchmark.testCaseIds.length;
  const { cancellationToken, client, onTestCaseComplete } = options;

  // Initialize results if empty
  if (!run.results) {
    run.results = {};
  }

  // Fetch all test cases upfront for this benchmark
  const allTestCases = await getAllTestCasesWithClient(client);
  const testCaseMap = new Map(allTestCases.map((tc: any) => [tc.id, tc]));

  try {
    // Iterate through each test case
    for (let testCaseIndex = 0; testCaseIndex < totalTestCases; testCaseIndex++) {
      // Check for cancellation before each test case
      if (cancellationToken?.isCancelled) {
        onProgress({
          currentTestCaseIndex: testCaseIndex,
          totalTestCases,
          currentRunId: run.id,
          currentTestCaseId: benchmark.testCaseIds[testCaseIndex],
          status: 'cancelled',
        });
        break;
      }

      const testCaseId = benchmark.testCaseIds[testCaseIndex];
      const testCase = testCaseMap.get(testCaseId);

      if (!testCase) {
        console.warn(`[BenchmarkRunner] Test case not found: ${testCaseId}`);
        run.results[testCaseId] = { reportId: '', status: 'failed' };
        continue;
      }

      // Report progress
      onProgress({
        currentTestCaseIndex: testCaseIndex,
        totalTestCases,
        currentRunId: run.id,
        currentTestCaseId: testCaseId,
        status: 'running',
      });

      // Set status to running
      run.results[testCaseId] = { reportId: '', status: 'running' };

      try {
        // Build agent config from run configuration
        const agentConfig = buildAgentConfigForRun(run);
        const bedrockModelId = getBedrockModelId(run.modelId);

        // Run the evaluation using connector
        const report = await runEvaluationWithConnector(
          agentConfig,
          bedrockModelId,
          testCase,
          () => {}, // No debug callback needed
          { registry: connectorRegistry }
        );

        // Save the report to OpenSearch and get the actual stored ID
        const savedReport = await saveReportWithClient(client, report, {
          experimentId: benchmark.id,
          experimentRunId: run.id,
        });

        // Start trace polling for trace-mode runs (metricsStatus: 'pending')
        if (savedReport.metricsStatus === 'pending' && savedReport.runId) {
          startTracePollingForReport(savedReport, testCase, client);
        }

        // Update result with success - use the actual stored ID
        run.results[testCaseId] = {
          reportId: savedReport.id,
          status: 'completed',
        };

        // Persist progress to OpenSearch (fire-and-forget with logging)
        if (onTestCaseComplete) {
          onTestCaseComplete(testCaseId, run.results[testCaseId])
            .catch(err => console.warn(`[BenchmarkRunner] Failed to persist progress for ${testCaseId}:`, err.message));
        }
      } catch (error) {
        console.error(`[BenchmarkRunner] Error in test case ${testCaseId}:`, error instanceof Error ? error.message : error);
        run.results[testCaseId] = { reportId: '', status: 'failed' };

        // Persist failure progress to OpenSearch (fire-and-forget with logging)
        if (onTestCaseComplete) {
          onTestCaseComplete(testCaseId, run.results[testCaseId])
            .catch(err => console.warn(`[BenchmarkRunner] Failed to persist failure progress for ${testCaseId}:`, err.message));
        }
      }
    }

    // Report final progress
    onProgress({
      currentTestCaseIndex: totalTestCases - 1,
      totalTestCases,
      currentRunId: run.id,
      currentTestCaseId: benchmark.testCaseIds[totalTestCases - 1],
      status: 'completed',
    });

    return run;
  } catch (error) {
    // Mark any pending test cases as failed
    benchmark.testCaseIds.forEach(testCaseId => {
      if (!run.results[testCaseId] || run.results[testCaseId].status === 'pending') {
        run.results[testCaseId] = { reportId: '', status: 'failed' };
      }
    });

    throw error;
  }
}

/**
 * Create and execute a new run for a benchmark
 *
 * This is the main entry point for running a benchmark.
 * It creates a new BenchmarkRun from the provided configuration and executes it.
 */
/**
 * Generate a unique run ID
 */
function generateRunId(): string {
  return `run-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
}

export async function runBenchmark(
  benchmark: Benchmark,
  runConfig: RunConfigInput,
  onProgress: (progress: BenchmarkProgress) => void,
  client: Client
): Promise<BenchmarkRun> {
  // Create a new run - spread runConfig to include all fields (name, description, etc.)
  const run: BenchmarkRun = {
    ...runConfig,
    id: generateRunId(),
    createdAt: new Date().toISOString(),
    results: {},
  };

  // Initialize pending status for all test cases
  benchmark.testCaseIds.forEach(testCaseId => {
    run.results[testCaseId] = { reportId: '', status: 'pending' };
  });

  return executeRun(benchmark, run, onProgress, { client });
}

/**
 * Run a single use case with a single configuration (for quick testing)
 */
export async function runSingleUseCase(
  run: BenchmarkRun,
  testCase: TestCase,
  client: Client,
  onStep?: (step: any) => void
): Promise<string> {
  const agentConfig = buildAgentConfigForRun(run);
  const bedrockModelId = getBedrockModelId(run.modelId);

  // Run the evaluation using connector
  const report = await runEvaluationWithConnector(
    agentConfig,
    bedrockModelId,
    testCase,
    onStep || (() => {}),
    { registry: connectorRegistry }
  );

  const savedReport = await saveReportWithClient(client, report);

  // Start trace polling for trace-mode runs
  if (savedReport.metricsStatus === 'pending' && savedReport.runId) {
    startTracePollingForReport(savedReport, testCase, client);
  }

  return savedReport.id;
}

/**
 * Start trace polling for a report that has metricsStatus: 'pending'
 *
 * When traces are found, calls the Bedrock judge with the trajectory
 * and test case's expectedOutcomes to get the final evaluation.
 */
function startTracePollingForReport(report: EvaluationReport, testCase: TestCase, client: Client): void {
  if (!report.runId) {
    console.warn(`[BenchmarkRunner] No runId for report ${report.id}, cannot start trace polling`);
    return;
  }

  tracePollingManager.startPolling(
    report.id,
    report.runId,
    {
      onTracesFound: async (spans, updatedReport) => {
        try {
          // Call the Bedrock judge with the trajectory and expectedOutcomes
          const judgeModelId = report.modelId ? getBedrockModelId(report.modelId) : undefined;

          const judgment = await callBedrockJudge(
            updatedReport.trajectory,
            {
              expectedOutcomes: testCase.expectedOutcomes,
              expectedTrajectory: testCase.expectedTrajectory,
            },
            [], // No logs for trace-mode - traces are the source of truth
            () => {}, // No progress callback needed
            judgeModelId
          );

          // Update report with judge results
          await updateRunWithClient(client, report.id, {
            metricsStatus: 'ready',
            passFailStatus: judgment.passFailStatus,
            metrics: judgment.metrics,
            llmJudgeReasoning: judgment.llmJudgeReasoning,
            improvementStrategies: judgment.improvementStrategies,
          });
        } catch (error) {
          console.error(`[BenchmarkRunner] Failed to judge report ${report.id}:`, error instanceof Error ? error.message : error);
          // Still mark as ready but with error info
          await updateRunWithClient(client, report.id, {
            metricsStatus: 'error',
            traceError: `Judge evaluation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
          });
        }
      },
      onAttempt: () => {}, // No verbose logging
      onError: (error) => {
        console.error(`[BenchmarkRunner] Trace polling failed for report ${report.id}:`, error instanceof Error ? error.message : error);
      },
    }
  );
}

// Backwards compatibility aliases
/** @deprecated Use runBenchmark instead */
export const runExperiment = runBenchmark;
