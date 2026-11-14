/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * Mounts the REAL application route table (`AppRoutes` from App.tsx) under a
 * MemoryRouter and asserts where every retired legacy URL lands. Page
 * components are stubbed so only the routing is under test.
 */

import * as React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';

// One stub per page module: renders a marker + the current URL so a test can
// assert both WHICH page mounted and WHAT the final URL (path + query) is.
const stub = (name: string) => ({
  __esModule: true,
  ...Object.fromEntries(
    // Every named export any of these modules is imported by App.tsx.
    ['Dashboard', 'SettingsPage', 'ComparisonPage', 'AgentTracesPage', 'PerformanceOverlay',
      'CodingAgentsPage', 'EvaluatorsPage', 'EvaluatorEditPage', 'AssistantChat', 'SkillsPage',
      'BenchmarksPage4', 'TestCasesPage4', 'BenchmarkRunsPage2', 'TestCaseDetailPage', 'EvalRunsPage',
      'RunInspectorPage', 'NewRunPage', 'Layout',
    ].map(exportName => [exportName, function Page() {
      const loc = useLocation();
      return React.createElement('div', { 'data-testid': `page-${name}` }, loc.pathname + loc.search);
    }]),
  ),
});

jest.mock('@/components/Dashboard', () => stub('dashboard'));
jest.mock('@/components/SettingsPage', () => stub('settings'));
jest.mock('@/components/comparison/ComparisonPage', () => stub('compare'));
jest.mock('@/components/traces/AgentTracesPage', () => stub('agent-traces'));
jest.mock('@/components/PerformanceOverlay', () => stub('perf'));
jest.mock('@/components/codingAgents/CodingAgentsPage', () => stub('coding-agents'));
jest.mock('@/components/EvaluatorsPage', () => stub('evaluators'));
jest.mock('@/components/EvaluatorEditPage', () => stub('evaluator-edit'));
jest.mock('@/components/assistant-ui/AssistantChat', () => stub('assistant'));
jest.mock('@/components/skills/SkillsPage', () => stub('skills'));
jest.mock('@/components/Layout', () => stub('layout'));
jest.mock('@/components/evals3/BenchmarksPage', () => stub('evals3-benchmarks'));
jest.mock('@/components/evals3/TestCasesPage', () => stub('evals3-test-cases'));
jest.mock('@/components/evals3/BenchmarkRunsPage', () => stub('evals3-benchmark-runs'));
jest.mock('@/components/evals3/TestCaseDetailPage', () => stub('evals3-test-case-detail'));
jest.mock('@/components/evals3/EvalRunsPage', () => stub('evals3-eval-runs'));
jest.mock('@/components/evals3/RunInspectorPage', () => stub('evals3-run-inspector'));
jest.mock('@/components/evals3/NewRunPage', () => stub('evals3-new-run'));
jest.mock('@/lib/constants', () => ({ refreshConfig: jest.fn(), subscribeConfigChange: jest.fn(() => () => {}), DEFAULT_CONFIG: { agents: [], models: {} } }));
jest.mock('@/lib/theme', () => ({ initializeTheme: jest.fn() }));

const getReportById = jest.fn();
const getBenchmarkById = jest.fn();
const getEvaluationRun = jest.fn();
jest.mock('@/services/storage', () => ({
  asyncRunStorage: { getReportById: (...args: unknown[]) => getReportById(...args) },
  asyncBenchmarkStorage: { getById: (...args: unknown[]) => getBenchmarkById(...args) },
}));
jest.mock('@/services/client', () => ({
  getEvaluationRun: (...args: unknown[]) => getEvaluationRun(...args),
}));

import { AppRoutes } from '../../App';

function mount(url: string) {
  return render(
    React.createElement(MemoryRouter, { initialEntries: [url] }, React.createElement(AppRoutes)),
  );
}

async function landsOn(url: string, page: string, finalUrl: string) {
  mount(url);
  const el = await screen.findByTestId(`page-${page}`);
  expect(el.textContent).toBe(finalUrl);
}

describe('App routes — retired legacy URLs redirect to their evals3 twin', () => {
  beforeEach(() => getReportById.mockReset());

  it.each([
    ['/benchmarks', 'evals3-benchmarks', '/evaluations/benchmarks'],
    ['/benchmarks/bm-1/runs', 'evals3-benchmark-runs', '/evaluations/benchmarks/bm-1/runs'],
    ['/benchmarks/bm-1/runs/run-1', 'evals3-run-inspector', '/evaluations/benchmarks/bm-1/runs/run-1/inspect'],
    ['/benchmarks/bm-1/runs/run-1?testCase=tc-1', 'evals3-run-inspector', '/evaluations/benchmarks/bm-1/runs/run-1/inspect?testCase=tc-1'],
    ['/benchmarks/bm-1/something/else', 'evals3-benchmarks', '/evaluations/benchmarks'],
    ['/test-cases', 'evals3-test-cases', '/evaluations/test-cases'],
    ['/test-cases/tc-1/runs', 'evals3-test-case-detail', '/evaluations/test-cases/tc-1'],
    ['/test-cases/tc-1/other', 'evals3-test-cases', '/evaluations/test-cases'],
    ['/evals', 'evals3-test-cases', '/evaluations/test-cases'],
    ['/run', 'evals3-test-cases', '/evaluations/test-cases'],
    ['/reports', 'evals3-benchmarks', '/evaluations/benchmarks'],
    ['/experiments', 'evals3-benchmarks', '/evaluations/benchmarks'],
    ['/experiments/bm-1/runs', 'evals3-benchmark-runs', '/evaluations/benchmarks/bm-1/runs'],
    ['/evaluations/runs/run-1', 'evals3-run-inspector', '/evaluations/runs/run-1/inspect'],
    ['/evaluations/runs/run-1?reportId=rep-1', 'evals3-run-inspector', '/evaluations/runs/run-1/inspect?reportId=rep-1'],
    ['/evaluations/benchmarks/bm-1/runs/run-1', 'evals3-run-inspector', '/evaluations/benchmarks/bm-1/runs/run-1/inspect'],
  ])('%s → %s at %s', async (from, page, to) => {
    await landsOn(from, page, to);
  });

  it('keeps the live routes mounted (no accidental redirect)', async () => {
    await landsOn('/evaluations/runs', 'evals3-eval-runs', '/evaluations/runs');
    await landsOn('/evaluations/runs/new', 'evals3-new-run', '/evaluations/runs/new');
    await landsOn('/evaluations/runs/run-9/inspect', 'evals3-run-inspector', '/evaluations/runs/run-9/inspect');
    await landsOn('/evaluations/test-cases/tc-9', 'evals3-test-case-detail', '/evaluations/test-cases/tc-9');
    await landsOn('/compare/bm-1?runs=a,b', 'compare', '/compare/bm-1?runs=a,b');
    await landsOn('/agent-traces', 'agent-traces', '/agent-traces');
    await landsOn('/', 'dashboard', '/');
  });

  it('unknown URLs fall back to the dashboard', async () => {
    await landsOn('/definitely/not/a/route', 'dashboard', '/');
  });
});

describe('App routes — /runs/:reportId resolves the report before redirecting', () => {
  beforeEach(() => {
    getReportById.mockReset();
    getBenchmarkById.mockReset();
    getEvaluationRun.mockReset();
    getEvaluationRun.mockResolvedValue({ id: 'run' });
  });

  it('report of a benchmark run → benchmark-scoped inspector with ?reportId', async () => {
    getReportById.mockResolvedValue({ id: 'rep-1', testCaseId: 'tc-1', experimentId: 'bm-1', experimentRunId: 'run-1' });
    await landsOn('/runs/rep-1', 'evals3-run-inspector', '/evaluations/benchmarks/bm-1/runs/run-1/inspect?reportId=rep-1');
    expect(getReportById).toHaveBeenCalledWith('rep-1');
    expect(getEvaluationRun).toHaveBeenCalledWith('run-1');
  });

  it('report of an ad-hoc evaluation run → bare inspector with ?reportId', async () => {
    getReportById.mockResolvedValue({ id: 'rep-2', testCaseId: 'tc-1', experimentRunId: 'run-2' });
    await landsOn('/runs/rep-2', 'evals3-run-inspector', '/evaluations/runs/run-2/inspect?reportId=rep-2');
  });

  it('report of a classic embedded benchmark run (no evaluation-run doc, listed in benchmark.runs[]) → benchmark-scoped inspector', async () => {
    getReportById.mockResolvedValue({ id: 'rep-5', testCaseId: 'tc-1', experimentId: 'bm-1', experimentRunId: 'run-legacy' });
    getEvaluationRun.mockRejectedValue(Object.assign(new Error('404'), { status: 404 }));
    getBenchmarkById.mockResolvedValue({ id: 'bm-1', runs: [{ id: 'run-legacy' }] });
    await landsOn('/runs/rep-5', 'evals3-run-inspector', '/evaluations/benchmarks/bm-1/runs/run-legacy/inspect?reportId=rep-5');
  });

  it('report whose run was deleted (no doc, not in benchmark.runs[]) → the test case detail page, not a "not found" inspector', async () => {
    getReportById.mockResolvedValue({ id: 'rep-6', testCaseId: 'tc-6', experimentId: 'bm-1', experimentRunId: 'run-gone' });
    getEvaluationRun.mockRejectedValue(Object.assign(new Error('404'), { status: 404 }));
    getBenchmarkById.mockResolvedValue({ id: 'bm-1', runs: [] });
    await landsOn('/runs/rep-6', 'evals3-test-case-detail', '/evaluations/test-cases/tc-6?run=rep-6');
  });

  it('carries the legacy query string over (destination keys win)', async () => {
    getReportById.mockResolvedValue({ id: 'rep-7', testCaseId: 'tc-1', experimentRunId: 'run-7' });
    await landsOn('/runs/rep-7?tab=traces', 'evals3-run-inspector', '/evaluations/runs/run-7/inspect?reportId=rep-7&tab=traces');
  });

  it('standalone single-case report → test case detail with ?run', async () => {
    getReportById.mockResolvedValue({ id: 'rep-3', testCaseId: 'tc-3' });
    await landsOn('/runs/rep-3', 'evals3-test-case-detail', '/evaluations/test-cases/tc-3?run=rep-3');
  });

  it('unknown report → evaluation runs list (not a blank page, not the dashboard)', async () => {
    getReportById.mockResolvedValue(null);
    await landsOn('/runs/missing', 'evals3-eval-runs', '/evaluations/runs');
  });

  it('shows a placeholder while resolving and an error if the lookup fails', async () => {
    let reject: (e: Error) => void = () => {};
    getReportById.mockReturnValue(new Promise((_r, rj) => { reject = rj; }));
    mount('/runs/rep-4');
    expect(screen.getByTestId('report-redirect')).toBeTruthy();
    reject(new Error('boom'));
    await waitFor(() => expect(screen.getByTestId('report-redirect-error').textContent).toContain('boom'));
  });
});
