/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Request, Response } from 'express';
import healthRoutes from '@/server/routes/health';

// Helper to create mock request/response
function createMocks() {
  const req = {} as Request;
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

      expect(res.json).toHaveBeenCalledWith({
        status: 'ok',
        service: 'bedrock-judge-proxy',
      });
    });
  });
});
