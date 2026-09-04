/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * RunConfigDialog — the ONE run-configuration dialog shared by "Add Run"
 * (create mode) and "Re-run" (rerun mode, prepopulated from the source run).
 *
 * Covers (owner spec: "Concurrency is also missing in the Run dialog box,
 * and re-run should open the same dialog box with prepopulated box"):
 *  - create mode renders a Concurrency field (empty → server default shown
 *    as placeholder) and hands `concurrency` back on Start Run only when set
 *  - rerun mode prepopulates EVERY field from the run doc's actual values:
 *    name '(re-run)', agent, evaluator (visible), judge model, concurrency,
 *    test-case source
 *  - rerun submit POSTs diff-only overrides (concurrency included only when
 *    changed) and navigates via onRerun
 *  - a source-run agent / evaluator that no longer exists in config is shown
 *    disabled with a hint (never silently swapped); missing agent blocks submit
 *  - pure helpers: computeRerunOverrides / valuesFromRun
 */

import * as React from 'react';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';

// ── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('@/lib/constants', () => ({
  DEFAULT_CONFIG: {
    agents: [
      { key: 'demo', name: 'Demo Agent', enabled: true },
      { key: 'other', name: 'Other Agent', enabled: true },
    ],
    models: { 'claude-sonnet': { display_name: 'Claude Sonnet' } },
  },
}));
jest.mock('@/lib/config', () => ({ ENV_CONFIG: { backendUrl: '' } }));
jest.mock('@/lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

const mockRerun = jest.fn();
jest.mock('@/services/client', () => ({
  rerunEvaluationRun: (...a: unknown[]) => mockRerun(...a),
}));

const mockGetAllBenchmarks = jest.fn();
jest.mock('@/services/storage', () => ({
  asyncBenchmarkStorage: { getAll: (...a: unknown[]) => mockGetAllBenchmarks(...a) },
}));

// Judge model select pulls model catalogs; render a plain input so the
// value round-trip is observable without the real component's fetches.
jest.mock('@/components/JudgeModelSelect', () => ({
  JudgeModelSelect: ({ value, onValueChange }: any) =>
    React.createElement('input', {
      'data-testid': 'run-config-judge-model',
      value,
      onChange: (e: any) => onValueChange(e.target.value),
    }),
}));

// Radix Select needs real pointer events + portals to open in jsdom. Render
// it as a native <select> so prepopulation and user changes are observable;
// disabled items keep `disabled` and data-testid so the missing-agent /
// missing-evaluator affordance is asserted on real DOM.
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
    SelectValue: ({ placeholder }: any) => {
      const ctx = R.useContext(Ctx);
      return R.createElement('span', { 'data-testid': 'select-value' }, ctx.value || placeholder || '');
    },
    SelectContent: ({ children }: any) => {
      const ctx = R.useContext(Ctx);
      const items = flatten(children).filter((c: any) => c && c.props && 'value' in c.props);
      return R.createElement(
        'select',
        {
          'data-testid': 'select-native',
          value: ctx.value ?? '',
          onChange: (e: any) => ctx.onValueChange(e.target.value),
        },
        items.map((c: any) => R.createElement('option', {
          key: c.props.value, value: c.props.value, disabled: c.props.disabled,
          'data-testid': c.props['data-testid'],
        }, c.props.children)),
      );
    },
    SelectItem: () => null,
  };
});

// Radix Dialog works in jsdom but its portal/focus-scope adds noise; a
// transparent stand-in keeps assertions on the dialog's own DOM.
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
  RunConfigDialog, computeRerunOverrides, valuesFromRun, hasRerunTweaks, DEFAULT_CONCURRENCY,
} from '@/components/evals3/RunConfigDialog';
import type { EvaluationRun } from '@/types';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const EVALUATORS = [
  { id: 'system-factuality', name: 'Factuality', isSystem: true },
  { id: 'custom-1', name: 'Custom Eval' },
];

const sourceRun: EvaluationRun = {
  id: 'eval-run-src',
  docType: 'evaluation-run',
  name: 'Nightly',
  status: 'completed',
  agentKey: 'demo',
  modelId: 'claude-sonnet',
  judgeModelId: 'demo-model',
  evaluatorId: 'system-factuality',
  concurrency: 3,
  benchmarkId: 'bm-1',
  sources: [{ type: 'benchmark', benchmarkId: 'bm-1' }],
  trigger: 'ui',
  testCaseSnapshots: [{ id: 'tc-1', version: 1, name: 'a' }, { id: 'tc-2', version: 1, name: 'b' }],
  results: {},
  createdAt: '2026-01-01T00:00:00.000Z',
} as EvaluationRun;

function installFetch() {
  (global as any).fetch = jest.fn(async (url: string) => {
    if (String(url).includes('/api/storage/evaluators')) {
      return { ok: true, json: async () => ({ evaluators: EVALUATORS }) } as any;
    }
    return { ok: false, json: async () => ({}) } as any;
  });
}

const dlg = (props: Record<string, unknown>) => React.createElement(RunConfigDialog as any, props);

const agentTrigger = () => screen.getByTestId('run-config-agent-trigger');
const evaluatorTrigger = () => screen.getByTestId('run-config-evaluator-trigger');
const concurrencyInput = () => screen.getByTestId('run-config-concurrency-input') as HTMLInputElement;
const nameInput = () => screen.getByTestId('run-config-name-input') as HTMLInputElement;
const submitBtn = () => screen.getByTestId('run-config-submit-btn') as HTMLButtonElement;
/** The native <select> rendered by the Select mock inside a given trigger's parent. */
const nativeSelectFor = (trigger: HTMLElement) =>
  trigger.parentElement!.querySelector('select[data-testid="select-native"]') as HTMLSelectElement;

beforeEach(() => {
  jest.clearAllMocks();
  installFetch();
  mockGetAllBenchmarks.mockResolvedValue([{ id: 'bm-1', name: 'Bench One' }, { id: 'bm-2', name: 'Bench Two' }]);
});

// ── Pure helpers ─────────────────────────────────────────────────────────────

describe('computeRerunOverrides (diff-only body)', () => {
  it('omits every field except name when nothing changed (concurrency included)', () => {
    const o = computeRerunOverrides(sourceRun, valuesFromRun(sourceRun));
    expect(o).toEqual({
      name: 'Nightly (re-run)',
      agentKey: undefined, judgeModelId: undefined, evaluatorId: undefined,
      concurrency: undefined, benchmarkId: undefined,
    });
    expect(hasRerunTweaks(o)).toBe(false);
  });

  it('includes concurrency ONLY when it differs from the source run', () => {
    const v = valuesFromRun(sourceRun);
    expect(computeRerunOverrides(sourceRun, { ...v, concurrency: 3 }).concurrency).toBeUndefined();
    expect(computeRerunOverrides(sourceRun, { ...v, concurrency: 7 }).concurrency).toBe(7);
    expect(hasRerunTweaks(computeRerunOverrides(sourceRun, { ...v, concurrency: 7 }))).toBe(true);
  });

  it('treats an empty concurrency as the server default (1) — a change vs. a run with concurrency 3, a no-op vs. a legacy run without one', () => {
    const v = valuesFromRun(sourceRun);
    expect(computeRerunOverrides(sourceRun, { ...v, concurrency: undefined }).concurrency).toBe(DEFAULT_CONCURRENCY);
    const legacy = { ...sourceRun, concurrency: undefined } as EvaluationRun;
    expect(computeRerunOverrides(legacy, { ...valuesFromRun(legacy), concurrency: undefined }).concurrency).toBeUndefined();
    expect(computeRerunOverrides(legacy, { ...valuesFromRun(legacy), concurrency: 1 }).concurrency).toBeUndefined();
  });

  it('sends null to clear evaluator / judge model, and only a DIFFERENT benchmark as a swap', () => {
    const v = valuesFromRun(sourceRun);
    const o = computeRerunOverrides(sourceRun, { ...v, evaluatorId: undefined, judgeModelId: undefined, agentKey: 'other', benchmarkId: 'bm-2' });
    expect(o).toMatchObject({ evaluatorId: null, judgeModelId: null, agentKey: 'other', benchmarkId: 'bm-2' });
    // "keep source" (undefined) never turns into a null clear.
    expect(computeRerunOverrides(sourceRun, { ...v, benchmarkId: undefined }).benchmarkId).toBeUndefined();
  });
});

describe('valuesFromRun', () => {
  it('mirrors the run doc: name suffixed, agent/evaluator/judge/concurrency/benchmark copied', () => {
    expect(valuesFromRun(sourceRun)).toMatchObject({
      name: 'Nightly (re-run)', agentKey: 'demo', evaluatorId: 'system-factuality',
      judgeModelId: 'demo-model', concurrency: 3, benchmarkId: 'bm-1', modelId: 'claude-sonnet',
    });
  });
});

// ── create mode ──────────────────────────────────────────────────────────────

describe('RunConfigDialog — create mode (Add Run)', () => {
  const benchmark = { id: 'bm-1', name: 'Bench One', testCaseIds: ['tc-1', 'tc-2'] };

  it('renders a Concurrency field with the server default as placeholder and Start Run', async () => {
    render(dlg({ mode: 'create', open: true, onOpenChange: jest.fn(), onStart: jest.fn(), benchmark, initialValues: { name: 'Run 1', agentKey: 'demo', modelId: 'claude-sonnet' } }));
    expect(screen.getByText('Configure Run')).toBeTruthy();
    expect(screen.getByText('Concurrency')).toBeTruthy();
    expect(concurrencyInput().value).toBe('');
    expect(concurrencyInput().placeholder).toBe(`${DEFAULT_CONCURRENCY} (default)`);
    expect(concurrencyInput().getAttribute('title')).toMatch(/in parallel/);
    expect(screen.getByTestId('run-config-source-summary').textContent).toContain('Bench One');
    expect(screen.getByTestId('run-config-source-summary').textContent).toContain('2 cases');
    expect(submitBtn().textContent).toContain('Start Run');
    await waitFor(() => expect(nativeSelectFor(evaluatorTrigger()).options.length).toBe(3));
  });

  it('hands back concurrency on Start Run only when set, clamped to [1, 20]', async () => {
    const onStart = jest.fn();
    render(dlg({ mode: 'create', open: true, onOpenChange: jest.fn(), onStart: onStart, benchmark, initialValues: { name: 'Run 1', agentKey: 'demo', modelId: 'claude-sonnet' } }));
    fireEvent.click(submitBtn());
    await waitFor(() => expect(onStart).toHaveBeenCalledTimes(1));
    expect(onStart.mock.calls[0][0]).toMatchObject({ name: 'Run 1', agentKey: 'demo', modelId: 'claude-sonnet' });
    expect(onStart.mock.calls[0][0].concurrency).toBeUndefined();

    fireEvent.change(concurrencyInput(), { target: { value: '99' } });
    expect(concurrencyInput().value).toBe('20');
    fireEvent.change(concurrencyInput(), { target: { value: '0' } });
    expect(concurrencyInput().value).toBe('1');
    fireEvent.change(concurrencyInput(), { target: { value: '4' } });
    fireEvent.click(submitBtn());
    await waitFor(() => expect(onStart).toHaveBeenCalledTimes(2));
    expect(onStart.mock.calls[1][0].concurrency).toBe(4);
  });

  it('disables Start Run until a name is present', () => {
    render(dlg({ mode: 'create', open: true, onOpenChange: jest.fn(), onStart: jest.fn(), benchmark, initialValues: { name: '', agentKey: 'demo', modelId: 'claude-sonnet' } }));
    expect(submitBtn().disabled).toBe(true);
    fireEvent.change(nameInput(), { target: { value: 'x' } });
    expect(submitBtn().disabled).toBe(false);
  });
});

// ── rerun mode ───────────────────────────────────────────────────────────────

describe('RunConfigDialog — rerun mode (prepopulated from the source run)', () => {
  it('renders nothing while sourceRun is null', () => {
    const { container } = render(dlg({ mode: 'rerun', open: true, onOpenChange: jest.fn(), sourceRun: null }));
    expect(container.innerHTML).toBe('');
  });

  it('prepopulates name, agent, evaluator (visible), judge model, concurrency and test-case source from the run doc', async () => {
    render(dlg({ mode: 'rerun', open: true, onOpenChange: jest.fn(), onRerun: jest.fn(), sourceRun: sourceRun }));
    expect(screen.getByText('Re-run evaluation')).toBeTruthy();
    expect(nameInput().value).toBe('Nightly (re-run)');
    expect(agentTrigger().getAttribute('data-value')).toBe('demo');
    expect(evaluatorTrigger().getAttribute('data-value')).toBe('system-factuality');
    expect((screen.getByTestId('run-config-judge-model') as HTMLInputElement).value).toBe('demo-model');
    expect(concurrencyInput().value).toBe('3');
    expect(screen.getByTestId('run-config-benchmark-trigger').getAttribute('data-value')).toBe('bm-1');
    // Evaluator list loaded → the prepopulated one resolves to a real option, no missing hint.
    await waitFor(() => expect(nativeSelectFor(evaluatorTrigger()).options.length).toBe(3));
    expect(screen.queryByTestId('run-config-evaluator-missing-hint')).toBeNull();
    expect(screen.queryByTestId('run-config-agent-missing-hint')).toBeNull();
    // Nothing tweaked → no modified hint; submit says Re-run.
    expect(screen.queryByTestId('run-config-modified-hint')).toBeNull();
    expect(submitBtn().textContent).toContain('Re-run');
    expect(submitBtn().disabled).toBe(false);
  });

  it('submits diff-only overrides (name + changed concurrency), shows the modified hint, and calls onRerun with the new id', async () => {
    mockRerun.mockResolvedValue({ runId: 'eval-run-new', run: {}, defaultsApplied: [], modified: true });
    const onRerun = jest.fn();
    const onOpenChange = jest.fn();
    render(dlg({ mode: 'rerun', open: true, onOpenChange: onOpenChange, onRerun: onRerun, sourceRun: sourceRun }));

    fireEvent.change(concurrencyInput(), { target: { value: '7' } });
    expect(screen.getByTestId('run-config-modified-hint')).toBeTruthy();
    fireEvent.click(submitBtn());

    await waitFor(() => expect(mockRerun).toHaveBeenCalledTimes(1));
    expect(mockRerun).toHaveBeenCalledWith('eval-run-src', {
      name: 'Nightly (re-run)',
      agentKey: undefined, judgeModelId: undefined, evaluatorId: undefined,
      concurrency: 7, benchmarkId: undefined,
    });
    await waitFor(() => expect(onRerun).toHaveBeenCalledWith('eval-run-new'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('a faithful duplicate sends no field overrides at all (concurrency untouched → omitted)', async () => {
    mockRerun.mockResolvedValue({ runId: 'eval-run-dup', run: {}, defaultsApplied: [], modified: false });
    render(dlg({ mode: 'rerun', open: true, onOpenChange: jest.fn(), onRerun: jest.fn(), sourceRun: sourceRun }));
    fireEvent.click(submitBtn());
    await waitFor(() => expect(mockRerun).toHaveBeenCalledTimes(1));
    const body = mockRerun.mock.calls[0][1];
    expect(body.concurrency).toBeUndefined();
    expect(hasRerunTweaks(body)).toBe(false);
  });

  it('surfaces a POST failure inline and keeps the dialog open', async () => {
    mockRerun.mockRejectedValue(new Error('Cannot re-run: benchmark bm-1 no longer exists'));
    const onOpenChange = jest.fn();
    render(dlg({ mode: 'rerun', open: true, onOpenChange: onOpenChange, onRerun: jest.fn(), sourceRun: sourceRun }));
    fireEvent.click(submitBtn());
    await waitFor(() => expect(screen.getByTestId('run-config-error').textContent).toContain('no longer exists'));
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('shows a source-run agent that is no longer configured as a disabled entry with a hint and blocks submit (never silently swaps)', async () => {
    const gone = { ...sourceRun, agentKey: 'retired-agent' } as EvaluationRun;
    render(dlg({ mode: 'rerun', open: true, onOpenChange: jest.fn(), onRerun: jest.fn(), sourceRun: gone }));
    expect(agentTrigger().getAttribute('data-value')).toBe('retired-agent');
    const missing = screen.getByTestId('run-config-agent-missing-item') as HTMLOptionElement;
    expect(missing.disabled).toBe(true);
    expect(missing.textContent).toContain('retired-agent');
    expect(screen.getByTestId('run-config-agent-missing-hint').textContent).toMatch(/no longer configured/);
    expect(submitBtn().disabled).toBe(true);
    // Picking a configured agent clears the hint and re-enables submit.
    fireEvent.change(nativeSelectFor(agentTrigger()), { target: { value: 'other' } });
    expect(screen.queryByTestId('run-config-agent-missing-hint')).toBeNull();
    expect(submitBtn().disabled).toBe(false);
    expect(screen.getByTestId('run-config-modified-hint')).toBeTruthy();
  });

  it('shows a source-run evaluator that no longer exists as a disabled entry with a hint (after the evaluator list loads)', async () => {
    const gone = { ...sourceRun, evaluatorId: 'deleted-evaluator' } as EvaluationRun;
    render(dlg({ mode: 'rerun', open: true, onOpenChange: jest.fn(), onRerun: jest.fn(), sourceRun: gone }));
    // Before the list loads nothing is flagged (can't tell missing from not-yet-loaded).
    expect(screen.queryByTestId('run-config-evaluator-missing-hint')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('run-config-evaluator-missing-hint')).toBeTruthy());
    const missing = screen.getByTestId('run-config-evaluator-missing-item') as HTMLOptionElement;
    expect(missing.disabled).toBe(true);
    expect(evaluatorTrigger().getAttribute('data-value')).toBe('deleted-evaluator');
    // Known-gone evaluator blocks submit until another is chosen (RCA Default counts).
    expect(submitBtn().disabled).toBe(true);
    fireEvent.change(nativeSelectFor(evaluatorTrigger()), { target: { value: '__default__' } });
    expect(screen.queryByTestId('run-config-evaluator-missing-hint')).toBeNull();
    expect(submitBtn().disabled).toBe(false);
  });

  it('does NOT flag the evaluator as missing when the evaluator list failed to load (a network blip must not block re-runs)', async () => {
    (global as any).fetch = jest.fn(async () => { throw new Error('offline'); });
    render(dlg({ mode: 'rerun', open: true, onOpenChange: jest.fn(), onRerun: jest.fn(), sourceRun: sourceRun }));
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });
    expect(screen.queryByTestId('run-config-evaluator-missing-hint')).toBeNull();
    expect(submitBtn().disabled).toBe(false);
  });

  it('keeps in-progress edits when the parent refetches the SAME run (new object, same id) while the dialog is open', () => {
    const onOpenChange = jest.fn();
    const { rerender } = render(dlg({ mode: 'rerun', open: true, onOpenChange, onRerun: jest.fn(), sourceRun: sourceRun }));
    fireEvent.change(concurrencyInput(), { target: { value: '8' } });
    fireEvent.change(nameInput(), { target: { value: 'My tweaked name' } });
    // Parent polls → a fresh object for the same run (e.g. stats updated).
    rerender(dlg({ mode: 'rerun', open: true, onOpenChange, onRerun: jest.fn(), sourceRun: { ...sourceRun, stats: { total: 2 } } as any }));
    expect(concurrencyInput().value).toBe('8');
    expect(nameInput().value).toBe('My tweaked name');
    // A DIFFERENT run id does re-seed.
    rerender(dlg({ mode: 'rerun', open: true, onOpenChange, onRerun: jest.fn(), sourceRun: { ...sourceRun, id: 'eval-run-other', name: 'Other', concurrency: 5 } as any }));
    expect(concurrencyInput().value).toBe('5');
    expect(nameInput().value).toBe('Other (re-run)');
  });

  it('re-seeds from the source run each time it opens (a stale tweak never leaks into the next open)', async () => {
    const { rerender } = render(dlg({ mode: 'rerun', open: true, onOpenChange: jest.fn(), onRerun: jest.fn(), sourceRun: sourceRun }));
    fireEvent.change(concurrencyInput(), { target: { value: '9' } });
    expect(concurrencyInput().value).toBe('9');
    rerender(dlg({ mode: 'rerun', open: false, onOpenChange: jest.fn(), onRerun: jest.fn(), sourceRun: sourceRun }));
    await act(async () => {
      rerender(dlg({ mode: 'rerun', open: true, onOpenChange: jest.fn(), onRerun: jest.fn(), sourceRun: sourceRun }));
    });
    expect(concurrencyInput().value).toBe('3');
  });
});
