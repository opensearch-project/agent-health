/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E: Judge Evaluation tab — agentic trace judge keeps Improvement
 * Strategies.
 *
 * Regression for the bug where server/services/piAgenticJudgeService.ts
 * unconditionally forced `improvementStrategies: []`, so a run judged by the
 * agent-trace-judge (judgeModelId: 'agent-trace-judge') never showed the
 * "Improvement Strategies" section on the run-detail page even when the
 * evaluator's prompt asked the model for them — while the same evaluator
 * judged by a plain Bedrock model showed them fine.
 *
 * Seeds a standalone run (no benchmark needed — RunDetailsPage renders a
 * bare `report.id` at /runs/:runId directly) whose report is shaped exactly
 * like what the FIXED evaluateWithPiAgenticTrace + the fixed
 * benchmarkRunner.ts persistence path now produce: judgeModelId set to
 * 'agent-trace-judge', a non-empty `report.improvementStrategies`, and a
 * matching `matcherResults[0].improvementStrategies` (the unified judge
 * surface). Cheap: one test case + one run, no live agent/model call.
 */

import { test, expect } from './fixtures/test-fixtures';

test.describe('Judge Evaluation tab — agent trace judge improvement strategies', () => {
  let testCaseId: string | null = null;
  let reportId: string | null = null;

  test.beforeAll(async ({ request }) => {
    const stamp = Date.now();

    const tcRes = await request.post('/api/storage/test-cases', {
      data: {
        name: `ahtest-agent-judge-strategies-${stamp}`,
        category: 'Test',
        difficulty: 'Easy',
        initialPrompt: 'Diagnose the CPU spike.',
        expectedOutcomes: ['Identifies the CPU spike root cause'],
      },
    });
    if (!tcRes.ok()) return;
    testCaseId = (await tcRes.json()).id;

    const runRes = await request.post('/api/storage/runs', {
      data: {
        testCaseId,
        testCaseVersionId: `${testCaseId}-v1`,
        agentId: 'demo',
        modelId: 'demo-model',
        judgeModelId: 'agent-trace-judge',
        iteration: 1,
        status: 'completed',
        passFailStatus: 'passed',
        metricsStatus: 'ready',
        trajectory: [{ type: 'assistant', content: 'Root cause: CPU spike on node-3.' }],
        metrics: { accuracy: 92 },
        llmJudgeReasoning: 'Verified against real spans; agent correctly identified the root cause.',
        improvementStrategies: [
          {
            category: 'Reliability',
            issue: 'Retry storm observed in spans',
            recommendation: 'Add exponential backoff to the retry loop',
            priority: 'high',
          },
        ],
        matcherResults: [
          {
            description: 'judge: identifies the CPU spike root cause',
            pass: true,
            method: 'llm-judge',
            role: 'gate',
            model: 'agent-trace-judge',
            improvementStrategies: [
              {
                category: 'Reliability',
                issue: 'Retry storm observed in spans',
                recommendation: 'Add exponential backoff to the retry loop',
                priority: 'high',
              },
            ],
          },
        ],
      },
    });
    if (!runRes.ok()) {
      testCaseId = null;
      return;
    }
    reportId = (await runRes.json()).id;
  });

  test.afterAll(async ({ request }) => {
    if (reportId) await request.delete(`/api/storage/runs/${reportId}`).catch(() => {});
    if (testCaseId) await request.delete(`/api/storage/test-cases/${testCaseId}`).catch(() => {});
  });

  test('renders the Improvement Strategies section for a run judged by the agent trace judge', async ({ page }) => {
    test.skip(!testCaseId || !reportId, 'Could not seed standalone run (storage not configured?)');

    await page.goto(`/runs/${reportId}`);
    await expect(page.getByRole('tab', { name: /Judge Evaluation/ })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('tab', { name: /Judge Evaluation/ }).click();

    // The top-level "Improvement Strategies" card (RunDetailsContent),
    // rendered from `liveReport.improvementStrategies` — empty pre-fix for
    // the agentic trace judge.
    await expect(page.getByText('Improvement Strategies', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Retry storm observed in spans').first()).toBeVisible();
    await expect(page.getByText('Add exponential backoff to the retry loop').first()).toBeVisible();
  });
});
