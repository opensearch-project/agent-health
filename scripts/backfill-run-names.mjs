#!/usr/bin/env node
/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * One-shot backfill: assign `Run N` names to historical TestCaseRun documents
 * that were saved before single-test-case runs gained a `name` field.
 *
 * Why
 * ---
 * Before the run-name plumbing landed, the *Configure Run* dialog accepted a
 * Name input but the server silently dropped the field. Every run created
 * during that window has no `name` in storage, so the UI's
 * `getRunDisplayName` fallback shows `Run <last-6-chars-of-id>` for them —
 * a cryptic label users (rightly) read as "garbage uuid".
 *
 * What this does
 * --------------
 * For each test case, fetches every saved run, sorts them by `timestamp`
 * (oldest first), and PATCHes any run that has no `name` with `Run <N>`,
 * counting from 1 within that test case. Existing names are left untouched.
 * The numbering matches what the dialog would have seeded had the wiring
 * been in place at the time (`Run ${runs.length + 1}`), so the post-backfill
 * runs list reads as if the feature had always existed.
 *
 * Idempotent: re-running the script is a no-op (every run already has a
 * `name`, so the inner loop skips them all). Safe to run on a live cluster
 * — uses the existing `PATCH /api/storage/runs/:id` endpoint, which only
 * updates the supplied fields.
 *
 * Usage
 * -----
 *   node scripts/backfill-run-names.mjs
 *   node scripts/backfill-run-names.mjs --dry-run        # print, don't write
 *   node scripts/backfill-run-names.mjs --base http://localhost:4001
 */

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const baseIdx = args.indexOf('--base');
const BASE_URL = baseIdx >= 0 && args[baseIdx + 1]
  ? args[baseIdx + 1]
  : (process.env.AH_BACKEND || process.env.AGENT_HEALTH_BACKEND || 'http://localhost:4001');

const DEFAULT_PAGE_SIZE = 1000;

/** Fetch every test case in the cluster (paginated). */
async function fetchAllTestCases() {
  const items = [];
  let from = 0;
  // The server's /api/storage/test-cases endpoint paginates with size+from;
  // we just walk pages until total is exhausted.
  while (true) {
    const url = `${BASE_URL}/api/storage/test-cases?size=${DEFAULT_PAGE_SIZE}&from=${from}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
    const data = await res.json();
    const page = data.testCases || [];
    items.push(...page);
    if (page.length < DEFAULT_PAGE_SIZE) break;
    from += page.length;
  }
  return items;
}

/** Fetch every run for a given test case (paginated). */
async function fetchRunsForTestCase(testCaseId) {
  const items = [];
  let from = 0;
  while (true) {
    const url = `${BASE_URL}/api/storage/runs/by-test-case/${encodeURIComponent(testCaseId)}?size=${DEFAULT_PAGE_SIZE}&from=${from}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
    const data = await res.json();
    const page = data.runs || [];
    items.push(...page);
    if (page.length < DEFAULT_PAGE_SIZE) break;
    from += page.length;
  }
  return items;
}

/** PATCH a run with a new name. */
async function patchRunName(runId, name) {
  const url = `${BASE_URL}/api/storage/runs/${encodeURIComponent(runId)}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`PATCH ${url} → ${res.status} ${body}`);
  }
}

/** Compare timestamps with safe fallback so undefined doesn't sort last. */
function tsKey(run) {
  const t = run.timestamp || run.createdAt;
  if (!t) return 0;
  const ms = new Date(t).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

async function main() {
  console.log(`[backfill] Backend: ${BASE_URL}`);
  console.log(`[backfill] Mode:    ${isDryRun ? 'DRY-RUN (no writes)' : 'WRITE'}`);

  // 1. Discover test cases.
  console.log('[backfill] Fetching all test cases…');
  const testCases = await fetchAllTestCases();
  console.log(`[backfill] Found ${testCases.length} test case(s).`);

  // 2. For each test case, name its unnamed runs.
  let totalRuns = 0;
  let totalUnnamed = 0;
  let totalRenamed = 0;
  let totalErrors = 0;

  for (const tc of testCases) {
    const tcId = tc.id;
    const runs = await fetchRunsForTestCase(tcId);
    if (runs.length === 0) continue;
    totalRuns += runs.length;

    // Sort oldest → newest so `Run 1` is the first one ever made.
    runs.sort((a, b) => tsKey(a) - tsKey(b));

    let counter = 0; // increments for every run, named or not, so the
                     // numbers match what the dialog would have seeded
                     // (`Run ${runs.length + 1}`) at each point in history.
    for (const run of runs) {
      counter++;
      const existing = (run.name || '').trim();
      if (existing) continue; // already named — leave alone
      totalUnnamed++;
      const newName = `Run ${counter}`;

      if (isDryRun) {
        console.log(`  [dry] ${tc.name || tcId} :: ${run.id} → ${newName}`);
        totalRenamed++;
        continue;
      }

      try {
        await patchRunName(run.id, newName);
        totalRenamed++;
      } catch (err) {
        totalErrors++;
        console.warn(`  [error] ${run.id}: ${err.message}`);
      }
    }
  }

  console.log('[backfill] ----------------------------------------');
  console.log(`[backfill] Total runs scanned: ${totalRuns}`);
  console.log(`[backfill] Unnamed runs:       ${totalUnnamed}`);
  console.log(`[backfill] Renamed:            ${totalRenamed}${isDryRun ? ' (dry-run)' : ''}`);
  if (totalErrors) console.log(`[backfill] Errors:             ${totalErrors}`);
  if (isDryRun) {
    console.log('[backfill] Re-run without --dry-run to apply.');
  }
}

main().catch(err => {
  console.error('[backfill] Fatal:', err);
  process.exit(1);
});
