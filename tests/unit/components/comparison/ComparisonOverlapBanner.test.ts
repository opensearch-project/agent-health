/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 *
 * @jest-environment jsdom
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { ComparisonOverlapBanner } from '@/components/comparison/ComparisonOverlapBanner';
import type { TestCaseOverlap } from '@/services/comparisonService';

const h = React.createElement;

describe('ComparisonOverlapBanner', () => {
  const base: TestCaseOverlap = {
    runCount: 2,
    totalTestCases: 4,
    sharedTestCases: 2,
    partialTestCases: 2,
    perRun: [
      { runId: 'a', runName: 'Run A', count: 3, uniqueCount: 1 },
      { runId: 'b', runName: 'Run B', count: 3, uniqueCount: 1 },
    ],
    fullyOverlapping: false,
  };

  it('renders nothing for fewer than 2 runs', () => {
    const { container } = render(h(ComparisonOverlapBanner, { overlap: { ...base, runCount: 1 } }));
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when there are no test cases', () => {
    const { container } = render(h(ComparisonOverlapBanner, { overlap: { ...base, totalTestCases: 0 } }));
    expect(container.firstChild).toBeNull();
  });

  it('shows the partial-overlap (amber) state with shared / partial counts and per-run uniqueness', () => {
    render(h(ComparisonOverlapBanner, { overlap: base }));
    const banner = screen.getByTestId('comparison-overlap-banner');
    expect(banner.getAttribute('data-overlap')).toBe('partial');
    expect(banner.textContent).toMatch(/in common/i);
    expect(banner.textContent).toContain('Run A');
    expect(banner.textContent).toContain('only here');
  });

  it('shows the full-overlap (green) state when all runs ran the same cases', () => {
    render(
      h(ComparisonOverlapBanner, {
        overlap: {
          runCount: 2,
          totalTestCases: 3,
          sharedTestCases: 3,
          partialTestCases: 0,
          perRun: [
            { runId: 'a', runName: 'Run A', count: 3, uniqueCount: 0 },
            { runId: 'b', runName: 'Run B', count: 3, uniqueCount: 0 },
          ],
          fullyOverlapping: true,
        },
      })
    );
    const banner = screen.getByTestId('comparison-overlap-banner');
    expect(banner.getAttribute('data-overlap')).toBe('full');
    expect(banner.textContent).toMatch(/fully comparable/i);
  });
});
