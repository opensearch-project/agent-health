/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Rendered-output tests for the Time Distribution panels: shares are SELF
 * time (nested children are not double-counted), the basis is labelled, and
 * the inclusive time is still available in the tooltip.
 */

import * as React from 'react';
import { render } from '@testing-library/react';
import TraceInfoView from '@/components/traces/TraceInfoView';
import { TimeDistributionBar, formatCategoryStatTitle } from '@/components/traces/TraceSummary';
import { calculateCategoryStats } from '@/services/traces/traceStats';
import { categorizeSpanTree } from '@/services/traces/spanCategorization';
import { flattenSpans } from '@/services/traces/traceStats';
import { Span } from '@/types';

const T0 = Date.parse('2026-06-19T09:00:00.000Z');
const iso = (ms: number) => new Date(T0 + ms).toISOString();

/**
 * Agent loop (10s) wrapping one chat (8s) and one tool (2s), back to back.
 * Inclusive summing would show AGENT 50% / LLM 40% / TOOL 10%; self time is
 * AGENT 0% / LLM 80% / TOOL 20%.
 */
function nestedTree(): Span[] {
  const tool: Span = {
    traceId: 't', spanId: 'tool', parentSpanId: 'agent', name: 'execute_tool search_products',
    startTime: iso(8000), endTime: iso(10000), duration: 2000, status: 'OK',
    attributes: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'search_products' },
  };
  const chat: Span = {
    traceId: 't', spanId: 'chat', parentSpanId: 'agent', name: 'chat',
    startTime: iso(0), endTime: iso(8000), duration: 8000, status: 'OK',
    attributes: { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'm', 'gen_ai.provider.name': 'p' },
  };
  const agent: Span = {
    traceId: 't', spanId: 'agent', name: 'invoke_agent retrieval-agent',
    startTime: iso(0), endTime: iso(10000), duration: 10000, status: 'OK',
    attributes: { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'retrieval-agent' },
    children: [chat, tool],
  };
  return [agent];
}

describe('TraceInfoView — Time Distribution uses self time', () => {
  it('labels the basis and shows self-time shares in the legend', () => {
    const { container, getByTestId } = render(React.createElement(TraceInfoView, { spanTree: nestedTree() }));

    expect(getByTestId('time-distribution-basis').textContent).toContain('self time');

    // LLM 80% (8.00s), TOOL 20% (2.00s), AGENT 0% — the wrapper's inclusive 10s
    // is NOT attributed to AGENT.
    expect(getByTestId('time-distribution-llm').textContent).toMatch(/80%\s*\(8\.00s\)/);
    expect(getByTestId('time-distribution-tool').textContent).toMatch(/20%\s*\(2\.00s\)/);
    expect(getByTestId('time-distribution-agent').textContent).toMatch(/0(\.0)?%\s*\(0ms\)/);

    // The header shows the trace wall-clock, not a sum of inclusive durations (20s pre-fix).
    expect(container.textContent).not.toContain('20.00s');
  });

  it('keeps the inclusive time in the tooltip when it differs from self time', () => {
    const { getByTestId } = render(React.createElement(TraceInfoView, { spanTree: nestedTree() }));
    const agentLegend = getByTestId('time-distribution-agent');
    expect(agentLegend.getAttribute('title')).toContain('0ms self');
    expect(agentLegend.getAttribute('title')).toContain('10.00s incl. children');
  });
});

describe('TimeDistributionBar (shared summary component)', () => {
  it('renders self-time shares and the basis label', () => {
    const flat = flattenSpans(categorizeSpanTree(nestedTree()));
    const stats = calculateCategoryStats(flat, 10000);
    const { container, getByTestId } = render(
      React.createElement(TimeDistributionBar, { stats, totalDuration: 10000 }),
    );
    expect(getByTestId('time-distribution-basis').textContent).toContain('self time');
    expect(container.textContent).toMatch(/LLM\s*80%\s*\(8\.00s\)/);
    expect(container.textContent).toMatch(/TOOL\s*20%\s*\(2\.00s\)/);
  });

  it('formatCategoryStatTitle omits the inclusive figure when it equals self time', () => {
    expect(formatCategoryStatTitle({ category: 'LLM', count: 1, totalDuration: 500, selfDuration: 500, percentage: 50 }))
      .toBe('LLM: 500ms self (50.0%)');
    expect(formatCategoryStatTitle({ category: 'AGENT', count: 1, totalDuration: 1000, selfDuration: 250, percentage: 25 }))
      .toBe('AGENT: 250ms self (25.0%) · 1.00s incl. children');
  });
});
