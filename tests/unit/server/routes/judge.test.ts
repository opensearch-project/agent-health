/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Request, Response } from 'express';
import judgeRoutes from '@/server/routes/judge';
import { evaluateTrajectory, parseBedrockError } from '@/server/services/bedrockService';
import { evaluateWithOpenAICompatible, parseOpenAICompatibleError } from '@/server/services/judgeService';

// Mock the AWS Bedrock client
const mockSend = jest.fn();
jest.mock('@aws-sdk/client-bedrock', () => ({
  BedrockClient: jest.fn().mockImplementation(() => ({
    send: mockSend,
  })),
  ListInferenceProfilesCommand: jest.fn().mockImplementation((input) => input),
}));

jest.mock('@aws-sdk/credential-providers', () => ({
  fromNodeProviderChain: jest.fn().mockReturnValue({}),
}));

// Mock the bedrock service
jest.mock('@/server/services/bedrockService', () => ({
  evaluateTrajectory: jest.fn(),
  parseBedrockError: jest.fn(),
}));

// Mock the OpenAI-compatible judge service
jest.mock('@/server/services/judgeService', () => ({
  evaluateWithOpenAICompatible: jest.fn(),
  parseOpenAICompatibleError: jest.fn(),
}));

const mockEvaluateTrajectory = evaluateTrajectory as jest.MockedFunction<typeof evaluateTrajectory>;
const mockParseBedrockError = parseBedrockError as jest.MockedFunction<typeof parseBedrockError>;
const mockEvaluateWithOpenAICompatible = evaluateWithOpenAICompatible as jest.MockedFunction<typeof evaluateWithOpenAICompatible>;
const mockParseOpenAICompatibleError = parseOpenAICompatibleError as jest.MockedFunction<typeof parseOpenAICompatibleError>;

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

  describe('GET /api/judge/bedrock-models', () => {
    it('returns discovered Anthropic models from Bedrock', async () => {
      mockSend.mockResolvedValue({
        inferenceProfileSummaries: [
          { inferenceProfileId: 'us.anthropic.claude-sonnet-4-20250514-v1:0', inferenceProfileName: 'Claude Sonnet 4' },
          { inferenceProfileId: 'us.anthropic.claude-opus-4-6-v1', inferenceProfileName: 'Claude Opus 4.6' },
          { inferenceProfileId: 'us.meta.llama3-8b-instruct-v1:0', inferenceProfileName: 'Llama 3 8B' },
        ],
      });

      const { req, res } = createMocks();
      const handler = getRouteHandler(judgeRoutes, 'get', '/api/judge/bedrock-models');
      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith({
        models: [
          { id: 'us.anthropic.claude-sonnet-4-20250514-v1:0', name: 'Claude Sonnet 4' },
          { id: 'us.anthropic.claude-opus-4-6-v1', name: 'Claude Opus 4.6' },
        ],
        region: expect.any(String),
        configured: true,
      });
    });

    it('filters out non-Anthropic models', async () => {
      mockSend.mockResolvedValue({
        inferenceProfileSummaries: [
          { inferenceProfileId: 'us.meta.llama3-8b-instruct-v1:0', inferenceProfileName: 'Llama 3 8B' },
          { inferenceProfileId: 'us.amazon.titan-text-express-v1', inferenceProfileName: 'Titan Text' },
        ],
      });

      const { req, res } = createMocks();
      const handler = getRouteHandler(judgeRoutes, 'get', '/api/judge/bedrock-models');
      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith({
        models: [],
        region: expect.any(String),
        configured: true,
      });
    });

    it('returns 503 when Bedrock credentials are missing or API fails', async () => {
      mockSend.mockRejectedValue(new Error('Could not load credentials'));

      const { req, res } = createMocks();
      const handler = getRouteHandler(judgeRoutes, 'get', '/api/judge/bedrock-models');
      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith({
        error: expect.stringContaining('Cannot discover Bedrock models'),
        region: expect.any(String),
        configured: false,
      });
    });

    it('handles empty inference profiles response', async () => {
      mockSend.mockResolvedValue({
        inferenceProfileSummaries: [],
      });

      const { req, res } = createMocks();
      const handler = getRouteHandler(judgeRoutes, 'get', '/api/judge/bedrock-models');
      await handler(req, res);

      expect(res.json).toHaveBeenCalledWith({
        models: [],
        region: expect.any(String),
        configured: true,
      });
    });
  });

  describe('POST /api/judge', () => {
    it('returns 400 when trajectory is missing', async () => {
      const { req, res } = createMocks({});
      const handler = getRouteHandler(judgeRoutes, 'post', '/api/judge');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Trajectory is required and must be a non-empty array',
      });
    });

    it('returns 400 when trajectory is an empty array', async () => {
      const { req, res } = createMocks({
        trajectory: [],
        expectedOutcomes: ['Test outcome'],
      });
      const handler = getRouteHandler(judgeRoutes, 'post', '/api/judge');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Trajectory is required and must be a non-empty array',
      });
    });

    it('returns 400 when trajectory is not an array', async () => {
      const { req, res } = createMocks({
        trajectory: 'not-an-array',
        expectedOutcomes: ['Test outcome'],
      });
      const handler = getRouteHandler(judgeRoutes, 'post', '/api/judge');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Trajectory is required and must be a non-empty array',
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
          metrics: expect.objectContaining({
            accuracy: expect.any(Number),
          }),
          llmJudgeReasoning: expect.any(String),
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
        expect.any(String) // Resolved model ID from config
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
          error: expect.stringContaining('Judge evaluation failed'),
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
          metrics: expect.objectContaining({
            accuracy: expect.any(Number),
          }),
          llmJudgeReasoning: expect.stringContaining('diagnostic tools'),
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

    it('routes to evaluateWithOpenAICompatible when provider is openai-compatible', async () => {
      mockEvaluateWithOpenAICompatible.mockResolvedValue({
        passFailStatus: 'passed',
        metrics: { accuracy: 0.9 },
        llmJudgeReasoning: 'OpenAI-compatible evaluation',
        improvementStrategies: [],
        duration: 120,
      });

      const { req, res } = createMocks({
        trajectory: [{ type: 'action', toolName: 'search' }],
        expectedOutcomes: ['Identify issue'],
        modelId: 'gpt-4o', // Uses provider: 'openai-compatible' in DEFAULT_CONFIG
      });
      const handler = getRouteHandler(judgeRoutes, 'post', '/api/judge');

      await handler(req, res);

      expect(mockEvaluateWithOpenAICompatible).toHaveBeenCalledWith(
        expect.objectContaining({
          trajectory: expect.any(Array),
          expectedOutcomes: expect.any(Array),
        }),
        expect.any(String) // Resolved model ID
      );
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          passFailStatus: 'passed',
          metrics: expect.objectContaining({ accuracy: 0.9 }),
        })
      );
    });

    it('does NOT call evaluateTrajectory (Bedrock) when provider is openai-compatible', async () => {
      mockEvaluateWithOpenAICompatible.mockResolvedValue({
        passFailStatus: 'passed',
        metrics: { accuracy: 0.9 },
        llmJudgeReasoning: 'OpenAI-compatible evaluation',
        improvementStrategies: [],
        duration: 120,
      });

      const { req, res } = createMocks({
        trajectory: [{ type: 'action', toolName: 'search' }],
        expectedOutcomes: ['Identify issue'],
        modelId: 'gpt-4o',
      });
      const handler = getRouteHandler(judgeRoutes, 'post', '/api/judge');

      await handler(req, res);

      expect(mockEvaluateTrajectory).not.toHaveBeenCalled();
    });

    it('returns 500 with OpenAI-compatible error message on failure', async () => {
      const error = new Error('OpenAI-compatible endpoint responded 401: Unauthorized');
      mockEvaluateWithOpenAICompatible.mockRejectedValue(error);
      mockParseOpenAICompatibleError.mockReturnValue('OpenAI-compatible endpoint authentication failed. Check your OPENAI_COMPATIBLE_API_KEY.');

      const { req, res } = createMocks({
        trajectory: [{ type: 'action' }],
        expectedOutcomes: ['Test'],
        modelId: 'gpt-4o',
      });
      const handler = getRouteHandler(judgeRoutes, 'post', '/api/judge');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('Judge evaluation failed'),
        })
      );
    });
  });
});
