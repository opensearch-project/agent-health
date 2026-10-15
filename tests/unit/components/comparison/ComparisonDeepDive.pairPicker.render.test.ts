/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * RTL render tests for the deep-dive panel's PAIR PICKER (owner report: on a
 * compare page with three runs the "what's actually different" section was
 * simply absent — the panel only rendered for exactly two runs).
 *
 * Mounts the REAL ComparisonDeepDive with `fetch` and `localStorage` faked:
 *  - with `pairPicker` the header names the pair, the hint renders and both
 *    selects list every selectable run (name · date) with A ≠ B
 *  - changing a select reports the new pair through onChange (swap on collision)
 *  - `autoStart === false` + no cached narrative → idle state with a Generate
 *    button, NO POST until it is clicked
 *  - `autoStart === false` + a cached narrative → served instantly, no POST
 *    (switching back and forth between pairs never re-launches the LLM job)
 *  - without `pairPicker` the 2-run header is byte-for-byte what it was
 */

import * as React from 'react';
import { render, screen, act, fireEvent, cleanup } from '@testing-library/react';

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: string }) => React.createElement('div', { 'data-testid': 'md' }, children),
}));
jest.mock('remark-gfm', () => () => {});

import { ComparisonDeepDive, deepDiveRunLabel } from '@/components/comparison/ComparisonDeepDive';

const FABLE = 'us.anthropic.claude-fable-5-1';

const RUNS: any[] = [
  { id: 'run-old', agentKey: 'agent-old', name: 'Baseline', createdAt: '2026-10-01T10:00:00Z' },
  { id: 'run-mid', agentKey: 'agent-mid', name: 'Candidate v1', createdAt: '2026-10-02T10:00:00Z' },
  { id: 'run-new', agentKey: 'agent-new', name: 'Candidate v2', createdAt: '2026-10-03T10:00:00Z' },
];
const byId = (id: string) => RUNS.find((r) => r.id === id);

// Module-level result cache is keyed by report-id pair → unique ids per test.
let seq = 0;
const rep = (runId: string) => `rep-${runId}-${seq}`;
const makeRows = (): any[] => [
  {
    testCaseId: 'tc-1',
    testCaseName: 'Case 1',
    results: Object.fromEntries(RUNS.map((r) => [r.id, { reportId: rep(r.id), passFailStatus: 'passed', accuracy: 80 }])),
  },
];

type FetchCall = { url: string; body?: any };
let calls: FetchCall[];
function installFetch() {
  calls = [];
  (global as any).fetch = jest.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    const json = (data: unknown, ok = true, status = 200) => ({ ok, status, json: async () => data }) as any;
    if (url.endsWith('/api/comparison/deep-dive/models')) return json({ models: [{ provider: 'amazon-bedrock', id: FABLE, name: 'Fable' }], defaultId: FABLE });
    if (url.endsWith('/api/comparison/deep-dive/system-prompt')) return json({ systemPrompt: 'DEFAULT' });
    if (url.endsWith('/api/comparison/deep-dive')) return json({ jobId: 'job-1' }, true, 202);
    if (url.includes('/api/comparison/deep-dive/jobs/')) {
      const post = [...calls].reverse().find((c) => c.url.endsWith('/api/comparison/deep-dive') && c.body);
      const ids = (post?.body?.reportIds || []).join('+');
      return json({ status: 'done', elapsedMs: 1000, result: { markdown: `narrative for ${ids}`, modelId: `amazon-bedrock/${FABLE}`, durationMs: 1000, runs: [] } });
    }
    return json({}, false, 404);
  });
}
const postCalls = () => calls.filter((c) => c.url.endsWith('/api/comparison/deep-dive') && c.body);
const flush = async (ms = 0) => {
  await act(async () => { await jest.advanceTimersByTimeAsync(0); });
  if (ms > 0) await act(async () => { await jest.advanceTimersByTimeAsync(ms); });
};

function mount(pair: [string, string], opts: { autoStart?: boolean; picker?: boolean; onChange?: jest.Mock } = {}) {
  const props = {
    runs: [byId(pair[0]), byId(pair[1])],
    rows: makeRows(),
    reports: {},
    getAgentName: (k: string) => `Agent(${k})`,
    onSpanLink: () => {},
    onWindowAgents: () => {},
    autoStart: opts.autoStart,
    pairPicker: opts.picker === false ? undefined : { options: RUNS, onChange: opts.onChange ?? jest.fn() },
  };
  const utils = render(React.createElement(ComparisonDeepDive, props as any));
  return { ...utils, rerender: (nextPair: [string, string], next: Partial<typeof props> = {}) =>
    utils.rerender(React.createElement(ComparisonDeepDive, { ...props, ...next, runs: [byId(nextPair[0]), byId(nextPair[1])] } as any)) };
}

beforeEach(() => {
  jest.useFakeTimers();
  localStorage.clear();
  seq += 1;
  installFetch();
});
afterEach(() => {
  cleanup();
  jest.useRealTimers();
});

describe('deepDiveRunLabel', () => {
  it('is "<run name> · <date>", falling back to the agent name when the run has none', () => {
    expect(deepDiveRunLabel(RUNS[0], (k) => k)).toMatch(/^Baseline · Oct 1, 2026/);
    expect(deepDiveRunLabel({ id: 'r', agentKey: 'agent-x', createdAt: 'nope' } as any, (k) => `Agent(${k})`)).toBe('Agent(agent-x)');
    expect(deepDiveRunLabel(RUNS[0], (k) => k, false)).toBe('Baseline');
  });
});

describe('ComparisonDeepDive — pair picker (3+ runs)', () => {
  it('renders the pair in the header, the hint, and both selects with every run (name · date), A ≠ B', async () => {
    mount(['run-old', 'run-new'], { autoStart: true });
    await flush(3000);

    expect(screen.getByTestId('deep-dive-heading').textContent).toBe("What's actually different — Baseline vs Candidate v2");
    expect(screen.getByTestId('deep-dive-pair-hint').textContent).toBe('The trace-grounded deep-dive compares two runs at a time; pick the pair.');

    const a = screen.getByTestId('deep-dive-pair-select-a') as HTMLSelectElement;
    const b = screen.getByTestId('deep-dive-pair-select-b') as HTMLSelectElement;
    expect(a.value).toBe('run-old');
    expect(b.value).toBe('run-new');
    expect(a.value).not.toBe(b.value);
    const labels = Array.from(a.options).map((o) => o.textContent);
    expect(labels).toHaveLength(3);
    expect(labels[0]).toMatch(/^Baseline · Oct 1, 2026/);
    expect(labels[1]).toMatch(/^Candidate v1 · Oct 2, 2026/);
    expect(labels[2]).toMatch(/^Candidate v2 · Oct 3, 2026/);

    // The default pair auto-starts exactly like the 2-run page.
    expect(postCalls()).toHaveLength(1);
    expect(postCalls()[0].body.reportIds).toEqual([rep('run-old'), rep('run-new')]);
    expect(screen.getByTestId('md').textContent).toBe(`narrative for ${rep('run-old')}+${rep('run-new')}`);
  });

  it('changing a side reports the new pair; picking the other side\'s run swaps instead of allowing A = B', async () => {
    const onChange = jest.fn();
    mount(['run-old', 'run-new'], { autoStart: true, onChange });
    await flush(3000);

    fireEvent.change(screen.getByTestId('deep-dive-pair-select-b'), { target: { value: 'run-mid' } });
    expect(onChange).toHaveBeenLastCalledWith(['run-old', 'run-mid']);

    fireEvent.change(screen.getByTestId('deep-dive-pair-select-b'), { target: { value: 'run-old' } });
    expect(onChange).toHaveBeenLastCalledWith(['run-new', 'run-old']);

    fireEvent.change(screen.getByTestId('deep-dive-pair-select-a'), { target: { value: 'run-new' } });
    expect(onChange).toHaveBeenLastCalledWith(['run-new', 'run-old']);
  });

  it('a non-default, uncached pair does NOT launch the LLM job: idle state + Generate button, POST only on click', async () => {
    mount(['run-old', 'run-mid'], { autoStart: false });
    await flush(3000);

    expect(postCalls()).toHaveLength(0);
    expect(screen.getByTestId('deep-dive-idle')).toBeTruthy();
    expect(screen.queryByTestId('deep-dive-loading')).toBeNull();
    expect(screen.getByTestId('deep-dive-heading').textContent).toBe("What's actually different — Baseline vs Candidate v1");

    fireEvent.click(screen.getByTestId('deep-dive-generate'));
    await flush(3000);
    expect(postCalls()).toHaveLength(1);
    expect(postCalls()[0].body.reportIds).toEqual([rep('run-old'), rep('run-mid')]);
    expect(screen.getByTestId('md').textContent).toBe(`narrative for ${rep('run-old')}+${rep('run-mid')}`);
    expect(screen.queryByTestId('deep-dive-idle')).toBeNull();
  });

  it('toggling between pairs reuses cached narratives — no second POST for a pair that was already generated', async () => {
    const view = mount(['run-old', 'run-new'], { autoStart: true });
    await flush(3000);
    expect(postCalls()).toHaveLength(1);
    expect(screen.getByTestId('md').textContent).toBe(`narrative for ${rep('run-old')}+${rep('run-new')}`);

    // Switch to a non-default pair: idle (no surprise LLM cost), then generate on click.
    view.rerender(['run-old', 'run-mid'], { autoStart: false });
    await flush(3000);
    expect(postCalls()).toHaveLength(1);
    expect(screen.getByTestId('deep-dive-idle')).toBeTruthy();
    expect(screen.queryByTestId('md')).toBeNull(); // the previous pair's narrative is not shown under the new header
    fireEvent.click(screen.getByTestId('deep-dive-generate'));
    await flush(3000);
    expect(postCalls()).toHaveLength(2);
    expect(screen.getByTestId('md').textContent).toBe(`narrative for ${rep('run-old')}+${rep('run-mid')}`);

    // Back to the default pair → served from cache, still 2 POSTs.
    view.rerender(['run-old', 'run-new'], { autoStart: true });
    await flush(3000);
    expect(postCalls()).toHaveLength(2);
    expect(screen.getByTestId('md').textContent).toBe(`narrative for ${rep('run-old')}+${rep('run-new')}`);

    // And forward again to the non-default pair → ALSO from cache, no idle state, no POST.
    view.rerender(['run-old', 'run-mid'], { autoStart: false });
    await flush(3000);
    expect(postCalls()).toHaveLength(2);
    expect(screen.queryByTestId('deep-dive-idle')).toBeNull();
    expect(screen.getByTestId('md').textContent).toBe(`narrative for ${rep('run-old')}+${rep('run-mid')}`);
  });

  it('a pair that shares no test case keeps the picker visible with an explanatory line instead of vanishing', async () => {
    const props = {
      runs: [byId('run-old'), byId('run-mid')],
      rows: [{ testCaseId: 'tc-1', testCaseName: 'Case 1', results: { 'run-old': { reportId: rep('run-old') } } }],
      reports: {},
      getAgentName: (k: string) => k,
      onSpanLink: () => {},
      onWindowAgents: () => {},
      autoStart: false,
      pairPicker: { options: RUNS, onChange: jest.fn() },
    };
    render(React.createElement(ComparisonDeepDive, props as any));
    await flush(3000);
    expect(screen.getByTestId('deep-dive-pair-picker')).toBeTruthy();
    expect(screen.getByTestId('deep-dive-no-shared-case')).toBeTruthy();
    expect(screen.queryByTestId('deep-dive-idle')).toBeNull();
    expect(postCalls()).toHaveLength(0);
  });
});

describe('ComparisonDeepDive — 2-run page (no picker) is unchanged', () => {
  it('renders the original header/sub-line, no picker, and auto-starts', async () => {
    mount(['run-old', 'run-new'], { picker: false });
    await flush(3000);
    expect(screen.getByTestId('deep-dive-heading').textContent).toBe("What's actually different");
    expect(screen.queryByTestId('deep-dive-pair-picker')).toBeNull();
    expect(screen.queryByTestId('deep-dive-pair-hint')).toBeNull();
    expect(screen.queryByTestId('deep-dive-idle')).toBeNull();
    expect(postCalls()).toHaveLength(1);
  });
});
