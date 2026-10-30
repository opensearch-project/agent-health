/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration: a NEW evaluation run with a `kind: 'deterministic'` evaluator
 * is scored in code — never by the LLM judge — on a real server.
 *
 * Pre-fix the runner forwarded the deterministic evaluator id to /api/judge,
 * which built a Bedrock request with a BLANK system prompt → ValidationException
 * → 10 client retries with exponential back-off (~8.5 min per case) → an
 * errored report. Only Retry judgement scored deterministic evaluators in code.
 *
 * Fixture: a stub REST agent (an in-test HTTP server) that answers with ranked
 * tool hits; a generic deterministic evaluator (ranked-hit / ranked-recall /
 * mrr, gold from an `expectedOutcomes` pattern); two test cases — one whose
 * hits cover the gold ids, one for which the agent returns NO hits.
 *
 *   POST /api/storage/evaluation-runs  { evaluatorId: <deterministic> }
 *     → the run completes within seconds (not minutes);
 *     → the hit case's report carries the code-computed verdict:
 *       passFailStatus 'passed', judgeMode 'deterministic', metrics per
 *       declared metric, a scoringSnapshot, matcher rows, NO llmJudgeResponse,
 *       NO judgeModelId, NO judgeError;
 *     → the no-hits case is NOT EVALUABLE: metricsStatus 'error', no verdict,
 *       traceError names the evaluator — excluded from the pass rate;
 *     → run.stats: passed 1, errored 1, failed 0.
 *
 * Requires a backend (AH_PORT). Every created id is deleted in afterAll.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getTestBackendUrl } from '@/tests/integration/testConfig';
import { createTestDataTracker, uniqueTestName } from '../../../../helpers/testDataTracker';

const BASE_URL = getTestBackendUrl();
const tracker = createTestDataTracker();
const TEST_TIMEOUT = 90_000;

const checkBackend = async (): Promise<boolean> => {
  try {
    const r = await fetch(`${BASE_URL}/api/storage/health`);
    return (await r.json()).status === 'ok';
  } catch {
    return false;
  }
};

const evaluatorBody = () => ({
  name: uniqueTestName('ranked-retrieval-new-run'),
  description: 'generic deterministic evaluator fixture',
  kind: 'deterministic',
  metrics: [
    { name: 'hit@1', compute: { type: 'ranked-hit', k: 1 }, weight: 0.25, primary: true },
    { name: 'hit@3', compute: { type: 'ranked-hit', k: 3 }, weight: 0.25, primary: true },
    { name: 'recall@5', compute: { type: 'ranked-recall', k: 5, denominator: 'full-gold' }, weight: 0.25, primary: true },
    { name: 'mrr', compute: { type: 'mrr' }, weight: 0.25 },
  ],
  passPolicy: { kind: 'gates', gates: [{ metric: 'hit@3', min: 1 }] },
  inputs: {
    gold: { source: 'expectedOutcomes-pattern', pattern: '^Gold id\\(s\\):\\s*(.+)$' },
    prediction: { source: 'tool-hits-ordered' },
  },
});

/** Read the SSE stream of POST /evaluation-runs until `completed`; return the runId. */
async function startRunAndWait(body: Record<string, unknown>, timeoutMs: number): Promise<{ runId: string; elapsedMs: number }> {
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE_URL}/api/storage/evaluation-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) throw new Error(`POST /evaluation-runs → ${res.status} ${await res.text()}`);
    const text = await res.text(); // the server ends the stream after `completed`
    const runId = text.match(/"runId":"([^"]+)"/)?.[1];
    if (!runId) throw new Error(`no runId in SSE stream: ${text.slice(0, 300)}`);
    if (!/event: completed/.test(text)) throw new Error(`stream ended without 'completed': ${text.slice(-300)}`);
    return { runId, elapsedMs: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

describe('deterministic evaluator — NEW evaluation run is code-scored, never LLM-judged', () => {
  let backendAvailable = false;
  let agentServer: http.Server;
  let agentUrl = '';
  let agentHits = 0;

  beforeAll(async () => {
    backendAvailable = await checkBackend();
    // Stub REST agent: ranked hits for the normal prompt, NO hits when the
    // prompt asks for "nothing" (→ the not-evaluable case).
    agentServer = http.createServer((req, res) => {
      let raw = '';
      req.on('data', c => { raw += c; });
      req.on('end', () => {
        agentHits++;
        const noHits = /nothing/i.test(raw);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(noHits
          ? { toolCalls: [{ name: 'search', args: { query: 'nothing' }, result: { status: 'ok', hits: [] } }], answer: 'I found nothing.' }
          : {
              toolCalls: [{ name: 'search', args: { query: 'widgets' }, result: { status: 'ok', hits: [{ id: 'doc-2' }, { id: 'doc-1' }, { id: 'doc-9' }] } }],
              answer: 'The relevant items are doc-1 and doc-2.',
            }));
      });
    });
    await new Promise<void>(r => agentServer.listen(0, '127.0.0.1', r));
    agentUrl = `http://127.0.0.1:${(agentServer.address() as AddressInfo).port}/run`;
  });

  afterAll(async () => {
    await tracker.cleanup();
    await new Promise<void>(r => agentServer.close(() => r()));
  });

  it(
    'scores every case in code within seconds; a case with no candidates is "not evaluable", not failed',
    async () => {
      if (!backendAvailable) { console.warn('backend unavailable — skipping'); return; }

      const evRes = await fetch(`${BASE_URL}/api/storage/evaluators`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(evaluatorBody()),
      });
      expect(evRes.status).toBe(201);
      const evaluator = await evRes.json();
      tracker.evaluator(evaluator.id);

      const mkCase = async (name: string, prompt: string) => {
        const r = await fetch(`${BASE_URL}/api/storage/test-cases`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: uniqueTestName(name), category: 'Retrieval', difficulty: 'Easy', initialPrompt: prompt,
            expectedOutcomes: ['The agent lists the widget documents', 'Gold id(s): doc-1, doc-2'], context: [], expectedTrajectory: [],
          }),
        });
        expect(r.ok).toBe(true);
        const tc = await r.json();
        tracker.testCase(tc.id);
        return tc.id as string;
      };
      const hitCase = await mkCase('det-new-run-hit', 'Find the widget documents');
      const emptyCase = await mkCase('det-new-run-empty', 'Find nothing at all');

      const agRes = await fetch(`${BASE_URL}/api/agents/custom`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: uniqueTestName('stub-rest-agent'), endpoint: agentUrl, connectorType: 'rest' }),
      });
      expect(agRes.status).toBe(201);
      const agentKey = (await agRes.json()).agent.key as string;
      tracker.customAgent(agentKey);

      // Pre-fix this took ~8.5 min per case (10 judge attempts with exponential
      // back-off against a blank system prompt). 60 s is generous for two
      // stub-agent round-trips + code scoring on a shared file/OpenSearch backend.
      const { runId, elapsedMs } = await startRunAndWait({
        sources: [{ type: 'test-case-ids', ids: [hitCase, emptyCase] }],
        agentKey,
        evaluatorId: evaluator.id,
        name: uniqueTestName('det-new-run'),
      }, 60_000);
      tracker.evaluationRun(runId);
      expect(elapsedMs).toBeLessThan(60_000);
      expect(agentHits).toBe(2);

      const run = (await (await fetch(`${BASE_URL}/api/storage/evaluation-runs/${runId}`)).json());
      expect(run.status).toBe('completed');
      for (const result of Object.values(run.results ?? {}) as Array<{ reportId: string }>) tracker.run(result.reportId);

      const hitReport = (await (await fetch(`${BASE_URL}/api/storage/runs/${run.results[hitCase].reportId}`)).json());
      expect(hitReport.passFailStatus).toBe('passed');
      expect(hitReport.metricsStatus).toBe('completed');
      expect(hitReport.judgeMode).toBe('deterministic');
      expect(hitReport.evaluatorId).toBe(evaluator.id);
      expect(hitReport.metrics).toEqual({ 'hit@1': 1, 'hit@3': 1, 'recall@5': 1, mrr: 1 });
      expect(hitReport.score).toBe(1);
      expect(hitReport.scoringSnapshot?.primaryMetrics).toEqual(['hit@1', 'hit@3', 'recall@5']);
      expect(Array.isArray(hitReport.matcherResults)).toBe(true);
      expect(hitReport.matcherResults).toHaveLength(4);
      // No LLM ran: nothing names a judge model, no judge sidecar, no judge error.
      expect(hitReport.judgeModelId ?? null).toBeNull();
      expect(hitReport.judgeModel ?? undefined).toBeUndefined();
      expect(hitReport.llmJudgeResponse ?? null).toBeNull();
      expect(hitReport.judgeError ?? undefined).toBeUndefined();
      expect(hitReport.traceError ?? undefined).toBeUndefined();
      // The agent output is untouched.
      expect(hitReport.trajectory.some((s: any) => s.type === 'tool_result')).toBe(true);

      const emptyReport = (await (await fetch(`${BASE_URL}/api/storage/runs/${run.results[emptyCase].reportId}`)).json());
      expect(emptyReport.metricsStatus).toBe('error');
      expect(emptyReport.passFailStatus ?? null).toBeNull();
      expect(emptyReport.judgeMode).toBe('deterministic');
      expect(emptyReport.traceError).toContain(`Not evaluable by ${evaluator.name}`);
      expect(emptyReport.metrics).toEqual({});
      expect(emptyReport.scoringSnapshot?.unevaluable?.length).toBeGreaterThan(0);
      expect(emptyReport.llmJudgeResponse ?? null).toBeNull();

      expect(run.results[hitCase].passFailStatus).toBe('passed');
      expect(run.results[emptyCase].passFailStatus ?? undefined).toBeUndefined();
      expect(run.stats).toMatchObject({ passed: 1, failed: 0, errored: 1, total: 2 });
    },
    TEST_TIMEOUT,
  );
});
