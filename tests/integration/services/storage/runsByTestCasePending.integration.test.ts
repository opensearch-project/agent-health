/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test — GET /api/storage/runs/by-test-case/:testCaseId
 * immediately reflects a run stuck at metricsStatus:'pending'.
 *
 * Context: a user reported that after pressing "Run Test" twice on the
 * test-case detail page, the new runs never showed up. Diagnosis (see PR
 * description) found the two runs WERE persisted correctly — /api/evaluate
 * (UI mode) uses `awaitTraces: false` for trace-mode agents (see
 * server/routes/evaluation.ts), which pre-persists the report with
 * `refresh: 'wait_for'` and returns its SSE 'completed' event with
 * metricsStatus:'pending' *before* the background trace-judge finishes.
 *
 * This test pins the query/creation-side half of that contract: the report
 * is queryable via the exact endpoint the test-case detail page uses
 * (asyncRunStorage.getReportsByTestCase → GET /runs/by-test-case/:id)
 * immediately after being created as 'pending', and again once the judge
 * resolves it — proving the API was never the bug. The actual fix
 * (TestCaseDetailPage polling + correct pending/running row icon) is
 * unit-tested in tests/unit/components/evals3/TestCaseDetailPage.test.ts.
 *
 * Requires the backend server running (see AGENTS.md → AH_PORT):
 *   npm run test:integration -- --testPathPattern=runsByTestCasePending
 */

import { getTestBackendUrl } from '@/tests/integration/testConfig';
import { createTestDataTracker, uniqueTestName } from '../../../helpers/testDataTracker';

const BASE_URL = getTestBackendUrl();

const checkBackend = async (): Promise<boolean> => {
  try {
    const res = await fetch(`${BASE_URL}/api/storage/health`);
    if (!res.ok) return false;
    const data = await res.json();
    return data.status === 'connected' || data.status === 'ok';
  } catch {
    return false;
  }
};

describe('GET /runs/by-test-case/:id — pending trace-mode runs (regression)', () => {
  let backendAvailable = false;
  const tracker = createTestDataTracker();

  beforeAll(async () => {
    backendAvailable = await checkBackend();
    if (!backendAvailable) {
      console.warn('Backend not available — skipping runsByTestCasePending integration tests');
    }
  });

  afterAll(async () => {
    await tracker.cleanup();
  });

  it('surfaces a run at metricsStatus:pending immediately, then reflects its final verdict after update', async () => {
    if (!backendAvailable) return;

    const testCaseId = `tc-pending-runs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Mirrors what /api/evaluate's placeholder-update path persists for a
    // trace-mode agent's SSE 'completed' event: status 'completed' (the
    // agent itself finished), metricsStatus 'pending' (judge still running
    // in the background), no passFailStatus yet.
    const createRes = await fetch(`${BASE_URL}/api/storage/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: uniqueTestName('pending-run'),
        testCaseId,
        testCaseVersionId: `${testCaseId}-v1`,
        agentId: 'test-agent',
        modelId: 'test-model',
        status: 'completed',
        metricsStatus: 'pending',
        trajectory: [],
      }),
    });
    expect(createRes.ok).toBe(true);
    const created = await createRes.json();
    tracker.run(created.id);

    // What the test-case detail page's loadData() actually calls
    // (asyncRunStorage.getReportsByTestCase → this exact endpoint).
    const immediateRes = await fetch(`${BASE_URL}/api/storage/runs/by-test-case/${encodeURIComponent(testCaseId)}`);
    expect(immediateRes.ok).toBe(true);
    const immediate = await immediateRes.json();
    expect(immediate.total).toBe(1);
    expect(immediate.runs[0].id).toBe(created.id);
    expect(immediate.runs[0].metricsStatus).toBe('pending');
    expect(immediate.runs[0].passFailStatus).toBeUndefined();

    // Background judge resolves the run (mirrors
    // startTracePollingForReportWithModule's onTracesFound update).
    const updateRes = await fetch(`${BASE_URL}/api/storage/runs/${encodeURIComponent(created.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        metricsStatus: 'ready',
        passFailStatus: 'passed',
        metrics: { accuracy: 1 },
      }),
    });
    expect(updateRes.ok).toBe(true);

    const afterJudgeRes = await fetch(`${BASE_URL}/api/storage/runs/by-test-case/${encodeURIComponent(testCaseId)}`);
    const afterJudge = await afterJudgeRes.json();
    expect(afterJudge.total).toBe(1);
    expect(afterJudge.runs[0].metricsStatus).toBe('ready');
    expect(afterJudge.runs[0].passFailStatus).toBe('passed');
  });
});
