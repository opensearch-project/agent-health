/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for SpanInputOutput component - input/output extraction from OTEL span attributes
 */

import { Span } from '@/types';

// Replicate the extraction logic from SpanInputOutput component for testing
interface SpanIOData {
  span: Span;
  category: 'agent' | 'llm' | 'tool' | 'other';
  input: string | null;
  output: string | null;
  toolName?: string;
  modelId?: string;
}

function getEventContent(span: Span, eventName: string): string | null {
  if (!span.events) return null;
  const event = span.events.find(e => e.name === eventName);
  if (!event?.attributes) return null;
  const value = event.attributes['content'] ||
                event.attributes['body'] ||
                event.attributes['gen_ai.content'] ||
                event.attributes['message'];
  if (!value) return null;
  return typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
}

function getToolPartFromMessages(
  raw: unknown,
  partType: 'tool_call' | 'tool_call_response',
  field: 'arguments' | 'result',
): string | null {
  if (!raw) return null;
  let messages: unknown = raw;
  if (typeof messages === 'string') {
    try {
      messages = JSON.parse(messages);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(messages)) return null;
  for (const msg of messages) {
    const parts = (msg as any)?.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (part?.type === partType && part[field] !== undefined && part[field] !== null) {
        const v = part[field];
        return typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v);
      }
    }
  }
  return null;
}

function extractSpanIO(span: Span): SpanIOData {
  const attrs = span.attributes || {};
  const name = span.name.toLowerCase();

  // Determine category
  let category: SpanIOData['category'] = 'other';
  if (name.includes('agent') || attrs['gen_ai.agent.name']) {
    category = 'agent';
  } else if (name.includes('llm') || name.includes('bedrock') || name.includes('converse') || attrs['gen_ai.system']) {
    category = 'llm';
  } else if (name.includes('tool') || attrs['gen_ai.tool.name']) {
    category = 'tool';
  }

  // Extract input based on category and OTEL conventions
  let input: string | null = null;
  let output: string | null = null;

  // LLM spans - check span events first (standard OTel), then attributes
  if (category === 'llm') {
    input = getEventContent(span, 'gen_ai.content.prompt') ||
            attrs['gen_ai.input.messages'] ||
            attrs['gen_ai.prompt'] ||
            attrs['gen_ai.prompt.0.content'] ||
            attrs['llm.prompts'] ||
            attrs['llm.input_messages'] ||
            attrs['input.value'] ||
            null;

    output = getEventContent(span, 'gen_ai.content.completion') ||
             attrs['gen_ai.output.messages'] ||
             attrs['gen_ai.completion'] ||
             attrs['gen_ai.completion.0.content'] ||
             attrs['llm.completions'] ||
             attrs['llm.output_messages'] ||
             attrs['output.value'] ||
             null;
  }

  // Tool spans — mirrors the component (issue #319): spec attributes,
  // then event convention (gen_ai.tool.message / gen_ai.choice), then
  // structured message attributes, then vendor-compat fallbacks.
  if (category === 'tool') {
    input = attrs['gen_ai.tool.call.arguments'] ||
            getEventContent(span, 'gen_ai.tool.message') ||
            getToolPartFromMessages(attrs['gen_ai.input.messages'], 'tool_call', 'arguments') ||
            getEventContent(span, 'gen_ai.tool.input') ||
            attrs['gen_ai.tool.input'] ||
            attrs['tool.input'] ||
            attrs['input.value'] ||
            attrs['tool.parameters'] ||
            null;

    output = attrs['gen_ai.tool.call.result'] ||
             getEventContent(span, 'gen_ai.choice') ||
             getToolPartFromMessages(attrs['gen_ai.output.messages'], 'tool_call_response', 'result') ||
             getEventContent(span, 'gen_ai.tool.output') ||
             attrs['gen_ai.tool.output'] ||
             attrs['tool.output'] ||
             attrs['output.value'] ||
             attrs['tool.result'] ||
             null;
  }

  // Agent spans - check events then attributes
  if (category === 'agent') {
    input = getEventContent(span, 'gen_ai.content.prompt') ||
            attrs['gen_ai.input.messages'] ||
            attrs['gen_ai.agent.input'] ||
            attrs['agent.input'] ||
            attrs['input.value'] ||
            attrs['user.message'] ||
            null;

    output = getEventContent(span, 'gen_ai.content.completion') ||
             attrs['gen_ai.output.messages'] ||
             attrs['gen_ai.agent.output'] ||
             attrs['agent.output'] ||
             attrs['output.value'] ||
             attrs['assistant.message'] ||
             null;
  }

  // Generic fallback
  if (!input) {
    input = attrs['input'] || attrs['request'] || attrs['message'] || null;
  }
  if (!output) {
    output = attrs['output'] || attrs['response'] || attrs['result'] || null;
  }

  // Convert objects to JSON string
  if (input && typeof input === 'object') {
    input = JSON.stringify(input, null, 2);
  }
  if (output && typeof output === 'object') {
    output = JSON.stringify(output, null, 2);
  }

  return {
    span,
    category,
    input: input as string | null,
    output: output as string | null,
    toolName: attrs['gen_ai.tool.name'] || attrs['tool.name'],
    modelId: attrs['gen_ai.request.model'] || attrs['llm.model_name'] || attrs['gen_ai.system'],
  };
}

// Helper to create test spans
function createSpan(overrides: Partial<Span> = {}): Span {
  return {
    spanId: 'test-span-id',
    traceId: 'test-trace-id',
    name: overrides.name || 'test-span',
    startTime: '2024-01-01T00:00:00Z',
    endTime: '2024-01-01T00:00:01Z',
    status: 'OK',
    attributes: overrides.attributes || {},
    ...overrides,
  };
}

describe('SpanInputOutput - extractSpanIO', () => {
  describe('category detection', () => {
    it('detects agent category from span name', () => {
      const span = createSpan({ name: 'agent.run' });
      const result = extractSpanIO(span);
      expect(result.category).toBe('agent');
    });

    it('detects agent category from attribute', () => {
      const span = createSpan({
        name: 'some-span',
        attributes: { 'gen_ai.agent.name': 'my-agent' },
      });
      const result = extractSpanIO(span);
      expect(result.category).toBe('agent');
    });

    it('detects llm category from span name', () => {
      const spans = [
        createSpan({ name: 'llm.call' }),
        createSpan({ name: 'bedrock.invoke' }),
        createSpan({ name: 'converse.api' }),
      ];

      spans.forEach(span => {
        const result = extractSpanIO(span);
        expect(result.category).toBe('llm');
      });
    });

    it('detects llm category from gen_ai.system attribute', () => {
      const span = createSpan({
        name: 'some-span',
        attributes: { 'gen_ai.system': 'openai' },
      });
      const result = extractSpanIO(span);
      expect(result.category).toBe('llm');
    });

    it('detects tool category from span name', () => {
      const span = createSpan({ name: 'tool.execute' });
      const result = extractSpanIO(span);
      expect(result.category).toBe('tool');
    });

    it('detects tool category from gen_ai.tool.name attribute', () => {
      const span = createSpan({
        name: 'some-span',
        attributes: { 'gen_ai.tool.name': 'search_tool' },
      });
      const result = extractSpanIO(span);
      expect(result.category).toBe('tool');
    });

    it('defaults to other category', () => {
      const span = createSpan({ name: 'random-span' });
      const result = extractSpanIO(span);
      expect(result.category).toBe('other');
    });
  });

  describe('LLM input/output extraction', () => {
    it('extracts gen_ai.prompt and gen_ai.completion', () => {
      const span = createSpan({
        name: 'llm.call',
        attributes: {
          'gen_ai.prompt': 'Hello, how are you?',
          'gen_ai.completion': 'I am doing well, thank you!',
        },
      });

      const result = extractSpanIO(span);
      expect(result.input).toBe('Hello, how are you?');
      expect(result.output).toBe('I am doing well, thank you!');
    });

    it('extracts llm.prompts and llm.completions', () => {
      const span = createSpan({
        name: 'llm.call',
        attributes: {
          'llm.prompts': 'User prompt',
          'llm.completions': 'Assistant response',
        },
      });

      const result = extractSpanIO(span);
      expect(result.input).toBe('User prompt');
      expect(result.output).toBe('Assistant response');
    });

    it('extracts input.value and output.value', () => {
      const span = createSpan({
        name: 'llm.call',
        attributes: {
          'input.value': 'Input text',
          'output.value': 'Output text',
        },
      });

      const result = extractSpanIO(span);
      expect(result.input).toBe('Input text');
      expect(result.output).toBe('Output text');
    });

    it('extracts model ID', () => {
      const span = createSpan({
        name: 'llm.call',
        attributes: {
          'gen_ai.request.model': 'claude-3-sonnet',
        },
      });

      const result = extractSpanIO(span);
      expect(result.modelId).toBe('claude-3-sonnet');
    });
  });

  describe('Tool input/output extraction', () => {
    it('extracts gen_ai.tool.input and gen_ai.tool.output', () => {
      const span = createSpan({
        name: 'tool.execute',
        attributes: {
          'gen_ai.tool.name': 'search',
          'gen_ai.tool.input': '{"query": "test"}',
          'gen_ai.tool.output': '{"results": []}',
        },
      });

      const result = extractSpanIO(span);
      expect(result.input).toBe('{"query": "test"}');
      expect(result.output).toBe('{"results": []}');
      expect(result.toolName).toBe('search');
    });

    it('extracts tool.input and tool.output', () => {
      const span = createSpan({
        name: 'tool.execute',
        attributes: {
          'tool.input': 'input data',
          'tool.output': 'output data',
        },
      });

      const result = extractSpanIO(span);
      expect(result.input).toBe('input data');
      expect(result.output).toBe('output data');
    });

    // Issue #319: the OTel GenAI event-based convention (what Strands emits)
    // stores arguments in a gen_ai.tool.message event and the result in a
    // gen_ai.choice event — neither is an attribute.
    it('extracts tool I/O from gen_ai.tool.message / gen_ai.choice span events (Strands)', () => {
      const span = createSpan({
        name: 'execute_tool add_to_cart',
        attributes: {
          'gen_ai.operation.name': 'execute_tool',
          'gen_ai.tool.name': 'add_to_cart',
          'gen_ai.tool.call.id': 'tooluse_abc',
        },
        events: [
          {
            name: 'gen_ai.tool.message',
            time: '2024-01-01T00:00:00.5Z',
            attributes: { role: 'tool', id: 'tooluse_abc', content: '{"quantity":1,"product_id":"PROD-001"}' },
          },
          {
            name: 'gen_ai.choice',
            time: '2024-01-01T00:00:00.9Z',
            attributes: { id: 'tooluse_abc', message: '[{"json":{"cart_id":"default","total":79.99}}]' },
          },
        ],
      });

      const result = extractSpanIO(span);
      expect(result.category).toBe('tool');
      expect(result.input).toBe('{"quantity":1,"product_id":"PROD-001"}');
      expect(result.output).toBe('[{"json":{"cart_id":"default","total":79.99}}]');
    });

    it('prefers spec attributes gen_ai.tool.call.arguments/.result over events', () => {
      const span = createSpan({
        name: 'execute_tool search',
        attributes: {
          'gen_ai.tool.name': 'search',
          'gen_ai.tool.call.arguments': '{"q":"attr wins"}',
          'gen_ai.tool.call.result': '{"hits":1}',
        },
        events: [
          { name: 'gen_ai.tool.message', time: '2024-01-01T00:00:00.5Z', attributes: { content: '{"q":"event"}' } },
          { name: 'gen_ai.choice', time: '2024-01-01T00:00:00.9Z', attributes: { message: '{"hits":0}' } },
        ],
      });

      const result = extractSpanIO(span);
      expect(result.input).toBe('{"q":"attr wins"}');
      expect(result.output).toBe('{"hits":1}');
    });

    it('extracts tool I/O from gen_ai.input/output.messages tool_call parts', () => {
      const span = createSpan({
        name: 'execute_tool lookup',
        attributes: {
          'gen_ai.tool.name': 'lookup',
          'gen_ai.input.messages': JSON.stringify([
            { role: 'assistant', parts: [{ type: 'tool_call', id: 'c1', name: 'lookup', arguments: { key: 'k1' } }] },
          ]),
          'gen_ai.output.messages': JSON.stringify([
            { role: 'tool', parts: [{ type: 'tool_call_response', id: 'c1', result: { value: 42 } }] },
          ]),
        },
      });

      const result = extractSpanIO(span);
      expect(result.input).toContain('"key": "k1"');
      expect(result.output).toContain('"value": 42');
    });

    it('extracts tool.parameters and tool.result', () => {
      const span = createSpan({
        name: 'tool.execute',
        attributes: {
          'tool.parameters': 'params',
          'tool.result': 'result',
        },
      });

      const result = extractSpanIO(span);
      expect(result.input).toBe('params');
      expect(result.output).toBe('result');
    });
  });

  describe('Agent input/output extraction', () => {
    it('extracts gen_ai.agent.input and gen_ai.agent.output', () => {
      const span = createSpan({
        name: 'agent.run',
        attributes: {
          'gen_ai.agent.input': 'User message',
          'gen_ai.agent.output': 'Agent response',
        },
      });

      const result = extractSpanIO(span);
      expect(result.input).toBe('User message');
      expect(result.output).toBe('Agent response');
    });

    it('extracts user.message and assistant.message', () => {
      const span = createSpan({
        name: 'agent.run',
        attributes: {
          'user.message': 'Hello',
          'assistant.message': 'Hi there!',
        },
      });

      const result = extractSpanIO(span);
      expect(result.input).toBe('Hello');
      expect(result.output).toBe('Hi there!');
    });
  });

  describe('fallback extraction', () => {
    it('falls back to generic input/output attributes', () => {
      const span = createSpan({
        name: 'random-span',
        attributes: {
          'input': 'generic input',
          'output': 'generic output',
        },
      });

      const result = extractSpanIO(span);
      expect(result.input).toBe('generic input');
      expect(result.output).toBe('generic output');
    });

    it('falls back to request/response attributes', () => {
      const span = createSpan({
        name: 'random-span',
        attributes: {
          'request': 'request data',
          'response': 'response data',
        },
      });

      const result = extractSpanIO(span);
      expect(result.input).toBe('request data');
      expect(result.output).toBe('response data');
    });
  });

  describe('object to JSON conversion', () => {
    it('converts object input to JSON string', () => {
      const span = createSpan({
        name: 'llm.call',
        attributes: {
          'gen_ai.prompt': { role: 'user', content: 'Hello' },
        },
      });

      const result = extractSpanIO(span);
      expect(result.input).toBe(JSON.stringify({ role: 'user', content: 'Hello' }, null, 2));
    });

    it('converts object output to JSON string', () => {
      const span = createSpan({
        name: 'llm.call',
        attributes: {
          'gen_ai.completion': { role: 'assistant', content: 'Hi' },
        },
      });

      const result = extractSpanIO(span);
      expect(result.output).toBe(JSON.stringify({ role: 'assistant', content: 'Hi' }, null, 2));
    });
  });

  describe('null handling', () => {
    it('returns null for missing input', () => {
      const span = createSpan({
        name: 'llm.call',
        attributes: {
          'gen_ai.completion': 'output only',
        },
      });

      const result = extractSpanIO(span);
      expect(result.input).toBeNull();
      expect(result.output).toBe('output only');
    });

    it('returns null for missing output', () => {
      const span = createSpan({
        name: 'llm.call',
        attributes: {
          'gen_ai.prompt': 'input only',
        },
      });

      const result = extractSpanIO(span);
      expect(result.input).toBe('input only');
      expect(result.output).toBeNull();
    });

    it('returns null for both when no attributes', () => {
      const span = createSpan({ name: 'llm.call' });

      const result = extractSpanIO(span);
      expect(result.input).toBeNull();
      expect(result.output).toBeNull();
    });
  });
});

describe('SpanInputOutput - filtering', () => {
  it('filters spans with input or output', () => {
    const spans = [
      createSpan({
        spanId: '1',
        name: 'llm.call',
        attributes: { 'gen_ai.prompt': 'input' },
      }),
      createSpan({
        spanId: '2',
        name: 'random',
        attributes: {},
      }),
      createSpan({
        spanId: '3',
        name: 'tool.exec',
        attributes: { 'gen_ai.tool.output': 'output' },
      }),
    ];

    const spanIOData = spans
      .map(extractSpanIO)
      .filter(data => data.input || data.output);

    expect(spanIOData).toHaveLength(2);
    expect(spanIOData[0].span.spanId).toBe('1');
    expect(spanIOData[1].span.spanId).toBe('3');
  });

  it('sorts by start time', () => {
    const spans = [
      createSpan({
        spanId: '3',
        name: 'llm.call',
        startTime: '2024-01-01T00:00:03Z',
        attributes: { 'gen_ai.prompt': 'c' },
      }),
      createSpan({
        spanId: '1',
        name: 'llm.call',
        startTime: '2024-01-01T00:00:01Z',
        attributes: { 'gen_ai.prompt': 'a' },
      }),
      createSpan({
        spanId: '2',
        name: 'llm.call',
        startTime: '2024-01-01T00:00:02Z',
        attributes: { 'gen_ai.prompt': 'b' },
      }),
    ];

    const spanIOData = spans
      .map(extractSpanIO)
      .filter(data => data.input || data.output)
      .sort((a, b) =>
        new Date(a.span.startTime).getTime() - new Date(b.span.startTime).getTime()
      );

    expect(spanIOData[0].span.spanId).toBe('1');
    expect(spanIOData[1].span.spanId).toBe('2');
    expect(spanIOData[2].span.spanId).toBe('3');
  });
});

describe('SpanInputOutput - category counts', () => {
  it('counts spans by category', () => {
    const spans = [
      createSpan({ name: 'agent.run', attributes: { 'gen_ai.agent.input': 'a' } }),
      createSpan({ name: 'llm.call', attributes: { 'gen_ai.prompt': 'b' } }),
      createSpan({ name: 'llm.call', attributes: { 'gen_ai.prompt': 'c' } }),
      createSpan({ name: 'tool.exec', attributes: { 'gen_ai.tool.name': 't1', 'gen_ai.tool.input': 'd' } }),
      createSpan({ name: 'tool.exec', attributes: { 'gen_ai.tool.name': 't2', 'gen_ai.tool.input': 'e' } }),
      createSpan({ name: 'tool.exec', attributes: { 'gen_ai.tool.name': 't3', 'gen_ai.tool.input': 'f' } }),
    ];

    const spanIOData = spans.map(extractSpanIO);
    const categoryCounts = spanIOData.reduce(
      (acc, data) => {
        acc[data.category]++;
        return acc;
      },
      { agent: 0, llm: 0, tool: 0, other: 0 } as Record<string, number>
    );

    expect(categoryCounts.agent).toBe(1);
    expect(categoryCounts.llm).toBe(2);
    expect(categoryCounts.tool).toBe(3);
    expect(categoryCounts.other).toBe(0);
  });
});

describe('SpanInputOutput - OTel span event extraction', () => {
  it('extracts LLM input/output from gen_ai.content.prompt/completion span events', () => {
    const span = createSpan({
      name: 'llm.call',
      attributes: { 'gen_ai.system': 'openai' },
      events: [
        { name: 'gen_ai.content.prompt', time: '2024-01-01T00:00:00Z', attributes: { content: 'What is the weather?' } },
        { name: 'gen_ai.content.completion', time: '2024-01-01T00:00:01Z', attributes: { content: 'The weather is sunny.' } },
      ],
    });

    const result = extractSpanIO(span);
    expect(result.input).toBe('What is the weather?');
    expect(result.output).toBe('The weather is sunny.');
  });

  it('prefers span events over attributes for LLM spans', () => {
    const span = createSpan({
      name: 'llm.call',
      attributes: {
        'gen_ai.system': 'openai',
        'gen_ai.prompt': 'attribute prompt',
      },
      events: [
        { name: 'gen_ai.content.prompt', time: '2024-01-01T00:00:00Z', attributes: { content: 'event prompt' } },
      ],
    });

    const result = extractSpanIO(span);
    expect(result.input).toBe('event prompt');
  });

  it('extracts from event body attribute', () => {
    const span = createSpan({
      name: 'llm.call',
      attributes: { 'gen_ai.system': 'aws_bedrock' },
      events: [
        { name: 'gen_ai.content.prompt', time: '2024-01-01T00:00:00Z', attributes: { body: 'prompt from body' } },
      ],
    });

    const result = extractSpanIO(span);
    expect(result.input).toBe('prompt from body');
  });

  it('extracts tool input/output from span events', () => {
    const span = createSpan({
      name: 'tool.execute',
      attributes: { 'gen_ai.tool.name': 'search' },
      events: [
        { name: 'gen_ai.tool.input', time: '2024-01-01T00:00:00Z', attributes: { content: '{"query": "errors"}' } },
        { name: 'gen_ai.tool.output', time: '2024-01-01T00:00:01Z', attributes: { content: '{"count": 5}' } },
      ],
    });

    const result = extractSpanIO(span);
    expect(result.input).toBe('{"query": "errors"}');
    expect(result.output).toBe('{"count": 5}');
  });

  it('extracts agent input/output from gen_ai.content events', () => {
    const span = createSpan({
      name: 'agent.run',
      attributes: { 'gen_ai.agent.name': 'rca-agent' },
      events: [
        { name: 'gen_ai.content.prompt', time: '2024-01-01T00:00:00Z', attributes: { content: 'Analyze this error' } },
        { name: 'gen_ai.content.completion', time: '2024-01-01T00:00:01Z', attributes: { content: 'Root cause found' } },
      ],
    });

    const result = extractSpanIO(span);
    expect(result.input).toBe('Analyze this error');
    expect(result.output).toBe('Root cause found');
  });

  it('handles events with no matching attributes gracefully', () => {
    const span = createSpan({
      name: 'llm.call',
      attributes: { 'gen_ai.system': 'openai' },
      events: [
        { name: 'gen_ai.content.prompt', time: '2024-01-01T00:00:00Z', attributes: { unrelated: 'value' } },
      ],
    });

    const result = extractSpanIO(span);
    expect(result.input).toBeNull();
  });

  it('handles spans with empty events array', () => {
    const span = createSpan({
      name: 'llm.call',
      attributes: { 'gen_ai.system': 'openai' },
      events: [],
    });

    const result = extractSpanIO(span);
    expect(result.input).toBeNull();
    expect(result.output).toBeNull();
  });

  it('serializes object content from events to JSON', () => {
    const span = createSpan({
      name: 'llm.call',
      attributes: { 'gen_ai.system': 'openai' },
      events: [
        { name: 'gen_ai.content.prompt', time: '2024-01-01T00:00:00Z', attributes: { content: { role: 'user', text: 'Hello' } } },
      ],
    });

    const result = extractSpanIO(span);
    expect(result.input).toBe(JSON.stringify({ role: 'user', text: 'Hello' }, null, 2));
  });
});

describe('SpanInputOutput - gen_ai.input/output.messages attributes', () => {
  it('extracts gen_ai.input.messages and gen_ai.output.messages for LLM spans', () => {
    const span = createSpan({
      name: 'llm.call',
      attributes: {
        'gen_ai.system': 'anthropic',
        'gen_ai.input.messages': '[{"role":"user","content":"Hello"}]',
        'gen_ai.output.messages': '[{"role":"assistant","content":"Hi there"}]',
      },
    });

    const result = extractSpanIO(span);
    expect(result.input).toBe('[{"role":"user","content":"Hello"}]');
    expect(result.output).toBe('[{"role":"assistant","content":"Hi there"}]');
  });

  it('extracts gen_ai.input.messages for agent spans', () => {
    const span = createSpan({
      name: 'agent.run',
      attributes: {
        'gen_ai.agent.name': 'my-agent',
        'gen_ai.input.messages': 'User query here',
        'gen_ai.output.messages': 'Agent response here',
      },
    });

    const result = extractSpanIO(span);
    expect(result.input).toBe('User query here');
    expect(result.output).toBe('Agent response here');
  });

  it('prefers span events over gen_ai.input.messages', () => {
    const span = createSpan({
      name: 'llm.call',
      attributes: {
        'gen_ai.system': 'openai',
        'gen_ai.input.messages': 'attribute messages',
      },
      events: [
        { name: 'gen_ai.content.prompt', time: '2024-01-01T00:00:00Z', attributes: { content: 'event content' } },
      ],
    });

    const result = extractSpanIO(span);
    expect(result.input).toBe('event content');
  });

  it('prefers gen_ai.input.messages over legacy gen_ai.prompt', () => {
    const span = createSpan({
      name: 'llm.call',
      attributes: {
        'gen_ai.system': 'openai',
        'gen_ai.input.messages': 'new style messages',
        'gen_ai.prompt': 'legacy prompt',
      },
    });

    const result = extractSpanIO(span);
    expect(result.input).toBe('new style messages');
  });
});

describe('SpanInputOutput - OTel standard tool attributes', () => {
  it('extracts gen_ai.tool.call.arguments and gen_ai.tool.call.result', () => {
    const span = createSpan({
      name: 'tool.execute',
      attributes: {
        'gen_ai.tool.name': 'search_logs',
        'gen_ai.tool.call.arguments': '{"query": "error", "timeRange": "1h"}',
        'gen_ai.tool.call.result': '{"matches": 42}',
      },
    });

    const result = extractSpanIO(span);
    expect(result.input).toBe('{"query": "error", "timeRange": "1h"}');
    expect(result.output).toBe('{"matches": 42}');
  });

  it('prefers gen_ai.tool.call.arguments over legacy gen_ai.tool.input', () => {
    const span = createSpan({
      name: 'tool.execute',
      attributes: {
        'gen_ai.tool.name': 'search',
        'gen_ai.tool.call.arguments': 'standard args',
        'gen_ai.tool.input': 'legacy input',
      },
    });

    const result = extractSpanIO(span);
    expect(result.input).toBe('standard args');
  });

  it('prefers gen_ai.tool.call.result over legacy gen_ai.tool.output', () => {
    const span = createSpan({
      name: 'tool.execute',
      attributes: {
        'gen_ai.tool.name': 'search',
        'gen_ai.tool.call.result': 'standard result',
        'gen_ai.tool.output': 'legacy output',
      },
    });

    const result = extractSpanIO(span);
    expect(result.output).toBe('standard result');
  });
});
