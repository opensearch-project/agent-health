/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Client-side services
 *
 * Services that run in the browser and communicate with the backend API.
 */

export {
  executeBenchmarkRun,
  cancelBenchmarkRun,
  // Backwards compatibility aliases
  executeExperimentRun,
  cancelExperimentRun,
} from './benchmarkApi';

export {
  runServerEvaluation,
  type ServerEvaluationRequest,
  type ServerEvaluationReport,
  type ServerEvaluationResult,
} from './evaluationApi';

export {
  getSessionMetadata,
  putSessionMetadata,
  listSessionMetadata,
} from './sessionAnnotationsApi';

export {
  streamAssistantChat,
  clearAssistantSession,
  checkAssistantHealth,
} from './assistantApi';

export {
  discoverSkills,
  validateSkill,
  streamSkillEval,
  getSkillResults,
} from './skillsApi';

export {
  executeEvaluationRun,
  listEvaluationRuns,
  getEvaluationRun,
  cancelEvaluationRun,
  deleteEvaluationRun,
  promoteEvaluationRun,
  updateEvaluationRun,
  type CreateEvaluationRunRequest,
  type EvaluationRunProgress,
  type EvaluationRunStartedEvent,
} from './evaluationRunsApi';
