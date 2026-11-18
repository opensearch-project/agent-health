/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * #640 — the run inspector's Traces tab builds its Strategy-C window around
 * the RUN, not around the moment the tab is opened.
 *
 * The report is persisted through the REAL storage API of the backend under
 * test (file storage in CI — the adapter that writes `timestamp` but no
 * `createdAt`, the shape the client failed to map). Only `/api/traces` is
 * stubbed at the network boundary, so the test can capture the exact request
 * the inspector sends and answer it with spans the way CloudWatch does.
 *
 * Red on main: the captured `agents[0].endedAt` was ≈ now + 60 s for a run
 * that happened two hours earlier; the real CloudWatch backend then narrowed
 * the exact-id scan to that stale window and the tab read "No traces available".
 */

import { test, expect } from './fixtures/test-fixtures';

const RUN_ID = `e2e-640-run-${Date.now()}`;
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const RUN_STARTED_MS = Date.now() - TWO_HOURS_MS;
const RUN_DURATION_MS = 74_000;
const SLACK_MS = 60_000; // RunDetailsContent's window slack
const iso = (ms: number) => new Date(ms).toISOString();

const spans = [
  {
    traceId: 'e2e640aaaaaaaaaaaaaaaaaaaaaaaaaa', spanId: 'root-640', parentSpanId: '',
    name: 'POST /invoke', startTime: iso(RUN_STARTED_MS), endTime: iso(RUN_STARTED_MS + RUN_DURATION_MS),
    duration: RUN_DURATION_MS, status: 'OK',
    attributes: { 'service.name': 'demo-retrieval-agent', 'agent_health.run.id': RUN_ID, 'session.id': RUN_ID, spanKind: 'SERVER' },
    events: [],
  },
  {
    traceId: 'e2e640aaaaaaaaaaaaaaaaaaaaaaaaaa', spanId: 'chat-640', parentSpanId: 'root-640',
    name: 'chat demo-model', startTime: iso(RUN_STARTED_MS + 500), endTime: iso(RUN_STARTED_MS + 9_500),
    duration: 9_000, status: 'OK',
    attributes: { 'service.name': 'demo-retrieval-agent', 'agent_health.run.id': RUN_ID, 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'demo-model', 'gen_ai.usage.input_tokens': 1200, 'gen_ai.usage.output_tokens': 300, spanKind: 'CLIENT' },
    events: [],
  },
  {
    traceId: 'e2e640aaaaaaaaaaaaaaaaaaaaaaaaaa', spanId: 'tool-640', parentSpanId: 'root-640',
    name: 'execute_tool search_documents', startTime: iso(RUN_STARTED_MS + 10_000), endTime: iso(RUN_STARTED_MS + 12_000),
    duration: 2_000, status: 'OK',
    attributes: { 'service.name': 'demo-retrieval-agent', 'agent_health.run.id': RUN_ID, 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'search_documents', spanKind: 'INTERNAL' },
    events: [],
  },
];

test.describe('#640 — Traces tab window is derived from the stored run, not from now', () => {
  let reportId: string;
  /** What the backend stored as the run's time (OpenSearch: createdAt, file: timestamp). */
  let storedRunTimeMs: number;
  /** File adapter shape (`timestamp`, no `createdAt`) — the shape #640 is about. */
  let fileShaped = false;

  test.beforeAll(async ({ request }) => {
    const created = await request.post('/api/storage/runs', {
      data: {
        runId: RUN_ID,
        sessionId: RUN_ID,
        timestamp: iso(RUN_STARTED_MS),
        testCaseId: 'e2e-640-help-center-qa',
        testCaseVersion: 1,
        agentName: 'Demo Agent',
        agentId: 'demo-retrieval', // storage shape (server/services/storage/index.ts saveReportWithClient): agentId = the agent key
        modelId: 'demo-model',
        status: 'completed',
        passFailStatus: 'passed',
        trajectory: [],
        metrics: { accuracy: 100 },
        llmJudgeReasoning: 'Answer cites the right article.',
        performanceMetrics: { durationMs: RUN_DURATION_MS, totalSteps: 2, toolCalls: 1, llmCalls: 1 },
      },
    });
    expect(created.status(), await created.text()).toBe(201);
    const doc = await created.json();
    reportId = doc.id;
    // Backend-agnostic expectation: the client maps createdAt ?? timestamp.
    storedRunTimeMs = Date.parse(doc.createdAt ?? doc.timestamp);
    expect(Number.isFinite(storedRunTimeMs)).toBe(true);
    fileShaped = doc.createdAt === undefined;
    if (fileShaped) expect(storedRunTimeMs).toBe(RUN_STARTED_MS); // file storage keeps the run's own timestamp
  });

  test.afterAll(async ({ request }) => {
    if (reportId) await request.delete(`/api/storage/runs/${encodeURIComponent(reportId)}`).catch(() => {});
  });

  test('the inspector sends the run\'s window with its exact ids, and renders the spans', async ({ page }) => {
    const traceRequests: any[] = [];
    await page.route('**/api/traces', async (route) => {
      const body = JSON.parse(route.request().postData() || '{}');
      traceRequests.push(body);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ spans, total: spans.length, hasMore: false, nextCursor: null, backend: 'cloudwatch' }),
      });
    });
    await page.route('**/api/traces/health**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok', backend: 'cloudwatch' }) })
    );

    const openedAt = Date.now();
    await page.goto(`/runs/${encodeURIComponent(reportId)}`);
    await page.getByRole('tab', { name: /^Traces/ }).click();

    // Spans render (not "No traces available"): the tab badge counts them and
    // the view toolbar appears only when the span tree is non-empty.
    await expect(page.getByRole('tab', { name: /^Traces/ })).toContainText('3', { timeout: 15000 });
    await expect(page.getByRole('button', { name: 'Fullscreen' })).toBeVisible();
    await expect(page.getByText('No traces available')).toHaveCount(0);
    // The default Timeline view draws on a canvas; the Trace Tree view renders the span names as text.
    await page.getByRole('button', { name: 'Trace Tree' }).click();
    await expect(page.getByText('POST /invoke').first()).toBeVisible();
    await expect(page.getByText('execute_tool search_documents').first()).toBeVisible();

    // The request the inspector sent: exact ids + a window around the RUN.
    expect(traceRequests.length).toBeGreaterThanOrEqual(1);
    const req = traceRequests[0];
    expect(req.runIds).toEqual([RUN_ID]);
    expect(Array.isArray(req.agents)).toBe(true);
    expect(req.agents).toHaveLength(1);
    const [agent] = req.agents;
    expect(agent.sessionId).toBe(RUN_ID); // Strategy D hint rides on the window hint
    // endedAt = stored run time + slack; startedAt = endedAt - (durationMs + slack).
    expect(agent.endedAt).toBe(storedRunTimeMs + SLACK_MS);
    expect(agent.startedAt).toBe(storedRunTimeMs - RUN_DURATION_MS - SLACK_MS);
    // …and, on file storage, NOT a window built around the moment the tab was
    // opened (red on main: endedAt ≈ openedAt + 60 s). An OpenSearch-backed
    // backend stamps createdAt = save time, so there the two coincide by design.
    if (fileShaped) expect(Math.abs(agent.endedAt - openedAt)).toBeGreaterThan(60 * 60_000);
  });
});
