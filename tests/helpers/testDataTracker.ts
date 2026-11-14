/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fsModule from 'node:fs';

/**
 * Shared test-data tracker + cleaner.
 *
 * ## Why this exists
 *
 * Integration and e2e tests create **real** persisted entities (test cases,
 * benchmarks, evaluation runs, benchmark runs, evaluators, images) by hitting the
 * backend storage API. The backend those tests talk to is resolved from
 * `AH_PORT` and defaults to `localhost:4001` — which in this developer's setup is
 * a **live server wired to a shared OpenSearch cluster**. Anything a test creates
 * and fails to delete is permanent clutter in that shared cluster (or, when the
 * backend uses the file adapter, permanent JSON files under
 * `.agent-health/data/**`).
 *
 * The repo convention (AGENTS.md, "Integration Test Cleanup") is: track every
 * created id and delete it in `afterAll`. Hand-rolling that per file is exactly
 * where the leaks come from — a test creates three kinds of entity and the
 * `afterAll` only deletes one, or the cleanup is skipped on an early return.
 *
 * This module centralises it:
 *
 * ```ts
 * const tracker = createTestDataTracker();          // reads AH_PORT
 * afterAll(() => tracker.cleanup());                // deletes everything, always
 *
 * const tc = await createTestCase(...);
 * tracker.testCase(tc.id);                          // one line per created entity
 * ```
 *
 * Cleanup is:
 *  - **ordered** — children before parents, so nothing is orphaned;
 *  - **idempotent** — a 404 is success (entity already gone / cascade-deleted);
 *  - **non-throwing** by default — a cleanup failure must not turn a passing
 *    suite red, but it is reported (and `AH_TEST_CLEANUP_STRICT=1` makes it throw
 *    so CI can enforce zero-leak);
 *  - **de-duplicated** — tracking the same id twice deletes once.
 */

/**
 * Entity kinds this tracker can delete, in the order they must be deleted.
 *
 * Strictly leaf-to-root: `run` (report docs) before `benchmark-run` before
 * `benchmark`. Reports are conceptually children of a benchmark-run, and the
 * benchmark-run projection (`benchmark.runs[].results[*].reportId`) is the only
 * server-side lookup table from a run to its report ids — deleting reports
 * first means that projection is never destroyed while its children still
 * exist. In practice this is belt-and-braces: recovery never walks projections
 * (every report id is appended to the crash ledger at track() time, before any
 * cleanup starts, so a cleanup that dies mid-stream still leaves the report
 * ids recoverable BY ID) — but leaf-first order keeps the invariant true even
 * if the ledger write failed.
 */
export const ENTITY_KINDS = [
  'run', // test-case run / report -> leaf: child of benchmark-run / evaluation-run
  'benchmark-run', // child of benchmark -> delete before its benchmark
  'evaluation-run', // references benchmarks + test cases
  'test-case', // referenced by runs
  'image', // referenced by test cases
  'benchmark', // parent of benchmark-run
  'evaluator', // referenced by benchmarks/runs
  'custom-agent',
  'remote-server',
] as const;

export type EntityKind = (typeof ENTITY_KINDS)[number];

/** A tracked entity awaiting deletion. */
interface TrackedEntity {
  kind: EntityKind;
  /** Entity id (or image digest, or agent/server name). */
  id: string;
  /** Parent id — only used by `benchmark-run`, whose DELETE route is nested. */
  parentId?: string;
}

export interface CleanupResult {
  /** Entities successfully deleted (or already absent). */
  deleted: number;
  /**
   * Report ids DISCOVERED by reconciliation (never explicitly tracked) that
   * were deleted because they reference a tracked test-case id. These are the
   * "late-written report" leaks: an evaluation kept executing in the
   * background after its test moved on, and persisted its report doc after
   * the suite's afterAll had already harvested everything it could see.
   */
  reconciled: string[];
  /**
   * Test-case ids whose reconciliation SEARCH failed — we could not verify
   * that no late-written reports reference them. Kept separate from `failed`
   * (which is strictly "tracked entity failed to delete") so callers'
   * assertions about tracked entities stay precise. Strict mode treats an
   * actively-rejected search like a rejected delete.
   */
  reconcileFailed: Array<{ testCaseId: string; reason: string; unreachable?: boolean }>;
  /**
   * Entities we failed to delete — these are real leaks.
   *
   * `unreachable: true` marks network-level failures (fetch threw: connection
   * refused / reset / DNS), i.e. the backend itself was unreachable, as opposed
   * to the backend actively rejecting the DELETE (HTTP 5xx/403/...). The
   * distinction matters for `AH_TEST_CLEANUP_STRICT`: see cleanup().
   */
  failed: Array<{ kind: EntityKind; id: string; reason: string; unreachable?: boolean }>;
}

/** Resolve the backend base URL the same way `tests/integration/testConfig.ts` does. */
export function getTestBackendUrl(): string {
  const port = process.env.AH_PORT || process.env.AGENT_HEALTH_PORT || '4001';
  return `http://localhost:${port}`;
}

/**
 * Prefix stamped on every entity name created by tests.
 *
 * Two purposes:
 *  1. makes test rows obvious in the shared cluster UI;
 *  2. lets the sweeper (`scripts/sweep-test-data.mjs`) safely bulk-delete
 *     leftovers from tests that crashed before `afterAll` could run — it only
 *     ever deletes names carrying this prefix, so real user data is never at
 *     risk.
 */
export const AH_TEST_PREFIX = 'ahtest-';

let uniqueCounter = 0;

/**
 * Directory holding crash-recovery ledgers.
 *
 * Every id is appended here the moment it is tracked, so if the worker is killed
 * before `afterAll` runs (jest timeout, `--forceExit`, OOM, Ctrl-C) the ids
 * survive on disk and `jest.globalTeardown.cjs` can delete them by id.
 *
 * This replaced a name-pattern sweep that had to LIST every entity to find
 * orphans: on a shared cluster holding ~8.3k runs and ~1.5k test cases that cost
 * ~60s per jest invocation. Deleting by id from a ledger is O(orphans) and needs
 * no listing at all. `.agent-health/` is already gitignored.
 */
export const LEDGER_DIR = '.agent-health/.test-ledger';

/**
 * Ledger line kind that asks `jest.globalTeardown.cjs` to re-check a
 * test-case id for LATE-WRITTEN report docs at the very end of the run.
 *
 * cleanup()'s own settle-poll (below) is bounded to a few seconds, but a
 * background evaluation can persist its report doc tens of seconds after the
 * suite that started it finished — measured live: 14 report docs, all from
 * the `demo` agent, written in the final minute of a 201s integration run,
 * every one referencing a test case its suite had already deleted. Rewriting
 * the ledger with these markers (instead of unlinking it) lets globalTeardown
 * run one final id-scoped reconciliation pass after ALL suites are done.
 */
export const RECONCILE_KIND = 'reconcile-test-case';

/** Delay between reconciliation settle-poll passes inside cleanup(). */
const RECONCILE_GAP_MS = 250;

/**
 * Total settle-poll budget after the tracked entities are deleted. Bounded so
 * a suite's afterAll can never hang; overridable for tests via
 * `AH_TEST_RECONCILE_BUDGET_MS`. `0` disables the settle-poll (the pre-delete
 * reconciliation pass still runs).
 */
function reconcileBudgetMs(): number {
  const raw = Number(process.env.AH_TEST_RECONCILE_BUDGET_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 4000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Node's fs, resolved statically.
 *
 * This USED to be a lazy `require('fs')` inside a try/catch "so importing this
 * module never breaks a browser bundle" — but the package is `"type":
 * "module"`, so Playwright compiles specs (and this helper) as ESM where
 * `require` is undefined: the catch swallowed the ReferenceError and every
 * e2e tracker silently ran with NO crash ledger at all. A static import works
 * in both module systems (ts-jest emits CJS `require`, Playwright's esbuild
 * keeps the ESM import), and no browser bundle imports this tests-only
 * helper — if one ever does, a loud build error beats a silently-disabled
 * safety net.
 */
function nodeFs(): typeof import('fs') | null {
  return fsModule;
}

/**
 * Build a collision-free, sweeper-recognisable entity name.
 *
 * Includes pid + timestamp + counter so parallel jest workers / playwright
 * workers never collide on a name.
 */
export function uniqueTestName(label = 'entity'): string {
  uniqueCounter += 1;
  const safeLabel = label.replace(/[^a-zA-Z0-9._-]/g, '-');
  return `${AH_TEST_PREFIX}${safeLabel}-${process.pid}-${Date.now()}-${uniqueCounter}`;
}

/** True when a name looks like it was created by our test suites. */
export function isTestEntityName(name: unknown): boolean {
  return typeof name === 'string' && name.startsWith(AH_TEST_PREFIX);
}

/** Build the DELETE path for a tracked entity. */
function deletePath(entity: TrackedEntity): string {
  const id = encodeURIComponent(entity.id);
  switch (entity.kind) {
    case 'test-case':
      return `/api/storage/test-cases/${id}`;
    case 'benchmark':
      return `/api/storage/benchmarks/${id}`;
    case 'benchmark-run':
      return `/api/storage/benchmarks/${encodeURIComponent(entity.parentId ?? '')}/runs/${id}`;
    case 'evaluation-run':
      return `/api/storage/evaluation-runs/${id}`;
    case 'run':
      return `/api/storage/runs/${id}`;
    case 'evaluator':
      return `/api/storage/evaluators/${id}`;
    case 'image':
      return `/api/storage/images/${id}`;
    case 'custom-agent':
      return `/api/agents/custom/${id}`;
    case 'remote-server':
      return `/api/remote-servers/${id}`;
    default: {
      const exhaustive: never = entity.kind;
      throw new Error(`Unhandled entity kind: ${String(exhaustive)}`);
    }
  }
}

export class TestDataTracker {
  private readonly baseUrl: string;
  private readonly entities: TrackedEntity[] = [];
  private readonly seen = new Set<string>();
  private readonly ledgerPath: string | null;
  /**
   * Test-case ids from fully-successful cleanups, carried into the ledger as
   * RECONCILE_KIND markers for globalTeardown's end-of-run re-check.
   */
  private readonly reconcilePending = new Set<string>();

  constructor(baseUrl: string = getTestBackendUrl()) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.ledgerPath = this.initLedger();
  }

  /** Create this tracker's ledger file. Returns null when fs is unavailable. */
  private initLedger(): string | null {
    if (process.env.AH_TEST_LEDGER_DISABLED === '1') return null;
    const fs = nodeFs();
    if (!fs) return null;
    try {
      fs.mkdirSync(LEDGER_DIR, { recursive: true });
      uniqueCounter += 1;
      // The run id (set by jest.globalSetup.cjs) scopes this ledger to the
      // current jest run so a concurrent run's teardown won't drain it.
      // `adhoc` covers direct/Playwright use where globalSetup didn't run.
      const runId = process.env.AH_TEST_RUN_ID || 'adhoc';
      return `${LEDGER_DIR}/run-${runId}--${process.pid}-${Date.now()}-${uniqueCounter}.jsonl`;
    } catch {
      return null;
    }
  }

  /**
   * Append one entity to the on-disk ledger.
   *
   * Synchronous and best-effort on purpose: it must complete before a possible
   * SIGKILL, and a ledger problem must never fail the test that is running.
   */
  private appendToLedger(entity: TrackedEntity): void {
    if (!this.ledgerPath) return;
    const fs = nodeFs();
    if (!fs) return;
    try {
      fs.appendFileSync(this.ledgerPath, `${JSON.stringify(entity)}\n`);
    } catch {
      /* best effort */
    }
  }

  /**
   * Remove this tracker's ledger — or, when this cleanup deleted test cases,
   * REWRITE it with `RECONCILE_KIND` markers so `jest.globalTeardown.cjs` can
   * re-check those ids for late-written reports at the end of the whole run
   * (see RECONCILE_KIND). Only called after a fully-successful cleanup; on any
   * failure the original entity lines are kept for retry.
   */
  private finalizeLedger(): void {
    if (!this.ledgerPath) return;
    const fs = nodeFs();
    if (!fs) return;
    try {
      if (this.reconcilePending.size === 0) {
        if (fs.existsSync(this.ledgerPath)) fs.unlinkSync(this.ledgerPath);
        return;
      }
      const lines = [...this.reconcilePending]
        .map((id) => `${JSON.stringify({ kind: RECONCILE_KIND, id })}\n`)
        .join('');
      fs.writeFileSync(this.ledgerPath, lines);
    } catch {
      /* best effort */
    }
  }

  /** Generic tracking hook. Ignores empty/nullish ids so callers can be terse. */
  track(kind: EntityKind, id: string | null | undefined, parentId?: string): void {
    if (!id) return;
    const key = `${kind}::${parentId ?? ''}::${id}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    const entity: TrackedEntity = { kind, id, parentId };
    this.entities.push(entity);
    this.appendToLedger(entity);
  }

  /** Track many ids of one kind (handles `{id}` objects or bare id strings). */
  trackAll(
    kind: EntityKind,
    ids: Array<string | { id?: string } | null | undefined> | null | undefined,
    parentId?: string
  ): void {
    for (const item of ids ?? []) {
      if (!item) continue;
      this.track(kind, typeof item === 'string' ? item : item.id, parentId);
    }
  }

  // ── Typed convenience wrappers (read better at call sites) ────────────────
  testCase(id: string | null | undefined): void {
    this.track('test-case', id);
  }
  testCases(ids: Array<string | { id?: string } | null | undefined> | null | undefined): void {
    this.trackAll('test-case', ids);
  }
  benchmark(id: string | null | undefined): void {
    this.track('benchmark', id);
  }
  /**
   * Track a benchmark run. Benchmark runs are EMBEDDED subdocuments of their
   * benchmark, so the DELETE route is nested and `benchmarkId` must be the run's
   * REAL parent.
   *
   * KNOWN LIMITATION (accepted, documented): the nested route returns 404 both
   * when the run is missing and when the whole benchmark is missing, and
   * cleanup treats 404 as success. A caller who passes the WRONG parent id
   * therefore gets a silent "success" while the real embedded run lives on
   * under its true parent. We deliberately do NOT probe the parent to
   * disambiguate, because no probe can catch the harmful case:
   *   - parent missing => the benchmark doc is gone, and embedded runs die with
   *     their parent doc => genuinely gone, success is CORRECT;
   *   - parent present, run missing => indistinguishable from "already
   *     cleaned up / cascade-deleted", which must stay a success (idempotence);
   *   - wrong-but-EXISTING parent => the OpenSearch adapter's removeIf script
   *     removes nothing and reports plain 200 success, so not even a 404-side
   *     check would fire.
   * The practical mitigation is that suites track the parent benchmark too
   * (delete of the parent removes every embedded run), which the integration
   * suite exercises.
   */
  benchmarkRun(benchmarkId: string | null | undefined, runId: string | null | undefined): void {
    if (!benchmarkId) return;
    this.track('benchmark-run', runId, benchmarkId);
  }
  evaluationRun(id: string | null | undefined): void {
    this.track('evaluation-run', id);
  }
  run(id: string | null | undefined): void {
    this.track('run', id);
  }
  evaluator(id: string | null | undefined): void {
    this.track('evaluator', id);
  }
  image(digest: string | null | undefined): void {
    this.track('image', digest);
  }
  customAgent(id: string | null | undefined): void {
    this.track('custom-agent', id);
  }
  remoteServer(name: string | null | undefined): void {
    this.track('remote-server', name);
  }

  /** How many entities are pending deletion (useful in assertions). */
  get size(): number {
    return this.entities.length;
  }

  /**
   * Path of this tracker's crash-recovery ledger, or null when disabled.
   *
   * Exposed so tests can assert the ledger is removed after a successful
   * cleanup without depending on the state of other trackers.
   */
  get ledgerFile(): string | null {
    return this.ledgerPath;
  }

  /** Snapshot of pending entities (test-only introspection). */
  pending(): ReadonlyArray<Readonly<TrackedEntity>> {
    return this.entities.map((e) => ({ ...e }));
  }

  /**
   * Delete every tracked entity, children before parents — then RECONCILE:
   * for every test-case id this cleanup deleted, search for report docs that
   * reference it and delete any that appeared (id-scoped: the search key is an
   * id THIS tracker was given; nothing is ever matched by name and storage is
   * never enumerated).
   *
   * Why reconciliation exists: an evaluation keeps executing in the background
   * after a test moves on (cancellation flips status synchronously while the
   * in-flight test case keeps running), so its report doc can be written AFTER
   * afterAll already harvested every id it could see. The tracker never knew
   * that id — a tracking-completeness gap, not a teardown gap. The pre-delete
   * pass catches reports that already landed (and deletes them BEFORE their
   * test cases, preserving child-before-parent); the bounded settle-poll after
   * deletion catches ones that land during cleanup (re-query until two
   * consecutive passes discover nothing new, within reconcileBudgetMs());
   * anything later still is caught by globalTeardown via the RECONCILE_KIND
   * ledger markers finalizeLedger() writes.
   *
   * Safe to call more than once. Successfully deleted entities are never
   * retried; entities that FAILED to delete (and any never attempted because
   * cleanup was interrupted) are RE-QUEUED, so a later cleanup() call retries
   * them. The in-memory queue is therefore never lost to a transient error —
   * important because the on-disk ledger append is best-effort and this queue
   * can be the only record of an id. On the all-success path the queue drains
   * completely, so a second call issues no requests (idempotent).
   *
   * Never throws unless `AH_TEST_CLEANUP_STRICT=1` — and even then only for
   * failures where the backend actively REJECTED a delete (or a reconciliation
   * search). Network-level failures (backend unreachable / died mid-suite)
   * warn instead of throwing in strict mode too: tests that needed the backend
   * have already failed or skipped, and turning "backend went away" into a red
   * cleanup would destabilise CI. The leaked ids stay in the ledger and in
   * this queue, and jest.globalTeardown.cjs retries them (health-gated) at the
   * end of the run.
   */
  async cleanup(): Promise<CleanupResult> {
    const queue = this.entities.splice(0, this.entities.length);
    this.seen.clear();
    const result: CleanupResult = { deleted: 0, reconciled: [], reconcileFailed: [], failed: [] };
    /** Entities proven gone; everything else is re-queued in `finally`. */
    const succeeded = new Set<TrackedEntity>();

    // Small concurrency cap: fast, but never stampedes a shared cluster.
    const CONCURRENCY = 4;

    const deleteOne = async (entity: TrackedEntity): Promise<void> => {
      try {
        const response = await fetch(`${this.baseUrl}${deletePath(entity)}`, {
          method: 'DELETE',
        });
        // 404/410 => already gone (cascade delete or a prior cleanup): success.
        if (response.ok || response.status === 404 || response.status === 410) {
          result.deleted += 1;
          succeeded.add(entity);
          return;
        }
        result.failed.push({
          kind: entity.kind,
          id: entity.id,
          reason: `HTTP ${response.status}`,
        });
      } catch (error) {
        result.failed.push({
          kind: entity.kind,
          id: entity.id,
          reason: error instanceof Error ? error.message : String(error),
          unreachable: true,
        });
      }
    };

    // ── Reconciliation plumbing ─────────────────────────────────────
    const tcIds = queue.filter((e) => e.kind === 'test-case').map((e) => e.id);
    /** Report ids already handled (tracked or discovered) — never re-deleted. */
    const handledRunIds = new Set(queue.filter((e) => e.kind === 'run').map((e) => e.id));
    /** Search failures deduped per test-case id (a broken backend would
     *  otherwise produce one entry per settle pass). */
    const reconcileFailedIds = new Set<string>();

    /** One id-scoped search: report docs referencing this tracked test case. */
    const searchReports = async (tcId: string): Promise<string[] | null> => {
      try {
        const response = await fetch(`${this.baseUrl}/api/storage/runs/search`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ testCaseId: tcId, size: 500 }),
        });
        if (!response.ok) {
          if (!reconcileFailedIds.has(tcId)) {
            reconcileFailedIds.add(tcId);
            result.reconcileFailed.push({ testCaseId: tcId, reason: `HTTP ${response.status}` });
          }
          return null;
        }
        const body = (await response.json()) as { runs?: Array<{ id?: unknown }> };
        return (body.runs ?? [])
          .map((r) => r?.id)
          .filter(
            (id): id is string =>
              // `demo-` docs are the bundled read-only sample data the search
              // route mixes into every response — never ours, never deletable.
              typeof id === 'string' && id.length > 0 && !id.startsWith('demo-')
          );
      } catch (error) {
        if (!reconcileFailedIds.has(tcId)) {
          reconcileFailedIds.add(tcId);
          result.reconcileFailed.push({
            testCaseId: tcId,
            reason: error instanceof Error ? error.message : String(error),
            unreachable: true,
          });
        }
        return null;
      }
    };

    /** One reconciliation pass over every tracked test-case id. */
    const discoverReports = async (): Promise<TrackedEntity[]> => {
      const found: TrackedEntity[] = [];
      for (let i = 0; i < tcIds.length; i += CONCURRENCY) {
        await Promise.all(
          tcIds.slice(i, i + CONCURRENCY).map(async (tcId) => {
            const ids = await searchReports(tcId);
            for (const id of ids ?? []) {
              if (handledRunIds.has(id)) continue;
              handledRunIds.add(id);
              found.push({ kind: 'run', id });
            }
          })
        );
      }
      // Every discovered report goes to the crash ledger BEFORE any delete is
      // attempted, and into the queue so the `finally` re-queue covers it.
      for (const entity of found) {
        this.appendToLedger(entity);
        queue.push(entity);
        result.reconciled.push(entity.id);
      }
      return found;
    };

    try {
      // Pre-delete reconciliation: reports that ALREADY landed join the `run`
      // batch below, so they are deleted before the test cases they reference.
      if (tcIds.length > 0) await discoverReports();
      const preFoundNothing = result.reconciled.length === 0;

      for (const kind of ENTITY_KINDS) {
        const batch = queue.filter((e) => e.kind === kind);
        if (batch.length === 0) continue;
        for (let i = 0; i < batch.length; i += CONCURRENCY) {
          await Promise.all(batch.slice(i, i + CONCURRENCY).map(deleteOne));
        }
      }

      // Post-delete settle-poll: a report can land AFTER the pre-pass query
      // too. Re-query until two consecutive passes discover nothing new,
      // bounded by reconcileBudgetMs(). Common case (nothing ever found):
      // one confirming pass after a single short gap, then exit.
      if (tcIds.length > 0) {
        let emptyStreak = preFoundNothing ? 1 : 0;
        const deadline = Date.now() + reconcileBudgetMs();
        while (emptyStreak < 2 && Date.now() < deadline) {
          await sleep(RECONCILE_GAP_MS);
          const late = await discoverReports();
          if (late.length === 0) {
            emptyStreak += 1;
            // A pass where EVERY search failed proves nothing and will not
            // improve by polling a broken backend — bail out.
            if (reconcileFailedIds.size >= tcIds.length) break;
            continue;
          }
          emptyStreak = 0;
          for (let i = 0; i < late.length; i += CONCURRENCY) {
            await Promise.all(late.slice(i, i + CONCURRENCY).map(deleteOne));
          }
        }
      }
    } finally {
      // Re-queue everything not proven gone (failed + never attempted), in the
      // original order, restoring de-dup keys so re-tracking stays idempotent.
      // No ledger re-append: each survivor's original track() line is still on
      // disk, because the ledger is only cleared on full success below.
      for (const entity of queue) {
        if (succeeded.has(entity)) continue;
        const key = `${entity.kind}::${entity.parentId ?? ''}::${entity.id}`;
        if (this.seen.has(key)) continue;
        this.seen.add(key);
        this.entities.push(entity);
      }
    }

    if (result.failed.length > 0 || result.reconcileFailed.length > 0) {
      const parts: string[] = [];
      if (result.failed.length > 0) {
        const detail = result.failed
          .map((f) => `${f.kind} ${f.id} (${f.reason})`)
          .join(', ');
        parts.push(
          `failed to delete ${result.failed.length} entit${
            result.failed.length === 1 ? 'y' : 'ies'
          } (kept queued + in the crash ledger for retry): ${detail}`
        );
      }
      if (result.reconcileFailed.length > 0) {
        const detail = result.reconcileFailed
          .map((f) => `${f.testCaseId} (${f.reason})`)
          .join(', ');
        parts.push(
          `could not verify ${result.reconcileFailed.length} test-case id(s) for late-written reports: ${detail}`
        );
      }
      const message = `[test-cleanup] ${parts.join('; ')}`;
      // Strict mode throws only when the backend actively rejected a delete or
      // a reconciliation search. "Backend unreachable" must not fail an
      // otherwise-green build; see the method docstring for the full reasoning.
      const rejected =
        result.failed.some((f) => !f.unreachable) ||
        result.reconcileFailed.some((f) => !f.unreachable);
      if (process.env.AH_TEST_CLEANUP_STRICT === '1' && rejected) {
        throw new Error(message);
      }
      // eslint-disable-next-line no-console
      console.warn(message);
    } else {
      // Everything is gone. Deleted test-case ids graduate into reconcile
      // markers so globalTeardown re-checks them for late-written reports at
      // the very end of the run; with no test cases the ledger is removed.
      for (const tcId of tcIds) this.reconcilePending.add(tcId);
      this.finalizeLedger();
    }

    return result;
  }
}

/** Create a tracker bound to the backend under test. */
export function createTestDataTracker(baseUrl?: string): TestDataTracker {
  return new TestDataTracker(baseUrl);
}
