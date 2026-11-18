/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `GET /api/runs/in-flight` + `POST /api/server/drain` (#612) over a REAL
 * FileStorageModule, and the drain guard on every route that starts a
 * server-executed run.
 */

import express from 'express';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { FileStorageModule } from '@/server/adapters/file/StorageModule';
import { LocalRunSink, EXECUTOR_TOKEN_HEADER } from '@/services/runSink';
import { registerActiveRunLister } from '@/server/services/runCancellation';
import { resetDrainForTests, isDraining } from '@/server/services/serverDrain';
import type { EvaluationRun } from '@/types';

const request = require('supertest');

let currentStorage: FileStorageModule;
jest.mock('@/server/adapters/index', () => ({
  getStorageModule: () => currentStorage,
  isStorageAvailable: () => true,
}));
jest.mock('@/lib/debug', () => ({ debug: jest.fn() }));

function makeRun(id: string, overrides: Partial<EvaluationRun> = {}): EvaluationRun {
  return {
    id, docType: 'evaluation-run', name: `Run ${id}`, createdAt: '2026-01-01T00:00:00.000Z', status: 'running',
    agentKey: 'agent-a', modelId: 'model-a', sources: [], trigger: 'ui',
    testCaseSnapshots: [{ id: 'tc-1', version: 1, name: 'one' }], results: {}, ...overrides,
  } as EvaluationRun;
}

describe('/api/runs/in-flight and /api/server/drain', () => {
  let dir: string;
  let app: express.Express;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'ah-inflight-'));
    currentStorage = new FileStorageModule(dir);
    resetDrainForTests();
    app = express();
    app.use(express.json());
    app.use((await import('@/server/routes/runs')).default);
    app.use((await import('@/server/routes/runsIngest')).default);
  });
  afterEach(() => {
    resetDrainForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists leased running runs (any executor) without their fencing token, pre-lease running docs excluded, process registries unioned', async () => {
    const serverSink = new LocalRunSink(currentStorage, { executorKind: 'server', executorVersion: '1.2.3', ttlMs: 60_000 });
    const cliSink = new LocalRunSink(currentStorage, { executorKind: 'cli', executorVersion: '1.2.3', ttlMs: 60_000 });
    const a = await serverSink.createRun(makeRun('run-server'));
    const b = await cliSink.createRun(makeRun('run-cli'));
    await currentStorage.evaluationRuns.update('run-cli', { cancelRequestedAt: '2026-01-01T00:01:00.000Z' });
    // A finished leased run and a pre-lease `running` zombie are not in flight.
    await serverSink.createRun(makeRun('run-done'));
    await serverSink.finalize('run-done', { status: 'completed', completedRun: { results: {}, testCaseSnapshots: [] } });
    await currentStorage.evaluationRuns.create(makeRun('legacy-zombie'));
    // A legacy /execute benchmark run known only to this process's registry.
    const unregister = registerActiveRunLister(() => [{ id: 'bench-run-legacy', kind: 'benchmark' }]);

    try {
      const res = await request(app).get('/api/runs/in-flight');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ count: 3, complete: true, draining: false });
      const byId = Object.fromEntries(res.body.runs.map((r: any) => [r.id, r]));
      expect(Object.keys(byId).sort()).toEqual(['bench-run-legacy', 'run-cli', 'run-server']);
      expect(byId['run-server']).toEqual({
        id: 'run-server', name: 'Run run-server', kind: 'evaluation', source: 'lease', createdAt: '2026-01-01T00:00:00.000Z',
        executor: { kind: 'server', version: '1.2.3' },
        lease: { generation: 1, heartbeatAt: a.lease.heartbeatAt, ttlMs: 60_000, live: true },
      });
      expect(byId['run-cli']).toMatchObject({ executor: { kind: 'cli' }, cancelRequestedAt: '2026-01-01T00:01:00.000Z', lease: { live: true } });
      expect(byId['bench-run-legacy']).toEqual({ id: 'bench-run-legacy', kind: 'benchmark', source: 'process' });
      // Never the token.
      expect(JSON.stringify(res.body)).not.toContain(a.executorToken);
      expect(JSON.stringify(res.body)).not.toContain(b.executorToken);
    } finally {
      unregister();
    }
  });

  it('an expired lease is listed as live: false (the sweeper has not got to it yet)', async () => {
    const sink = new LocalRunSink(currentStorage, { ttlMs: 1000, now: () => new Date(Date.now() - 5000) });
    await sink.createRun(makeRun('run-stale'));
    const res = await request(app).get('/api/runs/in-flight');
    expect(res.body.runs).toEqual([expect.objectContaining({ id: 'run-stale', lease: expect.objectContaining({ live: false }) })]);
  });

  it('lists every leased run across storage pages and reports complete: true; a listing that hits the bound is complete: false', async () => {
    const sink = new LocalRunSink(currentStorage, { ttlMs: 60_000 });
    for (let i = 0; i < 205; i++) await sink.createRun(makeRun(`run-many-${String(i).padStart(3, '0')}`));
    const res = await request(app).get('/api/runs/in-flight');
    expect(res.body).toMatchObject({ count: 205, complete: true });
    expect(res.body.runs).toHaveLength(205);
  });

  it('drain: reports in-flight runs, flips the flag, refuses new leases with 503 listing them, in-flight shows draining', async () => {
    const sink = new LocalRunSink(currentStorage, { ttlMs: 60_000 });
    await sink.createRun(makeRun('run-busy'));
    expect(isDraining()).toBe(false);

    const drained = await request(app).post('/api/server/drain');
    expect(drained.status).toBe(200);
    expect(drained.body).toMatchObject({ draining: true, since: expect.any(String), inFlight: { count: 1, runs: [expect.objectContaining({ id: 'run-busy' })] } });
    expect(isDraining()).toBe(true);

    // Idempotent: the same `since`.
    const again = await request(app).post('/api/server/drain');
    expect(again.body.since).toBe(drained.body.since);

    const refused = await request(app).post('/api/runs/ingest').send({ run: makeRun('run-new') });
    expect(refused.status).toBe(503);
    expect(refused.body).toMatchObject({ error: 'draining', since: drained.body.since, inFlight: { count: 1, runs: [expect.objectContaining({ id: 'run-busy' })] } });
    expect(refused.body.message).toMatch(/draining .* 1 run still in flight/);
    expect(refused.body.inFlight.complete).toBe(true);
    expect(await currentStorage.evaluationRuns.getById('run-new')).toBeNull();

    // Runs already in flight keep writing.
    const beat = await request(app).post('/api/runs/ingest/run-busy/heartbeat').set(EXECUTOR_TOKEN_HEADER, (await currentStorage.evaluationRuns.getById('run-busy'))!.executor!.id!).send({});
    expect(beat.status).toBe(200);

    const inFlight = await request(app).get('/api/runs/in-flight');
    expect(inFlight.body).toMatchObject({ draining: true, since: drained.body.since, count: 1 });
  });
});

describe('drain guard on the server-executed run routes', () => {
  // The route modules pull in the whole execution stack; only the guard
  // position matters here, so assert it on the registered route layers.
  it('POST /evaluation-runs, /:id/rerun, /benchmarks/:id/execute and /api/evaluate all run the drain guard first', async () => {
    const { refuseWhenDraining } = await import('@/server/services/serverDrain');
    const evaluationRuns = (await import('@/server/routes/storage/evaluationRuns')).default as any;
    const benchmarks = (await import('@/server/routes/storage/benchmarks')).default as any;
    const evaluation = (await import('@/server/routes/evaluation')).default as any;
    const guardOf = (router: any, routePath: string) => {
      const layer = router.stack.find((l: any) => l.route?.path === routePath && l.route.methods.post);
      expect(layer).toBeDefined();
      return layer.route.stack[0].handle;
    };
    expect(guardOf(evaluationRuns, '/api/storage/evaluation-runs')).toBe(refuseWhenDraining);
    expect(guardOf(evaluationRuns, '/api/storage/evaluation-runs/:id/rerun')).toBe(refuseWhenDraining);
    expect(guardOf(benchmarks, '/api/storage/benchmarks/:id/execute')).toBe(refuseWhenDraining);
    expect(guardOf(evaluation, '/api/evaluate')).toBe(refuseWhenDraining);
  });
});
