/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the /api/evaluate route's model handling + rejection
 * contract (regression for "Run Test silently does nothing"):
 *
 *   - `modelId` is optional. For an agent that owns its model (declared
 *     `connectorConfig.model`, or a model-owning connector) the caller's
 *     `modelId` is ignored and the placeholder run records the agent's
 *     declared model with `modelSource: 'agent'`.
 *   - For a catalog-model agent an unknown `modelId` is still rejected — but
 *     the 400 now carries a machine-readable `code` and is logged at info
 *     level with agentKey/testCaseId, BEFORE anything is stored.
 *   - Every other pre-stream 4xx (invalid body, unknown agent, unknown test
 *     case) carries a `code` and is logged the same way.
 */

import { EventEmitter } from 'events';
import type { Request, Response } from 'express';

import evaluationRoutes from '@/server/routes/evaluation';
import { getStorageModule } from '@/server/adapters';
import { runSingleUseCase } from '@/services/benchmarkRunner';
import { loadConfigSync } from '@/lib/config/index';
import { getCustomAgents } from '@/server/services/customAgentStore';

jest.mock('@/server/adapters', () => ({ getStorageModule: jest.fn() }));
jest.mock('@/services/benchmarkRunner', () => ({ runSingleUseCase: jest.fn() }));
jest.mock('@/lib/config/index', () => ({ loadConfigSync: jest.fn() }));
jest.mock('@/server/services/customAgentStore', () => ({ getCustomAgents: jest.fn(() => []) }));

const mockGetStorageModule = getStorageModule as jest.MockedFunction<typeof getStorageModule>;
const mockRunSingleUseCase = runSingleUseCase as jest.MockedFunction<typeof runSingleUseCase>;
const mockLoadConfigSync = loadConfigSync as jest.MockedFunction<typeof loadConfigSync>;
const mockGetCustomAgents = getCustomAgents as jest.MockedFunction<typeof getCustomAgents>;

function createMockRes() {
  const writes: string[] = [];
  const res = {
    headers: {} as Record<string, string>,
    headersSent: false,
    writableEnded: false,
    statusCode: 200,
    setHeader(this: any, k: string, v: string) { this.headers[k] = v; return this; },
    flushHeaders(this: any) { this.headersSent = true; },
    write(this: any, chunk: string) { writes.push(chunk); return true; },
    end(this: any) { this.writableEnded = true; return this; },
    status(this: any, n: number) { this.statusCode = n; return this; },
    json: jest.fn().mockReturnThis(),
  } as any;
  res.writes = writes;
  return res as Response & { writes: string[]; statusCode: number; json: jest.Mock };
}

function createMockReq(body: any) {
  const req = new EventEmitter() as any;
  req.body = body;
  return req as Request;
}

function getEvaluateHandler(): (req: Request, res: Response) => Promise<void> {
  const layer = (evaluationRoutes as any).stack.find(
    (l: any) => l.route?.path === '/api/evaluate' && l.route?.methods?.post,
  );
  return layer.route.stack[0].handle;
}

const CATALOG_AGENT = { key: 'streaming-agent', name: 'Streaming Agent', endpoint: 'http://localhost:9001/run', connectorType: 'agui-streaming', headers: {} };
const REST_AGENT = {
  key: 'retrieval-agent',
  name: 'Retrieval Agent',
  endpoint: 'http://localhost:9002/ask',
  connectorType: 'rest',
  connectorConfig: { model: 'provider.deployment-v2' },
  headers: {},
};
const CLI_AGENT = { key: 'cli-agent', name: 'CLI Agent', endpoint: 'some-cli', connectorType: 'claude-code', headers: {} };

const CATALOG = {
  'claude-sonnet-4.5': { model_id: 'us.anthropic.claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5', provider: 'bedrock', context_window: 1, max_output_tokens: 1 },
};

const INLINE_TC = {
  id: 'inline-tc-1', name: 'Inline test', description: '', labels: [], category: 'Custom', difficulty: 'Easy',
  currentVersion: 1, versions: [], isPromoted: false, createdAt: '2024-01-01', updatedAt: '2024-01-01',
  initialPrompt: 'do the thing', context: [],
};

function storageWithCapture() {
  let captured: any = null;
  const storage = {
    runs: {
      create: jest.fn().mockImplementation(async (doc) => { captured = doc; return { ...doc, id: 'ph-1' }; }),
      update: jest.fn(),
      getById: jest.fn().mockResolvedValue({ id: 'ph-1', status: 'completed', metrics: {}, trajectory: [] }),
    },
    testCases: { getById: jest.fn().mockResolvedValue(null), search: jest.fn().mockResolvedValue({ items: [] }) },
  };
  mockGetStorageModule.mockReturnValue(storage as any);
  mockRunSingleUseCase.mockResolvedValue('ph-1');
  return { storage, captured: () => captured };
}

describe('POST /api/evaluate — model resolution', () => {
  let infoSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    mockLoadConfigSync.mockReturnValue({ agents: [CATALOG_AGENT, REST_AGENT, CLI_AGENT], models: CATALOG } as any);
    mockGetCustomAgents.mockReturnValue([]);
  });

  afterEach(() => jest.restoreAllMocks());

  it('REST agent with a declared model, no modelId → runs; records the declared model with modelSource agent', async () => {
    const { storage, captured } = storageWithCapture();
    const res = createMockRes();
    await getEvaluateHandler()(createMockReq({ testCase: INLINE_TC, agentKey: 'retrieval-agent' }), res);

    expect(res.json).not.toHaveBeenCalled();
    expect(captured()).toMatchObject({ modelId: 'provider.deployment-v2', modelName: 'provider.deployment-v2', modelSource: 'agent' });
    // The runner is handed the agent's model, so a REST payload's `model` is what the agent actually runs on.
    expect(mockRunSingleUseCase.mock.calls[0][0]).toMatchObject({ agentKey: 'retrieval-agent', modelId: 'provider.deployment-v2' });
    expect(storage.runs.create).toHaveBeenCalledTimes(1);
  });

  it('REST agent with a declared model IGNORES an unrelated catalog modelId instead of recording it', async () => {
    const { captured } = storageWithCapture();
    const res = createMockRes();
    await getEvaluateHandler()(createMockReq({ testCase: INLINE_TC, agentKey: 'retrieval-agent', modelId: 'claude-sonnet-4.5' }), res);

    expect(res.json).not.toHaveBeenCalled();
    expect(captured()).toMatchObject({ modelId: 'provider.deployment-v2', modelSource: 'agent' });
    expect(mockRunSingleUseCase.mock.calls[0][0].modelId).toBe('provider.deployment-v2');
  });

  it('REST agent with a declared model that is NOT a catalog key is accepted even when sent as modelId', async () => {
    const { captured } = storageWithCapture();
    const res = createMockRes();
    // This is what the CLI `run` command sends (resolveAgentModel(agent)) — it used to be a 400.
    await getEvaluateHandler()(createMockReq({ testCase: INLINE_TC, agentKey: 'retrieval-agent', modelId: 'provider.deployment-v2' }), res);
    expect(res.json).not.toHaveBeenCalled();
    expect(captured()).toMatchObject({ modelId: 'provider.deployment-v2', modelSource: 'agent' });
  });

  it('CLI agent (model-owning connector, nothing declared) → runs with no model recorded, modelSource agent', async () => {
    const { captured } = storageWithCapture();
    const res = createMockRes();
    await getEvaluateHandler()(createMockReq({ testCase: INLINE_TC, agentKey: 'cli-agent', modelId: 'claude-sonnet-4.5' }), res);
    expect(res.json).not.toHaveBeenCalled();
    expect(captured()).toMatchObject({ modelId: '', modelSource: 'agent' });
  });

  it('catalog agent + catalog modelId → recorded with modelSource request (unchanged behaviour)', async () => {
    const { captured } = storageWithCapture();
    const res = createMockRes();
    await getEvaluateHandler()(createMockReq({ testCase: INLINE_TC, agentKey: 'streaming-agent', modelId: 'claude-sonnet-4.5' }), res);
    expect(res.json).not.toHaveBeenCalled();
    expect(captured()).toMatchObject({ modelId: 'claude-sonnet-4.5', modelName: 'Claude Sonnet 4.5', modelSource: 'request' });
  });

  it('catalog agent + no modelId → catalog default with modelSource default', async () => {
    const { captured } = storageWithCapture();
    const res = createMockRes();
    await getEvaluateHandler()(createMockReq({ testCase: INLINE_TC, agentKey: 'streaming-agent' }), res);
    expect(res.json).not.toHaveBeenCalled();
    expect(captured()).toMatchObject({ modelId: 'claude-sonnet-4.5', modelSource: 'default' });
  });

  describe('rejections carry a code, are logged at info level, and store nothing', () => {
    const cases: Array<[string, any, number, string, RegExp]> = [
      ['catalog agent + non-catalog modelId', { testCase: INLINE_TC, agentKey: 'streaming-agent', modelId: 'provider.deployment-v2' }, 400, 'MODEL_NOT_FOUND', /Model not found: provider\.deployment-v2/],
      ['unknown agent', { testCase: INLINE_TC, agentKey: 'nope' }, 400, 'AGENT_NOT_FOUND', /Agent not found: nope/],
      ['non-string modelId', { testCase: INLINE_TC, agentKey: 'streaming-agent', modelId: 42 }, 400, 'INVALID_REQUEST', /modelId must be a string/],
      ['missing agentKey', { testCase: INLINE_TC }, 400, 'INVALID_REQUEST', /agentKey/],
      ['unknown test case id', { testCaseId: 'tc-missing', agentKey: 'streaming-agent', modelId: 'claude-sonnet-4.5' }, 404, 'TEST_CASE_NOT_FOUND', /Test case not found: tc-missing/],
    ];

    it.each(cases)('%s', async (_label, body, status, code, messageRe) => {
      const { storage } = storageWithCapture();
      const res = createMockRes();
      await getEvaluateHandler()(createMockReq(body), res);

      expect(res.statusCode).toBe(status);
      expect(res.json).toHaveBeenCalledWith({ error: expect.stringMatching(messageRe), code });
      expect(res.headersSent).toBe(false);
      expect(storage.runs.create).not.toHaveBeenCalled();
      expect(mockRunSingleUseCase).not.toHaveBeenCalled();
      // Observable server-side: agentKey + testCaseId + code + reason.
      const logLine = infoSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes('[EvaluationAPI] Rejected'));
      expect(logLine).toBeDefined();
      expect(logLine).toContain(code);
      expect(logLine).toContain(`agentKey=${body.agentKey ?? '-'}`);
      expect(logLine).toContain(`testCaseId=${body.testCaseId ?? (body.testCase ? 'inline' : '-')}`);
    });
  });
});
