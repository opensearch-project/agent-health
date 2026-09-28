/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Surface matrix · UI · run actions: Retry judgement · Delete
 *
 * Real runs, real failure mode, no mocked routes:
 *   - RETRY JUDGEMENT: a `useTraces` REST agent that never exports spans makes
 *     the trace poll time out, so the run completes with N judge-failed cases
 *     (`metricsStatus: 'error'`, no verdict — an "errored" run). In the run
 *     inspector the kebab offers "Retry judgement (N)" ENABLED; the confirm
 *     dialog shows the count, re-judges the stored agent output with the
 *     run's judge (Demo Model), reports a summary, and the run's stats flip
 *     to N passed. On a fully judged run the item is DISABLED.
 *   - DELETE: from the Evaluation Runs list, kebab → Delete → confirm removes
 *     the row and the run is 404 via the API; its reports remain (AGENTS.md).
 *
 * The trace-poll budget must be short on the server under test
 * (`TRACE_POLL_MAX_ATTEMPTS` / `TRACE_POLL_INTERVAL_MS`, as CI sets) — the
 * spec fails with a clear message if the errored run takes > 90s to land.
 */

import { test, expect } from '../fixtures/test-fixtures';
import { uniqueTestName } from '../../helpers/testDataTracker';
import { startTraceparentRestAgent, type TraceparentRestAgent } from '../../helpers/traceparentRestAgent';
import {
  BASE_URL, DEMO_MODEL, api, getEvaluationRun, getReport, httpRequest, postSse, reportIdsOf, waitForReportsResolved,
  waitForTerminalRun,
} from '../../helpers/surfaceMatrix';
import { seedAgent, seedCases, seedCompletedRun, type SeededAgent } from './helpers';

const CASES = 2;

test.describe('surface-matrix · UI · run actions', () => {
  test.setTimeout(240_000);
  let seeded: SeededAgent | undefined;
  let silentAgent: TraceparentRestAgent | undefined;

  test.afterEach(async () => {
    await seeded?.agent.close();
    await silentAgent?.close();
    seeded = undefined;
    silentAgent = undefined;
  });

  test('Retry judgement: enabled on an errored run and re-judges it to N passed; disabled on a judged run', async ({ page, testData }) => {
    // A traced agent that exports NO spans → every case ends judge-failed.
    silentAgent = await startTraceparentRestAgent({ otlpEndpoint: `${BASE_URL}/v1/traces`, emitSpans: false });
    const silent = await api<{ agent: { key: string } }>('POST', '/api/agents/custom', {
      name: uniqueTestName('ui-silent-agent'), endpoint: silentAgent.url, connectorType: 'rest', useTraces: true,
    });
    testData.customAgent(silent.agent.key);
    const cases = await seedCases(testData, 'ui-retry', CASES);

    const res = await postSse('/api/storage/evaluation-runs', {
      name: uniqueTestName('ui-retry-run'),
      sources: [{ type: 'test-case-ids', ids: cases.map((c) => c.id) }],
      agentKey: silent.agent.key,
      modelId: DEMO_MODEL,
      judgeModelId: DEMO_MODEL,
    });
    const runId = res.events.find((e) => e.event === 'started')!.data.runId;
    testData.evaluationRun(runId);
    const run = await waitForTerminalRun(runId, 90_000);
    const reportIds = reportIdsOf(run);
    for (const id of reportIds) testData.run(id);
    const errored = await waitForReportsResolved(reportIds, 90_000);
    expect(errored.every((r) => r.metricsStatus === 'error'), 'trace timeout → judge-failed reports').toBe(true);

    // The run inspector's kebab → Retry judgement → confirm dialog.
    await page.goto(`/evaluations/runs/${runId}/inspect`);
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30_000 });
    await page.getByTestId(`run-actions-menu-trigger-${runId}`).click();
    const retry = page.getByTestId(`run-action-retry-judgement-${runId}`);
    await expect(retry).toBeVisible({ timeout: 10_000 });
    await expect(retry).toBeEnabled();
    await expect(retry).toContainText(String(CASES));
    await retry.click();
    // Confirm dialog: shows the judge-failed count, then a completion summary.
    const dialog = page.getByTestId('retry-judgement-dialog');
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await expect(dialog.getByTestId('retry-judgement-count')).toHaveText(String(CASES));
    await dialog.getByTestId('retry-judgement-confirm-btn').click();
    await expect(dialog.getByTestId('retry-judgement-summary')).toBeVisible({ timeout: 60_000 });
    await expect(dialog.getByTestId('retry-judgement-error')).toHaveCount(0);
    await dialog.getByTestId('retry-judgement-done-btn').click();

    await expect(page.getByTestId(`run-action-error-${runId}`)).toHaveCount(0);
    await expect.poll(async () => (await getEvaluationRun(runId)).stats?.passed, { timeout: 60_000 }).toBe(CASES);
    for (const id of reportIds) {
      const report = await getReport(id);
      expect(report.metricsStatus).not.toBe('error');
      expect(['passed', 'failed']).toContain(report.passFailStatus);
    }

    // A fully judged run: the item is present but disabled.
    seeded = await seedAgent(testData);
    const { run: judged } = await seedCompletedRun(testData, { agentKey: seeded.key, caseIds: cases.map((c) => c.id) });
    await page.goto(`/evaluations/runs/${judged.id}/inspect`);
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30_000 });
    await page.getByTestId(`run-actions-menu-trigger-${judged.id}`).click();
    const disabled = page.getByTestId(`run-action-retry-judgement-${judged.id}`);
    await expect(disabled).toBeVisible({ timeout: 10_000 });
    await expect(disabled).toBeDisabled();
  });

  test('Delete from the Evaluation Runs list removes the run; its reports stay', async ({ page, testData }) => {
    seeded = await seedAgent(testData);
    const cases = await seedCases(testData, 'ui-delete', 1);
    const name = uniqueTestName('ui-delete-run');
    const { run, reportIds } = await seedCompletedRun(testData, { agentKey: seeded.key, caseIds: cases.map((c) => c.id), name });

    await page.goto('/evaluations/runs');
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30_000 });
    await page.getByPlaceholder('Search runs...').fill(name);
    await expect(page.getByText(name)).toBeVisible({ timeout: 15_000 });

    await page.getByTestId(`run-actions-menu-trigger-${run.id}`).click();
    await page.getByTestId(`run-action-delete-${run.id}`).click();
    const confirm = page.getByTestId(`run-delete-confirm-${run.id}`);
    await expect(confirm).toBeVisible({ timeout: 10_000 });
    await expect(confirm).toContainText('Delete this run?');
    await page.getByTestId(`run-delete-confirm-btn-${run.id}`).click();

    await expect(page.getByText(name)).toHaveCount(0, { timeout: 15_000 });
    expect((await httpRequest('GET', `/api/storage/evaluation-runs/${encodeURIComponent(run.id)}`)).status).toBe(404);
    for (const id of reportIds) expect((await getReport(id)).id).toBe(id);
  });
});
