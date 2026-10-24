/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E: Retry judgement + Re-run on a LEGACY benchmark-embedded run.
 *
 * Owner report (#509 follow-up): on a benchmark whose two runs were created
 * by the classic/CLI path (`run-<ts>-<rand>` ids embedded in
 * `benchmark.runs[]`, NO evaluation-run doc) and whose agent key is no longer
 * configured on this server, the inspector's kebab offered neither Re-run nor
 * Retry judgement — both greyed out with "isn't available for legacy
 * benchmark-embedded runs". Retry judgement never needs the agent (only the
 * stored trajectory + an evaluator), and Re-run legitimately does — so the
 * honest UX is: Retry judgement ENABLED and working; Re-run opens the run
 * dialog, which says the agent is gone and offers the picker.
 *
 * Real-shaped fixture (seeded via the storage API, cleaned up by id): one
 * benchmark, 3 test cases (two with IDENTICAL names), two legacy embedded runs
 * with reportIds + stats + performanceMetrics and NO `passFailStatus` mirror
 * on `results[tc]` (exactly what classic runs persisted), agent key not in
 * config, a stored evaluator, the built-in demo judge model (deterministic,
 * credential-free — resolves 'passed' for a non-empty trajectory).
 */

import { test, expect } from './fixtures/test-fixtures';

const UNCONFIGURED_AGENT = 'retired-prod-agent';
const TRAJECTORY = [
  { type: 'action', toolName: 'search_sessions', content: '{"q":"travel"}' },
  { type: 'tool_result', toolName: 'search_sessions', content: '[{"id":"sess-001","score":0.91}]' },
  { type: 'assistant', content: 'The answer is in session sess-001.' },
];

test.describe('Legacy benchmark-embedded run — Retry judgement works without the agent; Re-run says the agent is gone', () => {
  test('inspector kebab: Retry judgement enabled → dialog → confirm → re-judged; Re-run → run dialog with "(not in config)" + agent picker', async ({ page, request, testData }) => {
    const stamp = Date.now();

    const evRes = await request.post('/api/storage/evaluators', {
      data: {
        name: `e2e-legacy-judge-${stamp}`,
        description: 'Created by Playwright. Safe to delete.',
        systemPrompt: 'You are a strict judge.',
        scoringConfig: { metrics: [{ name: 'accuracy', weight: 1, scale: 100 }], passThreshold: 60, scale: 100 },
        inferenceConfig: {},
      },
    });
    test.skip(!evRes.ok(), 'Could not create evaluator (storage not configured?)');
    const evaluatorId = (await evRes.json()).id;
    testData.evaluator(evaluatorId);

    const names = ['q-01 travel email', 'q-02 domain readiness', 'q-02 domain readiness'];
    const testCaseIds: string[] = [];
    for (const name of names) {
      const tcRes = await request.post('/api/storage/test-cases', {
        data: { name, category: 'retrieval', difficulty: 'Medium', initialPrompt: `Find: ${name}`, expectedOutcomes: ['cites the gold session'] },
      });
      test.skip(!tcRes.ok(), 'Could not create test case');
      const tc = await tcRes.json();
      testCaseIds.push(tc.id || tc.testCase?.id);
      testData.testCase(testCaseIds[testCaseIds.length - 1]);
    }

    // Reports: 2 passed + 1 judge-failed (metricsStatus 'error', no verdict).
    const seedReport = async (tcId: string, idx: number, verdict: 'passed' | null) => {
      const id = `run-${stamp - 50000 + idx}-e2elegacy${idx}`;
      const res = await request.post('/api/storage/runs', {
        data: {
          id, timestamp: new Date().toISOString(),
          agentName: UNCONFIGURED_AGENT, agentKey: UNCONFIGURED_AGENT, modelName: 'prod-agent', modelId: 'prod-agent',
          judgeModelId: 'demo-model', evaluatorId, testCaseId: tcId,
          status: 'completed', metricsStatus: verdict ? 'ready' : 'error', passFailStatus: verdict,
          trajectory: TRAJECTORY,
          metrics: verdict ? { accuracy: 92 } : {},
          llmJudgeReasoning: verdict ? 'Original verdict.' : undefined,
          ...(verdict ? {} : { failureStage: 'judge', error: 'Judge call failed: 400 ValidationException', judgeError: 'Judge call failed: 400 ValidationException' }),
          performanceMetrics: { judgeDurationMs: 5600, judgeAttempts: 1, durationMs: 20944, agentDurationMs: 15301 },
        },
      });
      test.skip(!res.ok(), 'Could not seed report');
      testData.run(id);
      return id;
    };
    const reportIds = [await seedReport(testCaseIds[0], 0, 'passed'), await seedReport(testCaseIds[1], 1, 'passed'), await seedReport(testCaseIds[2], 2, null)];

    const legacyRun = (id: string, name: string, offsetMs: number) => ({
      id, name, description: 'legacy embedded run (classic/CLI path)',
      createdAt: new Date(stamp - offsetMs).toISOString(), completedAt: new Date(stamp - offsetMs + 228032).toISOString(),
      status: 'completed', agentKey: UNCONFIGURED_AGENT, modelId: 'prod-agent',
      judgeModelId: 'demo-model', judgeProvider: 'bedrock', evaluatorId, concurrency: 2, benchmarkVersion: 1,
      testCaseSnapshots: testCaseIds.map((tcId, k) => ({ id: tcId, version: 1, name: names[k] })),
      // Classic runs persisted NO passFailStatus mirror on results[tc].
      results: Object.fromEntries(testCaseIds.map((tcId, k) => [tcId, { reportId: reportIds[k], status: 'completed', performanceMetrics: { judgeDurationMs: 5600, judgeAttempts: 1, durationMs: 20944 + k * 1000, agentDurationMs: 15301 } }])),
      stats: { total: 3, pending: 0, passed: 2, failed: 0, errored: 1 },
      performanceMetrics: { minTestCaseDurationMs: 20944, maxTestCaseDurationMs: 22944, avgTestCaseDurationMs: 21944, durationMs: 228032, concurrency: 2 },
    });
    const runA = `run-${stamp - 7200000}-e2elegacya`;
    const runB = `run-${stamp - 3600000}-e2elegacyb`;
    const bmRes = await request.post('/api/storage/benchmarks', {
      data: {
        name: `e2e-legacy-benchmark-${stamp}`, description: 'Created by Playwright. Safe to delete.', testCaseIds,
        runs: [legacyRun(runA, 'legacy · BEFORE', 7200000), legacyRun(runB, 'legacy · AFTER', 3600000)],
      },
    });
    test.skip(!bmRes.ok(), 'Could not seed benchmark');
    const bm = await bmRes.json();
    const benchmarkId = bm.id || bm.benchmark?.id;
    testData.benchmark(benchmarkId);

    // Sanity: the run is truly legacy — no first-class doc.
    expect((await request.get(`/api/storage/evaluation-runs/${runB}`)).status()).toBe(404);

    await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs/${runB}/inspect`);
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30000 });
    await expect(page.locator('[data-testid="test-case-row"]')).toHaveCount(3, { timeout: 20000 });

    // ── Retry judgement: ENABLED, labelled with the judge-failed count.
    await page.locator(`[data-testid="run-actions-menu-trigger-${runB}"]`).click();
    const retryItem = page.locator(`[data-testid="run-action-retry-judgement-${runB}"]`);
    await expect(retryItem).toContainText('Retry judgement (1)', { timeout: 15000 });
    await expect(retryItem).not.toHaveAttribute('aria-disabled', 'true');
    await retryItem.click();

    const dialog = page.locator('[data-testid="retry-judgement-dialog"]');
    await expect(dialog).toBeVisible({ timeout: 10000 });
    // Defaults = the legacy run's own evaluator / judge model; scope = judge-failed (1).
    await expect(page.locator('[data-testid="retry-judgement-evaluator-trigger"]')).toContainText(`e2e-legacy-judge-${stamp}`, { timeout: 10000 });
    await expect(dialog).toContainText('Demo');
    await expect(page.locator('[data-testid="retry-judgement-scope-errored"]')).toBeChecked();
    await expect(page.locator('[data-testid="retry-judgement-count"]')).toHaveText('1', { timeout: 10000 });

    // Confirm → progress → summary (the demo judge resolves 'passed').
    await page.locator('[data-testid="retry-judgement-confirm-btn"]').click();
    const summary = page.locator('[data-testid="retry-judgement-summary"]');
    await expect(summary).toBeVisible({ timeout: 30000 });
    await expect(page.locator('[data-testid="retry-judgement-summary-line"]')).toHaveText('Retried 1 · 1 scored');
    await page.locator('[data-testid="retry-judgement-done-btn"]').click();
    await expect(dialog).not.toBeVisible();

    // Server-side truth, on the EMBEDDED run (there is still no first-class doc).
    expect((await request.get(`/api/storage/evaluation-runs/${runB}`)).status()).toBe(404);
    const persistedBm = await (await request.get(`/api/storage/benchmarks/${benchmarkId}`)).json();
    const embedded = (persistedBm.benchmark ?? persistedBm).runs.find((r: any) => r.id === runB);
    expect(embedded.lastJudgementRetry).toMatchObject({ scope: 'errored', evaluatorId, judgeModelId: 'demo-model' });
    // Stats stay truthful for the cases the retry did NOT touch (2 passed before → 3 passed now, not 1/2).
    expect(embedded.stats).toMatchObject({ passed: 3, failed: 0, errored: 0, total: 3 });
    const rejudged = await (await request.get(`/api/storage/runs/${reportIds[2]}`)).json();
    expect(rejudged.passFailStatus).toBe('passed');
    expect(rejudged.judgementRetryCount).toBe(1);
    // The sibling run of the same benchmark is untouched.
    const sibling = (persistedBm.benchmark ?? persistedBm).runs.find((r: any) => r.id === runA);
    expect(sibling.lastJudgementRetry).toBeUndefined();
    expect(sibling.stats).toMatchObject({ passed: 2, errored: 1 });

    // The page refreshed: the formerly errored case now shows PASSED; header 3 ✓.
    await expect(page.locator('[data-testid="test-case-row"]').filter({ hasText: 'PASSED' })).toHaveCount(3, { timeout: 20000 });

    // ── Re-run: ENABLED; opens the run dialog prefilled from this run, says the agent is gone, Start Run disabled until another agent is picked.
    await page.locator(`[data-testid="run-actions-menu-trigger-${runB}"]`).click();
    const rerunItem = page.locator(`[data-testid="run-action-rerun-${runB}"]`);
    await expect(rerunItem).not.toHaveAttribute('aria-disabled', 'true');
    await rerunItem.click();
    const runDialog = page.locator('[data-testid="run-config-dialog"]');
    await expect(runDialog).toBeVisible({ timeout: 10000 });
    await expect(runDialog).toHaveAttribute('data-mode', 'create');
    await expect(page.locator('[data-testid="run-config-name-input"]')).toHaveValue('legacy · AFTER (re-run)');
    await expect(page.locator('[data-testid="run-config-agent-trigger"]')).toContainText(`${UNCONFIGURED_AGENT} (not in config)`);
    await expect(page.locator('[data-testid="run-config-agent-missing-hint"]')).toContainText(`Agent "${UNCONFIGURED_AGENT}" is no longer configured — pick another agent to continue.`);
    await expect(page.locator('[data-testid="run-config-concurrency-input"]')).toHaveValue('2');
    await expect(page.locator('[data-testid="run-config-submit-btn"]')).toBeDisabled();
    // The picker offers the configured agents; choosing one unblocks Start Run (not clicked — no run is started).
    await page.locator('[data-testid="run-config-agent-trigger"]').click();
    await page.getByRole('option', { name: 'Demo Agent' }).click();
    await expect(page.locator('[data-testid="run-config-agent-missing-hint"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="run-config-submit-btn"]')).toBeEnabled();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(runDialog).not.toBeVisible();
  });
});
