/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * What is executing against this server's storage right now (#612).
 *
 * Two sources, unioned by run id:
 *   - LEASED runs: `status: 'running'` evaluation-run documents that carry a
 *     lease (lib/runLease.ts) — whichever process executes them, this one or
 *     a CLI. Pre-lease `running` docs (no `lease`) are NOT listed: they can
 *     only be stale leftovers of a crashed process, which is exactly what
 *     `/health.activeRuns` was built to exclude.
 *   - PROCESS runs: the in-memory executor registries of this process
 *     (`listActiveRuns`), which still cover legacy `/benchmarks/:id/execute`
 *     runs and retry-judgement jobs that have no lease.
 *
 * `GET /api/runs/in-flight` serves this; the CLI's version-mismatch restart
 * reads it (falling back to `/health.activeRuns` on older servers), and the
 * drain refusal lists it. The executor's fencing token is never included.
 */

import type { IStorageModule } from '../adapters/types.js';
import type { EvaluationRun } from '../../types/index.js';
import { isLeaseLive } from '../../lib/runLease.js';
import { listActiveRuns } from './runCancellation.js';

export interface InFlightRun {
  id: string;
  name?: string;
  /** `benchmark` / `evaluation` / `retry-judgement` for process runs; `evaluation` for leased runs. */
  kind: string;
  /** Where this entry was observed. */
  source: 'lease' | 'process';
  executor?: { kind: 'cli' | 'server'; version: string };
  lease?: { generation: number; heartbeatAt: string; ttlMs: number; live: boolean };
  cancelRequestedAt?: string;
  createdAt?: string;
}

export interface InFlightRuns {
  count: number;
  runs: InFlightRun[];
  /** False when an in-process registry could not answer or the listing was truncated (treat as "unknown", not "idle"). */
  complete: boolean;
}

const PAGE_SIZE = 200;
/** Hard bound on pages read (5000 `running` docs); past it the answer is reported `complete: false`. */
const MAX_PAGES = 25;

export async function listInFlightRuns(storage: Pick<IStorageModule, 'evaluationRuns'>, nowMs = Date.now()): Promise<InFlightRuns> {
  const byId = new Map<string, InFlightRun>();
  const items: EvaluationRun[] = [];
  let truncated = true;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { items: pageItems } = await storage.evaluationRuns.list({ status: 'running', from: page * PAGE_SIZE, size: PAGE_SIZE, sort: 'createdAt', order: 'asc' });
    items.push(...pageItems);
    if (pageItems.length < PAGE_SIZE) { truncated = false; break; }
  }
  for (const run of items) {
    if (!run.lease) continue;
    byId.set(run.id, {
      id: run.id,
      name: run.name,
      kind: 'evaluation',
      source: 'lease',
      ...(run.executor ? { executor: { kind: run.executor.kind, version: run.executor.version } } : {}),
      lease: { generation: run.lease.generation, heartbeatAt: run.lease.heartbeatAt, ttlMs: run.lease.ttlMs, live: isLeaseLive(run.lease, nowMs) },
      ...(run.cancelRequestedAt ? { cancelRequestedAt: run.cancelRequestedAt } : {}),
      createdAt: run.createdAt,
    });
  }
  const processRuns = listActiveRuns();
  for (const ref of processRuns.runs) {
    if (!byId.has(ref.id)) byId.set(ref.id, { id: ref.id, kind: ref.kind, source: 'process' });
  }
  const runs = [...byId.values()];
  // Incomplete when a registry could not answer OR the storage listing hit
  // its bound: a caller deciding whether a restart is safe must refuse, not
  // read a partial list as "that is all".
  return { count: runs.length, runs, complete: processRuns.complete && !truncated };
}
