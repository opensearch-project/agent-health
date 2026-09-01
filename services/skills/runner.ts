/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Skill Evaluation Runner
 * Orchestrates A/B runs (with-skill vs without-skill) for each eval case.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type {
  AgentConfig,
  TestCase,
  TrajectoryStep,
  Skill,
  SkillEvalsFile,
  SkillEval,
  SkillEvalCondition,
  SkillEvalRunResult,
  SkillEvalStatus,
  SkillTimingData,
  SkillGradingResult,
  SkillBenchmarkResult,
  SkillEvalProgressEvent,
} from '@/types';
import type { ConnectorRegistry } from '@/connectors';
import { runEvaluationWithConnector } from '@/services/evaluation';
import { gradeAssertions } from './grader';
import { aggregateResults } from './aggregator';
import { debug } from '@/lib/debug';

export interface SkillEvalOptions {
  skill: Skill;
  evals: SkillEvalsFile;
  agent: AgentConfig;
  modelId: string;
  workspacePath: string;
  iteration: number;
  registry: ConnectorRegistry;
  serverBaseUrl: string;
  onProgress?: (event: SkillEvalProgressEvent) => void;
}

/**
 * Run a full skill evaluation (A/B across all evals).
 */
export async function runSkillEval(options: SkillEvalOptions): Promise<SkillBenchmarkResult> {
  const { skill, evals, agent, modelId, workspacePath, iteration, registry, serverBaseUrl, onProgress } = options;

  const iterationDir = join(workspacePath, `iteration-${iteration}`);
  mkdirSync(iterationDir, { recursive: true });

  onProgress?.({
    type: 'started',
    skillName: skill.metadata.name,
    totalEvals: evals.evals.length,
    iteration,
  });

  const withSkillResults: { grading: SkillGradingResult; timing: SkillTimingData }[] = [];
  const withoutSkillResults: { grading: SkillGradingResult; timing: SkillTimingData }[] = [];

  for (const evalCase of evals.evals) {
    const evalDir = join(iterationDir, `eval-${evalCase.id}`);

    // Run with skill
    const withResult = await runOneCondition(evalCase, 'with_skill', {
      agent,
      modelId,
      skill,
      evalDir,
      registry,
      serverBaseUrl,
      onProgress,
    });
    withSkillResults.push({ grading: withResult.grading, timing: withResult.timing });

    // Run without skill
    const withoutResult = await runOneCondition(evalCase, 'without_skill', {
      agent,
      modelId,
      skill: undefined,
      evalDir,
      registry,
      serverBaseUrl,
      onProgress,
    });
    withoutSkillResults.push({ grading: withoutResult.grading, timing: withoutResult.timing });
  }

  // Aggregate
  const benchmark = aggregateResults(withSkillResults, withoutSkillResults, {
    skillName: skill.metadata.name,
    skillPath: skill.path,
    iteration,
    agentKey: agent.key,
    modelId,
  });

  // Write benchmark.json
  writeFileSync(
    join(iterationDir, 'benchmark.json'),
    JSON.stringify(benchmark, null, 2)
  );

  onProgress?.({ type: 'completed', benchmark });

  return benchmark;
}

interface RunConditionOptions {
  agent: AgentConfig;
  modelId: string;
  skill: Skill | undefined;
  evalDir: string;
  registry: ConnectorRegistry;
  serverBaseUrl: string;
  onProgress?: (event: SkillEvalProgressEvent) => void;
}

async function runOneCondition(
  evalCase: SkillEval,
  condition: SkillEvalCondition,
  options: RunConditionOptions,
): Promise<SkillEvalRunResult> {
  const { agent, modelId, skill, evalDir, registry, serverBaseUrl, onProgress } = options;

  const conditionDir = join(evalDir, condition);
  mkdirSync(conditionDir, { recursive: true });

  onProgress?.({ type: 'eval_running', evalId: evalCase.id, condition, prompt: evalCase.prompt });

  // Build a synthetic test case from the eval prompt
  const testCase = buildTestCase(evalCase, skill, condition);

  // Build agent config: inject skill for 'with_skill', ensure non-interactive for all
  let effectiveAgent = condition === 'with_skill' && skill
    ? injectSkill(agent, skill)
    : agent;

  // Claude Code needs dangerouslySkipPermissions for non-interactive execution
  if (effectiveAgent.connectorType === 'claude-code' && !effectiveAgent.connectorConfig?.dangerouslySkipPermissions) {
    effectiveAgent = {
      ...effectiveAgent,
      connectorConfig: { ...effectiveAgent.connectorConfig, dangerouslySkipPermissions: true },
    };
  }

  // Execute — don't pass modelId to agent (it's for the judge, not the agent under test)
  const startTime = Date.now();
  const trajectory: TrajectoryStep[] = [];
  let executionError: Error | undefined;

  try {
    await runEvaluationWithConnector(
      effectiveAgent,
      '',
      testCase,
      (step) => { trajectory.push(step); },
      { registry },
    );
  } catch (err) {
    debug('SkillRunner', `Execution failed for eval ${evalCase.id} (${condition}):`, err);
    executionError = err instanceof Error ? err : new Error(String(err));
    // Push a synthetic error step so downstream consumers (UI / serializer)
    // can still see *something* in the trajectory — but the canonical signal
    // is the SkillExecutionError thrown below, surfaced via evalStatus.
    trajectory.push({
      id: `error-${evalCase.id}-${condition}`,
      type: 'response',
      content: `Error: ${executionError.message}`,
      timestamp: Date.now(),
    });
  }

  const durationMs = Date.now() - startTime;
  const timing: SkillTimingData = { duration_ms: durationMs };

  // Write timing.json
  writeFileSync(join(conditionDir, 'timing.json'), JSON.stringify(timing, null, 2));

  // Grade assertions — skip if the agent itself errored. Grading an error
  // response would (a) waste a judge call and (b) wrongly attribute the
  // failure to the *skill*, when the skill is unknowable until the agent
  // is healthy. Surface 'errored' as a distinct outcome instead.
  let grading: SkillGradingResult;
  let evalStatus: SkillEvalStatus;

  if (executionError) {
    grading = {
      assertion_results: evalCase.assertions.map(a => ({
        text: a,
        passed: false,
        evidence: `Skipped: agent execution errored before grading (${executionError!.message})`,
      })),
      summary: {
        passed: 0,
        failed: evalCase.assertions.length,
        total: evalCase.assertions.length,
        pass_rate: 0,
      },
    };
    evalStatus = 'errored';
  } else {
    onProgress?.({ type: 'eval_grading', evalId: evalCase.id, condition });

    if (evalCase.assertions.length > 0) {
      grading = await gradeAssertions({
        trajectory,
        assertions: evalCase.assertions,
        serverBaseUrl,
        modelId,
      });
    } else {
      grading = { assertion_results: [], summary: { passed: 0, failed: 0, total: 0, pass_rate: 0 } };
    }

    evalStatus = grading.summary.total > 0 && grading.summary.passed === grading.summary.total
      ? 'passed'
      : 'failed';
  }

  // Write grading.json
  writeFileSync(join(conditionDir, 'grading.json'), JSON.stringify(grading, null, 2));

  onProgress?.({
    type: 'eval_done',
    evalId: evalCase.id,
    condition,
    passRate: grading.summary.pass_rate,
    evalStatus,
    ...(executionError ? { errorMessage: executionError.message } : {}),
  });

  // Surface the execution error via the result's evalStatus / errorMessage
  // (in-band) instead of throwing — the suite keeps running so a single bad
  // eval doesn't poison the rest. Callers wanting fail-fast can inspect
  // `result.evalStatus === 'errored'` or wrap with SkillExecutionError.

  return {
    evalId: evalCase.id,
    condition,
    trajectory,
    timing,
    grading,
    evalStatus,
    ...(executionError ? { errorMessage: executionError.message } : {}),
  };
}

/**
 * Build a synthetic TestCase from a SkillEval prompt.
 * For with_skill, prepend skill instructions to the prompt (avoids shell escaping
 * issues with --append-system-prompt on subprocess connectors).
 */
function buildTestCase(evalCase: SkillEval, skill: Skill | undefined, condition: SkillEvalCondition): TestCase {
  const prompt = condition === 'with_skill' && skill
    ? `${formatSkillPrompt(skill)}\n\n---\n\n${evalCase.prompt}`
    : evalCase.prompt;

  return {
    id: `skill-eval-${evalCase.id}-${condition}`,
    name: `Skill Eval #${evalCase.id}`,
    description: evalCase.expected_output,
    labels: [],
    category: 'Other' as any,
    difficulty: 'Medium',
    currentVersion: 1,
    versions: [],
    initialPrompt: prompt,
    context: [],
    expectedOutcomes: [evalCase.expected_output],
    isPromoted: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Clone agent config with skill instructions injected via appendSystemPrompt.
 */
function injectSkill(agent: AgentConfig, skill: Skill): AgentConfig {
  // For claude-code/subprocess: don't use --append-system-prompt (shell escaping breaks
  // on multiline content with shell: true). Instead, we prepend skill instructions to
  // the test case prompt via buildTestCase.
  return agent;
}

function formatSkillPrompt(skill: Skill): string {
  return `<skill name="${skill.metadata.name}">
${skill.instructions}
</skill>`;
}
