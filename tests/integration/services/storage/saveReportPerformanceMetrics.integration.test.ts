/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression: `saveReportWithClient` — the write path of the classic benchmark
 * `/execute` runner and the CLI `benchmark` command — dropped
 * `report.performanceMetrics` on the floor. The runners stamp it on every
 * report, the runs index maps it, and every reader expects it
 * (`asyncRunStorage.toTestCaseRun`, the comparison resolver, and the run
 * report's Traces tab, whose Strategy-C window falls back to a 30-MINUTE
 * lookback when `durationMs` is missing instead of the run's own duration).
 *
 * Real storage path, real OpenSearch: the report is written with the REAL
 * `saveReportWithClient` and read back with the REAL `getRunByIdWithClient`
 * against a DISPOSABLE cluster (`TEST_OPENSEARCH_ENDPOINT`, or the CI service
 * container). Fails on `main` with `performanceMetrics` undefined on the
 * stored document.
 */

import { INDEX_MAPPINGS } from '@/server/constants/indexMappings';
import { INDEXES } from '@/server/services/opensearchClient';
import { saveReportWithClient, getRunByIdWithClient } from '@/server/services/storage';
import {
  RawOpenSearchTestData,
  createRawOpenSearchClient,
  rawClusterReachable,
  rawOpenSearchOptInHint,
  resolveRawOpenSearchEndpoint,
} from '../../../helpers/rawOpenSearchCluster';
import { uniqueTestName } from '../../../helpers/testDataTracker';

const ENDPOINT = resolveRawOpenSearchEndpoint();
const describeIfOptedIn = ENDPOINT ? describe : describe.skip;
if (!ENDPOINT) {
  console.warn(rawOpenSearchOptInHint('saveReportWithClient persists performanceMetrics'));
}

describeIfOptedIn('saveReportWithClient persists report.performanceMetrics (classic /execute + CLI benchmark write path)', () => {
  const client = createRawOpenSearchClient(ENDPOINT!);
  const data = new RawOpenSearchTestData(client);
  // Same convention as the sibling raw-cluster suites: under GitHub Actions the
  // endpoint defaults to the integration job's service container, but other
  // jobs (release-rehearsal runs `npm test` with no container) must skip, not fail.
  let available = false;

  beforeAll(async () => {
    available = await rawClusterReachable(client);
    if (!available) {
      // eslint-disable-next-line no-console
      console.warn(`[skip] OpenSearch not reachable at ${ENDPOINT} — skipping saveReportWithClient performanceMetrics tests`);
      return;
    }
    // The writer targets the fixed runs index; make sure it exists with the real mapping.
    const exists = await client.indices.exists({ index: INDEXES.runs });
    if (!exists.body) {
      await client.indices.create({ index: INDEXES.runs, body: INDEX_MAPPINGS[INDEXES.runs] as any });
    }
  }, 30_000);

  afterAll(async () => {
    if (available) await data.cleanup();
    await client.close();
  });

  it('writes performanceMetrics and reads durationMs back from the stored document', async () => {
    if (!available) return;
    const report = {
      testCaseId: uniqueTestName('tc-perf-metrics'),
      testCaseVersion: 1,
      agentKey: 'example-rest-agent',
      modelId: 'example-model',
      status: 'completed',
      passFailStatus: 'passed',
      trajectory: [{ type: 'assistant', content: 'done' }],
      metrics: { accuracy: 100 },
      performanceMetrics: { durationMs: 36_900, agentDurationMs: 34_000 },
      llmJudgeReasoning: 'ok',
      evaluatedAt: new Date().toISOString(),
    };

    const saved = await saveReportWithClient(client, report, { experimentId: uniqueTestName('bench'), experimentRunId: uniqueTestName('run') });
    data.trackDoc(INDEXES.runs, saved.id);

    const stored = await getRunByIdWithClient(client, saved.id);
    expect(stored).not.toBeNull();
    expect(stored.performanceMetrics).toEqual({ durationMs: 36_900, agentDurationMs: 34_000 });
    expect(stored.performanceMetrics.durationMs).toBe(36_900);
  }, 30_000);

  it('does not invent performanceMetrics for a report that has none', async () => {
    if (!available) return;
    const saved = await saveReportWithClient(client, {
      testCaseId: uniqueTestName('tc-no-perf'),
      testCaseVersion: 1,
      agentKey: 'example-rest-agent',
      modelId: 'example-model',
      status: 'completed',
      trajectory: [],
      metrics: {},
      evaluatedAt: new Date().toISOString(),
    });
    data.trackDoc(INDEXES.runs, saved.id);

    const stored = await getRunByIdWithClient(client, saved.id);
    expect(stored).not.toBeNull();
    expect(stored).not.toHaveProperty('performanceMetrics');
  }, 30_000);
});
