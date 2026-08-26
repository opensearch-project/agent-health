/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Rendered-output tests for issue #319 — the two span-detail components must
 * actually DISPLAY tool arguments/results carried on OTel GenAI span events
 * (`gen_ai.tool.message` / `gen_ai.choice`), not just read them internally.
 *
 * The span fixture mirrors the live Strands SDK `execute_tool add_to_cart`
 * span from the issue report: no argument/result attributes at all — the
 * data lives exclusively on events. Pre-fix, SpanDetailsPanel showed
 * "No input data available" and SimpleSpanAttributesTable rendered zero
 * event rows for exactly this span.
 */

import * as React from 'react';
import { render, screen } from '@testing-library/react';
import SpanDetailsPanel from '@/components/traces/SpanDetailsPanel';
import SimpleSpanAttributesTable from '@/components/traces/SimpleSpanAttributesTable';
import { Span } from '@/types';

jest.mock('@/components/traces/ContextWindowBar', () => ({
  __esModule: true,
  default: () => React.createElement('div', { 'data-testid': 'context-window-bar' }),
}));

jest.mock('@/components/traces/FormattedMessages', () => ({
  __esModule: true,
  default: () => React.createElement('div', { 'data-testid': 'formatted-messages' }),
}));

/** Live-shape Strands execute_tool span: I/O on events, NOT attributes. */
function strandsToolSpan(): Span {
  return {
    traceId: 'trace-strands-1',
    spanId: 'span-tool-1',
    name: 'execute_tool add_to_cart',
    startTime: '2026-06-19T09:00:00Z',
    endTime: '2026-06-19T09:00:01Z',
    duration: 1000,
    status: 'OK',
    attributes: {
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': 'add_to_cart',
      'gen_ai.tool.call.id': 'tooluse_WnEEnNKK',
      'gen_ai.tool.status': 'success',
    },
    events: [
      {
        name: 'gen_ai.tool.message',
        time: '2026-06-19T09:00:00.100Z',
        attributes: {
          role: 'tool',
          id: 'tooluse_WnEEnNKK',
          content: '{"quantity":1,"product_id":"PROD-001"}',
        },
      },
      {
        name: 'gen_ai.choice',
        time: '2026-06-19T09:00:00.900Z',
        attributes: {
          id: 'tooluse_WnEEnNKK',
          message: '[{"json":{"cart_id":"default","items":[{"product_id":"PROD-001","quantity":1}],"total":79.99}}]',
        },
      },
    ],
  };
}

describe('SpanDetailsPanel — tool I/O from span events (#319)', () => {
  it('renders the tool arguments from the gen_ai.tool.message event as INPUT', () => {
    render(React.createElement(SpanDetailsPanel, { span: strandsToolSpan(), onClose: jest.fn() }));

    // Pre-fix this said "No input data available for this span".
    expect(screen.queryByText(/No input data available/i)).toBeNull();
    // The arguments JSON (pretty-printed) is visible (input pane, and the
    // result echoes the product id in the output pane too).
    expect(screen.getAllByText(/PROD-001/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/quantity/).length).toBeGreaterThanOrEqual(1);
  });

  it('renders the tool result from the gen_ai.choice event as OUTPUT', () => {
    render(React.createElement(SpanDetailsPanel, { span: strandsToolSpan(), onClose: jest.fn() }));

    expect(screen.queryByText(/No output data available/i)).toBeNull();
    expect(screen.getAllByText(/79\.99/).length).toBeGreaterThanOrEqual(1);
  });

  it('prefers the spec attributes when both attributes and events are present', () => {
    const span = strandsToolSpan();
    span.attributes!['gen_ai.tool.call.arguments'] = '{"from":"attribute"}';
    const { container } = render(React.createElement(SpanDetailsPanel, { span, onClose: jest.fn() }));

    // Spec attribute wins over the event content in the INPUT pane
    expect(container.textContent).toContain('attribute');
    expect(container.textContent).not.toContain('PROD-001-not-there');
  });

  it('does not render event-derived I/O for a span with no I/O anywhere', () => {
    const span = strandsToolSpan();
    span.events = [];
    span.attributes = { 'gen_ai.tool.name': 'add_to_cart' };
    const { container } = render(React.createElement(SpanDetailsPanel, { span, onClose: jest.fn() }));

    // No tool arguments/result anywhere on the span → nothing I/O-shaped
    // rendered (sections stay collapsed with no data).
    expect(container.textContent).not.toContain('PROD-001');
    expect(container.textContent).not.toContain('79.99');
  });
});

describe('SimpleSpanAttributesTable — span events folded into the table (#319)', () => {
  it('renders event fields as <event-name>.<field> rows alongside attributes', () => {
    render(React.createElement(SimpleSpanAttributesTable, { span: strandsToolSpan() }));

    // Attribute rows still present
    expect(screen.getByText('gen_ai.tool.name')).toBeTruthy();
    // Event rows folded in with the <event>.<field> key convention
    expect(screen.getByText('gen_ai.tool.message.content')).toBeTruthy();
    expect(screen.getByText('gen_ai.choice.message')).toBeTruthy();
    // Event VALUES (the actual tool I/O) are rendered
    expect(screen.getAllByText(/PROD-001/).length).toBeGreaterThanOrEqual(1);
  });

  it('the header count includes event fields, not just attributes', () => {
    render(React.createElement(SimpleSpanAttributesTable, { span: strandsToolSpan() }));

    // 4 attributes + 3 gen_ai.tool.message fields + 2 gen_ai.choice fields = 9
    expect(screen.getByText(/9 attributes/)).toBeTruthy();
  });

  it('renders duplicate-named events without dropping rows', () => {
    const span = strandsToolSpan();
    span.events = [
      { name: 'gen_ai.choice', time: '2026-06-19T09:00:00.5Z', attributes: { message: 'first' } },
      { name: 'gen_ai.choice', time: '2026-06-19T09:00:00.9Z', attributes: { message: 'second' } },
    ];
    render(React.createElement(SimpleSpanAttributesTable, { span }));

    // Both event instances appear even though the flattened key collides.
    expect(screen.getAllByText('gen_ai.choice.message').length).toBe(2);
    expect(screen.getByText('first')).toBeTruthy();
    expect(screen.getByText('second')).toBeTruthy();
  });

  it('renders a plain attributes-only span unchanged (no events)', () => {
    const span: Span = {
      traceId: 't', spanId: 's', name: 'plain-span',
      startTime: '2026-06-19T09:00:00Z', endTime: '2026-06-19T09:00:01Z',
      status: 'OK', attributes: { 'service.name': 'my-agent' },
    };
    render(React.createElement(SimpleSpanAttributesTable, { span }));

    expect(screen.getByText('service.name')).toBeTruthy();
    expect(screen.getByText(/1 attribute\b/)).toBeTruthy();
  });
});
