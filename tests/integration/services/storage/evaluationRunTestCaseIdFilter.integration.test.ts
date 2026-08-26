/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test: `GET /api/storage/evaluation-runs?testCaseId=<id>` (i.e.
 * `OpenSearchEvaluationRunOperations.list({ testCaseId })`) against a REAL
 * OpenSearch cluster.
 *
 * Regression: `testCaseSnapshots` on EvaluationRun docs is a plain
 * dynamically-mapped `object` array (see server/constants/indexMappings.ts —
 * it's intentionally left out of the explicit mapping since it's a bounded
 * 3-property shape regardless of array length, so it's not the field-count
 * growth vector that mapping change addresses), NOT `nested`. The `list()`
 * testCaseId filter used a `nested` query against it, which OpenSearch
 * rejects outright — `query_shard_exception: nested object under path
 * [testCaseSnapshots] is not of nested type` — a 400/500 on every call to
 * `GET /api/storage/evaluation-runs?testCaseId=...`, not just a silent
 * zero-results bug. Discovered via `codex_review` while reviewing the
 * `results` field-count-growth fix in this same PR (mocked unit tests for
 * `list()` never exercise real OpenSearch mapping-compatibility errors).
 *
 * Fixed by using a plain `term` on the array's flattened `.keyword`
 * multi-field (`testCaseSnapshots.id.keyword`) instead of a `nested` query —
 * a plain `object`-type array flattens each leaf field's values across all
 * elements, so a term query matches if ANY element has that id, which is
 * exactly the filter semantics this needs.
 *
 * Cluster: connects to `TEST_OPENSEARCH_ENDPOINT` (default
 * `http://localhost:9200`), same as evaluationRunMappingGrowth.integration.test.ts
 * — skips gracefully if unreachable. Never deletes/truncates the shared
 * `evals_experiments` index (see that file's header for why).
 */

import { Client } from '@opensearch-project/opensearch';
import { OpenSearchStorageModule } from '@/server/adapters/opensearch/StorageModule';
import { FileSessionMetadataOperations } from '@/server/adapters/file/StorageModule';
import { ensureIndexesWithValidation } from '@/server/services/indexInitializer';
import { STORAGE_INDEXES } from '@/server/middleware/dataSourceConfig';
import type { EvaluationRun } from '@/types';

const ENDPOINT = process.env.TEST_OPENSEARCH_ENDPOINT || 'http://localhost:9200';
const INDEX = STORAGE_INDEXES.benchmarks;
const RUN_TAG = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function clusterUp(client: Client): Promise<boolean> {
  try {
    await client.cluster.health({ wait_for_status: 'yellow', timeout: '5s' });
    return true;
  } catch {
    return false;
  }
}

describe('EvaluationRun list({ testCaseId }) filter (real OpenSearch)', () => {
  let client: Client;
  let storage: OpenSearchStorageModule;
  let available = false;
  let matchingRunId: string;
  let otherRunId: string;
  const targetTestCaseId = `tc-filter-target-${RUN_TAG}`;
  const otherTestCaseId = `tc-filter-other-${RUN_TAG}`;

  beforeAll(async () => {
    client = new Client({ node: ENDPOINT, ssl: { rejectUnauthorized: false } });
    available = await clusterUp(client);
    if (!available) {
      // eslint-disable-next-line no-console
      console.warn(`[skip] OpenSearch not reachable at ${ENDPOINT} — skipping testCaseId filter tests`);
      return;
    }

    await ensureIndexesWithValidation(client);
    storage = new OpenSearchStorageModule(client, new FileSessionMetadataOperations());

    matchingRunId = `eval-run-filter-match-${RUN_TAG}`;
    otherRunId = `eval-run-filter-other-${RUN_TAG}`;

    await storage.evaluationRuns.create({
      id: matchingRunId,
      docType: 'evaluation-run',
      name: 'Filter target run',
      createdAt: new Date().toISOString(),
      status: 'completed',
      agentKey: 'demo',
      modelId: 'test-model',
      sources: [{ type: 'test-case-ids', ids: [targetTestCaseId] }],
      trigger: 'api',
      testCaseSnapshots: [{ id: targetTestCaseId, version: 1, name: 'Target test case' }],
      results: {},
    } as EvaluationRun);

    await storage.evaluationRuns.create({
      id: otherRunId,
      docType: 'evaluation-run',
      name: 'Filter non-matching run',
      createdAt: new Date().toISOString(),
      status: 'completed',
      agentKey: 'demo',
      modelId: 'test-model',
      sources: [{ type: 'test-case-ids', ids: [otherTestCaseId] }],
      trigger: 'api',
      testCaseSnapshots: [{ id: otherTestCaseId, version: 1, name: 'Other test case' }],
      results: {},
    } as EvaluationRun);

    await client.indices.refresh({ index: INDEX });
  }, 30000);

  afterAll(async () => {
    if (available) {
      await client.close().catch(() => {});
    }
  });

  it('does not throw a query_shard_exception (nested-vs-object mapping mismatch)', async () => {
    if (!available) return;
    await expect(storage.evaluationRuns.list({ testCaseId: targetTestCaseId })).resolves.toBeDefined();
  }, 30000);

  it('returns only runs whose testCaseSnapshots contain the requested testCaseId', async () => {
    if (!available) return;

    const { items } = await storage.evaluationRuns.list({ testCaseId: targetTestCaseId });
    const ids = items.map((r) => r.id);
    expect(ids).toContain(matchingRunId);
    expect(ids).not.toContain(otherRunId);
  }, 30000);
});
