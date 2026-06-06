/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Skill Benchmark Aggregator
 * Computes summary statistics from skill evaluation results.
 */

import type {
  SkillGradingResult,
  SkillTimingData,
  SkillConditionStats,
  SkillBenchmarkResult,
  StatSummary,
} from '@/types';

interface ConditionData {
  grading: SkillGradingResult;
  timing: SkillTimingData;
}

/**
 * Aggregate eval results into a benchmark summary.
 */
export function aggregateResults(
  withSkill: ConditionData[],
  withoutSkill: ConditionData[],
  meta: {
    skillName: string;
    skillPath: string;
    iteration: number;
    agentKey: string;
    modelId?: string;
  }
): SkillBenchmarkResult {
  const withStats = computeConditionStats(withSkill);
  const withoutStats = computeConditionStats(withoutSkill);

  return {
    skill_name: meta.skillName,
    skill_path: meta.skillPath,
    iteration: meta.iteration,
    created_at: new Date().toISOString(),
    agent_key: meta.agentKey,
    model_id: meta.modelId,
    run_summary: {
      with_skill: withStats,
      without_skill: withoutStats,
      delta: {
        pass_rate: withStats.pass_rate.mean - withoutStats.pass_rate.mean,
        time_seconds: withStats.time_seconds.mean - withoutStats.time_seconds.mean,
        tokens: withStats.tokens.mean - withoutStats.tokens.mean,
      },
    },
  };
}

function computeConditionStats(data: ConditionData[]): SkillConditionStats {
  const passRates = data.map(d => d.grading.summary.pass_rate);
  const times = data.map(d => d.timing.duration_ms / 1000);
  const tokens = data.map(d => d.timing.total_tokens ?? 0);

  return {
    pass_rate: computeStatSummary(passRates),
    time_seconds: computeStatSummary(times),
    tokens: computeStatSummary(tokens),
  };
}

function computeStatSummary(values: number[]): StatSummary {
  if (values.length === 0) {
    return { mean: 0, stddev: 0, min: 0, max: 0 };
  }

  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  const stddev = Math.sqrt(variance);

  return {
    mean: round(mean),
    stddev: round(stddev),
    min: round(Math.min(...values)),
    max: round(Math.max(...values)),
  };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
