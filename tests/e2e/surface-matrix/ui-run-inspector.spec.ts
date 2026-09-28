/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Surface matrix · UI · run inspector renders a completed run
 *
 * After any surface produces a run, the customer inspects it. Against a REAL
 * completed run of the REST agent (traces exported, judged by the demo
 * judge), pinned:
 *   - `/evaluations/runs/:id/inspect` shows the run name, agent, verdict
 *     counts (N✓ 0✗ / N) and one PASSED row per test case;
 *   - selecting a case renders the Test Case Output / Traces / Judge
 *     Evaluation tabs; Test Case Output carries a non-zero step count; the
 *     Traces tab counts the agent's 3 spans and offers Trace Tree / Agent Map /
 *     Timeline; Judge Evaluation shows the verdict + reasoning;
 *   - the benchmark-scoped route `/evaluations/benchmarks/:bid/runs/:rid`
 *     redirects to `…/inspect` and renders the same run.
 */

import { test, expect } from '../fixtures/test-fixtures';
import { seedAgent, seedBenchmark, seedCases, seedCompletedRun, type SeededAgent } from './helpers';

const CASES = 2;

test.describe('surface-matrix · UI · run inspector', () => {
  test.setTimeout(180_000);
  let seeded: SeededAgent;

  test.afterEach(async () => { await seeded?.agent.close(); });

  test('inspector shows verdicts, rows, and Test Case Output / Traces / Judge Evaluation for a completed run', async ({ page, testData }) => {
    seeded = await seedAgent(testData);
    const cases = await seedCases(testData, 'ui-inspector', CASES);
    const bench = await seedBenchmark(testData, 'ui-inspector-bench', cases.map((c) => c.id));
    const { run } = await seedCompletedRun(testData, { agentKey: seeded.key, benchmarkId: bench.id });

    await page.goto(`/evaluations/runs/${run.id}/inspect`);
    // Header: run name, agent, verdict counts N✓ 0✗ / N, pass rate.
    await expect(page.getByText(run.name).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(seeded.name).first()).toBeVisible();
    await expect(page.getByText(`${CASES}✓`)).toBeVisible();
    await expect(page.getByText('0✗')).toBeVisible();
    await expect(page.getByText(`/ ${CASES}`)).toBeVisible();
    await expect(page.getByText(`Test Cases · ${CASES}`)).toBeVisible();
    await expect(page.getByTestId('test-case-row')).toHaveCount(CASES, { timeout: 15_000 });
    await expect(page.getByTestId('test-case-row').filter({ hasText: 'PASSED' })).toHaveCount(CASES);

    await page.getByText(cases[0].name).first().click();
    const outputTab = page.getByRole('tab', { name: /^Test Case Output/ });
    await expect(outputTab).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('tab', { name: /^Traces/ })).toBeVisible();
    await expect(page.getByRole('tab', { name: /^Judge Evaluation$/ })).toBeVisible();
    // Test Case Output: the badge carries the step count (> 0 for a real run).
    await expect(outputTab).not.toContainText(/\b0\b/);

    // Traces: the tab badge counts the agent's 3 spans and the viewer offers
    // its views (the span names themselves are drawn on a canvas — the
    // span-level contract is pinned by the API spec, api-reads).
    const tracesTab = page.getByRole('tab', { name: /^Traces/ });
    await tracesTab.click();
    await expect(tracesTab).toContainText('3', { timeout: 30_000 });
    for (const view of ['Trace Tree', 'Agent Map', 'Timeline']) {
      await expect(page.getByRole('button', { name: view })).toBeVisible();
    }

    await page.getByRole('tab', { name: /^Judge Evaluation$/ }).click();
    await expect(page.getByText(/^(PASSED|FAILED)$/).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/Mock Evaluation Result|Expected Outcomes Coverage/).first()).toBeVisible();

    // Benchmark-scoped route → same inspector.
    await page.goto(`/evaluations/benchmarks/${bench.id}/runs/${run.id}`);
    await expect(page).toHaveURL(new RegExp(`/evaluations/benchmarks/${bench.id}/runs/${run.id}/inspect$`));
    await expect(page.getByText(`/ ${CASES}`)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('test-case-row')).toHaveCount(CASES, { timeout: 15_000 });
  });
});
