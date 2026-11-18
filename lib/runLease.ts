/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Executor leases for evaluation runs (#612, step 2).
 *
 * A run document carries `executor: { id, kind, version }` and
 * `lease: { generation, heartbeatAt, ttlMs }` (types/index.ts). The executor
 * heartbeats every {@link heartbeatIntervalMs}; every mutation it issues is a
 * compare-and-swap guarded by {@link LeaseGuard} — `executor.id == token &&
 * lease.generation == generation && status == 'running'` — evaluated inside
 * the storage adapter's atomic write (Painless script / serialized file
 * write). A mismatch is a {@link LeaseLostError} (HTTP 409 `lease-lost`).
 *
 * Policy (design §2): TTL defaults to 5 minutes = 15 missed 20 s beats. The
 * only event-loop blockers in the pipeline are user sync hooks (an
 * `execSync` credential helper in `beforeRequest`); connectors are async. A
 * false positive (fencing out a live run → its remaining results are lost)
 * costs far more than a false negative (a zombie lingers ≤ TTL), so the TTL
 * errs long. The heartbeat period scales with the TTL so a shorter TTL (tests,
 * `AH_RUN_LEASE_TTL_MS`) never starves its own executor.
 */

import type { EvaluationRun, RunLease } from '@/types';

export const DEFAULT_RUN_LEASE_TTL_MS = 5 * 60 * 1000;
/** Default heartbeat period at the default TTL (15 beats per TTL). */
export const DEFAULT_RUN_HEARTBEAT_MS = 20_000;
/** Lower bound on the heartbeat period so a tiny test TTL cannot busy-loop. */
const MIN_RUN_HEARTBEAT_MS = 200;
const BEATS_PER_TTL = DEFAULT_RUN_LEASE_TTL_MS / DEFAULT_RUN_HEARTBEAT_MS; // 15

/** Smallest TTL accepted (5 heartbeats at the 200 ms floor); below it every run would expire between beats. */
export const MIN_RUN_LEASE_TTL_MS = 1000;

/** `AH_RUN_LEASE_TTL_MS` (integer ms ≥ 1000) or the 5-minute default. */
export function resolveLeaseTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AH_RUN_LEASE_TTL_MS;
  if (!raw) return DEFAULT_RUN_LEASE_TTL_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= MIN_RUN_LEASE_TTL_MS ? parsed : DEFAULT_RUN_LEASE_TTL_MS;
}

/** Heartbeat period for a lease of `ttlMs`: 20 s at the default TTL, 1/15 of a shorter one. */
export function heartbeatIntervalMs(ttlMs: number): number {
  return Math.max(MIN_RUN_HEARTBEAT_MS, Math.min(DEFAULT_RUN_HEARTBEAT_MS, Math.floor(ttlMs / BEATS_PER_TTL)));
}

/**
 * True while the executor's last heartbeat is within the lease TTL. A
 * heartbeat more than one TTL in the FUTURE (a hand-edited or corrupt
 * document; server-stamped heartbeats cannot get there) is not live either —
 * otherwise such a run could never be reclaimed.
 */
export function isLeaseLive(lease: RunLease | undefined, nowMs = Date.now()): boolean {
  if (!lease) return false;
  const beat = Date.parse(lease.heartbeatAt);
  if (!Number.isFinite(beat)) return false;
  return nowMs - beat <= lease.ttlMs && beat - nowMs <= lease.ttlMs;
}

/**
 * What a write must prove about the run it targets. The executor presents its
 * token + generation. The sweeper additionally pins the `heartbeatAt` it
 * observed as expired, so a heartbeat that lands between its listing and its
 * take-over CAS makes the take-over fail instead of fencing out a live run.
 */
export interface LeaseGuard {
  executorId: string;
  generation: number;
  heartbeatAt?: string;
}

/** Guard a run's CURRENT executor would present, or undefined for a pre-lease / taken-over run. */
export function guardFor(run: Pick<EvaluationRun, 'executor' | 'lease'>): LeaseGuard | undefined {
  if (!run.executor?.id || !run.lease) return undefined;
  return { executorId: run.executor.id, generation: run.lease.generation };
}

/** Does the persisted run accept a write under `guard`? Same predicate the adapters evaluate atomically. */
export function leaseGuardHolds(run: Pick<EvaluationRun, 'executor' | 'lease' | 'status'>, guard: LeaseGuard): boolean {
  return run.status === 'running'
    && run.executor?.id === guard.executorId
    && run.lease?.generation === guard.generation
    && (guard.heartbeatAt === undefined || run.lease?.heartbeatAt === guard.heartbeatAt);
}

/** Body of a `409 lease-lost` response / message of a {@link LeaseLostError}. */
export interface LeaseLostInfo {
  error: 'lease-lost';
  runId: string;
  /** The run's CURRENT lease generation (what the writer expected is in the request). */
  generation: number;
  /** When the run left the executor's hands (takeover / terminal transition), ISO. */
  at: string;
  /** The run's current status — `failed` after a sweep, `completed`/`cancelled` after a terminal write. */
  status: string;
}

/** A guarded write was refused because the run no longer belongs to the writer. */
export class LeaseLostError extends Error {
  readonly info: LeaseLostInfo;
  constructor(info: LeaseLostInfo) {
    super(`lease-lost: run ${info.runId} is ${info.status} (lease generation ${info.generation}) since ${info.at}`);
    this.name = 'LeaseLostError';
    this.info = info;
  }
}

export function isLeaseLostError(error: unknown): error is LeaseLostError {
  return error instanceof LeaseLostError || (error as { name?: string } | undefined)?.name === 'LeaseLostError';
}

/** Build the refusal for a run whose persisted state does not satisfy `guard`. */
export function leaseLostInfo(run: Pick<EvaluationRun, 'id' | 'status' | 'lease' | 'completedAt'>, nowIso = new Date().toISOString()): LeaseLostInfo {
  return {
    error: 'lease-lost',
    runId: run.id,
    generation: run.lease?.generation ?? 0,
    at: run.completedAt ?? run.lease?.heartbeatAt ?? nowIso,
    status: run.status,
  };
}

const EXECUTOR_LOST_PREFIX = 'executor lost';

/** Human-readable error stamped on a run the sweeper failed. */
export function executorLostMessage(heartbeatAt: string, ttlMs: number): string {
  return `${EXECUTOR_LOST_PREFIX} (no heartbeat since ${heartbeatAt}; lease TTL ${Math.round(ttlMs / 1000)}s)`;
}

/** True for the `error` of a run the sweeper failed (its executor stopped heartbeating). */
export function isExecutorLostError(error: string | undefined): boolean {
  return typeof error === 'string' && error.startsWith(EXECUTOR_LOST_PREFIX);
}
