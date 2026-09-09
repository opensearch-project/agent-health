/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E: run-lifecycle action matrix (Delete / Cancel / Retry judgement) via
 * the shared RunActionsMenu kebab, plus the upgraded, prefilled Re-run
 * dialog.
 *
 * Covers the UI-visible surface (server behavior is covered by
 * tests/integration/.../evaluationRunLifecycleActions.integration.test.ts):
 *   - the kebab menu renders on evaluation-runs list rows and shows/hides
 *     Cancel depending on run status ("cancel only for ongoing ones")
 *   - Delete opens a confirm dialog before deleting
 *   - the run-detail page header's Re-run (kebab item) dialog is prefilled
 *     from the source run (agent, evaluator, judge model all visible + editable)
 *   - the inspector header exposes the same action menu, and it is the ONLY
 *     home for lifecycle actions there (no standalone Re-run / Retry
 *     judgement / Compare buttons — owner papercut); the kebab lists exactly
 *     Re-run / [Cancel] / Retry judgement / Delete with per-status gating
 *
 * Seeds its own deterministic evaluation-run docs via the storage API and
 * cleans them up via the `testData` tracker.
 */

import { test, expect } from './fixtures/test-fixtures';

test.describe('Run actions menu — Delete / Cancel / Retry judgement', () => {
  test('running run: kebab shows Cancel; completed run: kebab hides Cancel', async ({ page, request, testData }) => {
    const tcRes = await request.post('/api/storage/test-cases', {
      data: {
        name: `e2e-actions-tc-${Date.now()}`,
        category: 'Test',
        difficulty: 'Easy',
        initialPrompt: 'q',
        expectedOutcomes: ['a'],
      },
    });
    test.skip(!tcRes.ok(), 'Could not create test case (storage not configured?)');
    const tc = await tcRes.json();
    const testCaseId = tc.id || tc.testCase?.id;
    testData.testCase(testCaseId);

    const runningId = `eval-run-e2e-actions-running-${Date.now()}`;
    const runningRes = await request.put(`/api/storage/evaluation-runs/${runningId}`, {
      data: {
        id: runningId, name: 'E2E Actions Running Run', status: 'running',
        agentKey: 'demo', modelId: 'claude-sonnet',
        sources: [{ type: 'test-case-ids', ids: [testCaseId] }],
        trigger: 'api', testCaseSnapshots: [{ id: testCaseId, version: 1, name: 'tc' }],
        results: {}, createdAt: new Date().toISOString(),
      },
    });
    test.skip(!runningRes.ok(), 'Could not seed running run');
    testData.evaluationRun(runningId);

    const completedId = `eval-run-e2e-actions-completed-${Date.now()}`;
    await request.put(`/api/storage/evaluation-runs/${completedId}`, {
      data: {
        id: completedId, name: 'E2E Actions Completed Run', status: 'completed',
        agentKey: 'demo', modelId: 'claude-sonnet',
        sources: [{ type: 'test-case-ids', ids: [testCaseId] }],
        trigger: 'api', testCaseSnapshots: [{ id: testCaseId, version: 1, name: 'tc' }],
        results: {}, createdAt: new Date().toISOString(),
      },
    });
    testData.evaluationRun(completedId);

    await page.goto('/evaluations/runs');
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30000 });
    await page.getByPlaceholder('Search runs...').fill('E2E Actions');

    // Running row: menu shows Cancel.
    await expect(page.getByText('E2E Actions Running Run')).toBeVisible({ timeout: 15000 });
    const runningRow = page.locator('tr').filter({ hasText: 'E2E Actions Running Run' });
    await runningRow.locator(`[data-testid="run-actions-menu-trigger-${runningId}"]`).click();
    await expect(page.locator(`[data-testid="run-action-cancel-${runningId}"]`)).toBeVisible({ timeout: 10000 });
    await page.keyboard.press('Escape');

    // Completed row: menu hides Cancel.
    await expect(page.getByText('E2E Actions Completed Run')).toBeVisible({ timeout: 15000 });
    const completedRow = page.locator('tr').filter({ hasText: 'E2E Actions Completed Run' });
    await completedRow.locator(`[data-testid="run-actions-menu-trigger-${completedId}"]`).click();
    await expect(page.locator(`[data-testid="run-action-cancel-${completedId}"]`)).toHaveCount(0);
    // Retry judgement is present but disabled (no judge-failed cases).
    await expect(page.locator(`[data-testid="run-action-retry-judgement-${completedId}"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="run-action-retry-judgement-${completedId}"]`)).toBeDisabled();
    await page.keyboard.press('Escape');
  });

  test('Delete opens a confirm dialog and deleting removes the run from the list', async ({ page, request, testData }) => {
    const runId = `eval-run-e2e-actions-delete-${Date.now()}`;
    const res = await request.put(`/api/storage/evaluation-runs/${runId}`, {
      data: {
        id: runId, name: 'E2E Actions Delete Target', status: 'completed',
        agentKey: 'demo', modelId: 'claude-sonnet', sources: [],
        trigger: 'api', testCaseSnapshots: [], results: {}, createdAt: new Date().toISOString(),
      },
    });
    test.skip(!res.ok(), 'Could not seed run (storage not configured?)');

    await page.goto('/evaluations/runs');
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30000 });
    await page.getByPlaceholder('Search runs...').fill('E2E Actions Delete Target');
    await expect(page.getByText('E2E Actions Delete Target')).toBeVisible({ timeout: 15000 });

    await page.locator(`[data-testid="run-actions-menu-trigger-${runId}"]`).click();
    await page.locator(`[data-testid="run-action-delete-${runId}"]`).click();

    const confirmDialog = page.locator(`[data-testid="run-delete-confirm-${runId}"]`);
    await expect(confirmDialog).toBeVisible({ timeout: 10000 });
    await expect(confirmDialog).toContainText('Delete this run?');

    await page.locator(`[data-testid="run-delete-confirm-btn-${runId}"]`).click();
    await expect(page.getByText('E2E Actions Delete Target')).toHaveCount(0, { timeout: 15000 });

    // Deleted server-side too — no cleanup needed, but verify directly.
    const getRes = await request.get(`/api/storage/evaluation-runs/${runId}`);
    expect(getRes.status()).toBe(404);
  });

  test('Retry judgement is enabled only for a terminal run with a judge-failed (no-verdict) case, and flips it to passed', async ({ page, request, testData }) => {
    const tcRes = await request.post('/api/storage/test-cases', {
      data: {
        name: `e2e-retry-judgement-tc-${Date.now()}`,
        category: 'Test', difficulty: 'Easy', initialPrompt: 'q', expectedOutcomes: ['a'],
      },
    });
    test.skip(!tcRes.ok(), 'Could not create test case (storage not configured?)');
    const tc = await tcRes.json();
    const testCaseId = tc.id || tc.testCase?.id;
    testData.testCase(testCaseId);

    const reportRes = await request.post('/api/storage/runs', {
      data: {
        testCaseId, agentName: 'Demo Agent', agentKey: 'demo',
        modelName: 'demo-model', modelId: 'demo-model',
        // Judge-failed = agent completed but the evaluator produced NO
        // verdict (metricsStatus 'error'), the same shape the runner
        // persists for trace timeouts / judge errors — NOT a graded 'failed'.
        status: 'completed', metricsStatus: 'error', passFailStatus: null,
        trajectory: [{ type: 'response', content: 'no root cause found' }],
        metrics: { accuracy: 20, faithfulness: 20, latency_score: 80, trajectory_alignment_score: 20 },
        timestamp: new Date().toISOString(),
      },
    });
    test.skip(!reportRes.ok(), 'Could not seed report (storage not configured?)');
    const report = await reportRes.json();
    testData.run(report.id);

    const runId = `eval-run-e2e-retry-judgement-${Date.now()}`;
    await request.put(`/api/storage/evaluation-runs/${runId}`, {
      data: {
        id: runId, name: 'E2E Retry Judgement Run', status: 'completed',
        agentKey: 'demo', modelId: 'claude-sonnet', judgeModelId: 'demo-model',
        sources: [{ type: 'test-case-ids', ids: [testCaseId] }],
        trigger: 'api', testCaseSnapshots: [{ id: testCaseId, version: 1, name: 'tc' }],
        results: { [testCaseId]: { status: 'completed', reportId: report.id } },
        createdAt: new Date().toISOString(),
      },
    });
    testData.evaluationRun(runId);

    await page.goto(`/evaluations/runs/${runId}`);
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30000 });

    await page.locator('[data-testid="run-actions-menu-trigger-' + runId + '"]').click();
    const retryItem = page.locator(`[data-testid="run-action-retry-judgement-${runId}"]`);
    await expect(retryItem).toBeVisible({ timeout: 10000 });
    await expect(retryItem).toBeEnabled();
    await retryItem.click();

    // No inline error surfaced by the menu, and the server-side effect is
    // real: the demo judge's accuracy floor (0.7+) always resolves to
    // 'passed', so the run's persisted stats flip from errored to passed
    // (the client polls the shared 202 job to completion at a 2s cadence).
    // Poll the API directly rather than asserting on a specific pixel
    // (the stats row has no data-testid) — the UI-visible contract under
    // test is "clicking the enabled menu item doesn't error and the action
    // actually took effect", not a specific rendering of the number.
    await expect(page.locator(`[data-testid="run-action-error-${runId}"]`)).toHaveCount(0);
    await expect.poll(async () => {
      const res = await request.get(`/api/storage/evaluation-runs/${runId}`);
      const body = await res.json();
      return body.stats?.passed;
    }, { timeout: 15000 }).toBe(1);
  });
});

test.describe('Re-run dialog — the shared RunConfigDialog, prefilled + editable', () => {
  test('prefills agent/evaluator/judge model from the source run, and shows a modified hint when tweaked', async ({ page, request, testData }) => {
    const tcRes = await request.post('/api/storage/test-cases', {
      data: {
        name: `e2e-rerun-prefill-tc-${Date.now()}`,
        category: 'Test', difficulty: 'Easy', initialPrompt: 'q', expectedOutcomes: ['a'],
      },
    });
    test.skip(!tcRes.ok(), 'Could not create test case (storage not configured?)');
    const tc = await tcRes.json();
    const testCaseId = tc.id || tc.testCase?.id;
    testData.testCase(testCaseId);

    const runId = `eval-run-e2e-rerun-prefill-${Date.now()}`;
    const res = await request.put(`/api/storage/evaluation-runs/${runId}`, {
      data: {
        id: runId, name: 'E2E Rerun Prefill Source', status: 'completed',
        agentKey: 'demo', modelId: 'claude-sonnet', judgeModelId: 'demo-model',
        evaluatorId: 'system-factuality', concurrency: 3,
        sources: [{ type: 'test-case-ids', ids: [testCaseId] }],
        trigger: 'api', testCaseSnapshots: [{ id: testCaseId, version: 1, name: 'tc' }],
        results: {}, createdAt: new Date().toISOString(),
      },
    });
    test.skip(!res.ok(), 'Could not seed source run');
    testData.evaluationRun(runId);

    await page.goto(`/evaluations/runs/${runId}`);
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30000 });
    await page.locator(`[data-testid="run-actions-menu-trigger-${runId}"]`).click();
    await page.locator(`[data-testid="run-action-rerun-${runId}"]`).click();

    const dialog = page.locator('[data-testid="run-config-dialog"]');
    await expect(dialog).toBeVisible({ timeout: 10000 });

    // Prefilled name.
    await expect(page.locator('[data-testid="run-config-name-input"]')).toHaveValue('E2E Rerun Prefill Source (re-run)');
    // Evaluator visible + prefilled (owner-requested — not just carried silently).
    await expect(page.locator('[data-testid="run-config-evaluator-trigger"]')).toContainText('Factuality');
    // Agent visible + prefilled.
    await expect(page.locator('[data-testid="run-config-agent-trigger"]')).toBeVisible();

    // No "modified" hint yet — nothing has been tweaked.
    await expect(page.locator('[data-testid="run-config-modified-hint"]')).toHaveCount(0);

    // Concurrency is a first-class field (owner: "Concurrency is also missing
    // in the Run dialog box"), prepopulated from the run doc. Tweaking it
    // flips the modified hint.
    const concurrencyInput = page.locator('[data-testid="run-config-concurrency-input"]');
    await expect(concurrencyInput).toHaveValue('3');
    await concurrencyInput.fill('7');
    await expect(page.locator('[data-testid="run-config-modified-hint"]')).toBeVisible({ timeout: 5000 });

    // Dismiss without submitting — no run created.
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).not.toBeVisible();
  });
});

test.describe('Re-run from the inspector kebab — the SAME dialog as Add Run, prepopulated', () => {
  test('opens RunConfigDialog prepopulated (name / agent / evaluator / concurrency) and submitting creates a run linked via rerunOf', async ({ page, request, testData }) => {
    const tcRes = await request.post('/api/storage/test-cases', {
      data: {
        name: `e2e-inspector-rerun-tc-${Date.now()}`,
        category: 'Test', difficulty: 'Easy', initialPrompt: 'q', expectedOutcomes: ['a'],
      },
    });
    test.skip(!tcRes.ok(), 'Could not create test case (storage not configured?)');
    const tc = await tcRes.json();
    const testCaseId = tc.id || tc.testCase?.id;
    testData.testCase(testCaseId);

    const runId = `eval-run-e2e-inspector-rerun-${Date.now()}`;
    const res = await request.put(`/api/storage/evaluation-runs/${runId}`, {
      data: {
        id: runId, name: 'E2E Inspector Rerun Source', status: 'completed',
        agentKey: 'demo', modelId: 'claude-sonnet', judgeModelId: 'demo-model',
        evaluatorId: 'system-factuality', concurrency: 2,
        sources: [{ type: 'test-case-ids', ids: [testCaseId] }],
        trigger: 'api', testCaseSnapshots: [{ id: testCaseId, version: 1, name: 'tc' }],
        results: {}, createdAt: new Date().toISOString(),
      },
    });
    test.skip(!res.ok(), 'Could not seed source run');
    testData.evaluationRun(runId);

    await page.goto(`/evaluations/runs/${runId}/inspect`);
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30000 });
    await page.locator(`[data-testid="run-actions-menu-trigger-${runId}"]`).click();
    await page.locator(`[data-testid="run-action-rerun-${runId}"]`).click();

    // ONE dialog component for both entry points: the same data-testid the
    // benchmark page's "Add Run" renders, here in rerun mode.
    const dialog = page.locator('[data-testid="run-config-dialog"]');
    await expect(dialog).toBeVisible({ timeout: 10000 });
    await expect(dialog).toHaveAttribute('data-mode', 'rerun');

    // Prepopulated from the run doc's ACTUAL values.
    await expect(page.locator('[data-testid="run-config-name-input"]')).toHaveValue('E2E Inspector Rerun Source (re-run)');
    await expect(page.locator('[data-testid="run-config-agent-trigger"]')).toContainText('Demo');
    await expect(page.locator('[data-testid="run-config-evaluator-trigger"]')).toContainText('Factuality');
    await expect(page.locator('[data-testid="run-config-concurrency-input"]')).toHaveValue('2');
    await expect(page.locator('[data-testid="run-config-modified-hint"]')).toHaveCount(0);

    // Submit as a faithful duplicate — a REAL run is created against the
    // demo agent (cheap), linked back via rerunOf, and we land on it.
    await page.locator('[data-testid="run-config-submit-btn"]').click();
    await expect(page).toHaveURL(/\/evaluations\/runs\/eval-run-[^/]+$/, { timeout: 15000 });
    const newRunId = page.url().split('/evaluations/runs/')[1].split(/[/?#]/)[0];
    expect(newRunId).not.toBe(runId);
    testData.evaluationRun(newRunId);

    const newRun = await (await request.get(`/api/storage/evaluation-runs/${newRunId}`)).json();
    expect(newRun.rerunOf).toBe(runId);
    expect(newRun.modified).toBeFalsy();
    expect(newRun.concurrency).toBe(2);
    expect(newRun.evaluatorId).toBe('system-factuality');
    expect(newRun.agentKey).toBe('demo');

    // The duplicate actually executes → per-test-case report docs; track
    // them once it settles so nothing leaks into the shared cluster.
    await expect.poll(async () => {
      const r = await (await request.get(`/api/storage/evaluation-runs/${newRunId}`)).json();
      return ['completed', 'failed', 'cancelled'].includes(r.status) ? r.status : null;
    }, { timeout: 120000, intervals: [2000] }).not.toBeNull();
    const settled = await (await request.get(`/api/storage/evaluation-runs/${newRunId}`)).json();
    for (const r of Object.values(settled.results || {}) as any[]) if (r?.reportId) testData.run(r.reportId);
  });
});

test.describe('Re-run dialog — source-run agent no longer in config (real Radix Select)', () => {
  test('shows the retired agent key as the disabled current selection with a hint, blocks Re-run, and re-enables after picking a configured agent', async ({ page, request, testData }) => {
    const tcRes = await request.post('/api/storage/test-cases', {
      data: {
        name: `e2e-rerun-missing-agent-tc-${Date.now()}`,
        category: 'Test', difficulty: 'Easy', initialPrompt: 'q', expectedOutcomes: ['a'],
      },
    });
    test.skip(!tcRes.ok(), 'Could not create test case (storage not configured?)');
    const tc = await tcRes.json();
    const testCaseId = tc.id || tc.testCase?.id;
    testData.testCase(testCaseId);

    const runId = `eval-run-e2e-missing-agent-${Date.now()}`;
    const res = await request.put(`/api/storage/evaluation-runs/${runId}`, {
      data: {
        id: runId, name: 'E2E Missing Agent Source', status: 'completed',
        agentKey: 'retired-agent-e2e', modelId: 'claude-sonnet',
        sources: [{ type: 'test-case-ids', ids: [testCaseId] }],
        trigger: 'api', testCaseSnapshots: [{ id: testCaseId, version: 1, name: 'tc' }],
        results: {}, createdAt: new Date().toISOString(),
      },
    });
    test.skip(!res.ok(), 'Could not seed source run');
    testData.evaluationRun(runId);

    await page.goto(`/evaluations/runs/${runId}`);
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30000 });
    await page.locator(`[data-testid="run-actions-menu-trigger-${runId}"]`).click();
    await page.locator(`[data-testid="run-action-rerun-${runId}"]`).click();
    await expect(page.locator('[data-testid="run-config-dialog"]')).toBeVisible({ timeout: 10000 });

    // Never silently swapped: the trigger shows the retired key, the hint
    // explains, and submit is blocked.
    await expect(page.locator('[data-testid="run-config-agent-trigger"]')).toContainText('retired-agent-e2e');
    await expect(page.locator('[data-testid="run-config-agent-missing-hint"]')).toBeVisible();
    await expect(page.locator('[data-testid="run-config-submit-btn"]')).toBeDisabled();

    // The retired entry is present but disabled in the (real Radix) list;
    // picking a configured agent clears the hint and re-enables submit.
    await page.locator('[data-testid="run-config-agent-trigger"]').click();
    await page.waitForSelector('[role="listbox"]', { timeout: 5000 });
    await expect(page.locator('[data-testid="run-config-agent-missing-item"]')).toHaveAttribute('data-disabled', '');
    await page.locator('[role="option"]:has-text("Demo Agent")').click();
    await expect(page.locator('[data-testid="run-config-agent-missing-hint"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="run-config-agent-trigger"]')).toContainText('Demo Agent');
    await expect(page.locator('[data-testid="run-config-submit-btn"]')).toBeEnabled();
    await expect(page.locator('[data-testid="run-config-modified-hint"]')).toBeVisible();

    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('[data-testid="run-config-dialog"]')).not.toBeVisible();
  });
});

test.describe('Run inspector header — action menu + Cancel-only-while-running', () => {
  test('inspector header exposes the same action menu for evaluation runs', async ({ page, request, testData }) => {
    const tcRes = await request.post('/api/storage/test-cases', {
      data: {
        name: `e2e-inspector-actions-tc-${Date.now()}`,
        category: 'Test', difficulty: 'Easy', initialPrompt: 'q', expectedOutcomes: ['a'],
      },
    });
    test.skip(!tcRes.ok(), 'Could not create test case (storage not configured?)');
    const tc = await tcRes.json();
    const testCaseId = tc.id || tc.testCase?.id;
    testData.testCase(testCaseId);

    const runId = `eval-run-e2e-inspector-actions-${Date.now()}`;
    const res = await request.put(`/api/storage/evaluation-runs/${runId}`, {
      data: {
        id: runId, name: 'E2E Inspector Actions Run', status: 'running',
        agentKey: 'demo', modelId: 'claude-sonnet',
        sources: [{ type: 'test-case-ids', ids: [testCaseId] }],
        trigger: 'api', testCaseSnapshots: [{ id: testCaseId, version: 1, name: 'tc' }],
        results: {}, createdAt: new Date().toISOString(),
      },
    });
    test.skip(!res.ok(), 'Could not seed run');
    testData.evaluationRun(runId);

    await page.goto(`/evaluations/runs/${runId}/inspect`);
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30000 });

    await page.locator(`[data-testid="run-actions-menu-trigger-${runId}"]`).click();
    await expect(page.locator(`[data-testid="run-action-cancel-${runId}"]`)).toBeVisible({ timeout: 10000 });
  });
});

/*
 * Owner papercut on the inspector header: the standalone Re-run / Retry
 * judgement / Compare buttons are gone; the "…" kebab is the ONLY home for
 * lifecycle actions and lists exactly Re-run / [Cancel] / Retry judgement /
 * Delete, gated per run status. Compare is not in the kebab (it stays
 * reachable from the runs list / compare nav).
 */
test.describe('Run inspector header — kebab is the only action surface (gating matrix)', () => {
  // Kebab item order + kinds visible in the open menu.
  async function openKebabKinds(page: import('@playwright/test').Page, runId: string) {
    await page.locator(`[data-testid="run-actions-menu-trigger-${runId}"]`).click();
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible({ timeout: 10000 });
    const items = menu.getByRole('menuitem');
    const ids = await items.evaluateAll(els => els.map(el => (el.getAttribute('data-testid') || '')));
    return ids.map(id => id.replace(/^run-action-/, '').replace(new RegExp(`-${runId}$`), ''));
  }

  async function assertNoStandaloneHeaderButtons(page: import('@playwright/test').Page, runId: string) {
    await expect(page.locator(`[data-testid="run-actions-menu-trigger-${runId}"]`)).toBeVisible({ timeout: 15000 });
    await expect(page.locator('[data-testid="inspector-rerun-btn"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="inspector-retry-judgement-btn"]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Compare' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Re-run$/ })).toHaveCount(0);
  }

  async function seedTestCase(request: import('@playwright/test').APIRequestContext, testData: any, tag: string) {
    const tcRes = await request.post('/api/storage/test-cases', {
      data: { name: `e2e-kebab-matrix-${tag}-${Date.now()}`, category: 'Test', difficulty: 'Easy', initialPrompt: 'q', expectedOutcomes: ['a'] },
    });
    if (!tcRes.ok()) return null;
    const tc = await tcRes.json();
    const id = tc.id || tc.testCase?.id;
    testData.testCase(id);
    return id as string;
  }

  test('RUNNING run: Re-run, Cancel, Retry judgement (disabled), Delete — in that order', async ({ page, request, testData }) => {
    const testCaseId = await seedTestCase(request, testData, 'running');
    test.skip(!testCaseId, 'Could not create test case (storage not configured?)');

    const runId = `eval-run-e2e-kebab-running-${Date.now()}`;
    const res = await request.put(`/api/storage/evaluation-runs/${runId}`, {
      data: {
        id: runId, name: 'E2E Kebab Matrix Running', status: 'running',
        agentKey: 'demo', modelId: 'claude-sonnet',
        sources: [{ type: 'test-case-ids', ids: [testCaseId] }],
        trigger: 'api', testCaseSnapshots: [{ id: testCaseId, version: 1, name: 'tc' }],
        results: {}, createdAt: new Date().toISOString(),
      },
    });
    test.skip(!res.ok(), 'Could not seed run');
    testData.evaluationRun(runId);

    await page.goto(`/evaluations/runs/${runId}/inspect`);
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30000 });
    await assertNoStandaloneHeaderButtons(page, runId);

    expect(await openKebabKinds(page, runId)).toEqual(['rerun', 'cancel', 'retry-judgement', 'delete']);
    await expect(page.locator(`[data-testid="run-action-rerun-${runId}"]`)).not.toHaveAttribute('aria-disabled', 'true');
    const retry = page.locator(`[data-testid="run-action-retry-judgement-${runId}"]`);
    await expect(retry).toHaveAttribute('aria-disabled', 'true');
    await expect(retry).toContainText('Retry judgement (0)');
    await expect(retry).toHaveAttribute('title', 'Retry judgement is only available once the run has finished');
    await page.keyboard.press('Escape');
  });

  test('COMPLETED run WITH a judge-failed case: Re-run, Retry judgement (1) enabled, Delete — no Cancel', async ({ page, request, testData }) => {
    const testCaseId = await seedTestCase(request, testData, 'errored');
    test.skip(!testCaseId, 'Could not create test case (storage not configured?)');

    const reportRes = await request.post('/api/storage/runs', {
      data: {
        id: `report-e2e-kebab-errored-${Date.now()}`, timestamp: new Date().toISOString(),
        agentName: 'Demo Agent', agentKey: 'demo', modelName: 'demo-model', modelId: 'demo-model',
        testCaseId, status: 'completed', metricsStatus: 'error', passFailStatus: null,
        traceError: 'Judge evaluation failed (kind=judge_failed): mock 400',
        trajectory: [{ type: 'action', toolName: 'search_logs', content: 'looking' }],
        metrics: { accuracy: 0, faithfulness: 0, latency_score: 0, trajectory_alignment_score: 0 },
      },
    });
    test.skip(!reportRes.ok(), 'Could not seed report');
    const report = await reportRes.json();
    const reportId = report.id || report.report?.id;
    testData.run(reportId);

    const runId = `eval-run-e2e-kebab-errored-${Date.now()}`;
    const res = await request.put(`/api/storage/evaluation-runs/${runId}`, {
      data: {
        id: runId, name: 'E2E Kebab Matrix Errored', status: 'completed',
        agentKey: 'demo', modelId: 'demo-model', judgeModelId: 'demo-model',
        sources: [{ type: 'test-case-ids', ids: [testCaseId] }],
        trigger: 'api', testCaseSnapshots: [{ id: testCaseId, version: 1, name: 'tc' }],
        results: { [testCaseId]: { status: 'completed', reportId } },
        createdAt: new Date().toISOString(),
      },
    });
    test.skip(!res.ok(), 'Could not seed run');
    testData.evaluationRun(runId);

    await page.goto(`/evaluations/runs/${runId}/inspect`);
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30000 });
    await assertNoStandaloneHeaderButtons(page, runId);

    expect(await openKebabKinds(page, runId)).toEqual(['rerun', 'retry-judgement', 'delete']);
    await expect(page.locator(`[data-testid="run-action-cancel-${runId}"]`)).toHaveCount(0);
    // The label re-renders in place once the report-summary batch lands
    // (count flips 0 → 1) — the open menu reflects live state.
    const retry = page.locator(`[data-testid="run-action-retry-judgement-${runId}"]`);
    await expect(retry).toContainText('Retry judgement (1)', { timeout: 15000 });
    await expect(retry).not.toHaveAttribute('aria-disabled', 'true');

    // Same pipeline as before: the kebab item opens the confirm dialog with the count.
    await retry.click();
    const dialog = page.locator('[data-testid="retry-judgement-dialog"]');
    await expect(dialog).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-testid="retry-judgement-count"]')).toHaveText('1');
    await page.keyboard.press('Escape');
  });

  test('COMPLETED clean run: Retry judgement (0) disabled with the no-failures reason; Re-run + Delete enabled', async ({ page, request, testData }) => {
    const testCaseId = await seedTestCase(request, testData, 'clean');
    test.skip(!testCaseId, 'Could not create test case (storage not configured?)');

    const reportRes = await request.post('/api/storage/runs', {
      data: {
        id: `report-e2e-kebab-clean-${Date.now()}`, timestamp: new Date().toISOString(),
        agentName: 'Demo Agent', agentKey: 'demo', modelName: 'demo-model', modelId: 'demo-model',
        testCaseId, status: 'completed', metricsStatus: 'ready', passFailStatus: 'passed',
        trajectory: [{ type: 'action', toolName: 'search_logs', content: 'looking' }],
        metrics: { accuracy: 100, faithfulness: 100, latency_score: 100, trajectory_alignment_score: 100 },
      },
    });
    test.skip(!reportRes.ok(), 'Could not seed report');
    const report = await reportRes.json();
    const reportId = report.id || report.report?.id;
    testData.run(reportId);

    const runId = `eval-run-e2e-kebab-clean-${Date.now()}`;
    const res = await request.put(`/api/storage/evaluation-runs/${runId}`, {
      data: {
        id: runId, name: 'E2E Kebab Matrix Clean', status: 'completed',
        agentKey: 'demo', modelId: 'demo-model',
        sources: [{ type: 'test-case-ids', ids: [testCaseId] }],
        trigger: 'api', testCaseSnapshots: [{ id: testCaseId, version: 1, name: 'tc' }],
        results: { [testCaseId]: { status: 'completed', reportId, passFailStatus: 'passed' } },
        createdAt: new Date().toISOString(),
      },
    });
    test.skip(!res.ok(), 'Could not seed run');
    testData.evaluationRun(runId);

    await page.goto(`/evaluations/runs/${runId}/inspect`);
    await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30000 });
    await assertNoStandaloneHeaderButtons(page, runId);

    expect(await openKebabKinds(page, runId)).toEqual(['rerun', 'retry-judgement', 'delete']);
    const retry = page.locator(`[data-testid="run-action-retry-judgement-${runId}"]`);
    await expect(retry).toContainText('Retry judgement (0)');
    await expect(retry).toHaveAttribute('aria-disabled', 'true');
    await expect(retry).toHaveAttribute('title', 'No judge-failed cases to retry');
    await expect(page.locator(`[data-testid="run-action-rerun-${runId}"]`)).not.toHaveAttribute('aria-disabled', 'true');
    await expect(page.locator(`[data-testid="run-action-delete-${runId}"]`)).toBeVisible();

    // Delete goes through a confirm — nothing destructive on a bare click.
    await page.locator(`[data-testid="run-action-delete-${runId}"]`).click();
    await expect(page.locator(`[data-testid="run-delete-confirm-${runId}"]`)).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: 'Cancel' }).click();
    const still = await request.get(`/api/storage/evaluation-runs/${runId}`);
    expect(still.ok()).toBeTruthy();
  });
});
