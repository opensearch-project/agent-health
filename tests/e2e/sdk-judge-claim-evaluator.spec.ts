/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E (#619): a code-SDK run with NO evaluator chosen judges its inline
 * `judge(result, claim)` with the neutral built-in `system-claim` evaluator —
 * and the run page SAYS so.
 *
 * Real run through the same `/api/storage/evaluation-runs` code-import path
 * the CLI uses (built-in `demo` agent + mock judge, so no credentials), then:
 *   - the inspector's Judge Evaluation tab, judge row expanded → `evaluator:
 *     Claim` (from the matcher's frozen scoringSnapshot). On the old code the
 *     row carried no evaluator line at all and the snapshot read
 *     `system-rca-default`.
 *   - an identical run WITH `evaluatorId: 'system-rca-default'` → the row
 *     reads `RCA Default` (explicit choice unchanged).
 *   - the Evaluators page lists the new "Claim" system evaluator.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { test, expect } from './fixtures/test-fixtures';
import type { APIRequestContext } from '@playwright/test';
import { uniqueTestName } from '../helpers/testDataTracker';

const FIXTURE = `
const { test } = require('@opensearch-project/agent-health');

test('shop-claim', { prompt: 'running shoes under $100' }, async ({ agent, judge }) => {
  const result = await agent.run();
  await judge(result, 'Every retrieved item is a running shoe priced under $100.');
});
`;

async function sseEvents(request: APIRequestContext, url: string, data: Record<string, unknown>): Promise<any[]> {
  const res = await request.post(url, { data, timeout: 120_000 });
  if (!res.ok()) throw new Error(`${url} → ${res.status()} ${await res.text()}`);
  const events: any[] = [];
  for (const block of (await res.text()).split('\n\n')) {
    let eventName: string | undefined; let dataLine: string | undefined;
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) eventName = line.slice(7).trim();
      else if (line.startsWith('data: ')) dataLine = line.slice(6);
    }
    if (!dataLine) continue;
    try {
      const parsed = JSON.parse(dataLine);
      events.push(eventName && !('type' in parsed) ? { type: eventName, ...parsed } : parsed);
    } catch { /* ignore */ }
  }
  const terminal = events.find(e => e.status === 'completed' || e.type === 'completed' || e.error);
  if (!terminal || terminal.error) throw new Error(`${url}: ${terminal ? JSON.stringify(terminal).slice(0, 300) : 'no terminal event'}`);
  return events;
}

test.describe('Code-SDK judge() without an evaluator → neutral "Claim" evaluator, visible on the run page (#619)', () => {
  let skipReason = '';
  let tempDir: string;
  let defaultRunId = '';
  let explicitRunId = '';
  const created: Array<[string, string]> = [];

  test.beforeAll(async ({ request }) => {
    test.setTimeout(180_000);
    const health = await (await request.get('/api/storage/health')).json().catch(() => ({}));
    if (health.status !== 'ok') { skipReason = 'storage not available'; return; }

    tempDir = mkdtempSync(join(tmpdir(), 'e2e-claim-evaluator-'));
    const fixturePath = join(tempDir, 'shop.eval.js');
    writeFileSync(fixturePath, FIXTURE, 'utf-8');

    const startRun = async (name: string, extra: Record<string, unknown>) => {
      const events = await sseEvents(request, '/api/storage/evaluation-runs', {
        name, agentKey: 'demo', modelId: 'demo-model', judgeModelId: 'demo-model', concurrency: 1, trigger: 'e2e-test',
        sources: [{ type: 'code-import', filenames: [fixturePath], testCaseIds: [] }],
        ...extra,
      });
      const started = events.find(e => e.type === 'started');
      expect(started?.runId).toBeTruthy();
      created.push(['evaluation-run', started.runId]);
      for (const tc of started.testCases ?? []) created.push(['test-case', tc.id]);
      const doc = await (await request.get(`/api/storage/evaluation-runs/${started.runId}`)).json();
      for (const r of Object.values<any>((doc.evaluationRun ?? doc).results ?? {})) if (r.reportId) created.push(['run', r.reportId]);
      return started.runId as string;
    };
    defaultRunId = await startRun(uniqueTestName('claim-evaluator-default'), {});
    explicitRunId = await startRun(uniqueTestName('claim-evaluator-explicit'), { evaluatorId: 'system-rca-default' });
  });

  test.afterAll(async ({ request }) => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    const leaked: string[] = [];
    for (const kind of ['run', 'evaluation-run', 'test-case']) {
      for (const [k, id] of created) {
        if (k !== kind) continue;
        const path = kind === 'run' ? `/api/storage/runs/${id}` : kind === 'evaluation-run' ? `/api/storage/evaluation-runs/${id}` : `/api/storage/test-cases/${id}`;
        const r = await request.delete(path).catch(() => null);
        if (!r || (!r.ok() && r.status() !== 404)) leaked.push(`${kind} ${id}`);
      }
    }
    if (leaked.length) console.warn(`[sdk-judge-claim-evaluator] cleanup left data behind: ${leaked.join(', ')}`);
  });

  async function openJudgeRow(page: any, runId: string) {
    await page.goto(`/evaluations/runs/${runId}/inspect`);
    const row = page.locator('[data-testid="test-case-row"]').first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.click();
    await page.getByRole('tab', { name: /Judge Evaluation/ }).click();
    const judgeRow = page.getByText(/^judge: Every retrieved item/).first();
    await expect(judgeRow).toBeVisible({ timeout: 15_000 });
    // Expand (a passing row starts collapsed; a failing one is already open).
    if (await page.getByTestId('matcher-evaluator').count() === 0) await judgeRow.click();
    await expect(page.getByTestId('matcher-evaluator')).toBeVisible({ timeout: 10_000 });
  }

  test('no evaluator on the run → the judge row reads "evaluator: Claim" (system-claim), never the RCA rubric', async ({ page }) => {
    test.skip(!!skipReason, skipReason);
    await openJudgeRow(page, defaultRunId);
    const ev = page.getByTestId('matcher-evaluator');
    await expect(ev).toHaveText('Claim');
    await expect(ev).toHaveAttribute('title', 'system-claim');
  });

  test('explicit evaluatorId on the run → the judge row reads the chosen evaluator ("RCA Default")', async ({ page }) => {
    test.skip(!!skipReason, skipReason);
    await openJudgeRow(page, explicitRunId);
    const ev = page.getByTestId('matcher-evaluator');
    await expect(ev).toHaveText('RCA Default');
    await expect(ev).toHaveAttribute('title', 'system-rca-default');
  });

  test('Evaluators page lists the built-in "Claim" system evaluator', async ({ page }) => {
    test.skip(!!skipReason, skipReason);
    await page.goto('/evaluators');
    const row = page.getByRole('button', { name: /^Claim\b/ }).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toContainText('System');
    await expect(row).toContainText(/satisfies each stated claim/);
  });
});
