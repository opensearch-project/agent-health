/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mockNavigate = jest.fn();
const mockGetBenchmark = jest.fn();
const mockGetTestCases = jest.fn();
const mockListEvaluationRuns = jest.fn();

jest.mock('react-router-dom', () => ({
  useParams: () => ({ benchmarkId: 'bench-1' }),
  useNavigate: () => mockNavigate,
}));

jest.mock('@/hooks/usePersistedState', () => ({
  usePersistedState: (_key: string, initial: unknown) => React.useState(initial),
}));
jest.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));

jest.mock('@/services/storage', () => ({
  asyncBenchmarkStorage: {
    getById: (...args: unknown[]) => mockGetBenchmark(...args),
    deleteRun: jest.fn(),
    save: jest.fn(),
  },
  asyncTestCaseStorage: { getByIds: (...args: unknown[]) => mockGetTestCases(...args) },
}));

jest.mock('@/services/client', () => ({
  executeBenchmarkRun: jest.fn(),
  listEvaluationRuns: (...args: unknown[]) => mockListEvaluationRuns(...args),
}));

jest.mock('@/hooks/useBenchmarkCancellation', () => ({
  useBenchmarkCancellation: () => ({ isCancelling: () => false, handleCancelRun: jest.fn() }),
}));

jest.mock('@/lib/constants', () => ({
  DEFAULT_CONFIG: {
    agents: [{ key: 'demo', name: 'Demo Agent', enabled: true }],
    models: { 'demo-model': { display_name: 'Demo Model' } },
  },
}));

jest.mock('@/lib/config', () => ({ ENV_CONFIG: { backendUrl: '' } }));
jest.mock('@/lib/utils', () => ({
  formatDate: () => 'Aug 25, 2026',
  getModelName: (id: string) => id,
  getLabelColor: () => '',
}));

jest.mock('@/components/evals3/Breadcrumbs', () => ({ Breadcrumbs: () => React.createElement('nav') }));
jest.mock('@/components/BenchmarkEditor', () => ({ BenchmarkEditor: () => null }));
jest.mock('@/components/JudgeModelSelect', () => ({ JudgeModelSelect: () => null }));

const mockPassthrough = (tag = 'div') => ({ children, ...props }: any) => {
  const { asChild, onValueChange, defaultValue, defaultSize, minSize, maxSize, direction, withHandle, ...domProps } = props;
  return React.createElement(tag, domProps, children);
};

jest.mock('@/components/ui/card', () => ({
  Card: mockPassthrough('section'), CardContent: mockPassthrough(), CardHeader: mockPassthrough(), CardTitle: mockPassthrough('h3'),
}));
jest.mock('@/components/ui/button', () => ({ Button: mockPassthrough('button') }));
jest.mock('@/components/ui/badge', () => ({ Badge: mockPassthrough('span') }));
jest.mock('@/components/ui/input', () => ({ Input: mockPassthrough('input') }));
jest.mock('@/components/ui/label', () => ({ Label: mockPassthrough('label') }));
jest.mock('@/components/ui/textarea', () => ({ Textarea: mockPassthrough('textarea') }));
jest.mock('@/components/ui/progress', () => ({ Progress: mockPassthrough() }));
jest.mock('@/components/ui/checkbox', () => ({ Checkbox: mockPassthrough('input') }));
jest.mock('@/components/ui/select', () => ({
  Select: mockPassthrough(), SelectContent: mockPassthrough(), SelectItem: mockPassthrough(),
  SelectTrigger: mockPassthrough('button'), SelectValue: mockPassthrough('span'),
}));
jest.mock('@/components/ui/tabs', () => ({
  Tabs: mockPassthrough(), TabsList: mockPassthrough(), TabsTrigger: mockPassthrough('button'), TabsContent: mockPassthrough(),
}));
jest.mock('@/components/ui/resizable', () => ({
  ResizablePanelGroup: mockPassthrough(), ResizablePanel: mockPassthrough(), ResizableHandle: () => null,
}));

class MockIntersectionObserver {
  observe() { /* noop */ }
  disconnect() { /* noop */ }
}
(globalThis as any).IntersectionObserver = MockIntersectionObserver;
(globalThis as any).fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ evaluators: [] }) });

import { BenchmarkRunsPage2 } from '@/components/evals3/BenchmarkRunsPage';

const runningEvalRun = {
  id: 'eval-run-live',
  docType: 'evaluation-run',
  name: 'Live benchmark run',
  createdAt: '2026-08-25T00:00:00.000Z',
  status: 'running',
  agentKey: 'demo',
  modelId: 'demo-model',
  sources: [{ type: 'benchmark', benchmarkId: 'bench-1' }],
  trigger: 'ui',
  benchmarkId: 'bench-1',
  benchmarkVersion: 1,
  testCaseSnapshots: [
    { id: 'tc-1', version: 1, name: 'One' },
    { id: 'tc-2', version: 1, name: 'Two' },
    { id: 'tc-3', version: 1, name: 'Three' },
  ],
  results: {
    'tc-1': { reportId: 'report-1', status: 'completed' },
    'tc-2': { reportId: 'report-2', status: 'failed' },
  },
};

describe('BenchmarkRunsPage in-progress evaluation runs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetBenchmark.mockResolvedValue({
      id: 'bench-1',
      name: 'Visibility benchmark',
      description: '',
      createdAt: '2026-08-24T00:00:00.000Z',
      updatedAt: '2026-08-24T00:00:00.000Z',
      currentVersion: 1,
      versions: [{ version: 1, createdAt: '2026-08-24T00:00:00.000Z', testCaseIds: ['tc-1', 'tc-2', 'tc-3'] }],
      testCaseIds: ['tc-1', 'tc-2', 'tc-3'],
      runs: [],
      totalRuns: 0,
      hasMoreRuns: false,
    });
    mockGetTestCases.mockResolvedValue([]);
    mockListEvaluationRuns.mockResolvedValue({ evaluationRuns: [runningEvalRun], total: 1 });
  });

  it('queries running docs for this benchmark and renders live progress in the runs section', async () => {
    const view = render(React.createElement(BenchmarkRunsPage2));

    expect(await screen.findByText('Live benchmark run')).not.toBeNull();
    expect(screen.getByText('Running')).not.toBeNull();
    expect(screen.getByText('2 of 3 cases')).not.toBeNull();
    expect(screen.getByTestId('benchmark-in-progress-run')).not.toBeNull();
    expect(mockListEvaluationRuns).toHaveBeenCalledWith({
      benchmarkId: 'bench-1',
      status: 'running',
      size: 100,
      sort: 'createdAt',
      order: 'desc',
    });

    fireEvent.click(screen.getByTestId('benchmark-in-progress-run'));
    expect(mockNavigate).toHaveBeenCalledWith('/evaluations/runs/eval-run-live/inspect');

    view.unmount();
    await waitFor(() => expect(mockGetBenchmark).toHaveBeenCalled());
  });
});
