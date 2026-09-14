/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test: POST /api/judge, provider 'agent' (trace judge), hints-only
 * scoping for REST-connector agents with no runId.
 *
 * Verifies the route -> service contract over a REAL HTTP request/response
 * (supertest against the actual express app + the real `judge.ts` router +
 * real JSON body-parsing middleware), with only the LLM-driving service
 * (`evaluateWithPiAgenticTrace`, which would otherwise spin up the pi SDK and
 * need Bedrock credentials) mocked at its module boundary — the same pattern
 * `tests/integration/server/routes/assistant.integration.test.ts` uses for
 * the claude/Bedrock/LiteLLM dispatch. Does NOT require:
 *   - the pi SDK / a real judge model / AWS credentials
 *   - the dev server running (AH_PORT/4001) — this boots its own in-process
 *     express app on an ephemeral port via supertest
 *
 * This is the regression coverage for the bug fixed alongside PR #461
 * (trace-poll-fix): a REST-shaped report with NO runId (REST connectors never
 * mint one outside trace-mode polling — see services/traces/judgeAgentsHints.ts
 * `hasTraceCorrelation` doc comment) but WITH Strategy C `agents` correlation
 * hints (serviceName + time-window, from `buildJudgeAgentsHints`, #264) used
 * to 400 unconditionally at this route before ever reaching the judge. The
 * tool-level scoping behavior (query_spans/query_logs querying by `agents`
 * instead of `runIds` when there's no runId) is unit-tested directly against
 * the real `createTraceJudgeExtension` in
 * tests/unit/server/services/traceJudgeTools.test.ts — this test's job is the
 * route/HTTP boundary: does the request reach the service at all.
 *
 * Run:
 *   npm test -- --testPathPatterns=judgeAgentProviderHints.integration
 */

import express from 'express';
import request from 'supertest';

const mockEvaluateWithPiAgenticTrace = jest.fn();
jest.mock('@/server/services/piAgenticJudgeService', () => ({
  evaluateWithPiAgenticTrace: (...args: any[]) => mockEvaluateWithPiAgenticTrace(...args),
  describeDefaultAgentJudgeModel: jest.fn(),
  AGENT_JUDGE_MODEL_ENV: 'AH_AGENT_JUDGE_MODEL_ID',
}));

const mockGetEvaluatorById = jest.fn();
jest.mock('@/server/adapters', () => ({
  getStorageModule: () => ({ evaluators: { getById: mockGetEvaluatorById } }),
}));

jest.mock('@/lib/debug', () => ({ debug: jest.fn() }));

import judgeRoutes from '@/server/routes/judge';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(judgeRoutes);
  return app;
}

// An evaluator whose inferenceConfig selects the agent (trace) judge provider
// — mirrors how a saved "Example Persona"-style evaluator configures it.
const agentTraceEvaluator = {
  id: 'rest-trace-eval',
  name: 'REST Trace Judge',
  inferenceConfig: { provider: 'agent' },
};

// A trajectory shaped like what a REST connector produces: plain steps, no
// `.runId` on any step (RESTConnector.execute() returns `data.runId ||
// data.id || null`, and this agent's response body carries neither).
const restTrajectory = [
  { type: 'action', toolName: 'search_logs', toolArgs: { query: 'cpu spike' } },
  { type: 'tool_result', toolName: 'search_logs', content: '{"hits": 3}', status: 'SUCCESS' },
  { type: 'response', content: 'Root cause: CPU spike on node-3.' },
];

describe('POST /api/judge — agent provider, hints-only scoping (integration)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetEvaluatorById.mockResolvedValue(agentTraceEvaluator);
  });

  it('reaches the agent trace judge over real HTTP with NO runId but a serviceName+window hint (the reported REST-connector bug)', async () => {
    mockEvaluateWithPiAgenticTrace.mockResolvedValue({
      passFailStatus: 'passed',
      metrics: { accuracy: 92, faithfulness: 90, latency_score: 88, trajectory_alignment_score: 85 },
      llmJudgeReasoning: 'Verified via query_spans against the real OTel window.',
      improvementStrategies: [],
    });

    const agents = [
      { serviceName: 'example-agent', startedAt: Date.now() - 60_000, endedAt: Date.now() },
    ];

    const res = await request(buildApp())
      .post('/api/judge')
      .send({
        trajectory: restTrajectory,
        expectedOutcomes: ['Identifies the CPU spike as root cause'],
        evaluatorId: 'rest-trace-eval',
        agents,
        // no runId — this is the exact shape a REST connector agent using
        // agent-trace-judge WITHOUT useTraces trace-mode polling produces.
      })
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(200);
    expect(res.body.passFailStatus).toBe('passed');
    expect(mockEvaluateWithPiAgenticTrace).toHaveBeenCalledTimes(1);
    const [forwardedRequest] = mockEvaluateWithPiAgenticTrace.mock.calls[0];
    expect(forwardedRequest.runId).toBeUndefined();
    expect(forwardedRequest.agents).toEqual(agents);
  });

  it('reaches the agent trace judge with NO runId but a sessionId-only hint', async () => {
    mockEvaluateWithPiAgenticTrace.mockResolvedValue({
      passFailStatus: 'failed',
      metrics: { accuracy: 40, faithfulness: 50, latency_score: 60, trajectory_alignment_score: 30 },
      llmJudgeReasoning: 'Spans show a different root cause than claimed.',
      improvementStrategies: [],
    });

    const agents = [
      { serviceName: '', startedAt: Date.now() - 60_000, endedAt: Date.now(), sessionId: 'sess-rest-1' },
    ];

    const res = await request(buildApp())
      .post('/api/judge')
      .send({
        trajectory: restTrajectory,
        expectedOutcomes: ['Identifies the CPU spike as root cause'],
        evaluatorId: 'rest-trace-eval',
        agents,
      })
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(200);
    expect(res.body.passFailStatus).toBe('failed');
    expect(mockEvaluateWithPiAgenticTrace).toHaveBeenCalledTimes(1);
  });

  it('degrades to trajectory-only judging over real HTTP (no 400, no query_spans/query_logs) when NEITHER runId nor usable agents hints are present -- the useTraces:false / non-instrumented-agent case', async () => {
    mockEvaluateWithPiAgenticTrace.mockResolvedValue({
      passFailStatus: 'failed',
      metrics: { accuracy: 40, faithfulness: 50, latency_score: 60, trajectory_alignment_score: 30 },
      llmJudgeReasoning: 'Judged from trajectory alone; no trace tools available for this run.',
      improvementStrategies: [],
      judgeMode: 'trajectory-only',
    });

    const res = await request(buildApp())
      .post('/api/judge')
      .send({
        trajectory: restTrajectory,
        expectedOutcomes: ['Identifies the CPU spike as root cause'],
        evaluatorId: 'rest-trace-eval',
        // no runId, no agents at all -- e.g. a `useTraces: false` REST agent's report.
      })
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(200);
    expect(res.body.judgeMode).toBe('trajectory-only');
    expect(mockEvaluateWithPiAgenticTrace).toHaveBeenCalledTimes(1);
    // traceToolsAvailable=false is the 3rd positional arg -- no query_spans/query_logs pack.
    expect(mockEvaluateWithPiAgenticTrace.mock.calls[0][2]).toBe(false);
  });

  it('degrades to trajectory-only judging when agents hints are present but empty of any usable field', async () => {
    mockEvaluateWithPiAgenticTrace.mockResolvedValue({
      passFailStatus: 'failed', metrics: {}, llmJudgeReasoning: 'ok', improvementStrategies: [], judgeMode: 'trajectory-only',
    });

    const res = await request(buildApp())
      .post('/api/judge')
      .send({
        trajectory: restTrajectory,
        expectedOutcomes: ['Identifies the CPU spike as root cause'],
        evaluatorId: 'rest-trace-eval',
        agents: [{ startedAt: 1, endedAt: 2 }], // no serviceName, no sessionId
      })
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(200);
    expect(mockEvaluateWithPiAgenticTrace.mock.calls[0][2]).toBe(false);
  });

  it('regression: a runId-carrying request still works unchanged (Strategy B alone)', async () => {
    mockEvaluateWithPiAgenticTrace.mockResolvedValue({
      passFailStatus: 'passed',
      metrics: { accuracy: 95, faithfulness: 95, latency_score: 95, trajectory_alignment_score: 95 },
      llmJudgeReasoning: 'ok',
      improvementStrategies: [],
    });

    const res = await request(buildApp())
      .post('/api/judge')
      .send({
        trajectory: restTrajectory,
        expectedOutcomes: ['Identifies the CPU spike as root cause'],
        evaluatorId: 'rest-trace-eval',
        runId: 'run-abc-123',
      })
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(200);
    expect(mockEvaluateWithPiAgenticTrace).toHaveBeenCalledTimes(1);
    const [forwardedRequest] = mockEvaluateWithPiAgenticTrace.mock.calls[0];
    expect(forwardedRequest.runId).toBe('run-abc-123');
  });
});
