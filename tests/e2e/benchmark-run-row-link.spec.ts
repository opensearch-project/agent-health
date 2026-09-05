/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E regression test for the "Claude Code run row not clickable on the
 * benchmark runs page" bug (see components/evals3/RunInspectorPage.tsx).
 *
 * Root cause: `benchmark.runs[]` is only populated once a run-first
 * evaluation-run document reaches a TERMINAL state
 * (`linkCompletedRunToBenchmark` only runs on the success path of
 * `executeEvaluationRun` in server/routes/storage/evaluationRuns.ts). A
 * still-running (or, as reproduced deterministically here, a run whose
 * agent lookup failed near-instantly) evaluation-run tied to a benchmark
 * therefore has NO entry in `benchmark.runs[]`, even though it exists as a
 * standalone document. `RunInspectorPage.tsx`'s benchmark-mode loader used
 * to look ONLY inside `benchmark.runs[]` and silently `navigate()` back to
 * the runs list the instant that lookup came up empty — from the user's
 * perspective, landing on (or clicking into) that run's inspect URL did
 * nothing.
 *
 * NOTE on how this URL is reached today vs. after this fix lands: the
 * production benchmark runs list (components/evals3/BenchmarkRunsPage.tsx,
 * on `main-goyamegh`) already unions `benchmark.runs[]` with standalone
 * evaluation-run docs via `listEvaluationRuns({ benchmarkId })`, so a
 * not-yet-linked run's row renders and links to exactly this URL — that's
 * the real bug the owner saw live. That union is itself NOT YET on
 * `origin/main` (this branch's base) as of this fix, so there is currently
 * no row on `origin/main`'s runs list that constructs this URL for an
 * unlinked run. This test therefore drives the URL directly (`page.goto`)
 * rather than clicking a list row — it exercises the exact same
 * `RunInspectorPage.tsx` code path this fix changes, real browser
 * rendering included, independent of that separate (already fixed
 * elsewhere) list-union gap.
 *
 * Title locator: standalone evaluation-run docs render their name through
 * the inline-rename field (`run-inspector-rename-text`, PR #460) rather than
 * a plain <h2> — only legacy benchmark-embedded runs (no rename endpoint)
 * still get the <h2>. This run IS a standalone doc, so the rename field is
 * the correct "the inspector rendered THIS run" signal.
 */

import { test, expect } from './fixtures/test-fixtures';
import { createTestDataTracker, uniqueTestName } from '../helpers/testDataTracker';

test.describe('Benchmark run row link — mid-run / not-yet-linked runs are clickable', () => {
  const tracker = createTestDataTracker();
  let benchmarkId: string | null = null;
  let testCaseId: string | null = null;
  let runId: string | null = null;
  const RUN_NAME = uniqueTestName('run-first-inflight');

  test.beforeAll(async ({ request }) => {
    const tcRes = await request.post('/api/storage/test-cases', {
      data: {
        name: uniqueTestName('cc-row-link-tc'),
        initialPrompt: 'What is 2+2?',
        expectedOutcomes: ['Agent responds with 4'],
      },
    });
    test.skip(!tcRes.ok(), 'Could not create test case');
    const tcData = await tcRes.json();
    testCaseId = tcData.id || tcData.testCase?.id;
    tracker.testCase(testCaseId);

    const bmRes = await request.post('/api/storage/benchmarks', {
      data: {
        name: uniqueTestName('cc-row-link-benchmark'),
        description: 'e2e: not-yet-linked run row must still be clickable',
        testCaseIds: testCaseId ? [testCaseId] : [],
      },
    });
    test.skip(!bmRes.ok(), 'Could not create benchmark');
    const bmData = await bmRes.json();
    benchmarkId = bmData.id || bmData.benchmark?.id;
    tracker.benchmark(benchmarkId);

    // Deliberately unresolvable agentKey: the server validates `sources` /
    // `agentKey` presence, persists the evaluation-run doc (status
    // 'running'), THEN resolves the agent — which throws synchronously
    // ("Agent not found") before any network/model call. The run doc is
    // updated to 'failed' and the SSE stream ends within milliseconds, no
    // sleeps involved. Crucially, `benchmark.runs[]` is only ever appended
    // to on the SUCCESS path, so this run stays a standalone,
    // never-embedded evaluation-run document — exactly the shape of a
    // still-running run before this fix, without any timing race.
    const runRes = await request.post('/api/storage/evaluation-runs', {
      data: {
        sources: [{ type: 'benchmark', benchmarkId }],
        benchmarkId,
        agentKey: 'e2e-cc-row-link-nonexistent-agent',
        modelId: 'irrelevant',
        name: RUN_NAME,
        trigger: 'ui',
      },
    });
    test.skip(!runRes.ok(), 'Could not create evaluation run');
    const body = await runRes.text();
    const startedMatch = body.match(/event: started\ndata: (\{.*\})/);
    if (startedMatch) {
      try {
        runId = JSON.parse(startedMatch[1]).runId || null;
      } catch { /* fall through to null */ }
    }
    if (runId) tracker.evaluationRun(runId);
  });

  test.afterAll(async () => {
    await tracker.cleanup();
  });

  test('run inspector for a not-yet-linked evaluation-run renders the run (not a silent bounce back to the runs list) when navigated to directly', async ({ page }) => {
    test.skip(!benchmarkId || !runId, 'Setup did not produce a benchmark + run to test');

    // Precondition sanity check: the run must genuinely be absent from
    // benchmark.runs[] (the exact repro condition), and the run doc itself
    // must be fetchable standalone — otherwise this test isn't exercising
    // the bug at all.
    const bmCheck = await page.request.get(`/api/storage/benchmarks/${benchmarkId}`);
    const bmBody = await bmCheck.json();
    expect((bmBody.runs || []).some((r: { id: string }) => r.id === runId)).toBe(false);
    const runCheck = await page.request.get(`/api/storage/evaluation-runs/${runId}`);
    expect(runCheck.ok()).toBe(true);

    // Navigate straight to the nested benchmark-mode inspect URL — the exact
    // route a benchmark runs-list row link (components/evals3/BenchmarkRunsPage.tsx)
    // constructs. Before the fix, RunInspectorPage's `loadData` found no
    // match in `bm.runs` and called `navigate()` straight back to
    // `/evaluations/benchmarks/:id/runs` — from a user's perspective,
    // arriving here (whether by a row click or a direct link) silently
    // bounced back with no visible error.
    await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs/${runId}/inspect`);

    // The regression: assert we actually STAY on and RENDER the inspect
    // route for this run id — not redirected back to the runs list.
    await expect(page).toHaveURL(new RegExp(`/evaluations/benchmarks/${benchmarkId}/runs/${runId}/inspect$`), {
      timeout: 15_000,
    });
    await expect(page.locator('[data-testid="run-inspector-not-found"]')).toHaveCount(0);
    await expect(page.getByTestId('run-inspector-rename-text')).toHaveText(RUN_NAME, { timeout: 15_000 });
  });

  test('run inspector for a genuinely nonexistent run renders an explicit not-found state, not a silent bounce', async ({ page }) => {
    test.skip(!benchmarkId, 'No benchmark created');

    await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs/does-not-exist-anywhere/inspect`);

    // Must land on (and stay on) an explicit not-found state, not silently
    // redirect back to the runs list with no explanation.
    await expect(page.locator('[data-testid="run-inspector-not-found"]')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('text=Run not found')).toBeVisible();

    // The explicit "Back to runs" affordance still gets the user home, on
    // demand — unlike the old automatic, unexplained redirect.
    await page.click('text=Back to runs');
    await expect(page).toHaveURL(new RegExp(`/evaluations/benchmarks/${benchmarkId}/runs$`), { timeout: 15_000 });
  });

  test('clicking a not-yet-linked run\'s row on the benchmark runs list opens the inspector instead of bouncing back to the list', async ({ page }) => {
    test.skip(!benchmarkId || !runId, 'Setup did not produce a benchmark + run to test');

    // Same never-embedded precondition as the direct-URL test above, but
    // this time driven through the ACTUAL row click on the runs LIST page —
    // the real reported path (an in-flight run's row looked clickable but
    // silently did nothing). The row itself doesn't need to be visibly
    // "Running" for this regression: the bounce is keyed purely on absence
    // from `benchmark.runs[]`, which this setup's deliberately-unresolvable
    // agentKey guarantees deterministically (no flaky timing window needed).
    await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs`);
    const row = page.locator(`text=${RUN_NAME}`).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click();

    // Before the fix this click landed back on the SAME runs-list URL
    // (silent bounce). Assert it actually opens the inspector and renders.
    await expect(page).toHaveURL(new RegExp(`/evaluations/benchmarks/${benchmarkId}/runs/${runId}/inspect$`), {
      timeout: 15_000,
    });
    await expect(page.locator('[data-testid="run-inspector-not-found"]')).toHaveCount(0);
    await expect(page.getByTestId('run-inspector-rename-text')).toHaveText(RUN_NAME, { timeout: 15_000 });
  });
});

