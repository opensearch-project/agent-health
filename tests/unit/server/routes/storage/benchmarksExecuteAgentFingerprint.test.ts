/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Legacy `POST /api/storage/benchmarks/:id/execute` path — the run pushed
 * into `benchmark.runs[]` must carry the agent-configuration provenance
 * (agentFingerprint / agentFingerprintShort / agentPromptHash), the same
 * stamp the unified evaluation-runs path applies. Uses the REAL fingerprint
 * code against a mocked config so the persisted value is pinned to what
 * `computeAgentFingerprint` produces for that agent.
 */

import type { Request, Response } from 'express';

const mockGet = jest.fn();
const mockUpdate = jest.fn();
const mockSearch = jest.fn();
const mockClient = { get: mockGet, update: mockUpdate, search: mockSearch, index: jest.fn(), delete: jest.fn(), bulk: jest.fn() };

const mockTestCasesGetAll = jest.fn();
const mockStorage = {
  benchmarks: { getById: jest.fn(), getAll: jest.fn(), update: jest.fn(), create: jest.fn(), delete: jest.fn() },
  testCases: { getAll: (...a: any[]) => mockTestCasesGetAll(...a), getById: jest.fn() },
  runs: { getById: jest.fn() },
  images: { create: jest.fn().mockResolvedValue({}), update: jest.fn().mockResolvedValue({}) },
  isConfigured: jest.fn().mockReturnValue(true),
};

jest.mock('@/server/adapters/index', () => ({ getStorageModule: jest.fn(() => mockStorage) }));
jest.mock('@/server/middleware/storageClient', () => ({
  isStorageAvailable: jest.fn(() => true),
  requireStorageClient: jest.fn(() => mockClient),
  INDEXES: { benchmarks: 'experiments-index', testCases: 'test-cases-index', runs: 'runs-index' },
}));

const agent = {
  key: 'agent',
  name: 'Agent',
  endpoint: 'claude',
  connectorType: 'claude-code',
  headers: { Authorization: 'Bearer s3cret' },
  connectorConfig: { systemPrompt: 'Be careful.', allowedTools: ['Read'] },
};
jest.mock('@/lib/config/index', () => ({
  loadConfigSync: jest.fn(() => ({ agents: [agent], models: {} })),
  getConfigFileInfo: jest.fn(() => null),
}));
jest.mock('@/server/services/customAgentStore', () => ({ getCustomAgents: jest.fn(() => []) }));
jest.mock('@/cli/demo/sampleBenchmarks', () => ({
  SAMPLE_BENCHMARKS: [],
  isSampleBenchmarkId: (id: string) => id.startsWith('demo-'),
  isSampleExperimentId: (id: string) => id.startsWith('demo-'),
}));
jest.mock('@/cli/demo/sampleTestCases', () => ({ SAMPLE_TEST_CASES: [] }));

const mockExecuteRun = jest.fn();
jest.mock('@/services/benchmarkRunner', () => ({
  executeRun: (...args: any[]) => mockExecuteRun(...args),
  createCancellationToken: () => ({ isCancelled: false, cancel: jest.fn() }),
}));

import benchmarksRoutes from '@/server/routes/storage/benchmarks';
import { computeAgentFingerprint } from '@/lib/agentFingerprint';

function getRouteHandler(router: any, method: string, path: string) {
  const route = router.stack.find((l: any) => l.route && l.route.path === path && l.route.methods[method]);
  return route?.route.stack[0].handle;
}

function createMocks(params: any, body: any) {
  const req = { params, body, query: {}, on: jest.fn(), storageClient: mockClient } as unknown as Request;
  const res = {
    json: jest.fn().mockReturnThis(), status: jest.fn().mockReturnThis(), setHeader: jest.fn(),
    flushHeaders: jest.fn(), write: jest.fn(), end: jest.fn(), headersSent: false,
  } as unknown as Response;
  return { req, res };
}

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => jest.restoreAllMocks());

describe('POST /api/storage/benchmarks/:id/execute — agent provenance stamp', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGet.mockResolvedValue({ body: { found: true, _source: { id: 'exp-1', name: 'B', testCaseIds: ['tc-1'], runs: [] } } });
    mockUpdate.mockResolvedValue({ body: {} });
    mockTestCasesGetAll.mockResolvedValue({ items: [{ id: 'tc-1', name: 'TC', initialPrompt: 'p' }], total: 1 });
    mockSearch.mockResolvedValue({ body: { hits: { hits: [] } } });
    mockExecuteRun.mockImplementation(async (_b: any, run: any) => ({ ...run, status: 'completed', results: {} }));
  });

  it('stamps the fingerprint on the run pushed into benchmark.runs[] AND on the run handed to executeRun', async () => {
    const { req, res } = createMocks({ id: 'exp-1' }, { name: 'Run', agentKey: 'agent' });
    const handler = getRouteHandler(benchmarksRoutes, 'post', '/api/storage/benchmarks/:id/execute');
    await handler(req, res);

    const expected = computeAgentFingerprint(agent as any);
    // First client.update persists the initial `runs` array with the new run.
    const persisted = mockUpdate.mock.calls[0][0].body.doc.runs[0];
    expect(persisted.agentFingerprint).toBe(expected.agentFingerprint);
    expect(persisted.agentFingerprintShort).toBe(expected.agentFingerprintShort);
    expect(persisted.agentPromptHash).toBe(expected.agentPromptHash);
    // The runner receives the same run object so reports inherit it.
    expect(mockExecuteRun.mock.calls[0][1].agentFingerprint).toBe(expected.agentFingerprint);
    // Secrets never appear in what is persisted.
    expect(JSON.stringify(persisted)).not.toContain('s3cret');
  });

  it('a run-level agentEndpoint override changes the fingerprint (it changes what the connector talks to)', async () => {
    const handler = getRouteHandler(benchmarksRoutes, 'post', '/api/storage/benchmarks/:id/execute');
    const a = createMocks({ id: 'exp-1' }, { name: 'Run', agentKey: 'agent' });
    await handler(a.req, a.res);
    const b = createMocks({ id: 'exp-1' }, { name: 'Run', agentKey: 'agent', agentEndpoint: 'http://elsewhere:1' });
    await handler(b.req, b.res);
    const [first, second] = mockUpdate.mock.calls.filter(c => c[0]?.body?.doc?.runs).map(c => c[0].body.doc.runs[0]);
    expect(first.agentFingerprint).not.toBe(second.agentFingerprint);
    expect(second.agentFingerprint).toBe(computeAgentFingerprint(agent as any, { agentEndpoint: 'http://elsewhere:1' }).agentFingerprint);
  });
});
