/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E: agent-error surfacing in the run inspector + run detail page.
 *
 * Owner incident: a 62-case run against a REST agent ended with 5 cases
 * "errored" whose Test Case Output tab showed NOTHING useful — the truth was
 * that the agent request had timed out (undici HeadersTimeoutError after the
 * silent 300 s default) and the empty case had then been judged anyway. These
 * specs seed the exact report shape the fixed runner now persists
 * (`failureStage: 'agent'` + `agentError`) alongside a judge-stage failure,
 * then assert the rendered result:
 *
 *   1. Test Case Output tab shows the "Agent request failed" card with the
 *      unwrapped cause, endpoint, elapsed and the timeout in force.
 *   2. The case row badge reads AGENT ERROR (vs JUDGE ERROR for the other
 *      case, vs FAILED for a failed verdict).
 *   3. Retry judgement counts ONLY the judge-stage case (1), not the agent one.
 *   4. The standalone /runs/:id page renders the same card.
 *
 * Seeded via the storage API; cleaned up via the testData tracker.
 */

import { test, expect } from './fixtures/test-fixtures';

const STAMP = Date.now();
const RUN_ID = `eval-run-e2e-agent-error-${STAMP}`;
const RUN_NAME = `E2E Agent Error Surfacing ${STAMP}`;
const ENDPOINT = 'http://agent.example.internal:8000/ask';
const CAUSE = `Agent request timed out after 300728ms (timeout 300000ms) — no response headers/body from POST ${ENDPOINT} [UND_ERR_HEADERS_TIMEOUT]`;

test.describe('Agent-error surfacing — inspector + run detail', () => {
  let tcAgent: string | null = null;
  let tcJudge: string | null = null;
  let tcFailed: string | null = null;
  let repAgent: string | null = null;
  let repJudge: string | null = null;
  let repFailed: string | null = null;
  let seeded = false;

  test.beforeAll(async ({ request }) => {
    const mkTc = async (name: string) => {
      const r = await request.post('/api/storage/test-cases', {
        data: { name: `ahtest-agent-error-${name}-${STAMP}`, category: 'Test', difficulty: 'Easy', initialPrompt: 'What is the answer?', expectedOutcomes: ['Answers'] },
      });
      if (!r.ok()) return null;
      const b = await r.json();
      return (b.id || b.testCase?.id || null) as string | null;
    };
    tcAgent = await mkTc('agent');
    tcJudge = await mkTc('judge');
    tcFailed = await mkTc('failed');
    if (!tcAgent || !tcJudge || !tcFailed) return;

    const base = { agentName: 'A REST agent', agentKey: 'example-rest-agent', modelName: 'demo-model', modelId: 'demo-model', connectorProtocol: 'rest', agentEndpoint: ENDPOINT, judgeModelId: 'agent-trace-judge', evaluatorId: 'ev-persona' };
    const mkRep = async (data: Record<string, unknown>) => {
      const r = await request.post('/api/storage/runs', { data });
      if (!r.ok()) return null;
      const b = await r.json();
      return (b.id || b.run?.id || b.report?.id || null) as string | null;
    };

    // 1) Agent-stage failure: exactly what the fixed runner persists for the incident.
    repAgent = await mkRep({
      ...base, testCaseId: tcAgent,
      status: 'failed', metricsStatus: 'error', failureStage: 'agent', passFailStatus: null,
      trajectory: [], rawEvents: [],
      error: CAUSE,
      agentError: { kind: 'timeout', message: CAUSE, elapsedMs: 300_728, endpoint: ENDPOINT, timeoutMs: 300_000 },
      traceError: `Agent request failed (kind=agent_failed): ${CAUSE}`,
      llmJudgeReasoning: `**Agent request failed — not judged.**\n\nThe agent produced no output.\n\n**Cause:** ${CAUSE}`,
      metrics: { accuracy: 0, faithfulness: 0, latency_score: 0, trajectory_alignment_score: 0 },
    });
    // 2) Judge-stage failure with an empty raw reply and 2 attempts.
    repJudge = await mkRep({
      ...base, testCaseId: tcJudge,
      status: 'completed', metricsStatus: 'error', failureStage: 'judge', passFailStatus: null,
      trajectory: [{ id: 's1', type: 'response', content: 'The answer is 42.', timestamp: Date.now() }], rawEvents: [{ response: 'The answer is 42.' }],
      error: 'Bedrock Judge evaluation failed after 2 attempts: AgentJudge: judge returned no parseable verdict — the model returned an empty response.',
      judgeError: { message: 'Bedrock Judge evaluation failed after 2 attempts: …', rawResponse: '', attempts: 2 },
      traceError: 'Judge evaluation failed (kind=judge_failed): Bedrock Judge evaluation failed after 2 attempts: judge returned no parseable verdict',
      llmJudgeReasoning: '**Evaluator could not run.**',
      metrics: { accuracy: 0, faithfulness: 0, latency_score: 0, trajectory_alignment_score: 0 },
    });
    // 3) Plain failed verdict, for contrast.
    repFailed = await mkRep({
      ...base, testCaseId: tcFailed,
      status: 'completed', metricsStatus: 'ready', passFailStatus: 'failed',
      trajectory: [{ id: 's1', type: 'response', content: 'The answer is 41.', timestamp: Date.now() }], rawEvents: [{}],
      llmJudgeReasoning: 'Wrong answer.',
      metrics: { accuracy: 20, faithfulness: 20, latency_score: 90, trajectory_alignment_score: 20 },
    });
    if (!repAgent || !repJudge || !repFailed) return;

    const runRes = await request.put(`/api/storage/evaluation-runs/${RUN_ID}`, {
      data: {
        id: RUN_ID, name: RUN_NAME, status: 'completed', docType: 'evaluation-run',
        agentKey: 'example-rest-agent', modelId: 'demo-model', judgeModelId: 'agent-trace-judge',
        sources: [{ type: 'test-case-ids', ids: [tcAgent, tcJudge, tcFailed] }], trigger: 'api',
        testCaseSnapshots: [
          { id: tcAgent, version: 1, name: 'agent timeout case' },
          { id: tcJudge, version: 1, name: 'judge empty case' },
          { id: tcFailed, version: 1, name: 'failed verdict case' },
        ],
        results: {
          // The runner writes 'completed' (no passFailStatus) for both errored kinds.
          [tcAgent]: { reportId: repAgent, status: 'completed' },
          [tcJudge]: { reportId: repJudge, status: 'completed' },
          [tcFailed]: { reportId: repFailed, status: 'failed', passFailStatus: 'failed' },
        },
        stats: { passed: 0, failed: 1, errored: 2, pending: 0, total: 3 },
        createdAt: new Date().toISOString(), completedAt: new Date().toISOString(),
      },
    });
    seeded = runRes.ok();
  });

  test.afterAll(async ({ request }) => {
    await request.delete(`/api/storage/evaluation-runs/${RUN_ID}`).catch(() => {});
    for (const id of [repAgent, repJudge, repFailed]) if (id) await request.delete(`/api/storage/runs/${id}`).catch(() => {});
    for (const id of [tcAgent, tcJudge, tcFailed]) if (id) await request.delete(`/api/storage/test-cases/${id}`).catch(() => {});
  });

  test('inspector: AGENT ERROR badge, agent-error card in Test Case Output, retry-judgement excludes it', async ({ page }) => {
    test.skip(!seeded, 'Could not seed run (storage unavailable)');
    await page.goto(`/evaluations/runs/${RUN_ID}/inspect?reportId=${repAgent}`);

    // Row badges: AGENT ERROR vs JUDGE ERROR vs FAILED.
    const agentRow = page.locator(`[data-testid="test-case-row"][data-test-case-id="${tcAgent}"]`);
    await expect(agentRow).toBeVisible({ timeout: 15000 });
    await expect(agentRow.getByTestId('status-label')).toHaveText('AGENT ERROR');
    const judgeRow = page.locator(`[data-testid="test-case-row"][data-test-case-id="${tcJudge}"]`);
    await expect(judgeRow.getByTestId('status-label')).toHaveText('JUDGE ERROR');
    const failedRow = page.locator(`[data-testid="test-case-row"][data-test-case-id="${tcFailed}"]`);
    await expect(failedRow.getByTestId('status-label')).toHaveText('FAILED');

    // Header tallies split by stage; retry judgement counts only the judge case.
    await expect(page.getByTestId('inspector-agent-error-count')).toHaveText('1');
    await expect(page.getByTestId('inspector-judge-error-count')).toHaveText('1');
    // Retry judgement lives in the actions kebab (owner papercut: no
    // standalone header buttons; see tests/e2e/run-actions-menu.spec.ts).
    await page.locator(`[data-testid="run-actions-menu-trigger-${RUN_ID}"]`).click();
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible({ timeout: 10000 });
    const retryItem = page.locator(`[data-testid="run-action-retry-judgement-${RUN_ID}"]`);
    await expect(retryItem).toBeVisible();
    await expect(retryItem).toContainText('Retry judgement (1)');
    await expect(retryItem).not.toHaveAttribute('aria-disabled', 'true');
    await page.keyboard.press('Escape');

    // Right pane: inspector badge + the agent-error card at the top of Test Case Output.
    await expect(page.getByTestId('inspector-status-badge')).toHaveText('AGENT ERROR', { timeout: 15000 });
    const card = page.getByTestId('run-failure-card');
    await expect(card.first()).toBeVisible();
    await expect(card.first()).toHaveAttribute('data-stage', 'agent');
    await expect(card.first()).toContainText('Agent request failed');
    await expect(card.first().getByTestId('run-failure-cause')).toContainText('UND_ERR_HEADERS_TIMEOUT');
    await expect(card.first().getByTestId('run-failure-cause')).toContainText('timeout 300000ms');
    await expect(card.first()).toContainText(ENDPOINT);
    await expect(card.first()).toContainText('5 min 1 s');            // elapsed
    await expect(card.first()).toContainText('connectorConfig.timeoutMs'); // timeout in force
    await expect(card.first()).toContainText('not judged');
    // It must NOT say the evaluator failed.
    await expect(page.getByText('Evaluator could not run')).toHaveCount(0);
  });

  test('inspector: judge-stage case shows the judge card with "model returned an empty response" + attempts', async ({ page }) => {
    test.skip(!seeded, 'Could not seed run (storage unavailable)');
    await page.goto(`/evaluations/runs/${RUN_ID}/inspect?reportId=${repJudge}`);
    await expect(page.getByTestId('inspector-status-badge')).toHaveText('JUDGE ERROR', { timeout: 15000 });
    const card = page.getByTestId('run-failure-card').first();
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute('data-stage', 'judge');
    await expect(card).toContainText('Judge could not produce a verdict');
    await expect(card.getByTestId('run-failure-cause')).toContainText('no parseable verdict');
    await expect(card.getByTestId('run-failure-raw-toggle')).toContainText('model returned an empty response');
    await expect(card).toContainText('Attempts');
    await expect(card).toContainText('2');
    await expect(card).toContainText('Retry judgement');
  });

  test('standalone run detail page renders the agent-error card (not an empty output tab)', async ({ page }) => {
    test.skip(!seeded, 'Could not seed run (storage unavailable)');
    await page.goto(`/runs/${repAgent}`);
    const card = page.getByTestId('run-failure-card').first();
    await expect(card).toBeVisible({ timeout: 15000 });
    await expect(card).toHaveAttribute('data-stage', 'agent');
    await expect(card.getByTestId('run-failure-cause')).toContainText('UND_ERR_HEADERS_TIMEOUT');
    await expect(page.getByTestId('status-label').first()).toHaveText('AGENT ERROR');
    await expect(page.getByText('Failed to fetch traces')).toHaveCount(0);
  });
});
