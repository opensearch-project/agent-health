/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Rendered-output tests for the OTel Compliance section of SpanDetailsPanel.
 *
 * Regression: LLM spans carrying the current semconv provider key
 * `gen_ai.provider.name` (semconv >= 1.37; `gen_ai.system` is deprecated)
 * were flagged "1 missing" because compliance required `gen_ai.system`.
 */

import * as React from 'react';
import { render } from '@testing-library/react';
import SpanDetailsPanel from '@/components/traces/SpanDetailsPanel';
import { categorizeSpan } from '@/services/traces/spanCategorization';
import { Span } from '@/types';

jest.mock('@/components/traces/ContextWindowBar', () => ({
  __esModule: true,
  default: () => React.createElement('div', { 'data-testid': 'context-window-bar' }),
}));

jest.mock('@/components/traces/FormattedMessages', () => ({
  __esModule: true,
  default: () => React.createElement('div', { 'data-testid': 'formatted-messages' }),
}));

function llmSpan(attributes: Record<string, any>): Span {
  return categorizeSpan({
    traceId: 'trace-1',
    spanId: 'span-llm',
    name: 'chat',
    startTime: '2026-06-19T09:00:00Z',
    endTime: '2026-06-19T09:00:01Z',
    duration: 1000,
    status: 'OK',
    attributes: {
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.model': 'some-model',
      ...attributes,
    },
    events: [],
  });
}

describe('SpanDetailsPanel — OTel Compliance with gen_ai.provider.name', () => {
  it('shows no compliance warning for an LLM span stamped with gen_ai.provider.name', () => {
    const { container } = render(
      React.createElement(SpanDetailsPanel, { span: llmSpan({ 'gen_ai.provider.name': 'openai' }), onClose: jest.fn() }),
    );
    expect(container.textContent).not.toContain('OTel Compliance');
    expect(container.textContent).not.toMatch(/\d+ missing/);
  });

  it('still accepts the deprecated gen_ai.system alias', () => {
    const { container } = render(
      React.createElement(SpanDetailsPanel, { span: llmSpan({ 'gen_ai.system': 'aws_bedrock' }), onClose: jest.fn() }),
    );
    expect(container.textContent).not.toContain('OTel Compliance');
  });

  it('names the preferred key with the deprecated alias when neither is present', () => {
    const { container } = render(
      React.createElement(SpanDetailsPanel, { span: llmSpan({}), onClose: jest.fn() }),
    );
    expect(container.textContent).toContain('OTel Compliance');
    expect(container.textContent).toContain('1 missing');
    expect(container.textContent).toContain('gen_ai.provider.name (or deprecated gen_ai.system)');
  });
});
