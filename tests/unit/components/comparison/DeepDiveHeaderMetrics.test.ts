/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 *
 * @jest-environment jsdom
 */

/**
 * Unit tests for DeepDiveHeaderMetrics — the ComparisonDeepDive panel's
 * header. After two rounds of owner feedback it renders ONLY the case
 * identity line ("Case: <name>", linked) — the "Score / Duration / Tools, A
 * vs B" line (round 1's replacement for the removed bars chart) was itself
 * removed this round because every one of those numbers now lives on the
 * scoreboard's run rows (see ComparisonScoreboard.tsx), so the deep-dive
 * header would just be duplicating them.
 *
 * Covers: the case name renders prominently and links to the test case, a
 * plain-text fallback when no id is known, and that the component renders
 * nothing when there is no case name at all.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  DeepDiveHeaderMetrics,
  type DeepDiveHeaderMetricsProps,
} from '@/components/comparison/DeepDiveHeaderMetrics';

const h = React.createElement;

/** DeepDiveHeaderMetrics renders a react-router-dom <Link> — needs a Router in scope. */
function renderMetrics(props: DeepDiveHeaderMetricsProps) {
  return render(h(MemoryRouter, null, h(DeepDiveHeaderMetrics, props)));
}

describe('DeepDiveHeaderMetrics (component)', () => {
  it('renders nothing when there is no case name', () => {
    const { container } = renderMetrics({});
    expect(container.firstChild).toBeNull();
  });

  it('renders the case name prominently, linked to the test case', () => {
    // Owner follow-up (#398): the deep-dive panel analyzes ONE representative
    // test case for span citations, but nothing said so -- the panel header
    // must name the case it's actually tracing.
    renderMetrics({
      testCaseName: 'Diagnose protected-index write rejection',
      testCaseId: 'tc-42',
    });
    const caseLabel = screen.getByTestId('deep-dive-case-label');
    expect(caseLabel.textContent).toContain('Case:');
    expect(caseLabel.textContent).toContain('Diagnose protected-index write rejection');
    const link = screen.getByRole('link', { name: /Diagnose protected-index write rejection/ });
    expect(link.getAttribute('href')).toBe('/evaluations/test-cases/tc-42');
  });

  it('renders the case name as plain (unlinked) text when no testCaseId is given', () => {
    renderMetrics({ testCaseName: 'Untitled case' });
    const caseLabel = screen.getByTestId('deep-dive-case-label');
    expect(caseLabel.textContent).toContain('Untitled case');
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('does not render a metrics line (Score/Duration/Tools) — those numbers now live on the scoreboard rows', () => {
    renderMetrics({ testCaseName: 'Case with no separate metrics line', testCaseId: 'tc-1' });
    expect(screen.queryByTestId('deep-dive-header-metrics')).toBeNull();
  });
});
