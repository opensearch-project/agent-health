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
 * retrying; defaults will be the last selected ones").
 *
 * Covers:
 *  - seedRetryJudgementDefaults: lastJudgementRetry > run values > built-in
 *    default; scope defaults to 'errored' iff there are judge-failed cases
 *  - the dialog preselects those defaults and lists GET /evaluators
 *  - the "Only judge-failed cases" radio is disabled at N=0 (All preselected)
 *  - submit POSTs { scope, evaluatorId, judgeModelId } (''→null) via
 *    retryJudgement() and shows the summary
 */

import * as React from 'react';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';

jest.mock('@/lib/config', () => ({ ENV_CONFIG: { backendUrl: '' } }));
jest.mock('@/lib/utils', () => ({ cn: (...args: unknown[]) => args.filter(Boolean).join(' ') }));

const mockRetryJudgement = jest.fn();
jest.mock('@/services/client', () => ({
  retryJudgement: (...a: unknown[]) => mockRetryJudgement(...a),
}));

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
  RetryJudgementConfirmDialog, seedRetryJudgementDefaults, DEFAULT_EVALUATOR_ID,
} from '@/components/evals3/RetryJudgementConfirmDialog';
import type { EvaluationRun } from '@/types';

const EVALUATORS = [
  { id: 'system-rca-default', name: 'RCA Default', isSystem: true },
  { id: 'system-factuality', name: 'Factuality', isSystem: true },
  { id: 'custom-1', name: 'Custom Eval' },
];

const baseRun = {
  id: 'eval-run-1', docType: 'evaluation-run', name: 'Nightly', status: 'completed',
  agentKey: 'demo', modelId: 'demo-model', judgeModelId: 'run-model', evaluatorId: 'custom-1',
  sources: [], trigger: 'ui', testCaseSnapshots: [], results: {}, createdAt: '2026-01-01T00:00:00.000Z',
} as unknown as EvaluationRun;

beforeEach(() => {
  mockRetryJudgement.mockReset();
  (global as any).fetch = jest.fn(async () => ({ ok: true, json: async () => ({ evaluators: EVALUATORS }) }));
});

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
});

describe('RetryJudgementConfirmDialog', () => {
  const renderDialog = (props: Partial<React.ComponentProps<typeof RetryJudgementConfirmDialog>> = {}) => {
    const onComplete = jest.fn();
    const onOpenChange = jest.fn();
    const utils = render(React.createElement(RetryJudgementConfirmDialog, {
      run: baseRun, judgeFailedCount: 1, rejudgeableCount: 3, open: true, onOpenChange, onComplete, ...props,
    }));
    return { ...utils, onComplete, onOpenChange };
  };

  it('preselects the run\'s evaluator + judge model and the judge-failed scope, listing the fetched evaluators', async () => {
    renderDialog();
    await waitFor(() => expect(screen.getByTestId('retry-judgement-evaluator-system-factuality')).toBeTruthy());
    expect(screen.getByTestId('select-native')).toHaveProperty('value', 'custom-1');
    expect((screen.getByTestId('retry-judge-model') as HTMLInputElement).value).toBe('run-model');
    expect((screen.getByTestId('retry-judgement-scope-errored') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId('retry-judgement-scope-errored').closest('label')!.textContent).toContain('(1)');
    expect(screen.getByTestId('retry-judgement-scope-all').closest('label')!.textContent).toContain('(3)');
    expect(screen.getByTestId('retry-judgement-count').textContent).toBe('1');
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
    rerender(React.createElement(RetryJudgementConfirmDialog, {
      run: { ...baseRun, lastJudgementRetry: { evaluatorId: 'custom-1', judgeModelId: 'run-model', scope: 'all', at: 'later' } },
      judgeFailedCount: 1, rejudgeableCount: 3, open: true, onOpenChange: jest.fn(), onComplete: jest.fn(),
    }));
    expect(screen.getByTestId('select-native')).toHaveProperty('value', 'system-factuality');
  });

  it('with no judge-failed cases: "Only judge-failed" is disabled, "All cases" preselected, count = all', () => {
    renderDialog({ judgeFailedCount: 0 });
    expect((screen.getByTestId('retry-judgement-scope-errored') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId('retry-judgement-scope-all') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId('retry-judgement-count').textContent).toBe('3');
    expect((screen.getByTestId('retry-judgement-confirm-btn') as HTMLButtonElement).disabled).toBe(false);
  });

  it('submit POSTs the picked evaluator / model / scope ("" judge model → null) and shows the summary; Done reports back', async () => {
    let resolveRetry: (v: any) => void = () => {};
    mockRetryJudgement.mockImplementation((_id: string, _req: any, onProgress: any) => new Promise(resolve => {
      onProgress(0, 3);
      resolveRetry = resolve;
    }));
    const { onComplete } = renderDialog();
    await waitFor(() => expect(screen.getByTestId('retry-judgement-evaluator-system-factuality')).toBeTruthy());

    fireEvent.change(screen.getByTestId('select-native'), { target: { value: 'system-factuality' } });
    fireEvent.change(screen.getByTestId('retry-judge-model'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('retry-judgement-scope-all'));
    expect(screen.getByTestId('retry-judgement-count').textContent).toBe('3');

    fireEvent.click(screen.getByTestId('retry-judgement-confirm-btn'));
    expect(mockRetryJudgement).toHaveBeenCalledWith(
      'eval-run-1',
      { scope: 'all', evaluatorId: 'system-factuality', judgeModelId: null },
      expect.any(Function),
    );
    await waitFor(() => expect(screen.getByTestId('retry-judgement-progress').textContent).toContain('0/3'));

    const summary = { retried: 3, succeeded: 3, failed: 0, results: [] };
    await act(async () => { resolveRetry(summary); });
    await waitFor(() => expect(screen.getByTestId('retry-judgement-summary').textContent).toContain('3 succeeded'));
    fireEvent.click(screen.getByTestId('retry-judgement-done-btn'));
    expect(onComplete).toHaveBeenCalledWith(summary);
  });

  it('surfaces a rejected submit (e.g. 400 unknown evaluator) inline and stays open', async () => {
    mockRetryJudgement.mockRejectedValue(new Error('Evaluator not found: gone'));
    renderDialog();
    fireEvent.click(screen.getByTestId('retry-judgement-confirm-btn'));
    await waitFor(() => expect(screen.getByTestId('retry-judgement-error').textContent).toBe('Evaluator not found: gone'));
    expect(screen.getByTestId('retry-judgement-confirm-btn')).toBeTruthy();
  });

  it('renders nothing without a run', () => {
    const { container } = renderDialog({ run: null });
    expect(container.innerHTML).toBe('');
  });
});
