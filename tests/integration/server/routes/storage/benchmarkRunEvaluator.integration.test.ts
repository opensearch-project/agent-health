/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests pinning the contract that the BenchmarkRunsPage
 * "Configure Run" dialog needs to be useful:
 *
 *   POST /api/storage/evaluation-runs  with a `{ type: 'benchmark' }` source
 *   and `evaluatorId` and/or `judgeModelId` in the body  →  the run linked
 *   into `benchmark.runs[]` (the projection every benchmark-scoped reader
 *   consumes) carries those exact fields.
 *
 * The dialog used to drive the legacy `POST /api/storage/benchmarks/:id/execute`
 * runner; that runner has been removed and the route answers `410 Gone`
 * (pinned below), so this is the ONE path a benchmark run can take.
 *
 * Sister coverage:
 *   - tests/integration/server/routes/judgeModelId.integration.test.ts —
 *     covers /api/evaluate (TestCaseDetailPage, QuickRunModal) and the
 *     evaluation-run DOCUMENT for /api/storage/evaluation-runs.
 *   - tests/e2e/evals3-benchmark-runs.spec.ts — verifies the dialog
 *     RENDERS the Evaluator + Judge Model dropdowns and submits them.
 *
 * Uses the built-in `demo` agent + `demo-model` so no real agent endpoint or
 * AWS Bedrock creds are required; works on file and OpenSearch storage.
 *
 * Run:
 *   AH_PORT=<port> npm run test:integration -- --testPathPattern=benchmarkRunEvaluator.integration
 */

import { getTestBackendUrl } from '@/tests/integration/testConfig';
import { createTestDataTracker, uniqueTestName } from '../../../../helpers/testDataTracker';
import { LEGACY_EXECUTE_REMOVED } from '@/lib/legacyExecuteRemoved';

const TEST_TIMEOUT = 60_000;
const BASE_URL = getTestBackendUrl();

const checkBackend = async (): Promise<boolean> => {
  try {
    const r = await fetch(`${BASE_URL}/api/storage/health`);
    if (!r.ok) return false;
    const data = await r.json();
    return data.status === 'ok' || data.status === 'connected';
  } catch {
    return false;
  }
};

/** Read the evaluation-runs SSE stream to its end as `{ event, data }` frames. */
async function readRunStream(res: Response): Promise<Array<{ event: string; data: any }>> {
  const events: Array<{ event: string; data: any }> = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const flush = (frame: string) => {
    let event = '';
    let data = '';
    for (const line of frame.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7);
      else if (line.startsWith('data: ')) data = line.slice(6);
    }
    if (!data) return;
    try { events.push({ event, data: JSON.parse(data) }); } catch { /* partial */ }
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() || '';
    for (const frame of frames) flush(frame);
  }
  if (buffer.trim()) flush(buffer);
  return events;
}

describe('Benchmark run through the evaluation-runs API — evaluatorId / judgeModelId round-trip', () => {
  const tracker = createTestDataTracker();
  let backendAvailable = false;

  beforeAll(async () => {
    backendAvailable = await checkBackend();
    if (!backendAvailable) {
      console.warn(`[benchmarkRunEvaluator.integ] Backend not available at ${BASE_URL} — skipping all tests`);
    }
  });

  afterAll(async () => {
    await tracker.cleanup();
  }, TEST_TIMEOUT);

  async function seedBenchmark(suffix: string): Promise<{ benchmarkId: string; testCaseId: string }> {
    const tcRes = await fetch(`${BASE_URL}/api/storage/test-cases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: uniqueTestName(`evaluator-pass-through-tc-${suffix}`),
        category: 'Test',
        difficulty: 'Easy',
        initialPrompt: 'Demo prompt',
        context: [],
        expectedOutcomes: ['demo outcome'],
        expectedTrajectory: [],
      }),
    });
    if (!tcRes.ok) {
      throw new Error(`create test case failed: ${tcRes.status} ${await tcRes.text().catch(() => '')}`);
    }
    const tc = await tcRes.json();
    const testCaseId: string = tc.id || tc.testCase?.id;
    tracker.testCase(testCaseId);

    const bmRes = await fetch(`${BASE_URL}/api/storage/benchmarks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: uniqueTestName(`evaluator-pass-through-bm-${suffix}`),
        description: 'Pinning evaluator/judge-model round-trip on the evaluation-runs path',
        testCaseIds: [testCaseId],
      }),
    });
    if (!bmRes.ok) {
      throw new Error(`create benchmark failed: ${bmRes.status} ${await bmRes.text().catch(() => '')}`);
    }
    const bm = await bmRes.json();
    const benchmarkId: string = bm.id || bm.benchmark?.id;
    tracker.benchmark(benchmarkId);
    return { benchmarkId, testCaseId };
  }

  /** Run the benchmark to completion and return the projection embedded in `benchmark.runs[]`. */
  async function runBenchmark(benchmarkId: string, body: Record<string, unknown>): Promise<any> {
    const response = await fetch(`${BASE_URL}/api/storage/evaluation-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sources: [{ type: 'benchmark', benchmarkId }],
        benchmarkId,
        trigger: 'manual',
        ...body,
      }),
    });
    if (!response.ok) {
      throw new Error(`run failed: ${response.status} ${response.statusText} ${await response.text().catch(() => '')}`);
    }
    const events = await readRunStream(response);
    const started = events.find(e => e.event === 'started');
    expect(started?.data.runId).toEqual(expect.any(String));
    tracker.evaluationRun(started!.data.runId);
    const completed = events.find(e => e.event === 'completed');
    expect(completed).toBeDefined();
    for (const result of Object.values(completed!.data.results || {}) as any[]) {
      if (result?.reportId) tracker.run(result.reportId);
    }

    const bm = await (await fetch(`${BASE_URL}/api/storage/benchmarks/${encodeURIComponent(benchmarkId)}`)).json();
    const run = (bm.benchmark ?? bm).runs?.find((r: any) => r.id === started!.data.runId);
    expect(run).toBeDefined();
    return run;
  }

  it(
    'persists evaluatorId on the embedded BenchmarkRun when supplied via the dialog',
    async () => {
      if (!backendAvailable) return;
      const { benchmarkId } = await seedBenchmark('with-eval');

      const run = await runBenchmark(benchmarkId, {
        name: uniqueTestName('With evaluator'),
        agentKey: 'demo',
        modelId: 'demo-model',
        evaluatorId: 'system-rca-default',
      });

      expect(run.evaluatorId).toBe('system-rca-default');
      expect(run.agentKey).toBe('demo');
      expect(run.modelId).toBe('demo-model');
      expect(run.status).toBe('completed');
    },
    TEST_TIMEOUT,
  );

  it(
    'omits evaluatorId on the embedded BenchmarkRun when the dialog leaves it as "RCA Default" (undefined)',
    async () => {
      if (!backendAvailable) return;
      const { benchmarkId } = await seedBenchmark('no-eval');

      const run = await runBenchmark(benchmarkId, {
        name: uniqueTestName('No evaluator'),
        agentKey: 'demo',
        modelId: 'demo-model',
      });

      expect(run.evaluatorId).toBeUndefined();
    },
    TEST_TIMEOUT,
  );

  it(
    'persists judgeModelId on the embedded BenchmarkRun separately from the agent modelId',
    async () => {
      if (!backendAvailable) return;
      const { benchmarkId } = await seedBenchmark('with-judge');

      // judgeModelId must be a demo-provider model: the run-level judge model
      // really reaches the judge, and a Bedrock id would call Bedrock (no
      // creds in CI). The agent-side modelId is a Bedrock key — the demo
      // agent's mock connector ignores it — so the two fields still differ.
      const run = await runBenchmark(benchmarkId, {
        name: uniqueTestName('With judge model'),
        agentKey: 'demo',
        modelId: 'claude-sonnet-4',
        judgeModelId: 'demo-model',
      });

      expect(run.judgeModelId).toBe('demo-model');
      expect(run.modelId).toBe('claude-sonnet-4');
      expect(run.judgeModelId).not.toBe(run.modelId);
    },
    TEST_TIMEOUT,
  );

  it(
    'rejects 400 when agentKey is missing (evaluation-runs validation)',
    async () => {
      if (!backendAvailable) return;
      const { benchmarkId } = await seedBenchmark('bad');

      const response = await fetch(`${BASE_URL}/api/storage/evaluation-runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sources: [{ type: 'benchmark', benchmarkId }],
          benchmarkId,
          modelId: 'demo-model',
          evaluatorId: 'system-rca-default',
        }),
      });
      expect(response.status).toBe(400);
      const err = await response.json();
      expect(err.error).toMatch(/agentKey is required/i);
    },
    TEST_TIMEOUT,
  );

  it(
    'the legacy dialog target POST /api/storage/benchmarks/:id/execute answers 410 Gone and embeds no run',
    async () => {
      if (!backendAvailable) return;
      const { benchmarkId } = await seedBenchmark('legacy');

      const response = await fetch(
        `${BASE_URL}/api/storage/benchmarks/${encodeURIComponent(benchmarkId)}/execute`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'Legacy dialog run',
            agentKey: 'demo',
            modelId: 'demo-model',
            evaluatorId: 'system-rca-default',
          }),
        },
      );
      expect(response.status).toBe(410);
      expect(response.headers.get('deprecation')).toBe(LEGACY_EXECUTE_REMOVED.deprecationHeader);
      expect(response.headers.get('sunset')).toBe(LEGACY_EXECUTE_REMOVED.sunsetHeader);
      expect(await response.json()).toEqual({
        error: LEGACY_EXECUTE_REMOVED.error,
        code: 'LEGACY_EXECUTE_REMOVED',
        replacement: 'POST /api/storage/evaluation-runs',
        docs: 'docs/CLI.md#benchmark-execution-path',
      });

      const bm = await (await fetch(`${BASE_URL}/api/storage/benchmarks/${encodeURIComponent(benchmarkId)}`)).json();
      expect(((bm.benchmark ?? bm).runs ?? [])).toHaveLength(0);
    },
    TEST_TIMEOUT,
  );
});
