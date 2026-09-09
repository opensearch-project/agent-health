/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Agent-error surfacing — the failure-stage additions across the evaluator
 * error patch, the judge retry policy, the parser, and the pi error mapper.
 *
 * Owner incident (a 62-case run against a REST agent): the agent request
 * timed out (undici `fetch failed` / HeadersTimeoutError), the runner
 * persisted an EMPTY report and judged it anyway, the judge model returned an
 * empty turn, `parseJudgeResponse` threw, `parsePiError` rewrote that to
 * "Failed to parse Pi judge response. The CLI may have returned invalid
 * JSON." and `callBedrockJudge` retried TEN times (~8.5 min) per case. The UI
 * ended up saying "evaluator could not run". These tests pin every link of
 * the corrected chain.
 */

import { buildEvaluatorErrorPatch, failureStageForKind } from '@/services/evaluation/evaluatorError';
import { describeAgentError } from '@/services/evaluation/agentFailure';
import { parseJudgeResponse, JudgeParseError, isJudgeParseError } from '@/server/services/judgeResponseParser';
import { parsePiError } from '@/server/services/piJudgeService';
import { callBedrockJudge, PARSE_FAILURE_MAX_ATTEMPTS, judgeErrorDetailFrom } from '@/services/evaluation/bedrockJudge';
import { isJudgeFailedCase, hasRejudgeableOutput } from '@/services/evaluation/retryJudgement';
import { extractJudgeFailureReason } from '@/lib/judgeFailureSummary';
import { getFailureStage, getFailureCause, agentProducedNoOutput, describeAgentErrorKind, formatMs } from '@/lib/reportFailure';
import { copyReportFailureFields, pickReportFailureFields, REPORT_FAILURE_FIELDS } from '@/lib/reportFailureFields';

function undiciHeadersTimeout(): Error {
  const cause = Object.assign(new Error('Headers Timeout Error'), { name: 'HeadersTimeoutError', code: 'UND_ERR_HEADERS_TIMEOUT' });
  return Object.assign(new TypeError('fetch failed'), { cause });
}

describe('buildEvaluatorErrorPatch — failureStage + structured detail', () => {
  it('maps every kind to a stage', () => {
    expect(failureStageForKind('agent_failed')).toBe('agent');
    expect(failureStageForKind('judge_failed')).toBe('judge');
    expect(failureStageForKind('trace_timeout')).toBe('trace');
    expect(failureStageForKind('trace_incomplete')).toBe('trace');
    expect(failureStageForKind('trace_callback_failed')).toBe('trace');
    expect(failureStageForKind('trace_fetch_failed')).toBe('trace');
    expect(failureStageForKind('unknown')).toBe('judge');
  });

  it('agent_failed: stamps failureStage:"agent", the unwrapped cause as `error`, agentError, and agent-stage prose', () => {
    const err = undiciHeadersTimeout();
    const agentError = describeAgentError(err, { endpoint: 'http://localhost:8000/ask', elapsedMs: 300_700, timeoutMs: 300_000 });
    const patch = buildEvaluatorErrorPatch('agent_failed', err, { agentError });
    expect(patch.metricsStatus).toBe('error');
    expect(patch.failureStage).toBe('agent');
    expect(patch.passFailStatus).toBeNull();
    expect(patch.agentError).toEqual(agentError);
    // The recorded cause is the REAL one, not the opaque wrapper.
    expect(patch.error).toMatch(/HeadersTimeoutError/);
    expect(patch.error).not.toBe('fetch failed');
    expect(patch.traceError).toMatch(/^Agent request failed \(kind=agent_failed\): .*HeadersTimeoutError/);
    expect(patch.llmJudgeReasoning).toMatch(/Agent request failed — not judged/);
    expect(patch.llmJudgeReasoning).toMatch(/re-run the case/);
    expect(patch.llmJudgeReasoning).not.toMatch(/Evaluator could not run/);
    expect(patch.judgeError).toBeUndefined();
  });

  it('judge_failed: stamps failureStage:"judge" + judgeError (raw text + attempts) and keeps the evaluator prose', () => {
    const patch = buildEvaluatorErrorPatch('judge_failed', new Error('judge returned no parseable verdict — the model returned an empty response.'), {
      judgeError: { message: 'x', rawResponse: '', attempts: 2 },
    });
    expect(patch.failureStage).toBe('judge');
    expect(patch.judgeError).toEqual({ message: 'x', rawResponse: '', attempts: 2 });
    expect(patch.error).toMatch(/no parseable verdict/);
    expect(patch.llmJudgeReasoning).toMatch(/Evaluator could not run/);
    expect(patch.agentError).toBeUndefined();
  });

  it('trace_* kinds stamp failureStage:"trace" without detail objects', () => {
    const patch = buildEvaluatorErrorPatch('trace_timeout', 'polling exhausted');
    expect(patch.failureStage).toBe('trace');
    expect(patch.error).toBe('polling exhausted');
    expect(patch.agentError).toBeUndefined();
    expect(patch.judgeError).toBeUndefined();
  });
});

describe('parseJudgeResponse — JudgeParseError', () => {
  it('throws a typed JudgeParseError with code JUDGE_UNPARSEABLE + rawResponse for an EMPTY reply', () => {
    let caught: unknown;
    try { parseJudgeResponse('', { source: 'AgentJudge' }); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(JudgeParseError);
    expect(isJudgeParseError(caught)).toBe(true);
    const e = caught as JudgeParseError;
    expect(e.code).toBe('JUDGE_UNPARSEABLE');
    expect(e.nonTransient).toBe(true);
    expect(e.rawResponse).toBe('');
    expect(e.message).toMatch(/AgentJudge: judge returned no parseable verdict — the model returned an empty response/);
  });

  it('keeps the raw text for a non-empty reply without JSON', () => {
    let caught: unknown;
    try { parseJudgeResponse('I refuse to answer in JSON.', { source: 'PiJudge' }); } catch (e) { caught = e; }
    const e = caught as JudgeParseError;
    expect(e.rawResponse).toBe('I refuse to answer in JSON.');
    expect(e.message).toMatch(/did not contain a JSON object/);
  });

  it('keeps the raw text for malformed JSON', () => {
    let caught: unknown;
    // A brace-balanced but invalid body gets past extractJsonFromResponse and fails JSON.parse.
    try { parseJudgeResponse('{"pass_fail_status": passed}', { source: 'PiJudge' }); } catch (e) { caught = e; }
    expect(isJudgeParseError(caught)).toBe(true);
    expect((caught as JudgeParseError).message).toMatch(/failed to parse judge JSON/);
    expect((caught as JudgeParseError).rawResponse).toBe('{"pass_fail_status": passed}');
  });

  it('isJudgeParseError is false for ordinary errors', () => {
    expect(isJudgeParseError(new Error('nope'))).toBe(false);
    expect(isJudgeParseError(null)).toBe(false);
  });
});

describe('parsePiError — no more "Pi CLI returned invalid JSON" for a model that returned nothing', () => {
  it('passes the shared parser\'s precise message through untouched', () => {
    const msg = 'AgentJudge: judge returned no parseable verdict — the model returned an empty response.';
    expect(parsePiError(new Error(msg))).toBe(msg);
  });
  it('never emits the misleading legacy wording', () => {
    for (const m of [
      'AgentJudge: judge returned no parseable verdict — the response did not contain a JSON object. First 200 chars: ',
      'Unexpected token in JSON at position 3',
      'failed to parse something',
    ]) {
      const out = parsePiError(new Error(m));
      expect(out).not.toMatch(/Failed to parse Pi judge response/);
      expect(out).not.toMatch(/CLI may have returned invalid JSON/);
      expect(out).toMatch(/no parseable verdict/);
    }
  });
  it('keeps the other mappings', () => {
    expect(parsePiError(new Error('spawn pi ENOENT'))).toMatch(/Pi CLI not found/);
    expect(parsePiError(new Error('ExpiredToken'))).toMatch(/AWS credentials expired/);
    expect(parsePiError(new Error('ETIMEDOUT'))).toMatch(/timed out/);
    expect(parsePiError(new Error('something else'))).toBe('something else');
  });
});

describe('callBedrockJudge — parse-failure retry cap', () => {
  const mockFetch = jest.fn();
  const trajectory = [{ id: 's1', type: 'response', content: 'hi', timestamp: Date.now() }] as any;

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = mockFetch as any;
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
  });
  afterEach(() => { jest.restoreAllMocks(); });

  it(`stops after ${PARSE_FAILURE_MAX_ATTEMPTS} attempts (not 10) on 422 JUDGE_UNPARSEABLE and retains the raw text + attempt count`, async () => {
    expect(PARSE_FAILURE_MAX_ATTEMPTS).toBe(2);
    mockFetch.mockResolvedValue({
      ok: false,
      status: 422,
      json: () => Promise.resolve({
        error: 'Judge evaluation failed: AgentJudge: judge returned no parseable verdict — the model returned an empty response.',
        code: 'JUDGE_UNPARSEABLE',
        rawResponse: '',
      }),
    });
    let caught: unknown;
    try { await callBedrockJudge(trajectory, { expectedOutcomes: ['x'] }); } catch (e) { caught = e; }
    expect(mockFetch).toHaveBeenCalledTimes(PARSE_FAILURE_MAX_ATTEMPTS);
    const e = caught as any;
    expect(e.message).toMatch(new RegExp(`failed after ${PARSE_FAILURE_MAX_ATTEMPTS} attempts`));
    expect(e.message).toMatch(/no parseable verdict/);
    expect(e.unparseable).toBe(true);
    expect(e.rawResponse).toBe('');
    expect(e.judgeAttempts).toBe(PARSE_FAILURE_MAX_ATTEMPTS);
    // judgeErrorDetailFrom lifts it into the report.judgeError shape.
    expect(judgeErrorDetailFrom(e)).toEqual({ message: e.message, rawResponse: '', attempts: 2 });
  }, 15_000);

  it('recovers when the second attempt parses (models are stochastic)', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 422, json: () => Promise.resolve({ error: 'Judge evaluation failed: empty', code: 'JUDGE_UNPARSEABLE', rawResponse: '' }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ passFailStatus: 'passed', metrics: { accuracy: 90 }, llmJudgeReasoning: 'ok', improvementStrategies: [] }) });
    const r = await callBedrockJudge(trajectory, { expectedOutcomes: ['x'] });
    expect(r.passFailStatus).toBe('passed');
    expect(r.judgeAttempts).toBe(2);
  }, 15_000);

  it('judgeErrorDetailFrom tolerates plain errors and strings', () => {
    expect(judgeErrorDetailFrom(new Error('boom'))).toEqual({ message: 'boom' });
    expect(judgeErrorDetailFrom('str')).toEqual({ message: 'str' });
    expect(judgeErrorDetailFrom(undefined)).toEqual({ message: 'Unknown judge error' });
  });
});

describe('retry-judgement + judgeFailureSummary exclude agent-stage failures', () => {
  const agentFailed = {
    status: 'failed', metricsStatus: 'error', failureStage: 'agent',
    traceError: 'Agent request failed (kind=agent_failed): HeadersTimeoutError', trajectory: [], rawEvents: [],
  } as any;
  it('isJudgeFailedCase is false even when the run result says completed', () => {
    expect(isJudgeFailedCase(agentFailed, { reportId: 'r', status: 'completed' })).toBe(false);
    expect(hasRejudgeableOutput({ ...agentFailed, trajectory: [{ id: 'x' }] })).toBe(false);
  });
  it('extractJudgeFailureReason is undefined for an agent-stage report (does not inflate judgeFailureSummary)', () => {
    expect(extractJudgeFailureReason(agentFailed)).toBeUndefined();
    // An explicitly-relabeled legacy doc: failureStage 'agent' but traceError still says judge_failed → still excluded.
    expect(extractJudgeFailureReason({ status: 'failed', metricsStatus: 'error', failureStage: 'agent', traceError: 'Judge evaluation failed (kind=judge_failed): x' })).toBeUndefined();
    // Judge-stage still recognized.
    expect(extractJudgeFailureReason({ status: 'completed', metricsStatus: 'error', failureStage: 'judge', traceError: 'Judge evaluation failed (kind=judge_failed): empty reply' })).toBe('empty reply');
  });
});

describe('lib/reportFailure — stage derivation for new and legacy reports', () => {
  it('prefers the explicit failureStage', () => {
    expect(getFailureStage({ failureStage: 'agent', status: 'failed' } as any)).toBe('agent');
    expect(getFailureStage({ failureStage: 'judge', status: 'completed' } as any)).toBe('judge');
    expect(getFailureStage({ failureStage: 'trace' } as any)).toBe('trace');
  });
  it('derives from the traceError kind token for pre-fix reports', () => {
    expect(getFailureStage({ metricsStatus: 'error', traceError: 'Agent run did not complete (kind=agent_failed): Subprocess timed out' } as any)).toBe('agent');
    expect(getFailureStage({ metricsStatus: 'error', traceError: 'Judge evaluation failed (kind=judge_failed): x' } as any)).toBe('judge');
    expect(getFailureStage({ metricsStatus: 'error', traceError: 'Traces never arrived (kind=trace_timeout): x' } as any)).toBe('trace');
    expect(getFailureStage({ metricsStatus: 'error', traceError: 'no token' } as any)).toBe('judge');
  });
  it('derives from the legacy outer-catch shape', () => {
    expect(getFailureStage({ status: 'failed', llmJudgeReasoning: 'Evaluation failed: fetch failed' } as any)).toBe('agent');
    expect(getFailureStage({ status: 'failed', llmJudgeReasoning: 'Evaluation failed: Bedrock Judge validation error' } as any)).toBe('judge');
  });
  it('is undefined for healthy reports', () => {
    expect(getFailureStage({ status: 'completed', passFailStatus: 'passed' } as any)).toBeUndefined();
    expect(getFailureStage({ status: 'completed', passFailStatus: 'failed' } as any)).toBeUndefined();
    expect(getFailureStage({ status: 'completed', metricsStatus: 'pending' } as any)).toBeUndefined();
    expect(getFailureStage(null)).toBeUndefined();
  });
  it('getFailureCause prefers agentError.message > error > traceError tail > legacy reasoning', () => {
    expect(getFailureCause({ agentError: { kind: 'timeout', message: 'A' }, error: 'B', traceError: 'L (kind=x): C' } as any)).toBe('A');
    expect(getFailureCause({ error: 'B', traceError: 'L (kind=x): C' } as any)).toBe('B');
    expect(getFailureCause({ traceError: 'L (kind=x): C' } as any)).toBe('C');
    expect(getFailureCause({ traceError: 'no tag' } as any)).toBe('no tag');
    expect(getFailureCause({ llmJudgeReasoning: 'Evaluation failed: fetch failed' } as any)).toBe('fetch failed');
    expect(getFailureCause({} as any)).toBeUndefined();
  });
  it('helpers', () => {
    expect(agentProducedNoOutput({ trajectory: [], rawEvents: [] } as any)).toBe(true);
    expect(agentProducedNoOutput({ trajectory: [{}], rawEvents: [] } as any)).toBe(false);
    expect(describeAgentErrorKind('timeout')).toMatch(/timed out/);
    expect(describeAgentErrorKind('connection')).toMatch(/connect/);
    expect(describeAgentErrorKind('http_503')).toBe('Agent returned HTTP 503');
    expect(describeAgentErrorKind('unknown')).toBe('Agent request failed');
    expect(describeAgentErrorKind(undefined)).toBe('Agent request failed');
    expect(formatMs(500)).toBe('500 ms');
    expect(formatMs(2500)).toBe('2.5 s');
    expect(formatMs(300_728)).toBe('5 min 1 s');
    expect(formatMs(300_000)).toBe('5 min');
    expect(formatMs(undefined)).toBeUndefined();
  });
});

describe('lib/reportFailureFields', () => {
  it('copies exactly the failure fields, including null (to clear) but not undefined', () => {
    const src = { error: 'e', failureStage: 'agent', agentError: { kind: 'timeout', message: 'm' }, judgeError: null, other: 'x' };
    const out = copyReportFailureFields(src, { keep: 1 } as any);
    expect(out).toEqual({ keep: 1, error: 'e', failureStage: 'agent', agentError: { kind: 'timeout', message: 'm' }, judgeError: null });
    expect(pickReportFailureFields({ error: undefined, failureStage: 'judge' })).toEqual({ failureStage: 'judge' });
    expect(pickReportFailureFields(undefined)).toEqual({});
    expect([...REPORT_FAILURE_FIELDS]).toEqual(['error', 'failureStage', 'agentError', 'judgeError']);
  });
});
