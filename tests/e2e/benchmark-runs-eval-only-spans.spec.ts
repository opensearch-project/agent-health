/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Benchmark Runs tab — no fake zeros (owner report, 2026-10-24: a classic
 * benchmark's two embedded runs read "0 tokens · — · 0 LLM calls · — Time/case"
 * on a server whose trace store held only Agent Health's own eval spans; the
 * agent's traces lived in a different store).
 *
 * UNMOCKED: the storage AND the trace store are the real server's (file mode
 * + the embedded OTLP receiver). Spans are ingested through `POST /v1/traces`,
 * the page issues its real `POST /api/metrics/batch`, and the rendered cells
 * are asserted. Skips when the server is not in file-observability mode (an
 * OpenSearch observability cluster drops the local OTLP payload by design).
 *
 * Real-shaped fixture: TWO embedded legacy runs (classic shape — no per-result
 * verdict, timing embedded on the run only, denormalized `stats`) + ONE
 * evaluation-run doc, the SAME agent name on all three, eval/judge-only spans
 * for the legacy runs vs real agent spans for the eval run.
 */

import { createHash } from 'crypto';
import { test, expect } from './fixtures/test-fixtures';
import { createTestDataTracker, uniqueTestName } from '../helpers/testDataTracker';

const hex = (n: number, seed: string) => createHash('sha256').update(seed).digest('hex').slice(0, n);

function otlpSpan(name: string, traceId: string, spanId: string, startMs: number, durMs: number, attrs: Record<string, string | number>, parentSpanId?: string) {
  return {
    traceId, spanId, parentSpanId, name, kind: 1,
    startTimeUnixNano: String(startMs * 1e6), endTimeUnixNano: String((startMs + durMs) * 1e6),
    attributes: Object.entries(attrs).map(([key, v]) => ({ key, value: typeof v === 'number' ? { intValue: String(v) } : { stringValue: v } })),
    status: { code: 1 },
  };
}
const otlpPayload = (serviceName: string, spans: unknown[]) => ({
  resourceSpans: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: serviceName } }] }, scopeSpans: [{ scope: { name: 'ahtest' }, spans }] }],
});

test.describe('Benchmark Runs — eval-only spans read "no traces" (never 0); legacy Time/case from the embedded wall-clock', () => {
  const tracker = createTestDataTracker();
  let benchmarkId: string | null = null;
  let skipReason: string | null = null;
  const stamp = Date.now();
  const AGENT = 'demo-rest-agent';
  const caseIds: string[] = [];
  const LEGACY_A = `run-${stamp}-legacya`, LEGACY_B = `run-${stamp}-legacyb`, EVALRUN = `run-${stamp}-evalrun`;
  const NAME_A = uniqueTestName('legacy-run-a'), NAME_B = uniqueTestName('legacy-run-b'), NAME_E = uniqueTestName('eval-run');
  const legacyDurations: Record<string, number[]> = { [LEGACY_A]: [75_929, 54_284, 30_287], [LEGACY_B]: [106_856, 20_944, 90_000] };

  test.beforeAll(async ({ request }) => {
    test.setTimeout(120_000);
    const health = await (await request.get('/api/traces/health')).json().catch(() => null);
    if (health?.backend !== 'file') { skipReason = `observability backend is ${health?.backend ?? 'unknown'}, not file`; return; }

    for (let i = 0; i < 3; i++) {
      const r = await request.post('/api/storage/test-cases', { data: { name: uniqueTestName(`evalonly-tc-${i}`), category: 'Test', difficulty: 'Easy', initialPrompt: 'p', expectedOutcomes: ['o'] } });
      if (!r.ok()) { skipReason = `test-case seed failed: ${r.status()}`; return; }
      const j = await r.json();
      const id = j.id || j.testCase?.id;
      tracker.testCase(id);
      caseIds.push(id);
    }
    const reportIds: Record<string, string[]> = { [LEGACY_A]: [], [LEGACY_B]: [], [EVALRUN]: [] };
    const seed = async (runId: string, withPerf: boolean, durations: number[]) => {
      for (let i = 0; i < caseIds.length; i++) {
        const key = `${runId}-k${i}`;
        const r = await request.post('/api/storage/runs', {
          data: {
            testCaseId: caseIds[i], testCaseVersion: 1, agentKey: AGENT, agentName: AGENT, modelId: 'demo-model', modelName: 'demo-model',
            status: 'completed', passFailStatus: 'passed', trajectory: [], metrics: { accuracy: 90 },
            connectorProtocol: 'rest', runId: key, traceId: hex(32, `${key}-eval`),
            ...(withPerf ? { performanceMetrics: { durationMs: durations[i], agentDurationMs: durations[i] - 1000 } } : {}),
            experimentRunId: runId,
          },
        });
        if (!r.ok()) throw new Error(`report seed failed: ${r.status()}`);
        const j = await r.json();
        tracker.run(j.id);
        reportIds[runId].push(j.id);
      }
    };
    try {
      await seed(LEGACY_A, false, legacyDurations[LEGACY_A]);
      await seed(LEGACY_B, false, legacyDurations[LEGACY_B]);
      await seed(EVALRUN, true, [44_000, 38_000, 61_000]);

      const legacyRun = (id: string, name: string, createdAt: string) => ({
        id, name, agentKey: AGENT, modelId: 'demo-model', judgeModelId: 'demo-judge', createdAt, status: 'completed', benchmarkVersion: 1, concurrency: 2,
        testCaseSnapshots: caseIds.map(tc => ({ id: tc, version: 1, name: tc })),
        results: Object.fromEntries(caseIds.map((tc, i) => [tc, {
          reportId: reportIds[id][i], status: 'completed',
          performanceMetrics: { durationMs: legacyDurations[id][i], agentDurationMs: legacyDurations[id][i] - 6_000, judgeDurationMs: 5_000, judgeAttempts: 1 },
        }])),
        stats: { total: 3, passed: 3, failed: 0, pending: 0, errored: 0 },
      });
      const bmRes = await request.post('/api/storage/benchmarks', {
        data: { name: uniqueTestName('evalonly-benchmark'), description: 'eval-only spans', testCaseIds: caseIds, runs: [], currentVersion: 1, versions: [{ version: 1, createdAt: new Date().toISOString(), testCaseIds: caseIds }] },
      });
      if (!bmRes.ok()) { skipReason = `benchmark seed failed: ${bmRes.status()}`; return; }
      benchmarkId = (await bmRes.json()).id;
      tracker.benchmark(benchmarkId!);
      const bm = await (await request.get(`/api/storage/benchmarks/${benchmarkId}`)).json();
      const put = await request.put(`/api/storage/benchmarks/${benchmarkId}`, {
        data: {
          name: bm.name, description: bm.description, testCaseIds: bm.testCaseIds,
          runs: [legacyRun(LEGACY_A, NAME_A, new Date(stamp - 86_400_000).toISOString()), legacyRun(LEGACY_B, NAME_B, new Date(stamp - 2 * 86_400_000).toISOString())],
        },
      });
      if (!put.ok()) { skipReason = `benchmark PUT failed: ${put.status()}`; benchmarkId = null; return; }
      const er = await request.put(`/api/storage/evaluation-runs/${EVALRUN}`, {
        data: {
          id: EVALRUN, name: NAME_E, docType: 'evaluation-run', benchmarkId, status: 'completed', agentKey: AGENT, modelId: 'demo-model', judgeModelId: 'demo-judge',
          createdAt: new Date(stamp).toISOString(), completedAt: new Date(stamp + 200_000).toISOString(), sources: [], trigger: 'api',
          testCaseSnapshots: caseIds.map(tc => ({ id: tc, version: 1, name: tc })),
          results: Object.fromEntries(caseIds.map((tc, i) => [tc, { reportId: reportIds[EVALRUN][i], status: 'completed', passFailStatus: 'passed' }])),
        },
      });
      if (er.ok()) tracker.evaluationRun(EVALRUN);

      const t0 = stamp - 600_000;
      const evalOnly: unknown[] = [];
      for (const runId of [LEGACY_A, LEGACY_B]) {
        for (let i = 0; i < 3; i++) {
          const key = `${runId}-k${i}`, traceId = hex(32, `${key}-eval`);
          evalOnly.push(otlpSpan('test_case', traceId, hex(16, `${key}-tc`), t0 + i * 1000, 70_000, { 'gen_ai.operation.name': 'evaluation', 'agent_health.run.id': key }));
          evalOnly.push(otlpSpan('chat', traceId, hex(16, `${key}-judge`), t0 + i * 1000 + 65_000, 5_000, { 'gen_ai.operation.name': 'evaluation', 'gen_ai.request.model': 'demo-judge', 'gen_ai.usage.input_tokens': 4000, 'gen_ai.usage.output_tokens': 300 }, hex(16, `${key}-tc`)));
        }
      }
      const agent: unknown[] = [];
      for (let i = 0; i < 3; i++) {
        const key = `${EVALRUN}-k${i}`, traceId = hex(32, `${key}-eval`);
        agent.push(otlpSpan('test_case', traceId, hex(16, `${key}-tc`), t0 + i * 1000, 60_000, { 'gen_ai.operation.name': 'evaluation', 'agent_health.run.id': key }));
        agent.push(otlpSpan('chat', traceId, hex(16, `${key}-llm1`), t0 + i * 1000 + 1000, 9_000, { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'demo-model', 'gen_ai.usage.input_tokens': 10_000, 'gen_ai.usage.output_tokens': 500, 'agent_health.run.id': key }, hex(16, `${key}-tc`)));
        agent.push(otlpSpan('execute_tool search_index', traceId, hex(16, `${key}-tool`), t0 + i * 1000 + 11_000, 2_000, { 'gen_ai.tool.name': 'search_index', 'agent_health.run.id': key }, hex(16, `${key}-tc`)));
        agent.push(otlpSpan('chat', traceId, hex(16, `${key}-llm2`), t0 + i * 1000 + 14_000, 9_000, { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'demo-model', 'gen_ai.usage.input_tokens': 12_000, 'gen_ai.usage.output_tokens': 700, 'agent_health.run.id': key }, hex(16, `${key}-tc`)));
      }
      for (const [svc, spans] of [['agent-health', evalOnly], [AGENT, agent]] as const) {
        const r = await request.post('/v1/traces', { data: otlpPayload(svc, spans as unknown[]) });
        if (!r.ok()) { skipReason = `OTLP ingest failed: ${r.status()}`; benchmarkId = null; return; }
      }
    } catch (e) {
      skipReason = `seed failed: ${e}`;
      benchmarkId = null;
    }
  });

  test.afterAll(async () => { await tracker.cleanup(); });

  test('legacy runs whose only spans are Agent Health\'s own eval spans read "no traces" (tooltip: the agent\'s spans are elsewhere), Time/case from the embedded wall-clock, Pass % intact; the traced run next to them shows real totals', async ({ page }) => {
    test.skip(!benchmarkId, skipReason ?? 'seed failed');
    await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs`);
    await expect(page.getByTestId('benchmark-runs-table')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('run-row')).toHaveCount(3, { timeout: 30_000 });

    const a = page.locator('[data-testid="run-row"]', { hasText: NAME_A });
    const b = page.locator('[data-testid="run-row"]', { hasText: NAME_B });
    const e = page.locator('[data-testid="run-row"]', { hasText: NAME_E });

    // The traced run: real numbers (2 LLM calls × 3 cases, 23.2K tokens each, 1 tool each).
    await expect(e.getByTestId('run-tokens-cell')).toHaveAttribute('data-state', 'value', { timeout: 20_000 });
    await expect(e.getByTestId('run-tokens-cell')).toContainText('69.6K');
    await expect(e.getByTestId('run-llmcalls-cell')).toHaveText('6');
    await expect(e.getByTestId('run-timepercase-cell')).toHaveText('44 s');

    // Legacy runs: NOT "0". "no traces", with the eval-only explanation.
    for (const row of [a, b]) {
      await expect(row.getByTestId('run-tokens-cell')).toHaveAttribute('data-state', 'empty', { timeout: 20_000 });
      for (const id of ['run-tokens-cell', 'run-cost-cell', 'run-llmcalls-cell']) {
        await expect(row.getByTestId(id)).toHaveText('no traces');
        await expect(row.getByTestId(id)).toHaveAttribute('data-empty-kind', 'no-traces');
        await expect(row.getByTestId(id).locator('span')).toHaveAttribute('title',
          /^No traces for this run — the trace store holds only Agent Health's own evaluation span for every one of its 3 cases; no spans from the agent itself were found\. Either the agent is not instrumented, or it exports its traces to a different trace store/);
      }
      // Pass % comes from the run's own verdicts/stats — never a casualty of missing spans.
      await expect(row.getByTestId('run-passrate-cell')).toContainText('100%');
    }
    // Time/case: the classic write path put the per-case wall-clock on the run, not the report → pre-fix "—".
    await expect(a.getByTestId('run-timepercase-cell')).toHaveText('54 s');     // median of 75.9 / 54.3 / 30.3 s
    await expect(b.getByTestId('run-timepercase-cell')).toHaveText('1m 30s');   // median of 106.9 / 20.9 / 90.0 s
    for (const row of [a, b]) await expect(row.getByTestId('run-timepercase-cell')).toHaveAttribute('data-state', 'value');
  });

  test('the run inspector strip of a legacy run says "no traces" (eval-only tooltip) with spans 0/3 and the embedded wall-clock, not "0 tokens"', async ({ page }) => {
    test.skip(!benchmarkId, skipReason ?? 'seed failed');
    await page.goto(`/evaluations/benchmarks/${benchmarkId}/runs/${LEGACY_A}/inspect`);
    const strip = page.getByTestId('run-telemetry-strip');
    await expect(strip).toHaveAttribute('data-state', 'empty', { timeout: 30_000 });
    await expect(strip).toHaveAttribute('data-empty-kind', 'no-traces');
    await expect(strip.getByTestId('strip-tokens')).toContainText('no traces');
    await expect(strip.getByTestId('strip-tokens')).toHaveAttribute('title', /holds only Agent Health's own evaluation span for every one of its 3 cases/);
    await expect(strip.getByTestId('strip-llmcalls')).toContainText('no traces');
    await expect(strip.getByTestId('strip-spans')).toHaveText('spans: 0/3 cases');
    await expect(strip.getByTestId('strip-timepercase')).toContainText('54 s');
  });
});
