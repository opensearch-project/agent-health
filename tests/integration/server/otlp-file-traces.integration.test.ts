/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test: OTLP/JSON ingest → file trace store → read-back.
 *
 * Exercises the real stack (no mocks): the embedded `POST /v1/traces` receiver,
 * the OTLP transform, the on-disk `TraceStore`, the `FileObservabilityModule`,
 * and the `/api/traces` + `/api/traces/health` read routes — all in file mode
 * (no OpenSearch cluster configured). Writes go to a throwaway temp dir.
 */

import express, { Express } from 'express';
import request from 'supertest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import otlpReceiverRoutes from '@/server/routes/otlpReceiver';
import tracesRoutes from '@/server/routes/traces';

const TRACE_ID = 'aaaa0000bbbb1111cccc2222dddd3333';

function otlpPayload(opts: { traceId?: string; runId?: string; sessionId?: string; service?: string; spanId?: string } = {}) {
  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: opts.service || 'local-agent' } }] },
        scopeSpans: [
          {
            scope: { name: 'test.tracer' },
            spans: [
              {
                traceId: opts.traceId || TRACE_ID,
                spanId: opts.spanId || '1111222233334444',
                name: 'chat',
                kind: 3,
                startTimeUnixNano: '1700000000000000000',
                endTimeUnixNano: '1700000001000000000',
                attributes: [
                  ...(opts.runId ? [{ key: 'agent_health.run.id', value: { stringValue: opts.runId } }] : []),
                  ...(opts.sessionId ? [{ key: 'session.id', value: { stringValue: opts.sessionId } }] : []),
                  { key: 'gen_ai.request.model', value: { stringValue: 'synthetic-model' } },
                ],
                status: { code: 1 },
              },
            ],
          },
        ],
      },
    ],
  };
}

describe('OTLP file-trace round-trip (integration)', () => {
  let app: Express;
  let dir: string;
  const saved: Record<string, string | undefined> = {};
  const OBS_ENV = ['OPENSEARCH_LOGS_ENDPOINT', 'OPENSEARCH_LOGS_USERNAME', 'OPENSEARCH_LOGS_PASSWORD', 'AGENT_HEALTH_DATA_DIR'];

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'otlp-int-'));
    for (const k of OBS_ENV) saved[k] = process.env[k];
    // File mode: no observability cluster; writes land in the temp dir.
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

  it('persists ingested spans and returns them by traceId (backend=file)', async () => {
    await request(app).post('/v1/traces').send(otlpPayload()).expect(200);

    const res = await request(app).post('/api/traces').send({ traceId: TRACE_ID }).expect(200);
    expect(res.body.backend).toBe('file');
    const ids = res.body.spans.map((s: any) => s.spanId);
    expect(ids).toContain('1111222233334444');
    expect(res.body.spans[0].attributes['service.name']).toBe('local-agent');

    const canonical = path.join(dir, 'traces', `trace-${TRACE_ID}.ndjson`);
    const records = (await fs.readFile(canonical, 'utf8')).trim().split('\n').map(JSON.parse);
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual(expect.objectContaining({
      spanId: '1111222233334444', kind: 3, durationMs: 1000,
      'service.name': 'local-agent', 'gen_ai.request.model': 'synthetic-model',
    }));
    expect(records[0].raw.attributes['service.name']).toBe('local-agent');
  });

  it('correlates by runId (agent_health.run.id == runId)', async () => {
    await request(app)
      .post('/v1/traces')
      .send(otlpPayload({ traceId: 'beef0000beef0000beef0000beef0000', spanId: 'cafe000000000001', runId: 'run-xyz' }))
      .expect(200);

    const res = await request(app).post('/api/traces').send({ runIds: ['run-xyz'] }).expect(200);
    expect(res.body.backend).toBe('file');
    expect(res.body.spans.some((s: any) => s.spanId === 'cafe000000000001')).toBe(true);
  });

  it('correlates runIds directly to session.id and stores a per-session file', async () => {
    const runId = 'run-session-direct';
    await request(app)
      .post('/v1/traces')
      .send(otlpPayload({ traceId: 'cccc0000cccc0000cccc0000cccc0000', spanId: 'cafe000000000002', sessionId: runId }))
      .expect(200);

    const res = await request(app).post('/api/traces').send({ runIds: [runId] }).expect(200);
    expect(res.body.spans.map((s: any) => s.spanId)).toContain('cafe000000000002');
    await expect(fs.stat(path.join(dir, 'traces', `session-${runId}.ndjson`))).resolves.toBeDefined();
  });

  it('reports the file backend on /api/traces/health', async () => {
    const res = await request(app).get('/api/traces/health').expect(200);
    expect(res.body.backend).toBe('file');
    expect(res.body.status).toBe('ok');
  });

  it('does NOT persist while an OpenSearch cluster is configured (no split-brain)', async () => {
    process.env.OPENSEARCH_LOGS_ENDPOINT = 'https://example-cluster:9200';
    try {
      await request(app)
        .post('/v1/traces')
        .send(otlpPayload({ traceId: 'dddd0000dddd0000dddd0000dddd0000', spanId: 'feed000000000001' }))
        .expect(200);
    } finally {
      delete process.env.OPENSEARCH_LOGS_ENDPOINT;
    }

    // Back in file mode, that trace was never written to disk.
    const res = await request(app).post('/api/traces').send({ traceId: 'dddd0000dddd0000dddd0000dddd0000' }).expect(200);
    expect(res.body.spans.filter((s: any) => s.spanId === 'feed000000000001')).toHaveLength(0);
  });
});
