/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { render, screen } from '@testing-library/react';

const mockNavigate = jest.fn();
const mockListEvaluationRuns = jest.fn();
const mockGetAllBenchmarks = jest.fn();
const mockGetReportSummaries = jest.fn();

jest.mock('react-router-dom', () => ({ useNavigate: () => mockNavigate }));
jest.mock('@/hooks/usePersistedState', () => ({
  usePersistedState: (_key: string, initial: unknown) => React.useState(initial),
}));
jest.mock('@/hooks/usePersistedSet', () => ({
  usePersistedSet: () => React.useState(new Set<string>()),
}));

jest.mock('@/services/storage', () => ({
  asyncBenchmarkStorage: { getAll: (...args: unknown[]) => mockGetAllBenchmarks(...args) },
  asyncTestCaseStorage: {},
  asyncRunStorage: { getReportSummariesByIds: (...args: unknown[]) => mockGetReportSummaries(...args) },
}));
jest.mock('@/services/client', () => ({
  listEvaluationRuns: (...args: unknown[]) => mockListEvaluationRuns(...args),
}));

jest.mock('@/lib/constants', () => ({
  DEFAULT_CONFIG: {
    agents: [{ key: 'demo', name: 'Demo Agent', enabled: true }],
    models: { 'demo-model': { display_name: 'Demo Model' } },
  },
}));
jest.mock('@/lib/utils', () => ({
  formatRelativeTime: () => 'just now',
  getModelName: (id: string) => id,
}));
jest.mock('@/components/evals3/Breadcrumbs', () => ({ Breadcrumbs: () => React.createElement('nav') }));

const mockPassthrough = (tag = 'div') => ({ children, ...props }: any) => {
  const { asChild, onValueChange, defaultValue, open, onOpenChange, delayDuration, ...domProps } = props;
  return React.createElement(tag, domProps, children);
};

jest.mock('@/components/ui/button', () => ({ Button: mockPassthrough('button') }));
jest.mock('@/components/ui/input', () => ({ Input: mockPassthrough('input') }));
jest.mock('@/components/ui/badge', () => ({ Badge: mockPassthrough('span') }));
jest.mock('@/components/ui/select', () => ({
  Select: mockPassthrough(), SelectContent: mockPassthrough(), SelectItem: mockPassthrough(),
  SelectTrigger: mockPassthrough('button'), SelectValue: mockPassthrough('span'),
}));
jest.mock('@/components/ui/tooltip', () => ({
  Tooltip: mockPassthrough(), TooltipContent: mockPassthrough(),
  TooltipProvider: mockPassthrough(), TooltipTrigger: mockPassthrough(),
}));
jest.mock('@/components/ui/popover', () => ({
  Popover: mockPassthrough(), PopoverContent: mockPassthrough(), PopoverTrigger: mockPassthrough(),
}));

class MockIntersectionObserver {
  observe() { /* noop */ }
  disconnect() { /* noop */ }
}
(globalThis as any).IntersectionObserver = MockIntersectionObserver;

import { EvalRunsPage } from '@/components/evals3/EvalRunsPage';

describe('EvalRunsPage running rows', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAllBenchmarks.mockResolvedValue([{
      id: 'bench-1', name: 'Visibility benchmark', testCaseIds: [], runs: [], versions: [], currentVersion: 1,
    }]);
    mockGetReportSummaries.mockResolvedValue({});
    mockListEvaluationRuns.mockResolvedValue({
      total: 1,
      evaluationRuns: [{
        id: 'eval-run-live',
        docType: 'evaluation-run',
        name: 'Running visibility run',
        createdAt: new Date().toISOString(),
        status: 'running',
        agentKey: 'demo',
        modelId: 'demo-model',
        sources: [{ type: 'benchmark', benchmarkId: 'bench-1' }],
        trigger: 'ui',
        benchmarkId: 'bench-1',
        testCaseSnapshots: [
          { id: 'tc-1', version: 1, name: 'One' },
          { id: 'tc-2', version: 1, name: 'Two' },
          { id: 'tc-3', version: 1, name: 'Three' },
        ],
        results: {
          'tc-1': { reportId: 'report-1', status: 'completed', passFailStatus: 'passed' },
          'tc-2': { reportId: 'report-2', status: 'failed', passFailStatus: 'failed' },
        },
      }, {
        id: 'eval-run-interrupted',
        docType: 'evaluation-run',
        name: 'Interrupted run',
        createdAt: new Date(Date.now() - 60_000).toISOString(),
        status: 'failed',
        error: 'interrupted: server restarted mid-run',
        agentKey: 'demo',
        modelId: 'demo-model',
        sources: [{ type: 'benchmark', benchmarkId: 'bench-1' }],
        trigger: 'ui',
        benchmarkId: 'bench-1',
        testCaseSnapshots: [{ id: 'tc-1', version: 1, name: 'One' }],
        results: { 'tc-1': { reportId: 'report-1', status: 'completed', passFailStatus: 'passed' } },
      }],
    });
  });

  it('does not show a green completed icon for a running run and shows case progress', async () => {
    const view = render(React.createElement(EvalRunsPage));

    expect(await screen.findByText('Running visibility run')).not.toBeNull();
    expect(screen.getByText('2 of 3 cases')).not.toBeNull();
    expect(screen.getByTestId('running-run-indicator').getAttribute('aria-label')).toBe(
      'Running, 2 of 3 cases complete',
    );
    expect(screen.getByLabelText('Running').getAttribute('class')).toContain('animate-spin');
    expect(await screen.findByText('Interrupted run')).not.toBeNull();
    expect(screen.getByLabelText('Failed')).not.toBeNull();
    expect(screen.getByText('interrupted: server restarted mid-run').getAttribute('title')).toBe(
      'interrupted: server restarted mid-run',
    );
    expect(mockListEvaluationRuns).toHaveBeenCalledWith({ size: 500 });

    view.unmount();
  });
});
