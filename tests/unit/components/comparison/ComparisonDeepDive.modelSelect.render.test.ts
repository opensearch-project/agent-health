/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * RTL render tests for the deep-dive panel's model selector + the lifted
 * client-side deadline (owner asks: "What model is run for What's actually
 * different? I want it to be Fable 5.1." / "My comparison times out after
 * 180 seconds, remove this limit.").
 *
 * Mounts the REAL ComparisonDeepDive with `fetch` and `localStorage` faked:
 *  - selector renders the server's list, defaults to Fable 5.1 (defaultId)
 *  - the FIRST POST already carries that modelId (auto-run waits for the list)
 *  - a persisted localStorage choice wins over the default and is sent
 *  - changing the selector persists to localStorage + starts a new generation
 *  - the spinner shows the model + a m/s elapsed label and keeps polling past
 *    the old 200s client cap while the job says 'running'
 *  - the footer shows the model the server actually used
 */

import * as React from 'react';
import { render, screen, act, fireEvent, cleanup } from '@testing-library/react';

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: string }) => React.createElement('div', { 'data-testid': 'md' }, children),
}));
jest.mock('remark-gfm', () => () => {});

import {
  ComparisonDeepDive,
  MODEL_CACHE_KEY,
  resolveDeepDiveModelId,
  formatElapsedSec,
} from '@/components/comparison/ComparisonDeepDive';

const FABLE = 'us.anthropic.claude-fable-5-1';
const SONNET = 'us.anthropic.claude-sonnet-4-6';
const MODELS = [
  { provider: 'amazon-bedrock', id: FABLE, name: 'Claude Fable 5.1 (US)' },
  { provider: 'amazon-bedrock', id: SONNET, name: 'Claude Sonnet 4.6 (US)' },
];

const runs: any[] = [
  { id: 'run-a', agentKey: 'agent-a' },
  { id: 'run-b', agentKey: 'agent-b' },
];
// The panel's result cache is module-level (in-memory + localStorage) and
// keyed by report-id pair, so every test gets its OWN pair to stay isolated.
let pairSeq = 0;
let repA = 'rep-a-0';
let repB = 'rep-b-0';
const makeRows = (): any[] => [
  { testCaseId: 'tc-1', testCaseName: 'Case 1', results: { 'run-a': { reportId: repA, passFailStatus: 'passed', accuracy: 90 }, 'run-b': { reportId: repB, passFailStatus: 'failed', accuracy: 40 } } },
];

type FetchCall = { url: string; body?: any };
let calls: FetchCall[];
let jobStatus: 'running' | 'done';
let modelsResponse: any;

function installFetch() {
  calls = [];
  jobStatus = 'done';
  modelsResponse = { models: MODELS, defaultId: FABLE };
  (global as any).fetch = jest.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    const json = (data: unknown, ok = true, status = 200) => ({ ok, status, json: async () => data }) as any;
    if (url.endsWith('/api/comparison/deep-dive/models')) return json(modelsResponse);
    if (url.endsWith('/api/comparison/deep-dive/system-prompt')) return json({ systemPrompt: 'DEFAULT' });
    if (url.endsWith('/api/comparison/deep-dive')) return json({ jobId: 'job-1' }, true, 202);
    if (url.includes('/api/comparison/deep-dive/jobs/')) {
      if (jobStatus === 'running') return json({ status: 'running', elapsedMs: 1000 });
      const post = [...calls].reverse().find((c) => c.url.endsWith('/api/comparison/deep-dive') && c.body);
      const usedModel = post?.body?.modelId ?? 'server-default-model';
      return json({ status: 'done', elapsedMs: 1000, result: { markdown: `narrative by ${usedModel}`, modelId: `amazon-bedrock/${usedModel}`, durationMs: 412_000, runs: [] } });
    }
    return json({}, false, 404);
  });
}

function mount() {
  return render(
    React.createElement(ComparisonDeepDive, {
      runs,
      rows: makeRows(),
      reports: {},
      getAgentName: (k: string) => k,
      onSpanLink: () => {},
      onWindowAgents: () => {},
    })
  );
}

const postCalls = () => calls.filter((c) => c.url.endsWith('/api/comparison/deep-dive') && c.body);
// Advance fake time inside act(). Always settles pending microtasks first
// (flush(0)) so fetches resolved "now" schedule their timers before we
// advance the clock.
const flush = async (ms = 0) => {
  await act(async () => { await jest.advanceTimersByTimeAsync(0); });
  if (ms > 0) await act(async () => { await jest.advanceTimersByTimeAsync(ms); });
};

beforeEach(() => {
  jest.useFakeTimers();
  localStorage.clear();
  pairSeq += 1;
  repA = `rep-a-${pairSeq}`;
  repB = `rep-b-${pairSeq}`;
  installFetch();
});
afterEach(() => {
  cleanup();
  jest.useRealTimers();
});

describe('resolveDeepDiveModelId (pure)', () => {
  it('prefers a persisted choice that is still offered, else the server default, else undefined', () => {
    expect(resolveDeepDiveModelId(SONNET, MODELS, FABLE)).toBe(SONNET);
    expect(resolveDeepDiveModelId('stale.model', MODELS, FABLE)).toBe(FABLE);
    expect(resolveDeepDiveModelId(null, MODELS, FABLE)).toBe(FABLE);
    expect(resolveDeepDiveModelId(null, [], null)).toBeUndefined();
  });
});

describe('formatElapsedSec', () => {
  it('renders minutes once past 60s', () => {
    expect(formatElapsedSec(42)).toBe('42s');
    expect(formatElapsedSec(95)).toBe('1m 35s');
    expect(formatElapsedSec(600)).toBe('10m 0s');
  });
});

describe('ComparisonDeepDive — model selector', () => {
  it('renders the selector defaulting to Fable 5.1 and the FIRST generation already carries that modelId', async () => {
    mount();
    await flush(0);
    const select = screen.getByTestId('deep-dive-model-select') as HTMLSelectElement;
    expect(select.value).toBe(FABLE);
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['Claude Fable 5.1 (US)', 'Claude Sonnet 4.6 (US)']);

    await flush(3000); // one poll tick
    expect(postCalls()).toHaveLength(1);
    expect(postCalls()[0].body.modelId).toBe(FABLE);
    expect(postCalls()[0].body.reportIds).toEqual([repA, repB]);
    // Footer shows the model the server reported it actually used.
    expect(screen.getByTestId('deep-dive-footer').textContent).toContain('us.anthropic.claude-fable-5-1');
    expect(screen.getByTestId('deep-dive-footer').textContent).toContain('412s');
  });

  it('a persisted localStorage choice wins over the server default and is sent on the request', async () => {
    localStorage.setItem(MODEL_CACHE_KEY, SONNET);
    mount();
    await flush(3000);
    expect((screen.getByTestId('deep-dive-model-select') as HTMLSelectElement).value).toBe(SONNET);
    expect(postCalls()[0].body.modelId).toBe(SONNET);
  });

  it('a stale persisted id no longer offered falls back to the server default', async () => {
    localStorage.setItem(MODEL_CACHE_KEY, 'us.anthropic.claude-gone-1');
    mount();
    await flush(3000);
    expect((screen.getByTestId('deep-dive-model-select') as HTMLSelectElement).value).toBe(FABLE);
    expect(postCalls()[0].body.modelId).toBe(FABLE);
  });

  it('changing the model persists to localStorage, invalidates the cached result for the pair and generates with the new model', async () => {
    mount();
    await flush(3000);
    expect(postCalls()).toHaveLength(1);
    expect(screen.getByTestId('md').textContent).toBe(`narrative by ${FABLE}`);

    fireEvent.change(screen.getByTestId('deep-dive-model-select'), { target: { value: SONNET } });
    expect(localStorage.getItem(MODEL_CACHE_KEY)).toBe(SONNET);
    await flush(3000);
    expect(postCalls()).toHaveLength(2);
    expect(postCalls()[1].body.modelId).toBe(SONNET);
    expect(screen.getByTestId('md').textContent).toBe(`narrative by ${SONNET}`);

    // Switching BACK serves the Fable narrative from cache — no third POST.
    fireEvent.change(screen.getByTestId('deep-dive-model-select'), { target: { value: FABLE } });
    await flush(3000);
    expect(postCalls()).toHaveLength(2);
    expect(screen.getByTestId('md').textContent).toBe(`narrative by ${FABLE}`);
  });

  it('a hung models request never blocks the panel: after the 10s bound it generates with the server default', async () => {
    // Make ONLY the models fetch hang until aborted (AbortSignal.timeout).
    const realFetch = (global as any).fetch;
    (global as any).fetch = jest.fn((url: string, init?: RequestInit) => {
      if (url.endsWith('/api/comparison/deep-dive/models')) {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'TimeoutError')));
        });
      }
      return realFetch(url, init);
    });
    mount();
    await flush(5000);
    expect(postCalls()).toHaveLength(0); // still waiting on the (bounded) models fetch
    await flush(6000); // past the 10s bound → abort → modelsLoaded → auto-run
    await flush(3000);
    expect(postCalls()).toHaveLength(1);
    expect(postCalls()[0].body).not.toHaveProperty('modelId');
    expect(screen.queryByTestId('deep-dive-model-select')).toBeNull();
  });

  it('omits modelId (server default) and hides the selector when the server offers no models', async () => {
    modelsResponse = { models: [], defaultId: null };
    mount();
    await flush(3000);
    expect(screen.queryByTestId('deep-dive-model-select')).toBeNull();
    expect(postCalls()).toHaveLength(1);
    expect(postCalls()[0].body).not.toHaveProperty('modelId');
  });
});

describe('ComparisonDeepDive — no client-side deadline; legible long waits', () => {
  it('shows the model + m/s elapsed time while loading and keeps polling well past the old 200s cap while the job is running', async () => {
    jobStatus = 'running';
    mount();
    await flush(1000);
    expect(screen.getByTestId('deep-dive-loading')).toBeTruthy();
    expect(screen.getByTestId('deep-dive-loading-model').textContent).toContain('Claude Fable 5.1 (US)');
    expect(screen.getByTestId('deep-dive-loading-elapsed').textContent).toBe('(1s)');
    // Selector is locked while a generation is in flight.
    expect((screen.getByTestId('deep-dive-model-select') as HTMLSelectElement).disabled).toBe(true);

    await flush(94_000);
    expect(screen.getByTestId('deep-dive-loading-elapsed').textContent).toBe('(1m 35s)');
    expect(screen.getByTestId('deep-dive-loading-model').textContent).toMatch(/no time limit/);

    // 6 minutes in (well past the old 200s client budget): still loading,
    // still polling, NO "Timed out" error.
    await flush(6 * 60_000 - 95_000);
    expect(screen.getByTestId('deep-dive-loading')).toBeTruthy();
    expect(screen.queryByText(/Timed out/)).toBeNull();
    expect(screen.queryByText(/Couldn't generate/)).toBeNull();
    const pollsSoFar = calls.filter((c) => c.url.includes('/jobs/')).length;
    expect(pollsSoFar).toBeGreaterThan(100); // ~2.5s cadence over 6 min

    // ...and the eventual result lands normally.
    jobStatus = 'done';
    await flush(3000);
    expect(screen.getByTestId('md').textContent).toBe(`narrative by ${FABLE}`);
    expect(screen.queryByTestId('deep-dive-loading')).toBeNull();
  });
});
