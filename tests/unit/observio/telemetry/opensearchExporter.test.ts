/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for observio-sample-agent OpenSearch span exporter.
 *
 * Verifies span-to-document conversion, bulk export behavior,
 * and error handling.
 */

import { SpanKind, SpanStatusCode, TraceFlags } from '@opentelemetry/api';
import { ExportResultCode } from '@opentelemetry/core';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-node';

// Mock the OpenSearch client
const mockBulk = jest.fn();
const mockClose = jest.fn().mockResolvedValue(undefined);

// Use manual mock factory — Jest resolves from test file location (root node_modules)
jest.mock('@opensearch-project/opensearch', () => ({
  Client: jest.fn().mockImplementation(() => ({
    bulk: mockBulk,
    close: mockClose,
  })),
}));

// The observio exporter file resolves @opensearch-project/opensearch from its own node_modules.
// We need to tell Jest to use our mock for that path too.
jest.mock(
  require.resolve('@opensearch-project/opensearch', {
    paths: [require('path').join(__dirname, '../../../../observio-sample-agent/src/telemetry')],
  }),
  () => ({
    Client: jest.fn().mockImplementation(() => ({
      bulk: mockBulk,
      close: mockClose,
    })),
  })
);

import { OpenSearchSpanExporter } from '@/observio-sample-agent/src/telemetry/opensearchExporter';

/** Promisify the export callback */
function exportSpans(exporter: OpenSearchSpanExporter, spans: ReadableSpan[]): Promise<{ code: number }> {
  return new Promise((resolve) => {
    exporter.export(spans, (result) => resolve(result));
  });
}

function createMockSpan(overrides: Partial<ReadableSpan> = {}): ReadableSpan {
  return {
    spanContext: () => ({
      traceId: 'abc123def456789012345678abcdef00',
      spanId: '1234567890abcdef',
      traceFlags: TraceFlags.SAMPLED,
    }),
    parentSpanContext: undefined,
    name: 'test-span',
    kind: SpanKind.INTERNAL,
    startTime: [1700000000, 0], // seconds, nanos
    endTime: [1700000001, 500000000], // 1.5s later
    status: { code: SpanStatusCode.OK, message: '' },
    attributes: {
      'gen_ai.system': 'anthropic',
      'gen_ai.operation.name': 'invoke_agent',
    },
    resource: {
      attributes: {
        'service.name': 'observio-sample-agent',
        'telemetry.sdk.language': 'nodejs',
      },
    },
    events: [],
    links: [],
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
    instrumentationScope: { name: 'observio-sample-agent', version: '1.0.0' },
    duration: [1, 500000000],
    ended: true,
    ...overrides,
  } as unknown as ReadableSpan;
}

describe('OpenSearchSpanExporter', () => {
  let exporter: OpenSearchSpanExporter;
  let consoleSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    exporter = new OpenSearchSpanExporter({
      endpoint: 'https://localhost:9200',
      username: 'admin',
      password: 'admin',
      indexName: 'otel-v1-apm-span-000001',
      tlsSkipVerify: true,
    });
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  describe('constructor', () => {
    it('initializes with provided config', () => {
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('OpenSearch exporter initialized')
      );
    });

    it('uses default index name when not provided', () => {
      const defaultExporter = new OpenSearchSpanExporter({
        endpoint: 'https://localhost:9200',
      });
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('otel-v1-apm-span-000001')
      );
    });
  });

  describe('export', () => {
    it('exports spans via bulk API', async () => {
      mockBulk.mockResolvedValueOnce({ body: { errors: false, items: [] } });

      const span = createMockSpan();
      const result = await exportSpans(exporter, [span]);

      expect(result.code).toBe(ExportResultCode.SUCCESS);
      expect(mockBulk).toHaveBeenCalledTimes(1);
      const body = mockBulk.mock.calls[0][0].body;
      expect(body).toHaveLength(2); // [indexAction, document]
      expect(body[0].index._index).toBe('otel-v1-apm-span-000001');
      expect(body[1].traceId).toBe('abc123def456789012345678abcdef00');
      expect(body[1].spanId).toBe('1234567890abcdef');
      expect(body[1].name).toBe('test-span');
      expect(body[1].serviceName).toBe('observio-sample-agent');
    });

    it('handles empty span array', async () => {
      const result = await exportSpans(exporter, []);
      expect(result.code).toBe(ExportResultCode.SUCCESS);
      expect(mockBulk).not.toHaveBeenCalled();
    });

    it('returns FAILED on bulk API error', async () => {
      mockBulk.mockRejectedValueOnce(new Error('Connection refused'));

      const span = createMockSpan();
      const result = await exportSpans(exporter, [span]);
      expect(result.code).toBe(ExportResultCode.FAILED);
    });

    it('logs warning on partial bulk errors', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
      mockBulk.mockResolvedValueOnce({
        body: {
          errors: true,
          items: [
            { index: { error: { type: 'mapper_parsing_exception', reason: 'field type conflict' } } },
          ],
        },
      });

      const span = createMockSpan();
      const result = await exportSpans(exporter, [span]);

      expect(result.code).toBe(ExportResultCode.SUCCESS);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('bulk write had 1 error(s)'),
        expect.any(String)
      );
      warnSpy.mockRestore();
    });

    it('returns FAILED after shutdown', async () => {
      await exporter.shutdown();

      const span = createMockSpan();
      const result = await exportSpans(exporter, [span]);
      expect(result.code).toBe(ExportResultCode.FAILED);
      expect(mockBulk).not.toHaveBeenCalled();
    });
  });

  describe('span document format', () => {
    it('flattens attributes with @ separator', async () => {
      mockBulk.mockResolvedValueOnce({ body: { errors: false, items: [] } });

      const span = createMockSpan();
      await exportSpans(exporter, [span]);

      const doc = mockBulk.mock.calls[0][0].body[1];
      expect(doc['span.attributes.gen_ai@system']).toBe('anthropic');
      expect(doc['span.attributes.gen_ai@operation@name']).toBe('invoke_agent');
      expect(doc['resource.attributes.service@name']).toBe('observio-sample-agent');
    });

    it('sets traceGroup for root spans (no parent)', async () => {
      mockBulk.mockResolvedValueOnce({ body: { errors: false, items: [] } });

      const span = createMockSpan({ parentSpanContext: undefined });
      await exportSpans(exporter, [span]);

      const doc = mockBulk.mock.calls[0][0].body[1];
      expect(doc.traceGroup).toBe('test-span');
      expect(doc.traceGroupFields).toBeDefined();
      expect(doc.traceGroupFields.statusCode).toBe(1); // OK
    });

    it('does not set traceGroup for child spans', async () => {
      mockBulk.mockResolvedValueOnce({ body: { errors: false, items: [] } });

      const span = createMockSpan({
        parentSpanContext: {
          spanId: 'aaaaaaaaaaaaaaaa',
          traceId: 'abc123def456789012345678abcdef00',
          traceFlags: TraceFlags.SAMPLED,
        } as any,
      });
      await exportSpans(exporter, [span]);

      const doc = mockBulk.mock.calls[0][0].body[1];
      expect(doc.traceGroup).toBeUndefined();
      expect(doc.traceGroupFields).toBeUndefined();
    });

    it('converts span kind to string format', async () => {
      mockBulk.mockResolvedValueOnce({ body: { errors: false, items: [] } });

      const span = createMockSpan({ kind: SpanKind.SERVER });
      await exportSpans(exporter, [span]);

      const doc = mockBulk.mock.calls[0][0].body[1];
      expect(doc.kind).toBe('SPAN_KIND_SERVER');
    });

    it('includes events with flattened attribute keys', async () => {
      mockBulk.mockResolvedValueOnce({ body: { errors: false, items: [] } });

      const span = createMockSpan({
        events: [{
          name: 'gen_ai.content.prompt',
          time: [1700000000, 100000000],
          attributes: { 'gen_ai.prompt.text': 'hello' },
          droppedAttributesCount: 0,
        }],
      });
      await exportSpans(exporter, [span]);

      const doc = mockBulk.mock.calls[0][0].body[1];
      expect(doc.events).toHaveLength(1);
      expect(doc.events[0].name).toBe('gen_ai.content.prompt');
      expect(doc.events[0].attributes['gen_ai@prompt@text']).toBe('hello');
    });

    it('generates doc ID from traceId/spanId', async () => {
      mockBulk.mockResolvedValueOnce({ body: { errors: false, items: [] } });

      const span = createMockSpan();
      await exportSpans(exporter, [span]);

      const indexAction = mockBulk.mock.calls[0][0].body[0];
      expect(indexAction.index._id).toBe('abc123def456789012345678abcdef00/1234567890abcdef');
    });
  });

  describe('shutdown', () => {
    it('closes the OpenSearch client', async () => {
      await exporter.shutdown();
      expect(mockClose).toHaveBeenCalled();
    });
  });
});
