/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test against a REAL OpenSearch node: Strategy B (run-id) trace
 * correlation must find spans under every index schema the attribute may be
 * indexed in — this is the only level that proves the query DSL is right,
 * rather than that an in-memory emulator agrees with the query builder.
 *
 * Three indexes are created, each matched by one `otel-v1-apm-span-*`-style
 * pattern, and ONE `fetchTraces({ runIds })` query is issued across all three
 * (exactly like a real alias / multi-index search over rolled-over indexes):
 *
 *   1. OSI / Data Prepper flat-@ template — `span.attributes.*` dynamically
 *      mapped as `keyword`; attributes are literal top-level fields
 *      `span.attributes.agent_health@run@id`. (The shipped query never matched
 *      these: measured live, 0 hits for every run id on such a cluster.)
 *   2. Nested schema, EXPLICIT keyword mapping — `attributes.agent_health.run.id`
 *      is a `keyword`; `.keyword` under it is unmapped.
 *   3. Nested schema, plain DYNAMIC mapping (no template at all) — OpenSearch
 *      maps the string as analyzed `text` + `.keyword` multi-field, so a
 *      hyphenated run id is tokenized on `-` and ONLY `.keyword` matches.
 *
 * Asserting across all three in one request also proves the fan-out is SAFE:
 * `terms` clauses on paths that are unmapped in a given index (`.keyword` on a
 * keyword field, `span.attributes.*` on a nested index) match nothing and do
 * not error, even when the same field name is `text` in one index and
 * `keyword` in another.
 *
 * Cluster: http://localhost:9200 (no security), the same ephemeral OpenSearch
 * the CI integration job runs. Each test bails out (passes trivially, with a
 * console warning) when the cluster is unreachable, so local runs without a
 * cluster and non-integration CI jobs stay green. To run locally:
 *
 *   docker run -d --rm -p 9200:9200 -e discovery.type=single-node \
 *     -e DISABLE_SECURITY_PLUGIN=true -e DISABLE_INSTALL_DEMO_CONFIG=true \
 *     opensearchproject/opensearch:2.17.0
 *   npm run test:integration -- strategyBRealOpenSearch
 */

import { Client } from '@opensearch-project/opensearch';
import { fetchTraces } from '@/server/services/tracesService';
import { computeMetrics } from '@/server/services/metricsService';

const ENDPOINT = process.env.TEST_OPENSEARCH_ENDPOINT || 'http://localhost:9200';
const STAMP = Date.now();
const PATTERN = `otel-v1-apm-span-ahtest-${STAMP}-*`;
const IDX_FLAT = `otel-v1-apm-span-ahtest-${STAMP}-flat`;
const IDX_NESTED_KW = `otel-v1-apm-span-ahtest-${STAMP}-nestedkw`;
const IDX_NESTED_DYN = `otel-v1-apm-span-ahtest-${STAMP}-nesteddyn`;

// Hyphenated ids on purpose — the shape our producers emit, and the shape a
// dynamically mapped `text` field tokenizes (so only `.keyword` can match).
const RUN_FLAT = `run-${STAMP}-flat-a4e3j7lsj`;
const RUN_NESTED_KW = `run-${STAMP}-nkw-b5f4k8mtk`;
const RUN_NESTED_DYN = `run-${STAMP}-ndyn-c6g5l9nul`;
const RUN_CONV_ONLY = `run-${STAMP}-conv-d7h6m0ovm`;

async function clusterUp(client: Client): Promise<boolean> {
  try {
    await client.cluster.health({ wait_for_status: 'yellow', timeout: '5s' });
    return true;
  } catch {
    return false;
  }
}

const NOW = Date.now();
function base(spanId: string, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    traceId: `trace-${spanId}`,
    spanId,
    parentSpanId: '',
    name: 'chat',
    kind: 'SPAN_KIND_INTERNAL',
    serviceName: 'rest-agent',
    startTime: new Date(NOW - 5000).toISOString(),
    endTime: new Date(NOW).toISOString(),
    durationInNanos: 5_000_000_000,
    status: { code: 1 },
    ...extra,
  };
}

describe('Strategy B run-id correlation against a REAL OpenSearch node (all attribute schemas, one multi-index query)', () => {
  let client: Client;
  let available = false;

  beforeAll(async () => {
    client = new Client({ node: ENDPOINT, ssl: { rejectUnauthorized: false } });
    available = await clusterUp(client);
    if (!available) {
      // See traceTextSearch.opensearch.integration.test.ts for why this is a
      // skip-with-warning rather than a CI-gated throw.
      // eslint-disable-next-line no-console
      console.warn(`[skip] OpenSearch not reachable at ${ENDPOINT} — skipping real-cluster Strategy-B tests`);
      return;
    }

    // 1. OSI / Data Prepper otel-v1-apm-span template: flat-@ keyword leaves.
    await client.indices.create({
      index: IDX_FLAT,
      body: {
        mappings: {
          dynamic_templates: [
            { span_attributes_map: { path_match: 'span.attributes.*', mapping: { type: 'keyword' } } },
            { resource_attributes_map: { path_match: 'resource.attributes.*', mapping: { type: 'keyword' } } },
          ],
          properties: {
            traceId: { type: 'keyword' },
            spanId: { type: 'keyword' },
            serviceName: { type: 'keyword' },
            startTime: { type: 'date' },
            endTime: { type: 'date' },
          },
        },
      },
    });
    // 2. Nested, explicit keyword mapping.
    await client.indices.create({
      index: IDX_NESTED_KW,
      body: {
        mappings: {
          properties: {
            traceId: { type: 'keyword' },
            spanId: { type: 'keyword' },
            serviceName: { type: 'keyword' },
            startTime: { type: 'date' },
            endTime: { type: 'date' },
            attributes: {
              properties: {
                'agent_health.run.id': { type: 'keyword' },
                'gen_ai.conversation.id': { type: 'keyword' },
              },
            },
          },
        },
      },
    });
    // 3. Nested, fully dynamic (no template): strings -> text + .keyword.
    await client.indices.create({
      index: IDX_NESTED_DYN,
      body: {
        mappings: {
          properties: {
            traceId: { type: 'keyword' },
            spanId: { type: 'keyword' },
            serviceName: { type: 'keyword' },
            startTime: { type: 'date' },
            endTime: { type: 'date' },
          },
        },
      },
    });

    await client.bulk({
      refresh: true,
      body: [
        // flat-@: both run-id attributes
        { index: { _index: IDX_FLAT } },
        base('flat-root', {
          'span.attributes.agent_health@run@id': RUN_FLAT,
          'span.attributes.gen_ai@conversation@id': RUN_FLAT,
          'span.attributes.gen_ai@operation@name': 'chat',
          'span.attributes.gen_ai@request@model': 'anthropic.claude-sonnet-4',
          'span.attributes.gen_ai@usage@input_tokens': 1200,
          'span.attributes.gen_ai@usage@output_tokens': 300,
        }),
        // flat-@: OTEL-standard conversation id only
        { index: { _index: IDX_FLAT } },
        base('flat-conv', { 'span.attributes.gen_ai@conversation@id': RUN_CONV_ONLY }),
        // nested keyword-mapped
        { index: { _index: IDX_NESTED_KW } },
        base('nkw-root', { attributes: { 'agent_health.run.id': RUN_NESTED_KW, 'gen_ai.conversation.id': RUN_NESTED_KW } }),
        // nested dynamically-mapped (text + .keyword)
        { index: { _index: IDX_NESTED_DYN } },
        base('ndyn-root', { attributes: { 'agent_health.run.id': RUN_NESTED_DYN, 'gen_ai.conversation.id': RUN_NESTED_DYN } }),
        // decoys in every index
        { index: { _index: IDX_FLAT } },
        base('flat-decoy', { 'span.attributes.agent_health@run@id': `run-${STAMP}-decoy-zzzzzzzzz` }),
        { index: { _index: IDX_NESTED_DYN } },
        base('ndyn-decoy', { attributes: { 'agent_health.run.id': `run-${STAMP}-decoy-yyyyyyyyy` } }),
      ],
    });
  }, 60000);

  afterAll(async () => {
    if (available) {
      await client.indices.delete({ index: [IDX_FLAT, IDX_NESTED_KW, IDX_NESTED_DYN] }).catch(() => {});
    }
    await client.close().catch(() => {});
  });

  // Jest registers `it` synchronously before `beforeAll` runs, so decide at
  // runtime (see traceTextSearch.opensearch.integration.test.ts).
  function itIfAvailable(name: string, fn: () => Promise<void>, timeout = 30000) {
    it(name, async () => {
      if (!available) {
        // eslint-disable-next-line no-console
        console.warn(`[skip] OpenSearch not reachable at ${ENDPOINT} — skipping "${name}"`);
        return;
      }
      await fn();
    }, timeout);
  }

  itIfAvailable('the dynamic nested index really maps the run-id attribute as text + .keyword (precondition for the .keyword path)', async () => {
    const res = await client.indices.getFieldMapping({ index: IDX_NESTED_DYN, fields: 'attributes.agent_health.run.id' });
    const mapping = (res.body as any)[IDX_NESTED_DYN].mappings['attributes.agent_health.run.id'].mapping.id;
    expect(mapping.type).toBe('text');
    expect(mapping.fields.keyword.type).toBe('keyword');
  });

  itIfAvailable('the pre-fix nested-only clause finds NOTHING on the flat-@ index (the bug), and nothing on the dynamic-text index either', async () => {
    const preFix = {
      bool: {
        should: [
          { terms: { 'attributes.agent_health.run.id': [RUN_FLAT, RUN_NESTED_DYN] } },
          { terms: { 'attributes.gen_ai.conversation.id': [RUN_FLAT, RUN_NESTED_DYN] } },
        ],
        minimum_should_match: 1,
      },
    };
    const res = await client.count({ index: PATTERN, body: { query: preFix } });
    expect(res.body.count).toBe(0);
  });

  itIfAvailable('fetchTraces({ runIds }) finds the run in EVERY schema with one multi-index query, without decoy bleed', async () => {
    const result = await fetchTraces(
      { runIds: [RUN_FLAT, RUN_NESTED_KW, RUN_NESTED_DYN, RUN_CONV_ONLY], size: 50 },
      client,
      PATTERN,
    );

    expect(result.spans.map((s) => s.spanId).sort()).toEqual(['flat-conv', 'flat-root', 'ndyn-root', 'nkw-root']);
    // transformSpan normalizes both shapes to dotted keys.
    expect(result.spans.find((s) => s.spanId === 'flat-root')!.attributes['agent_health.run.id']).toBe(RUN_FLAT);
    expect(result.spans.find((s) => s.spanId === 'ndyn-root')!.attributes['agent_health.run.id']).toBe(RUN_NESTED_DYN);
  });

  itIfAvailable('each schema is reachable on its own (flat-@ / nested keyword / nested dynamic-text)', async () => {
    const flat = await fetchTraces({ runIds: [RUN_FLAT] }, client, PATTERN);
    expect(flat.spans.map((s) => s.spanId)).toEqual(['flat-root']);

    const kw = await fetchTraces({ runIds: [RUN_NESTED_KW] }, client, PATTERN);
    expect(kw.spans.map((s) => s.spanId)).toEqual(['nkw-root']);

    const dyn = await fetchTraces({ runIds: [RUN_NESTED_DYN] }, client, PATTERN);
    expect(dyn.spans.map((s) => s.spanId)).toEqual(['ndyn-root']);
  });

  itIfAvailable('computeMetrics correlates a flat-@ run by Strategy B alone and reads its @-encoded token attributes', async () => {
    const m = await computeMetrics(RUN_FLAT, { client, indexPattern: PATTERN });
    expect(m.status).toBe('success');
    expect(m.llmCalls).toBe(1);
    expect(m.inputTokens).toBe(1200);
    expect(m.outputTokens).toBe(300);
  });
});
