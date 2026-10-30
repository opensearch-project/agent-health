/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * POST /api/judge — fail-fast paths (server/routes/judge.ts):
 *   - a `kind: 'deterministic'` evaluator is refused with 400
 *     `DETERMINISTIC_EVALUATOR` before any provider is contacted;
 *   - a provider request rejection (AWS SDK `ValidationException`, client
 *     fault + HTTP 400) is answered 400 `JUDGE_REQUEST_REJECTED` so the
 *     client's retry loop stops after one attempt; throttling / server
 *     faults keep the retryable 500.
 *   - `isProviderRequestRejection` truth table.
 */

import { Request, Response } from 'express';

jest.mock('@aws-sdk/client-bedrock', () => ({
  BedrockClient: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  ListInferenceProfilesCommand: jest.fn().mockImplementation((input) => input),
}));
jest.mock('@aws-sdk/credential-providers', () => ({ fromNodeProviderChain: jest.fn().mockReturnValue({}) }));
jest.mock('@/server/services/bedrockService', () => ({
  evaluateTrajectory: jest.fn(),
  parseBedrockError: jest.fn((e: Error) => `parsed: ${e.message}`),
}));
const mockGetEvaluatorById = jest.fn();
jest.mock('@/server/adapters', () => ({
  getStorageModule: () => ({ evaluators: { getById: mockGetEvaluatorById } }),
}));
jest.mock('@/lib/config/index', () => ({ loadConfigSync: jest.fn(() => ({ models: {}, agents: [] })) }));

import judgeRoutes, { isProviderRequestRejection } from '@/server/routes/judge';
import { evaluateTrajectory } from '@/server/services/bedrockService';

const mockEvaluateTrajectory = evaluateTrajectory as jest.MockedFunction<typeof evaluateTrajectory>;

function createMocks(body: any = {}) {
  const req = { body } as Request;
  const res = { json: jest.fn().mockReturnThis(), status: jest.fn().mockReturnThis() } as unknown as Response;
  return { req, res };
}

function postJudge() {
  const layer = (judgeRoutes as any).stack.find((l: any) => l.route?.path === '/api/judge' && l.route.methods.post);
  return layer.route.stack[0].handle as (req: Request, res: Response) => Promise<void>;
}

const body = (evaluatorId: string) => ({
  trajectory: [{ id: 's1', type: 'tool_result', toolName: 'search', content: '{"hits":[{"id":"doc-1"}]}', timestamp: 1 }],
  expectedOutcomes: ['Gold id(s): doc-1'],
  modelId: 'anthropic.claude-fixture-v1',
  evaluatorId,
});

/** Shape of an AWS SDK v3 modelled service exception. */
function sdkError(name: string, httpStatusCode: number, fault: 'client' | 'server', message: string) {
  const err = new Error(message) as any;
  err.name = name;
  err.$fault = fault;
  err.$metadata = { httpStatusCode, attempts: 1 };
  return err;
}

describe('POST /api/judge — fail fast', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it('refuses a deterministic evaluator with 400 DETERMINISTIC_EVALUATOR and never calls a provider', async () => {
    mockGetEvaluatorById.mockResolvedValue({ id: 'eval-det', name: 'Ranked retrieval', kind: 'deterministic', systemPrompt: '' });
    const { req, res } = createMocks(body('eval-det'));
    await postJudge()(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    const payload = (res.json as jest.Mock).mock.calls[0][0];
    expect(payload.code).toBe('DETERMINISTIC_EVALUATOR');
    expect(payload.error).toContain('"Ranked retrieval" is deterministic');
    expect(payload.error).toContain('scored in code');
    expect(mockEvaluateTrajectory).not.toHaveBeenCalled();
  });

  it('answers 400 JUDGE_REQUEST_REJECTED with the provider message when Bedrock throws ValidationException', async () => {
    mockGetEvaluatorById.mockResolvedValue({ id: 'eval-llm', name: 'LLM', systemPrompt: 'judge' });
    mockEvaluateTrajectory.mockRejectedValue(sdkError('ValidationException', 400, 'client', 'The text field in the SystemContentBlock object at system.0 is blank.'));
    const { req, res } = createMocks(body('eval-llm'));
    await postJudge()(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    const payload = (res.json as jest.Mock).mock.calls[0][0];
    expect(payload.code).toBe('JUDGE_REQUEST_REJECTED');
    expect(payload.error).toContain('ValidationException');
    expect(payload.error).toContain('SystemContentBlock');
    expect(payload.details).toContain('SystemContentBlock');
  });

  it('keeps the retryable 500 for throttling and server faults', async () => {
    mockGetEvaluatorById.mockResolvedValue({ id: 'eval-llm', name: 'LLM', systemPrompt: 'judge' });
    for (const err of [
      sdkError('ThrottlingException', 429, 'client', 'Too many requests'),
      sdkError('ServiceUnavailableException', 503, 'server', 'Service unavailable'),
      new Error('socket hang up'),
    ]) {
      mockEvaluateTrajectory.mockRejectedValueOnce(err);
      const { req, res } = createMocks(body('eval-llm'));
      await postJudge()(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
      expect((res.json as jest.Mock).mock.calls[0][0].code).toBeUndefined();
    }
  });
});

describe('isProviderRequestRejection', () => {
  it.each([
    ['ValidationException (modelled)', sdkError('ValidationException', 400, 'client', 'blank system'), true],
    ['ValidationException without metadata', Object.assign(new Error('x'), { name: 'ValidationException' }), true],
    ['client fault 400 under another name', sdkError('SerializationException', 400, 'client', 'bad body'), true],
    ['ResourceNotFoundException 404 (unknown model id)', sdkError('ResourceNotFoundException', 404, 'client', 'no such model'), true],
    ['ThrottlingException 429', sdkError('ThrottlingException', 429, 'client', 'slow down'), false],
    ['ModelTimeoutException 408', sdkError('ModelTimeoutException', 408, 'client', 'model timed out'), false],
    ['ModelErrorException 424', sdkError('ModelErrorException', 424, 'client', 'model error'), false],
    ['AccessDeniedException 403', sdkError('AccessDeniedException', 403, 'client', 'no'), false],
    ['ExpiredTokenException 403 (credentials, may heal on retry)', sdkError('ExpiredTokenException', 403, 'client', 'expired'), false],
    ['server fault 500', sdkError('InternalServerException', 500, 'server', 'boom'), false],
    ['plain Error', new Error('socket hang up'), false],
    ['null', null, false],
    ['string', 'ValidationException', false],
  ])('%s → %s', (_label, error, expected) => {
    expect(isProviderRequestRejection(error)).toBe(expected);
  });
});
