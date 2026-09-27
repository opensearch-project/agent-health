/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E: canonical verdict engine surfaces.
 *
 *  (i)   A report judged with a `threshold` evaluator where the LLM said
 *        "passed" but the computed score is below the threshold → the Judge
 *        tab shows the COMPUTED verdict, the LLM's verdict and a conflict
 *        marker, and lists the unevaluable rubric as "not evaluable" (not 0).
 *  (ii)  A judge-error report shows the explicit "no metrics" state (no
 *        zeros anywhere).
 *  (iii) Evaluator editor: pick the "Score threshold" pass policy → saved as
 *        `passPolicy: { kind: 'threshold', minScore }`, version pill bumps.
 *
 * Reports are seeded directly (generic fixture; no LLM), exactly like the
 * verdict engine writes them — the write path itself is covered by the
 * integration suite (verdictEngineSnapshotWrite.integration.test.ts).
 */

import { test, expect } from './fixtures/test-fixtures';

const UNIQUE = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

test.describe('Judge tab — verdict engine', () => {
  let testCaseId: string | null = null;
  let benchmarkId: string | null = null;
  let runId: string | null = null;
  let conflictReportId: string | null = null;
  let errorReportId: string | null = null;
  let errorTestCaseId: string | null = null;

  test.beforeAll(async ({ request }) => {
    const stamp = Date.now();
    const mkCase = async (name: string) => {
      const res = await request.post('/api/storage/test-cases', {
        data: {
          name,
          category: 'Test',
          difficulty: 'Easy',
          initialPrompt: 'Which document answers the question?',
          expectedOutcomes: ['cites the right document'],
        },
      });
      return res.ok() ? (await res.json()).id as string : null;
    };
    testCaseId = await mkCase(`e2e-verdict-conflict-${stamp}`);
    errorTestCaseId = await mkCase(`e2e-verdict-error-${stamp}`);
    if (!testCaseId || !errorTestCaseId) return;

    conflictReportId = `report-e2e-verdict-conflict-${stamp}`;
    errorReportId = `report-e2e-verdict-error-${stamp}`;
    const snapshot = {
      evaluatorId: 'eval-e2e-demo',
      evaluatorVersion: 2,
      contentHash: 'sha256:e2e0000000000000',
      evaluatorName: 'Demo threshold evaluator',
      weights: { relevance: 0.5, grounding: 0.3, brevity: 0.2 },
      scale: { relevance: { min: 0, max: 100 }, grounding: { min: 0, max: 100 }, brevity: { min: 0, max: 100 } },
      passPolicy: { kind: 'threshold', minScore: 0.7 },
      judgeModelId: 'demo-judge-model',
      unevaluable: ['brevity'],
    };
    const bulk = await request.post('/api/storage/runs/bulk', {
      data: {
        runs: [
          {
            id: conflictReportId,
            testCaseId,
            testCaseVersionId: `${testCaseId}-v1`,
            agentId: 'demo',
            modelId: 'demo-model',
            iteration: 1,
            status: 'completed',
            metricsStatus: 'ready',
            // The LLM said passed; the engine (0.5*60 + 0.3*60 over 0.8) = 0.60 < 0.70 → failed.
            passFailStatus: 'failed',
            llmVerdict: 'passed',
            verdictConflict: true,
            score: 0.6,
            metrics: { relevance: 60, grounding: 60 },
            scoringSnapshot: snapshot,
            trajectory: [{ type: 'assistant', content: 'answer text' }],
            llmJudgeReasoning: 'The answer cites the right document.',
          },
          {
            id: errorReportId,
            testCaseId: errorTestCaseId,
            testCaseVersionId: `${errorTestCaseId}-v1`,
            agentId: 'demo',
            modelId: 'demo-model',
            iteration: 1,
            status: 'completed',
            metricsStatus: 'error',
            metrics: {},
            traceError: 'Judge evaluation failed (kind=judge_failed): Judge HTTP 500',
            trajectory: [{ type: 'assistant', content: 'answer text' }],
            llmJudgeReasoning: '**Evaluator could not run.**',
          },
        ],
      },
    });
    if (!bulk.ok()) { conflictReportId = null; errorReportId = null; return; }

    const bmRes = await request.post('/api/storage/benchmarks', {
      data: {
        name: `e2e-verdict-bm-${stamp}`,
        description: 'verdict engine e2e',
        testCaseIds: [testCaseId, errorTestCaseId],
        runs: [],
        currentVersion: 1,
        versions: [{ version: 1, createdAt: new Date().toISOString(), testCaseIds: [testCaseId, errorTestCaseId] }],
      },
    });
    if (!bmRes.ok()) return;
    benchmarkId = (await bmRes.json()).id;
    runId = `run-e2e-verdict-${stamp}`;
    const bm = await (await request.get(`/api/storage/benchmarks/${benchmarkId}`)).json();
    const put = await request.put(`/api/storage/benchmarks/${benchmarkId}`, {
      data: {
        name: bm.name,
        description: bm.description,
        testCaseIds: bm.testCaseIds,
        runs: [
          {
            id: runId,
            name: 'E2E Verdict Run',
            agentKey: 'demo',
            modelId: 'demo-model',
            judgeModelId: 'demo-judge-model',
            createdAt: new Date().toISOString(),
            status: 'completed',
            benchmarkVersion: 1,
            testCaseSnapshots: [],
            results: {
              [testCaseId]: { reportId: conflictReportId, status: 'completed', passFailStatus: 'failed' },
              [errorTestCaseId]: { reportId: errorReportId, status: 'completed' },
            },
          },
        ],
      },
    });
    if (!put.ok()) benchmarkId = null;
  });

  test.afterAll(async ({ request }) => {
    if (benchmarkId) await request.delete(`/api/storage/benchmarks/${benchmarkId}`).catch(() => {});
    for (const id of [conflictReportId, errorReportId]) if (id) await request.delete(`/api/storage/runs/${id}`).catch(() => {});
    for (const id of [testCaseId, errorTestCaseId]) if (id) await request.delete(`/api/storage/test-cases/${id}`).catch(() => {});
  });

  test('(i) computed verdict + LLM verdict + conflict marker; unevaluable rubric is "not evaluable", not 0', async ({ page }) => {
    test.skip(!benchmarkId || !runId || !conflictReportId, 'Could not seed benchmark run (storage not configured?)');

    await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs/${runId}/inspect`);
    const rows = page.locator('[data-testid="test-case-row"]');
    await expect(rows.first()).toBeVisible({ timeout: 30_000 });
    await rows.filter({ hasText: /verdict-conflict/ }).first().click();
    await page.getByRole('tab', { name: /Judge Evaluation/ }).click();

    const summary = page.getByTestId('verdict-summary');
    await expect(summary).toBeVisible({ timeout: 15_000 });
    await expect(summary).toHaveAttribute('data-verdict-state', 'conflict');
    await expect(page.getByTestId('verdict-line')).toContainText('Verdict: failed');
    await expect(page.getByTestId('verdict-line')).toContainText('policy: score ≥ 0.7');
    await expect(page.getByTestId('verdict-line')).toContainText('LLM said: passed');
    await expect(page.getByTestId('verdict-conflict')).toContainText('conflict');
    await expect(page.getByTestId('verdict-score')).toContainText('60%');
    await expect(page.getByTestId('verdict-unevaluable')).toContainText('brevity: not evaluable');
    await expect(summary).toContainText('scored 2 / 3 rubrics');
  });

  test('(ii) judge error shows the "no metrics" state instead of zeros', async ({ page }) => {
    test.skip(!benchmarkId || !runId || !errorReportId, 'Could not seed benchmark run (storage not configured?)');

    await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs/${runId}/inspect`);
    const rows = page.locator('[data-testid="test-case-row"]');
    await expect(rows.first()).toBeVisible({ timeout: 30_000 });
    await rows.filter({ hasText: /verdict-error/ }).first().click();
    await page.getByRole('tab', { name: /Judge Evaluation/ }).click();

    const summary = page.getByTestId('verdict-summary');
    await expect(summary).toBeVisible({ timeout: 15_000 });
    await expect(summary).toHaveAttribute('data-verdict-state', 'no-metrics');
    await expect(summary).toContainText('No verdict');
    await expect(summary).toContainText('no metrics were recorded');
    await expect(summary).toContainText('errored');
    // No fabricated zero anywhere in the Judge tab panel (the run header's
    // pass rate legitimately reads 0% — 0 of 1 judged passed — and is out of scope).
    const judgePanel = page.getByRole('tabpanel');
    await expect(judgePanel.getByText(/\b0%/)).toHaveCount(0);
    await expect(judgePanel.getByText(/not evaluable/)).toHaveCount(0);
  });
});

test.describe('Evaluator editor — pass policy', () => {
  test('(iii) setting a Score threshold policy persists passPolicy and bumps the version pill', async ({ page, request }) => {
    const name = UNIQUE('E2E Verdict Eval');
    const created = await request.post('/api/storage/evaluators', {
      data: {
        name,
        description: 'Created by Playwright. Safe to delete.',
        systemPrompt: 'You are a judge.',
        scoringConfig: {
          metrics: [{ name: 'relevance', weight: 0.6, scale: 100 }, { name: 'grounding', weight: 0.4, scale: 100 }],
          passThreshold: 70,
          scale: 100,
        },
        inferenceConfig: {},
      },
    });
    expect(created.ok()).toBeTruthy();
    const evaluator = await created.json();

    try {
      await page.goto(`/evaluators/${evaluator.id}/edit`);
      await expect(page.getByRole('heading', { name: /edit evaluator/i })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText('v1', { exact: true }).first()).toBeVisible();

      // Default is the frozen judge-verdict policy.
      const policySelect = page.getByTestId('pass-policy-select');
      await expect(policySelect).toContainText(/judge verdict/i);
      await policySelect.click();
      await page.getByRole('option', { name: /score threshold/i }).click();
      await expect(policySelect).toContainText(/score threshold/i);
      await page.locator('#passThreshold').fill('75');
      await page.getByLabel('Primary metric relevance').check();

      const [putResp] = await Promise.all([
        page.waitForResponse(r => /\/api\/storage\/evaluators\//.test(r.url()) && r.request().method() === 'PUT'),
        page.getByRole('button', { name: /^save$/i }).click(),
      ]);
      expect(putResp.status()).toBe(200);
      const updated = await putResp.json();
      expect(updated.currentVersion).toBe(2);
      expect(updated.scoringConfig.passPolicy).toEqual({ kind: 'threshold', minScore: 0.75 });
      expect(updated.scoringConfig.primaryMetrics).toEqual(['relevance']);

      // The header shows the evaluator document's new currentVersion (the pre-existing evaluator
      // history; scoring identity stays evaluatorId + contentHash — no separate versioning scheme)
      // and the policy is reloaded into the (now read-only) form.
      await expect(page.getByText('v2', { exact: true }).first()).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId('pass-policy-select')).toContainText(/score threshold/i);
    } finally {
      await request.delete(`/api/storage/evaluators/${evaluator.id}`).catch(() => {});
    }
  });
});
