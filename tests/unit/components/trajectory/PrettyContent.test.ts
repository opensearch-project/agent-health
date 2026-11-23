/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Render tests for components/trajectory/PrettyContent.tsx — the summary
 * header, Tree / Table / Raw toggles, per-node expand/collapse, lazy paging
 * of large arrays, and the text/markdown fallbacks.
 */

import * as React from 'react';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import { PrettyContent, findTableCandidate } from '@/components/trajectory/PrettyContent';

jest.mock('@/components/ui/markdown', () => ({
  Markdown: ({ children, className }: any) => React.createElement('div', { className, 'data-testid': 'markdown' }, children),
  hasRealMarkdown: (s: string) => /\*\*|^#\s/m.test(s),
}));

function makeHits(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `doc-${i}`,
    title: `Product ${i}`,
    price: i * 10,
    inStock: i % 2 === 0,
  }));
}

function mcpEnvelope(inner: unknown): string {
  return JSON.stringify([{ type: 'text', text: JSON.stringify(inner) }]);
}

const searchResult = {
  status: 'ok',
  index: 'products',
  total: 91,
  hit_count: 20,
  hits: makeHits(20),
  rewrites: ['expanded color synonyms'],
};

describe('PrettyContent', () => {
  it('shows a summary header, unwrap note and defaults to the Table view for an envelope wrapping search hits', () => {
    render(React.createElement(PrettyContent, { content: mcpEnvelope(searchResult) }));

    expect(screen.getByTestId('pretty-content-summary').textContent).toBe('object · 6 keys');
    expect(screen.getByTestId('pretty-content-unwrapped').textContent).toContain('content envelope');

    // Table is the default when a homogeneous array is present.
    const tableBtn = screen.getByTestId('pretty-content-mode-table');
    expect(tableBtn.getAttribute('aria-pressed')).toBe('true');
    const table = screen.getByTestId('pretty-content-table');
    expect(within(table).getAllByRole('row')).toHaveLength(21); // header + 20
    expect(within(table).getByText('inStock')).toBeTruthy();
    expect(within(table).getByText('Product 7')).toBeTruthy();
    // The table came from a key of the root object, and says so.
    expect(screen.getByTestId('pretty-content-table-context').textContent).toContain('hits · 20 rows');
  });

  it('Raw shows the original (escaped) string untouched', () => {
    const raw = mcpEnvelope(searchResult);
    render(React.createElement(PrettyContent, { content: raw }));
    fireEvent.click(screen.getByTestId('pretty-content-mode-raw'));
    expect(screen.getByTestId('pretty-content-raw').textContent).toBe(raw);
    expect(screen.getByTestId('pretty-content-mode-raw').getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByTestId('pretty-content-table')).toBeNull();
  });

  it('Raw uses the explicit `raw` prop when the content is an already-parsed object (tool args)', () => {
    const args = { index: 'products', size: 20 };
    render(React.createElement(PrettyContent, { content: args, raw: '{"index": "products", "size": 20}' }));
    fireEvent.click(screen.getByTestId('pretty-content-mode-raw'));
    expect(screen.getByTestId('pretty-content-raw').textContent).toBe('{"index": "products", "size": 20}');
  });

  it('Tree view expands two levels by default, toggles nodes and supports expand/collapse all', () => {
    render(React.createElement(PrettyContent, { content: mcpEnvelope(searchResult) }));
    fireEvent.click(screen.getByTestId('pretty-content-mode-tree'));
    const tree = screen.getByTestId('pretty-content-tree');

    // Depth 0 (root) and depth 1 (hits array) are open; depth-2 objects are collapsed.
    expect(within(tree).getByText('hit_count')).toBeTruthy();
    expect(within(tree).getByText('91')).toBeTruthy();
    const hitsToggle = within(tree).getByLabelText('Collapse hits');
    expect(hitsToggle.getAttribute('aria-expanded')).toBe('true');
    // Each hit row is present as a collapsed node showing its summary, not its keys.
    expect(within(tree).getAllByText('object · 4 keys').length).toBe(20);
    expect(within(tree).queryByText('inStock')).toBeNull();

    // Expand one hit.
    fireEvent.click(within(tree).getByLabelText('Expand 0'));
    expect(within(tree).getByText('inStock')).toBeTruthy();
    expect(within(tree).getByText('"doc-0"')).toBeTruthy();

    // Collapse the hits array: children vanish, summary shows inline.
    fireEvent.click(hitsToggle);
    expect(within(tree).queryByText('"doc-0"')).toBeNull();
    expect(within(tree).getByText('table · 20 rows × 4 cols')).toBeTruthy();

    // Expand all → every leaf visible.
    fireEvent.click(within(tree).getByText('expand all'));
    expect(within(tree).getAllByText('inStock')).toHaveLength(20);

    // Collapse all → only the root line remains.
    fireEvent.click(within(tree).getByText('collapse all'));
    expect(within(tree).queryByText('hit_count')).toBeNull();
    expect(within(tree).getByLabelText('Expand root')).toBeTruthy();

    // A toggle after collapse-all flips just that node.
    fireEvent.click(within(tree).getByLabelText('Expand root'));
    expect(within(tree).getByText('hit_count')).toBeTruthy();
  });

  it('colours scalars by type and soft-wraps long strings behind a "more" toggle', () => {
    const long = 'x'.repeat(1000);
    render(React.createElement(PrettyContent, { content: { n: 1, b: true, z: null, s: long } }));
    const tree = screen.getByTestId('pretty-content-tree');
    expect(within(tree).getByText('1').className).toContain('text-sky');
    expect(within(tree).getByText('true').className).toContain('text-amber');
    expect(within(tree).getByText('null').className).toContain('italic');
    const more = within(tree).getByText(/more \(1002 chars\)/);
    const clipped = more.parentElement!;
    expect(clipped.textContent!.length).toBeLessThan(1002);
    fireEvent.click(more);
    expect(clipped.textContent).toContain(long);
    expect(within(tree).getByText('less')).toBeTruthy();
  });

  it('pages large arrays in the tree (100 per page) and large tables (50 per page)', () => {
    const rows = makeHits(120);
    render(React.createElement(PrettyContent, { content: rows }));
    // Table first.
    let table = screen.getByTestId('pretty-content-table');
    expect(within(table).getAllByRole('row')).toHaveLength(51);
    fireEvent.click(screen.getByText(/show 50 more of 70 remaining rows/));
    table = screen.getByTestId('pretty-content-table');
    expect(within(table).getAllByRole('row')).toHaveLength(101);

    // Tree pages children (root array = depth 0, each row = depth 1 → open by default).
    fireEvent.click(screen.getByTestId('pretty-content-mode-tree'));
    const tree = screen.getByTestId('pretty-content-tree');
    expect(within(tree).getAllByText('inStock')).toHaveLength(100);
    fireEvent.click(within(tree).getByText(/show 20 more of 20 remaining/));
    expect(within(tree).getAllByText('inStock')).toHaveLength(120);
  });

  it('truncates long table cells and exposes the full value as a title', () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ id: i, blob: 'y'.repeat(300), nested: { deep: i } }));
    render(React.createElement(PrettyContent, { content: rows }));
    const table = screen.getByTestId('pretty-content-table');
    const cells = within(table).getAllByTitle('y'.repeat(300));
    expect(cells).toHaveLength(3);
    expect(cells[0].textContent!.length).toBeLessThan(100);
    // Nested objects are rendered as compact JSON.
    expect(within(table).getByText('{ "deep": 1 }')).toBeTruthy();
  });

  it('renders a JSON object with no tabular part as Tree by default and offers no Table toggle', () => {
    render(React.createElement(PrettyContent, { content: '{"a": {"b": 1}}' }));
    expect(screen.getByTestId('pretty-content-mode-tree').getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByTestId('pretty-content-mode-table')).toBeNull();
    expect(screen.getByTestId('pretty-content-tree')).toBeTruthy();
    expect(screen.getByTestId('pretty-content-summary').textContent).toBe('object · 1 key');
  });

  it('renders prose as text with no toggles when nothing was unwrapped', () => {
    render(React.createElement(PrettyContent, { content: 'The index has 12 shards.' }));
    expect(screen.getByTestId('pretty-content-text').textContent).toBe('The index has 12 shards.');
    expect(screen.queryByTestId('pretty-content-mode-raw')).toBeNull();
    expect(screen.getByTestId('pretty-content-summary').textContent).toBe('text · 24 chars');
  });

  it('renders unwrapped markdown through <Markdown> and offers Text / Raw toggles', () => {
    const raw = JSON.stringify([{ type: 'text', text: '# Title\n\nSome **bold** text' }]);
    render(React.createElement(PrettyContent, { content: raw }));
    expect(screen.getByTestId('markdown').textContent).toBe('# Title\n\nSome **bold** text');
    expect(screen.getByTestId('pretty-content-summary').textContent).toBe('markdown');
    fireEvent.click(screen.getByTestId('pretty-content-mode-raw'));
    expect(screen.getByTestId('pretty-content-raw').textContent).toBe(raw);
    fireEvent.click(screen.getByTestId('pretty-content-mode-text'));
    expect(screen.getByTestId('markdown')).toBeTruthy();
  });

  it('copy button writes the pretty JSON (or the raw string in Raw mode)', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const raw = '{"a":1}';
    render(React.createElement(PrettyContent, { content: raw }));
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Copy as pretty JSON'));
    });
    expect(writeText).toHaveBeenLastCalledWith('{\n  "a": 1\n}');
    expect(screen.getByTitle('Copied!')).toBeTruthy();
    fireEvent.click(screen.getByTestId('pretty-content-mode-raw'));
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Copy raw string'));
    });
    expect(writeText).toHaveBeenLastCalledWith(raw);
  });

  it('shows scalar siblings of the table key above the table', () => {
    render(React.createElement(PrettyContent, { content: mcpEnvelope(searchResult) }));
    const ctx = screen.getByTestId('pretty-content-table-context');
    expect(ctx.textContent).toContain('status: "ok"');
    expect(ctx.textContent).toContain('total: 91');
    expect(ctx.textContent).toContain('hits · 20 rows');
    // Containers are not listed inline.
    expect(ctx.textContent).not.toContain('rewrites');
  });

  it('truncated table cells are buttons that open the full value (keyboard-operable)', () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ id: i, blob: `${i}-` + 'y'.repeat(300) }));
    render(React.createElement(PrettyContent, { content: rows }));
    const table = screen.getByTestId('pretty-content-table');
    const cellBtn = within(table).getByTitle('1-' + 'y'.repeat(300));
    expect(cellBtn.tagName).toBe('BUTTON');
    expect(cellBtn.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(cellBtn);
    expect(cellBtn.textContent).toBe('1-' + 'y'.repeat(300));
    expect(cellBtn.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(cellBtn);
    expect(cellBtn.textContent!.length).toBeLessThan(100);
  });

  it('resets the view mode and tree state when the content changes shape in place (live steps)', () => {
    const { rerender } = render(React.createElement(PrettyContent, { content: 'Thinking about the query…' }));
    expect(screen.getByTestId('pretty-content-text')).toBeTruthy();
    // Content becomes JSON → must switch to the tree, not keep rendering "text".
    rerender(React.createElement(PrettyContent, { content: '{"a": {"b": {"c": 1}}}' }));
    expect(screen.getByTestId('pretty-content-tree')).toBeTruthy();
    expect(screen.queryByTestId('pretty-content-text')).toBeNull();
    // User expands a deep node, then the content changes → expansion resets.
    fireEvent.click(screen.getByLabelText('Expand b'));
    expect(screen.getByText('c')).toBeTruthy();
    rerender(React.createElement(PrettyContent, { content: '{"a": {"b": {"c": 2}}}' }));
    expect(screen.queryByText('c')).toBeNull();
    expect(screen.getByLabelText('Expand b')).toBeTruthy();
    // And a user-chosen mode survives re-renders with the SAME content.
    fireEvent.click(screen.getByTestId('pretty-content-mode-raw'));
    rerender(React.createElement(PrettyContent, { content: '{"a": {"b": {"c": 2}}}' }));
    expect(screen.getByTestId('pretty-content-raw')).toBeTruthy();
  });

  it('toggles nodes whose keys contain "/" correctly (depth is not derived from the path)', () => {
    render(React.createElement(PrettyContent, { content: { 'a/b': { 'c/d': { e: 1 } } }, defaultExpandedDepth: 2 }));
    const tree = screen.getByTestId('pretty-content-tree');
    // depth-2 node "c/d" is collapsed by default; one click must open it.
    fireEvent.click(within(tree).getByLabelText('Expand c/d'));
    expect(within(tree).getByText('e')).toBeTruthy();
    fireEvent.click(within(tree).getByLabelText('Collapse c/d'));
    expect(within(tree).queryByText('e')).toBeNull();
  });

  it('flags capped nested parsing in the header', () => {
    // Four string hops: the innermost stays a string → truncated note shown.
    const l4 = JSON.stringify({ leaf: true });
    const l3 = JSON.stringify({ l4 });
    const l2 = JSON.stringify({ l3 });
    const l1 = JSON.stringify({ l2 });
    render(React.createElement(PrettyContent, { content: JSON.stringify({ l1 }) }));
    expect(screen.getByTestId('pretty-content-truncated').textContent).toContain('nested parsing capped');
  });

  it('renders an empty container without a chevron, and hides expand/collapse-all on a flat value', () => {
    render(React.createElement(PrettyContent, { content: { empty: {}, list: [], n: 1 } }));
    const tree = screen.getByTestId('pretty-content-tree');
    expect(within(tree).getByLabelText('Collapse empty').textContent).toBe('');
    expect(within(tree).queryByText('expand all')).toBeNull();
  });

  it('shows expand/collapse-all only when something is nested', () => {
    render(React.createElement(PrettyContent, { content: { a: { b: 1 } } }));
    expect(screen.getByText('expand all')).toBeTruthy();
  });
});

describe('findTableCandidate', () => {
  it('returns the root array when it is tabular', () => {
    const c = findTableCandidate(makeHits(3));
    expect(c?.key).toBeUndefined();
    expect(c?.table.rows).toHaveLength(3);
  });

  it('returns the single tabular key of a root object', () => {
    const c = findTableCandidate({ meta: 1, hits: makeHits(4) });
    expect(c?.key).toBe('hits');
  });

  it('picks the largest when several keys are tabular', () => {
    const c = findTableCandidate({ small: makeHits(3), big: makeHits(9) });
    expect(c?.key).toBe('big');
  });

  it('returns undefined when nothing is tabular', () => {
    expect(findTableCandidate({ a: 1 })).toBeUndefined();
    expect(findTableCandidate('str')).toBeUndefined();
    expect(findTableCandidate([1, 2, 3])).toBeUndefined();
  });
});
