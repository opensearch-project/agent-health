/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AG-UI Streaming Connector
 * Handles communication with agents using the AG-UI protocol over SSE
 */

import type { TrajectoryStep } from '@/types';
import type { AGUIEvent } from '@/types/agui';
import { BaseConnector } from '@/services/connectors/base/BaseConnector';
import type {
  ConnectorAuth,
  ConnectorRequest,
  ConnectorResponse,
  ConnectorProgressCallback,
  ConnectorRawEventCallback,
} from '@/services/connectors/types';
import { consumeSSEStream } from '@/services/agent/sseStream';
import { buildAgentPayload, AgentRequestPayload } from '@/services/agent/payloadBuilder';
import { AGUIToTrajectoryConverter, computeTrajectoryFromRawEvents } from '@/services/agent/aguiConverter';

/**
 * AG-UI Streaming Connector
 * Uses Server-Sent Events (SSE) to stream agent responses in AG-UI format
 */
export class AGUIStreamingConnector extends BaseConnector {
  readonly type = 'agui-streaming' as const;
  readonly name = 'AG-UI Streaming';
  readonly supportsStreaming = true;

  /**
   * Build AG-UI payload from standard request
   */
  buildPayload(request: ConnectorRequest): AgentRequestPayload {
    return buildAgentPayload(
      request.testCase,
      request.modelId,
      request.threadId,
      request.runId
    );
  }

  /**
   * Execute the request using SSE streaming
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
    const trajectory: TrajectoryStep[] = [];
    const rawEvents: AGUIEvent[] = [];
    const converter = new AGUIToTrajectoryConverter();

    this.debug('Executing AG-UI streaming request');
    this.debug('Endpoint:', endpoint);
    this.debug('Payload:', JSON.stringify(payload).substring(0, 500));

    await consumeSSEStream(
      endpoint,
      payload,
      (event: AGUIEvent) => {
        // Capture raw event for debugging
        rawEvents.push(event);
        onRawEvent?.(event);

        // Convert to trajectory steps
        const steps = converter.processEvent(event);
        steps.forEach(step => {
          trajectory.push(step);
          onProgress?.(step);
        });
      },
      headers
    );

    const runId = converter.getRunId();
    this.debug('Stream completed. RunId:', runId, 'Steps:', trajectory.length);

    return {
      trajectory,
      runId,
      rawEvents,
      metadata: {
        threadId: converter.getThreadId(),
      },
    };
  }

  /**
   * Parse raw AG-UI events into trajectory steps
   * Used for re-processing stored raw events
   */
  parseResponse(rawEvents: AGUIEvent[]): TrajectoryStep[] {
    return computeTrajectoryFromRawEvents(rawEvents);
  }

  /**
   * Health check for AG-UI endpoint
   * Tries to connect without sending a full request
   */
  async healthCheck(endpoint: string, auth: ConnectorAuth): Promise<boolean> {
    try {
      const headers = this.buildAuthHeaders(auth);
      // For AG-UI endpoints, we can't really do a health check without
      // making a full request, so just check if the endpoint is reachable
      const response = await fetch(endpoint, {
        method: 'OPTIONS',
        headers,
      });
      // Accept any response that isn't a network error
      return true;
    } catch (error) {
      this.error('Health check failed:', error);
      return false;
    }
  }
}

/**
 * Default instance for convenience
 */
export const aguiStreamingConnector = new AGUIStreamingConnector();
