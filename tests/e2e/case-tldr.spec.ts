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
 * Hybrid design: ASKED and AGENT are deterministic and render on first paint;
 * the VERDICT label is deterministic too and only its REASON is model-written
 * (fetched lazily; unjudged runs never call the model).
 *
 * Real-shaped fixture: one evaluation run with FIVE cases — a pass, a fail, a
 * judge error, an agent error, and a second case with the SAME NAME as the
 * pass (the card must key on the selected report, not the name). Scenarios:
 *
 *   1. held request  → Asked/Agent already visible, verdict row shows the
 *      deterministic sentence greyed as "writing the reason…" (never blocks the
 *      page); then the model reason renders with the "AI verdict" badge.
 *   2. identical names → switching rows shows THAT report's own text.
 *   3. regenerate     → sends force:true and re-renders.
 *   4. real route, no model → "Field summary" badge + honest note for a judged
 *      case; the agent-error case never calls the model and reads "Not judged:
 *      the agent request failed — <cause>" (never a verdict, never zeros).
 *   5. request error  → honest note, deterministic verdict stays visible.
 */

import { test, expect } from './fixtures/test-fixtures';
import type { Page, Route } from '@playwright/test';

const STAMP = Date.now();
const RUN_ID = `eval-run-e2e-case-tldr-${STAMP}`;
const RUN_NAME = `E2E Case TLDR ${STAMP}`;
const DUP_NAME = `ahtest-case-tldr-duplicate-name-${STAMP}`;
const AGENT_CAUSE = 'Agent request timed out after 30012ms (timeout 30000ms) — no response headers/body from POST http://agent.example.internal:8000/ask [UND_ERR_HEADERS_TIMEOUT]';

type Seed = {
  tcPass: string; tcDup: string; tcFail: string; tcJudge: string; tcAgent: string;
  repPass: string; repDup: string; repFail: string; repJudge: string; repAgent: string;
};

// What the server returns for a model-written reason: Asked/Agent are the
// deterministic sentences (the card ignores them and renders its own copy),
// the verdict carries the computed label + the model's reason.
const llmSummary = (reportId: string, verdict: string) => ({
  summary: {
    source: 'llm',
    parts: { asked: 'ignored by the card', agent: 'ignored by the card', verdict },
    model: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
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
    if (!tcPass || !tcDup || !tcFail || !tcJudge || !tcAgent) return;
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
    if (!repPass || !repDup || !repFail || !repJudge || !repAgent) return;

    const runRes = await request.put(`/api/storage/evaluation-runs/${RUN_ID}`, {
      data: {
        id: RUN_ID, name: RUN_NAME, status: 'completed', docType: 'evaluation-run',
        agentKey: 'example-rest-agent', modelId: 'demo-model', judgeModelId: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
        sources: [{ type: 'test-case-ids', ids: [tcPass, tcDup, tcFail, tcJudge, tcAgent] }], trigger: 'api',
        testCaseSnapshots: [
          { id: tcPass, version: 1, name: DUP_NAME },
          { id: tcDup, version: 1, name: DUP_NAME },
          { id: tcFail, version: 1, name: 'pool exhaustion case' },
          { id: tcJudge, version: 1, name: 'postmortem summary case' },
          { id: tcAgent, version: 1, name: 'restarting pods case' },
        ],
        results: {
          [tcPass]: { reportId: repPass, status: 'completed', passFailStatus: 'passed' },
          [tcDup]: { reportId: repDup, status: 'completed', passFailStatus: 'passed' },
          [tcFail]: { reportId: repFail, status: 'failed', passFailStatus: 'failed' },
          [tcJudge]: { reportId: repJudge, status: 'completed' },
          [tcAgent]: { reportId: repAgent, status: 'completed' },
        },
        stats: { passed: 2, failed: 1, errored: 2, pending: 0, total: 5 },
        createdAt: new Date().toISOString(), completedAt: new Date().toISOString(),
      },
    });
    if (runRes.ok()) seed = { tcPass, tcDup, tcFail, tcJudge, tcAgent, repPass, repDup, repFail, repJudge, repAgent };
  });

  test.afterAll(async ({ request }) => {
    await request.delete(`/api/storage/evaluation-runs/${RUN_ID}`).catch(() => {});
    for (const id of created.reps) await request.delete(`/api/storage/runs/${id}`).catch(() => {});
    for (const id of created.tcs) await request.delete(`/api/storage/test-cases/${id}`).catch(() => {});
  });

  const card = (page: Page) => page.getByTestId('case-tldr');
  const reportIdOf = (route: Route) => decodeURIComponent(route.request().url().match(/\/runs\/([^/]+)\/summary/)![1]);

  test('held request → Asked/Agent instant, verdict greyed as writing; then the model reason renders with the AI badge', async ({ page }) => {
    test.skip(!seed, 'Could not seed run (storage unavailable)');
    const s = seed!;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    await page.route('**/api/storage/runs/*/summary', async (route) => {
      await gate; // hold the request: the page must not block on it
      await route.fulfill({ json: llmSummary(reportIdOf(route), 'Judge verdict: PASSED (score 90%) — both expected outcomes were met, with only the exact start time missing.') });
    });

    await page.goto(`/evaluations/runs/${RUN_ID}/inspect?reportId=${s.repPass}`);
    await expect(card(page)).toBeVisible({ timeout: 30000 });
    await expect(card(page)).toHaveAttribute('data-state', 'loading');
    // Deterministic rows are there before any request returns.
    await expect(page.getByTestId('case-tldr-asked')).toContainText('The test asks: “Checkout returns HTTP 500 for 2% of requests since the 14:00 deploy. Find the root cause.” It has 2 expected outcomes');
    await expect(page.getByTestId('case-tldr-agent')).toContainText('Example ops agent used the tool search_logs and answered: “Root cause: build 8812 introduced a null dereference in DiscountCodeHandler.');
    // Verdict row: the deterministic label is already visible, marked as still writing.
    await expect(page.getByTestId('case-tldr-verdict')).toHaveAttribute('data-writing', 'true');
    await expect(page.getByTestId('case-tldr-verdict')).toContainText('Judge verdict: PASSED (score 90%)');
    await expect(page.getByTestId('case-tldr-skeleton')).toContainText('writing the reason…');
    // The rest of the inspector is usable meanwhile.
    await expect(page.getByTestId('inspector-status-badge')).toHaveText('PASSED');
    await expect(page.getByText('Test Case Definition')).toBeVisible();

    release();
    await expect(card(page)).toHaveAttribute('data-state', 'ready', { timeout: 10000 });
    await expect(card(page)).toHaveAttribute('data-source', 'llm');
    await expect(page.getByTestId('case-tldr-source')).toContainText('AI reason');
    await expect(page.getByTestId('case-tldr-source')).toContainText('claude-sonnet-4-5');
    await expect(page.getByTestId('case-tldr-verdict')).toHaveText('Judge verdict: PASSED (score 90%) — both expected outcomes were met, with only the exact start time missing.');
    await expect(page.getByTestId('case-tldr-verdict')).toHaveClass(/text-green/);
    await expect(page.getByTestId('case-tldr-verdict')).not.toHaveAttribute('data-writing', 'true');
    await expect(page.getByTestId('case-tldr-fallback-note')).toHaveCount(0);
    // The card sits ABOVE the Test Case Definition header.
    const cardBox = await card(page).boundingBox();
    const defBox = await page.getByText('Test Case Definition').boundingBox();
    expect(cardBox!.y).toBeLessThan(defBox!.y);
  });

  test('two cases with the same name: switching rows shows the selected report\'s own text', async ({ page }) => {
    test.skip(!seed, 'Could not seed run (storage unavailable)');
    const s = seed!;
    const requested: string[] = [];
    await page.route('**/api/storage/runs/*/summary', async (route) => {
      const id = reportIdOf(route);
      requested.push(id);
      await route.fulfill({ json: llmSummary(id, `Judge verdict: PASSED — reason for ${id}.`) });
    });

    await page.goto(`/evaluations/runs/${RUN_ID}/inspect?reportId=${s.repPass}`);
    await expect(page.getByTestId('case-tldr-verdict')).toHaveText(`Judge verdict: PASSED — reason for ${s.repPass}.`, { timeout: 15000 });
    await expect(page.getByTestId('case-tldr-asked')).toContainText('Checkout returns HTTP 500');

    // Both rows carry the identical name; click the OTHER one.
    const dupRows = page.locator('[data-testid="test-case-row"]').filter({ hasText: DUP_NAME });
    await expect(dupRows).toHaveCount(2);
    await page.locator(`[data-testid="test-case-row"][data-test-case-id="${s.tcDup}"]`).click();
    await expect(page.getByTestId('case-tldr-verdict')).toHaveText(`Judge verdict: PASSED — reason for ${s.repDup}.`, { timeout: 15000 });
    await expect(page.getByTestId('case-tldr-asked')).toContainText('Why did the nightly report job fail after the 02:00 token rotation?');
    await expect(page.getByTestId('case-tldr-agent')).toContainText('The scheduler token expires at 02:00');
    expect(requested).toContain(s.repPass);
    expect(requested).toContain(s.repDup);
  });

  test('regenerate sends force:true and re-renders; failed verdict is toned red', async ({ page }) => {
    test.skip(!seed, 'Could not seed run (storage unavailable)');
    const s = seed!;
    const bodies: any[] = [];
    let n = 0;
    await page.route('**/api/storage/runs/*/summary', async (route) => {
      bodies.push(route.request().postDataJSON());
      n += 1;
      await route.fulfill({ json: llmSummary(reportIdOf(route), `Judge verdict: FAILED (score 30%) — wrong service named (v${n}).`) });
    });
    await page.goto(`/evaluations/runs/${RUN_ID}/inspect?reportId=${s.repFail}`);
    await expect(card(page)).toHaveAttribute('data-state', 'ready', { timeout: 15000 });
    await expect(page.getByTestId('case-tldr-verdict')).toHaveText(/^Judge verdict: FAILED \(score 30%\) — wrong service named \(v\d+\)\.$/);
    await expect(page.getByTestId('case-tldr-verdict')).toHaveClass(/text-red/);
    const initial = bodies.length;
    expect(initial).toBeGreaterThan(0);
    for (const b of bodies) expect(b).toEqual({ force: false });

    await page.getByTestId('case-tldr-regenerate').click();
    await expect(page.getByTestId('case-tldr-verdict')).toHaveText(`Judge verdict: FAILED (score 30%) — wrong service named (v${initial + 1}).`, { timeout: 15000 });
    expect(bodies).toHaveLength(initial + 1);
    expect(bodies[initial]).toEqual({ force: true });
  });

  test('real route: unjudged cases never call the model; a judged case without model access shows the field-based reason honestly', async ({ page, request }) => {
    test.skip(!seed, 'Could not seed run (storage unavailable)');
    const s = seed!;
    // Agent error: deterministic end to end — no request at all.
    const summaryCalls: string[] = [];
    page.on('request', (r) => { if (r.url().includes('/summary')) summaryCalls.push(r.url()); });
    await page.goto(`/evaluations/runs/${RUN_ID}/inspect?reportId=${s.repAgent}`);
    await expect(card(page)).toHaveAttribute('data-state', 'ready', { timeout: 20000 });
    await expect(card(page)).toHaveAttribute('data-source', 'deterministic');
    await expect(page.getByTestId('case-tldr-asked')).toContainText('List the pods restarting in the payments namespace');
    await expect(page.getByTestId('case-tldr-agent')).toHaveText('Example ops agent produced no output.');
    await expect(page.getByTestId('case-tldr-verdict')).toContainText('Not judged: the agent request failed — Agent request timed out after 30012ms');
    await expect(page.getByTestId('case-tldr-verdict')).not.toContainText(/PASSED|FAILED|score 0/);
    await expect(page.getByTestId('case-tldr-verdict')).toHaveClass(/text-amber/);
    await expect(page.getByTestId('case-tldr-source')).toHaveCount(0);
    await expect(page.getByTestId('case-tldr-regenerate')).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(summaryCalls).toHaveLength(0);

    // Judge error: same honesty, judge stage named, still no model call.
    await page.locator(`[data-testid="test-case-row"][data-test-case-id="${s.tcJudge}"]`).click();
    await expect(page.getByTestId('case-tldr-verdict')).toContainText('Not judged: the judge could not produce a verdict', { timeout: 20000 });
    await expect(page.getByTestId('case-tldr-agent')).toContainText('answered: “The postmortem lists three action items');
    await page.waitForTimeout(300);
    expect(summaryCalls).toHaveLength(0);

    // Failed verdict: the route is called. Without model access it answers with the field-based reason.
    const probe = await request.post(`/api/storage/runs/${s.repFail}/summary`, { data: {} });
    expect(probe.ok()).toBeTruthy();
    const probeBody = await probe.json();
    expect(probeBody.summary.parts.verdict).toMatch(/^Judge verdict: FAILED \(score 30%\) — /);
    test.skip(probeBody.summary.source === 'llm', 'server has model access — fallback rendering is asserted where the model is unavailable (CI)');
    await page.locator(`[data-testid="test-case-row"][data-test-case-id="${s.tcFail}"]`).click();
    await expect(card(page)).toHaveAttribute('data-source', 'fallback', { timeout: 20000 });
    await expect(page.getByTestId('case-tldr-source')).toHaveText(/Field summary/);
    await expect(page.getByTestId('case-tldr-fallback-note')).toContainText('AI reason unavailable');
    await expect(page.getByTestId('case-tldr-verdict')).toContainText('Judge verdict: FAILED (score 30%) — Wrong service: the pool exhaustion comes from the orders service');
  });

  test('request failure → honest note; the deterministic verdict stays visible (no endless skeleton)', async ({ page }) => {
    test.skip(!seed, 'Could not seed run (storage unavailable)');
    const s = seed!;
    await page.route('**/api/storage/runs/*/summary', (route) => route.fulfill({ status: 500, json: { error: 'storage exploded' } }));
    await page.goto(`/evaluations/runs/${RUN_ID}/inspect?reportId=${s.repPass}`);
    await expect(card(page)).toHaveAttribute('data-state', 'error', { timeout: 15000 });
    await expect(page.getByTestId('case-tldr-fallback-note')).toContainText('AI reason unavailable (storage exploded)');
    await expect(page.getByTestId('case-tldr-verdict')).toContainText('Judge verdict: PASSED (score 90%) — The agent traced the 500s to the NullPointerException');
    await expect(page.getByTestId('case-tldr-skeleton')).toHaveCount(0);
    // Regenerate stays available as the retry affordance.
    await expect(page.getByTestId('case-tldr-regenerate')).toBeVisible();
  });
});
