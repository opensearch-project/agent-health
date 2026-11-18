/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  DEFAULT_RUN_LEASE_TTL_MS,
  LeaseLostError,
  executorLostMessage,
  guardFor,
  heartbeatIntervalMs,
  isLeaseLive,
  isExecutorLostError,
  isLeaseLostError,
  leaseGuardHolds,
  leaseLostInfo,
  resolveLeaseTtlMs,
} from '@/lib/runLease';

describe('lib/runLease', () => {
  describe('resolveLeaseTtlMs', () => {
    it('defaults to 5 minutes and honours a positive AH_RUN_LEASE_TTL_MS', () => {
      expect(resolveLeaseTtlMs({})).toBe(5 * 60 * 1000);
      expect(DEFAULT_RUN_LEASE_TTL_MS).toBe(300_000);
      expect(resolveLeaseTtlMs({ AH_RUN_LEASE_TTL_MS: '15000' })).toBe(15_000);
    });
    it('ignores garbage / non-positive / sub-second values (a TTL shorter than a few beats would expire every run)', () => {
      for (const v of ['0', '-5', 'soon', '', '999']) expect(resolveLeaseTtlMs({ AH_RUN_LEASE_TTL_MS: v })).toBe(300_000);
      expect(resolveLeaseTtlMs({ AH_RUN_LEASE_TTL_MS: '1000' })).toBe(1000);
    });
  });

  describe('heartbeatIntervalMs', () => {
    it('is 20 s at the default TTL (15 beats per TTL) and scales down with a shorter TTL', () => {
      expect(heartbeatIntervalMs(300_000)).toBe(20_000);
      expect(heartbeatIntervalMs(30_000)).toBe(2_000);
      expect(heartbeatIntervalMs(15_000)).toBe(1_000);
    });
    it('never exceeds 20 s for a long TTL and never drops below 200 ms for a tiny one', () => {
      expect(heartbeatIntervalMs(60 * 60 * 1000)).toBe(20_000);
      expect(heartbeatIntervalMs(100)).toBe(200);
    });
  });

  describe('isLeaseLive', () => {
    const lease = { generation: 1, heartbeatAt: '2026-01-01T00:00:00.000Z', ttlMs: 60_000 };
    const t0 = Date.parse(lease.heartbeatAt);
    it('is live within the TTL (inclusive) and expired after it', () => {
      expect(isLeaseLive(lease, t0)).toBe(true);
      expect(isLeaseLive(lease, t0 + 60_000)).toBe(true);
      expect(isLeaseLive(lease, t0 + 60_001)).toBe(false);
    });
    it('treats a missing or unparseable lease as not live', () => {
      expect(isLeaseLive(undefined, t0)).toBe(false);
      expect(isLeaseLive({ ...lease, heartbeatAt: 'never' }, t0)).toBe(false);
    });
    it('a heartbeat more than one TTL in the future is not live (a corrupt document must stay reclaimable); mild skew is tolerated', () => {
      expect(isLeaseLive(lease, t0 - 60_000)).toBe(true);
      expect(isLeaseLive(lease, t0 - 60_001)).toBe(false);
    });
  });

  describe('guards', () => {
    const run = { id: 'r', status: 'running', executor: { id: 'tok', kind: 'server', version: '1' }, lease: { generation: 3, heartbeatAt: 'x', ttlMs: 1 } } as any;
    it('guardFor reads the current executor/generation, or nothing for a pre-lease / taken-over run', () => {
      expect(guardFor(run)).toEqual({ executorId: 'tok', generation: 3 });
      expect(guardFor({ ...run, executor: { ...run.executor, id: null } })).toBeUndefined();
      expect(guardFor({ id: 'legacy', status: 'running' } as any)).toBeUndefined();
    });
    it('leaseGuardHolds requires token, generation AND running', () => {
      expect(leaseGuardHolds(run, { executorId: 'tok', generation: 3 })).toBe(true);
      expect(leaseGuardHolds(run, { executorId: 'other', generation: 3 })).toBe(false);
      expect(leaseGuardHolds(run, { executorId: 'tok', generation: 2 })).toBe(false);
      expect(leaseGuardHolds({ ...run, status: 'completed' }, { executorId: 'tok', generation: 3 })).toBe(false);
      expect(leaseGuardHolds({ id: 'legacy', status: 'running' } as any, { executorId: 'tok', generation: 1 })).toBe(false);
    });
    it('a guard that pins heartbeatAt (the sweeper) fails once the executor has heartbeated again', () => {
      expect(leaseGuardHolds(run, { executorId: 'tok', generation: 3, heartbeatAt: 'x' })).toBe(true);
      expect(leaseGuardHolds(run, { executorId: 'tok', generation: 3, heartbeatAt: 'renewed' })).toBe(false);
    });
  });

  describe('LeaseLostError', () => {
    it('carries the refusal payload and is recognised across module copies by name', () => {
      const info = leaseLostInfo({ id: 'r', status: 'failed', completedAt: '2026-01-01T00:06:00.000Z', lease: { generation: 2, heartbeatAt: '2026-01-01T00:00:00.000Z', ttlMs: 1 } });
      expect(info).toEqual({ error: 'lease-lost', runId: 'r', generation: 2, at: '2026-01-01T00:06:00.000Z', status: 'failed' });
      const err = new LeaseLostError(info);
      expect(err.message).toBe('lease-lost: run r is failed (lease generation 2) since 2026-01-01T00:06:00.000Z');
      expect(isLeaseLostError(err)).toBe(true);
      expect(isLeaseLostError(Object.assign(new Error('x'), { name: 'LeaseLostError' }))).toBe(true);
      expect(isLeaseLostError(new Error('lease-lost'))).toBe(false);
    });
    it('falls back to the last heartbeat, then now, for `at` on a run that is still running', () => {
      expect(leaseLostInfo({ id: 'r', status: 'running', lease: { generation: 1, heartbeatAt: 'HB', ttlMs: 1 } }).at).toBe('HB');
      expect(leaseLostInfo({ id: 'r', status: 'running' }, 'NOW').at).toBe('NOW');
    });
  });

  it('executorLostMessage names the last heartbeat and the TTL in seconds, and isExecutorLostError recognises it', () => {
    const msg = executorLostMessage('2026-01-01T00:00:00.000Z', 300_000);
    expect(msg).toBe('executor lost (no heartbeat since 2026-01-01T00:00:00.000Z; lease TTL 300s)');
    expect(isExecutorLostError(msg)).toBe(true);
    expect(isExecutorLostError('agent crashed')).toBe(false);
    expect(isExecutorLostError(undefined)).toBe(false);
  });
});
