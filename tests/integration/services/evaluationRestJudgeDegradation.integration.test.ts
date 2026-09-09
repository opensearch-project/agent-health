/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test: `runEvaluationWithConnector` (services/evaluation/index.ts,
 * the "classic"/STANDARD MODE judge path used by every non-`useTraces`
 * agent) driving the REAL `callBedrockJudge` client against a mocked
 * `fetch` boundary that stands in for `/api/judge`.
 *
 * This is the regression coverage for the reported incident: a REST-
 * connector agent declared `useTraces: false` (not OTel-instrumented) whose
 * report has no `runId` and no derivable Strategy C `agents` hint. Pre-fix,
 * picking `judgeModelId: 'agent-trace-judge'` for such an agent made
 * `/api/judge` 400 with "needs a runId or trace correlation hint", and
 * `runEvaluationWithConnector`'s single outer catch turned that into
 * `status: 'failed'`, no `passFailStatus`, no `metricsStatus` -- silently
 * indistinguishable from a genuine agent crash, and invisible to
 * retry-judgement's salvage predicate.
 *
 * Two scenarios, both exercising the REAL service code (only the network
 * boundary is mocked -- the real `/api/judge` route's own degrade decision
 * is covered separately by tests/unit/server/routes/judge.test.ts and
 * tests/integration/server/routes/judgeAgentProviderHints.integration.test.ts):
 *   1. The (now-fixed) route degrades to trajectory-only judging and
 *      returns a real verdict + `judgeMode: 'trajectory-only'` -- the report
 *      must carry a real `passFailStatus` and the persisted `judgeMode`.
 *   2. The judge call fails for some OTHER reason (defense in depth -- the
 *      fix isn't "the 400 can never happen again", it's "a judge failure
 *      after a successful agent run must never masquerade as a generic
 *      failure") -- the report must land in the canonical
 *      `metricsStatus: 'error'` / `status: 'completed'` shape, and
 *      retryJudgement's `isJudgeFailedCase` must recognize it as salvageable.
 */

import type { AgentConfig, TestCase } from '@/types';
import type { ConnectorRegistry, AgentConnector, ConnectorResponse } from '@/services/connectors/types';

const mockFetch = jest.fn();
global.fetch = mockFetch as any;

import { runEvaluationWithConnector } from '@/services/evaluation';
import { isJudgeFailedCase } from '@/services/evaluation/retryJudgement';

function buildTestCase(): TestCase {
  const now = new Date().toISOString();
  return {
    id: 'tc-rest-no-traces',
    name: 'REST no-traces case',
    description: 'desc',
    labels: ['category:RCA'],
    currentVersion: 1,
    versions: [{
      version: 1,
      createdAt: now,
      initialPrompt: 'Why is the service failing?',
      context: [],
      expectedOutcomes: ['Identifies the root cause'],
    }],
    isPromoted: false,
    createdAt: now,
    updatedAt: now,
    initialPrompt: 'Why is the service failing?',
    context: [],
    expectedOutcomes: ['Identifies the root cause'],
  } as unknown as TestCase;
}

/** A minimal REST-shaped connector: fixed trajectory, no runId (exactly what RESTConnector.execute() returns for an agent whose response body carries neither `runId` nor `id`). */
function buildMockRegistry(): ConnectorRegistry {
  const connector: AgentConnector = {
    type: 'rest',
    name: 'REST (mock)',
    supportsStreaming: false,
    buildPayload: () => ({}),
    execute: async (): Promise<ConnectorResponse> => ({
      trajectory: [
        { id: 's1', type: 'action', toolName: 'search_logs', toolArgs: { query: 'cpu' }, timestamp: Date.now() },
        { id: 's2', type: 'tool_result', toolName: 'search_logs', content: '{"hits":3}', status: 'SUCCESS', timestamp: Date.now() },
        { id: 's3', type: 'response', content: 'Root cause: CPU spike on node-3.', timestamp: Date.now() },
      ] as any,
      runId: null, // REST connectors never mint one outside trace-mode polling
      rawEvents: [],
      metadata: {},
    }),
    parseResponse: () => [],
  } as unknown as AgentConnector;

  return {
    getForAgent: () => connector,
  } as unknown as ConnectorRegistry;
}

function buildAgent(): AgentConfig {
  return {
    key: 'example-rest-agent',
    name: 'Example REST Agent',
    endpoint: 'https://example-agent.internal/invoke',
    connectorType: 'rest',
    useTraces: false, // not OTel-instrumented -- the reported scenario
  } as unknown as AgentConfig;
}

describe('runEvaluationWithConnector — agent-trace-judge against a useTraces:false REST agent (integration)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('produces a real verdict with judgeMode="trajectory-only" when /api/judge degrades instead of erroring', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        passFailStatus: 'passed',
        metrics: { accuracy: 82, faithfulness: 80, latency_score: 90, trajectory_alignment_score: 75 },
        llmJudgeReasoning: 'The trajectory shows the agent identified a plausible root cause from the tool output alone.',
        improvementStrategies: [],
        judgeMode: 'trajectory-only',
      }),
    });

    const report = await runEvaluationWithConnector(
      buildAgent(),
      'test-model',
      buildTestCase(),
      () => {},
      { registry: buildMockRegistry(), judgeModelId: 'agent-trace-judge' }
    );

    // A real verdict -- NOT the reported bug's status:'failed'/passFailStatus:undefined.
    expect(report.status).toBe('completed');
    expect(report.passFailStatus).toBe('passed');
    expect((report as any).judgeMode).toBe('trajectory-only');
    expect(report.llmJudgeReasoning).not.toMatch(/^Evaluation failed:/);

    // The request /api/judge received carried no runId/agents hint -- this
    // agent genuinely has nothing to correlate on.
    const [, requestInit] = mockFetch.mock.calls[0];
    const sentBody = JSON.parse(requestInit.body);
    expect(sentBody.runId).toBeUndefined();
    expect(sentBody.agents).toBeUndefined();
    expect(sentBody.modelId).toBe('agent-trace-judge');
  });

  it('surfaces a judge-step failure as metricsStatus:"error" (never a generic status:"failed") and is salvageable by retry-judgement', async () => {
    // Simulate the judge call failing for ANY reason (defense in depth --
    // this is not conditioned on the specific pre-fix 400; any judge-call
    // exception must land in the canonical shape). A 4xx is the
    // non-retryable branch so this resolves in one attempt.
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: () => Promise.resolve({
        error: 'The agent (trace) judge provider needs a runId or at least one trace correlation hint (agents: serviceName+window, or sessionId) to scope its trace tools — this request had neither.',
      }),
    });

    const report = await runEvaluationWithConnector(
      buildAgent(),
      'test-model',
      buildTestCase(),
      () => {},
      { registry: buildMockRegistry(), judgeModelId: 'agent-trace-judge' }
    ) as any;

    // The agent DID complete (we have a trajectory) -- this must be the
    // canonical buildEvaluatorErrorPatch('judge_failed', ...) shape, not the
    // generic status:'failed' the reported incident produced.
    expect(report.status).toBe('completed');
    expect(report.metricsStatus).toBe('error');
    expect(report.passFailStatus).toBeNull();
    expect(report.traceError).toMatch(/kind=judge_failed/);
    expect(report.traceError).toMatch(/needs a runId/);
    expect(report.trajectory.length).toBeGreaterThan(0);

    // The #462 retry-judgement salvage predicate must recognize this case.
    // Pre-fix (status:'failed', no metricsStatus) it did NOT.
    const runResult = { reportId: 'irrelevant', status: report.status };
    expect(isJudgeFailedCase(report, runResult)).toBe(true);
  });

  it('a genuine agent-invocation failure (not a judge failure) lands on the OUTER catch as an AGENT-stage failure (status:"failed", failureStage:"agent") and never reaches the judge', async () => {
    const throwingRegistry: ConnectorRegistry = {
      getForAgent: () => ({
        type: 'rest',
        name: 'REST (mock)',
        supportsStreaming: false,
        buildPayload: () => ({}),
        execute: async () => { throw new Error('ECONNREFUSED'); },
        parseResponse: () => [],
      }),
    } as unknown as ConnectorRegistry;

    const report = await runEvaluationWithConnector(
      buildAgent(),
      'test-model',
      buildTestCase(),
      () => {},
      { registry: throwingRegistry, judgeModelId: 'agent-trace-judge' }
    ) as any;

    expect(report.status).toBe('failed');
    // Agent-error surfacing: the outer catch now writes the canonical
    // agent-stage shape (metricsStatus:'error' so stats bucket it as errored,
    // never as a verdict; failureStage:'agent'; the real cause on `error`).
    expect(report.metricsStatus).toBe('error');
    expect(report.failureStage).toBe('agent');
    expect(report.passFailStatus).toBeNull();
    expect(report.error).toMatch(/ECONNREFUSED/);
    expect(report.agentError.kind).toBe('connection');
    expect(report.llmJudgeReasoning).toMatch(/Agent request failed — not judged/);
    expect(report.llmJudgeReasoning).toMatch(/ECONNREFUSED/);
    // It is NOT a judge failure — retry-judgement must not offer it.
    expect(isJudgeFailedCase(report, { reportId: 'r', status: report.status })).toBe(false);
    // The judge was never even called -- fetch should not have been reached.
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
