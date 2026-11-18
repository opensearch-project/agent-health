/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration: an agent that OWNS its model (a `rest` agent whose payload is
 * hook-built, or `connectorConfig.agentOwnsModel: true`) and declares none.
 *
 *   - Its run and reports carry NO model id — never `''`, never the catalog
 *     fallback the caller sent (`demo-model` → `mock://demo-model` on every
 *     report of the reproducing run).
 *   - Once its spans arrive, the model THEY report (`gen_ai.request.model` +
 *     `gen_ai.provider.name` on the chat spans) is stamped on the report with
 *     `modelSource: 'observed'`, and on the run (first report wins) through
 *     the real finalize path, so the runs list and compare captions show it.
 *   - No spans → stays blank.
 *   - A catalog agent run with a requested catalog model is unchanged.
 *
 * Real runner, real `FileStorageModule`, real `LocalRunSink.finalize`; only
 * the agent invocation and the trace fetch are stubbed (fixture spans shaped
 * like a hosted search service's traces: `invoke_agent` → `chat` ×2 → tool).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { executeEvaluationRun } from '@/services/evaluationRunner';
import { FileStorageModule } from '@/server/adapters/file/StorageModule';
import { LocalRunSink } from '@/services/runSink';
import { resolveEvaluationRunModelId } from '@/server/services/runModelResolution';
import type { EvaluationRun, TestCase, AgentConfig } from '@/types';
import type { EvaluateFn } from '@/services/sourceResolver';

const AGENTS: AgentConfig[] = [
  // Hook-built REST payload: the connector's default `model` field is never sent.
  { key: 'search-service', name: 'Search service (REST, hook-built payload)', endpoint: 'http://127.0.0.1:1/search', connectorType: 'rest', useTraces: true,
    tracePolling: { maxAttempts: 1, intervalMs: 0 }, hooks: { beforeRequest: async (ctx: any) => ctx } } as AgentConfig,
  { key: 'hosted-agent', name: 'Hosted agent (agentOwnsModel)', endpoint: 'http://127.0.0.1:1/ask', connectorType: 'rest', useTraces: true,
    tracePolling: { maxAttempts: 1, intervalMs: 0 }, connectorConfig: { agentOwnsModel: true } } as AgentConfig,
  { key: 'catalog-agent', name: 'Catalog agent (plain REST)', endpoint: 'http://127.0.0.1:1/ask', connectorType: 'rest', useTraces: false } as AgentConfig,
];
const MODELS = {
  'demo-model': { model_id: 'mock://demo-model', display_name: 'Demo Model', provider: 'demo' },
  'claude-sonnet': { model_id: 'anthropic.claude-sonnet-4', display_name: 'Claude Sonnet', provider: 'bedrock' },
};

jest.mock('@/services/evaluation', () => ({
  ...jest.requireActual('@/services/evaluation'),
  runEvaluationWithConnector: jest.fn(),
  invokeAgent: jest.fn(),
  callBedrockJudge: jest.fn(),
}));
jest.mock('@/services/connectors/server', () => ({
  connectorRegistry: { getForAgent: jest.fn(() => ({ ownsModel: false })) },
}));
jest.mock('@/lib/config/index', () => ({
  // Lazy: `AGENTS` / `MODELS` are module consts hoisted below the mocks.
  loadConfigSync: jest.fn(() => ({ agents: AGENTS, models: MODELS })),
}));
jest.mock('@/lib/constants', () => ({
  DEFAULT_CONFIG: { agents: [], models: {
    'demo-model': { model_id: 'mock://demo-model', display_name: 'Demo Model', provider: 'demo' },
    'claude-sonnet': { model_id: 'anthropic.claude-sonnet-4', display_name: 'Claude Sonnet', provider: 'bedrock' },
  } },
}));
jest.mock('@/server/services/customAgentStore', () => ({ getCustomAgents: jest.fn(() => []) }));
jest.mock('@/lib/debug', () => ({ debug: jest.fn() }));
jest.mock('@/services/traces/tracePoller', () => ({ tracePollingManager: { startPolling: jest.fn() } }));
jest.mock('@/services/traces/index', () => ({ fetchTracesForRun: jest.fn() }));

import { invokeAgent } from '@/services/evaluation';
import { fetchTracesForRun } from '@/services/traces/index';

const mockInvokeAgent = invokeAgent as jest.Mock;
const mockFetchTraces = fetchTracesForRun as jest.MockedFunction<typeof fetchTracesForRun>;

const T0 = '2026-01-01T00:00:00.000Z';
const span = (id: string, name: string, attributes: Record<string, unknown>, offsetMs = 0) => ({
  spanId: id, traceId: 'trace-search-1', name, status: 'OK', attributes,
  startTime: new Date(Date.parse(T0) + offsetMs).toISOString(), endTime: new Date(Date.parse(T0) + offsetMs + 10).toISOString(),
});
/** A hosted search service's trace: provider + model only on the LLM-call spans. */
const SERVICE_SPANS = [
  span('root', 'invoke_agent search-agent', { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.provider.name': 'example-provider' }, 0),
  span('tool', 'execute_tool search_index', { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.provider.name': 'example-provider' }, 20),
  span('chat2', 'chat', { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'example-model-v1', 'gen_ai.provider.name': 'example-provider' }, 40),
  span('chat1', 'chat', { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'example-model-v1', 'gen_ai.provider.name': 'example-provider' }, 10),
  span('http', 'POST /{index}/_search', { 'http.request.method': 'POST' }, 30),
];

function stubInvocation() {
  return { trajectory: [{ type: 'response', content: 'agent output' }], rawEvents: [], runId: 'agent-run-1', agentDurationMs: 1000, connector: { type: 'rest' } as any };
}
const TC: TestCase = { id: 'tc-1', name: 'TC', initialPrompt: 'Which listings match?', context: [] } as unknown as TestCase;

/** What `POST /api/storage/evaluation-runs` does: the model id it records for `agentKey` given the caller's `modelId`. */
function makeRun(agentKey: string, requestedModelId: string | undefined): EvaluationRun {
  const agent = AGENTS.find(a => a.key === agentKey);
  return {
    id: `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, name: 'Run', agentKey,
    modelId: resolveEvaluationRunModelId(agent, requestedModelId),
    status: 'running', results: {}, createdAt: new Date().toISOString(),
    testCaseSnapshots: [{ id: TC.id, version: 1, name: TC.name }],
  } as unknown as EvaluationRun;
}

describe('agent-owned model: never a catalog fallback, observed from traces (runner + FileStorageModule)', () => {
  let tmpDir: string;
  let storage: FileStorageModule;
  let sink: LocalRunSink;

  beforeEach(async () => {
    jest.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-model-'));
    storage = new FileStorageModule(tmpDir);
    sink = new LocalRunSink(storage as any);
    mockInvokeAgent.mockResolvedValue(stubInvocation());
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  async function runCase(run: EvaluationRun) {
    await storage.evaluationRuns.create(run as any);
    const evalFn: EvaluateFn = jest.fn(async ({ agent }: any) => { await agent.run(TC.initialPrompt); });
    const completed = await executeEvaluationRun(run, [TC], { storageModule: storage as any, evaluateFnMap: new Map([[TC.id, evalFn]]), onProgress: jest.fn() });
    const finalized = await sink.finalize(run.id, { status: 'completed', completedRun: completed });
    const report = await storage.runs.getById((run.results as any)[TC.id].reportId);
    return { report: report as any, finalized: finalized as any };
  }

  it.each([
    ['hook-built REST payload', 'search-service'],
    ['connectorConfig.agentOwnsModel', 'hosted-agent'],
  ])('%s: the caller\'s `demo-model` fallback is dropped; report + run record the model observed on the chat spans', async (_label, agentKey) => {
    mockFetchTraces.mockResolvedValue({ spans: SERVICE_SPANS, total: SERVICE_SPANS.length } as any);
    const run = makeRun(agentKey, 'demo-model');
    expect(run.modelId).toBeUndefined();

    const { report, finalized } = await runCase(run);

    expect(report.status).toBe('completed');
    expect(JSON.stringify(report)).not.toContain('mock://demo-model');
    expect(report).toMatchObject({ modelId: 'example-model-v1', modelName: 'example-provider · example-model-v1', modelSource: 'observed' });
    expect(report.spans).toHaveLength(SERVICE_SPANS.length);
    // Run-level: what the runs list column and the compare caption read.
    expect(finalized).toMatchObject({ modelId: 'example-model-v1', modelName: 'example-provider · example-model-v1', modelSource: 'observed' });
    expect((await storage.evaluationRuns.getById(run.id)) as any).toMatchObject({ modelId: 'example-model-v1', modelSource: 'observed' });
  });

  it('no spans → the model stays blank on the report and the run (never \'\' and never a fallback)', async () => {
    mockFetchTraces.mockResolvedValue({ spans: [], total: 0 } as any);
    const { report, finalized } = await runCase(makeRun('search-service', 'demo-model'));

    expect(report.status).toBe('completed');
    expect('modelId' in report).toBe(false);
    expect('modelName' in report).toBe(false);
    expect(report.modelSource).toBeUndefined();
    expect(finalized.modelId).toBeUndefined();
    expect(finalized.modelSource).toBeUndefined();
  });

  it('spans without a model attribute → blank too (nothing is inferred from a provider alone)', async () => {
    mockFetchTraces.mockResolvedValue({ spans: [SERVICE_SPANS[0], SERVICE_SPANS[1]], total: 2 } as any);
    const { report } = await runCase(makeRun('hosted-agent', undefined));
    expect('modelId' in report).toBe(false);
    expect(report.spans).toHaveLength(2);
  });

  it('a catalog agent keeps the requested catalog model exactly as before (modelId + display name, no observed source)', async () => {
    const run = makeRun('catalog-agent', 'claude-sonnet');
    expect(run.modelId).toBe('claude-sonnet');
    const { report, finalized } = await runCase(run);
    // Pre-existing SDK-path behaviour: the final report carries the resolved
    // provider model id of the requested catalog key.
    expect(report).toMatchObject({ modelId: 'anthropic.claude-sonnet-4', modelName: 'anthropic.claude-sonnet-4' });
    expect(report.modelSource).toBeUndefined();
    expect(finalized.modelId).toBe('claude-sonnet');
    expect(finalized.modelSource).toBeUndefined();
  });
});
