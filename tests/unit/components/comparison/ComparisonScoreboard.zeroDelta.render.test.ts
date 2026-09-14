/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Render tests for ComparisonScoreboard's zero/non-zero delta rendering
 * (codecov/patch #430 follow-up).
 *
 * ComparisonScoreboard.test.ts (source-analysis) asserts the SOURCE TEXT
 * contains the em-dash fix, but never executes the component, so it cannot
 * move code coverage. This file actually mounts ComparisonScoreboard (and,
 * via the condensed-band tests, its IntersectionObserver-gated CondensedBand
 * sub-component) and exercises every branch touched by the fix:
 *  - delta === 0 -> em dash + `title="No change"` (was a bare "=" glyph)
 *  - delta > 0 / delta < 0 -> signed value, colored, no tooltip
 * for the pass-rate, cost, and duration deltas in both the expanded table
 * footer and the condensed one-liner band.
 */

import * as React from 'react';
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ComparisonScoreboard } from '@/components/comparison/ComparisonScoreboard';
import type { RunAggregateMetrics, BenchmarkRun } from '@/types';
import type { TestCaseOverlap } from '@/services/comparisonService';

// jsdom has no IntersectionObserver. Capture the callback the component
// registers so tests can flip the scoreboard into its condensed state
// on demand (mirrors the pattern in RunInspectorPage.test.ts).
type IOCallback = (entries: Array<{ isIntersecting: boolean }>) => void;
let ioCallback: IOCallback = () => {};
class MockIntersectionObserver {
  constructor(cb: IOCallback) {
    ioCallback = cb;
  }
  observe() {}
  disconnect() {}
}
(global as any).IntersectionObserver = MockIntersectionObserver;

function makeRun(overrides: Partial<RunAggregateMetrics> = {}): RunAggregateMetrics {
  return {
    runId: 'run-a',
    runName: 'Run A',
    createdAt: '2024-01-01T00:00:00Z',
    modelId: 'claude-3',
    agentKey: 'agent-a',
    totalTestCases: 10,
    passedCount: 8,
    failedCount: 2,
    avgAccuracy: 80,
    passRatePercent: 80,
    totalCostUsd: 1.5,
    avgDurationMs: 5000,
    ...overrides,
  } as RunAggregateMetrics;
}

const overlap: TestCaseOverlap = {
  runCount: 2,
  totalTestCases: 10,
  sharedTestCases: 10,
  partialTestCases: 0,
  perRun: [],
  fullyOverlapping: true,
};

const selectedRuns = [
  { id: 'run-a', results: {} } as unknown as BenchmarkRun,
  { id: 'run-b', results: {} } as unknown as BenchmarkRun,
];

function renderScoreboard(runs: RunAggregateMetrics[]) {
  return render(
    React.createElement(
      MemoryRouter,
      null,
      React.createElement(ComparisonScoreboard, {
        runs,
        selectedRuns,
        overlap,
        onRemoveRun: jest.fn(),
        onSwapRuns: jest.fn(),
        getAgentName: (key: string) => key,
      }),
    ),
  );
}

describe('ComparisonScoreboard — delta footer (expanded table)', () => {
  it('renders an em dash + "No change" tooltip when pass rate, cost, and duration are all identical', () => {
    const a = makeRun();
    const b = makeRun({ runId: 'run-b', runName: 'Run B' }); // identical metrics -> every delta is 0
    renderScoreboard([a, b]);

    const passRate = screen.getByTestId('scoreboard-delta-passrate');
    expect(passRate.textContent).toBe('\u2014');
    expect(passRate.title).toBe('No change');
    expect(passRate.className).toContain('text-muted-foreground');

    const cost = screen.getByTestId('scoreboard-delta-cost');
    expect(cost.textContent).toBe('\u2014');
    expect(cost.title).toBe('No change');
    expect(cost.className).toContain('text-muted-foreground');

    const duration = screen.getByTestId('scoreboard-delta-duration');
    expect(duration.textContent).toBe('\u2014');
    expect(duration.title).toBe('No change');
    expect(duration.className).toContain('text-muted-foreground');
  });

  it('renders a positive (blue) pass-rate delta and a green (improved) cost delta with no tooltip', () => {
    const a = makeRun({ passRatePercent: 90, totalCostUsd: 1.0 });
    const b = makeRun({ runId: 'run-b', runName: 'Run B', passRatePercent: 70, totalCostUsd: 2.0 });
    renderScoreboard([a, b]);

    const passRate = screen.getByTestId('scoreboard-delta-passrate');
    expect(passRate.textContent).toBe('+20pp');
    // Two legacy-scored fixtures: no "No change" tooltip, but the Δ does carry
    // the legacy-provenance caveat (both runs lack a scoring snapshot).
    expect(passRate.title).not.toBe('No change');
    expect(passRate.title).toContain('legacy-scored');
    expect(passRate.className).toContain('text-blue-400');

    const cost = screen.getByTestId('scoreboard-delta-cost');
    expect(cost.textContent).not.toBe('\u2014');
    expect(cost.title).toBe('');
    expect(cost.className).toContain('text-green-400'); // cost went down = improvement
  });

  it('renders a negative (red) pass-rate delta and a red (regressed) duration delta', () => {
    const a = makeRun({ passRatePercent: 60, avgDurationMs: 6000 });
    const b = makeRun({ runId: 'run-b', runName: 'Run B', passRatePercent: 80, avgDurationMs: 5000 });
    renderScoreboard([a, b]);

    const passRate = screen.getByTestId('scoreboard-delta-passrate');
    expect(passRate.textContent).toBe('-20pp');
    expect(passRate.className).toContain('text-red-400');

    const duration = screen.getByTestId('scoreboard-delta-duration');
    expect(duration.textContent).toContain('+'); // A slower than B -> positive, regression
    expect(duration.className).toContain('text-red-400');
  });

  it('omits the cost/duration delta cells entirely when totalCostUsd/avgDurationMs are undefined', () => {
    const a = makeRun({ totalCostUsd: undefined, avgDurationMs: undefined });
    const b = makeRun({ runId: 'run-b', runName: 'Run B', totalCostUsd: undefined, avgDurationMs: undefined });
    renderScoreboard([a, b]);

    expect(screen.queryByTestId('scoreboard-delta-cost')).toBeNull();
    expect(screen.queryByTestId('scoreboard-delta-duration')).toBeNull();
    // Pass-rate delta is still shown (it doesn't depend on cost/duration).
    expect(screen.getByTestId('scoreboard-delta-passrate')).toBeTruthy();
  });
});

describe('ComparisonScoreboard — condensed band', () => {
  function condense() {
    act(() => {
      ioCallback([{ isIntersecting: false }]);
    });
  }

  it('renders an em dash + "No change" tooltip for a zero pass-rate delta when condensed', () => {
    const a = makeRun();
    const b = makeRun({ runId: 'run-b', runName: 'Run B' }); // same passRatePercent
    renderScoreboard([a, b]);
    condense();

    const band = screen.getByTestId('scoreboard-condensed');
    const delta = band.querySelector('span.font-medium.tabular-nums') as HTMLElement;
    expect(delta).toBeTruthy();
    expect(delta.textContent).toBe('\u2014');
    expect(delta.title).toBe('No change');
    expect(delta.className).toContain('text-muted-foreground');
  });

  it('renders a signed, colored delta for a non-zero pass-rate delta when condensed', () => {
    const a = makeRun({ passRatePercent: 90 });
    const b = makeRun({ runId: 'run-b', runName: 'Run B', passRatePercent: 70 });
    renderScoreboard([a, b]);
    condense();

    const band = screen.getByTestId('scoreboard-condensed');
    const delta = band.querySelector('span.font-medium.tabular-nums') as HTMLElement;
    expect(delta.textContent).toBe('+20pp');
    expect(delta.title).toBe('');
    expect(delta.className).toContain('text-blue-400');
  });

  it('condensed band with a single run (no comparison) renders without a delta span', () => {
    const a = makeRun();
    renderScoreboard([a]);
    condense();

    const band = screen.getByTestId('scoreboard-condensed');
    expect(band.querySelector('span.font-medium.tabular-nums')).toBeNull();
    expect(band.textContent).not.toContain('vs');
  });
});
