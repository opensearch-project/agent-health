/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration: the benchmark Runs tab must never render a MEASURED zero for a
 * run whose agent emitted no spans this server can see.
 *
 * Owner report (2026-10-24): a classic (CLI-path) benchmark with two embedded
 * runs read "0 tokens · — · 0 LLM calls · — Time/case" on an OpenSearch-only
 * server while the agent's traces lived in CloudWatch. Two root causes, both
 * exercised here through the REAL routes (file storage + the embedded OTLP
 * receiver → file trace store → `POST /api/metrics/batch`):
 *
 *   1. Strategy B (`agent_health.run.id`) always finds Agent Health's OWN
 *      `test_case` eval span for the key — so the batch route answered
 *      `hasSpans: true` with every counter 0, and the roll-up showed "0".
 *      Now: `hasSpans: false` + `evalOnlySpans`, rolled up as "no traces"
 *      with a tooltip that says the agent's spans are elsewhere.
 *   2. The classic write path persisted the per-case wall-clock on the RUN
 *      (`results[tc].performanceMetrics`) but not on the report, so Time/case
 *      read "—". Now the roll-up falls back to the embedded copy.
 *
 * Real-shaped fixture: one benchmark, TWO embedded legacy runs (classic
 * shape — `{reportId, status, performanceMetrics}`, no per-result verdict,
 * denormalized `stats`) + ONE first-class evaluation-run doc, the SAME agent
 * name on all three, reports with and without `performanceMetrics`, spans
 * that are eval/judge-only for the legacy runs and real agent spans (tokens,
 * tool calls) for the evaluation run.
 *
 * Skips when the backend is down or is NOT in file-observability mode (an
 * OpenSearch observability cluster drops the local OTLP payload by design).
 * Everything created is tracked by id and deleted.
 */

import { createHash } from 'crypto';
import { getTestBackendUrl } from '@/tests/integration/testConfig';
import { createTestDataTracker, uniqueTestName } from '@/tests/helpers/testDataTracker';
import { aggregateRunTelemetry, buildRunTelemetryCorrelation, describeNoTraces, type TelemetryReport } from '@/lib/runTelemetry';

const TEST_TIMEOUT = 60_000;
const BASE_URL = getTestBackendUrl();

const json = async (res: Response) => { const t = await res.text(); try { return JSON.parse(t); } catch { return t; } };
const post = (path: string, body: unknown) =>
  fetch(`${BASE_URL}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const put = (path: string, body: unknown) =>
  fetch(`${BASE_URL}${path}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/** Deterministic hex id (trace ids 32, span ids 16) from a seed. */
const hex = (n: number, seed: string) => createHash('sha256').update(seed).digest('hex').slice(0, n);

/** One OTLP/JSON span. `attrs` values are strings or numbers. */
function otlpSpan(name: string, traceId: string, spanId: string, startMs: number, durMs: number, attrs: Record<string, string | number>, parentSpanId?: string) {
  return {
    traceId, spanId, parentSpanId, name, kind: 1,
    startTimeUnixNano: String(startMs * 1e6), endTimeUnixNano: String((startMs + durMs) * 1e6),
    attributes: Object.entries(attrs).map(([key, v]) => ({ key, value: typeof v === 'number' ? { intValue: String(v) } : { stringValue: v } })),
    status: { code: 1 },
  };
}
const otlpPayload = (serviceName: string, spans: unknown[]) => ({
  resourceSpans: [{
    resource: { attributes: [{ key: 'service.name', value: { stringValue: serviceName } }] },
    scopeSpans: [{ scope: { name: 'ahtest' }, spans }],
  }],
});

describe('Benchmark Runs telemetry — eval-only spans are "no traces", never a measured 0; Time/case falls back to the run\'s embedded wall-clock', () => {
  const tracker = createTestDataTracker();
  let backendAvailable = false;
  let fileObservability = false;
  const stamp = Date.now();
  const AGENT = 'demo-rest-agent';
  const caseIds: string[] = [];
  let benchmarkId: string | null = null;

  // Classic/CLI-path runs: embedded in benchmark.runs[], no evaluation-run doc.
  const LEGACY_A = `run-${stamp}-legacya`;
  const LEGACY_B = `run-${stamp}-legacyb`;
  // First-class evaluation-run doc (the "Add Run" path).
  const EVALRUN = `run-${stamp}-evalrun`;
  /** connector runId (= metrics key) per run per case. */
  const keys: Record<string, string[]> = { [LEGACY_A]: [], [LEGACY_B]: [], [EVALRUN]: [] };
  const reportIds: Record<string, string[]> = { [LEGACY_A]: [], [LEGACY_B]: [], [EVALRUN]: [] };
  const legacyDurations: Record<string, number[]> = { [LEGACY_A]: [75_929, 54_284, 30_287], [LEGACY_B]: [106_856, 20_944, 90_000] };
  const evalRunDurations = [44_000, 38_000, 61_000];

  beforeAll(async () => {
    try { backendAvailable = (await fetch(`${BASE_URL}/health`)).ok; } catch { backendAvailable = false; }
    if (!backendAvailable) { console.warn('Backend not available at', BASE_URL, '- skipping'); return; }
    const health = await json(await fetch(`${BASE_URL}/api/traces/health`));
    fileObservability = health?.backend === 'file';
    if (!fileObservability) { console.warn('Observability backend is', health?.backend, '- the embedded OTLP receiver drops payloads; skipping'); return; }
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    for (let i = 0; i < 3; i++) {
      const tc = await json(await post('/api/storage/test-cases', {
        name: uniqueTestName(`evalonly-tc-${i}`), category: 'Test', difficulty: 'Easy', initialPrompt: 'p', expectedOutcomes: ['o'],
      }));
      const id = tc.id || tc.testCase?.id;
      tracker.testCase(id);
      caseIds.push(id);
    }

    // Reports. Legacy runs: NO performanceMetrics on the report (classic write path). Eval run: has it.
    const seed = async (runId: string, withPerf: boolean, durations: number[]) => {
      for (let i = 0; i < caseIds.length; i++) {
        const key = `${runId}-k${i}`;
        const rep = await json(await post('/api/storage/runs', {
          testCaseId: caseIds[i], testCaseVersion: 1, agentKey: AGENT, agentName: AGENT, modelId: 'demo-model', modelName: 'demo-model',
          status: 'completed', passFailStatus: 'passed', trajectory: [], metrics: { accuracy: 90 },
          connectorProtocol: 'rest', runId: key, traceId: hex(32, key),
          ...(withPerf ? { performanceMetrics: { durationMs: durations[i], agentDurationMs: durations[i] - 1000 } } : {}),
          experimentRunId: runId,
        }));
        tracker.run(rep.id);
        keys[runId].push(key);
        reportIds[runId].push(rep.id);
      }
    };
    await seed(LEGACY_A, false, legacyDurations[LEGACY_A]);
    await seed(LEGACY_B, false, legacyDurations[LEGACY_B]);
    await seed(EVALRUN, true, evalRunDurations);

    const legacyRun = (id: string, name: string, createdAt: string) => ({
      id, name, agentKey: AGENT, modelId: 'demo-model', judgeModelId: 'demo-judge', createdAt, status: 'completed', benchmarkVersion: 1, concurrency: 2,
      testCaseSnapshots: caseIds.map(tc => ({ id: tc, version: 1, name: tc })),
      // Classic shape: no passFailStatus on the result, timing embedded here only.
      results: Object.fromEntries(caseIds.map((tc, i) => [tc, {
        reportId: reportIds[id][i], status: 'completed',
        performanceMetrics: { durationMs: legacyDurations[id][i], agentDurationMs: legacyDurations[id][i] - 6_000, judgeDurationMs: 5_000, judgeAttempts: 1 },
      }])),
      stats: { total: 3, passed: 3, failed: 0, pending: 0, errored: 0 },
      performanceMetrics: { durationMs: 200_410, concurrency: 2 },
    });
    const bm = await json(await post('/api/storage/benchmarks', {
      name: uniqueTestName('evalonly-benchmark'), description: 'eval-only spans', testCaseIds: caseIds, runs: [], currentVersion: 1,
      versions: [{ version: 1, createdAt: new Date().toISOString(), testCaseIds: caseIds }],
    }));
    benchmarkId = bm.id;
    tracker.benchmark(benchmarkId!);
    const stored = await json(await fetch(`${BASE_URL}/api/storage/benchmarks/${benchmarkId}`));
    const putRes = await put(`/api/storage/benchmarks/${benchmarkId}`, {
      name: stored.name, description: stored.description, testCaseIds: stored.testCaseIds,
      runs: [
        legacyRun(LEGACY_A, uniqueTestName('legacy-run-a'), new Date(stamp - 86_400_000).toISOString()),
        legacyRun(LEGACY_B, uniqueTestName('legacy-run-b'), new Date(stamp - 2 * 86_400_000).toISOString()),
      ],
    });
    if (!putRes.ok) throw new Error(`benchmark PUT failed: ${putRes.status}`);

    const evalRunRes = await put(`/api/storage/evaluation-runs/${EVALRUN}`, {
      id: EVALRUN, name: uniqueTestName('eval-run'), docType: 'evaluation-run', benchmarkId,
      status: 'completed', agentKey: AGENT, modelId: 'demo-model', judgeModelId: 'demo-judge',
      createdAt: new Date(stamp).toISOString(), completedAt: new Date(stamp + 200_000).toISOString(),
      sources: [], trigger: 'api', testCaseSnapshots: caseIds.map(tc => ({ id: tc, version: 1, name: tc })),
      results: Object.fromEntries(caseIds.map((tc, i) => [tc, { reportId: reportIds[EVALRUN][i], status: 'completed', passFailStatus: 'passed' }])),
    });
    if (evalRunRes.ok) tracker.evaluationRun(EVALRUN);

    // Spans. Legacy runs: ONLY Agent Health's own eval span (+ a judge chat) per key — the agent's traces are in another store.
    const t0 = stamp - 600_000;
    const evalOnly: unknown[] = [];
    for (const runId of [LEGACY_A, LEGACY_B]) {
      keys[runId].forEach((key, i) => {
        const traceId = hex(32, `${key}-eval`);
        evalOnly.push(otlpSpan('test_case', traceId, hex(16, `${key}-tc`), t0 + i * 1000, 70_000, {
          'gen_ai.operation.name': 'evaluation', 'agent_health.run.id': key, 'gen_ai.conversation.id': key,
        }));
        evalOnly.push(otlpSpan('chat', traceId, hex(16, `${key}-judge`), t0 + i * 1000 + 65_000, 5_000, {
          'gen_ai.operation.name': 'evaluation', 'gen_ai.request.model': 'demo-judge', 'gen_ai.usage.input_tokens': 4000, 'gen_ai.usage.output_tokens': 300,
        }, hex(16, `${key}-tc`)));
      });
    }
    expect((await post('/v1/traces', otlpPayload('agent-health', evalOnly))).status).toBe(200);
    // Eval run: the eval span AND the agent's own spans (two LLM calls + a tool) under the same run id.
    const agentSpans: unknown[] = [];
    keys[EVALRUN].forEach((key, i) => {
      const traceId = hex(32, `${key}-eval`);
      agentSpans.push(otlpSpan('test_case', traceId, hex(16, `${key}-tc`), t0 + i * 1000, 60_000, { 'gen_ai.operation.name': 'evaluation', 'agent_health.run.id': key }));
      agentSpans.push(otlpSpan('chat', traceId, hex(16, `${key}-llm1`), t0 + i * 1000 + 1000, 9_000, { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'demo-model', 'gen_ai.usage.input_tokens': 10_000, 'gen_ai.usage.output_tokens': 500, 'agent_health.run.id': key }, hex(16, `${key}-tc`)));
      agentSpans.push(otlpSpan('execute_tool search_index', traceId, hex(16, `${key}-tool`), t0 + i * 1000 + 11_000, 2_000, { 'gen_ai.tool.name': 'search_index', 'agent_health.run.id': key }, hex(16, `${key}-tc`)));
      agentSpans.push(otlpSpan('chat', traceId, hex(16, `${key}-llm2`), t0 + i * 1000 + 14_000, 9_000, { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'demo-model', 'gen_ai.usage.input_tokens': 12_000, 'gen_ai.usage.output_tokens': 700, 'agent_health.run.id': key }, hex(16, `${key}-tc`)));
    });
    expect((await post('/v1/traces', otlpPayload(AGENT, agentSpans))).status).toBe(200);
  }, TEST_TIMEOUT);

  afterAll(async () => { await tracker.cleanup(); });

  const ready = () => backendAvailable && fileObservability;

  it('the embedded legacy runs and the evaluation-run doc are all listed for the benchmark (the page merges them)', async () => {
    if (!ready()) return;
    const bm = await json(await fetch(`${BASE_URL}/api/storage/benchmarks/${benchmarkId}?runsSize=100`));
    expect((bm.runs as any[]).map(r => r.id).sort()).toEqual([LEGACY_A, LEGACY_B].sort());
    for (const r of bm.runs) {
      expect(r.results[caseIds[0]].passFailStatus).toBeUndefined();      // classic shape, verdicts only in stats
      expect(r.results[caseIds[0]].performanceMetrics.durationMs).toBe(legacyDurations[r.id][0]);
    }
    const list = await json(await fetch(`${BASE_URL}/api/storage/evaluation-runs?benchmarkId=${benchmarkId}&size=100`));
    expect((list.evaluationRuns || []).map((r: any) => r.id)).toEqual([EVALRUN]);
  }, TEST_TIMEOUT);

  it('the summaries the page loads carry no performanceMetrics for the legacy reports (the classic write path never persisted it) but do for the eval run', async () => {
    if (!ready()) return;
    const ids = [...reportIds[LEGACY_A], ...reportIds[EVALRUN]];
    const { runs } = await json(await fetch(`${BASE_URL}/api/storage/runs?ids=${ids.join(',')}&fields=runId,traceId,connectorProtocol,performanceMetrics,agentId`));
    const byId = Object.fromEntries(runs.map((r: any) => [r.id, r]));
    for (const id of reportIds[LEGACY_A]) expect(byId[id].performanceMetrics).toBeUndefined();
    expect(byId[reportIds[EVALRUN][0]].performanceMetrics).toMatchObject({ durationMs: 44_000 });
  }, TEST_TIMEOUT);

  it('POST /api/metrics/batch: keys whose only spans are Agent Health\'s own eval/judge spans answer hasSpans:false + evalOnlySpans; keys with agent spans answer real totals', async () => {
    if (!ready()) return;
    const all = [...keys[LEGACY_A], ...keys[LEGACY_B], ...keys[EVALRUN]];
    const res = await post('/api/metrics/batch', {
      runIds: all,
      traceIds: Object.fromEntries(all.map(k => [k, hex(32, `${k}-eval`)])),
      sessionIds: {},
    });
    expect(res.status).toBe(200);
    const { metrics } = await res.json();
    expect(metrics.map((m: any) => m.runId)).toEqual(all);
    const byKey = Object.fromEntries(metrics.map((m: any) => [m.runId, m]));

    for (const k of [...keys[LEGACY_A], ...keys[LEGACY_B]]) {
      // Pre-fix: { hasSpans: true, totalTokens: 0, llmCalls: 0, correlatedBy: 'ids' } → the page rendered "0 · — · 0".
      expect(byKey[k]).toMatchObject({ hasSpans: false, status: 'pending', evalOnlySpans: 2, totalTokens: 0, llmCalls: 0, costUsd: 0 });
      expect(byKey[k].error).toBeUndefined();
      expect(byKey[k].traceId).toBe(hex(32, `${k}-eval`));   // the eval trace is real and still linkable
    }
    for (const k of keys[EVALRUN]) {
      // The judge chat is excluded; the agent's two LLM calls + one tool count.
      expect(byKey[k]).toMatchObject({ hasSpans: true, status: 'success', inputTokens: 22_000, outputTokens: 1_200, totalTokens: 23_200, llmCalls: 2, toolCalls: 1, correlatedBy: 'ids' });
      expect(byKey[k].evalOnlySpans).toBeUndefined();
    }
  }, TEST_TIMEOUT);

  it('the Runs-tab roll-up of exactly those responses: legacy runs = "no traces" (eval-only, 3/3) with Time/case from the embedded wall-clock; the eval run = real tokens', async () => {
    if (!ready()) return;
    const bm = await json(await fetch(`${BASE_URL}/api/storage/benchmarks/${benchmarkId}?runsSize=100`));
    const { evaluationRuns } = await json(await fetch(`${BASE_URL}/api/storage/evaluation-runs?benchmarkId=${benchmarkId}&size=100`));
    const runs = [...bm.runs, ...evaluationRuns];
    const allReportIds = Object.values(reportIds).flat();
    const { runs: summaries } = await json(await fetch(`${BASE_URL}/api/storage/runs?ids=${allReportIds.join(',')}&fields=runId,sessionId,traceId,connectorProtocol,performanceMetrics,agentId,createdAt`));
    const reports: Record<string, TelemetryReport> = Object.fromEntries(summaries.map((s: any) => [s.id, {
      id: s.id, runId: s.runId, traceId: s.traceId, sessionId: s.sessionId, agentKey: s.agentId, connectorProtocol: s.connectorProtocol,
      timestamp: s.createdAt, performanceMetrics: s.performanceMetrics,
    }]));
    const c = buildRunTelemetryCorrelation(runs, reports);
    expect(c.keys.sort()).toEqual(Object.values(keys).flat().sort());
    const res = await post('/api/metrics/batch', { runIds: c.keys, sessionIds: c.sessionIdByKey, traceIds: c.traceIdByKey, agents: c.agentsByKey });
    expect(res.status).toBe(200);
    const metricsByKey = Object.fromEntries((await res.json()).metrics.map((m: any) => [m.runId, m]));

    for (const id of [LEGACY_A, LEGACY_B]) {
      const t = aggregateRunTelemetry(runs.find(r => r.id === id)!, reports, metricsByKey)!;
      expect(t).toMatchObject({ hasSpans: false, unavailable: false, spansCases: 0, evalOnlyCases: 3, totalCases: 3, pendingCases: 0, totalTokens: 0, llmCalls: 0 });
      const sorted = [...legacyDurations[id]].sort((a, b) => a - b);
      expect(t.medianDurationMs).toBe(sorted[1]);    // from results[tc].performanceMetrics — pre-fix null ("—")
      expect(describeNoTraces(t)).toMatch(/holds only Agent Health's own evaluation spans for every one of its 3 cases; no spans from the agent itself were found/);
    }
    const e = aggregateRunTelemetry(runs.find(r => r.id === EVALRUN)!, reports, metricsByKey)!;
    expect(e).toMatchObject({ hasSpans: true, spansCases: 3, evalOnlyCases: 0, totalTokens: 69_600, llmCalls: 6, toolCalls: 3, medianDurationMs: 44_000 });
  }, TEST_TIMEOUT);
});
