/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E: per-test SDK definition view on the run report.
 *
 * Feature: for a code-SDK test case, the run report's "Test Case Definition"
 * section used to render the WHOLE eval file — for a suite that registers
 * its tests from a loop, "the test" was nowhere to be seen. Now, under the
 * `<file>.eval.js` header, only THIS test is shown, with three segments:
 *
 *   Pretty (default)  — this test's resolved `test()` options (prompt,
 *                       expected outcomes, labels, timeout, description)
 *   Evaluate function — the evaluate callback text, syntax-highlighted
 *   Whole file        — the pre-existing full-file code view
 *
 * Legacy records (no `definition`) keep the whole-file view with a hint.
 *
 * We seed the test case + report directly via the storage API (the import
 * path that produces `definition` is covered by
 * tests/integration/server/routes/storage/testCasesDefinitionCapture.integration.test.ts)
 * so this spec only exercises the rendering contract. Everything created is
 * tracked by id and deleted via the `testData` fixture.
 */

import { test, expect, type APIRequestContext } from './fixtures/test-fixtures';
import type { TestDataTracker } from '../helpers/testDataTracker';

const WHOLE_FILE = [
  "const { test } = require('@opensearch-project/agent-health');",
  'const CASES = [',
  "  { name: 'synthetic-case-one',   prompt: 'Synthetic prompt number one',   marker: 'ONE' },",
  "  { name: 'synthetic-case-two',   prompt: 'Synthetic prompt number two',   marker: 'TWO' },",
  "  { name: 'synthetic-case-three', prompt: 'Synthetic prompt number three', marker: 'THREE' },",
  '];',
  'for (const c of CASES) {',
  "  test(c.name, { prompt: c.prompt, labels: ['category:Synthetic'] }, async ({ result }) => {",
  '    // shared-loop-body-marker',
  "    if (!result) throw new Error('no result for ' + c.name);",
  '  });',
  '}',
].join('\n');

const DEFINITION = {
  registeredAs: 'sdk',
  options: {
    prompt: 'Synthetic prompt number two',
    description: 'Synthetic description for TWO',
    expectedOutcomes: ['Outcome two is satisfied', 'Outcome two is fast'],
    labels: ['category:Synthetic', 'difficulty:Easy', 'marker:TWO'],
    timeout: 30000,
  },
  bodySource: "async ({ result }) => {\n    // shared-loop-body-marker\n    if (!result) throw new Error('no result for ' + c.name);\n  }",
};

async function seedSdkCase(
  request: APIRequestContext,
  testData: TestDataTracker,
  withDefinition: boolean,
): Promise<{ testCaseId: string; reportId: string }> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const tcRes = await request.post('/api/storage/test-cases', {
    data: {
      name: `e2e-sdk-def-two-${stamp}`,
      description: 'Synthetic description for TWO',
      labels: ['category:Synthetic', 'difficulty:Easy'],
      category: 'Synthetic',
      difficulty: 'Easy',
      isPromoted: false,
      initialPrompt: 'Synthetic prompt number two',
      context: [],
      expectedOutcomes: ['Outcome two is satisfied'],
      sourceFile: 'evals/synthetic-suite.eval.js',
      sourceFileName: 'synthetic-suite.eval.js',
      sourceLanguage: 'javascript',
      sourceHash: `e2e-hash-${stamp}`,
      sourceCode: WHOLE_FILE,
      ...(withDefinition ? { definition: DEFINITION } : {}),
    },
  });
  expect(tcRes.ok(), 'creating SDK test case').toBe(true);
  const testCaseId: string = (await tcRes.json()).id;
  testData.testCase(testCaseId);

  const reportId = `report-e2e-sdk-def-${stamp}`;
  const runRes = await request.post('/api/storage/runs', {
    data: {
      id: reportId,
      timestamp: new Date().toISOString(),
      testCaseId,
      testCaseVersionId: `${testCaseId}-v1`,
      agentKey: 'demo',
      agentId: 'demo',
      modelId: 'demo-model',
      iteration: 1,
      status: 'completed',
      passFailStatus: 'passed',
      metricsStatus: 'ready',
      evaluationType: 'deterministic',
      trajectory: [{ type: 'assistant', content: 'synthetic step' }],
      metrics: { accuracy: 1, faithfulness: 1, latency_score: 1, trajectory_alignment_score: 1 },
    },
  });
  expect(runRes.ok(), 'creating run report').toBe(true);
  testData.run(reportId);
  return { testCaseId, reportId };
}

test.describe('Run report — per-test SDK definition view', () => {
  test.beforeAll(async ({ request }) => {
    const healthRes = await request.get('/api/storage/health');
    if (!healthRes.ok()) test.skip(true, 'Backend storage not available');
  });

  test('shows Pretty by default with ONLY this test, Evaluate function on switch, whole file still reachable', async ({ page, request, testData }) => {
    const { reportId } = await seedSdkCase(request, testData, true);
    await page.goto(`/runs/${reportId}`);

    // Open the collapsible "Test Case Definition" section.
    const header = page.getByRole('button', { name: /test case definition/i });
    await expect(header).toBeVisible({ timeout: 15_000 });
    await header.click();

    const view = page.getByTestId('sdk-test-definition-view');
    await expect(view).toBeVisible();
    await expect(view).toHaveAttribute('data-mode', 'captured');
    // Filename header (the `<file>.eval.js` row).
    await expect(view).toContainText('evals/synthetic-suite.eval.js');

    // Pretty is the default segment and shows THIS test's options…
    await expect(page.getByTestId('sdk-definition-segment-pretty')).toHaveAttribute('aria-selected', 'true');
    const pretty = page.getByTestId('sdk-definition-pretty');
    await expect(pretty).toBeVisible();
    await expect(pretty).toContainText('Synthetic prompt number two');
    await expect(pretty).toContainText('Outcome two is satisfied');
    await expect(pretty).toContainText('Outcome two is fast');
    await expect(pretty).toContainText('Synthetic description for TWO');
    await expect(page.getByTestId('sdk-definition-timeout')).toContainText('30000');
    // …and NOT the other tests from the same file.
    await expect(view).not.toContainText('synthetic-case-one');
    await expect(view).not.toContainText('synthetic-case-three');
    await expect(view).not.toContainText('Synthetic prompt number one');

    // Evaluate function segment: the callback text, highlighted.
    await page.getByTestId('sdk-definition-segment-evaluate').click();
    const body = page.getByTestId('sdk-definition-evaluate-body');
    await expect(body).toBeVisible();
    await expect(body).toContainText('shared-loop-body-marker');
    await expect(body).toContainText('no result for');
    await expect(body).not.toContainText('const CASES');
    expect(await body.locator('.token.keyword').count()).toBeGreaterThan(0);
    await expect(page.getByTestId('sdk-definition-pretty')).toHaveCount(0);

    // Whole file is still reachable and contains every test.
    await page.getByTestId('sdk-definition-segment-file').click();
    const fileBody = page.getByTestId('eval-source-code-body');
    await expect(fileBody).toBeVisible();
    await expect(fileBody).toContainText('synthetic-case-one');
    await expect(fileBody).toContainText('synthetic-case-three');
  });

  test('legacy SDK record without definition falls back to the whole file with a re-import hint', async ({ page, request, testData }) => {
    const { reportId } = await seedSdkCase(request, testData, false);
    await page.goto(`/runs/${reportId}`);

    const header = page.getByRole('button', { name: /test case definition/i });
    await expect(header).toBeVisible({ timeout: 15_000 });
    await header.click();

    const view = page.getByTestId('sdk-test-definition-view');
    await expect(view).toHaveAttribute('data-mode', 'legacy');
    await expect(page.getByTestId('sdk-definition-legacy-hint')).toContainText(/re-import/i);
    await expect(page.getByTestId('sdk-definition-segments')).toHaveCount(0);
    // The whole-file view is present (collapsed header, expandable).
    await expect(page.getByTestId('eval-source-code-view')).toBeVisible();
    await page.getByTestId('eval-source-toggle').click();
    await expect(page.getByTestId('eval-source-code-body')).toContainText('synthetic-case-one');
  });

  test('Test Case detail page uses the same per-test view (Pretty by default)', async ({ page, request, testData }) => {
    const { testCaseId } = await seedSdkCase(request, testData, true);
    await page.goto(`/evaluations/test-cases/${testCaseId}`);

    const view = page.getByTestId('sdk-test-definition-view');
    await expect(view).toBeVisible({ timeout: 15_000 });
    await expect(view).toHaveAttribute('data-mode', 'captured');
    await expect(page.getByTestId('sdk-definition-pretty')).toContainText('Synthetic prompt number two');
    await expect(view).not.toContainText('synthetic-case-one');
  });
});
