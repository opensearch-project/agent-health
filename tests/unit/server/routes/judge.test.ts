/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Request, Response } from 'express';
import judgeRoutes from '@/server/routes/judge';
import { evaluateTrajectory, parseBedrockError } from '@/server/services/bedrockService';

// Mock the bedrock service
jest.mock('@/server/services/bedrockService', () => ({
  evaluateTrajectory: jest.fn(),
  parseBedrockError: jest.fn(),
}));

const mockEvaluateTrajectory = evaluateTrajectory as jest.MockedFunction<typeof evaluateTrajectory>;
const mockParseBedrockError = parseBedrockError as jest.MockedFunction<typeof parseBedrockError>;

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

describe('Judge Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('POST /api/judge', () => {
    it('returns 400 when trajectory is missing', async () => {
      const { req, res } = createMocks({});
      const handler = getRouteHandler(judgeRoutes, 'post', '/api/judge');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Missing required field: trajectory',
      });
    });

    it('returns 400 when expectedOutcomes and expectedTrajectory are missing', async () => {
      const { req, res } = createMocks({
        trajectory: [{ type: 'action', content: 'test' }],
      });
      const handler = getRouteHandler(judgeRoutes, 'post', '/api/judge');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Missing required field: expectedOutcomes or expectedTrajectory',
      });
    });

    it('uses mock judge when demo-model is specified', async () => {
      const { req, res } = createMocks({
        trajectory: [{ type: 'action', toolName: 'cluster_health' }],
        expectedOutcomes: ['Identify root cause'],
        modelId: 'demo-model', // Use demo-model which has provider: 'demo'
      });
      const handler = getRouteHandler(judgeRoutes, 'post', '/api/judge');

      await handler(req, res);

      expect(mockEvaluateTrajectory).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          passFailStatus: expect.stringMatching(/passed|failed/),
          accuracy: expect.any(Number),
          reasoning: expect.any(String),
        })
      );
    });

    it('calls Bedrock service for real evaluation', async () => {
      mockEvaluateTrajectory.mockResolvedValue({
        passFailStatus: 'passed',
        metrics: {
          accuracy: 0.95,
        },
        llmJudgeReasoning: 'Good performance',
        improvementStrategies: [],
        duration: 100,
      });

      const { req, res } = createMocks({
        trajectory: [{ type: 'action', toolName: 'cluster_health' }],
        expectedOutcomes: ['Identify root cause'],
        modelId: 'claude-sonnet-4', // Use bedrock model
      });
      const handler = getRouteHandler(judgeRoutes, 'post', '/api/judge');

      await handler(req, res);

      expect(mockEvaluateTrajectory).toHaveBeenCalledWith(
        expect.objectContaining({
          trajectory: expect.any(Array),
          expectedOutcomes: expect.any(Array),
        }),
        'claude-sonnet-4'
      );
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          passFailStatus: 'passed',
          metrics: expect.objectContaining({
            accuracy: 0.95,
          }),
        })
      );
    });

    it('returns 500 on Bedrock error', async () => {
      const error = new Error('Bedrock connection failed');
      mockEvaluateTrajectory.mockRejectedValue(error);
      mockParseBedrockError.mockReturnValue('Bedrock connection failed');

      const { req, res } = createMocks({
        trajectory: [{ type: 'action' }],
        expectedOutcomes: ['Test'],
        modelId: 'claude-sonnet-4', // Use bedrock model
      });
      const handler = getRouteHandler(judgeRoutes, 'post', '/api/judge');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('Bedrock Judge evaluation failed'),
        })
      );
    });

    it('handles trajectory with tool calls in demo mode', async () => {
      const { req, res } = createMocks({
        trajectory: [
          { type: 'action', toolName: 'cluster_health' },
          { type: 'response', content: 'The root cause is...' },
        ],
        expectedOutcomes: ['Check cluster health', 'Identify root cause'],
        modelId: 'demo-model', // Use demo-model
      });
      const handler = getRouteHandler(judgeRoutes, 'post', '/api/judge');

      await handler(req, res);

      // With tool calls and conclusion, should have higher accuracy
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          accuracy: expect.any(Number),
          reasoning: expect.stringContaining('diagnostic tools'),
        })
      );
    });

    it('defaults to bedrock provider when model not found', async () => {
      mockEvaluateTrajectory.mockResolvedValue({
        passFailStatus: 'passed',
        metrics: { accuracy: 0.85 },
        llmJudgeReasoning: 'Good',
        improvementStrategies: [],
        duration: 50,
      });

      const { req, res } = createMocks({
        trajectory: [{ type: 'action', toolName: 'test' }],
        expectedOutcomes: ['Test outcome'],
        modelId: 'unknown-model', // Model not in config
      });
      const handler = getRouteHandler(judgeRoutes, 'post', '/api/judge');

      await handler(req, res);

      // Should fall through to bedrock provider (default)
      expect(mockEvaluateTrajectory).toHaveBeenCalled();
    });
  });
});
