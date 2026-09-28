/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration: the LEGACY `POST /api/storage/benchmarks/:id/execute` route must
 * give every test case its OWN OTel trace, stamp each report with the real W3C
 * trace id of its eval span, keep the connector run id on `runId`, and let the
 * trace poller resolve every report.
 *
 * Real path end-to-end against the running backend, with a real REST agent:
 *   POST /execute → services/benchmarkRunner.executeRun
 *     → RESTConnector (propagateHeader) → fixture agent adopts `traceparent`,
 *       exports OTLP spans to the backend's own `/v1/traces` receiver, answers
 *       `{ id: 'conv-…' }` (→ report.runId)
 *     → report persisted (metricsStatus: pending) → trace poller → judge
 *       (`demo-model` → mock judge) → metricsStatus: ready.
 *
 * Pre-fix (measured on a 3-case benchmark, `-c 3`):
 *   - every `test_case` span was a CHILD of the run's `test_suite_run` span, so
 *     all three agent invocations received the SAME `traceparent` trace id and
 *     one trace file held 25+ spans of unrelated cases;
 *   - `saveReportWithClient` wrote `traceId: report.runId`, so reports came back
 *     with `traceId === runId === 'conv-…'`;
 *   - the poller then filtered fetched spans with `span.traceId === 'conv-…'`
 *     → 0 spans → `Traces never arrived (kind=trace_timeout)` on 3/3 reports
 *     ("0/3 passed (3 errored — evaluator could not run)").
 *
 * Requires the backend to be running (AH_PORT) with OpenSearch storage — the
 * legacy route refuses file storage. Strategy-A assertions (report.traceId ==
 * the trace id the agent was handed) additionally need eval telemetry enabled
 * on the backend (`OTEL_EVAL_ENABLED=true`, exporter → the backend's own
 * `/v1/traces`); when it is off the test still asserts per-case isolation via
 * the agent's own trace ids and that every report resolves.
 */

import { getTestBackendUrl } from '@/tests/integration/testConfig';
import { createTestDataTracker, uniqueTestName } from '../../../../helpers/testDataTracker';
import { startTraceparentRestAgent, type TraceparentRestAgent } from '../../../../helpers/traceparentRestAgent';
import { isW3CTraceId } from '@/lib/traceIdentity';

const BASE_URL = getTestBackendUrl();
const TEST_TIMEOUT = 180_000;
const CASE_COUNT = 3;

async function backendReady(): Promise<boolean> {
  try {
    const health = await fetch(`${BASE_URL}/health`);
    if (!health.ok) return false;
    const storage = await (await fetch(`${BASE_URL}/api/storage/health`)).json();
    return storage.status === 'ok';
  } catch {
    return false;
  }
}

/** Read the /execute SSE stream to its end; returns every `data:` event. */
async function readExecuteStream(res: Response): Promise<any[]> {
  const events: any[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() || '';
    for (const frame of frames) {
      for (const line of frame.split('\n')) {
        if (line.startsWith('data: ')) {
          try { events.push(JSON.parse(line.slice(6))); } catch { /* partial */ }
        }
      }
    }
  }
  return events;
}

async function fetchTraceUntil(traceId: string, ready: (spans: any[]) => boolean, timeoutMs = 15_000): Promise<{ spans: any[] }> {
  const deadline = Date.now() + timeoutMs;
  let last: { spans: any[] } = { spans: [] };
  while (Date.now() < deadline) {
    last = await (await fetch(`${BASE_URL}/api/traces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ traceId, size: 200 }),
    })).json();
    if (ready(last.spans || [])) return last;
    await new Promise(r => setTimeout(r, 500));
  }
  return last;
}

describe('legacy POST /api/storage/benchmarks/:id/execute — one OTel trace per test case', () => {
  const tracker = createTestDataTracker();
  let ready = false;
  let agent: TraceparentRestAgent | null = null;
  let agentKey = '';
  let benchmarkId = '';
  const testCaseIds: string[] = [];
  const promptByTestCaseId = new Map<string, string>();

  beforeAll(async () => {
    ready = await backendReady();
    if (!ready) {
      console.warn(`[skip] backend at ${BASE_URL} is not up with OpenSearch storage — legacy /execute needs it`);
      return;
    }

    agent = await startTraceparentRestAgent({ otlpEndpoint: `${BASE_URL}/v1/traces` });

    const created = await fetch(`${BASE_URL}/api/agents/custom`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: uniqueTestName('traceparent-rest-agent'),
        endpoint: agent.url,
        connectorType: 'rest',
        useTraces: true,
      }),
    });
    expect(created.status).toBe(201);
    agentKey = (await created.json()).agent.key;
    tracker.customAgent(agentKey);

    for (let i = 1; i <= CASE_COUNT; i++) {
      const prompt = `search products ${i} (${uniqueTestName('q')})`;
      const res = await fetch(`${BASE_URL}/api/storage/test-cases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: uniqueTestName(`legacy-trace-case-${i}`),
          category: 'RCA',
          difficulty: 'Easy',
          initialPrompt: prompt,
          expectedOutcomes: ['returns a product'],
          context: [],
        }),
      });
      const body = await res.json();
      const id = (body.testCase ?? body).id as string;
      tracker.testCase(id);
      testCaseIds.push(id);
      promptByTestCaseId.set(id, prompt);
    }

    const bench = await fetch(`${BASE_URL}/api/storage/benchmarks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: uniqueTestName('legacy-trace-per-case'), description: 'integration', testCaseIds }),
    });
    const benchBody = await bench.json();
    benchmarkId = (benchBody.benchmark ?? benchBody).id;
    tracker.benchmark(benchmarkId);
  }, TEST_TIMEOUT);

  afterAll(async () => {
    await agent?.close();
    await tracker.cleanup();
  }, 60_000);

  it(
    'runs N cases concurrently under N distinct traces, stamps W3C traceIds (never the connector id) and resolves every report',
    async () => {
      if (!ready) return;

      const res = await fetch(`${BASE_URL}/api/storage/benchmarks/${encodeURIComponent(benchmarkId)}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'legacy-route trace isolation', agentKey, modelId: 'demo-model', concurrency: CASE_COUNT }),
      });
      expect(res.ok).toBe(true);
      const events = await readExecuteStream(res);
      const terminal = events.find(e => e.type === 'completed' || e.type === 'cancelled' || e.type === 'error');
      expect(terminal?.type).toBe('completed');
      const run = terminal.run;
      const results = Object.entries(run.results) as Array<[string, any]>;
      expect(results).toHaveLength(CASE_COUNT);
      for (const [, r] of results) tracker.run(r.reportId);
      expect(results.every(([, r]) => r.status === 'completed' && r.reportId)).toBe(true);

      // --- the agent's view: one invocation per case, each in its own trace ---
      expect(agent!.invocations).toHaveLength(CASE_COUNT);
      const agentTraceIds = new Set(agent!.invocations.map(i => i.traceId));
      expect(agentTraceIds.size).toBe(CASE_COUNT);
      const telemetryOn = agent!.invocations.every(i => !!i.traceparent);
      if (telemetryOn) {
        // Every case was handed a DIFFERENT traceparent (pre-fix: identical).
        const handed = new Set(agent!.invocations.map(i => i.traceparent!.split('-')[1]));
        expect(handed.size).toBe(CASE_COUNT);
      }

      // --- the persisted reports ---
      const reports = await Promise.all(results.map(async ([testCaseId, r]) => {
        const body = await (await fetch(`${BASE_URL}/api/storage/runs/${encodeURIComponent(r.reportId)}`)).json();
        return { testCaseId, ...(body.run ?? body) };
      }));

      const reportTraceIds = new Set<string>();
      for (const report of reports) {
        const invocation = agent!.invocations.find(i => i.prompt === promptByTestCaseId.get(report.testCaseId));
        expect(invocation).toBeDefined();

        // Resolved — not "Traces never arrived".
        expect(report.metricsStatus).toBe('ready');
        expect(report.traceError).toBeFalsy();
        expect(report.traceFetchAttempts).toBe(1);
        expect(['passed', 'failed']).toContain(report.passFailStatus);

        // Connector id stays on runId; traceId is a real W3C id and never the connector id.
        expect(report.runId).toBe(invocation!.conversationId);
        expect(isW3CTraceId(report.traceId)).toBe(true);
        expect(report.traceId).not.toBe(report.runId);
        reportTraceIds.add(report.traceId);
        if (telemetryOn) {
          // Strategy A: the report's traceId IS the trace the agent adopted.
          expect(report.traceId).toBe(invocation!.traceId);
        }

        // The trace behind report.traceId holds ONLY this case's agent spans.
        // (The eval span itself is exported by a batch processor, so give it a
        // few seconds to land before asserting on it.)
        const traces = await fetchTraceUntil(report.traceId, (spans) =>
          !telemetryOn || spans.some(s => s.name === 'test_case' && !s.parentSpanId));
        const convIds = new Set(
          (traces.spans as any[])
            .map(s => s.attributes?.['gen_ai.conversation.id'])
            .filter((v): v is string => typeof v === 'string' && v.startsWith('conv-'))
        );
        if (telemetryOn) {
          expect(Array.from(convIds)).toEqual([invocation!.conversationId]);
          // The eval test_case span that carried the traceparent is the trace
          // ROOT — the suite relationship is a span link, not parentage — and
          // the run's test_suite_run span lives in ITS OWN trace.
          const spans = traces.spans as any[];
          expect(spans.some(s => s.name.startsWith('test_suite_run'))).toBe(false);
          const rootEvalSpans = spans.filter(s => s.name === 'test_case' && !s.parentSpanId);
          expect(rootEvalSpans.length).toBeGreaterThan(0);
          expect(rootEvalSpans[0].links).toEqual([
            expect.objectContaining({ attributes: { 'agent_health.link.type': 'test_suite_run' } }),
          ]);
          // The agent's root span hangs off that eval span (W3C context adopted).
          const agentRoot = spans.find(s => s.name.startsWith('invoke_agent'));
          expect(agentRoot?.parentSpanId).toBe(invocation!.parentSpanId);
        }
      }
      expect(reportTraceIds.size).toBe(CASE_COUNT);
    },
    TEST_TIMEOUT
  );
});
