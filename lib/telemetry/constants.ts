/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OTel Semantic Convention constants for evaluation telemetry.
 *
 * In-spec attributes are re-exported from @opentelemetry/semantic-conventions.
 * Proposed and extension attributes are defined here as string constants.
 */

// =============================================================================
// In-spec attributes (Development stability)
// Re-exported from @opentelemetry/semantic-conventions for convenience
// =============================================================================

export {
  // Test attributes (model/test/registry.yaml)
  ATTR_TEST_SUITE_NAME,
  ATTR_TEST_SUITE_RUN_STATUS,
  ATTR_TEST_CASE_NAME,
  ATTR_TEST_CASE_RESULT_STATUS,
  TEST_SUITE_RUN_STATUS_VALUE_SUCCESS,
  TEST_SUITE_RUN_STATUS_VALUE_FAILURE,
  TEST_SUITE_RUN_STATUS_VALUE_IN_PROGRESS,
  TEST_CASE_RESULT_STATUS_VALUE_PASS,
  TEST_CASE_RESULT_STATUS_VALUE_FAIL,

  // GenAI evaluation attributes (model/gen-ai/registry.yaml, PR #2563)
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_EVALUATION_NAME,
  ATTR_GEN_AI_EVALUATION_SCORE_VALUE,
  ATTR_GEN_AI_EVALUATION_SCORE_LABEL,
  ATTR_GEN_AI_EVALUATION_EXPLANATION,

  // GenAI evaluation event (model/gen-ai/events.yaml)
  EVENT_GEN_AI_EVALUATION_RESULT,
} from '@opentelemetry/semantic-conventions/incubating';

// =============================================================================
// Proposed attributes (Issue #3398 — not yet in spec)
// https://github.com/open-telemetry/semantic-conventions/issues/3398
// =============================================================================

/** Unique identifier for a specific test suite run */
export const ATTR_TEST_SUITE_RUN_ID = 'test.suite.run.id' as const;

/** Machine-readable unique identifier for a test case */
export const ATTR_TEST_CASE_ID = 'test.case.id' as const;

// =============================================================================
// IO attributes (used by Python SDK, not yet standardized)
// =============================================================================

/** Test case input (prompt) */
export const ATTR_TEST_CASE_INPUT = 'test.case.input' as const;

/** Test case output (agent response) */
export const ATTR_TEST_CASE_OUTPUT = 'test.case.output' as const;

/** Test case expected outcome */
export const ATTR_TEST_CASE_EXPECTED = 'test.case.expected' as const;

// =============================================================================
// Agent Health extension attributes (agent_health.* prefix)
// =============================================================================

/** Model ID used by the LLM judge */
export const ATTR_AGENT_HEALTH_JUDGE_MODEL_ID = 'agent_health.judge.model_id' as const;

/** Time spent in LLM judge evaluation (ms) */
export const ATTR_AGENT_HEALTH_JUDGE_DURATION_MS = 'agent_health.judge.duration_ms' as const;

/** Number of retry attempts for the LLM judge */
export const ATTR_AGENT_HEALTH_JUDGE_ATTEMPTS = 'agent_health.judge.attempts' as const;

/** Time spent in agent execution (ms) */
export const ATTR_AGENT_HEALTH_AGENT_DURATION_MS = 'agent_health.agent.duration_ms' as const;

/** Connector protocol used for agent communication */
export const ATTR_AGENT_HEALTH_CONNECTOR_PROTOCOL = 'agent_health.connector.protocol' as const;

/** Agent run ID — links eval spans to the agent execution trace */
export const ATTR_AGENT_HEALTH_AGENT_RUN_ID = 'gen_ai.request.id' as const;

// =============================================================================
// Constants
// =============================================================================

/** Operation name value for evaluation spans */
export const GEN_AI_OPERATION_NAME_VALUE_EVALUATION = 'evaluation' as const;

/** Maximum length for truncated attribute values */
export const MAX_ATTRIBUTE_LENGTH = 10000;

/** Maximum length for judge explanation in events */
export const MAX_EXPLANATION_LENGTH = 4000;

/** Tracer name used for evaluation spans */
export const EVAL_TRACER_NAME = 'agent-health-eval';
