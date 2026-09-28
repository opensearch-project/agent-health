/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * RETRIEVAL category + "unknown is not OTHER" rules for span categorization.
 *
 * Motivation: on real agent traces 28–50% of spans landed in OTHER because
 * categorization only knew the listed GenAI operation names. Three classes
 * fell through — DB/search client spans (OTel DB semconv), framework agent-loop
 * spans with a framework-specific `gen_ai.operation.name`, and the HTTP SERVER
 * entrypoint of the agent service. Each rule below would fail if that
 * regressed.
 */

import { Span, SpanCategory } from '@/types';
import {
  getSpanCategory,
  getCategoryMeta,
  buildDisplayName,
  categorizeSpan,
  categorizeSpanTree,
  countByCategory,
  checkOTelCompliance,
  isDbSpan,
  isEntrypointSpan,
  buildCategoryFields,
} from '@/services/traces/spanCategorization';
import { preprocessSpanTree } from '@/services/traces/spanPreprocessing';
import { CATEGORY_COLORS, getCategoryColors } from '@/services/traces/categoryStyles';
import { getSpanColor } from '@/services/traces';
import { computeTraceSummary } from '@/services/traces/traceSummary';
import { nodeTypes } from '@/components/traces/flow/nodeTypes';
import { spansToFlow } from '@/services/traces/flowTransform';

function span(overrides: Partial<Span> & { spanId: string }): Span {
  return {
    traceId: 'trace-1',
    name: 'span',
    startTime: '2026-01-01T00:00:00.000Z',
    endTime: '2026-01-01T00:00:01.000Z',
    duration: 1000,
    status: 'OK',
    attributes: {},
    ...overrides,
  };
}

const ALL_CATEGORIES: SpanCategory[] = ['AGENT', 'LLM', 'TOOL', 'RETRIEVAL', 'EVAL', 'ERROR', 'OTHER'];

const searchSpan = () =>
  span({
    spanId: 'db-1',
    name: 'search products',
    attributes: {
      spanKind: 'SPAN_KIND_CLIENT',
      'db.system.name': 'opensearch',
      'db.operation.name': 'search',
      'db.namespace': 'catalog',
      'db.collection.name': 'products',
      'db.query.text': '{"query":{"match":{"title":"lamp"}}}',
      'db.response.returned_rows': '20',
      'db.response.status_code': '200',
    },
  });

describe('RETRIEVAL: OTel DB semconv spans', () => {
  it('classifies a span with db.system.name as RETRIEVAL', () => {
    expect(getSpanCategory(searchSpan())).toBe('RETRIEVAL');
    expect(isDbSpan(searchSpan())).toBe(true);
  });

  it('accepts the legacy db.system attribute', () => {
    const s = span({ spanId: 'db-2', name: 'SELECT users', attributes: { 'db.system': 'postgresql', 'db.statement': 'SELECT 1' } });
    expect(getSpanCategory(s)).toBe('RETRIEVAL');
  });

  it('does not treat a span without db.* as retrieval', () => {
    expect(isDbSpan(span({ spanId: 'x', attributes: { 'gen_ai.operation.name': 'chat' } }))).toBe(false);
    expect(isDbSpan(span({ spanId: 'y', attributes: undefined }))).toBe(false);
  });

  it('a KNOWN gen_ai.operation.name wins over db.* on a hybrid span (stays in tool stats)', () => {
    const s = searchSpan();
    s.attributes = { ...s.attributes, 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'search_index', 'gen_ai.provider.name': 'openai' };
    expect(getSpanCategory(s)).toBe('TOOL');
    // The DB details are still available to the detail views.
    expect(isDbSpan(s)).toBe(true);
  });

  it('db.* wins over an UNKNOWN gen_ai.operation.name + GenAI context (leaf semantic)', () => {
    const s = searchSpan();
    s.attributes = { ...s.attributes, 'gen_ai.operation.name': 'vector_lookup', 'gen_ai.provider.name': 'openai' };
    expect(getSpanCategory(s)).toBe('RETRIEVAL');
  });

  it('ERROR status still takes precedence over db.*', () => {
    const s = searchSpan();
    s.status = 'ERROR';
    expect(getSpanCategory(s)).toBe('ERROR');
  });

  it('builds the display name as "{db.operation.name} {collection}" per the DB span-name convention', () => {
    expect(buildDisplayName(searchSpan(), 'RETRIEVAL')).toBe('search products');
    const nsOnly = span({ spanId: 'db-3', name: 'raw', attributes: { 'db.system.name': 'redis', 'db.operation.name': 'GET', 'db.namespace': '0' } });
    expect(buildDisplayName(nsOnly, 'RETRIEVAL')).toBe('GET 0');
    const bare = span({ spanId: 'db-4', name: 'query', attributes: { 'db.system.name': 'sqlite' } });
    expect(buildDisplayName(bare, 'RETRIEVAL')).toBe('query');
  });

  it('exposes category metadata for RETRIEVAL', () => {
    const meta = getCategoryMeta('RETRIEVAL');
    expect(meta.label).toBe('Retrieval');
    expect(meta.icon).toBe('Database');
    expect(meta.color).toContain('cyan');
    const c = categorizeSpan(searchSpan());
    expect(c.category).toBe('RETRIEVAL');
    expect(c.categoryLabel).toBe('Retrieval');
    expect(c.isEntrypoint).toBeUndefined();
  });

  describe('compliance expectations', () => {
    it('is compliant with db.system.name + db.query.text', () => {
      const r = checkOTelCompliance(categorizeSpan(searchSpan()));
      expect(r.isCompliant).toBe(true);
      expect(r.missingAttributes).toEqual([]);
    });

    it('accepts db.operation.name as the alternative to db.query.text', () => {
      const s = span({ spanId: 'db-5', attributes: { 'db.system.name': 'opensearch', 'db.operation.name': 'search' } });
      expect(checkOTelCompliance(categorizeSpan(s)).isCompliant).toBe(true);
    });

    it('reports both alternatives as one missing entry when neither is present', () => {
      const s = span({ spanId: 'db-6', attributes: { 'db.system.name': 'opensearch' } });
      const r = checkOTelCompliance(categorizeSpan(s));
      expect(r.isCompliant).toBe(false);
      expect(r.missingAttributes).toEqual(['db.query.text|db.operation.name']);
    });

    it('flags legacy db.system-only spans as missing the stable db.system.name', () => {
      const s = span({ spanId: 'db-7', attributes: { 'db.system': 'postgresql', 'db.statement': 'SELECT 1' } });
      const r = checkOTelCompliance(categorizeSpan(s));
      expect(r.missingAttributes).toEqual(['db.system.name', 'db.query.text|db.operation.name']);
    });
  });
});

describe('AGENT: framework-specific gen_ai.operation.name with GenAI context', () => {
  it('classifies an unknown operation name WITH gen_ai.provider.name as AGENT', () => {
    const s = span({ spanId: 'loop-1', name: 'execute_event_loop_cycle', attributes: { 'gen_ai.operation.name': 'execute_event_loop_cycle', 'gen_ai.provider.name': 'openai' } });
    expect(getSpanCategory(s)).toBe('AGENT');
  });

  it('accepts gen_ai.system or gen_ai.agent.name as the GenAI context', () => {
    expect(getSpanCategory(span({ spanId: 'a', name: 'plan', attributes: { 'gen_ai.operation.name': 'plan_step', 'gen_ai.system': 'anthropic' } }))).toBe('AGENT');
    expect(getSpanCategory(span({ spanId: 'b', name: 'plan', attributes: { 'gen_ai.operation.name': 'plan_step', 'gen_ai.agent.name': 'planner' } }))).toBe('AGENT');
  });

  it('an unknown operation that reports a model or token usage is a model call → LLM, not AGENT', () => {
    expect(getSpanCategory(span({ spanId: 'r1', name: 'rerank', attributes: { 'gen_ai.operation.name': 'rerank', 'gen_ai.provider.name': 'cohere', 'gen_ai.request.model': 'rerank-v3' } }))).toBe('LLM');
    expect(getSpanCategory(span({ spanId: 'r2', name: 'moderation', attributes: { 'gen_ai.operation.name': 'moderation', 'gen_ai.system': 'openai', 'gen_ai.usage.input_tokens': 12 } }))).toBe('LLM');
    expect(getSpanCategory(span({ spanId: 'r3', name: 'embed', attributes: { 'gen_ai.operation.name': 'embeddings', 'gen_ai.provider.name': 'openai' } }))).toBe('LLM'); // now a known op
  });

  it('an unknown operation name WITHOUT GenAI context keeps the name-pattern fallbacks', () => {
    // name pattern → LLM
    expect(getSpanCategory(span({ spanId: 'c', name: 'bedrock.converse', attributes: { 'gen_ai.operation.name': 'weird_op' } }))).toBe('LLM');
    // no pattern → OTHER stays the explicit "we do not know" bucket
    expect(getSpanCategory(span({ spanId: 'd', name: 'misc step', attributes: { 'gen_ai.operation.name': 'weird_op' } }))).toBe('OTHER');
  });

  it('known operation names are unaffected', () => {
    expect(getSpanCategory(span({ spanId: 'e', attributes: { 'gen_ai.operation.name': 'chat', 'gen_ai.provider.name': 'openai' } }))).toBe('LLM');
    expect(getSpanCategory(span({ spanId: 'f', attributes: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.provider.name': 'openai' } }))).toBe('TOOL');
    expect(getSpanCategory(span({ spanId: 'g', attributes: { 'gen_ai.operation.name': 'invoke_agent' } }))).toBe('AGENT');
    expect(getSpanCategory(span({ spanId: 'h', attributes: { 'gen_ai.operation.name': 'evaluation' } }))).toBe('EVAL');
  });
});

describe('AGENT entrypoint: HTTP SERVER span of the agent service', () => {
  const httpServer = (kind: unknown, methodAttr = 'http.request.method') =>
    span({ spanId: 'root', name: 'POST /ask', attributes: { spanKind: kind, [methodAttr]: 'POST', 'url.path': '/ask', 'http.route': '/ask' } });

  it('classifies an HTTP SERVER span as AGENT and flags it as the entrypoint', () => {
    const s = httpServer('SPAN_KIND_SERVER');
    expect(getSpanCategory(s)).toBe('AGENT');
    expect(isEntrypointSpan(s)).toBe(true);
    expect(categorizeSpan(s).isEntrypoint).toBe(true);
    expect(buildCategoryFields(s).isEntrypoint).toBe(true);
  });

  it('accepts the legacy http.method attribute and exactly the OTLP/OTel kind encodings', () => {
    expect(isEntrypointSpan(httpServer('SPAN_KIND_SERVER', 'http.method'))).toBe(true);
    expect(isEntrypointSpan(httpServer('SERVER'))).toBe(true);
    expect(isEntrypointSpan(httpServer('server'))).toBe(true);
    expect(isEntrypointSpan(httpServer(2))).toBe(true);
  });

  it('rejects look-alike / garbage span kinds', () => {
    expect(isEntrypointSpan(httpServer('SPAN_KIND_API_SERVER'))).toBe(false);
    expect(isEntrypointSpan(httpServer('CLIENT'))).toBe(false);
    expect(isEntrypointSpan(httpServer('2'))).toBe(false);
    expect(isEntrypointSpan(httpServer(3))).toBe(false);
    expect(isEntrypointSpan(httpServer(undefined))).toBe(false);
  });

  it('only the OUTERMOST HTTP SERVER span is the entrypoint; nested server spans are AGENT but not entrypoints', () => {
    const outer = httpServer('SPAN_KIND_SERVER');
    const inner = span({ spanId: 'inner', name: 'POST /internal/tool', attributes: { spanKind: 'SPAN_KIND_SERVER', 'http.request.method': 'POST' } });
    outer.children = [inner];
    const tree = categorizeSpanTree([outer]);
    expect(tree[0].isEntrypoint).toBe(true);
    const innerCat = (tree[0].children as any[])[0];
    expect(innerCat.category).toBe('AGENT');
    expect(innerCat.isEntrypoint).toBeUndefined();
    // Same via the single-pass preprocessor
    const pre = preprocessSpanTree([outer], { startTime: 0, endTime: 1000, duration: 1000 });
    expect(pre.categorizedTree[0].isEntrypoint).toBe(true);
    expect((pre.categorizedTree[0].children as any[])[0].isEntrypoint).toBeUndefined();
    // Explicit ancestors on the per-span API
    expect(isEntrypointSpan(inner, [outer])).toBe(false);
    expect(isEntrypointSpan(inner, [span({ spanId: 'x', attributes: {} })])).toBe(true);
  });

  it('does not flag a span whose parent is missing but that is not an HTTP SERVER span', () => {
    expect(isEntrypointSpan(span({ spanId: 'r', name: 'root', attributes: {} }))).toBe(false);
    expect(isEntrypointSpan(span({ spanId: 'r2', name: 'root', attributes: { spanKind: 'SPAN_KIND_SERVER' } }))).toBe(false);
  });

  it('keeps the flag even when the span has a parent (the eval span is usually its W3C parent)', () => {
    const s = httpServer('SPAN_KIND_SERVER');
    s.parentSpanId = 'eval-span';
    expect(getSpanCategory(s)).toBe('AGENT');
    expect(categorizeSpan(s).isEntrypoint).toBe(true);
  });

  it('an entrypoint span is judged against HTTP server-span semconv, not GenAI expectations', () => {
    const s = httpServer('SPAN_KIND_SERVER');
    s.attributes!['http.response.status_code'] = 200;
    const r = checkOTelCompliance(categorizeSpan(s));
    expect(r.isCompliant).toBe(true);
    expect(r.missingAttributes).toEqual([]);
    // Method alone is not enough: route/path and status are expected too.
    const bare = categorizeSpan(span({ spanId: 'b', name: 'POST', attributes: { spanKind: 'SPAN_KIND_SERVER', 'http.request.method': 'POST' } }));
    expect(checkOTelCompliance(bare).missingAttributes).toEqual([
      'http.route|url.path|http.target',
      'http.response.status_code|http.status_code',
    ]);
    // A plain (non-entrypoint) AGENT span keeps the GenAI expectations.
    const loop = categorizeSpan(span({ spanId: 'l', name: 'loop', attributes: { 'gen_ai.operation.name': 'loop_cycle', 'gen_ai.provider.name': 'openai' } }));
    expect(checkOTelCompliance(loop).missingAttributes).toEqual(['gen_ai.agent.name']);
  });

  it('outbound HTTP CLIENT spans without db.* are NOT entrypoints and stay OTHER', () => {
    const s = span({ spanId: 'client', name: 'GET api.example.com', attributes: { spanKind: 'SPAN_KIND_CLIENT', 'http.request.method': 'GET' } });
    expect(isEntrypointSpan(s)).toBe(false);
    expect(getSpanCategory(s)).toBe('OTHER');
    expect(categorizeSpan(s).isEntrypoint).toBeUndefined();
  });

  it('preprocessSpanTree carries isEntrypoint like categorizeSpan does', () => {
    const root = httpServer('SPAN_KIND_SERVER');
    root.children = [searchSpan()];
    const pre = preprocessSpanTree([root], { startTime: 0, endTime: 1000, duration: 1000 });
    expect(pre.categorizedTree[0].isEntrypoint).toBe(true);
    expect(pre.categorizedTree[0].category).toBe('AGENT');
    expect((pre.categorizedTree[0].children as any[])[0].category).toBe('RETRIEVAL');
    expect((pre.categorizedTree[0].children as any[])[0].isEntrypoint).toBeUndefined();
  });
});

describe('every category enumeration covers RETRIEVAL', () => {
  it('countByCategory includes a RETRIEVAL bucket', () => {
    const counts = countByCategory(categorizeSpanTree([searchSpan()]));
    expect(Object.keys(counts).sort()).toEqual([...ALL_CATEGORIES].sort());
    expect(counts.RETRIEVAL).toBe(1);
    expect(counts.OTHER).toBe(0);
  });

  it('category style maps have an entry for every category', () => {
    for (const cat of ALL_CATEGORIES) {
      expect(CATEGORY_COLORS[cat]).toBeDefined();
      expect(getCategoryMeta(cat)).toBeDefined();
    }
    expect(getCategoryColors('RETRIEVAL').bar).toBe('bg-cyan-500');
    expect(getSpanColor(searchSpan())).toBe('#06b6d4');
  });

  it('the Agent map registers a React Flow node type for every category (else the node renders blank)', () => {
    for (const cat of ALL_CATEGORIES) {
      expect(nodeTypes[cat.toLowerCase() as keyof typeof nodeTypes]).toBeDefined();
    }
    const { nodes } = spansToFlow(categorizeSpanTree([searchSpan()]), 1000);
    expect(nodes[0].type).toBe('retrieval');
    expect(nodeTypes[nodes[0].type as keyof typeof nodeTypes]).toBeDefined();
  });

  it('computeTraceSummary reports the retrieval count', () => {
    const summary = computeTraceSummary([searchSpan(), span({ spanId: 'l', attributes: { 'gen_ai.operation.name': 'chat' } })]);
    expect(summary.retrieval).toBe(1);
    expect(summary.llm).toBe(1);
  });
});

describe('end-to-end: a synthetic agent trace with all three classes has 0 OTHER spans', () => {
  it('categorizes the HTTP root, loop cycles, LLM, tool and search spans without falling back to OTHER', () => {
    const root = span({ spanId: 'root', name: 'POST /ask', attributes: { spanKind: 'SPAN_KIND_SERVER', 'http.request.method': 'POST', 'url.path': '/ask' } });
    const invoke = span({ spanId: 'inv', parentSpanId: 'root', name: 'invoke_agent retrieval-agent', attributes: { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'retrieval-agent' } });
    const cycle = span({ spanId: 'cyc', parentSpanId: 'inv', name: 'execute_event_loop_cycle', attributes: { 'gen_ai.operation.name': 'execute_event_loop_cycle', 'gen_ai.provider.name': 'openai' } });
    const chat = span({ spanId: 'chat', parentSpanId: 'cyc', name: 'chat', attributes: { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'model-x', 'gen_ai.provider.name': 'openai' } });
    const tool = span({ spanId: 'tool', parentSpanId: 'cyc', name: 'execute_tool search_index', attributes: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'search_index' } });
    const search = searchSpan();
    search.parentSpanId = 'tool';
    tool.children = [search];
    cycle.children = [chat, tool];
    invoke.children = [cycle];
    root.children = [invoke];

    const counts = countByCategory(categorizeSpanTree([root]));
    expect(counts).toEqual({ AGENT: 3, LLM: 1, TOOL: 1, RETRIEVAL: 1, EVAL: 0, ERROR: 0, OTHER: 0 });
  });
});
