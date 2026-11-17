/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Jest globalTeardown — crash safety net for leaked test data.
 *
 * Per-suite `afterAll(() => tracker.cleanup())` is the primary mechanism and
 * handles the normal case, including failing assertions. It does NOT run when a
 * worker dies: `--forceExit`, a jest timeout that tears down the worker, an OOM,
 * or a Ctrl-C all skip `afterAll` and strand whatever the suite created in the
 * shared OpenSearch cluster.
 *
 * This hook closes that gap by draining the **ledgers** that `TestDataTracker`
 * writes: every tracked id is appended to `.agent-health/.test-ledger/*.jsonl`
 * the moment it is created, and the file is removed once its suite cleans up
 * successfully. So any ledger still present here belongs to a suite that died,
 * and we can delete its entities BY ID.
 *
 * Deleting by id is the whole point. The first version of this sweep instead
 * LISTED every entity and matched names against an `ahtest-` prefix; against the
 * shared cluster (~8.3k runs, ~1.5k test cases, no server-side name filter) that
 * cost ~60s on every single `npm test`. The ledger makes teardown O(orphans):
 * zero cost when nothing leaked, which is the common case.
 *
 * Durability rules (a ledger file may be the ONLY record of a leaked id, so it
 * is treated as precious):
 *  - a ledger is only unlinked when it was successfully READ **and** every
 *    entity in it was successfully deleted (or was already gone). A read error
 *    or a failed DELETE keeps the file for the next run to retry;
 *  - unlinking is per-file, so one bad ledger never blocks draining the rest.
 *
 * Strictness: with `AH_TEST_CLEANUP_STRICT=1` (set in CI's integration job)
 * this hook THROWS when the backend actively refused to delete a leaked
 * entity — jest then fails the run, so "green build with a logged leak" cannot
 * happen. It deliberately does NOT fail on:
 *  - an unreachable backend (the /health gate below returns early; tests that
 *    needed the backend already failed or skipped, and the ledgers are kept);
 *  - a non-empty but successful sweep (the data WAS recovered; that's a suite
 *    hygiene bug worth a loud warning, not a broken build);
 *  - an unreadable ledger file (kept on disk for the next run; an fs blip is
 *    not evidence of a leak).
 *
 * Set `AH_TEST_SKIP_SWEEP=1` to disable (e.g. when debugging leftover state).
 */

const fs = require('fs');
const path = require('path');

const LEDGER_DIR = path.join('.agent-health', '.test-ledger');

/**
 * Ledger marker kind written by TestDataTracker.finalizeLedger() after a fully
 * successful cleanup that deleted test cases: "re-check this test-case id for
 * LATE-WRITTEN report docs at the end of the run". A background evaluation can
 * persist its report doc long after the suite that started it finished (and
 * after cleanup()'s own bounded settle-poll gave up), referencing a test case
 * that is already deleted. This end-of-run pass runs one id-scoped search per
 * marker and deletes whatever appeared — by id, never by name, never by
 * enumerating storage. Must match RECONCILE_KIND in tests/helpers/testDataTracker.ts.
 */
const RECONCILE_KIND = 'reconcile-test-case';

/** Settle-poll pacing for the end-of-run reconciliation (OpenSearch index
 *  refresh is ~1s, so passes are spaced wider than the tracker's). */
const RECONCILE_GAP_MS = 1000;
const RECONCILE_BUDGET_MS = 15000;

/** DELETE route per entity kind. */
const DELETE_PATHS = {
  run: (id) => `/api/storage/runs/${encodeURIComponent(id)}`,
  'benchmark-run': (id, parentId) =>
    `/api/storage/benchmarks/${encodeURIComponent(parentId || '')}/runs/${encodeURIComponent(id)}`,
  'evaluation-run': (id) => `/api/storage/evaluation-runs/${encodeURIComponent(id)}`,
  'test-case': (id) => `/api/storage/test-cases/${encodeURIComponent(id)}`,
  image: (id) => `/api/storage/images/${encodeURIComponent(id)}`,
  benchmark: (id) => `/api/storage/benchmarks/${encodeURIComponent(id)}`,
  evaluator: (id) => `/api/storage/evaluators/${encodeURIComponent(id)}`,
  'custom-agent': (id) => `/api/agents/custom/${encodeURIComponent(id)}`,
  'remote-server': (id) => `/api/remote-servers/${encodeURIComponent(id)}`,
};

/**
 * Deletion order: children before parents, mirroring ENTITY_KINDS in the
 * tracker (`run` first — report docs are the leaves; see the rationale there).
 */
const KIND_ORDER = [
  'run',
  'benchmark-run',
  'evaluation-run',
  'test-case',
  'image',
  'benchmark',
  'evaluator',
  'custom-agent',
  'remote-server',
];

/**
 * mtime-based staleness FALLBACK for ledgers whose owning pid cannot be
 * determined from the filename (hand-written files, older naming schemes).
 *
 * Process liveness (below) is the primary ownership signal, because mtime is a
 * poor one: a ledger's mtime only advances when a new id is appended, so a
 * long-running jest process that created its entities early and then spent
 * hours in later suites looks exactly like a dead run. The old 2h threshold
 * made that a real hazard — a second jest invocation could adopt and delete a
 * LIVE run's in-flight data. With pid-liveness doing the real work, this
 * fallback only exists for unparseable names, and is raised to 6h to make the
 * "very slow but alive run with an unparseable ledger name" window far less
 * plausible. Cost of over-caution is tiny: an orphan just waits for a later
 * run (or `scripts/sweep-test-data.mjs`).
 */
const STALE_LEDGER_FALLBACK_MS = 6 * 60 * 60 * 1000;

/**
 * Extract the pid that OWNS a ledger file, from its name:
 *
 *   run-<AH_TEST_RUN_ID>--<writerPid>-<timestamp>-<n>.jsonl
 *
 * Preferred: the run id. jest.globalSetup.cjs generates it as
 * `<parentPid>-<timestamp>`, and the jest PARENT process is the true owner of
 * the run — it stays alive across all workers until globalTeardown finishes,
 * so its liveness is the correct "is this run still in flight?" signal.
 *
 * Fallback: the writer pid from the filename suffix, for ledgers whose run id
 * is not pid-shaped (`adhoc` from Playwright/direct use, or a custom
 * AH_TEST_RUN_ID). There the writing process IS the owner: it removes its own
 * ledger on successful cleanup, so "file present + writer dead" means either a
 * crash or a failed cleanup — both safe and correct to adopt.
 */
function parseOwnerPid(name) {
  const own = name.match(/^run-(\d+)-\d+--/);
  if (own) return Number(own[1]);
  const writer = name.match(/--(\d+)-\d+-\d+\.jsonl$/);
  if (writer) return Number(writer[1]);
  return null;
}

/**
 * Is a process with this pid alive?
 *
 * `process.kill(pid, 0)` sends no signal, it only probes:
 *  - no throw  => process exists (alive);
 *  - EPERM     => process exists but belongs to another user (alive, NOT ours
 *                 to reason about — treat as alive so we never adopt it);
 *  - ESRCH     => no such process (dead).
 *
 * Pid reuse can make a dead owner look alive (the OS recycled its pid). That
 * fails SAFE: we merely skip the ledger again; it stays on disk and is picked
 * up once the recycled pid exits, or by the retroactive sweeper.
 */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === 'EPERM');
  }
}

/**
 * Read the ledgers this teardown owns, and return the entities they reference.
 *
 * Ownership, in order:
 *  1. same `AH_TEST_RUN_ID` prefix — this run's own suites: always adopt;
 *  2. owning pid parsed from the filename is DEAD — the run can never drain its
 *     own ledger again: adopt (regardless of mtime; this also makes recovery
 *     immediate instead of hours later);
 *  3. owning pid is ALIVE — the run may still be in flight: skip, even if the
 *     file looks old (mtime only advances on append; see
 *     STALE_LEDGER_FALLBACK_MS);
 *  4. pid unparseable — fall back to mtime: adopt only past the 6h threshold.
 *
 * Returns:
 *  - `entities`: every parsed entity from readable adopted ledgers;
 *  - `files`: adopted ledger paths (readable or not);
 *  - `skipped`: count of foreign ledgers left alone (live or too recent);
 *  - `ledgers`: per-file detail `{ file, entities, readOk }` — the caller must
 *    only unlink files that were read successfully AND fully drained;
 *  - `unreadable`: adopted files that could not be read (NEVER unlink these:
 *    a transient fs error must not destroy the only record of leaked ids).
 */
function readLedgers(now = Date.now()) {
  if (!fs.existsSync(LEDGER_DIR)) {
    return { entities: [], files: [], skipped: 0, ledgers: [], unreadable: [] };
  }

  const runId = process.env.AH_TEST_RUN_ID || 'adhoc';
  const ownPrefix = `run-${runId}--`;

  const files = [];
  let skipped = 0;
  for (const name of fs.readdirSync(LEDGER_DIR)) {
    if (!name.endsWith('.jsonl')) continue;
    const full = path.join(LEDGER_DIR, name);
    if (name.startsWith(ownPrefix)) {
      files.push(full);
      continue;
    }
    const ownerPid = parseOwnerPid(name);
    if (ownerPid !== null) {
      if (pidAlive(ownerPid)) skipped += 1;
      else files.push(full);
      continue;
    }
    // No pid in the name: conservative mtime fallback.
    let stale = false;
    try {
      stale = now - fs.statSync(full).mtimeMs > STALE_LEDGER_FALLBACK_MS;
    } catch {
      stale = false;
    }
    if (stale) files.push(full);
    else skipped += 1;
  }

  const entities = [];
  const ledgers = [];
  const unreadable = [];
  for (const file of files) {
    let content;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      // Could not read: the ids inside (if any) are unknown, so the file must
      // survive this teardown. Do NOT silently drop it from bookkeeping.
      unreadable.push(file);
      ledgers.push({ file, entities: [], readOk: false });
      continue;
    }
    const fileEntities = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entity = JSON.parse(trimmed);
        // A partially-written final line (killed mid-append) is simply skipped.
        if (entity && typeof entity.id === 'string' && DELETE_PATHS[entity.kind]) {
          entities.push(entity);
          fileEntities.push(entity);
        } else if (entity && typeof entity.id === 'string' && entity.kind === RECONCILE_KIND) {
          // Late-report re-check marker (see RECONCILE_KIND above). Tracked in
          // fileEntities too so the per-file unlink rule covers it: a marker
          // whose reconciliation failed keeps its ledger for the next run.
          entities.push(entity);
          fileEntities.push(entity);
        }
      } catch {
        /* torn line: ignore */
      }
    }
    ledgers.push({ file, entities: fileEntities, readOk: true });
  }
  return { entities, files, skipped, ledgers, unreadable };
}

module.exports = async () => {
  if (process.env.AH_TEST_SKIP_SWEEP === '1') return;

  const { entities, files, ledgers, unreadable } = readLedgers();
  if (files.length === 0) return;

  const port = process.env.AH_PORT || process.env.AGENT_HEALTH_PORT || '4001';
  const baseUrl = `http://localhost:${port}`;

  const entityKey = (e) => `${e.kind}::${e.parentId || ''}::${e.id}`;

  // De-duplicate: several suites may have tracked the same id.
  const seen = new Set();
  const unique = entities.filter((e) => {
    const key = entityKey(e);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const swept = [];
  /** Late-written reports deleted by the end-of-run reconciliation pass. */
  const sweptLate = [];
  const failed = [];
  /** Keys of entities whose DELETE did not succeed — their ledgers must survive. */
  const failedKeys = new Set();
  /** True when at least one failure was an active HTTP rejection (not a network error). */
  let rejected = false;

  if (unique.length > 0) {
    // Only probe the backend when there is actually something to delete. An
    // unreachable backend keeps every ledger untouched for the next run —
    // and never fails the build, even in strict mode.
    try {
      const health = await fetch(`${baseUrl}/health`);
      if (!health.ok) return;
    } catch {
      return;
    }

    for (const kind of KIND_ORDER) {
      for (const entity of unique.filter((e) => e.kind === kind)) {
        try {
          const response = await fetch(
            `${baseUrl}${DELETE_PATHS[kind](entity.id, entity.parentId)}`,
            { method: 'DELETE' }
          );
          if (response.ok || response.status === 404 || response.status === 410) {
            swept.push(`${kind} ${entity.id}`);
          } else {
            failed.push(`${kind} ${entity.id} (HTTP ${response.status})`);
            failedKeys.add(entityKey(entity));
            rejected = true;
          }
        } catch (error) {
          // Network-level failure (backend died mid-sweep): not a rejection.
          failed.push(`${kind} ${entity.id} (${error.message})`);
          failedKeys.add(entityKey(entity));
        }
      }
    }

    // ── End-of-run late-report reconciliation (RECONCILE_KIND markers) ─────
    // Every marker is a test-case id some suite created AND successfully
    // deleted; a background evaluation may have written report docs for it
    // after that suite's cleanup finished. Search per id, delete what
    // appeared, and settle-poll (two consecutive empty passes) because a
    // report can land — or become searchable, OpenSearch refresh is ~1s —
    // while this pass runs.
    const reconcileIds = [
      ...new Set(unique.filter((e) => e.kind === RECONCILE_KIND).map((e) => e.id)),
    ];
    if (reconcileIds.length > 0) {
      const handled = new Set();
      const failedSearchIds = new Set();

      const searchOnce = async (tcId) => {
        const found = [];
        try {
          const response = await fetch(`${baseUrl}/api/storage/runs/search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ testCaseId: tcId, size: 500 }),
          });
          if (!response.ok) {
            if (!failedSearchIds.has(tcId)) {
              failedSearchIds.add(tcId);
              failed.push(`late-report search for test-case ${tcId} (HTTP ${response.status})`);
              failedKeys.add(entityKey({ kind: RECONCILE_KIND, id: tcId }));
              rejected = true;
            }
            return found;
          }
          const body = await response.json();
          for (const run of body.runs || []) {
            const id = run && run.id;
            // demo-* docs are bundled read-only sample data — never ours.
            if (typeof id !== 'string' || !id || id.startsWith('demo-')) continue;
            if (handled.has(id)) continue;
            handled.add(id);
            found.push(id);
          }
        } catch (error) {
          if (!failedSearchIds.has(tcId)) {
            failedSearchIds.add(tcId);
            failed.push(`late-report search for test-case ${tcId} (${error.message})`);
            failedKeys.add(entityKey({ kind: RECONCILE_KIND, id: tcId }));
          }
        }
        return found;
      };

      let emptyStreak = 0;
      const deadline = Date.now() + RECONCILE_BUDGET_MS;
      while (emptyStreak < 2 && Date.now() < deadline) {
        const foundThisPass = [];
        for (const tcId of reconcileIds) {
          for (const id of await searchOnce(tcId)) foundThisPass.push({ id, tcId });
        }
        if (foundThisPass.length === 0) {
          emptyStreak += 1;
          // Every search failing proves nothing; polling a broken backend
          // will not improve — the markers' ledgers are kept for retry.
          if (failedSearchIds.size >= reconcileIds.length) break;
        } else {
          emptyStreak = 0;
          for (const { id, tcId } of foundThisPass) {
            try {
              const response = await fetch(`${baseUrl}${DELETE_PATHS.run(id)}`, {
                method: 'DELETE',
              });
              if (response.ok || response.status === 404 || response.status === 410) {
                sweptLate.push(`run ${id} (late report of test-case ${tcId})`);
              } else {
                failed.push(`run ${id} (late report of test-case ${tcId}: HTTP ${response.status})`);
                failedKeys.add(entityKey({ kind: RECONCILE_KIND, id: tcId }));
                rejected = true;
              }
            } catch (error) {
              failed.push(`run ${id} (late report of test-case ${tcId}: ${error.message})`);
              failedKeys.add(entityKey({ kind: RECONCILE_KIND, id: tcId }));
            }
          }
        }
        if (emptyStreak < 2) await new Promise((resolve) => setTimeout(resolve, RECONCILE_GAP_MS));
      }
    }
  }

  // Unlink per file, and only files that were successfully read AND fully
  // drained. A file with a read error or with any undeleted entity is the only
  // durable record of those ids — keeping it is what makes retry possible.
  for (const ledger of ledgers) {
    if (!ledger.readOk) continue;
    if (ledger.entities.some((e) => failedKeys.has(entityKey(e)))) continue;
    try {
      fs.unlinkSync(ledger.file);
    } catch {
      /* best effort */
    }
  }
  // Only remove the directory when nothing (other runs' ledgers, kept files)
  // remains in it.
  try {
    if (fs.readdirSync(LEDGER_DIR).length === 0) fs.rmdirSync(LEDGER_DIR);
  } catch {
    /* best effort */
  }

  if (swept.length > 0) {
    // Loud on purpose: a non-empty sweep means some suite's afterAll did not run,
    // which is a bug in that suite even though the data is now cleaned up.
    // eslint-disable-next-line no-console
    console.warn(
      `\n[test-cleanup] swept ${swept.length} orphaned test entit${swept.length === 1 ? 'y' : 'ies'} ` +
        `left behind by this run (a suite's afterAll cleanup did not run):\n  ${swept.join('\n  ')}\n`
    );
  }
  if (sweptLate.length > 0) {
    // NOT a suite bug: these reports were written by background evaluations
    // AFTER their suite's cleanup (and its settle-poll) finished — exactly the
    // gap this end-of-run pass exists to close.
    // eslint-disable-next-line no-console
    console.warn(
      `\n[test-cleanup] reconciled ${sweptLate.length} late-written report doc${sweptLate.length === 1 ? '' : 's'} ` +
        `referencing test cases this run created and deleted:\n  ${sweptLate.join('\n  ')}\n`
    );
  }
  if (unreadable.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `\n[test-cleanup] could NOT read ${unreadable.length} ledger file(s) — kept on disk for the next run:\n  ${unreadable.join('\n  ')}\n`
    );
  }
  if (failed.length > 0) {
    const message =
      `[test-cleanup] could NOT delete ${failed.length} orphaned entit${failed.length === 1 ? 'y' : 'ies'} ` +
      `(ledger kept for retry):\n  ${failed.join('\n  ')}`;
    // Strict mode (CI): the backend was reachable (health-gated above) yet
    // actively REFUSED deletes — that is a real leak; fail the run by throwing.
    // Jest treats a globalTeardown error as a run failure even under forceExit
    // (process.exitCode would be clobbered by forceExit's explicit exit).
    // Network-only failures (backend died mid-sweep) warn instead: same
    // reasoning as the health gate above — an unreachable backend must never
    // fail the build, and the ledgers were kept for retry.
    if (process.env.AH_TEST_CLEANUP_STRICT === '1' && rejected) {
      throw new Error(message);
    }
    // eslint-disable-next-line no-console
    console.warn(`\n${message}\n`);
  }
};

module.exports.readLedgers = readLedgers;
module.exports.LEDGER_DIR = LEDGER_DIR;
