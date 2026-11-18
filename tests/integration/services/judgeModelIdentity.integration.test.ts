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
 *   - CODE-SDK bodies (`evaluateFnMap`): a `judge()` call rolls the resolved
 *     LLM up to `report.judgeModel` / `report.judgeProvider` and to the run
 *     (the owner-verified miss: SDK reports had only
 *     `matcherResults[].model = 'agent-trace-judge'` and no `judgeModel`);
 *     a deterministic-only body is marked `judgeProvider: 'none'`; the
 *     run-level kind is the first REAL judge kind, never 'none' once any
 *     report judged.
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
    evaluationRuns: { update: jest.fn().mockResolvedValue({}), updateResult: jest.fn().mockResolvedValue({}), getById: jest.fn().mockResolvedValue(null) },
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

  describe('code-SDK bodies (evaluateFnMap)', () => {
    const sdkTestCase = (id: string) => createTestCase(id);

    it('judge() inside the body → report.judgeModel + judgeProvider + run.judgeModel (the SDK-path miss)', async () => {
      mockFetch.mockResolvedValue(okJudge({ judgeModel: SONNET_45, judgeProvider: 'agent' }));
      const { storage, docs } = createStorage();
      const run = createRun({ judgeModelId: 'agent-trace-judge' });
      const tc = sdkTestCase('tc-sdk-judge');
      const evaluateFnMap = new Map<string, (f: any) => Promise<void>>([
        [tc.id, async ({ agent, judge }: any) => {
          const result = await agent.run('Why is it failing?');
          await judge(result, ['names the failing dependency', 'proposes a fix']);
        }],
      ]);

      const result = await executeEvaluationRun(run, [tc], { storageModule: storage, onProgress: () => {}, evaluateFnMap });

      expect(result.status).toBe('completed');
      const [report] = [...docs.values()].filter(d => d.testCaseId);
      expect(report.evaluationType).toBe('deterministic');
      expect(report.llmJudgeResponse).toBeUndefined();               // SDK reports have no classic sidecar
      const judgeRows = report.matcherResults.filter((m: any) => m.method === 'llm-judge');
      expect(judgeRows).toHaveLength(1);
      expect(judgeRows[0].model).toBe('agent-trace-judge');           // requested id (BC)
      expect(judgeRows[0].judgeModel).toBe(SONNET_45);                // resolved LLM on the matcher
      expect(judgeRows[0].judgeProvider).toBe('agent');
      // …and rolled up to the report + the run:
      expect(report.judgeModelId).toBe('agent-trace-judge');
      expect(report.judgeModel).toBe(SONNET_45);
      expect(report.judgeProvider).toBe('agent');
      expect(result.judgeModel).toBe(SONNET_45);
      expect(result.judgeProvider).toBe('agent');
      // the SDK judge call asked for the configured judge id
      expect(JSON.parse(mockFetch.mock.calls[0][1].body).modelId).toBe('agent-trace-judge');
    });

    it("deterministic-only body → judgeModel unset, judgeProvider 'none' on the report AND the run", async () => {
      const { storage, docs } = createStorage();
      const run = createRun({ judgeModelId: 'agent-trace-judge' });
      const tc = sdkTestCase('tc-sdk-det');
      const { expect: ahExpect } = await import('@/lib/matchers/expect');
      const evaluateFnMap = new Map<string, (f: any) => Promise<void>>([
        [tc.id, async ({ agent }: any) => {
          const result = await agent.run('Why is it failing?');
          ahExpect(result.trajectory.length).to.be.greaterThan(0);
        }],
      ]);

      const result = await executeEvaluationRun(run, [tc], { storageModule: storage, onProgress: () => {}, evaluateFnMap });

      const [report] = [...docs.values()].filter(d => d.testCaseId);
      expect(mockFetch).not.toHaveBeenCalled();
      expect(report.passFailStatus).toBe('passed');
      expect(report.judgeModel).toBeUndefined();
      expect(report.judgeProvider).toBe('none');
      expect(result.judgeModel).toBeUndefined();
      expect(result.judgeProvider).toBe('none');
    });

    it("mixed run: the run-level kind is the first REAL judge kind, never 'none' once any case judged (order-independent)", async () => {
      mockFetch.mockResolvedValue(okJudge({ judgeModel: SONNET_45, judgeProvider: 'agent' }));
      const { storage, docs } = createStorage();
      const run = createRun({ judgeModelId: 'agent-trace-judge', concurrency: 1 });
      const det = sdkTestCase('tc-sdk-det-first');
      const judged = sdkTestCase('tc-sdk-judged-second');
      const evaluateFnMap = new Map<string, (f: any) => Promise<void>>([
        [det.id, async ({ agent }: any) => { await agent.run('p'); }],
        [judged.id, async ({ agent, judge }: any) => { await judge(await agent.run('p'), 'claim'); }],
      ]);

      const result = await executeEvaluationRun(run, [det, judged], { storageModule: storage, onProgress: () => {}, evaluateFnMap });

      const byCase = Object.fromEntries([...docs.values()].filter(d => d.testCaseId).map(d => [d.testCaseId, d]));
      expect(byCase[det.id].judgeProvider).toBe('none');
      expect(byCase[det.id].judgeModel).toBeUndefined();
      expect(byCase[judged.id].judgeProvider).toBe('agent');
      expect(byCase[judged.id].judgeModel).toBe(SONNET_45);
      expect(result.judgeModel).toBe(SONNET_45);
      expect(result.judgeProvider).toBe('agent');
    });

    it("a later deterministic-only case never downgrades the run-level identity to 'none' (judged case first)", async () => {
      mockFetch.mockResolvedValue(okJudge({ judgeModel: SONNET_45, judgeProvider: 'agent' }));
      const { storage, docs } = createStorage();
      const run = createRun({ judgeModelId: 'agent-trace-judge', concurrency: 1 });
      const judged = sdkTestCase('tc-sdk-judged-first');
      const det = sdkTestCase('tc-sdk-det-second');
      const evaluateFnMap = new Map<string, (f: any) => Promise<void>>([
        [judged.id, async ({ agent, judge }: any) => { await judge(await agent.run('p'), 'claim'); }],
        [det.id, async ({ agent }: any) => { await agent.run('p'); }],
      ]);

      const result = await executeEvaluationRun(run, [judged, det], { storageModule: storage, onProgress: () => {}, evaluateFnMap });

      const byCase = Object.fromEntries([...docs.values()].filter(d => d.testCaseId).map(d => [d.testCaseId, d]));
      expect(byCase[det.id].judgeProvider).toBe('none');          // per-report truth is kept
      expect(result.judgeModel).toBe(SONNET_45);                   // run-level identity untouched
      expect(result.judgeProvider).toBe('agent');
    });

    it('all judge() calls errored: no identity, and NOT the none marker (an LLM judge was attempted)', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 400, text: () => Promise.resolve('bad request'), json: () => Promise.resolve({}) });
      const { storage, docs } = createStorage();
      const run = createRun({ judgeModelId: 'agent-trace-judge' });
      const tc = sdkTestCase('tc-sdk-errored');
      const evaluateFnMap = new Map<string, (f: any) => Promise<void>>([
        [tc.id, async ({ agent, judge }: any) => { await judge(await agent.run('p'), 'claim'); }],
      ]);

      const result = await executeEvaluationRun(run, [tc], { storageModule: storage, onProgress: () => {}, evaluateFnMap });

      const [report] = [...docs.values()].filter(d => d.testCaseId);
      expect(report.matcherResults.some((m: any) => m.method === 'llm-judge' && m.errored)).toBe(true);
      expect(report.judgeModel).toBeUndefined();
      expect(report.judgeProvider).toBeUndefined();
      expect(result.judgeModel).toBeUndefined();
      expect(result.judgeProvider).toBeUndefined();
    });

    it('old /api/judge (no identity in the response) + agent judge in an SDK body: no fabricated model, kind inferred, guard warns', async () => {
      mockFetch.mockResolvedValue(okJudge({}));
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const { storage, docs } = createStorage();
      const run = createRun({ judgeModelId: 'agent-trace-judge' });
      const tc = sdkTestCase('tc-sdk-old');
      const evaluateFnMap = new Map<string, (f: any) => Promise<void>>([
        [tc.id, async ({ agent, judge }: any) => { await judge(await agent.run('p'), 'claim'); }],
      ]);

      const result = await executeEvaluationRun(run, [tc], { storageModule: storage, onProgress: () => {}, evaluateFnMap });

      const [report] = [...docs.values()].filter(d => d.testCaseId);
      expect(report.judgeModel).toBeUndefined();
      expect(report.judgeProvider).toBe('agent');
      expect(result.judgeModel).toBeUndefined();
      // The runtime guard made the miss visible instead of silently persisting it.
      expect(warn.mock.calls.map(c => String(c[0])).some(m => m.startsWith(`[JudgeIdentity] WARN ${report.id}:`) && m.includes('no resolved judgeModel'))).toBe(true);
    });
  });
});
