/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression e2e for the version-level test-case-link bug: a CLI-created
 * benchmark (shell: testCaseIds: []) that gets test cases linked via
 * `POST /api/storage/evaluation-runs` must render those test cases on the
 * benchmark page's test-case panel, not "No test cases in this version".
 *
 * This is the gap that let the bug ship: the existing e2e coverage
 * (evals3-benchmark-runs.spec.ts) only ever seeded benchmarks with
 * `testCaseIds` already set directly at creation time, which also
 * populates `versions[0].testCaseIds` correctly (see
 * server/routes/storage/benchmarks.ts's POST /api/storage/benchmarks). It
 * never exercised the CLI's actual path — create a SHELL benchmark, then
 * link test cases into it via a run — which is exactly the path that
 * dropped the version-level array (services/benchmarkPromotion.ts
 * linkTestCaseIdsToBenchmark). This spec reproduces that real path end to
 * end and asserts the rendered panel, not just the API response.
 */

import { test, expect } from './fixtures/test-fixtures';

test.describe('Benchmark page test-case panel renders CLI-created (run-linked) cases', () => {
  const testCaseName = `E2E Version-Link TC ${Date.now()}`;
  const benchmarkName = `E2E Version-Link Benchmark ${Date.now()}`;
  let testCaseId: string | null = null;
  let benchmarkId: string | null = null;
  let runId: string | null = null;

  test.beforeAll(async ({ request }) => {
    // 1. Create a test case.
    const tcRes = await request.post('/api/storage/test-cases', {
      data: {
        name: testCaseName,
        category: 'Test',
        difficulty: 'Easy',
        initialPrompt: 'What is 2+2?',
        expectedOutcomes: ['Agent responds with 4'],
      },
    });
    if (tcRes.ok()) {
      const tc = await tcRes.json();
      testCaseId = tc.id || tc.testCase?.id || null;
    }

    // 2. Create a SHELL benchmark — testCaseIds: [] at creation, exactly how
    // `agent-health benchmark -f foo.eval.js -n "..."` creates one before any
    // run has linked test cases into it.
    const bmRes = await request.post('/api/storage/benchmarks', {
      data: {
        name: benchmarkName,
        description: 'Created empty, then linked via a run — reproduces the CLI path',
        testCaseIds: [],
      },
    });
    if (bmRes.ok()) {
      const bm = await bmRes.json();
      benchmarkId = bm.id || bm.benchmark?.id || null;
    }

    test.skip(!testCaseId || !benchmarkId, 'Failed to seed test case / benchmark');

    // Sanity: genuinely a shell at both levels before linking.
    const before = await (await request.get(`/api/storage/benchmarks/${benchmarkId}`)).json();
    expect(before.testCaseIds).toEqual([]);
    expect((before.versions || []).find((v: any) => v.version === before.currentVersion)?.testCaseIds).toEqual([]);

    // 3. Run against the shell benchmark with `benchmarkId` set — this is
    // the exact call that must link the test case into BOTH testCaseIds
    // levels. `agentKey: 'demo'` is the deterministic mock provider so this
    // completes fast without external creds. request.post buffers the
    // whole (SSE) response body, so it resolves only once the run ends.
    const runRes = await request.post('/api/storage/evaluation-runs', {
      data: {
        name: `E2E Version-Link Run ${Date.now()}`,
        sources: [{ type: 'test-case-ids', ids: [testCaseId] }],
        agentKey: 'demo',
        modelId: 'demo-model',
        benchmarkId,
        trigger: 'e2e-test',
      },
      timeout: 60_000,
    });
    if (runRes.ok()) {
      const body = await runRes.text();
      const match = body.match(/"runId":"([^"]+)"/);
      if (match) runId = match[1];
    }
  });

  test.afterAll(async ({ request }) => {
    if (runId) await request.delete(`/api/storage/evaluation-runs/${runId}`).catch(() => {});
    if (benchmarkId) await request.delete(`/api/storage/benchmarks/${benchmarkId}`).catch(() => {});
    if (testCaseId) await request.delete(`/api/storage/test-cases/${testCaseId}`).catch(() => {});
  });

  test('API sanity: linking populated BOTH testCaseIds levels (no version bump)', async ({ request }) => {
    test.skip(!benchmarkId, 'Seed data unavailable');
    const bm = await (await request.get(`/api/storage/benchmarks/${benchmarkId}`)).json();
    expect(bm.testCaseIds).toContain(testCaseId);
    const currentEntry = (bm.versions || []).find((v: any) => v.version === bm.currentVersion);
    expect(currentEntry?.testCaseIds).toContain(testCaseId);
  });

  test('renders the linked test case in the Cases tab instead of an empty case list', async ({ page }) => {
    test.skip(!benchmarkId, 'Seed data unavailable');

    // The benchmark page is now a fixed two-tab layout (Cases | Runs, PR #447);
    // the old split "test-case panel" (and its "No test cases in this version"
    // / "N test cases" copy) no longer exists. The Cases tab is the surface
    // that renders the benchmark's current-version test cases, so a
    // version-level link that is dropped shows up as a Cases tab with no
    // rows (and no "Cases N" count badge).
    await page.goto(`/evaluations/benchmarks/${benchmarkId}`);
    await page.waitForSelector('h2', { timeout: 30000 });
    await expect(page.locator(`h2:has-text("${benchmarkName}")`)).toBeVisible();

    // THE FIX: the Cases tab count reflects the linked test case, and the
    // case row for it actually renders in the case list.
    const casesTab = page.locator('[role="tab"]:has-text("Cases")');
    await expect(casesTab).toBeVisible();
    await expect(casesTab).toContainText('1');
    await page.waitForSelector('[data-testid="benchmark-cases-tab"]', { timeout: 30000 });
    const caseList = page.locator('[role="listbox"][aria-label="Benchmark cases"]');
    await expect(caseList.locator('[role="option"]')).toHaveCount(1);
    await expect(caseList.getByText(testCaseName)).toBeVisible();
  });

  test('the version-aware benchmark runs page renders the linked case, not "No test cases in this version"', async ({ page }) => {
    test.skip(!benchmarkId, 'Seed data unavailable');

    // The Cases tab above derives its rows from the TOP-LEVEL `testCaseIds`,
    // so it cannot distinguish the original bug (top-level populated,
    // `versions[current].testCaseIds` still empty). This page —
    // components/BenchmarkRunsPage.tsx, routed at /benchmarks/:id/runs and
    // reached from the Overview's "Run a benchmark" CTA — is the surface that
    // reads the CURRENT VERSION's array (getVersionTestCases), and is where
    // the bug originally rendered as "No test cases in this version".
    await page.goto(`/benchmarks/${benchmarkId}/runs`);
    await expect(page.locator('[data-testid="benchmark-name"]')).toHaveText(benchmarkName, { timeout: 30000 });

    // THE BUG: this text renders when the current version's testCaseIds is
    // empty, even though the benchmark's top-level testCaseIds is correct.
    await expect(page.locator('text=No test cases in this version')).toHaveCount(0);

    // THE FIX: the version panel's count reflects the linked test case, and
    // the card for it actually renders.
    await expect(page.locator('text=/^1 test case$/')).toBeVisible();
    await expect(page.locator(`text=${testCaseName}`).first()).toBeVisible();
  });
});
