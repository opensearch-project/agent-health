/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 *
 * @jest-environment jsdom
 */

/**
 * Regression tests for the "Traces tab never loads" bug (owner repro: the
 * internal-benchmark-example benchmark's REST-connector runs, which carry no
 * runId/traceId/sessionId on their reports at all).
 *
 * Root cause: `runInfos` filtered OUT any run whose report had no
 * `report.runId`, and `fetchAllTraces()` bailed out early
 * (`if (runInfos.length === 0) return;`) WITHOUT ever calling
 * `setIsLoading`/`setTraceData` — so when every selected run lacked a runId,
 * the component was permanently stuck rendering the loading spinner
 * (`data-testid="trace-flow-loading"`), with zero network activity, forever.
 *
 * Fix: every run always gets a `traceData` entry; a run+case with NO
 * correlator of any kind (no runId, no traceId, no session.id, no Strategy-C
 * window) resolves immediately to zero spans instead of hanging — the
 * component's own "no traces found" terminal empty state
 * (`data-testid="trace-flow-empty"`) takes over, exactly as it would for a
 * run that legitimately queried and found nothing.
 *
 * (React.createElement, not JSX — jest's testMatch only picks up
 * `*.test.ts`, and plain .ts files cannot contain JSX syntax; matches the
 * established pattern in ComparisonScoreboard.test.ts.)
 */

import * as React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { TraceFlowComparison } from '@/components/comparison/sections/TraceFlowComparison';
import type { BenchmarkRun, EvaluationReport } from '@/types';

jest.mock('@/services/traces', () => {
  const actual = jest.requireActual('@/services/traces');
  return {
    ...actual,
    fetchTracesForRun: jest.fn(),
  };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { fetchTracesForRun } = require('@/services/traces');

const TC = 'tc-rest-agent-1';

function makeRun(id: string, name: string): BenchmarkRun {
  return {
    id,
    name,
    createdAt: new Date().toISOString(),
    agentKey: 'internal-rest-agent-example',
    modelId: 'gpt-4',
    results: { [TC]: { reportId: `rep-${id}`, status: 'completed', passFailStatus: 'passed' } },
  } as unknown as BenchmarkRun;
}

/** A REST-connector report: no runId, no traceId, no sessionId anywhere. */
function makeUntraceableReport(id: string): EvaluationReport {
  return {
    id,
    testCaseId: TC,
    connectorProtocol: 'rest',
    status: 'completed',
    trajectory: [],
  } as unknown as EvaluationReport;
}

describe('TraceFlowComparison — no correlator on either side (REST agent, no OTel)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('resolves promptly to the "no traces" empty state, never issuing a network call it cannot succeed at (regression: used to hang on the loading spinner forever)', async () => {
    const runA = makeRun('run-a', 'stark-retail — mock run 1 (subset ingest)');
    const runB = makeRun('run-b', 'stark-retail smoke (6 tests, subset ingest)');
    const reports = {
      'rep-run-a': makeUntraceableReport('rep-run-a'),
      'rep-run-b': makeUntraceableReport('rep-run-b'),
    };

    render(
      React.createElement(TraceFlowComparison, { runs: [runA, runB], reports, useCaseId: TC })
    );

    // Never issues a doomed-to-fail /api/traces call for a run with zero
    // correlators — this is the whole point of the fix (fail-fast honesty,
    // not an indefinite pending fetch).
    await waitFor(() => {
      expect(screen.getByTestId('trace-flow-empty')).toBeTruthy();
    });
    expect(fetchTracesForRun).not.toHaveBeenCalled();
    expect(screen.queryByTestId('trace-flow-loading')).toBeNull();
  });

  it('still shows the loading spinner WHILE a genuinely traceable run is being queried (not stuck permanently)', async () => {
    const runA = makeRun('run-a', 'A');
    const runB = makeRun('run-b', 'B');
    const reports = {
      'rep-run-a': { ...makeUntraceableReport('rep-run-a'), runId: 'agent-run-a' } as unknown as EvaluationReport,
      'rep-run-b': makeUntraceableReport('rep-run-b'),
    };

    let resolveFetch: (v: unknown) => void = () => {};
    (fetchTracesForRun as jest.Mock).mockImplementation(
      () => new Promise((resolve) => { resolveFetch = resolve; })
    );

    render(
      React.createElement(TraceFlowComparison, { runs: [runA, runB], reports, useCaseId: TC })
    );

    // While run A's fetch is in flight, the component is legitimately loading.
    expect(await screen.findByTestId('trace-flow-loading')).toBeTruthy();

    resolveFetch({ spans: [], total: 0 });

    // Once both sides resolve (A: fetched empty, B: no correlator at all), it
    // reaches the terminal empty state — not stuck loading forever.
    await waitFor(() => {
      expect(screen.getByTestId('trace-flow-empty')).toBeTruthy();
    });
    expect(fetchTracesForRun).toHaveBeenCalledTimes(1);
    expect(fetchTracesForRun).toHaveBeenCalledWith(expect.objectContaining({ runId: 'agent-run-a' }));
  });

  it('surfaces a retryable error state (not a hang) when the trace query itself fails/times out', async () => {
    const runA = makeRun('run-a', 'A');
    const runB = makeRun('run-b', 'B');
    const reports = {
      'rep-run-a': { ...makeUntraceableReport('rep-run-a'), runId: 'agent-run-a' } as unknown as EvaluationReport,
      'rep-run-b': { ...makeUntraceableReport('rep-run-b'), runId: 'agent-run-b' } as unknown as EvaluationReport,
    };
    (fetchTracesForRun as jest.Mock).mockRejectedValue(new Error('Traces request timed out after 20s'));

    render(
      React.createElement(TraceFlowComparison, { runs: [runA, runB], reports, useCaseId: TC })
    );

    await waitFor(() => {
      expect(screen.getByText('Failed to load traces')).toBeTruthy();
    });
    expect(screen.getAllByText(/timed out after 20s/).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
  });
});
