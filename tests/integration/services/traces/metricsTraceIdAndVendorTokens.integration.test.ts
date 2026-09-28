/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test for the comparison-page "Cost / Tokens / LLM Calls"
 * columns bug (read-only bug hunt against a real live server + real shared
 * OpenSearch observability cluster, generic wording per the internal-name
 * rule): THREE independent gaps in `server/services/metricsService.ts` left
 * these columns empty even when `/api/traces` found the exact same spans
 * instantly.
 *
 * Gap 1 (correlation) — REST-connector agents never get a native runId
 * (`RESTConnector.execute()` returns none), so `report.runId` falls back to
 * `report.traceId` upstream. `computeMetrics`/`computeBatchMetrics` only ever
 * queried Strategy B (`attributes.agent_health.run.id` /
 * `attributes.gen_ai.conversation.id`) — never a direct Strategy A traceId
 * match — so these runs 0-correlated even though their spans exist and share
 * that exact traceId (confirmed live: `/api/traces {traceId}` found 5 spans
 * for a report whose `/api/metrics/:runId` returned zero matching spans).
 *
 * Gap 2 (span-attribute schema) — the live `otel-v1-apm-span-*` index this
 * bug was hunted against stores attributes in the LEGACY @-raw flattened
 * shape (`span.attributes.gen_ai@request@model`, dots encoded as `@`), NOT
 * the nested `attributes` object this file read directly
 * (`span.attributes || {}`). `services/traces/tracesService.ts`'s
 * `transformSpan()` already normalizes both shapes for the Traces tab; this
 * file was the one remaining reader that never called it, so every
 * `attrs['...']` lookup silently returned `undefined` even on correctly
 * correlated spans (confirmed live: `/api/metrics/:runId?traceId=` found
 * spans, `toolCalls` counted correctly from `span.name`, but `llmCalls` /
 * `totalTokens` stayed `0`).
 *
 * Gap 3 (vendor token-key naming) — once Gap 2 is fixed, a real Claude Code
 * `claude_code.llm_request` span stamps `gen_ai.request.model` correctly but
 * reports usage under bare `input_tokens` / `output_tokens`, NOT the OTel Gen
 * AI registry names `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens`
 * this file read exclusively.
 *
 * Bonus (batch-only): the `_source` field projection used by the BATCH query
 * (`METRICS_SOURCE_FIELDS`) omitted the `span.attributes.*` /
 * `resource.attributes.*` wildcard patterns, so even after Gaps 1-3 were
 * fixed, `computeBatchMetrics` (what the comparison page actually calls)
 * still returned all-zero tokens while `computeMetrics` (no `_source`
 * restriction) returned the real numbers for the SAME run — caught only by
 * testing the real HTTP `/api/metrics/batch` route against the live cluster.
 *
 * This test exercises the REAL query-building + REAL span-parsing code paths
 * end-to-end; only the OpenSearch client's `.search()` is faked — an in-memory
 * index that ALSO applies `_source` field projection like real OpenSearch
 * (so a regression to `METRICS_SOURCE_FIELDS` makes this test fail, not just
 * a string-match on the query body). Same style as
 * plainRawCorrelation.integration.test.ts.
 *
 * Run: npm test -- --testPathPatterns=metricsTraceIdAndVendorTokens.integration
 */

import { computeMetrics, computeBatchMetrics } from '@/server/services/metricsService';

/** A span in the LEGACY @-raw flattened shape this cluster actually uses. */
function atRawSpan(overrides: Record<string, any>): Record<string, any> {
  return {
    traceId: 'trace-default',
    spanId: 'span-' + Math.random().toString(36).slice(2, 8),
    name: 'span',
    startTime: '2026-09-02T07:45:00.000000000Z',
    endTime: '2026-09-02T07:45:01.000000000Z',
    durationInNanos: 1_000_000_000,
    status: { code: 1, message: '' },
    ...overrides,
  };
}

/** Encode a dotted attribute map into `span.attributes.<key with @ for .>` fields. */
function atAttrs(attrs: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(attrs)) {
    out[`span.attributes.${k.replace(/\./g, '@')}`] = v;
  }
  return out;
}

// --- Claude Code fixture (Gaps 2+3): real span shape captured read-only from
// a live trace-mode run. Note: NO agent_health.run.id / gen_ai.conversation.id
// attribute anywhere — only findable via the shared traceId (Gap 1's fix).
const CLAUDE_CODE_TRACE_ID = 'trace-claude-code-1';
const CLAUDE_CODE_SPANS: Record<string, any>[] = [
  atRawSpan({
    spanId: 'cc-llm-1',
    traceId: CLAUDE_CODE_TRACE_ID,
    name: 'claude_code.llm_request',
    durationInNanos: 7_238_000_000,
    ...atAttrs({
      'gen_ai.system': 'anthropic',
      'gen_ai.request.model': 'global.anthropic.claude-sonnet-4-6',
      'span.type': 'llm_request',
      input_tokens: 34947,
      output_tokens: 313,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    }),
  }),
  atRawSpan({
    spanId: 'cc-llm-2',
    traceId: CLAUDE_CODE_TRACE_ID,
    name: 'claude_code.llm_request',
    ...atAttrs({
      'gen_ai.system': 'anthropic',
      'gen_ai.request.model': 'global.anthropic.claude-sonnet-4-6',
      'span.type': 'llm_request',
      input_tokens: 1200,
      output_tokens: 87,
    }),
  }),
  atRawSpan({
    spanId: 'cc-tool-1',
    traceId: CLAUDE_CODE_TRACE_ID,
    name: 'claude_code.tool.execution',
    ...atAttrs({ 'gen_ai.tool.call.id': 'call-1' }),
  }),
];

// --- REST-agent fixture (Gap 1): no native runId (report.runId falls back to
// report.traceId), no session.id either — the ONLY correlator is the shared
// traceId. Standard gen_ai.usage.* naming (this agent's own instrumentation is
// semconv-correct; it's purely a correlation gap, not a token-naming gap).
const REST_TRACE_ID = 'trace-rest-agent-1';
const REST_SPANS: Record<string, any>[] = [
  atRawSpan({
    spanId: 'rest-llm-1',
    traceId: REST_TRACE_ID,
    name: 'invoke_agent',
    ...atAttrs({
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.model': 'anthropic.claude-sonnet-4',
      'gen_ai.usage.input_tokens': 812,
      'gen_ai.usage.output_tokens': 140,
    }),
  }),
  atRawSpan({
    spanId: 'rest-tool-1',
    traceId: REST_TRACE_ID,
    name: 'execute_tool search_products',
    ...atAttrs({ 'gen_ai.tool.name': 'search_products' }),
  }),
];

// --- Decoy: agent-health's own eval span sharing the Claude Code trace
// (Strategy A pulls in the whole trace) — must be excluded from the agent's
// own token/LLM-call counts.
const EVAL_SPAN_ON_CLAUDE_CODE_TRACE = atRawSpan({
  spanId: 'eval-test-case',
  traceId: CLAUDE_CODE_TRACE_ID,
  name: 'test_case',
  ...atAttrs({ 'gen_ai.operation.name': 'evaluation' }),
});

// --- Aggregate-usage fixture: a framework that stamps gen_ai.usage.* on the
// invoke_agent span (sum of its chat children) AND on each chat span, in the
// @-raw flattened shape. Both the parent and the children carry the model.
const AGG_TRACE_ID = 'trace-aggregate-usage-1';
const AGG_SPANS: Record<string, any>[] = [
  atRawSpan({
    spanId: 'agg-root', traceId: AGG_TRACE_ID, name: 'POST /ask', kind: 'SPAN_KIND_SERVER',
    durationInNanos: 9_000_000_000,
  }),
  atRawSpan({
    spanId: 'agg-agent', parentSpanId: 'agg-root', traceId: AGG_TRACE_ID, name: 'invoke_agent retrieval-agent',
    durationInNanos: 8_900_000_000,
    ...atAttrs({
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.provider.name': 'openai',
      'gen_ai.request.model': 'gpt-4o',
      'gen_ai.usage.input_tokens': '3000',
      'gen_ai.usage.output_tokens': '300',
      'gen_ai.usage.total_tokens': '3300',
    }),
  }),
  atRawSpan({
    spanId: 'agg-cycle-1', parentSpanId: 'agg-agent', traceId: AGG_TRACE_ID, name: 'execute_event_loop_cycle',
    ...atAttrs({ 'gen_ai.operation.name': 'execute_event_loop_cycle' }),
  }),
  atRawSpan({
    spanId: 'agg-chat-1', parentSpanId: 'agg-cycle-1', traceId: AGG_TRACE_ID, name: 'chat',
    ...atAttrs({
      'gen_ai.operation.name': 'chat', 'gen_ai.provider.name': 'openai', 'gen_ai.request.model': 'gpt-4o',
      'gen_ai.usage.input_tokens': '1000', 'gen_ai.usage.output_tokens': '100', 'gen_ai.usage.total_tokens': '1100',
    }),
  }),
  atRawSpan({
    spanId: 'agg-cycle-2', parentSpanId: 'agg-agent', traceId: AGG_TRACE_ID, name: 'execute_event_loop_cycle',
    ...atAttrs({ 'gen_ai.operation.name': 'execute_event_loop_cycle' }),
  }),
  atRawSpan({
    spanId: 'agg-chat-2', parentSpanId: 'agg-cycle-2', traceId: AGG_TRACE_ID, name: 'chat',
    ...atAttrs({
      'gen_ai.operation.name': 'chat', 'gen_ai.provider.name': 'openai', 'gen_ai.request.model': 'gpt-4o',
      'gen_ai.usage.input_tokens': '2000', 'gen_ai.usage.output_tokens': '200', 'gen_ai.usage.total_tokens': '2200',
    }),
  }),
];

const INDEX: Record<string, any>[] = [
  ...CLAUDE_CODE_SPANS,
  EVAL_SPAN_ON_CLAUDE_CODE_TRACE,
  ...REST_SPANS,
  ...AGG_SPANS,
];

function resolveField(doc: Record<string, any>, field: string): unknown {
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

/**
 * Mimic real OpenSearch `_source` field projection: exact field names pass
 * through as-is; a `prefix.*` pattern keeps every field whose key starts with
 * `prefix.`. Fields not covered by any requested pattern are dropped — this
 * is what makes the fake catch a regression to `METRICS_SOURCE_FIELDS` (drop
 * the `span.attributes.*` wildcard and every attribute field disappears from
 * the projected doc, exactly like the real bug).
 */
function applySourceProjection(doc: Record<string, any>, sourceFields?: string[]): Record<string, any> {
  if (!sourceFields || sourceFields.length === 0) return doc;
  const exact = new Set(sourceFields.filter((f) => !f.endsWith('.*')));
  const prefixes = sourceFields.filter((f) => f.endsWith('.*')).map((f) => f.slice(0, -1)); // keep trailing '.'
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(doc)) {
    if (exact.has(key) || prefixes.some((p) => key.startsWith(p))) {
      out[key] = value;
    }
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

describe('metrics correlation + span-schema + vendor token reads (comparison-page Cost/Tokens/LLM Calls bug)', () => {
  describe('computeMetrics (single-run, no _source restriction)', () => {
    it('Strategy B alone finds nothing for a Claude-Code-shaped run (no agent_health.run.id / gen_ai.conversation.id on any span)', async () => {
      const client = createFakeClient();

      const m = await computeMetrics('subprocess-does-not-match-anything', { client });

      expect(m.status).toBe('pending');
      expect(m.totalTokens).toBe(0);
    });

    it('Strategy A (traceId) reaches the @-raw-flattened vendor-shaped spans and reads bare input_tokens/output_tokens', async () => {
      const client = createFakeClient();

      // The report's real runId never matches any span attribute; only the
      // traceId correlator (Strategy A) does, and the doc is stored in the
      // legacy @-flattened schema (Gap 2), with vendor (not registry) token
      // key names (Gap 3).
      const m = await computeMetrics('subprocess-1788335139441', { client }, undefined, CLAUDE_CODE_TRACE_ID);

      expect(m.status).toBe('success');
      // 34947+1200 input, 313+87 output — the eval span is excluded.
      expect(m.inputTokens).toBe(36147);
      expect(m.outputTokens).toBe(400);
      expect(m.totalTokens).toBe(36547);
      expect(m.llmCalls).toBe(2);
      expect(m.costUsd).toBeGreaterThan(0);
    });

    it('Strategy A also reaches a REST-connector run whose runId IS the traceId (report.runId falls back to report.traceId upstream)', async () => {
      const client = createFakeClient();

      const m = await computeMetrics(REST_TRACE_ID, { client }, undefined, REST_TRACE_ID);

      expect(m.status).toBe('success');
      expect(m.inputTokens).toBe(812);
      expect(m.outputTokens).toBe(140);
      expect(m.llmCalls).toBe(1);
      expect(m.toolsUsed).toEqual(['search_products']);
    });
  });

  describe('computeBatchMetrics (the exact path the comparison page calls, WITH _source restriction)', () => {
    it('correlates both a Claude-Code-shaped run and a REST-connector run via a traceId map in ONE terms query, isolating them from each other', async () => {
      const client = createFakeClient();

      const results = await computeBatchMetrics(
        ['subprocess-1788335139441', REST_TRACE_ID],
        { client },
        undefined,
        { 'subprocess-1788335139441': CLAUDE_CODE_TRACE_ID, [REST_TRACE_ID]: REST_TRACE_ID }
      );

      expect(client.search).toHaveBeenCalledTimes(1);

      const cc = results.find(r => r.runId === 'subprocess-1788335139441')!;
      expect(cc.status).toBe('success');
      expect(cc.totalTokens).toBe(36547);
      expect(cc.llmCalls).toBe(2);

      const rest = results.find(r => r.runId === REST_TRACE_ID)!;
      expect(rest.status).toBe('success');
      expect(rest.inputTokens).toBe(812);
      expect(rest.toolCalls).toBe(1);
    });

    it('requests a _source projection that keeps span.attributes.*/resource.attributes.* (regression lock: a narrowed projection silently zeroes every token/model read)', async () => {
      const client = createFakeClient();

      await computeBatchMetrics(
        ['subprocess-1788335139441'],
        { client },
        undefined,
        { 'subprocess-1788335139441': CLAUDE_CODE_TRACE_ID }
      );

      const sourceFields = client.search.mock.calls[0][0].body._source;
      expect(sourceFields).toEqual(expect.arrayContaining(['span.attributes.*', 'resource.attributes.*']));
    });

    it('does not double-count usage stamped on an aggregate invoke_agent span (leaf-usage invariant, batch path with _source projection)', async () => {
      const client = createFakeClient();

      const [m] = await computeBatchMetrics([AGG_TRACE_ID], { client }, undefined, { [AGG_TRACE_ID]: AGG_TRACE_ID });

      // Pre-fix: 6000 / 600 (parent added on top of children) and 3 LLM calls.
      expect(m.inputTokens).toBe(3000);
      expect(m.outputTokens).toBe(300);
      expect(m.totalTokens).toBe(3300);
      expect(m.llmCalls).toBe(2);
      expect(m.usageAggregatesSkipped).toBe(1);
      // The projection must have carried the ids the invariant depends on.
      expect(client.search.mock.calls[0][0].body._source).toEqual(expect.arrayContaining(['spanId', 'parentSpanId']));
    });

    it('single-run path agrees with the batch path on the aggregate-usage trace', async () => {
      const client = createFakeClient();
      const m = await computeMetrics(AGG_TRACE_ID, { client }, undefined, AGG_TRACE_ID);
      expect(m.totalTokens).toBe(3300);
      expect(m.llmCalls).toBe(2);
      expect(m.usageAggregatesSkipped).toBe(1);
    });

    it('still returns pending (not a fabricated success) for a run with no traceId correlator and no matching attributes', async () => {
      const client = createFakeClient();

      const [m] = await computeBatchMetrics(['totally-unrelated-run'], { client });

      expect(m.status).toBe('pending');
      expect(m.totalTokens).toBe(0);
    });
  });
});
