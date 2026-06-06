/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { formatMetricsBreakdown } from '@/components/RunScore';

// `formatMetricsBreakdown` is the data half of `<RunScore>` — extracting it
// from the React component lets us assert tooltip content without rendering.
// The component itself wraps a thin tooltip around it, so behavior coverage
// here + behavior coverage of `getRunOverallScore` (in lib/utils.test.ts)
// covers everything the tooltip can show.
describe('RunScore — formatMetricsBreakdown', () => {
  it('lists each populated numeric metric in alphabetical order', () => {
    // Keys are intentionally in non-alphabetical insertion order to verify
    // sorting kicks in. Alphabetical matters because the same evaluator
    // should produce the same breakdown order across renders.
    expect(formatMetricsBreakdown({
      tool_ordering: 70,
      redundant_calls: 90,
      tool_selection_accuracy: 80,
    })).toEqual([
      'redundant_calls: 90%',
      'tool_ordering: 70%',
      'tool_selection_accuracy: 80%',
    ]);
  });

  it('rounds non-integer metric values for display', () => {
    expect(formatMetricsBreakdown({ accuracy: 84.6 })).toEqual(['accuracy: 85%']);
    expect(formatMetricsBreakdown({ a: 33.4, b: 33.5 })).toEqual([
      'a: 33%',
      'b: 34%',
    ]);
  });

  it('skips entries with non-numeric or undefined values', () => {
    // Mirrors how `EvaluationMetrics` is shaped — the index signature allows
    // `undefined`. Skipping (rather than rendering "metric: undefined%")
    // keeps the tooltip clean for legacy reports that have stub keys.
    expect(formatMetricsBreakdown({
      accuracy: 80,
      faithfulness: undefined,
      latency_score: undefined,
    })).toEqual(['accuracy: 80%']);
  });

  it('skips NaN and Infinity defensively', () => {
    expect(formatMetricsBreakdown({
      a: 50,
      b: NaN as any,
      c: Infinity as any,
    })).toEqual(['a: 50%']);
  });

  it('returns an empty list for empty / null / undefined input', () => {
    expect(formatMetricsBreakdown({})).toEqual([]);
    expect(formatMetricsBreakdown(undefined)).toEqual([]);
    expect(formatMetricsBreakdown(null)).toEqual([]);
  });

  it('preserves a legitimate zero-valued metric (does not collapse it)', () => {
    // 0% is a real outcome; we want it to show up in the tooltip so the
    // user can see *which* metric scored zero, not just the aggregate.
    expect(formatMetricsBreakdown({ safety_score: 0 })).toEqual(['safety_score: 0%']);
  });
});
