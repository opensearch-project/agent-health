/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Agent Request Payload Builder
 * Constructs the request payload for the OpenSearch ML agent endpoint
 */

import { TestCase, AgentContextItem, AgentToolDefinition } from '@/types';

export interface AgentMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

export interface AgentRequestPayload {
  threadId: string;
  runId: string;
  messages: AgentMessage[];
  tools: AgentToolDefinition[];
  context: AgentContextItem[];
  state: Record<string, any>;
  forwardedProps: Record<string, any>;
}

/**
 * Default tool for PPL query execution (matches client-side definition)
 */
export const DEFAULT_PPL_TOOL: AgentToolDefinition = {
  name: 'execute_ppl_query',
  description: 'Update the query bar with a PPL query and optionally execute it',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The PPL query to set in the query bar',
      },
      autoExecute: {
        type: 'boolean',
        description: 'Whether to automatically execute the query (default: true)',
      },
      description: {
        type: 'string',
        description: 'Optional description of what the query does',
      },
    },
    required: ['query'],
  },
};

/**
 * Generate a unique ID with prefix (matching AG-UI format)
 */
function generateId(prefix: string): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 11);
  return `${prefix}-${timestamp}-${random}`;
}

/**
 * Build agent request payload from test case
 * Tools are passed from test case or default to PPL tool
 */
export function buildAgentPayload(
  testCase: TestCase,
  modelId: string,
  threadId?: string,
  runId?: string
): AgentRequestPayload {
  // Use tools from test case, or default to PPL tool for Smart Contextual Menu tests
  const tools = testCase.tools || [DEFAULT_PPL_TOOL];

  return {
    threadId: threadId || generateId('thread'),
    runId: runId || generateId('run'),
    messages: [
      {
        id: generateId('msg'),
        role: 'user',
        content: testCase.initialPrompt,
      },
    ],
    tools,
    context: testCase.context || [],
    state: {},
    forwardedProps: {},
  };
}

/**
 * Build agent payload for multi-turn conversation
 */
export function buildMultiTurnPayload(
  messages: AgentMessage[],
  threadId?: string,
  runId?: string,
  context?: AgentContextItem[],
  tools?: AgentToolDefinition[]
): AgentRequestPayload {
  return {
    threadId: threadId || generateId('thread'),
    runId: runId || generateId('run'),
    messages,
    tools: tools || [DEFAULT_PPL_TOOL],
    context: context || [],
    state: {},
    forwardedProps: {},
  };
}
