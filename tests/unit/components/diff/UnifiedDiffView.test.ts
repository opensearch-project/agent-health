/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the line-diff algorithm that powers the evaluator version
 * history Git-style diff view.
 *
 * Covers:
 *  - identical inputs → no add/remove operations
 *  - pure additions / pure removals
 *  - line replacements (remove followed by add)
 *  - empty inputs
 *  - LCS preservation across reordered hunks
 *  - summary counts
 */

import { diffLines, summarizeDiff } from '@/components/diff/UnifiedDiffView';

describe('diffLines (UnifiedDiffView)', () => {
  it('returns all-equal ops when both strings are identical', () => {
    const text = 'alpha\nbeta\ngamma';
    const lines = diffLines(text, text);
    expect(lines).toHaveLength(3);
    expect(lines.every((l) => l.op === 'equal')).toBe(true);
    // Line numbers stay in lockstep on both sides.
    expect(lines.map((l) => l.beforeLine)).toEqual([1, 2, 3]);
    expect(lines.map((l) => l.afterLine)).toEqual([1, 2, 3]);
  });

  it('records a pure addition with no removals', () => {
    const before = 'alpha\nbeta';
    const after = 'alpha\nbeta\ngamma';
    const lines = diffLines(before, after);
    const summary = summarizeDiff(lines);
    expect(summary).toEqual({ added: 1, removed: 0, unchanged: 2 });

    const added = lines.find((l) => l.op === 'add')!;
    expect(added.text).toBe('gamma');
    expect(added.beforeLine).toBeNull();
    expect(added.afterLine).toBe(3);
  });

  it('records a pure removal with no additions', () => {
    const before = 'alpha\nbeta\ngamma';
    const after = 'alpha\ngamma';
    const lines = diffLines(before, after);
    const summary = summarizeDiff(lines);
    expect(summary).toEqual({ added: 0, removed: 1, unchanged: 2 });

    const removed = lines.find((l) => l.op === 'remove')!;
    expect(removed.text).toBe('beta');
    expect(removed.beforeLine).toBe(2);
    expect(removed.afterLine).toBeNull();
  });

  it('represents a line replacement as remove + add', () => {
    const before = 'alpha\nbeta\ngamma';
    const after = 'alpha\nBETA\ngamma';
    const lines = diffLines(before, after);
    const ops = lines.map((l) => l.op);
    // Order isn't specified by LCS but for a single-line replacement we
    // expect equal, then remove and add (in either order), then equal.
    expect(ops[0]).toBe('equal');
    expect(ops[ops.length - 1]).toBe('equal');
    expect(ops.filter((o) => o === 'remove')).toHaveLength(1);
    expect(ops.filter((o) => o === 'add')).toHaveLength(1);

    const removed = lines.find((l) => l.op === 'remove')!;
    const added = lines.find((l) => l.op === 'add')!;
    expect(removed.text).toBe('beta');
    expect(added.text).toBe('BETA');
  });

  it('handles an empty "before" by reporting every line as added', () => {
    const lines = diffLines('', 'one\ntwo');
    // Splitting "" yields one empty line, so we expect one equal + adds.
    const adds = lines.filter((l) => l.op === 'add');
    expect(adds.length).toBeGreaterThanOrEqual(2);
    expect(adds.map((l) => l.text)).toEqual(expect.arrayContaining(['one', 'two']));
  });

  it('handles an empty "after" by reporting every line as removed', () => {
    const lines = diffLines('one\ntwo', '');
    const removes = lines.filter((l) => l.op === 'remove');
    expect(removes.length).toBeGreaterThanOrEqual(2);
    expect(removes.map((l) => l.text)).toEqual(expect.arrayContaining(['one', 'two']));
  });

  it('preserves the longest common subsequence across interleaved changes', () => {
    const before = 'a\nb\nc\nd\ne';
    const after = 'a\nB\nc\nD\ne';
    const lines = diffLines(before, after);
    const summary = summarizeDiff(lines);
    // a, c, e are common to both → 3 unchanged. b/B and d/D each contribute
    // one remove + one add.
    expect(summary.unchanged).toBe(3);
    expect(summary.added).toBe(2);
    expect(summary.removed).toBe(2);

    const equalTexts = lines.filter((l) => l.op === 'equal').map((l) => l.text);
    expect(equalTexts).toEqual(['a', 'c', 'e']);
  });
});

describe('summarizeDiff', () => {
  it('counts adds, removes, and unchanged lines independently', () => {
    const summary = summarizeDiff([
      { op: 'equal', text: 'x', beforeLine: 1, afterLine: 1 },
      { op: 'add', text: 'y', beforeLine: null, afterLine: 2 },
      { op: 'add', text: 'z', beforeLine: null, afterLine: 3 },
      { op: 'remove', text: 'w', beforeLine: 2, afterLine: null },
    ]);
    expect(summary).toEqual({ added: 2, removed: 1, unchanged: 1 });
  });
});
