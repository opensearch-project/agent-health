/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `extractSpanIO` (the REAL export, not a copy) must recognise the current
 * semconv provider key `gen_ai.provider.name` everywhere it used to read only
 * the deprecated `gen_ai.system`: LLM category detection and the modelId
 * fallback.
 */

import { extractSpanIO } from '@/components/traces/SpanInputOutput';
import { Span } from '@/types';

function span(overrides: Partial<Span>): Span {
  return {
    traceId: 't1',
    spanId: 's1',
    name: 'some span',
    startTime: '2024-01-01T00:00:00Z',
    endTime: '2024-01-01T00:00:01Z',
    duration: 1000,
    status: 'OK',
    attributes: {},
    ...overrides,
  };
}

describe('extractSpanIO — GenAI provider key aliases', () => {
  it('detects the llm category from gen_ai.provider.name', () => {
    const io = extractSpanIO(span({ attributes: { 'gen_ai.provider.name': 'openai' } }));
    expect(io.category).toBe('llm');
  });

  it('still detects the llm category from the deprecated gen_ai.system', () => {
    const io = extractSpanIO(span({ attributes: { 'gen_ai.system': 'openai' } }));
    expect(io.category).toBe('llm');
  });

  it('uses gen_ai.provider.name as the modelId fallback when no model attribute is present', () => {
    const io = extractSpanIO(span({ name: 'llm call', attributes: { 'gen_ai.provider.name': 'anthropic' } }));
    expect(io.modelId).toBe('anthropic');
  });

  it('prefers the real model attribute over any provider key', () => {
    const io = extractSpanIO(span({
      name: 'llm call',
      attributes: { 'gen_ai.request.model': 'model-x', 'gen_ai.provider.name': 'anthropic' },
    }));
    expect(io.modelId).toBe('model-x');
  });

  it('does not classify a span with neither provider key as llm', () => {
    const io = extractSpanIO(span({ attributes: {} }));
    expect(io.category).toBe('other');
  });
});
