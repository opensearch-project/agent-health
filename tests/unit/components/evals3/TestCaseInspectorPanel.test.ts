/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TestCaseInspectorPanel — agent-failure reason line. The panel renders
 * RunDetailsContent with `hideMetrics`, which hides the report page's
 * error cards, so a classified agent failure (transport / unreachable /
 * empty response) has to show its reason in the panel header or the user
 * only sees a bare ERRORED chip.
 *
 * Written with React.createElement (this repo's jest config only matches
 * `*.test.ts`).
 */
import * as React from 'react';
import { render, screen } from '@testing-library/react';

jest.mock('@/components/RunDetailsContent', () => ({
  RunDetailsContent: () => require('react').createElement('div', { 'data-testid': 'run-details-content' }),
}));
jest.mock('@/components/evals3/CollapsibleTestCaseDefinition', () => ({
  CollapsibleTestCaseDefinition: () => require('react').createElement('div', { 'data-testid': 'definition' }),
}));

import { TestCaseInspectorPanel } from '@/components/evals3/TestCaseInspectorPanel';
import type { EvaluationReport, TestCase } from '@/types';

const h = React.createElement;

const testCase = { id: 'tc-1', name: 'Search products', initialPrompt: 'search products', expectedOutcomes: ['ok'] } as unknown as TestCase;

function report(overrides: Partial<EvaluationReport> = {}): EvaluationReport {
  return {
    id: 'rep-1', name: 'Run 1', timestamp: '2026-01-01T00:00:00Z', testCaseId: 'tc-1', agentName: 'REST Agent', modelName: 'demo-model',
    status: 'failed', metricsStatus: 'error', passFailStatus: null as any,
    trajectory: [{ id: 's', timestamp: 1, type: 'response', content: '{}' }],
    metrics: { accuracy: 0 }, llmJudgeReasoning: '',
    ...overrides,
  } as EvaluationReport;
}

describe('TestCaseInspectorPanel — agent failure reason', () => {
  it('empty response: ERRORED chip + reason line naming the class, host message and "Not judged."', () => {
    const message = 'EMPTY_RESPONSE — agent returned an empty response (no steps, no answer, no results) from agent endpoint agent.internal:9000: no agent steps; the payload has no answer, steps or results';
    render(h(TestCaseInspectorPanel, {
      report: report({ agentError: { stage: 'agent', kind: 'empty-response', code: 'EMPTY_RESPONSE', message } }),
      testCase, status: 'errored',
    }));
    expect(screen.getByText('ERRORED')).toBeTruthy();
    const line = screen.getByTestId('inspector-agent-failure');
    expect(line.getAttribute('data-kind')).toBe('empty-response');
    expect(line.textContent).toContain('Agent returned an empty response');
    expect(line.textContent).toContain(message);
    expect(line.textContent).toContain('Not judged.');
    expect(line.textContent).not.toContain('http://');
  });

  it('unreachable / transport members use their own titles', () => {
    const { unmount } = render(h(TestCaseInspectorPanel, {
      report: report({ agentError: { stage: 'agent', kind: 'unreachable', code: 'AGENT_ENDPOINT_UNREACHABLE', message: 'agent endpoint unreachable — 3 consecutive empty responses (EMPTY_RESPONSE, h:1); this case was not attempted' } }),
      testCase, status: 'errored',
    }));
    expect(screen.getByTestId('inspector-agent-failure').textContent).toContain('Agent endpoint unreachable');
    unmount();
    render(h(TestCaseInspectorPanel, {
      report: report({ agentError: { stage: 'agent', kind: 'transport', code: 'ECONNREFUSED', message: 'ECONNREFUSED — connection refused while calling agent endpoint h:1: fetch failed' } }),
      testCase, status: 'errored',
    }));
    expect(screen.getByTestId('inspector-agent-failure').textContent).toContain('Agent request failed');
  });

  it('no reason line for a judged report', () => {
    render(h(TestCaseInspectorPanel, {
      report: report({ status: 'completed', metricsStatus: 'ready', passFailStatus: 'passed', agentError: undefined }),
      testCase, status: 'passed',
    }));
    expect(screen.getByText('PASSED')).toBeTruthy();
    expect(screen.queryByTestId('inspector-agent-failure')).toBeNull();
  });
});
