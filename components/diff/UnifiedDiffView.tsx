/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * UnifiedDiffView
 *
 * A small, dependency-free Git-style line diff viewer.
 *
 * Renders three modes:
 *   - "unified" (default): single column with -/+ prefixes (like `git diff`)
 *   - "split":             two columns, before vs after, aligned by hunks
 *
 * The line-diff is computed via a classic Longest Common Subsequence (LCS)
 * walk so the output matches the structure produced by `diff --unified`
 * without pulling in any third-party diffing library.
 */

import React, { useMemo } from 'react';

export type DiffOp = 'equal' | 'add' | 'remove';

export interface DiffLine {
  op: DiffOp;
  text: string;
  /** 1-based line number in the "before" text, or null for additions */
  beforeLine: number | null;
  /** 1-based line number in the "after" text, or null for removals */
  afterLine: number | null;
}

/**
 * Compute a line-level diff between two strings using LCS.
 *
 * Produces a sequence of operations (equal/add/remove) that describes how to
 * transform `before` into `after`.
 *
 * Complexity: O(n*m) time and memory, where n,m are the line counts. For
 * evaluator system prompts (typically a few hundred lines at most) this is
 * comfortably fast and avoids any runtime dependency.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const n = a.length;
  const m = b.length;

  // dp[i][j] = LCS length of a[i..] and b[j..]
  // Allocate (n+1) x (m+1) using a flat typed array for memory locality.
  const dp = new Uint32Array((n + 1) * (m + 1));
  const idx = (i: number, j: number) => i * (m + 1) + j;

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) {
        dp[idx(i, j)] = dp[idx(i + 1, j + 1)] + 1;
      } else {
        const down = dp[idx(i + 1, j)];
        const right = dp[idx(i, j + 1)];
        dp[idx(i, j)] = down > right ? down : right;
      }
    }
  }

  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      lines.push({ op: 'equal', text: a[i], beforeLine: i + 1, afterLine: j + 1 });
      i++; j++;
    } else if (dp[idx(i + 1, j)] >= dp[idx(i, j + 1)]) {
      lines.push({ op: 'remove', text: a[i], beforeLine: i + 1, afterLine: null });
      i++;
    } else {
      lines.push({ op: 'add', text: b[j], beforeLine: null, afterLine: j + 1 });
      j++;
    }
  }
  while (i < n) {
    lines.push({ op: 'remove', text: a[i], beforeLine: i + 1, afterLine: null });
    i++;
  }
  while (j < m) {
    lines.push({ op: 'add', text: b[j], beforeLine: null, afterLine: j + 1 });
    j++;
  }
  return lines;
}

/**
 * Summarize a diff as `+X / -Y` counts for status badges.
 */
export function summarizeDiff(lines: DiffLine[]): { added: number; removed: number; unchanged: number } {
  let added = 0, removed = 0, unchanged = 0;
  for (const line of lines) {
    if (line.op === 'add') added++;
    else if (line.op === 'remove') removed++;
    else unchanged++;
  }
  return { added, removed, unchanged };
}

interface UnifiedDiffViewProps {
  before: string;
  after: string;
  /** Label for the "before" side, shown in headers / split view. */
  beforeLabel?: string;
  /** Label for the "after" side, shown in headers / split view. */
  afterLabel?: string;
  /** Rendering mode. */
  mode?: 'unified' | 'split';
  /**
   * Maximum equal lines to keep around a hunk before collapsing them into a
   * "@@ … @@" gutter. Set to Infinity (or a very large number) to disable
   * collapsing entirely.
   */
  contextLines?: number;
  /** Optional className for the outer container. */
  className?: string;
}

/**
 * Group diff lines into hunks separated by collapsed "@@" markers, mirroring
 * the way `git diff --unified=N` presents changes.
 */
function groupHunks(lines: DiffLine[], contextLines: number): Array<DiffLine[] | { collapsed: number }> {
  if (!Number.isFinite(contextLines) || contextLines >= lines.length) {
    return lines.length === 0 ? [] : [lines];
  }

  // Find indices of changes (non-equal lines).
  const changeIdx: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].op !== 'equal') changeIdx.push(i);
  }

  // Pure-equal diffs: nothing to show.
  if (changeIdx.length === 0) return [];

  const result: Array<DiffLine[] | { collapsed: number }> = [];
  let cursor = 0;

  // Walk in change-clusters, keeping `contextLines` of equal text on each side.
  let k = 0;
  while (k < changeIdx.length) {
    let hunkStart = Math.max(cursor, changeIdx[k] - contextLines);
    let hunkEnd = changeIdx[k];

    // Extend the hunk while subsequent changes fall within 2*contextLines.
    while (k + 1 < changeIdx.length && changeIdx[k + 1] - changeIdx[k] <= contextLines * 2) {
      k++;
      hunkEnd = changeIdx[k];
    }
    hunkEnd = Math.min(lines.length - 1, hunkEnd + contextLines);

    if (hunkStart > cursor) {
      result.push({ collapsed: hunkStart - cursor });
    }
    result.push(lines.slice(hunkStart, hunkEnd + 1));
    cursor = hunkEnd + 1;
    k++;
  }

  if (cursor < lines.length) {
    result.push({ collapsed: lines.length - cursor });
  }
  return result;
}

/**
 * Pretty-print a 1-based line number into a fixed-width gutter cell.
 */
const LineNumber: React.FC<{ value: number | null }> = ({ value }) => (
  <span className="inline-block w-10 pr-2 text-right text-muted-foreground select-none tabular-nums">
    {value ?? ''}
  </span>
);

const UnifiedRow: React.FC<{ line: DiffLine }> = ({ line }) => {
  const sigil = line.op === 'add' ? '+' : line.op === 'remove' ? '-' : ' ';
  const rowClass =
    line.op === 'add'
      ? 'bg-green-500/10 text-green-700 dark:text-green-300'
      : line.op === 'remove'
      ? 'bg-red-500/10 text-red-700 dark:text-red-300'
      : 'text-foreground/80';
  return (
    <div className={`flex font-mono text-xs leading-5 px-2 ${rowClass}`}>
      <LineNumber value={line.beforeLine} />
      <LineNumber value={line.afterLine} />
      <span className="w-4 select-none">{sigil}</span>
      <span className="whitespace-pre-wrap break-words flex-1">{line.text || ' '}</span>
    </div>
  );
};

const CollapsedRow: React.FC<{ count: number }> = ({ count }) => (
  <div className="flex font-mono text-xs leading-5 px-2 py-1 bg-muted/40 text-muted-foreground border-y border-border/50">
    <span className="w-24 text-center select-none">@@</span>
    <span className="flex-1 italic">{count} unchanged line{count === 1 ? '' : 's'} hidden</span>
  </div>
);

/**
 * Side-by-side rendering: pair adds with the most recent removes inside a hunk
 * so they line up like a typical "split" Git diff. Trailing unmatched lines on
 * either side are rendered with empty placeholders on the opposite column.
 */
function buildSplitRows(hunk: DiffLine[]): Array<{ left: DiffLine | null; right: DiffLine | null }> {
  const rows: Array<{ left: DiffLine | null; right: DiffLine | null }> = [];
  let i = 0;
  while (i < hunk.length) {
    const line = hunk[i];
    if (line.op === 'equal') {
      rows.push({ left: line, right: line });
      i++;
      continue;
    }
    // Collect a contiguous run of removes followed by adds.
    const removes: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < hunk.length && hunk[i].op === 'remove') { removes.push(hunk[i]); i++; }
    while (i < hunk.length && hunk[i].op === 'add') { adds.push(hunk[i]); i++; }
    const len = Math.max(removes.length, adds.length);
    for (let k = 0; k < len; k++) {
      rows.push({ left: removes[k] ?? null, right: adds[k] ?? null });
    }
  }
  return rows;
}

const SplitCell: React.FC<{ line: DiffLine | null; side: 'left' | 'right' }> = ({ line, side }) => {
  if (!line) {
    return <div className="flex-1 px-2 bg-muted/30" />;
  }
  const isChange =
    (side === 'left' && line.op === 'remove') ||
    (side === 'right' && line.op === 'add');
  const cls = isChange
    ? side === 'left'
      ? 'bg-red-500/10 text-red-700 dark:text-red-300'
      : 'bg-green-500/10 text-green-700 dark:text-green-300'
    : 'text-foreground/80';
  return (
    <div className={`flex-1 flex font-mono text-xs leading-5 px-2 ${cls}`}>
      <LineNumber value={side === 'left' ? line.beforeLine : line.afterLine} />
      <span className="whitespace-pre-wrap break-words flex-1">{line.text || ' '}</span>
    </div>
  );
};

export const UnifiedDiffView: React.FC<UnifiedDiffViewProps> = ({
  before,
  after,
  beforeLabel = 'Before',
  afterLabel = 'After',
  mode = 'unified',
  contextLines = 3,
  className = '',
}) => {
  const lines = useMemo(() => diffLines(before, after), [before, after]);
  const summary = useMemo(() => summarizeDiff(lines), [lines]);
  const hunks = useMemo(() => groupHunks(lines, contextLines), [lines, contextLines]);

  const isIdentical = summary.added === 0 && summary.removed === 0;

  return (
    <div className={`border rounded-md overflow-hidden bg-background ${className}`}>
      {/* Header: Git-like file header with +/- counts */}
      <div className="flex items-center justify-between px-3 py-2 bg-muted/50 border-b text-xs">
        <div className="flex items-center gap-3">
          <span className="font-semibold">{beforeLabel}</span>
          <span className="text-muted-foreground">→</span>
          <span className="font-semibold">{afterLabel}</span>
        </div>
        <div className="flex items-center gap-3 font-mono">
          <span className="text-green-600 dark:text-green-400">+{summary.added}</span>
          <span className="text-red-600 dark:text-red-400">−{summary.removed}</span>
        </div>
      </div>

      {/* Body */}
      {isIdentical ? (
        <div className="px-3 py-6 text-center text-sm text-muted-foreground italic">
          No differences — both versions are identical.
        </div>
      ) : mode === 'split' ? (
        <div className="overflow-x-auto">
          <div className="flex border-b text-[11px] uppercase tracking-wide text-muted-foreground bg-muted/30">
            <div className="flex-1 px-2 py-1">{beforeLabel}</div>
            <div className="flex-1 px-2 py-1 border-l">{afterLabel}</div>
          </div>
          {hunks.map((hunk, idx) =>
            'collapsed' in hunk ? (
              <CollapsedRow key={`c-${idx}`} count={hunk.collapsed} />
            ) : (
              <React.Fragment key={`h-${idx}`}>
                {buildSplitRows(hunk).map((row, rIdx) => (
                  <div key={`r-${idx}-${rIdx}`} className="flex">
                    <SplitCell line={row.left} side="left" />
                    <div className="border-l" />
                    <SplitCell line={row.right} side="right" />
                  </div>
                ))}
              </React.Fragment>
            )
          )}
        </div>
      ) : (
        <div className="overflow-x-auto py-1">
          {hunks.map((hunk, idx) =>
            'collapsed' in hunk ? (
              <CollapsedRow key={`c-${idx}`} count={hunk.collapsed} />
            ) : (
              <React.Fragment key={`h-${idx}`}>
                {hunk.map((line, lIdx) => (
                  <UnifiedRow key={`u-${idx}-${lIdx}`} line={line} />
                ))}
              </React.Fragment>
            )
          )}
        </div>
      )}
    </div>
  );
};

export default UnifiedDiffView;
