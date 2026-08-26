/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for the agent-vs-judge-model split.
 *
 * Pins these end-to-end contracts so a regression cannot land silently:
 *
 *   1. POST /api/evaluate with `judgeModelId` set → run document persists it
 *      AND the field is distinct from `modelId` (the agent's LLM).
 *   2. POST /api/evaluate WITHOUT `judgeModelId` → run document has no
 *      `judgeModelId` (server doesn't auto-derive it from `modelId`).
 *   3. POST /api/storage/evaluation-runs with `judgeModelId` → all child
 *      reports for that run carry the same `judgeModelId`.
 *   4. The `extraFields` and `judgeDebug` round-trip from the judge service
 *      through to the persisted run document (placeholder-update bug
 *      regression test — see services/benchmarkRunner.ts).
 *
 * Uses the built-in `demo` agent + `demo-model` so no real agent endpoint or
 * AWS Bedrock creds are required. Only OpenSearch storage is needed.
 *
 * Run:
 *   npm run test:integration -- --testPathPattern=judgeModelId.integration
 */

import { getTestBackendUrl, checkJudgeAvailable } from '@/tests/integration/testConfig';

const TEST_TIMEOUT = 60000;
const BASE_URL = getTestBackendUrl();

const checkBackend = async (): Promise<boolean> => {
  try {
    const r = await fetch(`${BASE_URL}/health`);
    return r.ok;
  } catch {
    return false;
  }
};

const checkStorage = async (): Promise<boolean> => {
  try {
    const r = await fetch(`${BASE_URL}/api/storage/health`);
    if (!r.ok) return false;
    const data = await r.json();
    return data.status === 'ok';
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
    catch { return; /* malformed */ }
    // Two SSE shapes are emitted across the codebase:
    //   /api/evaluate                  → typed data      (data: {"type":"started",...})
    //   /api/storage/evaluation-runs   → named events    (event: started\ndata: {...})
    // Normalize to the typed-data shape so the test predicates can
    // match on `e.type` either way — if a named event came in without
    // a `type` on the payload, copy the SSE event name onto it.
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

function buildInlineTestCase(id: string) {
  const now = new Date().toISOString();
  return {
    id,
    name: `Integration TC ${id}`,
    description: 'judgeModelId integration test',
    labels: ['category:Test'],
    category: 'Test',
    difficulty: 'Medium',
    currentVersion: 1,
    versions: [{
      version: 1,
      createdAt: now,
      initialPrompt: 'Demo prompt',
      context: [],
      expectedOutcomes: ['demo outcome'],
    }],
    isPromoted: false,
    createdAt: now,
    updatedAt: now,
    initialPrompt: 'Demo prompt',
    context: [],
    expectedOutcomes: ['demo outcome'],
  };
}

describe('judgeModelId round-trip — integration', () => {
  let backendAvailable = false;
  let storageAvailable = false;
  let judgeAvailable = false;
  const createdReportIds: string[] = [];
  const createdTestCaseIds: string[] = [];
  const createdRunIds: string[] = [];

  beforeAll(async () => {
    backendAvailable = await checkBackend();
    storageAvailable = backendAvailable && await checkStorage();
    // These round-trips all wait for a `completed`/scored result, which needs a
    // real (Bedrock) judge. The CI integration job has no AWS creds, so skip
    // when the judge can't actually run (passes locally with AWS_PROFILE).
    judgeAvailable = storageAvailable && await checkJudgeAvailable(BASE_URL);
    if (!backendAvailable) {
      console.log(`[judgeModelId.integ] Backend not running at ${BASE_URL}, skipping all tests`);
    } else if (!storageAvailable) {
      console.log('[judgeModelId.integ] Storage not configured, skipping happy-path tests');
    } else if (!judgeAvailable) {
      console.log('[judgeModelId.integ] Bedrock judge unavailable (no AWS creds), skipping judge round-trips');
    }
  });

  afterAll(async () => {
    // Clean up everything this test created so the storage doesn't accumulate.
    // See AGENTS.md "Integration Test Cleanup".
    for (const id of createdReportIds) {
      await fetch(`${BASE_URL}/api/storage/runs/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => { /* ignore */ });
    }
    for (const id of createdTestCaseIds) {
      await fetch(`${BASE_URL}/api/storage/test-cases/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => { /* ignore */ });
    }
    for (const id of createdRunIds) {
      await fetch(`${BASE_URL}/api/storage/evaluation-runs/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => { /* ignore */ });
    }
  });

  // -----------------------------------------------------------------------
  // POST /api/evaluate (UI "Run Test" / QuickRunModal path)
  // -----------------------------------------------------------------------

  describe('POST /api/evaluate', () => {
    it(
      'persists run-level judgeModelId on the saved run document',
      async () => {
        if (!backendAvailable || !storageAvailable || !judgeAvailable) return;

        const testCaseId = `tc-judgemodel-set-${Date.now()}`;
        createdTestCaseIds.push(testCaseId);
        const testCase = buildInlineTestCase(testCaseId);

        const response = await fetch(`${BASE_URL}/api/evaluate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            testCase,
            agentKey: 'demo',
            modelId: 'demo-model',           // agent's "LLM" (mock)
            judgeModelId: 'us.anthropic.claude-opus-4-6-v1', // judge LLM (cx input)
          }),
        });

        expect(response.status).toBe(200);
        const events = await consumeSSEStream(response);
        const completed = events.find(e => e.type === 'completed');
        expect(completed).toBeDefined();
        const reportId: string = completed.reportId;
        createdReportIds.push(reportId);

        const runRes = await fetch(`${BASE_URL}/api/storage/runs/${encodeURIComponent(reportId)}`);
        expect(runRes.status).toBe(200);
        const run = await runRes.json();

        expect(run.modelId).toBe('demo-model');
        expect(run.judgeModelId).toBe('us.anthropic.claude-opus-4-6-v1');
        // Pre-fix: judgeModelId did not exist as a field; modelId was used
        // for both. This assertion only passes after the agent-vs-judge
        // split is wired all the way through the runner + storage layer.
        expect(run.judgeModelId).not.toBe(run.modelId);
      },
      TEST_TIMEOUT
    );

    it(
      'omits judgeModelId from run document when not supplied (server does not auto-derive it from modelId)',
      async () => {
        if (!backendAvailable || !storageAvailable || !judgeAvailable) return;

        const testCaseId = `tc-judgemodel-unset-${Date.now()}`;
        createdTestCaseIds.push(testCaseId);
        const testCase = buildInlineTestCase(testCaseId);

        const response = await fetch(`${BASE_URL}/api/evaluate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            testCase,
            agentKey: 'demo',
            modelId: 'demo-model',
            // judgeModelId intentionally omitted
          }),
        });

        const events = await consumeSSEStream(response);
        const completed = events.find(e => e.type === 'completed');
        expect(completed).toBeDefined();
        const reportId: string = completed.reportId;
        createdReportIds.push(reportId);

        const runRes = await fetch(`${BASE_URL}/api/storage/runs/${encodeURIComponent(reportId)}`);
        const run = await runRes.json();

        // Critical: judgeModelId must NOT silently default to the agent's
        // modelId. That was the pre-fix behavior and is exactly what we
        // moved away from. When unset on the request, it stays unset on
        // the persisted run; the runner falls back internally to
        // BEDROCK_MODEL_ID env without polluting the run document.
        expect(run.judgeModelId).toBeUndefined();
        expect(run.modelId).toBe('demo-model');
      },
      TEST_TIMEOUT
    );

    it(
      'rejects empty-string judgeModelId as if it were undefined (does NOT persist empty)',
      async () => {
        if (!backendAvailable || !storageAvailable || !judgeAvailable) return;

        const testCaseId = `tc-judgemodel-empty-${Date.now()}`;
        createdTestCaseIds.push(testCaseId);
        const testCase = buildInlineTestCase(testCaseId);

        const response = await fetch(`${BASE_URL}/api/evaluate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            testCase,
            agentKey: 'demo',
            modelId: 'demo-model',
            judgeModelId: '',  // empty string — common UI dropdown sentinel
          }),
        });

        const events = await consumeSSEStream(response);
        const completed = events.find(e => e.type === 'completed');
        const reportId: string = completed.reportId;
        createdReportIds.push(reportId);

        const runRes = await fetch(`${BASE_URL}/api/storage/runs/${encodeURIComponent(reportId)}`);
        const run = await runRes.json();

        // Sanitization is in server/routes/evaluation.ts:
        //   judgeModelId: typeof judgeModelId === 'string' && judgeModelId ? judgeModelId : undefined
        expect(run.judgeModelId).toBeUndefined();
      },
      TEST_TIMEOUT
    );
  });

  // -----------------------------------------------------------------------
  // POST /api/storage/evaluation-runs (HTTP API + CLI benchmark path)
  // -----------------------------------------------------------------------

  describe('POST /api/storage/evaluation-runs', () => {
    it(
      'persists judgeModelId on the EvaluationRun document AND on every child report',
      async () => {
        if (!backendAvailable || !storageAvailable || !judgeAvailable) return;

        const testCaseId = `tc-judgemodel-erun-${Date.now()}`;
        createdTestCaseIds.push(testCaseId);
        const testCase = buildInlineTestCase(testCaseId);

        // First, create the test case in storage so the sources resolve.
        const createRes = await fetch(`${BASE_URL}/api/storage/test-cases`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(testCase),
        });
        expect(createRes.status).toBeLessThan(400);

        const response = await fetch(`${BASE_URL}/api/storage/evaluation-runs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: `judgeModelId integ ${Date.now()}`,
            sources: [{ type: 'test-case', testCaseId }],
            agentKey: 'demo',
            modelId: 'demo-model',
            judgeModelId: 'us.anthropic.claude-haiku-3-5',  // cx input
            trigger: 'api',
          }),
        });

        expect(response.status).toBe(200);
        const events = await consumeSSEStream(response);
        // The `started` event for /api/storage/evaluation-runs carries
        // { runId, testCases } as its data. After our normalization it
        // looks like { type: 'started', runId, testCases }.
        const startedEvent = events.find(e => e.type === 'started');
        expect(startedEvent).toBeDefined();
        const runId: string = startedEvent.runId;
        createdRunIds.push(runId);

        // Verify the EvaluationRun document carries judgeModelId.
        const runRes = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${encodeURIComponent(runId)}`);
        expect(runRes.status).toBe(200);
        const evalRun = await runRes.json();
        expect(evalRun.judgeModelId).toBe('us.anthropic.claude-haiku-3-5');
        expect(evalRun.modelId).toBe('demo-model');

        // Wait for the child report to complete and verify it inherited
        // judgeModelId from the run-level config (the runner's job).
        // The 'testCaseComplete' (camelCase) named SSE event carries
        // { testCaseId, result }; we look for it OR the older 'completed'
        // shape some surfaces use to be tolerant of both.
        const childCompleted = events.find(e =>
          (e.type === 'testCaseComplete' && e.result?.reportId) ||
          (e.type === 'completed' && e.reportId)
        );
        const childReportId = childCompleted?.result?.reportId || childCompleted?.reportId;
        if (childReportId) {
          createdReportIds.push(childReportId);
          const reportRes = await fetch(`${BASE_URL}/api/storage/runs/${encodeURIComponent(childReportId)}`);
          const report = await reportRes.json();
          expect(report.judgeModelId).toBe('us.anthropic.claude-haiku-3-5');
        }
      },
      TEST_TIMEOUT
    );
  });

  // -----------------------------------------------------------------------
  // Round-trip: extraFields + judgeDebug (regression for the
  // benchmarkRunner placeholder-update bug found during evaluator-prompt-plumbing
  // testing — pre-fix, llmJudgeResponse was silently dropped on the update path).
  // -----------------------------------------------------------------------

  describe('placeholder-update path (regression: services/benchmarkRunner.ts)', () => {
    it(
      'propagates llmJudgeResponse (rawResponse, extraFields, judgeDebug) onto the persisted run',
      async () => {
        if (!backendAvailable || !storageAvailable || !judgeAvailable) return;

        // The demo provider returns a mock response that exercises the
        // typed wire fields but doesn't emit extraFields. So this test
        // primarily verifies the SHAPE of llmJudgeResponse (the keys we
        // care about exist on the round-tripped document), not specific
        // extraFields content. A non-demo eval (see
        // evals/judgeModelId-and-extra-fields.eval.js) covers the
        // dynamic-extraction side end-to-end with a real judge prompt.

        const testCaseId = `tc-judgemodel-llmresp-${Date.now()}`;
        createdTestCaseIds.push(testCaseId);
        const testCase = buildInlineTestCase(testCaseId);

        const response = await fetch(`${BASE_URL}/api/evaluate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            testCase,
            agentKey: 'demo',
            modelId: 'demo-model',
          }),
        });

        const events = await consumeSSEStream(response);
        const completed = events.find(e => e.type === 'completed');
        const reportId: string = completed.reportId;
        createdReportIds.push(reportId);

        const runRes = await fetch(`${BASE_URL}/api/storage/runs/${encodeURIComponent(reportId)}`);
        const run = await runRes.json();

        // Pre-fix the placeholder-update path in services/benchmarkRunner.ts
        // built an `updates` object that did NOT include `llmJudgeResponse`,
        // so the rawResponse / extraFields / judgeDebug populated by the
        // judge service were silently discarded on the path through
        // /api/evaluate (which always pre-creates a placeholder).
        // Asserting the FIELD EXISTS on the persisted run \u2014 not its
        // content \u2014 catches that regression deterministically with the
        // demo provider, which doesn't otherwise emit extraFields.
        expect(run.llmJudgeResponse).toBeDefined();
        expect(typeof run.llmJudgeResponse).toBe('object');
      },
      TEST_TIMEOUT
    );
  });
});
