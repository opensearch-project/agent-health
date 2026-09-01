/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E2E regression for the round-2 "even trace-judged runs show `--`" bug hunt.
 *
 * Root cause (see CHANGELOG / server/services/metricsService.ts): the batch
 * metrics query only ever matched Strategy B (`agent_health.run.id` /
 * `gen_ai.conversation.id`), never Strategy D (`session.id`) — the precise
 * correlator closed-source connectors like Claude Code actually stamp. When
 * the observability cluster genuinely has no matching spans (`status:
 * "pending"`), `mergeTraceMetrics` now falls back to REAL non-trace data
 * instead of leaving every metric as a dash:
 *   - Avg Duration: report.performanceMetrics.durationMs (in addition to the
 *     pre-existing run.results[tc].performanceMetrics.durationMs fallback).
 *   - Tool Calls: counts real trajectory 'action' steps.
 *   - Cost / Tokens / LLM Calls stay '--' — no honest non-trace source exists
 *     for those, and the fix must NOT invent a fabricated proxy.
 *
 * Deterministic: storage + /api/metrics/batch are mocked via page.route(), no
 * real OpenSearch/trace cluster required.
 */

import { test, expect, mockDeepDiveJob } from './fixtures/test-fixtures';
import type { Route } from '@playwright/test';

const RUN_A = 'eval-run-notrace-a';
const RUN_B = 'eval-run-notrace-b';
const TC = 'tc-notrace-shared';

const evalRun = (id: string, agentKey: string, reportId: string) => ({
  id,
  docType: 'evaluation-run',
  name: `No-trace Run ${agentKey}`,
  createdAt: '2026-03-10T10:00:00Z',
  status: 'completed',
  agentKey,
  modelId: 'claude-sonnet-4-20250514',
  sources: [{ type: 'test-case-ids', ids: [TC] }],
  trigger: 'cli',
  testCaseSnapshots: [{ id: TC, version: 1, name: 'No-trace Shared Case' }],
  results: { [TC]: { reportId, status: 'completed', passFailStatus: 'passed' } },
  stats: { passed: 1, failed: 0, total: 1 },
});

// Mirrors the real EnterpriseRAG-84 report shape: performanceMetrics.durationMs
// and a real (non-empty) trajectory, but a `runId` the observability cluster
// has no spans for at all (simulated by the /api/metrics/batch mock below
// returning a zero-filled `status: "pending"` placeholder).
const report = (id: string, agentKey: string, runId: string, durationMs: number, toolCallCount: number) => ({
  id,
  createdAt: '2026-03-10T10:00:00Z',
  testCaseId: TC,
  agentId: agentKey,
  runId,
  modelId: 'claude-sonnet-4-20250514',
  status: 'completed',
  passFailStatus: 'passed',
  metrics: { accuracy: 80 },
  performanceMetrics: { durationMs, agentDurationMs: durationMs },
  trajectory: Array.from({ length: toolCallCount }, (_, i) => ({
    id: `t${i}`, timestamp: 0, type: 'action', content: '', toolName: 'some_tool',
  })),
});

async function json(route: Route, body: unknown) {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

test.describe('Comparison scoreboard — honest no-trace fallbacks (Duration + Tool Calls, never Cost/Tokens/LLM Calls)', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/storage/benchmarks**', (route) => json(route, { benchmarks: [], total: 0 }));
    await page.route('**/api/storage/test-cases**', (route) => json(route, { testCases: [], total: 0 }));
    await page.route('**/api/storage/evaluation-runs**', (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith(`/evaluation-runs/${RUN_A}`)) return json(route, evalRun(RUN_A, 'demo', 'rep-notrace-a'));
      if (url.pathname.endsWith(`/evaluation-runs/${RUN_B}`)) return json(route, evalRun(RUN_B, 'pulsar', 'rep-notrace-b'));
      if (url.pathname.endsWith('/evaluation-runs')) {
        return json(route, { evaluationRuns: [evalRun(RUN_A, 'demo', 'rep-notrace-a'), evalRun(RUN_B, 'pulsar', 'rep-notrace-b')], total: 2 });
      }
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    });
    await page.route(/\/api\/storage\/runs\?ids=/, (route) => {
      const ids = (new URL(route.request().url()).searchParams.get('ids') || '').split(',');
      const runs: unknown[] = [];
      if (ids.some((id) => id.includes('rep-notrace-a'))) runs.push(report('rep-notrace-a', 'demo', 'subprocess-notrace-a', 57000, 19));
      if (ids.some((id) => id.includes('rep-notrace-b'))) runs.push(report('rep-notrace-b', 'pulsar', 'subprocess-notrace-b', 22600, 5));
      return json(route, { runs, total: runs.length });
    });
    await page.route('**/api/storage/runs/**', (route) => {
      const url = route.request().url();
      if (url.includes('rep-notrace-a')) return json(route, report('rep-notrace-a', 'demo', 'subprocess-notrace-a', 57000, 19));
      if (url.includes('rep-notrace-b')) return json(route, report('rep-notrace-b', 'pulsar', 'subprocess-notrace-b', 22600, 5));
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    });
    // Simulates the real bug: no spans found for either runId (e.g. Strategy
    // D's session.id genuinely has no matching spans in the cluster) -> a
    // zero-filled "pending" placeholder per run, same as the real batch API.
    await page.route('**/api/metrics/batch**', (route) => {
      const body = JSON.parse(route.request().postData() || '{}');
      const runIds: string[] = body.runIds || [];
      const metrics = runIds.map((runId) => ({
        runId, traceId: null, inputTokens: 0, outputTokens: 0, totalTokens: 0,
        costUsd: 0, durationMs: 0, llmCalls: 0, toolCalls: 0, toolsUsed: [], status: 'pending',
      }));
      return json(route, { metrics, aggregate: {} });
    });
    await mockDeepDiveJob(page, { result: { markdown: 'stub', modelId: 'stub/model', durationMs: 1, runs: [] } });
  });

  test('Avg Duration and Tool Calls show real numbers; Cost/Tokens/LLM Calls stay "--" (no fabricated proxy)', async ({ page }) => {
    await page.goto(`/compare?runs=${RUN_A},${RUN_B}`);
    await page.waitForSelector('[data-testid="comparison-scoreboard"]', { timeout: 30000 });
    // Give the trace-metrics effect (fetchBatchMetrics) a moment to resolve
    // and re-render with the "pending" response before asserting.
    await page.waitForTimeout(1500);

    const rowA = page.locator('[data-testid="scoreboard-row-A"]');
    const rowB = page.locator('[data-testid="scoreboard-row-B"]');

    // Duration: real numbers, not dashes (57.0s / 22.6s, matching the real
    // EnterpriseRAG-84 report data this regression is modeled on).
    await expect(rowA).toContainText('57.0s');
    await expect(rowB).toContainText('22.6s');

    // Tool Calls: real trajectory-derived counts, not dashes.
    await expect(rowA).toContainText('19');
    await expect(rowB).toContainText('5');

    // Cost / Tokens / LLM Calls: honestly "--" (no trace data, no invented
    // proxy) -- each row should show exactly three dashes (cost, tokens, llm
    // calls) once duration/tool-calls are populated with real numbers.
    const rowAText = await rowA.innerText();
    const dashCount = (rowAText.match(/--/g) || []).length;
    expect(dashCount).toBe(3);
  });
});
