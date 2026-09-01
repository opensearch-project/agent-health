/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration coverage for #334 + #335 on the SDK code-eval path, asserting the
 * report shape that actually PERSISTS through the real `FileStorageModule`
 * round-trip (not an in-memory mock). This is what catches storage-layer field
 * filtering bugs — e.g. `passFailStatus: null` must be CLEARED on disk for an
 * errored run (using `undefined` would be filtered out by the `!== undefined`
 * allow-list, leaving a stale `'failed'`; see services/evaluation/evaluatorError.ts).
 *
 *   #334 — a useTraces code-eval persists report.traceId + report.spans so the
 *          run-report Traces tab renders for SDK runs.
 *   #335 — an agent subprocess timeout persists as an `errored` report
 *          (metricsStatus='error', passFailStatus=null) with the underlying
 *          message surfaced — not a silent `failed`.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { executeEvaluationRun } from '@/services/evaluationRunner';
import { FileStorageModule } from '@/server/adapters/file/StorageModule';
import type { EvaluationRun, TestCase, AgentConfig } from '@/types';
import type { EvaluateFn } from '@/services/sourceResolver';

jest.mock('@/services/evaluation', () => ({
  // Spread the real module so helpers the runner calls (e.g.
  // computeSdkMatcherSessionMetrics, added in #312) stay defined — only the
  // agent/judge entrypoints below are stubbed. Without this the runner throws
  // "computeSdkMatcherSessionMetrics is not a function", erroring the run.
  ...jest.requireActual('@/services/evaluation'),
  runEvaluationWithConnector: jest.fn(),
  invokeAgent: jest.fn(),
  callBedrockJudge: jest.fn(),
}));
jest.mock('@/connectors/server', () => ({
  connectorRegistry: { getForAgent: jest.fn() },
}));
jest.mock('@/lib/config/index', () => ({
  loadConfigSync: jest.fn(() => ({
    agents: [
      { key: 'traced-agent', name: 'Traced Agent', endpoint: 'http://localhost:3000', connectorType: 'agui-streaming', useTraces: true, tracePolling: { maxAttempts: 1, intervalMs: 0 } },
      { key: 'plain-agent', name: 'Plain Agent', endpoint: 'http://localhost:3000', connectorType: 'agui-streaming', useTraces: false },
    ],
    models: { 'claude-sonnet': { model_id: 'anthropic.claude-sonnet-4' } },
  })),
}));
jest.mock('@/lib/constants', () => ({
  DEFAULT_CONFIG: { agents: [], models: { 'claude-sonnet': { model_id: 'anthropic.claude-sonnet-4' } } },
}));
jest.mock('@/server/services/customAgentStore', () => ({ getCustomAgents: jest.fn(() => []) }));
jest.mock('@/lib/debug', () => ({ debug: jest.fn() }));
jest.mock('@/services/traces/tracePoller', () => ({ tracePollingManager: { startPolling: jest.fn() } }));
jest.mock('@/services/traces/index', () => ({ fetchTracesForRun: jest.fn() }));

import { invokeAgent } from '@/services/evaluation';
import { fetchTracesForRun } from '@/services/traces/index';

const mockInvokeAgent = invokeAgent as jest.Mock;
const mockFetchTraces = fetchTracesForRun as jest.MockedFunction<typeof fetchTracesForRun>;

function stubInvocation() {
  return {
    trajectory: [{ type: 'response', content: 'agent output' }],
    rawEvents: [],
    runId: 'agent-run-id-123',
    agentDurationMs: 1000,
    connector: { type: 'agui-streaming' } as any,
  };
}

const TC: TestCase = { id: 'tc-1', name: 'TC', initialPrompt: 'Test prompt', context: [] } as unknown as TestCase;
function makeRun(agentKey: string): EvaluationRun {
  return { id: `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, name: 'Run', agentKey, modelId: 'claude-sonnet', status: 'running', results: {}, createdAt: new Date().toISOString() } as unknown as EvaluationRun;
}

describe('code-eval trace attach + agent-failure surfacing — FileStorageModule persistence (#334, #335)', () => {
  let tmpDir: string;
  let storage: FileStorageModule;

  beforeEach(() => {
    jest.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-eval-trace-attach-'));
    storage = new FileStorageModule(tmpDir);
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('#334: persists report.traceId + spans from the fetched traces (survives storage round-trip)', async () => {
    mockInvokeAgent.mockResolvedValue(stubInvocation());
    mockFetchTraces.mockResolvedValue({
      spans: [{ spanId: 'a', traceId: 'trace-xyz', name: 'invoke_agent', startTime: '2024-01-01T00:00:00Z', endTime: '2024-01-01T00:00:01Z', status: 'OK', attributes: {} }],
      total: 1,
    } as any);

    const evalFn: EvaluateFn = jest.fn(async ({ agent }: any) => {
      const result = await agent.run('Test prompt');
      expect(result.agentOutput.length).toBeGreaterThan(0);
    });

    const run = makeRun('traced-agent');
    await executeEvaluationRun(run, [TC], { storageModule: storage as any, evaluateFnMap: new Map([[TC.id, evalFn]]), onProgress: jest.fn() });

    const reportId = (run.results as any)[TC.id].reportId;
    const saved = await storage.runs.getById(reportId);
    expect(saved).toBeTruthy();
    expect((saved as any).passFailStatus).toBe('passed');
    expect((saved as any).traceId).toBe('trace-xyz');
    expect((saved as any).spans).toHaveLength(1);
  });

  it('#335: an agent subprocess timeout persists as `errored` with passFailStatus CLEARED on disk', async () => {
    mockInvokeAgent.mockRejectedValue(new Error('Subprocess timed out after 600000ms'));

    const evalFn: EvaluateFn = jest.fn(async ({ agent }: any) => { await agent.run('Test prompt'); });

    const run = makeRun('plain-agent');
    await executeEvaluationRun(run, [TC], { storageModule: storage as any, evaluateFnMap: new Map([[TC.id, evalFn]]), onProgress: jest.fn() });

    const reportId = (run.results as any)[TC.id].reportId;
    const saved = await storage.runs.getById(reportId);
    expect(saved).toBeTruthy();
    expect((saved as any).metricsStatus).toBe('error');
    // The key persistence guarantee: passFailStatus is CLEARED (null/absent) on
    // disk, not a stale 'failed' — an errored run must be excluded from pass-rate.
    expect((saved as any).passFailStatus == null).toBe(true);
    expect((saved as any).llmJudgeReasoning).toMatch(/Agent run did not complete/);
    expect((saved as any).llmJudgeReasoning).toMatch(/Subprocess timed out after 600000ms/);
  });
});
