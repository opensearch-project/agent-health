/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * RunSink contract — the SAME scenarios run against `LocalRunSink` (over a
 * real FileStorageModule in a temp dir) and `HttpRunSink` (over the real
 * `/api/runs/ingest/*` router on a local listener, backed by the same kind
 * of FileStorageModule). Whatever the runner can observe through the sink
 * interface must be identical on both.
 */

import express from 'express';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import { FileStorageModule } from '@/server/adapters/file/StorageModule';
import { LocalRunSink, mintExecutorToken, mintReportId, EXECUTOR_TOKEN_HEADER, LEASE_GENERATION_HEADER, type RunSink } from '@/services/runSink';
import { HttpRunSink, HttpRunSinkError } from '@/services/httpRunSink';
import { LeaseLostError } from '@/lib/runLease';
import type { EvaluationRun } from '@/types';

// The ingestion router reads the server's storage module; point it at the
// suite's FileStorageModule (swapped per test via `currentStorage`).
let currentStorage: FileStorageModule;
jest.mock('@/server/adapters/index', () => ({
  getStorageModule: () => currentStorage,
}));

jest.mock('@/lib/debug', () => ({ debug: jest.fn() }));

function makeRun(id: string, overrides: Partial<EvaluationRun> = {}): EvaluationRun {
  return {
    id,
    docType: 'evaluation-run',
    name: 'Contract run',
    description: 'desc',
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'running',
    agentKey: 'agent-a',
    modelId: 'model-a',
    judgeModelId: 'judge-a',
    evaluatorId: 'ev-1',
    concurrency: 2,
    sources: [{ type: 'test-case-ids', ids: ['tc-1', 'tc-2'] }],
    trigger: 'api',
    testCaseSnapshots: [{ id: 'tc-1', version: 1, name: 'one' }, { id: 'tc-2', version: 1, name: 'two' }],
    results: {},
    ...overrides,
  } as EvaluationRun;
}

interface Harness {
  name: string;
  sink: RunSink;
  storage: FileStorageModule;
  /**
   * A SECOND executor for another run. One sink is one executor (it holds one
   * token); a test that drives two runs at once needs one sink per run, as
   * two CLIs would.
   */
  anotherSink: () => RunSink;
  /** A sink impersonating `token` at lease generation `generation` (a stale / forged executor). */
  sinkAs: (token: string, generation?: number) => RunSink;
  close: () => Promise<void>;
}

async function localHarness(): Promise<Harness> {
  const dir = mkdtempSync(path.join(tmpdir(), 'ah-runsink-local-'));
  const storage = new FileStorageModule(dir);
  currentStorage = storage;
  const sink = new LocalRunSink(storage, { executorKind: 'server', executorVersion: '9.9.9-test' });
  return {
    name: 'LocalRunSink', sink, storage,
    anotherSink: () => new LocalRunSink(storage),
    sinkAs: (token, generation = 1) => sink.forExecutor({ executorId: token, generation }),
    close: async () => rmSync(dir, { recursive: true, force: true }),
  };
}

async function httpHarness(): Promise<Harness> {
  const dir = mkdtempSync(path.join(tmpdir(), 'ah-runsink-http-'));
  const storage = new FileStorageModule(dir);
  currentStorage = storage;
  const router = (await import('@/server/routes/runsIngest')).default;
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(router);
  const server: http.Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as any).port;
  const base = `http://127.0.0.1:${port}`;
  return {
    name: 'HttpRunSink',
    sink: new HttpRunSink(base, { executorVersion: '9.9.9-test' }),
    storage,
    anotherSink: () => new HttpRunSink(base),
    sinkAs: (token, generation = 1) => new HttpRunSink(base, { executorToken: token, leaseGeneration: generation }),
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe.each([
  ['LocalRunSink', localHarness],
  ['HttpRunSink', httpHarness],
])('RunSink contract — %s', (_name, makeHarness) => {
  let h: Harness;
  beforeEach(async () => { h = await makeHarness(); });
  afterEach(async () => { await h.close(); });

  it('createRun persists the run document with an executor lease and returns the 128-bit token', async () => {
    const run = makeRun('run-1');
    const created = await h.sink.createRun(run);
    expect(created.runId).toBe('run-1');
    expect(created.executorToken).toMatch(/^[0-9a-f]{32}$/);
    expect(created.lease).toEqual({ generation: 1, heartbeatAt: expect.any(String), ttlMs: 5 * 60 * 1000 });
    const stored = await h.storage.evaluationRuns.getById('run-1');
    expect(stored).toMatchObject({ id: 'run-1', status: 'running', agentKey: 'agent-a' });
    // The fence lives on the document: token, kind, version, lease — no host/pid.
    expect(stored?.executor).toEqual({ id: created.executorToken, kind: h.name === 'HttpRunSink' ? 'cli' : 'server', version: '9.9.9-test' });
    expect(stored?.lease).toEqual(created.lease);
    expect(JSON.stringify(stored)).not.toMatch(/hostname|"pid"/);
    // The caller's in-memory run matches the document.
    expect(run.executor).toEqual(stored?.executor);
    expect(run.lease).toEqual(stored?.lease);
  });

  it('upsertCaseReport is idempotent on reportId: first write creates, later writes merge into the same document', async () => {
    await h.sink.createRun(makeRun('run-1'));
    const reportId = mintReportId();
    expect(reportId).toMatch(/^report-\d+-[a-z0-9]+$/);

    const first = await h.sink.upsertCaseReport({
      runId: 'run-1', testCaseId: 'tc-1', attempt: 1, reportId,
      report: { status: 'running', metricsStatus: 'pending', testCaseId: 'tc-1', experimentRunId: 'run-1', trajectory: [], metrics: {} } as any,
    });
    expect(first.reportId).toBe(reportId);
    expect(first.report).toMatchObject({ id: reportId, status: 'running', metricsStatus: 'pending' });

    const second = await h.sink.upsertCaseReport({
      runId: 'run-1', testCaseId: 'tc-1', attempt: 1, reportId,
      // `id` on the fields must not win over the minted id.
      report: { id: 'ignored-id', status: 'completed', metricsStatus: 'completed', passFailStatus: 'passed', trajectory: [{ type: 'response', content: 'hi' }] } as any,
    });
    expect(second.reportId).toBe(reportId);
    // Merge semantics: fields from the first write survive, later fields win.
    expect(second.report).toMatchObject({ id: reportId, status: 'completed', passFailStatus: 'passed', testCaseId: 'tc-1', experimentRunId: 'run-1' });

    // A retried identical write is a no-op merge, never a duplicate.
    const third = await h.sink.upsertCaseReport({
      runId: 'run-1', testCaseId: 'tc-1', attempt: 1, reportId,
      report: { status: 'completed', passFailStatus: 'passed' } as any,
    });
    expect(third.report).toMatchObject(second.report as any);

    const all = await h.storage.runs.getAll();
    expect(all.total).toBe(1);
    expect((await h.storage.runs.getById(reportId))?.passFailStatus).toBe('passed');
  });

  it('patchCaseReport merges a partial update into an existing report', async () => {
    await h.sink.createRun(makeRun('run-1'));
    const reportId = mintReportId();
    await h.sink.upsertCaseReport({ runId: 'run-1', testCaseId: 'tc-1', attempt: 1, reportId, report: { status: 'running', metricsStatus: 'pending' } as any });
    await h.sink.patchCaseReport('run-1', reportId, { metricsStatus: 'error', llmJudgeReasoning: 'Evaluation error: boom' } as any);
    expect(await h.storage.runs.getById(reportId)).toMatchObject({ status: 'running', metricsStatus: 'error', llmJudgeReasoning: 'Evaluation error: boom' });
  });

  it('setCaseResult records one case verdict on the run document; heartbeat renews the lease and both echo the generation', async () => {
    const created = await h.sink.createRun(makeRun('run-1'));
    const echo = await h.sink.setCaseResult('run-1', 'tc-1', { reportId: 'r-1', status: 'completed', passFailStatus: 'passed' });
    expect(echo).toEqual({ generation: 1 });
    await new Promise(r => setTimeout(r, 5));
    expect(await h.sink.heartbeat('run-1', { startedCount: 1, completedCount: 1, totalTestCases: 2 })).toEqual({ generation: 1 });
    const stored = await h.storage.evaluationRuns.getById('run-1');
    expect(stored?.results).toEqual({ 'tc-1': { reportId: 'r-1', status: 'completed', passFailStatus: 'passed' } });
    expect(Date.parse(stored!.lease!.heartbeatAt)).toBeGreaterThan(Date.parse(created.lease.heartbeatAt));
    expect(stored?.lease).toMatchObject({ generation: 1, ttlMs: created.lease.ttlMs });
  });

  it('a cancel requested through the server is echoed on the next heartbeat / case result (cancel by lease)', async () => {
    await h.sink.createRun(makeRun('run-1'));
    expect(await h.sink.heartbeat('run-1', { startedCount: 0, completedCount: 0, totalTestCases: 2 })).toEqual({ generation: 1 });
    // What POST /evaluation-runs/:id/cancel writes for a run executing elsewhere.
    await h.storage.evaluationRuns.update('run-1', { cancelRequestedAt: '2026-01-01T00:05:00.000Z' });
    expect(await h.sink.heartbeat('run-1', { startedCount: 1, completedCount: 0, totalTestCases: 2 })).toEqual({ generation: 1, cancelRequestedAt: '2026-01-01T00:05:00.000Z' });
    expect(await h.sink.setCaseResult('run-1', 'tc-1', { reportId: 'r-1', status: 'completed', passFailStatus: 'passed' }))
      .toEqual({ generation: 1, cancelRequestedAt: '2026-01-01T00:05:00.000Z' });
    // The executor then finalizes `cancelled`; never-started cases get markers.
    const finalized = await h.sink.finalize('run-1', { status: 'cancelled', completedRun: { results: { 'tc-1': { reportId: 'r-1', status: 'completed', passFailStatus: 'passed' } }, testCaseSnapshots: makeRun('run-1').testCaseSnapshots } });
    expect(finalized.status).toBe('cancelled');
    expect((await h.storage.evaluationRuns.getById('run-1'))?.results['tc-2']).toEqual({ reportId: '', status: 'cancelled' });
  });

  describe('lease fencing (#612): every mutation is a compare-and-swap on token + generation + running', () => {
    const report = (status: string) => ({ status, testCaseId: 'tc-1', experimentRunId: 'run-1' } as any);

    it('a stale / forged token is refused on every write and nothing is persisted', async () => {
      await h.sink.createRun(makeRun('run-1'));
      const stale = h.sinkAs(mintExecutorToken());
      await expect(stale.upsertCaseReport({ runId: 'run-1', testCaseId: 'tc-1', attempt: 1, reportId: mintReportId(), report: report('running') })).rejects.toBeInstanceOf(LeaseLostError);
      await expect(stale.setCaseResult('run-1', 'tc-1', { reportId: 'r-1', status: 'completed' })).rejects.toBeInstanceOf(LeaseLostError);
      await expect(stale.heartbeat('run-1', { startedCount: 0, completedCount: 0, totalTestCases: 2 })).rejects.toBeInstanceOf(LeaseLostError);
      await expect(stale.finalize('run-1', { status: 'failed', error: 'x' })).rejects.toBeInstanceOf(LeaseLostError);
      await expect(stale.finalize('run-1', { status: 'completed', completedRun: { results: {}, testCaseSnapshots: [] } })).rejects.toMatchObject({
        name: 'LeaseLostError', info: { error: 'lease-lost', runId: 'run-1', generation: 1, status: 'running', at: expect.any(String) },
      });
      const stored = await h.storage.evaluationRuns.getById('run-1');
      expect(stored).toMatchObject({ status: 'running', results: {} });
      expect(stored?.error).toBeUndefined();
      expect((await h.storage.runs.getAll()).total).toBe(0);
    });

    it('the right token at a stale generation is refused too', async () => {
      const created = await h.sink.createRun(makeRun('run-1'));
      const staleGeneration = h.sinkAs(created.executorToken, 7);
      await expect(staleGeneration.heartbeat('run-1', { startedCount: 0, completedCount: 0, totalTestCases: 2 })).rejects.toBeInstanceOf(LeaseLostError);
      await expect(staleGeneration.setCaseResult('run-1', 'tc-1', { reportId: 'r-1', status: 'completed' })).rejects.toBeInstanceOf(LeaseLostError);
      expect((await h.storage.evaluationRuns.getById('run-1'))?.results).toEqual({});
    });

    it('after the sweeper takes a run over (generation bumped, token cleared, status failed) the old executor cannot resurrect it', async () => {
      const created = await h.sink.createRun(makeRun('run-1'));
      const reportId = mintReportId();
      await h.sink.upsertCaseReport({ runId: 'run-1', testCaseId: 'tc-1', attempt: 1, reportId, report: report('running') });
      // What server/services/runLeaseSweeper.ts writes.
      await h.storage.evaluationRuns.update('run-1', {
        status: 'failed', error: 'executor lost (no heartbeat since 2026-01-01T00:00:00.000Z; lease TTL 300s)', completedAt: '2026-01-01T00:06:00.000Z',
        executor: { id: null, kind: 'server', version: '9.9.9-test' }, lease: { generation: 2, heartbeatAt: '2026-01-01T00:00:00.000Z', ttlMs: 300_000 },
      });
      const late = () => h.sink.finalize('run-1', { status: 'completed', completedRun: { results: { 'tc-1': { reportId, status: 'completed', passFailStatus: 'passed' } }, testCaseSnapshots: makeRun('run-1').testCaseSnapshots } });
      await expect(late()).rejects.toMatchObject({ info: { error: 'lease-lost', generation: 2, status: 'failed', at: '2026-01-01T00:06:00.000Z' } });
      await expect(h.sink.heartbeat('run-1', { startedCount: 1, completedCount: 1, totalTestCases: 2 })).rejects.toBeInstanceOf(LeaseLostError);
      await expect(h.sink.setCaseResult('run-1', 'tc-1', { reportId, status: 'completed' })).rejects.toBeInstanceOf(LeaseLostError);
      await expect(h.sink.upsertCaseReport({ runId: 'run-1', testCaseId: 'tc-1', attempt: 1, reportId, report: report('completed') })).rejects.toBeInstanceOf(LeaseLostError);
      await expect(h.sink.patchCaseReport('run-1', reportId, { status: 'completed' } as any)).rejects.toBeInstanceOf(LeaseLostError);
      const stored = await h.storage.evaluationRuns.getById('run-1');
      expect(stored).toMatchObject({ status: 'failed', results: {}, lease: { generation: 2 }, executor: { id: null } });
      expect((await h.storage.runs.getById(reportId))?.status).toBe('running');
      expect(created.executorToken).not.toBe(stored?.executor?.id);
    });

    it('a retried finalize by the SAME executor is idempotent (terminal state already written by it), a different terminal status is not', async () => {
      await h.sink.createRun(makeRun('run-1'));
      const completedRun = { results: { 'tc-1': { reportId: 'r-1', status: 'completed' as const, passFailStatus: 'passed' as const } }, testCaseSnapshots: makeRun('run-1').testCaseSnapshots };
      const first = await h.sink.finalize('run-1', { status: 'completed', completedRun, completedAt: '2026-01-01T00:10:00.000Z' });
      const again = await h.sink.finalize('run-1', { status: 'completed', completedRun });
      expect(again).toMatchObject({ status: 'completed', completedAt: '2026-01-01T00:10:00.000Z', stats: first.stats });
      // Same executor asking for a DIFFERENT terminal state is a conflict, not a retry.
      await expect(h.sink.finalize('run-1', { status: 'failed', error: 'late crash report' })).rejects.toBeInstanceOf(LeaseLostError);
      expect((await h.storage.evaluationRuns.getById('run-1'))?.status).toBe('completed');
    });

    it('a sink holding no token for a LEASED run fails closed on every write (never an unguarded write), while pre-lease runs stay writable', async () => {
      await h.sink.createRun(makeRun('run-leased'));
      // Another sink over the same storage that did not create the run and carries no token.
      const stranger = h.name === 'HttpRunSink'
        ? new LocalRunSink(h.storage)             // the HTTP route always binds a token; the in-process case is what can fail open
        : new LocalRunSink(h.storage);
      await expect(stranger.setCaseResult('run-leased', 'tc-1', { reportId: 'r', status: 'completed' })).rejects.toThrow(/leased to another executor/);
      await expect(stranger.heartbeat('run-leased', { startedCount: 0, completedCount: 0, totalTestCases: 2 })).rejects.toThrow(/leased to another executor/);
      await expect(stranger.finalize('run-leased', { status: 'failed', error: 'x' })).rejects.toThrow(/leased to another executor/);
      await expect(stranger.upsertCaseReport({ runId: 'run-leased', testCaseId: 'tc-1', attempt: 1, reportId: mintReportId(), report: report('running') })).rejects.toThrow(/leased to another executor/);
      expect(await h.storage.evaluationRuns.getById('run-leased')).toMatchObject({ status: 'running', results: {} });

      // A document created before leases existed has nothing to fence: legacy writes go through.
      await h.storage.evaluationRuns.create(makeRun('run-legacy'));
      expect(await stranger.heartbeat('run-legacy', { startedCount: 0, completedCount: 0, totalTestCases: 2 })).toEqual({ generation: 0 });
      expect(await stranger.setCaseResult('run-legacy', 'tc-1', { reportId: 'r', status: 'completed', passFailStatus: 'passed' })).toEqual({ generation: 0 });
      expect((await stranger.finalize('run-legacy', { status: 'completed', completedRun: { results: {}, testCaseSnapshots: [] } })).status).toBe('completed');
    });

    it('a UI cancel racing a completing executor leaves exactly one terminal state', async () => {
      await h.sink.createRun(makeRun('run-1'));
      await h.storage.evaluationRuns.update('run-1', { cancelRequestedAt: '2026-01-01T00:05:00.000Z' });
      // The executor had already drained and finalizes `completed` before it saw the echo.
      const finalized = await h.sink.finalize('run-1', { status: 'completed', completedRun: { results: { 'tc-1': { reportId: 'r-1', status: 'completed', passFailStatus: 'passed' }, 'tc-2': { reportId: 'r-2', status: 'failed', passFailStatus: 'failed' } }, testCaseSnapshots: makeRun('run-1').testCaseSnapshots } });
      expect(finalized.status).toBe('completed');
      const stored = await h.storage.evaluationRuns.getById('run-1');
      expect(stored).toMatchObject({ status: 'completed', cancelRequestedAt: '2026-01-01T00:05:00.000Z' });
      expect(Object.values(stored!.results).map(r => r.status).sort()).toEqual(['completed', 'failed']);
    });
  });

  it('finalize(completed) recomputes stats from the persisted results and links the projection into the benchmark', async () => {
    const bench = await h.storage.benchmarks.create({ name: 'B', testCaseIds: ['tc-1', 'tc-2'] } as any);
    await h.sink.createRun(makeRun('run-1', { benchmarkId: bench.id, agentFingerprint: 'fp-full', agentFingerprintShort: 'fp' } as any));
    await h.sink.setCaseResult('run-1', 'tc-1', { reportId: 'r-1', status: 'completed', passFailStatus: 'passed' });
    // tc-2's per-case write was "lost": only in memory — finalize heals it.
    const completedRun = {
      results: {
        'tc-1': { reportId: 'r-1', status: 'completed' as const, passFailStatus: 'passed' as const },
        'tc-2': { reportId: 'r-2', status: 'failed' as const, passFailStatus: 'failed' as const },
      },
      testCaseSnapshots: makeRun('run-1').testCaseSnapshots,
      judgeModel: 'real-judge-llm',
      judgeProvider: 'bedrock',
    };
    const finalized = await h.sink.finalize('run-1', { status: 'completed', completedRun, completedAt: '2026-01-01T00:10:00.000Z', benchmarkId: bench.id });
    expect(finalized).toMatchObject({ id: 'run-1', status: 'completed', completedAt: '2026-01-01T00:10:00.000Z', judgeModel: 'real-judge-llm' });
    expect(finalized.stats).toEqual({ passed: 1, failed: 1, errored: 0, pending: 0, notRun: 0, total: 2 });

    const stored = await h.storage.evaluationRuns.getById('run-1');
    expect(stored?.results['tc-2']).toEqual(completedRun.results['tc-2']);

    const linked = await h.storage.benchmarks.getById(bench.id);
    const projection = linked?.runs?.find((r) => r.id === 'run-1') as any;
    expect(projection).toMatchObject({
      id: 'run-1', name: 'Contract run', description: 'desc', status: 'completed',
      agentKey: 'agent-a', modelId: 'model-a', judgeModelId: 'judge-a', evaluatorId: 'ev-1', concurrency: 2,
      judgeModel: 'real-judge-llm', judgeProvider: 'bedrock',
      agentFingerprint: 'fp-full', agentFingerprintShort: 'fp',
      createdAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:10:00.000Z',
      stats: finalized.stats,
    });
    expect(projection.results).toEqual(stored?.results);
    expect(projection.testCaseSnapshots).toHaveLength(2);
  });

  it('finalize(cancelled) stamps explicit cancelled markers for planned cases that never started', async () => {
    await h.sink.createRun(makeRun('run-1'));
    const finalized = await h.sink.finalize('run-1', {
      status: 'cancelled',
      completedRun: { results: { 'tc-1': { reportId: 'r-1', status: 'completed', passFailStatus: 'passed' } }, testCaseSnapshots: makeRun('run-1').testCaseSnapshots },
    });
    expect(finalized.status).toBe('cancelled');
    expect(finalized.stats).toEqual({ passed: 1, failed: 0, errored: 0, pending: 0, notRun: 1, total: 2 });
    expect((await h.storage.evaluationRuns.getById('run-1'))?.results['tc-2']).toEqual({ reportId: '', status: 'cancelled' });
  });

  it('finalize(failed) writes the terminal failure without touching results', async () => {
    await h.sink.createRun(makeRun('run-1'));
    await h.sink.setCaseResult('run-1', 'tc-1', { reportId: 'r-1', status: 'completed', passFailStatus: 'passed' });
    const finalized = await h.sink.finalize('run-1', { status: 'failed', error: 'agent crashed', completedAt: '2026-01-01T00:10:00.000Z' });
    expect(finalized).toMatchObject({ status: 'failed', error: 'agent crashed', completedAt: '2026-01-01T00:10:00.000Z' });
    expect((await h.storage.evaluationRuns.getById('run-1'))?.results['tc-1']?.status).toBe('completed');
  });

  it('a report written under one run/case cannot be merged or patched under another', async () => {
    await h.sink.createRun(makeRun('run-1'));
    const other = h.anotherSink();
    await other.createRun(makeRun('run-2'));
    const reportId = mintReportId();
    await h.sink.upsertCaseReport({ runId: 'run-1', testCaseId: 'tc-1', attempt: 1, reportId, report: { status: 'running', testCaseId: 'tc-1', experimentRunId: 'run-1' } as any });
    await expect(other.upsertCaseReport({ runId: 'run-2', testCaseId: 'tc-1', attempt: 1, reportId, report: { status: 'completed' } as any }))
      .rejects.toThrow(/belongs to run run-1/);
    await expect(h.sink.upsertCaseReport({ runId: 'run-1', testCaseId: 'tc-2', attempt: 1, reportId, report: { status: 'completed' } as any }))
      .rejects.toThrow(/belongs to test case tc-1/);
    await expect(other.patchCaseReport('run-2', reportId, { status: 'failed' } as any)).rejects.toThrow(/belongs to run run-1/);
    expect((await h.storage.runs.getById(reportId))?.status).toBe('running');
  });

  it('finalize of an unknown run rejects with a not-found error', async () => {
    await h.sink.createRun(makeRun('run-1'));
    await expect(h.sink.finalize('run-does-not-exist', { status: 'completed', completedRun: { results: {}, testCaseSnapshots: [] } }))
      .rejects.toThrow(/not found/i);
  });
});

describe('HttpRunSink specifics', () => {
  let h: Harness;
  beforeEach(async () => { h = await httpHarness(); });
  afterEach(async () => { await h.close(); });

  it('refuses mutations before createRun (no executor token yet)', async () => {
    await expect(h.sink.heartbeat('run-x', { startedCount: 0, completedCount: 0, totalTestCases: 0 })).rejects.toThrow(/createRun\(\) must succeed/);
  });

  it('the server requires the executor token header on every mutation and echoes it back', async () => {
    const created = await h.sink.createRun(makeRun('run-1'));
    const base = (h.sink as any).base as string;
    const noToken = await fetch(`${base}/run-1/heartbeat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(noToken.status).toBe(400);
    expect((await noToken.json()).error).toMatch(new RegExp(EXECUTOR_TOKEN_HEADER, 'i'));

    const withToken = await fetch(`${base}/run-1/heartbeat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', [EXECUTOR_TOKEN_HEADER]: created.executorToken }, body: '{}',
    });
    expect(withToken.status).toBe(200);
    expect(withToken.headers.get(EXECUTOR_TOKEN_HEADER)).toBe(created.executorToken);
  });

  it('surfaces server validation errors with their HTTP status', async () => {
    await h.sink.createRun(makeRun('run-1'));
    // Body/URL consistency and enums are checked before anything is written.
    await expect(h.sink.upsertCaseReport({ runId: 'run-1', testCaseId: 'tc-1', attempt: 1, reportId: mintReportId(), report: { testCaseId: 'tc-other' } as any }))
      .rejects.toMatchObject({ status: 400, message: /testCaseId/ });
    await expect(h.sink.upsertCaseReport({ runId: 'run-1', testCaseId: 'tc-1', attempt: 1, reportId: mintReportId(), report: { experimentRunId: 'run-other' } as any }))
      .rejects.toMatchObject({ status: 400, message: /experimentRunId/ });
    await expect(h.sink.upsertCaseReport({ runId: 'run-1', testCaseId: 'tc-1', attempt: 0, reportId: mintReportId(), report: {} }))
      .rejects.toMatchObject({ status: 400, message: /attempt/ });
    await expect(h.sink.setCaseResult('run-1', 'tc-1', { reportId: 'r', status: 'bogus' } as any))
      .rejects.toMatchObject({ status: 400, message: /status must be one of/ });
    await expect((h.sink as HttpRunSink).finalize('run-1', { status: 'bogus' } as any)).rejects.toMatchObject({ status: 400 } as Partial<HttpRunSinkError>);
    await expect(h.sink.upsertCaseReport({ runId: 'run-1', testCaseId: 'tc-1', attempt: 1, reportId: '', report: {} })).rejects.toMatchObject({ status: 400 });
  });

  it('a resumed sink reuses a previously minted token (and the generation it opened)', async () => {
    const created = await h.sink.createRun(makeRun('run-1'));
    const base = (h.sink as any).base.replace(/\/api\/runs\/ingest$/, '');
    const resumed = new HttpRunSink(base, { executorToken: created.executorToken });
    expect(resumed.token).toBe(created.executorToken);
    await expect(resumed.heartbeat('run-1', { startedCount: 0, completedCount: 0, totalTestCases: 2 })).resolves.toEqual({ generation: 1 });
  });

  it('a lease-lost refusal is HTTP 409 with the lease-lost body; a malformed generation header is 400', async () => {
    const created = await h.sink.createRun(makeRun('run-1'));
    const base = (h.sink as any).base as string;
    const forged = await fetch(`${base}/run-1/heartbeat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', [EXECUTOR_TOKEN_HEADER]: mintExecutorToken() }, body: '{}',
    });
    expect(forged.status).toBe(409);
    expect(await forged.json()).toEqual({ error: 'lease-lost', runId: 'run-1', generation: 1, status: 'running', at: expect.any(String) });
    for (const bad of ['zero', '0', '-1', '1.5', '9007199254740993']) {
      const badGeneration = await fetch(`${base}/run-1/heartbeat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', [EXECUTOR_TOKEN_HEADER]: created.executorToken, [LEASE_GENERATION_HEADER]: bad }, body: '{}',
      });
      expect(badGeneration.status).toBe(400);
      expect((await badGeneration.json()).error).toMatch(new RegExp(LEASE_GENERATION_HEADER, 'i'));
    }
    // executor.version on create is bounded (printable, ≤ 64 chars).
    const badVersion = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ run: makeRun('run-v'), executor: { version: 'x'.repeat(65) } }) });
    expect(badVersion.status).toBe(400);
    expect(await h.storage.evaluationRuns.getById('run-v')).toBeNull();
  });
});

describe('mintExecutorToken', () => {
  it('mints distinct 32-hex tokens', () => {
    const a = mintExecutorToken();
    const b = mintExecutorToken();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
});
