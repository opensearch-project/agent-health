/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests pinning the contract that the BenchmarkRunsPage
 * "Configure Run" dialog needs to be useful:
 *
 *   POST /api/storage/benchmarks/:id/execute  with `evaluatorId` and/or
 *   `judgeModelId` in the body  →  the persisted BenchmarkRun document
 *   carries those exact fields.
 *
 * Pre-fix the dialog only collected `agentKey` + `modelId` (mislabelled as
 * "Judge Model"), so even if the server accepted `evaluatorId`/`judgeModelId`,
 * the UI couldn't deliver them. This test guards the SERVER side of that
 * contract — it must continue to round-trip these fields untouched so the
 * UI plumbing stays meaningful.
 *
 * Sister coverage:
 *   - tests/integration/server/routes/judgeModelId.integration.test.ts —
 *     covers /api/evaluate (TestCaseDetailPage, QuickRunModal) and
 *     /api/storage/evaluation-runs (EvalRuns / NewRunPage / CLI).
 *   - tests/e2e/evals3-benchmark-runs.spec.ts — verifies the dialog
 *     RENDERS the Evaluator + Judge Model dropdowns and submits them.
 *
 * Uses the built-in `demo` agent + `demo-model` so no real agent endpoint or
 * AWS Bedrock creds are required. Only OpenSearch (or file storage) is needed.
 *
 * Run:
 *   npm run test:integration -- --testPathPattern=benchmarkExecuteEvaluator.integration
 */

import { getTestBackendUrl } from '@/tests/integration/testConfig';

const TEST_TIMEOUT = 60_000;
const BASE_URL = getTestBackendUrl();

const checkBackend = async (): Promise<boolean> => {
  try {
    const r = await fetch(`${BASE_URL}/api/storage/health`);
    if (!r.ok) return false;
    const data = await r.json();
    return data.status === 'connected' || data.status === 'ok';
  } catch {
    return false;
  }
};

async function consumeSSEStream(response: Response): Promise<any[]> {
  const reader = response.body?.getReader();
  if (!reader) return [];
  const decoder = new TextDecoder();
  let buffer = '';
  const events: any[] = [];
  const flushEventBlock = (block: string) => {
    let eventName: string | undefined;
    let dataLine: string | undefined;
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) eventName = line.slice(7).trim();
      else if (line.startsWith('data: ')) dataLine = line.slice(6);
    }
    if (!dataLine) return;
    let parsed: any;
    try { parsed = JSON.parse(dataLine); }
    catch { return; }
    if (eventName && (!parsed || typeof parsed !== 'object' || !('type' in parsed))) {
      parsed = { type: eventName, ...(typeof parsed === 'object' ? parsed : { value: parsed }) };
    }
    events.push(parsed);
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';
    for (const part of parts) flushEventBlock(part);
  }
  if (buffer.trim()) flushEventBlock(buffer);
  return events;
}

async function executeAndGetRunId(
  benchmarkId: string,
  body: Record<string, unknown>,
): Promise<string | null> {
  const response = await fetch(
    `${BASE_URL}/api/storage/benchmarks/${encodeURIComponent(benchmarkId)}/execute`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) {
    throw new Error(
      `execute failed: ${response.status} ${response.statusText} ${await response.text().catch(() => '')}`,
    );
  }
  const events = await consumeSSEStream(response);
  const started = events.find(e => e.type === 'started');
  return started?.runId ?? null;
}

describe('Benchmark execute — evaluatorId / judgeModelId round-trip', () => {
  let backendAvailable = false;
  const createdTestCaseIds: string[] = [];
  const createdBenchmarkIds: string[] = [];

  beforeAll(async () => {
    backendAvailable = await checkBackend();
    if (!backendAvailable) {
      console.warn(
        `[benchmarkExecuteEvaluator.integ] Backend not available at ${BASE_URL} — skipping all tests`,
      );
    }
  });

  afterAll(async () => {
    for (const id of createdBenchmarkIds) {
      await fetch(
        `${BASE_URL}/api/storage/benchmarks/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      ).catch(() => { /* ignore */ });
    }
    for (const id of createdTestCaseIds) {
      await fetch(
        `${BASE_URL}/api/storage/test-cases/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      ).catch(() => { /* ignore */ });
    }
  });

  async function seedBenchmark(suffix: string): Promise<{ benchmarkId: string; testCaseId: string }> {
    const tcRes = await fetch(`${BASE_URL}/api/storage/test-cases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `Evaluator-pass-through TC ${suffix}`,
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
    createdTestCaseIds.push(testCaseId);

    const bmRes = await fetch(`${BASE_URL}/api/storage/benchmarks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `Evaluator-pass-through BM ${suffix}`,
        description: 'Pinning evaluator/judge-model round-trip on /execute',
        testCaseIds: [testCaseId],
        runs: [],
        currentVersion: 1,
        versions: [{
          version: 1,
          createdAt: new Date().toISOString(),
          testCaseIds: [testCaseId],
        }],
      }),
    });
    if (!bmRes.ok) {
      throw new Error(`create benchmark failed: ${bmRes.status} ${await bmRes.text().catch(() => '')}`);
    }
    const bm = await bmRes.json();
    const benchmarkId: string = bm.id || bm.benchmark?.id;
    createdBenchmarkIds.push(benchmarkId);
    return { benchmarkId, testCaseId };
  }

  it(
    'persists evaluatorId on the BenchmarkRun when supplied via the dialog',
    async () => {
      if (!backendAvailable) return;
      const { benchmarkId } = await seedBenchmark(`with-eval-${Date.now()}`);

      const runId = await executeAndGetRunId(benchmarkId, {
        name: 'With evaluator',
        agentKey: 'demo',
        modelId: 'demo-model',
        evaluatorId: 'system-rca-default',
      });
      expect(runId).toBeDefined();

      const bmRes = await fetch(
        `${BASE_URL}/api/storage/benchmarks/${encodeURIComponent(benchmarkId)}`,
      );
      expect(bmRes.status).toBe(200);
      const bm = await bmRes.json();
      const run = bm.runs?.find((r: any) => r.id === runId);

      expect(run).toBeDefined();
      expect(run.evaluatorId).toBe('system-rca-default');
      expect(run.agentKey).toBe('demo');
      expect(run.modelId).toBe('demo-model');
    },
    TEST_TIMEOUT,
  );

  it(
    'omits evaluatorId on the BenchmarkRun when the dialog leaves it as "RCA Default" (undefined)',
    async () => {
      if (!backendAvailable) return;
      const { benchmarkId } = await seedBenchmark(`no-eval-${Date.now()}`);

      const runId = await executeAndGetRunId(benchmarkId, {
        name: 'No evaluator',
        agentKey: 'demo',
        modelId: 'demo-model',
      });
      expect(runId).toBeDefined();

      const bm = await (await fetch(
        `${BASE_URL}/api/storage/benchmarks/${encodeURIComponent(benchmarkId)}`,
      )).json();
      const run = bm.runs?.find((r: any) => r.id === runId);

      expect(run).toBeDefined();
      expect(run.evaluatorId).toBeUndefined();
    },
    TEST_TIMEOUT,
  );

  it(
    'persists judgeModelId on the BenchmarkRun when supplied via the dialog (separately from agent modelId)',
    async () => {
      if (!backendAvailable) return;
      const { benchmarkId } = await seedBenchmark(`with-judge-${Date.now()}`);

      const runId = await executeAndGetRunId(benchmarkId, {
        name: 'With judge model',
        agentKey: 'demo',
        modelId: 'demo-model',
        judgeModelId: 'us.anthropic.claude-haiku-3-5',
      });
      expect(runId).toBeDefined();

      const bm = await (await fetch(
        `${BASE_URL}/api/storage/benchmarks/${encodeURIComponent(benchmarkId)}`,
      )).json();
      const run = bm.runs?.find((r: any) => r.id === runId);

      expect(run).toBeDefined();
      expect(run.judgeModelId).toBe('us.anthropic.claude-haiku-3-5');
      expect(run.modelId).toBe('demo-model');
      expect(run.judgeModelId).not.toBe(run.modelId);
    },
    TEST_TIMEOUT,
  );

  it(
    'rejects 400 when name is missing (validateRunConfig still works alongside the new optional fields)',
    async () => {
      if (!backendAvailable) return;
      const { benchmarkId } = await seedBenchmark(`bad-${Date.now()}`);

      const response = await fetch(
        `${BASE_URL}/api/storage/benchmarks/${encodeURIComponent(benchmarkId)}/execute`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentKey: 'demo',
            modelId: 'demo-model',
            evaluatorId: 'system-rca-default',
          }),
        },
      );
      expect(response.status).toBe(400);
      const err = await response.json();
      expect(err.error).toMatch(/name is required/i);
    },
    TEST_TIMEOUT,
  );
});
