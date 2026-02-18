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
  let { endpoint, payload, headers: customHeaders = {} } = request;

  console.log('\n========== AGENT PROXY REQUEST ==========');
  console.log('[AgentProxy] Timestamp:', new Date().toISOString());
  console.log('[AgentProxy] Target endpoint:', endpoint);
  console.log('[AgentProxy] Custom headers:', JSON.stringify(customHeaders));
  console.log('[AgentProxy] Payload preview:', JSON.stringify(payload).substring(0, 300) + '...');

  // payload = {
  //  "parameters": {
  //     "context": "\n# Investigation Context\n\nYou are an AI assistant helping with root cause analysis based on log data. I'm investigating an issue in a system and need your analytical expertise.\n\n## Context Information\n\n**Relevant Index name**: train-ticket-traces-2\n\n**Time Field**: startTimeMillis\n\n**Time Period the issue happens**: From 2024-01-23T08:32:45.000Z to 2024-01-24T05:59:33.000Z\n \n\n\n**Variables**: {\n  \"pplQuery\": \"source = `train-ticket-traces-2` | stats max(duration) as duration by span(startTimeMillis , 1m)\",\n  \"pplFilters\": []\n}\n\n**PPL Query user executed**: source = `train-ticket-traces-2` | stats max(duration) as duration by span(startTimeMillis , 1m)\n\n \n## Data Distribution Analysis\n\n### Methodology\nAnalyzes field value distributions in the selected time period:\n- Examines categorical fields (keyword, boolean, text) and numeric fields (grouped into ranges)\n- Calculates percentage distribution for each field value\n- Shows fields with highest cardinality and most significant values\n\n### Field Data\n[1] Field: duration\n Top Values:\n - \"624652.0-1120379.0\": 48.0%\n - \"1616106.0-2111833.0\": 28.0%\n - \"2111833.0-2607560.0\": 12.0%\n - \"1120379.0-1616106.0\": 8.0%\n - \"2607560.0-3103287.0\": 4.0%\n\n### Analysis Guidelines\n**PRIMARY EVIDENCE**: Use field distributions to understand data characteristics.\n\n**Investigation Strategy**:\n1. Look for error-related fields (status_code, error_code, level, severity) with high error percentages\n2. Examine fields with concentrated distributions (>80% in single value) - may indicate systemic issues\n3. Check topChanges to identify dominant field values that correlate with problems\n4. Cross-reference field values with log patterns to identify root causes\n\n**Query Construction**:\n- Use field names and top values to build targeted queries\n- Filter by high-percentage values to focus on dominant behaviors\n- Combine multiple fields to narrow down root cause\n \n\n## Step description\nThis step executes PPL query and get response data for further research. Analyze these results as part of your investigation and consider how they relate to the overall issue. \n\n## Step result:\nUser has executed the following PPL query: 'source = `train-ticket-traces-2` | stats max(duration) as duration by span(startTimeMillis , 1m)' which returned the following results:\n\n**Important**: Due to input context length limits, only 100 records are shown below. If the actual query result contains more than 100 records, a random sampling of 100 records has been applied. The actual result set may be significantly larger than what is displayed here.\n\n```tsv\nduration\tspan(startTimeMillis,1m)\n624652\t2024-01-23 15:14:00\n870604\t2024-01-23 15:15:00\n846707\t2024-01-23 15:16:00\n737853\t2024-01-23 15:17:00\n903787\t2024-01-23 15:18:00\n902666\t2024-01-23 15:19:00\n1240608\t2024-01-23 15:20:00\n687190\t2024-01-23 15:21:00\n723824\t2024-01-23 15:22:00\n1068511\t2024-01-23 15:23:00\n677467\t2024-01-23 15:24:00\n669984\t2024-01-23 15:25:00\n982893\t2024-01-23 15:26:00\n1800885\t2024-01-23 15:27:00\n1700810\t2024-01-23 15:28:00\n2004696\t2024-01-23 15:29:00\n1303065\t2024-01-23 15:30:00\n1846996\t2024-01-23 15:31:00\n1703740\t2024-01-23 15:32:00\n3103287\t2024-01-23 15:33:00\n2204772\t2024-01-23 15:34:00\n1800601\t2024-01-23 15:35:00\n2201108\t2024-01-23 15:36:00\n2411848\t2024-01-23 15:37:00\n1648439\t2024-01-23 15:38:00\n```\n ",
  //     "question": "Why the train ticket website is abnormal starting from 2024-01-23T15:26:51.000Z, check the related index: train-ticket-metrics-2, train-ticket-logs-2, train-ticket-traces-2 to find the root cause service. Just give the root cause service and reason, do not add extra description. You need to give 3 possible root cause service. You need to check the traces index firstly to identiy which service cause the duration spikes at that time if possible, the duration field's unit in the trace index is microseconds, you need to find a trace with high duration around that time firstly, , then identify which service cause the high duration, and then check the logs or metrics index to help identify the result.When checking logs or metrics, you need to limit the time range to a small time range around the abnormal time, and limit the service name by filtering the root cause service, and only check the metrics related to the root cause service.",
  //     "system_prompt": "# Investigation Planner Agent\n\nYou are a thoughtful and analytical planner agent in a plan-execute-reflect framework. Your job is to design a clear, step-by-step plan for a given objective.\n\n \n## Time Scope\n\n**CRITICAL: Use this exact time range for your investigation:**\n- Start time: 2024-01-23T08:32:45.000Z\n- End time: 2024-01-24T05:59:33.000Z\n\nUse these ISO 8601 UTC timestamps (format: YYYY-MM-DDTHH:mm:ss.sssZ) for all time-based queries and analysis.\n\n\n\n# Instructions\n\n## Core Planning Rules\n- Break the objective into an ordered list of atomic, self-contained Steps that, if executed, will lead to the final result or complete the objective\n- Each Step must state what to do, where, and which tool/parameters would be used. You do not execute tools, only reference them for planning\n- Use only the provided tools; do not invent or assume tools. If no suitable tool applies, use reasoning or observations instead\n- Base your plan only on the data and information explicitly provided; do not rely on unstated knowledge or external facts\n- If there is insufficient information to create a complete plan, summarize what is known so far and clearly state what additional information is required to proceed\n- Stop and summarize if the task is complete or further progress is unlikely\n- Avoid vague instructions; be specific about data sources, indexes, or parameters\n- Never make assumptions or rely on implicit knowledge\n- Respond only in JSON format\n\n- When using ListIndexTool, use include_details false when the input is an index pattern or wildcard.\n\n## Step Examples\n**Good example:** \"Use Tool to sample documents from index: 'my-index'\"\n\n**Bad example:** \"Use Tool to sample documents from each index\"\n\n**Bad example:** \"Use Tool to sample documents from all indices\"\n\n\n# Response Format\n\n## JSON Response Requirements\nOnly respond in JSON format. Always follow the given response instructions. Do not return any content that does not follow the response instructions. Do not add anything before or after the expected JSON\n\nAlways respond with a valid JSON object that strictly follows the below schema:\n```json\n{\n \"steps\": array[string],\n \"result\": string\n}\n```\n\n- Use \"steps\" to return an array of strings where each string is a step to complete the objective, leave it empty if you know the final result. Please wrap each step in quotes and escape any special characters within the string\n- Use \"result\" to return the final response when you have enough information, leave it empty if you want to execute more steps. When providing the final result, it MUST be a stringified JSON object with the following structure:\n\n## Final Result Structure\nFinal result must be a stringified JSON object:\n```json\n{\n \"findings\": array[object],\n \"hypotheses\": array[object],\n \"topologies\": array[object],\n \"investigationName\": \"string object which will be the auto generated name for the whole investigation, max 50 characters\"\n}\n```\n\nYour final result JSON must include:\n- **\"findings\"**: An array of finding objects, each containing:\n * **\"id\"**: A unique identifier for the finding (e.g., \"F1\", \"F2\")\n * **\"description\"**: Clear statement of the finding\n * **\"importance\"**: Rating from 0-100 indicating overall significance\n * **\"evidence\"**: Specific data, quotes, or observations supporting this finding\n- **\"hypotheses\"**: An array of hypothesis objects, each containing:\n * **\"id\"**: A unique identifier for the hypothesis (e.g., \"H1\")\n * **\"title\"**: A concise title for the hypothesis\n * **\"description\"**: Clear statement of the hypothesis\n * **\"likelihood\"**: Rating from 0-100 indicating probability of being correct\n * **\"supporting_findings\"**: Array of finding IDs that support or relate to this hypothesis\n- **\"topologies\"**: An array of topology objects, each containing:\n * **\"id\"**: A unique identifier for the topology (e.g., \"T1\", \"T2\")\n * **\"description\"**: A brief title or summary for the topology graph\n * **\"traceId\"**: The trace ID associated with this topology\n * **\"hypothesisIds\"**: Array of hypothesis IDs that this topology supports\n * **\"nodes\"**: Array of node objects representing services/operations\n\n### Finding Structure\n```json\n{\n \"id\": string,\n \"description\": string,\n \"importance\": number (0-100),\n \"evidence\": string\n}\n```\n\n### Hypothesis Structure\n```json\n{\n \"id\": string,\n \"title\": string,\n \"description\": string,\n \"likelihood\": number (0-100),\n \"supporting_findings\": array[string]\n}\n```\n\n### Topology Structure\n```json\n{\n \"id\": string,\n \"description\": string,\n \"traceId\": string,\n \"hypothesisIds\": array[string],\n \"nodes\": array[{\n \"id\": string,\n \"name\": string,\n \"startTime\": string,\n \"duration\": string,\n \"status\": string,\n \"parentId\": string | null\n }]\n}\n```\n\n### Likelihood Guidelines\n- **Strong likelihood (70-100)**: High confidence, substantial supporting evidence\n- **Moderate likelihood (40-70)**: Medium confidence, some supporting evidence\n- **Weak likelihood (0-40)**: Low confidence, limited supporting evidence\n\n## Examples\n**Planning response:**\n```json\n{\n \"steps\": [\"This is an example step\", \"this is another example step\"],\n \"result\": \"\"\n}\n```\n\n**Final response:**\n```json\n{\n \"steps\": [],\n \"result\": \"{\"investigationName\": \"Invalid payment token Investigation\",\"findings\":[{\"id\":\"F1\",\"description\":\"High error rate detected\",\"importance\":90,\"evidence\":\"500+ errors in last hour\"}],\"hypotheses\":[{\"id\":\"H1\",\"title\":\"Database Connection Issue\",\"description\":\"Application errors caused by database connectivity problems\",\"likelihood\":85,\"supporting_findings\":[\"F1\"]}],\"topology\":[]}\"\n}\n```\n\n## Critical Rules\n1. Do not use commas within individual steps\n2. **CRITICAL: For tool parameters use commas without spaces (e.g., \"param1,param2,param3\") - This rule must be followed exactly**\n3. For individual steps that call a specific tool, include all required parameters\n4. Do not add any content before or after the JSON\n5. Only respond with a pure JSON object\n6. **CRITICAL: The \"result\" field in your final response MUST contain a properly escaped JSON string**\n7. **CRITICAL: The hypothesis must reference specific findings by their IDs in the supporting_findings array**\n8. **Topology Generation Rule:** When trace data with traceId is available, create a single topology object in the \"topologies\" array with structured node data. Generate only one topology with the most critical service call hierarchy in JSON format.\n\n### Topology Node Requirements:\n- Each node represents a service or operation in the trace\n- Use parentId to establish hierarchy (null for root nodes)\n- Include precise startTime (ISO format) and duration\n- Provide descriptive status (e.g., \"success\", \"failed\", \"error\", \"latency\", \"timeout\", etc.)\n- Keep focused on critical path (limit to 10 nodes max)",
  //     "planner_prompt_template": "\n## AVAILABLE TOOLS\n${parameters.tools_prompt}\n\n## PLANNING GUIDANCE\n${parameters.planner_prompt}\n\n## OBJECTIVE\nYour job is to fulfill user's requirements and answer their questions effectively. User Input:\n```${parameters.user_prompt}```\n\n## PREVIOUS CONTEXT\nThe following are steps executed previously to help you investigate, you can take these as background knowledge and utilize these information for further research\n[${parameters.context}]\n\nRemember: Respond only in JSON format following the required schema.",
  //     "planner_with_history_template": "\n## AVAILABLE TOOLS\n${parameters.tools_prompt}\n\n## PLANNING GUIDANCE\n${parameters.planner_prompt}\n\n## OBJECTIVE\nThe following is the user's input. Your job is to fulfill the user's requirements and answer their questions effectively. User Input:\n```${parameters.user_prompt}```\n\n## PREVIOUS CONTEXT\nThe following are steps executed previously to help you investigate, you can take these as background knowledge and utilize these information for further research\n[${parameters.context}]\n\n## CURRENT PROGRESS\nYou have already completed the following steps in the current plan. Consider these when determining next actions:\n[${parameters.completed_steps}]\n\nRemember: Respond only in JSON format following the required schema.",
  //     "reflect_prompt_template": "\n## AVAILABLE TOOLS\n${parameters.tools_prompt}\n\n## PLANNING GUIDANCE\n```${parameters.planner_prompt}```\n\n## OBJECTIVE\nThe following is the user's input. Your job is to fulfill the user's requirements and answer their questions effectively. User Input:\n${parameters.user_prompt}\n\n## ORIGINAL PLAN\nThis was the initially created plan to address the objective:\n[${parameters.steps}]\n\n## PREVIOUS CONTEXT\nThe following are steps executed previously to help you investigate, you can take these as background knowledge and utilize these information for further research without doing the same thing again:\n[${parameters.context}]\n\n## CURRENT PROGRESS\nYou have already completed the following steps from the original plan. Consider these when determining next actions:\n[${parameters.completed_steps}]\n\n## REFLECTION GUIDELINE\n${parameters.reflect_prompt}\n\nRemember: Respond only in JSON format following the required schema."
  //   }
  // };

  // Check if Demo Agent selected
  if (endpoint.startsWith('mock://')) {
    setSSEHeaders(res);
    await streamMockAgentResponse(payload, res);
    res.end();
    return;
  }

  // Detect streaming vs non-streaming
  const isStreaming = endpoint.endsWith('/stream');
  console.log('[AgentProxy] Mode:', isStreaming ? 'STREAMING' : 'NON-STREAMING');

  // Make request to agent endpoint
  const timeoutMs = parseInt(process.env.UNDICI_HEADERS_TIMEOUT || '300000', 10);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(isStreaming && { 'Accept': 'text/event-stream' }),
      ...customHeaders,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('[AgentProxy] Agent error:', response.status, errorText);
    
    if (isStreaming) {
      setSSEHeaders(res);
      sendErrorEvent(res, `Agent error: ${response.status} - ${errorText}`);
    } else {
      res.status(response.status).json({ error: errorText });
    }
    return;
  }

  // Non-streaming: return JSON directly
  if (!isStreaming) {
    const jsonResponse = await response.json();
    console.log('[AgentProxy] Response:', JSON.stringify(jsonResponse));
    res.json(jsonResponse);
    return;
  }

  // Streaming
  setSSEHeaders(res);
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
