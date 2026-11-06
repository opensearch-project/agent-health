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
import { registerActiveRunLister } from '@/server/services/runCancellation';

function callHealth(req: Request, res: Response): any {
  const routes = (healthRoutes as any).stack;
  const healthRoute = routes.find(
    (layer: any) => layer.route && layer.route.path === '/health'
  );
  healthRoute.route.stack[0].handle(req, res);
  return (res.json as jest.Mock).mock.calls[0][0];
}

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
      expect(payload.activeRuns).toBeUndefined();
      // non-sensitive fields still returned
      expect(payload.status).toBe('ok');
      expect(payload.features).toBeDefined();
    });
  });

  // #612 problem 5: the CLI must know whether a version-mismatched server is
  // executing anything before it restarts it. The answer comes from the
  // process's own executor registries, never from storage status.
  describe('GET /health activeRuns (loopback only)', () => {
    it('reports zero in-flight runs on an idle server', () => {
      const { req, res } = createMocks();
      expect(callHealth(req, res).activeRuns).toEqual({ count: 0, runs: [] });
    });

    it('lists every run the registries are executing, with its kind', () => {
      const off = registerActiveRunLister(() => [
        { id: 'run-1', kind: 'benchmark' },
        { id: 'eval-run-2', kind: 'evaluation' },
      ]);
      try {
        const { req, res } = createMocks();
        expect(callHealth(req, res).activeRuns).toEqual({
          count: 2,
          runs: [{ id: 'run-1', kind: 'benchmark' }, { id: 'eval-run-2', kind: 'evaluation' }],
        });
      } finally {
        off();
      }
      const { req, res } = createMocks();
      expect(callHealth(req, res).activeRuns).toEqual({ count: 0, runs: [] });
    });

    it('caps the listed ids at 20 but keeps the true count', () => {
      const off = registerActiveRunLister(() =>
        Array.from({ length: 25 }, (_, i) => ({ id: `run-${i}`, kind: 'evaluation' as const }))
      );
      try {
        const { req, res } = createMocks();
        const { activeRuns } = callHealth(req, res);
        expect(activeRuns.count).toBe(25);
        expect(activeRuns.runs).toHaveLength(20);
        expect(activeRuns.runs[0]).toEqual({ id: 'run-0', kind: 'evaluation' });
      } finally {
        off();
      }
    });
  });
});
