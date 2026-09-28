/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test: the `/api/traces` response carries a top-level `kind`
 * (canonical `INTERNAL|SERVER|CLIENT|PRODUCER|CONSUMER`) regardless of how
 * the ingest pipeline encoded the OTel SpanKind.
 *
 * Regression: spans read from the OpenSearch pipeline had `attributes.spanKind`
 * set (e.g. `SPAN_KIND_SERVER`) but no usable top-level `kind`, and spans
 * ingested through the OTLP receiver dropped the kind entirely.
 *
 *   - Part A drives the REAL route stack in file mode: `POST /v1/traces`
 *     (numeric kind and proto-enum-name kind) → on-disk store → `POST /api/traces`.
 *   - Part B drives the OpenSearch reader (`fetchTraces` → `transformSpan`)
 *     against a fake client returning Data Prepper-shaped docs with a string
 *     kind, a numeric kind, and a doc whose kind only lives in `span.kind`.
 */

import express, { Express } from 'express';
import request from 'supertest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import otlpReceiverRoutes from '@/server/routes/otlpReceiver';
import tracesRoutes from '@/server/routes/traces';
import { fetchTraces } from '@/server/services/tracesService';

const TRACE_ID = 'abcd0000abcd0000abcd0000abcd0000';

function otlpPayload(spans: Array<{ spanId: string; name: string; kind: number | string }>) {
  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'retrieval-agent' } }] },
        scopeSpans: [
          {
            scope: { name: 'test.tracer' },
            spans: spans.map((s) => ({
              traceId: TRACE_ID,
              spanId: s.spanId,
              name: s.name,
              kind: s.kind,
              startTimeUnixNano: '1700000000000000000',
              endTimeUnixNano: '1700000001000000000',
              attributes: [],
              status: { code: 1 },
            })),
          },
        ],
      },
    ],
  };
}

describe('/api/traces exposes a normalised top-level span kind (integration)', () => {
  describe('Part A — OTLP receiver → file store → /api/traces (real routes)', () => {
    let app: Express;
    let dir: string;
    const saved: Record<string, string | undefined> = {};
    const OBS_ENV = ['OPENSEARCH_LOGS_ENDPOINT', 'OPENSEARCH_LOGS_USERNAME', 'OPENSEARCH_LOGS_PASSWORD', 'AGENT_HEALTH_DATA_DIR'];

    beforeAll(async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'spankind-int-'));
      for (const k of OBS_ENV) saved[k] = process.env[k];
      delete process.env.OPENSEARCH_LOGS_ENDPOINT;
      delete process.env.OPENSEARCH_LOGS_USERNAME;
      delete process.env.OPENSEARCH_LOGS_PASSWORD;
      process.env.AGENT_HEALTH_DATA_DIR = dir;

      app = express();
      app.use(express.json({ limit: '10mb' }));
      app.use(otlpReceiverRoutes);
      app.use(tracesRoutes);
    });

    afterAll(async () => {
      for (const k of OBS_ENV) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      await fs.rm(dir, { recursive: true, force: true });
    });

    it('returns kind for numeric (OTLP enum) and string (proto enum name) inputs', async () => {
      await request(app)
        .post('/v1/traces')
        .send(otlpPayload([
          { spanId: '0000000000000001', name: 'POST /ask', kind: 2 },                 // SERVER
          { spanId: '0000000000000002', name: 'chat', kind: 'SPAN_KIND_CLIENT' },    // CLIENT
          { spanId: '0000000000000003', name: 'execute_tool search', kind: 1 },      // INTERNAL
          { spanId: '0000000000000004', name: 'unspecified', kind: 0 },              // no kind
        ]))
        .expect(200);

      const res = await request(app).post('/api/traces').send({ traceId: TRACE_ID }).expect(200);
      expect(res.body.backend).toBe('file');
      const byId = Object.fromEntries(res.body.spans.map((s: any) => [s.spanId, s]));

      expect(byId['0000000000000001'].kind).toBe('SERVER');
      expect(byId['0000000000000002'].kind).toBe('CLIENT');
      expect(byId['0000000000000003'].kind).toBe('INTERNAL');
      expect(byId['0000000000000004'].kind).toBeUndefined();
      // The attribute mirror the flat attribute table reads is the canonical name too.
      expect(byId['0000000000000001'].attributes.spanKind).toBe('SERVER');
    });
  });

  describe('Part B — OpenSearch reader (Data Prepper-shaped docs)', () => {
    const DOCS: Record<string, any>[] = [
      {
        traceId: 'trace-K', spanId: 'root', parentSpanId: '', name: 'POST /ask',
        kind: 'SPAN_KIND_SERVER', serviceName: 'retrieval-agent',
        startTime: '2026-06-17T09:00:00.000000000Z', endTime: '2026-06-17T09:00:03.000000000Z',
        durationInNanos: 3_000_000_000, status: { code: 1 }, attributes: {},
      },
      {
        traceId: 'trace-K', spanId: 'llm', parentSpanId: 'root', name: 'chat',
        kind: 3, serviceName: 'retrieval-agent',
        startTime: '2026-06-17T09:00:00.000000000Z', endTime: '2026-06-17T09:00:01.000000000Z',
        durationInNanos: 1_000_000_000, status: { code: 1 }, attributes: {},
      },
      {
        // No top-level kind at all; the pipeline only copied it into an attribute.
        traceId: 'trace-K', spanId: 'tool', parentSpanId: 'root', name: 'execute_tool search',
        serviceName: 'retrieval-agent',
        startTime: '2026-06-17T09:00:01.000000000Z', endTime: '2026-06-17T09:00:02.000000000Z',
        durationInNanos: 1_000_000_000, status: { code: 1 },
        attributes: { 'span.kind': 'Internal' },
      },
      {
        traceId: 'trace-K', spanId: 'nokind', parentSpanId: 'root', name: 'mystery',
        serviceName: 'retrieval-agent',
        startTime: '2026-06-17T09:00:02.000000000Z', endTime: '2026-06-17T09:00:02.500000000Z',
        durationInNanos: 500_000_000, status: { code: 1 }, attributes: {},
      },
    ];

    function fakeClient() {
      const search = jest.fn(async () => ({
        body: { hits: { hits: DOCS.map((_source) => ({ _source })), total: { value: DOCS.length } } },
      }));
      return { search } as any;
    }

    it('normalises string, numeric and attribute-only kinds; omits kind when unknown', async () => {
      const result = await fetchTraces({ traceId: 'trace-K' }, fakeClient());
      const byId = Object.fromEntries(result.spans.map((s: any) => [s.spanId, s]));

      expect(byId.root.kind).toBe('SERVER');
      expect(byId.llm.kind).toBe('CLIENT');
      expect(byId.tool.kind).toBe('INTERNAL');
      expect(byId.nokind.kind).toBeUndefined();
      // The attribute table reads the same canonical name as the OTLP path.
      expect(byId.root.attributes.spanKind).toBe('SERVER');
    });
  });
});
