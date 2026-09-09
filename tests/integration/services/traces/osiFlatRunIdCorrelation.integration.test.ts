/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression: Strategy B (run-id) trace correlation NEVER matched spans
 * written by OpenSearch Ingestion / Data Prepper into the `otel-v1-apm-span-*`
 * index — the default index pattern of this very service.
 *
 * That index template stores span attributes FLAT, one top-level field per
 * attribute, with dots in the attribute name encoded as `@`:
 *
 *     "span.attributes.agent_health@run@id":    "run-…"
 *     "span.attributes.gen_ai@conversation@id": "run-…"
 *
 * `tracesService.ts` and `metricsService.ts` built their Strategy-B clause
 * against the NESTED shape only (`attributes.agent_health.run.id` /
 * `attributes.gen_ai.conversation.id`), which on that index is simply an
 * unmapped field. Measured read-only on a live OSI-ingested cluster with
 * `_count`: the nested-path clause returned 0 hits for every run id on the
 * cluster; the flat-@ clause returned the run's spans (53 for one REST-agent
 * run, 1 for the eval span). So run-id correlation had silently never worked
 * there — the Traces tab / metrics only ever found spans via Strategy A
 * (shared traceId) and Strategy C (service.name + time window).
 *
 * The READ side (`transformSpan`) always tolerated both shapes (PR #469 fixed
 * exactly this mismatch for the metrics reader), which is why spans that WERE
 * found rendered fine and the query-side gap went unnoticed.
 *
 * This test exercises the REAL query-building + span-parsing paths end-to-end
 * against an in-memory fake OpenSearch whose field resolution mirrors how
 * OpenSearch maps each schema: a `term`/`terms` clause on
 * `span.attributes.agent_health@run@id` resolves against the top-level flat
 * key; `attributes.agent_health.run.id` resolves against the nested object.
 * One index holds documents of BOTH shapes, so the fix must find both without
 * regressing the nested-schema behaviour plainRawCorrelation.integration.test.ts
 * already locks in.
 *
 * Run: npm test -- --testPathPatterns=osiFlatRunIdCorrelation.integration
 */

import { fetchTraces } from '@/server/services/tracesService';
import { computeMetrics, computeBatchMetrics } from '@/server/services/metricsService';

// ---------------------------------------------------------------------------
// Fixtures — one run stored in the OSI flat-@ shape, one in the nested shape.
// Generic agent names only (internal-name rule).
// ---------------------------------------------------------------------------

const FLAT_RUN = 'run-flat-1788552723776-j9o0h2p4';
const NESTED_RUN = 'run-nested-1781686816814-a4e3j7lsj';
const CONV_ONLY_RUN = 'run-convonly-1788552700000-abcdefgh';
const DECOY_RUN = 'run-decoy-0000000000000-zzzzzzzz';

function baseSpan(overrides: Record<string, any>): Record<string, any> {
  return {
    traceId: 'trace-' + Math.random().toString(36).slice(2, 10),
    spanId: 'span-' + Math.random().toString(36).slice(2, 8),
    parentSpanId: '',
    name: 'span',
    kind: 'SPAN_KIND_INTERNAL',
    serviceName: 'rest-agent',
    startTime: '2026-09-08T07:29:00.000000000Z',
    endTime: '2026-09-08T07:29:01.000000000Z',
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

const INDEX: Record<string, any>[] = [
  // --- FLAT run: root + LLM call + tool call, stamped with BOTH run-id attributes (as our producers do)
  baseSpan({
    spanId: 'flat-root',
    traceId: 'trace-flat',
    name: 'invoke_agent',
    durationInNanos: 3_000_000_000,
    ...flatAttrs({
      'agent_health.run.id': FLAT_RUN,
      'gen_ai.conversation.id': FLAT_RUN,
      'gen_ai.agent.name': 'rest-agent',
    }),
  }),
  baseSpan({
    spanId: 'flat-llm',
    traceId: 'trace-flat',
    name: 'chat anthropic.claude-sonnet-4',
    ...flatAttrs({
      'agent_health.run.id': FLAT_RUN,
      'gen_ai.conversation.id': FLAT_RUN,
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.model': 'anthropic.claude-sonnet-4',
      'gen_ai.usage.input_tokens': 1200,
      'gen_ai.usage.output_tokens': 300,
    }),
  }),
  baseSpan({
    spanId: 'flat-tool',
    traceId: 'trace-flat',
    name: 'execute_tool search',
    ...flatAttrs({
      'agent_health.run.id': FLAT_RUN,
      'gen_ai.conversation.id': FLAT_RUN,
      'gen_ai.tool.name': 'search',
    }),
  }),
  // --- FLAT span stamped ONLY with the OTEL-standard gen_ai.conversation.id
  baseSpan({
    spanId: 'flat-conv-only',
    traceId: 'trace-conv',
    name: 'chat',
    ...flatAttrs({
      'gen_ai.conversation.id': CONV_ONLY_RUN,
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.model': 'anthropic.claude-sonnet-4',
      'gen_ai.usage.input_tokens': 10,
      'gen_ai.usage.output_tokens': 5,
    }),
  }),
  // --- NESTED run (stock Data Prepper plain-raw / our own exporter)
  baseSpan({
    spanId: 'nested-root',
    traceId: 'trace-nested',
    name: 'invoke_agent',
    serviceName: 'plainraw-agent',
    attributes: { 'agent_health.run.id': NESTED_RUN, 'gen_ai.conversation.id': NESTED_RUN },
  }),
  baseSpan({
    spanId: 'nested-llm',
    traceId: 'trace-nested',
    name: 'chat',
    serviceName: 'plainraw-agent',
    attributes: {
      'agent_health.run.id': NESTED_RUN,
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.model': 'us.amazon.nova-pro-v1:0',
      'gen_ai.usage.input_tokens': 700,
      'gen_ai.usage.output_tokens': 70,
    },
  }),
  // --- Decoy in each shape: must never bleed into another run's results
  baseSpan({ spanId: 'decoy-flat', traceId: 'trace-decoy-f', ...flatAttrs({ 'agent_health.run.id': DECOY_RUN }) }),
  baseSpan({ spanId: 'decoy-nested', traceId: 'trace-decoy-n', attributes: { 'agent_health.run.id': DECOY_RUN } }),
];

// ---------------------------------------------------------------------------
// Fake OpenSearch — resolves a query field path the way the two index
// templates map it. Flat-@ keys are literal top-level document fields (the
// OSI template's dynamic `span.attributes.*` keyword mapping); dotted paths
// under `attributes.` / `resource.attributes.` walk the nested object and are
// treated as explicitly `keyword`-mapped (exact match on the base path); a
// `.keyword` path on such a field is UNMAPPED and matches nothing (verified
// against a real node: unmapped `terms` paths match nothing, no error). This
// is deliberately the STRICTER of the two nested-mapping possibilities — the
// dynamically-mapped `text` + `.keyword` case, where only `.keyword` matches,
// is covered against a REAL OpenSearch node in
// strategyBRealOpenSearch.opensearch.integration.test.ts.
// ---------------------------------------------------------------------------
function resolveField(doc: Record<string, any>, field: string): unknown {
  if (field in doc) return doc[field]; // flat-@ shape: literal key
  if (field.endsWith('.keyword')) return undefined; // no multi-field on a keyword-mapped path
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

function createMixedSchemaClient() {
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

describe('Strategy B run-id correlation against OSI flat-@ spans (regression: never matched pre-fix)', () => {
  describe('fetchTraces (Traces tab / /api/traces / judge + comparison trace tools)', () => {
    it('finds a run whose spans are stored in the OSI flat-@ shape (span.attributes.agent_health@run@id)', async () => {
      const client = createMixedSchemaClient();

      const result = await fetchTraces({ runIds: [FLAT_RUN] }, client);

      expect(result.spans.map((s) => s.spanId).sort()).toEqual(['flat-llm', 'flat-root', 'flat-tool']);
      // transformSpan normalizes the flat-@ keys back to dotted attribute names.
      expect(result.spans.every((s) => s.attributes['agent_health.run.id'] === FLAT_RUN)).toBe(true);
      expect(result.spans.find((s) => s.spanId === 'flat-llm')!.attributes['gen_ai.usage.input_tokens']).toBe(1200);
    });

    it('finds a flat-@ span stamped ONLY with the OTEL-standard gen_ai.conversation.id', async () => {
      const client = createMixedSchemaClient();

      const result = await fetchTraces({ runIds: [CONV_ONLY_RUN] }, client);

      expect(result.spans.map((s) => s.spanId)).toEqual(['flat-conv-only']);
    });

    it('still finds a run stored in the nested attributes.* shape (no regression)', async () => {
      const client = createMixedSchemaClient();

      const result = await fetchTraces({ runIds: [NESTED_RUN] }, client);

      expect(result.spans.map((s) => s.spanId).sort()).toEqual(['nested-llm', 'nested-root']);
    });

    it('one query finds runs of BOTH shapes together without decoy bleed', async () => {
      const client = createMixedSchemaClient();

      const result = await fetchTraces({ runIds: [FLAT_RUN, NESTED_RUN] }, client);

      expect(result.spans.map((s) => s.spanId).sort()).toEqual([
        'flat-llm', 'flat-root', 'flat-tool', 'nested-llm', 'nested-root',
      ]);
      expect(result.spans.some((s) => s.spanId.startsWith('decoy'))).toBe(false);
    });

    it('the pre-fix nested-only clause reproduces the bug on the same index (0 hits for the flat run)', () => {
      // Documents what the shipped query used to be, so the fix is provably
      // what makes the assertions above pass — not the fake being lenient.
      const preFix = {
        bool: {
          should: [
            { terms: { 'attributes.agent_health.run.id': [FLAT_RUN] } },
            { terms: { 'attributes.gen_ai.conversation.id': [FLAT_RUN] } },
          ],
          minimum_should_match: 1,
        },
      };
      expect(INDEX.filter((d) => matches(preFix, d))).toHaveLength(0);
    });
  });

  describe('computeMetrics / computeBatchMetrics (/api/metrics, /api/metrics/batch)', () => {
    it('Strategy B ALONE (no traceId, no sessionId) computes metrics for a flat-@ run', async () => {
      const client = createMixedSchemaClient();

      const m = await computeMetrics(FLAT_RUN, { client });

      expect(m.status).toBe('success');
      expect(m.inputTokens).toBe(1200);
      expect(m.outputTokens).toBe(300);
      expect(m.llmCalls).toBe(1);
      expect(m.toolCalls).toBe(1);
      expect(m.traceId).toBe('trace-flat');
    });

    it('batch path groups flat-@ and nested runs back to the right runId (projection keeps span.attributes.*)', async () => {
      const client = createMixedSchemaClient();

      const results = await computeBatchMetrics([FLAT_RUN, NESTED_RUN, CONV_ONLY_RUN], { client });

      const byRun = new Map(results.map((r) => [r.runId, r]));
      expect(byRun.get(FLAT_RUN)!.inputTokens).toBe(1200);
      expect(byRun.get(FLAT_RUN)!.status).toBe('success');
      expect(byRun.get(NESTED_RUN)!.inputTokens).toBe(700);
      expect(byRun.get(NESTED_RUN)!.status).toBe('success');
      // Grouped via gen_ai.conversation.id read back through transformSpan.
      expect(byRun.get(CONV_ONLY_RUN)!.inputTokens).toBe(10);
      expect(byRun.get(CONV_ONLY_RUN)!.status).toBe('success');
    });
  });
});
