/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * In-memory async job store for the comparison deep-dive generator.
 *
 * Why (iteration 5, owner report): the public tunnel proxy
 * (goyamegh-ah-main.c.tunnels.lab.aws.dev) enforces a gateway timeout
 * SHORTER than the deep-dive's real generation time (~50-180s for a
 * comparison-wide analysis) — `POST /api/comparison/deep-dive` dies with a
 * 524 for tunnel users even though localhost works fine, because the
 * request/response cycle itself is held open for the whole generation.
 * Round-4's in-request deadline (DEEP_DIVE_DEADLINE_MS) bounds worst-case
 * time but can't fix this — the proxy's OWN timeout fires first regardless.
 *
 * Fix: convert the endpoint to a fire-and-poll async job. POST kicks off
 * generation in-process and returns a `jobId` in well under a second — no
 * connection is ever held open for the full generation. The client polls
 * GET .../jobs/:jobId every few seconds instead.
 *
 * This module is deliberately framework- and domain-agnostic (generic over
 * the result type) so it's trivially unit-testable without booting Express
 * or the pi SDK — `server/routes/comparison.ts` owns the actual
 * generateComparisonDeepDive() wiring.
 */

import crypto from 'crypto';

export type DeepDiveJobStatus = 'running' | 'done' | 'error';

export interface DeepDiveJobRecord<T> {
  id: string;
  /** De-dupe key (see {@link computeDeepDiveDedupeKey}) — same inputs, same key. */
  key: string;
  status: DeepDiveJobStatus;
  startedAt: number;
  completedAt?: number;
  result?: T;
  error?: string;
}

/** Thrown by {@link DeepDiveJobStore.start} when at the concurrency cap and there is no existing running job to dedupe onto. Route maps this to HTTP 429. */
export class DeepDiveJobCapacityError extends Error {
  constructor(public readonly maxConcurrent: number) {
    super(`Too many deep-dive generations already in progress (max ${maxConcurrent} concurrent). Try again shortly.`);
    this.name = 'DeepDiveJobCapacityError';
  }
}

/** 30 minutes — generous enough that a user polling a slow-but-legitimate job never loses it, short enough the process doesn't accumulate stale entries forever under real traffic. */
export const DEFAULT_JOB_TTL_MS = 30 * 60 * 1000;

/** Reject new (non-deduped) job starts once this many are simultaneously `running` — each one holds an in-process pi agent session + makes real model calls, so an unbounded number would be a resource/cost hazard. */
export const DEFAULT_MAX_CONCURRENT_JOBS = 3;

/** Cap on TOTAL retained jobs (running + terminal) per store. Beyond this, the oldest TERMINAL (done/error) jobs are evicted first — a running job is never evicted, no matter how old, since evicting it would orphan its in-flight generation with nothing left to report the result to. Bounds worst-case memory even if a client population regenerates far more distinct report-pair/prompt/rows combinations than the 30-minute TTL alone would ever naturally clear. */
export const DEFAULT_MAX_RETAINED_JOBS = 50;

export class DeepDiveJobStore<T> {
  private jobs = new Map<string, DeepDiveJobRecord<T>>();
  /** key -> jobId, tracked only while that job is genuinely `running` (de-dupe lookup). */
  private jobIdByKey = new Map<string, string>();

  constructor(
    private readonly ttlMs: number = DEFAULT_JOB_TTL_MS,
    private readonly maxConcurrent: number = DEFAULT_MAX_CONCURRENT_JOBS,
    private readonly maxRetained: number = DEFAULT_MAX_RETAINED_JOBS
  ) {}

  /** Drop any job whose terminal state (or, for a still-running job, its start time) is older than the TTL. Lazy — runs on every read/write rather than a background timer, so there's no interval to leak/unref in tests or short-lived processes. */
  private sweep(now: number = Date.now()): void {
    for (const [id, job] of this.jobs) {
      const anchor = job.completedAt ?? job.startedAt;
      if (now - anchor > this.ttlMs) {
        this.jobs.delete(id);
        if (this.jobIdByKey.get(job.key) === id) {
          this.jobIdByKey.delete(job.key);
        }
      }
    }
  }

  private countRunning(): number {
    let n = 0;
    for (const job of this.jobs.values()) {
      if (job.status === 'running') n++;
    }
    return n;
  }

  /**
   * Enforce {@link DEFAULT_MAX_RETAINED_JOBS}: evict the OLDEST terminal
   * (done/error) jobs, by completion time, until the store is back at/under
   * the cap or there are no more terminal jobs left to evict. A running job
   * is NEVER evicted — if every single tracked job happens to be running
   * (only possible when maxConcurrent > maxRetained, an intentionally
   * unusual configuration), the store is simply allowed to exceed the cap
   * until one of them finishes.
   */
  private evictOverflow(): void {
    let overflow = this.jobs.size - this.maxRetained;
    if (overflow <= 0) return;
    const terminal = [...this.jobs.values()]
      .filter((j) => j.status !== 'running')
      .sort((a, b) => (a.completedAt ?? a.startedAt) - (b.completedAt ?? b.startedAt));
    for (const job of terminal) {
      if (overflow <= 0) break;
      this.jobs.delete(job.id);
      if (this.jobIdByKey.get(job.key) === job.id) {
        this.jobIdByKey.delete(job.key);
      }
      overflow--;
    }
  }

  /**
   * Start a job for `key`, or return the id of an already-RUNNING job for
   * the same key (de-dupe — never generate the same report-pair+prompt
   * twice concurrently). `run` is invoked at most once per NEW job; its
   * settlement (resolve/reject) transitions the job to `done`/`error`.
   *
   * Throws {@link DeepDiveJobCapacityError} when at the concurrency cap AND
   * there is no existing running job for `key` to dedupe onto.
   */
  start(key: string, run: () => Promise<T>): { jobId: string; deduped: boolean } {
    this.sweep();

    const existingId = this.jobIdByKey.get(key);
    if (existingId) {
      const existing = this.jobs.get(existingId);
      if (existing && existing.status === 'running') {
        return { jobId: existingId, deduped: true };
      }
      // Stale mapping (the job finished or was TTL-swept but the key lookup
      // wasn't cleared for some reason) -- drop it and fall through to start fresh.
      this.jobIdByKey.delete(key);
    }

    if (this.countRunning() >= this.maxConcurrent) {
      throw new DeepDiveJobCapacityError(this.maxConcurrent);
    }

    const id = crypto.randomUUID();
    const job: DeepDiveJobRecord<T> = { id, key, status: 'running', startedAt: Date.now() };
    this.jobs.set(id, job);
    this.jobIdByKey.set(key, id);
    this.evictOverflow();

    // Fire-and-forget: this is the whole point of the async-job conversion —
    // the HTTP request that created this job has already returned by the
    // time this settles.
    run().then(
      (result) => {
        job.status = 'done';
        job.result = result;
        job.completedAt = Date.now();
      },
      (err: unknown) => {
        job.status = 'error';
        job.error = err instanceof Error ? err.message : String(err);
        job.completedAt = Date.now();
      }
    );

    return { jobId: id, deduped: false };
  }

  /** Look up a job by id. Returns undefined if never existed, or if it has since been TTL-swept. */
  get(jobId: string): DeepDiveJobRecord<T> | undefined {
    this.sweep();
    return this.jobs.get(jobId);
  }

  /** Test/diagnostic hook: how many jobs are currently tracked (any status). */
  size(): number {
    this.sweep();
    return this.jobs.size;
  }

  /** Test/diagnostic hook: how many jobs are currently `running`. */
  runningCount(): number {
    this.sweep();
    return this.countRunning();
  }
}

/**
 * De-dupe key for a deep-dive generation request: same report pair (order
 * independent) + same effective prompt inputs (systemPrompt override, rows
 * table) => same key => a second concurrent POST for it rides the existing
 * job instead of paying for a second generation.
 *
 * The `rows` table is hashed SEPARATELY and CANONICALLY (each row reduced to
 * a stable, explicit-field-order string, then the whole set sorted before
 * joining) rather than relying on `JSON.stringify` over whatever shape/order
 * the caller happens to pass — two POSTs for the SAME report pair and prompt
 * but a DIFFERENT rows table must never collapse onto the same job (the
 * second caller would silently get the first caller's unrelated result), and
 * conversely the SAME logical rows table re-sent in a different order should
 * still hash identically rather than triggering a needless duplicate
 * generation.
 */
export function computeDeepDiveDedupeKey(reportIds: string[], systemPrompt?: string, rows?: unknown): string {
  const sortedIds = [...reportIds].sort();
  const rowsHash = crypto.createHash('sha256').update(canonicalizeRowsForHash(rows)).digest('hex');
  const payload = JSON.stringify({ ids: sortedIds, systemPrompt: systemPrompt || null, rowsHash });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * Reduce an (untrusted, loosely-typed) rows table to a stable string for
 * hashing: each row -> a fixed-field-order line, then the set of lines
 * sorted before joining so row ORDER never affects the result (only
 * CONTENT does). Defensive against non-array/malformed input (falls back to
 * a plain JSON.stringify) since this runs before any request-body
 * validation in the route.
 */
function canonicalizeRowsForHash(rows: unknown): string {
  if (!Array.isArray(rows)) return JSON.stringify(rows ?? null);
  const side = (s: unknown): string => {
    if (!s || typeof s !== 'object') return '';
    const o = s as Record<string, unknown>;
    const score = typeof o.score === 'number' && Number.isFinite(o.score) ? o.score : '';
    return `${o.passFailStatus ?? ''}|${score}|${o.reportId ?? ''}`;
  };
  const lines = rows.map((r) => {
    if (!r || typeof r !== 'object') return JSON.stringify(r);
    const row = r as Record<string, unknown>;
    return `${row.testCaseId ?? ''}|${row.testCaseName ?? ''}|${side(row.a)}|${side(row.b)}`;
  });
  return lines.sort().join('\n');
}
