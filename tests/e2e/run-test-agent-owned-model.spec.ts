/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E: "Run Test" for an agent that owns its model, and a rejected run that
 * must never be silent.
 *
 * Regression for the "Run Test does nothing" report: for a `rest` agent whose
 * model is declared in its own connector config (a provider-native id, never a
 * catalog key) the run dialogs still sent a catalog `modelId` — the Test Case
 * Detail dialog even re-seeded it from the latest run, i.e. with the agent's
 * own id — the server answered `400 Model not found`, and neither surface
 * rendered the error (the detail page only showed errors inside the live
 * panel, which unmounts the moment the request fails).
 *
 * What we verify (rendered result, not implementation):
 *   1. Test Case Detail → Configure Run: an agent that owns its model shows
 *      the declared model read-only ("set by the agent"), Start Run sends NO
 *      `modelId`, and the run proceeds.
 *   2. Test Case Detail: a rejected `/api/evaluate` shows the server's own
 *      message in a persistent banner; Run Test is re-enabled.
 *   3. QuickRunModal: same two behaviours (no Agent Model dropdown for an
 *      owning agent; inline error on rejection with the Run button re-enabled).
 *
 * The owning agent is injected by intercepting `GET /api/agents` (the e2e
 * server only ships catalog-model demo agents; connector-owned CLIs can't run
 * in CI), and `/api/evaluate` is intercepted so the assertions are about the
 * UI contract: what the request carries and what the page renders. The real
 * server path for an owning agent is covered by
 * tests/integration/server/routes/evaluateModelOptional.integration.test.ts.
 */

import { test, expect } from './fixtures/test-fixtures';
import type { APIRequestContext, Page, Route } from '@playwright/test';
import { uniqueTestName, TestDataTracker } from '../helpers/testDataTracker';

const TEST_TIMEOUT = 120_000;
const OWNING_AGENT_KEY = 'e2e-retrieval-agent';
const OWNING_AGENT_NAME = 'E2E retrieval agent (declared model)';
const DECLARED_MODEL = 'provider.e2e-retrieval-deployment';
const REJECTION = { error: `Model not found: ${DECLARED_MODEL}. Agent 'demo' takes a catalog model; pass one of: demo-model`, code: 'MODEL_NOT_FOUND' };

/** Add a synthetic REST agent that owns its model to the /api/agents payload. */
async function injectOwningAgent(page: Page): Promise<void> {
  await page.route('**/api/agents', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.agents = [
      ...(body.agents || []),
      {
        key: OWNING_AGENT_KEY,
        name: OWNING_AGENT_NAME,
        endpoint: 'http://127.0.0.1:1/ask',
        connectorType: 'rest',
        connectorConfig: { model: DECLARED_MODEL },
        headers: {},
        builtIn: false,
        isCustom: true,
        modelOwnership: { ownsModel: true, declaredModelId: DECLARED_MODEL },
      },
    ];
    body.total = body.agents.length;
    await route.fulfill({ response, json: body });
  });
}

/** Intercept POST /api/evaluate: record the body, answer with a completed SSE for `reportId`. */
async function mockEvaluateCompleted(page: Page, reportId: string): Promise<{ bodies: any[] }> {
  const captured = { bodies: [] as any[] };
  await page.route('**/api/evaluate', async (route: Route) => {
    captured.bodies.push(route.request().postDataJSON());
    const frames = [
      { type: 'started', testCase: 'e2e', agent: OWNING_AGENT_NAME, reportId },
      { type: 'completed', reportId, report: { id: reportId, status: 'completed', passFailStatus: 'passed', metricsStatus: 'complete', metrics: { accuracy: 91 }, trajectorySteps: 1, llmJudgeReasoning: 'e2e mocked judge' } },
    ];
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      body: frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(''),
    });
  });
  return captured;
}

/** Intercept POST /api/evaluate with the server's pre-stream 400 shape. */
async function mockEvaluateRejected(page: Page): Promise<{ count: () => number }> {
  let n = 0;
  await page.route('**/api/evaluate', async (route: Route) => {
    n += 1;
    await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify(REJECTION) });
  });
  return { count: () => n };
}

async function createTestCase(request: APIRequestContext, testData: TestDataTracker, name: string): Promise<string> {
  const res = await request.post('/api/storage/test-cases', {
    data: {
      name,
      description: 'Created by e2e/run-test-agent-owned-model.spec.ts',
      labels: [],
      category: 'Custom',
      difficulty: 'Easy',
      isPromoted: false,
      initialPrompt: `owned-model-input-${Date.now()}: why is search slow?`,
      context: [],
      expectedOutcomes: ['names the alias'],
    },
  });
  expect(res.ok(), 'creating test case via storage API').toBe(true);
  const id: string = (await res.json()).id;
  testData.testCase(id);
  return id;
}

/** Persist a completed report the mocked `completed` SSE event can point at. */
async function createCompletedReport(request: APIRequestContext, testData: TestDataTracker, testCaseId: string, name: string): Promise<string> {
  const res = await request.post('/api/storage/runs', {
    data: {
      name,
      testCaseId,
      testCaseVersion: 1,
      agentKey: OWNING_AGENT_KEY,
      agentId: OWNING_AGENT_KEY,
      agentName: OWNING_AGENT_NAME,
      modelId: DECLARED_MODEL,
      modelName: DECLARED_MODEL,
      modelSource: 'agent',
      status: 'completed',
      passFailStatus: 'passed',
      metrics: { accuracy: 91 },
      trajectory: [{ id: 's1', timestamp: Date.now(), type: 'response', content: 'The alias is misconfigured.' }],
      llmJudgeReasoning: 'e2e mocked judge',
      timestamp: new Date().toISOString(),
    },
  });
  expect(res.ok(), 'creating report via storage API').toBe(true);
  const id: string = (await res.json()).id;
  testData.run(id);
  return id;
}

async function setPersistedAgent(page: Page, agentKey: string): Promise<void> {
  await page.evaluate((key) => localStorage.setItem('agent-health:prefs:agentKey', JSON.stringify(key)), agentKey);
}

test.describe('Run Test — agents that own their model + visible rejections', () => {
  test.setTimeout(TEST_TIMEOUT);

  test.beforeAll(async ({ request }) => {
    const healthRes = await request.get('/api/storage/health');
    if (!healthRes.ok()) test.skip(true, 'Backend storage not available');
  });

  test('Test Case Detail: owning agent shows its declared model read-only, sends no modelId, and the run lands', async ({ page, request, testData }) => {
    const name = uniqueTestName('owned-model-detail');
    const tcId = await createTestCase(request, testData, name);
    const reportId = await createCompletedReport(request, testData, tcId, 'Run owned');
    await injectOwningAgent(page);
    const evaluate = await mockEvaluateCompleted(page, reportId);

    await page.goto(`/evaluations/test-cases/${tcId}`);
    await expect(page.getByRole('heading', { level: 2 })).toContainText(name);
    // The seeded latest run belongs to the owning agent and carries its
    // provider-native model id — exactly the state that used to re-seed a
    // non-catalog `modelId` into the dialog.
    await page.getByRole('button', { name: /^run test$/i }).first().click();
    await expect(page.getByText('Configure Run', { exact: true })).toBeVisible();

    const dialog = page.locator('div.fixed', { hasText: 'Configure Run' });
    await expect(dialog.getByRole('combobox').first()).toContainText(OWNING_AGENT_NAME);
    const modelHint = page.getByTestId('tc-run-agent-model');
    await expect(modelHint).toContainText(DECLARED_MODEL);
    await expect(modelHint).toContainText('set by the agent');
    // No Agent Model picker anywhere in the dialog.
    await expect(dialog.getByText('Agent Model', { exact: true })).toHaveCount(0);

    await page.getByRole('button', { name: /^start run$/i }).click();

    await expect.poll(() => evaluate.bodies.length, { timeout: 15_000 }).toBe(1);
    expect(evaluate.bodies[0].agentKey).toBe(OWNING_AGENT_KEY);
    expect(evaluate.bodies[0]).not.toHaveProperty('modelId');

    // The run completed: no error banner, Run Test re-enabled, the report row is listed.
    await expect(page.getByTestId('run-error-banner')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^run test$/i }).first()).toBeEnabled({ timeout: 15_000 });
    await expect(page.getByText('Run owned').first()).toBeVisible();
  });

  test('Test Case Detail: a rejected run shows the server message in a persistent banner and re-enables Run Test', async ({ page, request, testData }) => {
    const name = uniqueTestName('rejected-run-detail');
    const tcId = await createTestCase(request, testData, name);
    const rejected = await mockEvaluateRejected(page);

    await page.goto(`/evaluations/test-cases/${tcId}`);
    await expect(page.getByRole('heading', { level: 2 })).toContainText(name);
    await page.getByRole('button', { name: /^run test$/i }).first().click();
    await expect(page.getByText('Configure Run', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: /^start run$/i }).click();

    const banner = page.getByTestId('run-error-banner');
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(banner).toContainText(`Model not found: ${DECLARED_MODEL}`);
    expect(rejected.count()).toBe(1);

    // Not stuck: the header button is back to "Run Test" and clickable.
    const runTest = page.getByRole('button', { name: /^run test$/i }).first();
    await expect(runTest).toBeEnabled();
    // The banner persists until dismissed.
    await page.waitForTimeout(1500);
    await expect(banner).toBeVisible();
    await banner.getByRole('button', { name: /dismiss run error/i }).click();
    await expect(banner).toHaveCount(0);
  });

  test('QuickRunModal: owning agent hides the Agent Model dropdown, sends no modelId, and shows the result', async ({ page, request, testData }) => {
    const name = uniqueTestName('owned-model-quickrun');
    const tcId = await createTestCase(request, testData, name);
    const reportId = await createCompletedReport(request, testData, tcId, 'Run owned quick');
    await injectOwningAgent(page);
    const evaluate = await mockEvaluateCompleted(page, reportId);

    await page.goto('/evaluations/test-cases');
    await page.waitForSelector('[data-testid="test-cases-page"]', { timeout: 30_000 });
    await setPersistedAgent(page, OWNING_AGENT_KEY);
    await page.reload();
    await page.waitForSelector('[data-testid="test-cases-page"]', { timeout: 30_000 });

    const row = page.locator('tr', { hasText: name }).first();
    await row.hover();
    await row.getByTestId('test-case-run-button').click();
    await expect(page.getByTestId('quickrun-agent-select')).toContainText(OWNING_AGENT_NAME);

    const owned = page.getByTestId('quickrun-agent-model-owned');
    await expect(owned).toBeVisible();
    await expect(owned).toContainText(DECLARED_MODEL);
    await expect(page.getByTestId('quickrun-agent-model-select')).toHaveCount(0);

    await page.getByTestId('quickrun-run-button').click();
    await expect.poll(() => evaluate.bodies.length, { timeout: 15_000 }).toBe(1);
    expect(evaluate.bodies[0].agentKey).toBe(OWNING_AGENT_KEY);
    expect(evaluate.bodies[0]).not.toHaveProperty('modelId');

    await expect(page.getByText('PASSED', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('quickrun-error')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /view run details/i })).toBeVisible();
  });

  test('QuickRunModal: a rejected run shows the server message inline and re-enables Run', async ({ page, request, testData }) => {
    const name = uniqueTestName('rejected-run-quickrun');
    await createTestCase(request, testData, name);
    const rejected = await mockEvaluateRejected(page);

    await page.goto('/evaluations/test-cases');
    await page.waitForSelector('[data-testid="test-cases-page"]', { timeout: 30_000 });
    // Catalog agent (demo) so the Agent Model dropdown IS shown — the
    // rejection path is independent of ownership.
    await setPersistedAgent(page, 'demo');
    await page.reload();
    await page.waitForSelector('[data-testid="test-cases-page"]', { timeout: 30_000 });

    const row = page.locator('tr', { hasText: name }).first();
    await row.hover();
    await row.getByTestId('test-case-run-button').click();
    await expect(page.getByTestId('quickrun-agent-model-select')).toBeVisible();

    const runButton = page.getByTestId('quickrun-run-button');
    await runButton.click();

    const error = page.getByTestId('quickrun-error');
    await expect(error).toBeVisible({ timeout: 15_000 });
    await expect(error).toContainText(`Model not found: ${DECLARED_MODEL}`);
    expect(rejected.count()).toBe(1);
    await expect(runButton).toBeEnabled();
    // Still there a moment later — not a transient flash.
    await page.waitForTimeout(1500);
    await expect(error).toBeVisible();
  });
});
