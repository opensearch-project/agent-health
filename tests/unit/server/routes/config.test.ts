/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Request, Response } from 'express';
import configRoutes from '@/server/routes/config';
import { loadConfigSync } from '@/lib/config/index';

// Mock config loader
jest.mock('@/lib/config/index', () => ({
  loadConfigSync: jest.fn(),
}));

const mockLoadConfigSync = loadConfigSync as jest.MockedFunction<typeof loadConfigSync>;

// Helper to create mock request/response
function createMocks() {
  const req = {} as Request;
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

describe('Config Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/agents', () => {
    it('returns agents from config', () => {
      mockLoadConfigSync.mockReturnValue({
        agents: [
          { key: 'demo', name: 'Demo Agent', endpoint: 'mock://demo', models: ['demo-model'] },
        ],
        models: {},
      } as any);

      const { req, res } = createMocks();
      const handler = getRouteHandler(configRoutes, 'get', '/api/agents');
      handler(req, res);

      expect(res.json).toHaveBeenCalledWith({
        agents: [{ key: 'demo', name: 'Demo Agent', endpoint: 'mock://demo', models: ['demo-model'] }],
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
            models: ['claude-sonnet-4.5'],
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
          { key: 'basic', name: 'Basic Agent', endpoint: 'http://localhost:3000', models: ['m1'] },
          { key: 'hooked', name: 'Hooked Agent', endpoint: 'http://localhost:3001', models: ['m1'], hooks: { beforeRequest: jest.fn() } },
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
  });
});
