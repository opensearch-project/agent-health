/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E for #617: a negated chai assertion in a code-SDK test
 * (`expect(x).to.not.match(re)`) must be SHOWN with its negation on the run
 * page. Before the fix the stored `description` read as the opposite check
 * ("… to match /^none — /") while `errorMessage` said "not to match", so the
 * Judge Evaluation tab contradicted itself and a correct failure looked like
 * a bug in the test.
 *
 * Real path, not a seeded report: the server executes a code-import run of an
 * eval file written by this test (the issue's own assertions, on literal
 * values so no agent is invoked), then the browser opens the persisted
 * report and the rendered check rows are asserted.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { test, expect } from './fixtures/test-fixtures';

const STAMP = Date.now();
const ANSWER = 'none — top 3: a; b; c';
const FIXTURE = `
const { test, expect } = require('@opensearch-project/agent-health');

// The issue's shape: the answer starts with "none — " and the test asserts it must NOT.
test('ahtest-negation-fails-${STAMP}', () => {
  expect(${JSON.stringify(ANSWER)}, 'no expected item in the top 3').to.not.match(/^none — /);
});

// Passing negated checks of several forms next to a positive one.
test('ahtest-negation-passes-${STAMP}', () => {
  expect('top 3: a; b; c').to.not.match(/^none — /);
  expect(['a', 'b', 'c']).to.not.include('z');
  expect(['a']).to.not.be.empty;
  expect('top 3: a; b; c').to.include('top 3');
});
`;

interface RunDoc {
  id: string;
  status: string;
  results?: Record<string, { reportId?: string; status?: string }>;
  testCaseSnapshots?: Array<{ id: string; name: string }>;
}

test.describe('Judge Evaluation tab — negated assertions keep their negation (#617)', () => {
  let dir: string;
  let run: RunDoc | null = null;
  const reportByName = new Map<string, string>();

  test.beforeAll(async ({ request }) => {
    dir = mkdtempSync(join(tmpdir(), 'ahtest-negation-e2e-'));
    const file = join(dir, 'negation.eval.js');
    writeFileSync(file, FIXTURE, 'utf-8');

    // The server runs the file (code-import source) and streams progress;
    // the response ends when the run is complete.
    const res = await request.post('/api/storage/evaluation-runs', {
      data: {
        name: `ahtest-negation-e2e-${STAMP}`,
        sources: [{ type: 'code-import', filenames: [file], testCaseIds: [] }],
        agentKey: 'demo',
        modelId: 'demo-model',
        concurrency: 1,
        trigger: 'e2e-test',
      },
      timeout: 120_000,
    });
    if (!res.ok()) return;
    const runIdMatch = /"runId"\s*:\s*"((?:eval-)?run-[A-Za-z0-9-]+)"/.exec(await res.text());
    if (!runIdMatch) return;
    const runId = runIdMatch[1];
    for (let i = 0; i < 60; i++) {
      const r = await request.get(`/api/storage/evaluation-runs/${runId}`);
      if (r.ok()) {
        const body = await r.json();
        const doc: RunDoc = body.evaluationRun ?? body;
        if (doc.status === 'completed' || doc.status === 'failed') { run = doc; break; }
      }
      await new Promise(r => setTimeout(r, 500));
    }
    if (!run) return;
    for (const [tcId, result] of Object.entries(run.results ?? {})) {
      const name = run.testCaseSnapshots?.find(s => s.id === tcId)?.name;
      if (name && result.reportId) reportByName.set(name, result.reportId);
    }
  });

  test.afterAll(async ({ request }) => {
    // Everything this run created, by id — children before the parent.
    if (run) {
      for (const result of Object.values(run.results ?? {})) {
        if (result.reportId) await request.delete(`/api/storage/runs/${encodeURIComponent(result.reportId)}`).catch(() => {});
      }
      for (const s of run.testCaseSnapshots ?? []) {
        await request.delete(`/api/storage/test-cases/${encodeURIComponent(s.id)}`).catch(() => {});
      }
      await request.delete(`/api/storage/evaluation-runs/${encodeURIComponent(run.id)}`).catch(() => {});
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  // The TL;DR summary route may call a model; it is not under test here.
  const quietTldr = (page: import('@playwright/test').Page) =>
    page.route('**/api/storage/runs/*/summary', r => r.fulfill({ json: { cached: true, summary: { source: 'fallback', parts: { asked: 'a', agent: 'b', verdict: 'c' }, generatedAt: new Date().toISOString(), inputsHash: 'x', error: 'test' } } }));

  test('failing `.to.not.match`: headline, row title and error all read "not to match"', async ({ page }) => {
    test.skip(!run, 'Could not execute the code-import run (server unavailable or code-first config)');
    const reportId = reportByName.get(`ahtest-negation-fails-${STAMP}`);
    test.skip(!reportId, 'No report persisted for the failing case');
    await quietTldr(page);
    await page.goto(`/evaluations/runs/${run!.id}/inspect?reportId=${reportId}`);
    await page.getByRole('tab', { name: /Judge Evaluation/ }).click();

    const headline = page.getByTestId('judgement-headline');
    await expect(headline).toBeVisible({ timeout: 15_000 });
    await expect(headline).toHaveAttribute('data-tone', 'failed');
    await expect(page.getByTestId('checks-heading')).toContainText('0/1 passed, 1 failed');
    // Headline, row title and the error all say "not to match" — the report agrees with itself.
    await expect(page.getByTestId('judgement-headline-title')).toContainText(`'${ANSWER}' not to match /^none — /`);
    await expect(page.getByTestId('check-title').first()).toHaveText(`'${ANSWER}' not to match /^none — /`);
    await expect(page.getByText(`error: no expected item in the top 3: expected '${ANSWER}' not to match /^none — /`).first()).toBeVisible();
    // The inverted claim must appear nowhere on the page.
    await expect(page.getByText(`'${ANSWER}' to match /^none — /`)).toHaveCount(0);
  });

  test('passing `.not` chains: each row title keeps its negation; the positive row is unchanged', async ({ page }) => {
    test.skip(!run, 'Could not execute the code-import run (server unavailable or code-first config)');
    const reportId = reportByName.get(`ahtest-negation-passes-${STAMP}`);
    test.skip(!reportId, 'No report persisted for the passing case');
    await quietTldr(page);
    await page.goto(`/evaluations/runs/${run!.id}/inspect?reportId=${reportId}`);
    await page.getByRole('tab', { name: /Judge Evaluation/ }).click();

    await expect(page.getByTestId('judgement-headline')).toHaveAttribute('data-tone', 'passed', { timeout: 15_000 });
    const titles = page.getByTestId('check-title');
    await expect(titles).toHaveText([
      "'top 3: a; b; c' not to match /^none — /",
      "[ 'a', 'b', 'c' ] to not include 'z'",
      "[ 'a' ] not to be empty",
      "'top 3: a; b; c' to include 'top 3'",
    ]);
  });
});
