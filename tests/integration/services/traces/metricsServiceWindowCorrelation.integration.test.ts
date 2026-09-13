/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression: the comparison page's Cost / Tokens / LLM Calls were BLANK for
 * an entire run whenever its reports carried no correlation id at all — no
 * `runId` (the agent's REST response echoed nothing agent-health recognized),
 * no `sessionId`, no `traceId` (eval telemetry off) — even though the run-report
 * Traces tab and the agent (trace) judge found those very spans instantly.
 *
 * Why: the Traces tab / judge query `/api/traces` with `agents: [{serviceName,
 * startedAt, endedAt}]` (Strategy C, service.name + run window) unioned with
 * A/B/D. `/api/metrics/batch` only ever accepted runIds / sessionIds / traceIds
 * — and the compare page skipped every report with no runId before it even
 * asked. Two readers of the same cluster, two vocabularies.
 *
 * This test exercises the REAL query-building + span-attribution path
 * (`computeMetrics` / `computeBatchMetrics`, the SDK-client branch that
 * `/api/metrics` uses) end-to-end against an in-memory fake OpenSearch whose
 * field resolution mirrors the OSI flat-@ `otel-v1-apm-span-*` template AND
 * the nested plain-raw shape, seeded with spans that carry NO run id, session
 * id or shared trace id — only `serviceName` + `startTime`. Metrics must be
 * found by the service-window hint alone, attributed to the right key, and
 * `fetchTraces` (the Traces tab) must return the SAME spans for the SAME hint
 * so the two surfaces cannot disagree.
 *
 * All fixtures are synthetic; generic agent names only.
 *
 * Run: npm test -- --testPathPatterns=metricsServiceWindowCorrelation.integration
 */

import { fetchTraces, buildAgentHintClause } from '@/server/services/tracesService';
import { computeMetrics, computeBatchMetrics } from '@/server/services/metricsService';

// ---------------------------------------------------------------------------
// Fixtures — two REST-agent runs (report keys, NOT run ids: the reports have
// none) under the same service name in adjacent windows, one of them stored in
// the OSI flat-@ shape and one in the nested shape; a decoy service in the same
// window; a same-service span outside every window.
// ---------------------------------------------------------------------------

const SERVICE = 'example-rest-agent';
const REPORT_FLAT = 'report-1788000000001-flat';
const REPORT_NESTED = 'report-1788000000002-nested';

const T = (s: string) => Date.parse(s);
// Run 1 (flat-@): agent ran 10:00:00 – 10:00:25; report persisted at 10:00:30 with durationMs 25s.
const RUN1_REPORT_TS = T('2026-03-01T10:00:30.000Z');
// Run 2 (nested): agent ran 10:03:00 – 10:03:40; report persisted at 10:03:45 with durationMs 40s.
const RUN2_REPORT_TS = T('2026-03-01T10:03:45.000Z');
const SLACK = 60_000;
const hintFor = (ts: number, durationMs: number) => ({
  serviceName: SERVICE,
  startedAt: ts - (durationMs + SLACK),
  endedAt: ts + (durationMs + SLACK),
});
const HINT_RUN1 = hintFor(RUN1_REPORT_TS, 25_000);
const HINT_RUN2 = hintFor(RUN2_REPORT_TS, 40_000);

function baseSpan(overrides: Record<string, any>): Record<string, any> {
  return {
    traceId: 'trace-' + Math.random().toString(36).slice(2, 10),
    spanId: 'span-' + Math.random().toString(36).slice(2, 8),
    parentSpanId: '',
    name: 'span',
    kind: 'SPAN_KIND_INTERNAL',
    serviceName: SERVICE,
    startTime: '2026-03-01T10:00:00.000000000Z',
    endTime: '2026-03-01T10:00:01.000000000Z',
    durationInNanos: 1_000_000_000,
    status: { code: 1, message: '' },
    ...overrides,
  };
}

/** Encode a dotted attribute map into OSI flat `span.attributes.<key with @>` fields. */
function flatAttrs(attrs: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(attrs)) out[`span.attributes.${k.replace(/\./g, '@')}`] = v;
  return out;
}

// NOTE: no agent_health.run.id / gen_ai.conversation.id / session.id anywhere,
// and every span has its own traceId — only service.name + time can correlate.
const INDEX: Record<string, any>[] = [
  // --- Run 1, OSI flat-@ shape
  baseSpan({
    spanId: 'r1-llm-1', name: 'chat', startTime: '2026-03-01T10:00:05.000000000Z',
    ...flatAttrs({ 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'anthropic.claude-sonnet-4', 'gen_ai.usage.input_tokens': '1000', 'gen_ai.usage.output_tokens': '100' }),
  }),
  baseSpan({
    spanId: 'r1-tool', name: 'execute_tool search', startTime: '2026-03-01T10:00:12.000000000Z',
    ...flatAttrs({ 'gen_ai.tool.name': 'search' }),
  }),
  baseSpan({
    spanId: 'r1-llm-2', name: 'chat', startTime: '2026-03-01T10:00:20.000000000Z',
    ...flatAttrs({ 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'anthropic.claude-sonnet-4', 'gen_ai.usage.input_tokens': '2000', 'gen_ai.usage.output_tokens': '200' }),
  }),
  // --- Run 2, nested plain-raw shape
  baseSpan({
    spanId: 'r2-llm-1', name: 'chat', startTime: '2026-03-01T10:03:05.000000000Z',
    attributes: { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'anthropic.claude-sonnet-4', 'gen_ai.usage.input_tokens': 500, 'gen_ai.usage.output_tokens': 50 },
  }),
  baseSpan({
    spanId: 'r2-tool-a', name: 'execute_tool lookup', startTime: '2026-03-01T10:03:15.000000000Z',
    attributes: { 'gen_ai.tool.name': 'lookup' },
  }),
  baseSpan({
    spanId: 'r2-tool-b', name: 'execute_tool search', startTime: '2026-03-01T10:03:25.000000000Z',
    attributes: { 'gen_ai.tool.name': 'search' },
  }),
  // --- Decoys
  baseSpan({ // another agent, same window as run 1
    spanId: 'decoy-other-service', name: 'chat', serviceName: 'unrelated-agent', startTime: '2026-03-01T10:00:10.000000000Z',
    attributes: { 'gen_ai.request.model': 'm', 'gen_ai.usage.input_tokens': 99_999, 'gen_ai.usage.output_tokens': 1 },
  }),
  baseSpan({ // same agent, an hour later — outside both windows
    spanId: 'decoy-out-of-window', name: 'chat', startTime: '2026-03-01T11:00:00.000000000Z',
    attributes: { 'gen_ai.request.model': 'm', 'gen_ai.usage.input_tokens': 99_999, 'gen_ai.usage.output_tokens': 1 },
  }),
];

// ---------------------------------------------------------------------------
// Fake OpenSearch — same field-resolution rules as
// osiFlatRunIdCorrelation.integration.test.ts (flat-@ keys are literal
// top-level fields; dotted `attributes.*` paths walk the nested object; a
// `.keyword` path on a keyword-mapped field is unmapped and matches nothing;
// `range` on startTime compares ISO timestamps).
// ---------------------------------------------------------------------------
function resolveField(doc: Record<string, any>, field: string): unknown {
  if (field in doc) return doc[field];
  if (field.endsWith('.keyword')) return undefined;
  if (field.startsWith('attributes.')) return doc.attributes?.[field.slice('attributes.'.length)];
  if (field.startsWith('resource.attributes.')) return doc.resource?.attributes?.[field.slice('resource.attributes.'.length)];
  return doc[field];
}

function matches(clause: any, doc: Record<string, any>): boolean {
  if (!clause || typeof clause !== 'object') return true;
  if (clause.term) {
    const [field, val] = Object.entries(clause.term)[0] as [string, unknown];
    return resolveField(doc, field) === val;
  }
  if (clause.terms) {
    const [field, vals] = Object.entries(clause.terms)[0] as [string, unknown[]];
    return (vals as unknown[]).includes(resolveField(doc, field) as never);
  }
  if (clause.range) {
    const [field, bounds] = Object.entries(clause.range)[0] as [string, any];
    const t = new Date(String(resolveField(doc, field))).getTime();
    if (bounds.gte !== undefined && t < new Date(bounds.gte).getTime()) return false;
    if (bounds.lte !== undefined && t > new Date(bounds.lte).getTime()) return false;
    return true;
  }
  if (clause.bool) {
    const { must = [], should = [], minimum_should_match } = clause.bool;
    const mustOk = (must as any[]).every((c) => matches(c, doc));
    const shouldOk =
      (should as any[]).length === 0 || (minimum_should_match ?? 0) === 0
        ? true
        : (should as any[]).some((c) => matches(c, doc));
    return mustOk && shouldOk;
  }
  return true;
}

/** Real-OpenSearch-like `_source` projection (exact names + `prefix.*`). */
function applySourceProjection(doc: Record<string, any>, sourceFields?: string[]): Record<string, any> {
  if (!sourceFields || sourceFields.length === 0) return doc;
  const exact = new Set(sourceFields.filter((f) => !f.endsWith('.*')));
  const prefixes = sourceFields.filter((f) => f.endsWith('.*')).map((f) => f.slice(0, -1));
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(doc)) {
    if (exact.has(key) || prefixes.some((p) => key.startsWith(p))) out[key] = value;
  }
  return out;
}

function createFakeClient() {
  const search = jest.fn(async ({ body }: any) => {
    const hits = INDEX.filter((d) => matches(body.query, d)).slice(0, body.size ?? 100);
    return {
      body: {
        hits: {
          hits: hits.map((doc) => ({ _source: applySourceProjection(doc, body._source) })),
          total: { value: hits.length },
        },
      },
    };
  });
  return { search } as any;
}

describe('Strategy C (service.name + run window) metrics correlation for reports with NO correlation id', () => {
  it('pre-fix reproduction: with no ids, the correlation union is empty and NOTHING matches', async () => {
    const client = createFakeClient();
    // A report key that no span names, and no hints => Strategy B on a key
    // nobody stamped => zero spans (this is exactly the blank scoreboard row).
    const m = await computeMetrics(REPORT_FLAT, { client });
    expect(m.hasSpans).toBe(false);
    expect(m.status).toBe('pending');
  });

  it('computeMetrics finds an OSI flat-@ run by service window alone and reads its tokens / model / tools', async () => {
    const client = createFakeClient();

    const m = await computeMetrics(REPORT_FLAT, { client }, undefined, undefined, [HINT_RUN1]);

    expect(m.hasSpans).toBe(true);
    expect(m.status).toBe('success');
    expect(m.inputTokens).toBe(3000);
    expect(m.outputTokens).toBe(300);
    expect(m.llmCalls).toBe(2);
    expect(m.toolCalls).toBe(1);
    expect(m.toolsUsed).toEqual(['search']);
    expect(m.costUsd).toBeGreaterThan(0);
  });

  it('computeBatchMetrics (the /api/metrics/batch path, with _source projection) attributes each run\'s spans to its own key across BOTH index schemas, without decoy bleed', async () => {
    const client = createFakeClient();

    const results = await computeBatchMetrics(
      [REPORT_FLAT, REPORT_NESTED],
      { client },
      undefined,
      undefined,
      { [REPORT_FLAT]: [HINT_RUN1], [REPORT_NESTED]: [HINT_RUN2] }
    );

    const byKey = new Map(results.map((r) => [r.runId, r]));
    expect(byKey.get(REPORT_FLAT)).toEqual(expect.objectContaining({
      hasSpans: true, status: 'success', inputTokens: 3000, outputTokens: 300, llmCalls: 2, toolCalls: 1,
    }));
    expect(byKey.get(REPORT_NESTED)).toEqual(expect.objectContaining({
      hasSpans: true, status: 'success', inputTokens: 500, outputTokens: 50, llmCalls: 1, toolCalls: 2,
    }));
    // Neither decoy's 99,999 tokens leaked into either run.
    expect(byKey.get(REPORT_FLAT)!.inputTokens + byKey.get(REPORT_NESTED)!.inputTokens).toBe(3500);
    // One request for the chunk, carrying one Strategy-C clause per key.
    expect(client.search).toHaveBeenCalledTimes(1);
    const should = client.search.mock.calls[0][0].body.query.bool.must[0].bool.should;
    expect(should).toEqual(expect.arrayContaining([buildAgentHintClause(HINT_RUN1), buildAgentHintClause(HINT_RUN2)]));
  });

  it('a key with a hint whose window contains no spans stays an honest pending placeholder (hasSpans:false), not a zero-cost success', async () => {
    const client = createFakeClient();
    const empty = { serviceName: SERVICE, startedAt: T('2026-03-01T12:00:00Z'), endedAt: T('2026-03-01T12:10:00Z') };

    const [m] = await computeBatchMetrics(['report-empty'], { client }, undefined, undefined, { 'report-empty': [empty] });

    expect(m.hasSpans).toBe(false);
    expect(m.status).toBe('pending');
  });

  it('parity: fetchTraces (Traces tab / judge) returns the SAME spans for the SAME hint that metrics counted', async () => {
    const client = createFakeClient();

    const traces = await fetchTraces({ agents: [HINT_RUN1] }, client);
    const metrics = await computeMetrics(REPORT_FLAT, { client }, undefined, undefined, [HINT_RUN1]);

    expect(traces.spans.map((s) => s.spanId).sort()).toEqual(['r1-llm-1', 'r1-llm-2', 'r1-tool']);
    // Every span the Traces tab shows is a span metrics counted: 2 LLM calls, 1 tool.
    expect(metrics.llmCalls).toBe(traces.spans.filter((s) => s.attributes['gen_ai.request.model']).length);
    expect(metrics.toolCalls).toBe(traces.spans.filter((s) => s.attributes['gen_ai.tool.name']).length);
  });

  it('the union is additive: a run that DOES have a run id is still found by Strategy B when a hint is also present', async () => {
    const client = createFakeClient();
    // Add a Strategy-B-stamped span for a third run to the index for this test only.
    const stamped = baseSpan({
      spanId: 'r3-llm', name: 'chat', serviceName: 'third-agent', startTime: '2026-03-01T20:00:00.000000000Z',
      ...flatAttrs({ 'gen_ai.conversation.id': 'run-third', 'gen_ai.request.model': 'm', 'gen_ai.usage.input_tokens': 42, 'gen_ai.usage.output_tokens': 0 }),
    });
    INDEX.push(stamped);
    try {
      const results = await computeBatchMetrics(
        ['run-third', REPORT_FLAT],
        { client },
        undefined,
        undefined,
        { [REPORT_FLAT]: [HINT_RUN1] }
      );
      const byKey = new Map(results.map((r) => [r.runId, r]));
      expect(byKey.get('run-third')!.inputTokens).toBe(42);
      expect(byKey.get(REPORT_FLAT)!.inputTokens).toBe(3000);
    } finally {
      INDEX.pop();
    }
  });
});
