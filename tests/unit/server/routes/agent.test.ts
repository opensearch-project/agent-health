/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Request, Response } from 'express';
import agentRoutes from '@/server/routes/agent';
import { proxyAgentRequest, validateAgentRequest } from '@/server/services/agentService';

// Mock the agent service
jest.mock('@/server/services/agentService', () => ({
  proxyAgentRequest: jest.fn(),
  validateAgentRequest: jest.fn(),
}));

const mockProxyAgentRequest = proxyAgentRequest as jest.MockedFunction<typeof proxyAgentRequest>;
const mockValidateAgentRequest = validateAgentRequest as jest.MockedFunction<typeof validateAgentRequest>;

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
  });
});
