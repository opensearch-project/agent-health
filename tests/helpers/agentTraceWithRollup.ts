/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A real-shaped agent trace whose `invoke_agent` span carries the ROLL-UP of
 * its `chat` children's usage — the shape GenAI-convention agent frameworks
 * emit (#653):
 *
 *   invoke_agent demo-agent      model, usage = Σ children  (6,000 in / 300 out)
 *   ├─ chat                       model, 1,000 / 50
 *   ├─ execute_tool search        tool span, no usage
 *   ├─ chat                       model, 2,000 / 100
 *   └─ chat                       model, 3,000 / 150
 *
 * Summing `gen_ai.usage.*` over every span reads 12,000 / 600 and 4 LLM
 * calls; the truth is 6,000 / 300 and 3 LLM calls. Usable as the OpenSearch
 * plain-raw span document (nested `attributes`, numeric `status.code`) and,
 * via {@link rollupSpansAsOtlp}, as the OTLP/JSON payload the embedded
 * receiver (`POST /v1/traces`) ingests.
 */

export interface RollupSpanDoc {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: string;
  serviceName: string;
  startTime: string;
  endTime: string;
  durationInNanos: number;
  status: { code: number };
  attributes: Record<string, unknown>;
}

export interface RollupFixtureOptions {
  /** Agent Health's run id — stamped as `agent_health.run.id` on every span. */
  runId: string;
  /** 32-hex OTel trace id shared by every span. */
  traceId: string;
  serviceName?: string;
  /** Wall-clock start of the trace (ms since epoch). */
  startedAt?: number;
  model?: string;
}

export const ROLLUP_FIXTURE = {
  spanCount: 5,
  /** The honest numbers (leaf usage counted once). */
  inputTokens: 6000,
  outputTokens: 300,
  totalTokens: 6300,
  llmCalls: 3,
  toolCalls: 1,
  /** What a naive sum over every usage-carrying span reads. */
  doubleCountedTotalTokens: 12600,
  doubleCountedLlmCalls: 4,
} as const;

const CHILD_USAGE: Array<{ input: number; output: number }> = [
  { input: 1000, output: 50 },
  { input: 2000, output: 100 },
  { input: 3000, output: 150 },
];

const hex = (n: number, width: number) => n.toString(16).padStart(width, '0');

export function buildAgentTraceWithRollup(options: RollupFixtureOptions): RollupSpanDoc[] {
  const serviceName = options.serviceName ?? 'demo-agent';
  const model = options.model ?? 'anthropic.claude-sonnet-4-20250514-v1:0';
  const t0 = options.startedAt ?? Date.parse('2026-01-01T00:00:00.000Z');
  const iso = (ms: number) => new Date(ms).toISOString();
  const common = { 'agent_health.run.id': options.runId, 'service.name': serviceName };
  const span = (
    idx: number,
    name: string,
    parentSpanId: string | undefined,
    startMs: number,
    endMs: number,
    attributes: Record<string, unknown>,
    kind = 'SPAN_KIND_INTERNAL',
  ): RollupSpanDoc => ({
    traceId: options.traceId,
    spanId: hex(idx + 1, 16),
    parentSpanId,
    name,
    kind,
    serviceName,
    startTime: iso(startMs),
    endTime: iso(endMs),
    durationInNanos: (endMs - startMs) * 1_000_000,
    status: { code: 1 },
    attributes: { ...common, ...attributes },
  });

  const totalIn = CHILD_USAGE.reduce((a, u) => a + u.input, 0);
  const totalOut = CHILD_USAGE.reduce((a, u) => a + u.output, 0);
  const agent = span(0, `invoke_agent ${serviceName}`, undefined, t0, t0 + 10_000, {
    'gen_ai.operation.name': 'invoke_agent',
    'gen_ai.request.model': model,
    'gen_ai.usage.input_tokens': totalIn,
    'gen_ai.usage.output_tokens': totalOut,
  }, 'SPAN_KIND_SERVER');
  const chat = (i: number, startMs: number) => span(i, 'chat', agent.spanId, startMs, startMs + 2_000, {
    'gen_ai.operation.name': 'chat',
    'gen_ai.request.model': model,
    'gen_ai.usage.input_tokens': CHILD_USAGE[i - 1].input,
    'gen_ai.usage.output_tokens': CHILD_USAGE[i - 1].output,
  }, 'SPAN_KIND_CLIENT');
  const tool = span(4, 'execute_tool search', agent.spanId, t0 + 3_000, t0 + 4_000, {
    'gen_ai.operation.name': 'execute_tool',
    'gen_ai.tool.name': 'search',
  });
  return [agent, chat(1, t0 + 1_000), tool, chat(2, t0 + 4_500), chat(3, t0 + 7_000)];
}

/** The same spans as an OTLP/JSON `ExportTraceServiceRequest` body (for `POST /v1/traces`). */
export function rollupSpansAsOtlp(spans: RollupSpanDoc[]): Record<string, unknown> {
  const anyValue = (v: unknown) =>
    typeof v === 'number' ? (Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v }) : { stringValue: String(v) };
  const kindEnum: Record<string, number> = { SPAN_KIND_INTERNAL: 1, SPAN_KIND_SERVER: 2, SPAN_KIND_CLIENT: 3 };
  const nanos = (isoTs: string) => String(BigInt(Date.parse(isoTs)) * 1_000_000n);
  const serviceName = spans[0]?.serviceName ?? 'demo-agent';
  return {
    resourceSpans: [{
      resource: { attributes: [{ key: 'service.name', value: { stringValue: serviceName } }] },
      scopeSpans: [{
        scope: { name: 'demo-agent-sdk' },
        spans: spans.map((s) => ({
          traceId: s.traceId,
          spanId: s.spanId,
          ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
          name: s.name,
          kind: kindEnum[s.kind] ?? 1,
          startTimeUnixNano: nanos(s.startTime),
          endTimeUnixNano: nanos(s.endTime),
          status: { code: s.status.code },
          attributes: Object.entries(s.attributes)
            .filter(([k]) => k !== 'service.name')
            .map(([key, value]) => ({ key, value: anyValue(value) })),
        })),
      }],
    }],
  };
}
