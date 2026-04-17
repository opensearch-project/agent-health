/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Mock for @opentelemetry/semantic-conventions/incubating module
 * These constants are from the incubating (experimental) GenAI semantic conventions
 */

// Attribute names for GenAI spans
export const ATTR_GEN_AI_OPERATION_NAME = 'gen_ai.operation.name';
export const ATTR_GEN_AI_AGENT_NAME = 'gen_ai.agent.name';
export const ATTR_GEN_AI_PROVIDER_NAME = 'gen_ai.provider.name';
export const ATTR_GEN_AI_REQUEST_MODEL = 'gen_ai.request.model';
export const ATTR_GEN_AI_TOOL_NAME = 'gen_ai.tool.name';
export const ATTR_GEN_AI_TOOL_CALL_ID = 'gen_ai.tool.call_id';
export const ATTR_GEN_AI_SYSTEM = 'gen_ai.system';
export const ATTR_GEN_AI_USAGE_INPUT_TOKENS = 'gen_ai.usage.input_tokens';
export const ATTR_GEN_AI_USAGE_OUTPUT_TOKENS = 'gen_ai.usage.output_tokens';
export const ATTR_GEN_AI_REQUEST_TEMPERATURE = 'gen_ai.request.temperature';

// Operation name values
export const GEN_AI_OPERATION_NAME_VALUE_CREATE_AGENT = 'create_agent';
export const GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT = 'invoke_agent';
export const GEN_AI_OPERATION_NAME_VALUE_CHAT = 'chat';
export const GEN_AI_OPERATION_NAME_VALUE_TEXT_COMPLETION = 'text_completion';
export const GEN_AI_OPERATION_NAME_VALUE_GENERATE_CONTENT = 'generate_content';
export const GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL = 'execute_tool';

// Test attributes (from semantic-conventions registry)
export const ATTR_TEST_SUITE_NAME = 'test.suite.name';
export const ATTR_TEST_SUITE_RUN_STATUS = 'test.suite.run.status';
export const ATTR_TEST_CASE_NAME = 'test.case.name';
export const ATTR_TEST_CASE_RESULT_STATUS = 'test.case.result.status';

// Test suite run status values
export const TEST_SUITE_RUN_STATUS_VALUE_SUCCESS = 'success';
export const TEST_SUITE_RUN_STATUS_VALUE_FAILURE = 'failure';
export const TEST_SUITE_RUN_STATUS_VALUE_SKIPPED = 'skipped';
export const TEST_SUITE_RUN_STATUS_VALUE_ABORTED = 'aborted';
export const TEST_SUITE_RUN_STATUS_VALUE_TIMED_OUT = 'timed_out';
export const TEST_SUITE_RUN_STATUS_VALUE_IN_PROGRESS = 'in_progress';

// Test case result status values
export const TEST_CASE_RESULT_STATUS_VALUE_PASS = 'pass';
export const TEST_CASE_RESULT_STATUS_VALUE_FAIL = 'fail';

// GenAI evaluation attributes
export const ATTR_GEN_AI_EVALUATION_NAME = 'gen_ai.evaluation.name';
export const ATTR_GEN_AI_EVALUATION_SCORE_VALUE = 'gen_ai.evaluation.score.value';
export const ATTR_GEN_AI_EVALUATION_SCORE_LABEL = 'gen_ai.evaluation.score.label';
export const ATTR_GEN_AI_EVALUATION_EXPLANATION = 'gen_ai.evaluation.explanation';

// GenAI evaluation event name
export const EVENT_GEN_AI_EVALUATION_RESULT = 'gen_ai.evaluation.result';

export default {
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_AGENT_NAME,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_TOOL_CALL_ID,
  ATTR_GEN_AI_SYSTEM,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  ATTR_GEN_AI_REQUEST_TEMPERATURE,
  GEN_AI_OPERATION_NAME_VALUE_CREATE_AGENT,
  GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT,
  GEN_AI_OPERATION_NAME_VALUE_CHAT,
  GEN_AI_OPERATION_NAME_VALUE_TEXT_COMPLETION,
  GEN_AI_OPERATION_NAME_VALUE_GENERATE_CONTENT,
  GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL,
  ATTR_TEST_SUITE_NAME,
  ATTR_TEST_SUITE_RUN_STATUS,
  ATTR_TEST_CASE_NAME,
  ATTR_TEST_CASE_RESULT_STATUS,
  TEST_SUITE_RUN_STATUS_VALUE_SUCCESS,
  TEST_SUITE_RUN_STATUS_VALUE_FAILURE,
  TEST_CASE_RESULT_STATUS_VALUE_PASS,
  TEST_CASE_RESULT_STATUS_VALUE_FAIL,
  ATTR_GEN_AI_EVALUATION_NAME,
  ATTR_GEN_AI_EVALUATION_SCORE_VALUE,
  ATTR_GEN_AI_EVALUATION_SCORE_LABEL,
  ATTR_GEN_AI_EVALUATION_EXPLANATION,
  EVENT_GEN_AI_EVALUATION_RESULT,
};
