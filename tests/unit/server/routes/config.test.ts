/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Request, Response } from 'express';
import configRoutes from '@/server/routes/config';
import { loadConfigSync } from '@/lib/config/index';
import { addCustomAgent, removeCustomAgent, getCustomAgents, clearCustomAgents } from '@/server/services/customAgentStore';

// Mock config loader
jest.mock('@/lib/config/index', () => ({
  loadConfigSync: jest.fn(),
}));

// Mock custom agent store
jest.mock('@/server/services/customAgentStore', () => ({
  addCustomAgent: jest.fn(),
  removeCustomAgent: jest.fn(),
  getCustomAgents: jest.fn().mockReturnValue([]),
  clearCustomAgents: jest.fn(),
}));

const mockLoadConfigSync = loadConfigSync as jest.MockedFunction<typeof loadConfigSync>;
const mockGetCustomAgents = getCustomAgents as jest.MockedFunction<typeof getCustomAgents>;
const mockAddCustomAgent = addCustomAgent as jest.MockedFunction<typeof addCustomAgent>;
const mockRemoveCustomAgent = removeCustomAgent as jest.MockedFunction<typeof removeCustomAgent>;

// Helper to create mock request/response
function createMocks(body?: any, params?: any) {
  const req = { body, params } as unknown as Request;
  const res = {
    json: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return { req, res };
}

// Helper to get route handler
function getRouteHandler(router: any, method: string, path: string) {
  const routes = router.stack;
  const route = routes.find(
    (layer: any) =>
      layer.route &&
      layer.route.path === path &&
      layer.route.methods[method.toLowerCase()]
  );
  return route?.route.stack[0].handle;
}

describe('Config Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetCustomAgents.mockReturnValue([]);
  });

  describe('GET /api/agents', () => {
    it('returns agents from config', () => {
      mockLoadConfigSync.mockReturnValue({
        agents: [
          { key: 'demo', name: 'Demo Agent', endpoint: 'mock://demo' },
        ],
        models: {},
      } as any);

      const { req, res } = createMocks();
      const handler = getRouteHandler(configRoutes, 'get', '/api/agents');
      handler(req, res);

      expect(res.json).toHaveBeenCalledWith({
        agents: [{ key: 'demo', name: 'Demo Agent', endpoint: 'mock://demo' }],
        total: 1,
        meta: { source: 'config' },
      });
    });

    it('strips hooks from serialized agent configs', () => {
      const mockHook = jest.fn();
      mockLoadConfigSync.mockReturnValue({
        agents: [
          {
            key: 'pulsar',
            name: 'Pulsar',
            endpoint: 'http://localhost:3000/agent',
            headers: { Authorization: 'Bearer token' },
            hooks: { beforeRequest: mockHook },
          },
        ],
        models: {},
      } as any);

      const { req, res } = createMocks();
      const handler = getRouteHandler(configRoutes, 'get', '/api/agents');
      handler(req, res);

      const response = (res.json as jest.Mock).mock.calls[0][0];
      expect(response.agents).toHaveLength(1);
      expect(response.agents[0]).not.toHaveProperty('hooks');
      expect(response.agents[0].key).toBe('pulsar');
      expect(response.agents[0].name).toBe('Pulsar');
    });

    it('handles agents without hooks gracefully', () => {
      mockLoadConfigSync.mockReturnValue({
        agents: [
          { key: 'basic', name: 'Basic Agent', endpoint: 'http://localhost:3000' },
          { key: 'hooked', name: 'Hooked Agent', endpoint: 'http://localhost:3001', hooks: { beforeRequest: jest.fn() } },
        ],
        models: {},
      } as any);

      const { req, res } = createMocks();
      const handler = getRouteHandler(configRoutes, 'get', '/api/agents');
      handler(req, res);

      const response = (res.json as jest.Mock).mock.calls[0][0];
      expect(response.agents).toHaveLength(2);
      expect(response.agents[0]).not.toHaveProperty('hooks');
      expect(response.agents[1]).not.toHaveProperty('hooks');
    });

    it('returns 500 when config loading fails', () => {
      mockLoadConfigSync.mockImplementation(() => {
        throw new Error('Config load error');
      });

      const { req, res } = createMocks();
      const handler = getRouteHandler(configRoutes, 'get', '/api/agents');

      jest.spyOn(console, 'error').mockImplementation(() => {});
      handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Config load error' });
    });

    it('returns merged built-in and custom agents', () => {
      mockLoadConfigSync.mockReturnValue({
        agents: [
          { key: 'demo', name: 'Demo Agent', endpoint: 'mock://demo' },
        ],
        models: {},
      } as any);

      mockGetCustomAgents.mockReturnValue([
        { key: 'custom-1', name: 'My Custom', endpoint: 'http://custom.example.com', isCustom: true, headers: {}, connectorType: 'agui-streaming' as const },
      ]);

      const { req, res } = createMocks();
      const handler = getRouteHandler(configRoutes, 'get', '/api/agents');
      handler(req, res);

      const response = (res.json as jest.Mock).mock.calls[0][0];
      expect(response.agents).toHaveLength(2);
      expect(response.total).toBe(2);
      expect(response.agents[0].key).toBe('demo');
      expect(response.agents[1].key).toBe('custom-1');
      expect(response.agents[1].isCustom).toBe(true);
    });
  });

  describe('POST /api/agents/custom', () => {
    it('creates a custom agent and returns 201', () => {
      const { req, res } = createMocks({ name: 'Test Agent', endpoint: 'http://localhost:9000' });
      const handler = getRouteHandler(configRoutes, 'post', '/api/agents/custom');
      handler(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(mockAddCustomAgent).toHaveBeenCalledTimes(1);

      const addedAgent = mockAddCustomAgent.mock.calls[0][0];
      expect(addedAgent.name).toBe('Test Agent');
      expect(addedAgent.endpoint).toBe('http://localhost:9000');
      expect(addedAgent.isCustom).toBe(true);
      expect(addedAgent.connectorType).toBe('agui-streaming');
      expect(addedAgent.key).toMatch(/^custom-/);
    });

    it('returns 400 when name is missing', () => {
      const { req, res } = createMocks({ endpoint: 'http://localhost:9000' });
      const handler = getRouteHandler(configRoutes, 'post', '/api/agents/custom');
      handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'name is required' });
      expect(mockAddCustomAgent).not.toHaveBeenCalled();
    });

    it('returns 400 when endpoint is missing', () => {
      const { req, res } = createMocks({ name: 'Test Agent' });
      const handler = getRouteHandler(configRoutes, 'post', '/api/agents/custom');
      handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'endpoint is required' });
      expect(mockAddCustomAgent).not.toHaveBeenCalled();
    });

    it('returns 400 for invalid URL', () => {
      const { req, res } = createMocks({ name: 'Agent', endpoint: 'not-a-url' });
      const handler = getRouteHandler(configRoutes, 'post', '/api/agents/custom');
      handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid URL format' });
      expect(mockAddCustomAgent).not.toHaveBeenCalled();
    });

    it('returns 400 for non-http URL', () => {
      const { req, res } = createMocks({ name: 'Agent', endpoint: 'ftp://server.com' });
      const handler = getRouteHandler(configRoutes, 'post', '/api/agents/custom');
      handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'URL must use http or https protocol' });
      expect(mockAddCustomAgent).not.toHaveBeenCalled();
    });

    it('returns 400 for empty name string', () => {
      const { req, res } = createMocks({ name: '   ', endpoint: 'http://localhost:9000' });
      const handler = getRouteHandler(configRoutes, 'post', '/api/agents/custom');
      handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'name is required' });
    });

    it('trims whitespace from name and endpoint', () => {
      const { req, res } = createMocks({ name: '  My Agent  ', endpoint: '  http://localhost:9000  ' });
      const handler = getRouteHandler(configRoutes, 'post', '/api/agents/custom');
      handler(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      const addedAgent = mockAddCustomAgent.mock.calls[0][0];
      expect(addedAgent.name).toBe('My Agent');
      expect(addedAgent.endpoint).toBe('http://localhost:9000');
    });

    it('defaults connectorType to agui-streaming and useTraces to false when omitted', () => {
      const { req, res } = createMocks({ name: 'Test Agent', endpoint: 'http://localhost:9000' });
      const handler = getRouteHandler(configRoutes, 'post', '/api/agents/custom');
      handler(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      const addedAgent = mockAddCustomAgent.mock.calls[0][0];
      expect(addedAgent.connectorType).toBe('agui-streaming');
      expect(addedAgent.useTraces).toBe(false);
    });

    it('persists provided connectorType', () => {
      const { req, res } = createMocks({
        name: 'Rest Agent',
        endpoint: 'http://localhost:9000',
        connectorType: 'rest',
      });
      const handler = getRouteHandler(configRoutes, 'post', '/api/agents/custom');
      handler(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      const addedAgent = mockAddCustomAgent.mock.calls[0][0];
      expect(addedAgent.connectorType).toBe('rest');
    });

    it('persists useTraces: true when provided', () => {
      const { req, res } = createMocks({
        name: 'Traced Agent',
        endpoint: 'http://localhost:9000',
        useTraces: true,
      });
      const handler = getRouteHandler(configRoutes, 'post', '/api/agents/custom');
      handler(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      const addedAgent = mockAddCustomAgent.mock.calls[0][0];
      expect(addedAgent.useTraces).toBe(true);
    });

    it('returns 400 for an invalid connectorType', () => {
      const { req, res } = createMocks({
        name: 'Agent',
        endpoint: 'http://localhost:9000',
        connectorType: 'invalid-connector',
      });
      const handler = getRouteHandler(configRoutes, 'post', '/api/agents/custom');
      handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect((res.json as jest.Mock).mock.calls[0][0].error).toMatch(/connectorType must be one of/);
      expect(mockAddCustomAgent).not.toHaveBeenCalled();
    });

    it('accepts all valid connectorType values', () => {
      const validTypes = ['agui-streaming', 'rest', 'openai-compatible', 'subprocess', 'claude-code', 'mock'] as const;
      const handler = getRouteHandler(configRoutes, 'post', '/api/agents/custom');

      for (const connectorType of validTypes) {
        jest.clearAllMocks();
        const { req, res } = createMocks({
          name: 'Agent',
          endpoint: 'http://localhost:9000',
          connectorType,
        });
        handler(req, res);
        expect(res.status).toHaveBeenCalledWith(201);
        const addedAgent = mockAddCustomAgent.mock.calls[0][0];
        expect(addedAgent.connectorType).toBe(connectorType);
      }
    });

    it('coerces non-boolean useTraces to false (truthy non-true values)', () => {
      const { req, res } = createMocks({
        name: 'Agent',
        endpoint: 'http://localhost:9000',
        useTraces: 'yes',
      });
      const handler = getRouteHandler(configRoutes, 'post', '/api/agents/custom');
      handler(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      const addedAgent = mockAddCustomAgent.mock.calls[0][0];
      // Only strict true is accepted; 'yes' should be coerced to false
      expect(addedAgent.useTraces).toBe(false);
    });
  });

  describe('DELETE /api/agents/custom/:id', () => {
    it('returns 204 when agent is found and removed', () => {
      mockRemoveCustomAgent.mockReturnValue(true);

      const { req, res } = createMocks(undefined, { id: 'custom-123' });
      const handler = getRouteHandler(configRoutes, 'delete', '/api/agents/custom/:id');
      handler(req, res);

      expect(mockRemoveCustomAgent).toHaveBeenCalledWith('custom-123');
      expect(res.status).toHaveBeenCalledWith(204);
      expect(res.send).toHaveBeenCalled();
    });

    it('returns 404 when agent is not found', () => {
      mockRemoveCustomAgent.mockReturnValue(false);

      const { req, res } = createMocks(undefined, { id: 'nonexistent' });
      const handler = getRouteHandler(configRoutes, 'delete', '/api/agents/custom/:id');
      handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'Custom agent not found' });
    });
  });
});
