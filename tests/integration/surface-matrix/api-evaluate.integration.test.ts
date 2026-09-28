/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Surface matrix · API · `POST /api/evaluate` (single test case, SSE)
 *
 * The endpoint the CLI `run` command, the Test Case page's "Run Test" and the
 * Quick Run modal all call. Pinned against a real REST agent:
 *   - by `testCaseId`: 200 `text/event-stream`; events `started` (with a
 *     `reportId` for disconnect recovery) → `completed` (report `status:
 *     'completed'`, a `passed|failed` verdict, `metricsStatus` resolved);
 *     the report is then readable at `GET /api/storage/runs/:reportId` and
 *     listed under the test case; `runName` is persisted as the report name;
 *   - inline `testCase` (ad-hoc prompt, no stored case) works the same way;
 *   - a `useTraces` agent completes with the verdict arriving via trace
 *     polling (report resolves to `metricsStatus: 'ready'` shortly after);
 *   - validation: missing `modelId` → 400; unknown agent → 400; unknown test
 *     case → 404; missing both `testCaseId` and `testCase` → 400.
 *
 * `modelId` is REQUIRED on this branch (400 without it). Sibling PR #534 makes
 * it optional (the agent's model is owned by its own config) — that case is
 * `test.skip`ped here with the PR number and must be un-skipped when #534 lands.
 */

import { createTestDataTracker, uniqueTestName } from '../../helpers/testDataTracker';
import { startTraceparentRestAgent, type TraceparentRestAgent } from '../../helpers/traceparentRestAgent';
import {
  BASE_URL, DEMO_MODEL, api, backendReady, caseInput, createTestCase, getReport, httpRequest, postSse,
  registerRestAgent, settleStorage, waitForReportsResolved,
} from '../../helpers/surfaceMatrix';

const TEST_TIMEOUT = 180_000;

describe('surface-matrix · API · POST /api/evaluate', () => {
  const tracker = createTestDataTracker();
  let ready = false;
  let plainAgent: TraceparentRestAgent;
  let tracedAgent: TraceparentRestAgent;
  let plainKey: string;
  let tracedKey: string;
  let tc: { id: string; name: string };

  beforeAll(async () => {
    ready = await backendReady();
    if (!ready) { console.warn(`[surface-matrix] backend not reachable at ${BASE_URL}; skipping`); return; }
    plainAgent = await startTraceparentRestAgent({ otlpEndpoint: `${BASE_URL}/v1/traces`, emitSpans: false });
    tracedAgent = await startTraceparentRestAgent({ otlpEndpoint: `${BASE_URL}/v1/traces` });
    plainKey = await registerRestAgent(plainAgent, { useTraces: false, label: 'api-evaluate-plain' });
    tracedKey = await registerRestAgent(tracedAgent, { useTraces: true, label: 'api-evaluate-traced' });
    tracker.customAgent(plainKey);
    tracker.customAgent(tracedKey);
    tc = await createTestCase(caseInput('api-evaluate', 1));
    tracker.testCase(tc.id);
  }, TEST_TIMEOUT);

  afterAll(async () => {
    if (plainAgent) await plainAgent.close();
    if (tracedAgent) await tracedAgent.close();
    await tracker.cleanup();
  }, 60_000);

  function eventsOf(events: { data: any }[], type: string) {
    return events.map((e) => e.data).filter((d) => d?.type === type);
  }

  it('by testCaseId: SSE started → completed, report persisted with a verdict and the given runName', async () => {
    if (!ready) return;
    const runName = uniqueTestName('api-evaluate-run');
    const res = await postSse('/api/evaluate', { testCaseId: tc.id, agentKey: plainKey, modelId: DEMO_MODEL, runName });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');

    const [started] = eventsOf(res.events, 'started');
    expect(started).toBeDefined();
    expect(started.reportId).toMatch(/^report-/);
    expect(started.testCase).toBe(tc.name);
    tracker.run(started.reportId);

    const [completed] = eventsOf(res.events, 'completed');
    expect(completed).toBeDefined();
    expect(eventsOf(res.events, 'error')).toEqual([]);
    expect(completed.reportId).toBe(started.reportId);
    expect(completed.report.status).toBe('completed');
    expect(['passed', 'failed']).toContain(completed.report.passFailStatus);
    expect(completed.report.trajectorySteps).toBeGreaterThan(0);
    expect(typeof completed.report.llmJudgeReasoning).toBe('string');

    const report = await getReport(started.reportId);
    expect(report).toMatchObject({ id: started.reportId, status: 'completed', testCaseId: tc.id, agentKey: plainKey, name: runName });
    expect(['passed', 'failed']).toContain(report.passFailStatus);
    expect(plainAgent.invocations.some((i) => i.conversationId === report.runId)).toBe(true);

    await settleStorage(); // list views lag one refresh on OpenSearch
    const listed = await api<{ runs: any[] }>('GET', `/api/storage/runs/by-test-case/${encodeURIComponent(tc.id)}`);
    expect(listed.runs.map((r) => r.id)).toContain(started.reportId);
  }, TEST_TIMEOUT);

  it('inline testCase (ad-hoc prompt) evaluates without a stored case', async () => {
    if (!ready) return;
    const prompt = `search products ${uniqueTestName('adhoc')}`;
    const res = await postSse('/api/evaluate', {
      testCase: {
        id: `adhoc-${Date.now()}`,
        name: uniqueTestName('adhoc-case'),
        category: 'Ad-hoc',
        difficulty: 'Medium',
        initialPrompt: prompt,
        context: [],
        expectedOutcomes: ['returns a product'],
      },
      agentKey: plainKey,
      modelId: DEMO_MODEL,
    });
    expect(res.status).toBe(200);
    const [started] = eventsOf(res.events, 'started');
    tracker.run(started?.reportId);
    const [completed] = eventsOf(res.events, 'completed');
    expect(completed?.report.status).toBe('completed');
    expect(['passed', 'failed']).toContain(completed.report.passFailStatus);
    expect(plainAgent.invocations.at(-1)?.prompt).toBe(prompt);
  }, TEST_TIMEOUT);

  it('a useTraces agent completes and the verdict lands via trace polling (metricsStatus → ready)', async () => {
    if (!ready) return;
    const res = await postSse('/api/evaluate', { testCaseId: tc.id, agentKey: tracedKey, modelId: DEMO_MODEL });
    expect(res.status).toBe(200);
    const [started] = eventsOf(res.events, 'started');
    tracker.run(started?.reportId);
    const [completed] = eventsOf(res.events, 'completed');
    expect(completed?.report.status).toBe('completed');
    const [report] = await waitForReportsResolved([started.reportId]);
    expect(report.metricsStatus).toBe('ready');
    expect(['passed', 'failed']).toContain(report.passFailStatus);
    expect(tracedAgent.invocations.some((i) => i.conversationId === report.runId)).toBe(true);
  }, TEST_TIMEOUT);

  it('validation: 400 without modelId (pinned; #534 relaxes this), 400 unknown agent, 404 unknown case, 400 no case at all', async () => {
    if (!ready) return;
    expect((await httpRequest('POST', '/api/evaluate', { testCaseId: tc.id, agentKey: plainKey })).status).toBe(400);
    const badAgent = await httpRequest('POST', '/api/evaluate', { testCaseId: tc.id, agentKey: uniqueTestName('no-agent'), modelId: DEMO_MODEL });
    expect(badAgent.status).toBe(400);
    expect(badAgent.body.error).toMatch(/Agent not found/);
    const badCase = await httpRequest('POST', '/api/evaluate', { testCaseId: uniqueTestName('no-case'), agentKey: plainKey, modelId: DEMO_MODEL });
    expect(badCase.status).toBe(404);
    expect(badCase.body.error).toMatch(/Test case not found/);
    expect((await httpRequest('POST', '/api/evaluate', { agentKey: plainKey, modelId: DEMO_MODEL })).status).toBe(400);
  }, TEST_TIMEOUT);

  // Sibling PR #534 ("the agent's model is owned by its config") makes modelId optional.
  // Un-skip when it lands; until then the 400 above is the pinned contract.
  it.skip('without modelId evaluates using the agent-owned model (PR #534)', async () => {
    const res = await postSse('/api/evaluate', { testCaseId: tc.id, agentKey: plainKey });
    expect(res.status).toBe(200);
  });
});
