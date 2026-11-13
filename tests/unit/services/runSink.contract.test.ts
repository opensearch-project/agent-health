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
import { LocalRunSink, mintExecutorToken, mintReportId, EXECUTOR_TOKEN_HEADER, type RunSink } from '@/services/runSink';
import { HttpRunSink, HttpRunSinkError } from '@/services/httpRunSink';
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
  close: () => Promise<void>;
}

async function localHarness(): Promise<Harness> {
  const dir = mkdtempSync(path.join(tmpdir(), 'ah-runsink-local-'));
  const storage = new FileStorageModule(dir);
  currentStorage = storage;
  return { name: 'LocalRunSink', sink: new LocalRunSink(storage), storage, close: async () => rmSync(dir, { recursive: true, force: true }) };
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
  return {
    name: 'HttpRunSink',
    sink: new HttpRunSink(`http://127.0.0.1:${port}`),
    storage,
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

  it('createRun persists the run document and returns a 128-bit executor token', async () => {
    const created = await h.sink.createRun(makeRun('run-1'));
    expect(created.runId).toBe('run-1');
    expect(created.executorToken).toMatch(/^[0-9a-f]{32}$/);
    const stored = await h.storage.evaluationRuns.getById('run-1');
    expect(stored).toMatchObject({ id: 'run-1', status: 'running', agentKey: 'agent-a' });
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

  it('setCaseResult records one case verdict on the run document; heartbeat echoes an empty lease', async () => {
    await h.sink.createRun(makeRun('run-1'));
    const echo = await h.sink.setCaseResult('run-1', 'tc-1', { reportId: 'r-1', status: 'completed', passFailStatus: 'passed' });
    expect(echo).toEqual({ generation: 0 });
    expect(await h.sink.heartbeat('run-1', { startedCount: 1, completedCount: 1, totalTestCases: 2 })).toEqual({ generation: 0 });
    const stored = await h.storage.evaluationRuns.getById('run-1');
    expect(stored?.results).toEqual({ 'tc-1': { reportId: 'r-1', status: 'completed', passFailStatus: 'passed' } });
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
    await expect((h.sink as HttpRunSink).finalize('run-1', { status: 'bogus' } as any)).rejects.toMatchObject({ status: 400 } as Partial<HttpRunSinkError>);
    await expect(h.sink.upsertCaseReport({ runId: 'run-1', testCaseId: 'tc-1', attempt: 1, reportId: '', report: {} })).rejects.toMatchObject({ status: 400 });
  });

  it('a resumed sink reuses a previously minted token', async () => {
    const created = await h.sink.createRun(makeRun('run-1'));
    const base = (h.sink as any).base.replace(/\/api\/runs\/ingest$/, '');
    const resumed = new HttpRunSink(base, { executorToken: created.executorToken });
    expect(resumed.token).toBe(created.executorToken);
    await expect(resumed.heartbeat('run-1', { startedCount: 0, completedCount: 0, totalTestCases: 2 })).resolves.toEqual({ generation: 0 });
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
