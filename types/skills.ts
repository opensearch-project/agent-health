/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Skill Evaluator Types
 * Types for the AgentSkills open standard evaluation framework
 */

import type { TrajectoryStep } from './index';

// ============ Skill Definition Types ============

export interface SkillMetadata {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, unknown>;
  allowedTools?: string[];
}

export interface Skill {
  metadata: SkillMetadata;
  instructions: string;
  path: string;
}

// ============ Eval Definition Types ============

export interface SkillEval {
  id: number;
  prompt: string;
  expected_output: string;
  files?: string[];
  assertions: string[];
}

export interface SkillEvalsFile {
  skill_name: string;
  evals: SkillEval[];
}

// ============ Grading Types ============

export interface SkillAssertionResult {
  text: string;
  passed: boolean;
  evidence: string;
}

export interface SkillGradingResult {
  assertion_results: SkillAssertionResult[];
  summary: {
    passed: number;
    failed: number;
    total: number;
    pass_rate: number;
  };
}

// ============ Timing Types ============

export interface SkillTimingData {
  total_tokens?: number;
  duration_ms: number;
}

// ============ Benchmark Types ============

export interface StatSummary {
  mean: number;
  stddev: number;
  min: number;
  max: number;
}

export interface SkillConditionStats {
  pass_rate: StatSummary;
  time_seconds: StatSummary;
  tokens: StatSummary;
}

export interface SkillBenchmarkResult {
  skill_name: string;
  skill_path: string;
  iteration: number;
  created_at: string;
  agent_key: string;
  model_id?: string;
  run_summary: {
    with_skill: SkillConditionStats;
    without_skill: SkillConditionStats;
    delta: {
      pass_rate: number;
      time_seconds: number;
      tokens: number;
    };
  };
}

// ============ Eval Run Types ============

export type SkillEvalCondition = 'with_skill' | 'without_skill';

/**
 * Per-eval outcome.
 *
 *  - 'passed'  : agent ran cleanly and every assertion graded true
 *  - 'failed'  : agent ran cleanly but at least one assertion graded false
 *               (this is the signal the improver learns from)
 *  - 'errored' : agent execution itself failed (crash / timeout / endpoint
 *               unreachable). Skill quality is *unknowable* until the agent
 *               is healthy again — keep this distinct from 'failed' so the
 *               improver does not try to "fix the skill" for a bug elsewhere.
 */
export type SkillEvalStatus = 'passed' | 'failed' | 'errored';

export interface SkillEvalRunResult {
  evalId: number;
  condition: SkillEvalCondition;
  trajectory: TrajectoryStep[];
  timing: SkillTimingData;
  grading: SkillGradingResult;
  /** Tri-state outcome — see SkillEvalStatus jsdoc. */
  evalStatus: SkillEvalStatus;
  /** Populated when evalStatus === 'errored'. */
  errorMessage?: string;
}

// ============ Progress Events ============

export type SkillEvalProgressEvent =
  | { type: 'started'; skillName: string; totalEvals: number; iteration: number }
  | { type: 'eval_running'; evalId: number; condition: SkillEvalCondition; prompt: string }
  | { type: 'eval_grading'; evalId: number; condition: SkillEvalCondition }
  | {
      type: 'eval_done';
      evalId: number;
      condition: SkillEvalCondition;
      passRate: number;
      /** Tri-state status — distinguishes assertion failure from execution error. */
      evalStatus: SkillEvalStatus;
      /** Populated when evalStatus === 'errored'. */
      errorMessage?: string;
    }
  | { type: 'improving'; message: string }
  | { type: 'improved'; applied: boolean; changes: string; reasoning: string; improvedInstructions?: string }
  | { type: 'completed'; benchmark: SkillBenchmarkResult }
  | { type: 'error'; message: string };

// ============ Validation Types ============

export interface SkillValidationResult {
  valid: boolean;
  skill?: Skill;
  evalsFile?: SkillEvalsFile;
  errors: string[];
  warnings: string[];
}
