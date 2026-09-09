/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test: judge-model IDENTITY reaches the persisted report and run.
 *
 * Drives the REAL `executeEvaluationRun` -> REAL `runEvaluationWithConnector`
 * -> REAL `callBedrockJudge` chain with only the network boundary (`fetch`,
 * standing in for `/api/judge`) and the agent connector mocked, persisting
 * into an in-memory storage module that mirrors the adapters' create/update
 * merge semantics. Asserts what actually lands on the documents:
 *
 *   - agent-trace-judge run: `report.judgeModelId` stays 'agent-trace-judge'
 *     (the judge KIND) while `report.judgeModel` and
 *     `report.llmJudgeResponse.modelId` carry the REAL underlying LLM the
 *     provider resolved, `llmJudgeResponse.judgeProvider` = 'agent', and the
 *     run-level `run.judgeModel` is set from the first report.
 *   - plain Bedrock run: `judgeModel === judgeModelId` (trivially).
 *   - old-server shape (no judgeModel in the /api/judge response) for an
 *     agentic judge: `judgeModel` is NOT fabricated from the provider name.
 *
 * Pre-fix every agent-trace-judge report on the shared cluster persisted
 * `judgeModelId: 'agent-trace-judge'` AND `llmJudgeResponse.modelId:
 * 'agent-trace-judge'` -- the only record of the real model was the
 * env-gated `judgeDebug.modelId`, absent in production.
 */

import type { EvaluationRun, TestCase, AgentConfig } from '@/types';
import type { IStorageModule } from '@/server/adapters/types';

const mockFetch = jest.fn();
global.fetch = mockFetch as any;

// The runner reaches the connector through the module-level registry; give
// it a REST-shaped mock connector (fixed trajectory, no runId -- exactly what
// RESTConnector.execute() returns for a non-instrumented agent).
jest.mock('@/services/connectors/server', () => {
  const connector = {
    type: 'rest', name: 'REST (mock)', supportsStreaming: false, buildPayload: () => ({}),
    execute: async () => ({
      trajectory: [
        { id: 's1', type: 'action', toolName: 'search_logs', toolArgs: { q: 'cpu' }, timestamp: Date.now() },
        { id: 's2', type: 'response', content: 'Root cause: CPU spike.', timestamp: Date.now() },
      ],
      runId: null, rawEvents: [], metadata: {},
    }),
    parseResponse: () => [],
  };
  return { connectorRegistry: { getConnector: () => connector, getForAgent: () => connector } };
});

const mockLoadConfigSync = jest.fn();
jest.mock('@/lib/config/index', () => ({
  loadConfigSync: () => mockLoadConfigSync(),
}));

const CONFIG = {
  agents: [
    { key: 'example-rest-agent', name: 'Example REST Agent', endpoint: 'https://example-agent.internal/invoke', connectorType: 'rest', useTraces: false },
  ],
  models: {
    'test-model': { model_id: 'anthropic.claude-test', display_name: 'Test Model', context_window: 200000, max_output_tokens: 4096 },
    'claude-sonnet-4.6': { model_id: 'us.anthropic.claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6', provider: 'bedrock' },
    'agent-trace-judge': { model_id: 'agent-trace-judge', display_name: 'Agent Trace Judge (pi SDK + query_spans)', provider: 'agent' },
  },
};

jest.mock('@/lib/constants', () => ({
  DEFAULT_CONFIG: {
    agents: [
      { key: 'example-rest-agent', name: 'Example REST Agent', endpoint: 'https://example-agent.internal/invoke', connectorType: 'rest', useTraces: false },
    ],
    models: {
      'test-model': { model_id: 'anthropic.claude-test', display_name: 'Test Model', context_window: 200000, max_output_tokens: 4096 },
      'claude-sonnet-4.6': { model_id: 'us.anthropic.claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6', provider: 'bedrock' },
      'agent-trace-judge': { model_id: 'agent-trace-judge', display_name: 'Agent Trace Judge (pi SDK + query_spans)', provider: 'agent' },
    },
  },
}));

jest.mock('@/server/services/customAgentStore', () => ({
  getCustomAgents: jest.fn().mockReturnValue([]),
}));

jest.mock('@/services/traces/tracePoller', () => ({
  tracePollingManager: { startPolling: jest.fn() },
}));

jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'error').mockImplementation(() => {});
jest.spyOn(console, 'warn').mockImplementation(() => {});

import { executeEvaluationRun } from '@/services/evaluationRunner';

const SONNET_45 = 'amazon-bedrock/global.anthropic.claude-sonnet-4-5-20250929-v1:0';

function createTestCase(id: string): TestCase {
  const now = new Date().toISOString();
  return {
    id, name: `Case ${id}`, description: 'd', labels: ['category:RCA'], currentVersion: 1,
    versions: [{ version: 1, createdAt: now, initialPrompt: 'Why is it failing?', context: [], expectedOutcomes: ['Identifies the root cause'] }],
    isPromoted: false, createdAt: now, updatedAt: now,
    initialPrompt: 'Why is it failing?', context: [], expectedOutcomes: ['Identifies the root cause'],
  } as unknown as TestCase;
}

function createRun(overrides: Partial<EvaluationRun> = {}): EvaluationRun {
  return {
    id: 'run-identity-1', docType: 'evaluation-run', name: 'identity run', createdAt: new Date().toISOString(),
    status: 'pending', agentKey: 'example-rest-agent', modelId: 'test-model', concurrency: 1,
    sources: [], trigger: 'api', testCaseSnapshots: [], results: {}, ...overrides,
  } as EvaluationRun;
}

/** In-memory storage mirroring the adapters' create/{...existing,...updates} merge. */
function createStorage(): { storage: IStorageModule; docs: Map<string, any> } {
  const docs = new Map<string, any>();
  const storage = {
    runs: {
      create: jest.fn().mockImplementation((report: any) => {
        const id = report.id || `report-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const doc = { ...report, id, timestamp: report.timestamp || new Date().toISOString() };
        docs.set(id, doc);
        return Promise.resolve(doc);
      }),
      update: jest.fn().mockImplementation((id: string, updates: any) => {
        const merged = { ...(docs.get(id) || { id }), ...updates, id };
        docs.set(id, merged);
        return Promise.resolve(merged);
      }),
      getById: jest.fn().mockImplementation((id: string) => Promise.resolve(docs.get(id) ?? null)),
      delete: jest.fn().mockResolvedValue({ deleted: true }),
    },
    testCases: { getById: jest.fn().mockResolvedValue(null) },
    benchmarks: { getById: jest.fn().mockResolvedValue(null), updateRun: jest.fn().mockResolvedValue(true) },
    evaluationRuns: { update: jest.fn().mockResolvedValue({}), updateResult: jest.fn().mockResolvedValue({}) },
  } as unknown as IStorageModule;
  return { storage, docs };
}

const okJudge = (extra: Record<string, unknown>) => ({
  ok: true,
  json: () => Promise.resolve({
    passFailStatus: 'passed',
    metrics: { accuracy: 88, faithfulness: 90, latency_score: 85, trajectory_alignment_score: 80 },
    llmJudgeReasoning: 'ok',
    improvementStrategies: [],
    ...extra,
  }),
});

describe('judge identity persisted on report + run (integration)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadConfigSync.mockReturnValue(CONFIG);
  });

  it('agent-trace-judge: judgeModelId stays the provider, judgeModel / llmJudgeResponse.modelId carry the REAL LLM, run.judgeModel set', async () => {
    mockFetch.mockResolvedValue(okJudge({ judgeMode: 'trajectory-only', judgeModel: SONNET_45, judgeProvider: 'agent' }));
    const { storage, docs } = createStorage();
    const run = createRun({ judgeModelId: 'agent-trace-judge' });

    const result = await executeEvaluationRun(run, [createTestCase('tc-a'), createTestCase('tc-b')], {
      storageModule: storage, onProgress: () => {},
    });

    expect(result.status).toBe('completed');
    // Run-level identity: the first report that resolved a model.
    expect(result.judgeModelId).toBe('agent-trace-judge');
    expect(result.judgeModel).toBe(SONNET_45);

    const reports = [...docs.values()].filter(d => d.testCaseId);
    expect(reports).toHaveLength(2);
    for (const report of reports) {
      expect(report.passFailStatus).toBe('passed');
      expect(report.judgeModelId).toBe('agent-trace-judge');           // the judge KIND
      expect(report.judgeModel).toBe(SONNET_45);                        // the real LLM
      expect(report.llmJudgeResponse.modelId).toBe(SONNET_45);          // no longer 'agent-trace-judge'
      expect(report.llmJudgeResponse.judgeProvider).toBe('agent');      // provider is not lost
      expect(report.judgeMode).toBe('trajectory-only');
      // matcherResults keep the configured id (that's the "model" the SDK
      // judge() was bound to); the resolved LLM lives on the report.
      expect(report.matcherResults[0].model).toBe('agent-trace-judge');
    }
    // and the /api/judge request still asked for the configured judge id
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).modelId).toBe('agent-trace-judge');
  });

  it('bedrock: judgeModel equals the configured judge id (trivially) and run.judgeModel is set', async () => {
    mockFetch.mockResolvedValue(okJudge({ judgeModel: 'us.anthropic.claude-sonnet-4-6', judgeProvider: 'bedrock' }));
    const { storage, docs } = createStorage();
    const run = createRun({ judgeModelId: 'us.anthropic.claude-sonnet-4-6' });

    const result = await executeEvaluationRun(run, [createTestCase('tc-a')], {
      storageModule: storage, onProgress: () => {},
    });

    const [report] = [...docs.values()].filter(d => d.testCaseId);
    expect(report.judgeModelId).toBe('us.anthropic.claude-sonnet-4-6');
    expect(report.judgeModel).toBe('us.anthropic.claude-sonnet-4-6');
    expect(report.llmJudgeResponse.modelId).toBe('us.anthropic.claude-sonnet-4-6');
    expect(report.llmJudgeResponse.judgeProvider).toBe('bedrock');
    expect(result.judgeModel).toBe('us.anthropic.claude-sonnet-4-6');
  });

  it('old /api/judge (no judgeModel in the response) + agentic judge: judgeModel is NOT fabricated from the provider name', async () => {
    mockFetch.mockResolvedValue(okJudge({ judgeMode: 'trace-tools' }));
    const { storage, docs } = createStorage();
    const run = createRun({ judgeModelId: 'agent-trace-judge' });

    const result = await executeEvaluationRun(run, [createTestCase('tc-a')], {
      storageModule: storage, onProgress: () => {},
    });

    const [report] = [...docs.values()].filter(d => d.testCaseId);
    expect(report.judgeModelId).toBe('agent-trace-judge');
    expect(report.judgeModel).toBeUndefined();
    // llmJudgeResponse keeps the configured id (never empty) and infers the kind.
    expect(report.llmJudgeResponse.modelId).toBe('agent-trace-judge');
    expect(report.llmJudgeResponse.judgeProvider).toBe('agent');
    expect(result.judgeModel).toBeUndefined();
  });
});
