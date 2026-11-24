/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test (#653 / #652): trace-derived metrics count a roll-up
 * parent's usage ONCE, through the real HTTP path.
 *
 * Real stack, no mocks: the embedded `POST /v1/traces` OTLP receiver → the
 * on-disk `TraceStore` → `FileObservabilityModule` → `GET /api/metrics/:runId`
 * and `POST /api/metrics/batch` (the exact request the Comparison page sends:
 * keyed by `report.runId`, with per-key `sessionIds` / `traceIds` maps).
 *
 * The ingested trace is the real-world shape that produced the 2× bug: an
 * `invoke_agent` span stamped with the sum of its three `chat` children. A
 * second key with NO spans must come back as the honest `pending /
 * hasSpans:false` placeholder, never as zeros that look measured.
 */

import express, { Express } from 'express';
import request from 'supertest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import otlpReceiverRoutes from '@/server/routes/otlpReceiver';
import metricsRoutes from '@/server/routes/metrics';
import { buildAgentTraceWithRollup, rollupSpansAsOtlp, ROLLUP_FIXTURE } from '../../helpers/agentTraceWithRollup';

const RUN_ID = 'req-rollup-0001';
const TRACE_ID = 'abcd0000abcd0000abcd0000abcd0001';
const UNTRACED_RUN_ID = 'req-untraced-0002';

describe('/api/metrics leaf-usage invariant over the real OTLP → file store → route path (integration)', () => {
  let app: Express;
  let dir: string;
  const saved: Record<string, string | undefined> = {};
  const OBS_ENV = ['OPENSEARCH_LOGS_ENDPOINT', 'OPENSEARCH_LOGS_USERNAME', 'OPENSEARCH_LOGS_PASSWORD', 'AGENT_HEALTH_DATA_DIR'];

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'metrics-rollup-int-'));
    for (const k of OBS_ENV) saved[k] = process.env[k];
    delete process.env.OPENSEARCH_LOGS_ENDPOINT;
    delete process.env.OPENSEARCH_LOGS_USERNAME;
    delete process.env.OPENSEARCH_LOGS_PASSWORD;
    process.env.AGENT_HEALTH_DATA_DIR = dir;

    app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use(otlpReceiverRoutes);
    app.use(metricsRoutes);

    const spans = buildAgentTraceWithRollup({ runId: RUN_ID, traceId: TRACE_ID, serviceName: 'demo-agent' });
    await request(app).post('/v1/traces').send(rollupSpansAsOtlp(spans)).expect(200);
  });

  afterAll(async () => {
    for (const k of OBS_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('GET /api/metrics/:runId — an invoke_agent roll-up over 3 chat children reads 1× tokens and 3 LLM calls (not 2×, 4)', async () => {
    const res = await request(app).get(`/api/metrics/${RUN_ID}`).expect(200);
    expect(res.body.hasSpans).toBe(true);
    expect(res.body.status).toBe('success');
    expect(res.body.inputTokens).toBe(ROLLUP_FIXTURE.inputTokens);
    expect(res.body.outputTokens).toBe(ROLLUP_FIXTURE.outputTokens);
    expect(res.body.totalTokens).toBe(ROLLUP_FIXTURE.totalTokens);
    expect(res.body.totalTokens).not.toBe(ROLLUP_FIXTURE.doubleCountedTotalTokens);
    expect(res.body.llmCalls).toBe(ROLLUP_FIXTURE.llmCalls);
    expect(res.body.toolCalls).toBe(ROLLUP_FIXTURE.toolCalls);
    expect(res.body.costUsd).toBeCloseTo((ROLLUP_FIXTURE.inputTokens * 3 + ROLLUP_FIXTURE.outputTokens * 15) / 1e6, 10);
  });

  it('POST /api/metrics/batch keyed as the Comparison page keys it (report.runId + sessionIds/traceIds maps) — same numbers; a key with no spans is pending, never zeros-as-data', async () => {
    const res = await request(app)
      .post('/api/metrics/batch')
      .send({
        runIds: [RUN_ID, UNTRACED_RUN_ID],
        sessionIds: { [RUN_ID]: RUN_ID },
        traceIds: { [RUN_ID]: TRACE_ID },
      })
      .expect(200);
    const byKey = new Map<string, any>(res.body.metrics.map((m: any) => [m.runId, m]));

    const traced = byKey.get(RUN_ID);
    expect(traced.hasSpans).toBe(true);
    expect(traced.totalTokens).toBe(ROLLUP_FIXTURE.totalTokens);
    expect(traced.llmCalls).toBe(ROLLUP_FIXTURE.llmCalls);
    expect(traced.correlatedBy).toBe('ids');

    const untraced = byKey.get(UNTRACED_RUN_ID);
    expect(untraced.status).toBe('pending');
    expect(untraced.hasSpans).toBe(false);
    expect(untraced.error).toBeUndefined();
  });

  it('GET and batch agree with each other for the same key (one invariant, every consumer)', async () => {
    const single = (await request(app).get(`/api/metrics/${RUN_ID}`).expect(200)).body;
    const batch = (await request(app).post('/api/metrics/batch').send({ runIds: [RUN_ID] }).expect(200)).body.metrics[0];
    expect(batch.totalTokens).toBe(single.totalTokens);
    expect(batch.llmCalls).toBe(single.llmCalls);
    expect(batch.costUsd).toBeCloseTo(single.costUsd, 10);
  });
});
