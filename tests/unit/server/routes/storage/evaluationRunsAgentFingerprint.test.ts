/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the agent-configuration provenance stamp on run creation
 * (server/routes/storage/evaluationRuns.ts create + rerun,
 * server/services/agentProvenance.ts, and GET /api/agents/:key/fingerprint).
 *
 * Mounts the real routers with storage / runner collaborators mocked and the
 * REAL fingerprint code (lib/agentFingerprint.ts) so the assertions pin the
 * end-to-end shape a run document carries — not a mocked value echoed back.
 */

const mockEvaluationRunsGetById = jest.fn();
const mockEvaluationRunsCreate = jest.fn();
const mockEvaluationRunsUpdate = jest.fn();
const mockEvaluationRunsUpdateResult = jest.fn();
const mockBenchmarksGetById = jest.fn();
const mockBenchmarksAddRun = jest.fn();

jest.mock('@/server/adapters/index', () => ({
  getStorageModule: jest.fn().mockReturnValue({
    evaluationRuns: {
      getById: (...args: any[]) => mockEvaluationRunsGetById(...args),
      create: (...args: any[]) => mockEvaluationRunsCreate(...args),
      update: (...args: any[]) => mockEvaluationRunsUpdate(...args),
      updateResult: (...args: any[]) => mockEvaluationRunsUpdateResult(...args),
      // Forward-compat with the terminal-aware finalize path (#486): the
      // route may reconcile results before linking the benchmark projection.
      mergeMissingResults: jest.fn().mockResolvedValue(true),
      list: jest.fn(),
      delete: jest.fn(),
    },
    benchmarks: {
      getById: (...args: any[]) => mockBenchmarksGetById(...args),
      update: jest.fn(),
      addRun: (...args: any[]) => mockBenchmarksAddRun(...args),
    },
    images: { create: jest.fn().mockResolvedValue({}), update: jest.fn().mockResolvedValue({}) },
  }),
}));

const mockResolveTestCaseSources = jest.fn();
jest.mock('@/services/sourceResolver', () => ({
  resolveTestCaseSources: (...args: any[]) => mockResolveTestCaseSources(...args),
}));

const mockExecuteEvaluationRun = jest.fn();
jest.mock('@/services/evaluationRunner', () => ({
  executeEvaluationRun: (...args: any[]) => mockExecuteEvaluationRun(...args),
  createCancellationToken: jest.fn(() => ({ isCancelled: false, cancel: jest.fn() })),
}));

jest.mock('@/services/benchmarkPromotion', () => ({
  promoteRunToBenchmark: jest.fn(),
  linkTestCaseIdsToBenchmark: jest.fn().mockResolvedValue(undefined),
}));

// Two agents: a subprocess agent with a system prompt (prompt hash derivable)
// and a plain streaming agent without one. Mutable so a test can "edit the
// config file" between two run creations.
let agents: any[] = [];
const mockLoadConfigSync = jest.fn(() => ({ agents, models: {} }));
const mockGetConfigFileInfo = jest.fn(() => null);
jest.mock('@/lib/config/index', () => ({
  loadConfigSync: (...args: any[]) => mockLoadConfigSync(...args),
  getConfigFileInfo: (...args: any[]) => mockGetConfigFileInfo(...args),
}));

jest.mock('@/server/services/customAgentStore', () => ({
  getCustomAgents: jest.fn().mockReturnValue([{ key: 'custom-1', name: 'Custom', endpoint: 'http://c:1', isCustom: true, connectorType: 'agui-streaming' }]),
  addCustomAgent: jest.fn(),
  removeCustomAgent: jest.fn(),
}));

jest.mock('@/server/services/codingAgents/remoteConfig', () => ({ getRemoteServers: jest.fn().mockReturnValue([]) }));
jest.mock('@/server/services/observioAgent', () => ({
  waitForObservioReady: jest.fn().mockResolvedValue(undefined),
  getObservioPort: jest.fn().mockReturnValue(3001),
}));
jest.mock('@/lib/config/statePaths', () => ({
  readLayeredState: jest.fn().mockReturnValue({}),
  writeStateScope: jest.fn(),
  isCodeFirstMode: jest.fn().mockReturnValue(false),
}));

import express, { Application } from 'express';
const request = require('supertest');
import evaluationRunsRouter from '@/server/routes/storage/evaluationRuns';
import configRouter from '@/server/routes/config';
import { computeAgentFingerprint } from '@/lib/agentFingerprint';
import { resolveAgentProvenance, reportProvenanceFrom, clearConfigSourceCache } from '@/server/services/agentProvenance';

const SHA256_HEX = /^[a-f0-9]{64}$/;

function promptAgent(systemPrompt = 'Be careful.') {
  return {
    key: 'coding-agent',
    name: 'Coding agent',
    endpoint: 'claude',
    connectorType: 'claude-code',
    headers: { Authorization: 'Bearer s3cret' },
    connectorConfig: { systemPrompt, allowedTools: ['Read'], env: { ANTHROPIC_API_KEY: 'k' } },
  };
}
const plainAgent = { key: 'plain', name: 'Plain', endpoint: 'http://a:1', connectorType: 'agui-streaming', headers: {} };

function makeApp(): Application {
  const app = express();
  app.use(express.json());
  app.use(evaluationRunsRouter);
  app.use(configRouter);
  return app;
}

describe('agent provenance stamp', () => {
  let app: Application;

  beforeEach(() => {
    jest.clearAllMocks();
    clearConfigSourceCache();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    agents = [promptAgent(), plainAgent];
    app = makeApp();
    mockResolveTestCaseSources.mockResolvedValue({
      testCases: [{ id: 'tc-1', name: 'TC 1', version: 1 }],
      sources: [{ type: 'test-case-ids', ids: ['tc-1'] }],
      evaluateFnMap: new Map(), hooksByFile: new Map(), testHookScopes: new Map(),
    });
    mockExecuteEvaluationRun.mockResolvedValue({ results: {}, stats: { total: 1 } });
    mockEvaluationRunsCreate.mockResolvedValue(undefined);
    mockEvaluationRunsUpdate.mockResolvedValue({ id: 'x', status: 'completed' });
    // getById is consulted by the finalize path (#486) after the run
    // completes; default to echoing the created doc so linking proceeds.
    mockEvaluationRunsGetById.mockImplementation(async (id: string) => {
      const created = mockEvaluationRunsCreate.mock.calls.map(c => c[0]).find(r => r.id === id);
      return created ? { ...created, results: {} } : null;
    });
  });

  afterEach(() => jest.restoreAllMocks());

  describe('resolveAgentProvenance()', () => {
    it('returns fingerprint + short + promptHash for a configured agent', () => {
      const p = resolveAgentProvenance('coding-agent')!;
      expect(p.agentFingerprint).toMatch(SHA256_HEX);
      expect(p.agentFingerprintShort).toBe(p.agentFingerprint!.slice(0, 12));
      expect(p.agentPromptHash).toMatch(SHA256_HEX);
      expect(p).toEqual(expect.objectContaining(computeAgentFingerprint(promptAgent())));
    });
    it('omits promptHash for an agent without a system prompt', () => {
      const p = resolveAgentProvenance('plain')!;
      expect(p.agentFingerprint).toMatch(SHA256_HEX);
      expect(p.agentPromptHash).toBeUndefined();
    });
    it('resolves UI-added custom agents too (no config source for them)', () => {
      const p = resolveAgentProvenance('custom-1')!;
      expect(p.agentFingerprint).toMatch(SHA256_HEX);
      expect(p.agentConfigSource).toBeUndefined();
    });
    it('returns undefined for an unknown agent and never throws', () => {
      expect(resolveAgentProvenance('nope')).toBeUndefined();
      mockLoadConfigSync.mockImplementationOnce(() => { throw new Error('boom'); });
      expect(resolveAgentProvenance('plain')).toBeUndefined();
    });
    it('honours a run-level endpoint override', () => {
      const a = resolveAgentProvenance('plain')!;
      const b = resolveAgentProvenance('plain', { agentEndpoint: 'http://b:2' })!;
      expect(b.agentFingerprint).not.toBe(a.agentFingerprint);
    });
    it('attaches agentConfigSource when a config file is present (cached per path)', () => {
      mockGetConfigFileInfo.mockReturnValue({ path: __filename, format: 'typescript', exists: true } as any);
      const p = resolveAgentProvenance('plain')!;
      expect(p.agentConfigSource?.path).toBe(require('fs').realpathSync(__filename));
      resolveAgentProvenance('plain');
      // Second call within the TTL reuses the cached source: one lookup only.
      expect(mockGetConfigFileInfo).toHaveBeenCalledTimes(2);
    });
    it('reportProvenanceFrom() mirrors only the three hash fields (never the config source)', () => {
      expect(reportProvenanceFrom(undefined)).toEqual({});
      expect(reportProvenanceFrom({ agentFingerprint: 'f', agentFingerprintShort: 's', agentPromptHash: 'p', agentConfigSource: { path: '/x' } }))
        .toEqual({ agentFingerprint: 'f', agentFingerprintShort: 's', agentPromptHash: 'p' });
      expect(reportProvenanceFrom({ agentFingerprint: 'f', agentFingerprintShort: 's' }))
        .toEqual({ agentFingerprint: 'f', agentFingerprintShort: 's' });
    });
  });

  describe('POST /api/storage/evaluation-runs', () => {
    const body = { sources: [{ type: 'test-case-ids', ids: ['tc-1'] }], agentKey: 'coding-agent' };

    it('stamps agentFingerprint / agentFingerprintShort / agentPromptHash on the created run doc', async () => {
      const res = await request(app).post('/api/storage/evaluation-runs').send(body);
      expect(res.status).toBe(200);
      const run = mockEvaluationRunsCreate.mock.calls[0][0];
      const expected = computeAgentFingerprint(promptAgent());
      expect(run.agentFingerprint).toBe(expected.agentFingerprint);
      expect(run.agentFingerprintShort).toBe(expected.agentFingerprintShort);
      expect(run.agentPromptHash).toBe(expected.agentPromptHash);
      // The runner receives the same stamped doc (it mirrors onto reports).
      expect(mockExecuteEvaluationRun.mock.calls[0][0].agentFingerprint).toBe(expected.agentFingerprint);
    });

    it('two runs across a config edit (prompt change) carry DIFFERENT fingerprints and prompt hashes', async () => {
      await request(app).post('/api/storage/evaluation-runs').send(body);
      agents = [promptAgent('Be reckless.'), plainAgent]; // "edit the config file"
      await request(app).post('/api/storage/evaluation-runs').send(body);
      const [first, second] = mockEvaluationRunsCreate.mock.calls.map(c => c[0]);
      expect(first.agentFingerprint).not.toBe(second.agentFingerprint);
      expect(first.agentPromptHash).not.toBe(second.agentPromptHash);
    });

    it('a header/secret-only edit leaves the fingerprint UNCHANGED', async () => {
      await request(app).post('/api/storage/evaluation-runs').send(body);
      agents = [{ ...promptAgent(), headers: { Authorization: 'Bearer rotated' }, connectorConfig: { ...promptAgent().connectorConfig, env: { ANTHROPIC_API_KEY: 'k2' } } }, plainAgent];
      await request(app).post('/api/storage/evaluation-runs').send(body);
      const [first, second] = mockEvaluationRunsCreate.mock.calls.map(c => c[0]);
      expect(first.agentFingerprint).toBe(second.agentFingerprint);
    });

    it('copies the provenance onto the benchmark.runs[] projection when benchmarkId is set', async () => {
      mockBenchmarksGetById.mockResolvedValue({ id: 'bench-1', testCaseIds: ['tc-1'] });
      mockBenchmarksAddRun.mockResolvedValue(true);
      await request(app).post('/api/storage/evaluation-runs').send({ ...body, benchmarkId: 'bench-1' });
      const projected = mockBenchmarksAddRun.mock.calls[0][1];
      const expected = computeAgentFingerprint(promptAgent());
      expect(projected.agentFingerprint).toBe(expected.agentFingerprint);
      expect(projected.agentFingerprintShort).toBe(expected.agentFingerprintShort);
      expect(projected.agentPromptHash).toBe(expected.agentPromptHash);
    });

    it('still creates the run (no provenance) when the agent cannot be resolved by the fingerprinter', async () => {
      const res = await request(app).post('/api/storage/evaluation-runs').send({ ...body, agentKey: 'ghost' });
      expect(res.status).toBe(200);
      const run = mockEvaluationRunsCreate.mock.calls[0][0];
      expect(run.agentKey).toBe('ghost');
      expect(run.agentFingerprint).toBeUndefined();
    });
  });

  describe('POST /api/storage/evaluation-runs/:id/rerun', () => {
    it('the re-run gets the CURRENT fingerprint (differs from the source run after a config edit)', async () => {
      const source = {
        id: 'eval-run-src', docType: 'evaluation-run', name: 'Src', agentKey: 'coding-agent', modelId: '',
        sources: [{ type: 'test-case-ids', ids: ['tc-1'] }], trigger: 'ui', status: 'completed',
        testCaseSnapshots: [], results: {}, createdAt: '2024-01-01T00:00:00Z',
        ...computeAgentFingerprint(promptAgent('OLD prompt')),
      };
      mockEvaluationRunsGetById.mockResolvedValue(source);
      const res = await request(app).post('/api/storage/evaluation-runs/eval-run-src/rerun').send({});
      expect(res.status).toBe(201);
      expect(res.body.run.rerunOf).toBe('eval-run-src');
      const expected = computeAgentFingerprint(promptAgent());
      expect(res.body.run.agentFingerprint).toBe(expected.agentFingerprint);
      expect(res.body.run.agentFingerprint).not.toBe(source.agentFingerprint);
      expect(res.body.run.agentPromptHash).not.toBe(source.agentPromptHash);
    });
  });

  describe('GET /api/agents/:key/fingerprint', () => {
    it('returns the current fingerprint for a configured agent', async () => {
      const res = await request(app).get('/api/agents/coding-agent/fingerprint');
      expect(res.status).toBe(200);
      const expected = computeAgentFingerprint(promptAgent());
      expect(res.body).toEqual(expect.objectContaining({
        agentKey: 'coding-agent',
        agentFingerprint: expected.agentFingerprint,
        agentFingerprintShort: expected.agentFingerprintShort,
        agentPromptHash: expected.agentPromptHash,
      }));
      expect(res.body.computedAt).toEqual(expect.any(String));
      // Never leaks config contents — only hashes.
      expect(JSON.stringify(res.body)).not.toContain('s3cret');
      expect(JSON.stringify(res.body)).not.toContain('Be careful');
    });
    it('matches what a run created right now is stamped with', async () => {
      const fp = await request(app).get('/api/agents/coding-agent/fingerprint');
      await request(app).post('/api/storage/evaluation-runs').send({ sources: [{ type: 'test-case-ids', ids: ['tc-1'] }], agentKey: 'coding-agent' });
      expect(mockEvaluationRunsCreate.mock.calls[0][0].agentFingerprint).toBe(fp.body.agentFingerprint);
    });
    it('honours ?agentEndpoint= like a run-level override', async () => {
      const a = await request(app).get('/api/agents/plain/fingerprint');
      const b = await request(app).get('/api/agents/plain/fingerprint?agentEndpoint=http%3A%2F%2Fb%3A2');
      expect(b.body.agentFingerprint).not.toBe(a.body.agentFingerprint);
    });
    it('404s for an unknown agent', async () => {
      const res = await request(app).get('/api/agents/ghost/fingerprint');
      expect(res.status).toBe(404);
    });
  });
});
