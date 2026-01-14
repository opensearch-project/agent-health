/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Agent Service - Proxy SSE streaming requests to agents
 */

import { Response } from 'express';

// ============================================================================
// Types
// ============================================================================

export interface AgentProxyRequest {
  endpoint: string;
  payload: any;
  headers?: Record<string, string>;
}

export interface SSEHeaders {
  'Content-Type': string;
  'Cache-Control': string;
  'Connection': string;
  'X-Accel-Buffering': string;
}

// ============================================================================
// Agent Proxy Functions
// ============================================================================

/**
 * Set SSE (Server-Sent Events) headers on the response
 */
export function setSSEHeaders(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
}

/**
 * Send an AG UI RUN_ERROR event
 */
export function sendErrorEvent(res: Response, message: string): void {
  res.write(`data: ${JSON.stringify({
    type: 'RUN_ERROR',
    message,
    timestamp: Date.now()
  })}\n\n`);
  res.end();
}

/**
 * Stream mock agent response (AG-UI events) for demo mode
 */
async function streamMockAgentResponse(payload: any, res: Response): Promise<void> {
  const runId = `mock-run-${Date.now()}`;
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

  // Extract test case name from payload for personalized response
  const prompt = payload?.parameters?.question || payload?.question || 'the issue';

  // RUN_STARTED
  res.write(`data: ${JSON.stringify({ type: 'RUN_STARTED', threadId: runId, runId, timestamp: Date.now() })}\n\n`);
  await sleep(100);

  // TEXT_MESSAGE_START - Initial thinking
  const msgId1 = `msg-${Date.now()}-1`;
  res.write(`data: ${JSON.stringify({ type: 'TEXT_MESSAGE_START', messageId: msgId1, role: 'assistant', timestamp: Date.now() })}\n\n`);
  await sleep(50);

  // Stream thinking content
  const thinkingContent = `I need to investigate this issue. Let me start by checking the cluster health and then drill down into specific metrics.`;
  for (const char of thinkingContent) {
    res.write(`data: ${JSON.stringify({ type: 'TEXT_MESSAGE_CONTENT', messageId: msgId1, delta: char })}\n\n`);
    await sleep(20);
  }
  res.write(`data: ${JSON.stringify({ type: 'TEXT_MESSAGE_END', messageId: msgId1, timestamp: Date.now() })}\n\n`);
  await sleep(300);

  // TOOL_CALL_START - First tool
  const toolId1 = `tool-${Date.now()}-1`;
  res.write(`data: ${JSON.stringify({ type: 'TOOL_CALL_START', toolCallId: toolId1, toolCallName: 'opensearch_cluster_health', timestamp: Date.now() })}\n\n`);
  await sleep(100);

  // Tool args
  res.write(`data: ${JSON.stringify({ type: 'TOOL_CALL_ARGS', toolCallId: toolId1, delta: '{"local": true}' })}\n\n`);
  await sleep(50);
  res.write(`data: ${JSON.stringify({ type: 'TOOL_CALL_END', toolCallId: toolId1, timestamp: Date.now() })}\n\n`);
  await sleep(500);

  // TOOL_RESULT
  const toolResult1 = JSON.stringify({ status: 'yellow', number_of_nodes: 3, unassigned_shards: 0 });
  res.write(`data: ${JSON.stringify({ type: 'TOOL_RESULT', toolCallId: toolId1, result: toolResult1, timestamp: Date.now() })}\n\n`);
  await sleep(300);

  // TEXT_MESSAGE_START - Analysis
  const msgId2 = `msg-${Date.now()}-2`;
  res.write(`data: ${JSON.stringify({ type: 'TEXT_MESSAGE_START', messageId: msgId2, role: 'assistant', timestamp: Date.now() })}\n\n`);
  await sleep(50);

  const analysisContent = `The cluster is in yellow state. Let me check the node stats to identify which node might be causing issues.`;
  for (const char of analysisContent) {
    res.write(`data: ${JSON.stringify({ type: 'TEXT_MESSAGE_CONTENT', messageId: msgId2, delta: char })}\n\n`);
    await sleep(15);
  }
  res.write(`data: ${JSON.stringify({ type: 'TEXT_MESSAGE_END', messageId: msgId2, timestamp: Date.now() })}\n\n`);
  await sleep(300);

  // TOOL_CALL_START - Second tool
  const toolId2 = `tool-${Date.now()}-2`;
  res.write(`data: ${JSON.stringify({ type: 'TOOL_CALL_START', toolCallId: toolId2, toolCallName: 'opensearch_nodes_stats', timestamp: Date.now() })}\n\n`);
  await sleep(100);

  res.write(`data: ${JSON.stringify({ type: 'TOOL_CALL_ARGS', toolCallId: toolId2, delta: '{"metric": "jvm,os"}' })}\n\n`);
  await sleep(50);
  res.write(`data: ${JSON.stringify({ type: 'TOOL_CALL_END', toolCallId: toolId2, timestamp: Date.now() })}\n\n`);
  await sleep(600);

  // TOOL_RESULT
  const toolResult2 = 'Node-1: CPU 12%, JVM Heap 45%\nNode-2: CPU 15%, JVM Heap 52%\nNode-3: CPU 98%, JVM Heap 89% (Data Node)';
  res.write(`data: ${JSON.stringify({ type: 'TOOL_RESULT', toolCallId: toolId2, result: toolResult2, timestamp: Date.now() })}\n\n`);
  await sleep(400);

  // TEXT_MESSAGE_START - Conclusion
  const msgId3 = `msg-${Date.now()}-3`;
  res.write(`data: ${JSON.stringify({ type: 'TEXT_MESSAGE_START', messageId: msgId3, role: 'assistant', timestamp: Date.now() })}\n\n`);
  await sleep(50);

  const conclusionContent = `## Root Cause Analysis Complete

**Finding:** High CPU utilization detected on Node-3 (98% CPU, 89% JVM Heap)

**Root Cause:** Node-3 is experiencing resource exhaustion, likely due to:
1. Heavy indexing or search operations
2. Garbage collection pressure from high heap usage
3. Possible hot spot in shard distribution

**Recommendations:**
1. Check hot threads on Node-3 using \`_nodes/Node-3/hot_threads\`
2. Review shard distribution and consider rebalancing
3. Monitor GC logs for long pauses
4. Consider scaling horizontally if load persists`;

  for (const char of conclusionContent) {
    res.write(`data: ${JSON.stringify({ type: 'TEXT_MESSAGE_CONTENT', messageId: msgId3, delta: char })}\n\n`);
    await sleep(10);
  }
  res.write(`data: ${JSON.stringify({ type: 'TEXT_MESSAGE_END', messageId: msgId3, timestamp: Date.now() })}\n\n`);
  await sleep(100);

  // RUN_FINISHED
  res.write(`data: ${JSON.stringify({ type: 'RUN_FINISHED', threadId: runId, runId, timestamp: Date.now() })}\n\n`);
}

/**
 * Proxy agent request and stream SSE response back to client
 *
 * @param request - Agent proxy request configuration
 * @param res - Express Response object for streaming
 */
export async function proxyAgentRequest(
  request: AgentProxyRequest,
  res: Response
): Promise<void> {
  const { endpoint, payload, headers: customHeaders = {} } = request;

  console.log('\n========== AGENT PROXY REQUEST ==========');
  console.log('[AgentProxy] Timestamp:', new Date().toISOString());
  console.log('[AgentProxy] Target endpoint:', endpoint);
  console.log('[AgentProxy] Custom headers:', JSON.stringify(customHeaders));
  console.log('[AgentProxy] Payload preview:', JSON.stringify(payload).substring(0, 300) + '...');

  // Set SSE headers for streaming response
  setSSEHeaders(res);

  // Check if Demo Agent selected (mock:// endpoint)
  if (endpoint.startsWith('mock://')) {
    console.log('[AgentProxy] Demo Agent - returning mock response');
    await streamMockAgentResponse(payload, res);
    res.end();
    return;
  }

  console.log('[AgentProxy] Calling real endpoint:', endpoint);

  // Make request to agent endpoint
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      ...customHeaders,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('[AgentProxy] Agent returned error:', response.status, errorText);

    // Send a proper AG UI RUN_ERROR event so frontend can handle it
    sendErrorEvent(res, `Agent error: ${response.status} - ${errorText}`);
    return;
  }

  console.log('[AgentProxy] Connected to agent, streaming response...');
  console.log('[AgentProxy] Response headers:', Object.fromEntries(response.headers.entries()));

  // Stream the response back to client
  const reader = response.body?.getReader();
  if (!reader) {
    console.error('[AgentProxy] No response body reader available');
    sendErrorEvent(res, 'Agent response has no body stream');
    return;
  }

  const decoder = new TextDecoder();
  let totalBytes = 0;
  let chunkCount = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      totalBytes += value.length;
      chunkCount++;

      // Log first few chunks and then periodically
      if (chunkCount <= 3 || chunkCount % 10 === 0) {
        console.log(`[AgentProxy] Chunk #${chunkCount} (${value.length} bytes):`,
          chunk.substring(0, 200) + (chunk.length > 200 ? '...' : ''));
      }

      res.write(chunk);
    }
  } catch (streamError) {
    console.error('[AgentProxy] Stream error:', streamError);
  } finally {
    reader.releaseLock();
  }

  console.log(`[AgentProxy] Stream completed - ${chunkCount} chunks, ${totalBytes} bytes total`);
  res.end();
}

/**
 * Validate agent proxy request
 */
export function validateAgentRequest(request: Partial<AgentProxyRequest>): { valid: boolean; error?: string } {
  if (!request.endpoint) {
    return { valid: false, error: 'Missing required field: endpoint' };
  }

  if (!request.payload) {
    return { valid: false, error: 'Missing required field: payload' };
  }

  return { valid: true };
}
