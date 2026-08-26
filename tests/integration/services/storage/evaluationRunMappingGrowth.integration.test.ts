/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test: EvaluationRun.results must not blow up the
 * `evals_experiments` index's total field count as test-case results
 * accumulate, against a REAL OpenSearch cluster.
 *
 * Regression coverage for the 2026-08-26 incident: a 400-test-case
 * EvaluationRun crashed mid-run at 243/400 test cases with
 * "Limit of total fields [5000] has been exceeded". `results` is a
 * `Record<testCaseId, {...}>` map stored as a TOP-LEVEL field on the
 * EvaluationRun document (see OpenSearchEvaluationRunOperations — a
 * different code path than the legacy nested `runs.results`, which already
 * had this protection). Without an explicit non-dynamic mapping for the
 * top-level `results` field, every unique testCaseId across every run ever
 * created added new mapped fields to the index, shared across ALL documents
 * in the index — eventually exceeding the field-count ceiling.
 *
 * This test exercises the real production code path end-to-end against a
 * REAL OpenSearch cluster (no mocks):
 *   1. `ensureIndexesWithValidation()` creates a fresh `evals_experiments`
 *      index using the actual `INDEX_MAPPINGS` (the fix under test).
 *   2. Test A synthesizes a run with 500 test-case results in one write
 *      (comparable to, with margin, the 400-case run that crashed in
 *      production) via `OpenSearchEvaluationRunOperations.create()`, then
 *      reads it back and checks the index's total field count.
 *   3. Test B exercises `updateResult()` — the exact method the real
 *      evaluation runner calls per completed test case, via a painless
 *      partial update — repeatedly, proving incremental writes don't grow
 *      the mapping either (kept to a smaller count; each call round-trips
 *      to the cluster with `refresh: 'wait_for'`, matching production
 *      semantics but too slow at N=500 for a test).
 *
 * Cluster: connects to `TEST_OPENSEARCH_ENDPOINT` (default
 * `http://localhost:9200`), the same ephemeral OpenSearch the CI
 * `integration-tests` job provisions. Skips gracefully (with a console
 * warning) if unreachable, so local runs without a cluster stay green.
 *
 * `STORAGE_INDEXES.benchmarks` is a fixed constant ('evals_experiments'),
 * shared with every other integration test file that hits that same CI
 * OpenSearch service container (they may run in parallel Jest workers) — so
 * this test deliberately never deletes or truncates the index, only ensures
 * it exists (idempotent) and adds its own uniquely-named documents. Field-
 * count assertions compare a before/after snapshot around this test's own
 * writes and tolerate a small slack for incidental fields any other
 * concurrently-running test file might add in that window (see SLACK below)
 * — the bug this guards against grows the mapping by ~1000+ fields for one
 * 500-case run, dwarfing that slack.
 *
 * To run locally against a disposable cluster:
 *   docker run -d --rm -p 9200:9200 -e discovery.type=single-node \
 *     -e DISABLE_SECURITY_PLUGIN=true -e DISABLE_INSTALL_DEMO_CONFIG=true \
 *     opensearchproject/opensearch:2.17.0
 *   npm run test:integration -- evaluationRunMappingGrowth
 */

import { Client } from '@opensearch-project/opensearch';
import { OpenSearchStorageModule } from '@/server/adapters/opensearch/StorageModule';
import { FileSessionMetadataOperations } from '@/server/adapters/file/StorageModule';
import { ensureIndexesWithValidation } from '@/server/services/indexInitializer';
import { STORAGE_INDEXES } from '@/server/middleware/dataSourceConfig';
import type { EvaluationRun } from '@/types';

const ENDPOINT = process.env.TEST_OPENSEARCH_ENDPOINT || 'http://localhost:9200';
const INDEX = STORAGE_INDEXES.benchmarks;
const NUM_TEST_CASES = 500; // > the 400 that crashed in production, with margin
const NUM_INCREMENTAL_UPDATES = 25; // smaller: each updateResult() round-trips with refresh:'wait_for'
// Tolerance for the shared-index race described above (concurrent CI test
// files adding unrelated fields between this test's before/after mapping
// snapshots). The bug this guards against adds ~1000+ fields for one
// 500-case run — orders of magnitude past this slack — so it stays a strong
// regression signal despite the tolerance.
const FIELD_COUNT_SLACK = 15;
// Unique per test run (Date.now()-seeded) so this suite's testCaseIds never
// collide with another concurrently-running test file's synthetic IDs in the
// same shared index.
const RUN_TAG = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function clusterUp(client: Client): Promise<boolean> {
  try {
    await client.cluster.health({ wait_for_status: 'yellow', timeout: '5s' });
    return true;
  } catch {
    return false;
  }
}

/** Recursively count mapped fields the way OpenSearch's total_fields.limit does. */
function countMappedFields(properties: Record<string, any>): number {
  let total = 0;
  for (const spec of Object.values(properties)) {
    total += 1;
    if (spec && typeof spec === 'object') {
      if (spec.fields) total += Object.keys(spec.fields).length;
      if (spec.properties) total += countMappedFields(spec.properties);
    }
  }
  return total;
}

function buildResults(count: number, prefix = 'tc'): EvaluationRun['results'] {
  const results: EvaluationRun['results'] = {};
  for (let i = 0; i < count; i++) {
    results[`${prefix}-${i}`] = { reportId: `report-${i}`, status: 'completed' };
  }
  return results;
}

describe('EvaluationRun results mapping growth (real OpenSearch)', () => {
  let client: Client;
  let storage: OpenSearchStorageModule;
  let available = false;

  beforeAll(async () => {
    client = new Client({ node: ENDPOINT, ssl: { rejectUnauthorized: false } });
    available = await clusterUp(client);
    if (!available) {
      // eslint-disable-next-line no-console
      console.warn(`[skip] OpenSearch not reachable at ${ENDPOINT} — skipping mapping-growth tests`);
      return;
    }

    // Real production code path: idempotently ensure the index exists with
    // the actual mapping fix under test (server/constants/indexMappings.ts).
    // Deliberately non-destructive — see file header on why this never
    // deletes/truncates the shared `evals_experiments` index.
    await ensureIndexesWithValidation(client);

    storage = new OpenSearchStorageModule(client, new FileSessionMetadataOperations());
  }, 30000);

  afterAll(async () => {
    if (available) {
      await client.close().catch(() => {});
    }
  });

  it('synthesizes a run with 500 test-case results: persists, reads back correctly, and does not grow the mapping', async () => {
    if (!available) return; // graceful skip, see beforeAll warning

    // Baseline field count from an empty-results run, so the assertion below
    // is attributable to the 500 results, not index bootstrap noise. Uses a
    // populated (not empty) testCaseSnapshots array too, matching the 500-case
    // run below — an empty array never triggers dynamic field inference at
    // all, which would otherwise mask the one-time (not per-item) cost of
    // OpenSearch inferring testCaseSnapshots.{id,name,version} the first time
    // it sees a populated array. That one-time cost is expected/fine — it's
    // bounded regardless of array length, unlike the unbounded `results` map
    // this test actually guards against.
    const baselineRunId = `eval-run-mapping-baseline-${RUN_TAG}`;
    await storage.evaluationRuns.create({
      id: baselineRunId,
      docType: 'evaluation-run',
      name: 'Baseline (empty results)',
      createdAt: new Date().toISOString(),
      status: 'running',
      agentKey: 'demo',
      modelId: 'test-model',
      sources: [{ type: 'test-case-ids', ids: [] }],
      trigger: 'api',
      testCaseSnapshots: [{ id: `tc-baseline-${RUN_TAG}`, version: 1, name: 'Baseline test case' }],
      results: {},
    } as EvaluationRun);
    await client.indices.refresh({ index: INDEX });
    const baselineMapping = await client.indices.getMapping({ index: INDEX });
    const baselineFieldCount = countMappedFields(
      (baselineMapping.body as any)[INDEX].mappings.properties
    );

    const runId = `eval-run-mapping-growth-${RUN_TAG}`;
    const tcPrefix = `mg-tc-${RUN_TAG}`;
    const run: EvaluationRun = {
      id: runId,
      docType: 'evaluation-run',
      name: 'Mapping growth regression test (500 test cases)',
      createdAt: new Date().toISOString(),
      status: 'completed',
      agentKey: 'demo',
      modelId: 'test-model',
      sources: [{ type: 'test-case-ids', ids: [] }],
      trigger: 'api',
      testCaseSnapshots: Array.from({ length: NUM_TEST_CASES }, (_, i) => ({
        id: `${tcPrefix}-${i}`,
        version: 1,
        name: `Test case ${i}`,
      })),
      results: buildResults(NUM_TEST_CASES, tcPrefix),
    };

    await storage.evaluationRuns.create(run);
    await client.indices.refresh({ index: INDEX });

    // 1. Reads back correctly: all 500 results present with correct shape.
    const fetched = await storage.evaluationRuns.getById(runId);
    expect(fetched).not.toBeNull();
    expect(Object.keys(fetched!.results)).toHaveLength(NUM_TEST_CASES);
    expect(fetched!.results[`${tcPrefix}-0`]).toEqual({ reportId: 'report-0', status: 'completed' });
    expect(fetched!.results[`${tcPrefix}-499`]).toEqual({ reportId: 'report-499', status: 'completed' });

    // 2. No meaningful mapping growth: field count with 500 distinct
    // testCaseId keys in `results` stays within FIELD_COUNT_SLACK of the
    // empty-results baseline (slack tolerates unrelated concurrent CI test
    // files touching this shared index — see file header). Before the fix,
    // this grows by ~2-5 fields per test case (results.<id>.reportId, .status,
    // their .keyword sub-fields, ...) — i.e. 1000+ new fields for this one run
    // alone, dwarfing the slack.
    const afterMapping = await client.indices.getMapping({ index: INDEX });
    const afterFieldCount = countMappedFields((afterMapping.body as any)[INDEX].mappings.properties);
    expect(afterFieldCount - baselineFieldCount).toBeLessThanOrEqual(FIELD_COUNT_SLACK);

    // 3. The `results` field itself stays the disabled opaque-object shape —
    // never gains per-testCaseId sub-properties. This is the deterministic,
    // race-proof assertion (unaffected by anything unrelated concurrent tests
    // might add elsewhere in the mapping).
    const resultsMapping = (afterMapping.body as any)[INDEX].mappings.properties.results;
    expect(resultsMapping).toEqual({ type: 'object', enabled: false });
  }, 60000);

  it('incrementally written results (real updateResult() painless path, per-test-case) also do not grow the mapping', async () => {
    if (!available) return;

    const beforeMapping = await client.indices.getMapping({ index: INDEX });
    const beforeFieldCount = countMappedFields((beforeMapping.body as any)[INDEX].mappings.properties);

    const runId = `eval-run-mapping-incremental-${RUN_TAG}`;
    const tcPrefix = `incr-tc-${RUN_TAG}`;
    await storage.evaluationRuns.create({
      id: runId,
      docType: 'evaluation-run',
      name: 'Incremental updateResult() regression test',
      createdAt: new Date().toISOString(),
      status: 'running',
      agentKey: 'demo',
      modelId: 'test-model',
      sources: [{ type: 'test-case-ids', ids: [] }],
      trigger: 'api',
      testCaseSnapshots: [],
      results: {},
    } as EvaluationRun);

    // Exercise the exact method the real evaluation runner calls per
    // completed test case (server/routes/storage/evaluationRuns.ts
    // onTestCaseComplete → storage.evaluationRuns.updateResult), via a
    // painless partial update — not a full-document reindex.
    for (let i = 0; i < NUM_INCREMENTAL_UPDATES; i++) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await storage.evaluationRuns.updateResult(runId, `${tcPrefix}-${i}`, {
        reportId: `report-${i}`,
        status: 'completed',
      });
      expect(ok).toBe(true);
    }

    const fetched = await storage.evaluationRuns.getById(runId);
    expect(Object.keys(fetched!.results)).toHaveLength(NUM_INCREMENTAL_UPDATES);

    await client.indices.refresh({ index: INDEX });
    const afterMapping = await client.indices.getMapping({ index: INDEX });
    const afterFieldCount = countMappedFields((afterMapping.body as any)[INDEX].mappings.properties);
    expect(afterFieldCount - beforeFieldCount).toBeLessThanOrEqual(FIELD_COUNT_SLACK);

    const resultsMapping = (afterMapping.body as any)[INDEX].mappings.properties.results;
    expect(resultsMapping).toEqual({ type: 'object', enabled: false });
  }, 60000);
});
