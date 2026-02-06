/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Mock Connector
 * Generates demo/test trajectory without calling a real agent
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
 * Mock Connector for demo and testing
 * Generates a realistic trajectory without calling a real agent
 */
export class MockConnector extends BaseConnector {
  readonly type = 'mock' as const;
  readonly name = 'Demo Agent (Mock)';
  readonly supportsStreaming = true;

  /**
   * Build payload - not used for mock but required by interface
   */
  buildPayload(request: ConnectorRequest): any {
    return {
      question: request.testCase.initialPrompt,
      context: request.testCase.context,
    };
  }

  /**
   * Execute mock request - generates realistic trajectory with delays
   */
  async execute(
    endpoint: string,
    request: ConnectorRequest,
    auth: ConnectorAuth,
    onProgress?: ConnectorProgressCallback,
    onRawEvent?: ConnectorRawEventCallback
  ): Promise<ConnectorResponse> {
    const trajectory: TrajectoryStep[] = [];
    const rawEvents: any[] = [];
    const runId = `mock-run-${Date.now()}`;
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

    this.debug('Generating mock trajectory for:', request.testCase.name);

    // Helper to emit step
    const emitStep = (step: TrajectoryStep) => {
      trajectory.push(step);
      onProgress?.(step);
      // Also emit as "raw event" for consistency
      rawEvents.push({ type: 'MOCK_STEP', step });
      onRawEvent?.({ type: 'MOCK_STEP', step });
    };

    // Step 1: Initial thinking/analysis
    await sleep(100);
    emitStep(this.createStep('assistant',
      'I need to investigate this issue. Let me start by checking the cluster health and then drill down into specific metrics.'
    ));

    // Step 2: First tool call
    await sleep(300);
    emitStep(this.createStep('action',
      'Calling opensearch_cluster_health...',
      {
        toolName: 'opensearch_cluster_health',
        toolArgs: { local: true },
      }
    ));

    // Step 3: First tool result
    await sleep(500);
    emitStep(this.createStep('tool_result',
      JSON.stringify({ status: 'yellow', number_of_nodes: 3, unassigned_shards: 0 }, null, 2),
      {
        status: 'SUCCESS' as ToolCallStatus,
        latencyMs: 500,
      }
    ));

    // Step 4: Analysis after first tool
    await sleep(300);
    emitStep(this.createStep('assistant',
      'The cluster is in yellow state. Let me check the node stats to identify which node might be causing issues.'
    ));

    // Step 5: Second tool call
    await sleep(300);
    emitStep(this.createStep('action',
      'Calling opensearch_nodes_stats...',
      {
        toolName: 'opensearch_nodes_stats',
        toolArgs: { metric: 'jvm,os' },
      }
    ));

    // Step 6: Second tool result
    await sleep(600);
    emitStep(this.createStep('tool_result',
      'Node-1: CPU 12%, JVM Heap 45%\nNode-2: CPU 15%, JVM Heap 52%\nNode-3: CPU 98%, JVM Heap 89% (Data Node)',
      {
        status: 'SUCCESS' as ToolCallStatus,
        latencyMs: 600,
      }
    ));

    // Step 7: Final response with RCA
    await sleep(400);
    emitStep(this.createStep('response',
      `## Root Cause Analysis Complete

**Finding:** High CPU utilization detected on Node-3 (98% CPU, 89% JVM Heap)

**Root Cause:** Node-3 is experiencing resource exhaustion, likely due to:
1. Heavy indexing or search operations
2. Garbage collection pressure from high heap usage
3. Possible hot spot in shard distribution

**Recommendations:**
1. Check hot threads on Node-3 using \`_nodes/Node-3/hot_threads\`
2. Review shard distribution and consider rebalancing
3. Monitor GC logs for long pauses
4. Consider scaling horizontally if load persists`
    ));

    this.debug('Mock trajectory completed. Steps:', trajectory.length);

    return {
      trajectory,
      runId,
      rawEvents,
      metadata: {
        mock: true,
        testCaseId: request.testCase.id,
        testCaseName: request.testCase.name,
      },
    };
  }

  /**
   * Parse raw events - for mock, just extract steps from our custom format
   */
  parseResponse(rawEvents: any[]): TrajectoryStep[] {
    return rawEvents
      .filter(e => e.type === 'MOCK_STEP' && e.step)
      .map(e => e.step);
  }

  /**
   * Health check - mock is always "healthy"
   */
  async healthCheck(endpoint: string, auth: ConnectorAuth): Promise<boolean> {
    return true;
  }
}

/**
 * Default instance for convenience
 */
export const mockConnector = new MockConnector();
