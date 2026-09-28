/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Empty responses in the agent-failure family (services/evaluation/
 * agentReachability.ts × emptyResponse.ts): breaker interplay, structured
 * `agentError`, the finaliser's label choice and the SDK-path stamp.
 */
import {
  AgentTransportError,
  AgentUnreachableError,
  EndpointCircuitBreaker,
  classifyTransportFailure,
  describeAgentFailure,
  evaluatorKindForAgentFailure,
  finalizeAgentFailedReport,
  stampAgentFailure,
} from '@/services/evaluation/agentReachability';
import { AgentEmptyResponseError, classifyEmptyResponse } from '@/services/evaluation/emptyResponse';

function refused(): Error {
  const e = new Error('connect ECONNREFUSED 10.0.0.5:9000') as Error & { code: string };
  e.code = 'ECONNREFUSED';
  return e;
}

function emptyError(host = 'agent.internal:9000'): AgentEmptyResponseError {
  const verdict = classifyEmptyResponse({ trajectory: [{ type: 'response', content: '{}' }], rawEvents: [{}] });
  return new AgentEmptyResponseError(verdict, host, {
    trajectory: [{ id: 's1', timestamp: 1, type: 'response', content: '{}' }],
    rawEvents: [{}], runId: 'run-9', metadata: { sessionId: 'sess-9' }, agentDurationMs: 5,
  });
}

describe('EndpointCircuitBreaker × empty responses', () => {
  it('three consecutive empty responses open the breaker by default; the refusal and summary say "empty responses"', () => {
    const b = new EndpointCircuitBreaker(3);
    expect(b.countEmptyResponses).toBe(true);
    b.recordEmptyResponse('agent.internal:9000/run');
    b.recordEmptyResponse('agent.internal:9000/run');
    expect(b.isOpen('agent.internal:9000/run')).toBe(false);
    b.recordEmptyResponse('agent.internal:9000/run');
    expect(b.isOpen('agent.internal:9000/run')).toBe(true);
    expect(() => b.assertClosed('agent.internal:9000/run')).toThrow(AgentUnreachableError);
    try { b.assertClosed('agent.internal:9000/run'); } catch (e: any) {
      expect(e.message).toBe('agent endpoint unreachable — 3 consecutive empty responses (EMPTY_RESPONSE, agent.internal:9000); this case was not attempted');
    }
    expect(b.summary()).toBe(
      'Agent endpoint unreachable — 3 consecutive empty responses (EMPTY_RESPONSE, agent.internal:9000); 2 further cases were not attempted',
    );
    expect(b.totalEmptyResponses).toBe(3);
  });

  it('a mixed streak (refused + empty) reads "agent failures"; a pure transport streak keeps "connection failures"', () => {
    const b = new EndpointCircuitBreaker(3);
    b.recordFailure('k', refused());
    b.recordEmptyResponse('k');
    b.recordFailure('k', refused());
    expect(b.isOpen('k')).toBe(true);
    expect(b.summary()).toBe('Agent endpoint unreachable — 3 consecutive agent failures (ECONNREFUSED, k)');

    const t = new EndpointCircuitBreaker(2);
    t.recordFailure('k', refused());
    t.recordFailure('k', refused());
    expect(t.summary()).toBe('Agent endpoint unreachable — 2 consecutive connection failures (ECONNREFUSED, k)');
  });

  it('countEmptyResponses: false — empties are tallied for the summary but never open the circuit', () => {
    const b = new EndpointCircuitBreaker(3, { countEmptyResponses: false });
    for (let i = 0; i < 5; i++) b.recordEmptyResponse('k');
    expect(b.isOpen('k')).toBe(false);
    expect(b.openCircuits()).toEqual([]);
    expect(b.totalEmptyResponses).toBe(5);
    expect(b.summary()).toBe('5 cases returned an empty response (no steps, no answer, no results) — not judged');
  });

  it('empties below the threshold still produce a run summary (count form), singular/plural', () => {
    const b = new EndpointCircuitBreaker(3);
    b.recordEmptyResponse('k');
    expect(b.summary()).toBe('1 case returned an empty response (no steps, no answer, no results) — not judged');
    b.recordSuccess('k');
    b.recordEmptyResponse('k');
    expect(b.summary()).toBe('2 cases returned an empty response (no steps, no answer, no results) — not judged');
    expect(b.isOpen('k')).toBe(false);
  });

  it('a success resets the empty streak (and its noun); an empty response never resets a transport streak', () => {
    const b = new EndpointCircuitBreaker(3);
    b.recordEmptyResponse('k');
    b.recordEmptyResponse('k');
    b.recordSuccess('k');
    b.recordEmptyResponse('k');
    expect(b.isOpen('k')).toBe(false);
    b.recordFailure('k', refused());
    b.recordFailure('k', refused());
    expect(b.isOpen('k')).toBe(true);
    expect(b.summary()).toContain('3 consecutive agent failures');
  });

  it('no summary when nothing happened', () => {
    expect(new EndpointCircuitBreaker(3).summary()).toBeUndefined();
  });

  it('disabled breaker (threshold 0): empties never open it but are still counted', () => {
    const b = new EndpointCircuitBreaker(Infinity);
    for (let i = 0; i < 10; i++) b.recordEmptyResponse('k');
    expect(b.isOpen('k')).toBe(false);
    expect(b.summary()).toContain('10 cases returned an empty response');
  });
});

describe('describeAgentFailure / evaluatorKindForAgentFailure', () => {
  it('classifies the three family members and nothing else', () => {
    const transport = new AgentTransportError(classifyTransportFailure(refused())!, 'h:1', refused());
    expect(describeAgentFailure(transport)).toEqual({ stage: 'agent', kind: 'transport', code: 'ECONNREFUSED', message: transport.message });
    const unreachable = new AgentUnreachableError('h:1', 3, 'ECONNREFUSED');
    expect(describeAgentFailure(unreachable)).toEqual({ stage: 'agent', kind: 'unreachable', code: 'AGENT_ENDPOINT_UNREACHABLE', message: unreachable.message });
    const empty = emptyError();
    expect(describeAgentFailure(empty)).toEqual({ stage: 'agent', kind: 'empty-response', code: 'EMPTY_RESPONSE', message: empty.message });
    expect(describeAgentFailure(new Error('Subprocess timed out'))).toBeUndefined();
    expect(describeAgentFailure(undefined)).toBeUndefined();
  });

  it('maps empty-response to agent_empty_response and everything else to agent_failed', () => {
    expect(evaluatorKindForAgentFailure(describeAgentFailure(emptyError()))).toBe('agent_empty_response');
    expect(evaluatorKindForAgentFailure(describeAgentFailure(new AgentUnreachableError('h', 3, 'X')))).toBe('agent_failed');
    expect(evaluatorKindForAgentFailure(undefined)).toBe('agent_failed');
  });
});

describe('finalizeAgentFailedReport with agentError', () => {
  it('an empty-response connector report gets the "Agent returned an empty response" label and stays final', () => {
    const err = emptyError();
    const report: any = {
      status: 'failed',
      llmJudgeReasoning: `Evaluation failed: ${err.message}`,
      agentError: describeAgentFailure(err),
      trajectory: err.payload.trajectory,
    };
    expect(finalizeAgentFailedReport(report)).toBe(true);
    expect(report.metricsStatus).toBe('error');
    expect(report.passFailStatus).toBeNull();
    expect(report.skipJudge).toBe(true);
    expect(report.traceError).toBe(`Agent returned an empty response (kind=agent_empty_response): ${err.message}`);
    expect(report.llmJudgeReasoning).toContain('**Agent returned an empty response.**');
    expect(report.llmJudgeReasoning).toContain('never scored as a reply');
    // The placeholder trajectory is kept for display.
    expect(report.trajectory).toHaveLength(1);
    // Second call is a no-op.
    expect(finalizeAgentFailedReport(report)).toBe(false);
  });

  it('a transport report keeps the agent_failed label', () => {
    const report: any = { status: 'failed', llmJudgeReasoning: 'Evaluation failed: ECONNREFUSED — …', agentError: { stage: 'agent', kind: 'transport', code: 'ECONNREFUSED', message: 'x' } };
    finalizeAgentFailedReport(report);
    expect(report.traceError).toMatch(/^Agent run did not complete \(kind=agent_failed\)/);
  });
});

describe('stampAgentFailure (SDK / agent.run() path)', () => {
  it('empty response: agent_empty_response patch + agentError + the connector payload for display', () => {
    const report: any = { trajectory: [], rawEvents: [] };
    stampAgentFailure(report, emptyError());
    expect(report.metricsStatus).toBe('error');
    expect(report.passFailStatus).toBeNull();
    expect(report.skipJudge).toBe(true);
    expect(report.agentError).toMatchObject({ stage: 'agent', kind: 'empty-response', code: 'EMPTY_RESPONSE' });
    expect(report.traceError).toMatch(/^Agent returned an empty response \(kind=agent_empty_response\): EMPTY_RESPONSE — agent returned an empty response/);
    expect(report.trajectory).toEqual([{ id: 's1', timestamp: 1, type: 'response', content: '{}' }]);
    expect(report.rawEvents).toEqual([{}]);
    expect(report.runId).toBe('run-9');
    expect(report.sessionId).toBe('sess-9');
  });

  it('unclassified error (timeout): plain agent_failed, no agentError', () => {
    const report: any = {};
    stampAgentFailure(report, new Error('Subprocess timed out after 600000ms'));
    expect(report.traceError).toBe('Agent run did not complete (kind=agent_failed): Subprocess timed out after 600000ms');
    expect(report.agentError).toBeUndefined();
    expect(report.skipJudge).toBe(true);
  });

  it('transport error: agent_failed + structured agentError', () => {
    const report: any = {};
    stampAgentFailure(report, new AgentTransportError(classifyTransportFailure(refused())!, 'h:1', refused()));
    expect(report.agentError).toMatchObject({ kind: 'transport', code: 'ECONNREFUSED' });
    expect(report.traceError).toMatch(/kind=agent_failed/);
  });
});
