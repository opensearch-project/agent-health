/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A synthetic agent's span sink on a REAL OpenSearch node: one throw-away
 * `otel-v1-apm-span-ahtest-*` index with the OSI / Data Prepper
 * `otel-v1-apm-span` template shape — flat `span.attributes.<key with '.'
 * → '@'>` leaves dynamically mapped as `keyword`, top-level `traceId` /
 * `spanId` / `serviceName` / `startTime` / `endTime` / `durationInNanos` /
 * `status.code` — the schema production clusters ingest agent traces into
 * (and the one Strategy B used to miss, see
 * tests/integration/server/services/strategyBRealOpenSearch.opensearch.integration.test.ts).
 *
 * The agent-health server under test is pointed at this ONE index as its
 * traces pattern (`observability.indexes.traces`), so nothing else on the
 * node is read and `cleanup()` drops exactly this index.
 *
 * Endpoint: `resolveMatrixOpenSearchEndpoint()` — `TEST_OPENSEARCH_ENDPOINT`
 * locally (opt-in: the suite writes synthetic data), or `localhost:9200` when
 * the CI job declares `AH_TEST_REQUIRE_OPENSEARCH=1` (the jobs that provision
 * the disposable service container — integration-tests and e2e-tests);
 * `null` → the suite must skip. Either way, once an endpoint is named an
 * unreachable node is a FAILURE, never a skip: a job that promised OpenSearch
 * and lost it must not go green with this coverage silently gone. (Jobs that
 * run every jest suite without a container, e.g. release-rehearsal, declare
 * nothing and skip.)
 */

import type { Client } from '@opensearch-project/opensearch';
import type { AgentSpanInput, AgentSpanSink } from './agentSpanSink';
import { createRawOpenSearchClient, rawClusterReachable, resolveRawOpenSearchEndpoint } from './rawOpenSearchCluster';

export { rawOpenSearchOptInHint } from './rawOpenSearchCluster';

/** Env var a CI job sets when it provisions a disposable OpenSearch on localhost:9200 for these suites. */
export const REQUIRE_OPENSEARCH_VAR = 'AH_TEST_REQUIRE_OPENSEARCH';

/** The disposable node the matrix suites may write to, or `null` (skip). See the module doc. */
export function resolveMatrixOpenSearchEndpoint(): string | null {
  const explicit = process.env.TEST_OPENSEARCH_ENDPOINT?.trim();
  if (explicit) return explicit;
  if (process.env[REQUIRE_OPENSEARCH_VAR] === '1') return 'http://localhost:9200';
  return null;
}

export interface OpenSearchSpanIndex extends AgentSpanSink {
  readonly backend: 'opensearch';
  /** Node URL (the value for the config's `observability.endpoint`). */
  endpoint: string;
  /** The throw-away index name — also the exact `indexes.traces` pattern the server reads. */
  index: string;
  client: Client;
}

const KIND_NAME: Record<AgentSpanInput['kind'], string> = {
  SERVER: 'SPAN_KIND_SERVER',
  CLIENT: 'SPAN_KIND_CLIENT',
  INTERNAL: 'SPAN_KIND_INTERNAL',
  PRODUCER: 'SPAN_KIND_PRODUCER',
  CONSUMER: 'SPAN_KIND_CONSUMER',
};
const STATUS_CODE: Record<NonNullable<AgentSpanInput['status']>['code'], number> = { UNSET: 0, OK: 1, ERROR: 2 };

/** One Data Prepper span document (flat-@ attribute leaves) from the agent fixture's span. */
export function toDataPrepperSpanDoc(span: AgentSpanInput): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    traceId: span.traceId,
    spanId: span.spanId,
    parentSpanId: span.parentSpanId ?? '',
    traceState: '',
    name: span.name,
    kind: KIND_NAME[span.kind],
    serviceName: span.serviceName,
    startTime: new Date(span.startMs).toISOString(),
    endTime: new Date(span.endMs).toISOString(),
    durationInNanos: (span.endMs - span.startMs) * 1_000_000,
    // Nested `status` object (the plain-raw shape): both readers accept it (`status.code` is ALSO read flat by tracesService).
    status: { code: STATUS_CODE[span.status?.code ?? 'OK'], ...(span.status?.message ? { message: span.status.message } : {}) },
    'instrumentationScope.name': 'demo_agent',
    'resource.attributes.service@name': span.serviceName,
    'resource.attributes.telemetry@sdk@name': 'opentelemetry',
    'resource.attributes.telemetry@sdk@language': 'nodejs',
  };
  for (const [key, value] of Object.entries(span.attributes)) doc[`span.attributes.${key.replace(/\./g, '@')}`] = value;
  return doc;
}

/** The Data Prepper `otel-v1-apm-span` index template, reduced to what the documents above use. */
export const DATA_PREPPER_SPAN_MAPPINGS = {
  dynamic_templates: [
    { resource_attributes_map: { path_match: 'resource.attributes.*', mapping: { type: 'keyword' } } },
    { span_attributes_map: { path_match: 'span.attributes.*', mapping: { type: 'keyword' } } },
  ],
  properties: {
    traceId: { type: 'keyword', ignore_above: 256 },
    spanId: { type: 'keyword', ignore_above: 256 },
    parentSpanId: { type: 'keyword', ignore_above: 256 },
    name: { type: 'keyword', ignore_above: 1024 },
    kind: { type: 'keyword', ignore_above: 128 },
    serviceName: { type: 'keyword' },
    startTime: { type: 'date_nanos' },
    endTime: { type: 'date_nanos' },
    durationInNanos: { type: 'long' },
    status: { properties: { code: { type: 'integer' }, message: { type: 'keyword' } } },
    'instrumentationScope.name': { type: 'keyword' },
  },
} as const;

/**
 * Create the throw-away span index on `endpoint`. Throws when the node is not
 * reachable — callers decide beforehand (via `resolveRawOpenSearchEndpoint()`)
 * whether to skip; a configured-but-dead node is a failure, not a skip.
 */
export async function startOpenSearchSpanIndex(endpoint: string, options: { label?: string } = {}): Promise<OpenSearchSpanIndex> {
  const client = createRawOpenSearchClient(endpoint);
  if (!(await rawClusterReachable(client))) {
    await client.close().catch(() => {});
    throw new Error(`OpenSearch at ${endpoint} is not reachable (TEST_OPENSEARCH_ENDPOINT / the CI service container)`);
  }
  // Lowercase, unique: `otel-v1-apm-span-ahtest-<label>-<pid>-<ts>` is a valid index name the sweeper recognises.
  const index = `otel-v1-apm-span-ahtest-${(options.label ?? 'matrix').toLowerCase()}-${process.pid}-${Date.now()}`;
  try {
    await client.indices.create({ index, body: { mappings: DATA_PREPPER_SPAN_MAPPINGS as any } });
  } catch (e) {
    // Nothing to keep: drop whatever the failed create may have left, then the client.
    await client.indices.delete({ index }).catch(() => undefined);
    await client.close().catch(() => {});
    throw e;
  }
  let count = 0;
  return {
    backend: 'opensearch',
    endpoint,
    index,
    client,
    async putSpans(spans) {
      if (spans.length === 0) return;
      const body: unknown[] = [];
      for (const span of spans) body.push({ index: { _index: index, _id: span.spanId } }, toDataPrepperSpanDoc(span));
      // `refresh: true` — the agent "flushed" its exporter: a reader sees the spans as soon as the agent has answered.
      const res = await client.bulk({ refresh: true, body });
      if (res.body.errors) {
        const first = res.body.items.find((i: any) => i.index?.error)?.index?.error;
        throw new Error(`bulk index into ${index} failed: ${JSON.stringify(first)}`);
      }
      count += spans.length;
    },
    size: () => count,
    async close() {
      await client.indices.delete({ index }).catch((e: any) => {
        if (e?.meta?.statusCode !== 404) console.warn(`[openSearchSpanIndex] could not delete ${index}: ${e?.message ?? e}`);
      });
      await client.close().catch(() => {});
    },
  };
}
