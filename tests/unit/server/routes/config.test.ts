/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

const mockLoadConfigSync = jest.fn();
const mockAddCustomAgent = jest.fn();
const mockRemoveCustomAgent = jest.fn();
const mockGetCustomAgents = jest.fn();
const mockGetRemoteServers = jest.fn();
const mockWaitForObservioReady = jest.fn();
const mockGetObservioPort = jest.fn();
const mockReadLayeredState = jest.fn();
const mockWriteStateScope = jest.fn();
const mockIsCodeFirstMode = jest.fn();
const mockFetch = jest.fn();

jest.mock('@/lib/config/index', () => ({
  loadConfigSync: (...args: any[]) => mockLoadConfigSync(...args),
}));

jest.mock('@/server/services/customAgentStore', () => ({
  addCustomAgent: (...args: any[]) => mockAddCustomAgent(...args),
  removeCustomAgent: (...args: any[]) => mockRemoveCustomAgent(...args),
  getCustomAgents: (...args: any[]) => mockGetCustomAgents(...args),
}));

jest.mock('@/server/services/codingAgents/remoteConfig', () => ({
  getRemoteServers: (...args: any[]) => mockGetRemoteServers(...args),
}));

jest.mock('@/server/services/observioAgent', () => ({
  waitForObservioReady: (...args: any[]) => mockWaitForObservioReady(...args),
  getObservioPort: (...args: any[]) => mockGetObservioPort(...args),
}));

jest.mock('@/lib/config/statePaths', () => ({
  readLayeredState: (...args: any[]) => mockReadLayeredState(...args),
  writeStateScope: (...args: any[]) => mockWriteStateScope(...args),
  isCodeFirstMode: (...args: any[]) => mockIsCodeFirstMode(...args),
}));

import express, { Application } from 'express';
const request = require('supertest');
import configRouter from '@/server/routes/config';

function makeApp(): Application {
  const app = express();
  app.use(express.json());
  app.use(configRouter);
  return app;
}

describe('Config router', () => {
  let app: Application;
  const originalFetch = global.fetch;

  beforeAll(() => {
    (global as any).fetch = (...args: any[]) => mockFetch(...args);
  });

  afterAll(() => {
    (global as any).fetch = originalFetch;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mockLoadConfigSync.mockReturnValue({
      agents: [
        { key: 'observio', name: 'Observio', endpoint: 'http://localhost:4001/agent', hooks: { beforeRequest: jest.fn() } },
        { key: 'demo', name: 'Demo', endpoint: 'mock://demo' },
        { key: 'local-invalid', name: 'Broken URL', endpoint: 'not-a-url' },
      ],
      models: {
        'model-a': { provider: 'bedrock', model_id: 'anthropic.claude-3-5-sonnet' },
      },
    });
    mockGetCustomAgents.mockReturnValue([
      {
        key: 'custom-1',
        name: 'Custom Agent',
        endpoint: 'https://custom.example.com/agent',
        isCustom: true,
        headers: {},
        connectorType: 'rest',
      },
    ]);
    mockGetRemoteServers.mockReturnValue([
      { name: 'alpha', url: 'https://alpha.example.com', apiKey: 'secret' },
      { name: 'beta', url: 'https://beta.example.com' },
    ]);
    mockWaitForObservioReady.mockResolvedValue(undefined);
    mockGetObservioPort.mockReturnValue(4321);
    mockReadLayeredState.mockReturnValue({
      remoteServers: [
        { name: 'alpha', url: 'https://alpha.example.com', apiKey: 'secret' },
      ],
    });
    mockWriteStateScope.mockReturnValue(undefined);
    mockIsCodeFirstMode.mockReturnValue(false);
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ agents: [{ name: 'claude-code' }, { name: 'codex' }] }),
    });
    app = makeApp();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('GET /api/agents', () => {
    it('returns merged agents, strips hooks, patches local observio, and reports metadata', async () => {
      const res = await request(app).get('/api/agents');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        agents: [
          // `modelOwnership` is server-computed per agent (see
          // server/services/runModelResolution.ts): none of these fixtures
          // declare a model and their connectors take a catalog model.
          { key: 'observio', name: 'Observio', endpoint: 'http://localhost:4321/agent', builtIn: true, modelOwnership: { ownsModel: false } },
          { key: 'demo', name: 'Demo', endpoint: 'mock://demo', builtIn: true, modelOwnership: { ownsModel: false } },
          { key: 'local-invalid', name: 'Broken URL', endpoint: 'not-a-url', builtIn: false, modelOwnership: { ownsModel: false } },
          {
            key: 'custom-1',
            name: 'Custom Agent',
            endpoint: 'https://custom.example.com/agent',
            isCustom: true,
            headers: {},
            connectorType: 'rest',
            builtIn: false,
            modelOwnership: { ownsModel: false },
          },
        ],
        total: 4,
        meta: {
          source: 'config',
          hasCustomAgents: true,
          customCount: 2,
          builtInCount: 2,
        },
      });
      expect(res.body.agents[0]).not.toHaveProperty('hooks');
    });

    it('reports modelOwnership for agents that declare their model or run on a model-owning connector', async () => {
      mockLoadConfigSync.mockReturnValue({
        agents: [
          // REST agent whose model is a provider-native id declared in its own config
          { key: 'retrieval-agent', name: 'Retrieval agent', endpoint: 'http://localhost:9000/ask', connectorType: 'rest', connectorConfig: { model: 'provider.some-deployment-v2' } },
          // CLI agent: the connector never forwards a run-level model
          { key: 'cli-agent', name: 'CLI agent', endpoint: 'some-cli', connectorType: 'claude-code' },
          // Catalog agent
          { key: 'streaming', name: 'Streaming', endpoint: 'http://localhost:9001/run', connectorType: 'agui-streaming' },
        ],
        models: {},
      });
      mockGetCustomAgents.mockReturnValue([]);

      const res = await request(app).get('/api/agents');
      expect(res.status).toBe(200);
      const byKey = Object.fromEntries(res.body.agents.map((a: any) => [a.key, a.modelOwnership]));
      expect(byKey).toEqual({
        'retrieval-agent': { ownsModel: true, declaredModelId: 'provider.some-deployment-v2' },
        'cli-agent': { ownsModel: true },
        streaming: { ownsModel: false },
      });
    });

    it('supports ?filter=custom and ?filter=builtin', async () => {
      const customRes = await request(app).get('/api/agents?filter=custom');
      const builtinRes = await request(app).get('/api/agents?filter=builtin');

      expect(customRes.status).toBe(200);
      expect(customRes.body.agents.map((agent: any) => agent.key)).toEqual(['local-invalid', 'custom-1']);
      expect(builtinRes.status).toBe(200);
      expect(builtinRes.body.agents.map((agent: any) => agent.key)).toEqual(['observio', 'demo']);
    });

    it('returns 500 when config loading fails', async () => {
      mockLoadConfigSync.mockImplementationOnce(() => {
        throw new Error('config broke');
      });

      const res = await request(app).get('/api/agents');

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'config broke' });
    });
  });

  describe('POST /api/agents/custom', () => {
    it('validates required fields and endpoint format', async () => {
      const missingName = await request(app).post('/api/agents/custom').send({ endpoint: 'https://agent.example.com' });
      const missingEndpoint = await request(app).post('/api/agents/custom').send({ name: 'Agent' });
      const invalidUrl = await request(app).post('/api/agents/custom').send({ name: 'Agent', endpoint: 'not-a-url' });
      const badProtocol = await request(app).post('/api/agents/custom').send({ name: 'Agent', endpoint: 'ftp://server.example.com' });

      expect(missingName.status).toBe(400);
      expect(missingName.body).toEqual({ error: 'name is required' });
      expect(missingEndpoint.status).toBe(400);
      expect(missingEndpoint.body).toEqual({ error: 'endpoint is required' });
      expect(invalidUrl.status).toBe(400);
      expect(invalidUrl.body).toEqual({ error: 'Invalid URL format' });
      expect(badProtocol.status).toBe(400);
      expect(badProtocol.body).toEqual({ error: 'URL must use http or https protocol' });
    });

    it('rejects invalid connector types', async () => {
      const res = await request(app)
        .post('/api/agents/custom')
        .send({ name: 'Agent', endpoint: 'https://agent.example.com', connectorType: 'bogus' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/connectorType must be one of:/);
    });

    it('creates a custom agent, trimming fields and preserving flags', async () => {
      const res = await request(app)
        .post('/api/agents/custom')
        .send({
          name: '  New Agent  ',
          endpoint: '  https://agent.example.com/run  ',
          connectorType: 'langgraph',
          useTraces: true,
        });

      expect(res.status).toBe(201);
      expect(res.body.agent).toEqual({
        key: expect.stringMatching(/^custom-/),
        name: 'New Agent',
        endpoint: 'https://agent.example.com/run',
        isCustom: true,
        connectorType: 'langgraph',
        useTraces: true,
        headers: {},
      });
      expect(mockAddCustomAgent).toHaveBeenCalledWith(res.body.agent);
    });

    it('returns 500 when storing a custom agent throws', async () => {
      mockAddCustomAgent.mockImplementationOnce(() => {
        throw new Error('cannot store agent');
      });

      const res = await request(app)
        .post('/api/agents/custom')
        .send({ name: 'Agent', endpoint: 'https://agent.example.com' });

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'cannot store agent' });
    });
  });

  describe('DELETE /api/agents/custom/:id', () => {
    it('deletes an existing custom agent', async () => {
      mockRemoveCustomAgent.mockReturnValue(true);

      const res = await request(app).delete('/api/agents/custom/custom-1');

      expect(res.status).toBe(204);
      expect(res.text).toBe('');
      expect(mockRemoveCustomAgent).toHaveBeenCalledWith('custom-1');
    });

    it('returns 404 when the custom agent is missing', async () => {
      mockRemoveCustomAgent.mockReturnValue(false);

      const res = await request(app).delete('/api/agents/custom/missing');

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Custom agent not found' });
    });

    it('returns 500 when removal throws', async () => {
      mockRemoveCustomAgent.mockImplementationOnce(() => {
        throw new Error('remove failed');
      });

      const res = await request(app).delete('/api/agents/custom/custom-1');

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'remove failed' });
    });
  });

  describe('GET /api/models', () => {
    it('returns configured models', async () => {
      const res = await request(app).get('/api/models');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        models: [
          { key: 'model-a', provider: 'bedrock', model_id: 'anthropic.claude-3-5-sonnet' },
        ],
        total: 1,
        meta: { source: 'config' },
      });
    });

    it('returns 500 when model config loading fails', async () => {
      mockLoadConfigSync.mockImplementationOnce(() => {
        throw new Error('model read failed');
      });

      const res = await request(app).get('/api/models');

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'model read failed' });
    });
  });

  describe('GET /api/remote-servers', () => {
    it('lists remote servers with masked apiKey presence', async () => {
      const res = await request(app).get('/api/remote-servers');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        servers: [
          { name: 'alpha', url: 'https://alpha.example.com', hasApiKey: true },
          { name: 'beta', url: 'https://beta.example.com', hasApiKey: false },
        ],
      });
    });

    it('returns 500 when listing remote servers fails', async () => {
      mockGetRemoteServers.mockImplementationOnce(() => {
        throw new Error('remote list failed');
      });

      const res = await request(app).get('/api/remote-servers');

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'remote list failed' });
    });
  });

  describe('POST /api/remote-servers', () => {
    it('returns 409 in code-first mode', async () => {
      mockIsCodeFirstMode.mockReturnValueOnce(true);

      const res = await request(app)
        .post('/api/remote-servers')
        .send({ name: 'gamma', url: 'https://gamma.example.com' });

      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/code-first mode/);
    });

    it('validates required name and url fields', async () => {
      const noName = await request(app).post('/api/remote-servers').send({ url: 'https://server.example.com' });
      const noUrl = await request(app).post('/api/remote-servers').send({ name: 'server' });
      const badUrl = await request(app).post('/api/remote-servers').send({ name: 'server', url: 'notaurl' });

      expect(noName.status).toBe(400);
      expect(noName.body).toEqual({ error: 'name is required' });
      expect(noUrl.status).toBe(400);
      expect(noUrl.body).toEqual({ error: 'url is required' });
      expect(badUrl.status).toBe(400);
      expect(badUrl.body).toEqual({ error: 'Invalid URL format' });
    });

    it('returns 409 when the remote server already exists', async () => {
      const res = await request(app)
        .post('/api/remote-servers')
        .send({ name: 'alpha', url: 'https://other.example.com' });

      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: 'Server "alpha" already exists' });
    });

    it('creates a new remote server and persists project state', async () => {
      const res = await request(app)
        .post('/api/remote-servers')
        .send({ name: '  gamma  ', url: 'https://gamma.example.com/', apiKey: '  token  ' });

      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        server: { name: 'gamma', url: 'https://gamma.example.com', hasApiKey: true },
      });
      expect(mockWriteStateScope).toHaveBeenCalledWith(
        {
          remoteServers: [
            { name: 'alpha', url: 'https://alpha.example.com', apiKey: 'secret' },
            { name: 'gamma', url: 'https://gamma.example.com', apiKey: 'token' },
          ],
        },
        'project'
      );
    });

    it('returns 500 when writing remote server state fails', async () => {
      mockWriteStateScope.mockImplementationOnce(() => {
        throw new Error('write failed');
      });

      const res = await request(app)
        .post('/api/remote-servers')
        .send({ name: 'gamma', url: 'https://gamma.example.com' });

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'write failed' });
    });
  });

  describe('DELETE /api/remote-servers/:name', () => {
    it('returns 409 in code-first mode', async () => {
      mockIsCodeFirstMode.mockReturnValueOnce(true);

      const res = await request(app).delete('/api/remote-servers/alpha');

      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/code-first mode/);
    });

    it('returns 404 when the remote server is missing', async () => {
      const res = await request(app).delete('/api/remote-servers/missing');

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Server "missing" not found' });
    });

    it('deletes a configured remote server', async () => {
      const res = await request(app).delete('/api/remote-servers/alpha');

      expect(res.status).toBe(204);
      expect(mockWriteStateScope).toHaveBeenCalledWith({ remoteServers: [] }, 'project');
    });

    it('returns 500 when deleting remote server state fails', async () => {
      mockWriteStateScope.mockImplementationOnce(() => {
        throw new Error('delete write failed');
      });

      const res = await request(app).delete('/api/remote-servers/alpha');

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'delete write failed' });
    });
  });

  describe('POST /api/remote-servers/:name/test', () => {
    it('returns 404 when the remote server is missing', async () => {
      const res = await request(app).post('/api/remote-servers/missing/test');

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Server "missing" not found' });
    });

    it('returns ok status and agent count when fetch succeeds', async () => {
      const res = await request(app).post('/api/remote-servers/alpha/test');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok', agents: 2 });
      expect(mockFetch).toHaveBeenCalledWith('https://alpha.example.com/api/coding-agents/available', {
        headers: { Authorization: 'Bearer secret' },
        signal: expect.any(AbortSignal),
      });
    });

    it('returns an error payload for non-2xx remote responses', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
      });

      const res = await request(app).post('/api/remote-servers/alpha/test');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'error', message: 'HTTP 503 Service Unavailable' });
    });

    it('returns an error payload when fetch rejects', async () => {
      mockFetch.mockRejectedValueOnce(new Error('dial failed'));

      const res = await request(app).post('/api/remote-servers/alpha/test');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'error', message: 'dial failed' });
    });

    it('returns 500 when reading configured servers throws', async () => {
      mockReadLayeredState.mockImplementationOnce(() => {
        throw new Error('state read failed');
      });

      const res = await request(app).post('/api/remote-servers/alpha/test');

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'state read failed' });
    });
  });
});
