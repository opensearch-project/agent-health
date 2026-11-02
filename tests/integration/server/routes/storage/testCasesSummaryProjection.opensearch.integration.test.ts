/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration coverage for issue #591 at the storage layer, against a REAL
 * OpenSearch cluster, through the REAL route — in-process.
 *
 * The HTTP-level sibling (testCasesSummaryProjection.integration.test.ts)
 * proves the summary RESPONSE is small and fast. It cannot see what the
 * server pulled from the cluster to build it, and that is where #591 lived:
 * the route loaded every test case in full and trimmed it in Node, so the
 * 1.7 MB summary cost the same 200+ MB cluster round-trip as the full
 * listing. The fix pushes the projection into the search itself
 * (`_source.excludes`), which is a claim about what OpenSearch honours — so
 * this suite mounts the production test-cases router on an Express app whose
 * storage module is the real `OpenSearchStorageModule` pointed at a
 * throwaway `ahtest-*` index on a disposable cluster, seeds documents with a
 * ~400 KB `sourceCode` each, and measures the bytes the cluster actually
 * returned for the search behind `GET /api/storage/test-cases?fields=summary`.
 *
 * Why in-process: the client's `response` event exposes every search result
 * body as the cluster sent it, before the route touches it. A full-fetch
 * regression shows up as megabytes on that wire even though the HTTP
 * response the browser gets stays small.
 *
 * Cluster: STRICTLY OPT-IN via `TEST_OPENSEARCH_ENDPOINT` (localhost:9200
 * fallback only under GitHub Actions, where the integration job provisions
 * a disposable service container) — see tests/helpers/rawOpenSearchCluster.ts.
 * Without the opt-in the suite SKIPS. The real `evals_test_cases` index is
 * never touched: `STORAGE_INDEXES.testCases` is redirected to the throwaway
 * for this test file's module registry only, and restored in afterAll.
 *
 * To run locally against a disposable cluster:
 *   docker run -d --rm -p 9200:9200 -e discovery.type=single-node \
 *     -e DISABLE_SECURITY_PLUGIN=true -e DISABLE_INSTALL_DEMO_CONFIG=true \
 *     opensearchproject/opensearch:2.17.0
 *   TEST_OPENSEARCH_ENDPOINT=http://localhost:9200 \
 *     npm run test:integration -- testCasesSummaryProjection.opensearch
 */

import express, { type Express } from 'express';
import request from 'supertest';
import { Client } from '@opensearch-project/opensearch';
import testCasesRoutes from '@/server/routes/storage/testCases';
import { getStorageModule, setStorageModule } from '@/server/adapters/index';
import type { IStorageModule } from '@/server/adapters/types';
import { OpenSearchStorageModule } from '@/server/adapters/opensearch/StorageModule';
import { FileSessionMetadataOperations } from '@/server/adapters/file/StorageModule';
import { INDEX_MAPPINGS } from '@/server/constants/indexMappings';
import { STORAGE_INDEXES } from '@/server/middleware/dataSourceConfig';
import { SUMMARY_PROMPT_MAX_CHARS } from '@/server/services/testCaseSummary';
import type { TestCase } from '@/types';
import {
  RawOpenSearchTestData,
  createRawOpenSearchClient,
  rawClusterReachable,
  rawOpenSearchOptInHint,
  resolveRawOpenSearchEndpoint,
} from '../../../../helpers/rawOpenSearchCluster';
import { uniqueTestName } from '../../../../helpers/testDataTracker';

const ENDPOINT = resolveRawOpenSearchEndpoint();
/** Real index name, captured before the suite redirects STORAGE_INDEXES.testCases. */
const REAL_INDEX = STORAGE_INDEXES.testCases;

/** Size of the synthetic eval-file text on each seeded case (~400 KB, like real imports). */
const SOURCE_CODE_BYTES = 400_000;
/** Enough cases that a full fetch is unmistakably megabytes, few enough to seed quickly. */
const CASE_COUNT = 12;
/**
 * Upper bound on what the cluster may return for the summary search. Twelve
 * projected documents (ids, names, labels, provenance, a prompt) are a few
 * KB; the full documents are CASE_COUNT × 400 KB ≈ 4.8 MB. Generous enough
 * that OpenSearch metadata can never trip it, tight enough that even a
 * single un-projected `sourceCode` (400 KB) fails it.
 */
const SUMMARY_WIRE_BYTES_MAX = 200_000;

/** Index of the one seeded case whose prompt is short enough to be returned untruncated. */
const SHORT_PROMPT_CASE = 1;
const SHORT_PROMPT = 'Short synthetic prompt.';

const describeIfOptedIn = ENDPOINT ? describe : describe.skip;
if (!ENDPOINT) {
  // eslint-disable-next-line no-console
  console.warn(rawOpenSearchOptInHint('test-case summary projection (OpenSearch _source.excludes)'));
}

function syntheticSourceCode(seed: string): string {
  const line = `test('${seed}', { prompt: 'synthetic prompt' }, async ({ result, expect }) => { expect(result.status).toBe('ok'); });\n`;
  return line.repeat(Math.ceil(SOURCE_CODE_BYTES / line.length)).slice(0, SOURCE_CODE_BYTES);
}

describeIfOptedIn('GET /api/storage/test-cases?fields=summary projects at the OpenSearch layer (#591)', () => {
  let client: Client;
  let testData: RawOpenSearchTestData;
  let previousStorage: IStorageModule;
  let app: Express;
  let available = false;
  let index: string;
  /** Names of the seeded cases, in seed order. */
  let names: string[] = [];
  /** The case that was updated to a second version, and its v2 name. */
  let updatedId = '';
  let updatedV2Name = '';
  /** JSON-serialised size of every search response body the cluster returned. */
  let searchWireBytes: number[] = [];

  beforeAll(async () => {
    client = createRawOpenSearchClient(ENDPOINT!);
    available = await rawClusterReachable(client);
    if (!available) {
      // eslint-disable-next-line no-console
      console.warn(`[skip] OpenSearch not reachable at ${ENDPOINT} — skipping summary projection tests`);
      return;
    }

    // Observe what the cluster hands back for each search, as sent — this is
    // the quantity #591 is about, and the HTTP response cannot reveal it.
    client.on('response', (_err, result) => {
      const path = result?.meta?.request?.params?.path ?? '';
      if (typeof path === 'string' && path.endsWith('/_search')) {
        searchWireBytes.push(JSON.stringify(result?.body ?? {}).length);
      }
    });

    testData = new RawOpenSearchTestData(client);
    index = await testData.createThrowawayIndex(
      'summary-projection-test-cases',
      INDEX_MAPPINGS[REAL_INDEX] as Record<string, unknown>,
    );
    (STORAGE_INDEXES as { testCases: string }).testCases = index;

    previousStorage = getStorageModule();
    const storage = new OpenSearchStorageModule(client, new FileSessionMetadataOperations());
    setStorageModule(storage);

    app = express();
    app.use(express.json({ limit: '50mb' }));
    app.use(testCasesRoutes);

    // Seed through the production adapter (the same write path the API uses).
    names = Array.from({ length: CASE_COUNT }, (_, i) => uniqueTestName(`summary-projection-${i}`));
    const created: TestCase[] = [];
    for (const [i, name] of names.entries()) {
      created.push(await storage.testCases.create({
        name,
        description: `Synthetic large code-imported case ${i}`,
        labels: ['category:RCA', 'difficulty:Medium'],
        // All but one prompt exceed SUMMARY_PROMPT_MAX_CHARS, so the summary
        // exercises both the truncated and the pass-through prompt shapes.
        initialPrompt: i === SHORT_PROMPT_CASE ? SHORT_PROMPT : `Investigate the synthetic incident ${i}. `.repeat(10),
        context: [{ description: 'runbook', value: 'https://runbooks.example.invalid/large' }],
        expectedOutcomes: ['Identifies the offending component'],
        sourceFileName: `${name}.eval.js`,
        sourceLanguage: 'javascript',
        sourceHash: name,
        sourceCode: syntheticSourceCode(name),
        definition: { options: { prompt: 'synthetic prompt' }, evaluateSource: 'async () => {}' },
      } as Partial<TestCase>));
    }
    // One case gets a second version so the per-id "latest version" pick is
    // exercised on documents that lack the excluded fields.
    updatedId = created[0].id;
    updatedV2Name = `${names[0]}-v2`;
    await storage.testCases.update(updatedId, { name: updatedV2Name });
    // `create()` / `update()` index with refresh=wait_for, so the docs are
    // searchable here without an explicit refresh.
  }, 120_000);

  afterAll(async () => {
    (STORAGE_INDEXES as { testCases: string }).testCases = REAL_INDEX;
    if (previousStorage) setStorageModule(previousStorage);
    if (available && testData) {
      await testData.cleanup();
    }
    if (client) {
      await client.close().catch(() => {});
    }
  });

  beforeEach(() => {
    searchWireBytes = [];
  });

  it('seeded documents really are large and versioned (fixture sanity, via the full route)', async () => {
    if (!available) return;

    const res = await request(app).get('/api/storage/test-cases').query({ includeSample: 'false' });
    expect(res.status).toBe(200);

    const seeded = (res.body.testCases as any[]).filter(tc => names.some(n => tc.name === n || tc.name === updatedV2Name));
    expect(seeded).toHaveLength(CASE_COUNT);
    for (const tc of seeded) {
      expect(typeof tc.sourceCode).toBe('string');
      expect(tc.sourceCode).toHaveLength(SOURCE_CODE_BYTES);
      expect(tc.definition).toEqual(expect.objectContaining({ evaluateSource: 'async () => {}' }));
      expect(tc.context).toHaveLength(1);
      expect(tc.expectedOutcomes).toEqual(['Identifies the offending component']);
    }
    const updated = seeded.find(tc => tc.id === updatedId);
    expect(updated.name).toBe(updatedV2Name);
    expect(updated.version).toBe(2);

    // The full listing legitimately pulls every byte — this is the baseline
    // the summary must NOT pay. One search, CASE_COUNT × 400 KB (+ the v1 copy).
    expect(searchWireBytes).toHaveLength(1);
    expect(searchWireBytes[0]).toBeGreaterThan(CASE_COUNT * SOURCE_CODE_BYTES);
  });

  it('summary listing returns the summary shape for every seeded case, latest version per id', async () => {
    if (!available) return;

    const res = await request(app).get('/api/storage/test-cases').query({ fields: 'summary', includeSample: 'false' });
    expect(res.status).toBe(200);

    const seeded = (res.body.testCases as any[]).filter(tc => names.some(n => tc.name === n || tc.name === updatedV2Name));
    expect(seeded).toHaveLength(CASE_COUNT);
    // No duplicate ids: v1 and v2 of the updated case collapse to one row.
    expect(new Set(seeded.map(tc => tc.id)).size).toBe(CASE_COUNT);

    for (const tc of seeded) {
      // Excluded at the storage layer — the keys are absent on the wire, not
      // `null`/`''` placeholders that a client might still try to render.
      expect(tc).not.toHaveProperty('sourceCode');
      expect(tc).not.toHaveProperty('definition');
      // Pinned by the route so list clients can always iterate them.
      expect(tc.context).toEqual([]);
      expect(tc.expectedOutcomes).toEqual([]);
      expect(tc.versions).toEqual([]);
      // Prompt is truncated by the route (the cluster can drop a field, not
      // shorten it) — unless it already fits.
      if (tc.name === names[SHORT_PROMPT_CASE]) {
        expect(tc.initialPrompt).toBe(SHORT_PROMPT);
      } else {
        expect(tc.initialPrompt).toHaveLength(SUMMARY_PROMPT_MAX_CHARS + '...'.length);
        expect(tc.initialPrompt.endsWith('...')).toBe(true);
      }
      // Provenance survives so the list can badge "code-imported".
      expect(tc.sourceFileName).toMatch(/\.eval\.js$/);
      expect(tc.sourceLanguage).toBe('javascript');
      expect(typeof tc.sourceHash).toBe('string');
      expect(tc.labels).toEqual(['category:RCA', 'difficulty:Medium']);
      expect(typeof tc.createdAt).toBe('string');
    }

    const updated = seeded.find(tc => tc.id === updatedId);
    // Updated case present once, as its latest version.
    expect(updated).toBeTruthy();
    expect(updated.name).toBe(updatedV2Name);
    expect(updated.version).toBe(2);
    expect(updated.currentVersion).toBe(2);
  });

  it('summary listing pulls only the projected documents from the cluster (not the 400 KB sources)', async () => {
    if (!available) return;

    const res = await request(app).get('/api/storage/test-cases').query({ fields: 'summary', includeSample: 'false' });
    expect(res.status).toBe(200);
    expect(res.body.testCases.length).toBeGreaterThanOrEqual(CASE_COUNT);

    // Exactly one search backs the listing, and it must come back without the
    // heavy fields. Before the fix this was CASE_COUNT × 400 KB ≈ 4.8 MB
    // (the route trimmed it afterwards, so the HTTP body looked identical).
    expect(searchWireBytes).toHaveLength(1);
    expect(searchWireBytes[0]).toBeLessThan(SUMMARY_WIRE_BYTES_MAX);
  });

  it('summary projection does not alter the full listing or the single-document read', async () => {
    if (!available) return;

    // A summary call first, then the full paths — the projection must be
    // per-request, never sticky on the adapter.
    await request(app).get('/api/storage/test-cases').query({ fields: 'summary', includeSample: 'false' });

    const byId = await request(app).get(`/api/storage/test-cases/${encodeURIComponent(updatedId)}`);
    expect(byId.status).toBe(200);
    const doc = byId.body.testCase ?? byId.body;
    expect(doc.name).toBe(updatedV2Name);
    expect(doc.sourceCode).toHaveLength(SOURCE_CODE_BYTES);
    expect(doc.context).toHaveLength(1);

    const full = await request(app).get('/api/storage/test-cases').query({ includeSample: 'false' });
    expect(full.status).toBe(200);
    const seeded = (full.body.testCases as any[]).filter(tc => names.some(n => tc.name === n || tc.name === updatedV2Name));
    expect(seeded.every(tc => typeof tc.sourceCode === 'string' && tc.sourceCode.length === SOURCE_CODE_BYTES)).toBe(true);
  });
});
