/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Rendered-output tests for RETRIEVAL spans: the span detail panel must show
 * the DB query text (pretty-printed) as INPUT, the returned rows / status /
 * retrieved ids as OUTPUT, and the `{operation} {collection} ({system})`
 * caption; the Input/Output tab must list the span under a Retrieval badge.
 */

import * as React from 'react';
import { render, screen } from '@testing-library/react';
import SpanDetailsPanel from '@/components/traces/SpanDetailsPanel';
import { SpanInputOutput, extractSpanIO } from '@/components/traces/SpanInputOutput';
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

function searchSpan(): Span {
  return {
    traceId: 'trace-r-1',
    spanId: 'span-search-1',
    name: 'search products',
    startTime: '2026-01-01T00:00:00Z',
    endTime: '2026-01-01T00:00:00.040Z',
    duration: 40,
    status: 'OK',
    attributes: {
      spanKind: 'SPAN_KIND_CLIENT',
      'db.system.name': 'opensearch',
      'db.operation.name': 'search',
      'db.namespace': 'catalog',
      'db.collection.name': 'products',
      'db.query.text': '{"size":20,"query":{"match":{"title":"desk lamp"}}}',
      'db.response.returned_rows': '20',
      'db.response.status_code': '200',
      'retrieval-agent.search.hit_ids': "['prod-101', 'prod-202']",
    },
  };
}

describe('SpanDetailsPanel — RETRIEVAL span I/O', () => {
  it('renders the pretty-printed query text as INPUT with the db caption', () => {
    render(React.createElement(SpanDetailsPanel, { span: categorizeSpan(searchSpan()), onClose: jest.fn() }));

    expect(screen.queryByText(/No input data available/i)).toBeNull();
    expect(screen.getByTestId('span-details-retrieval-caption').textContent).toBe('search products (opensearch)');
    const input = screen.getByTestId('span-details-input').textContent || '';
    expect(input).toContain('"match"');
    expect(input).toContain('desk lamp');
    expect(input.split('\n').length).toBeGreaterThan(3); // pretty-printed, not one line
  });

  it('renders returned rows, status code and retrieved ids as OUTPUT', () => {
    render(React.createElement(SpanDetailsPanel, { span: categorizeSpan(searchSpan()), onClose: jest.fn() }));

    expect(screen.queryByText(/No output data available/i)).toBeNull();
    const output = screen.getByTestId('span-details-output').textContent || '';
    expect(output).toContain('returned_rows: 20');
    expect(output).toContain('status_code: 200');
    expect(output).toContain('retrieval-agent.search.hit_ids (2)');
    expect(output).toContain('prod-101');
  });

  it('shows the DB key attributes and no OTel compliance warning for a compliant db span', () => {
    const { container } = render(React.createElement(SpanDetailsPanel, { span: categorizeSpan(searchSpan()), onClose: jest.fn() }));
    expect(container.textContent).toContain('opensearch');
    expect(container.textContent).toContain('Returned Rows');
    expect(screen.queryByText(/OTel Compliance/i)).toBeNull();
  });

  it('warns when a db span carries neither db.query.text nor db.operation.name', () => {
    const s = searchSpan();
    s.attributes = { 'db.system.name': 'opensearch' };
    render(React.createElement(SpanDetailsPanel, { span: categorizeSpan(s), onClose: jest.fn() }));
    expect(screen.getByText(/OTel Compliance/i)).toBeTruthy();
    expect(screen.getByText('db.query.text|db.operation.name')).toBeTruthy();
  });

  it('a hybrid execute_tool + db.* span keeps its tool I/O and still shows the DB caption', () => {
    const s = searchSpan();
    s.attributes = {
      ...s.attributes,
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': 'search_index',
      'gen_ai.tool.call.arguments': '{"q":"from-tool-args"}',
      'gen_ai.tool.call.result': '{"hits":3}',
    };
    const c = categorizeSpan(s);
    expect(c.category).toBe('TOOL');
    render(React.createElement(SpanDetailsPanel, { span: c, onClose: jest.fn() }));
    expect(screen.getByTestId('span-details-input').textContent).toContain('from-tool-args');
    expect(screen.getByTestId('span-details-input').textContent).not.toContain('desk lamp');
    expect(screen.getByTestId('span-details-output').textContent).toContain('hits');
    expect(screen.getByTestId('span-details-retrieval-caption').textContent).toBe('search products (opensearch)');
  });

  it('does not show a retrieval caption for non-db spans', () => {
    const s = searchSpan();
    s.attributes = { 'gen_ai.operation.name': 'chat' };
    render(React.createElement(SpanDetailsPanel, { span: categorizeSpan(s), onClose: jest.fn() }));
    expect(screen.queryByTestId('span-details-retrieval-caption')).toBeNull();
  });
});

describe('SpanInputOutput — RETRIEVAL category', () => {
  it('extractSpanIO classifies db spans as retrieval with query in / rows out', () => {
    const io = extractSpanIO(searchSpan());
    expect(io.category).toBe('retrieval');
    expect(io.input).toContain('desk lamp');
    expect(io.output).toContain('returned_rows: 20');
  });

  it('db.* wins over a bare gen_ai.tool.name (no known operation) on the same span', () => {
    const s = searchSpan();
    s.attributes = { ...s.attributes, 'gen_ai.tool.name': 'search_index' };
    expect(extractSpanIO(s).category).toBe('retrieval');
  });

  it('a known execute_tool operation keeps the span in the tool bucket of the I/O tab', () => {
    const s = searchSpan();
    s.attributes = { ...s.attributes, 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'search_index', 'gen_ai.tool.call.arguments': '{"q":1}' };
    const io = extractSpanIO(s);
    expect(io.category).toBe('tool');
    expect(io.input).toContain('"q"');
  });

  it('renders a Retrieval badge and the span card', () => {
    render(React.createElement(SpanInputOutput, { spans: [searchSpan()] }));
    expect(screen.getByText(/Retrieval: 1/)).toBeTruthy();
    expect(screen.getByText('search products')).toBeTruthy();
  });
});

describe('SimpleSpanAttributesTable — retrieval summary strip', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const SimpleSpanAttributesTable = require('@/components/traces/SimpleSpanAttributesTable').default;

  it('shows caption, returned rows and status for a db span, with the query text in the table', () => {
    const { container } = render(React.createElement(SimpleSpanAttributesTable, { span: searchSpan() }));
    const strip = screen.getByTestId('span-retrieval-summary');
    expect(strip.textContent).toContain('search products (opensearch)');
    expect(strip.textContent).toContain('20 rows');
    expect(strip.textContent).toContain('200');
    expect(screen.getByText('db.query.text')).toBeTruthy();
    expect(container.textContent).toContain('desk lamp');
  });

  it('pluralises correctly and omits missing parts', () => {
    const s = searchSpan();
    s.attributes = { 'db.system.name': 'sqlite', 'db.response.returned_rows': 1 };
    render(React.createElement(SimpleSpanAttributesTable, { span: s }));
    expect(screen.getByTestId('span-retrieval-summary').textContent).toBe('sqlite· 1 row');
  });

  it('renders no strip for non-db spans', () => {
    const s = searchSpan();
    s.attributes = { 'gen_ai.operation.name': 'chat' };
    render(React.createElement(SimpleSpanAttributesTable, { span: s }));
    expect(screen.queryByTestId('span-retrieval-summary')).toBeNull();
  });
});
