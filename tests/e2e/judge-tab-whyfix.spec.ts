/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E: Judge Evaluation tab — WHY / FIX redesign.
 *
 * Seeds a benchmark run whose report carries SDK-style `matcherResults`
 * (one passing code assertion + one failed llm-judge entry shaped exactly
 * like real persisted verdicts from the logos-human-persona evaluator:
 * dimension judgeMetrics, improvementStrategies, prose reasoning with
 * per-fact verdicts and an expected-vs-cited source mismatch, and the
 * pre-fix `score: 0` + `errorMessage === reasoning` artifacts).
 *
 * Asserts the redesigned rendering:
 *   - no fabricated "score 0%" headline; dimension chips instead
 *   - "Why it failed" panel (source mismatch + fact counts from prose)
 *   - "How to fix it" panel (the judge's improvementStrategies)
 *   - per-fact checklist chips
 *   - reasoning rendered exactly once (no error/reasoning duplication)
 */

import { test, expect } from './fixtures/test-fixtures';

const REASONING = `The expected source document is article 49d9e88fadbf11fa4e685c847590078ff9394c2fe7566094f504f53ca4aca465. However, the agent retrieved a different article (b6c9353c0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5). Required facts evaluation: 1. 'You can start accepting payments almost immediately' — PARTIALLY stated. The agent frames it around a status with caveats. 2. 'Identity verification needed before full activation' — PARTIALLY stated. Not clearly stated.`;

test.describe('Judge Evaluation tab — why/fix redesign', () => {
  let testCaseId: string | null = null;
  let reportId: string | null = null;
  let benchmarkId: string | null = null;
  let runId: string | null = null;

  test.beforeAll(async ({ request }) => {
    const stamp = Date.now();

    const tcRes = await request.post('/api/storage/test-cases', {
      data: {
        name: `e2e-judge-whyfix-${stamp}`,
        category: 'Test',
        difficulty: 'Easy',
        initialPrompt: 'Can I accept payments during verification?',
        expectedOutcomes: ['states the two required facts'],
      },
    });
    if (!tcRes.ok()) return;
    testCaseId = (await tcRes.json()).id;

    reportId = `report-e2e-judge-whyfix-${stamp}`;
    const bulkRes = await request.post('/api/storage/runs/bulk', {
      data: {
        runs: [
          {
            id: reportId,
            testCaseId,
            testCaseVersionId: `${testCaseId}-v1`,
            agentId: 'demo',
            modelId: 'demo-model',
            iteration: 1,
            status: 'completed',
            passFailStatus: 'failed',
            metricsStatus: 'ready',
            trajectory: [{ type: 'assistant', content: 'answer text' }],
            matcherResults: [
              { description: 'true to equal true', pass: true, method: 'code-assertion', actual: true, expected: true },
              {
                description: 'judge: 2 claims',
                pass: false,
                method: 'llm-judge',
                role: 'gate',
                durationMs: 21906,
                // Pre-fix artifacts old reports carry — the UI must degrade them:
                score: 0,
                errorMessage: REASONING,
                reasoning: REASONING,
                model: 'us.anthropic.claude-sonnet-4-6',
                judgeMetrics: { answer_correctness: 55, trust_honesty: 45, readability: 75 },
                improvementStrategies: [
                  {
                    category: 'Correctness',
                    issue: 'Wrong article retrieved',
                    recommendation: 'Use targeted queries to surface the expected article.',
                    priority: 'high',
                  },
                ],
              },
            ],
          },
        ],
      },
    });
    if (!bulkRes.ok()) {
      reportId = null;
      return;
    }

    const bmRes = await request.post('/api/storage/benchmarks', {
      data: {
        name: `e2e-judge-whyfix-bm-${stamp}`,
        description: 'judge tab why/fix e2e',
        testCaseIds: [testCaseId],
        runs: [],
        currentVersion: 1,
        versions: [{ version: 1, createdAt: new Date().toISOString(), testCaseIds: [testCaseId] }],
      },
    });
    if (!bmRes.ok()) return;
    benchmarkId = (await bmRes.json()).id;

    runId = `run-e2e-judge-whyfix-${stamp}`;
    const get = await request.get(`/api/storage/benchmarks/${benchmarkId}`);
    const bm = await get.json();
    const put = await request.put(`/api/storage/benchmarks/${benchmarkId}`, {
      data: {
        name: bm.name,
        description: bm.description,
        testCaseIds: bm.testCaseIds,
        runs: [
          {
            id: runId,
            name: 'E2E Judge WhyFix Run',
            agentKey: 'demo',
            modelId: 'demo-model',
            createdAt: new Date().toISOString(),
            status: 'completed',
            benchmarkVersion: 1,
            testCaseSnapshots: [],
            results: { [testCaseId!]: { reportId, status: 'completed' } },
          },
        ],
      },
    });
    if (!put.ok()) benchmarkId = null;
  });

  test.afterAll(async ({ request }) => {
    if (benchmarkId) await request.delete(`/api/storage/benchmarks/${benchmarkId}`).catch(() => {});
    if (reportId) await request.delete(`/api/storage/runs/${reportId}`).catch(() => {});
    if (testCaseId) await request.delete(`/api/storage/test-cases/${testCaseId}`).catch(() => {});
  });

  test('failed judge matcher renders Why/Fix panels, fact chips, and a single reasoning copy', async ({ page }) => {
    test.skip(!benchmarkId || !runId || !reportId, 'Could not seed benchmark run (storage not configured?)');

    await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs/${runId}/inspect`);
    await expect(page.locator('[data-testid="test-case-row"]').first()).toBeVisible({ timeout: 30_000 });
    await page.locator('[data-testid="test-case-row"]').first().click();

    // Open the Judge Evaluation tab.
    await page.getByRole('tab', { name: /Judge Evaluation/ }).click();

    // Matchers summary with the failed judge row expanded by default.
    await expect(page.getByText('Checks', { exact: false }).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('judge: 2 claims')).toBeVisible();

    // 1. No fabricated "score 0%"; dimension chips are the scannable verdict.
    await expect(page.getByText('score 0%')).toHaveCount(0);
    await expect(page.getByText(/answer correctness 55/)).toBeVisible();
    await expect(page.getByText(/trust honesty 45/)).toBeVisible();

    // 2. WHY: source mismatch parsed out of the reasoning prose.
    await expect(page.getByText('Why it failed')).toBeVisible();
    await expect(page.getByText(/Wrong source cited/)).toBeVisible();
    await expect(page.getByText(/49d9e88f…/)).toBeVisible();

    // 3. FIX: the judge's own improvement strategies, promoted.
    await expect(page.getByText('How to fix it')).toBeVisible();
    await expect(page.getByText('Wrong article retrieved')).toBeVisible();

    // 4. Per-fact checklist chips.
    await expect(page.getByText('PARTIAL').first()).toBeVisible();
    await expect(page.getByText(/accepting payments almost immediately/).first()).toBeVisible();

    // 5. Reasoning appears exactly once (old errorMessage mirror suppressed).
    await page.getByText('Full judge reasoning').click();
    const copies = await page.getByText('However, the agent retrieved a different article', { exact: false }).count();
    expect(copies).toBe(1);
  });
});
