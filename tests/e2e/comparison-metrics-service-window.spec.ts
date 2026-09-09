/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E regression: the comparison scoreboard's Cost / Tokens / LLM Calls
 * rendered "--" for an ENTIRE run whenever its reports carried no correlation
 * id (no runId / sessionId / traceId — what a REST-connector agent produces
 * when its response echoes nothing agent-health recognizes), even though the
 * Traces tab found the run's spans by service.name + time window.
 *
 * Asserts the whole client-side contract end to end:
 *   1. Reports with no runId are NOT skipped — they are requested under their
 *      own report id.
 *   2. The batch metrics request carries an `agents` Strategy-C hint for each
 *      such report, derived from the agent's configured `traceServiceName`
 *      (served by /api/agents) and the report's timestamp / durationMs — the
 *      same derivation the trace judge uses.
 *   3. Metrics returned under the report-id key render on the run row.
 *   4. A run whose reports DO have run ids still works exactly as before.
 *
 * Deterministic: storage, agents and metrics are mocked via page.route();
 * synthetic fixtures only.
 */

import { test, expect, mockDeepDiveJob } from './fixtures/test-fixtures';
import type { Route } from '@playwright/test';

const RUN_REST = 'eval-run-window-rest';
const RUN_IDS = 'eval-run-window-ids';
const TC = 'tc-window-shared';
const REPORT_REST = 'rep-window-rest'; // no runId/sessionId/traceId
const REPORT_IDS = 'rep-window-ids';   // has a runId
const REST_AGENT_KEY = 'example-rest-agent';
const REST_SERVICE_NAME = 'example-rest-agent-otel-service';
const REPORT_TS = '2026-03-05T10:00:30.000Z';
const REPORT_DURATION_MS = 30_000;

const evalRun = (id: string, agentKey: string, reportId: string) => ({
  id,
  docType: 'evaluation-run',
  name: `Window Run ${agentKey}`,
  createdAt: '2026-03-05T10:00:00Z',
  status: 'completed',
  agentKey,
  modelId: 'claude-sonnet-4-20250514',
  sources: [{ type: 'test-case-ids', ids: [TC] }],
  trigger: 'cli',
  testCaseSnapshots: [{ id: TC, version: 1, name: 'Window Shared Case' }],
  results: { [TC]: { reportId, status: 'completed', passFailStatus: 'passed' } },
  stats: { passed: 1, failed: 0, total: 1 },
});

const restReport = {
  id: REPORT_REST,
  createdAt: REPORT_TS,
  testCaseId: TC,
  agentId: REST_AGENT_KEY,
  connectorProtocol: 'rest',
  modelId: 'claude-sonnet-4-20250514',
  status: 'completed',
  passFailStatus: 'passed',
  metrics: { accuracy: 90 },
  performanceMetrics: { durationMs: REPORT_DURATION_MS },
  trajectory: [],
  // deliberately: no runId, no sessionId, no traceId
};

const idsReport = {
  id: REPORT_IDS,
  createdAt: '2026-03-05T10:00:00Z',
  testCaseId: TC,
  agentId: 'demo',
  connectorProtocol: 'mock',
  modelId: 'claude-sonnet-4-20250514',
  status: 'completed',
  passFailStatus: 'passed',
  metrics: { accuracy: 80 },
  performanceMetrics: { durationMs: 5000 },
  trajectory: [],
  runId: 'mock-run-777',
};

const metricsFor = (runId: string, inputTokens: number, llmCalls: number) => ({
  runId,
  traceId: 'trace-' + runId,
  inputTokens,
  outputTokens: 100,
  totalTokens: inputTokens + 100,
  costUsd: inputTokens / 1e6 * 3 + 100 / 1e6 * 15,
  durationMs: 12_000,
  llmCalls,
  toolCalls: 2,
  toolsUsed: ['search', 'lookup'],
  status: 'success',
  hasSpans: true,
});

async function json(route: Route, body: unknown) {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

test.describe('Comparison scoreboard — Strategy-C (service.name + window) metrics for reports with no correlation id', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/storage/benchmarks**', (route) => json(route, { benchmarks: [], total: 0 }));
    await page.route('**/api/storage/test-cases**', (route) => json(route, { testCases: [], total: 0 }));
    // The agent config the compare page reads traceServiceName from.
    await page.route('**/api/agents**', (route) => json(route, {
      agents: [
        { key: 'demo', name: 'Demo Agent', endpoint: 'mock://demo', connectorType: 'mock', builtIn: true },
        { key: REST_AGENT_KEY, name: 'Example REST agent', endpoint: 'http://127.0.0.1:1/ask', connectorType: 'rest', traceServiceName: REST_SERVICE_NAME, builtIn: false },
      ],
      total: 2,
      meta: { source: 'config', hasCustomAgents: true, customCount: 1, builtInCount: 1 },
    }));
    await page.route('**/api/storage/evaluation-runs**', (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith(`/evaluation-runs/${RUN_REST}`)) return json(route, evalRun(RUN_REST, REST_AGENT_KEY, REPORT_REST));
      if (url.pathname.endsWith(`/evaluation-runs/${RUN_IDS}`)) return json(route, evalRun(RUN_IDS, 'demo', REPORT_IDS));
      if (url.pathname.endsWith('/evaluation-runs')) {
        return json(route, { evaluationRuns: [evalRun(RUN_REST, REST_AGENT_KEY, REPORT_REST), evalRun(RUN_IDS, 'demo', REPORT_IDS)], total: 2 });
      }
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    });
    await page.route(/\/api\/storage\/runs\?ids=/, (route) => {
      const ids = (new URL(route.request().url()).searchParams.get('ids') || '').split(',');
      const runs: unknown[] = [];
      if (ids.includes(REPORT_REST)) runs.push(restReport);
      if (ids.includes(REPORT_IDS)) runs.push(idsReport);
      return json(route, { runs, total: runs.length });
    });
    await page.route('**/api/storage/runs/**', (route) => {
      const url = route.request().url();
      if (url.includes(REPORT_REST)) return json(route, restReport);
      if (url.includes(REPORT_IDS)) return json(route, idsReport);
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    });
    await mockDeepDiveJob(page, { result: { markdown: 'stub', modelId: 'stub/model', durationMs: 1, runs: [] } });
  });

  test('a no-runId REST report is requested under its report id with a service-window hint, and its metrics render on the row', async ({ page }) => {
    const batchBodies: any[] = [];
    await page.route('**/api/metrics/batch**', (route) => {
      const body = route.request().postDataJSON();
      batchBodies.push(body);
      // Echo metrics back under exactly the keys requested — a real server
      // returns results under the caller's keys too.
      const metrics = (body.runIds as string[]).map((key) =>
        key === REPORT_REST ? metricsFor(key, 250_000, 6) : metricsFor(key, 4_000, 1));
      return json(route, { metrics, aggregate: {} });
    });

    await page.goto(`/compare?runs=${RUN_REST},${RUN_IDS}`);
    await page.waitForSelector('[data-testid="comparison-scoreboard"]', { timeout: 30000 });

    // (1)+(2) the request contract
    await expect.poll(() => batchBodies.length, { timeout: 15000 }).toBeGreaterThan(0);
    const body = batchBodies[batchBodies.length - 1];
    expect(body.runIds).toEqual(expect.arrayContaining([REPORT_REST, 'mock-run-777']));
    expect(body.agents).toBeDefined();
    const hint = body.agents[REPORT_REST];
    expect(Array.isArray(hint) && hint.length === 1).toBe(true);
    expect(hint[0].serviceName).toBe(REST_SERVICE_NAME);
    // Symmetric window around the report timestamp: ±(durationMs + 60s slack),
    // identical to buildJudgeAgentsHints (the trace judge's derivation).
    const ts = Date.parse(REPORT_TS);
    expect(hint[0].startedAt).toBe(ts - (REPORT_DURATION_MS + 60_000));
    expect(hint[0].endedAt).toBe(ts + (REPORT_DURATION_MS + 60_000));
    // The mock-connector run has a real runId and a protocol whose service
    // name is unknowable => no fabricated hint for it.
    expect(body.agents['mock-run-777']).toBeUndefined();

    // (3) the rendered result — the REST run row is populated, not "--".
    const restCost = page.locator(`[data-testid="run-cost-${RUN_REST}"]`);
    const restTokens = page.locator(`[data-testid="run-tokens-${RUN_REST}"]`);
    const restLlm = page.locator(`[data-testid="run-llmcalls-${RUN_REST}"]`);
    await expect(restTokens).toContainText('250.1K');
    await expect(restLlm).toHaveText('6');
    await expect(restCost).not.toHaveText('--');
    await expect(restCost).toContainText('$');

    // (4) the run with real ids still renders its own numbers.
    await expect(page.locator(`[data-testid="run-tokens-${RUN_IDS}"]`)).toContainText('4.1K');
    await expect(page.locator(`[data-testid="run-llmcalls-${RUN_IDS}"]`)).toHaveText('1');
  });

  test('when the metrics API returns no spans for the windowed key, the row stays an honest "--" (no fabricated $0)', async ({ page }) => {
    await page.route('**/api/metrics/batch**', (route) => {
      const body = route.request().postDataJSON();
      const metrics = (body.runIds as string[]).map((key) => ({
        runId: key, traceId: null, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0,
        durationMs: 0, llmCalls: 0, toolCalls: 0, toolsUsed: [], status: 'pending', hasSpans: false,
      }));
      return json(route, { metrics, aggregate: {} });
    });

    await page.goto(`/compare?runs=${RUN_REST},${RUN_IDS}`);
    await page.waitForSelector('[data-testid="comparison-scoreboard"]', { timeout: 30000 });

    await expect(page.locator(`[data-testid="run-cost-${RUN_REST}"]`)).toHaveText('--');
    await expect(page.locator(`[data-testid="run-tokens-${RUN_REST}"]`)).toHaveText('--');
    await expect(page.locator(`[data-testid="run-llmcalls-${RUN_REST}"]`)).toHaveText('--');
  });
});
