/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Render tests for the comparison scoreboard's explainability affordances
 * (owner: "Each column should be explainable by a hover with a one line
 * description. The run names should be clickable to the run link, complete
 * name should show up on hover."):
 *  - every column header renders a non-empty `title` tooltip, with the exact
 *    wording pinned for the two easily-confused ones (Average accuracy vs
 *    Avg score);
 *  - the run name is an anchor to the run-report route (benchmark-scoped
 *    when the run belongs to a benchmark, bare eval-run route otherwise),
 *    carrying the FULL run name as its title;
 *  - the per-case UseCaseComparisonTable's run headers link the same way.
 */

import * as React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  ComparisonScoreboard,
  SCOREBOARD_COLUMNS,
  DELTA_ROW_TOOLTIP,
} from '@/components/comparison/ComparisonScoreboard';
import { runReportPath } from '@/lib/runReportPath';
import { UseCaseComparisonTable } from '@/components/comparison/UseCaseComparisonTable';
import type { RunAggregateMetrics, BenchmarkRun, TestCaseComparisonRow } from '@/types';
import type { TestCaseOverlap } from '@/services/comparisonService';

// UseCaseComparisonTable transitively pulls in react-markdown (ESM-only) via
// the expanded-row markdown renderer; stub it — headers are all we assert on.
jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: string }) => React.createElement('div', null, children),
}));
jest.mock('remark-gfm', () => () => {});

class MockIntersectionObserver {
  observe() {}
  disconnect() {}
}
(global as any).IntersectionObserver = MockIntersectionObserver;

const LONG_NAME = 'nightly regression — full benchmark, retry-on-judge-failure enabled (candidate build 2024.01.01)';

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
    avgScore: 82,
    passRatePercent: 80,
    totalCostUsd: 1.5,
    avgDurationMs: 5000,
    totalTokens: 1000,
    totalLlmCalls: 20,
    totalToolCalls: 30,
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
  { id: 'run-a', name: LONG_NAME, results: {} } as unknown as BenchmarkRun,
  { id: 'run-b', name: 'Run B', results: {} } as unknown as BenchmarkRun,
];

function renderScoreboard(
  runs: RunAggregateMetrics[],
  runBenchmarkIdById?: Map<string, string | undefined>,
) {
  return render(
    React.createElement(
      MemoryRouter,
      null,
      React.createElement(ComparisonScoreboard, {
        runs,
        selectedRuns,
        overlap,
        runBenchmarkIdById,
        onRemoveRun: () => {},
        onSwapRuns: () => {},
        getAgentName: (k: string) => k,
      }),
    ),
  );
}

describe('ComparisonScoreboard — column header tooltips', () => {
  it('every column header renders a non-empty one-line title tooltip', () => {
    renderScoreboard([makeRun(), makeRun({ runId: 'run-b', runName: 'Run B' })]);
    const headers = screen.getAllByRole('columnheader');
    // One per SCOREBOARD_COLUMNS entry + the unlabeled actions column.
    expect(headers).toHaveLength(SCOREBOARD_COLUMNS.length + 1);
    for (const col of SCOREBOARD_COLUMNS) {
      const th = screen.getByTestId(`scoreboard-col-${col.key}`);
      // The pass-rate header carries the verdict policy ("judge verdict" for legacy fixtures).
      expect(th.textContent).toBe(col.key === 'passRate' ? 'Pass rate (judge verdict)' : col.label);
      const title = th.getAttribute('title');
      expect(title).toBeTruthy();
      expect(title).toBe(col.tooltip);
      // "one line": no line breaks, reasonably short.
      expect(title).not.toMatch(/\n/);
      expect(title!.length).toBeLessThan(140);
    }
  });

  it('pins the Avg score wording (snapshot-derived) and has no accuracy-only column', () => {
    renderScoreboard([makeRun()]);
    expect(screen.queryByTestId('scoreboard-col-avgAccuracy')).toBeNull();
    expect(screen.getByTestId('scoreboard-col-avgScore').getAttribute('title')).toBe(
      'Mean of each case\'s weighted rubric score per its scoring snapshot (0–100); "—" for runs judged before scoring snapshots existed',
    );
  });

  it('pins the owner-specified wording for the remaining columns', () => {
    renderScoreboard([makeRun()]);
    const expected: Record<string, string> = {
      passRate: 'Passed ÷ evaluated cases (errored cases excluded); the parenthesis names the verdict policy',
      cost: 'Total LLM cost across all test cases in the run',
      tokens: 'Total tokens across all test cases',
      llmCalls: 'Total LLM calls across all test cases',
      toolCalls: 'Total tool invocations across all test cases',
      avgDuration: 'Mean wall-clock duration per test case',
      coverage: 'Test cases this run shares with the comparison set',
    };
    for (const [key, tooltip] of Object.entries(expected)) {
      expect(screen.getByTestId(`scoreboard-col-${key}`).getAttribute('title')).toBe(tooltip);
    }
  });

  it('the Delta footer label is explained too', () => {
    renderScoreboard([makeRun(), makeRun({ runId: 'run-b', runName: 'Run B' })]);
    expect(screen.getByTestId('scoreboard-delta-label').getAttribute('title')).toBe(DELTA_ROW_TOOLTIP);
    expect(DELTA_ROW_TOOLTIP.length).toBeGreaterThan(0);
  });
});

describe('ComparisonScoreboard — run name is a link with the full name on hover', () => {
  it('benchmark run: anchor to the benchmark-scoped run route, title = full run name', () => {
    renderScoreboard(
      [makeRun({ runName: LONG_NAME }), makeRun({ runId: 'run-b', runName: 'Run B' })],
      new Map([['run-a', 'bench-1'], ['run-b', undefined]]),
    );
    const a = screen.getByTestId('run-name-link-run-a');
    expect(a.tagName).toBe('A');
    expect(a.getAttribute('href')).toBe('/evaluations/benchmarks/bench-1/runs/run-a');
    expect(a.getAttribute('title')).toBe(LONG_NAME);
    expect(a.textContent).toBe(LONG_NAME);
    // The icon deep link agrees with the name link.
    expect(screen.getByTestId('open-run-run-a').getAttribute('href')).toBe('/evaluations/benchmarks/bench-1/runs/run-a');
  });

  it('ad-hoc eval run (no benchmarkId): anchor to the bare eval-run route', () => {
    renderScoreboard(
      [makeRun(), makeRun({ runId: 'run-b', runName: 'Run B' })],
      new Map([['run-a', 'bench-1'], ['run-b', undefined]]),
    );
    const b = screen.getByTestId('run-name-link-run-b');
    expect(b.getAttribute('href')).toBe('/evaluations/runs/run-b');
    expect(b.getAttribute('title')).toBe('Run B');
    expect(screen.getByTestId('open-run-run-b').getAttribute('href')).toBe('/evaluations/runs/run-b');
  });

  it('falls back to the agent name for both text and title when runName is missing', () => {
    renderScoreboard([makeRun({ runName: undefined as unknown as string, agentKey: 'my-agent' })]);
    const a = screen.getByTestId('run-name-link-run-a');
    expect(a.textContent).toBe('my-agent');
    expect(a.getAttribute('title')).toBe('my-agent');
  });

  it('keeps the Remove button intact next to the link', () => {
    renderScoreboard([makeRun()]);
    expect(screen.getByTitle('Remove')).toBeTruthy();
    expect(screen.getByTitle('Open run')).toBeTruthy();
  });
});

describe('runReportPath', () => {
  it('routes benchmark runs to the benchmark-scoped page and everything else to the bare eval-run page', () => {
    expect(runReportPath('r1', 'b1')).toBe('/evaluations/benchmarks/b1/runs/r1');
    expect(runReportPath('r1', undefined)).toBe('/evaluations/runs/r1');
    expect(runReportPath('r1', '')).toBe('/evaluations/runs/r1');
    // Ids are path-segment encoded so a stray '/' or '?' can't break the route.
    expect(runReportPath('r/1', 'b?1')).toBe('/evaluations/benchmarks/b%3F1/runs/r%2F1');
  });
});

describe('UseCaseComparisonTable — run headers link to the run report', () => {
  const rows: TestCaseComparisonRow[] = [
    {
      testCaseId: 'tc-1',
      testCaseName: 'case one',
      labels: [],
      results: {
        'run-a': { status: 'pass', accuracy: 90 },
        'run-b': { status: 'fail', accuracy: 40 },
      },
    } as unknown as TestCaseComparisonRow,
  ];

  it('header run names are anchors with the full name as title and the correct route', () => {
    render(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(UseCaseComparisonTable, {
          rows,
          runs: selectedRuns,
          reports: {},
          runBenchmarkIdById: new Map([['run-a', 'bench-1'], ['run-b', undefined]]),
        }),
      ),
    );
    const a = screen.getByTestId('case-table-run-link-run-a');
    expect(a.tagName).toBe('A');
    expect(a.getAttribute('href')).toBe('/evaluations/benchmarks/bench-1/runs/run-a');
    expect(a.getAttribute('title')).toBe(LONG_NAME);
    const b = screen.getByTestId('case-table-run-link-run-b');
    expect(b.getAttribute('href')).toBe('/evaluations/runs/run-b');
    expect(b.getAttribute('title')).toBe('Run B');
  });
});
