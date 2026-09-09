/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * evaluateWithPiAgenticTrace — wiring contract against the pi SDK surface
 * (>= 0.80.8): `ModelRuntime.create()` → `getAvailable()` →
 * `createAgentSession({ model, modelRuntime, tools, ... })`.
 *
 * The SDK is an optional, dynamically imported dependency, so it is mocked
 * here as a virtual module (the same pattern as comparisonDeepDiveService's
 * tests). The REAL-package contract lives in
 * tests/integration/optionalDeps/optionalDepsContract.integration.test.ts;
 * this suite pins what OUR side hands to the SDK — which options, which tools,
 * how the model is chosen — so a wiring regression fails loudly here.
 */

import type { TrajectoryStep } from '@/types';

const mockModelUs = { provider: 'amazon-bedrock', id: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0' };
const mockModelOther = { provider: 'amazon-bedrock', id: 'amazon.nova-lite-v1:0' };

const verdict = JSON.stringify({
  pass_fail_status: 'passed',
  metrics: { accuracy: 91 },
  reasoning: 'trace shows the expected tool was called',
});

const trajectory: TrajectoryStep[] = [
  { id: 's1', timestamp: 1, type: 'action', content: '{}', toolName: 'search_logs', toolArgs: {} } as TrajectoryStep,
  { id: 's2', timestamp: 2, type: 'response', content: 'done' } as TrajectoryStep,
];

describe('evaluateWithPiAgenticTrace — pi SDK wiring (ModelRuntime era)', () => {
  let createAgentSession: jest.Mock;
  let modelRuntimeCreate: jest.Mock;
  let getAvailable: jest.Mock;
  let resourceLoaderOpts: any;
  let prompted: string | undefined;

  beforeEach(() => {
    jest.resetModules();
    resourceLoaderOpts = undefined;
    prompted = undefined;
    getAvailable = jest.fn(async () => [mockModelOther, mockModelUs]);
    modelRuntimeCreate = jest.fn(async () => ({ getAvailable }));
    createAgentSession = jest.fn(async () => ({
      session: {
        prompt: jest.fn(async (p: string) => { prompted = p; }),
        messages: [{ role: 'assistant', content: [{ type: 'text', text: verdict }] }],
      },
    }));
    jest.doMock(
      '@earendil-works/pi-coding-agent',
      () => ({
        createAgentSession,
        SessionManager: { inMemory: jest.fn(() => ({ kind: 'in-memory' })) },
        ModelRuntime: { create: modelRuntimeCreate },
        DefaultResourceLoader: jest.fn().mockImplementation((opts: any) => {
          resourceLoaderOpts = opts;
          return { reload: jest.fn(async () => {}) };
        }),
        getAgentDir: jest.fn(() => '/tmp/mock-agent-dir'),
      }),
      { virtual: true }
    );
    jest.doMock('@/lib/debug', () => ({ debug: jest.fn() }));
  });

  afterEach(() => {
    jest.dontMock('@earendil-works/pi-coding-agent');
    jest.dontMock('@/lib/debug');
  });

  it('creates ONE ModelRuntime, picks the requested model from getAvailable(), and passes the runtime (not authStorage/modelRegistry) to createAgentSession', async () => {
    const { evaluateWithPiAgenticTrace } = require('@/server/services/piAgenticJudgeService');
    const res = await evaluateWithPiAgenticTrace(
      { trajectory, expectedTrajectory: [], expectedOutcomes: ['calls search_logs'], runId: 'run-1', modelId: mockModelUs.id },
      undefined,
      true
    );

    expect(modelRuntimeCreate).toHaveBeenCalledTimes(1);
    expect(getAvailable).toHaveBeenCalledTimes(1);
    expect(createAgentSession).toHaveBeenCalledTimes(1);
    const opts = createAgentSession.mock.calls[0][0];
    expect(opts.model).toEqual(mockModelUs);
    // The runtime object returned by ModelRuntime.create() is what the session gets.
    expect(opts.modelRuntime).toEqual({ getAvailable });
    expect(opts).not.toHaveProperty('authStorage');
    expect(opts).not.toHaveProperty('modelRegistry');
    // Core scoping guarantee: only the two run-scoped trace tools, no built-ins.
    expect(opts.tools).toEqual(['query_spans', 'query_logs']);
    expect(opts.sessionManager).toEqual({ kind: 'in-memory' });
    expect(opts.resourceLoader).toBeDefined();
    expect(resourceLoaderOpts.noExtensions).toBe(true);
    expect(resourceLoaderOpts.extensionFactories).toHaveLength(1);

    expect(prompted).toContain('search_logs');
    expect(res.passFailStatus).toBe('passed');
    expect(res.judgeMode).toBe('trace-tools');
    expect(res.improvementStrategies).toEqual([]);
  });

  it('trajectory-only mode disables ALL tools and registers no trace extension', async () => {
    const { evaluateWithPiAgenticTrace } = require('@/server/services/piAgenticJudgeService');
    const res = await evaluateWithPiAgenticTrace(
      { trajectory, expectedTrajectory: [], modelId: mockModelUs.id },
      undefined,
      false
    );
    const opts = createAgentSession.mock.calls[0][0];
    expect(opts.tools).toEqual([]);
    expect(resourceLoaderOpts.extensionFactories).toEqual([]);
    expect(res.judgeMode).toBe('trajectory-only');
  });

  it('throws an actionable error when the runtime reports no available models', async () => {
    getAvailable.mockResolvedValueOnce([]);
    const { evaluateWithPiAgenticTrace } = require('@/server/services/piAgenticJudgeService');
    await expect(
      evaluateWithPiAgenticTrace({ trajectory, expectedTrajectory: [], runId: 'run-1' }, undefined, true)
    ).rejects.toThrow(/no model available/);
    expect(createAgentSession).not.toHaveBeenCalled();
  });

  it('surfaces a clear error (not a raw module-not-found) when the optional SDK is absent', async () => {
    jest.dontMock('@earendil-works/pi-coding-agent');
    jest.resetModules();
    jest.doMock(
      '@earendil-works/pi-coding-agent',
      () => { throw new Error("Cannot find module '@earendil-works/pi-coding-agent'"); },
      { virtual: true }
    );
    const { evaluateWithPiAgenticTrace } = require('@/server/services/piAgenticJudgeService');
    await expect(
      evaluateWithPiAgenticTrace({ trajectory, expectedTrajectory: [], runId: 'run-1' }, undefined, true)
    ).rejects.toThrow(/requires the optional dependency "@earendil-works\/pi-coding-agent"/);
  });
});
