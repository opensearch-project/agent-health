/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Experiment,
  ExperimentRun,
  ExperimentProgress,
  AgentConfig,
  TestCase,
  EvaluationReport,
  RunConfigInput,
} from '@/types';
import { getAllTestCases, saveReport, updateRun } from '@/server/services/storage';
import { runEvaluation, callBedrockJudge } from './evaluation';
import { DEFAULT_CONFIG } from '@/lib/constants';
import { tracePollingManager } from './traces/tracePoller';

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
}

/**
 * Build an agent config from a run's configuration
 */
function buildAgentConfigForRun(run: ExperimentRun): AgentConfig {
  // Find the base agent config
  const baseAgent = DEFAULT_CONFIG.agents.find(a => a.key === run.agentKey);

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
  const modelConfig = DEFAULT_CONFIG.models[modelKey];
  return modelConfig?.model_id || modelKey;
}

/**
 * Execute a run for an experiment
 *
 * A run executes a single configuration against all test cases in the experiment.
 * Results are stored in the evals_runs index via asyncRunStorage.
 */
export async function executeRun(
  experiment: Experiment,
  run: ExperimentRun,
  onProgress: (progress: ExperimentProgress) => void,
  options?: ExecuteRunOptions
): Promise<ExperimentRun> {
  const totalTestCases = experiment.testCaseIds.length;
  const cancellationToken = options?.cancellationToken;

  // Initialize results if empty
  if (!run.results) {
    run.results = {};
  }

  // Fetch all test cases upfront for this experiment
  const allTestCases = await getAllTestCases();
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
          currentTestCaseId: experiment.testCaseIds[testCaseIndex],
          status: 'cancelled',
        });
        break;
      }

      const testCaseId = experiment.testCaseIds[testCaseIndex];
      const testCase = testCaseMap.get(testCaseId);

      if (!testCase) {
        console.warn(`Test case not found: ${testCaseId}`);
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

        // Run the evaluation
        const judgeKey = run.judgeKey || 'bedrock'; // Default to Bedrock judge
        const report = await runEvaluation(
          agentConfig,
          bedrockModelId,
          testCase,
          judgeKey,
          () => {} // No step callback needed here
        );

        // Save the report to OpenSearch and get the actual stored ID
        const savedReport = await saveReport(report, {
          experimentId: experiment.id,
          experimentRunId: run.id,
        });

        // Start trace polling for trace-mode runs (metricsStatus: 'pending')
        if (savedReport.metricsStatus === 'pending' && savedReport.runId) {
          console.info(`[ExperimentRunner] Starting trace polling for report ${savedReport.id}`);
          startTracePollingForReport(savedReport, testCase);
        }

        // Update result with success - use the actual stored ID
        run.results[testCaseId] = {
          reportId: savedReport.id,
          status: 'completed',
        };
      } catch (error) {
        console.error(`Error running test case ${testCaseId}:`, error);
        run.results[testCaseId] = { reportId: '', status: 'failed' };
      }
    }

    // Report final progress
    onProgress({
      currentTestCaseIndex: totalTestCases - 1,
      totalTestCases,
      currentRunId: run.id,
      currentTestCaseId: experiment.testCaseIds[totalTestCases - 1],
      status: 'completed',
    });

    return run;
  } catch (error) {
    // Mark any pending test cases as failed
    experiment.testCaseIds.forEach(testCaseId => {
      if (!run.results[testCaseId] || run.results[testCaseId].status === 'pending') {
        run.results[testCaseId] = { reportId: '', status: 'failed' };
      }
    });

    throw error;
  }
}

/**
 * Create and execute a new run for an experiment
 *
 * This is the main entry point for running an experiment.
 * It creates a new ExperimentRun from the provided configuration and executes it.
 */
/**
 * Generate a unique run ID
 */
function generateRunId(): string {
  return `run-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
}

export async function runExperiment(
  experiment: Experiment,
  runConfig: RunConfigInput,
  onProgress: (progress: ExperimentProgress) => void
): Promise<ExperimentRun> {
  // Create a new run - spread runConfig to include all fields (name, description, etc.)
  const run: ExperimentRun = {
    ...runConfig,
    id: generateRunId(),
    createdAt: new Date().toISOString(),
    results: {},
  };

  // Initialize pending status for all test cases
  experiment.testCaseIds.forEach(testCaseId => {
    run.results[testCaseId] = { reportId: '', status: 'pending' };
  });

  return executeRun(experiment, run, onProgress);
}

/**
 * Run a single use case with a single configuration (for quick testing)
 */
export async function runSingleUseCase(
  run: ExperimentRun,
  testCase: TestCase,
  onStep?: (step: any) => void
): Promise<string> {
  const agentConfig = buildAgentConfigForRun(run);
  const bedrockModelId = getBedrockModelId(run.modelId);
  const judgeKey = run.judgeKey || 'bedrock'; // Default to Bedrock judge

  const report = await runEvaluation(
    agentConfig,
    bedrockModelId,
    testCase,
    judgeKey,
    onStep || (() => {})
  );

  const savedReport = await saveReport(report);

  // Start trace polling for trace-mode runs
  if (savedReport.metricsStatus === 'pending' && savedReport.runId) {
    console.info(`[ExperimentRunner] Starting trace polling for report ${savedReport.id}`);
    startTracePollingForReport(savedReport, testCase);
  }

  return savedReport.id;
}

/**
 * Start trace polling for a report that has metricsStatus: 'pending'
 *
 * When traces are found, calls the Bedrock judge with the trajectory
 * and test case's expectedOutcomes to get the final evaluation.
 */
function startTracePollingForReport(report: EvaluationReport, testCase: TestCase): void {
  if (!report.runId) {
    console.warn(`[ExperimentRunner] No runId for report ${report.id}, cannot start trace polling`);
    return;
  }

  tracePollingManager.startPolling(
    report.id,
    report.runId,
    {
      onTracesFound: async (spans, updatedReport) => {
        console.info(`[ExperimentRunner] Traces found for report ${report.id}: ${spans.length} spans`);

        try {
          // Call the Bedrock judge with the trajectory and expectedOutcomes
          // Use the model from the report (which was used for the agent evaluation)
          const judgeModelId = report.modelId ? getBedrockModelId(report.modelId) : undefined;
          console.info(`[ExperimentRunner] Calling Bedrock judge for report ${report.id} with model: ${judgeModelId || '(default)'}`);

          const judgment = await callBedrockJudge(
            updatedReport.trajectory,
            {
              expectedOutcomes: testCase.expectedOutcomes,
              expectedTrajectory: testCase.expectedTrajectory,
            },
            [], // No logs for trace-mode - traces are the source of truth
            (chunk) => console.debug('[ExperimentRunner] Judge progress:', chunk.slice(0, 100)),
            judgeModelId
          );

          console.info(`[ExperimentRunner] Judge result for report ${report.id}: ${judgment.passFailStatus}, accuracy: ${judgment.metrics.accuracy}%`);

          // Update report with judge results
          await updateRun(report.id, {
            metricsStatus: 'ready',
            passFailStatus: judgment.passFailStatus,
            metrics: judgment.metrics,
            llmJudgeReasoning: judgment.llmJudgeReasoning,
            improvementStrategies: judgment.improvementStrategies,
            // Note: Not storing spans - fetch on-demand using report.runId
          });

          console.info(`[ExperimentRunner] Report ${report.id} updated with judge results`);
        } catch (error) {
          console.error(`[ExperimentRunner] Failed to judge report ${report.id}:`, error);
          // Still mark as ready but with error info
          await updateRun(report.id, {
            metricsStatus: 'error',
            traceError: `Judge evaluation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
          });
        }
      },
      onAttempt: (attempt, maxAttempts) => {
        console.info(`[ExperimentRunner] Polling attempt ${attempt}/${maxAttempts} for report ${report.id}`);
      },
      onError: (error) => {
        console.error(`[ExperimentRunner] Trace polling failed for report ${report.id}:`, error);
      },
    }
  );
}
