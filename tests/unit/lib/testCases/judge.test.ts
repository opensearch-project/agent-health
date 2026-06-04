/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for `judge()` and `bindJudge()` in lib/testCases/judge.ts.
 *
 * Coverage focuses on the contract that makes SDK runs match the UI:
 *
 *   1. Per-call `evaluatorId` lands on the /api/judge POST body verbatim.
 *   2. `bindJudge({ evaluatorId })` injects the evaluator into every call
 *      that doesn't override it, so destructured fixture-style usage
 *      (`async ({ judge }) => ...`) inherits the run-level evaluator.
 *   3. Per-call options always win over bound defaults (model, evaluatorId).
 *   4. `bindJudge(undefined)` and `bindJudge({})` short-circuit to the
 *      unbound `judge` (zero overhead path).
 *   5. The legacy form `judge(trajectory, [claims])` keeps working.
 *
 * We mock global.fetch and inspect the request body — the server side
 * already has its own coverage of evaluator resolution, so we don't
 * exercise that here.
 */

import { judge, bindJudge } from '@/lib/testCases/judge';
import { startSession, endSession } from '@/lib/matchers/session';

type JsonBody = {
  trajectory?: unknown[];
  expectedOutcomes?: string[];
  expectedTrajectory?: unknown[];
  modelId?: string;
  evaluatorId?: string;
};

function mockJudgeFetch(verdict: { passFailStatus: 'passed' | 'failed'; metrics?: any; reasoning?: string } = { passFailStatus: 'passed' }): {
  fetchMock: jest.Mock;
  lastBody: () => JsonBody;
} {
  const fetchMock = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      passFailStatus: verdict.passFailStatus,
      metrics: verdict.metrics ?? { accuracy: 95 },
      llmJudgeReasoning: verdict.reasoning ?? '',
    }),
    text: async () => '',
  });
  // Cast through unknown — Node's global fetch type and jest.Mock don't
  // line up cleanly without a deeper shim, but the surface judge() uses
  // (a Promise of { ok, status, json() }) is fully covered by the mock.
  (global as any).fetch = fetchMock as unknown as typeof fetch;

  const lastBody = (): JsonBody => {
    const calls = fetchMock.mock.calls;
    if (calls.length === 0) throw new Error('fetch was not called');
    const init = calls[calls.length - 1][1] as RequestInit;
    return JSON.parse(init.body as string) as JsonBody;
  };

  return { fetchMock, lastBody };
}

describe('judge() — per-call options', () => {
  beforeEach(() => {
    startSession();
  });
  afterEach(() => {
    endSession();
    jest.restoreAllMocks();
  });

  it('forwards evaluatorId on the /api/judge POST body when set', async () => {
    const { lastBody } = mockJudgeFetch();
    const result = { trajectory: [{ type: 'response', content: 'ok' }] } as any;

    await judge(result, 'identifies the issue', { evaluatorId: 'system:cp-oncall' });

    expect(lastBody().evaluatorId).toBe('system:cp-oncall');
  });

  it('omits evaluatorId from the body when not set (server default applies)', async () => {
    const { lastBody } = mockJudgeFetch();
    await judge({ trajectory: [{ type: 'response', content: 'ok' }] } as any, 'claim');

    const body = lastBody();
    expect('evaluatorId' in body).toBe(false);
  });

  it('forwards model as modelId on the body when set', async () => {
    const { lastBody } = mockJudgeFetch();
    await judge({ trajectory: [{ type: 'response', content: 'ok' }] } as any, 'claim', {
      model: 'claude-opus-4',
    });

    expect(lastBody().modelId).toBe('claude-opus-4');
  });

  it('accepts the legacy form judge(trajectory, [claims])', async () => {
    const { lastBody } = mockJudgeFetch();
    const trajectory = [{ type: 'response', content: 'final' }] as any[];

    await judge(trajectory, ['c1', 'c2']);

    const body = lastBody();
    expect(body.trajectory).toEqual(trajectory);
    expect(body.expectedOutcomes).toEqual(['c1', 'c2']);
  });

  it('throws on judge "failed" verdict and records a failed MatcherResult', async () => {
    mockJudgeFetch({ passFailStatus: 'failed', metrics: { accuracy: 30 }, reasoning: 'missed key fact' });

    await expect(
      judge({ trajectory: [{ type: 'response', content: 'x' }] } as any, 'claim'),
    ).rejects.toThrow(/FAILED.*accuracy: 30/s);
  });
});

describe('bindJudge() — run-level defaults (UI-equivalent)', () => {
  beforeEach(() => {
    startSession();
  });
  afterEach(() => {
    endSession();
    jest.restoreAllMocks();
  });

  it('injects evaluatorId into every call when no per-call override is given', async () => {
    const { lastBody } = mockJudgeFetch();
    const bound = bindJudge({ evaluatorId: 'system:cp-oncall' });

    await bound({ trajectory: [{ type: 'response', content: 'a' }] } as any, 'c1');
    await bound({ trajectory: [{ type: 'response', content: 'b' }] } as any, 'c2');

    expect(lastBody().evaluatorId).toBe('system:cp-oncall');
  });

  it('per-call evaluatorId wins over bound default', async () => {
    const { lastBody } = mockJudgeFetch();
    const bound = bindJudge({ evaluatorId: 'system:cp-oncall' });

    await bound({ trajectory: [{ type: 'response', content: 'x' }] } as any, 'claim', {
      evaluatorId: 'user:custom-eval',
    });

    expect(lastBody().evaluatorId).toBe('user:custom-eval');
  });

  it('per-call model wins over bound model', async () => {
    const { lastBody } = mockJudgeFetch();
    const bound = bindJudge({ model: 'claude-sonnet-4', evaluatorId: 'system:rca' });

    await bound({ trajectory: [{ type: 'response', content: 'x' }] } as any, 'claim', {
      model: 'claude-opus-4',
    });

    const body = lastBody();
    expect(body.modelId).toBe('claude-opus-4');
    // Unrelated bound default (evaluatorId) survives.
    expect(body.evaluatorId).toBe('system:rca');
  });

  it('omits evaluatorId from the body when nothing is bound and no per-call override', async () => {
    const { lastBody } = mockJudgeFetch();
    const bound = bindJudge({ model: 'claude-sonnet-4' });

    await bound({ trajectory: [{ type: 'response', content: 'x' }] } as any, 'claim');

    expect('evaluatorId' in lastBody()).toBe(false);
  });

  it('returns the unbound judge when given undefined (zero-overhead path)', () => {
    expect(bindJudge(undefined)).toBe(judge);
    expect(bindJudge({})).toBe(judge);
    expect(bindJudge({ evaluatorId: undefined, model: undefined, serverUrl: undefined })).toBe(judge);
  });

  it('explicit per-call undefined falls through to bound default (does not clear it)', async () => {
    const { lastBody } = mockJudgeFetch();
    const bound = bindJudge({ evaluatorId: 'system:cp-oncall' });

    // Caller passes `{ model: 'foo' }` and forgets to repeat evaluatorId —
    // the run-level default must survive. This is the "destructure judge
    // and just pass an extra option per call" ergonomics that makes SDK
    // behaviour match UI behaviour.
    await bound({ trajectory: [{ type: 'response', content: 'x' }] } as any, 'claim', {
      model: 'claude-opus-4',
    });

    const body = lastBody();
    expect(body.evaluatorId).toBe('system:cp-oncall');
    expect(body.modelId).toBe('claude-opus-4');
  });
});
