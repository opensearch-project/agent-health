/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import {
  getRunningRunProgress,
  RunningRunIndicator,
} from '@/components/evals3/RunningRunIndicator';

describe('RunningRunIndicator', () => {
  it('renders a distinct running badge and completed-of-total progress', () => {
    render(React.createElement(RunningRunIndicator, { completed: 2, total: 3 }));

    expect(screen.getByText('Running')).not.toBeNull();
    expect(screen.getByText('2 of 3 cases')).not.toBeNull();
    expect(screen.getByTestId('running-run-indicator').getAttribute('aria-label')).toBe(
      'Running, 2 of 3 cases complete',
    );
  });

  it('counts terminal results and uses snapshots as the denominator', () => {
    const progress = getRunningRunProgress({
      testCaseSnapshots: [
        { id: 'a', version: 1, name: 'A' },
        { id: 'b', version: 1, name: 'B' },
        { id: 'c', version: 1, name: 'C' },
      ],
      results: {
        a: { reportId: 'r-a', status: 'completed' },
        b: { reportId: '', status: 'running' },
        c: { reportId: 'r-c', status: 'failed' },
      },
    });

    expect(progress).toEqual({ completed: 2, total: 3 });
  });

  it('falls back to result count for legacy runs without snapshots', () => {
    expect(getRunningRunProgress({
      results: {
        a: { reportId: 'r-a', status: 'completed' },
        b: { reportId: '', status: 'running' },
      },
    })).toEqual({ completed: 1, total: 2 });
  });
});
