/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Agent (trace) judge — model IDENTITY.
 *
 * `agent-trace-judge` is a PROVIDER whose underlying LLM is chosen at run
 * time from the pi registry. These tests pin:
 *   - `resolveAgentJudgeModel` precedence: evaluator pin > AH_AGENT_JUDGE_MODEL_ID
 *     env pin > real request modelId > auto-pick — and that a provider
 *     pseudo-id is never accepted as a pin;
 *   - the auto-pick itself is UNCHANGED (still prefers a recent Claude Sonnet
 *     on a region/global inference profile) so existing runs stay comparable;
 *   - `extractResponseModel` reads what pi actually answered with;
 *   - `evaluateWithPiAgenticTrace` returns `judgeModel` / `judgeProvider` on
 *     EVERY verdict (not only under AH_JUDGE_DEBUG), with the resolved model
 *     in the provider-qualified `provider/id` shape.
 *
 * The SDK is mocked at the module boundary (a fake registry + a fake
 * session whose transcript reports the model), so no credentials / network.
 */

const mockGetAvailable = jest.fn();
const mockSessionPrompt = jest.fn();
let mockSessionMessages: any[] = [];

jest.mock('@earendil-works/pi-coding-agent', () => ({
  AuthStorage: { create: () => ({}) },
  ModelRegistry: { create: () => ({ getAvailable: mockGetAvailable }) },
  SessionManager: { inMemory: () => ({}) },
  DefaultResourceLoader: class {
    constructor(_: any) {}
    async reload() {}
  },
  getAgentDir: () => '/tmp/agent-dir',
  createAgentSession: async () => ({
    session: {
      prompt: mockSessionPrompt,
      get messages() { return mockSessionMessages; },
    },
  }),
}), { virtual: true });

jest.mock('@/lib/debug', () => ({ debug: jest.fn() }));

import {
  resolveAgentJudgeModel,
  pickJudgeModel,
  extractResponseModel,
  qualifiedModelId,
  describeDefaultAgentJudgeModel,
  evaluateWithPiAgenticTrace,
  AGENT_JUDGE_MODEL_ENV,
} from '@/server/services/piAgenticJudgeService';

const m = (id: string, provider = 'amazon-bedrock', name?: string) => ({ provider, id, name });

// The shape of the live registry on 2026-09-09 (98 credentialed models):
// the auto-pick must land on the Sonnet 4.5 GLOBAL profile — this is the
// "what judges today" fact the owner asked to have recorded.
const LIVE_LIKE_REGISTRY = [
  m('anthropic.claude-sonnet-4-5-20250929-v1:0', 'amazon-bedrock', 'Claude Sonnet 4.5'),
  m('global.anthropic.claude-sonnet-4-5-20250929-v1:0', 'amazon-bedrock', 'Claude Sonnet 4.5 (Global)'),
  m('us.anthropic.claude-sonnet-4-5-20250929-v1:0', 'amazon-bedrock', 'Claude Sonnet 4.5 (US)'),
  m('global.anthropic.claude-sonnet-4-6', 'amazon-bedrock', 'Claude Sonnet 4.6 (Global)'),
  m('us.anthropic.claude-sonnet-4-6', 'amazon-bedrock', 'Claude Sonnet 4.6 (US)'),
  m('jp.anthropic.claude-sonnet-4-5-20250929-v1:0', 'amazon-bedrock', 'Claude Sonnet 4.5 (JP)'),
  m('us.anthropic.claude-opus-4-6-v1', 'amazon-bedrock', 'Claude Opus 4.6 (US)'),
  m('us.anthropic.claude-3-5-sonnet-20241022-v2:0', 'amazon-bedrock', 'Claude 3.5 Sonnet v2'),
  m('gpt-4o', 'openai', 'GPT-4o'),
];

describe('resolveAgentJudgeModel', () => {
  const OLD_ENV = process.env[AGENT_JUDGE_MODEL_ENV];
  const OLD_REGION = process.env.AWS_REGION;
  beforeEach(() => {
    delete process.env[AGENT_JUDGE_MODEL_ENV];
    process.env.AWS_REGION = 'us-west-2';
  });
  afterAll(() => {
    if (OLD_ENV === undefined) delete process.env[AGENT_JUDGE_MODEL_ENV]; else process.env[AGENT_JUDGE_MODEL_ENV] = OLD_ENV;
    process.env.AWS_REGION = OLD_REGION;
  });

  it('auto-picks (source=auto) with the UNCHANGED scorer: Sonnet 4.5 global profile on the live-like registry', () => {
    const r = resolveAgentJudgeModel(LIVE_LIKE_REGISTRY);
    expect(r?.source).toBe('auto');
    // Same as pickJudgeModel — the pick order is deliberately not changed.
    expect(r?.model.id).toBe(pickJudgeModel(LIVE_LIKE_REGISTRY)?.id);
    expect(qualifiedModelId(r!.model)).toBe('amazon-bedrock/global.anthropic.claude-sonnet-4-5-20250929-v1:0');
  });

  it('honours the AH_AGENT_JUDGE_MODEL_ID env pin (source=env-pin), matched by base id across profiles', () => {
    process.env[AGENT_JUDGE_MODEL_ENV] = 'anthropic.claude-sonnet-4-6';
    const r = resolveAgentJudgeModel(LIVE_LIKE_REGISTRY);
    expect(r?.source).toBe('env-pin');
    // region-appropriate profile preferred over global/bare for the pinned base id
    expect(r?.model.id).toBe('us.anthropic.claude-sonnet-4-6');
  });

  it('accepts the env pin via an explicit env object (deterministic in tests)', () => {
    const r = resolveAgentJudgeModel(LIVE_LIKE_REGISTRY, { env: { [AGENT_JUDGE_MODEL_ENV]: 'us.anthropic.claude-opus-4-6-v1' } as any });
    expect(r?.source).toBe('env-pin');
    expect(r?.model.id).toBe('us.anthropic.claude-opus-4-6-v1');
  });

  it('evaluator pin (inferenceConfig.agentJudgeModelId) beats the env pin', () => {
    process.env[AGENT_JUDGE_MODEL_ENV] = 'anthropic.claude-sonnet-4-6';
    const r = resolveAgentJudgeModel(LIVE_LIKE_REGISTRY, { evaluatorPin: 'anthropic.claude-opus-4-6-v1' });
    expect(r?.source).toBe('evaluator-pin');
    expect(r?.model.id).toBe('us.anthropic.claude-opus-4-6-v1');
  });

  it('env pin beats the request modelId; a REAL request modelId beats auto-pick (pre-existing behaviour kept)', () => {
    process.env[AGENT_JUDGE_MODEL_ENV] = 'anthropic.claude-sonnet-4-6';
    expect(resolveAgentJudgeModel(LIVE_LIKE_REGISTRY, { requestedModelId: 'anthropic.claude-opus-4-6-v1' })?.model.id)
      .toBe('us.anthropic.claude-sonnet-4-6');
    delete process.env[AGENT_JUDGE_MODEL_ENV];
    const r = resolveAgentJudgeModel(LIVE_LIKE_REGISTRY, { requestedModelId: 'anthropic.claude-opus-4-6-v1' });
    expect(r?.source).toBe('request');
    expect(r?.model.id).toBe('us.anthropic.claude-opus-4-6-v1');
  });

  it('NEVER treats a provider pseudo-id as a pin — `agent-trace-judge` as request/env/evaluator falls through to auto', () => {
    process.env[AGENT_JUDGE_MODEL_ENV] = 'agent-trace-judge';
    const r = resolveAgentJudgeModel(LIVE_LIKE_REGISTRY, { requestedModelId: 'agent-trace-judge', evaluatorPin: 'pi-judge' });
    expect(r?.source).toBe('auto');
    expect(r?.model.id).toBe('global.anthropic.claude-sonnet-4-5-20250929-v1:0');
  });

  it('a pin that matches no credentialed model falls through to the next rule (never a hard failure)', () => {
    process.env[AGENT_JUDGE_MODEL_ENV] = 'anthropic.claude-mythos-9';
    const r = resolveAgentJudgeModel(LIVE_LIKE_REGISTRY, { evaluatorPin: 'not-a-model' });
    expect(r?.source).toBe('auto');
  });

  it('returns undefined only when the registry is empty', () => {
    expect(resolveAgentJudgeModel([])).toBeUndefined();
    process.env[AGENT_JUDGE_MODEL_ENV] = 'anthropic.claude-sonnet-4-6';
    expect(resolveAgentJudgeModel([])).toBeUndefined();
  });
});

describe('extractResponseModel', () => {
  it('returns the model/provider of the LAST assistant message, preferring responseModel', () => {
    const messages = [
      { role: 'user', content: [] },
      { role: 'assistant', provider: 'amazon-bedrock', model: 'us.anthropic.claude-sonnet-4-5', content: [] },
      { role: 'toolResult', content: [] },
      { role: 'assistant', provider: 'amazon-bedrock', model: 'us.anthropic.claude-sonnet-4-5', responseModel: 'claude-sonnet-4-5-20250929', content: [] },
    ];
    expect(extractResponseModel(messages)).toEqual({ provider: 'amazon-bedrock', model: 'claude-sonnet-4-5-20250929' });
  });
  it('returns undefined when no assistant message carries a model', () => {
    expect(extractResponseModel([{ role: 'assistant', content: [] }])).toBeUndefined();
    expect(extractResponseModel([])).toBeUndefined();
    expect(extractResponseModel(undefined as any)).toBeUndefined();
  });
});

describe('describeDefaultAgentJudgeModel (GET /api/judge/models backing)', () => {
  const OLD_ENV = process.env[AGENT_JUDGE_MODEL_ENV];
  afterEach(() => {
    if (OLD_ENV === undefined) delete process.env[AGENT_JUDGE_MODEL_ENV]; else process.env[AGENT_JUDGE_MODEL_ENV] = OLD_ENV;
  });

  it('reports the auto-picked model with its registry display name and source', async () => {
    delete process.env[AGENT_JUDGE_MODEL_ENV];
    process.env.AWS_REGION = 'us-west-2';
    mockGetAvailable.mockResolvedValue(LIVE_LIKE_REGISTRY);
    await expect(describeDefaultAgentJudgeModel()).resolves.toEqual({
      id: 'amazon-bedrock/global.anthropic.claude-sonnet-4-5-20250929-v1:0',
      name: 'Claude Sonnet 4.5 (Global)',
      source: 'auto',
    });
  });

  it('reports source=env-pin when AH_AGENT_JUDGE_MODEL_ID is set', async () => {
    process.env[AGENT_JUDGE_MODEL_ENV] = 'anthropic.claude-sonnet-4-6';
    mockGetAvailable.mockResolvedValue(LIVE_LIKE_REGISTRY);
    const r = await describeDefaultAgentJudgeModel();
    expect(r).toMatchObject({ source: 'env-pin' });
    expect((r as any).id).toContain('claude-sonnet-4-6');
  });

  it('never throws: an empty registry yields { error }', async () => {
    mockGetAvailable.mockResolvedValue([]);
    await expect(describeDefaultAgentJudgeModel()).resolves.toEqual({ error: expect.stringContaining('no credentialed model') });
  });
});

describe('evaluateWithPiAgenticTrace — records the underlying LLM on every verdict', () => {
  const OLD_ENV = process.env[AGENT_JUDGE_MODEL_ENV];
  const OLD_DEBUG = process.env.AH_JUDGE_DEBUG;
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env[AGENT_JUDGE_MODEL_ENV];
    process.env.AWS_REGION = 'us-west-2';
    // Prove the identity is recorded WITHOUT the debug flag — that gap is the bug.
    process.env.AH_JUDGE_DEBUG = '0';
    mockGetAvailable.mockResolvedValue(LIVE_LIKE_REGISTRY);
  });
  afterAll(() => {
    if (OLD_ENV === undefined) delete process.env[AGENT_JUDGE_MODEL_ENV]; else process.env[AGENT_JUDGE_MODEL_ENV] = OLD_ENV;
    if (OLD_DEBUG === undefined) delete process.env.AH_JUDGE_DEBUG; else process.env.AH_JUDGE_DEBUG = OLD_DEBUG;
  });

  const request = {
    trajectory: [{ type: 'response', content: 'Root cause: disk full.' }] as any,
    expectedOutcomes: ['identifies the root cause'],
    runId: 'run-1',
    modelId: 'agent-trace-judge',
  };
  const verdict = JSON.stringify({ pass_fail_status: 'passed', accuracy: 90, reasoning: 'ok', metrics: { faithfulness: 90, latency_score: 90, trajectory_alignment_score: 90 } });

  it('judgeModel = provider-qualified model the transcript reports; judgeProvider = agent; judgeDebug stays off', async () => {
    mockSessionMessages = [
      { role: 'assistant', provider: 'amazon-bedrock', model: 'global.anthropic.claude-sonnet-4-5-20250929-v1:0', content: [{ type: 'text', text: verdict }] },
    ];
    const res = await evaluateWithPiAgenticTrace(request as any, undefined, true);
    expect(res.passFailStatus).toBe('passed');
    expect(res.judgeModel).toBe('amazon-bedrock/global.anthropic.claude-sonnet-4-5-20250929-v1:0');
    expect(res.judgeProvider).toBe('agent');
    expect(res.judgeMode).toBe('trace-tools');
    expect(res.judgeDebug).toBeUndefined();
  });

  it('falls back to the model we asked for when the transcript carries no model field', async () => {
    mockSessionMessages = [{ role: 'assistant', content: [{ type: 'text', text: verdict }] }];
    const res = await evaluateWithPiAgenticTrace(request as any, undefined, false);
    expect(res.judgeModel).toBe('amazon-bedrock/global.anthropic.claude-sonnet-4-5-20250929-v1:0');
    expect(res.judgeMode).toBe('trajectory-only');
  });

  it('the env pin changes which model runs AND what is recorded', async () => {
    process.env[AGENT_JUDGE_MODEL_ENV] = 'anthropic.claude-sonnet-4-6';
    mockSessionMessages = [{ role: 'assistant', content: [{ type: 'text', text: verdict }] }];
    const res = await evaluateWithPiAgenticTrace(request as any, undefined, true);
    expect(res.judgeModel).toBe('amazon-bedrock/us.anthropic.claude-sonnet-4-6');
  });

  it('the saved evaluator pin (inferenceConfig.agentJudgeModelId) wins over the env pin', async () => {
    process.env[AGENT_JUDGE_MODEL_ENV] = 'anthropic.claude-sonnet-4-6';
    mockSessionMessages = [{ role: 'assistant', content: [{ type: 'text', text: verdict }] }];
    const evaluator = { id: 'ev', name: 'ev', systemPrompt: '', inferenceConfig: { provider: 'agent', agentJudgeModelId: 'anthropic.claude-opus-4-6-v1' } } as any;
    const res = await evaluateWithPiAgenticTrace(request as any, evaluator, true);
    expect(res.judgeModel).toBe('amazon-bedrock/us.anthropic.claude-opus-4-6-v1');
  });

  it('throws the actionable no-model error when the registry is empty', async () => {
    mockGetAvailable.mockResolvedValue([]);
    await expect(evaluateWithPiAgenticTrace(request as any, undefined, true)).rejects.toThrow(/no model available/);
  });
});
