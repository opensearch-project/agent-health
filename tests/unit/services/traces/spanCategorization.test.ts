/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for spanCategorization.ts - span categorization and OTel compliance
 */

import { Span, CategorizedSpan, SpanCategory } from '@/types';
import {
  getCategoryMeta,
  getSpanCategory,
  buildDisplayName,
  categorizeSpan,
  categorizeSpans,
  categorizeSpanTree,
  filterSpansByCategory,
  filterSpanTreeByCategory,
  countByCategory,
  checkOTelCompliance,
  hasAnyWarnings,
} from '@/services/traces/spanCategorization';

// OTel attribute constants
const ATTR_GEN_AI_OPERATION_NAME = 'gen_ai.operation.name';
const ATTR_GEN_AI_AGENT_NAME = 'gen_ai.agent.name';
const ATTR_GEN_AI_TOOL_NAME = 'gen_ai.tool.name';
const ATTR_GEN_AI_REQUEST_MODEL = 'gen_ai.request.model';
const ATTR_GEN_AI_PROVIDER_NAME = 'gen_ai.provider.name';
const ATTR_GEN_AI_SYSTEM = 'gen_ai.system';

// Helper to create test spans
function createSpan(overrides: Partial<Span> & { spanId: string }): Span {
  return {
    spanId: overrides.spanId,
    traceId: 'test-trace',
    name: overrides.name || 'test-span',
    startTime: '2024-01-01T00:00:00Z',
    endTime: '2024-01-01T00:00:01Z',
    duration: 1000,
    status: overrides.status || 'OK',
    attributes: overrides.attributes || {},
    children: overrides.children,
  };
}

function createCategorizedSpan(
  overrides: Partial<CategorizedSpan> & { spanId: string; category: SpanCategory }
): CategorizedSpan {
  return {
    spanId: overrides.spanId,
    traceId: 'test-trace',
    name: overrides.name || 'test-span',
    displayName: overrides.displayName || overrides.name || 'test-span',
    startTime: '2024-01-01T00:00:00Z',
    endTime: '2024-01-01T00:00:01Z',
    duration: 1000,
    status: 'OK',
    category: overrides.category,
    categoryLabel: overrides.category,
    categoryColor: '#888888',
    categoryIcon: 'circle',
    attributes: overrides.attributes || {},
    children: overrides.children,
  };
}

describe('getCategoryMeta', () => {
  it('returns metadata for AGENT category', () => {
    const meta = getCategoryMeta('AGENT');
    expect(meta.label).toBe('Agent');
    expect(meta.icon).toBe('Bot');
    expect(meta.color).toContain('indigo');
  });

  it('returns metadata for LLM category', () => {
    const meta = getCategoryMeta('LLM');
    expect(meta.label).toBe('LLM');
    expect(meta.icon).toBe('Zap');
    expect(meta.color).toContain('purple');
  });

  it('returns metadata for TOOL category', () => {
    const meta = getCategoryMeta('TOOL');
    expect(meta.label).toBe('Tool');
    expect(meta.icon).toBe('Wrench');
    expect(meta.color).toContain('amber');
  });

  it('returns metadata for ERROR category', () => {
    const meta = getCategoryMeta('ERROR');
    expect(meta.label).toBe('Error');
    expect(meta.icon).toBe('AlertCircle');
    expect(meta.color).toContain('red');
  });

  it('returns metadata for OTHER category', () => {
    const meta = getCategoryMeta('OTHER');
    expect(meta.label).toBe('Other');
    expect(meta.icon).toBe('Circle');
    expect(meta.color).toContain('slate');
  });
});

describe('getSpanCategory', () => {
  describe('Error status precedence', () => {
    it('returns ERROR for spans with error status', () => {
      const span = createSpan({ spanId: '1', status: 'ERROR' });
      expect(getSpanCategory(span)).toBe('ERROR');
    });

    it('returns ERROR even with OTel attributes', () => {
      const span = createSpan({
        spanId: '1',
        status: 'ERROR',
        attributes: { [ATTR_GEN_AI_OPERATION_NAME]: 'chat' },
      });
      expect(getSpanCategory(span)).toBe('ERROR');
    });
  });

  describe('OTel operation name based categorization', () => {
    it('returns AGENT for create_agent operation', () => {
      const span = createSpan({
        spanId: '1',
        attributes: { [ATTR_GEN_AI_OPERATION_NAME]: 'create_agent' },
      });
      expect(getSpanCategory(span)).toBe('AGENT');
    });

    it('returns AGENT for invoke_agent operation', () => {
      const span = createSpan({
        spanId: '1',
        attributes: { [ATTR_GEN_AI_OPERATION_NAME]: 'invoke_agent' },
      });
      expect(getSpanCategory(span)).toBe('AGENT');
    });

    it('returns LLM for chat operation', () => {
      const span = createSpan({
        spanId: '1',
        attributes: { [ATTR_GEN_AI_OPERATION_NAME]: 'chat' },
      });
      expect(getSpanCategory(span)).toBe('LLM');
    });

    it('returns LLM for text_completion operation', () => {
      const span = createSpan({
        spanId: '1',
        attributes: { [ATTR_GEN_AI_OPERATION_NAME]: 'text_completion' },
      });
      expect(getSpanCategory(span)).toBe('LLM');
    });

    it('returns TOOL for execute_tool operation', () => {
      const span = createSpan({
        spanId: '1',
        attributes: { [ATTR_GEN_AI_OPERATION_NAME]: 'execute_tool' },
      });
      expect(getSpanCategory(span)).toBe('TOOL');
    });
  });

  describe('Name-based fallback categorization', () => {
    it('returns LLM for bedrock spans', () => {
      const span = createSpan({ spanId: '1', name: 'bedrock.converse' });
      expect(getSpanCategory(span)).toBe('LLM');
    });

    it('returns LLM for converse spans', () => {
      const span = createSpan({ spanId: '1', name: 'AWS Converse API' });
      expect(getSpanCategory(span)).toBe('LLM');
    });

    it('returns LLM for callmodel spans', () => {
      const span = createSpan({ spanId: '1', name: 'CallModel' });
      expect(getSpanCategory(span)).toBe('LLM');
    });

    it('returns TOOL for executetool spans', () => {
      const span = createSpan({ spanId: '1', name: 'ExecuteTool SearchDocs' });
      expect(getSpanCategory(span)).toBe('TOOL');
    });

    it('returns TOOL for tool.execute spans', () => {
      const span = createSpan({ spanId: '1', name: 'tool.execute GetMetrics' });
      expect(getSpanCategory(span)).toBe('TOOL');
    });

    it('returns AGENT for agent.run spans', () => {
      const span = createSpan({ spanId: '1', name: 'agent.run' });
      expect(getSpanCategory(span)).toBe('AGENT');
    });

    it('returns AGENT for invoke_agent spans', () => {
      const span = createSpan({ spanId: '1', name: 'invoke_agent' });
      expect(getSpanCategory(span)).toBe('AGENT');
    });

    it('returns AGENT for generateResponse spans', () => {
      const span = createSpan({ spanId: '1', name: 'GenerateResponse' });
      expect(getSpanCategory(span)).toBe('AGENT');
    });

    it('returns OTHER for unknown spans', () => {
      const span = createSpan({ spanId: '1', name: 'some_random_operation' });
      expect(getSpanCategory(span)).toBe('OTHER');
    });
  });

  it('handles undefined name gracefully', () => {
    const span = createSpan({ spanId: '1', name: undefined as unknown as string });
    expect(getSpanCategory(span)).toBe('OTHER');
  });
});

describe('buildDisplayName', () => {
  it('builds AGENT display name with agent name', () => {
    const span = createSpan({
      spanId: '1',
      name: 'MyAgent',
      attributes: {
        [ATTR_GEN_AI_OPERATION_NAME]: 'invoke_agent',
        [ATTR_GEN_AI_AGENT_NAME]: 'RCA-Agent',
      },
    });
    const name = buildDisplayName(span, 'AGENT');
    expect(name).toBe('invoke_agent RCA-Agent');
  });

  it('builds LLM display name with provider and model', () => {
    const span = createSpan({
      spanId: '1',
      attributes: {
        [ATTR_GEN_AI_OPERATION_NAME]: 'chat',
        [ATTR_GEN_AI_PROVIDER_NAME]: 'aws',
        [ATTR_GEN_AI_REQUEST_MODEL]: 'anthropic.claude-v2',
      },
    });
    const name = buildDisplayName(span, 'LLM');
    expect(name).toBe('chat aws claude-v2');
  });

  it('builds TOOL display name with tool name', () => {
    const span = createSpan({
      spanId: '1',
      name: 'SearchDocs',
      attributes: {
        [ATTR_GEN_AI_OPERATION_NAME]: 'execute_tool',
        [ATTR_GEN_AI_TOOL_NAME]: 'SearchDocsTool',
      },
    });
    const name = buildDisplayName(span, 'TOOL');
    expect(name).toBe('execute_tool SearchDocsTool');
  });

  it('returns span name for ERROR category', () => {
    const span = createSpan({ spanId: '1', name: 'error-span' });
    expect(buildDisplayName(span, 'ERROR')).toBe('error-span');
  });

  it('returns span name for OTHER category', () => {
    const span = createSpan({ spanId: '1', name: 'other-span' });
    expect(buildDisplayName(span, 'OTHER')).toBe('other-span');
  });

  it('falls back to span name when attributes missing', () => {
    const span = createSpan({ spanId: '1', name: 'fallback-name' });
    expect(buildDisplayName(span, 'LLM')).toBe('fallback-name');
  });
});

describe('categorizeSpan', () => {
  it('categorizes span with full metadata', () => {
    const span = createSpan({
      spanId: '1',
      name: 'test',
      attributes: { [ATTR_GEN_AI_OPERATION_NAME]: 'chat' },
    });
    const categorized = categorizeSpan(span);

    expect(categorized.category).toBe('LLM');
    expect(categorized.categoryLabel).toBe('LLM');
    expect(categorized.categoryColor).toContain('purple');
    expect(categorized.categoryIcon).toBe('Zap');
    expect(categorized.displayName).toBeDefined();
  });

  it('preserves original span properties', () => {
    const span = createSpan({
      spanId: 'test-id',
      name: 'original-name',
      attributes: { custom: 'value' },
    });
    const categorized = categorizeSpan(span);

    expect(categorized.spanId).toBe('test-id');
    expect(categorized.name).toBe('original-name');
    expect(categorized.attributes?.custom).toBe('value');
  });
});

describe('categorizeSpans', () => {
  it('categorizes array of spans', () => {
    const spans = [
      createSpan({ spanId: '1', attributes: { [ATTR_GEN_AI_OPERATION_NAME]: 'chat' } }),
      createSpan({ spanId: '2', attributes: { [ATTR_GEN_AI_OPERATION_NAME]: 'execute_tool' } }),
    ];
    const categorized = categorizeSpans(spans);

    expect(categorized).toHaveLength(2);
    expect(categorized[0].category).toBe('LLM');
    expect(categorized[1].category).toBe('TOOL');
  });

  it('returns empty array for empty input', () => {
    expect(categorizeSpans([])).toEqual([]);
  });
});

describe('categorizeSpanTree', () => {
  it('categorizes nested spans preserving hierarchy', () => {
    const spans = [
      createSpan({
        spanId: '1',
        attributes: { [ATTR_GEN_AI_OPERATION_NAME]: 'invoke_agent' },
        children: [
          createSpan({ spanId: '1.1', attributes: { [ATTR_GEN_AI_OPERATION_NAME]: 'chat' } }),
        ],
      }),
    ];
    const categorized = categorizeSpanTree(spans);

    expect(categorized[0].category).toBe('AGENT');
    expect(categorized[0].children).toHaveLength(1);
    expect((categorized[0].children![0] as CategorizedSpan).category).toBe('LLM');
  });

  it('handles deeply nested trees', () => {
    const spans = [
      createSpan({
        spanId: '1',
        children: [
          createSpan({
            spanId: '1.1',
            children: [createSpan({ spanId: '1.1.1' })],
          }),
        ],
      }),
    ];
    const categorized = categorizeSpanTree(spans);

    expect(categorized[0].children).toHaveLength(1);
    const child = categorized[0].children![0] as CategorizedSpan;
    expect(child.children).toHaveLength(1);
  });
});

describe('filterSpansByCategory', () => {
  it('filters spans by single category', () => {
    const spans = [
      createCategorizedSpan({ spanId: '1', category: 'LLM' }),
      createCategorizedSpan({ spanId: '2', category: 'TOOL' }),
      createCategorizedSpan({ spanId: '3', category: 'LLM' }),
    ];
    const filtered = filterSpansByCategory(spans, ['LLM']);

    expect(filtered).toHaveLength(2);
    expect(filtered.every(s => s.category === 'LLM')).toBe(true);
  });

  it('filters spans by multiple categories', () => {
    const spans = [
      createCategorizedSpan({ spanId: '1', category: 'LLM' }),
      createCategorizedSpan({ spanId: '2', category: 'TOOL' }),
      createCategorizedSpan({ spanId: '3', category: 'AGENT' }),
    ];
    const filtered = filterSpansByCategory(spans, ['LLM', 'TOOL']);

    expect(filtered).toHaveLength(2);
  });

  it('returns all spans when categories array is empty', () => {
    const spans = [
      createCategorizedSpan({ spanId: '1', category: 'LLM' }),
      createCategorizedSpan({ spanId: '2', category: 'TOOL' }),
    ];
    const filtered = filterSpansByCategory(spans, []);

    expect(filtered).toHaveLength(2);
  });
});

describe('filterSpanTreeByCategory', () => {
  it('filters tree preserving hierarchy', () => {
    const spans: CategorizedSpan[] = [
      {
        ...createCategorizedSpan({ spanId: '1', category: 'AGENT' }),
        children: [
          createCategorizedSpan({ spanId: '1.1', category: 'LLM' }),
          createCategorizedSpan({ spanId: '1.2', category: 'TOOL' }),
        ],
      },
    ];
    const filtered = filterSpanTreeByCategory(spans, ['LLM']);

    expect(filtered).toHaveLength(1);
    expect(filtered[0].children).toHaveLength(1);
  });

  it('returns all spans when categories array is empty', () => {
    const spans: CategorizedSpan[] = [
      createCategorizedSpan({ spanId: '1', category: 'LLM' }),
    ];
    const filtered = filterSpanTreeByCategory(spans, []);

    expect(filtered).toHaveLength(1);
  });

  it('excludes branches with no matching descendants', () => {
    const spans: CategorizedSpan[] = [
      {
        ...createCategorizedSpan({ spanId: '1', category: 'AGENT' }),
        children: [
          createCategorizedSpan({ spanId: '1.1', category: 'OTHER' }),
        ],
      },
    ];
    const filtered = filterSpanTreeByCategory(spans, ['LLM']);

    expect(filtered).toHaveLength(0);
  });
});

describe('countByCategory', () => {
  it('counts spans by category', () => {
    const spans = [
      createCategorizedSpan({ spanId: '1', category: 'LLM' }),
      createCategorizedSpan({ spanId: '2', category: 'LLM' }),
      createCategorizedSpan({ spanId: '3', category: 'TOOL' }),
    ];
    const counts = countByCategory(spans);

    expect(counts.LLM).toBe(2);
    expect(counts.TOOL).toBe(1);
    expect(counts.AGENT).toBe(0);
  });

  it('counts nested spans', () => {
    const spans: CategorizedSpan[] = [
      {
        ...createCategorizedSpan({ spanId: '1', category: 'AGENT' }),
        children: [
          createCategorizedSpan({ spanId: '1.1', category: 'LLM' }),
          createCategorizedSpan({ spanId: '1.2', category: 'TOOL' }),
        ],
      },
    ];
    const counts = countByCategory(spans);

    expect(counts.AGENT).toBe(1);
    expect(counts.LLM).toBe(1);
    expect(counts.TOOL).toBe(1);
  });

  it('returns all zeros for empty array', () => {
    const counts = countByCategory([]);

    expect(counts.AGENT).toBe(0);
    expect(counts.LLM).toBe(0);
    expect(counts.TOOL).toBe(0);
    expect(counts.ERROR).toBe(0);
    expect(counts.OTHER).toBe(0);
  });
});

describe('checkOTelCompliance', () => {
  it('returns compliant for LLM span with all attributes', () => {
    const span = createCategorizedSpan({
      spanId: '1',
      category: 'LLM',
      attributes: {
        [ATTR_GEN_AI_OPERATION_NAME]: 'chat',
        [ATTR_GEN_AI_REQUEST_MODEL]: 'claude-v2',
        [ATTR_GEN_AI_SYSTEM]: 'aws_bedrock',
      },
    });
    const result = checkOTelCompliance(span);

    expect(result.isCompliant).toBe(true);
    expect(result.missingAttributes).toEqual([]);
  });

  it('returns non-compliant for LLM span missing attributes', () => {
    const span = createCategorizedSpan({
      spanId: '1',
      category: 'LLM',
      attributes: {},
    });
    const result = checkOTelCompliance(span);

    expect(result.isCompliant).toBe(false);
    expect(result.missingAttributes.length).toBeGreaterThan(0);
  });

  it('returns compliant for TOOL span with required attributes', () => {
    const span = createCategorizedSpan({
      spanId: '1',
      category: 'TOOL',
      attributes: {
        [ATTR_GEN_AI_OPERATION_NAME]: 'execute_tool',
        [ATTR_GEN_AI_TOOL_NAME]: 'SearchDocs',
      },
    });
    const result = checkOTelCompliance(span);

    expect(result.isCompliant).toBe(true);
  });

  it('returns compliant for OTHER category (no requirements)', () => {
    const span = createCategorizedSpan({
      spanId: '1',
      category: 'OTHER',
      attributes: {},
    });
    const result = checkOTelCompliance(span);

    expect(result.isCompliant).toBe(true);
  });
});

describe('hasAnyWarnings', () => {
  it('returns false when all spans are compliant', () => {
    const spans = [
      createCategorizedSpan({
        spanId: '1',
        category: 'LLM',
        attributes: {
          [ATTR_GEN_AI_OPERATION_NAME]: 'chat',
          [ATTR_GEN_AI_REQUEST_MODEL]: 'claude-v2',
          [ATTR_GEN_AI_SYSTEM]: 'bedrock',
        },
      }),
    ];
    expect(hasAnyWarnings(spans)).toBe(false);
  });

  it('returns true when any span is non-compliant', () => {
    const spans = [
      createCategorizedSpan({
        spanId: '1',
        category: 'LLM',
        attributes: {},  // Missing required attributes
      }),
    ];
    expect(hasAnyWarnings(spans)).toBe(true);
  });

  it('returns false for empty array', () => {
    expect(hasAnyWarnings([])).toBe(false);
  });
});
