/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Request, Response } from 'express';
import agentRoutes from '@/server/routes/agent';
import { proxyAgentRequest, validateAgentRequest } from '@/server/services/agentService';
import { loadConfigSync } from '@/lib/config/index';
import { executeBeforeRequestHook } from '@/lib/hooks';

// Mock the agent service
jest.mock('@/server/services/agentService', () => ({
  proxyAgentRequest: jest.fn(),
  validateAgentRequest: jest.fn(),
}));

// Mock config loader
jest.mock('@/lib/config/index', () => ({
  loadConfigSync: jest.fn(),
}));

// Mock hooks
jest.mock('@/lib/hooks', () => ({
  executeBeforeRequestHook: jest.fn(),
}));

const mockProxyAgentRequest = proxyAgentRequest as jest.MockedFunction<typeof proxyAgentRequest>;
const mockValidateAgentRequest = validateAgentRequest as jest.MockedFunction<typeof validateAgentRequest>;
const mockLoadConfigSync = loadConfigSync as jest.MockedFunction<typeof loadConfigSync>;
const mockExecuteBeforeRequestHook = executeBeforeRequestHook as jest.MockedFunction<typeof executeBeforeRequestHook>;

// Helper to create mock request/response
function createMocks(body: any = {}) {
  const req = {
    body,
  } as Request;
  const res = {
    json: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
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

describe('Agent Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/agent', () => {
    it('returns 400 for invalid request', async () => {
      mockValidateAgentRequest.mockReturnValue({ valid: false, error: 'Missing endpoint' });

      const { req, res } = createMocks({});
      const handler = getRouteHandler(agentRoutes, 'post', '/api/agent');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Missing endpoint' });
    });

    it('proxies valid request to agent endpoint', async () => {
      mockValidateAgentRequest.mockReturnValue({ valid: true });
      mockProxyAgentRequest.mockResolvedValue(undefined);

      const { req, res } = createMocks({
        endpoint: 'http://localhost:3000/api/agent',
        payload: { prompt: 'test' },
        headers: { 'Content-Type': 'application/json' },
      });

      const handler = getRouteHandler(agentRoutes, 'post', '/api/agent');
      await handler(req, res);

      expect(mockProxyAgentRequest).toHaveBeenCalledWith(
        {
          endpoint: 'http://localhost:3000/api/agent',
          payload: { prompt: 'test' },
          headers: { 'Content-Type': 'application/json' },
        },
        res
      );
    });

    it('returns 500 on proxy error', async () => {
      mockValidateAgentRequest.mockReturnValue({ valid: true });
      mockProxyAgentRequest.mockRejectedValue(new Error('Connection refused'));

      const { req, res } = createMocks({
        endpoint: 'http://localhost:3000/api/agent',
        payload: {},
      });

      const handler = getRouteHandler(agentRoutes, 'post', '/api/agent');
      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Agent proxy failed: Connection refused',
      });
    });

    it('executes beforeRequest hook when agentKey is provided and agent has hooks', async () => {
      const mockHook = jest.fn();
      mockValidateAgentRequest.mockReturnValue({ valid: true });
      mockProxyAgentRequest.mockResolvedValue(undefined);
      mockLoadConfigSync.mockReturnValue({
        agents: [{
          key: 'pulsar',
          name: 'Pulsar',
          endpoint: 'http://localhost:3000/agent',
          models: ['claude-sonnet-4.5'],
          hooks: { beforeRequest: mockHook },
        }],
        models: {},
        connectors: [],
        testCases: [],
        reporters: [],
        judge: {},
        server: { port: 4001, reuseExistingServer: true, startTimeout: 30000 },
      } as any);
      mockExecuteBeforeRequestHook.mockResolvedValue({
        endpoint: 'http://localhost:3000/agent/v2',
        payload: { modified: true },
        headers: { 'X-Custom': 'value' },
      });

      const { req, res } = createMocks({
        endpoint: 'http://localhost:3000/agent',
        payload: { threadId: 'thread-1' },
        headers: { 'Content-Type': 'application/json' },
        agentKey: 'pulsar',
      });

      const handler = getRouteHandler(agentRoutes, 'post', '/api/agent');
      await handler(req, res);

      expect(mockExecuteBeforeRequestHook).toHaveBeenCalledWith(
        { beforeRequest: mockHook },
        {
          endpoint: 'http://localhost:3000/agent',
          payload: { threadId: 'thread-1' },
          headers: { 'Content-Type': 'application/json' },
        },
        'pulsar'
      );
      expect(mockProxyAgentRequest).toHaveBeenCalledWith(
        {
          endpoint: 'http://localhost:3000/agent/v2',
          payload: { modified: true },
          headers: { 'X-Custom': 'value' },
        },
        res
      );
    });

    it('skips hook execution when no agentKey is provided', async () => {
      mockValidateAgentRequest.mockReturnValue({ valid: true });
      mockProxyAgentRequest.mockResolvedValue(undefined);

      const { req, res } = createMocks({
        endpoint: 'http://localhost:3000/api/agent',
        payload: { prompt: 'test' },
      });

      const handler = getRouteHandler(agentRoutes, 'post', '/api/agent');
      await handler(req, res);

      expect(mockLoadConfigSync).not.toHaveBeenCalled();
      expect(mockExecuteBeforeRequestHook).not.toHaveBeenCalled();
    });

    it('skips hook execution when agent has no hooks', async () => {
      mockValidateAgentRequest.mockReturnValue({ valid: true });
      mockProxyAgentRequest.mockResolvedValue(undefined);
      mockLoadConfigSync.mockReturnValue({
        agents: [{
          key: 'basic-agent',
          name: 'Basic',
          endpoint: 'http://localhost:3000/agent',
          models: ['claude-sonnet-4.5'],
        }],
        models: {},
        connectors: [],
        testCases: [],
        reporters: [],
        judge: {},
        server: { port: 4001, reuseExistingServer: true, startTimeout: 30000 },
      } as any);

      const { req, res } = createMocks({
        endpoint: 'http://localhost:3000/agent',
        payload: { prompt: 'test' },
        agentKey: 'basic-agent',
      });

      const handler = getRouteHandler(agentRoutes, 'post', '/api/agent');
      await handler(req, res);

      expect(mockExecuteBeforeRequestHook).not.toHaveBeenCalled();
      expect(mockProxyAgentRequest).toHaveBeenCalled();
    });

    it('returns 500 when hook execution fails', async () => {
      mockValidateAgentRequest.mockReturnValue({ valid: true });
      mockLoadConfigSync.mockReturnValue({
        agents: [{
          key: 'failing-agent',
          name: 'Failing',
          endpoint: 'http://localhost:3000/agent',
          models: ['claude-sonnet-4.5'],
          hooks: { beforeRequest: jest.fn() },
        }],
        models: {},
        connectors: [],
        testCases: [],
        reporters: [],
        judge: {},
        server: { port: 4001, reuseExistingServer: true, startTimeout: 30000 },
      } as any);
      mockExecuteBeforeRequestHook.mockRejectedValue(
        new Error('beforeRequest hook failed for agent "failing-agent": Thread creation failed')
      );

      const { req, res } = createMocks({
        endpoint: 'http://localhost:3000/agent',
        payload: {},
        agentKey: 'failing-agent',
      });

      const handler = getRouteHandler(agentRoutes, 'post', '/api/agent');
      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Agent proxy failed: beforeRequest hook failed for agent "failing-agent": Thread creation failed',
      });
    });
  });
});
