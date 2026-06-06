/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for the SDK / code-import dedup contract on
 * `POST /api/storage/test-cases/bulk`.
 *
 * Why this test exists
 * ────────────────────
 * The CLI's legacy single-file mode (`agent-health benchmark -f file.eval.js`)
 * called the bulk endpoint on every run. Pre-fix, the endpoint always
 * routed to `bulkCreate` regardless of provenance, so SDK / code-imported
 * test cases minted fresh `tc-<timestamp>-<random>` IDs every time the
 * same .eval.js was run. Combined with the CLI's set-union merge into
 * the existing benchmark, this made `benchmark.testCaseIds` grow by N
 * every run for an N-test file — duplicates of the same logical test
 * accumulating side-by-side in the run inspector.
 *
 * The fix auto-routes on the server: if any incoming test case has a
 * non-empty `sourceFile`, the endpoint dispatches to `bulkUpsert`,
 * which dedups by `(name, sourceFile)` and bumps the version on
 * `sourceHash` drift. JSON imports / UI uploads (no `sourceFile`) keep
 * the strict-create semantics.
 *
 * This test pins the contract end-to-end against the live HTTP API so
 * any future refactor that re-introduces always-create on SDK input
 * (e.g. removing the `hasSourceFile` branch, or adding a "force create"
 * shortcut that bypasses dedup) shows up as a single targeted failure
 * instead of as cross-run benchmark bloat in production.
 *
 * What we cover
 * ─────────────
 *   1. SDK upsert path (sourceFile + sourceHash present):
 *      • First call → `created: 1, updated: 0, unchanged: 0`, returns id-A.
 *      • Same payload (same hash) → `unchanged: 1`, returns id-A again.
 *      • Same name+sourceFile but different hash → `updated: 1`, returns
 *        id-A with `currentVersion` bumped.
 *      • Same name, different sourceFile → `created: 1`, returns id-B
 *        (different file = different identity).
 *      • Different name, same sourceFile → `created: 1`, returns id-C.
 *
 *   2. JSON path (no sourceFile) is untouched:
 *      • Response shape stays `{ created, errors, testCases }` with
 *        no `updated` / `unchanged` keys.
 *      • Repeating the call mints fresh IDs (legacy create-only behavior).
 *
 *   3. Mixed batches (some items have sourceFile, others don't) hit the
 *      upsert path because the route gates on `testCases.some(...)`.
 *      The test pins this so a future caller that sends mixed batches
 *      doesn't get surprised.
 *
 * Prerequisites
 * ─────────────
 *   • Backend running with OpenSearch storage configured. Self-skips
 *     otherwise (warns, no-ops).
 *
 * Cleanup
 * ───────
 *   • Every TestCase ID created during the test is recorded in
 *     `createdTestCaseIds[]` and deleted in `afterAll`. The `afterAll`
 *     also sweeps any leftover docs whose name starts with the test's
 *     unique prefix to catch leaks from a previously failed run.
 */

import { ApiClient } from '@/cli/utils/apiClient';
import { getTestBackendUrl } from '@/tests/integration/testConfig';

const TEST_TIMEOUT = 30_000;
const BASE_URL = getTestBackendUrl();

const checkBackend = async (): Promise<boolean> => {
  try {
    const r = await fetch(`${BASE_URL}/health`);
    if (!r.ok) return false;
    const sh = await fetch(`${BASE_URL}/api/storage/health`);
    const sd = await sh.json();
    return sd.status === 'ok';
  } catch {
    return false;
  }
};

interface BulkResponse {
  created: number;
  errors: number;
  updated?: number;
  unchanged?: number;
  testCases: Array<{ id: string; name: string; sourceFile?: string; sourceHash?: string; currentVersion?: number; version?: number }>;
}

async function postBulk(testCases: any[]): Promise<{ status: number; body: BulkResponse }> {
  const r = await fetch(`${BASE_URL}/api/storage/test-cases/bulk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ testCases }),
  });
  const body = await r.json();
  return { status: r.status, body };
}

describe('SDK dedup contract — POST /api/storage/test-cases/bulk', () => {
  let backendAvailable = false;
  let client: ApiClient;
  // Per-run prefix: every TC and benchmark name gets this prefix so
  // parallel jest workers / repeated runs don't collide, and the cleanup
  // sweeper has a unique handle to find leaks.
  const NAME_PREFIX = `dedup-integ-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const createdTestCaseIds: string[] = [];

  beforeAll(async () => {
    backendAvailable = await checkBackend();
    if (!backendAvailable) {
      // eslint-disable-next-line no-console
      console.warn(`[dedup-integ] Backend not reachable at ${BASE_URL} — skipping. Start with: npm run dev:server`);
    }
    client = new ApiClient(BASE_URL);
  }, TEST_TIMEOUT);

  afterAll(async () => {
    if (!backendAvailable) return;
    // Primary cleanup: delete every ID we know we created.
    await Promise.all(
      createdTestCaseIds.map(id =>
        fetch(`${BASE_URL}/api/storage/test-cases/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {})
      )
    );
    // Secondary sweep: delete any leftover TCs whose name starts with our
    // unique prefix (catches docs that were created but never tracked,
    // e.g. if an assertion failed before pushing into the array).
    try {
      const r = await fetch(`${BASE_URL}/api/storage/test-cases?size=500`);
      if (r.ok) {
        const data = await r.json();
        const leftovers: Promise<any>[] = [];
        for (const tc of (data.testCases || data.items || [])) {
          if (typeof tc.name === 'string' && tc.name.startsWith(NAME_PREFIX)) {
            leftovers.push(
              fetch(`${BASE_URL}/api/storage/test-cases/${encodeURIComponent(tc.id)}`, { method: 'DELETE' }).catch(() => {})
            );
          }
        }
        await Promise.all(leftovers);
      }
    } catch {
      /* best-effort */
    }
  }, 60_000);

  // ─────────────────────────────────────────────────────────────────
  // SDK upsert path — same name + sourceFile must round-trip the SAME id.
  // ─────────────────────────────────────────────────────────────────
  describe('SDK path (sourceFile present)', () => {
    it('first import returns created=1 with the upsert response shape', async () => {
      if (!backendAvailable) return;

      const tc = {
        name: `${NAME_PREFIX}-sdk-stable-id`,
        description: 'first import — should be created',
        initialPrompt: 'noop',
        context: [],
        labels: ['category:Smoke'],
        sourceFile: `evals/${NAME_PREFIX}.eval.js`,
        sourceHash: 'hash-v1',
      };

      const { status, body } = await postBulk([tc]);
      expect(status).toBe(200);
      // Upsert response shape: created/updated/unchanged are all present.
      expect(body.created).toBe(1);
      expect(body.updated).toBe(0);
      expect(body.unchanged).toBe(0);
      expect(body.testCases).toHaveLength(1);
      expect(body.testCases[0].id).toMatch(/^tc-/);
      createdTestCaseIds.push(body.testCases[0].id);
    }, TEST_TIMEOUT);

    it('re-importing the same (name, sourceFile, sourceHash) returns unchanged=1 and SAME id', async () => {
      if (!backendAvailable) return;

      const tc = {
        name: `${NAME_PREFIX}-sdk-stable-id`,
        description: 'first import — should be created',
        initialPrompt: 'noop',
        context: [],
        labels: ['category:Smoke'],
        sourceFile: `evals/${NAME_PREFIX}.eval.js`,
        sourceHash: 'hash-v1',
      };

      const first = (await postBulk([tc])).body;
      const second = (await postBulk([tc])).body;

      // Re-import must NOT mint a new id — that's the bug this test pins.
      expect(second.created).toBe(0);
      expect(second.updated).toBe(0);
      expect(second.unchanged).toBe(1);
      expect(second.testCases[0].id).toBe(first.testCases[0].id);

      createdTestCaseIds.push(first.testCases[0].id);
    }, TEST_TIMEOUT);

    it('same (name, sourceFile) with DIFFERENT sourceHash returns updated=1, SAME id, version bumped', async () => {
      if (!backendAvailable) return;

      const base = {
        name: `${NAME_PREFIX}-sdk-version-bump`,
        description: 'baseline',
        initialPrompt: 'noop v1',
        context: [],
        labels: ['category:Smoke'],
        sourceFile: `evals/${NAME_PREFIX}-bump.eval.js`,
        sourceHash: 'hash-v1',
      };
      const edited = { ...base, initialPrompt: 'noop v2', sourceHash: 'hash-v2' };

      const first = (await postBulk([base])).body;
      const second = (await postBulk([edited])).body;

      // Editing the file (new hash) must bump the version of the SAME
      // TestCase — not create a sibling with a fresh id.
      expect(second.created).toBe(0);
      expect(second.updated).toBe(1);
      expect(second.unchanged).toBe(0);
      expect(second.testCases[0].id).toBe(first.testCases[0].id);

      const bumpedVersion = second.testCases[0].currentVersion ?? second.testCases[0].version;
      expect(bumpedVersion).toBeGreaterThan(1);

      createdTestCaseIds.push(first.testCases[0].id);
    }, TEST_TIMEOUT);

    it('same name in DIFFERENT sourceFile is a different TestCase (different id)', async () => {
      if (!backendAvailable) return;

      const fileA = {
        name: `${NAME_PREFIX}-shared-name`,
        initialPrompt: 'a',
        context: [],
        labels: ['category:Smoke'],
        sourceFile: `evals/${NAME_PREFIX}-fileA.eval.js`,
        sourceHash: 'hash-A',
      };
      const fileB = {
        name: `${NAME_PREFIX}-shared-name`,
        initialPrompt: 'b',
        context: [],
        labels: ['category:Smoke'],
        sourceFile: `evals/${NAME_PREFIX}-fileB.eval.js`,
        sourceHash: 'hash-B',
      };

      const a = (await postBulk([fileA])).body;
      const b = (await postBulk([fileB])).body;

      // sourceFile is half of the dedup key — same name + different file
      // is two distinct TestCases, not a collision.
      expect(a.created).toBe(1);
      expect(b.created).toBe(1);
      expect(a.testCases[0].id).not.toBe(b.testCases[0].id);

      createdTestCaseIds.push(a.testCases[0].id, b.testCases[0].id);
    }, TEST_TIMEOUT);

    it('different names in same sourceFile each get their own id', async () => {
      if (!backendAvailable) return;

      const tcs = [
        {
          name: `${NAME_PREFIX}-multi-test-A`,
          initialPrompt: 'a',
          context: [],
          labels: ['category:Smoke'],
          sourceFile: `evals/${NAME_PREFIX}-multi.eval.js`,
          sourceHash: 'hash-mA',
        },
        {
          name: `${NAME_PREFIX}-multi-test-B`,
          initialPrompt: 'b',
          context: [],
          labels: ['category:Smoke'],
          sourceFile: `evals/${NAME_PREFIX}-multi.eval.js`,
          sourceHash: 'hash-mB',
        },
      ];

      const first = (await postBulk(tcs)).body;
      expect(first.created).toBe(2);
      expect(new Set(first.testCases.map(tc => tc.id)).size).toBe(2);

      // Re-import: both should report `unchanged`, both same ids.
      const second = (await postBulk(tcs)).body;
      expect(second.unchanged).toBe(2);
      expect(second.created).toBe(0);
      expect(second.testCases.map(tc => tc.id).sort()).toEqual(first.testCases.map(tc => tc.id).sort());

      createdTestCaseIds.push(...first.testCases.map(tc => tc.id));
    }, TEST_TIMEOUT);
  });

  // ─────────────────────────────────────────────────────────────────
  // JSON path — no sourceFile means strict-create. Backward-compat lock.
  // ─────────────────────────────────────────────────────────────────
  describe('JSON path (no sourceFile) — backward compatibility', () => {
    it('response shape is {created, errors, testCases} with NO updated/unchanged keys', async () => {
      if (!backendAvailable) return;

      const tc = {
        name: `${NAME_PREFIX}-json-no-source`,
        description: 'JSON-imported, no sourceFile',
        initialPrompt: 'noop',
        context: [],
        labels: ['category:Smoke'],
      };

      const { status, body } = await postBulk([tc]);
      expect(status).toBe(200);
      expect(body.created).toBe(1);
      // Strict shape check: pre-fix callers depend on these keys being
      // absent. A future refactor that always returns the upsert shape
      // would break clients that destructure `{ created, errors }` and
      // expect no other keys.
      expect(body.updated).toBeUndefined();
      expect(body.unchanged).toBeUndefined();

      createdTestCaseIds.push(body.testCases[0].id);
    }, TEST_TIMEOUT);

    it('repeated JSON imports mint fresh ids each time (legacy create-only)', async () => {
      if (!backendAvailable) return;

      const tc = {
        name: `${NAME_PREFIX}-json-fresh-ids-${Math.random().toString(36).slice(2, 8)}`,
        description: 'JSON-imported',
        initialPrompt: 'noop',
        context: [],
        labels: ['category:Smoke'],
      };

      const first = (await postBulk([tc])).body;
      const second = (await postBulk([tc])).body;

      // No `sourceFile` → no dedup key → fresh id every time. This is
      // the existing pre-fix behavior preserved deliberately for JSON
      // imports / UI uploads. Changing this would be a separate, larger
      // behavioural change.
      expect(first.created).toBe(1);
      expect(second.created).toBe(1);
      expect(first.testCases[0].id).not.toBe(second.testCases[0].id);

      createdTestCaseIds.push(first.testCases[0].id, second.testCases[0].id);
    }, TEST_TIMEOUT);
  });

  // ─────────────────────────────────────────────────────────────────
  // Mixed batches — rejected with HTTP 400 (provenance contract).
  //
  // PR #254 review feedback (Copilot): routing a heterogeneous batch
  // through `bulkUpsert` lets a JSON item match an existing SDK record
  // by `name` alone (the adapter's match key is `e.name === tc.name &&
  // (tc.sourceFile ? e.sourceFile === tc.sourceFile : true)`), and the
  // update payload sets `sourceHash: tc.sourceHash` which is `undefined`
  // for JSON items — silently clobbering the SDK record's hash. The
  // route now rejects mixed batches with 400. The CLI never sends mixed
  // batches anyway (each `-f` import is homogeneous), so this is a hard
  // contract guard, not a UX paper-cut.
  // ─────────────────────────────────────────────────────────────────
  describe('mixed batches', () => {
    it('rejects a mixed batch with HTTP 400 and a clear error message', async () => {
      if (!backendAvailable) return;

      const sdkItem = {
        name: `${NAME_PREFIX}-mixed-sdk`,
        initialPrompt: 'sdk',
        context: [],
        labels: ['category:Smoke'],
        sourceFile: `evals/${NAME_PREFIX}-mixed.eval.js`,
        sourceHash: 'mixed-h',
      };
      const jsonItem = {
        name: `${NAME_PREFIX}-mixed-json`,
        initialPrompt: 'json',
        context: [],
        labels: ['category:Smoke'],
      };

      const { status, body } = await postBulk([sdkItem, jsonItem]);
      expect(status).toBe(400);
      // Pin the error string — callers / docs reference it.
      expect((body as any).error).toMatch(/Mixed batch rejected/i);
      expect((body as any).error).toMatch(/sourceFile/);
      expect((body as any).error).toMatch(/1 with sourceFile and 1 without/);
      // Hard guard: nothing got persisted on a 400.
      expect((body as any).testCases).toBeUndefined();
    }, TEST_TIMEOUT);

    it('homogeneous SDK batch (all items have sourceFile) hits upsert path', async () => {
      if (!backendAvailable) return;

      const items = [
        {
          name: `${NAME_PREFIX}-homog-A`,
          initialPrompt: 'a',
          context: [],
          labels: ['category:Smoke'],
          sourceFile: `evals/${NAME_PREFIX}-homog.eval.js`,
          sourceHash: 'homog-A',
        },
        {
          name: `${NAME_PREFIX}-homog-B`,
          initialPrompt: 'b',
          context: [],
          labels: ['category:Smoke'],
          sourceFile: `evals/${NAME_PREFIX}-homog.eval.js`,
          sourceHash: 'homog-B',
        },
      ];
      const { status, body } = await postBulk(items);
      expect(status).toBe(200);
      expect(body.created).toBe(2);
      expect(body.updated).toBe(0);
      expect(body.unchanged).toBe(0);
      createdTestCaseIds.push(...body.testCases.map(tc => tc.id));
    }, TEST_TIMEOUT);

    it('cross-name collision regression: a JSON item named like an existing SDK record cannot reach the upsert path', async () => {
      if (!backendAvailable) return;

      // Step 1: create an SDK record.
      const sharedName = `${NAME_PREFIX}-collision-target`;
      const sdkSeed = {
        name: sharedName,
        initialPrompt: 'sdk-original',
        context: [],
        labels: ['category:Smoke'],
        sourceFile: `evals/${NAME_PREFIX}-collision.eval.js`,
        sourceHash: 'sdk-original-hash',
      };
      const seed = (await postBulk([sdkSeed])).body;
      expect(seed.created).toBe(1);
      const sdkId = seed.testCases[0].id;
      createdTestCaseIds.push(sdkId);

      // Step 2: try to send a mixed batch — a JSON item whose `name`
      // happens to match the SDK record — alongside another SDK item.
      // Pre-fix this would have routed both to bulkUpsert, where the
      // JSON item's `(name, sourceFile=undefined)` would match the
      // seeded SDK record by name, run an update with
      // `sourceHash: undefined`, and clobber the SDK record's hash.
      // Post-fix the route rejects the batch outright — the SDK record
      // is untouched.
      const collidingJson = {
        name: sharedName,
        initialPrompt: 'json-collider',
        context: [],
        labels: ['category:Smoke'],
      };
      const otherSdk = {
        name: `${NAME_PREFIX}-collision-other`,
        initialPrompt: 'other',
        context: [],
        labels: ['category:Smoke'],
        sourceFile: `evals/${NAME_PREFIX}-collision.eval.js`,
        sourceHash: 'other-hash',
      };
      const mixed = await postBulk([collidingJson, otherSdk]);
      expect(mixed.status).toBe(400);

      // Step 3: read back the SDK record — hash and content unchanged.
      const after = await client.getTestCase(sdkId);
      expect(after).not.toBeNull();
      expect((after as any).sourceHash).toBe('sdk-original-hash');
      expect((after as any).initialPrompt).toBe('sdk-original');
    }, TEST_TIMEOUT);
  });

  // ─────────────────────────────────────────────────────────────────
  // Smoke — the user-facing CLI uses ApiClient.bulkCreateTestCases
  // and reads `updated` / `unchanged` off the response. Pin that the
  // typed client shape exposes them as optional so the CLI's narrowing
  // (`typeof bulkResult.updated === 'number'`) compiles and works.
  // ─────────────────────────────────────────────────────────────────
  describe('ApiClient.bulkCreateTestCases — typed shape carries upsert fields', () => {
    it('CLI client surfaces updated/unchanged on the SDK upsert path', async () => {
      if (!backendAvailable) return;

      const tc = {
        name: `${NAME_PREFIX}-client-shape`,
        initialPrompt: 'noop',
        context: [],
        labels: ['category:Smoke'],
        sourceFile: `evals/${NAME_PREFIX}-client.eval.js`,
        sourceHash: 'cli-h-1',
      };
      const first = await client.bulkCreateTestCases([tc]);
      // Created on first call; updated/unchanged are present (numeric 0).
      expect(first.created).toBe(1);
      expect(typeof first.updated).toBe('number');
      expect(typeof first.unchanged).toBe('number');
      expect(first.updated).toBe(0);
      expect(first.unchanged).toBe(0);

      const second = await client.bulkCreateTestCases([tc]);
      expect(second.created).toBe(0);
      expect(second.unchanged).toBe(1);
      expect(second.testCases[0].id).toBe(first.testCases[0].id);

      createdTestCaseIds.push(first.testCases[0].id);
    }, TEST_TIMEOUT);
  });
});
