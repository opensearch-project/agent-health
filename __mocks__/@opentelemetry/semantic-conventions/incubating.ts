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
};
