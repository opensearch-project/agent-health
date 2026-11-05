/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Run report → Traces tab: precise-first correlation (one root span per run).
 *
 * Repro of the reported bug: a benchmark run at concurrency > 1 produced
 * neighbouring runs of the same agent inside every case's wall-clock window,
 * and the Traces tab — which unioned the exact correlators with the
 * service-name window (Strategy C) — rendered THREE root spans / dozens of
 * foreign spans for a single invocation.
 *
 * Real stack, no request mocks: spans are ingested through the embedded OTLP
 * receiver into the file trace store, reports are seeded through the storage
 * API, and the page issues the real `/api/traces` query. Two scenarios:
 *   1. run A correlates by trace id → exactly its own tree, captioned
 *      "Matched by trace id", none of run B's spans;
 *   2. run C is a Strategy-C-only agent (no run id / trace id on its spans)
 *      → the window fallback is used, run B's tagged spans are filtered out,
 *      and the caption says how many were dropped.
 */

import { test, expect } from './fixtures/test-fixtures';
import type { Page, APIRequestContext } from '@playwright/test';

const stamp = Date.now();
// Unique per run so a quick re-run can't see the previous run's spans inside
// the window; the `<agentKey>-agent` convention resolves the service name.
const AGENT_KEY = `e2e-retrieval-${stamp}`;
const SERVICE = `${AGENT_KEY}-agent`;
const T0 = stamp - 5 * 60_000; // five minutes ago: inside every report's lookback window
const NS = (ms: number) => `${ms}000000`;

const RUN_A = `run-a-${stamp}`;
const RUN_B = `run-b-${stamp}`;
const RUN_C = `run-c-${stamp}`;
const hex32 = (prefix: string) => (prefix + stamp.toString(16)).padEnd(32, '0').slice(0, 32);
const TRACE_A = hex32('aaaa');
const TRACE_B = hex32('bbbb');
const TRACE_C = hex32('cccc');
const REPORT_A = `e2e-precise-first-a-${stamp}`;
const REPORT_C = `e2e-precise-first-c-${stamp}`;

interface SpanSpec { traceId: string; spanId: string; parentSpanId?: string; name: string; startMs: number; attrs?: Record<string, string> }

function otlpPayload(spans: SpanSpec[]) {
  return {
    resourceSpans: [{
      resource: { attributes: [{ key: 'service.name', value: { stringValue: SERVICE } }] },
      scopeSpans: [{
        scope: { name: 'e2e.tracer' },
        spans: spans.map((s) => ({
          traceId: s.traceId,
          spanId: s.spanId,
          ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
          name: s.name,
          kind: 2,
          startTimeUnixNano: NS(s.startMs),
          endTimeUnixNano: NS(s.startMs + 400),
          attributes: Object.entries(s.attrs ?? {}).map(([key, v]) => ({ key, value: { stringValue: v } })),
          status: { code: 1 },
        })),
      }],
    }],
  };
}

const sid = (p: string, n: number) => (p + n.toString(16)).padEnd(16, '0').slice(0, 16);

function tree(traceId: string, prefix: string, startMs: number, toolName: string, attrs?: Record<string, string>): SpanSpec[] {
  return [
    { traceId, spanId: sid(prefix, 1), name: 'POST /invoke', startMs, attrs },
    { traceId, spanId: sid(prefix, 2), parentSpanId: sid(prefix, 1), name: 'chat', startMs: startMs + 50, attrs },
    { traceId, spanId: sid(prefix, 3), parentSpanId: sid(prefix, 1), name: `execute_tool ${toolName}`, startMs: startMs + 150, attrs },
  ];
}

function report(id: string, runId: string, traceId: string) {
  return {
    id,
    createdAt: new Date(T0 + 30_000).toISOString(), // saved 30s after the agent started
    agentId: AGENT_KEY,
    agentKey: AGENT_KEY,
    modelId: 'demo-model',
    testCaseId: `e2e-precise-first-tc-${stamp}`,
    trajectory: [{ type: 'assistant', content: 'done' }],
    status: 'completed',
    passFailStatus: 'passed',
    metricsStatus: 'ready',
    runId,
    traceId,
    performanceMetrics: { durationMs: 20_000 },
    metrics: { accuracy: 100 },
  };
}

async function openTracesTab(page: Page, reportId: string) {
  const tracesResponse = page.waitForResponse((r) => r.url().includes('/api/traces') && r.request().method() === 'POST');
  await page.goto(`/runs/${reportId}`);
  await page.getByRole('tab', { name: /Traces/ }).click();
  return (await tracesResponse).json();
}

async function fileBackend(request: APIRequestContext): Promise<boolean> {
  const health = await request.get('/api/traces/health');
  return health.ok() && (await health.json()).backend === 'file';
}

test.describe('Run report Traces tab — precise-first correlation', () => {
  test.beforeAll(async ({ request }) => {
    if (!(await fileBackend(request))) return;
    // Run A and run B: same service, overlapping wall-clock, each tagged with
    // its own run id (A via the OTEL-standard attribute, B via ours). Run C's
    // agent is Strategy-C-only — its spans carry neither run id nor our trace
    // id (the 'dddd' tree). A third-party-id tree ('ffff') fills the OTEL
    // ids with its own thread id and must never be mistaken for another run.
    await request.post('/v1/traces', {
      data: otlpPayload([
        ...tree(TRACE_A, 'a', T0, 'search products', { 'gen_ai.conversation.id': RUN_A }),
        ...tree(TRACE_B, 'b', T0 + 2_000, 'search orders', { 'agent_health.run.id': RUN_B, 'gen_ai.conversation.id': RUN_B }),
        ...tree(hex32('dddd'), 'd', T0 + 4_000, 'search inventory'),
        ...tree(hex32('ffff'), 'f', T0 + 6_000, 'search reviews', { 'gen_ai.conversation.id': 'thread-42' }),
      ]),
    });
    await request.post('/api/storage/runs', { data: report(REPORT_A, RUN_A, TRACE_A) });
    await request.post('/api/storage/runs', { data: report(REPORT_C, RUN_C, TRACE_C) });
  });

  test.afterAll(async ({ request }) => {
    for (const id of [REPORT_A, REPORT_C]) {
      await request.delete(`/api/storage/runs/${encodeURIComponent(id)}`).catch(() => {});
    }
  });

  test('a run that correlates by trace id shows exactly ONE root and none of the neighbouring run\'s spans', async ({ page, request }) => {
    test.skip(!(await fileBackend(request)), 'needs the file trace backend (no OpenSearch observability cluster)');

    const body = await openTracesTab(page, REPORT_A);

    // The real API response the tab rendered from: one tree, no run-B spans.
    const spans: any[] = body.spans;
    expect(spans).toHaveLength(3);
    expect(spans.filter((s) => !s.parentSpanId)).toHaveLength(1);
    expect(spans.every((s) => s.traceId === TRACE_A)).toBe(true);
    expect(spans.some((s) => s.name.includes('search orders'))).toBe(false);
    expect(body.correlation).toEqual({ strategy: 'traceId', windowFiltered: 0 });

    // Rendered surface: span badge counts only this run, and the caption names the exact match.
    await expect(page.getByTestId('trace-timeline-chart')).toBeVisible();
    await expect(page.getByRole('tab', { name: /Traces/ })).toContainText('3');
    const caption = page.getByTestId('trace-correlation-caption');
    await expect(caption).toHaveText('Matched by trace id');
    await expect(caption).toHaveAttribute('data-strategy', 'traceId');
  });

  test('a Strategy-C-only run falls back to the window, drops other runs\' traces and says so', async ({ page, request }) => {
    test.skip(!(await fileBackend(request)), 'needs the file trace backend (no OpenSearch observability cluster)');

    const body = await openTracesTab(page, REPORT_C);

    const spans: any[] = body.spans;
    // Run B (Agent Health's own run id, another run) is dropped whole; run A
    // (OTEL-standard id only — positive-match attribute, never negative
    // evidence), the untagged tree and the third-party-id tree are kept.
    expect(spans.some((s) => s.name.includes('search orders'))).toBe(false);
    expect(spans.some((s) => s.attributes?.['agent_health.run.id'])).toBe(false);
    expect(spans.some((s) => s.name.includes('search inventory'))).toBe(true);
    expect(spans.some((s) => s.name.includes('search reviews'))).toBe(true);
    expect(spans).toHaveLength(9);
    expect(spans.filter((s) => !s.parentSpanId)).toHaveLength(3);
    expect(body.correlation).toEqual({ strategy: 'window', windowFiltered: 3 });

    await expect(page.getByTestId('trace-timeline-chart')).toBeVisible();
    await expect(page.getByRole('tab', { name: /Traces/ })).toContainText('9');
    const caption = page.getByTestId('trace-correlation-caption');
    await expect(caption).toHaveText('Matched by service-name window — 3 spans from other runs filtered');
    await expect(caption).toHaveAttribute('data-strategy', 'window');
  });
});
