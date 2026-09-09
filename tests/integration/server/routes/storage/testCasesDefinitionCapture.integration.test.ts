/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test: per-test `definition` capture survives the real
 * code-import path (loader → `POST /api/storage/test-cases/bulk` upsert →
 * `GET /api/storage/test-cases/:id`) and does not churn versions.
 *
 * Why this exists
 * ───────────────
 * For code-SDK test cases the run report's "Test Case Definition" used to
 * render the ENTIRE persisted `sourceCode`. For a suite that registers its
 * tests from a data table in a loop, that file never shows *the* test. The
 * fix persists a per-test `definition` (resolved `test()` options + the
 * evaluate body text) on each imported record. This test pins, against the
 * live HTTP API:
 *
 *   1. Importing the synthetic 4-test fixture yields four records, each
 *      carrying its OWN `definition.options` (prompt / expectedOutcomes /
 *      labels / timeout / description) and a `bodySource` that is the
 *      callback text — not the file, not a sibling's options.
 *   2. `GET /:id` returns `definition`; `GET ?fields=summary&ids=…` strips it
 *      (list payloads must not bloat).
 *   3. A second import of the UNCHANGED file classifies every record as
 *      `unchanged` — same ids, same `currentVersion` — because `definition`
 *      is not part of `sourceHash`.
 *   4. Backfill: a record persisted WITHOUT `definition` (imported before the
 *      field existed) gains it on the next unchanged-file re-import, in place
 *      — still `unchanged`, still version 1. This is the path the UI's
 *      "re-import to capture" hint relies on.
 *
 * Prerequisites: backend reachable at AH_PORT (self-skips otherwise).
 * Cleanup: every id the backend returns is tracked and deleted by id.
 */

import { resolve } from 'path';
import { loadTestCasesFromModule, detectSourceLanguage } from '@/lib/testCases/loader';
import { clearRegistry } from '@/lib/testCases/define';
import { getCategoryFromLabels, getDifficultyFromLabels } from '@/lib/testCaseLabels';
import { getTestBackendUrl } from '@/tests/integration/testConfig';
import { createTestDataTracker } from '@/tests/helpers/testDataTracker';

const TEST_TIMEOUT = 60_000;
const BASE_URL = getTestBackendUrl();
const FIXTURE = resolve(__dirname, '../../../../fixtures/definition-capture.eval.js');
const tracker = createTestDataTracker();

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

/**
 * Build the upsert payload the way cli/commands/benchmark.ts does, from the
 * real loader output — so the `definition` plumbing under test is the
 * production one, not a hand-rolled payload. `sourceFile` is salted per
 * run so parallel/repeated runs never collide on (name, sourceFile).
 */
async function buildImportPayload(salt: string) {
  clearRegistry();
  const loaded = await loadTestCasesFromModule(FIXTURE);
  const sourceFile = `tests/fixtures/${salt}/definition-capture.eval.js`;
  return loaded.testCases.map(tc => {
    const labels = tc.options.labels;
    const category = getCategoryFromLabels(labels);
    const difficulty = getDifficultyFromLabels(labels);
    return {
      name: `${salt}-${tc.name}`,
      ...(category ? { category } : {}),
      ...(difficulty ? { difficulty } : {}),
      initialPrompt: tc.options.prompt,
      context: tc.options.context,
      labels,
      sourceFile,
      sourceHash: tc.hash,
      sourceCode: loaded.fileSource,
      sourceFileName: 'definition-capture.eval.js',
      sourceLanguage: detectSourceLanguage(sourceFile),
      definition: tc.definition,
      description: tc.options.description,
      ...(tc.options.expectedOutcomes ? { expectedOutcomes: tc.options.expectedOutcomes } : {}),
    };
  });
}

async function postBulk(testCases: any[]) {
  const r = await fetch(`${BASE_URL}/api/storage/test-cases/bulk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ testCases }),
  });
  const body = await r.json();
  for (const tc of body?.testCases ?? []) tracker.testCase(tc?.id);
  return { status: r.status, body };
}

describe('per-test definition capture — code import round-trip', () => {
  jest.setTimeout(TEST_TIMEOUT);
  let backendAvailable = false;
  const salt = `defcap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  beforeAll(async () => {
    backendAvailable = await checkBackend();
    if (!backendAvailable) {
      // eslint-disable-next-line no-console
      console.warn(`[defcap-integ] Backend not reachable at ${BASE_URL} — skipping.`);
    }
  });

  afterAll(async () => {
    await tracker.cleanup();
  });

  it('each imported record carries its OWN definition (options + evaluate body), retrievable via GET /:id', async () => {
    if (!backendAvailable) return;

    const payload = await buildImportPayload(salt);
    expect(payload).toHaveLength(4);

    const { status, body } = await postBulk(payload);
    expect(status).toBe(200);
    expect(body.created).toBe(4);

    const byName = new Map<string, any>(body.testCases.map((tc: any) => [tc.name.slice(salt.length + 1), tc]));

    const two = await (await fetch(`${BASE_URL}/api/storage/test-cases/${encodeURIComponent(byName.get('synthetic-case-two').id)}`)).json();
    expect(two.definition).toBeDefined();
    expect(two.definition.registeredAs).toBe('sdk');
    expect(two.definition.options).toEqual({
      prompt: 'Synthetic prompt number two',
      description: 'Synthetic description for TWO',
      expectedOutcomes: ['Outcome two is satisfied', 'Outcome two is fast'],
      labels: ['category:Synthetic', 'difficulty:Easy', 'marker:TWO'],
      timeout: 30000,
    });
    // The body is the callback text, not the whole file.
    expect(two.definition.bodySource).toContain('shared-loop-body-marker');
    expect(two.definition.bodySource).not.toContain('standalone-body-marker');
    expect(two.definition.bodySource).not.toContain('const CASES');
    expect(two.definition.bodySource.length).toBeLessThan(two.sourceCode.length);

    const standalone = await (await fetch(`${BASE_URL}/api/storage/test-cases/${encodeURIComponent(byName.get('synthetic-case-standalone').id)}`)).json();
    expect(standalone.definition.options).toEqual({ prompt: 'Standalone synthetic prompt' });
    expect(standalone.definition.bodySource).toContain('standalone-body-marker');
    expect(standalone.definition.bodySource).not.toContain('shared-loop-body-marker');

    // Sibling records don't leak into each other.
    const one = await (await fetch(`${BASE_URL}/api/storage/test-cases/${encodeURIComponent(byName.get('synthetic-case-one').id)}`)).json();
    expect(one.definition.options.prompt).toBe('Synthetic prompt number one');
    expect(JSON.stringify(one.definition.options)).not.toContain('number two');
  });

  it('list view (fields=summary) strips definition and sourceCode but keeps provenance', async () => {
    if (!backendAvailable) return;

    const payload = await buildImportPayload(salt);
    const { body } = await postBulk(payload);
    const ids = body.testCases.map((tc: any) => tc.id);

    const list = await (await fetch(`${BASE_URL}/api/storage/test-cases?fields=summary&ids=${ids.join(',')}`)).json();
    const items = (list.testCases as any[]).filter(tc => ids.includes(tc.id));
    expect(items.length).toBe(ids.length);
    for (const tc of items) {
      expect(tc.definition).toBeUndefined();
      expect(tc.sourceCode).toBeUndefined();
      expect(tc.sourceFile).toBe(`tests/fixtures/${salt}/definition-capture.eval.js`);
    }
  });

  it('legacy records (no definition) are backfilled in place on the next unchanged re-import — still version 1', async () => {
    if (!backendAvailable) return;

    const legacySalt = `${salt}-legacy`;
    const payload = await buildImportPayload(legacySalt);
    // Simulate records persisted before the field existed.
    const legacyPayload = payload.map(({ definition: _drop, ...rest }) => rest);
    const first = (await postBulk(legacyPayload)).body;
    expect(first.created).toBe(4);
    for (const tc of first.testCases) expect(tc.definition).toBeUndefined();

    const second = (await postBulk(payload)).body;
    expect(second.created).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.unchanged).toBe(4);
    expect(second.testCases.map((tc: any) => tc.id).sort()).toEqual(first.testCases.map((tc: any) => tc.id).sort());

    for (const tc of second.testCases) {
      const fresh = await (await fetch(`${BASE_URL}/api/storage/test-cases/${encodeURIComponent(tc.id)}`)).json();
      expect(fresh.currentVersion ?? fresh.version).toBe(1);
      expect(fresh.definition?.registeredAs).toBe('sdk');
      expect(typeof fresh.definition?.bodySource).toBe('string');
      const versions = await (await fetch(`${BASE_URL}/api/storage/test-cases/${encodeURIComponent(tc.id)}/versions`)).json();
      expect(versions.total).toBe(1);
    }
  });

  it('re-importing the UNCHANGED file is `unchanged` for every record — same ids, no version bump', async () => {
    if (!backendAvailable) return;

    const first = (await postBulk(await buildImportPayload(salt))).body;
    const second = (await postBulk(await buildImportPayload(salt))).body;

    expect(second.created).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.unchanged).toBe(4);
    const firstIds = first.testCases.map((tc: any) => tc.id).sort();
    const secondIds = second.testCases.map((tc: any) => tc.id).sort();
    expect(secondIds).toEqual(firstIds);
    for (const tc of second.testCases) {
      const fresh = await (await fetch(`${BASE_URL}/api/storage/test-cases/${encodeURIComponent(tc.id)}`)).json();
      expect(fresh.currentVersion ?? fresh.version).toBe(1);
      expect(fresh.definition?.registeredAs).toBe('sdk');
    }
  });
});
