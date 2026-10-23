/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The Gantt timeline's HTML label column: one row per visible span aligned to
 * the ECharts category axis, each with a caret (expand/collapse), the span
 * name as a button that selects the span (full name in title), and the
 * absolute start + offset cell; header states the ordering and pins t=0.
 * ECharts itself is mocked — the canvas is not what is under test.
 */

import * as React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import TraceTimelineChart from '@/components/traces/TraceTimelineChart';
import { processSpansIntoTree, calculateTimeRange } from '@/services/traces';
import { formatClockTime } from '@/services/traces/spanTime';
import { Span } from '@/types';

const setOption = jest.fn();
jest.mock('echarts', () => ({
  init: () => ({ setOption, on: jest.fn(), off: jest.fn(), resize: jest.fn(), dispose: jest.fn() }),
}));

const T0 = Date.UTC(2026, 2, 3, 9, 15, 30, 250);
const iso = (ms: number) => new Date(ms).toISOString();
const LONG = 'invoke_agent a-service-name-long-enough-to-be-ellipsized-in-any-reasonable-column';

function spans(): Span[] {
  return [
    { traceId: 't', spanId: 'root', name: 'POST /ask', status: 'OK', startTime: iso(T0), endTime: iso(T0 + 5000), attributes: {} },
    { traceId: 't', spanId: 'b', parentSpanId: 'root', name: 'chat', status: 'OK', startTime: iso(T0 + 1234), endTime: iso(T0 + 2000), attributes: {} },
    { traceId: 't', spanId: 'a', parentSpanId: 'root', name: LONG, status: 'ERROR', startTime: iso(T0 + 100), endTime: iso(T0 + 900), attributes: {} },
    { traceId: 't', spanId: 'leaf', parentSpanId: 'a', name: 'hidden child', status: 'OK', startTime: iso(T0 + 200), endTime: iso(T0 + 300), attributes: {} },
  ];
}

function renderChart(overrides: Partial<React.ComponentProps<typeof TraceTimelineChart>> = {}) {
  const flat = spans();
  const onSelectSpan = jest.fn();
  const onToggleExpand = jest.fn();
  render(
    React.createElement(TraceTimelineChart, {
      spanTree: processSpansIntoTree(flat),
      timeRange: calculateTimeRange(flat),
      selectedSpan: null,
      onSelectSpan,
      expandedSpans: new Set(['root']),
      onToggleExpand,
      ...overrides,
    })
  );
  return { onSelectSpan, onToggleExpand };
}

describe('TraceTimelineChart — HTML label column', () => {
  beforeEach(() => setOption.mockClear());

  it('renders one label row per visible span, in start order, with clock + offset and ISO tooltip', () => {
    renderChart();
    const rows = screen.getAllByTestId('timeline-row');
    expect(rows.map(r => r.getAttribute('data-span-id'))).toEqual(['root', 'a', 'b']); // 'leaf' hidden (a collapsed)
    expect(screen.getAllByTestId('span-row-clock').map(e => e.textContent)).toEqual([
      formatClockTime(T0), formatClockTime(T0 + 100), formatClockTime(T0 + 1234),
    ]);
    expect(screen.getAllByTestId('span-row-offset').map(e => e.textContent)).toEqual(['+0.000 s', '+0.100 s', '+1.234 s']);
    expect(screen.getAllByTestId('span-row-time')[1].getAttribute('title')).toContain('2026-03-03T09:15:30.350Z');
    // Rows are stacked at HEADER_HEIGHT + idx * ROW_HEIGHT so they line up with the bars.
    const tops = rows.map(r => parseInt((r as HTMLElement).style.top, 10));
    expect(tops[1] - tops[0]).toBe(20);
    expect(tops[2] - tops[1]).toBe(20);
  });

  it('header states the ordering and pins t=0 to the root start; ECharts axis labels are hidden', () => {
    renderChart();
    expect(screen.getByTestId('trace-list-sort-hint').textContent).toMatch(/sorted by start time/);
    const anchor = screen.getByTestId('trace-anchor-time');
    expect(anchor.textContent).toBe(`t=0 = ${formatClockTime(T0)}`);
    expect(anchor.getAttribute('title')).toContain('2026-03-03T09:15:30.250Z');
    const option = setOption.mock.calls[0][0];
    expect(option.yAxis.axisLabel.show).toBe(false);
    expect(option.grid.left).toBeGreaterThanOrEqual(300);
    // Tooltip includes start + offset + ISO for the hovered bar.
    const html = option.tooltip.formatter({ data: { span: spans()[1] } });
    expect(html).toContain('+1.234 s');
    expect(html).toContain('2026-03-03T09:15:31.484Z');
  });

  it('name button selects the span (full name in title, error marker), caret toggles expansion', () => {
    const { onSelectSpan, onToggleExpand } = renderChart();
    const names = screen.getAllByTestId('span-row-name');
    expect(names[1].getAttribute('title')).toBe(LONG);
    expect(names[1].textContent).toBe(`⚠ ${LONG}`);
    fireEvent.click(names[1]);
    expect(onSelectSpan).toHaveBeenCalledTimes(1);
    expect(onSelectSpan.mock.calls[0][0].spanId).toBe('a');

    const carets = screen.getAllByTestId('span-row-expand');
    expect(carets).toHaveLength(2); // root (expanded) and a (collapsed); b and leaf have no children
    expect(carets[1].getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(carets[1]);
    expect(onToggleExpand).toHaveBeenCalledWith('a');
    expect(onSelectSpan).toHaveBeenCalledTimes(1); // caret does not select

    // Clicking the row background (not a button) also selects, like the tree table.
    fireEvent.click(screen.getAllByTestId('timeline-row')[2]);
    expect(onSelectSpan).toHaveBeenCalledTimes(2);
    expect(onSelectSpan.mock.calls[1][0].spanId).toBe('b');
  });

  it('a one-row trace keeps the band geometry (no minimum-height floor stretching the bands)', () => {
    const only: Span = { traceId: 't', spanId: 'solo', name: 'solo', status: 'OK', startTime: iso(T0), endTime: iso(T0 + 10), attributes: {} };
    renderChart({ spanTree: processSpansIntoTree([only]), timeRange: calculateTimeRange([only]) });
    const labels = screen.getByTestId('trace-timeline-labels') as HTMLElement;
    expect(parseInt(labels.style.height, 10)).toBe(22 + 20 + 30);
    const option = setOption.mock.calls.at(-1)[0];
    expect(option.grid.top).toBe(22);
    expect(option.grid.bottom).toBe(30);
  });

  it('the resize handle widens the label column and the grid follows', () => {
    renderChart();
    const before = setOption.mock.calls.at(-1)[0].grid.left;
    const handle = screen.getByTestId('span-name-col-resize');
    fireEvent.mouseDown(handle, { clientX: 100 });
    fireEvent.mouseMove(document, { clientX: 180 });
    fireEvent.mouseUp(document);
    const labels = screen.getByTestId('trace-timeline-labels') as HTMLElement;
    expect(parseInt(labels.style.width, 10)).toBe(before + 80);
    expect(setOption.mock.calls.at(-1)[0].grid.left).toBe(before + 80);
    fireEvent.doubleClick(handle);
    expect(parseInt(labels.style.width, 10)).toBe(before);
  });
});
