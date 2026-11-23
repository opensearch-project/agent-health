/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ReportPage (`/evaluations/reports/:reportId`) — renders ONE report from its
 * own document, so a report whose run and/or test case were deleted still
 * opens (neither delete cascades to report documents). Says plainly what is
 * gone, links to whatever still exists, and reserves its "not found" state
 * for a report id that truly does not exist.
 *
 * Also pins the shared panel's "Test case deleted" note, which the run
 * inspector shows for a kept run whose case was deleted (scenario a) — the
 * report page has its own banner and does not repeat it.
 */

import * as React from 'react';
const h = React.createElement;
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import type { EvaluationReport } from '@/types';

const getReportById = jest.fn();
const getTestCaseById = jest.fn();
const getBenchmarkById = jest.fn();
const getEvaluationRun = jest.fn();
jest.mock('@/services/storage', () => ({
  asyncRunStorage: { getReportById: (...a: unknown[]) => getReportById(...a) },
  asyncTestCaseStorage: { getById: (...a: unknown[]) => getTestCaseById(...a) },
  asyncBenchmarkStorage: { getById: (...a: unknown[]) => getBenchmarkById(...a) },
}));
jest.mock('@/services/client', () => ({ getEvaluationRun: (...a: unknown[]) => getEvaluationRun(...a) }));
jest.mock('@/lib/pageLatency', () => ({ markPageReady: jest.fn() }));
// The panel's body is the real inspector content; only its heavy children
// are stubbed. RunDetailsContent echoes the report's final response so the
// test can assert the REPORT (not a placeholder) is what rendered.
jest.mock('@/components/RunDetailsContent', () => ({
  RunDetailsContent: ({ report }: { report: EvaluationReport }) =>
    require('react').createElement('div', { 'data-testid': 'run-details-content' },
      report.trajectory.map(s => s.content).join(' ')),
}));
jest.mock('@/components/evals3/CaseTldrCard', () => ({ CaseTldrCard: () => null }));
jest.mock('@/components/evals3/CollapsibleTestCaseDefinition', () => ({
  CollapsibleTestCaseDefinition: ({ testCase }: { testCase: unknown }) =>
    testCase ? require('react').createElement('div', { 'data-testid': 'test-case-definition' }) : null,
}));

import { ReportPage } from '@/components/evals3/ReportPage';
import { TestCaseInspectorPanel } from '@/components/evals3/TestCaseInspectorPanel';

const report = {
  id: 'rep-1', timestamp: '2026-01-01T00:00:00Z', testCaseId: 'tc-1', experimentId: 'bm-1', experimentRunId: 'run-1',
  agentName: 'Demo Agent', modelName: 'demo-model', status: 'completed', passFailStatus: 'passed', metricsStatus: 'ready',
  trajectory: [{ id: 's1', type: 'response', content: 'Root cause: node-3 is out of heap', timestamp: 1 }],
  rawEvents: [], metrics: { accuracy: 0.9 },
} as unknown as EvaluationReport;

function mount(id = 'rep-1') {
  return render(h(MemoryRouter, { initialEntries: [`/evaluations/reports/${id}`] },
    h(Routes, null, h(Route, { path: '/evaluations/reports/:reportId', element: h(ReportPage) }))));
}

const notFound404 = Object.assign(new Error('404'), { status: 404 });

describe('ReportPage', () => {
  beforeEach(() => {
    getReportById.mockReset(); getTestCaseById.mockReset(); getBenchmarkById.mockReset(); getEvaluationRun.mockReset();
    getReportById.mockResolvedValue(report);
    getBenchmarkById.mockResolvedValue({ id: 'bm-1', runs: [] });
  });

  it('(c) run AND test case deleted: renders the report itself, labelled "Run deleted" + "Test case deleted", no links to pages that would bounce', async () => {
    getEvaluationRun.mockRejectedValue(notFound404);
    getTestCaseById.mockResolvedValue(null);
    mount();
    await screen.findByTestId('report-page');
    expect(screen.getByTestId('run-details-content').textContent).toContain('Root cause: node-3 is out of heap');
    expect(screen.getByTestId('report-page-run-deleted').textContent).toMatch(/Run deleted/);
    expect(screen.getByTestId('report-page-run-deleted').textContent).toContain('run-1');
    expect(screen.getByTestId('report-page-test-case-deleted').textContent).toMatch(/Test case deleted/);
    expect(screen.getByTestId('report-page-test-case-deleted').textContent).toContain('tc-1');
    expect(screen.getByTestId('report-page-title').textContent).toBe('Run report');
    expect(screen.queryByTestId('report-page-open-run')).toBeNull();
    expect(screen.queryByTestId('report-page-open-test-case')).toBeNull();
    // The page banner carries the label; the panel's own inspector note is not repeated.
    expect(screen.queryByTestId('inspector-test-case-deleted')).toBeNull();
    expect(screen.getByTestId('inspector-status-badge').textContent).toBe('PASSED');
  });

  it('(b) run deleted, test case kept: labels only the run and links to the test case page with that run preselected', async () => {
    getEvaluationRun.mockRejectedValue(notFound404);
    getTestCaseById.mockResolvedValue({ id: 'tc-1', name: 'cpu-spike-on-node-3' });
    mount();
    await screen.findByTestId('report-page');
    expect(screen.getByTestId('report-page-title').textContent).toBe('cpu-spike-on-node-3');
    expect(screen.getByTestId('report-page-run-deleted')).toBeTruthy();
    expect(screen.queryByTestId('report-page-test-case-deleted')).toBeNull();
    expect(screen.queryByTestId('inspector-test-case-deleted')).toBeNull();
    expect(screen.getByTestId('test-case-definition')).toBeTruthy();
    expect(screen.getByTestId('report-page-open-test-case').getAttribute('href')).toBe('/evaluations/test-cases/tc-1?run=rep-1');
    expect(screen.queryByTestId('report-page-open-run')).toBeNull();
  });

  it('(a) test case deleted, run kept: labels only the test case and links to the run inspector with the case preselected', async () => {
    getEvaluationRun.mockResolvedValue({ id: 'run-1' });
    getTestCaseById.mockResolvedValue(null);
    mount();
    await screen.findByTestId('report-page');
    expect(screen.getByTestId('report-page-test-case-deleted')).toBeTruthy();
    expect(screen.queryByTestId('report-page-run-deleted')).toBeNull();
    expect(screen.getByTestId('report-page-open-run').getAttribute('href')).toBe('/evaluations/benchmarks/bm-1/runs/run-1/inspect?reportId=rep-1');
    expect(screen.getByTestId('run-details-content').textContent).toContain('Root cause');
  });

  it('a standalone single-case report (never had a run) with its test case intact shows no orphan note at all', async () => {
    getReportById.mockResolvedValue({ ...report, experimentId: undefined, experimentRunId: undefined });
    getTestCaseById.mockResolvedValue({ id: 'tc-1', name: 'cpu-spike-on-node-3' });
    mount();
    await screen.findByTestId('report-page');
    expect(screen.queryByTestId('report-page-orphan-note')).toBeNull();
    expect(getEvaluationRun).not.toHaveBeenCalled();
    expect(screen.getByTestId('report-page-open-test-case')).toBeTruthy();
  });

  it('only a report id that truly does not exist gets the "Report not found" state (with a way out)', async () => {
    getReportById.mockResolvedValue(null);
    mount('missing');
    const nf = await screen.findByTestId('report-page-not-found');
    expect(nf.textContent).toContain('missing');
    expect(screen.getByRole('link', { name: /Go to Evaluation Runs/ }).getAttribute('href')).toBe('/evaluations/runs');
    expect(screen.queryByTestId('report-page')).toBeNull();
  });

  it('a transient failure of the run / test case lookups still renders the report — unverified, with no "deleted" labels and a Retry', async () => {
    getEvaluationRun.mockRejectedValue(Object.assign(new Error('Bad Gateway'), { status: 502 }));
    getTestCaseById.mockRejectedValue(new Error('Bad Gateway'));
    mount();
    await screen.findByTestId('report-page');
    expect(screen.getByTestId('run-details-content').textContent).toContain('Root cause');
    expect(screen.getByTestId('report-page-unverified')).toBeTruthy();
    expect(screen.queryByTestId('report-page-run-deleted')).toBeNull();
    expect(screen.queryByTestId('report-page-test-case-deleted')).toBeNull();
    expect(screen.queryByTestId('report-page-error')).toBeNull();
    getEvaluationRun.mockResolvedValue({ id: 'run-1' });
    getTestCaseById.mockResolvedValue(null);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByTestId('report-page-test-case-deleted')).toBeTruthy());
    expect(screen.queryByTestId('report-page-unverified')).toBeNull();
  });

  it('only the report fetch itself failing is an error state (with Retry)', async () => {
    getReportById.mockRejectedValue(new Error('storage offline'));
    mount();
    const err = await screen.findByTestId('report-page-error');
    expect(err.textContent).toContain('storage offline');
    getReportById.mockResolvedValue(report);
    getEvaluationRun.mockResolvedValue({ id: 'run-1' });
    getTestCaseById.mockResolvedValue({ id: 'tc-1', name: 'cpu-spike-on-node-3' });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByTestId('report-page')).toBeTruthy());
  });

  it('a slow load for a previous report id never overwrites the current one', async () => {
    let resolveFirst: (r: EvaluationReport) => void = () => {};
    getReportById.mockImplementationOnce(() => new Promise<EvaluationReport>(res => { resolveFirst = res; }));
    getEvaluationRun.mockResolvedValue({ id: 'run-1' });
    getTestCaseById.mockResolvedValue({ id: 'tc-1', name: 'cpu-spike-on-node-3' });
    const { unmount } = render(h(MemoryRouter, { initialEntries: ['/evaluations/reports/rep-slow'] },
      h(Link, { to: '/evaluations/reports/rep-1' }, 'go'),
      h(Routes, null, h(Route, { path: '/evaluations/reports/:reportId', element: h(ReportPage) }))));
    // Navigate in place to rep-1 (resolves immediately), then let rep-slow's fetch land late.
    await screen.findByTestId('report-page-loading');
    fireEvent.click(screen.getByText('go'));
    await screen.findByTestId('report-page');
    resolveFirst({ ...report, id: 'rep-slow', trajectory: [{ id: 's', type: 'response', content: 'STALE', timestamp: 1 }] } as EvaluationReport);
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });
    expect(screen.getByTestId('run-details-content').textContent).toContain('Root cause');
    expect(screen.getByTestId('run-details-content').textContent).not.toContain('STALE');
    unmount();
  });
});

describe('TestCaseInspectorPanel — deleted test case note', () => {
  it('shows "Test case deleted" only when the record is known to be missing (not while loading, not when present)', () => {
    const { rerender } = render(h(TestCaseInspectorPanel, { report, testCase: null, status: 'passed', testCaseFullRecord: 'missing' }));
    expect(screen.getByTestId('inspector-test-case-deleted').textContent).toMatch(/Test case deleted/);
    rerender(h(TestCaseInspectorPanel, { report, testCase: null, status: 'passed', testCaseFullRecord: 'loading' }));
    expect(screen.queryByTestId('inspector-test-case-deleted')).toBeNull();
    rerender(h(TestCaseInspectorPanel, { report, testCase: { id: 'tc-1', name: 'x' } as never, status: 'passed', testCaseFullRecord: 'missing' }));
    expect(screen.queryByTestId('inspector-test-case-deleted')).toBeNull();
  });
});
