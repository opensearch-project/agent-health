/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * "Last re-judgement failed" surfaces: the Judge-tab banner + Details dialog
 * (reason, outcome, diagnostics, Retry again) and the run-level "re-judge
 * failed" pill; dismissal is UI-only per browser and a NEWER attempt shows
 * again.
 */

import * as React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LastRetryAttemptBanner, dismissRetryAttempt } from '@/components/evals3/LastRetryAttemptBanner';
import { RetryJudgementJobPill, describeRunRetryAttempt } from '@/components/evals3/RetryJudgementJobs';
import { __resetRetryJudgementJobsForTests } from '@/services/client/retryJudgementJobs';
import type { RetryAttemptRecord, RunRetryAttemptSummary } from '@/types';

const fetchMock = jest.fn(async () => ({ ok: false, status: 404, statusText: '404', json: async () => ({ error: 'No retry-judgement job found for this run' }) }));
(global as any).fetch = fetchMock;

const attempt: RetryAttemptRecord = {
  at: new Date(Date.now() - 3 * 60_000).toISOString(),
  evaluatorId: 'eval-x', evaluatorName: 'Ranked products', scope: 'all', outcome: 'not-evaluable',
  reason: 'no gold ids on the test case (no expected.ids, no line matching the gold pattern, no explicit NONE line)',
  diagnostics: {
    gold: { source: 'not declared', ids: [], explicitlyEmpty: false },
    candidates: { sourceTried: [{ source: 'tool-hits', count: 1, detail: "tool 'search' hits (hits / results)" }], sourceUsed: 'tool-hits', count: 1, anchorRemoved: 0, returned: false, weak: false },
    toolsScanned: ['search'],
  },
};

beforeEach(() => { window.localStorage.clear(); __resetRetryJudgementJobsForTests(); });

describe('LastRetryAttemptBanner', () => {
  it('renders the reason, opens the Details dialog with outcome + diagnostics, and "Retry again" calls back', () => {
    const onRetry = jest.fn();
    render(React.createElement(LastRetryAttemptBanner, { reportId: 'rep-1', attempt, onRetryJudgement: onRetry }));
    const banner = screen.getByTestId('last-retry-attempt-banner');
    expect(banner.textContent).toContain('Last re-judgement failed');
    expect(banner.textContent).toContain('Ranked products');
    expect(screen.getByTestId('last-retry-attempt-reason').textContent).toBe(attempt.reason);
    expect(banner.textContent).toContain('the previous judgement below is unchanged');
    expect(banner.className).toMatch(/amber/);

    fireEvent.click(screen.getByTestId('last-retry-attempt-details-btn'));
    expect(screen.getByTestId('last-retry-attempt-dialog')).toBeTruthy();
    expect(screen.getByTestId('last-retry-attempt-outcome').textContent).toBe('not evaluable');
    expect(screen.getByTestId('last-retry-attempt-dialog-reason').textContent).toBe(attempt.reason);
    expect(screen.getByTestId('last-retry-attempt-diagnostics').textContent).toContain("1 from tool 'search' hits");
    expect(screen.getByTestId('last-retry-attempt-diagnostics').textContent).toContain('gold not declared');
    fireEvent.click(screen.getByTestId('last-retry-attempt-retry-again'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('hides "Retry again" when the host cannot open the retry dialog; dismiss is per attempt and a newer attempt shows again', () => {
    const { rerender } = render(React.createElement(LastRetryAttemptBanner, { reportId: 'rep-2', attempt }));
    fireEvent.click(screen.getByTestId('last-retry-attempt-details-btn'));
    expect(screen.queryByTestId('last-retry-attempt-retry-again')).toBeNull();
    fireEvent.click(screen.getByTestId('last-retry-attempt-dialog-dismiss'));
    expect(screen.queryByTestId('last-retry-attempt-banner')).toBeNull();
    // Same attempt stays dismissed across renders…
    rerender(React.createElement(LastRetryAttemptBanner, { reportId: 'rep-2', attempt }));
    expect(screen.queryByTestId('last-retry-attempt-banner')).toBeNull();
    // …a newer one is shown.
    rerender(React.createElement(LastRetryAttemptBanner, { reportId: 'rep-2', attempt: { ...attempt, at: new Date().toISOString(), outcome: 'judge-error', reason: 'Bedrock 400' } }));
    expect(screen.getByTestId('last-retry-attempt-reason').textContent).toBe('Bedrock 400');
    fireEvent.click(screen.getByTestId('last-retry-attempt-dismiss'));
    expect(screen.queryByTestId('last-retry-attempt-banner')).toBeNull();
  });
});

describe('RetryJudgementJobPill — "re-judge failed" state', () => {
  const summary: RunRetryAttemptSummary = {
    at: new Date(Date.now() - 60_000).toISOString(), evaluatorId: 'eval-x', evaluatorName: 'Ranked products', scope: 'all',
    retried: 3, succeeded: 1, notEvaluable: 2, failed: 0, reasons: { 'no gold ids on the test case (…)': 2 },
  };

  it('shows the failed pill (with the summary on hover) when no job runs and the run carries a lastRetryAttempt; dismiss hides it; null hides it', async () => {
    const { rerender } = render(React.createElement(MemoryRouter, null, React.createElement(RetryJudgementJobPill, { runId: 'run-p', lastRetryAttempt: summary })));
    await screen.findByTestId('retry-judgement-failed-pill-run-p');
    const pill = screen.getByTestId('retry-judgement-failed-pill-run-p');
    expect(pill.textContent).toContain('re-judge failed');
    expect(pill.getAttribute('title')).toBe(describeRunRetryAttempt(summary));
    expect(pill.getAttribute('title')).toContain('1 of 3 judged, 2 not evaluable — no gold ids on the test case (…) (×2). The previous judgements were preserved.');
    fireEvent.click(screen.getByTestId('retry-judgement-failed-pill-dismiss-run-p'));
    expect(screen.queryByTestId('retry-judgement-failed-pill-run-p')).toBeNull();
    // A successful retry clears the record server-side → nothing to show.
    dismissRetryAttempt('run-q', 'x'); // unrelated key must not matter
    rerender(React.createElement(MemoryRouter, null, React.createElement(RetryJudgementJobPill, { runId: 'run-p', lastRetryAttempt: null })));
    expect(screen.queryByTestId('retry-judgement-failed-pill-run-p')).toBeNull();
  });
});
