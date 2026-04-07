/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * LiteLLM Connector
 *
 * OpenAI-compatible connector for LiteLLM proxy and any OpenAI-compatible API.
 * Formats requests as OpenAI Chat Completions and parses the response.
 *
 * Works with:
 * - LiteLLM proxy (https://litellm.ai)
 * - OpenAI API directly
 * - Azure OpenAI
 * - Any OpenAI-compatible endpoint (vLLM, Ollama, etc.)
 */

import type { TrajectoryStep, ToolCallStatus } from '@/types';
import { BaseConnector } from '@/services/connectors/base/BaseConnector';
import type {
  ConnectorAuth,
  ConnectorRequest,
  ConnectorResponse,
  ConnectorProgressCallback,
  ConnectorRawEventCallback,
} from '@/services/connectors/types';

/**
 * OpenAI Chat Completion message format
 */
interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
}

/**
 * OpenAI Chat Completion response format
 */
interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: {
          name: string;
          arguments: string;
        };
      }>;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * LiteLLM / OpenAI-compatible connector
 */
export class LiteLLMConnector extends BaseConnector {
  readonly type = 'litellm' as const;
  readonly name = 'LiteLLM / OpenAI-compatible';
  readonly supportsStreaming = false;

  /**
   * Build OpenAI Chat Completion payload from test case
   */
  buildPayload(request: ConnectorRequest): any {
    const messages: ChatMessage[] = [];

    // Add context as system message if present
    if (request.testCase.context && request.testCase.context.length > 0) {
      const contextText = request.testCase.context
        .map((c: any) => typeof c === 'string' ? c : JSON.stringify(c))
        .join('\n');
      messages.push({
        role: 'system',
        content: contextText,
      });
    }

    // Add the prompt as user message
    messages.push({
      role: 'user',
      content: request.testCase.initialPrompt,
    });

    const payload: any = {
      model: request.modelId,
      messages,
    };

    // Add tools if the test case defines them
    if (request.testCase.tools && request.testCase.tools.length > 0) {
      payload.tools = request.testCase.tools.map((tool: any) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description || '',
          parameters: tool.parameters || {},
        },
      }));
    }

    return payload;
  }

  /**
   * Execute OpenAI-compatible Chat Completion request
   */
  async execute(
    endpoint: string,
    request: ConnectorRequest,
    auth: ConnectorAuth,
    onProgress?: ConnectorProgressCallback,
    onRawEvent?: ConnectorRawEventCallback
  ): Promise<ConnectorResponse> {
    const payload = request.payload || this.buildPayload(request);
    const headers = this.buildAuthHeaders(auth);

    this.debug('Executing LiteLLM request');
    this.debug('Endpoint:', endpoint);
    this.debug('Model:', payload.model);

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`LiteLLM request failed: ${response.status} - ${errorText}`);
    }

    const data: ChatCompletionResponse = await response.json();
    onRawEvent?.(data);

    const trajectory = this.parseResponse(data);
    trajectory.forEach(step => onProgress?.(step));

    return {
      trajectory,
      runId: data.id || null,
      rawEvents: [data],
      metadata: {
        model: data.model,
        usage: data.usage,
        finishReason: data.choices?.[0]?.finish_reason,
      },
    };
  }

  /**
   * Parse OpenAI Chat Completion response into trajectory steps
   */
  parseResponse(data: any): TrajectoryStep[] {
    const steps: TrajectoryStep[] = [];
    const choice = data.choices?.[0];

    if (!choice) {
      steps.push(this.createStep('response', JSON.stringify(data, null, 2)));
      return steps;
    }

    const message = choice.message;

    // Handle tool calls
    if (message.tool_calls && message.tool_calls.length > 0) {
      for (const toolCall of message.tool_calls) {
        let toolArgs: any;
        try {
          toolArgs = JSON.parse(toolCall.function.arguments);
        } catch {
          toolArgs = toolCall.function.arguments;
        }

        steps.push(this.createStep('action', `Calling ${toolCall.function.name}...`, {
          toolName: toolCall.function.name,
          toolArgs,
        }));
      }
    }

    // Handle content response
    if (message.content) {
      steps.push(this.createStep('response', message.content));
    }

    // If no content and no tool calls, create a generic response
    if (steps.length === 0) {
      steps.push(this.createStep('response', '(empty response)'));
    }

    return steps;
  }
}

/**
 * Default instance for convenience
 */
export const litellmConnector = new LiteLLMConnector();
