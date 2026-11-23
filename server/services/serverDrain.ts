/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Server drain (#612 problem 5 composition, design §3).
 *
 * `POST /api/server/drain` flips this process into draining: every route
 * that would START a server-executed run (`POST /evaluation-runs`, `/rerun`,
 * `/benchmarks/:id/execute`, `/api/evaluate`) and the ingestion `createRun`
 * (a new lease) answer `503 draining` with the runs still in flight, so an
 * operator — or the CLI's version-mismatch restart — can wait for
 * `GET /api/runs/in-flight` to empty and then restart without losing a run.
 * Runs already executing are untouched. Process-local, like the executor
 * registries; a restart clears it.
 */

import type { Request, Response, NextFunction } from 'express';
import { getStorageModule } from '../adapters/index.js';
import { listInFlightRuns } from './inFlightRuns.js';

let drainingSince: string | undefined;

export function startDrain(now = new Date()): { draining: true; since: string } {
  drainingSince ??= now.toISOString();
  return { draining: true, since: drainingSince };
}

export function isDraining(): boolean {
  return drainingSince !== undefined;
}

export function drainState(): { draining: boolean; since?: string } {
  return drainingSince ? { draining: true, since: drainingSince } : { draining: false };
}

/** Tests only: a fresh process state. */
export function resetDrainForTests(): void {
  drainingSince = undefined;
}

/** Express middleware: 503 while draining, listing what is still in flight. */
export async function refuseWhenDraining(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!drainingSince) { next(); return; }
  let inFlight: { count: number; runs: unknown[]; complete: boolean } | undefined;
  try {
    const listed = await listInFlightRuns(getStorageModule());
    inFlight = { count: listed.count, runs: listed.runs, complete: listed.complete };
  } catch { /* the refusal stands even if storage cannot be listed; say so rather than "0" */ }
  const still = inFlight ? `${inFlight.count}${inFlight.complete ? '' : '+'} run${inFlight.count === 1 ? '' : 's'} still in flight` : 'in-flight runs could not be listed';
  res.status(503).json({
    error: 'draining',
    message: `This server is draining (since ${drainingSince}) and does not start new runs; ${still}.`,
    since: drainingSince,
    inFlight,
  });
}
