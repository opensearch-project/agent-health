/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * LangGraph REST Connector
 * Handles non-streaming REST calls to LangGraph agents
 *
 * For AG-UI streaming LangGraph agents, use the existing agui-streaming connector.
 * This connector is for LangGraph instances exposed via direct REST API.
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
 * LangGraph REST Connector
 *
 * Communicates with LangGraph agents via the LangGraph REST API.
 * Uses the /invoke endpoint for synchronous execution.
 * For streaming LangGraph agents, use the agui-streaming connector instead.
 *
 * Configuration:
 * - endpoint: Base URL of the LangGraph server (e.g., "http://localhost:8123")
 * - connectorConfig.graphId: Graph/assistant ID (defaults to "agent")
 * - connectorConfig.threadId: Optional thread ID for multi-turn
 */
export class LangGraphConnector extends BaseConnector {
  readonly type = 'langgraph' as const;
  readonly name = 'LangGraph (REST)';

  override traceContext = { propagateHeader: true };
  readonly supportsStreaming = false;

  buildPayload(request: ConnectorRequest): any {
    const config = request.connectorConfig || {};
    return {
      input: {
        messages: [
          {
            role: 'user',
            content: request.testCase.initialPrompt,
          },
        ],
      },
      config: {
        configurable: {
          ...(request.modelId && { model: request.modelId }),
          ...config.configurable,
        },
      },
    };
  }

  async execute(
    endpoint: string,
    request: ConnectorRequest,
    auth: ConnectorAuth,
    onProgress?: ConnectorProgressCallback,
    onRawEvent?: ConnectorRawEventCallback
  ): Promise<ConnectorResponse> {
    const payload = request.payload || this.buildPayload(request);
    const headers = this.buildAuthHeaders(auth);
    this.injectTraceparentHeaders(headers);
    const config = request.connectorConfig || {};
    const graphId = config.graphId || 'agent';

    // Build the invoke URL
    const baseUrl = endpoint.replace(/\/+$/, '');
    const threadId = config.threadId || request.threadId;
    const invokeUrl = threadId
      ? `${baseUrl}/threads/${threadId}/runs/wait`
      : `${baseUrl}/assistants/${graphId}/invoke`;

    this.debug('Executing LangGraph request');
    this.debug('URL:', invokeUrl);

    const response = await fetch(invokeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`LangGraph request failed: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    onRawEvent?.(data);

    const trajectory = this.parseResponse(data);
    trajectory.forEach(step => onProgress?.(step));

    return {
      trajectory,
      runId: data.run_id || data.thread_id || threadId || null,
      rawEvents: [data],
      metadata: {
        graphId,
        threadId: data.thread_id || threadId,
      },
    };
  }

  parseResponse(data: any): TrajectoryStep[] {
    const steps: TrajectoryStep[] = [];

    // LangGraph invoke response format: { output: { messages: [...] } }
    // Or thread-based: { values: { messages: [...] } }
    const messages = data.output?.messages || data.values?.messages || data.messages || [];

    for (const msg of messages) {
      const role = msg.type || msg.role;
      const content = typeof msg.content === 'string'
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.map((c: any) => c.text || JSON.stringify(c)).join('\n')
          : JSON.stringify(msg.content);

      if (role === 'ai' || role === 'assistant') {
        // Check for tool calls in the AI message
        if (msg.tool_calls && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
          for (const toolCall of msg.tool_calls) {
            steps.push(this.createStep('action', `Calling ${toolCall.name}...`, {
              toolName: toolCall.name,
              toolArgs: toolCall.args,
            }));
          }
        }

        // AI reasoning or intermediate response
        if (content && !msg.tool_calls?.length) {
          steps.push(this.createStep('assistant', content));
        }
      } else if (role === 'tool') {
        steps.push(this.createStep('tool_result', content, {
          toolName: msg.name,
          status: 'SUCCESS' as ToolCallStatus,
        }));
      }
    }

    // The last AI message without tool calls is the final response
    const lastAssistant = [...steps].reverse().find(s => s.type === 'assistant');
    if (lastAssistant) {
      lastAssistant.type = 'response';
    }

    // Handle intermediate_steps format (older LangGraph versions)
    if (data.intermediate_steps && Array.isArray(data.intermediate_steps)) {
      for (const [action, observation] of data.intermediate_steps) {
        if (action?.tool) {
          steps.push(this.createStep('action', `Calling ${action.tool}...`, {
            toolName: action.tool,
            toolArgs: action.tool_input,
          }));
        }
        if (observation !== undefined) {
          const obsContent = typeof observation === 'string' ? observation : JSON.stringify(observation);
          steps.push(this.createStep('tool_result', obsContent, {
            status: 'SUCCESS' as ToolCallStatus,
          }));
        }
      }
    }

    // Handle direct output field
    if (data.output && typeof data.output === 'string' && steps.length === 0) {
      steps.push(this.createStep('response', data.output));
    }

    // Fallback
    if (steps.length === 0 && data) {
      steps.push(this.createStep('response', JSON.stringify(data, null, 2)));
    }

    return steps;
  }

  async healthCheck(endpoint: string, auth: ConnectorAuth): Promise<boolean> {
    try {
      const headers = this.buildAuthHeaders(auth);
      const baseUrl = endpoint.replace(/\/+$/, '');
      const response = await fetch(`${baseUrl}/ok`, {
        method: 'GET',
        headers,
      });
      return response.ok;
    } catch {
      // Try root endpoint as fallback
      try {
        const headers = this.buildAuthHeaders(auth);
        const response = await fetch(endpoint, { method: 'GET', headers });
        return response.ok;
      } catch {
        return false;
      }
    }
  }
}

export const langgraphConnector = new LangGraphConnector();
