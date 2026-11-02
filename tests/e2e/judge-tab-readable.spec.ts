/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E: "can I tell why it failed in 10 seconds?" — the Judge Evaluation tab
 * and the Test Case Output tab after the owner's report-page feedback.
 *
 * Fixture shapes copied from a real code-SDK run (names/ids synthetic):
 *   A. cost/latency case — one passed check, one failed check whose author
 *      message carries `k=v (bar ≤ N)` pairs, plus the runner's "Test body
 *      did not complete" marker. Answer is Markdown with a JSON fence.
 *   B. judge-with-sections case — an LLM judge FAIL whose reasoning has
 *      **Heading:** sections, next to a passed deterministic check.
 *   C. agent error — no answer, not judged.
 *
 * Asserts the rendered result only (no source regexes):
 *   1. Judge tab headline: "FAILED — <label>: totalTokens 339,809 vs ≤ 60,000 · time 92.3 s vs ≤ 30 s"
 *      + "Decided by 2 code checks … 1 passed, 1 failed, 1 not reached."
 *   2. Check rows: author label as title, measured-vs-limit table with
 *      "5.7× over", chai text only inside the Raw disclosure, compact
 *      "Later checks did not run" row, heading reads "Checks".
 *   3. LLM judge reasoning split into sections (one per heading).
 *   4. Test Case Output: Agent Response first (Markdown rendered, fence present),
 *      Rendered/Raw toggle, Steps collapsed by default and openable.
 *   5. Agent error: "Not judged — the agent request failed" headline and
 *      "No agent response".
 */

import { test, expect } from './fixtures/test-fixtures';

const STAMP = Date.now();
const RUN_ID = `eval-run-e2e-judge-readable-${STAMP}`;
const COST_MSG = 'AGENTIC cost/latency within the fix bar: totalTokens=339809 (bar ≤ 60000), time=92.3 s (bar ≤ 30 s), documents=1 (request f0b3b306-6a28-43a8-83eb-664a3f673091, mode AGENTIC): expected false to equal true';
const NOT_REACHED = 'Test body did not complete: an error was thrown before reaching further matcher calls in source order, so any expect()/judge()/evaluate() calls after that point never executed. If the error came from a failing expect() assertion (not a bug elsewhere in the test body), expect.soft(...) records instead of throwing so later matchers still run (see docs/SDK.md "Always-record guarantee").';
const ANSWER_MD = 'The provided documents do not answer the question directly [1][2].\n\n- **Finding 1**: the scheduler token expires at 02:00\n- **Finding 2**: no retry is configured\n\n```json\n{"requestId": "f0b3b306", "retrievalMode": "AGENTIC", "documents": 1}\n```';
const JUDGE_REASONING = '**Fact Precision Analysis:**\nThe agent returned only 2 records when 10 were required. Fact precision 10/100.\n\n**Provenance Verifiability:**\nOnly one expected id appears. Capping at 50.\n\n**Summary:**\nCritical failure: the agent returned only 2 records when the benchmark requires at least 10.';
const AGENT_CAUSE = 'HTTP_500 — endpoint rejected the request with HTTP 500 while calling the agent endpoint: {"message":"Search is temporarily unavailable. Please retry."}';

test.describe('Judge Evaluation + Test Case Output — readable failure', () => {
  const created = { tcs: [] as string[], reps: [] as string[] };
  let seed: { tcCost: string; tcJudge: string; tcAgent: string; repCost: string; repJudge: string; repAgent: string } | null = null;

  test.beforeAll(async ({ request }) => {
    const mkTc = async (name: string, prompt: string) => {
      const r = await request.post('/api/storage/test-cases', { data: { name, category: 'Test', difficulty: 'Easy', initialPrompt: prompt, expectedOutcomes: ['Answers within budget'] } });
      if (!r.ok()) return null;
      const b = await r.json(); const id = (b.id || b.testCase?.id || null) as string | null; if (id) created.tcs.push(id); return id;
    };
    const tcCost = await mkTc(`ahtest-judge-readable-cost-${STAMP}`, 'One-document question: when does the scheduler token expire?');
    const tcJudge = await mkTc(`ahtest-judge-readable-judge-${STAMP}`, 'List unisex running apparel.');
    const tcAgent = await mkTc(`ahtest-judge-readable-agent-${STAMP}`, 'Plain topic query.');
    if (!tcCost || !tcJudge || !tcAgent) return;
    const base = { agentName: 'Example search agent', agentKey: 'example-rest-agent', modelName: 'demo-model', modelId: 'demo-model', connectorProtocol: 'rest' };
    const mkRep = async (data: Record<string, unknown>) => {
      const r = await request.post('/api/storage/runs', { data }); if (!r.ok()) return null;
      const b = await r.json(); const id = (b.id || null) as string | null; if (id) created.reps.push(id); return id;
    };
    const repCost = await mkRep({
      ...base, testCaseId: tcCost, status: 'completed', metricsStatus: 'completed', passFailStatus: 'failed', judgeProvider: 'none', judgeModelId: 'agent-trace-judge',
      trajectory: [
        { id: 's1', type: 'action', toolName: 'search', toolArgs: { q: 'scheduler token' }, content: 'search({"q":"scheduler token"})', timestamp: 1 },
        { id: 's2', type: 'tool_result', content: '{"documents":[{"id":"doc-1"}]}', timestamp: 2 },
        { id: 's3', type: 'response', content: ANSWER_MD, timestamp: 3 },
      ],
      matcherResults: [
        { description: '[ Array(1) ] to be empty', pass: true, method: 'code-assertion', actual: ['doc-1'] },
        { description: 'false to equal true', pass: false, method: 'code-assertion', expected: true, actual: false, errorMessage: COST_MSG },
        { description: NOT_REACHED, pass: false, method: 'code-assertion', notReached: true, errorMessage: COST_MSG },
      ],
      llmJudgeReasoning: '', metrics: { accuracy: 0, faithfulness: 0, latency_score: 0, trajectory_alignment_score: 0 },
    });
    const repJudge = await mkRep({
      ...base, testCaseId: tcJudge, status: 'completed', metricsStatus: 'completed', passFailStatus: 'failed', judgeModelId: 'claude-sonnet-4.6',
      trajectory: [{ id: 's1', type: 'response', content: '2 record(s):\n- id ST101452 · running shorts\n- id ST101601 · running shorts', timestamp: 1 }],
      matcherResults: [
        { description: 'evaluate: recall_cap@10', pass: false, method: 'evaluator', reasoning: 'recall_cap@10 = 2/min(10, 108) = 0.20 (pass at ≥ 0.8).', errorMessage: 'recall_cap@10 = 2/min(10, 108) = 0.20 (pass at ≥ 0.8).' },
        { description: 'evaluate: hit@1', pass: true, method: 'evaluator', reasoning: 'Hit@1 = 1: first gold at rank 1.' },
        { description: 'judge: 3 claims', pass: false, method: 'llm-judge', model: 'claude-sonnet-4.6', score: 0.42, reasoning: JUDGE_REASONING },
      ],
      llmJudgeReasoning: JUDGE_REASONING, metrics: { accuracy: 42, faithfulness: 40, latency_score: 90, trajectory_alignment_score: 40 },
    });
    const repAgent = await mkRep({
      ...base, testCaseId: tcAgent, status: 'failed', metricsStatus: 'error', failureStage: 'agent', passFailStatus: null, trajectory: [], rawEvents: [],
      error: AGENT_CAUSE, agentError: { kind: 'transport', code: 'HTTP_500', message: AGENT_CAUSE, elapsedMs: 270_230, endpoint: 'http://agent.example.internal/ask', timeoutMs: 300_000, httpStatus: 500 },
      traceError: `Agent request failed (kind=agent_failed): ${AGENT_CAUSE}`, llmJudgeReasoning: '**Agent run did not complete.**',
      metrics: { accuracy: 0, faithfulness: 0, latency_score: 0, trajectory_alignment_score: 0 },
    });
    if (!repCost || !repJudge || !repAgent) return;
    const run = await request.put(`/api/storage/evaluation-runs/${RUN_ID}`, {
      data: {
        id: RUN_ID, name: `E2E Judge Readable ${STAMP}`, status: 'completed', docType: 'evaluation-run', agentKey: 'example-rest-agent', modelId: 'demo-model',
        sources: [{ type: 'test-case-ids', ids: [tcCost, tcJudge, tcAgent] }], trigger: 'api',
        testCaseSnapshots: [{ id: tcCost, version: 1, name: 'cost case' }, { id: tcJudge, version: 1, name: 'judge case' }, { id: tcAgent, version: 1, name: 'agent case' }],
        results: { [tcCost]: { reportId: repCost, status: 'failed', passFailStatus: 'failed' }, [tcJudge]: { reportId: repJudge, status: 'failed', passFailStatus: 'failed' }, [tcAgent]: { reportId: repAgent, status: 'completed' } },
        stats: { passed: 0, failed: 2, errored: 1, pending: 0, total: 3 }, createdAt: new Date().toISOString(), completedAt: new Date().toISOString(),
      },
    });
    if (run.ok()) seed = { tcCost, tcJudge, tcAgent, repCost, repJudge, repAgent };
  });

  test.afterAll(async ({ request }) => {
    await request.delete(`/api/storage/evaluation-runs/${RUN_ID}`).catch(() => {});
    for (const id of created.reps) await request.delete(`/api/storage/runs/${id}`).catch(() => {});
    for (const id of created.tcs) await request.delete(`/api/storage/test-cases/${id}`).catch(() => {});
  });

  // The TL;DR card calls the summary route; keep it deterministic and quiet here.
  const quietTldr = (page: import('@playwright/test').Page) => page.route('**/api/storage/runs/*/summary', r => r.fulfill({ json: { cached: true, summary: { source: 'fallback', parts: { asked: 'a', agent: 'b', verdict: 'c' }, generatedAt: new Date().toISOString(), inputsHash: 'x', error: 'test' } } }));

  test('Judge tab: headline says what failed with measured vs limit; checks are readable; chai text is behind Raw', async ({ page }) => {
    test.skip(!seed, 'Could not seed run (storage unavailable)');
    await quietTldr(page);
    await page.goto(`/evaluations/runs/${RUN_ID}/inspect?reportId=${seed!.repCost}`);
    await page.getByRole('tab', { name: /Judge Evaluation/ }).click();

    const headline = page.getByTestId('judgement-headline');
    await expect(headline).toBeVisible({ timeout: 15000 });
    await expect(headline).toHaveAttribute('data-tone', 'failed');
    await expect(page.getByTestId('judgement-headline-title')).toHaveText('FAILED — AGENTIC cost/latency within the fix bar: totalTokens 339,809 vs ≤ 60,000 · time 92.3 s vs ≤ 30 s');
    await expect(page.getByTestId('judgement-headline-how')).toHaveText('Decided by 2 code checks written in the test (no LLM judge): 1 passed, 1 failed, 1 not reached.');

    await expect(page.getByTestId('checks-heading')).toContainText('Checks');
    await expect(page.getByTestId('checks-heading')).toContainText('1/2 passed, 1 failed, 1 not reached');
    // Failed row: author label as the title; the chai text is not a visible title anywhere.
    const titles = page.getByTestId('check-title');
    await expect(titles).toHaveCount(2);
    await expect(titles.nth(1)).toHaveText('AGENTIC cost/latency within the fix bar');
    await expect(page.getByText('false to equal true', { exact: true })).toBeHidden(); // only inside the collapsed Raw disclosure
    // Measured vs limit table, open by default for the failed check.
    const table = page.getByTestId('check-measurements');
    await expect(table).toBeVisible();
    await expect(table.locator('tr').nth(0)).toContainText('totalTokens');
    await expect(table.locator('tr').nth(0)).toContainText('339,809');
    await expect(table.locator('tr').nth(0)).toContainText('✕ limit ≤ 60,000');
    await expect(table.locator('tr').nth(0)).toContainText('5.7× over');
    await expect(table.locator('tr').nth(1)).toContainText('92.3 s');
    await expect(table.locator('tr').nth(1)).toContainText('3.1× over');
    await expect(table.locator('tr').nth(2)).toContainText('documents');
    await expect(page.getByTestId('check-context')).toContainText('request f0b3b306-6a28-43a8-83eb-664a3f673091, mode AGENTIC');
    // Raw assertion is there, collapsed, and reveals the chai text.
    const raw = page.getByTestId('check-raw');
    await expect(raw).toBeVisible();
    await raw.locator('summary').click();
    await expect(raw).toContainText('false to equal true');
    await expect(raw).toContainText('expected false to equal true');
    // Not-reached marker: compact row, long paragraph only in its disclosure.
    const nr = page.getByTestId('check-not-reached');
    await expect(nr).toContainText('Later checks did not run');
    await expect(nr).toContainText('expect.soft(...)');
    await expect(nr.getByText('Test body did not complete', { exact: false })).toBeHidden();
  });

  test('Judge tab: LLM judge reasoning is split into sections; headline carries the judge summary', async ({ page }) => {
    test.skip(!seed, 'Could not seed run (storage unavailable)');
    await quietTldr(page);
    await page.goto(`/evaluations/runs/${RUN_ID}/inspect?reportId=${seed!.repJudge}`);
    await page.getByRole('tab', { name: /Judge Evaluation/ }).click();
    await expect(page.getByTestId('judgement-headline-title')).toContainText('FAILED — evaluate: recall_cap@10: recall_cap@10 = 2/min(10, 108) = 0.20 (pass at ≥ 0.8)', { timeout: 15000 });
    await expect(page.getByTestId('judgement-headline-title')).toContainText('judge: Critical failure: the agent returned only 2 records when the benchmark requires at least 10');
    await expect(page.getByTestId('judgement-headline-how')).toHaveText('Decided by 3 checks — 2 deterministic + 1 LLM judge: 1 passed, 2 failed.');
    const sections = page.getByTestId('judge-reasoning-section');
    await expect(sections).toHaveCount(3);
    await expect(sections.nth(0).locator('summary')).toHaveText('Fact Precision');
    await expect(sections.nth(1).locator('summary')).toHaveText('Provenance Verifiability');
    await expect(sections.nth(2).locator('summary')).toHaveText('Summary');
    // The Summary section is open by default; the others collapsed.
    await expect(sections.nth(2)).toContainText('Critical failure');
    await expect(sections.nth(1).getByText('Capping at 50', { exact: false })).toBeHidden();
  });

  test('Test Case Output: Agent Response first as Markdown with Rendered/Raw, steps collapsed below', async ({ page }) => {
    test.skip(!seed, 'Could not seed run (storage unavailable)');
    await quietTldr(page);
    await page.goto(`/evaluations/runs/${RUN_ID}/inspect?reportId=${seed!.repCost}`);
    const answer = page.getByTestId('final-answer');
    await expect(answer).toBeVisible({ timeout: 15000 });
    await expect(answer).toHaveAttribute('data-has-answer', 'true');
    await expect(answer.locator('h4')).toContainText('Agent Response');
    const body = page.getByTestId('final-answer-body');
    await expect(body).toHaveAttribute('data-view', 'rendered');
    // Markdown really rendered: a <strong>, a list, and a code block — not literal `**`.
    await expect(body.locator('strong').first()).toHaveText('Finding 1');
    await expect(body.locator('li')).toHaveCount(2);
    await expect(body.locator('pre code')).toContainText('"retrievalMode": "AGENTIC"');
    await expect(body).not.toContainText('**Finding 1**');
    // Answer appears ABOVE the steps toggle; steps are collapsed by default.
    const steps = page.getByTestId('steps-toggle');
    await expect(steps).toContainText('3 steps');
    await expect(page.getByTestId('steps-body')).toHaveCount(0);
    const a = await answer.boundingBox(); const s = await steps.boundingBox();
    expect(a!.y).toBeLessThan(s!.y);
    await steps.click();
    await expect(page.getByTestId('steps-body')).toBeVisible();
    await expect(page.getByTestId('steps-body')).toContainText('action · search');
    // Raw shows the exact string.
    await page.getByTestId('answer-view-raw').click();
    await expect(body).toHaveAttribute('data-view', 'raw');
    await expect(body).toContainText('**Finding 1**');
  });

  test('Agent error: Judge tab says Not judged; Test Case Output says no agent response', async ({ page }) => {
    test.skip(!seed, 'Could not seed run (storage unavailable)');
    await quietTldr(page);
    await page.goto(`/evaluations/runs/${RUN_ID}/inspect?reportId=${seed!.repAgent}`);
    await expect(page.getByTestId('final-answer-none')).toContainText('No agent response', { timeout: 15000 });
    await page.getByRole('tab', { name: /Judge Evaluation/ }).click();
    await expect(page.getByTestId('judgement-headline')).toHaveAttribute('data-tone', 'errored');
    await expect(page.getByTestId('judgement-headline-title')).toHaveText('Not judged — the agent request failed');
    await expect(page.getByTestId('judgement-headline-how')).toContainText('HTTP_500 — endpoint rejected the request');
    await expect(page.getByTestId('judgement-headline-how')).not.toContainText(/score 0/);
  });
});
