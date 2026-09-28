/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Empty-response detection — truth table for `classifyEmptyResponse` and its
 * helpers (services/evaluation/emptyResponse.ts).
 *
 * Owner incident: an HTTP agent answered 200 with `{ answer: null, results: [],
 * steps: [] }`; the agent's afterResponse hook rendered a placeholder as the
 * response step and the judge PASSED it ("Any reply at all — fully achieved").
 */
import {
  AgentEmptyResponseError,
  classifyEmptyResponse,
  EMPTY_RESPONSE_CODE,
  EMPTY_RESPONSE_TRIPS_BREAKER_ENV,
  hasAnyLeaf,
  isAgentEmptyResponseError,
  payloadContentState,
  readExplicitEmptyFlag,
  resolveEmptyResponseTripsBreaker,
} from '@/services/evaluation/emptyResponse';

const response = (content: string) => ({ type: 'response' as const, content });
const step = (type: 'tool_result' | 'action' | 'thinking' | 'assistant' | 'user', content = 'x') => ({ type, content });

describe('classifyEmptyResponse — truth table', () => {
  describe('EMPTY', () => {
    it('no steps at all, no raw events (blank)', () => {
      const v = classifyEmptyResponse({ trajectory: [], rawEvents: [] });
      expect(v).toMatchObject({ empty: true, source: 'blank', agentSteps: 0, responseChars: 0, payload: 'unknown' });
      expect(v.detail).toContain('no agent steps and no response text');
    });

    it('a single response step whose text is whitespace only', () => {
      const v = classifyEmptyResponse({ trajectory: [response('  \n\t ')], rawEvents: [{ answer: '' }] });
      expect(v).toMatchObject({ empty: true, source: 'blank', payload: 'empty' });
    });

    it('response step with null/undefined content counts as blank', () => {
      expect(classifyEmptyResponse({ trajectory: [{ type: 'response', content: null as any }] }).empty).toBe(true);
      expect(classifyEmptyResponse({ trajectory: [{ type: 'response', content: undefined as any }] }).empty).toBe(true);
    });

    it('`200 {}` through the REST connector: the JSON echo "{}" is not backed by any content', () => {
      // RESTConnector.parseResponse falls back to JSON.stringify(data, null, 2).
      const v = classifyEmptyResponse({ trajectory: [response('{}')], rawEvents: [{}] });
      expect(v).toMatchObject({ empty: true, source: 'no-content', payload: 'empty', responseChars: 2 });
      expect(v.detail).toContain('not backed by any agent content');
    });

    it('the owner incident: hook-rendered placeholder over a payload whose answer/results/steps are all empty', () => {
      const payload = { answer: null, results: [], ids: [], source: null, session_id: 'sess-123', steps: [] };
      const v = classifyEmptyResponse({
        trajectory: [response('No results available (source=unknown).')],
        rawEvents: [payload],
      });
      expect(v).toMatchObject({ empty: true, source: 'no-content', payload: 'empty', agentSteps: 0 });
    });

    it('an explicit hook flag forces EMPTY even when the rendered text looks like an answer and steps exist', () => {
      const v = classifyEmptyResponse({
        trajectory: [step('assistant', 'Here is what I found'), response('Great answer.')],
        rawEvents: [{ answer: 'Great answer.' }],
        explicit: true,
      });
      expect(v).toMatchObject({ empty: true, source: 'hook' });
    });

    it('a null / empty-string body', () => {
      expect(classifyEmptyResponse({ trajectory: [response('null')], rawEvents: [null] })).toMatchObject({ empty: true, payload: 'empty' });
      expect(classifyEmptyResponse({ trajectory: [], rawEvents: [''] })).toMatchObject({ empty: true, payload: 'empty' });
    });

    it('nested empties under known keys: `{ output: { messages: [] }, data: {} }`', () => {
      const v = classifyEmptyResponse({ trajectory: [response('{"output":{"messages":[]},"data":{}}')], rawEvents: [{ output: { messages: [] }, data: {} }] });
      expect(v).toMatchObject({ empty: true, payload: 'empty' });
    });

    it('a step-type without content (empty assistant / thinking stub) is not agent activity (codex_review)', () => {
      const v = classifyEmptyResponse({ trajectory: [step('assistant', ''), step('thinking', '   '), response('{}')], rawEvents: [{}] });
      expect(v).toMatchObject({ empty: true, agentSteps: 0 });
    });

    it('a `user` step is not agent activity', () => {
      const v = classifyEmptyResponse({ trajectory: [step('user', 'search products'), response('')], rawEvents: [{}] });
      expect(v).toMatchObject({ empty: true, agentSteps: 0 });
    });
  });

  describe('NOT empty', () => {
    it.each([
      ['tool_result'], ['action'], ['thinking'], ['assistant'],
    ] as const)('any agent-originated step (%s) with blank response text', (type) => {
      const v = classifyEmptyResponse({ trajectory: [step(type), response('')], rawEvents: [{}] });
      expect(v).toMatchObject({ empty: false, agentSteps: 1 });
    });

    it('steps present but empty final text (agent worked, then said nothing) is NOT empty', () => {
      const v = classifyEmptyResponse({
        trajectory: [step('action', 'Calling search...'), step('tool_result', '[3 hits]'), response('   ')],
        rawEvents: [{ toolCalls: [{ name: 'search' }], answer: null }],
      });
      expect(v.empty).toBe(false);
    });

    it('structured results present with a null answer — the results ARE the answer', () => {
      const payload = { answer: null, results: [{ id: 'p1', title: 'Trail shoe' }, { id: 'p2', title: 'Road shoe' }], steps: [] };
      const v = classifyEmptyResponse({ trajectory: [response(JSON.stringify(payload, null, 2))], rawEvents: [payload] });
      expect(v).toMatchObject({ empty: false, payload: 'content' });
    });

    it('a real answer string under a known key backs the response text', () => {
      const v = classifyEmptyResponse({ trajectory: [response('42')], rawEvents: [{ answer: '42' }] });
      expect(v).toMatchObject({ empty: false, payload: 'content' });
    });

    it('a numeric / boolean result is content', () => {
      expect(classifyEmptyResponse({ trajectory: [response('0')], rawEvents: [{ result: 0 }] }).empty).toBe(false);
      expect(classifyEmptyResponse({ trajectory: [response('false')], rawEvents: [{ result: false }] }).empty).toBe(false);
    });

    it('response text with NO raw events is trusted (no evidence to contradict it)', () => {
      const v = classifyEmptyResponse({ trajectory: [response('answer')], rawEvents: [] });
      expect(v).toMatchObject({ empty: false, payload: 'unknown' });
      expect(classifyEmptyResponse({ trajectory: [response('answer')] }).empty).toBe(false);
    });

    it('structured data under an UNKNOWN key with all known keys empty is NOT classified (codex_review: schema we cannot read)', () => {
      const payload = { answer: null, results: [], custom_results: [{ id: 'p1', title: 'Trail shoe' }] };
      const v = classifyEmptyResponse({ trajectory: [response(JSON.stringify(payload, null, 2))], rawEvents: [payload] });
      expect(v).toMatchObject({ empty: false, payload: 'unknown' });
      // Scalar metadata under unknown keys does not rescue an empty payload.
      expect(payloadContentState([{ answer: null, results: [], session_id: 's', status: 'ok', latency_ms: 12, ids: [] }])).toBe('empty');
    });

    it('a tool step (action / tool_result) IS agent activity even with blank content — a tool call happened', () => {
      expect(classifyEmptyResponse({ trajectory: [{ type: 'action', content: '' }, response('')], rawEvents: [{}] }).empty).toBe(false);
      expect(classifyEmptyResponse({ trajectory: [{ type: 'tool_result', content: '' }, response('')], rawEvents: [{}] }).empty).toBe(false);
    });

    it('response text over an UNKNOWN payload shape (no known content key) is trusted', () => {
      const v = classifyEmptyResponse({ trajectory: [response('{"foo":"the answer is 42"}')], rawEvents: [{ foo: 'the answer is 42' }] });
      expect(v).toMatchObject({ empty: false, payload: 'unknown' });
    });

    it('a streaming connector: text deltas back the response text', () => {
      const events = [
        { type: 'RUN_STARTED', threadId: 't', runId: 'r' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'Hel' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'lo' },
        { type: 'RUN_FINISHED', threadId: 't', runId: 'r' },
      ];
      expect(classifyEmptyResponse({ trajectory: [response('Hello')], rawEvents: events })).toMatchObject({ empty: false, payload: 'content' });
    });

    it('a subprocess connector: stdout chunks are content', () => {
      const v = classifyEmptyResponse({ trajectory: [response('done')], rawEvents: [{ type: 'stdout', data: 'done\n', timestamp: 1 }] });
      expect(v).toMatchObject({ empty: false, payload: 'content' });
    });

    it('an explicit `empty: false` suppresses the built-in detection', () => {
      const v = classifyEmptyResponse({ trajectory: [response('{}')], rawEvents: [{}], explicit: false });
      expect(v).toMatchObject({ empty: false });
      expect(v.detail).toContain('non-empty');
    });
  });

  it('never throws on garbage input', () => {
    expect(() => classifyEmptyResponse({ trajectory: null, rawEvents: 42 })).not.toThrow();
    expect(() => classifyEmptyResponse({ trajectory: [null as any, undefined as any], rawEvents: 'x' })).not.toThrow();
    expect(classifyEmptyResponse({ trajectory: undefined }).empty).toBe(true);
  });
});

describe('payloadContentState', () => {
  it('no raw events / undefined → unknown', () => {
    expect(payloadContentState(undefined)).toBe('unknown');
    expect(payloadContentState(null)).toBe('unknown');
    expect(payloadContentState([])).toBe('unknown');
  });
  it('a stream of pure protocol events (no content key anywhere) → unknown', () => {
    expect(payloadContentState([{ type: 'RUN_STARTED', runId: 'r' }, { type: 'RUN_FINISHED', runId: 'r' }])).toBe('unknown');
  });
  it('protocol events plus one empty content key → empty', () => {
    expect(payloadContentState([{ type: 'RUN_FINISHED', runId: 'r', result: null }])).toBe('empty');
  });
  it('content wins over unknown wins over empty', () => {
    expect(payloadContentState([{}, { foo: 1 }, { answer: 'x' }])).toBe('content');
    expect(payloadContentState([{}, { foo: 1 }])).toBe('unknown');
    expect(payloadContentState([{}, { answer: null }])).toBe('empty');
  });
  it('a non-array single payload is accepted', () => {
    expect(payloadContentState({ answer: 'x' })).toBe('content');
    expect(payloadContentState({})).toBe('empty');
    expect(payloadContentState('   ')).toBe('empty');
    expect(payloadContentState('text body')).toBe('unknown');
  });
  it('bounds recursion depth on deeply nested / cyclic-looking structures', () => {
    let deep: any = 'leaf';
    for (let i = 0; i < 20; i++) deep = { answer: deep };
    // Deeper than MAX_DEPTH: the leaf is out of reach → not content.
    expect(hasAnyLeaf(deep)).toBe(false);
    const shallow = { answer: { answer: { answer: 'leaf' } } };
    expect(hasAnyLeaf(shallow)).toBe(true);
  });
});

describe('readExplicitEmptyFlag', () => {
  it('reads empty / isEmpty (top-level) and response.isEmpty — nothing else', () => {
    expect(readExplicitEmptyFlag({ empty: true, response: {}, trajectory: [] })).toBe(true);
    expect(readExplicitEmptyFlag({ isEmpty: true, response: {}, trajectory: [] })).toBe(true);
    expect(readExplicitEmptyFlag({ response: { isEmpty: true }, trajectory: [] })).toBe(true);
    expect(readExplicitEmptyFlag({ empty: false })).toBe(false);
    // `response.empty` is a plausible AGENT payload field, not a contract field.
    expect(readExplicitEmptyFlag({ response: { empty: true }, trajectory: [] })).toBeUndefined();
  });
  it('is undefined when the hook said nothing (or returned a non-object / non-boolean)', () => {
    expect(readExplicitEmptyFlag({ response: {}, trajectory: [] })).toBeUndefined();
    expect(readExplicitEmptyFlag({ empty: 'yes' })).toBeUndefined();
    expect(readExplicitEmptyFlag(null)).toBeUndefined();
    expect(readExplicitEmptyFlag('x')).toBeUndefined();
  });
});

describe('resolveEmptyResponseTripsBreaker', () => {
  it('defaults to true', () => {
    expect(resolveEmptyResponseTripsBreaker(undefined, {})).toBe(true);
    expect(resolveEmptyResponseTripsBreaker({}, {})).toBe(true);
  });
  it('connectorConfig (boolean only) wins over env; a non-boolean is warned about and ignored', () => {
    expect(resolveEmptyResponseTripsBreaker({ emptyResponseTripsBreaker: false }, { [EMPTY_RESPONSE_TRIPS_BREAKER_ENV]: '1' })).toBe(false);
    expect(resolveEmptyResponseTripsBreaker({ emptyResponseTripsBreaker: true }, { [EMPTY_RESPONSE_TRIPS_BREAKER_ENV]: '0' })).toBe(true);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(resolveEmptyResponseTripsBreaker({ emptyResponseTripsBreaker: 'off' }, { [EMPTY_RESPONSE_TRIPS_BREAKER_ENV]: '0' })).toBe(false);
      expect(resolveEmptyResponseTripsBreaker({ emptyResponseTripsBreaker: 'off' }, {})).toBe(true);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Ignoring non-boolean connectorConfig.emptyResponseTripsBreaker'));
    } finally { warn.mockRestore(); }
  });
  it('env accepts 0/false/no/off as disabling, anything else enables', () => {
    for (const v of ['0', 'false', 'NO', 'off']) expect(resolveEmptyResponseTripsBreaker(undefined, { [EMPTY_RESPONSE_TRIPS_BREAKER_ENV]: v })).toBe(false);
    for (const v of ['1', 'true', 'yes']) expect(resolveEmptyResponseTripsBreaker(undefined, { [EMPTY_RESPONSE_TRIPS_BREAKER_ENV]: v })).toBe(true);
    expect(resolveEmptyResponseTripsBreaker(undefined, { [EMPTY_RESPONSE_TRIPS_BREAKER_ENV]: '  ' })).toBe(true);
  });
});

describe('AgentEmptyResponseError', () => {
  it('names the code, the host and the rule; carries the payload for the report', () => {
    const verdict = classifyEmptyResponse({ trajectory: [response('{}')], rawEvents: [{}] });
    const err = new AgentEmptyResponseError(verdict, 'agent.internal:9000', {
      trajectory: [response('{}')] as any, rawEvents: [{}], runId: 'run-1', metadata: { sessionId: 's-1' }, agentDurationMs: 12,
    });
    expect(err.name).toBe('AgentEmptyResponseError');
    expect(err.code).toBe(EMPTY_RESPONSE_CODE);
    expect(err.message).toBe(
      'EMPTY_RESPONSE — agent returned an empty response (no steps, no answer, no results) from agent endpoint agent.internal:9000: ' + verdict.detail,
    );
    expect(err.message).not.toContain('http://');
    expect(err.payload.runId).toBe('run-1');
    expect(err.payload.metadata?.sessionId).toBe('s-1');
    expect(isAgentEmptyResponseError(err)).toBe(true);
    expect(isAgentEmptyResponseError(new Error('x'))).toBe(false);
  });
});
