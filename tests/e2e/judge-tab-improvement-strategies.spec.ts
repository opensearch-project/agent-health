/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E: Judge Evaluation tab — Improvement Strategies on the run inspector.
 *
 * Regression lock for "improvement strategies don't show on the Judge
 * Evaluation tab". Seeds an evaluation run with three reports and opens each
 * on the inspector route (`/evaluations/runs/:id/inspect?reportId=…`):
 *
 *   1. PASSED report with a persisted array  → section renders (no notice)
 *   2. FAILED report with a persisted array  → section renders (no notice)
 *   3. report the agentic trace judge persisted with `improvementStrategies: []`
 *      while `llmJudgeResponse.rawResponse` still carries the array
 *      → section renders from the recovered text WITH the notice
 *
 * Case 3 is the shape every report judged by that provider had before it kept
 * strategies; the UI must not render a blank tab for them.
 */

import { test, expect } from './fixtures/test-fixtures';
import { uniqueTestName } from '../helpers/testDataTracker';

const STRATEGIES = [
  { category: 'payload_economy', issue: 'Conversational framing inflates token cost', recommendation: 'Emit a compact structured record per result', priority: 'low' },
  { category: 'provenance', issue: 'Citations are bare ids appended at the end', recommendation: 'Attach the doc id inline to each claim', priority: 'high' },
];
const RAW_WITH_STRATEGIES = '```json\n' + JSON.stringify({
  pass_fail_status: 'passed', reasoning: 'Precise and grounded.', improvement_strategies: STRATEGIES,
}) + '\n```';

test.describe('Judge Evaluation tab — improvement strategies (run inspector)', () => {
  let testCaseId: string | null = null;
  let runId: string | null = null;
  const reportIds: Record<'passed' | 'failed' | 'uncaptured', string | null> = { passed: null, failed: null, uncaptured: null };

  test.beforeAll(async ({ request }) => {
    const tcRes = await request.post('/api/storage/test-cases', {
      data: {
        name: uniqueTestName('e2e-judge-strategies-tc'), category: 'Test', difficulty: 'Easy',
        initialPrompt: 'Which product matches the spec?', expectedOutcomes: ['names the matching product'],
      },
    });
    if (!tcRes.ok()) return;
    const tc = await tcRes.json();
    testCaseId = tc.id || tc.testCase?.id;
    if (!testCaseId) return;

    const seed = async (kind: keyof typeof reportIds) => {
      const stored = kind === 'uncaptured' ? [] : STRATEGIES;
      const pass = kind !== 'failed';
      const res = await request.post('/api/storage/runs', {
        data: {
          testCaseId, agentKey: 'demo', agentName: 'Demo Agent', modelId: 'demo-model', modelName: 'demo-model',
          status: pass ? 'completed' : 'failed', passFailStatus: pass ? 'passed' : 'failed', metricsStatus: 'ready',
          judgeModelId: kind === 'uncaptured' ? 'agent-trace-judge' : 'demo-judge',
          trajectory: [{ type: 'assistant', content: 'answer text' }],
          metrics: { accuracy: pass ? 95 : 20 },
          improvementStrategies: stored,
          llmJudgeResponse: {
            modelId: 'judge', timestamp: new Date().toISOString(), promptTokens: 1, completionTokens: 1, latencyMs: 1,
            rawResponse: RAW_WITH_STRATEGIES, improvementStrategies: stored,
          },
          matcherResults: [
            { description: 'judge: 1 expected outcome', pass, method: 'llm-judge', reasoning: 'Precise and grounded.', improvementStrategies: stored },
          ],
        },
      });
      if (!res.ok()) return;
      const rep = await res.json();
      reportIds[kind] = rep.id || rep.run?.id || rep.report?.id || null;
    };
    await seed('passed');
    await seed('failed');
    await seed('uncaptured');
    if (!reportIds.passed || !reportIds.failed || !reportIds.uncaptured) return;

    runId = `eval-run-${uniqueTestName('e2e-judge-strategies')}`;
    const runRes = await request.put(`/api/storage/evaluation-runs/${runId}`, {
      data: {
        id: runId, name: uniqueTestName('E2E Judge Strategies Run'), status: 'completed',
        agentKey: 'demo', modelId: 'demo-model', judgeModelId: 'agent-trace-judge',
        sources: [{ type: 'test-case-ids', ids: [testCaseId] }], trigger: 'api', testCaseSnapshots: [],
        results: {
          [testCaseId]: { reportId: reportIds.passed, status: 'completed' },
          [`${testCaseId}-f`]: { reportId: reportIds.failed, status: 'failed' },
          [`${testCaseId}-u`]: { reportId: reportIds.uncaptured, status: 'completed' },
        },
        createdAt: new Date().toISOString(), completedAt: new Date().toISOString(),
      },
    });
    if (!runRes.ok()) runId = null;
  });

  test.afterAll(async ({ request }) => {
    if (runId) await request.delete(`/api/storage/evaluation-runs/${runId}`).catch(() => {});
    for (const id of Object.values(reportIds)) if (id) await request.delete(`/api/storage/runs/${id}`).catch(() => {});
    if (testCaseId) await request.delete(`/api/storage/test-cases/${testCaseId}`).catch(() => {});
  });

  async function openJudgeTab(page: any, reportId: string) {
    await page.goto(`/evaluations/runs/${runId}/inspect?reportId=${reportId}`);
    await page.getByRole('tab', { name: /Judge Evaluation/ }).click({ timeout: 30_000 });
    await expect(page.getByText('Matchers', { exact: false }).first()).toBeVisible({ timeout: 15_000 });
  }

  for (const kind of ['passed', 'failed'] as const) {
    test(`persisted strategies render for a ${kind} report`, async ({ page }) => {
      test.skip(!runId || !reportIds[kind], 'Could not seed run (storage not configured?)');
      await openJudgeTab(page, reportIds[kind]!);

      const section = page.getByTestId('improvement-strategies-section');
      await expect(section).toBeVisible();
      await expect(section.getByRole('heading', { name: /Improvement Strategies/ })).toBeVisible();
      await expect(section).toContainText('PAYLOAD ECONOMY');
      await expect(section).toContainText('Emit a compact structured record per result');
      await expect(section).toContainText('Attach the doc id inline to each claim');
      await expect(page.getByTestId('improvement-strategies-recovered-notice')).toHaveCount(0);
    });
  }

  test('strategies stored as [] are recovered from the raw judge text and flagged', async ({ page }) => {
    test.skip(!runId || !reportIds.uncaptured, 'Could not seed run (storage not configured?)');
    await openJudgeTab(page, reportIds.uncaptured!);

    const section = page.getByTestId('improvement-strategies-section');
    await expect(section).toBeVisible();
    await expect(section).toContainText('Conversational framing inflates token cost');
    await expect(section).toContainText('Citations are bare ids appended at the end');
    const notice = page.getByTestId('improvement-strategies-recovered-notice');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("Recovered from the judge's raw output");
    await expect(notice).toContainText('backfill-improvement-strategies');
  });
});
