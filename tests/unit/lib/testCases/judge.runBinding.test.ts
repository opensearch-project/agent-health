/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `createRunJudgeBinding(defaults)` — precedence matrix.
 *
 * The runners bind the `judge` fixture to the run-level evaluator + judge
 * model as AUTHORITATIVE so the person who launched the run (UI / API / CLI)
 * always wins over pins an eval-file author hard-coded into a body. Pre-fix
 * the body's per-call `{ evaluatorId, model }` won the request while the
 * report was still labelled with the run's selection — verdict from one
 * judge, label from another.
 *
 *   run-level set + body pin (differs)  → run wins, conflict recorded
 *   run-level set + body pin (same)     → run value, NO conflict
 *   run-level absent + body pin         → body wins, no conflict, source 'body'
 *   run-level absent + divergent pins   → no single value, source 'mixed'
 *   neither                             → default (server resolves), source 'default'
 *   non-selection options (skip/serverUrl) → per-call still wins
 *   plain bindJudge(defaults)           → per-call wins (SDK-user semantics unchanged)
 */

import { judge, bindJudge, createRunJudgeBinding, clearJudgeCache } from '@/lib/testCases/judge';
import { startSession, endSession } from '@/lib/matchers/session';

type JsonBody = { modelId?: string; evaluatorId?: string; expectedOutcomes?: string[] };

function mockJudgeFetch() {
  const fetchMock = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ passFailStatus: 'passed', metrics: { accuracy: 90 }, llmJudgeReasoning: 'ok' }),
    text: async () => '',
  });
  (global as any).fetch = fetchMock as unknown as typeof fetch;
  const bodies = (): JsonBody[] =>
    fetchMock.mock.calls.map((c: any[]) => JSON.parse((c[1] as RequestInit).body as string) as JsonBody);
  const lastBody = (): JsonBody => {
    const all = bodies();
    if (all.length === 0) throw new Error('fetch was not called');
    return all[all.length - 1];
  };
  return { fetchMock, lastBody, bodies };
}

// Distinct trajectories per call so the content-addressed verdict cache never
// short-circuits a call we want to observe on the wire.
let n = 0;
const result = () => ({ trajectory: [{ type: 'response', content: `r${++n}` }] } as any);

describe('createRunJudgeBinding — authoritative run-level selection', () => {
  beforeEach(() => {
    startSession();
    clearJudgeCache();
    process.env.AH_JUDGE_RETRY_BACKOFF_MS = '0';
  });
  afterEach(() => {
    endSession();
    jest.restoreAllMocks();
    delete process.env.AH_JUDGE_RETRY_BACKOFF_MS;
  });

  it('run-level evaluatorId + model WIN over a differing body pin, and both conflicts are recorded', async () => {
    const { lastBody } = mockJudgeFetch();
    const bound = createRunJudgeBinding({ evaluatorId: 'system-rca-default', model: 'demo-model', serverUrl: 'http://localhost:1' });

    await bound.judge(result(), 'claim', { evaluatorId: 'system-factuality', model: 'some-other-model' });

    const body = lastBody();
    expect(body.evaluatorId).toBe('system-rca-default');
    expect(body.modelId).toBe('demo-model');

    const { applied, conflicts, judgeCalls } = bound.snapshot();
    expect(judgeCalls).toBe(1);
    expect(applied).toEqual({
      evaluatorId: 'system-rca-default',
      evaluatorIdSource: 'run',
      modelId: 'demo-model',
      modelIdSource: 'run',
    });
    expect(conflicts).toEqual(
      expect.arrayContaining([
        { field: 'evaluatorId', runValue: 'system-rca-default', bodyValue: 'system-factuality' },
        { field: 'modelId', runValue: 'demo-model', bodyValue: 'some-other-model' },
      ]),
    );
    expect(conflicts).toHaveLength(2);
  });

  it('a body pin EQUAL to the run selection is not a conflict', async () => {
    mockJudgeFetch();
    const bound = createRunJudgeBinding({ evaluatorId: 'system-rca-default' });
    await bound.judge(result(), 'claim', { evaluatorId: 'system-rca-default' });
    expect(bound.snapshot().conflicts).toEqual([]);
    expect(bound.snapshot().applied.evaluatorIdSource).toBe('run');
  });

  it('conflicts are deduped per (field, bodyValue) across repeated calls', async () => {
    mockJudgeFetch();
    const bound = createRunJudgeBinding({ evaluatorId: 'system-rca-default' });
    await bound.judge(result(), 'c1', { evaluatorId: 'system-factuality' });
    await bound.judge(result(), 'c2', { evaluatorId: 'system-factuality' });
    await bound.judge.observe(result(), 'c3', { evaluatorId: 'system-safety' });
    expect(bound.snapshot().conflicts).toEqual([
      { field: 'evaluatorId', runValue: 'system-rca-default', bodyValue: 'system-factuality' },
      { field: 'evaluatorId', runValue: 'system-rca-default', bodyValue: 'system-safety' },
    ]);
    expect(bound.snapshot().judgeCalls).toBe(3);
  });

  it('run-level ABSENT for a field → the body pin applies for that field, no conflict, source "body"', async () => {
    const { lastBody } = mockJudgeFetch();
    // Run picked an evaluator but no judge model; body pins a model.
    const bound = createRunJudgeBinding({ evaluatorId: 'system-rca-default' });

    await bound.judge(result(), 'claim', { model: 'claude-opus-4' });

    const body = lastBody();
    expect(body.evaluatorId).toBe('system-rca-default');
    expect(body.modelId).toBe('claude-opus-4');
    expect(bound.snapshot().conflicts).toEqual([]);
    expect(bound.snapshot().applied).toEqual({
      evaluatorId: 'system-rca-default',
      evaluatorIdSource: 'run',
      modelId: 'claude-opus-4',
      modelIdSource: 'body',
    });
  });

  it('neither run-level nor body → nothing sent, source "default" (server resolves its default)', async () => {
    const { lastBody } = mockJudgeFetch();
    const bound = createRunJudgeBinding({ serverUrl: 'http://localhost:1' });
    await bound.judge(result(), 'claim');
    const body = lastBody();
    expect('evaluatorId' in body).toBe(false);
    expect('modelId' in body).toBe(false);
    expect(bound.snapshot().applied).toEqual({
      evaluatorId: undefined,
      evaluatorIdSource: 'default',
      modelId: undefined,
      modelIdSource: 'default',
    });
  });

  it('run binding with NO defaults is still a tracking wrapper (not the unbound judge)', async () => {
    mockJudgeFetch();
    const bound = createRunJudgeBinding();
    expect(bound.judge).not.toBe(judge);
    await bound.judge(result(), 'claim', { evaluatorId: 'system-factuality' });
    expect(bound.snapshot().applied.evaluatorId).toBe('system-factuality');
    expect(bound.snapshot().applied.evaluatorIdSource).toBe('body');
  });

  it('divergent body pins with no run-level selection → applied value omitted, source "mixed" (per-call truth on matcherResults)', async () => {
    mockJudgeFetch();
    const bound = createRunJudgeBinding({});
    await bound.judge(result(), 'c1', { evaluatorId: 'system-factuality' });
    await bound.judge(result(), 'c2', { evaluatorId: 'system-safety' });
    expect(bound.snapshot().applied.evaluatorId).toBeUndefined();
    expect(bound.snapshot().applied.evaluatorIdSource).toBe('mixed');
    expect(bound.snapshot().conflicts).toEqual([]);
  });

  it('non-selection per-call options (skip, serverUrl) still win under an authoritative binding', async () => {
    const { fetchMock } = mockJudgeFetch();
    const bound = createRunJudgeBinding({ evaluatorId: 'system-rca-default', serverUrl: 'http://localhost:1', skip: false });
    // skip: true per call → no HTTP call at all
    const v = await bound.judge(result(), 'claim', { skip: true });
    expect(v.skipped).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    // serverUrl per call → request goes to the body's URL
    await bound.judge(result(), 'claim-2', { serverUrl: 'http://localhost:2' });
    expect(String(fetchMock.mock.calls[0][0])).toContain('http://localhost:2/api/judge');
  });

  it('before any call, `selection.applied` reports what WOULD apply and judgeCalls = 0', () => {
    const bound = createRunJudgeBinding({ evaluatorId: 'system-rca-default', model: 'demo-model' });
    expect(bound.snapshot()).toEqual({
      applied: { evaluatorId: 'system-rca-default', evaluatorIdSource: 'run', modelId: 'demo-model', modelIdSource: 'run' },
      conflicts: [],
      judgeCalls: 0,
    });
  });

  it('records the applied evaluatorId on the per-call MatcherResult (per-call truth)', async () => {
    mockJudgeFetch();
    const { endSession: end, startSession: start } = await import('@/lib/matchers/session');
    end(); start();
    const bound = createRunJudgeBinding({ evaluatorId: 'system-rca-default', model: 'demo-model' });
    await bound.judge(result(), 'claim', { evaluatorId: 'system-factuality' });
    const results = end();
    start(); // keep afterEach's endSession balanced
    const llm = results.filter(r => r.method === 'llm-judge');
    expect(llm).toHaveLength(1);
    expect(llm[0].evaluatorId).toBe('system-rca-default');
    expect(llm[0].model).toBe('demo-model');
  });
});

describe('bindJudge — plain (non-authoritative) semantics are unchanged', () => {
  beforeEach(() => {
    startSession();
    clearJudgeCache();
    process.env.AH_JUDGE_RETRY_BACKOFF_MS = '0';
  });
  afterEach(() => {
    endSession();
    jest.restoreAllMocks();
    delete process.env.AH_JUDGE_RETRY_BACKOFF_MS;
  });

  it('per-call pins still win and are NOT recorded as conflicts', async () => {
    const { lastBody } = mockJudgeFetch();
    const bound = bindJudge({ evaluatorId: 'system-rca-default', model: 'demo-model' });
    await bound(result(), 'claim', { evaluatorId: 'system-factuality', model: 'claude-opus-4' });
    const body = lastBody();
    expect(body.evaluatorId).toBe('system-factuality');
    expect(body.modelId).toBe('claude-opus-4');
    // A plain binding carries no selection telemetry at all — that is a
    // runner concern (createRunJudgeBinding), not SDK surface.
    expect((bound as any).snapshot).toBeUndefined();
    expect((bound as any).selection).toBeUndefined();
  });

  it('bindJudge(undefined) / bindJudge({}) still short-circuit to the unbound judge', () => {
    expect(bindJudge(undefined)).toBe(judge);
    expect(bindJudge({})).toBe(judge);
  });
});
