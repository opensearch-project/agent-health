/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E: the New Run page's Judge Model dropdown labels the "Agent Trace Judge"
 * entry with the LLM the server would ACTUALLY judge with.
 *
 * `agent-trace-judge` is a PROVIDER whose underlying model is picked at run
 * time from the pi registry. `GET /api/judge/models` reports that pick as
 * `resolvedModel`; the option must read
 * "Agent Trace Judge (…) — Claude Sonnet 4.5 (Global)" so the user knows
 * which LLM is behind the judge before starting a run. Plain provider
 * entries render their display name only.
 *
 * Network is mocked at the route boundary (the catalog + the model list), so
 * this neither needs the pi SDK nor credentials on the CI backend.
 */

import type { Route } from '@playwright/test';
import { test, expect } from './fixtures/test-fixtures';

async function json(route: Route, body: unknown) {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

const SONNET_45 = 'amazon-bedrock/global.anthropic.claude-sonnet-4-5-20250929-v1:0';

const models = [
  { key: 'claude-sonnet-4.6', model_id: 'us.anthropic.claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6', provider: 'bedrock', context_window: 200000, max_output_tokens: 8192 },
  { key: 'agent-trace-judge', model_id: 'agent-trace-judge', display_name: 'Agent Trace Judge (pi SDK + query_spans)', provider: 'agent', context_window: 200000, max_output_tokens: 16384 },
];

test.describe('New Run page — Agent Trace Judge option shows its resolved underlying model', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/models', (route) => json(route, { models, total: models.length, meta: { source: 'config' } }));
    await page.route('**/api/judge/models', (route) =>
      json(route, {
        total: models.length,
        models: [
          models[0],
          { ...models[1], resolvedModel: SONNET_45, resolvedModelName: 'Claude Sonnet 4.5 (Global)', resolvedSource: 'auto', pinEnv: 'AH_AGENT_JUDGE_MODEL_ID' },
        ],
      }));
    await page.route('**/api/storage/benchmarks**', (route) => json(route, { benchmarks: [], total: 0 }));
    // One mocked test case so step 1 ("Add Sources") has something to tick --
    // the Judge Model select lives on step 2 ("Configure").
    const now = new Date().toISOString();
    const tc = { id: 'tc-judge-e2e', name: 'Judge label e2e case', description: '', labels: [], currentVersion: 1, createdAt: now, updatedAt: now, isPromoted: false,
      versions: [{ version: 1, createdAt: now, initialPrompt: 'p', context: [], expectedOutcomes: ['x'] }], initialPrompt: 'p', context: [], expectedOutcomes: ['x'] };
    await page.route('**/api/storage/test-cases**', (route) => json(route, { testCases: [tc], total: 1 }));
    await page.route('**/api/storage/evaluators', (route) => json(route, { evaluators: [], total: 0 }));
  });

  test('dropdown option reads "Agent Trace Judge (…) — Claude Sonnet 4.5 (Global)"; bedrock option unchanged', async ({ page }) => {
    await page.goto('/evaluations/runs/new');
    // Step 1: tick the seeded test case, go to the Configure step.
    const caseRow = page.locator('label', { hasText: 'Judge label e2e case' });
    await expect(caseRow).toBeVisible({ timeout: 15000 });
    await caseRow.locator('input[type="checkbox"]').check();
    await page.getByRole('button', { name: /Add 1 selected/ }).click();
    await page.getByRole('button', { name: /Next: Configure/ }).click();

    // Open the Judge Model select (Radix: the trigger is a combobox next to the label).
    const judgeLabel = page.locator('label:has-text("Judge Model")').first();
    await expect(judgeLabel).toBeVisible({ timeout: 10000 });
    const trigger = judgeLabel.locator('xpath=following::button[@role="combobox"][1]');
    await trigger.click();

    const agentOption = page.getByRole('option', { name: /Agent Trace Judge/ });
    await expect(agentOption).toBeVisible({ timeout: 10000 });
    await expect(agentOption).toContainText('Agent Trace Judge (pi SDK + query_spans) — Claude Sonnet 4.5 (Global)');
    await expect(agentOption).toHaveAttribute('data-resolved-judge-model', SONNET_45);

    const bedrockOption = page.getByRole('option', { name: /^Claude Sonnet 4\.6$/ });
    await expect(bedrockOption).toBeVisible();
    await expect(bedrockOption).not.toContainText('—');
  });
});
