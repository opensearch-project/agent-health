/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * RTL render tests for the deep-dive panel with EXACTLY TWO runs (owner
 * report, 2026-10-15: the "What's actually different" section was missing
 * even with two runs selected).
 *
 * Root cause: the panel read its report-id pair ONLY from the comparison
 * rows, and `buildTestCaseComparisonRows` puts a reportId on a row only once
 * the browser has downloaded that report doc. So for the whole (slow) reports
 * fetch — and forever, if that fetch failed — `pair` was null and the panel
 * returned null: no header, no placeholder, no message.
 *
 * Mounts the REAL ComparisonDeepDive with `fetch` and `localStorage` faked:
 *  - rows without reportIds + run docs WITH them → the panel renders; while
 *    `reportsLoading` it shows a loading line and does NOT POST; once the
 *    reports are in it auto-starts with the run docs' report ids
 *  - reports FAILED to load → mounted, no auto-start, "Generate anyway"
 *  - a cached narrative is served even while reports are loading
 *  - a reports reload mid-job never cancels/relaunches the job
 *  - no test case with a report on both sides → the panel renders an explicit
 *    message instead of returning null
 */

import * as React from 'react';
import { render, screen, act, cleanup, fireEvent } from '@testing-library/react';

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: string }) => React.createElement('div', { 'data-testid': 'md' }, children),
}));
jest.mock('remark-gfm', () => () => {});

import { ComparisonDeepDive } from '@/components/comparison/ComparisonDeepDive';

const FABLE = 'us.anthropic.claude-fable-5-1';

// The module-level result cache is keyed by report-id pair → unique ids per test.
let seq = 0;
const rep = (side: 'a' | 'b', tc: string) => `rep-${side}-${tc}-${seq}`;
const runs = (): any[] => [
  {
    id: 'run-a', agentKey: 'agent-a', name: 'Baseline', createdAt: '2026-10-01T10:00:00Z',
    testCaseSnapshots: [{ id: 'tc-1', version: 1, name: 'Case One' }],
    results: { 'tc-1': { reportId: rep('a', 'tc-1'), status: 'failed' }, 'tc-2': { reportId: rep('a', 'tc-2'), status: 'completed' } },
  },
  {
    id: 'run-b', agentKey: 'agent-b', name: 'Candidate', createdAt: '2026-10-02T10:00:00Z',
    results: { 'tc-1': { reportId: rep('b', 'tc-1'), status: 'completed' }, 'tc-2': { reportId: rep('b', 'tc-2'), status: 'completed' } },
  },
];
/** Rows exactly as the page builds them BEFORE the report docs are loaded. */
const unloadedRows = (): any[] => ['tc-1', 'tc-2'].map((tc) => ({
  testCaseId: tc, testCaseName: `Case ${tc}`, results: { 'run-a': { status: 'missing' }, 'run-b': { status: 'missing' } },
}));

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

function mount(overrides: Record<string, unknown> = {}) {
  const props: Record<string, unknown> = {
    runs: runs(),
    rows: unloadedRows(),
    reports: {},
    getAgentName: (k: string) => `Agent(${k})`,
    onSpanLink: () => {},
    onWindowAgents: () => {},
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

describe('ComparisonDeepDive — two runs, report ids not (yet) on the rows', () => {
  it('stays mounted while the reports load (no POST), then auto-starts with the run docs\' report ids', async () => {
    const view = mount({ reportsLoading: true });
    await flush(3000);

    // The regression: this whole block used to be absent from the page.
    expect(screen.getByTestId('comparison-deep-dive')).toBeTruthy();
    expect(screen.getByTestId('deep-dive-heading').textContent).toBe("What's actually different");
    expect(screen.getByTestId('deep-dive-reports-loading')).toBeTruthy();
    expect(screen.queryByTestId('deep-dive-no-shared-case')).toBeNull();
    expect(screen.queryByTestId('deep-dive-loading')).toBeNull();
    expect(postCalls()).toHaveLength(0);

    // Reports arrive (rows now carry the same ids) → one generation, keyed on the first shared case.
    view.rerender({ reportsLoading: false });
    await flush(3000);
    expect(screen.queryByTestId('deep-dive-reports-loading')).toBeNull();
    expect(postCalls()).toHaveLength(1);
    expect(postCalls()[0].body.reportIds).toEqual([rep('a', 'tc-1'), rep('b', 'tc-1')]);
    expect(screen.getByTestId('md').textContent).toBe(`narrative for ${rep('a', 'tc-1')}+${rep('b', 'tc-1')}`);
  });

  it('reports failed to load: stays mounted, does NOT auto-start, and "Generate anyway" posts the run docs\' report ids', async () => {
    mount({ reportsLoading: false, reportsFailed: true });
    await flush(3000);
    expect(screen.getByTestId('comparison-deep-dive')).toBeTruthy();
    expect(screen.getByTestId('deep-dive-reports-failed')).toBeTruthy();
    expect(screen.queryByTestId('deep-dive-idle')).toBeNull();
    expect(postCalls()).toHaveLength(0);

    fireEvent.click(screen.getByTestId('deep-dive-generate-anyway'));
    await flush(3000);
    expect(postCalls()).toHaveLength(1);
    expect(postCalls()[0].body.reportIds).toEqual([rep('a', 'tc-1'), rep('b', 'tc-1')]);
    expect(screen.getByTestId('md').textContent).toBe(`narrative for ${rep('a', 'tc-1')}+${rep('b', 'tc-1')}`);
    expect(screen.queryByTestId('deep-dive-reports-failed')).toBeNull();
  });

  it('a reports reload flipping `reportsLoading` while a job is in flight neither cancels nor relaunches it', async () => {
    const view = mount({ reportsLoading: false });
    await flush(0);
    expect(postCalls()).toHaveLength(1); // POST sent, poll pending
    view.rerender({ reportsLoading: true });
    await flush(0);
    view.rerender({ reportsLoading: false });
    await flush(3000);
    expect(postCalls()).toHaveLength(1);
    expect(screen.getByTestId('md').textContent).toBe(`narrative for ${rep('a', 'tc-1')}+${rep('b', 'tc-1')}`);
  });

  it('serves a cached narrative immediately even while the reports are still loading', async () => {
    const first = mount({ reportsLoading: false });
    await flush(3000);
    expect(postCalls()).toHaveLength(1);
    first.unmount();

    installFetch(); // fresh call log; same report ids → same cache key
    mount({ reportsLoading: true });
    await flush(3000);
    expect(postCalls()).toHaveLength(0);
    expect(screen.queryByTestId('deep-dive-reports-loading')).toBeNull();
    expect(screen.getByTestId('md').textContent).toBe(`narrative for ${rep('a', 'tc-1')}+${rep('b', 'tc-1')}`);
  });

  it('with no test case completed on both sides it renders an explicit message instead of nothing', async () => {
    const [a, b] = runs();
    b.results = { 'tc-9': { reportId: rep('b', 'tc-9'), status: 'completed' } };
    const rows = ['tc-1', 'tc-2', 'tc-9'].map((tc) => ({ testCaseId: tc, testCaseName: tc, results: { 'run-a': { status: 'missing' }, 'run-b': { status: 'missing' } } }));
    mount({ runs: [a, b], rows, reportsLoading: false });
    await flush(3000);
    expect(screen.getByTestId('comparison-deep-dive')).toBeTruthy();
    expect(screen.getByTestId('deep-dive-no-shared-case').textContent)
      .toBe('The deep-dive needs at least one test case that both runs completed — none found.');
    expect(screen.queryByTestId('deep-dive-reports-loading')).toBeNull();
    expect(postCalls()).toHaveLength(0);
  });
});
