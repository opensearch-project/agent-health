/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * GET /api/judge/models — the judge-model catalog annotated with the LLM each
 * entry ACTUALLY judges with. For `provider: 'agent'` entries (whose
 * `model_id` is the provider name `agent-trace-judge`) the route resolves the
 * underlying model via the pi registry and reports `resolvedModel` /
 * `resolvedSource` / `pinEnv`; plain entries pass through unchanged.
 *
 * Also pins that POST /api/judge forwards the provider's `judgeModel` /
 * `judgeProvider` untouched (the persistence layer relies on it) and that
 * the demo provider labels its verdict honestly.
 */

import express from 'express';
import request from 'supertest';

const mockDescribe = jest.fn();
const mockEvaluateWithPiAgenticTrace = jest.fn();
jest.mock('@/server/services/piAgenticJudgeService', () => ({
  evaluateWithPiAgenticTrace: (...args: any[]) => mockEvaluateWithPiAgenticTrace(...args),
  describeDefaultAgentJudgeModel: () => mockDescribe(),
  AGENT_JUDGE_MODEL_ENV: 'AH_AGENT_JUDGE_MODEL_ID',
}));

const mockEvaluateTrajectory = jest.fn();
jest.mock('@/server/services/bedrockService', () => ({
  evaluateTrajectory: (...args: any[]) => mockEvaluateTrajectory(...args),
  parseBedrockError: (e: Error) => e.message,
}));

const mockLoadConfigSync = jest.fn();
jest.mock('@/lib/config/index', () => ({
  loadConfigSync: () => mockLoadConfigSync(),
}));

jest.mock('@/server/adapters', () => ({
  getStorageModule: () => ({ evaluators: { getById: jest.fn().mockResolvedValue(null) } }),
}));
jest.mock('@/lib/debug', () => ({ debug: jest.fn() }));

import judgeRoutes from '@/server/routes/judge';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(judgeRoutes);
  return app;
}

const CATALOG = {
  models: {
    'claude-sonnet-4.6': { model_id: 'us.anthropic.claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6', provider: 'bedrock' },
    'agent-trace-judge': { model_id: 'agent-trace-judge', display_name: 'Agent Trace Judge (pi SDK + query_spans)', provider: 'agent' },
    'demo-model': { model_id: 'mock://demo-model', display_name: 'Demo', provider: 'demo' },
  },
  judge: {},
};

describe('GET /api/judge/models', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadConfigSync.mockReturnValue(CATALOG);
  });

  it('annotates agent-judge entries with the resolved underlying model, source and pin env; plain entries untouched', async () => {
    mockDescribe.mockResolvedValue({
      id: 'amazon-bedrock/global.anthropic.claude-sonnet-4-5-20250929-v1:0',
      name: 'Claude Sonnet 4.5 (Global)',
      source: 'auto',
    });
    const res = await request(buildApp()).get('/api/judge/models');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    const byKey = Object.fromEntries(res.body.models.map((m: any) => [m.key, m]));
    expect(byKey['agent-trace-judge']).toMatchObject({
      key: 'agent-trace-judge',
      model_id: 'agent-trace-judge',
      provider: 'agent',
      resolvedModel: 'amazon-bedrock/global.anthropic.claude-sonnet-4-5-20250929-v1:0',
      resolvedModelName: 'Claude Sonnet 4.5 (Global)',
      resolvedSource: 'auto',
      pinEnv: 'AH_AGENT_JUDGE_MODEL_ID',
    });
    expect(byKey['claude-sonnet-4.6']).toEqual({
      key: 'claude-sonnet-4.6', model_id: 'us.anthropic.claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6', provider: 'bedrock',
    });
    expect(byKey['claude-sonnet-4.6'].resolvedModel).toBeUndefined();
    expect(mockDescribe).toHaveBeenCalledTimes(1);
  });

  it('still returns the catalog (200) with resolveError when resolution fails (pi SDK missing / no creds)', async () => {
    mockDescribe.mockResolvedValue({ error: 'no credentialed model in the pi registry' });
    const res = await request(buildApp()).get('/api/judge/models');
    expect(res.status).toBe(200);
    const agent = res.body.models.find((m: any) => m.key === 'agent-trace-judge');
    expect(agent.resolvedModel).toBeUndefined();
    expect(agent.resolveError).toBe('no credentialed model in the pi registry');
    expect(agent.pinEnv).toBe('AH_AGENT_JUDGE_MODEL_ID');
  });

  it('does not touch the pi registry at all when no agent-judge entry is configured', async () => {
    mockLoadConfigSync.mockReturnValue({ models: { 'claude-sonnet-4.6': CATALOG.models['claude-sonnet-4.6'] }, judge: {} });
    const res = await request(buildApp()).get('/api/judge/models');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(mockDescribe).not.toHaveBeenCalled();
  });
});

describe('POST /api/judge — forwards judge identity from the provider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadConfigSync.mockReturnValue(CATALOG);
  });

  it('bedrock: judgeModel/judgeProvider from evaluateTrajectory reach the response body', async () => {
    mockEvaluateTrajectory.mockResolvedValue({
      passFailStatus: 'passed', metrics: { accuracy: 90 }, llmJudgeReasoning: 'ok', improvementStrategies: [],
      judgeModel: 'us.anthropic.claude-sonnet-4-6', judgeProvider: 'bedrock',
    });
    const res = await request(buildApp()).post('/api/judge').send({
      trajectory: [{ type: 'response', content: 'x' }], expectedOutcomes: ['y'], modelId: 'claude-sonnet-4.6',
    });
    expect(res.status).toBe(200);
    expect(res.body.judgeModel).toBe('us.anthropic.claude-sonnet-4-6');
    expect(res.body.judgeProvider).toBe('bedrock');
  });

  it('demo: labels the mock verdict with judgeProvider=demo (never an LLM id)', async () => {
    const res = await request(buildApp()).post('/api/judge').send({
      trajectory: [{ type: 'response', content: 'x' }], expectedOutcomes: ['y'], modelId: 'demo-model',
    });
    expect(res.status).toBe(200);
    expect(res.body.judgeProvider).toBe('demo');
    expect(res.body.judgeModel).toBe('mock://demo-model');
    expect(res.body.warning).toContain('MOCK_JUDGE');
  });
});
