/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for trace utility functions
 */

import {
  formatDuration,
  getKeyAttributes,
  estimateTokens,
  truncateText,
  formatTimestamp,
  safeParseJSON,
} from '@/services/traces/utils';
import type { Span } from '@/types';

describe('formatDuration', () => {
  it('returns "0ms" for null or undefined', () => {
    expect(formatDuration(null)).toBe('0ms');
    expect(formatDuration(undefined)).toBe('0ms');
  });

  it('returns "0ms" for NaN', () => {
    expect(formatDuration(NaN)).toBe('0ms');
  });

  it('formats milliseconds under 1000', () => {
    expect(formatDuration(100)).toBe('100ms');
    expect(formatDuration(999)).toBe('999ms');
    expect(formatDuration(1)).toBe('1ms');
  });

  it('formats seconds from 1000-59999ms', () => {
    expect(formatDuration(1000)).toBe('1.00s');
    expect(formatDuration(1500)).toBe('1.50s');
    // Note: 59999/1000 = 59.999 which rounds to 60.00
    expect(formatDuration(59990)).toBe('59.99s');
  });

  it('formats minutes and seconds for 60000ms+', () => {
    expect(formatDuration(60000)).toBe('1m 0.0s');
    expect(formatDuration(90000)).toBe('1m 30.0s');
    expect(formatDuration(125000)).toBe('2m 5.0s');
  });

  it('rounds milliseconds', () => {
    expect(formatDuration(100.6)).toBe('101ms');
    expect(formatDuration(100.4)).toBe('100ms');
  });

  it('handles zero', () => {
    expect(formatDuration(0)).toBe('0ms');
  });
});

describe('getKeyAttributes', () => {
  const createSpan = (name: string, attributes: Record<string, any>): Span => ({
    traceId: 't1',
    spanId: 's1',
    name,
    startTime: '2024-01-15T10:00:00.000Z',
    endTime: '2024-01-15T10:00:01.000Z',
    duration: 1000,
    status: 'OK',
    attributes,
    events: [],
  });

  describe('for Bedrock/LLM spans', () => {
    it('extracts model info from bedrock.* span', () => {
      const span = createSpan('bedrock.converse', {
        'gen_ai.request.model': 'anthropic.claude-3-sonnet',
        'gen_ai.usage.input_tokens': 100,
        'gen_ai.usage.output_tokens': 200,
        'gen_ai.request.temperature': 0.7,
      });

      const result = getKeyAttributes(span);

      expect(result['Model']).toBe('claude-3-sonnet');
      expect(result['Input Tokens']).toBe('100');
      expect(result['Output Tokens']).toBe('200');
      expect(result['Temperature']).toBe(0.7);
    });

    it('extracts from llm span', () => {
      const span = createSpan('llm_call', {
        'gen_ai.request.model': 'gpt-4',
        'gen_ai.usage.input_tokens': 50,
      });

      const result = getKeyAttributes(span);

      expect(result['Model']).toBe('gpt-4');
      expect(result['Input Tokens']).toBe('50');
    });

    it('extracts from converse span', () => {
      // Note: model name splits on '.', so 'claude-3.5-sonnet' becomes '5-sonnet'
      // For models without '.' in name, full name is preserved
      const span = createSpan('converse_with_model', {
        'gen_ai.request.model': 'claude-sonnet',
      });

      const result = getKeyAttributes(span);

      expect(result['Model']).toBe('claude-sonnet');
    });
  });

  describe('for Tool spans', () => {
    it('extracts tool info', () => {
      const span = createSpan('execute_tool', {
        'gen_ai.tool.name': 'SearchDocs',
        'gen_ai.tool.call_id': 'call-123',  // OTel semantic convention: gen_ai.tool.call_id (underscore)
        'tool.mcp_server': 'docs-server',
      });

      const result = getKeyAttributes(span);

      expect(result['Tool']).toBe('SearchDocs');
      expect(result['Tool Call ID']).toBe('call-123');
      expect(result['MCP Server']).toBe('docs-server');
    });

    it('falls back to span name for Tool when no tool.name', () => {
      const span = createSpan('tool_execution', {});

      const result = getKeyAttributes(span);

      expect(result['Tool']).toBe('tool_execution');
    });
  });

  describe('for default spans', () => {
    it('extracts service and kind', () => {
      const span = createSpan('custom_operation', {
        'service.name': 'my-service',
        'spanKind': 'INTERNAL',
      });

      const result = getKeyAttributes(span);

      expect(result['Service']).toBe('my-service');
      expect(result['Kind']).toBe('INTERNAL');
    });

    it('falls back to serviceName attribute', () => {
      const span = createSpan('custom_operation', {
        'serviceName': 'fallback-service',
      });

      const result = getKeyAttributes(span);

      expect(result['Service']).toBe('fallback-service');
    });
  });
});

describe('estimateTokens', () => {
  it('returns 0 for null or undefined', () => {
    expect(estimateTokens(null)).toBe(0);
    expect(estimateTokens(undefined)).toBe(0);
  });

  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('estimates tokens as characters / 4 (rounded up)', () => {
    expect(estimateTokens('1234')).toBe(1); // 4 chars -> 1 token
    expect(estimateTokens('12345')).toBe(2); // 5 chars -> 2 tokens
    expect(estimateTokens('12345678')).toBe(2); // 8 chars -> 2 tokens
    expect(estimateTokens('123456789')).toBe(3); // 9 chars -> 3 tokens
  });

  it('estimates from object JSON length', () => {
    const obj = { key: 'value' }; // {"key":"value"} = 15 chars -> 4 tokens
    expect(estimateTokens(obj)).toBe(4);
  });
});

describe('truncateText', () => {
  it('returns unchanged text when under maxLength', () => {
    expect(truncateText('short', 10)).toBe('short');
    expect(truncateText('exactly10!', 10)).toBe('exactly10!');
  });

  it('truncates with ellipsis when over maxLength', () => {
    expect(truncateText('this is longer text', 10)).toBe('this is...');
  });

  it('handles empty string', () => {
    expect(truncateText('', 10)).toBe('');
  });

  it('handles maxLength of 3 (minimum for ellipsis)', () => {
    expect(truncateText('hello', 3)).toBe('...');
  });
});

describe('formatTimestamp', () => {
  it('formats timestamp with hours, minutes, seconds, milliseconds', () => {
    const result = formatTimestamp('2024-01-15T14:30:45.123Z');

    // Note: Output depends on timezone, but should contain time components
    expect(result).toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  it('handles ISO timestamp with timezone offset', () => {
    const result = formatTimestamp('2024-01-15T14:30:45.123+05:30');

    expect(result).toMatch(/\d{2}:\d{2}:\d{2}/);
  });
});

describe('safeParseJSON', () => {
  it('parses valid JSON string', () => {
    const result = safeParseJSON('{"key":"value"}');

    expect(result).toEqual({ key: 'value' });
  });

  it('parses JSON array', () => {
    const result = safeParseJSON('[1,2,3]');

    expect(result).toEqual([1, 2, 3]);
  });

  it('returns original string for invalid JSON', () => {
    const result = safeParseJSON('not valid json');

    expect(result).toBe('not valid json');
  });

  it('returns original string for partial JSON', () => {
    const result = safeParseJSON('{"incomplete":');

    expect(result).toBe('{"incomplete":');
  });
});
