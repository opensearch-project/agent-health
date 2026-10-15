/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * RTL render tests for two owner reports on the live compare page (two runs,
 * same agent and benchmark):
 *
 *  1. DOUBLE DEEP-DIVE JOB — opening the page fired TWO
 *     `POST /api/comparison/deep-dive` ~70 ms apart (different job ids); only
 *     the second was polled/rendered, so one full LLM generation was wasted
 *     per visit. Root cause: the representative case (whose report-id pair is
 *     the cache key) was "the first row in table order", and the table
 *     re-sorts (category, then name) when the test-case metadata arrives a
 *     moment after the reports — a different first row → a different cache
 *     key → the auto-start effect ran again. The pick is now the lowest
 *     testCaseId, which never moves. These tests mount the REAL panel and
 *     count POSTs across (a) the model default arriving after mount and
 *     (b) the rows being renamed + re-sorted after the first POST.
 *
 *  2. HEADLINE NUMBERS — the narrative's pass counts disagreed with the
 *     scoreboard. The page now passes deterministic `facts`; the panel sends
 *     them with the job and renders them as a data line above the narrative.
 */

import * as React from 'react';
import { render, screen, act, cleanup } from '@testing-library/react';

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: string }) => React.createElement('div', { 'data-testid': 'md' }, children),
}));
jest.mock('remark-gfm', () => () => {});

import { ComparisonDeepDive } from '@/components/comparison/ComparisonDeepDive';
import type { DeepDiveFacts } from '@/lib/comparison/deepDiveFacts';

const FABLE = 'us.anthropic.claude-fable-5-1';

// The module-level result cache is keyed by report-id pair → unique ids per test.
let seq = 0;
const rep = (side: 'a' | 'b', tc: string) => `rep-${side}-${tc}-${seq}`;
const CASES = ['tc-1', 'tc-2'];
const runs = (): any[] => [
  { id: 'run-a', agentKey: 'agent-a', name: 'Baseline', createdAt: '2026-10-01T10:00:00Z', results: Object.fromEntries(CASES.map((tc) => [tc, { reportId: rep('a', tc), status: 'completed' }])) },
  { id: 'run-b', agentKey: 'agent-b', name: 'Candidate', createdAt: '2026-10-02T10:00:00Z', results: Object.fromEntries(CASES.map((tc) => [tc, { reportId: rep('b', tc), status: 'completed' }])) },
];
/** Rows as the page builds them once the reports are loaded; `names` maps testCaseId → display name (default: the id). */
const loadedRows = (order: string[], names: Record<string, string> = {}): any[] => order.map((tc) => ({
  testCaseId: tc,
  testCaseName: names[tc] ?? tc,
  results: {
    'run-a': { reportId: rep('a', tc), status: 'completed', passFailStatus: 'failed', accuracy: 40 },
    'run-b': { reportId: rep('b', tc), status: 'completed', passFailStatus: 'passed', accuracy: 90 },
  },
}));

type FetchCall = { url: string; body?: any };
let calls: FetchCall[];
let modelsGate: Promise<void>;
function installFetch() {
  calls = [];
  modelsGate = Promise.resolve();
  (global as any).fetch = jest.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    const json = (data: unknown, ok = true, status = 200) => ({ ok, status, json: async () => data }) as any;
    if (url.endsWith('/api/comparison/deep-dive/models')) {
      await modelsGate;
      return json({ models: [{ provider: 'amazon-bedrock', id: FABLE, name: 'Fable' }], defaultId: FABLE });
    }
    if (url.endsWith('/api/comparison/deep-dive/system-prompt')) return json({ systemPrompt: 'DEFAULT' });
    if (url.endsWith('/api/comparison/deep-dive')) return json({ jobId: `job-${calls.length}` }, true, 202);
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

function mount(overrides: Record<string, unknown> = {}) {
  const props: Record<string, unknown> = {
    runs: runs(),
    rows: loadedRows(CASES),
    reports: {},
    getAgentName: (k: string) => `Agent(${k})`,
    onSpanLink: () => {},
    onWindowAgents: () => {},
    reportsLoading: false,
    ...overrides,
  };
  const utils = render(React.createElement(ComparisonDeepDive, props as any));
  return { ...utils, rerender: (next: Record<string, unknown>) => utils.rerender(React.createElement(ComparisonDeepDive, { ...props, ...next } as any)) };
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

describe('ComparisonDeepDive — exactly one job per visit', () => {
  it('the model default arriving AFTER mount (and after the reports) still yields exactly one POST, carrying that model', async () => {
    let releaseModels: () => void = () => {};
    modelsGate = new Promise<void>((resolve) => { releaseModels = resolve; });
    mount();
    await flush(500);
    // Reports are in, rows complete — but no job yet: the model is not settled.
    expect(postCalls()).toHaveLength(0);
    expect(screen.queryByTestId('deep-dive-loading')).toBeNull();

    releaseModels();
    await flush(3000);
    expect(postCalls()).toHaveLength(1);
    expect(postCalls()[0].body.modelId).toBe(FABLE);
    expect(screen.getByTestId('md').textContent).toBe(`narrative for ${rep('a', 'tc-1')}+${rep('b', 'tc-1')}`);
  });

  it('rows renamed and re-sorted after the first POST (test-case metadata landing late) do NOT launch a second job', async () => {
    // Before the metadata loads the page names rows by id and sorts by that: tc-1, tc-2.
    const view = mount({ rows: loadedRows(['tc-1', 'tc-2']) });
    await flush(0);
    expect(postCalls()).toHaveLength(1);
    expect(postCalls()[0].body.reportIds).toEqual([rep('a', 'tc-1'), rep('b', 'tc-1')]);

    // Metadata arrives ~70 ms later: real names, and the table re-sorts so tc-2 is now the FIRST row.
    view.rerender({ rows: loadedRows(['tc-2', 'tc-1'], { 'tc-1': 'Zebra case', 'tc-2': 'Alpha case' }) });
    await flush(70);
    await flush(3000);

    // The regression: a second POST for [rep-a-tc-2, rep-b-tc-2] ~70 ms after the first.
    expect(postCalls()).toHaveLength(1);
    expect(screen.getByTestId('md').textContent).toBe(`narrative for ${rep('a', 'tc-1')}+${rep('b', 'tc-1')}`);
  });

  it('a page that first shows the rows loading (reports + metadata), then complete, generates once', async () => {
    const view = mount({ reportsLoading: true, rows: loadedRows(['tc-2', 'tc-1']) });
    await flush(500);
    expect(postCalls()).toHaveLength(0);
    view.rerender({ reportsLoading: false, rows: loadedRows(['tc-1', 'tc-2'], { 'tc-1': 'B', 'tc-2': 'A' }) });
    await flush(3000);
    expect(postCalls()).toHaveLength(1);
    expect(postCalls()[0].body.reportIds).toEqual([rep('a', 'tc-1'), rep('b', 'tc-1')]);
  });
});

describe('ComparisonDeepDive — deterministic headline numbers (facts)', () => {
  const facts: DeepDiveFacts = {
    a: { passed: 29, failed: 33, errored: 0, pending: 0, evaluated: 62, total: 62 },
    b: { passed: 24, failed: 35, errored: 3, pending: 0, evaluated: 59, total: 62 },
    disagreements: 15, aWins: 10, bWins: 5, bothPassed: 40, bothFailed: 4, uncovered: 3,
  };

  it('renders the data line above the narrative and sends the same facts with the job', async () => {
    mount({ facts });
    await flush(3000);
    expect(screen.getByTestId('deep-dive-facts').textContent).toBe('A 29/62 · B 24/59 (3 errored) · 15 disagreements: A wins 10, B wins 5');
    expect(postCalls()).toHaveLength(1);
    expect(postCalls()[0].body.facts).toEqual(facts);
    // The line precedes the generated markdown in the DOM.
    const panel = screen.getByTestId('comparison-deep-dive');
    const order = Array.from(panel.querySelectorAll('[data-testid="deep-dive-facts"], [data-testid="md"]')).map((el) => el.getAttribute('data-testid'));
    expect(order).toEqual(['deep-dive-facts', 'md']);
  });

  it('renders no line before the narrative exists (loading / generating), and omits `facts` from the POST when the page has none', async () => {
    const view = mount({ facts, reportsLoading: true });
    await flush(500);
    expect(screen.queryByTestId('deep-dive-facts')).toBeNull();
    view.rerender({ facts, reportsLoading: false });
    await flush(0);
    expect(screen.getByTestId('deep-dive-loading')).toBeTruthy();
    expect(screen.queryByTestId('deep-dive-facts')).toBeNull();
    await flush(3000);
    expect(screen.getByTestId('md')).toBeTruthy();
    expect(screen.getByTestId('deep-dive-facts')).toBeTruthy();

    cleanup();
    installFetch();
    seq += 1;
    mount();
    await flush(3000);
    expect(screen.queryByTestId('deep-dive-facts')).toBeNull();
    expect(postCalls()).toHaveLength(1);
    expect(postCalls()[0].body).not.toHaveProperty('facts');
  });
});
