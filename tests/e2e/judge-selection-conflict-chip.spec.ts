/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect } from './fixtures/test-fixtures';

/**
 * Judge-selection conflict chip on the run-detail Judge tab.
 *
 * When an eval body pinned a different evaluator / judge model than the run
 * selected, the runner applies the RUN's selection and records the
 * disagreement on the report as `judgeSelectionConflicts`. The report page
 * must flag it (amber chip with run + body values) — and a report without
 * conflicts must show no chip. We seed the exact report shape the runner
 * persists and assert the rendered result.
 */
test.describe('Run detail — judge selection conflict chip', () => {
  const base = {
    timestamp: new Date().toISOString(),
    agentKey: 'demo',
    agentName: 'Demo Agent',
    modelName: 'demo-model',
    modelId: 'demo-model',
    trajectory: [{ type: 'response', content: 'done' }],
    status: 'completed',
    evaluationType: 'deterministic',
    passFailStatus: 'passed',
    metricsStatus: 'completed',
    llmJudgeReasoning: '',
    metrics: { accuracy: 90, faithfulness: 90, latency_score: 90, trajectory_alignment_score: 90 },
    evaluatorId: 'system-rca-default',
    judgeModelId: 'demo-model',
    matcherResults: [
      {
        description: 'judge: mentions the affected service',
        pass: true,
        method: 'llm-judge',
        role: 'gate',
        score: 0.9,
        reasoning: 'ok',
        model: 'demo-model',
        evaluatorId: 'system-rca-default',
      },
    ],
  };

  test('a report with judgeSelectionConflicts shows the amber chip with run + body values', async ({ page, request, testData }) => {
    const res = await request.post('/api/storage/runs', {
      data: {
        ...base,
        testCaseId: `e2e-judge-conflict-tc-${Date.now()}`,
        judgeApplied: {
          evaluatorId: 'system-rca-default',
          evaluatorIdSource: 'run',
          modelId: 'demo-model',
          modelIdSource: 'run',
        },
        judgeSelectionConflicts: [
          { field: 'evaluatorId', runValue: 'system-rca-default', bodyValue: 'system-factuality' },
          { field: 'modelId', runValue: 'demo-model', bodyValue: 'some-other-model' },
        ],
      },
    });
    expect(res.ok(), 'seeding conflict report').toBe(true);
    const report = await res.json();
    testData.run(report.id);

    await page.goto(`/runs/${report.id}?tab=judge`);
    const chip = page.getByTestId('judge-selection-conflict-chip');
    await expect(chip).toBeVisible({ timeout: 15000 });
    await expect(chip).toContainText('Body pinned a different judge — run selection applied');
    const rows = page.getByTestId('judge-selection-conflict-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('system-rca-default');
    await expect(rows.nth(0)).toContainText('system-factuality');
    await expect(rows.nth(1)).toContainText('demo-model');
    await expect(rows.nth(1)).toContainText('some-other-model');
  });

  test('a report WITHOUT conflicts shows no chip', async ({ page, request, testData }) => {
    const res = await request.post('/api/storage/runs', {
      data: {
        ...base,
        testCaseId: `e2e-judge-noconflict-tc-${Date.now()}`,
        judgeApplied: {
          evaluatorId: 'system-rca-default',
          evaluatorIdSource: 'run',
          modelId: 'demo-model',
          modelIdSource: 'run',
        },
      },
    });
    expect(res.ok(), 'seeding clean report').toBe(true);
    const report = await res.json();
    testData.run(report.id);

    await page.goto(`/runs/${report.id}?tab=judge`);
    // Judge tab rendered (the matcher panel is present) …
    await expect(page.locator('text=mentions the affected service').first()).toBeVisible({ timeout: 15000 });
    // … and no conflict chip.
    await expect(page.getByTestId('judge-selection-conflict-chip')).toHaveCount(0);
  });
});
