/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Layers, CheckCircle2, GitCompare } from 'lucide-react';
import type { TestCaseOverlap } from '@/services/comparisonService';

/**
 * ComparisonOverlapBanner — the test-level honesty surface.
 *
 * Comparison is a test-case-level primitive: any set of runs can be compared,
 * benchmark or not. This banner makes the overlap explicit so a comparison of
 * runs with different (or partially-different) test-case coverage is never
 * silently misread as apples-to-apples. It renders two ways:
 *
 *   - fully overlapping  → subtle confirmation ("all N runs ran the same X cases").
 *   - partial overlap    → amber callout naming how many cases are shared vs
 *                          only-in-some, so the "Not run" rows below have context.
 */
export const ComparisonOverlapBanner: React.FC<{ overlap: TestCaseOverlap }> = ({ overlap }) => {
  if (overlap.runCount < 2 || overlap.totalTestCases === 0) return null;

  if (overlap.fullyOverlapping) {
    return (
      <div
        data-testid="comparison-overlap-banner"
        data-overlap="full"
        className="flex items-center gap-2 px-3 py-2 rounded-lg border border-green-300 dark:border-green-500/30 bg-green-50 dark:bg-green-500/10 text-green-800 dark:text-green-300 text-xs"
      >
        <CheckCircle2 size={14} className="shrink-0" />
        <span>
          All {overlap.runCount} runs ran the same{' '}
          <span className="font-semibold">{overlap.totalTestCases}</span> test{' '}
          case{overlap.totalTestCases === 1 ? '' : 's'} — fully comparable.
        </span>
      </div>
    );
  }

  return (
    <div
      data-testid="comparison-overlap-banner"
      data-overlap="partial"
      className="flex items-start gap-2 px-3 py-2 rounded-lg border border-amber-300 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 text-amber-800 dark:text-amber-300 text-xs"
    >
      <GitCompare size={14} className="shrink-0 mt-0.5" />
      <div className="space-y-1">
        <div>
          <span className="font-semibold">{overlap.sharedTestCases}</span> test
          case{overlap.sharedTestCases === 1 ? '' : 's'} in common across all{' '}
          {overlap.runCount} runs ·{' '}
          <span className="font-semibold">{overlap.partialTestCases}</span> only in
          some runs (shown as <span className="font-medium">“Not run”</span> where
          a run skipped them).
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-amber-700/80 dark:text-amber-300/70">
          <span className="inline-flex items-center gap-1">
            <Layers size={10} /> {overlap.totalTestCases} unique test cases total
          </span>
          {overlap.perRun.map(r => (
            <span key={r.runId} className="inline-flex items-center gap-1">
              <span className="font-medium text-amber-800 dark:text-amber-200">{r.runName}</span>
              : {r.count} ran{r.uniqueCount > 0 ? `, ${r.uniqueCount} only here` : ''}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
};
