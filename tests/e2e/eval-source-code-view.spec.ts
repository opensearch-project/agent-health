/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E spec for the "Eval source" IDE-style code view on the Test Case
 * detail page.
 *
 * Feature: when a test case originates from a code-SDK eval file
 * (`sourceFile` set — see lib/testCases/loader.ts and
 * cli/commands/benchmark.ts), the Test Case detail page renders the
 * full eval-file source as an IDE-style code view: line numbers, a
 * filename header, syntax highlighting, and a copy button — alongside
 * the existing parsed prompt / expected-outcomes definition fields.
 *
 * We seed test cases directly via the storage API (no CLI subprocess
 * needed for the UI assertion — the CLI/API import path that produces
 * these fields is covered separately by
 * tests/integration/cli/benchmarkCodeSdk.integration.test.ts) so this
 * spec stays fast and only exercises the rendering contract.
 */

import { test, expect, type APIRequestContext } from './fixtures/test-fixtures';

const CODE_SOURCE = [
  "import { test } from '@opensearch-project/agent-health';",
  '',
  "test('rca-outage', { prompt: 'Diagnose the outage' }, () => {",
  '  // a comment, to sanity-check syntax highlighting renders something',
  '  return true;',
  '});',
].join('\n');

async function createCodeSdkTestCase(
  request: APIRequestContext,
  overrides: Record<string, unknown> = {}
): Promise<{ id: string; cleanup: () => Promise<void> }> {
  const res = await request.post('/api/storage/test-cases', {
    data: {
      name: `e2e-eval-source-${Date.now()}`,
      description: 'Created by e2e/eval-source-code-view.spec.ts',
      labels: [],
      category: 'Custom',
      difficulty: 'Easy',
      isPromoted: false,
      initialPrompt: 'Diagnose the outage',
      context: [],
      sourceFile: 'evals/rca-outage.eval.ts',
      sourceFileName: 'rca-outage.eval.ts',
      sourceLanguage: 'typescript',
      sourceHash: 'e2e-fixture-hash',
      sourceCode: CODE_SOURCE,
      ...overrides,
    },
  });
  expect(res.ok(), 'creating code-SDK test case via storage API').toBe(true);
  const tc = await res.json();
  const id: string = tc.id;
  return {
    id,
    cleanup: async () => {
      await request.delete(`/api/storage/test-cases/${encodeURIComponent(id)}`).catch(() => {});
    },
  };
}

test.describe('Test Case Detail — Eval source code view', () => {
  test.beforeAll(async ({ request }) => {
    const healthRes = await request.get('/api/storage/health');
    if (!healthRes.ok()) {
      test.skip(true, 'Backend storage not available');
    }
  });

  test('renders the full eval-file source with line numbers, filename, and language badge', async ({ page, request }) => {
    const tc = await createCodeSdkTestCase(request);
    try {
      await page.goto(`/evaluations/test-cases/${tc.id}`);

      const codeView = page.getByTestId('eval-source-code-view');
      await expect(codeView).toBeVisible();

      // Filename header + language badge.
      await expect(codeView).toContainText('rca-outage.eval.ts');
      await expect(codeView).toContainText('TypeScript');

      // EXPANDED BY DEFAULT for a legacy (no per-test `definition`) record:
      // the eval file IS the definition here, and hiding it behind a second
      // click made SDK definitions look empty (owner report, 2026-09-08).
      // Still collapsible: the toggle hides the body and shows it again.
      const toggle = page.getByTestId('eval-source-toggle');
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      await expect(page.getByTestId('eval-source-code-body')).toBeVisible();
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await expect(page.getByTestId('eval-source-code-body')).toHaveCount(0);
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');

      // Line-number gutter: CODE_SOURCE has 6 lines, so the gutter's last
      // rendered number must be 6 and it must contain every number 1..6
      // (proves the ENTIRE file rendered, not a truncated preview).
      const gutter = page.getByTestId('eval-source-line-numbers');
      await expect(gutter).toBeVisible();
      const gutterText = (await gutter.textContent()) || '';
      const lines = gutterText.split('\n').filter(Boolean);
      expect(lines).toEqual(['1', '2', '3', '4', '5', '6']);

      // The code body contains the full source text (line numbers column
      // is separate from the code column, so check the body as a whole).
      const body = page.getByTestId('eval-source-code-body');
      await expect(body).toContainText("test('rca-outage'");
      await expect(body).toContainText('Diagnose the outage');
      await expect(body).toContainText('a comment, to sanity-check');

      // Syntax highlighting: Prism should have emitted at least one
      // `.token.keyword` span (e.g. `import`/`const`/`return`).
      const keywordTokenCount = await body.locator('.token.keyword').count();
      expect(keywordTokenCount).toBeGreaterThan(0);
    } finally {
      await tc.cleanup();
    }
  });

  test('copy button copies the raw source to the clipboard', async ({ page, request, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const tc = await createCodeSdkTestCase(request);
    try {
      await page.goto(`/evaluations/test-cases/${tc.id}`);
      const codeView = page.getByTestId('eval-source-code-view');
      await expect(codeView).toBeVisible();

      await codeView.getByRole('button', { name: /copy source/i }).click();
      const clipboard = await page.evaluate(() => navigator.clipboard.readText());
      expect(clipboard).toBe(CODE_SOURCE);
    } finally {
      await tc.cleanup();
    }
  });

  test('shows a "source not captured" placeholder for legacy code-SDK test cases with no sourceCode', async ({ page, request }) => {
    const tc = await createCodeSdkTestCase(request, { sourceCode: undefined });
    try {
      await page.goto(`/evaluations/test-cases/${tc.id}`);
      const codeView = page.getByTestId('eval-source-code-view');
      await expect(codeView).toBeVisible();
      // Expanded by default → the placeholder is visible without a click.
      await expect(page.getByTestId('eval-source-toggle')).toHaveAttribute('aria-expanded', 'true');
      await expect(codeView).toContainText(/source not captured at import/i);
      // No code body / line-number gutter when there's nothing to render.
      await expect(page.getByTestId('eval-source-code-body')).toHaveCount(0);
    } finally {
      await tc.cleanup();
    }
  });

  test('does NOT render the eval source section for a plain JSON test case', async ({ page, request }) => {
    // A JSON/UI-created test case has no sourceFile at all.
    const res = await request.post('/api/storage/test-cases', {
      data: {
        name: `e2e-json-testcase-${Date.now()}`,
        description: 'Plain JSON test case — no code-SDK provenance',
        labels: [],
        category: 'Custom',
        difficulty: 'Easy',
        isPromoted: false,
        initialPrompt: 'What is 2+2?',
        context: [],
        expectedOutcomes: ['Agent identifies the answer is 4'],
      },
    });
    expect(res.ok()).toBe(true);
    const jsonTc = await res.json();
    try {
      await page.goto(`/evaluations/test-cases/${jsonTc.id}`);
      // Definition section should render normally...
      await expect(page.getByText('Diagnose the outage')).toHaveCount(0);
      // ...but no eval-source code view for a non-code-SDK test case.
      await expect(page.getByTestId('eval-source-code-view')).toHaveCount(0);
    } finally {
      await request.delete(`/api/storage/test-cases/${encodeURIComponent(jsonTc.id)}`).catch(() => {});
    }
  });
});
