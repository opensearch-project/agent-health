/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E: a REST agent's non-2xx reply shows its recorded response headers on
 * the run inspector's failure card (#612, problem 6).
 *
 * Seeds what the runner persists for a 503 from a REST agent: two real test
 * cases, a one-run evaluation whose `results` point at the two reports
 * (`status: 'completed'` with no verdict — exactly how the runner records an
 * agent failure; `bucketRunResults` buckets it as errored), and reports
 * carrying `failureStage: 'agent'`, `agentError.httpStatus` and the new
 * `agentError.responseHeaders` (the allowlisted diagnostic subset,
 * lower-cased). Then asserts the rendered result in the run inspector
 * (`/evaluations/runs/:runId/inspect`, the only run-report surface since
 * #542 retired the standalone `/runs/:id` page): the HTTP status row and a
 * "Response headers" block listing every recorded header, including
 * `x-request-id` (the service request id an operator needs),
 * `x-amzn-requestid` and `retry-after`. The first test arrives through the
 * retired `/runs/:reportId` link to prove the redirect lands on the card; the
 * second opens the inspector directly.
 *
 * Also seeds a 5xx report WITHOUT headers (a report persisted before this
 * field existed) to prove the block is simply absent, not an empty box.
 */

import { test, expect } from './fixtures/test-fixtures';
import { createTestDataTracker, uniqueTestName } from '../helpers/testDataTracker';

const STAMP = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const ENDPOINT = 'http://agent.example.internal:8000/ask';
const CAUSE = `REST request failed: 503 - upstream unavailable (${ENDPOINT})`;
const RUN_ID = `eval-run-e2e-rest-non2xx-${STAMP}`;
const RESPONSE_HEADERS: Record<string, string> = {
  'content-type': 'text/plain',
  'date': 'Fri, 06 Nov 2026 08:18:12 GMT',
  'retry-after': '30',
  'x-amzn-requestid': 'amzn-req-456',
  'x-request-id': 'req-123',
};

test.describe('REST non-2xx — response headers on the run inspector failure card', () => {
  const tracker = createTestDataTracker();
  let tcWithHeaders: string | null = null;
  let tcWithoutHeaders: string | null = null;
  let withHeaders: string | null = null;
  let withoutHeaders: string | null = null;
  let seeded = false;

  test.beforeAll(async ({ request }) => {
    const health = await request.get('/api/storage/health');
    if (!health.ok()) return; // storage not configured → the tests skip below

    // Past this point every seeding step must succeed: a silent null would
    // turn a schema/storage regression into a green-by-skip suite.
    const mkTestCase = async (label: string) => {
      const r = await request.post('/api/storage/test-cases', {
        data: {
          name: uniqueTestName(`rest-non2xx-${label}`),
          category: 'Synthetic', difficulty: 'Easy',
          initialPrompt: 'Synthetic prompt', expectedOutcomes: ['Synthetic outcome'],
        },
      });
      expect(r.ok(), `seed test case ${label}: ${r.status()}`).toBeTruthy();
      const b = await r.json();
      const id = (b.id || b.testCase?.id) as string;
      tracker.testCase(id);
      return id;
    };
    tcWithHeaders = await mkTestCase('headers');
    tcWithoutHeaders = await mkTestCase('noheaders');

    const mkRep = async (data: Record<string, unknown>) => {
      const r = await request.post('/api/storage/runs', { data });
      expect(r.ok(), `seed report: ${r.status()}`).toBeTruthy();
      const b = await r.json();
      const id = (b.id || b.run?.id || b.report?.id) as string;
      tracker.run(id);
      return id;
    };
    const base = {
      agentName: 'A REST agent', agentKey: 'example-rest-agent', modelName: 'demo-model', modelId: 'demo-model',
      connectorProtocol: 'rest', agentEndpoint: ENDPOINT, experimentRunId: RUN_ID,
      status: 'failed', metricsStatus: 'error', failureStage: 'agent', passFailStatus: null,
      trajectory: [], rawEvents: [],
      error: CAUSE,
      traceError: `Agent request failed (kind=agent_failed): ${CAUSE}`,
      llmJudgeReasoning: `**Agent request failed — not judged.**\n\nThe agent produced no output.\n\n**Cause:** ${CAUSE}`,
      metrics: { accuracy: 0, faithfulness: 0, latency_score: 0, trajectory_alignment_score: 0 },
    };
    withHeaders = await mkRep({
      ...base,
      testCaseId: tcWithHeaders,
      agentError: {
        kind: 'http_503', httpStatus: 503, message: CAUSE, endpoint: ENDPOINT, elapsedMs: 118, timeoutMs: 300_000,
        responseHeaders: RESPONSE_HEADERS,
      },
    });
    withoutHeaders = await mkRep({
      ...base,
      testCaseId: tcWithoutHeaders,
      agentError: { kind: 'http_503', httpStatus: 503, message: CAUSE, endpoint: ENDPOINT, elapsedMs: 97, timeoutMs: 300_000 },
    });

    // The evaluation-run doc the inspector opens. An agent failure has no
    // verdict, so the runner records the result as a bare 'completed' (no
    // passFailStatus) — the stats bucket it as errored.
    const run = await request.put(`/api/storage/evaluation-runs/${RUN_ID}`, {
      data: {
        id: RUN_ID,
        docType: 'evaluation-run',
        name: uniqueTestName('rest-non2xx-run'),
        createdAt: new Date().toISOString(),
        status: 'completed',
        agentKey: 'example-rest-agent',
        modelId: 'demo-model',
        sources: [{ type: 'test-case-ids', ids: [tcWithHeaders, tcWithoutHeaders] }],
        trigger: 'api',
        testCaseSnapshots: [
          { id: tcWithHeaders, version: 1, name: 'rest-non2xx-headers' },
          { id: tcWithoutHeaders, version: 1, name: 'rest-non2xx-noheaders' },
        ],
        results: {
          [tcWithHeaders]: { reportId: withHeaders, status: 'completed' },
          [tcWithoutHeaders]: { reportId: withoutHeaders, status: 'completed' },
        },
        stats: { passed: 0, failed: 0, pending: 0, errored: 2, total: 2 },
      },
    });
    expect(run.ok(), `seed evaluation run: ${run.status()}`).toBeTruthy();
    tracker.evaluationRun(RUN_ID);
    seeded = true;
  });

  test.afterAll(async () => { await tracker.cleanup(); });

  test('run inspector lists the 503 reply\'s diagnostic response headers (request ids + retry-after visible)', async ({ page }) => {
    test.skip(!seeded, 'Storage not configured');
    // Arrive via the retired `/runs/:reportId` link: it must redirect to the
    // inspector with this report preselected, not drop the user on a list.
    await page.goto(`/runs/${withHeaders}`);
    await page.waitForURL(`**/evaluations/runs/${RUN_ID}/inspect?reportId=${withHeaders}`, { timeout: 15000 });
    const card = page.getByTestId('run-failure-card').first();
    await expect(card).toBeVisible({ timeout: 15000 });
    await expect(card).toHaveAttribute('data-stage', 'agent');
    await expect(card.getByTestId('run-failure-cause')).toContainText('REST request failed: 503');
    // The status row's VALUE cell (the cause text also contains "503", so a
    // card-wide match would not prove the row renders the right value).
    await expect(card.getByText('HTTP status', { exact: true }).locator('xpath=following-sibling::span[1]')).toHaveText('503');

    const headers = card.getByTestId('run-failure-response-headers');
    await expect(headers).toBeVisible();
    await expect(headers).toContainText('Response headers');
    const rows = headers.getByTestId('run-failure-response-header');
    await expect(rows).toHaveCount(Object.keys(RESPONSE_HEADERS).length);
    for (const [name, value] of Object.entries(RESPONSE_HEADERS)) {
      await expect(headers.locator(`[data-header-name="${name}"]`)).toHaveText(`${name}:${value}`);
    }
    const badge = page.getByTestId('inspector-status-badge');
    await expect(badge).toHaveText('AGENT ERROR');
    await expect(badge).toHaveAttribute('data-stage', 'agent');
    const row = page.locator(`[data-testid="test-case-row"][data-test-case-id="${tcWithHeaders}"]`);
    await expect(row.getByTestId('status-label')).toHaveText('AGENT ERROR');
  });

  test('a 5xx report without recorded headers shows the HTTP status but no response-headers block', async ({ page }) => {
    test.skip(!seeded, 'Storage not configured');
    await page.goto(`/evaluations/runs/${RUN_ID}/inspect?reportId=${withoutHeaders}`);
    const card = page.getByTestId('run-failure-card').first();
    await expect(card).toBeVisible({ timeout: 15000 });
    await expect(card.getByText('HTTP status', { exact: true }).locator('xpath=following-sibling::span[1]')).toHaveText('503');
    await expect(card.getByTestId('run-failure-response-headers')).toHaveCount(0);
  });
});
