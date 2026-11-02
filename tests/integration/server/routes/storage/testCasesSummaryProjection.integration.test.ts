/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration coverage for issue #591 — `GET /api/storage/test-cases?fields=summary`
 * must be cheap even when the corpus carries large `sourceCode` documents.
 *
 * Before the fix the route loaded every test case IN FULL from storage and
 * trimmed it in Node, so a 1.7 MB summary response took as long as the 213 MB
 * full listing (15.7 s measured on a real cluster with ~800 cases carrying a
 * ~400 KB `sourceCode`). The storage adapters now apply the summary
 * projection at the query (OpenSearch `_source.excludes`).
 *
 * This suite seeds a real-shaped fixture — 50 code-imported test cases, each
 * with a ~400 KB synthetic `sourceCode`, plus context / expectedOutcomes /
 * a second version — through the real HTTP API against whatever backend
 * AH_PORT points at, then asserts on the real response:
 *
 *   1. shape: no `sourceCode` / `definition`, and `context` /
 *      `expectedOutcomes` / `versions` are empty arrays, for every seeded id;
 *   2. time: the summary listing completes within a bound that the old
 *      full-load-then-trim implementation cannot meet once large documents
 *      exist (the listing covers the WHOLE corpus, so on a cluster that
 *      already holds large cases the old code fails this by an order of
 *      magnitude; on an empty CI cluster the 20 MB fixture alone is what the
 *      old code has to pull and parse).
 *
 * Everything created here is deleted by id via the shared tracker.
 *
 * Requires a running backend (AH_PORT, default 4001):
 *   AH_PORT=43xx npm run test:integration -- --testPathPatterns=testCasesSummaryProjection
 */

import { getTestBackendUrl } from '@/tests/integration/testConfig';
import { createTestDataTracker, uniqueTestName } from '@/tests/helpers/testDataTracker';
import { TEST_CASE_SUMMARY_EXCLUDED_FIELDS } from '@/server/services/testCaseSummary';

const BASE_URL = getTestBackendUrl();
const tracker = createTestDataTracker();

/** How many large documents to seed. 50 × ~400 KB ≈ 20 MB of source text. */
const LARGE_CASE_COUNT = 50;
/** Size of the synthetic eval-file text on each seeded case (~400 KB, like real imports). */
const SOURCE_CODE_BYTES = 400_000;
/** Bulk-create batch size — keeps each request body well under the server's 10 MB JSON limit. */
const BULK_BATCH = 10;
/**
 * Upper bound for the summary listing. Measured after the fix on a shared
 * cluster holding ~3,000 cases (~800 of them with ~400 KB `sourceCode`):
 * 0.67–1.22 s. The same request on the old code took 15.7 s there.
 */
const SUMMARY_TIME_BUDGET_MS = 3_000;

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

/** Deterministic, generic ~400 KB of JavaScript-looking text (no real data). */
function syntheticSourceCode(seed: number): string {
  const line = `test('ahtest-large-case-${seed}', { prompt: 'synthetic prompt ${seed}' }, async ({ result, expect }) => { expect(result.status).toBe('ok'); });\n`;
  const repeats = Math.ceil(SOURCE_CODE_BYTES / line.length);
  return line.repeat(repeats).slice(0, SOURCE_CODE_BYTES);
}

function largeCase(i: number, salt: string) {
  return {
    name: uniqueTestName(`large-case-${i}`),
    description: `Synthetic large code-imported case ${i}`,
    category: 'RCA',
    difficulty: 'Medium',
    labels: ['category:RCA', 'difficulty:Medium', `salt:${salt}`],
    initialPrompt: `Investigate synthetic incident ${i}. `.repeat(12), // > 200 chars → truncated in summary
    context: [{ description: 'runbook', value: `https://runbooks.example.invalid/${salt}/${i}` }],
    expectedOutcomes: ['Identifies the offending component', 'Proposes a remediation'],
    sourceFile: `tests/fixtures/${salt}/large-${i}.eval.js`,
    sourceFileName: `large-${i}.eval.js`,
    sourceLanguage: 'javascript',
    sourceHash: `${salt}-${i}`,
    sourceCode: syntheticSourceCode(i),
    definition: { registeredAs: 'sdk', options: { prompt: `synthetic prompt ${i}` }, evaluateSource: 'async () => {}' },
  };
}

async function timedGet(path: string): Promise<{ status: number; body: any; ms: number; bytes: number }> {
  const t0 = performance.now();
  const r = await fetch(`${BASE_URL}${path}`);
  const text = await r.text();
  const ms = performance.now() - t0;
  return { status: r.status, body: JSON.parse(text), ms, bytes: Buffer.byteLength(text) };
}

describe('GET /api/storage/test-cases?fields=summary with large sourceCode documents (#591)', () => {
  jest.setTimeout(180_000);
  let backendAvailable = false;
  const salt = `sumproj-${process.pid}-${Date.now()}`;
  const seededIds: string[] = [];

  beforeAll(async () => {
    backendAvailable = await checkBackend();
    if (!backendAvailable) {
      // eslint-disable-next-line no-console
      console.warn(`[summary-projection-integ] Backend not reachable at ${BASE_URL} — skipping.`);
      return;
    }

    for (let start = 0; start < LARGE_CASE_COUNT; start += BULK_BATCH) {
      const batch = Array.from({ length: Math.min(BULK_BATCH, LARGE_CASE_COUNT - start) }, (_, k) => largeCase(start + k, salt));
      const r = await fetch(`${BASE_URL}/api/storage/test-cases/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ testCases: batch }),
      });
      const body = await r.json();
      // Track FIRST, assert second — a failing expect must not leak documents.
      for (const tc of body?.testCases ?? []) {
        tracker.testCase(tc?.id);
        if (tc?.id) seededIds.push(tc.id);
      }
      expect(r.status).toBe(200);
      expect(body.created).toBe(batch.length);
    }
    expect(seededIds).toHaveLength(LARGE_CASE_COUNT);

    // Give one case a second version so `versions` has real history to strip.
    const bumped = await fetch(`${BASE_URL}/api/storage/test-cases/${encodeURIComponent(seededIds[0])}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'bumped to v2' }),
    });
    expect(bumped.status).toBe(200);
  });

  afterAll(async () => {
    await tracker.cleanup();
  });

  it('seeded documents really are large and fully stored (fixture sanity, via GET /:id)', async () => {
    if (!backendAvailable) return;

    const full = await timedGet(`/api/storage/test-cases/${encodeURIComponent(seededIds[1])}`);
    expect(full.status).toBe(200);
    expect(full.body.sourceCode).toHaveLength(SOURCE_CODE_BYTES);
    expect(full.body.definition).toBeDefined();
    expect(full.body.context).toHaveLength(1);
    expect(full.body.expectedOutcomes).toHaveLength(2);
    expect(full.bytes).toBeGreaterThan(SOURCE_CODE_BYTES);
  });

  it('summary listing carries none of the heavy fields for any seeded case', async () => {
    if (!backendAvailable) return;

    const { status, body } = await timedGet('/api/storage/test-cases?fields=summary');
    expect(status).toBe(200);

    const byId = new Map<string, any>(body.testCases.map((tc: any) => [tc.id, tc]));
    for (const id of seededIds) {
      const tc = byId.get(id);
      expect(tc).toBeDefined();
      expect(tc.sourceCode).toBeUndefined();
      expect(tc.definition).toBeUndefined();
      expect(tc.context).toEqual([]);
      expect(tc.expectedOutcomes).toEqual([]);
      expect(tc.versions).toEqual([]);
      // Provenance survives so the list can badge "code-imported".
      expect(tc.sourceFileName).toMatch(/^large-\d+\.eval\.js$/);
      expect(tc.sourceLanguage).toBe('javascript');
      // Prompt is truncated, not dropped.
      expect(tc.initialPrompt).toHaveLength(203);
      expect(tc.initialPrompt.endsWith('...')).toBe(true);
    }
    // The bumped case still resolves to its latest version.
    expect(byId.get(seededIds[0]).description).toBe('bumped to v2');
    expect(byId.get(seededIds[0]).currentVersion).toBe(2);

    // Belt and braces: not a single document in the whole listing leaks a
    // heavy field, whoever created it.
    for (const tc of body.testCases) {
      for (const field of ['sourceCode', 'definition']) {
        expect(tc[field]).toBeUndefined();
      }
      for (const field of ['context', 'expectedOutcomes', 'versions']) {
        expect(tc[field]).toEqual([]);
      }
    }
    // Sanity on the contract constant this test and the adapters share.
    expect([...TEST_CASE_SUMMARY_EXCLUDED_FIELDS].sort()).toEqual(
      ['context', 'definition', 'expectedOutcomes', 'sourceCode', 'versions'].sort(),
    );
  });

  it(`summary listing completes within ${SUMMARY_TIME_BUDGET_MS} ms with ${LARGE_CASE_COUNT} × ${SOURCE_CODE_BYTES / 1000} KB documents present`, async () => {
    if (!backendAvailable) return;

    // Best of two: the first request may pay a cold-cache penalty on the
    // cluster; the bound is about what the server path is CAPABLE of, not
    // about one unlucky sample.
    const first = await timedGet('/api/storage/test-cases?fields=summary');
    const second = await timedGet('/api/storage/test-cases?fields=summary');
    const best = Math.min(first.ms, second.ms);
    const sourceBytesSeeded = LARGE_CASE_COUNT * SOURCE_CODE_BYTES;

    // eslint-disable-next-line no-console
    console.log(
      `[summary-projection-integ] ${first.body.testCases.length} cases, summary payload ${first.bytes} B, ` +
      `times ${first.ms.toFixed(0)} ms / ${second.ms.toFixed(0)} ms (seeded ${sourceBytesSeeded} B of sourceCode)`,
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // The summary is small: far smaller than the sourceCode we seeded alone.
    expect(first.bytes).toBeLessThan(sourceBytesSeeded / 2);
    expect(best).toBeLessThan(SUMMARY_TIME_BUDGET_MS);
  });
});
