/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Rendered-output tests for the trace-row readability changes:
 *  - every tree row shows the span's absolute start (HH:MM:SS.mmm) + offset
 *    from the trace root, with the full ISO time in the tooltip;
 *  - the span NAME is a button that selects the span (click / keyboard) and
 *    always carries the full name in `title`;
 *  - the list header states the ordering guarantee and the t=0 anchor;
 *  - the drawers show the full (un-truncated) name and the labelled
 *    Retrieved (seen) / Returned (recommended) id lists with the overlap.
 */

import * as React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import TraceTreeTable from '@/components/traces/TraceTreeTable';
import SimpleSpanAttributesTable from '@/components/traces/SimpleSpanAttributesTable';
import SpanDetailsPanel from '@/components/traces/SpanDetailsPanel';
import RetrievedReturnedLists from '@/components/traces/RetrievedReturnedLists';
import { processSpansIntoTree, calculateTimeRange } from '@/services/traces';
import { formatClockTime } from '@/services/traces/spanTime';
import { Span } from '@/types';

jest.mock('@/components/traces/ContextWindowBar', () => ({
  __esModule: true,
  default: () => React.createElement('div', { 'data-testid': 'context-window-bar' }),
}));
jest.mock('@/components/traces/FormattedMessages', () => ({
  __esModule: true,
  default: () => React.createElement('div', { 'data-testid': 'formatted-messages' }),
}));

const T0 = Date.UTC(2026, 2, 3, 9, 15, 30, 250);
const iso = (ms: number) => new Date(ms).toISOString();
const LONG_TOOL = 'execute_tool a_very_long_tool_name_that_certainly_overflows_the_label_column_of_the_tree';

function flatSpans(): Span[] {
  return [
    {
      traceId: 't', spanId: 'root', name: 'POST /ask', status: 'OK',
      startTime: iso(T0), endTime: iso(T0 + 5000), duration: 5000,
      attributes: {
        'service.name': 'retrieval-agent', spanKind: 'SPAN_KIND_SERVER', 'http.request.method': 'POST',
        'retrieval.retrieved.ids': ['d1', 'd2', 'd3', 'd4'],
        'retrieval.results.ids': ['d2', 'd4', 'd9'],
      },
    },
    {
      traceId: 't', spanId: 'late', parentSpanId: 'root', name: 'chat', status: 'OK',
      startTime: iso(T0 + 1234), endTime: iso(T0 + 2000), duration: 766, attributes: {},
    },
    {
      traceId: 't', spanId: 'early', parentSpanId: 'root', name: LONG_TOOL, status: 'OK',
      startTime: iso(T0 + 100), endTime: iso(T0 + 900), duration: 800, attributes: {},
    },
  ];
}

function renderTree(onSelect = jest.fn(), selected: Span | null = null) {
  const spans = flatSpans();
  const tree = processSpansIntoTree(spans);
  const utils = render(
    React.createElement(TraceTreeTable, {
      spanTree: tree,
      timeRange: calculateTimeRange(spans),
      selectedSpan: selected,
      onSelect,
      expandedSpans: new Set(['root']),
      onToggleExpand: jest.fn(),
    })
  );
  return { ...utils, tree, onSelect };
}

describe('TraceTreeTable — absolute time + offset per row (E1) and ordering hint (E2)', () => {
  it('renders HH:MM:SS.mmm + offset on every row, ISO in the tooltip, rows in start order', () => {
    renderTree();
    const rows = screen.getAllByTestId('span-row-time');
    expect(rows).toHaveLength(3);
    const clocks = screen.getAllByTestId('span-row-clock').map(el => el.textContent);
    expect(clocks).toEqual([formatClockTime(T0), formatClockTime(T0 + 100), formatClockTime(T0 + 1234)]);
    expect(screen.getAllByTestId('span-row-offset').map(el => el.textContent)).toEqual(['+0.000 s', '+0.100 s', '+1.234 s']);
    expect(rows[2].getAttribute('title')).toContain('2026-03-03T09:15:31.484Z');
    // Names appear in the same order — 'early' (t+100) before 'late' (t+1234) even though it was listed after.
    expect(screen.getAllByTestId('span-row-name').map(b => b.getAttribute('title'))).toEqual(['POST /ask', LONG_TOOL, 'chat']);
  });

  it('shows the "sorted by start time" hint and the t=0 anchor with the full ISO in its tooltip', () => {
    renderTree();
    expect(screen.getByTestId('trace-list-sort-hint').textContent).toMatch(/sorted by start time/);
    const anchor = screen.getByTestId('trace-anchor-time');
    expect(anchor.textContent).toBe(`t=0 = ${formatClockTime(T0)}`);
    expect(anchor.getAttribute('title')).toContain('2026-03-03T09:15:30.250Z');
  });
});

describe('TraceTreeTable — name is a button that selects the span (E3) with the full name in title (E4)', () => {
  it('click on the name selects exactly that span (no double-fire through the row)', () => {
    const { onSelect } = renderTree();
    fireEvent.click(screen.getByTitle(LONG_TOOL));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].spanId).toBe('early');
  });

  it('the name is a real <button> (Enter/Space activate it) with aria-label + full title', () => {
    const { onSelect } = renderTree();
    const btn = screen.getByTitle(LONG_TOOL);
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.getAttribute('aria-label')).toBe(`Open details for ${LONG_TOOL}`);
    expect(btn.textContent).toBe(LONG_TOOL);
    // Native button semantics: keyboard activation dispatches click.
    btn.focus();
    fireEvent.click(btn);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('exposes ONE keyboard-operable resize handle (in the header) for the name column', () => {
    renderTree();
    const handles = screen.getAllByTestId('span-name-col-resize');
    expect(handles).toHaveLength(1);
    const handle = handles[0];
    expect(handle.getAttribute('role')).toBe('separator');
    expect(handle.getAttribute('tabindex')).toBe('0');
    const before = Number(handle.getAttribute('aria-valuenow'));
    fireEvent.mouseDown(handle, { clientX: 300 });
    fireEvent.mouseMove(document, { clientX: 400 });
    fireEvent.mouseUp(document);
    // Width is inline style on every row's name column wrapper: it grew by 100px.
    const nameCols = screen.getAllByTestId('span-row-name').map(b => b.parentElement as HTMLElement);
    const widths = new Set(nameCols.map(c => c.style.width));
    expect(widths.size).toBe(1);
    expect(parseInt([...widths][0], 10)).toBe(before + 100);
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(parseInt((screen.getAllByTestId('span-row-name')[0].parentElement as HTMLElement).style.width, 10)).toBe(before + 100 - 16);
    fireEvent.keyDown(handle, { key: 'Home' });
    expect(parseInt((screen.getAllByTestId('span-row-name')[0].parentElement as HTMLElement).style.width, 10)).toBe(before);
  });
});

describe('drawers — full name + start time (E4) and Retrieved/Returned pair (E5)', () => {
  it('SimpleSpanAttributesTable shows the whole name, the start time and the labelled id lists with overlap', () => {
    const root = flatSpans()[0];
    render(React.createElement(SimpleSpanAttributesTable, { span: { ...root, name: LONG_TOOL } }));
    const name = screen.getByTestId('span-drawer-name');
    expect(name.textContent).toBe(LONG_TOOL);
    expect(name.className).not.toMatch(/truncate/);
    expect(screen.getByTestId('span-drawer-start').textContent).toBe(formatClockTime(T0));

    const panel = screen.getByTestId('retrieved-returned-panel');
    const retrieved = within(panel).getByTestId('retrieved-ids');
    const returned = within(panel).getByTestId('returned-ids');
    expect(retrieved.textContent).toMatch(/Retrieved \(seen\)/i);
    expect(retrieved.textContent).toMatch(/4 ids/);
    expect(retrieved.textContent).toContain('retrieval.retrieved.ids');
    expect(within(retrieved).getAllByRole('listitem').map(li => li.textContent)).toEqual(['d1', 'd2', 'd3', 'd4']);
    expect(returned.textContent).toMatch(/Returned \(recommended\)/i);
    expect(returned.textContent).toMatch(/3 ids/);
    expect(within(returned).getAllByRole('listitem').map(li => li.textContent)).toEqual(['d2', 'd4', 'd9']);
    expect(screen.getByTestId('retrieved-returned-overlap').textContent).toBe(
      '2 of 4 retrieved were returned; 1 returned id was not in the retrieved set'
    );
  });

  it('SpanDetailsPanel header wraps the full name and mounts the pair', () => {
    const root = flatSpans()[0];
    render(React.createElement(SpanDetailsPanel, { span: { ...root, name: LONG_TOOL }, onClose: jest.fn() }));
    const name = screen.getByTestId('span-details-name');
    expect(name.textContent).toBe(LONG_TOOL);
    expect(name.getAttribute('title')).toBe(LONG_TOOL);
    expect(name.className).not.toMatch(/truncate/);
    expect(screen.getByTestId('span-details-start').textContent).toBe(formatClockTime(T0));
    expect(screen.getByTestId('retrieved-returned-panel')).toBeTruthy();
  });

  it('RetrievedReturnedLists renders nothing for a span without either key family', () => {
    const { container } = render(React.createElement(RetrievedReturnedLists, { span: flatSpans()[1] }));
    expect(container.innerHTML).toBe('');
  });

  it('RetrievedReturnedLists shows one side alone with no overlap line', () => {
    const span: Span = { ...flatSpans()[1], attributes: { 'agent.retrieved.doc_ids': ['a', 'b'] } };
    render(React.createElement(RetrievedReturnedLists, { span }));
    expect(screen.getByTestId('retrieved-ids').textContent).toMatch(/2 ids/);
    expect(screen.queryByTestId('returned-ids')).toBeNull();
    expect(screen.queryByTestId('retrieved-returned-overlap')).toBeNull();
  });
});
