/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A `SpanSink` (tests/helpers/demoRetrievalAgentStub.ts) that indexes the demo
 * agent's spans into a throwaway `ahtest-otel-v1-apm-span-*` index of a REAL
 * OpenSearch cluster — the shape Data Prepper writes (nested `attributes`,
 * ISO `startTime` / `endTime`, `durationInNanos`, numeric `status.code`), so
 * the agent-health server's OpenSearch observability module reads them
 * through its ordinary `/api/traces` query, nothing mocked.
 *
 * Opt-in like every raw-cluster helper (`resolveRawOpenSearchEndpoint`): the
 * index is created with the `ahtest-` prefix and dropped in `close()`.
 */

import type { Client } from '@opensearch-project/opensearch';
import { createRawOpenSearchClient, RawOpenSearchTestData } from './rawOpenSearchCluster';
import type { CloudWatchSpanRecordInput } from './cloudWatchLogsStub';
import type { SpanSink } from './demoRetrievalAgentStub';

const STATUS_CODE = { UNSET: 0, OK: 1, ERROR: 2 } as const;

/** Index mapping: the fields the traces service filters / sorts on are typed; attributes stay dynamic (text + keyword). */
export const SPAN_INDEX_BODY = {
  settings: { number_of_shards: 1, number_of_replicas: 0 },
  mappings: {
    properties: {
      traceId: { type: 'keyword' },
      spanId: { type: 'keyword' },
      parentSpanId: { type: 'keyword' },
      name: { type: 'keyword' },
      kind: { type: 'keyword' },
      serviceName: { type: 'keyword' },
      startTime: { type: 'date' },
      endTime: { type: 'date' },
      durationInNanos: { type: 'long' },
      status: { properties: { code: { type: 'integer' }, message: { type: 'keyword' } } },
    },
  },
};

/** Data Prepper document for one span of the demo agent. */
export function toOpenSearchSpanDoc(span: CloudWatchSpanRecordInput): Record<string, unknown> {
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : { parentSpanId: '' }),
    name: span.name,
    kind: span.kind,
    serviceName: span.serviceName,
    startTime: new Date(span.startMs).toISOString(),
    endTime: new Date(span.endMs).toISOString(),
    durationInNanos: (span.endMs - span.startMs) * 1_000_000,
    status: { code: STATUS_CODE[span.status?.code ?? 'OK'], ...(span.status?.message ? { message: span.status.message } : {}) },
    attributes: span.attributes,
    resource: { attributes: { 'service.name': span.serviceName, 'telemetry.sdk.language': 'nodejs' } },
  };
}

export interface OpenSearchSpanSink extends SpanSink {
  endpoint: string;
  /** The throwaway index the spans are written to; the server's `indexes.traces` is `${index}*`. */
  index: string;
  size(): number;
  close(): Promise<void>;
}

export async function startOpenSearchSpanSink(endpoint: string): Promise<OpenSearchSpanSink> {
  const client: Client = createRawOpenSearchClient(endpoint);
  const data = new RawOpenSearchTestData(client);
  const index = await data.createThrowawayIndex('otel-v1-apm-span', SPAN_INDEX_BODY);
  let pending: Promise<unknown>[] = [];
  let count = 0;
  return {
    endpoint,
    index,
    putSpan(span) {
      count++;
      pending.push(client.index({ index, id: span.spanId, body: toOpenSearchSpanDoc(span) }));
    },
    async flush() {
      const batch = pending; pending = [];
      await Promise.all(batch);
      await client.indices.refresh({ index });
    },
    size: () => count,
    async close() {
      await Promise.allSettled(pending);
      await data.cleanup();
    },
  };
}
