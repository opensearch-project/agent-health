/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { InlineRenameField } from '@/components/evals3/InlineRenameField';
import { IMPROVEMENT_ROW_BADGE_CLASS, RecentRow } from '@/components/Dashboard';
import { TooltipProvider } from '@/components/ui/tooltip';

afterEach(cleanup);

describe('mobile readability component contracts', () => {
  it('keeps improvement-row badges from shrinking or wrapping', () => {
    expect(IMPROVEMENT_ROW_BADGE_CLASS).toEqual(expect.stringContaining('shrink-0'));
    expect(IMPROVEMENT_ROW_BADGE_CLASS).toEqual(expect.stringContaining('whitespace-nowrap'));
  });

  it('InlineRenameField enables mobile wrapping only when requested', () => {
    const { rerender } = render(React.createElement(InlineRenameField, { value: 'Long run title', onSave: jest.fn(), testId: 'rename' }));
    expect(screen.getByTestId('rename-text').className).toContain('truncate');
    expect(screen.getByTestId('rename-text').className).not.toContain('whitespace-normal');

    rerender(React.createElement(InlineRenameField, { value: 'Long run title', onSave: jest.fn(), testId: 'rename', wrapOnMobile: true }));
    expect(screen.getByTestId('rename-text').className).toEqual(expect.stringContaining('whitespace-normal break-words sm:truncate'));
    expect(screen.getByTestId('rename-text').parentElement?.className).toEqual(expect.stringContaining('flex w-full items-start sm:inline-flex sm:w-auto'));
  });

  it('RecentRow exposes every card field and preserves desktop truncation/tooltips', () => {
    const row = {
      run: {
        id: 'run-mobile',
        name: 'A long evaluation run',
        agentKey: 'agent-mobile',
        modelId: 'mobile-model',
        createdAt: new Date().toISOString(),
        results: {},
        stats: { passed: 2, failed: 1, pending: 0, total: 3 },
      },
      benchmarkId: 'benchmark-mobile',
      benchmarkName: 'A long benchmark name',
      agentName: 'Readable mobile agent',
      passed: 2,
      failed: 1,
      total: 3,
      passRate: 2 / 3,
    } as any;

    render(React.createElement(TooltipProvider, null, React.createElement(RecentRow, { row, onClick: jest.fn() })));

    expect(screen.getByTestId('recent-run-name').textContent).toBe('A long evaluation run');
    expect(screen.getByTestId('recent-run-name').className).toContain('block');
    expect(screen.getByTestId('recent-run-name').className).not.toContain('sm:inline-block');
    expect(screen.getByTestId('recent-run-name').parentElement?.className).toEqual(expect.stringContaining('sm:flex sm:items-center sm:overflow-hidden sm:whitespace-nowrap'));
    expect(screen.getByTestId('recent-run-benchmark').textContent).toBe('A long benchmark name');
    expect(screen.getByTestId('recent-run-agent').textContent).toBe('Readable mobile agent');
    expect(screen.getByTestId('recent-run-model').textContent).toBe('mobile-model');
    expect(screen.getByTestId('recent-run-pass-rate').textContent).toContain('67%');
    expect(screen.getByTestId('recent-run-time').textContent).toBeTruthy();
    for (const id of ['recent-run-name', 'recent-run-benchmark', 'recent-run-agent', 'recent-run-model']) {
      expect(screen.getByTestId(id).className).toContain('sm:truncate');
    }
    expect(screen.getByTestId('recent-run-row').className).toContain('sm:last:border-b-0');
  });
});
