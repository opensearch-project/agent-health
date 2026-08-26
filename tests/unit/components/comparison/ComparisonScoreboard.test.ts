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
 */

import * as fs from 'fs';
import * as path from 'path';

const read = (rel: string) =>
  fs.readFileSync(path.resolve(__dirname, '../../../../', rel), 'utf-8');

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

  it('coverage cell shows shared count from overlap prop', () => {
    expect(src).toContain('overlap.sharedTestCases');
    expect(src).toContain('fully comparable');
  });

  it('run row click expands a detail drawer', () => {
    expect(src).toContain('RunDetailDrawer');
    expect(src).toContain('expandedRow');
    expect(src).toContain('setExpandedRow');
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

  it('embeds MetricComparisonPanel inside an expandable "All metrics" section', () => {
    expect(src).toContain('<MetricComparisonPanel');
    expect(src).toContain('metricsExpanded');
    expect(src).toContain('scoreboard-all-metrics-toggle');
  });

  it('has the sticky positioning and correct z-index', () => {
    expect(src).toContain('sticky top-0 z-40');
  });

  it('uses bg-card border styling consistent with shadcn theme', () => {
    expect(src).toContain('bg-card border border-border rounded-lg');
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
