/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * RetryJudgementConfirmDialog — the evaluator / judge-model / scope picker
 * behind the kebab's "Retry judgement" (owner follow-up to #468: "the
 * judgement should allow for evaluator type and prompt evaluator when
 * retrying; defaults will be the last selected ones"), fused with the
 * background-job + pre-flight behaviour:
 *
 *  - seedRetryJudgementDefaults: lastJudgementRetry > run values > built-in
 *    default; scope defaults to 'errored' iff there are judge-failed cases
 *  - the dialog preselects those defaults and lists GET /evaluators
 *  - the "Only judge-failed cases" radio is disabled at N=0 (All preselected)
 *  - every evaluator / scope change pre-flights the retry; a deterministic
 *    evaluator that can score nothing disables Confirm and lists the grouped
 *    reasons + per-case diagnostics; a deterministic evaluator forces scope
 *    'all' (radio locked, request says 'all')
 *  - Confirm POSTs { scope, evaluatorId, judgeModelId } (''→null) through
 *    the client job store, resolves on the 202, the dialog can be closed while
 *    the job runs (no cancel), re-open shows live progress, completion shows
 *    "Retried n · x scored · y not evaluable" with reasons (amber, never
 *    "still failed"); Done reports back
 */

import * as React from 'react';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

jest.mock('@/lib/config', () => ({ ENV_CONFIG: { backendUrl: '' } }));

jest.mock('@/components/JudgeModelSelect', () => ({
  JudgeModelSelect: ({ value, onValueChange }: any) =>
    React.createElement('input', {
      'data-testid': 'retry-judge-model',
      value,
      onChange: (e: any) => onValueChange(e.target.value),
    }),
}));

// Same native-<select> stand-in as RunConfigDialog.test.ts (Radix Select
// needs real pointer events + portals to open in jsdom).
jest.mock('@/components/ui/select', () => {
  const R = require('react');
  const Ctx = R.createContext<any>(null);
  const flatten = (children: any): any[] => {
    const out: any[] = [];
    R.Children.forEach(children, (c: any) => {
      if (!c) return;
      if (c.type === R.Fragment) out.push(...flatten(c.props.children));
      else out.push(c);
    });
    return out;
  };
  return {
    Select: ({ value, onValueChange, children }: any) =>
      R.createElement(Ctx.Provider, { value: { value, onValueChange } }, R.createElement('div', null, children)),
    SelectTrigger: ({ children, ...props }: any) => {
      const ctx = R.useContext(Ctx);
      return R.createElement('div', { ...props, 'data-value': ctx.value }, children);
    },
    SelectValue: () => null,
    SelectContent: ({ children }: any) => {
      const ctx = R.useContext(Ctx);
      const items = flatten(children).filter((c: any) => c && c.props && 'value' in c.props);
      return R.createElement(
        'select',
        { 'data-testid': 'select-native', value: ctx.value ?? '', onChange: (e: any) => ctx.onValueChange(e.target.value) },
        items.map((c: any) => R.createElement('option', {
          key: c.props.value, value: c.props.value, disabled: c.props.disabled, 'data-testid': c.props['data-testid'],
        }, c.props.children)),
      );
    },
    SelectItem: () => null,
  };
});

jest.mock('@/components/ui/dialog', () => {
  const R = require('react');
  return {
    Dialog: ({ open, children }: any) => (open ? R.createElement('div', null, children) : null),
    DialogContent: ({ children, ...props }: any) => R.createElement('div', props, children),
    DialogHeader: ({ children }: any) => R.createElement('div', null, children),
    DialogTitle: ({ children }: any) => R.createElement('h2', null, children),
    DialogDescription: ({ children }: any) => R.createElement('p', null, children),
    DialogFooter: ({ children }: any) => R.createElement('div', null, children),
  };
});

import {
  RetryJudgementConfirmDialog, seedRetryJudgementDefaults, selectionToRequest, DEFAULT_EVALUATOR_ID,
} from '@/components/evals3/RetryJudgementConfirmDialog';
import { __resetRetryJudgementJobsForTests, getRetryJudgementJob, RETRY_JUDGEMENT_JOB_POLL_MS } from '@/services/client/retryJudgementJobs';
import type { EvaluationRun } from '@/types';

const EVALUATORS = [
  { id: 'system-rca-default', name: 'RCA Default', isSystem: true },
  { id: 'system-factuality', name: 'Factuality', isSystem: true },
  { id: 'custom-1', name: 'Custom Eval' },
  { id: 'eval-det', name: 'Ranked retrieval', kind: 'deterministic' },
];

const baseRun = {
  id: 'eval-run-1', docType: 'evaluation-run', name: 'Nightly', status: 'completed',
  agentKey: 'demo', modelId: 'demo-model', judgeModelId: 'run-model', evaluatorId: 'custom-1',
  sources: [], trigger: 'ui', testCaseSnapshots: [], results: {}, createdAt: '2026-01-01T00:00:00.000Z',
} as unknown as EvaluationRun;

const NO_GOLD = 'no gold ids on the test case (no expected.ids, no line matching the gold pattern, no explicit NONE line)';
const NO_CANDIDATES = 'no candidate ids found in the final answer, a results tool or the stored tool results';
const diagnostics = {
  gold: { source: 'expectedOutcomes[0]', ids: ['428457'], explicitlyEmpty: false },
  candidates: {
    sourceTried: [
      { source: 'response-results', count: 0, detail: 'final response (no ranked list recognised)' },
      { source: 'tool-hits', count: 0, detail: "tool 'search' hits (hits / results)" },
    ],
    sourceUsed: 'none', count: 0, anchorRemoved: 0, returned: false, weak: false,
  },
  toolsScanned: ['search'],
};
const llmPreflight = (scope: string, total: number) => ({ evaluatorId: 'custom-1', evaluatorName: 'Custom Eval', deterministic: false, scope, total, evaluable: total, notEvaluable: 0, abstain: 0, reasons: {}, cases: [] });
const detNothing = {
  evaluatorId: 'eval-det', evaluatorName: 'Ranked retrieval', deterministic: true, scope: 'all', total: 3, evaluable: 0, notEvaluable: 3, abstain: 0,
  reasons: { [NO_GOLD]: 2, [NO_CANDIDATES]: 1 },
  cases: [
    { testCaseId: 'tc-1', evaluable: false, reason: NO_GOLD, diagnostics: { ...diagnostics, gold: { source: 'not declared', ids: [], explicitlyEmpty: false } } },
    { testCaseId: 'tc-2', evaluable: false, reason: NO_GOLD, diagnostics: { ...diagnostics, gold: { source: 'not declared', ids: [], explicitlyEmpty: false } } },
    { testCaseId: 'tc-3', evaluable: false, reason: NO_CANDIDATES, diagnostics },
  ],
};
const detSome = { ...detNothing, evaluable: 2, notEvaluable: 1, abstain: 1, reasons: { [NO_CANDIDATES]: 1 }, cases: [{ testCaseId: 'tc-1', evaluable: true }, { testCaseId: 'tc-2', evaluable: true, abstain: true }, detNothing.cases[2]] };

/**
 * fetch stand-in routed by URL: evaluators list, retry-judgement status
 * (404 until a job exists), pre-flight (per-evaluator table), POST (202).
 */
const json = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, statusText: String(status), json: async () => body });
let preflightByEvaluator: Record<string, unknown>;
let postResponses: Array<ReturnType<typeof json>>;
let statusResponses: Array<ReturnType<typeof json>>;
let calls: Array<{ url: string; body?: any }>;
const defaultFetch = async (url: string, init?: any) => {
  const body = init?.body ? JSON.parse(init.body) : undefined;
  calls.push({ url, body });
  if (url.endsWith('/api/storage/evaluators')) return json(200, { evaluators: EVALUATORS });
  if (url.endsWith('/retry-judgement/preflight')) {
    const p = preflightByEvaluator[body?.evaluatorId] ?? llmPreflight(body?.scope ?? 'errored', body?.scope === 'all' ? 3 : 1);
    return json(200, p);
  }
  if (url.endsWith('/retry-judgement/status')) return statusResponses.shift() ?? json(404, { error: 'No retry-judgement job found for this run' });
  if (url.includes('/retry-judgement?scope=')) return postResponses.shift() ?? json(202, { jobId: 'eval-run-1', status: 'running', total: 3 });
  throw new Error(`unexpected fetch ${url}`);
};
const fetchMock = jest.fn(defaultFetch);
(global as any).fetch = fetchMock;

const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }); };
const tick = async () => { await act(async () => { jest.advanceTimersByTime(RETRY_JUDGEMENT_JOB_POLL_MS); }); await flush(); await flush(); };
const postCalls = () => calls.filter(c => c.url.includes('/retry-judgement?scope='));
const preflightCalls = () => calls.filter(c => c.url.endsWith('/retry-judgement/preflight'));

beforeEach(() => {
  jest.useFakeTimers();
  __resetRetryJudgementJobsForTests();
  calls = [];
  preflightByEvaluator = { 'eval-det': detSome };
  postResponses = [];
  statusResponses = [];
  fetchMock.mockReset();
  fetchMock.mockImplementation(defaultFetch);
});
afterEach(() => { jest.useRealTimers(); });

describe('seedRetryJudgementDefaults', () => {
  it('uses the run\'s own evaluator / judge model when no retry happened yet', () => {
    expect(seedRetryJudgementDefaults(baseRun, 2)).toEqual({ evaluatorId: 'custom-1', judgeModelId: 'run-model', scope: 'errored' });
  });

  it('prefers lastJudgementRetry (the last selection) over the run\'s values', () => {
    const run = { ...baseRun, lastJudgementRetry: { evaluatorId: 'system-factuality', judgeModelId: 'picked', scope: 'all' as const, at: 'x' } };
    expect(seedRetryJudgementDefaults(run, 2)).toMatchObject({ evaluatorId: 'system-factuality', judgeModelId: 'picked' });
  });

  it('maps an explicit "default" (null) in lastJudgementRetry to the built-in evaluator / empty judge model — not back to the run\'s pinned values', () => {
    const run = { ...baseRun, lastJudgementRetry: { evaluatorId: null, judgeModelId: null, scope: 'all' as const, at: 'x' } };
    expect(seedRetryJudgementDefaults(run, 0)).toEqual({ evaluatorId: DEFAULT_EVALUATOR_ID, judgeModelId: '', scope: 'all' });
  });

  it('falls back to the built-in default evaluator / evaluator-default model for a run with neither set', () => {
    expect(seedRetryJudgementDefaults({ ...baseRun, evaluatorId: undefined, judgeModelId: undefined }, 1))
      .toEqual({ evaluatorId: DEFAULT_EVALUATOR_ID, judgeModelId: '', scope: 'errored' });
  });

  it('scope: "errored" iff there are judge-failed cases, else "all"', () => {
    expect(seedRetryJudgementDefaults(baseRun, 1).scope).toBe('errored');
    expect(seedRetryJudgementDefaults(baseRun, 0).scope).toBe('all');
  });

  it('selectionToRequest: "" judge model → null; a deterministic evaluator forces scope all', () => {
    expect(selectionToRequest({ evaluatorId: 'e', judgeModelId: '', scope: 'errored' }, false)).toEqual({ scope: 'errored', evaluatorId: 'e', judgeModelId: null });
    expect(selectionToRequest({ evaluatorId: 'e', judgeModelId: 'm', scope: 'errored' }, true)).toEqual({ scope: 'all', evaluatorId: 'e', judgeModelId: 'm' });
  });
});

describe('RetryJudgementConfirmDialog — picker', () => {
  const renderDialog = (props: Partial<React.ComponentProps<typeof RetryJudgementConfirmDialog>> = {}) => {
    const onComplete = jest.fn();
    const onOpenChange = jest.fn();
    const utils = render(React.createElement(MemoryRouter, null, React.createElement(RetryJudgementConfirmDialog, {
      run: baseRun, judgeFailedCount: 1, rejudgeableCount: 3, open: true, onOpenChange, onComplete, ...props,
    })));
    return { ...utils, onComplete, onOpenChange };
  };

  it('preselects the run\'s evaluator + judge model and the judge-failed scope, listing the fetched evaluators; pre-flights the selection', async () => {
    renderDialog();
    await waitFor(() => expect(screen.getByTestId('retry-judgement-evaluator-system-factuality')).toBeTruthy());
    expect(screen.getByTestId('select-native')).toHaveProperty('value', 'custom-1');
    expect((screen.getByTestId('retry-judge-model') as HTMLInputElement).value).toBe('run-model');
    expect((screen.getByTestId('retry-judgement-scope-errored') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId('retry-judgement-scope-errored').closest('label')!.textContent).toContain('(1)');
    expect(screen.getByTestId('retry-judgement-scope-all').closest('label')!.textContent).toContain('(3)');
    await waitFor(() => expect(screen.getByTestId('retry-judgement-count').textContent).toBe('1'));
    expect(preflightCalls().at(-1)!.body).toEqual({ scope: 'errored', evaluatorId: 'custom-1' });
    // An LLM evaluator: no evaluability banner.
    expect(screen.queryByTestId('retry-judgement-preflight')).toBeNull();
    expect((screen.getByTestId('retry-judgement-confirm-btn') as HTMLButtonElement).disabled).toBe(false);
  });

  it('preselects the LAST retry\'s evaluator / model when the run has one', async () => {
    renderDialog({ run: { ...baseRun, lastJudgementRetry: { evaluatorId: 'system-factuality', judgeModelId: 'picked', scope: 'all', at: 'x' } } });
    await waitFor(() => expect(screen.getByTestId('select-native')).toHaveProperty('value', 'system-factuality'));
    expect((screen.getByTestId('retry-judge-model') as HTMLInputElement).value).toBe('picked');
  });

  it('a parent refetch that swaps in a fresh run object (same id) does NOT wipe the user\'s in-progress selection', async () => {
    const { rerender } = renderDialog();
    await waitFor(() => expect(screen.getByTestId('retry-judgement-evaluator-system-factuality')).toBeTruthy());
    fireEvent.change(screen.getByTestId('select-native'), { target: { value: 'system-factuality' } });
    rerender(React.createElement(MemoryRouter, null, React.createElement(RetryJudgementConfirmDialog, {
      run: { ...baseRun, lastJudgementRetry: { evaluatorId: 'custom-1', judgeModelId: 'run-model', scope: 'all', at: 'later' } },
      judgeFailedCount: 1, rejudgeableCount: 3, open: true, onOpenChange: jest.fn(), onComplete: jest.fn(),
    })));
    expect(screen.getByTestId('select-native')).toHaveProperty('value', 'system-factuality');
  });

  it('with no judge-failed cases: "Only judge-failed" is disabled, "All cases" preselected, count = all', async () => {
    renderDialog({ judgeFailedCount: 0 });
    expect((screen.getByTestId('retry-judgement-scope-errored') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId('retry-judgement-scope-all') as HTMLInputElement).checked).toBe(true);
    await waitFor(() => expect((screen.getByTestId('retry-judgement-confirm-btn') as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByTestId('retry-judgement-count').textContent).toBe('3');
  });

  it('renders nothing without a run', () => {
    const { container } = renderDialog({ run: null });
    expect(container.innerHTML).toBe('');
  });
});

describe('RetryJudgementConfirmDialog — pre-flight', () => {
  const renderDialog = (props: Partial<React.ComponentProps<typeof RetryJudgementConfirmDialog>> = {}) =>
    render(React.createElement(MemoryRouter, null, React.createElement(RetryJudgementConfirmDialog, {
      run: baseRun, judgeFailedCount: 1, rejudgeableCount: 3, open: true, onOpenChange: jest.fn(), onComplete: jest.fn(), ...props,
    })));

  it('picking a deterministic evaluator that fits nothing: "0 of 3 cases evaluable", grouped reasons, per-case diagnostics, scope locked to all, Confirm DISABLED', async () => {
    preflightByEvaluator['eval-det'] = detNothing;
    renderDialog();
    await waitFor(() => expect(screen.getByTestId('retry-judgement-evaluator-eval-det')).toBeTruthy());
    fireEvent.change(screen.getByTestId('select-native'), { target: { value: 'eval-det' } });
    await waitFor(() => expect(screen.getByTestId('retry-judgement-preflight')).toBeTruthy());

    const pre = screen.getByTestId('retry-judgement-preflight');
    expect(pre.getAttribute('data-evaluable')).toBe('0');
    expect(screen.getByTestId('retry-judgement-preflight-summary').textContent).toBe('0 of 3 cases evaluable by this evaluator');
    expect(screen.getByTestId('retry-judgement-preflight-reasons').textContent).toContain(`2 ×${NO_GOLD}`);
    expect(screen.getByTestId('retry-judgement-preflight-reasons').textContent).toContain(`1 ×${NO_CANDIDATES}`);
    expect(pre.textContent).toContain("This evaluator's gold/extraction rules don't match these cases — pick another evaluator or add gold ids.");
    expect(pre.className).toMatch(/amber/);
    expect(pre.className).not.toMatch(/red/);
    const tc3 = screen.getByTestId('retry-judgement-preflight-cases-tc-3');
    expect(tc3.textContent).toContain('gold 1 id from expectedOutcomes[0]');
    expect(tc3.textContent).toContain("0 from tool 'search' hits (hits / results)");
    expect(tc3.textContent).toContain('Tools scanned: search');
    // Scope locked to "All cases" with the reason; judge model marked unused.
    expect((screen.getByTestId('retry-judgement-scope-errored') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId('retry-judgement-scope-all') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId('retry-judgement-scope-forced')).toBeTruthy();
    expect(screen.getByTestId('retry-judgement-no-judge-model')).toBeTruthy();
    expect(screen.getByTestId('retry-judgement-count').textContent).toBe('3');
    const confirm = screen.getByTestId('retry-judgement-confirm-btn') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(confirm.getAttribute('title')).toBe('This evaluator cannot score any case of this run');
    // The pre-flight was re-run for the new evaluator.
    expect(preflightCalls().at(-1)!.body).toEqual({ scope: 'errored', evaluatorId: 'eval-det' });
  });

  it('a partially evaluable deterministic evaluator: "2 of 3", abstain count, Confirm ENABLED and the request says scope all', async () => {
    renderDialog();
    await waitFor(() => expect(screen.getByTestId('retry-judgement-evaluator-eval-det')).toBeTruthy());
    fireEvent.change(screen.getByTestId('select-native'), { target: { value: 'eval-det' } });
    await waitFor(() => expect(screen.getByTestId('retry-judgement-preflight-summary').textContent).toBe('2 of 3 cases evaluable by this evaluator'));
    expect(screen.getByTestId('retry-judgement-preflight-abstain').textContent).toContain('1 abstain case');
    expect((screen.getByTestId('retry-judgement-confirm-btn') as HTMLButtonElement).disabled).toBe(false);

    await act(async () => { fireEvent.click(screen.getByTestId('retry-judgement-confirm-btn')); });
    await flush();
    expect(postCalls()).toHaveLength(1);
    expect(postCalls()[0].body).toEqual({ scope: 'all', evaluatorId: 'eval-det', judgeModelId: 'run-model' });
  });

  it('a pre-flight failure does not block the retry', async () => {
    fetchMock.mockImplementation(async (url: string, init?: any) => {
      calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
      if (url.endsWith('/api/storage/evaluators')) return json(200, { evaluators: EVALUATORS });
      if (url.endsWith('/retry-judgement/preflight')) return json(500, { error: 'boom' });
      if (url.endsWith('/retry-judgement/status')) return json(404, { error: 'No retry-judgement job found for this run' });
      return json(202, { total: 1 });
    });
    renderDialog();
    await waitFor(() => expect(screen.getByTestId('retry-judgement-preflight-error').textContent).toContain('boom'));
    expect((screen.getByTestId('retry-judgement-confirm-btn') as HTMLButtonElement).disabled).toBe(false);
    // Falls back to the picked scope's count from the run doc.
    expect(screen.getByTestId('retry-judgement-count').textContent).toBe('1');
  });
});

describe('RetryJudgementConfirmDialog — background job', () => {
  const renderDialog = (props: Partial<React.ComponentProps<typeof RetryJudgementConfirmDialog>> = {}) => {
    const onComplete = jest.fn();
    const onOpenChange = jest.fn();
    const utils = render(React.createElement(MemoryRouter, null, React.createElement(RetryJudgementConfirmDialog, {
      run: baseRun, judgeFailedCount: 1, rejudgeableCount: 3, open: true, onOpenChange, onComplete, ...props,
    })));
    return { ...utils, onComplete, onOpenChange };
  };

  it('Confirm POSTs the picked evaluator / model / scope ("" judge model → null) and resolves on the 202 → live progress; Close keeps the job; re-open shows progress; completion shows the summary; Done reports back', async () => {
    const { onComplete, onOpenChange, rerender } = renderDialog();
    await waitFor(() => expect(screen.getByTestId('retry-judgement-evaluator-system-factuality')).toBeTruthy());
    fireEvent.change(screen.getByTestId('select-native'), { target: { value: 'system-factuality' } });
    fireEvent.change(screen.getByTestId('retry-judge-model'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('retry-judgement-scope-all'));
    // The scope change re-pre-flights; Confirm re-enables once that landed.
    await waitFor(() => expect((screen.getByTestId('retry-judgement-confirm-btn') as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByTestId('retry-judgement-count').textContent).toBe('3');
    expect(preflightCalls().at(-1)!.body).toEqual({ scope: 'all', evaluatorId: 'system-factuality' });

    await act(async () => { fireEvent.click(screen.getByTestId('retry-judgement-confirm-btn')); });
    await flush();
    expect(postCalls()).toHaveLength(1);
    expect(postCalls()[0].url).toBe('/api/storage/evaluation-runs/eval-run-1/retry-judgement?scope=all');
    expect(postCalls()[0].body).toEqual({ scope: 'all', evaluatorId: 'system-factuality', judgeModelId: null });
    // No status poll yet — the dialog did not wait for the pipeline.
    expect(screen.getByTestId('retry-judgement-progress-text').textContent).toBe('Re-judging 0/3…');
    expect(screen.getByTestId('retry-judgement-progress').textContent).toContain('you can close this dialog');
    expect(screen.queryByTestId('retry-judgement-confirm-btn')).toBeNull();

    // Close while running — the job survives in the store.
    fireEvent.click(screen.getByTestId('retry-judgement-close-btn'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    rerender(React.createElement(MemoryRouter, null, React.createElement(RetryJudgementConfirmDialog, { run: baseRun, judgeFailedCount: 1, rejudgeableCount: 3, open: false, onOpenChange, onComplete })));
    expect(getRetryJudgementJob('eval-run-1')!.status).toBe('running');

    statusResponses.push(json(200, { status: 'running', total: 3, completed: 2 }));
    await tick();

    // Re-open: live progress (2/3), no pickers.
    rerender(React.createElement(MemoryRouter, null, React.createElement(RetryJudgementConfirmDialog, { run: baseRun, judgeFailedCount: 1, rejudgeableCount: 3, open: true, onOpenChange, onComplete })));
    await flush();
    expect(screen.getByTestId('retry-judgement-progress-text').textContent).toBe('Re-judging 2/3…');
    expect(screen.queryByTestId('retry-judgement-confirm-btn')).toBeNull();
    expect(screen.queryByTestId('select-native')).toBeNull();

    const summary = {
      retried: 3, succeeded: 2, failed: 0, notEvaluable: 1, abstain: 1,
      results: [
        { testCaseId: 'tc-1', reportId: 'r1', outcome: 'succeeded', passFailStatus: 'passed' },
        { testCaseId: 'tc-2', reportId: 'r2', outcome: 'succeeded', passFailStatus: 'passed', abstain: true },
        { testCaseId: 'tc-3', reportId: 'r3', outcome: 'not-evaluable', passFailStatus: null, reason: NO_CANDIDATES, diagnostics },
      ],
    };
    statusResponses.push(json(200, { status: 'completed', total: 3, completed: 3, summary }));
    await tick();
    expect(screen.getByTestId('retry-judgement-summary-line').textContent).toBe('Retried 3 · 2 scored (1 abstain) · 1 not evaluable');
    const notEvaluable = screen.getByTestId('retry-judgement-summary-not-evaluable');
    expect(notEvaluable.className).toMatch(/amber/);
    expect(notEvaluable.textContent).toContain('previous judgement kept');
    expect(screen.getByTestId('retry-judgement-summary-reasons').textContent).toBe(`1 ×${NO_CANDIDATES}`);
    expect(screen.getByTestId('retry-judgement-summary-cases-tc-3').textContent).toContain("0 from tool 'search' hits");
    expect(screen.queryByText(/still failed/)).toBeNull();
    fireEvent.click(screen.getByTestId('retry-judgement-done-btn'));
    expect(onComplete).toHaveBeenCalledWith(summary);
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('surfaces a rejected submit (e.g. 400 unknown evaluator) inline, stays open with the pickers, registers no job', async () => {
    postResponses.push(json(400, { error: 'Evaluator not found: gone' }));
    renderDialog();
    await waitFor(() => expect((screen.getByTestId('retry-judgement-confirm-btn') as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.click(screen.getByTestId('retry-judgement-confirm-btn')); });
    await waitFor(() => expect(screen.getByTestId('retry-judgement-error').textContent).toBe('Evaluator not found: gone'));
    expect(screen.getByTestId('retry-judgement-confirm-btn')).toBeTruthy();
    expect(screen.getByTestId('select-native')).toBeTruthy();
    expect(getRetryJudgementJob('eval-run-1')).toBeUndefined();
  });
});
