/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * REST Connector
 * Handles non-streaming REST API calls to agents
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
 * REST Connector for non-streaming HTTP agents
 * Sends a single request and parses the response
 */
export class RESTConnector extends BaseConnector {
  readonly type = 'rest' as const;
  readonly name = 'REST API';
  readonly supportsStreaming = false;

  /**
   * Build generic REST payload
   * Can be customized via connectorConfig
   */
  buildPayload(request: ConnectorRequest): any {
    return {
      prompt: request.testCase.initialPrompt,
      context: request.testCase.context,
      model: request.modelId,
      tools: request.testCase.tools,
    };
  }

  /**
   * Execute REST request
   */
  async execute(
    endpoint: string,
    request: ConnectorRequest,
    auth: ConnectorAuth,
    onProgress?: ConnectorProgressCallback,
    onRawEvent?: ConnectorRawEventCallback
  ): Promise<ConnectorResponse> {
    const payload = this.buildPayload(request);
    const headers = this.buildAuthHeaders(auth);

    this.debug('Executing REST request');
    this.debug('Endpoint:', endpoint);
    this.debug('Payload:', JSON.stringify(payload).substring(0, 500));

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
      throw new Error(`REST request failed: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    onRawEvent?.(data);

    const trajectory = this.parseResponse(data);

    // Emit all steps at once (no streaming)
    trajectory.forEach(step => onProgress?.(step));

    return {
      trajectory,
      runId: data.runId || data.id || null,
      rawEvents: [data],
      metadata: {
        status: response.status,
        responseHeaders: Object.fromEntries(response.headers.entries()),
      },
    };
  }

  /**
   * Parse REST response into trajectory steps
   * This is a generic implementation - subclass for specific APIs
   */
  parseResponse(data: any): TrajectoryStep[] {
    const steps: TrajectoryStep[] = [];

    // Handle common response formats
    if (data.thinking) {
      steps.push(this.createStep('thinking', data.thinking));
    }

    if (data.toolCalls && Array.isArray(data.toolCalls)) {
      for (const call of data.toolCalls) {
        steps.push(this.createStep('action', `Calling ${call.name}...`, {
          toolName: call.name,
          toolArgs: call.args || call.input,
        }));

        if (call.result !== undefined) {
          steps.push(this.createStep('tool_result',
            typeof call.result === 'string' ? call.result : JSON.stringify(call.result),
            { status: 'SUCCESS' as ToolCallStatus }
          ));
        }
      }
    }

    // Handle response/content/answer fields
    const responseContent = data.response || data.content || data.answer || data.text || data.message;
    if (responseContent) {
      steps.push(this.createStep('response',
        typeof responseContent === 'string' ? responseContent : JSON.stringify(responseContent)
      ));
    }

    // Handle ML-Commons specific format
    if (data.inference_results) {
      const outputs = data.inference_results[0]?.output || [];
      for (const output of outputs) {
        if (output.name === 'response') {
          const content = output.dataAsMap?.response || output.result;
          if (content) {
            steps.push(this.createStep('response', content));
          }
        }
      }
    }

    // If nothing was parsed, create a generic response
    if (steps.length === 0 && data) {
      steps.push(this.createStep('response', JSON.stringify(data, null, 2)));
    }

    return steps;
  }
}

/**
 * Default instance for convenience
 */
export const restConnector = new RESTConnector();
