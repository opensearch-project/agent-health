/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Run lease sweeper (#612 step 2, design §2).
 *
 * Every leased evaluation run (`lease` on the document, lib/runLease.ts) is
 * renewed by its executor every heartbeat period. When the executor dies —
 * server crash, CLI SIGKILL, laptop lid — the heartbeat stops and the run
 * would otherwise stay `running` forever (the "zombie run" class: no cancel
 * token in any process, "Not able to cancel this run"). This sweeper runs
 * at boot and every `AH_RUN_LEASE_SWEEP_INTERVAL_MS` (60 s) over the
 * server's own storage and, for each `running` run whose last heartbeat is
 * older than its TTL, TAKES THE RUN OVER in one compare-and-swap:
 *
 *   status → 'failed', error 'executor lost (no heartbeat since …)',
 *   `cancelled` markers for every planned case that never started
 *   (buildCancelledMarkers, same shape a cancelled run gets),
 *   lease.generation + 1 and executor.id cleared.
 *
 * The CAS is guarded on the executor/generation the sweeper OBSERVED, so if
 * the executor finalizes in between (or heartbeats again just in time) the
 * sweeper's write is refused and nothing changes — exactly one writer wins.
 * After a takeover the old executor's token matches nothing, so its late
 * heartbeat / finalize gets `409 lease-lost` and can never resurrect the run.
 *
 * Pre-lease documents (no `lease`) are left alone: the sweeper has no
 * evidence about them. `AH_RUN_LEASE_SWEEP_LEGACY=1` opts in to failing
 * legacy `running` docs older than `BENCHMARK_RUN_STALE_AFTER_MS` (1 h, the
 * same rule benchmarkRunRecoveryOnBoot applies to embedded runs) for a
 * hand-reviewed one-off clean-up. `AH_RUN_LEASE_SWEEP_DISABLED=1` turns the
 * sweeper off (tests that want a run to stay `running`).
 */

import type { IStorageModule } from '../adapters/types.js';
import type { EvaluationRun } from '../../types/index.js';
import { buildCancelledMarkers, computeTerminalStats } from '../../services/evaluationRunFinalize.js';
import { executorLostMessage, guardFor, isLeaseLive, isLeaseLostError } from '../../lib/runLease.js';

export const DEFAULT_SWEEP_INTERVAL_MS = 60_000;
const LEGACY_STALE_AFTER_MS = 60 * 60 * 1000;
const PAGE_SIZE = 200;
const MAX_PAGES = 25;

export interface SweepStat {
  scanned: number;
  /** Leased runs whose TTL had elapsed. */
  expired: number;
  /** Runs this pass marked `failed`. */
  swept: number;
  /** Expired runs whose CAS was refused — the executor finished, or heartbeated again, first. */
  lostRace: number;
  /** Pre-lease `running` docs seen (and skipped unless legacy sweeping is on). */
  legacySkipped: number;
  legacySwept: number;
  errors: number;
  durationMs: number;
  disabled?: boolean;
}

export interface SweepOptions {
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
}

function envInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Take over one expired leased run. Returns true when THIS call made it `failed`. */
async function takeOverExpiredRun(storage: Pick<IStorageModule, 'evaluationRuns'>, run: EvaluationRun, nowIso: string): Promise<boolean> {
  const observed = guardFor(run);
  if (!observed || !run.lease || !run.executor) return false;
  // Pin the heartbeat we saw expire: a renewal that lands between the listing
  // and this write changes `heartbeatAt`, so the CAS refuses and the (alive,
  // merely late) executor keeps its run.
  const guard = { ...observed, heartbeatAt: run.lease.heartbeatAt };
  const plannedIds = (run.testCaseSnapshots ?? []).map(s => s.id);
  try {
    // 1. The take-over itself: ONE compare-and-swap guarded on the executor,
    //    generation AND heartbeat observed in the listing. It fails the run,
    //    bumps the generation and clears the token together, so from here on
    //    the old executor's writes are refused and nothing below can race with it.
    await storage.evaluationRuns.update(run.id, {
      status: 'failed',
      error: executorLostMessage(run.lease.heartbeatAt, run.lease.ttlMs),
      completedAt: nowIso,
      executor: { ...run.executor, id: null },
      lease: { ...run.lease, generation: run.lease.generation + 1 },
    }, guard);
  } catch (error) {
    if (isLeaseLostError(error)) return false; // the executor won the race (finished, or heartbeated after our listing)
    throw error;
  }
  // 2. Owned by the sweeper now (no guard needed): explicit `cancelled`
  //    markers for planned cases that never started, then stats from what is
  //    PERSISTED. A crash in between leaves a `failed` run whose absent
  //    entries readers already bucket as notRun (lib/runStats.ts).
  await storage.evaluationRuns.mergeMissingResults(run.id, buildCancelledMarkers(plannedIds, run.results));
  const persisted = await storage.evaluationRuns.getById(run.id);
  if (persisted) {
    const stats = computeTerminalStats({ results: persisted.results, testCaseSnapshots: persisted.testCaseSnapshots ?? run.testCaseSnapshots }, 'failed');
    await storage.evaluationRuns.update(run.id, { stats });
  }
  return true;
}

/** One pass over storage. Idempotent; safe to run on every boot and timer tick. */
export async function sweepExpiredRunLeases(storage: Pick<IStorageModule, 'evaluationRuns'>, options: SweepOptions = {}): Promise<SweepStat> {
  const env = options.env ?? process.env;
  const now = (options.now ?? (() => new Date()))();
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const startedAt = Date.now();
  const stat: SweepStat = { scanned: 0, expired: 0, swept: 0, lostRace: 0, legacySkipped: 0, legacySwept: 0, errors: 0, durationMs: 0 };
  if (env.AH_RUN_LEASE_SWEEP_DISABLED === '1') {
    stat.disabled = true;
    stat.durationMs = Date.now() - startedAt;
    return stat;
  }
  const legacy = env.AH_RUN_LEASE_SWEEP_LEGACY === '1';
  const legacyStaleAfterMs = envInt(env, 'BENCHMARK_RUN_STALE_AFTER_MS', LEGACY_STALE_AFTER_MS);

  // Collect the whole `running` set FIRST, then act: a take-over removes the
  // run from the set, so paging with `from` while sweeping would skip the
  // runs that shift into the swept ones' places.
  const running: EvaluationRun[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    let items: EvaluationRun[];
    try {
      ({ items } = await storage.evaluationRuns.list({ status: 'running', from: page * PAGE_SIZE, size: PAGE_SIZE, sort: 'createdAt', order: 'asc' }));
    } catch (error: any) {
      stat.errors++;
      console.warn(`[runLeaseSweeper] list failed: ${error?.message ?? error}`);
      break;
    }
    running.push(...items);
    if (items.length < PAGE_SIZE) break;
  }
  {
    for (const run of running) {
      stat.scanned++;
      if (!run.lease) {
        const createdMs = Date.parse(run.createdAt);
        if (legacy && Number.isFinite(createdMs) && nowMs - createdMs > legacyStaleAfterMs) {
          try {
            await storage.evaluationRuns.update(run.id, {
              status: 'failed',
              error: `executor lost (run predates leases and has been 'running' for over ${Math.round(legacyStaleAfterMs / 60000)} min; AH_RUN_LEASE_SWEEP_LEGACY=1)`,
              completedAt: nowIso,
            });
            stat.legacySwept++;
          } catch (error: any) {
            stat.errors++;
            console.warn(`[runLeaseSweeper] legacy sweep of ${run.id} failed: ${error?.message ?? error}`);
          }
        } else {
          stat.legacySkipped++;
        }
        continue;
      }
      if (isLeaseLive(run.lease, nowMs)) continue;
      stat.expired++;
      try {
        if (await takeOverExpiredRun(storage, run, nowIso)) {
          stat.swept++;
          console.warn(`[runLeaseSweeper] run ${run.id} marked failed: ${executorLostMessage(run.lease.heartbeatAt, run.lease.ttlMs)}`);
        } else {
          stat.lostRace++;
        }
      } catch (error: any) {
        stat.errors++;
        console.warn(`[runLeaseSweeper] take-over of ${run.id} failed: ${error?.message ?? error}`);
      }
    }
  }
  stat.durationMs = Date.now() - startedAt;
  return stat;
}

export interface RunLeaseSweeperHandle {
  stop(): void;
  /** Resolves after the pass in progress (or the next one) completes. */
  sweepNow(): Promise<SweepStat>;
}

/**
 * Boot pass + periodic passes. Never throws, never overlaps two passes, and
 * the timer is unref'd so it cannot keep the process alive on shutdown.
 */
export function startRunLeaseSweeper(storage: Pick<IStorageModule, 'evaluationRuns'>, options: SweepOptions & { intervalMs?: number } = {}): RunLeaseSweeperHandle {
  const env = options.env ?? process.env;
  const intervalMs = options.intervalMs ?? envInt(env, 'AH_RUN_LEASE_SWEEP_INTERVAL_MS', DEFAULT_SWEEP_INTERVAL_MS);
  let inFlight: Promise<SweepStat> | undefined;
  const run = (): Promise<SweepStat> => {
    if (inFlight) return inFlight;
    inFlight = sweepExpiredRunLeases(storage, options)
      .then((stat) => {
        if (stat.swept || stat.legacySwept || stat.errors) {
          console.log(`[runLeaseSweeper] scanned ${stat.scanned}, swept ${stat.swept}, legacy ${stat.legacySwept}, lost race ${stat.lostRace}, errors ${stat.errors} [${stat.durationMs}ms]`);
        }
        return stat;
      })
      .catch((error: any) => {
        console.warn(`[runLeaseSweeper] pass failed: ${error?.message ?? error}`);
        return { scanned: 0, expired: 0, swept: 0, lostRace: 0, legacySkipped: 0, legacySwept: 0, errors: 1, durationMs: 0 } satisfies SweepStat;
      })
      .finally(() => { inFlight = undefined; });
    return inFlight;
  };
  void run();
  const timer = setInterval(() => { void run(); }, intervalMs);
  timer.unref?.();
  return {
    stop: () => clearInterval(timer),
    sweepNow: run,
  };
}
