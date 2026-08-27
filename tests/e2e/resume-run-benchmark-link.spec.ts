// SPDX-License-Identifier: Apache-2.0
// Copyright OpenSearch Contributors

/**
 * E2E regression: a run resumed via POST /resume must show up on the
 * benchmark detail page (`/benchmarks/:id/runs`), which renders
 * `benchmark.runs` directly (see components/BenchmarkRunsPage.tsx).
 *
 * Bug (production, hit twice): the create route's success path links a
 * completed run into `benchmark.runs`; the resume route's completion path
 * never did — so a run whose original create-route execution crashed BEFORE
 * that success branch (never linked) stayed permanently invisible on this
 * page even after a later resume finished it. `GET .../evaluation-runs/:id`
 * and the Evaluation Runs page looked fine (they read the evaluation-run
 * document directly); only this benchmark-scoped view was missing the run.
 *
 * Seeds the "crashed before addRun" state directly via the real backend
 * (PUT upsert with `benchmarkId` set, no execution — same technique as
 * resume-run.spec.ts), lets the resume actually run to completion against
 * the mock `demo` agent, then asserts the run appears on the benchmark page.
 */
import { test, expect } from './fixtures/test-fixtures';

test.describe('Resume links the run into benchmark.runs (production bug regression)', () => {
  const runId = `eval-run-resume-link-e2e-${Date.now()}`;
  const createdTestCaseIds: string[] = [];
  let benchmarkId: string | undefined;

  test.beforeAll(async ({ request }) => {
    for (let i = 1; i <= 2; i++) {
      const tc = await request.post('/api/storage/test-cases', {
        data: {
          name: `resume-link-e2e-tc${i}-${Date.now()}`,
          category: 'Diagnostics',
          difficulty: 'Easy',
          initialPrompt: `Say hello (${i})`,
          expectedOutcomes: ['Agent responds'],
          labels: [],
        },
      });
      expect(tc.ok()).toBeTruthy();
      createdTestCaseIds.push((await tc.json()).id);
    }
    const tcIds = createdTestCaseIds;

    const benchmark = await request.post('/api/storage/benchmarks', {
      data: {
        name: `resume-link-e2e-benchmark-${Date.now()}`,
        description: 'E2E regression: resumed runs must appear in benchmark.runs',
        testCaseIds: tcIds,
        runs: [],
        currentVersion: 1,
        versions: [{ version: 1, createdAt: new Date().toISOString(), testCaseIds: tcIds }],
      },
    });
    expect(benchmark.ok()).toBeTruthy();
    benchmarkId = (await benchmark.json()).id;

    // Seed a run associated with the benchmark whose original create-route
    // execution crashed BEFORE it ever reached the `addRun` success branch:
    // `benchmarkId` is set, but the benchmark's `runs` array (seeded empty
    // above) has no entry for it. One test case already has a persisted
    // report; the other is pending — both are resumable-relevant states.
    const seeded = await request.put(`/api/storage/evaluation-runs/${runId}`, {
      data: {
        name: 'resume-link-e2e-run',
        sources: [{ type: 'test-case-ids', ids: tcIds }],
        agentKey: 'demo',
        modelId: 'demo-model',
        judgeModelId: 'demo-model',
        trigger: 'api',
        benchmarkId,
        status: 'failed',
        error: 'simulated crash before create route reached addRun',
        createdAt: new Date().toISOString(),
        testCaseSnapshots: tcIds.map((id, i) => ({ id, version: 1, name: `resume-link-e2e-tc${i + 1}` })),
        results: {
          [tcIds[0]]: { reportId: 'e2e-link-preserved-report', status: 'completed' },
          [tcIds[1]]: { reportId: '', status: 'pending' },
        },
      },
    });
    expect(seeded.ok()).toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    await request.delete(`/api/storage/evaluation-runs/${runId}`).catch(() => {});
    if (benchmarkId) {
      await request.delete(`/api/storage/benchmarks/${benchmarkId}`).catch(() => {});
    }
    for (const id of createdTestCaseIds) {
      await request.delete(`/api/storage/test-cases/${id}`).catch(() => {});
    }
  });

  test('resumed run appears on the benchmark runs page exactly once', async ({ page }) => {
    // Sanity check via the API first: before resume, the benchmark truly has
    // no runs — this is the "invisible on the benchmark detail page" symptom.
    const beforeResume = await page.request.get(`/api/storage/benchmarks/${benchmarkId}`);
    expect(beforeResume.ok()).toBeTruthy();
    expect((await beforeResume.json()).runs || []).toHaveLength(0);

    // Resume from the run detail page — real execution against the mock
    // `demo` agent (fast, no external calls) so it actually completes and
    // exercises the fixed linking code.
    await page.goto(`/evaluations/runs/${runId}`);
    const resumeBtn = page.locator('[data-testid="resume-run-btn"]');
    await expect(resumeBtn).toBeVisible({ timeout: 30000 });
    await resumeBtn.click();

    // Resume streams via SSE and the page reflects completion; poll the API
    // for the terminal state rather than depending on a specific UI element.
    await expect
      .poll(
        async () => {
          const res = await page.request.get(`/api/storage/evaluation-runs/${runId}`);
          return (await res.json()).status;
        },
        { timeout: 60_000 }
      )
      .toBe('completed');

    // THE BUG: the completed run must now show up on the benchmark's runs
    // page, exactly once.
    await page.goto(`/benchmarks/${benchmarkId}/runs`);
    await expect(page.locator('[data-testid="benchmark-runs-page"]')).toBeVisible({ timeout: 30000 });
    await expect(page.getByText('resume-link-e2e-run', { exact: false })).toHaveCount(1);

    const afterResume = await page.request.get(`/api/storage/benchmarks/${benchmarkId}`);
    const linkedRuns = ((await afterResume.json()).runs || []).filter((r: any) => r.id === runId);
    expect(linkedRuns).toHaveLength(1);
    expect(linkedRuns[0].status).toBe('completed');
  });
});
