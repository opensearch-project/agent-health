/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { Request, Response } from 'express';
import judgeRoutes from '@/server/routes/judge';
import { evaluateTrajectory, parseBedrockError } from '@/server/services/bedrockService';
import { evaluateWithOpenAICompatible, parseOpenAICompatibleError } from '@/server/services/judgeService';
import { evaluateWithLiteLLM, parseLiteLLMError } from '@/server/services/litellmJudgeService';
import { evaluateWithClaudeCode, parseClaudeCodeError } from '@/server/services/claudeCodeJudgeService';
import { evaluateWithAgenticJudge, parseAgenticJudgeError } from '@/server/services/agenticJudgeService';
import { evaluateWithPiAgenticTrace } from '@/server/services/piAgenticJudgeService';

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

// Mock the claude code judge service
jest.mock('@/server/services/claudeCodeJudgeService', () => ({
  evaluateWithClaudeCode: jest.fn(),
  parseClaudeCodeError: jest.fn(),
}));

// Mock the agentic judge service
jest.mock('@/server/services/agenticJudgeService', () => ({
  evaluateWithAgenticJudge: jest.fn(),
  parseAgenticJudgeError: jest.fn(),
}));

// Mock the pi agentic *trace* judge service (provider: 'agent')
jest.mock('@/server/services/piAgenticJudgeService', () => ({
  evaluateWithPiAgenticTrace: jest.fn(),
}));

// Mock the storage adapter so a custom evaluatorId can resolve to an
// evaluator whose inferenceConfig selects the 'agent' (trace) provider.
const mockGetEvaluatorById = jest.fn();
const mockGetEvaluationRunById = jest.fn();
const mockGetRunById = jest.fn();
jest.mock('@/server/adapters', () => ({
  getStorageModule: () => ({
    evaluators: { getById: mockGetEvaluatorById },
    evaluationRuns: { getById: mockGetEvaluationRunById },
    runs: { getById: mockGetRunById },
  }),
}));

const mockEvaluateTrajectory = evaluateTrajectory as jest.MockedFunction<typeof evaluateTrajectory>;
const mockParseBedrockError = parseBedrockError as jest.MockedFunction<typeof parseBedrockError>;
const mockEvaluateWithOpenAICompatible = evaluateWithOpenAICompatible as jest.MockedFunction<typeof evaluateWithOpenAICompatible>;
const mockParseOpenAICompatibleError = parseOpenAICompatibleError as jest.MockedFunction<typeof parseOpenAICompatibleError>;
const mockEvaluateWithLiteLLM = evaluateWithLiteLLM as jest.MockedFunction<typeof evaluateWithLiteLLM>;
const mockParseLiteLLMError = parseLiteLLMError as jest.MockedFunction<typeof parseLiteLLMError>;
const mockEvaluateWithClaudeCode = evaluateWithClaudeCode as jest.MockedFunction<typeof evaluateWithClaudeCode>;
const mockParseClaudeCodeError = parseClaudeCodeError as jest.MockedFunction<typeof parseClaudeCodeError>;
const mockEvaluateWithAgenticJudge = evaluateWithAgenticJudge as jest.MockedFunction<typeof evaluateWithAgenticJudge>;
const mockParseAgenticJudgeError = parseAgenticJudgeError as jest.MockedFunction<typeof parseAgenticJudgeError>;
const mockEvaluateWithPiAgenticTrace = evaluateWithPiAgenticTrace as jest.MockedFunction<typeof evaluateWithPiAgenticTrace>;

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

  describe('GET /api/judge/anthropic-models', () => {
    const ORIG_KEY = process.env.ANTHROPIC_API_KEY;
    afterEach(() => {
      if (ORIG_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = ORIG_KEY;
      jest.restoreAllMocks();
    });

    it('returns 503 when ANTHROPIC_API_KEY is not configured', async () => {
      // serverConfig caches env at import; the route reads serverConfig
      // .ANTHROPIC_API_KEY which is '' by default in the test env.
      const { req, res } = createMocks();
      const handler = getRouteHandler(judgeRoutes, 'get', '/api/judge/anthropic-models');
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ configured: false, error: expect.stringContaining('Anthropic API not configured') })
      );
    });
  });

  describe('GET /api/judge/github-models', () => {
    afterEach(() => jest.restoreAllMocks());

    it('returns 503 when GITHUB_TOKEN is not configured', async () => {
      const { req, res } = createMocks();
      const handler = getRouteHandler(judgeRoutes, 'get', '/api/judge/github-models');
      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ configured: false, error: expect.stringContaining('GitHub Models not configured') })
      );
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
          warning: expect.stringMatching(/MOCK_JUDGE/),
        })
      );
    });

    it('warns loudly on the server console when the mock judge is used (unconditional, not behind a debug flag)', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
      try {
        const { req, res } = createMocks({
          trajectory: [{ type: 'action', toolName: 'cluster_health' }],
          expectedOutcomes: ['Identify root cause'],
          modelId: 'demo-model',
        });
        const handler = getRouteHandler(judgeRoutes, 'post', '/api/judge');

        await handler(req, res);

        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('MOCK JUDGE IN USE'),
          expect.stringContaining('demo-model') // resolved id, e.g. "mock://demo-model"
        );
      } finally {
        warnSpy.mockRestore();
      }
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
        expect.any(String), // Resolved model ID from config
        expect.objectContaining({ id: 'system-rca-default' }) // Default evaluator
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
        expect.any(String), // Resolved model ID
        expect.objectContaining({ id: 'system-rca-default' }) // Default evaluator
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

    it('routes to evaluateWithClaudeCode when provider is claude-code', async () => {
      mockEvaluateWithClaudeCode.mockResolvedValue({
        passFailStatus: 'passed',
        metrics: { accuracy: 92 },
        llmJudgeReasoning: 'Claude Code evaluation',
        improvementStrategies: [],
        duration: 5000,
      });

      const { req, res } = createMocks({
        trajectory: [{ type: 'action', toolName: 'search' }],
        expectedOutcomes: ['Identify issue'],
        modelId: 'claude-code-judge',
      });
      const handler = getRouteHandler(judgeRoutes, 'post', '/api/judge');

      await handler(req, res);

      expect(mockEvaluateWithClaudeCode).toHaveBeenCalledWith(
        expect.objectContaining({
          trajectory: expect.any(Array),
          expectedOutcomes: expect.any(Array),
        }),
        expect.objectContaining({ id: 'system-rca-default' }) // Default evaluator
      );
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          passFailStatus: 'passed',
          metrics: expect.objectContaining({ accuracy: 92 }),
        })
      );
    });

    it('does NOT call evaluateTrajectory or evaluateWithLiteLLM when provider is claude-code', async () => {
      mockEvaluateWithClaudeCode.mockResolvedValue({
        passFailStatus: 'passed',
        metrics: { accuracy: 88 },
        llmJudgeReasoning: 'Good',
        improvementStrategies: [],
        duration: 3000,
      });

      const { req, res } = createMocks({
        trajectory: [{ type: 'action', toolName: 'test' }],
        expectedOutcomes: ['Test outcome'],
        modelId: 'claude-code-judge',
      });
      const handler = getRouteHandler(judgeRoutes, 'post', '/api/judge');

      await handler(req, res);

      expect(mockEvaluateTrajectory).not.toHaveBeenCalled();
      expect(mockEvaluateWithLiteLLM).not.toHaveBeenCalled();
    });

    it('returns 500 with Claude Code error message on claude-code failure', async () => {
      const error = new Error('Claude CLI not found');
      mockEvaluateWithClaudeCode.mockRejectedValue(error);
      mockParseClaudeCodeError.mockReturnValue('Claude CLI not found. Install it with: npm install -g @anthropic-ai/claude-code');

      const { req, res } = createMocks({
        trajectory: [{ type: 'action' }],
        expectedOutcomes: ['Test'],
        modelId: 'claude-code-judge',
      });
      const handler = getRouteHandler(judgeRoutes, 'post', '/api/judge');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(mockParseClaudeCodeError).toHaveBeenCalledWith(error);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('Judge evaluation failed'),
        })
      );
    });

    it('litellm judge service re-exports are wired correctly', () => {
      // evaluateWithLiteLLM and parseLiteLLMError are re-exports from judgeService
      // Verify they're proper functions (mock wiring)
      expect(typeof mockEvaluateWithLiteLLM).toBe('function');
      expect(typeof mockParseLiteLLMError).toBe('function');
      // The mocks are from the re-exported judgeService module
      expect(mockEvaluateWithLiteLLM).toBeDefined();
      expect(mockParseLiteLLMError).toBeDefined();
    });

    it('routes to evaluateWithAgenticJudge when provider is agentic', async () => {
      mockEvaluateWithAgenticJudge.mockResolvedValue({
        passFailStatus: 'passed',
        metrics: { accuracy: 95 },
        llmJudgeReasoning: 'Agentic judge evaluation',
        improvementStrategies: [],
        duration: 8000,
      });

      const { req, res } = createMocks({
        trajectory: [{ type: 'action', toolName: 'search' }],
        expectedOutcomes: ['Identify issue'],
        modelId: 'agentic-claude-code', // Uses provider: 'agentic' in DEFAULT_CONFIG
      });
      const handler = getRouteHandler(judgeRoutes, 'post', '/api/judge');

      await handler(req, res);

      expect(mockEvaluateWithAgenticJudge).toHaveBeenCalledWith(
        expect.objectContaining({
          trajectory: expect.any(Array),
          expectedOutcomes: expect.any(Array),
        }),
        expect.objectContaining({
          backend: 'claude-code',
        }),
        expect.objectContaining({ id: 'system-rca-default' }) // Default evaluator
      );
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          passFailStatus: 'passed',
          metrics: expect.objectContaining({ accuracy: 95 }),
        })
      );
    });

    it('routes agentic-custom to custom backend', async () => {
      mockEvaluateWithAgenticJudge.mockResolvedValue({
        passFailStatus: 'passed',
        metrics: { accuracy: 88 },
        llmJudgeReasoning: 'Custom agentic evaluation',
        improvementStrategies: [],
        duration: 6000,
      });

      const { req, res } = createMocks({
        trajectory: [{ type: 'action', toolName: 'test' }],
        expectedOutcomes: ['Test outcome'],
        modelId: 'agentic-custom', // Uses provider: 'agentic', backend: 'custom'
      });
      const handler = getRouteHandler(judgeRoutes, 'post', '/api/judge');

      await handler(req, res);

      expect(mockEvaluateWithAgenticJudge).toHaveBeenCalledWith(
        expect.objectContaining({
          trajectory: expect.any(Array),
        }),
        expect.objectContaining({
          backend: 'custom',
        }),
        expect.objectContaining({ id: 'system-rca-default' }) // Default evaluator
      );
    });

    it('does NOT call other services when provider is agentic', async () => {
      mockEvaluateWithAgenticJudge.mockResolvedValue({
        passFailStatus: 'passed',
        metrics: { accuracy: 90 },
        llmJudgeReasoning: 'OK',
        improvementStrategies: [],
        duration: 5000,
      });

      const { req, res } = createMocks({
        trajectory: [{ type: 'action', toolName: 'test' }],
        expectedOutcomes: ['Test outcome'],
        modelId: 'agentic-claude-code',
      });
      const handler = getRouteHandler(judgeRoutes, 'post', '/api/judge');

      await handler(req, res);

      expect(mockEvaluateTrajectory).not.toHaveBeenCalled();
      expect(mockEvaluateWithClaudeCode).not.toHaveBeenCalled();
      expect(mockEvaluateWithOpenAICompatible).not.toHaveBeenCalled();
      expect(mockEvaluateWithLiteLLM).not.toHaveBeenCalled();
    });

    it('returns 500 with agentic judge error message on failure', async () => {
      const error = new Error('Agentic judge timed out');
      mockEvaluateWithAgenticJudge.mockRejectedValue(error);
      mockParseAgenticJudgeError.mockReturnValue('Agentic judge evaluation timed out (10 min limit).');

      const { req, res } = createMocks({
        trajectory: [{ type: 'action' }],
        expectedOutcomes: ['Test'],
        modelId: 'agentic-claude-code',
      });
      const handler = getRouteHandler(judgeRoutes, 'post', '/api/judge');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(mockParseAgenticJudgeError).toHaveBeenCalledWith(error);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('Judge evaluation failed'),
        })
      );
    });
  });

  describe('POST /api/judge - agent evidence provider scoping', () => {
    // An evaluator whose inferenceConfig selects the evidence-agent provider.
    const agentEvaluator = {
      id: 'custom-trace-eval',
      name: 'Trace Judge',
      inferenceConfig: { provider: 'agent' },
    };

    it('works without runId using complete trajectory evidence (trace-free mode)', async () => {
      mockGetEvaluatorById.mockResolvedValue(agentEvaluator);
      mockEvaluateWithPiAgenticTrace.mockResolvedValue({
        passFailStatus: 'passed', metrics: { accuracy: 88 }, llmJudgeReasoning: 'trajectory evidence', improvementStrategies: [],
      } as any);

      const { req, res } = createMocks({
        trajectory: [{ type: 'action', toolName: 'search' }],
        expectedOutcomes: ['Identify issue'],
        evaluatorId: 'custom-trace-eval',
        // no runId: bash evidence still works; trace tools are unavailable
      });
      const handler = getRouteHandler(judgeRoutes, 'post', '/api/judge');

      await handler(req, res);

      expect(res.status).not.toHaveBeenCalledWith(400);
      expect(mockEvaluateWithPiAgenticTrace).toHaveBeenCalledWith(
        expect.objectContaining({ runId: undefined, trajectory: expect.any(Array) }),
        expect.objectContaining({ id: 'custom-trace-eval' })
      );
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ passFailStatus: 'passed' }));
    });

    it('routes to evaluateWithPiAgenticTrace when runId is present', async () => {
      mockGetEvaluatorById.mockResolvedValue(agentEvaluator);
      mockEvaluateWithPiAgenticTrace.mockResolvedValue({
        passFailStatus: 'passed',
        metrics: { accuracy: 90 },
        llmJudgeReasoning: 'Trace-backed evaluation',
        improvementStrategies: [],
      } as any);

      const { req, res } = createMocks({
        trajectory: [{ type: 'action', toolName: 'search' }],
        expectedOutcomes: ['Identify issue'],
        evaluatorId: 'custom-trace-eval',
        runId: 'run-abc-123',
      });
      const handler = getRouteHandler(judgeRoutes, 'post', '/api/judge');

      await handler(req, res);

      expect(res.status).not.toHaveBeenCalledWith(400);
      expect(mockEvaluateWithPiAgenticTrace).toHaveBeenCalledWith(
        expect.objectContaining({ runId: 'run-abc-123' }),
        expect.objectContaining({ id: 'custom-trace-eval' }) // Saved evaluator
      );
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ passFailStatus: 'passed' })
      );
    });

    it('rejects an agentKey that differs from trusted run metadata', async () => {
      mockGetEvaluatorById.mockResolvedValue(agentEvaluator);
      mockGetEvaluationRunById.mockResolvedValue({ id: 'run-1', agentKey: 'trusted-agent' });

      const { req, res } = createMocks({
        trajectory: [{ type: 'action', runId: 'run-1' }], expectedOutcomes: ['Identify issue'],
        evaluatorId: 'custom-trace-eval', runId: 'run-1',
        evidenceContext: { agentKey: 'other-agent' },
      });
      await getRouteHandler(judgeRoutes, 'post', '/api/judge')(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(mockEvaluateWithPiAgenticTrace).not.toHaveBeenCalled();
    });

    it('derives the workspace agent from trusted run metadata', async () => {
      mockGetEvaluatorById.mockResolvedValue(agentEvaluator);
      mockGetEvaluationRunById.mockResolvedValue({ id: 'run-1', agentKey: 'test-agent' });
      mockEvaluateWithPiAgenticTrace.mockResolvedValue({ passFailStatus: 'passed' } as any);

      const { req, res } = createMocks({
        trajectory: [{ type: 'action', runId: 'run-1' }], expectedOutcomes: ['Identify issue'],
        evaluatorId: 'custom-trace-eval', runId: 'run-1', evidenceContext: {},
      });
      await getRouteHandler(judgeRoutes, 'post', '/api/judge')(req, res);

      expect(mockEvaluateWithPiAgenticTrace).toHaveBeenCalledWith(
        expect.objectContaining({ evidenceContext: expect.objectContaining({ agentKey: 'test-agent' }) }),
        expect.anything()
      );
    });

    it('does not trust a client-supplied workspace path', async () => {
      mockGetEvaluatorById.mockResolvedValue(agentEvaluator);
      mockEvaluateWithPiAgenticTrace.mockResolvedValue({
        passFailStatus: 'passed', metrics: { accuracy: 90 }, llmJudgeReasoning: 'ok', improvementStrategies: [],
      } as any);

      const { req, res } = createMocks({
        trajectory: [{ type: 'action', toolName: 'search' }],
        expectedOutcomes: ['Identify issue'],
        evaluatorId: 'custom-trace-eval',
        evidenceContext: {
          agentKey: 'attacker-controlled-agent',
          workspaceDir: '/etc',
          metadata: { workspaceDir: '/etc' },
        },
      });
      const handler = getRouteHandler(judgeRoutes, 'post', '/api/judge');

      await handler(req, res);

      expect(mockEvaluateWithPiAgenticTrace).toHaveBeenCalledWith(
        expect.objectContaining({
          evidenceContext: expect.objectContaining({ workspaceDir: undefined }),
        }),
        expect.objectContaining({ id: 'custom-trace-eval' })
      );
    });

    it('returns 403 when runId does not match the runId carried by the submitted trajectory (#3 cross-run guard)', async () => {
      mockGetEvaluatorById.mockResolvedValue(agentEvaluator);

      const { req, res } = createMocks({
        // Trajectory came from run 'run-OWN', but the caller asks the judge to
        // inspect a different run's traces.
        trajectory: [{ type: 'action', toolName: 'search', runId: 'run-OWN' }],
        expectedOutcomes: ['Identify issue'],
        evaluatorId: 'custom-trace-eval',
        runId: 'run-SOMEONE-ELSE',
      });
      const handler = getRouteHandler(judgeRoutes, 'post', '/api/judge');

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(mockEvaluateWithPiAgenticTrace).not.toHaveBeenCalled();
    });

    it('allows when the requested runId matches a runId in the trajectory', async () => {
      mockGetEvaluatorById.mockResolvedValue(agentEvaluator);
      mockEvaluateWithPiAgenticTrace.mockResolvedValue({
        passFailStatus: 'passed', metrics: { accuracy: 91 }, llmJudgeReasoning: 'ok', improvementStrategies: [],
      } as any);

      const { req, res } = createMocks({
        trajectory: [{ type: 'action', toolName: 'search', runId: 'run-OWN' }],
        expectedOutcomes: ['Identify issue'],
        evaluatorId: 'custom-trace-eval',
        runId: 'run-OWN',
      });
      const handler = getRouteHandler(judgeRoutes, 'post', '/api/judge');

      await handler(req, res);

      expect(res.status).not.toHaveBeenCalledWith(403);
      expect(mockEvaluateWithPiAgenticTrace).toHaveBeenCalledWith(
        expect.objectContaining({ runId: 'run-OWN' }),
        expect.objectContaining({ id: 'custom-trace-eval' }) // Saved evaluator
      );
    });
  });
});
