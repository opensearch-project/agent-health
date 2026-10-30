/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Client-side retry-judgement job store + React bindings: POST → 202
 * registers a running job, the poll loop drives progress → completion,
 * subscribers (pill, dialog, toaster) see every transition, the toast is
 * dismissable, refused POSTs register nothing, and a page reload adopts a
 * server-side job that is still running.
 */

import * as React from 'react';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  startRetryJudgementJob,
  getRetryJudgementJob,
  listRetryJudgementJobs,
  subscribeRetryJudgementJobs,
  dismissRetryJudgementJob,
  adoptRetryJudgementJob,
  RETRY_JUDGEMENT_JOB_POLL_MS,
  __resetRetryJudgementJobsForTests,
} from '@/services/client/retryJudgementJobs';
import { useOnRetryJudgementFinished } from '@/hooks/useRetryJudgementJob';
import { RetryJudgementJobPill, RetryJudgementToaster, formatRetryJudgementSummary } from '@/components/evals3/RetryJudgementJobs';

const fetchMock = jest.fn();
(global as any).fetch = fetchMock;

const json = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: String(status),
  json: async () => body,
});

const summary = {
  retried: 3, succeeded: 2, failed: 0, notEvaluable: 1, abstain: 1,
  results: [
    { testCaseId: 'a', reportId: 'r-a', outcome: 'succeeded', passFailStatus: 'passed' },
    { testCaseId: 'b', reportId: 'r-b', outcome: 'succeeded', passFailStatus: 'passed', abstain: true },
    { testCaseId: 'c', reportId: 'r-c', outcome: 'not-evaluable', passFailStatus: null, reason: 'no gold ids on the test case (no expected.ids, no line matching the gold pattern, no explicit NONE line)' },
  ],
};

beforeEach(() => {
  jest.useFakeTimers();
  fetchMock.mockReset();
  __resetRetryJudgementJobsForTests();
});
afterEach(() => { jest.useRealTimers(); });

const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
const tick = async (ms = RETRY_JUDGEMENT_JOB_POLL_MS) => { await act(async () => { jest.advanceTimersByTime(ms); }); await flush(); await flush(); };

describe('retryJudgementJobs store', () => {
  it('POST 202 → running job; polls status → progress → completed with the summary; listeners fire on each change', async () => {
    fetchMock
      .mockResolvedValueOnce(json(202, { jobId: 'run-1', status: 'running', total: 3 }))
      .mockResolvedValueOnce(json(200, { status: 'running', total: 3, completed: 1 }))
      .mockResolvedValueOnce(json(200, { status: 'running', total: 3, completed: 2 }))
      .mockResolvedValueOnce(json(200, { status: 'completed', total: 3, completed: 3, summary }));
    const seen: string[] = [];
    subscribeRetryJudgementJobs(() => { const j = getRetryJudgementJob('run-1'); seen.push(j ? `${j.status}:${j.completed}/${j.total}` : 'gone'); });

    const job = await startRetryJudgementJob('run-1', { scope: 'all', evaluatorId: 'eval-x' }, 'My run');
    expect(job).toMatchObject({ runId: 'run-1', status: 'running', total: 3, completed: 0, label: 'My run', request: { scope: 'all', evaluatorId: 'eval-x' } });
    // The POST carried the request body AND the legacy ?scope= query.
    expect(fetchMock.mock.calls[0][0]).toBe('/api/storage/evaluation-runs/run-1/retry-judgement?scope=all');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ scope: 'all', evaluatorId: 'eval-x' });
    // Resolved on the 202 — no poll has happened yet.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await tick();
    expect(getRetryJudgementJob('run-1')).toMatchObject({ status: 'running', completed: 1 });
    await tick();
    expect(getRetryJudgementJob('run-1')).toMatchObject({ status: 'running', completed: 2 });
    await tick();
    const done = getRetryJudgementJob('run-1')!;
    expect(done).toMatchObject({ status: 'completed', completed: 3, total: 3, summary });
    expect(done.finishedAt).toBeDefined();
    expect(fetchMock.mock.calls.slice(1).every(c => c[0] === '/api/storage/evaluation-runs/run-1/retry-judgement/status')).toBe(true);
    expect(seen).toEqual(['running:0/3', 'running:1/3', 'running:2/3', 'completed:3/3']);
    // No further polling after a terminal state.
    await tick();
    expect(fetchMock).toHaveBeenCalledTimes(4);

    // Finished jobs stay until dismissed (the toast), then vanish.
    expect(listRetryJudgementJobs()).toHaveLength(1);
    dismissRetryJudgementJob('run-1');
    expect(listRetryJudgementJobs()).toHaveLength(0);
    expect(seen.at(-1)).toBe('gone');
  });

  it('a failed job carries the server error; a lost job (404 on status) stops polling with an explicit error', async () => {
    fetchMock
      .mockResolvedValueOnce(json(202, { total: 1 }))
      .mockResolvedValueOnce(json(200, { status: 'failed', total: 1, completed: 0, error: 'a deterministic evaluator re-scores the whole run; use scope all' }));
    await startRetryJudgementJob('run-f');
    await tick();
    expect(getRetryJudgementJob('run-f')).toMatchObject({ status: 'failed', error: expect.stringMatching(/use scope all/) });

    fetchMock
      .mockResolvedValueOnce(json(202, { total: 1 }))
      .mockResolvedValueOnce(json(404, { error: 'No retry-judgement job found for this run' }));
    await startRetryJudgementJob('run-lost');
    await tick();
    expect(getRetryJudgementJob('run-lost')).toMatchObject({ status: 'failed', error: expect.stringMatching(/lost track/) });
    // A transient error keeps polling.
    fetchMock
      .mockResolvedValueOnce(json(202, { total: 1 }))
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(json(200, { status: 'completed', total: 1, completed: 1, summary: { ...summary, retried: 1 } }));
    await startRetryJudgementJob('run-t');
    await tick();
    expect(getRetryJudgementJob('run-t')!.status).toBe('running');
    await tick();
    expect(getRetryJudgementJob('run-t')!.status).toBe('completed');
  });

  it('a refused POST (409 / 400) rejects and registers NO job; a running job is not started twice', async () => {
    fetchMock.mockResolvedValueOnce(json(409, { error: 'Retry judgement is already in progress for this run' }));
    await expect(startRetryJudgementJob('run-409')).rejects.toThrow(/already in progress/);
    expect(getRetryJudgementJob('run-409')).toBeUndefined();

    fetchMock.mockResolvedValueOnce(json(202, { total: 2 }));
    const first = await startRetryJudgementJob('run-once');
    const again = await startRetryJudgementJob('run-once');
    expect(again).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(2); // one POST, no second POST
  });

  it('adoptRetryJudgementJob picks up a server-side job still running after a page reload (and ignores 404 / finished)', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { status: 'running', total: 5, completed: 2 }));
    const adopted = await adoptRetryJudgementJob('run-reload', 'Reloaded run');
    expect(adopted).toMatchObject({ runId: 'run-reload', status: 'running', total: 5, completed: 2, label: 'Reloaded run' });
    fetchMock.mockResolvedValueOnce(json(200, { status: 'completed', total: 5, completed: 5, summary }));
    await tick();
    expect(getRetryJudgementJob('run-reload')!.status).toBe('completed');

    fetchMock.mockResolvedValueOnce(json(404, { error: 'No retry-judgement job found for this run' }));
    expect(await adoptRetryJudgementJob('run-none')).toBeUndefined();
    fetchMock.mockResolvedValueOnce(json(200, { status: 'completed', total: 1, completed: 1, summary }));
    expect(await adoptRetryJudgementJob('run-old')).toBeUndefined(); // already finished server-side: nothing to show
  });
});

describe('React bindings: pill, finished-callback, toaster', () => {
  const Harness: React.FC<{ onFinished: (id: string) => void }> = ({ onFinished }) => {
    useOnRetryJudgementFinished(job => onFinished(job.runId));
    return React.createElement(
      MemoryRouter,
      null,
      React.createElement(RetryJudgementJobPill, { runId: 'run-ui', runName: 'UI run' }),
      React.createElement(RetryJudgementToaster),
    );
  };

  it('pill shows "Re-judging n/N…" while running, disappears when done; the finished callback fires once; the toast shows the summary and dismisses', async () => {
    // The pill's mount-time adopt() asks the status endpoint once (404 = no job).
    fetchMock.mockResolvedValueOnce(json(404, { error: 'No retry-judgement job found for this run' }));
    const onFinished = jest.fn();
    render(React.createElement(Harness, { onFinished }));
    await flush();
    expect(screen.queryByTestId('retry-judgement-pill-run-ui')).toBeNull();

    fetchMock
      .mockResolvedValueOnce(json(202, { total: 3 }))
      .mockResolvedValueOnce(json(200, { status: 'running', total: 3, completed: 2 }))
      .mockResolvedValueOnce(json(200, { status: 'completed', total: 3, completed: 3, summary }));
    await act(async () => { await startRetryJudgementJob('run-ui', { scope: 'errored' }, 'UI run'); });
    expect(screen.getByTestId('retry-judgement-pill-run-ui').textContent!.trim()).toBe('Re-judging 0/3…');
    await tick();
    expect(screen.getByTestId('retry-judgement-pill-run-ui').textContent!.trim()).toBe('Re-judging 2/3…');
    expect(onFinished).not.toHaveBeenCalled();
    await tick();
    expect(screen.queryByTestId('retry-judgement-pill-run-ui')).toBeNull();
    expect(onFinished).toHaveBeenCalledTimes(1);
    expect(onFinished).toHaveBeenCalledWith('run-ui');

    const toast = screen.getByTestId('retry-judgement-toast-run-ui');
    expect(toast.textContent).toContain('Retry judgement finished — UI run');
    expect(screen.getByTestId('retry-judgement-toast-summary-run-ui').textContent).toBe('Retried 3 · 2 scored (1 abstain) · 1 not evaluable');
    expect(toast.textContent).toContain("gold/extraction rules don't match these cases");
    expect(toast.querySelector('a')!.getAttribute('href')).toBe('/evaluations/runs/run-ui');

    fireEvent.click(screen.getByTestId('retry-judgement-toast-dismiss-run-ui'));
    expect(screen.queryByTestId('retry-judgement-toast-run-ui')).toBeNull();
    // Re-render does not re-announce the same finished job.
    await tick();
    expect(onFinished).toHaveBeenCalledTimes(1);
  });

  it('a failed job toasts the error in red wording', async () => {
    fetchMock.mockResolvedValueOnce(json(404, {}));
    render(React.createElement(Harness, { onFinished: () => {} }));
    await flush();
    fetchMock
      .mockResolvedValueOnce(json(202, { total: 1 }))
      .mockResolvedValueOnce(json(200, { status: 'failed', total: 1, completed: 0, error: 'judge exploded' }));
    await act(async () => { await startRetryJudgementJob('run-ui'); });
    await tick();
    expect(screen.getByTestId('retry-judgement-toast-run-ui').textContent).toContain('Retry judgement failed — run-ui');
    expect(screen.getByTestId('retry-judgement-toast-summary-run-ui').textContent).toBe('judge exploded');
  });
});

describe('formatRetryJudgementSummary', () => {
  it('never says "still failed" for a not-evaluable case; abstain and failed counts are appended when present', () => {
    expect(formatRetryJudgementSummary({ retried: 3, succeeded: 0, failed: 0, notEvaluable: 3, results: [] })).toBe('Retried 3 · 0 scored · 3 not evaluable');
    expect(formatRetryJudgementSummary({ retried: 2, succeeded: 2, failed: 0, results: [] })).toBe('Retried 2 · 2 scored');
    expect(formatRetryJudgementSummary({ retried: 4, succeeded: 2, failed: 1, notEvaluable: 1, abstain: 1, results: [] })).toBe('Retried 4 · 2 scored (1 abstain) · 1 not evaluable · 1 failed');
    // Older servers without the counts: derived from the per-case outcomes.
    expect(formatRetryJudgementSummary({ retried: 1, succeeded: 0, failed: 0, results: [{ testCaseId: 'x', reportId: 'r', outcome: 'not-evaluable' }] })).toBe('Retried 1 · 0 scored · 1 not evaluable');
  });
});
