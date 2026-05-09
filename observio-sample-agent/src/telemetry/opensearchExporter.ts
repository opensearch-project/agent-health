/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Custom OpenSearch Span Exporter for the Observio agent.
 *
 * Writes OTel spans directly to an OpenSearch cluster using bulk API.
 * Formats spans in OSIS-compatible format (flattened attributes with @ separator).
 */

import { SpanExporter, ReadableSpan } from '@opentelemetry/sdk-trace-node';
import { ExportResult, ExportResultCode } from '@opentelemetry/core';
import { SpanKind, SpanStatusCode, HrTime } from '@opentelemetry/api';
import { Client } from '@opensearch-project/opensearch';

export interface OpenSearchExporterConfig {
  endpoint: string;
  username?: string;
  password?: string;
  indexName?: string;
  tlsSkipVerify?: boolean;
}

function hrTimeToDate(hrTime: HrTime): string {
  const ms = hrTime[0] * 1000 + hrTime[1] / 1_000_000;
  return new Date(ms).toISOString();
}

function hrTimeToNanos(hrTime: HrTime): number {
  return hrTime[0] * 1_000_000_000 + hrTime[1];
}

function durationNanos(start: HrTime, end: HrTime): number {
  return hrTimeToNanos(end) - hrTimeToNanos(start);
}

function flattenKey(key: string): string {
  return key.replace(/\./g, '@');
}

function spanKindToString(kind: SpanKind): string {
  switch (kind) {
    case SpanKind.INTERNAL: return 'SPAN_KIND_INTERNAL';
    case SpanKind.SERVER: return 'SPAN_KIND_SERVER';
    case SpanKind.CLIENT: return 'SPAN_KIND_CLIENT';
    case SpanKind.PRODUCER: return 'SPAN_KIND_PRODUCER';
    case SpanKind.CONSUMER: return 'SPAN_KIND_CONSUMER';
    default: return 'SPAN_KIND_INTERNAL';
  }
}

function statusCodeToInt(code: SpanStatusCode): number {
  switch (code) {
    case SpanStatusCode.UNSET: return 0;
    case SpanStatusCode.OK: return 1;
    case SpanStatusCode.ERROR: return 2;
    default: return 0;
  }
}

function spanToDocument(span: ReadableSpan): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    traceId: span.spanContext().traceId,
    spanId: span.spanContext().spanId,
    parentSpanId: (span.parentSpanContext?.spanId && span.parentSpanContext.spanId !== '0000000000000000')
      ? span.parentSpanContext.spanId : '',
    name: span.name,
    kind: spanKindToString(span.kind),
    startTime: hrTimeToDate(span.startTime),
    endTime: hrTimeToDate(span.endTime),
    durationInNanos: durationNanos(span.startTime, span.endTime),
    'status.code': statusCodeToInt(span.status.code),
    'status.message': span.status.message || '',
    traceState: '',
    droppedAttributesCount: span.droppedAttributesCount,
    droppedEventsCount: span.droppedEventsCount,
    droppedLinksCount: span.droppedLinksCount,
  };

  for (const [key, value] of Object.entries(span.attributes)) {
    if (value !== undefined) {
      doc[`span.attributes.${flattenKey(key)}`] = value;
    }
  }

  const resource = span.resource;
  if (resource?.attributes) {
    for (const [key, value] of Object.entries(resource.attributes)) {
      if (value !== undefined) {
        doc[`resource.attributes.${flattenKey(key)}`] = value;
      }
    }
  }

  const serviceName = resource?.attributes?.['service.name'] || 'unknown';
  doc.serviceName = serviceName;

  const scope = (span as any).instrumentationScope ?? (span as any).instrumentationLibrary ?? {};
  doc['instrumentationScope.name'] = scope.name || '';
  if (scope.version) {
    doc['instrumentationScope.version'] = scope.version;
  }

  if (span.events.length > 0) {
    doc.events = span.events.map(event => {
      const eventDoc: Record<string, unknown> = {
        name: event.name,
        time: hrTimeToDate(event.time),
        droppedAttributesCount: event.droppedAttributesCount || 0,
      };
      if (event.attributes) {
        const attrs: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(event.attributes)) {
          if (value !== undefined) {
            attrs[flattenKey(key)] = value;
          }
        }
        eventDoc.attributes = attrs;
      }
      return eventDoc;
    });
  } else {
    doc.events = [];
  }

  if (span.links.length > 0) {
    doc.links = span.links.map(link => ({
      traceId: link.context.traceId,
      spanId: link.context.spanId,
      traceState: link.context.traceState?.serialize() || '',
      attributes: link.attributes || {},
      droppedAttributesCount: link.droppedAttributesCount || 0,
    }));
  } else {
    doc.links = [];
  }

  const hasRealParent = span.parentSpanContext?.spanId && span.parentSpanContext.spanId !== '0000000000000000';
  if (!hasRealParent) {
    doc.traceGroup = span.name;
    doc.traceGroupFields = {
      endTime: hrTimeToDate(span.endTime),
      durationInNanos: durationNanos(span.startTime, span.endTime),
      statusCode: statusCodeToInt(span.status.code),
    };
  }

  return doc;
}

export class OpenSearchSpanExporter implements SpanExporter {
  private client: Client;
  private indexName: string;
  private shutdownRequested = false;

  constructor(config: OpenSearchExporterConfig) {
    this.client = new Client({
      node: config.endpoint,
      auth: config.username && config.password
        ? { username: config.username, password: config.password }
        : undefined,
      ssl: {
        rejectUnauthorized: config.tlsSkipVerify !== true,
      },
    });

    this.indexName = config.indexName || 'otel-v1-apm-span-000001';
    console.log(`[Telemetry] OpenSearch exporter initialized → ${config.endpoint} (index: ${this.indexName})`);
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    if (this.shutdownRequested) {
      resultCallback({ code: ExportResultCode.FAILED });
      return;
    }

    this._export(spans)
      .then(() => resultCallback({ code: ExportResultCode.SUCCESS }))
      .catch((err) => {
        console.error('[Telemetry] OpenSearch export failed:', err instanceof Error ? err.message : err);
        resultCallback({ code: ExportResultCode.FAILED });
      });
  }

  private async _export(spans: ReadableSpan[]): Promise<void> {
    if (spans.length === 0) return;

    const body: Array<Record<string, unknown>> = [];
    for (const span of spans) {
      const doc = spanToDocument(span);
      const docId = `${doc.traceId}/${doc.spanId}`;
      body.push({ index: { _index: this.indexName, _id: docId } });
      body.push(doc);
    }

    const response = await this.client.bulk({ body });

    if (response.body.errors) {
      const errors = response.body.items
        .filter((item: any) => item.index?.error)
        .map((item: any) => `${item.index.error.type}: ${item.index.error.reason}`);
      if (errors.length > 0) {
        console.warn(`[Telemetry] OpenSearch bulk write had ${errors.length} error(s):`, errors[0]);
      }
    } else {
      console.log(`[Telemetry] Exported ${spans.length} span(s) to OpenSearch`);
    }
  }

  async shutdown(): Promise<void> {
    this.shutdownRequested = true;
    await this.client.close();
  }

  async forceFlush(): Promise<void> {
    // No buffering — exports are immediate via bulk API
  }
}
