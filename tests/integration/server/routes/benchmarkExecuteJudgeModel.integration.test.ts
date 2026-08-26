/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * End-to-end integration test: run-level `judgeModelId` must reach the judge
 * through the benchmark-execute path.
 *
 * Why this test exists
 * ────────────────────
 * `POST /api/storage/benchmarks/:id/execute` → `executeRun` had its own call
 * into `runEvaluationWithConnector` (the "classic path") that passed
 * `{ evaluatorId, skipJudge }` but silently DROPPED `judgeModelId` — while the
 * sibling paths (`runSingleUseCase`, `executeEvaluationRun`) forwarded it.
 * The judge then resolved to `BEDROCK_MODEL_ID` env or the agent's own model,
 * so a run configured with a specific judge model could be scored by a
 * completely different judge (in the worst case the mock/demo judge) without
 * any signal. The existing judgeModelIdFlag test covers the
 * /api/storage/evaluation-runs path; this one pins the benchmarks/:id/execute
 * path specifically.
 *
 * The discriminating signal
 * ─────────────────────────
 * We execute with `modelId` set to a Bedrock model key but `judgeModelId:
 * 'demo-model'` (the mock judge provider). Only if the run-level judge model
 * actually reaches the judge does the report get the demo provider's
 * mock/simulated reasoning — the fallback chain (BEDROCK_MODEL_ID or the
 * agent's Bedrock modelId) would either produce real LLM prose (creds
 * available) or an error (no creds, e.g. CI). We also assert the persisted
 * report carries `judgeModelId` for the audit trail.
 *
 * Prerequisites
 * ─────────────
 *   • Backend running (npm run dev:server). Test self-skips otherwise.
 *   • OpenSearch storage (the execute route 400s in file/sample-only mode);
 *     the test self-skips in that case too.
 */

import { request as httpRequest } from 'http';
import { getTestBackendUrl } from '@/tests/integration/testConfig';

const TEST_TIMEOUT = 120_000;
const BASE_URL = getTestBackendUrl();

// Plain Node http with agent:false — same undici/Jest-30 dodge as the other
// CLI integration tests in this repo.
function httpJson<T = any>(
  method: string,
  url: string,
  body?: unknown
): Promise<{ status: number; body: T; raw: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest(
      {
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname + u.search,
        method,
        headers: {
          Accept: 'application/json',
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          try {
            resolve({ status: res.statusCode || 0, body: text ? JSON.parse(text) : ({} as T), raw: text });
          } catch {
            resolve({ status: res.statusCode || 0, body: text as any, raw: text });
          }
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('POST /api/storage/benchmarks/:id/execute — judgeModelId plumbing', () => {
  let backendAvailable = false;
  let opensearchAvailable = false;
  let testCaseId: string | undefined;
  let benchmarkId: string | undefined;
  const reportIds: string[] = [];

  beforeAll(async () => {
    try {
      const health = await httpJson('GET', `${BASE_URL}/api/agents`);
      backendAvailable = health.status === 200;
      if (backendAvailable) {
        const s = await httpJson<any>('GET', `${BASE_URL}/api/storage/health`);
        opensearchAvailable = s.body?.status === 'ok' && s.body?.backend !== 'file';
      }
    } catch {
      backendAvailable = false;
    }
    if (!backendAvailable) {
      console.warn('[benchmarkExecuteJudgeModel] Backend not reachable — skipping');
    } else if (!opensearchAvailable) {
      console.warn('[benchmarkExecuteJudgeModel] OpenSearch storage not available — skipping');
    }
  }, TEST_TIMEOUT);

  afterAll(async () => {
    for (const id of reportIds) {
      await httpJson('DELETE', `${BASE_URL}/api/storage/runs/${encodeURIComponent(id)}`).catch(() => {});
    }
    if (benchmarkId) {
      await httpJson('DELETE', `${BASE_URL}/api/storage/benchmarks/${encodeURIComponent(benchmarkId)}`).catch(() => {});
    }
    if (testCaseId) {
      await httpJson('DELETE', `${BASE_URL}/api/storage/test-cases/${encodeURIComponent(testCaseId)}`).catch(() => {});
    }
  }, TEST_TIMEOUT);

  it(
    'run-level judgeModelId reaches the judge and is persisted on the report',
    async () => {
      if (!backendAvailable || !opensearchAvailable) return;

      // 1. Create a minimal test case + benchmark.
      const tc = await httpJson<any>('POST', `${BASE_URL}/api/storage/test-cases`, {
        name: 'judgeModelId-execute-path-tc',
        category: 'Diagnostics',
        difficulty: 'Easy',
        initialPrompt: 'Say hello',
        expectedOutcomes: ['Agent responds'],
        labels: [],
      });
      expect(tc.status).toBeLessThan(300);
      testCaseId = tc.body.id;

      const bm = await httpJson<any>('POST', `${BASE_URL}/api/storage/benchmarks`, {
        name: 'judgeModelId-execute-path-bm',
        description: 'integration: judgeModelId through benchmarks/:id/execute',
        testCaseIds: [testCaseId],
      });
      expect(bm.status).toBeLessThan(300);
      benchmarkId = bm.body.id;

      // 2. Execute with agent model = Bedrock key, judge model = demo-model.
      //    Only the run-level judgeModelId resolves to the mock judge; every
      //    fallback in the chain (BEDROCK_MODEL_ID env, agent modelId) is a
      //    real Bedrock model that would NOT produce mock reasoning.
      const exec = await httpJson<any>(
        'POST',
        `${BASE_URL}/api/storage/benchmarks/${encodeURIComponent(benchmarkId!)}/execute`,
        {
          name: 'judgeModelId-execute-path-run',
          agentKey: 'demo',
          modelId: 'claude-sonnet-4',
          judgeModelId: 'demo-model',
        }
      );
      // SSE stream — collect the raw text and pull out the completed run.
      expect(exec.status).toBe(200);
      const completedEvent = exec.raw
        .split('\n\n')
        .map((block) => block.replace(/^data: /, '').trim())
        .filter(Boolean)
        .map((line) => { try { return JSON.parse(line); } catch { return null; } })
        .find((evt) => evt?.type === 'completed');
      expect(completedEvent).toBeDefined();
      const run = completedEvent.run;
      expect(run.judgeModelId).toBe('demo-model');

      const result = run.results[testCaseId!];
      expect(result?.status).toBe('completed');
      const reportId = result.reportId;
      expect(reportId).toBeTruthy();
      reportIds.push(reportId);

      // 3. The persisted report carries the judge audit trail…
      const report = await httpJson<any>('GET', `${BASE_URL}/api/storage/runs/${encodeURIComponent(reportId)}`);
      expect(report.status).toBe(200);
      const doc = report.body.run ?? report.body;
      expect(doc.judgeModelId).toBe('demo-model');

      // 4. …and the verdict provably came from the demo judge, not a fallback.
      expect(doc.llmJudgeReasoning || '').toMatch(/mock|simulated|demo/i);
    },
    TEST_TIMEOUT
  );
});
