/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E: the case TL;DR card above the Test Case Definition in the run inspector.
 *
 * Owner ask: "for every test case definition there should be a summary above
 * the test explaining what the test is about, how the response was — a TL;DR
 * in 2–3 sentences all the way to the output and the judgment."
 *
 * #618: viewing a run page must NOT call a model. All three sentences
 * (Asked / Agent / Verdict) are deterministic and render on first paint; a
 * model-written summary is a separate labelled row the user asks for with
 * the card's Summarize button, and a summary already persisted on the report
 * is shown from the report itself. Every scenario below records the page's
 * requests and asserts how many `/summary` calls left the browser.
 *
 * Real-shaped fixture: one evaluation run with SEVEN cases — a pass, a fail,
 * a judge error, an agent error, a second case with the SAME NAME as the pass
 * (the card must key on the selected report, not the name), a
 * deterministic-only case (code checks, no judge), and a fail case reserved
 * for the real-route scenario. Scenarios:
 *
 *   1. page view        → ZERO summary requests; deterministic verdict;
 *      Summarize button. Click → exactly ONE request (generate:true); the AI
 *      summary renders as its own row labelled with the model id; Regenerate
 *      → one more request with force:true.
 *   2. persisted summary → shown on load, marked cached, ZERO requests.
 *   3. deterministic-only → no button, verdict from the failing check's
 *      errorMessage, ZERO requests. Unjudged (agent / judge error) likewise.
 *   4. identical names → switching rows shows THAT report's own text, still
 *      ZERO requests.
 *   5. real route, no model → honest "Model summary unavailable" note after
 *      a click; the deterministic verdict stays.
 *   6. request error    → honest note + Retry summary, verdict stays.
 */

import { test, expect } from './fixtures/test-fixtures';
import type { Page, Route } from '@playwright/test';

const STAMP = Date.now();
const RUN_ID = `eval-run-e2e-case-tldr-${STAMP}`;
const RUN_NAME = `E2E Case TLDR ${STAMP}`;
const DUP_NAME = `ahtest-case-tldr-duplicate-name-${STAMP}`;
const AGENT_CAUSE = 'Agent request timed out after 30012ms (timeout 30000ms) — no response headers/body from POST http://agent.example.internal:8000/ask [UND_ERR_HEADERS_TIMEOUT]';

type Seed = {
  tcPass: string; tcDup: string; tcFail: string; tcJudge: string; tcAgent: string; tcChecks: string; tcProbe: string;
  repPass: string; repDup: string; repFail: string; repJudge: string; repAgent: string; repChecks: string; repProbe: string;
};
const MODEL = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';
const CHECK_MSG = 'top-3 results must all carry the requested brand: brand_matches=1 (need ≥ 3), documents=3 (request 7f1a, mode AGENTIC): expected false to equal true';

// What the server returns for a model-written reason: Asked/Agent are the
// deterministic sentences (the card ignores them and renders its own copy),
// the verdict carries the computed label + the model's reason.
const llmSummary = (reportId: string, verdict: string) => ({
  summary: {
    source: 'llm',
    parts: { asked: 'ignored by the card', agent: 'ignored by the card', verdict },
    reason: verdict.includes(' — ') ? verdict.slice(verdict.indexOf(' — ') + 3) : verdict,
    model: MODEL,
    generatedAt: new Date().toISOString(),
    inputsHash: `hash-${reportId.slice(-6)}`,
  },
  cached: false,
});

test.describe('Case TL;DR card — run inspector', () => {
  let seed: Seed | null = null;
  const created = { tcs: [] as string[], reps: [] as string[] };

  test.beforeAll(async ({ request }) => {
    const mkTc = async (name: string, prompt: string, outcomes: string[]) => {
      const r = await request.post('/api/storage/test-cases', {
        data: { name, category: 'Test', difficulty: 'Easy', initialPrompt: prompt, expectedOutcomes: outcomes },
      });
      if (!r.ok()) return null;
      const b = await r.json();
      const id = (b.id || b.testCase?.id || null) as string | null;
      if (id) created.tcs.push(id);
      return id;
    };
    const tcPass = await mkTc(`ahtest-case-tldr-pass-${STAMP}`, 'Checkout returns HTTP 500 for 2% of requests since the 14:00 deploy. Find the root cause.', ['Identifies the null pointer in the discount-code handler', 'Recommends a rollback or hot-fix']);
    const tcDup = await mkTc(DUP_NAME, 'Why did the nightly report job fail after the 02:00 token rotation?', ['Finds the expired scheduler token']);
    const tcFail = await mkTc(`ahtest-case-tldr-fail-${STAMP}`, 'Which service is saturating the database connection pool?', ['Names the orders service as the source of the pool exhaustion']);
    const tcJudge = await mkTc(`ahtest-case-tldr-judge-${STAMP}`, 'Summarise the last incident postmortem.', ['Mentions the three action items']);
    const tcAgent = await mkTc(`ahtest-case-tldr-agent-${STAMP}`, 'List the pods restarting in the payments namespace.', ['Lists the restarting pods']);
    const tcChecks = await mkTc(`ahtest-case-tldr-checks-${STAMP}`, 'Find running shoes from the requested brand under 120.', ['The top 3 results all carry the requested brand']);
    // Used only by the real-route scenario, whose probe may persist a summary on it.
    const tcProbe = await mkTc(`ahtest-case-tldr-probe-${STAMP}`, 'Which service is saturating the database connection pool?', ['Names the orders service as the source of the pool exhaustion']);
    if (!tcPass || !tcDup || !tcFail || !tcJudge || !tcAgent || !tcChecks || !tcProbe) return;
    // Second case with the SAME display name as the pass case → rename tcPass to the dup name too.
    await request.put(`/api/storage/test-cases/${tcPass}`, { data: { name: DUP_NAME } }).catch(() => {});

    const base = { agentName: 'Example ops agent', agentKey: 'example-rest-agent', modelName: 'demo-model', modelId: 'demo-model', connectorProtocol: 'rest', judgeModelId: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', judgeModel: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', evaluatorId: 'ev-persona' };
    const mkRep = async (data: Record<string, unknown>) => {
      const r = await request.post('/api/storage/runs', { data });
      if (!r.ok()) return null;
      const b = await r.json();
      const id = (b.id || b.run?.id || b.report?.id || null) as string | null;
      if (id) created.reps.push(id);
      return id;
    };
    const repPass = await mkRep({
      ...base, testCaseId: tcPass, status: 'completed', metricsStatus: 'ready', passFailStatus: 'passed', score: 0.9,
      trajectory: [
        { id: 's1', type: 'action', toolName: 'search_logs', toolArgs: { q: 'status:500' }, content: 'search_logs({"q":"status:500"})', timestamp: 1 },
        { id: 's2', type: 'tool_result', content: 'NullPointerException in DiscountCodeHandler.apply', timestamp: 2 },
        { id: 's3', type: 'response', content: 'Root cause: build 8812 introduced a null dereference in DiscountCodeHandler. Roll back to 8811 and add a null guard.', timestamp: 3 },
      ],
      llmJudgeReasoning: 'The agent traced the 500s to the NullPointerException introduced by build 8812 and recommended a rollback; both outcomes met.',
      metrics: { accuracy: 92, faithfulness: 90, latency_score: 85, trajectory_alignment_score: 88 },
    });
    const repDup = await mkRep({
      ...base, testCaseId: tcDup, status: 'completed', metricsStatus: 'ready', passFailStatus: 'passed', score: 0.8,
      trajectory: [{ id: 's1', type: 'response', content: 'The scheduler token expires at 02:00; rotate it before the job.', timestamp: 1 }],
      llmJudgeReasoning: 'Found the expired token.',
      metrics: { accuracy: 80, faithfulness: 80, latency_score: 80, trajectory_alignment_score: 80 },
    });
    const repFail = await mkRep({
      ...base, testCaseId: tcFail, status: 'completed', metricsStatus: 'ready', passFailStatus: 'failed', score: 0.3,
      trajectory: [{ id: 's1', type: 'response', content: 'The inventory service is holding the connections.', timestamp: 1 }],
      llmJudgeReasoning: 'Wrong service: the pool exhaustion comes from the orders service, not inventory.',
      metrics: { accuracy: 30, faithfulness: 40, latency_score: 90, trajectory_alignment_score: 30 },
    });
    const repJudge = await mkRep({
      ...base, testCaseId: tcJudge, status: 'completed', metricsStatus: 'error', failureStage: 'judge', passFailStatus: null,
      trajectory: [{ id: 's1', type: 'response', content: 'The postmortem lists three action items: …', timestamp: 1 }],
      error: 'Bedrock Judge evaluation failed after 2 attempts: judge returned no parseable verdict — the model returned an empty response.',
      judgeError: { message: 'judge returned no parseable verdict', rawResponse: '', attempts: 2 },
      traceError: 'Judge evaluation failed (kind=judge_failed): judge returned no parseable verdict',
      llmJudgeReasoning: '**Evaluator could not run.**',
      metrics: { accuracy: 0, faithfulness: 0, latency_score: 0, trajectory_alignment_score: 0 },
    });
    const repAgent = await mkRep({
      ...base, testCaseId: tcAgent, status: 'failed', metricsStatus: 'error', failureStage: 'agent', passFailStatus: null,
      trajectory: [], rawEvents: [],
      error: AGENT_CAUSE,
      agentError: { kind: 'timeout', message: AGENT_CAUSE, elapsedMs: 30_012, endpoint: 'http://agent.example.internal:8000/ask', timeoutMs: 30_000 },
      traceError: `Agent request failed (kind=agent_failed): ${AGENT_CAUSE}`,
      llmJudgeReasoning: `**Agent request failed — not judged.**\n\n**Cause:** ${AGENT_CAUSE}`,
      metrics: { accuracy: 0, faithfulness: 0, latency_score: 0, trajectory_alignment_score: 0 },
    });
    // Deterministic-only: code `expect` checks, no judge at all (judgeModel / evaluatorId null, as in #618).
    const repChecks = await mkRep({
      ...base, judgeModelId: null, judgeModel: null, evaluatorId: null, judgeProvider: 'none',
      testCaseId: tcChecks, status: 'completed', metricsStatus: 'ready', passFailStatus: 'failed', llmJudgeReasoning: '',
      trajectory: [
        { id: 's1', type: 'action', toolName: 'search', toolArgs: { q: 'running shoes' }, content: 'search({"q":"running shoes"})', timestamp: 1 },
        { id: 's2', type: 'response', content: 'Here are three running shoes under 120.', timestamp: 2 },
      ],
      matcherResults: [
        { description: '[ Array(3) ] to have a length of 3', pass: true, method: 'code-assertion' },
        { description: 'false to equal true', pass: false, method: 'code-assertion', errorMessage: CHECK_MSG },
      ],
      metrics: {},
    });
    const repProbe = await mkRep({
      ...base, testCaseId: tcProbe, status: 'completed', metricsStatus: 'ready', passFailStatus: 'failed', score: 0.3,
      trajectory: [{ id: 's1', type: 'response', content: 'The inventory service is holding the connections.', timestamp: 1 }],
      llmJudgeReasoning: 'Wrong service: the pool exhaustion comes from the orders service, not inventory.',
      metrics: { accuracy: 30, faithfulness: 40, latency_score: 90, trajectory_alignment_score: 30 },
    });
    if (!repPass || !repDup || !repFail || !repJudge || !repAgent || !repChecks || !repProbe) return;
    // The pass case already carries a persisted model summary (written by an earlier Summarize click).
    await request.patch(`/api/storage/runs/${repPass}`, { data: { caseSummary: {
      source: 'llm', parts: { asked: 'stored', agent: 'stored', verdict: 'Judge verdict: PASSED (score 90%) — the null dereference was found and a rollback recommended.' },
      reason: 'the null dereference was found and a rollback recommended', model: MODEL, generatedAt: new Date().toISOString(), inputsHash: 'seeded',
    } } });

    const runRes = await request.put(`/api/storage/evaluation-runs/${RUN_ID}`, {
      data: {
        id: RUN_ID, name: RUN_NAME, status: 'completed', docType: 'evaluation-run',
        agentKey: 'example-rest-agent', modelId: 'demo-model', judgeModelId: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
        sources: [{ type: 'test-case-ids', ids: [tcPass, tcDup, tcFail, tcJudge, tcAgent, tcChecks, tcProbe] }], trigger: 'api',
        testCaseSnapshots: [
          { id: tcPass, version: 1, name: DUP_NAME },
          { id: tcDup, version: 1, name: DUP_NAME },
          { id: tcFail, version: 1, name: 'pool exhaustion case' },
          { id: tcJudge, version: 1, name: 'postmortem summary case' },
          { id: tcAgent, version: 1, name: 'restarting pods case' },
          { id: tcChecks, version: 1, name: 'brand filter case (checks only)' },
          { id: tcProbe, version: 1, name: 'pool exhaustion case (real route)' },
        ],
        results: {
          [tcPass]: { reportId: repPass, status: 'completed', passFailStatus: 'passed' },
          [tcDup]: { reportId: repDup, status: 'completed', passFailStatus: 'passed' },
          [tcFail]: { reportId: repFail, status: 'failed', passFailStatus: 'failed' },
          [tcJudge]: { reportId: repJudge, status: 'completed' },
          [tcAgent]: { reportId: repAgent, status: 'completed' },
          [tcChecks]: { reportId: repChecks, status: 'failed', passFailStatus: 'failed' },
          [tcProbe]: { reportId: repProbe, status: 'failed', passFailStatus: 'failed' },
        },
        stats: { passed: 2, failed: 3, errored: 2, pending: 0, total: 7 },
        createdAt: new Date().toISOString(), completedAt: new Date().toISOString(),
      },
    });
    if (runRes.ok()) seed = { tcPass, tcDup, tcFail, tcJudge, tcAgent, tcChecks, tcProbe, repPass, repDup, repFail, repJudge, repAgent, repChecks, repProbe };
  });

  test.afterAll(async ({ request }) => {
    await request.delete(`/api/storage/evaluation-runs/${RUN_ID}`).catch(() => {});
    for (const id of created.reps) await request.delete(`/api/storage/runs/${id}`).catch(() => {});
    for (const id of created.tcs) await request.delete(`/api/storage/test-cases/${id}`).catch(() => {});
  });

  const card = (page: Page) => page.getByTestId('case-tldr');
  const reportIdOf = (route: Route) => decodeURIComponent(route.request().url().match(/\/runs\/([^/]+)\/summary/)![1]);

  /** Every /summary request the page makes, with its body — the proof that viewing calls nothing. */
  const recordSummaryCalls = (page: Page) => {
    const calls: Array<{ url: string; body: any }> = [];
    page.on('request', (r) => { if (/\/api\/storage\/runs\/[^/]+\/summary/.test(r.url())) calls.push({ url: r.url(), body: r.postDataJSON() }); });
    return calls;
  };
  const settle = async (page: Page) => { await page.waitForTimeout(600); };

  test('page view: ZERO summary requests, deterministic verdict, Summarize button; click → ONE request; AI summary is its own row with the model id; Regenerate → force:true', async ({ page }) => {
    test.skip(!seed, 'Could not seed run (storage unavailable)');
    const s = seed!;
    const calls = recordSummaryCalls(page);
    let n = 0;
    await page.route('**/api/storage/runs/*/summary', async (route) => {
      n += 1;
      await route.fulfill({ json: llmSummary(reportIdOf(route), `Judge verdict: FAILED (score 30%) — the agent named the inventory service instead of orders (v${n}).`) });
    });

    await page.goto(`/evaluations/runs/${RUN_ID}/inspect?reportId=${s.repFail}`);
    await expect(card(page)).toBeVisible({ timeout: 30000 });
    await expect(card(page)).toHaveAttribute('data-state', 'idle');
    await expect(card(page)).toHaveAttribute('data-source', 'deterministic');
    await expect(card(page)).toHaveAttribute('data-summarizable', 'true');
    // All three sentences are there, from the report alone.
    await expect(page.getByTestId('case-tldr-asked')).toContainText('The test asks: “Which service is saturating the database connection pool?”');
    await expect(page.getByTestId('case-tldr-agent')).toContainText('Example ops agent answered: “The inventory service is holding the connections.”');
    await expect(page.getByTestId('case-tldr-verdict')).toHaveText('Judge verdict: FAILED (score 30%) — Wrong service: the pool exhaustion comes from the orders service, not inventory.');
    await expect(page.getByTestId('case-tldr-verdict')).toHaveClass(/text-red/);
    await expect(page.getByTestId('case-tldr-summarize')).toHaveText(/Summarize/);
    await expect(page.getByTestId('case-tldr-model-summary')).toHaveCount(0);
    await expect(page.getByTestId('case-tldr-source')).toHaveCount(0);
    // The rest of the inspector is usable; nothing was requested.
    await expect(page.getByTestId('inspector-status-badge')).toHaveText('FAILED');
    await expect(page.getByText('Test Case Definition')).toBeVisible();
    await settle(page);
    expect(calls).toHaveLength(0);

    // Explicit opt-in: exactly one request, force:false.
    await page.getByTestId('case-tldr-summarize').click();
    await expect(card(page)).toHaveAttribute('data-state', 'ready', { timeout: 10000 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain(`/runs/${s.repFail}/summary`);
    expect(calls[0].body).toEqual({ generate: true, force: false });
    // The judge's verdict row is unchanged; the model's text is a separate, labelled row.
    await expect(page.getByTestId('case-tldr-verdict')).toHaveText('Judge verdict: FAILED (score 30%) — Wrong service: the pool exhaustion comes from the orders service, not inventory.');
    await expect(page.getByTestId('case-tldr-model-label')).toContainText('AI summary');
    await expect(page.getByTestId('case-tldr-model-summary')).toContainText('the agent named the inventory service instead of orders (v1).');
    await expect(page.getByTestId('case-tldr-model-attribution')).toContainText(`Model-generated summary by ${MODEL}`);
    await expect(page.getByTestId('case-tldr-model-attribution')).toContainText("not the judge's verdict");
    await expect(page.getByTestId('case-tldr-source')).toContainText('Model summary · claude-sonnet-4-5');
    await expect(card(page)).toHaveAttribute('data-source', 'llm');
    await expect(page.getByTestId('case-tldr-summarize')).toHaveCount(0);
    // The card sits ABOVE the Test Case Definition header.
    const cardBox = await card(page).boundingBox();
    const defBox = await page.getByText('Test Case Definition').boundingBox();
    expect(cardBox!.y).toBeLessThan(defBox!.y);

    await page.getByTestId('case-tldr-regenerate').click();
    await expect(page.getByTestId('case-tldr-model-summary')).toContainText('(v2).', { timeout: 10000 });
    expect(calls).toHaveLength(2);
    expect(calls[1].body).toEqual({ generate: true, force: true });
  });

  test('a summary persisted on the report is shown on load, marked cached — ZERO requests', async ({ page }) => {
    test.skip(!seed, 'Could not seed run (storage unavailable)');
    const s = seed!;
    const calls = recordSummaryCalls(page);
    await page.goto(`/evaluations/runs/${RUN_ID}/inspect?reportId=${s.repPass}`);
    await expect(card(page)).toHaveAttribute('data-state', 'ready', { timeout: 30000 });
    await expect(card(page)).toHaveAttribute('data-source', 'llm');
    await expect(page.getByTestId('case-tldr-verdict')).toContainText('Judge verdict: PASSED (score 90%) — The agent traced the 500s to the NullPointerException');
    await expect(page.getByTestId('case-tldr-model-summary')).toContainText('the null dereference was found and a rollback recommended');
    await expect(page.getByTestId('case-tldr-model-attribution')).toContainText(`Model-generated summary by ${MODEL}`);
    await expect(page.getByTestId('case-tldr-model-attribution')).toContainText('· cached');
    await expect(page.getByTestId('case-tldr-summarize')).toHaveCount(0);
    await expect(page.getByTestId('case-tldr-regenerate')).toBeVisible();
    await settle(page);
    expect(calls).toHaveLength(0);
  });

  test('deterministic-only case (code checks, no judge): no Summarize at all, verdict from the failing check\'s errorMessage — ZERO requests; unjudged cases likewise', async ({ page }) => {
    test.skip(!seed, 'Could not seed run (storage unavailable)');
    const s = seed!;
    const calls = recordSummaryCalls(page);
    await page.goto(`/evaluations/runs/${RUN_ID}/inspect?reportId=${s.repChecks}`);
    await expect(card(page)).toBeVisible({ timeout: 30000 });
    await expect(card(page)).toHaveAttribute('data-summarizable', 'false');
    await expect(card(page)).toHaveAttribute('data-source', 'deterministic');
    await expect(page.getByTestId('case-tldr-asked')).toContainText('Find running shoes from the requested brand under 120.');
    await expect(page.getByTestId('case-tldr-agent')).toContainText('Example ops agent used the tool search and answered: “Here are three running shoes under 120.”');
    // The condition the model summary omitted in #618 is right there, from the check itself.
    await expect(page.getByTestId('case-tldr-verdict')).toHaveText('Verdict: FAILED — 1 of 2 checks failed — top-3 results must all carry the requested brand: brand_matches 1 vs ≥ 3.');
    await expect(page.getByTestId('case-tldr-summarize')).toHaveCount(0);
    await expect(page.getByTestId('case-tldr-regenerate')).toHaveCount(0);
    await expect(page.getByTestId('case-tldr-source')).toHaveCount(0);
    await expect(page.getByTestId('case-tldr-model-summary')).toHaveCount(0);

    // Agent error: deterministic end to end.
    await page.locator(`[data-testid="test-case-row"][data-test-case-id="${s.tcAgent}"]`).click();
    await expect(page.getByTestId('case-tldr-verdict')).toContainText('Not judged: the agent request failed — Agent request timed out after 30012ms', { timeout: 20000 });
    await expect(page.getByTestId('case-tldr-agent')).toHaveText('Example ops agent produced no output.');
    await expect(page.getByTestId('case-tldr-verdict')).not.toContainText(/PASSED|FAILED|score 0/);
    await expect(page.getByTestId('case-tldr-verdict')).toHaveClass(/text-amber/);
    await expect(card(page)).toHaveAttribute('data-summarizable', 'false');
    await expect(page.getByTestId('case-tldr-summarize')).toHaveCount(0);

    // Judge error: same honesty, judge stage named.
    await page.locator(`[data-testid="test-case-row"][data-test-case-id="${s.tcJudge}"]`).click();
    await expect(page.getByTestId('case-tldr-verdict')).toContainText('Not judged: the judge could not produce a verdict', { timeout: 20000 });
    await expect(page.getByTestId('case-tldr-agent')).toContainText('answered: “The postmortem lists three action items');
    await expect(page.getByTestId('case-tldr-summarize')).toHaveCount(0);
    await settle(page);
    expect(calls).toHaveLength(0);
  });

  test('two cases with the same name: switching rows shows the selected report\'s own text, never the other\'s summary — ZERO requests', async ({ page }) => {
    test.skip(!seed, 'Could not seed run (storage unavailable)');
    const s = seed!;
    const calls = recordSummaryCalls(page);
    await page.goto(`/evaluations/runs/${RUN_ID}/inspect?reportId=${s.repPass}`);
    await expect(page.getByTestId('case-tldr-model-summary')).toContainText('the null dereference was found', { timeout: 30000 });
    await expect(page.getByTestId('case-tldr-asked')).toContainText('Checkout returns HTTP 500');

    // Both rows carry the identical name; click the OTHER one.
    const dupRows = page.locator('[data-testid="test-case-row"]').filter({ hasText: DUP_NAME });
    await expect(dupRows).toHaveCount(2);
    await page.locator(`[data-testid="test-case-row"][data-test-case-id="${s.tcDup}"]`).click();
    await expect(page.getByTestId('case-tldr-asked')).toContainText('Why did the nightly report job fail after the 02:00 token rotation?', { timeout: 15000 });
    await expect(page.getByTestId('case-tldr-agent')).toContainText('The scheduler token expires at 02:00');
    await expect(page.getByTestId('case-tldr-verdict')).toHaveText('Judge verdict: PASSED (score 80%) — Found the expired token.');
    // No persisted summary on this report: nothing of the first report's leaks over, and Summarize waits for a click.
    await expect(page.getByTestId('case-tldr-model-summary')).toHaveCount(0);
    await expect(card(page)).toHaveAttribute('data-state', 'idle');
    await expect(page.getByTestId('case-tldr-summarize')).toBeVisible();
    await settle(page);
    expect(calls).toHaveLength(0);
  });

  test('real route: Summarize on a judged case without model access shows the honest note; the deterministic verdict stays', async ({ page, request }) => {
    test.skip(!seed, 'Could not seed run (storage unavailable)');
    const s = seed!;
    const probe = await request.post(`/api/storage/runs/${s.repProbe}/summary`, { data: { generate: true } });
    expect(probe.ok()).toBeTruthy();
    const probeBody = await probe.json();
    expect(probeBody.summary.parts.verdict).toMatch(/^Judge verdict: FAILED \(score 30%\) — /);
    test.skip(probeBody.summary.source === 'llm', 'server has model access — fallback rendering is asserted where the model is unavailable (CI)');
    const calls = recordSummaryCalls(page);
    await page.goto(`/evaluations/runs/${RUN_ID}/inspect?reportId=${s.repProbe}`);
    await expect(page.getByTestId('case-tldr-summarize')).toBeVisible({ timeout: 30000 });
    await page.getByTestId('case-tldr-summarize').click();
    await expect(card(page)).toHaveAttribute('data-state', 'ready', { timeout: 60000 });
    await expect(card(page)).toHaveAttribute('data-source', 'deterministic');
    await expect(page.getByTestId('case-tldr-fallback-note')).toContainText('Model summary unavailable');
    await expect(page.getByTestId('case-tldr-verdict')).toContainText('Judge verdict: FAILED (score 30%) — Wrong service: the pool exhaustion comes from the orders service');
    await expect(page.getByTestId('case-tldr-model-summary')).toHaveCount(0);
    await expect(page.getByTestId('case-tldr-summarize')).toHaveText(/Retry summary/);
    expect(calls).toHaveLength(1);
  });

  test('request failure → honest note + Retry summary; the deterministic verdict stays visible', async ({ page }) => {
    test.skip(!seed, 'Could not seed run (storage unavailable)');
    const s = seed!;
    await page.route('**/api/storage/runs/*/summary', (route) => route.fulfill({ status: 500, json: { error: 'storage exploded' } }));
    await page.goto(`/evaluations/runs/${RUN_ID}/inspect?reportId=${s.repDup}`);
    await expect(page.getByTestId('case-tldr-summarize')).toBeVisible({ timeout: 30000 });
    await page.getByTestId('case-tldr-summarize').click();
    await expect(card(page)).toHaveAttribute('data-state', 'error', { timeout: 15000 });
    await expect(page.getByTestId('case-tldr-fallback-note')).toContainText('Model summary unavailable (storage exploded)');
    await expect(page.getByTestId('case-tldr-verdict')).toHaveText('Judge verdict: PASSED (score 80%) — Found the expired token.');
    await expect(page.getByTestId('case-tldr-skeleton')).toHaveCount(0);
    await expect(page.getByTestId('case-tldr-summarize')).toHaveText(/Retry summary/);
  });
});
