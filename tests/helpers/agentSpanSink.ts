/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Where a synthetic agent's OpenTelemetry spans land, so one agent fixture
 * (tests/helpers/demoRetrievalAgentStub.ts) can drive BOTH observability
 * sources agent-health reads traces from:
 *   - CloudWatch: the Transaction Search `aws/spans` log group, served by the
 *     local CloudWatch Logs API stub (tests/helpers/cloudWatchLogsStub.ts);
 *   - OpenSearch: a Data Prepper `otel-v1-apm-span-*` index on a REAL
 *     OpenSearch node (tests/helpers/openSearchSpanIndex.ts).
 *
 * The span shape is the OTLP-ish one both writers map from; each sink turns it
 * into the record its backend stores.
 */

export interface AgentSpanInput {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: 'SERVER' | 'CLIENT' | 'INTERNAL' | 'PRODUCER' | 'CONSUMER';
  serviceName: string;
  startMs: number;
  endMs: number;
  attributes: Record<string, unknown>;
  status?: { code: 'OK' | 'ERROR' | 'UNSET'; message?: string };
}

export interface AgentSpanSink {
  /** `'cloudwatch'` | `'opensearch'` — what `/api/traces` reports as `backend`. */
  readonly backend: 'cloudwatch' | 'opensearch';
  /** Persist the spans of one agent invocation; resolved once a reader can see them. */
  putSpans(spans: AgentSpanInput[]): Promise<void>;
  /** Number of span records held. */
  size(): number;
  close(): Promise<void>;
}
