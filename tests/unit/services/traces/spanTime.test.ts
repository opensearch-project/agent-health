/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Span ordering guarantee (roots, children and the flattened visible list all
 * sort by startTime with spanId as the tie-break) and the absolute-time /
 * offset labels shown on every trace row.
 */

import { Span } from '@/types';
import { processSpansIntoTree, flattenVisibleSpans, sortByStartTime } from '@/services/traces';
import {
  compareSpansByStartTime,
  sortSpansByStartTime,
  getTraceAnchorMs,
  formatClockTime,
  formatIsoTime,
  formatTraceOffset,
  getSpanTimeLabels,
} from '@/services/traces/spanTime';

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();

function mk(spanId: string, startOffsetMs: number, parentSpanId?: string, durationMs = 10): Span {
  return {
    traceId: 'trace-1',
    spanId,
    parentSpanId,
    name: `span ${spanId}`,
    startTime: iso(T0 + startOffsetMs),
    endTime: iso(T0 + startOffsetMs + durationMs),
    duration: durationMs,
    status: 'OK',
  };
}

describe('compareSpansByStartTime / sortSpansByStartTime', () => {
  it('orders by startTime ascending', () => {
    const sorted = sortSpansByStartTime([mk('c', 300), mk('a', 100), mk('b', 200)]);
    expect(sorted.map(s => s.spanId)).toEqual(['a', 'b', 'c']);
  });

  it('breaks ties on the same millisecond by spanId, regardless of input order', () => {
    const forward = sortSpansByStartTime([mk('x', 50), mk('m', 50), mk('a', 50)]);
    const backward = sortSpansByStartTime([mk('a', 50), mk('m', 50), mk('x', 50)]);
    expect(forward.map(s => s.spanId)).toEqual(['a', 'm', 'x']);
    expect(backward.map(s => s.spanId)).toEqual(['a', 'm', 'x']);
    expect(compareSpansByStartTime(mk('a', 50), mk('a', 50))).toBe(0);
  });

  it('does not mutate its input', () => {
    const input = [mk('b', 2), mk('a', 1)];
    const copy = [...input];
    sortSpansByStartTime(input);
    expect(input).toEqual(copy);
  });

  it('sorts spans with an unparseable startTime LAST rather than throwing or faking the epoch', () => {
    const bad = { ...mk('bad', 5), startTime: 'not-a-date' };
    expect(sortSpansByStartTime([bad, mk('a', 1)]).map(s => s.spanId)).toEqual(['a', 'bad']);
  });
});

describe('processSpansIntoTree ordering guarantee', () => {
  it('sorts ROOTS by start time with the spanId tie-break', () => {
    const roots = processSpansIntoTree([mk('r-late', 500), mk('r-b', 100), mk('r-a', 100)]);
    expect(roots.map(s => s.spanId)).toEqual(['r-a', 'r-b', 'r-late']);
  });

  it('sorts CHILDREN at every depth the same way', () => {
    const tree = processSpansIntoTree([
      mk('root', 0, undefined, 1000),
      mk('c3', 300, 'root'),
      mk('c1', 100, 'root'),
      mk('c2b', 200, 'root'),
      mk('c2a', 200, 'root'),
      mk('g2', 120, 'c1'),
      mk('g1', 110, 'c1'),
    ]);
    expect(tree[0].children!.map(s => s.spanId)).toEqual(['c1', 'c2a', 'c2b', 'c3']);
    expect(tree[0].children![0].children!.map(s => s.spanId)).toEqual(['g1', 'g2']);
  });

  it('the flattened visible list is the depth-first walk of that order', () => {
    const tree = processSpansIntoTree([
      mk('root', 0, undefined, 1000),
      mk('c2', 200, 'root'),
      mk('c1', 100, 'root'),
      mk('g1', 110, 'c1'),
    ]);
    const flat = flattenVisibleSpans(tree, new Set(['root', 'c1']));
    expect(flat.map(s => s.spanId)).toEqual(['root', 'c1', 'g1', 'c2']);
    // Collapsing c1 hides its child but keeps sibling order.
    expect(flattenVisibleSpans(tree, new Set(['root'])).map(s => s.spanId)).toEqual(['root', 'c1', 'c2']);
  });

  it('the execution-order flow sorts siblings with the identical comparator', () => {
    const siblings = [mk('b', 5), mk('a', 5), mk('z', 1)] as any[];
    expect(sortByStartTime(siblings).map((s: Span) => s.spanId)).toEqual(['z', 'a', 'b']);
  });
});

describe('absolute time + offset labels', () => {
  it('getTraceAnchorMs is the earliest ROOT start; a clock-skewed child gets a negative offset instead of moving t=0', () => {
    const tree = processSpansIntoTree([mk('root', 100, undefined, 1000), mk('skewed', 90, 'root')]);
    expect(getTraceAnchorMs(tree)).toBe(T0 + 100);
    expect(getSpanTimeLabels(tree[0].children![0], getTraceAnchorMs(tree)).offset).toBe('-0.010 s');
    // Several roots (window-fetched sibling traces): the earliest root anchors.
    expect(getTraceAnchorMs(processSpansIntoTree([mk('r2', 500), mk('r1', 200)]))).toBe(T0 + 200);
    expect(getTraceAnchorMs([])).toBeNull();
    expect(getTraceAnchorMs([{ ...mk('x', 0), startTime: 'nope' }])).toBeNull();
  });

  it('formatClockTime renders local HH:MM:SS.mmm and tolerates bad input', () => {
    const local = new Date(2026, 0, 1, 14, 3, 22, 7); // constructed in local time on purpose
    expect(formatClockTime(local)).toBe('14:03:22.007');
    expect(formatClockTime(local.toISOString())).toBe('14:03:22.007');
    expect(formatClockTime('garbage')).toBe('');
  });

  it('formatIsoTime is the full UTC timestamp for tooltips', () => {
    expect(formatIsoTime(T0)).toBe('2026-01-01T12:00:00.000Z');
    expect(formatIsoTime('garbage')).toBe('');
  });

  it('formatTraceOffset is +N.NNN s with sign, three decimals, never clamped', () => {
    expect(formatTraceOffset(0)).toBe('+0.000 s');
    expect(formatTraceOffset(1234)).toBe('+1.234 s');
    expect(formatTraceOffset(83412.6)).toBe('+83.413 s');
    expect(formatTraceOffset(-2)).toBe('-0.002 s');
    expect(formatTraceOffset(NaN)).toBe('');
  });

  it('getSpanTimeLabels combines clock, iso and offset from the anchor', () => {
    const labels = getSpanTimeLabels(mk('s', 1234), T0);
    expect(labels.iso).toBe('2026-01-01T12:00:01.234Z');
    expect(labels.offset).toBe('+1.234 s');
    expect(labels.clock).toBe(formatClockTime(T0 + 1234));
    expect(getSpanTimeLabels(mk('s', 5), null).offset).toBe('');
  });
});
