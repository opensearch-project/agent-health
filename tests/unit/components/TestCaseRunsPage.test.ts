/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { EvaluationReport, TestCase } from '@/types';
import { getJudgeVerdict } from '@/lib/reportVerdict';

const mockNavigate = jest.fn();
const mockGetById = jest.fn();
const mockGetReportsByTestCase = jest.fn();

jest.mock('react-router-dom', () => ({
  useParams: () => ({ testCaseId: 'tc-1' }),
  useNavigate: () => mockNavigate,
  useLocation: () => ({ state: null }),
}));

jest.mock('@/services/storage', () => ({
  asyncTestCaseStorage: { getById: (...args: unknown[]) => mockGetById(...args) },
  asyncRunStorage: {
    getReportsByTestCase: (...args: unknown[]) => mockGetReportsByTestCase(...args),
    deleteReport: jest.fn(),
  },
}));

jest.mock('@/components/RunScore', () => ({
  RunScore: ({ report }: { report: EvaluationReport }) => {
    const score = getJudgeVerdict(report)?.score;
    return React.createElement('span', null, score == null ? '—' : `${Math.round(score)}%`);
  },
}));

jest.mock('@/components/TestCaseDetailPanel', () => ({
  TestCaseDetailPanel: () => React.createElement('div', { 'data-testid': 'test-case-detail' }),
}));
jest.mock('@/components/QuickRunModal', () => ({ QuickRunModal: () => null }));
jest.mock('@/components/TestCaseEditor', () => ({ TestCaseEditor: () => null }));

jest.mock('@/components/ui/card', () => ({
  Card: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => React.createElement('div', props, children),
  CardContent: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => React.createElement('div', props, children),
}));
jest.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => React.createElement('button', props, children),
}));
jest.mock('@/components/ui/badge', () => ({
  Badge: ({ children, ...props }: React.HTMLAttributes<HTMLSpanElement>) => React.createElement('span', props, children),
}));
jest.mock('@/components/ui/skeleton', () => ({ Skeleton: () => React.createElement('div') }));

const testCase: TestCase = {
  id: 'tc-1',
  name: 'Poisoned report exemplar',
  description: '',
  category: 'RCA' as any,
  difficulty: 'Medium',
  labels: [],
  currentVersion: 1,
  versions: [],
  isPromoted: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
} as TestCase;

const poisonedReport: EvaluationReport = {
  id: 'report-poisoned',
  timestamp: '2026-08-24T22:42:33.122Z',
  testCaseId: 'tc-1',
  status: 'completed',
  agentName: 'Agent',
  modelName: 'model',
  trajectory: [],
  metricsStatus: 'error',
  metrics: { accuracy: 0, faithfulness: 0 },
  llmJudgeReasoning: '**Evaluator could not run.** Reason (trace_timeout)',
  matcherResults: [{
    description: 'judge: expected outcomes',
    method: 'llm-judge',
    pass: true,
    score: 1,
  }],
};

describe('TestCaseRunsPage verdict-first rows', () => {
  afterEach(() => {
    cleanup();
    jest.clearAllMocks();
  });

  it('renders a poisoned judge-passed report as PASSED 100% with an explained diagnostic', async () => {
    mockGetById.mockResolvedValue(testCase);
    mockGetReportsByTestCase.mockResolvedValue({ reports: [poisonedReport], total: 1 });

    const { TestCaseRunsPage } = await import('@/components/TestCaseRunsPage');
    render(React.createElement(TestCaseRunsPage));

    await waitFor(() => expect(screen.queryByTestId('test-case-runs-page')).not.toBeNull());
    expect(screen.queryByText('PASSED')).not.toBeNull();
    expect(screen.queryByText('100%')).not.toBeNull();
    expect(screen.queryByText('ERRORED')).toBeNull();

    const diagnostic = screen.getByTestId('metrics-diagnostic');
    expect(diagnostic.getAttribute('title')).toContain('does not affect the judge verdict');
    expect(diagnostic.getAttribute('aria-label')).toContain('Metrics diagnostics');
  });
});
