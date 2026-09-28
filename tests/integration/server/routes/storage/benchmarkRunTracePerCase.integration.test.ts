/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration: a benchmark run through `POST /api/storage/evaluation-runs`
 * (a single `{ type: 'benchmark' }` source — the ONLY benchmark execution path
 * now that the legacy `/execute` runner is gone) must give every test case its
 * OWN OTel trace, stamp each report with the real W3C trace id of its eval
 * span, keep the connector run id on `runId`, let the trace poller resolve
 * every report, and link the finished run into `benchmark.runs[]`.
 *
 * Real path end-to-end against the running backend, with a real REST agent:
 *   POST /api/storage/evaluation-runs → services/evaluationRunner.executeEvaluationRun
 *     → RESTConnector (propagateHeader) → fixture agent adopts `traceparent`,
 *       exports OTLP spans to the backend's own `/v1/traces` receiver, answers
 *       `{ id: 'conv-…' }` (→ report.runId)
 *     → report persisted (metricsStatus: pending) → trace poller → judge
 *       (`demo-model` → mock judge) → metricsStatus: ready.
 *
 * History: the removed legacy runner started every `test_case` span as a CHILD
 * of one `test_suite_run` span, so all N agent invocations received the SAME
 * `traceparent` trace id, and wrote `traceId: report.runId` — 0/N reports
 * resolved. This spec pins the per-case isolation on the surviving path.
 *
 * Also asserts the legacy route answers `410 Gone` with the documented body.
 *
 * Requires the backend to be running (AH_PORT); file or OpenSearch storage
 * both work. Strategy-A assertions (report.traceId == the trace id the agent
 * was handed) additionally need eval telemetry enabled on the backend
 * (`OTEL_EVAL_ENABLED=true`, exporter → the backend's own `/v1/traces`); when
 * it is off the test still asserts per-case isolation via the agent's own
 * trace ids and that every report resolves.
 */

import { getTestBackendUrl } from '@/tests/integration/testConfig';
import { createTestDataTracker, uniqueTestName } from '../../../../helpers/testDataTracker';
import { startTraceparentRestAgent, type TraceparentRestAgent } from '../../../../helpers/traceparentRestAgent';
import { isW3CTraceId } from '@/lib/traceIdentity';
import { LEGACY_EXECUTE_REMOVED } from '@/lib/legacyExecuteRemoved';

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

/**
 * Read the evaluation-runs SSE stream to its end; returns every frame as
 * `{ event, data }` (frames are `event: <type>\ndata: <json>`).
 */
async function readRunStream(res: Response): Promise<Array<{ event: string; data: any }>> {
  const events: Array<{ event: string; data: any }> = [];
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
      let event = '';
      let data = '';
      for (const line of frame.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7);
        else if (line.startsWith('data: ')) data = line.slice(6);
      }
      if (!data) continue;
      try { events.push({ event, data: JSON.parse(data) }); } catch { /* partial */ }
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

describe('benchmark run via POST /api/storage/evaluation-runs — one OTel trace per test case', () => {
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
      console.warn(`[skip] backend at ${BASE_URL} is not up`);
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
          name: uniqueTestName(`trace-per-case-${i}`),
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
      body: JSON.stringify({ name: uniqueTestName('trace-per-case'), description: 'integration', testCaseIds }),
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

      const res = await fetch(`${BASE_URL}/api/storage/evaluation-runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: uniqueTestName('trace isolation'),
          sources: [{ type: 'benchmark', benchmarkId }],
          benchmarkId,
          agentKey,
          modelId: 'demo-model',
          concurrency: CASE_COUNT,
          trigger: 'manual',
        }),
      });
      expect(res.ok).toBe(true);
      const events = await readRunStream(res);
      const started = events.find(e => e.event === 'started');
      expect(started?.data.runId).toEqual(expect.any(String));
      tracker.evaluationRun(started!.data.runId);
      const terminal = events.find(e => e.event === 'completed' || e.event === 'error');
      expect(terminal?.event).toBe('completed');
      const run = terminal!.data;
      expect(run.id).toBe(started!.data.runId);
      expect(run.status).toBe('completed');
      const results = Object.entries(run.results) as Array<[string, any]>;
      expect(results).toHaveLength(CASE_COUNT);
      for (const [, r] of results) tracker.run(r.reportId);
      expect(results.every(([, r]) => r.status === 'completed' && r.reportId)).toBe(true);

      // The finished run is linked into the benchmark (the projection every
      // benchmark-scoped reader — runs list, inspector, comparison — reads).
      const benchBody = await (await fetch(`${BASE_URL}/api/storage/benchmarks/${encodeURIComponent(benchmarkId)}`)).json();
      const embedded = (benchBody.benchmark ?? benchBody).runs?.find((r: any) => r.id === run.id);
      expect(embedded).toBeDefined();
      expect(embedded.status).toBe('completed');
      expect(Object.keys(embedded.results)).toHaveLength(CASE_COUNT);

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
          // ROOT; no run-wide suite span shares the trace.
          const spans = traces.spans as any[];
          expect(spans.some(s => s.name.startsWith('test_suite_run'))).toBe(false);
          const rootEvalSpans = spans.filter(s => s.name === 'test_case' && !s.parentSpanId);
          expect(rootEvalSpans.length).toBeGreaterThan(0);
          // The agent's root span hangs off that eval span (W3C context adopted).
          const agentRoot = spans.find(s => s.name.startsWith('invoke_agent'));
          expect(agentRoot?.parentSpanId).toBe(invocation!.parentSpanId);
        }
      }
      expect(reportTraceIds.size).toBe(CASE_COUNT);
    },
    TEST_TIMEOUT
  );

  it('the legacy POST /api/storage/benchmarks/:id/execute route answers 410 Gone and starts nothing', async () => {
    if (!ready) return;

    const before = await (await fetch(`${BASE_URL}/api/storage/benchmarks/${encodeURIComponent(benchmarkId)}`)).json();
    const runsBefore = ((before.benchmark ?? before).runs ?? []).length;
    const invocationsBefore = agent!.invocations.length;

    const res = await fetch(`${BASE_URL}/api/storage/benchmarks/${encodeURIComponent(benchmarkId)}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'legacy client', agentKey, modelId: 'demo-model' }),
    });

    expect(res.status).toBe(410);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(res.headers.get('deprecation')).toBe(LEGACY_EXECUTE_REMOVED.deprecationHeader);
    expect(res.headers.get('sunset')).toBe(LEGACY_EXECUTE_REMOVED.sunsetHeader);
    expect(await res.json()).toEqual({
      error: LEGACY_EXECUTE_REMOVED.error,
      code: 'LEGACY_EXECUTE_REMOVED',
      replacement: 'POST /api/storage/evaluation-runs',
      docs: 'docs/CLI.md#benchmark-execution-path',
    });

    // Nothing ran and nothing was persisted.
    await new Promise(r => setTimeout(r, 500));
    expect(agent!.invocations.length).toBe(invocationsBefore);
    const after = await (await fetch(`${BASE_URL}/api/storage/benchmarks/${encodeURIComponent(benchmarkId)}`)).json();
    expect(((after.benchmark ?? after).runs ?? []).length).toBe(runsBefore);
  });
});
