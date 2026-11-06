/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E: a REST agent's non-2xx reply shows its recorded response headers on
 * the run-detail failure card (#612, problem 6).
 *
 * Seeds the exact report shape the runner now persists for a 503 from a REST
 * agent — `failureStage: 'agent'`, `agentError.httpStatus`, and the new
 * `agentError.responseHeaders` (the allowlisted diagnostic subset, lower-cased)
 * — then asserts the rendered result on `/runs/:id`: the HTTP status row and a
 * "Response headers" block listing `x-request-id` (the service request id an
 * operator needs), `x-amzn-requestid` and `retry-after`.
 *
 * Also seeds a 5xx report WITHOUT headers (a report persisted before this
 * field existed) to prove the block is simply absent, not an empty box.
 */

import { test, expect } from './fixtures/test-fixtures';

const STAMP = Date.now();
const ENDPOINT = 'http://agent.example.internal:8000/ask';
const CAUSE = `REST request failed: 503 - upstream unavailable (${ENDPOINT})`;

test.describe('REST non-2xx — response headers on the run-detail failure card', () => {
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
      connectorProtocol: 'rest', agentEndpoint: ENDPOINT, testCaseId: `e2e-rest-non2xx-tc-${STAMP}`,
      status: 'failed', metricsStatus: 'error', failureStage: 'agent', passFailStatus: null,
      trajectory: [], rawEvents: [],
      error: CAUSE,
      traceError: `Agent request failed (kind=agent_failed): ${CAUSE}`,
      llmJudgeReasoning: `**Agent request failed — not judged.**\n\nThe agent produced no output.\n\n**Cause:** ${CAUSE}`,
      metrics: { accuracy: 0, faithfulness: 0, latency_score: 0, trajectory_alignment_score: 0 },
    };
    withHeaders = await mkRep({
      ...base,
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
      agentError: { kind: 'http_503', httpStatus: 503, message: CAUSE, endpoint: ENDPOINT, elapsedMs: 97, timeoutMs: 300_000 },
    });
  });

  test.afterAll(async ({ request }) => {
    for (const id of [withHeaders, withoutHeaders]) if (id) await request.delete(`/api/storage/runs/${id}`).catch(() => {});
  });

  test('run detail lists the 503 reply\'s diagnostic response headers (request ids + retry-after visible)', async ({ page }) => {
    test.skip(!withHeaders, 'Could not seed report (storage unavailable)');
    await page.goto(`/runs/${withHeaders}`);
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
    await expect(page.getByTestId('status-label').first()).toHaveText('AGENT ERROR');
  });

  test('a 5xx report without recorded headers shows the HTTP status but no response-headers block', async ({ page }) => {
    test.skip(!withoutHeaders, 'Could not seed report (storage unavailable)');
    await page.goto(`/runs/${withoutHeaders}`);
    const card = page.getByTestId('run-failure-card').first();
    await expect(card).toBeVisible({ timeout: 15000 });
    await expect(card).toContainText('503');
    await expect(card.getByTestId('run-failure-response-headers')).toHaveCount(0);
  });
});
