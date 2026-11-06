/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test: a synthetic retrieval-agent trace containing the three
 * span classes that used to land in OTHER — an HTTP SERVER entrypoint, a
 * framework-specific `gen_ai.operation.name` loop span, and OTel DB-semconv
 * search spans — is ingested through the real `POST /v1/traces` receiver
 * (file backend, temp dir), read back through `POST /api/traces`, and then
 * run through the client categorization pipeline (`categorizeSpanTree` /
 * `countByCategory` / `processSpansIntoTree`) exactly as the Traces UI does.
 *
 * Asserts: the API preserves the attributes categorization depends on
 * (`db.*`, `gen_ai.*`, `http.request.method`, `spanKind`), the OTHER share is
 * 0, and the search span's query text / returned rows survive the round trip.
 */

import express, { Express } from 'express';
import request from 'supertest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import otlpReceiverRoutes from '@/server/routes/otlpReceiver';
import tracesRoutes from '@/server/routes/traces';
import { processSpansIntoTree } from '@/services/traces';
import { categorizeSpanTree, countByCategory } from '@/services/traces/spanCategorization';
import { flattenSpans } from '@/services/traces/traceStats';
import { extractRetrievalIO } from '@/services/traces/retrievalSpan';

const TRACE_ID = '5e7a0000ba5e0000ca7e0000d00d0000';
const T0 = 1_760_000_000_000_000_000; // ns
const ns = (offsetMs: number) => String(T0 + offsetMs * 1_000_000);
const str = (key: string, v: string) => ({ key, value: { stringValue: v } });
const arr = (key: string, vs: string[]) => ({ key, value: { arrayValue: { values: vs.map(v => ({ stringValue: v })) } } });

const QUERY = '{"size":20,"query":{"multi_match":{"query":"desk lamp","fields":["title","description"]}}}';

function syntheticRetrievalAgentTrace() {
  return {
    resourceSpans: [
      {
        resource: { attributes: [str('service.name', 'retrieval-agent')] },
        scopeSpans: [
          {
            scope: { name: 'retrieval.agent' },
            spans: [
              // (c) HTTP SERVER entrypoint of the agent service
              {
                traceId: TRACE_ID, spanId: 'a000000000000001', name: 'POST /ask', kind: 2,
                startTimeUnixNano: ns(0), endTimeUnixNano: ns(5000),
                attributes: [str('http.request.method', 'POST'), str('url.path', '/ask'), str('http.route', '/ask')],
                status: { code: 1 },
              },
              {
                traceId: TRACE_ID, spanId: 'a000000000000002', parentSpanId: 'a000000000000001', name: 'invoke_agent retrieval-agent', kind: 1,
                startTimeUnixNano: ns(10), endTimeUnixNano: ns(4990),
                attributes: [str('gen_ai.operation.name', 'invoke_agent'), str('gen_ai.agent.name', 'retrieval-agent'), str('gen_ai.provider.name', 'openai')],
                status: { code: 1 },
              },
              // (a) framework-specific operation name WITH GenAI context
              {
                traceId: TRACE_ID, spanId: 'a000000000000003', parentSpanId: 'a000000000000002', name: 'execute_event_loop_cycle', kind: 1,
                startTimeUnixNano: ns(20), endTimeUnixNano: ns(4980),
                attributes: [str('gen_ai.operation.name', 'execute_event_loop_cycle'), str('gen_ai.provider.name', 'openai')],
                status: { code: 1 },
              },
              {
                traceId: TRACE_ID, spanId: 'a000000000000004', parentSpanId: 'a000000000000003', name: 'chat', kind: 1,
                startTimeUnixNano: ns(30), endTimeUnixNano: ns(2000),
                attributes: [str('gen_ai.operation.name', 'chat'), str('gen_ai.provider.name', 'openai'), str('gen_ai.request.model', 'example-model')],
                status: { code: 1 },
              },
              {
                traceId: TRACE_ID, spanId: 'a000000000000005', parentSpanId: 'a000000000000003', name: 'execute_tool search_index', kind: 1,
                startTimeUnixNano: ns(2010), endTimeUnixNano: ns(2500),
                attributes: [str('gen_ai.operation.name', 'execute_tool'), str('gen_ai.tool.name', 'search_index')],
                status: { code: 1 },
              },
              // (b) OTel DB-semconv search span (CLIENT) under the tool
              {
                traceId: TRACE_ID, spanId: 'a000000000000006', parentSpanId: 'a000000000000005', name: 'search products', kind: 3,
                startTimeUnixNano: ns(2020), endTimeUnixNano: ns(2060),
                attributes: [
                  str('db.system.name', 'opensearch'),
                  str('db.operation.name', 'search'),
                  str('db.namespace', 'catalog'),
                  str('db.collection.name', 'products'),
                  str('db.query.text', QUERY),
                  str('db.response.returned_rows', '20'),
                  str('db.response.status_code', '200'),
                  arr('retrieval-agent.search.hit_ids', ['prod-101', 'prod-202', 'prod-303']),
                ],
                status: { code: 1 },
              },
              // A second DB span using the LEGACY attribute names
              {
                traceId: TRACE_ID, spanId: 'a000000000000007', parentSpanId: 'a000000000000005', name: 'SELECT catalog.products', kind: 3,
                startTimeUnixNano: ns(2070), endTimeUnixNano: ns(2090),
                attributes: [str('db.system', 'postgresql'), str('db.statement', 'SELECT id FROM products WHERE id = ANY($1)')],
                status: { code: 1 },
              },
            ],
          },
        ],
      },
    ],
  };
}

describe('retrieval-agent trace categorization round-trip (integration)', () => {
  let app: Express;
  let dir: string;
  const saved: Record<string, string | undefined> = {};
  const OBS_ENV = ['OPENSEARCH_LOGS_ENDPOINT', 'OPENSEARCH_LOGS_USERNAME', 'OPENSEARCH_LOGS_PASSWORD', 'AGENT_HEALTH_DATA_DIR'];

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'retrieval-cat-int-'));
    for (const k of OBS_ENV) saved[k] = process.env[k];
    delete process.env.OPENSEARCH_LOGS_ENDPOINT;
    delete process.env.OPENSEARCH_LOGS_USERNAME;
    delete process.env.OPENSEARCH_LOGS_PASSWORD;
    process.env.AGENT_HEALTH_DATA_DIR = dir;

    app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use(otlpReceiverRoutes);
    app.use(tracesRoutes);

    await request(app).post('/v1/traces').send(syntheticRetrievalAgentTrace()).expect(200);
  });

  afterAll(async () => {
    for (const k of OBS_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function fetchSpans() {
    const res = await request(app).post('/api/traces').send({ traceId: TRACE_ID }).expect(200);
    expect(res.body.backend).toBe('file');
    return res.body.spans as any[];
  }

  it('preserves the attributes categorization depends on, including spanKind', async () => {
    const spans = await fetchSpans();
    expect(spans).toHaveLength(7);
    const root = spans.find(s => s.spanId === 'a000000000000001');
    expect(root.attributes['http.request.method']).toBe('POST');
    expect(root.attributes.spanKind).toBe('SPAN_KIND_SERVER');
    const search = spans.find(s => s.spanId === 'a000000000000006');
    expect(search.attributes['db.system.name']).toBe('opensearch');
    expect(search.attributes['db.query.text']).toBe(QUERY);
    expect(search.attributes['db.response.returned_rows']).toBe('20');
    expect(search.attributes.spanKind).toBe('SPAN_KIND_CLIENT');
    expect(search.attributes['retrieval-agent.search.hit_ids']).toEqual(['prod-101', 'prod-202', 'prod-303']);
  });

  it('categorizes every span — OTHER share is 0 — through the same pipeline the UI uses', async () => {
    const spans = await fetchSpans();
    const tree = processSpansIntoTree(spans);
    const categorized = categorizeSpanTree(tree);
    const counts = countByCategory(categorized);

    expect(counts.OTHER).toBe(0);
    expect(counts).toEqual({ AGENT: 3, LLM: 1, TOOL: 1, RETRIEVAL: 2, EVAL: 0, ERROR: 0, OTHER: 0 });

    const byId = new Map(flattenSpans(categorized).map(s => [s.spanId, s]));
    expect(byId.get('a000000000000001')!.category).toBe('AGENT');
    expect(byId.get('a000000000000001')!.isEntrypoint).toBe(true);
    expect(byId.get('a000000000000003')!.category).toBe('AGENT'); // framework loop cycle
    expect(byId.get('a000000000000003')!.isEntrypoint).toBeUndefined();
    expect(byId.get('a000000000000006')!.category).toBe('RETRIEVAL');
    expect(byId.get('a000000000000006')!.displayName).toBe('search products');
    expect(byId.get('a000000000000007')!.category).toBe('RETRIEVAL'); // legacy db.system
  });

  it('exposes the query text, returned rows and retrieved ids of the search span', async () => {
    const spans = await fetchSpans();
    const search = spans.find(s => s.spanId === 'a000000000000006');
    const io = extractRetrievalIO(search);
    expect(io.caption).toBe('search products (opensearch)');
    expect(io.queryText).toBe(JSON.stringify(JSON.parse(QUERY), null, 2));
    expect(io.returnedRows).toBe(20);
    expect(io.statusCode).toBe('200');
    expect(io.idLists).toEqual([{ attribute: 'retrieval-agent.search.hit_ids', ids: ['prod-101', 'prod-202', 'prod-303'] }]);

    const legacy = spans.find(s => s.spanId === 'a000000000000007');
    expect(extractRetrievalIO(legacy).queryText).toBe('SELECT id FROM products WHERE id = ANY($1)');
  });
});
