/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression: with THREE runs selected on the compare page (header "3 of N
 * runs", table compare shows 3 columns) the scoreboard listed only A and B —
 * the third run silently vanished from pass rate / duration / cost / tokens /
 * calls / coverage. The component hard-capped to two runs in five places
 * (`runs.slice(0, 2)`, `perRun.slice(0, 2)`, the judge caption, the
 * legacy / snapshot comparability checks).
 *
 * Mounts ComparisonScoreboard for real and pins:
 *  - one lettered row per selected run (A, B, C, …), badges included;
 *  - one Δ row per non-baseline run ("Δ A−B", "Δ A−C") with A-minus-run
 *    values; the two-run compare keeps its single un-suffixed "Delta" row;
 *  - the judge caption lists every run (A · B · C) and still collapses when
 *    all judges match;
 *  - coverage wording switches "in both" → "in all 3" and names every run
 *    carrying unique cases;
 *  - the comparability gate / legacy checks run over ALL runs;
 *  - the condensed band lists every run too.
 */

import * as React from 'react';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  ComparisonScoreboard,
  runLetter,
  inAllLabel,
  deltaRowTooltipFor,
  DELTA_ROW_TOOLTIP,
  NOT_COMPARABLE_LABEL,
} from '@/components/comparison/ComparisonScoreboard';
import type { RunAggregateMetrics, BenchmarkRun, RunScoringSummary } from '@/types';
import type { TestCaseOverlap } from '@/services/comparisonService';

type IOCallback = (entries: Array<{ isIntersecting: boolean }>) => void;
let ioCallback: IOCallback = () => {};
class MockIntersectionObserver {
  constructor(cb: IOCallback) { ioCallback = cb; }
  observe() {}
  disconnect() {}
}
(global as any).IntersectionObserver = MockIntersectionObserver;

const snapshotScoring = (over: Partial<Extract<RunScoringSummary, { source: 'snapshot' }>> = {}): RunScoringSummary => ({
  source: 'snapshot',
  evaluatorId: 'eval-demo',
  evaluatorName: 'Demo evaluator',
  evaluatorVersion: 2,
  contentHashes: ['h1'],
  weights: { accuracy: 1 },
  passPolicy: { kind: 'threshold', minScore: 0.7 },
  scoredReports: 10,
  scoredRubrics: 10,
  totalRubrics: 10,
  primaryMetrics: [],
  ...over,
});

function makeRun(id: string, overrides: Partial<RunAggregateMetrics> = {}): RunAggregateMetrics {
  return {
    runId: id,
    runName: `Run ${id}`,
    createdAt: '2024-01-01T00:00:00Z',
    modelId: 'demo-model',
    agentKey: `agent-${id}`,
    totalTestCases: 10,
    passedCount: 8,
    failedCount: 2,
    passRatePercent: 80,
    totalCostUsd: 1.0,
    avgDurationMs: 5000,
    totalTokens: 1000,
    totalLlmCalls: 10,
    totalToolCalls: 20,
    ...overrides,
  } as RunAggregateMetrics;
}

const fullOverlap = (runCount: number): TestCaseOverlap => ({
  runCount,
  totalTestCases: 10,
  sharedTestCases: 10,
  partialTestCases: 0,
  perRun: [],
  fullyOverlapping: true,
});

const selected = (ids: string[], extra: Record<string, Partial<BenchmarkRun>> = {}): BenchmarkRun[] =>
  ids.map(id => ({ id, results: {}, ...(extra[id] ?? {}) } as unknown as BenchmarkRun));

function renderScoreboard(
  runs: RunAggregateMetrics[],
  props: Partial<React.ComponentProps<typeof ComparisonScoreboard>> = {},
) {
  return render(
    React.createElement(
      MemoryRouter,
      null,
      React.createElement(ComparisonScoreboard, {
        runs,
        selectedRuns: selected(runs.map(r => r.runId)),
        overlap: fullOverlap(runs.length),
        onRemoveRun: jest.fn(),
        onSwapRuns: jest.fn(),
        getAgentName: (key: string) => key,
        ...props,
      }),
    ),
  );
}

const threeRuns = () => [
  makeRun('a', { passRatePercent: 90, totalCostUsd: 1.0, avgDurationMs: 4000, totalTokens: 1000 }),
  makeRun('b', { passRatePercent: 70, totalCostUsd: 2.0, avgDurationMs: 5000, totalTokens: 1500 }),
  makeRun('c', { passRatePercent: 60, totalCostUsd: 0.5, avgDurationMs: 6000, totalTokens: 800 }),
];

describe('runLetter / inAllLabel', () => {
  it('letters rows A, B, C, … and falls back to a number past Z', () => {
    expect([0, 1, 2, 25].map(runLetter)).toEqual(['A', 'B', 'C', 'Z']);
    expect(runLetter(26)).toBe('R27');
  });
  it('says "in both" for two runs and "in all N" from three on', () => {
    expect(inAllLabel(2)).toBe('in both');
    expect(inAllLabel(3)).toBe('in all 3');
    expect(inAllLabel(5)).toBe('in all 5');
  });
});

describe('ComparisonScoreboard — three runs render three rows', () => {
  it('renders one row per selected run with A/B/C badges, every metric cell filled', () => {
    renderScoreboard(threeRuns());

    for (const letter of ['A', 'B', 'C']) {
      expect(screen.getByTestId(`scoreboard-row-${letter}`)).toBeTruthy();
      expect(screen.getByTestId(`run-badge-${letter}`).textContent).toBe(letter);
    }
    expect(screen.queryByTestId('scoreboard-row-D')).toBeNull();

    // The third run's metrics are actually on the board (this is the bug).
    expect(screen.getByTestId('run-passrate-c').textContent).toBe('60%');
    expect(screen.getByTestId('run-cost-c').textContent).toBe('$0.50');
    expect(screen.getByTestId('run-duration-c').textContent).not.toBe('--');
    expect(screen.getByTestId('run-tokens-c').textContent).not.toBe('--');
    expect(screen.getByTestId('run-llmcalls-c').textContent).toBe('10');
    expect(screen.getByTestId('run-toolcalls-c').textContent).toBe('20');
  });

  it('renders one Δ row per non-baseline run, each "A minus that run"', () => {
    renderScoreboard(threeRuns());

    const rowB = screen.getByTestId('scoreboard-delta-row-B');
    const rowC = screen.getByTestId('scoreboard-delta-row-C');
    expect(screen.queryByTestId('scoreboard-delta-row-D')).toBeNull();

    // Labels + tooltips name the compared run; the first row owns the un-suffixed ids.
    expect(screen.getByTestId('scoreboard-delta-label').textContent).toBe('Δ A−B');
    expect(screen.getByTestId('scoreboard-delta-label').title).toBe(deltaRowTooltipFor('B'));
    expect(screen.getByTestId('scoreboard-delta-label-C').textContent).toBe('Δ A−C');
    expect(screen.getByTestId('scoreboard-delta-label-C').title).toBe(deltaRowTooltipFor('C'));

    // A − B: 90 − 70 = +20pp; A − C: 90 − 60 = +30pp.
    expect(screen.getByTestId('scoreboard-delta-passrate').textContent).toBe('+20pp');
    expect(screen.getByTestId('scoreboard-delta-passrate-C').textContent).toBe('+30pp');
    // Cost: A − B = −$1.00 (A cheaper → green); A − C = +$0.50 (A pricier → red).
    expect(screen.getByTestId('scoreboard-delta-cost').className).toContain('text-green-400');
    expect(screen.getByTestId('scoreboard-delta-cost-C').textContent).toBe('+$0.50');
    expect(screen.getByTestId('scoreboard-delta-cost-C').className).toContain('text-red-400');
    // Duration: A faster than both → negative → green.
    expect(screen.getByTestId('scoreboard-delta-duration-C').className).toContain('text-green-400');
    // Tokens: A − C = +200 → A used more → red.
    expect(screen.getByTestId('scoreboard-delta-tokens-C').className).toContain('text-red-400');

    // Only the first Δ row carries the swap button (it swaps A and B).
    expect(rowB.querySelector('button[title="Swap A/B"]')).toBeTruthy();
    expect(rowC.querySelector('button[title="Swap A/B"]')).toBeNull();
  });

  it('two-run compare keeps today\'s single un-suffixed "Delta" row (no letter suffixes, no extra rows)', () => {
    renderScoreboard(threeRuns().slice(0, 2));

    expect(screen.getByTestId('scoreboard-delta-row-B')).toBeTruthy();
    expect(screen.queryByTestId('scoreboard-delta-row-C')).toBeNull();
    const label = screen.getByTestId('scoreboard-delta-label');
    expect(label.textContent).toBe('Delta');
    expect(label.title).toBe(DELTA_ROW_TOOLTIP);
    expect(screen.getByTestId('scoreboard-delta-passrate').textContent).toBe('+20pp');
    expect(screen.queryByTestId('scoreboard-delta-passrate-B')).toBeNull();
    expect(screen.queryByTestId('scoreboard-delta-label-B')).toBeNull();
    expect(screen.getByTestId('scoreboard-row-A')).toBeTruthy();
    expect(screen.getByTestId('scoreboard-row-B')).toBeTruthy();
    expect(screen.queryByTestId('scoreboard-row-C')).toBeNull();
  });

  it('single run: one row, no Δ footer', () => {
    renderScoreboard([makeRun('a')]);
    expect(screen.getByTestId('scoreboard-row-A')).toBeTruthy();
    expect(screen.queryByTestId('scoreboard-delta-row-B')).toBeNull();
    expect(screen.getByTestId('comparison-overlap-banner').textContent).toBe('10 cases');
  });

  it('removing the third run calls onRemoveRun with ITS id', () => {
    const onRemoveRun = jest.fn();
    renderScoreboard(threeRuns(), { onRemoveRun });
    fireEvent.click(screen.getByTestId('scoreboard-row-C').querySelector('button[title="Remove"]')!);
    expect(onRemoveRun).toHaveBeenCalledWith('c');
  });
});

describe('ComparisonScoreboard — judge caption over all runs', () => {
  it('lists A · B · C when the judges differ', () => {
    const runs = threeRuns();
    renderScoreboard(runs, {
      selectedRuns: selected(['a', 'b', 'c'], {
        a: { judgeModelId: 'judge-one', judgeModel: 'judge-one' } as any,
        b: { judgeModelId: 'judge-two', judgeModel: 'judge-two' } as any,
        c: { judgeModelId: 'judge-three', judgeModel: 'judge-three' } as any,
      }),
    });
    const line = screen.getByTestId('scoreboard-judge-line').textContent ?? '';
    expect(line).toMatch(/Judge:\s*A .*judge-one.*· B .*judge-two.*· C .*judge-three/);
  });

  it('names the third run when only IT differs (previously invisible)', () => {
    const runs = threeRuns();
    renderScoreboard(runs, {
      selectedRuns: selected(['a', 'b', 'c'], {
        a: { judgeModelId: 'judge-one', judgeModel: 'judge-one' } as any,
        b: { judgeModelId: 'judge-one', judgeModel: 'judge-one' } as any,
        c: { judgeModelId: 'judge-other', judgeModel: 'judge-other' } as any,
      }),
    });
    const line = screen.getByTestId('scoreboard-judge-line').textContent ?? '';
    expect(line).toMatch(/A .*judge-one/);
    expect(line).toMatch(/C .*judge-other/);
  });

  it('collapses to one entry when all three judges are identical', () => {
    const runs = threeRuns();
    renderScoreboard(runs, {
      selectedRuns: selected(['a', 'b', 'c'], {
        a: { judgeModelId: 'judge-one', judgeModel: 'judge-one' } as any,
        b: { judgeModelId: 'judge-one', judgeModel: 'judge-one' } as any,
        c: { judgeModelId: 'judge-one', judgeModel: 'judge-one' } as any,
      }),
    });
    const line = screen.getByTestId('scoreboard-judge-line').textContent ?? '';
    expect(line).not.toMatch(/\bA\b .*·/);
    expect(screen.getAllByTestId('judge-model-label')).toHaveLength(1);
  });
});

describe('ComparisonScoreboard — coverage wording for N runs', () => {
  it('fully overlapping three-run compare reads "10 in all 3, same case IDs"', () => {
    renderScoreboard(threeRuns());
    expect(screen.getByTestId('comparison-overlap-banner').textContent).toBe('10 in all 3, same case IDs');
  });

  it('two-run wording is unchanged ("in both")', () => {
    renderScoreboard(threeRuns().slice(0, 2));
    expect(screen.getByTestId('comparison-overlap-banner').textContent).toBe('10 in both, same case IDs');
  });

  it('partial overlap names every run carrying unique cases, including C', () => {
    renderScoreboard(threeRuns(), {
      overlap: {
        runCount: 3,
        totalTestCases: 12,
        sharedTestCases: 6,
        partialTestCases: 6,
        perRun: [
          { runId: 'a', runName: 'Run a', count: 8, uniqueCount: 2 },
          { runId: 'b', runName: 'Run b', count: 6, uniqueCount: 0 },
          { runId: 'c', runName: 'Run c', count: 10, uniqueCount: 4 },
        ],
        fullyOverlapping: false,
      },
    });
    expect(screen.getByTestId('comparison-overlap-banner').textContent).toBe('6 in all 3 · 2 only in A · 4 only in C');
  });

  it('cases shared by SOME runs but unique to none (in B and C, not A) are reported as "in some runs"', () => {
    // 10 total: 6 in all three, 1 only in A, 3 in B+C but not A.
    renderScoreboard(threeRuns(), {
      overlap: {
        runCount: 3,
        totalTestCases: 10,
        sharedTestCases: 6,
        partialTestCases: 4,
        perRun: [
          { runId: 'a', runName: 'Run a', count: 7, uniqueCount: 1 },
          { runId: 'b', runName: 'Run b', count: 9, uniqueCount: 0 },
          { runId: 'c', runName: 'Run c', count: 9, uniqueCount: 0 },
        ],
        fullyOverlapping: false,
      },
    });
    expect(screen.getByTestId('comparison-overlap-banner').textContent).toBe('6 in all 3 · 1 only in A · 3 in some runs');
  });

  it('letters in the coverage label follow the run id, not the position of perRun', () => {
    renderScoreboard(threeRuns(), {
      overlap: {
        runCount: 3,
        totalTestCases: 9,
        sharedTestCases: 6,
        partialTestCases: 3,
        // Deliberately reversed relative to the rows (C, B, A).
        perRun: [
          { runId: 'c', runName: 'Run c', count: 9, uniqueCount: 3 },
          { runId: 'b', runName: 'Run b', count: 6, uniqueCount: 0 },
          { runId: 'a', runName: 'Run a', count: 6, uniqueCount: 0 },
        ],
        fullyOverlapping: false,
      },
    });
    expect(screen.getByTestId('comparison-overlap-banner').textContent).toBe('6 in all 3 · 3 only in C');
  });
});

describe('ComparisonScoreboard — more runs than the colour palette', () => {
  it('seven runs: seven rows A–G, six Δ rows, badge colours cycle past the sixth run', () => {
    const runs = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id, i) => makeRun(id, { passRatePercent: 90 - i * 10 }));
    renderScoreboard(runs, { overlap: fullOverlap(7) });
    for (const letter of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) {
      expect(screen.getByTestId(`scoreboard-row-${letter}`)).toBeTruthy();
    }
    expect(screen.queryByTestId('scoreboard-row-H')).toBeNull();
    expect(screen.getAllByTestId(/^scoreboard-delta-row-/)).toHaveLength(6);
    expect(screen.getByTestId('scoreboard-delta-passrate-G').textContent).toBe('+60pp');
    // The 7th badge reuses the 1st colour (palette of six, cycling).
    expect(screen.getByTestId('run-badge-G').className).toBe(screen.getByTestId('run-badge-A').className);
    expect(screen.getByTestId('run-badge-B').className).not.toBe(screen.getByTestId('run-badge-A').className);
    expect(screen.getByTestId('comparison-overlap-banner').textContent).toBe('10 in all 7, same case IDs');
  });
});

describe('ComparisonScoreboard — comparability / scoring checks span all runs', () => {
  it('"same cases, same scoring" needs EVERY run snapshot-scored — a legacy third run downgrades it', () => {
    const runs = threeRuns();
    runs[0].scoring = snapshotScoring();
    runs[1].scoring = snapshotScoring();
    // runs[2] stays legacy
    renderScoreboard(runs, { comparability: { comparable: true, reasons: [] } });
    expect(screen.getByTestId('comparison-overlap-banner').textContent).toBe('10 in all 3, same case IDs');

    runs[2].scoring = snapshotScoring();
    renderScoreboard(runs, { comparability: { comparable: true, reasons: [] } });
    expect(screen.getAllByTestId('comparison-overlap-banner').at(-1)!.textContent).toBe('10 in all 3, same cases, same scoring');
  });

  it('the "Not comparable" gate blocks EVERY Δ row, with a single "Compare anyway" control', () => {
    const onCompareAnyway = jest.fn();
    renderScoreboard(threeRuns(), {
      comparability: { comparable: false, reasons: ['legacy scoring on Run c — no scoring snapshot to compare against'] },
      onCompareAnyway,
    });
    expect(screen.getByTestId('scoreboard-delta-blocked').textContent).toBe(NOT_COMPARABLE_LABEL);
    expect(screen.getByTestId('scoreboard-delta-blocked-C').textContent).toBe(NOT_COMPARABLE_LABEL);
    expect(screen.queryByTestId('scoreboard-delta-passrate')).toBeNull();
    expect(screen.queryByTestId('scoreboard-delta-passrate-C')).toBeNull();
    const anyway = screen.getAllByTestId('scoreboard-compare-anyway');
    expect(anyway).toHaveLength(1);
    fireEvent.click(anyway[0]);
    expect(onCompareAnyway).toHaveBeenCalledTimes(1);
  });

  it('"Compare anyway" restores every Δ row with the caveat tooltip', () => {
    renderScoreboard(threeRuns(), {
      comparability: { comparable: false, reasons: ['different scoring snapshots'] },
      compareAnyway: true,
    });
    expect(screen.getByTestId('scoreboard-delta-passrate').title).toContain('Compared anyway');
    expect(screen.getByTestId('scoreboard-delta-passrate-C').title).toContain('Compared anyway');
  });

  it('all-legacy caveat says "All runs" for three runs and keeps "Both runs" for two', () => {
    renderScoreboard(threeRuns());
    expect(screen.getByTestId('scoreboard-delta-passrate-C').title).toMatch(/^All runs are legacy-scored/);

    renderScoreboard(threeRuns().slice(0, 2));
    const twoRun = screen.getAllByTestId('scoreboard-delta-passrate').at(-1)!;
    expect(twoRun.title).toMatch(/^Both runs are legacy-scored/);
  });

  it('a snapshot-scored pair does not count as legacy just because the slice used to stop at two', () => {
    const runs = threeRuns();
    runs[0].scoring = snapshotScoring({ primaryMetrics: [{ name: 'hit', mean: 0.9, scale: { min: 0, max: 1 } }] });
    runs[1].scoring = snapshotScoring({ primaryMetrics: [{ name: 'hit', mean: 0.7, scale: { min: 0, max: 1 } }] });
    runs[2].scoring = snapshotScoring({ primaryMetrics: [{ name: 'hit', mean: 0.5, scale: { min: 0, max: 1 } }] });
    renderScoreboard(runs);
    // No legacy caveat on any Δ row …
    expect(screen.getByTestId('scoreboard-delta-passrate').title).toBe('');
    expect(screen.getByTestId('scoreboard-delta-passrate-C').title).toBe('');
    // … and the primary-metric Δ is computed for C too.
    expect(screen.getByTestId('scoreboard-delta-primary-hit').textContent).toContain('+');
    expect(screen.getByTestId('scoreboard-delta-primary-hit-C').textContent).toContain('+');
    expect(screen.getByTestId('run-primary-hit-c')).toBeTruthy();
  });
});

describe('ComparisonScoreboard — condensed band lists every run', () => {
  it('shows A vs B vs C with a Δ-vs-A per further run', () => {
    renderScoreboard(threeRuns());
    act(() => { ioCallback([{ isIntersecting: false }]); });
    const band = screen.getByTestId('scoreboard-condensed');
    expect(band.textContent).toContain('agent-a');
    expect(band.textContent).toContain('agent-b');
    expect(band.textContent).toContain('agent-c');
    expect(band.textContent).toContain('+20pp');
    expect(band.textContent).toContain('+30pp');
    expect(band.textContent).toContain('$1.00 vs $2.00 vs $0.50');
  });
});
