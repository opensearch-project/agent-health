/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Source-analysis tests for ComparisonScoreboard.
 *
 * The ComparisonScoreboard replaces VerdictStrip + ComparisonOverlapBanner +
 * the standalone MetricComparisonPanel Collapsible with a single unified sticky
 * band. Follows the source-analysis pattern (evaluatorRemoval, uiPapercuts)
 * since this component requires recharts, IntersectionObserver, and router context.
 *
 * The "Open run" deep-link fix (bottom of this file) IS rendered for real
 * (jsdom + @testing-library/react + a lightweight react-router-dom Link stub
 * + an IntersectionObserver stub) rather than source-grepped, since it's the
 * one behavior in this component with an actual branch (benchmarkId present
 * vs. absent) worth asserting against real DOM output.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';

const read = (rel: string) =>
  fs.readFileSync(path.resolve(__dirname, '../../../../', rel), 'utf-8');

// jsdom has no IntersectionObserver; the component's scroll-condense effect
// needs a stub so it can mount without throwing.
class MockIntersectionObserver {
  observe() {}
  disconnect() {}
  unobserve() {}
}
(global as unknown as { IntersectionObserver: unknown }).IntersectionObserver = MockIntersectionObserver;

// The component only imports `Link` from react-router-dom (no router-context
// hooks) — stub it as a plain anchor so we can assert the rendered `href`
// without mounting a MemoryRouter.
jest.mock('react-router-dom', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode }) =>
    React.createElement('a', { href: to, ...rest }, children),
}));

describe('ComparisonScoreboard structure', () => {
  let src: string;
  beforeAll(() => { src = read('components/comparison/ComparisonScoreboard.tsx'); });

  it('renders both run rows with A/B badges', () => {
    expect(src).toContain('RunBadgeA');
    expect(src).toContain('RunBadgeB');
    // data-testid uses a template literal: `scoreboard-row-${label}`
    expect(src).toContain('scoreboard-row-${label}');
  });

  it('shows pass-rate delta in the footer row', () => {
    expect(src).toContain('Delta');
    expect(src).toContain('passRateDelta');
    expect(src).toContain("'pp'");
  });

  it('renders a neutral em-dash (not a bare "=") for zero cost/duration/pass-rate delta', () => {
    // Regression: costDelta === 0 and durationDelta === 0 used to render a
    // bare '=' glyph, which reads as an equals-sign typo rather than "no
    // change". Now uses an em dash with a "No change" tooltip, matching the
    // muted-foreground styling already applied for the zero case.
    expect(src).not.toContain("=== 0 ? '='");
    expect(src).not.toMatch(/delta === 0 \? '='/);
    expect(src).toContain("costDelta === 0 ? '\u2014'");
    expect(src).toContain("durationDelta === 0 ? '\u2014'");
    expect(src).toContain("title={costDelta === 0 ? 'No change' : undefined}");
    expect(src).toContain("title={durationDelta === 0 ? 'No change' : undefined}");
    expect(src).toContain('data-testid="scoreboard-delta-cost"');
    expect(src).toContain('data-testid="scoreboard-delta-duration"');
  });

  it('formatDelta returns an em dash (not "=") when there is no difference', () => {
    expect(src).not.toMatch(/if \(diff === 0\) return '=';/);
    expect(src).toContain("if (diff === 0) return '\u2014';");
  });

  it('coverage cell shows shared count from overlap prop', () => {
    expect(src).toContain('overlap.sharedTestCases');
    expect(src).toContain('fully comparable');
  });

  it('no longer has a per-run expandable drawer or chevron', () => {
    // Change 3: the per-row dropdown is gone entirely; judge info shows once.
    expect(src).not.toContain('RunDetailDrawer');
    expect(src).not.toContain('expandedRow');
    expect(src).not.toContain('setExpandedRow');
    expect(src).not.toContain('ChevronRight');
  });

  it('shows every RunAggregateMetrics metric directly on the run row', () => {
    expect(src).toContain('>Pass Rate<');
    expect(src).toContain('>Avg Accuracy<');
    expect(src).toContain('>Cost<');
    expect(src).toContain('>Avg Duration<');
    expect(src).toContain('>Tokens<');
    expect(src).toContain('>LLM Calls<');
    expect(src).toContain('>Tool Calls<');
    expect(src).toContain('run-passrate-${run.runId}');
    expect(src).toContain('run-accuracy-${run.runId}');
  });

  it('renders a single judge line instead of per-row judge info', () => {
    expect(src).toContain('scoreboard-judge-line');
    expect(src).toContain('JudgeLine');
    expect(src).toContain('Judge:');
  });

  it('has an inline Open-run link and Remove button on each row (no drawer needed)', () => {
    expect(src).toContain('data-testid={`open-run-${run.runId}`}');
    expect(src).toContain('onClick={() => onRemoveRun(run.runId)}');
  });

  it('condensed state renders when isCondensed is true', () => {
    expect(src).toContain('CondensedBand');
    expect(src).toContain('isCondensed');
    expect(src).toContain('scoreboard-condensed');
  });

  it('uses IntersectionObserver for condensed transition', () => {
    expect(src).toContain('IntersectionObserver');
    expect(src).toContain('sentinelRef');
  });

  it('no longer embeds MetricComparisonPanel or an "All metrics" expander (metrics live on the rows now)', () => {
    expect(src).not.toContain('MetricComparisonPanel');
    expect(src).not.toContain('metricsExpanded');
    expect(src).not.toContain('scoreboard-all-metrics-toggle');
  });

  it('no longer renders any chart (recharts removed from this flow)', () => {
    expect(src).not.toContain('recharts');
    expect(src).not.toContain('BarChart');
  });

  it('has the sticky positioning and correct z-index', () => {
    expect(src).toContain('sticky top-0 z-40');
  });

  it('uses bg-card border styling consistent with shadcn theme', () => {
    expect(src).toContain('bg-card border border-border rounded-lg');
  });

  it('"Open run" deep-links to the benchmark run page for benchmark runs, eval-run route for ad-hoc', () => {
    // Regression: the drawer used to always link /evaluations/runs/:runId,
    // which 404s (resolves only the SDK eval-run store) for benchmark run
    // ids. runBenchmarkIdById (per-run, since unscoped comparisons mix
    // benchmarks and ad-hoc eval-runs) now picks the right route.
    expect(src).toContain('runBenchmarkIdById');
    expect(src).toContain('/evaluations/benchmarks/${benchmarkId}/runs/${run.runId}');
    expect(src).toContain('/evaluations/runs/${run.runId}');
    expect(src).toContain('data-testid={`open-run-${run.runId}`}');
  });
});

describe('VerdictStrip and ModeToggle are removed', () => {
  it('VerdictStrip.tsx no longer exists', () => {
    const exists = fs.existsSync(path.resolve(__dirname, '../../../../components/comparison/VerdictStrip.tsx'));
    expect(exists).toBe(false);
  });

  it('ModeToggle.tsx no longer exists', () => {
    const exists = fs.existsSync(path.resolve(__dirname, '../../../../components/comparison/ModeToggle.tsx'));
    expect(exists).toBe(false);
  });

  it('ComparisonPage does not import VerdictStrip', () => {
    const page = read('components/comparison/ComparisonPage.tsx');
    expect(page).not.toContain("from './VerdictStrip'");
    expect(page).not.toContain('<VerdictStrip');
  });

  it('ComparisonPage does not use mode-forking logic', () => {
    const page = read('components/comparison/ComparisonPage.tsx');
    expect(page).not.toContain('modeOverride');
    expect(page).not.toContain("mode === 'compare'");
    expect(page).not.toContain("mode === 'iterate'");
  });

  it('barrel index exports ComparisonScoreboard instead of VerdictStrip/ModeToggle', () => {
    const idx = read('components/comparison/index.ts');
    expect(idx).toContain("export { ComparisonScoreboard }");
    expect(idx).not.toContain("VerdictStrip");
    expect(idx).not.toContain("ModeToggle");
  });
});

describe('ComparisonScoreboard "Open run" deep link (rendered)', () => {
  // Real render (not source-analysis): asserts the actual anchor href the
  // browser would navigate to, for both a benchmark run and an ad-hoc
  // eval-run in the same comparison pool. Regression coverage for the fix
  // where every run linked to /evaluations/runs/:runId and 404d for
  // benchmark run ids.
  const { ComparisonScoreboard } = require('@/components/comparison/ComparisonScoreboard');

  const overlap = {
    runCount: 2,
    totalTestCases: 5,
    sharedTestCases: 5,
    partialTestCases: 0,
    perRun: [],
    fullyOverlapping: true,
  };

  const makeRun = (runId: string) => ({
    runId,
    runName: runId,
    createdAt: new Date().toISOString(),
    modelId: 'claude-sonnet',
    agentKey: 'mock',
    totalTestCases: 5,
    passedCount: 5,
    failedCount: 0,
    avgAccuracy: 100,
    passRatePercent: 100,
  });

  const makeSelectedRun = (id: string) => ({
    id,
    name: id,
    createdAt: new Date().toISOString(),
    agentKey: 'mock',
    modelId: 'claude-sonnet',
    results: {},
  });

  it('deep-links a benchmark run to /evaluations/benchmarks/:benchmarkId/runs/:runId', () => {
    const runA = makeRun('run-a');
    const runB = makeRun('run-b');
    render(
      React.createElement(ComparisonScoreboard, {
        runs: [runA, runB],
        selectedRuns: [makeSelectedRun('run-a'), makeSelectedRun('run-b')],
        overlap,
        runBenchmarkIdById: new Map([['run-a', 'bench-123'], ['run-b', undefined]]),
        onRemoveRun: () => {},
        onSwapRuns: () => {},
        getAgentName: (k: string) => k,
      })
    );

    // No click-to-expand needed anymore — the link is inline on the row.
    const linkA = screen.getByTestId('open-run-run-a');
    expect(linkA.getAttribute('href')).toBe('/evaluations/benchmarks/bench-123/runs/run-a');
  });

  it('falls back to /evaluations/runs/:runId for an ad-hoc run with no benchmarkId', () => {
    const runA = makeRun('run-a');
    const runB = makeRun('run-b');
    render(
      React.createElement(ComparisonScoreboard, {
        runs: [runA, runB],
        selectedRuns: [makeSelectedRun('run-a'), makeSelectedRun('run-b')],
        overlap,
        runBenchmarkIdById: new Map([['run-a', 'bench-123'], ['run-b', undefined]]),
        onRemoveRun: () => {},
        onSwapRuns: () => {},
        getAgentName: (k: string) => k,
      })
    );

    const linkB = screen.getByTestId('open-run-run-b');
    expect(linkB.getAttribute('href')).toBe('/evaluations/runs/run-b');
  });

  it('falls back to /evaluations/runs/:runId when runBenchmarkIdById is not provided at all', () => {
    const runA = makeRun('run-a');
    render(
      React.createElement(ComparisonScoreboard, {
        runs: [runA],
        selectedRuns: [makeSelectedRun('run-a')],
        overlap: { ...overlap, runCount: 1 },
        onRemoveRun: () => {},
        onSwapRuns: () => {},
        getAgentName: (k: string) => k,
      })
    );

    const linkA = screen.getByTestId('open-run-run-a');
    expect(linkA.getAttribute('href')).toBe('/evaluations/runs/run-a');
  });

  it('shows every metric on the row and a single judge line (no per-row drawer)', () => {
    const runA = makeRun('run-a');
    const runB = makeRun('run-b');
    render(
      React.createElement(ComparisonScoreboard, {
        runs: [runA, runB],
        selectedRuns: [makeSelectedRun('run-a'), makeSelectedRun('run-b')],
        overlap,
        runBenchmarkIdById: new Map([['run-a', 'bench-123'], ['run-b', undefined]]),
        onRemoveRun: () => {},
        onSwapRuns: () => {},
        getAgentName: (k: string) => k,
      })
    );

    expect(screen.getByTestId('run-passrate-run-a').textContent).toContain('100%');
    expect(screen.getByTestId('run-accuracy-run-a').textContent).toContain('100%');
    // Judge info renders exactly once (single shared model here).
    expect(screen.getAllByTestId('scoreboard-judge-line')).toHaveLength(1);
    expect(screen.getByTestId('scoreboard-judge-line').textContent).toContain('Judge:');
  });

  it('removing a run calls onRemoveRun with that run id', () => {
    const runA = makeRun('run-a');
    const runB = makeRun('run-b');
    const onRemoveRun = jest.fn();
    render(
      React.createElement(ComparisonScoreboard, {
        runs: [runA, runB],
        selectedRuns: [makeSelectedRun('run-a'), makeSelectedRun('run-b')],
        overlap,
        runBenchmarkIdById: new Map([['run-a', 'bench-123'], ['run-b', undefined]]),
        onRemoveRun,
        onSwapRuns: () => {},
        getAgentName: (k: string) => k,
      })
    );

    const row = screen.getByTestId('scoreboard-row-A');
    fireEvent.click(row.querySelector('button[title="Remove"]')!);
    expect(onRemoveRun).toHaveBeenCalledWith('run-a');
  });

  it('leads each row with the RUN NAME (agent/model/time move to a secondary line) — owner: "runs info should be communicated"', () => {
    const runA = { ...makeRun('run-a'), runName: 'stark-retail — mock run 1 (subset ingest)' };
    const runB = { ...makeRun('run-b'), runName: 'stark-retail smoke (6 tests, subset ingest)' };
    render(
      React.createElement(ComparisonScoreboard, {
        runs: [runA, runB],
        selectedRuns: [makeSelectedRun('run-a'), makeSelectedRun('run-b')],
        overlap,
        onRemoveRun: () => {},
        onSwapRuns: () => {},
        getAgentName: () => 'internal-rest-agent-example',
      })
    );

    const rowA = screen.getByTestId('scoreboard-row-A');
    const rowB = screen.getByTestId('scoreboard-row-B');
    expect(rowA.textContent).toContain('stark-retail — mock run 1 (subset ingest)');
    expect(rowB.textContent).toContain('stark-retail smoke (6 tests, subset ingest)');
    // The agent name / model still render, just as secondary info alongside the run name.
    expect(rowA.textContent).toContain('internal-rest-agent-example');
    expect(rowA.textContent).toContain('claude-sonnet');
  });

  it('falls back to the agent name when a run has no runName', () => {
    const runA = { ...makeRun('run-a'), runName: '' };
    render(
      React.createElement(ComparisonScoreboard, {
        runs: [runA],
        selectedRuns: [makeSelectedRun('run-a')],
        overlap: { ...overlap, runCount: 1 },
        onRemoveRun: () => {},
        onSwapRuns: () => {},
        getAgentName: () => 'fallback-agent-name',
      })
    );
    expect(screen.getByTestId('scoreboard-row-A').textContent).toContain('fallback-agent-name');
  });

  it('coverage cell states how many cases are tested in BOTH runs, naming which side has the extra cases (owner: "Coverage column is confusing")', () => {
    const runA = makeRun('run-a');
    const runB = makeRun('run-b');
    const partialOverlap = {
      runCount: 2,
      totalTestCases: 62,
      sharedTestCases: 6,
      partialTestCases: 56,
      perRun: [
        { runId: 'run-a', runName: 'A', count: 62, uniqueCount: 56 },
        { runId: 'run-b', runName: 'B', count: 6, uniqueCount: 0 },
      ],
      fullyOverlapping: false,
    };
    render(
      React.createElement(ComparisonScoreboard, {
        runs: [runA, runB],
        selectedRuns: [makeSelectedRun('run-a'), makeSelectedRun('run-b')],
        overlap: partialOverlap,
        onRemoveRun: () => {},
        onSwapRuns: () => {},
        getAgentName: (k: string) => k,
      })
    );

    const banner = screen.getByTestId('comparison-overlap-banner');
    expect(banner.getAttribute('data-overlap')).toBe('partial');
    expect(banner.textContent).toBe('6 in both · 56 only in A');
    // No longer the old ambiguous "N shared / M total" wording.
    expect(banner.textContent).not.toMatch(/\d+ total/);
  });

  it('coverage cell names BOTH sides when each has cases the other lacks', () => {
    const runA = makeRun('run-a');
    const runB = makeRun('run-b');
    const disjointOverlap = {
      runCount: 2,
      totalTestCases: 10,
      sharedTestCases: 4,
      partialTestCases: 6,
      perRun: [
        { runId: 'run-a', runName: 'A', count: 7, uniqueCount: 3 },
        { runId: 'run-b', runName: 'B', count: 7, uniqueCount: 3 },
      ],
      fullyOverlapping: false,
    };
    render(
      React.createElement(ComparisonScoreboard, {
        runs: [runA, runB],
        selectedRuns: [makeSelectedRun('run-a'), makeSelectedRun('run-b')],
        overlap: disjointOverlap,
        onRemoveRun: () => {},
        onSwapRuns: () => {},
        getAgentName: (k: string) => k,
      })
    );
    expect(screen.getByTestId('comparison-overlap-banner').textContent).toBe('4 in both · 3 only in A · 3 only in B');
  });

  it('coverage cell for a fully-overlapping comparison reads "N in both, fully comparable" (green)', () => {
    const runA = makeRun('run-a');
    const runB = makeRun('run-b');
    render(
      React.createElement(ComparisonScoreboard, {
        runs: [runA, runB],
        selectedRuns: [makeSelectedRun('run-a'), makeSelectedRun('run-b')],
        overlap,
        onRemoveRun: () => {},
        onSwapRuns: () => {},
        getAgentName: (k: string) => k,
      })
    );
    const banner = screen.getByTestId('comparison-overlap-banner');
    expect(banner.getAttribute('data-overlap')).toBe('full');
    expect(banner.textContent).toBe('5 in both, fully comparable');
  });
});
