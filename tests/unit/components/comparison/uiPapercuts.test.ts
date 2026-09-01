/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Source-analysis regression tests for the comparison-page UI papercut fixes.
 *
 * ComparisonPage / UseCaseComparisonTable need routing, async storage, and
 * recharts to render, which is impractical in jsdom — so (matching the
 * established evaluatorRemoval.test.ts pattern) we assert against the source.
 *
 * Guards:
 *  - test-case rows link to the REAL route (/evaluations/test-cases/...),
 *    not the dead /evals3/test-cases/... that redirected to home.
 *  - label badges link to the filtered list and stop event propagation so
 *    clicking one no longer toggles (expands) the row.
 *  - the "Detailed metrics" section drops the full-bleed radar / time-series
 *    charts; Compare mode instead shows a compact grouped bar chart.
 *  - selected-run badges truncate long names into fixed-size capsules.
 *  - the comparison table header is distinguishable (agent·model·date), and
 *    metric labels are spelled out ("Accuracy", not "Acc").
 */

import * as fs from 'fs';
import * as path from 'path';

const read = (rel: string) =>
  fs.readFileSync(path.resolve(__dirname, '../../../../', rel), 'utf-8');

describe('UseCaseComparisonTable link + label fixes', () => {
  let src: string;
  beforeAll(() => { src = read('components/comparison/UseCaseComparisonTable.tsx'); });

  it('links test cases to the real /evaluations/test-cases/ route', () => {
    expect(src).toContain('/evaluations/test-cases/${row.testCaseId}');
  });

  it('does not reference the dead /evals3/test-cases route', () => {
    expect(src).not.toContain('/evals3/test-cases/');
  });

  it('clicking a label filters the comparison table in place (onFilterLabel), not navigation', () => {
    expect(src).toContain('LabelFilterBadge');
    expect(src).toContain('onFilter?.(label)');
    // no longer navigates away to the test-cases list
    expect(src).not.toContain('/evaluations/test-cases?label=');
  });

  it('label clicks stopPropagation so they do not toggle the row', () => {
    const labelBlock = src.slice(src.indexOf('LabelFilterBadge'));
    expect(labelBlock).toContain('e.stopPropagation()');
  });
});

describe('TestCasesPage honours the ?label= URL filter', () => {
  let src: string;
  beforeAll(() => { src = read('components/evals3/TestCasesPage.tsx'); });

  it('reads the label param and drives the existing label filter', () => {
    expect(src).toContain("searchParams.get('label')");
    expect(src).toContain('setSelectedLabel');
  });

  it('reuses the existing label-filter state (no competing filter)', () => {
    expect(src).toContain("usePersistedState<string>('test-cases:labelFilter'");
  });
});

describe('ComparisonPage detailed-metrics + run-badge fixes', () => {
  let src: string;
  beforeAll(() => { src = read('components/comparison/ComparisonPage.tsx'); });

  it('no longer imports the old full-bleed chart components', () => {
    expect(src).not.toMatch(/import\s+\{\s*AggregateMetricsChart\s*\}/);
    expect(src).not.toMatch(/import\s+\{\s*MetricsTimeSeriesChart\s*\}/);
  });

  it('does not render the old radar / time-series charts', () => {
    expect(src).not.toContain('<AggregateMetricsChart');
    expect(src).not.toContain('<MetricsTimeSeriesChart');
  });

  it('renders the ComparisonScoreboard which shows every metric on the run rows (no separate metrics panel)', () => {
    expect(src).toContain('<ComparisonScoreboard');
    const scoreboard = read('components/comparison/ComparisonScoreboard.tsx');
    expect(scoreboard).not.toContain('MetricComparisonPanel');
    expect(src).not.toContain('RunComparisonBarChart');
    expect(src).not.toContain('MetricComparisonGrid');
  });

  it('detailed metrics render directly on the scoreboard rows, no chart, no deprecated legacy metrics', () => {
    const scoreboard = read('components/comparison/ComparisonScoreboard.tsx');
    // No chart anywhere in this flow (owner feedback: no charts wanted).
    expect(scoreboard).not.toContain('recharts');
    expect(scoreboard).not.toContain('BarChart');
    // The deprecated legacy judge metrics are NOT surfaced as comparison metrics.
    expect(scoreboard).not.toContain('Faithfulness');
    expect(scoreboard).not.toContain('avgTrajectoryScore');
    expect(scoreboard).not.toContain('avgLatencyScore');
  });

  it('drops the run multiselect + Compare/Iterate toggle (unified search replaces the toolbar)', () => {
    expect(src).not.toContain('<ModeToggle');
    expect(src).not.toContain('title={run.name}>{run.name}</span>');
  });
});

describe('Comparison table header + metric-label clarity', () => {
  it('table header shows agent, model and date per run (distinguishable)', () => {
    const src = read('components/comparison/UseCaseComparisonTable.tsx');
    expect(src).toContain('getModelName(run.modelId)');
    expect(src).toContain('formatRelativeTime(run.createdAt)');
    expect(src).toContain('#{idx + 1}');
  });

  it('MetricCell keeps "Accuracy" discoverable (tooltip) and never abbreviates to "Acc"', () => {
    // The dense single-line cell dropped the visible "Accuracy" label to fit
    // status + value + delta on one row; the full word must survive as the
    // value's tooltip so the number stays identifiable.
    const src = read('components/comparison/MetricCell.tsx');
    expect(src).toContain('title="Accuracy"');
    expect(src).not.toContain('>Acc<');
  });
});

describe('Breadcrumbs toolbar wraps instead of clipping', () => {
  it('actions row uses flex-wrap so controls like "Show sample" do not overflow', () => {
    const src = read('components/evals3/Breadcrumbs.tsx');
    expect(src).toContain('flex-wrap');
  });
});

describe('Unified comparison search (scope + scoped search) replaces the benchmark dropdown', () => {
  it('ComparisonPage renders ComparisonSearch instead of the standalone benchmark select', () => {
    const src = read('components/comparison/ComparisonPage.tsx');
    expect(src).toContain('<ComparisonSearch');
    expect(src).not.toContain('placeholder="Select benchmark"');
    // The redundant second dropdown (run multiselect) is gone — run selection
    // lives in the unified search's Run scope.
    expect(src).not.toContain('RunMultiSelect');
    // test-case scope drives a row filter on the comparison table.
    expect(src).toContain('testCaseFilter');
    expect(src).toContain('onSelectTestCase={setTestCaseFilter}');
  });

  it('ComparisonSearch Run scope manages selection (count + select all)', () => {
    const src = read('components/comparison/ComparisonSearch.tsx');
    expect(src).toContain('onSelectAllRuns');
    expect(src).toContain('selected');
  });

  it('ComparisonSearch offers the three scopes and records telemetry', () => {
    const src = read('components/comparison/ComparisonSearch.tsx');
    expect(src).toContain("'benchmark'");
    expect(src).toContain("'run'");
    expect(src).toContain("'testCase'");
    expect(src).toContain('recordUiEvent');
    expect(src).toContain("comparison_search_scope");
    expect(src).toContain("comparison_search_select");
  });

  it('UI telemetry helper posts fire-and-forget to the server sink', () => {
    const src = read('lib/uiTelemetry.ts');
    expect(src).toContain('/api/telemetry/ui-event');
    expect(src).toContain('keepalive: true');
  });
});

describe('Comparison header + label/id papercuts batch', () => {
  it('header collapses onto the title line (Breadcrumbs actions) and renames Categories -> Labels', () => {
    const src = read('components/comparison/ComparisonPage.tsx');
    expect(src).toContain('actions={');
    expect(src).toContain('>All Labels<');
    expect(src).not.toContain('>All Categories<');
  });

  it('run search results are sorted by date descending', () => {
    const src = read('components/comparison/ComparisonSearch.tsx');
    expect(src).toMatch(/new Date\(b\.createdAt\)\.getTime\(\) - new Date\(a\.createdAt\)\.getTime\(\)/);
  });

  it('the "+N" label overflow is a clickable popover and the test-case id has a copy button', () => {
    const src = read('components/comparison/UseCaseComparisonTable.tsx');
    expect(src).toContain('LabelOverflow');
    expect(src).toContain('Show all labels');
    expect(src).toContain('<CopyButton');
    expect(src).toContain('Copy test case id');
  });

  it('TaskSection no longer renders a duplicate labels block', () => {
    const src = read('components/comparison/sections/TaskSection.tsx');
    expect(src).not.toContain('labels.map');
    expect(src).not.toContain("from '@/components/ui/badge'");
  });

  it('CopyButton helper copies to the clipboard and stops propagation', () => {
    const src = read('components/ui/copy-button.tsx');
    expect(src).toContain('navigator.clipboard.writeText');
    expect(src).toContain('stopPropagation');
  });
});

describe('Comparison search: default run scope, all-runs universe, single search field', () => {
  it('ComparisonSearch defaults to the Run scope and is not a duplicate search field', () => {
    const src = read('components/comparison/ComparisonSearch.tsx');
    expect(src).toContain("useState<SearchScope>('run')");
    // the trigger shows a launcher label, not a second "Search …" box
    expect(src).toContain('triggerLabel');
    expect(src).not.toMatch(/Search \{SCOPES\.find/);
  });

  it('ComparisonPage searches the full run universe (eval runs + benchmark runs), not just the current benchmark', () => {
    const src = read('components/comparison/ComparisonPage.tsx');
    expect(src).toContain('listEvaluationRuns');
    expect(src).toContain('runUniverse');
    expect(src).toContain('runs={runUniverse}');
  });

  it('ComparisonPage filters by label (dropdown + label click drive labelFilter)', () => {
    const src = read('components/comparison/ComparisonPage.tsx');
    expect(src).toContain('labelFilter');
    expect(src).toContain('allLabels');
    expect(src).toContain('onFilterLabel={setLabelFilter}');
  });
});

describe('Consolidated metrics matrix keeps #345 pass-rate/accuracy regression hooks', () => {
  it('ComparisonScoreboard run rows carry run-passrate / run-accuracy testids', () => {
    const src = read('components/comparison/ComparisonScoreboard.tsx');
    expect(src).toContain('run-passrate-${run.runId}');
    expect(src).toContain('run-accuracy-${run.runId}');
  });
});

describe('"Comparing A vs B" summary line — REMOVED (iteration 5, owner feedback: no new vertical space; benchmark identity lives in the breadcrumb, run identity lives on the A/B rows)', () => {
  it('ComparisonPage no longer renders a standalone Comparing-A-vs-B summary line', () => {
    const src = read('components/comparison/ComparisonPage.tsx');
    expect(src).not.toContain('data-testid="comparison-summary-line"');
    expect(src).not.toContain('selectedRuns[0].name');
  });

  it('ComparisonPage breadcrumb inserts the benchmark name (owner: benchmark identity lives ONLY in the breadcrumb)', () => {
    const src = read('components/comparison/ComparisonPage.tsx');
    expect(src).toMatch(/benchmark\?\.name[\s\S]{0,120}href.*evaluations\/benchmarks/);
  });
});

describe('Scoreboard run-name title tooltip — owner: truncated run name must be FULLY readable on hover', () => {
  it('the run-name cell\'s title attribute always matches the displayed text, including the runName-missing fallback', () => {
    const src = read('components/comparison/ComparisonScoreboard.tsx');
    // Regression: title={run.runName} alone would render title="undefined"
    // text (i.e. no tooltip) whenever runName is falsy, even though the
    // fallback getAgentName(...) text IS displayed — title and displayed
    // text must use the identical fallback expression.
    expect(src).toMatch(/title=\{run\.runName \|\| getAgentName\(run\.agentKey\)\}/);
  });
});
