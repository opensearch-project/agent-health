/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { attributeLeafUsage, findUsageAggregateSpans } from '@/lib/usageAggregates';

interface S { traceId?: string; spanId?: string; parentSpanId?: string; input?: number; output?: number }

const readUsage = (s: S) => ({ input: s.input ?? 0, output: s.output ?? 0 });
const span = (spanId: string, parentSpanId?: string, input?: number, output?: number, traceId = 't1'): S =>
  ({ traceId, spanId, parentSpanId, input, output });

const totals = (spans: S[]) => {
  const attributed = attributeLeafUsage(spans, readUsage);
  let input = 0, output = 0, aggregates = 0;
  attributed.forEach(u => { input += u.input; output += u.output; if (u.isAggregate) aggregates++; });
  return { input, output, aggregates, attributed };
};

describe('attributeLeafUsage', () => {
  it('exact roll-up: parent == sum of children ⇒ parent contributes 0 and is an aggregate', () => {
    const parent = span('agent', undefined, 300, 30);
    const c1 = span('chat1', 'agent', 100, 10);
    const c2 = span('chat2', 'agent', 200, 20);
    const t = totals([parent, c1, c2]);
    expect(t.input).toBe(300);
    expect(t.output).toBe(30);
    expect(t.aggregates).toBe(1);
    expect(t.attributed.get(parent)).toEqual({ input: 0, output: 0, isAggregate: true });
    expect(t.attributed.get(c1)).toEqual({ input: 100, output: 10, isAggregate: false });
  });

  it('parent carries usage while no descendant does ⇒ counted in full, not an aggregate', () => {
    const parent = span('agent', undefined, 300, 30);
    const tool = span('tool', 'agent');
    const t = totals([parent, tool]);
    expect(t.input).toBe(300);
    expect(t.aggregates).toBe(0);
    expect(t.attributed.get(parent)!.isAggregate).toBe(false);
  });

  it('children only ⇒ untouched', () => {
    const t = totals([span('agent'), span('chat1', 'agent', 100, 10)]);
    expect(t.input).toBe(100);
    expect(t.aggregates).toBe(0);
  });

  it('parent carries MORE than its descendants ⇒ the remainder is counted, nothing is dropped', () => {
    // A real request span whose nested span only records part of the usage.
    const parent = span('request', undefined, 1000, 100);
    const partial = span('stream', 'request', 700, 100);
    const t = totals([parent, partial]);
    expect(t.input).toBe(1000);
    expect(t.output).toBe(100);
    expect(t.aggregates).toBe(0);
    expect(t.attributed.get(parent)).toEqual({ input: 300, output: 0, isAggregate: false });
  });

  it('parent carries LESS than its descendants ⇒ clamped at 0, descendants counted', () => {
    const parent = span('p', undefined, 50, 5);
    const child = span('c', 'p', 100, 10);
    const t = totals([parent, child]);
    expect(t.input).toBe(100);
    expect(t.output).toBe(10);
    expect(t.attributed.get(parent)!.isAggregate).toBe(true);
  });

  it('input and output are attributed independently', () => {
    const parent = span('p', undefined, 100, 50);   // input fully covered, output not at all
    const child = span('c', 'p', 100, 0);
    const t = totals([parent, child]);
    expect(t.input).toBe(100);
    expect(t.output).toBe(50);
    expect(t.attributed.get(parent)).toEqual({ input: 0, output: 50, isAggregate: false });
  });

  it('nested roll-ups through a passthrough wrapper are handled at every level', () => {
    const root = span('root', undefined, 500, 50);   // roll-up of everything
    const cycle = span('cycle', 'root');             // no usage
    const wrap = span('wrap', 'cycle', 500, 50);     // roll-up of chat
    const chat = span('chat', 'wrap', 500, 50);      // leaf
    const t = totals([root, cycle, wrap, chat]);
    expect(t.input).toBe(500);
    expect(t.aggregates).toBe(2);
    expect(t.attributed.get(root)!.isAggregate).toBe(true);
    expect(t.attributed.get(wrap)!.isAggregate).toBe(true);
    expect(t.attributed.get(chat)!.isAggregate).toBe(false);
  });

  it('mixed tree: aggregate in one branch, lone usage in another', () => {
    const root = span('root');
    const a = span('a', 'root', 30, 3);        // aggregate of a1
    const a1 = span('a1', 'a', 30, 3);
    const b = span('b', 'root', 70, 7);        // only usage in its branch → counted
    const b1 = span('b1', 'b');
    const t = totals([root, a, a1, b, b1]);
    expect(t.input).toBe(100);
    expect(t.aggregates).toBe(1);
    expect(t.attributed.get(a)!.isAggregate).toBe(true);
    expect(t.attributed.get(b)!.isAggregate).toBe(false);
  });

  it('does not link spans across traces even when span ids collide', () => {
    const parent = span('p', undefined, 10, 1, 'trace-A');
    const child = span('c', 'p', 10, 1, 'trace-B');
    const t = totals([parent, child]);
    expect(t.input).toBe(20);
    expect(t.aggregates).toBe(0);
  });

  it('tolerates orphans, missing ids and cycles (no infinite loop, nothing negative)', () => {
    const orphan = span('o', 'missing', 10, 1);
    const noId: S = { traceId: 't1', input: 5, output: 1 };
    const x = span('x', 'y', 1, 1);
    const y = span('y', 'x', 1, 1);
    const t = totals([orphan, noId, x, y]);
    expect(t.attributed.get(orphan)).toEqual({ input: 10, output: 1, isAggregate: false });
    expect(t.attributed.get(noId)).toEqual({ input: 5, output: 1, isAggregate: false });
    t.attributed.forEach(u => { expect(u.input).toBeGreaterThanOrEqual(0); expect(u.output).toBeGreaterThanOrEqual(0); });
    // Cycle x<->y: each is the other's "descendant"; whichever is visited first
    // absorbs the other's usage — the pair is counted once, never twice.
    expect(t.attributed.get(x)!.input + t.attributed.get(y)!.input).toBe(1);
  });

  it('is order-independent (children listed before parents)', () => {
    const c1 = span('chat1', 'agent', 100, 10);
    const parent = span('agent', undefined, 300, 30);
    const c2 = span('chat2', 'agent', 200, 20);
    const t = totals([c1, parent, c2]);
    expect(t.input).toBe(300);
    expect(t.aggregates).toBe(1);
  });
});

describe('findUsageAggregateSpans', () => {
  it('returns exactly the pure roll-up spans', () => {
    const parent = span('agent', undefined, 300, 30);
    const c1 = span('chat1', 'agent', 100, 10);
    const c2 = span('chat2', 'agent', 200, 20);
    const partialParent = span('req', undefined, 1000, 0);
    const partialChild = span('stream', 'req', 700, 0);
    const skipped = findUsageAggregateSpans([parent, c1, c2, partialParent, partialChild], readUsage);
    expect(skipped.has(parent)).toBe(true);
    expect(skipped.has(partialParent)).toBe(false);
    expect(skipped.size).toBe(1);
  });
});
