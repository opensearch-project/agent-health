/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration coverage for issue #591 on the BENCHMARK DETAIL page
 * (`/evaluations/benchmarks/:id`, `BenchmarkRunsPage` → `BenchmarkCasesTab`).
 *
 * The page resolves the benchmark's `testCaseIds` with ONE request. It used
 * to be `GET /api/storage/test-cases?ids=<all>` — the FULL documents — which
 * on a real 62-case code-imported benchmark came to 6.7 MB (6.55 MB of it
 * `sourceCode`) for a tab that renders names, labels and a one-line prompt.
 * It now asks for `&fields=summary` (~50 KB on that benchmark) and fetches
 * the ONE selected case in full by id for its definition pane.
 *
 * This suite seeds the real shape — a benchmark over 62 cases, each carrying
 * a ~100 KB `sourceCode`, two of them with the same name — through the real
 * HTTP API and measures the two request shapes against the real backend:
 *
 *   1. the request the page USED to issue (`?ids=` without `fields`) really
 *      is at least the seeded source text in size (fixture sanity + the
 *      "before" number that goes in the PR proof);
 *   2. the request the page issues NOW (`?ids=…&fields=summary`) returns every
 *      case, none of them with a heavy field, in a bounded number of bytes;
 *   3. the per-case fetch the definition pane issues (`GET /:id`) still
 *      carries the full prompt, outcomes and source for exactly that case.
 *
 * Everything created here is deleted by id via the shared tracker.
 *
 * Requires a running backend (AH_PORT, default 4001):
 *   AH_PORT=43xx npm run test:integration -- --testPathPatterns=benchmarkDetailTestCaseFetch
 */

import { getTestBackendUrl } from '@/tests/integration/testConfig';
import { createTestDataTracker, uniqueTestName } from '@/tests/helpers/testDataTracker';

const BASE_URL = getTestBackendUrl();
const tracker = createTestDataTracker();

/** A real code-imported benchmark the owner hit had 62 cases. */
const CASE_COUNT = 62;
/** Synthetic eval-file text per case (~100 KB; real imports run 100–400 KB). */
const SOURCE_CODE_BYTES = 100_000;
/** Bulk-create batch size — keeps each request body well under the server's 10 MB JSON limit. */
const BULK_BATCH = 10;
/**
 * Upper bound for the summary response of the whole benchmark. A summary
 * record is name / description / labels / provenance / a 203-char prompt —
 * well under 2 KB each; the real 62-case benchmark measured 50,638 B.
 */
const SUMMARY_BYTES_BUDGET = CASE_COUNT * 2_000;

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

/** Deterministic, generic JavaScript-looking text (no real data). */
function syntheticSourceCode(seed: number): string {
  const line = `test('ahtest-detail-case-${seed}', { prompt: 'synthetic prompt ${seed}' }, async ({ result, expect }) => { expect(result.status).toBe('ok'); });\n`;
  return line.repeat(Math.ceil(SOURCE_CODE_BYTES / line.length)).slice(0, SOURCE_CODE_BYTES);
}

function seededCase(i: number, salt: string, name: string) {
  return {
    name,
    description: `Synthetic code-imported case ${i}`,
    category: 'RCA',
    difficulty: 'Medium',
    labels: ['category:RCA', 'difficulty:Medium', `salt:${salt}`],
    initialPrompt: `Investigate synthetic incident ${i}. `.repeat(12), // > 200 chars → truncated in summary
    context: [{ description: 'runbook', value: `https://runbooks.example.invalid/${salt}/${i}` }],
    expectedOutcomes: [`Identifies component ${i}`, 'Proposes a remediation'],
    sourceFileName: `detail-${i}.eval.js`,
    sourceLanguage: 'javascript',
    sourceHash: `${salt}-${i}`,
    sourceCode: syntheticSourceCode(i),
  };
}

async function timedGet(path: string): Promise<{ status: number; body: any; ms: number; bytes: number }> {
  const t0 = performance.now();
  const r = await fetch(`${BASE_URL}${path}`);
  const text = await r.text();
  return { status: r.status, body: JSON.parse(text), ms: performance.now() - t0, bytes: Buffer.byteLength(text) };
}

describe('Benchmark detail page test-case fetch: summary by ids + one full case by id (#591)', () => {
  jest.setTimeout(180_000);
  let backendAvailable = false;
  const salt = `detail-${process.pid}-${Date.now()}`;
  const seededIds: string[] = [];
  const duplicateName = uniqueTestName('detail-dup-name');

  beforeAll(async () => {
    backendAvailable = await checkBackend();
    if (!backendAvailable) {
      // eslint-disable-next-line no-console
      console.warn(`[detail-fetch-integ] Backend not reachable at ${BASE_URL} — skipping.`);
      return;
    }

    for (let start = 0; start < CASE_COUNT; start += BULK_BATCH) {
      const batch = Array.from({ length: Math.min(BULK_BATCH, CASE_COUNT - start) }, (_, k) => {
        const i = start + k;
        // Cases 0 and 1 share a name: the pane must be keyed by id, not name.
        return seededCase(i, salt, i < 2 ? duplicateName : uniqueTestName(`detail-case-${i}`));
      });
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
    expect(seededIds).toHaveLength(CASE_COUNT);

    const bm = await fetch(`${BASE_URL}/api/storage/benchmarks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: uniqueTestName('detail-fetch-bm'),
        description: 'seed for the #591 detail-page regression',
        currentVersion: 1,
        versions: [{ version: 1, createdAt: new Date().toISOString(), testCaseIds: seededIds }],
        testCaseIds: seededIds,
        runs: [],
      }),
    });
    const bmBody = await bm.json();
    const bmId = bmBody?.id || bmBody?.benchmark?.id;
    if (bmId) tracker.benchmark(bmId);
    expect(bm.status).toBeLessThan(300);
  });

  afterAll(async () => {
    await tracker.cleanup();
  });

  const idsParam = () => seededIds.map(encodeURIComponent).join(',');

  it(`the request the page USED to issue (ids, full documents) is at least ${CASE_COUNT} × ${SOURCE_CODE_BYTES / 1000} KB`, async () => {
    if (!backendAvailable) return;

    const full = await timedGet(`/api/storage/test-cases?ids=${idsParam()}`);
    expect(full.status).toBe(200);
    expect(full.body.testCases).toHaveLength(CASE_COUNT);
    expect(full.bytes).toBeGreaterThan(CASE_COUNT * SOURCE_CODE_BYTES);
    // eslint-disable-next-line no-console
    console.log(`[detail-fetch-integ] BEFORE  GET ?ids=<${CASE_COUNT}>                 ${full.bytes} B in ${full.ms.toFixed(0)} ms`);
  });

  it(`the request the page issues NOW (ids + fields=summary) returns all ${CASE_COUNT} cases in under ${SUMMARY_BYTES_BUDGET} bytes with no heavy fields`, async () => {
    if (!backendAvailable) return;

    const summary = await timedGet(`/api/storage/test-cases?ids=${idsParam()}&fields=summary`);
    expect(summary.status).toBe(200);
    // eslint-disable-next-line no-console
    console.log(`[detail-fetch-integ] AFTER   GET ?ids=<${CASE_COUNT}>&fields=summary  ${summary.bytes} B in ${summary.ms.toFixed(0)} ms`);

    const byId = new Map<string, any>(summary.body.testCases.map((tc: any) => [tc.id, tc]));
    for (const id of seededIds) {
      const tc = byId.get(id);
      expect(tc).toBeDefined();
      expect(tc.sourceCode).toBeUndefined();
      expect(tc.definition).toBeUndefined();
      expect(tc.context).toEqual([]);
      expect(tc.expectedOutcomes).toEqual([]);
      expect(tc.versions).toEqual([]);
      // What the Cases tab renders survives: name, labels, provenance, a one-line prompt.
      expect(typeof tc.name).toBe('string');
      expect(tc.labels).toContain(`salt:${salt}`);
      expect(tc.sourceFileName).toMatch(/^detail-\d+\.eval\.js$/);
      expect(tc.initialPrompt.endsWith('...')).toBe(true);
    }
    // Both same-named cases are present and distinguishable by id.
    expect(summary.body.testCases.filter((tc: any) => tc.name === duplicateName).map((tc: any) => tc.id).sort())
      .toEqual([seededIds[0], seededIds[1]].sort());
    expect(summary.bytes).toBeLessThan(SUMMARY_BYTES_BUDGET);
  });

  it('the definition pane\'s per-case fetch (GET /:id) carries the full prompt, outcomes and source for exactly that case', async () => {
    if (!backendAvailable) return;

    // The second of the two same-named cases: the pane must get THIS one's content.
    const target = seededIds[1];
    const full = await timedGet(`/api/storage/test-cases/${encodeURIComponent(target)}`);
    expect(full.status).toBe(200);
    expect(full.body.id).toBe(target);
    expect(full.body.name).toBe(duplicateName);
    expect(full.body.expectedOutcomes).toEqual(['Identifies component 1', 'Proposes a remediation']);
    expect(full.body.initialPrompt).toBe('Investigate synthetic incident 1. '.repeat(12));
    expect(full.body.context).toHaveLength(1);
    expect(full.body.sourceCode).toHaveLength(SOURCE_CODE_BYTES);
    // One case in full is still an order of magnitude below the old all-cases download.
    expect(full.bytes).toBeLessThan(CASE_COUNT * SOURCE_CODE_BYTES / 10);
    // eslint-disable-next-line no-console
    console.log(`[detail-fetch-integ] PANE    GET /:id (one case, full)             ${full.bytes} B in ${full.ms.toFixed(0)} ms`);
  });
});
