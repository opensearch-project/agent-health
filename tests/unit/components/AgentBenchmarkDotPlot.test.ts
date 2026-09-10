/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Component-level smoke tests for AgentBenchmarkDotPlot — the primary v3
 * Agent Trends visualization. Pixel/visual correctness (dot positions,
 * hover tooltips, side-by-side desktop layout) is e2e-covered
 * (tests/e2e/agent-trends-band.spec.ts) against a real browser; this file
 * covers the parts that matter under JSDOM: ranked row order renders
 * top-to-bottom, latest vs. history dots both render with the right
 * counts, click wiring, and the empty state.
 */

import * as React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { AgentBenchmarkDotPlot } from '@/components/dashboard/AgentBenchmarkDotPlot';
import { buildAgentRunPoints, buildBenchmarkDotPlotRows, rankDotPlotRows } from '@/lib/agentTrends';
import type { Benchmark, BenchmarkRun } from '@/types';

afterEach(cleanup);

function makeRun(overrides: Partial<BenchmarkRun>): BenchmarkRun {
  return {
    id: 'run-1',
    name: 'Run 1',
    createdAt: '2024-06-01T00:00:00.000Z',
    agentKey: 'agent-a',
    modelId: 'claude-sonnet',
    results: {},
    ...overrides,
  };
}

function makeBenchmark(runs: BenchmarkRun[]): Benchmark {
  return {
    id: 'bm-1',
    name: 'Benchmark One',
    description: '',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    currentVersion: 1,
    versions: [{ version: 1, createdAt: '2024-01-01T00:00:00.000Z', testCaseIds: [] }],
    testCaseIds: [],
    runs,
  };
}

function rankedRows(runs: BenchmarkRun[]) {
  const points = buildAgentRunPoints([makeBenchmark(runs)], [], new Map());
  return rankDotPlotRows(buildBenchmarkDotPlotRows(points, 'accuracy'));
}

describe('AgentBenchmarkDotPlot', () => {
  it('renders rows top-to-bottom in ranked order (best score first)', () => {
    const rows = rankedRows([
      makeRun({ id: 'mid', agentKey: 'agent-mid', createdAt: '2024-06-01T00:00:00Z', stats: { passed: 7, failed: 3, pending: 0, total: 10 } }),
      makeRun({ id: 'best', agentKey: 'agent-best', createdAt: '2024-06-01T00:00:00Z', stats: { passed: 9, failed: 1, pending: 0, total: 10 } }),
      makeRun({ id: 'worst', agentKey: 'agent-worst', createdAt: '2024-06-01T00:00:00Z', stats: { passed: 3, failed: 7, pending: 0, total: 10 } }),
    ]);
    render(React.createElement(AgentBenchmarkDotPlot, { rows, metric: 'accuracy', onSelectPoint: jest.fn() }));

    const rowEls = [
      screen.getByTestId('agent-dot-plot-row-agent-best'),
      screen.getByTestId('agent-dot-plot-row-agent-mid'),
      screen.getByTestId('agent-dot-plot-row-agent-worst'),
    ];
    const positions = rowEls.map(el => Array.from(document.querySelectorAll('[data-testid^="agent-dot-plot-row-"]')).indexOf(el));
    expect(positions).toEqual([0, 1, 2]); // DOM order matches rank order
  });

  it('renders one large "latest" dot and one small "history" dot per earlier run', () => {
    const rows = rankedRows([
      makeRun({ id: 'r1', agentKey: 'agent-a', createdAt: '2024-06-01T00:00:00Z', stats: { passed: 6, failed: 4, pending: 0, total: 10 } }),
      makeRun({ id: 'r2', agentKey: 'agent-a', createdAt: '2024-06-05T00:00:00Z', stats: { passed: 8, failed: 2, pending: 0, total: 10 } }),
    ]);
    render(React.createElement(AgentBenchmarkDotPlot, { rows, metric: 'accuracy', onSelectPoint: jest.fn() }));

    expect(screen.getByTestId('agent-dot-plot-latest-agent-a').className).toContain('!min-h-0');
    expect(screen.getByTestId('agent-dot-plot-history-agent-a-0').className).toContain('!min-h-0');
  });

  it('uses three mobile ticks with safe edge anchors and hides intermediate desktop-only ticks', () => {
    const rows = rankedRows([
      makeRun({ id: 'r1', stats: { passed: 8, failed: 2, pending: 0, total: 10 } }),
    ]);
    render(React.createElement(AgentBenchmarkDotPlot, { rows, metric: 'accuracy', onSelectPoint: jest.fn() }));

    const ticks = screen.getByTestId('agent-dot-plot-ticks').querySelectorAll('span');
    expect(ticks).toHaveLength(5);
    expect(ticks[0].className).toEqual(expect.stringContaining('translate-x-0'));
    expect(ticks[0].className).toEqual(expect.stringContaining('sm:-translate-x-1/2'));
    expect(ticks[1].className).toEqual(expect.stringContaining('hidden sm:block'));
    expect(ticks[3].className).toEqual(expect.stringContaining('hidden sm:block'));
    expect(ticks[4].className).toEqual(expect.stringContaining('-translate-x-full'));
    expect(ticks[4].className).toEqual(expect.stringContaining('sm:-translate-x-1/2'));
  });

  it('calls onSelectPoint with the run/benchmark id when the latest dot is clicked', () => {
    const rows = rankedRows([
      makeRun({ id: 'only-run', agentKey: 'agent-a', createdAt: '2024-06-01T00:00:00Z', stats: { passed: 6, failed: 4, pending: 0, total: 10 } }),
    ]);
    const onSelectPoint = jest.fn();
    render(React.createElement(AgentBenchmarkDotPlot, { rows, metric: 'accuracy', onSelectPoint }));

    fireEvent.click(screen.getByTestId('agent-dot-plot-latest-agent-a'));
    expect(onSelectPoint).toHaveBeenCalledTimes(1);
    const [, runDocId, benchmarkId] = onSelectPoint.mock.calls[0];
    expect(runDocId).toBe('only-run');
    expect(benchmarkId).toBe('bm-1');
  });

  it('puts numbers only in the hover title, never as on-canvas text content', () => {
    const rows = rankedRows([
      makeRun({ id: 'r1', agentKey: 'agent-a', createdAt: '2024-06-01T00:00:00Z', stats: { passed: 8, failed: 2, pending: 0, total: 10 } }),
    ]);
    render(React.createElement(AgentBenchmarkDotPlot, { rows, metric: 'accuracy', onSelectPoint: jest.fn() }));

    const dot = screen.getByTestId('agent-dot-plot-latest-agent-a');
    expect(dot.textContent).toBe(''); // no on-point label
    expect(dot.getAttribute('title')).toMatch(/80\.0%/); // the number lives in the hover title instead
  });

  it('renders an agent row with no dots when it has no resolved value for the metric, instead of crashing', () => {
    const points = buildAgentRunPoints([makeBenchmark([
      makeRun({ id: 'r1', agentKey: 'agent-a', stats: { passed: 1, failed: 0, pending: 0, total: 1 } }),
    ])], [], new Map());
    const rows = rankDotPlotRows(buildBenchmarkDotPlotRows(points, 'cost')); // no trace metrics seeded -> cost is null
    render(React.createElement(AgentBenchmarkDotPlot, { rows, metric: 'cost', onSelectPoint: jest.fn() }));
    expect(screen.getByTestId('agent-dot-plot-empty')).toBeTruthy();
  });

  it('renders the empty state for zero rows', () => {
    render(React.createElement(AgentBenchmarkDotPlot, { rows: [], metric: 'accuracy', onSelectPoint: jest.fn() }));
    expect(screen.getByTestId('agent-dot-plot-empty')).toBeTruthy();
  });
});
