/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Run lease sweeper (#612) against a REAL FileStorageModule in a temp dir
 * with a fake clock — no mocks of the adapter or the sink. Red on the
 * previous behaviour: a `running` run whose executor died stayed `running`
 * forever (nothing on the server ever moved it).
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { FileStorageModule } from '@/server/adapters/file/StorageModule';
import { LocalRunSink } from '@/services/runSink';
import { LeaseLostError } from '@/lib/runLease';
import { sweepExpiredRunLeases, startRunLeaseSweeper } from '@/server/services/runLeaseSweeper';
import type { EvaluationRun } from '@/types';

jest.mock('@/lib/debug', () => ({ debug: jest.fn() }));

const T0 = Date.parse('2026-03-01T12:00:00.000Z');
const TTL = 5 * 60 * 1000;

function makeRun(id: string, overrides: Partial<EvaluationRun> = {}): EvaluationRun {
  return {
    id, docType: 'evaluation-run', name: `Run ${id}`, createdAt: new Date(T0).toISOString(), status: 'running',
    agentKey: 'agent-a', modelId: 'model-a', sources: [], trigger: 'ui',
    testCaseSnapshots: [{ id: 'tc-1', version: 1, name: 'one' }, { id: 'tc-2', version: 1, name: 'two' }, { id: 'tc-3', version: 1, name: 'three' }],
    results: {},
    ...overrides,
  } as EvaluationRun;
}

describe('runLeaseSweeper (real file adapter, fake clock)', () => {
  let dir: string;
  let storage: FileStorageModule;
  let nowMs: number;
  const clock = () => new Date(nowMs);
  const env = { AH_RUN_LEASE_TTL_MS: String(TTL) } as NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'ah-lease-sweeper-'));
    storage = new FileStorageModule(dir);
    nowMs = T0;
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  function sinkNow(): LocalRunSink {
    return new LocalRunSink(storage, { executorKind: 'server', executorVersion: '0.0.0-test', ttlMs: TTL, now: clock });
  }

  it('an expired lease → run failed "executor lost", cancelled markers for never-started cases, stats, generation bumped, token cleared', async () => {
    const sink = sinkNow();
    const created = await sink.createRun(makeRun('run-dead'));
    await sink.setCaseResult('run-dead', 'tc-1', { reportId: 'r-1', status: 'completed', passFailStatus: 'passed' });
    await sink.setCaseResult('run-dead', 'tc-2', { reportId: 'r-2', status: 'running' });

    // One heartbeat period short of the TTL: still live, untouched.
    nowMs = T0 + TTL;
    let stat = await sweepExpiredRunLeases(storage, { now: clock, env });
    expect(stat).toMatchObject({ scanned: 1, expired: 0, swept: 0 });
    expect((await storage.evaluationRuns.getById('run-dead'))?.status).toBe('running');

    // Past the TTL: taken over.
    nowMs = T0 + TTL + 1;
    stat = await sweepExpiredRunLeases(storage, { now: clock, env });
    expect(stat).toMatchObject({ scanned: 1, expired: 1, swept: 1, lostRace: 0, errors: 0 });

    const swept = await storage.evaluationRuns.getById('run-dead');
    expect(swept).toMatchObject({
      status: 'failed',
      error: `executor lost (no heartbeat since ${created.lease.heartbeatAt}; lease TTL 300s)`,
      completedAt: new Date(nowMs).toISOString(),
      executor: { id: null, kind: 'server', version: '0.0.0-test' },
      lease: { generation: 2, heartbeatAt: created.lease.heartbeatAt, ttlMs: TTL },
    });
    // Finished verdicts kept, started-but-unfinished kept as-is, never-started → explicit cancelled marker.
    expect(swept?.results).toEqual({
      'tc-1': { reportId: 'r-1', status: 'completed', passFailStatus: 'passed' },
      'tc-2': { reportId: 'r-2', status: 'running' },
      'tc-3': { reportId: '', status: 'cancelled' },
    });
    expect(swept?.stats).toEqual({ passed: 1, failed: 0, errored: 0, pending: 0, notRun: 2, total: 3 });

    // Idempotent: a second pass finds nothing running.
    expect(await sweepExpiredRunLeases(storage, { now: clock, env })).toMatchObject({ scanned: 0, swept: 0 });
  });

  it('the old executor is fenced out after the sweep: heartbeat / result / finalize all refuse with lease-lost and change nothing', async () => {
    const sink = sinkNow();
    await sink.createRun(makeRun('run-late'));
    nowMs = T0 + TTL + 1;
    await sweepExpiredRunLeases(storage, { now: clock, env });

    const sweptAt = new Date(nowMs).toISOString();
    await expect(sink.heartbeat('run-late', { startedCount: 1, completedCount: 0, totalTestCases: 3 }))
      .rejects.toMatchObject({ name: 'LeaseLostError', info: { error: 'lease-lost', runId: 'run-late', generation: 2, status: 'failed', at: sweptAt } });
    await expect(sink.setCaseResult('run-late', 'tc-1', { reportId: 'r-1', status: 'completed', passFailStatus: 'passed' })).rejects.toBeInstanceOf(LeaseLostError);
    await expect(sink.finalize('run-late', { status: 'completed', completedRun: { results: { 'tc-1': { reportId: 'r-1', status: 'completed', passFailStatus: 'passed' } }, testCaseSnapshots: makeRun('run-late').testCaseSnapshots } }))
      .rejects.toBeInstanceOf(LeaseLostError);
    const after = await storage.evaluationRuns.getById('run-late');
    expect(after).toMatchObject({ status: 'failed', lease: { generation: 2 } });
    expect(after?.results['tc-1']).toEqual({ reportId: '', status: 'cancelled' });
  });

  it('a heartbeat renews the lease, so a slow-but-alive executor is never swept', async () => {
    const sink = sinkNow();
    await sink.createRun(makeRun('run-alive'));
    for (let i = 1; i <= 4; i++) {
      nowMs = T0 + i * (TTL - 1000);
      await sink.heartbeat('run-alive', { startedCount: 1, completedCount: 0, totalTestCases: 3 });
      expect(await sweepExpiredRunLeases(storage, { now: clock, env })).toMatchObject({ expired: 0, swept: 0 });
    }
    expect((await storage.evaluationRuns.getById('run-alive'))?.status).toBe('running');
  });

  it('a heartbeat that lands between the sweeper\'s listing and its take-over refuses the take-over (the executor was late, not dead)', async () => {
    const sink = sinkNow();
    await sink.createRun(makeRun('run-late-beat'));
    nowMs = T0 + TTL + 1;
    // Storage view whose listing returns the expired snapshot, after which the
    // executor's beat arrives — before the sweeper's CAS.
    const racy = {
      evaluationRuns: new Proxy(storage.evaluationRuns, {
        get(target, prop) {
          if (prop === 'list') return async (o: any) => { const page = await target.list(o); await sink.heartbeat('run-late-beat', { startedCount: 1, completedCount: 0, totalTestCases: 3 }); return page; };
          const v = (target as any)[prop];
          return typeof v === 'function' ? v.bind(target) : v;
        },
      }),
    };
    expect(await sweepExpiredRunLeases(racy, { now: clock, env })).toMatchObject({ scanned: 1, expired: 1, swept: 0, lostRace: 1 });
    const doc = await storage.evaluationRuns.getById('run-late-beat');
    expect(doc).toMatchObject({ status: 'running', lease: { generation: 1, heartbeatAt: new Date(nowMs).toISOString() } });
    expect(doc?.executor?.id).toMatch(/^[0-9a-f]{32}$/);
    // The executor keeps working and finishes normally.
    await expect(sink.finalize('run-late-beat', { status: 'completed', completedRun: { results: {}, testCaseSnapshots: [] } })).resolves.toMatchObject({ status: 'completed' });
  });

  it('sweeper vs finalize racing on the same expired run: exactly one winner, single terminal state', async () => {
    // Same real adapter underneath; the sweeper's listing is delayed by a
    // varying number of event-loop turns so that over the rounds BOTH
    // interleavings happen (sweeper first, executor first), while every write
    // stays the real adapter's.
    const yieldTurns = async (n: number) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
    const slowListing = (turns: number) => ({
      evaluationRuns: new Proxy(storage.evaluationRuns, {
        get(target, prop) {
          if (prop === 'list') return async (o: any) => { await yieldTurns(turns); return target.list(o); };
          const v = (target as any)[prop];
          return typeof v === 'function' ? v.bind(target) : v;
        },
      }),
    });
    const outcomes = { executor: 0, sweeper: 0 };
    for (let round = 0; round < 16; round++) {
      const id = `run-race-${round}`;
      const sink = sinkNow();
      await sink.createRun(makeRun(id));
      await sink.setCaseResult(id, 'tc-1', { reportId: 'r-1', status: 'completed', passFailStatus: 'passed' });
      nowMs += TTL + 1;

      // Even rounds hold the sweeper back by `round/2` turns, odd rounds hold
      // the executor back — so the race tips each way across the run.
      const turns = Math.floor(round / 2);
      const finalize = async () => {
        if (round % 2 === 1) await yieldTurns(turns);
        return sink.finalize(id, {
          status: 'completed',
          completedRun: { results: { 'tc-1': { reportId: 'r-1', status: 'completed', passFailStatus: 'passed' }, 'tc-2': { reportId: 'r-2', status: 'failed', passFailStatus: 'failed' }, 'tc-3': { reportId: 'r-3', status: 'completed', passFailStatus: 'passed' } }, testCaseSnapshots: makeRun(id).testCaseSnapshots },
        });
      };
      const sweep = () => sweepExpiredRunLeases(round % 2 === 0 ? slowListing(turns) : storage, { now: clock, env });
      const [finalizeOutcome, sweepOutcome] = await Promise.allSettled([finalize(), sweep()]) as [PromiseSettledResult<EvaluationRun>, PromiseFulfilledResult<Awaited<ReturnType<typeof sweep>>>];
      expect(sweepOutcome.status).toBe('fulfilled');

      const doc = (await storage.evaluationRuns.getById(id))!;
      outcomes[finalizeOutcome.status === 'fulfilled' ? 'executor' : 'sweeper']++;
      if (finalizeOutcome.status === 'fulfilled') {
        // Executor won: completed; the sweeper either lost the CAS or never
        // saw the run as `running` — either way it swept nothing.
        expect(doc.status).toBe('completed');
        expect(sweepOutcome.value.swept).toBe(0);
        expect(sweepOutcome.value.lostRace + (1 - sweepOutcome.value.expired)).toBe(1);
        expect(doc.lease?.generation).toBe(1);
        expect(doc.stats).toEqual({ passed: 2, failed: 1, errored: 0, pending: 0, notRun: 0, total: 3 });
      } else {
        // Sweeper won: failed, and the executor got lease-lost.
        expect(finalizeOutcome.reason).toBeInstanceOf(LeaseLostError);
        expect(doc.status).toBe('failed');
        expect(sweepOutcome.value).toMatchObject({ swept: 1, lostRace: 0 });
        expect(doc.lease?.generation).toBe(2);
        expect(doc.executor?.id).toBeNull();
      }
      expect(['completed', 'failed']).toContain(doc.status);
    }
    // Both interleavings were exercised.
    expect(outcomes.executor).toBeGreaterThan(0);
    expect(outcomes.sweeper).toBeGreaterThan(0);
  });

  it('sweeps every expired run in one pass even when they span several pages (listing is collected before acting)', async () => {
    // PAGE_SIZE is 200: 250 expired runs would be paged with `from`, and
    // sweeping page 0 first would shift the remaining runs into its place.
    const sink = sinkNow();
    for (let i = 0; i < 250; i++) await sink.createRun(makeRun(`run-page-${String(i).padStart(3, '0')}`, { testCaseSnapshots: [] }));
    nowMs = T0 + TTL + 1;
    const stat = await sweepExpiredRunLeases(storage, { now: clock, env });
    expect(stat).toMatchObject({ scanned: 250, expired: 250, swept: 250, errors: 0 });
    expect((await storage.evaluationRuns.list({ status: 'running', size: 500 })).total).toBe(0);
  });

  it('pre-lease `running` documents are left alone by default; AH_RUN_LEASE_SWEEP_LEGACY=1 fails them after the 1 h rule', async () => {
    await storage.evaluationRuns.create(makeRun('legacy-fresh'));
    await storage.evaluationRuns.create(makeRun('legacy-old', { createdAt: new Date(T0 - 2 * 60 * 60 * 1000).toISOString() }));
    nowMs = T0 + TTL + 1;

    expect(await sweepExpiredRunLeases(storage, { now: clock, env })).toMatchObject({ scanned: 2, legacySkipped: 2, legacySwept: 0, swept: 0 });
    expect((await storage.evaluationRuns.getById('legacy-old'))?.status).toBe('running');

    expect(await sweepExpiredRunLeases(storage, { now: clock, env: { ...env, AH_RUN_LEASE_SWEEP_LEGACY: '1' } }))
      .toMatchObject({ scanned: 2, legacySkipped: 1, legacySwept: 1 });
    expect(await storage.evaluationRuns.getById('legacy-old')).toMatchObject({ status: 'failed', error: expect.stringContaining('predates leases') });
    expect((await storage.evaluationRuns.getById('legacy-fresh'))?.status).toBe('running');
  });

  it('terminal and cancelling runs are never touched; AH_RUN_LEASE_SWEEP_DISABLED=1 turns the sweeper off', async () => {
    const sink = sinkNow();
    await sink.createRun(makeRun('run-done'));
    await sink.finalize('run-done', { status: 'completed', completedRun: { results: {}, testCaseSnapshots: [] } });
    await sink.createRun(makeRun('run-expired'));
    nowMs = T0 + TTL + 1;

    expect(await sweepExpiredRunLeases(storage, { now: clock, env: { ...env, AH_RUN_LEASE_SWEEP_DISABLED: '1' } })).toMatchObject({ disabled: true, scanned: 0 });
    expect((await storage.evaluationRuns.getById('run-expired'))?.status).toBe('running');

    expect(await sweepExpiredRunLeases(storage, { now: clock, env })).toMatchObject({ scanned: 1, swept: 1 });
    expect((await storage.evaluationRuns.getById('run-done'))).toMatchObject({ status: 'completed', lease: { generation: 1 } });
  });

  it('startRunLeaseSweeper runs a boot pass, then on its timer, never overlapping; stop() ends it', async () => {
    jest.useFakeTimers();
    try {
      const sink = sinkNow();
      await sink.createRun(makeRun('run-boot'));
      nowMs = T0 + TTL + 1;
      const handle = startRunLeaseSweeper(storage, { now: clock, env, intervalMs: 1000 });
      // Boot pass.
      expect(await handle.sweepNow()).toMatchObject({ swept: 1 });
      expect((await storage.evaluationRuns.getById('run-boot'))?.status).toBe('failed');

      // Timer pass finds a newly expired run.
      await sink.createRun(makeRun('run-tick'));
      nowMs += TTL + 1;
      await jest.advanceTimersByTimeAsync(1000);
      await handle.sweepNow();
      expect((await storage.evaluationRuns.getById('run-tick'))?.status).toBe('failed');

      handle.stop();
      await sink.createRun(makeRun('run-after-stop'));
      nowMs += TTL + 1;
      await jest.advanceTimersByTimeAsync(5000);
      expect((await storage.evaluationRuns.getById('run-after-stop'))?.status).toBe('running');
    } finally {
      jest.useRealTimers();
    }
  });
});
