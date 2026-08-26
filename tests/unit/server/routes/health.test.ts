/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Request, Response } from 'express';

// Mock the version utility
jest.mock('@/server/utils/version', () => ({
  getVersion: jest.fn().mockReturnValue('1.0.0'),
}));

// Mock coding agents module
jest.mock('@/server/services/codingAgents', () => ({
  codingAnalyticsEnabled: true,
}));

import healthRoutes from '@/server/routes/health';

// Helper to create mock request/response. `remoteAddress` defaults to
// loopback since the CLI ownership check always dials over localhost.
function createMocks(remoteAddress = '127.0.0.1') {
  const req = { socket: { remoteAddress } } as unknown as Request;
  const res = {
    json: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return { req, res };
}

describe('Health Routes', () => {
  describe('GET /health', () => {
    it('returns health status', () => {
      const { req, res } = createMocks();

      // Get the route handler from the router
      const routes = (healthRoutes as any).stack;
      const healthRoute = routes.find(
        (layer: any) => layer.route && layer.route.path === '/health'
      );

      expect(healthRoute).toBeDefined();

      // Call the handler
      const handler = healthRoute.route.stack[0].handle;
      handler(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'ok',
          version: '1.0.0',
          service: 'agent-health',
          features: {
            codingAgentAnalytics: true,
          },
        })
      );
    });

    it('includes an instance identity block (pid / cwd / port / startedAt)', () => {
      const { req, res } = createMocks();
      const prev = process.env.AH_PORT;
      process.env.AH_PORT = '4042';
      try {
        const routes = (healthRoutes as any).stack;
        const healthRoute = routes.find(
          (layer: any) => layer.route && layer.route.path === '/health'
        );
        const handler = healthRoute.route.stack[0].handle;
        handler(req, res);

        const payload = (res.json as jest.Mock).mock.calls[0][0];
        expect(payload.instance).toBeDefined();
        expect(payload.instance.pid).toBe(process.pid);
        expect(payload.instance.cwd).toBe(process.cwd());
        // `port` reflects AH_PORT (the actual bound port after auto-increment).
        expect(payload.instance.port).toBe(4042);
        expect(typeof payload.instance.startedAt).toBe('string');
        expect(Number.isNaN(Date.parse(payload.instance.startedAt))).toBe(false);
      } finally {
        if (prev === undefined) delete process.env.AH_PORT;
        else process.env.AH_PORT = prev;
      }
    });

    it('omits the instance block for non-loopback (off-host) callers', () => {
      const { req, res } = createMocks('203.0.113.7');
      const routes = (healthRoutes as any).stack;
      const healthRoute = routes.find(
        (layer: any) => layer.route && layer.route.path === '/health'
      );
      const handler = healthRoute.route.stack[0].handle;
      handler(req, res);

      const payload = (res.json as jest.Mock).mock.calls[0][0];
      expect(payload.instance).toBeUndefined();
      // non-sensitive fields still returned
      expect(payload.status).toBe('ok');
      expect(payload.features).toBeDefined();
    });
  });
});
