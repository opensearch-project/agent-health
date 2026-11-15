/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `runJudge` — provider dispatch extracted from `POST /api/judge`
 * (services/judge/runJudge.ts). One case per provider branch + the typed
 * request errors the HTTP wrapper maps back to 400/403, with every provider
 * service mocked at the module boundary (what the route tests did).
 */

jest.mock('@/server/services/bedrockService', () => ({
  evaluateTrajectory: jest.fn(),
  parseBedrockError: jest.fn((e: any) => `bedrock: ${e.message}`),
}));
jest.mock('@/server/services/judgeService', () => ({
  evaluateWithOpenAICompatible: jest.fn(),
  parseOpenAICompatibleError: jest.fn((e: any) => `openai: ${e.message}`),
}));
jest.mock('@/server/services/litellmJudgeService', () => ({
  evaluateWithLiteLLM: jest.fn(),
  parseLiteLLMError: jest.fn((e: any) => `litellm: ${e.message}`),
}));
jest.mock('@/server/services/claudeCodeJudgeService', () => ({
  evaluateWithClaudeCode: jest.fn(),
  parseClaudeCodeError: jest.fn((e: any) => `claude: ${e.message}`),
}));
jest.mock('@/server/services/piJudgeService', () => ({
  evaluateWithPi: jest.fn(),
  parsePiError: jest.fn((e: any) => `pi: ${e.message}`),
}));
jest.mock('@/server/services/piAgenticJudgeService', () => ({
  evaluateWithPiAgenticTrace: jest.fn(),
}));
jest.mock('@/server/services/agenticJudgeService', () => ({
  evaluateWithAgenticJudge: jest.fn(),
  parseAgenticJudgeError: jest.fn((e: any) => `agentic: ${e.message}`),
}));
jest.mock('@/lib/debug', () => ({ debug: jest.fn() }));

import { evaluateTrajectory } from '@/server/services/bedrockService';
import { evaluateWithOpenAICompatible } from '@/server/services/judgeService';
import { evaluateWithLiteLLM } from '@/server/services/litellmJudgeService';
import { evaluateWithClaudeCode } from '@/server/services/claudeCodeJudgeService';
import { evaluateWithPi } from '@/server/services/piJudgeService';
import { evaluateWithPiAgenticTrace } from '@/server/services/piAgenticJudgeService';
import { evaluateWithAgenticJudge } from '@/server/services/agenticJudgeService';
import { runJudge, JudgeRequestError, describeJudgeFailure, resolveJudgeProvider, isProviderRequestRejection, type JudgeConfig } from '@/services/judge/runJudge';
import { DEFAULT_EVALUATOR_ID } from '@/server/prompts/evaluatorTemplates';

const verdict = {
  passFailStatus: 'passed' as const,
  metrics: { accuracy: 90, faithfulness: 90, latency_score: 90, trajectory_alignment_score: 90 },
  llmJudgeReasoning: 'fine',
  improvementStrategies: [],
  duration: 1,
};

const config: JudgeConfig = {
  models: {
    'demo-model': { model_id: 'mock://demo-model', display_name: 'Demo', provider: 'demo' } as any,
    'bedrock-model': { model_id: 'us.anthropic.claude', display_name: 'Claude', provider: 'bedrock' } as any,
    'cc-model': { model_id: 'claude-code', display_name: 'CC', provider: 'claude-code' } as any,
    'pi-model': { model_id: 'pi-judge', display_name: 'Pi', provider: 'pi' } as any,
    'agent-model': { model_id: 'agent-trace-judge', display_name: 'Agent', provider: 'agent' } as any,
    'agentic-model': { model_id: 'agentic-custom', display_name: 'Agentic', provider: 'agentic' } as any,
    'oai-model': { model_id: 'gpt-x', display_name: 'OAI', provider: 'openai-compatible' } as any,
    'lite-model': { model_id: 'lite-x', display_name: 'Lite', provider: 'litellm' } as any,
  },
  judge: { endpoint: 'http://agentic.local' },
};

const trajectory = [{ type: 'response', content: 'root cause found', runId: 'run-1' }];
const body = (extra: Record<string, unknown> = {}) => ({ trajectory, expectedOutcomes: ['finds the root cause'], ...extra });
const deps = (getEvaluator = jest.fn(async () => null)) => ({ getEvaluator, config });

describe('runJudge — provider dispatch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it('400 when the trajectory is missing/empty or no expectations are given', async () => {
    await expect(runJudge({ trajectory: [], expectedOutcomes: ['x'] }, deps())).rejects.toMatchObject({ status: 400, message: /Trajectory is required/ });
    await expect(runJudge({ trajectory } as any, deps())).rejects.toMatchObject({ status: 400, message: /expectedOutcomes or expectedTrajectory/ });
    await expect(runJudge({ trajectory: [], expectedOutcomes: ['x'] }, deps())).rejects.toBeInstanceOf(JudgeRequestError);
  });

  it('400 when a stored evaluator id is unknown; system evaluators never hit the lookup', async () => {
    const getEvaluator = jest.fn(async () => null);
    await expect(runJudge(body({ evaluatorId: 'ev-missing' }), deps(getEvaluator))).rejects.toMatchObject({ status: 400, message: 'Evaluator not found: ev-missing' });
    expect(getEvaluator).toHaveBeenCalledWith('ev-missing');

    (evaluateTrajectory as jest.Mock).mockResolvedValue(verdict);
    getEvaluator.mockClear();
    await runJudge(body({ evaluatorId: DEFAULT_EVALUATOR_ID, modelId: 'bedrock-model' }), deps(getEvaluator));
    expect(getEvaluator).not.toHaveBeenCalled();
  });

  it('a deterministic evaluator is refused with 400 DETERMINISTIC_EVALUATOR before any provider is called (#606)', async () => {
    const evaluator = { id: 'ev-det', name: 'Hit@k', kind: 'deterministic', scoringConfig: { metrics: [] } } as any;
    await expect(runJudge(body({ evaluatorId: 'ev-det', modelId: 'bedrock-model' }), deps(jest.fn(async () => evaluator))))
      .rejects.toMatchObject({ status: 400, code: 'DETERMINISTIC_EVALUATOR', message: /is deterministic/ });
    expect(evaluateTrajectory).not.toHaveBeenCalled();
  });

  it('demo → mock verdict with judgeProvider demo and a structured MOCK_JUDGE warning (no provider called)', async () => {
    const result: any = await runJudge(body({ modelId: 'demo-model' }), deps());
    expect(result.judgeProvider).toBe('demo');
    expect(result.judgeModel).toBe('mock://demo-model');
    expect(result.warning).toMatch(/MOCK_JUDGE/);
    expect(['passed', 'failed']).toContain(result.passFailStatus);
    expect(result.scoringSnapshot).toBeDefined();
    expect(evaluateTrajectory).not.toHaveBeenCalled();
  });

  it('bedrock (default when the model is unknown) → evaluateTrajectory with the resolved model id and the default evaluator', async () => {
    (evaluateTrajectory as jest.Mock).mockResolvedValue(verdict);
    const result: any = await runJudge(body({ modelId: 'bedrock-model' }), deps());
    expect(evaluateTrajectory).toHaveBeenCalledWith(
      expect.objectContaining({ trajectory, expectedOutcomes: ['finds the root cause'] }),
      'us.anthropic.claude',
      expect.objectContaining({ id: DEFAULT_EVALUATOR_ID }),
    );
    expect(result).toMatchObject({ passFailStatus: 'passed', llmVerdict: 'passed' });

    // A raw model id that is not a catalog key → still bedrock, id passed through.
    await runJudge(body({ modelId: 'us.anthropic.something-else' }), deps());
    expect(evaluateTrajectory).toHaveBeenLastCalledWith(expect.anything(), 'us.anthropic.something-else', expect.anything());
  });

  it('a stored evaluator inferenceConfig overrides both provider and model', async () => {
    (evaluateWithOpenAICompatible as jest.Mock).mockResolvedValue(verdict);
    const evaluator = { id: 'ev-1', name: 'Custom', systemPrompt: 'judge it', inferenceConfig: { provider: 'openai-compatible', modelId: 'gpt-override' } } as any;
    await runJudge(body({ evaluatorId: 'ev-1', modelId: 'bedrock-model' }), deps(jest.fn(async () => evaluator)));
    expect(evaluateWithOpenAICompatible).toHaveBeenCalledWith(expect.anything(), 'gpt-override', evaluator);
    expect(evaluateTrajectory).not.toHaveBeenCalled();
  });

  it.each([
    ['claude-code', 'cc-model', evaluateWithClaudeCode],
    ['pi', 'pi-model', evaluateWithPi],
  ])('%s → its CLI service receives the request and the resolved evaluator', async (_p, modelId, fn) => {
    (fn as jest.Mock).mockResolvedValue(verdict);
    await runJudge(body({ modelId }), deps());
    expect(fn).toHaveBeenCalledWith(expect.objectContaining({ trajectory }), expect.objectContaining({ id: DEFAULT_EVALUATOR_ID }));
  });

  it.each([
    ['openai-compatible', 'oai-model', 'gpt-x', evaluateWithOpenAICompatible],
    ['litellm', 'lite-model', 'lite-x', evaluateWithLiteLLM],
  ])('%s → endpoint service receives the resolved model id', async (_p, modelId, resolved, fn) => {
    (fn as jest.Mock).mockResolvedValue(verdict);
    await runJudge(body({ modelId }), deps());
    expect(fn).toHaveBeenCalledWith(expect.objectContaining({ trajectory }), resolved, expect.anything());
  });

  it('agent → trace tools enabled with a runId, disabled without any correlator', async () => {
    (evaluateWithPiAgenticTrace as jest.Mock).mockResolvedValue({ ...verdict, judgeMode: 'trace-tools' });
    await runJudge(body({ modelId: 'agent-model', runId: 'run-1' }), deps());
    expect(evaluateWithPiAgenticTrace).toHaveBeenLastCalledWith(
      expect.objectContaining({ runId: 'run-1', modelId: 'agent-trace-judge' }), expect.anything(), true,
    );
    await runJudge({ trajectory: [{ type: 'response', content: 'x' }], expectedOutcomes: ['y'], modelId: 'agent-model' }, deps());
    expect(evaluateWithPiAgenticTrace).toHaveBeenLastCalledWith(expect.objectContaining({ runId: undefined }), expect.anything(), false);
  });

  it('agent → 403 when the requested runId does not match the trajectory it claims to judge', async () => {
    await expect(runJudge(body({ modelId: 'agent-model', runId: 'someone-elses-run' }), deps()))
      .rejects.toMatchObject({ status: 403, message: /runId does not match the submitted trajectory/ });
    expect(evaluateWithPiAgenticTrace).not.toHaveBeenCalled();
  });

  it('agentic → backend custom for agentic-custom with the configured endpoint', async () => {
    (evaluateWithAgenticJudge as jest.Mock).mockResolvedValue(verdict);
    await runJudge(body({ modelId: 'agentic-model', runId: 'run-1' }), deps());
    expect(evaluateWithAgenticJudge).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-1' }),
      { backend: 'custom', endpoint: 'http://agentic.local' },
      expect.anything(),
    );
  });

  it('provider errors propagate untouched (the wrapper decides the HTTP shape)', async () => {
    (evaluateTrajectory as jest.Mock).mockRejectedValue(new Error('ThrottlingException'));
    await expect(runJudge(body({ modelId: 'bedrock-model' }), deps())).rejects.toThrow('ThrottlingException');
  });
});

describe('isProviderRequestRejection (#606)', () => {
  it('matches ValidationException and client-fault 400/404 only', () => {
    expect(isProviderRequestRejection({ name: 'ValidationException' })).toBe(true);
    expect(isProviderRequestRejection({ name: 'X', $fault: 'client', $metadata: { httpStatusCode: 400 } })).toBe(true);
    expect(isProviderRequestRejection({ name: 'ResourceNotFoundException', $fault: 'client', $metadata: { httpStatusCode: 404 } })).toBe(true);
    expect(isProviderRequestRejection({ name: 'ThrottlingException', $fault: 'client', $metadata: { httpStatusCode: 429 } })).toBe(false);
    expect(isProviderRequestRejection({ name: 'InternalServerException', $fault: 'server', $metadata: { httpStatusCode: 500 } })).toBe(false);
    expect(isProviderRequestRejection(undefined)).toBe(false);
  });
});

describe('describeJudgeFailure / resolveJudgeProvider', () => {
  it('routes the message through the provider-specific parser derived from modelId', () => {
    const err = new Error('boom');
    expect(describeJudgeFailure(err, 'pi-model', config)).toBe('pi: boom');
    expect(describeJudgeFailure(err, 'agent-model', config)).toBe('pi: boom');
    expect(describeJudgeFailure(err, 'cc-model', config)).toBe('claude: boom');
    expect(describeJudgeFailure(err, 'lite-model', config)).toBe('litellm: boom');
    expect(describeJudgeFailure(err, 'oai-model', config)).toBe('openai: boom');
    expect(describeJudgeFailure(err, 'agentic-model', config)).toBe('agentic: boom');
    expect(describeJudgeFailure(err, 'bedrock-model', config)).toBe('bedrock: boom');
    expect(describeJudgeFailure(err, undefined, undefined)).toBe('bedrock: boom');
  });

  it('resolves by catalog key, by raw model_id, and falls back to bedrock', () => {
    expect(resolveJudgeProvider(config, 'pi-model')).toEqual({ provider: 'pi', resolvedModelId: 'pi-judge' });
    expect(resolveJudgeProvider(config, 'lite-x')).toEqual({ provider: 'litellm', resolvedModelId: 'lite-x' });
    expect(resolveJudgeProvider(config, 'unknown')).toEqual({ provider: 'bedrock', resolvedModelId: 'unknown' });
  });
});
