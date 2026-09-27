/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Agent-error surfacing — UI primitives:
 *   - ResultStatus: an agent-stage failure is `errored` (not a failed
 *     verdict) and the badge reads AGENT ERROR / JUDGE ERROR by stage.
 *   - RunFailureCard: the Test Case Output card names the stage, shows the
 *     unwrapped cause, endpoint, elapsed and timeout (agent) or the judge's
 *     raw reply + attempts (judge).
 *   - TestCaseInspectorPanel header badge: AGENT ERROR vs JUDGE ERROR.
 */

import * as React from 'react';
const h = React.createElement;
import { render, screen, fireEvent } from '@testing-library/react';
import { getResultStatus, getErrorStage, StatusLabel, StatusIcon, getStatusDescription } from '@/components/evals3/ResultStatus';
import { RunFailureCard } from '@/components/evals3/RunFailureCard';
import type { EvaluationReport } from '@/types';

jest.mock('@/components/RunDetailsContent', () => ({
  RunDetailsContent: () => require('react').createElement('div', { 'data-testid': 'run-details-content' }),
}));
jest.mock('@/components/evals3/CollapsibleTestCaseDefinition', () => ({
  CollapsibleTestCaseDefinition: () => null,
}));
jest.mock('@/lib/utils', () => ({
  ...jest.requireActual('@/lib/utils'),
  getRunDisplayName: () => 'Run abc',
}));

import { TestCaseInspectorPanel } from '@/components/evals3/TestCaseInspectorPanel';

const agentFailedReport = {
  id: 'r-agent', timestamp: new Date().toISOString(), agentName: 'A REST agent', modelName: 'm', testCaseId: 'tc',
  status: 'failed', metricsStatus: 'error', failureStage: 'agent', passFailStatus: null,
  trajectory: [], rawEvents: [], metrics: {},
  error: 'HeadersTimeoutError: Headers Timeout Error (UND_ERR_HEADERS_TIMEOUT) — via fetch failed — no response within 300000ms (http://localhost:8000/ask)',
  agentError: { kind: 'timeout', message: 'HeadersTimeoutError: Headers Timeout Error (UND_ERR_HEADERS_TIMEOUT) — via fetch failed — no response within 300000ms (http://localhost:8000/ask)', elapsedMs: 300_728, endpoint: 'http://localhost:8000/ask', timeoutMs: 300_000 },
  traceError: 'Agent request failed (kind=agent_failed): HeadersTimeoutError …',
  llmJudgeReasoning: '**Agent request failed — not judged.**',
  connectorProtocol: 'rest',
} as unknown as EvaluationReport;

const judgeFailedReport = {
  id: 'r-judge', timestamp: new Date().toISOString(), agentName: 'A REST agent', modelName: 'm', testCaseId: 'tc',
  status: 'completed', metricsStatus: 'error', failureStage: 'judge', passFailStatus: null,
  trajectory: [{ id: 's1', type: 'response', content: 'answer', timestamp: 1 }], rawEvents: [{}], metrics: {},
  error: 'Bedrock Judge evaluation failed after 2 attempts: judge returned no parseable verdict — the model returned an empty response.',
  judgeError: { message: 'Bedrock Judge evaluation failed after 2 attempts: …', rawResponse: '', attempts: 2 },
  traceError: 'Judge evaluation failed (kind=judge_failed): …',
  llmJudgeReasoning: '**Evaluator could not run.**',
  judgeModelId: 'agent-trace-judge', evaluatorId: 'ev-1',
} as unknown as EvaluationReport;

describe('ResultStatus — stage-aware errored status', () => {
  it('an agent-stage failure with run status "failed" is errored (excluded from pass-rate), not a failed verdict', () => {
    expect(getResultStatus({ status: 'failed' }, agentFailedReport)).toBe('errored');
    expect(getResultStatus({ status: 'completed' }, agentFailedReport)).toBe('errored');
    expect(getErrorStage('errored', agentFailedReport)).toBe('agent');
  });
  it('a plain execution failure without a report is still failed', () => {
    expect(getResultStatus({ status: 'failed' }, null)).toBe('failed');
    expect(getErrorStage('failed', null)).toBeUndefined();
  });
  it('a judge-stage failure is errored with stage judge', () => {
    expect(getResultStatus({ status: 'completed' }, judgeFailedReport)).toBe('errored');
    expect(getErrorStage('errored', judgeFailedReport)).toBe('judge');
  });
  it('legacy reports derive the stage from the traceError kind token', () => {
    const legacy = { metricsStatus: 'error', traceError: 'Agent run did not complete (kind=agent_failed): Subprocess timed out' } as any;
    expect(getErrorStage('errored', legacy)).toBe('agent');
  });
  it('StatusLabel reads AGENT ERROR / JUDGE ERROR / TRACE ERROR / ERRORED by stage', () => {
    const { rerender } = render(h(StatusLabel, { status: "errored", stage: "agent" }));
    expect(screen.getByTestId('status-label').textContent).toBe('AGENT ERROR');
    rerender(h(StatusLabel, { status: "errored", stage: "judge" }));
    expect(screen.getByTestId('status-label').textContent).toBe('JUDGE ERROR');
    rerender(h(StatusLabel, { status: "errored", stage: "trace" }));
    expect(screen.getByTestId('status-label').textContent).toBe('TRACE ERROR');
    rerender(h(StatusLabel, { status: "errored" }));
    expect(screen.getByTestId('status-label').textContent).toBe('ERRORED');
    rerender(h(StatusLabel, { status: "failed", stage: "agent" }));
    expect(screen.getByTestId('status-label').textContent).toBe('FAILED');
  });
  it('StatusIcon uses a distinct icon for agent errors', () => {
    render(h(StatusIcon, { status: "errored", stage: "agent" }));
    expect(screen.getByTestId('status-icon-agent-error')).toBeTruthy();
  });
  it('getStatusDescription is stage-aware', () => {
    expect(getStatusDescription('errored', 'agent')).toMatch(/Agent request failed/);
    expect(getStatusDescription('errored', 'judge')).toMatch(/Judge/);
    expect(getStatusDescription('errored')).toBe('Evaluator could not run');
  });
});

describe('RunFailureCard', () => {
  it('agent stage: names the stage, shows the unwrapped cause, endpoint, elapsed, timeout and the re-run remedy', () => {
    render(h(RunFailureCard, { report: agentFailedReport }));
    const card = screen.getByTestId('run-failure-card');
    expect(card.getAttribute('data-stage')).toBe('agent');
    expect(screen.getByText(/Agent request failed — agent request timed out/i)).toBeTruthy();
    expect(screen.getByTestId('run-failure-cause').textContent).toMatch(/HeadersTimeoutError/);
    expect(screen.getByTestId('run-failure-cause').textContent).toMatch(/UND_ERR_HEADERS_TIMEOUT/);
    expect(screen.getByText('http://localhost:8000/ask')).toBeTruthy();
    expect(screen.getByText('5 min 1 s')).toBeTruthy();
    expect(screen.getByText(/5 min \(connectorConfig\.timeoutMs\)/)).toBeTruthy();
    expect(screen.getByText(/produced no output, so this case was not judged\. Re-run the case/)).toBeTruthy();
    // Must NOT claim the evaluator failed.
    expect(screen.queryByText(/Evaluator could not run/)).toBeNull();
  });

  it('judge stage: shows the cause, attempt count, "model returned an empty response" for an empty raw reply, and the retry-judgement remedy', () => {
    render(h(RunFailureCard, { report: judgeFailedReport }));
    expect(screen.getByTestId('run-failure-card').getAttribute('data-stage')).toBe('judge');
    expect(screen.getByText('Judge could not produce a verdict')).toBeTruthy();
    expect(screen.getByTestId('run-failure-cause').textContent).toMatch(/no parseable verdict/);
    expect(screen.getByText('2')).toBeTruthy(); // attempts
    expect(screen.getByTestId('run-failure-raw-toggle').textContent).toMatch(/model returned an empty response/);
    expect(screen.getByText(/Retry judgement/)).toBeTruthy();
  });

  it('judge stage: a non-empty raw reply is collapsible', () => {
    const r = { ...judgeFailedReport, judgeError: { message: 'x', rawResponse: 'I cannot comply.', attempts: 2 } } as any;
    render(h(RunFailureCard, { report: r }));
    expect(screen.queryByTestId('run-failure-raw')).toBeNull();
    fireEvent.click(screen.getByTestId('run-failure-raw-toggle'));
    expect(screen.getByTestId('run-failure-raw').textContent).toBe('I cannot comply.');
  });

  it('trace stage renders with attempts', () => {
    const r = { ...judgeFailedReport, failureStage: 'trace', traceError: 'Traces never arrived (kind=trace_timeout): polling exhausted', error: 'polling exhausted', judgeError: undefined, traceFetchAttempts: 30, runId: 'run-1' } as any;
    render(h(RunFailureCard, { report: r }));
    expect(screen.getByTestId('run-failure-card').getAttribute('data-stage')).toBe('trace');
    expect(screen.getByText('Trace pipeline failed')).toBeTruthy();
    expect(screen.getByText('30')).toBeTruthy();
  });

  it('renders nothing for a healthy report', () => {
    const healthy = { ...judgeFailedReport, failureStage: undefined, metricsStatus: 'ready', traceError: undefined, passFailStatus: 'passed', status: 'completed' } as any;
    const { container } = render(h(RunFailureCard, { report: healthy }));
    expect(container.firstChild).toBeNull();
  });

  it('legacy pre-fix agent failure (no failureStage/agentError) still renders as agent stage with the recorded reasoning', () => {
    const legacy = {
      ...agentFailedReport, failureStage: undefined, agentError: undefined, error: undefined, metricsStatus: undefined, traceError: undefined,
      llmJudgeReasoning: 'Evaluation failed: fetch failed',
    } as any;
    render(h(RunFailureCard, { report: legacy }));
    expect(screen.getByTestId('run-failure-card').getAttribute('data-stage')).toBe('agent');
    expect(screen.getByTestId('run-failure-cause').textContent).toBe('fetch failed');
  });
});

describe('TestCaseInspectorPanel — header badge', () => {
  it('reads AGENT ERROR for an agent-stage failure', () => {
    render(h(TestCaseInspectorPanel, { report: agentFailedReport, testCase: null, status: "errored" }));
    const badge = screen.getByTestId('inspector-status-badge');
    expect(badge.textContent).toBe('AGENT ERROR');
    expect(badge.getAttribute('data-stage')).toBe('agent');
  });
  it('reads JUDGE ERROR for a judge-stage failure', () => {
    render(h(TestCaseInspectorPanel, { report: judgeFailedReport, testCase: null, status: "errored" }));
    expect(screen.getByTestId('inspector-status-badge').textContent).toBe('JUDGE ERROR');
  });
  it('still reads PASSED/FAILED for verdicts', () => {
    const verdict = { ...judgeFailedReport, failureStage: undefined, metricsStatus: 'ready', traceError: undefined, passFailStatus: 'failed' } as any;
    render(h(TestCaseInspectorPanel, { report: verdict, testCase: null, status: 'failed' }));
    expect(screen.getByTestId('inspector-status-badge').textContent).toBe('FAILED');
  });
});
