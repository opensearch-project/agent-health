/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Skill Evaluator Service
 * Exports for skill parsing, evaluation, grading, aggregation, and improvement.
 */

export { parseSkill, parseEvals } from './parser';
export { runSkillEval, type SkillEvalOptions } from './runner';
export { gradeAssertions } from './grader';
export { aggregateResults } from './aggregator';
export { proposeImprovement, type ImprovementProposal } from './improver';
export { generateEvals } from './evalGenerator';
export { SkillExecutionError, isSkillExecutionError } from './errors';
export {
  DEFAULT_SKILL_MODEL_ID,
  SKILL_NAME_MAX_LENGTH,
  SKILL_DESCRIPTION_MAX_LENGTH,
  SKILL_DESCRIPTION_MIN_RECOMMENDED_LENGTH,
  SKILL_BODY_TOKEN_WARN_THRESHOLD,
} from './constants';
