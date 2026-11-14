/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E: a REST agent's non-2xx reply shows its recorded response headers on
 * the run inspector's failure card (#612, problem 6).
 *
 * Seeds the exact shape the runner persists for a 503 from a REST agent — a
 * one-run evaluation whose reports carry `failureStage: 'agent'`,
 * `agentError.httpStatus`, and the new `agentError.responseHeaders` (the
 * allowlisted diagnostic subset, lower-cased) — then asserts the rendered
 * result in the run inspector (`/evaluations/runs/:runId/inspect`, the only
 * run-report surface since #542 retired the standalone `/runs/:id` page): the
 * HTTP status row and a "Response headers" block listing `x-request-id` (the
 * service request id an operator needs), `x-amzn-requestid` and `retry-after`.
 * The first test arrives through the retired `/runs/:reportId` link to prove
 * the redirect lands on the card, the second opens the inspector directly.
 *
 * Also seeds a 5xx report WITHOUT headers (a report persisted before this
 * field existed) to prove the block is simply absent, not an empty box.
 */

import { test, expect } from './fixtures/test-fixtures';

const STAMP = Date.now();
const ENDPOINT = 'http://agent.example.internal:8000/ask';
const CAUSE = `REST request failed: 503 - upstream unavailable (${ENDPOINT})`;

const RUN_ID = `eval-run-e2e-rest-non2xx-${STAMP}`;
const TC_WITH_HEADERS = `e2e-rest-non2xx-tc-headers-${STAMP}`;
const TC_WITHOUT_HEADERS = `e2e-rest-non2xx-tc-noheaders-${STAMP}`;

test.describe('REST non-2xx — response headers on the run inspector failure card', () => {
  let withHeaders: string | null = null;
  let withoutHeaders: string | null = null;

  test.beforeAll(async ({ request }) => {
    const mkRep = async (data: Record<string, unknown>) => {
      const r = await request.post('/api/storage/runs', { data });
      if (!r.ok()) return null;
      const b = await r.json();
      return (b.id || b.run?.id || b.report?.id || null) as string | null;
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
      testCaseId: TC_WITH_HEADERS,
      agentError: {
        kind: 'http_503', httpStatus: 503, message: CAUSE, endpoint: ENDPOINT, elapsedMs: 118, timeoutMs: 300_000,
        responseHeaders: {
          'content-type': 'text/plain',
          'date': 'Fri, 06 Nov 2026 08:18:12 GMT',
          'retry-after': '30',
          'x-amzn-requestid': 'amzn-req-456',
          'x-request-id': 'req-123',
        },
      },
    });
    withoutHeaders = await mkRep({
      ...base,
      testCaseId: TC_WITHOUT_HEADERS,
      agentError: { kind: 'http_503', httpStatus: 503, message: CAUSE, endpoint: ENDPOINT, elapsedMs: 97, timeoutMs: 300_000 },
    });
    if (!withHeaders || !withoutHeaders) return;
    // The evaluation-run doc the inspector opens; its results point at the two reports.
    const run = await request.put(`/api/storage/evaluation-runs/${RUN_ID}`, {
      data: {
        id: RUN_ID,
        docType: 'evaluation-run',
        name: `E2E REST non-2xx run ${STAMP}`,
        createdAt: new Date().toISOString(),
        status: 'completed',
        agentKey: 'example-rest-agent',
        modelId: 'demo-model',
        sources: [],
        trigger: 'api',
        testCaseSnapshots: [],
        results: {
          [TC_WITH_HEADERS]: { reportId: withHeaders, status: 'failed' },
          [TC_WITHOUT_HEADERS]: { reportId: withoutHeaders, status: 'failed' },
        },
        stats: { passed: 0, failed: 0, pending: 0, errored: 2, total: 2 },
      },
    });
    if (!run.ok()) { withHeaders = null; withoutHeaders = null; }
  });

  test.afterAll(async ({ request }) => {
    for (const id of [withHeaders, withoutHeaders]) if (id) await request.delete(`/api/storage/runs/${id}`).catch(() => {});
    await request.delete(`/api/storage/evaluation-runs/${RUN_ID}`).catch(() => {});
  });

  test('run inspector lists the 503 reply\'s diagnostic response headers (request ids + retry-after visible)', async ({ page }) => {
    test.skip(!withHeaders, 'Could not seed report (storage unavailable)');
    // Arrive via the retired `/runs/:reportId` link: it must redirect to the
    // inspector with this report preselected, not drop the user on a list.
    await page.goto(`/runs/${withHeaders}`);
    await page.waitForURL(`**/evaluations/runs/${RUN_ID}/inspect?reportId=${withHeaders}`, { timeout: 15000 });
    const card = page.getByTestId('run-failure-card').first();
    await expect(card).toBeVisible({ timeout: 15000 });
    await expect(card).toHaveAttribute('data-stage', 'agent');
    await expect(card.getByTestId('run-failure-cause')).toContainText('REST request failed: 503');
    await expect(card).toContainText('HTTP status');
    await expect(card).toContainText('503');

    const headers = card.getByTestId('run-failure-response-headers');
    await expect(headers).toBeVisible();
    await expect(headers).toContainText('Response headers');
    const rows = headers.getByTestId('run-failure-response-header');
    await expect(rows).toHaveCount(5);
    await expect(headers.locator('[data-header-name="x-request-id"]')).toHaveText('x-request-id:req-123');
    await expect(headers.locator('[data-header-name="x-amzn-requestid"]')).toHaveText('x-amzn-requestid:amzn-req-456');
    await expect(headers.locator('[data-header-name="retry-after"]')).toHaveText('retry-after:30');
    const badge = page.getByTestId('inspector-status-badge');
    await expect(badge).toHaveText('AGENT ERROR');
    await expect(badge).toHaveAttribute('data-stage', 'agent');
    const row = page.locator(`[data-testid="test-case-row"][data-test-case-id="${TC_WITH_HEADERS}"]`);
    await expect(row.getByTestId('status-label')).toHaveText('AGENT ERROR');
  });

  test('a 5xx report without recorded headers shows the HTTP status but no response-headers block', async ({ page }) => {
    test.skip(!withoutHeaders, 'Could not seed report (storage unavailable)');
    await page.goto(`/evaluations/runs/${RUN_ID}/inspect?reportId=${withoutHeaders}`);
    const card = page.getByTestId('run-failure-card').first();
    await expect(card).toBeVisible({ timeout: 15000 });
    await expect(card).toContainText('503');
    await expect(card.getByTestId('run-failure-response-headers')).toHaveCount(0);
  });
});
