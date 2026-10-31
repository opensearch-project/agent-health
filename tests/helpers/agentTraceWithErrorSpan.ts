/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A real-shaped agent trace, as the OpenSearch plain-raw span schema stores it,
 * for the "one failing tool call must not read as a trace-store failure" tests.
 *
 * Shape (mirrors a REST agent whose traces land in a second observability
 * source, correlated by Strategy A — the agent's spans hang under Agent
 * Health's own `test_case` eval span):
 *   - 1  `test_case` eval span (Agent Health's own; excluded from the agent's counts)
 *   - 1  agent top-level `invoke_agent` span, status OK
 *   - 15 `chat` LLM spans with a model + token usage (→ llmCalls = 15)
 *   - 3  tool spans; ONE of them (`execute_tool search_docs`, 2nd of 3) has
 *        OTel status ERROR (code 2) with a message, each tool span wrapping one
 *        HTTP child span (the errored tool's child is a 4xx, also ERROR)
 *   - 36 HTTP/retrieval child spans under the chat spans to make a 50+ span trace
 * Total: 1 + 1 + 15 + 3 + 3 + 36 = 59 spans (one eval span + 58 agent spans),
 * 2 of them ERROR (the failing tool span and its HTTP child).
 *
 * Deterministic: span ids / timings derive from the run id, so two calls with
 * the same `runId` produce the same documents.
 */

export interface AgentTraceSpanDoc {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: string;
  serviceName: string;
  startTime: string;
  endTime: string;
  durationInNanos: number;
  status: { code: number; message?: string };
  attributes: Record<string, unknown>;
}

export interface AgentTraceFixtureOptions {
  /** Agent Health's run id — stamped as `agent_health.run.id` on every span. */
  runId: string;
  /** 32-hex OTel trace id shared by every span (Strategy A). */
  traceId: string;
  /** OTel `service.name` of the agent (Strategy C). */
  serviceName?: string;
  /** Wall-clock start of the trace (ms since epoch). */
  startedAt?: number;
  /** Input/output tokens per LLM call. 15 calls × (20_000 + 400) = 306_000 tokens by default. */
  tokensPerCall?: { input: number; output: number };
  /** Set false to produce the same trace with NO errored span (control). */
  withErrorSpan?: boolean;
}

export const AGENT_TRACE_FIXTURE = {
  spanCount: 59,
  agentSpanCount: 58,
  llmCalls: 15,
  toolCalls: 3,
  toolsUsed: ['describe_catalog', 'search_docs', 'record_answer'],
  errorSpans: 2,
  model: 'example-model-v1',
} as const;

function hex(seed: string, len: number): string {
  // djb2 over the whole seed, then expanded until long enough — deterministic, hex-only.
  let h = 5381;
  for (let i = 0; i < seed.length; i++) h = ((h << 5) + h + seed.charCodeAt(i)) >>> 0;
  let out = '';
  while (out.length < len) {
    h = ((h << 5) + h + 0x9e) >>> 0;
    out += h.toString(16).padStart(8, '0');
  }
  return out.slice(0, len);
}

export function buildAgentTraceWithErrorSpan(opts: AgentTraceFixtureOptions): AgentTraceSpanDoc[] {
  const {
    runId, traceId, serviceName = 'example-rest-agent', startedAt = Date.parse('2026-03-01T10:00:00Z'),
    tokensPerCall = { input: 20_000, output: 400 }, withErrorSpan = true,
  } = opts;
  const sid = (label: string) => hex(`${runId}:${label}`, 16);
  const common = { 'agent_health.run.id': runId, 'gen_ai.conversation.id': runId };
  const docs: AgentTraceSpanDoc[] = [];
  const push = (d: Omit<AgentTraceSpanDoc, 'traceId' | 'kind' | 'serviceName' | 'durationInNanos' | 'endTime'> & { startMs: number; durationMs: number; kind?: string; serviceName?: string }) => {
    const { startMs, durationMs, ...rest } = d;
    docs.push({
      traceId, kind: d.kind ?? 'SPAN_KIND_INTERNAL', serviceName: d.serviceName ?? serviceName,
      startTime: new Date(startMs).toISOString(), endTime: new Date(startMs + durationMs).toISOString(),
      durationInNanos: durationMs * 1e6, ...rest,
    });
  };

  const evalId = sid('eval');
  push({ spanId: evalId, name: 'test_case', serviceName: 'agent-health', startMs: startedAt, durationMs: 62_000,
    status: { code: 1 }, attributes: { ...common, 'gen_ai.operation.name': 'evaluation' } });

  const rootId = sid('root');
  push({ spanId: rootId, parentSpanId: evalId, name: 'invoke_agent example-rest-agent', startMs: startedAt + 100, durationMs: 60_000,
    status: { code: 1 }, attributes: { ...common, 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': serviceName } });

  // 15 chat spans, each with ~2 retrieval/HTTP children (36 total: 2 or 3 per chat).
  let t = startedAt + 200;
  let childBudget = 36;
  for (let i = 0; i < 15; i++) {
    const chatId = sid(`chat-${i}`);
    push({ spanId: chatId, parentSpanId: rootId, name: 'chat example-model-v1', kind: 'SPAN_KIND_CLIENT', startMs: t, durationMs: 3_000,
      status: { code: 1 }, attributes: { ...common, 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': AGENT_TRACE_FIXTURE.model,
        'gen_ai.usage.input_tokens': tokensPerCall.input, 'gen_ai.usage.output_tokens': tokensPerCall.output } });
    const children = Math.min(childBudget, i < 6 ? 3 : 2);
    for (let j = 0; j < children; j++) {
      push({ spanId: sid(`chat-${i}-http-${j}`), parentSpanId: chatId, name: 'POST /v1/messages', kind: 'SPAN_KIND_CLIENT', startMs: t + 100 + j * 800, durationMs: 700,
        status: { code: 1 }, attributes: { ...common, 'http.request.method': 'POST', 'http.response.status_code': 200 } });
    }
    childBudget -= children;
    t += 3_200;
  }

  // 3 tool spans — the 2nd one fails (and so does its HTTP child).
  AGENT_TRACE_FIXTURE.toolsUsed.forEach((tool, i) => {
    const failing = withErrorSpan && i === 1;
    const toolId = sid(`tool-${i}`);
    push({ spanId: toolId, parentSpanId: rootId, name: `execute_tool ${tool}`, startMs: t, durationMs: 1_500,
      status: failing ? { code: 2, message: 'index_not_found_exception: no such index [docs-2026]' } : { code: 1 },
      attributes: { ...common, 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': tool, ...(failing ? { 'error.type': 'index_not_found_exception' } : {}) } });
    push({ spanId: sid(`tool-${i}-http`), parentSpanId: toolId, name: 'POST /{index}/_search', kind: 'SPAN_KIND_CLIENT', startMs: t + 50, durationMs: 1_300,
      status: failing ? { code: 2, message: '404 Not Found' } : { code: 1 },
      attributes: { ...common, 'http.request.method': 'POST', 'http.response.status_code': failing ? 404 : 200 } });
    t += 1_600;
  });

  return docs;
}

/**
 * The same span as CloudWatch's `aws/spans` log group stores it (what
 * `cloudWatchSpanToSource` parses): nanosecond timestamps, the OTel status
 * code as its enum NAME, the service name under `resource.attributes`.
 */
export function toCloudWatchSpanRecord(doc: AgentTraceSpanDoc): Record<string, unknown> {
  const startNs = BigInt(Date.parse(doc.startTime)) * 1_000_000n;
  const endNs = BigInt(Date.parse(doc.endTime)) * 1_000_000n;
  return {
    resource: { attributes: { 'service.name': doc.serviceName, 'cloud.provider': 'aws' } },
    scope: { name: 'example_agent', version: '' },
    traceId: doc.traceId,
    spanId: doc.spanId,
    ...(doc.parentSpanId ? { parentSpanId: doc.parentSpanId } : {}),
    name: doc.name,
    kind: doc.kind.replace(/^SPAN_KIND_/, ''),
    startTimeUnixNano: startNs.toString(),
    endTimeUnixNano: endNs.toString(),
    durationNano: (endNs - startNs).toString(),
    attributes: doc.attributes,
    status: { code: doc.status.code === 2 ? 'ERROR' : doc.status.code === 1 ? 'OK' : 'UNSET', ...(doc.status.message ? { message: doc.status.message } : {}) },
  };
}
