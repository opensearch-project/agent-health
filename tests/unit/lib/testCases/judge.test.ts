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

import { judge, bindJudge, clearJudgeCache } from '@/lib/testCases/judge';
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
    clearJudgeCache();
    process.env.AH_JUDGE_RETRY_BACKOFF_MS = '0'; // no real delay between retries in tests
  });
  afterEach(() => {
    endSession();
    jest.restoreAllMocks();
    delete process.env.AH_JUDGE_RETRY_BACKOFF_MS;
  });

  it('forwards evaluatorId on the /api/judge POST body when set', async () => {
    const { lastBody } = mockJudgeFetch();
    const result = { trajectory: [{ type: 'response', content: 'ok' }] } as any;

    await judge(result, 'identifies the issue', { evaluatorId: 'system-rca-default' });

    expect(lastBody().evaluatorId).toBe('system-rca-default');
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

  it('forwards result.runId on the body when the result carries one', async () => {
    const { lastBody } = mockJudgeFetch();
    await judge({ trajectory: [{ type: 'response', content: 'ok' }], runId: 'agent-run-99' } as any, 'claim');
    expect((lastBody() as any).runId).toBe('agent-run-99');
  });

  it('omits runId from the body for the legacy trajectory-array form', async () => {
    const { lastBody } = mockJudgeFetch();
    await judge([{ type: 'response', content: 'ok' }] as any, 'claim');
    expect('runId' in (lastBody() as any)).toBe(false);
  });

  // SDK↔UI convergence (#264 follow-up): the runner attaches Strategy-C
  // correlation hints to the result as `judgeAgents`; judge() must forward
  // them as `agents` so the agent (trace) judge can find this run's spans in
  // OpenSearch by service-name + window — exactly like the classic
  // `waitForTracesAndJudge` path. Without this, the SDK judge sends only
  // `runId` and misses subprocess agents' spans.
  it('forwards result.judgeAgents on the body as `agents` (SDK↔UI trace parity)', async () => {
    const { lastBody } = mockJudgeFetch();
    const judgeAgents = [{ serviceName: 'claude-code-agent', startedAt: 1000, endedAt: 2000 }];
    await judge(
      { trajectory: [{ type: 'response', content: 'ok' }], runId: 'agent-run-99', judgeAgents } as any,
      'claim',
    );
    const body = lastBody() as any;
    expect(body.agents).toEqual(judgeAgents);
    expect(body.runId).toBe('agent-run-99'); // still forwarded alongside
  });

  it('omits `agents` when the result carries no judgeAgents hints', async () => {
    const { lastBody } = mockJudgeFetch();
    await judge({ trajectory: [{ type: 'response', content: 'ok' }], runId: 'r1' } as any, 'claim');
    expect('agents' in (lastBody() as any)).toBe(false);
  });

  it('omits `agents` for the legacy trajectory-array form', async () => {
    const { lastBody } = mockJudgeFetch();
    await judge([{ type: 'response', content: 'ok' }] as any, 'claim');
    expect('agents' in (lastBody() as any)).toBe(false);
  });

  it('accepts the legacy form judge(trajectory, [claims])', async () => {
    const { lastBody } = mockJudgeFetch();
    const trajectory = [{ type: 'response', content: 'final' }] as any[];

    await judge(trajectory, ['c1', 'c2']);

    const body = lastBody();
    expect(body.trajectory).toEqual(trajectory);
    expect(body.expectedOutcomes).toEqual(['c1', 'c2']);
  });

  it('returns a non-throwing failed verdict and records a failed gate MatcherResult', async () => {
    mockJudgeFetch({ passFailStatus: 'failed', metrics: { accuracy: 30 }, reasoning: 'missed key fact' });

    const verdict = await judge({ trajectory: [{ type: 'response', content: 'x' }] } as any, 'claim');
    expect(verdict.pass).toBe(false);
    expect(verdict.passFailStatus).toBe('failed');
    expect(verdict.accuracy).toBe(30);
    expect(verdict.score).toBeCloseTo(0.3);
    expect(verdict.role).toBe('gate');
    expect(verdict.errored).toBe(false);
  });

  it('verdict.orThrow() throws on a failed verdict, is a no-op on a passing one', async () => {
    mockJudgeFetch({ passFailStatus: 'failed', metrics: { accuracy: 10 }, reasoning: 'nope' });
    const failed = await judge({ trajectory: [{ type: 'response', content: 'x' }] } as any, 'claim');
    expect(() => failed.orThrow()).toThrow(/FAILED.*accuracy: 10/s);

    mockJudgeFetch({ passFailStatus: 'passed', metrics: { accuracy: 99 } });
    clearJudgeCache();
    const passed = await judge({ trajectory: [{ type: 'response', content: 'x' }] } as any, 'claim');
    expect(passed.orThrow()).toBe(passed); // chainable, no throw
  });

  it('judge.observe() records an observe-role verdict (never gates)', async () => {
    mockJudgeFetch({ passFailStatus: 'failed', metrics: { accuracy: 20 }, reasoning: 'meh' });
    const verdict = await judge.observe({ trajectory: [{ type: 'response', content: 'x' }] } as any, 'claim');
    expect(verdict.role).toBe('observe');
    expect(verdict.pass).toBe(false);
  });

  it('returns an errored verdict (not failed) when the judge endpoint errors', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false, status: 500, json: async () => ({}), text: async () => 'boom',
    });
    (global as any).fetch = fetchMock as unknown as typeof fetch;

    const verdict = await judge({ trajectory: [{ type: 'response', content: 'x' }] } as any, 'claim');
    expect(verdict.errored).toBe(true);
    expect(verdict.pass).toBe(false);
    expect(verdict.errorMessage).toMatch(/Judge HTTP 500: boom/);
    // orThrow surfaces the error too.
    expect(() => verdict.orThrow()).toThrow(/errored/);
  });

  // Resilience: the agentic (trace) judge can transiently drop the loopback
  // connection under load. A single `fetch failed` must NOT error the run.
  it('retries a transient `fetch failed` and succeeds (no errored verdict)', async () => {
    const okResp = {
      ok: true, status: 200,
      json: async () => ({ passFailStatus: 'passed', metrics: { accuracy: 88 }, llmJudgeReasoning: 'ok' }),
      text: async () => '',
    };
    const fetchMock = jest.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValue(okResp);
    (global as any).fetch = fetchMock as unknown as typeof fetch;

    const verdict = await judge({ trajectory: [{ type: 'response', content: 'x' }] } as any, 'claim');
    expect(fetchMock).toHaveBeenCalledTimes(2); // 1 transient failure + 1 success
    expect(verdict.errored).toBe(false);
    expect(verdict.pass).toBe(true);
  });

  it('records errored only after exhausting retries on a persistent `fetch failed`', async () => {
    const fetchMock = jest.fn().mockRejectedValue(new TypeError('fetch failed'));
    (global as any).fetch = fetchMock as unknown as typeof fetch;

    const verdict = await judge({ trajectory: [{ type: 'response', content: 'x' }] } as any, 'claim');
    expect(fetchMock).toHaveBeenCalledTimes(3); // MAX_JUDGE_ATTEMPTS
    expect(verdict.errored).toBe(true);
    expect(verdict.errorMessage).toMatch(/after 3 attempts/);
    expect(verdict.errorMessage).toMatch(/fetch failed/);
  });

  it('skip option returns a non-gating skipped verdict and makes no HTTP call', async () => {
    const { fetchMock } = mockJudgeFetch();
    const verdict = await judge(
      { trajectory: [{ type: 'response', content: 'x' }] } as any,
      'claim',
      { skip: true },
    );
    expect(verdict.skipped).toBe(true);
    expect(verdict.pass).toBe(true); // never gates
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('AH_SKIP_JUDGE=1 env forces skip for every judge call', async () => {
    const prev = process.env.AH_SKIP_JUDGE;
    process.env.AH_SKIP_JUDGE = '1';
    try {
      const { fetchMock } = mockJudgeFetch();
      const verdict = await judge({ trajectory: [{ type: 'response', content: 'x' }] } as any, 'claim');
      expect(verdict.skipped).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.AH_SKIP_JUDGE;
      else process.env.AH_SKIP_JUDGE = prev;
    }
  });

  it('per-call skip:false overrides AH_SKIP_JUDGE and forces the judge to run (#6 tri-state)', async () => {
    const prev = process.env.AH_SKIP_JUDGE;
    process.env.AH_SKIP_JUDGE = '1';
    try {
      clearJudgeCache();
      const { fetchMock } = mockJudgeFetch({ passFailStatus: 'passed', metrics: { accuracy: 90 } });
      const verdict = await judge({ trajectory: [{ type: 'response', content: 'x' }] } as any, 'claim', { skip: false });
      expect(verdict.skipped).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1); // env did NOT win
    } finally {
      if (prev === undefined) delete process.env.AH_SKIP_JUDGE;
      else process.env.AH_SKIP_JUDGE = prev;
    }
  });

  it('bindJudge({ skip: false }) binds (does not short-circuit to the unbound judge) and forces a run under AH_SKIP_JUDGE', async () => {
    const prev = process.env.AH_SKIP_JUDGE;
    process.env.AH_SKIP_JUDGE = '1';
    try {
      clearJudgeCache();
      const { fetchMock } = mockJudgeFetch({ passFailStatus: 'passed', metrics: { accuracy: 77 } });
      const bound = bindJudge({ skip: false });
      const verdict = await bound({ trajectory: [{ type: 'response', content: 'x' }] } as any, 'claim');
      expect(verdict.skipped).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      if (prev === undefined) delete process.env.AH_SKIP_JUDGE;
      else process.env.AH_SKIP_JUDGE = prev;
    }
  });

  it('caches identical judge inputs — second call hits the cache, no second HTTP call', async () => {
    clearJudgeCache();
    const { fetchMock } = mockJudgeFetch({ passFailStatus: 'passed', metrics: { accuracy: 88 } });
    const traj = [{ type: 'response', content: 'same' }];

    const v1 = await judge({ trajectory: traj } as any, 'claim');
    const v2 = await judge({ trajectory: traj } as any, 'claim');

    expect(v1.accuracy).toBe(88);
    expect(v2.accuracy).toBe(88);
    expect(fetchMock).toHaveBeenCalledTimes(1); // second call served from cache
  });

  it('does not cache across different claims/trajectories', async () => {
    clearJudgeCache();
    const { fetchMock } = mockJudgeFetch();
    await judge({ trajectory: [{ type: 'response', content: 'a' }] } as any, 'claim-1');
    await judge({ trajectory: [{ type: 'response', content: 'b' }] } as any, 'claim-2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('bindJudge() — run-level defaults (UI-equivalent)', () => {
  beforeEach(() => {
    startSession();
    clearJudgeCache();
  });
  afterEach(() => {
    endSession();
    jest.restoreAllMocks();
  });

  it('injects evaluatorId into every call when no per-call override is given', async () => {
    const { lastBody } = mockJudgeFetch();
    const bound = bindJudge({ evaluatorId: 'system-rca-default' });

    await bound({ trajectory: [{ type: 'response', content: 'a' }] } as any, 'c1');
    await bound({ trajectory: [{ type: 'response', content: 'b' }] } as any, 'c2');

    expect(lastBody().evaluatorId).toBe('system-rca-default');
  });

  it('per-call evaluatorId wins over bound default', async () => {
    const { lastBody } = mockJudgeFetch();
    const bound = bindJudge({ evaluatorId: 'system-rca-default' });

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
    const bound = bindJudge({ evaluatorId: 'system-rca-default' });

    // Caller passes `{ model: 'foo' }` and forgets to repeat evaluatorId —
    // the run-level default must survive. This is the "destructure judge
    // and just pass an extra option per call" ergonomics that makes SDK
    // behaviour match UI behaviour.
    await bound({ trajectory: [{ type: 'response', content: 'x' }] } as any, 'claim', {
      model: 'claude-opus-4',
    });

    const body = lastBody();
    expect(body.evaluatorId).toBe('system-rca-default');
    expect(body.modelId).toBe('claude-opus-4');
  });
});

describe('judge() — server URL resolution (port-isolation)', () => {
  const realEnv = { ...process.env };
  let warnSpy: jest.SpyInstance;

  beforeEach(async () => {
    startSession();
    clearJudgeCache();
    // Reset the warn-once latch so each test can observe the warning fire.
    const { __resetJudgePortWarning } = await import('@/lib/testCases/judge');
    __resetJudgePortWarning();
    delete process.env.AH_PORT;
    delete process.env.AGENT_HEALTH_PORT;
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    endSession();
    process.env = { ...realEnv };
    jest.restoreAllMocks();
  });

  /** Pull the URL the judge POSTed to from the fetch mock. */
  function lastUrl(fetchMock: jest.Mock): string {
    const calls = fetchMock.mock.calls;
    return String(calls[calls.length - 1][0]);
  }

  it('warns once and defaults to :4001 when AH_PORT and serverUrl are both unset', async () => {
    const { fetchMock } = mockJudgeFetch();
    const result = { trajectory: [{ type: 'response', content: 'ok' }] } as any;

    await judge(result, 'claim A');
    await judge(result, 'claim B'); // second call must NOT warn again

    expect(lastUrl(fetchMock)).toContain('http://localhost:4001/api/judge');
    // Exactly one warning across both calls (warn-once per process).
    const portWarnings = warnSpy.mock.calls.filter(c =>
      String(c[0]).includes('AH_PORT is not set')
    );
    expect(portWarnings).toHaveLength(1);
  });

  it('does NOT warn when AH_PORT is set, and targets that port', async () => {
    process.env.AH_PORT = '4087';
    const { fetchMock } = mockJudgeFetch();

    await judge({ trajectory: [{ type: 'response', content: 'ok' }] } as any, 'claim');

    expect(lastUrl(fetchMock)).toContain('http://localhost:4087/api/judge');
    const portWarnings = warnSpy.mock.calls.filter(c =>
      String(c[0]).includes('AH_PORT is not set')
    );
    expect(portWarnings).toHaveLength(0);
  });

  it('does NOT warn when an explicit serverUrl is provided, and targets it', async () => {
    const { fetchMock } = mockJudgeFetch();

    await judge({ trajectory: [{ type: 'response', content: 'ok' }] } as any, 'claim', {
      serverUrl: 'http://127.0.0.1:9100',
    });

    expect(lastUrl(fetchMock)).toContain('http://127.0.0.1:9100/api/judge');
    const portWarnings = warnSpy.mock.calls.filter(c =>
      String(c[0]).includes('AH_PORT is not set')
    );
    expect(portWarnings).toHaveLength(0);
  });
});
