/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * RTL tests for components/evals3/CaseTldrCard.tsx — #618: viewing a run
 * page must not call a model. `fetch` is spied at the window level (the real
 * services/client/caseSummaryApi.ts runs), so "no request" means no HTTP
 * request of any kind, not "a mocked helper was not called".
 *
 * States pinned:
 *   - judged by an LLM, nothing persisted → Summarize button, verdict row
 *     deterministic, ZERO requests on mount; click → exactly one POST with
 *     generate:true, force:false; the AI summary renders as its own labelled row with the
 *     full model id; Regenerate → one more POST with force:true.
 *   - persisted summary on the report → shown at mount ("cached"), zero requests.
 *   - persisted but stale (re-judged later) → not shown; Summarize offered.
 *   - deterministic-only (code checks, no judge) → no button at all, verdict
 *     built from the failing check's errorMessage, zero requests.
 *   - unjudged (agent error) → no button, zero requests.
 *   - request failure → honest note + "Retry summary"; the verdict row stays.
 *   - report switch → the previous report's summary never shows for the next.
 */

import * as React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CaseTldrCard } from '@/components/evals3/CaseTldrCard';
import type { CaseSummary, TestCase, TestCaseRun } from '@/types';

const MODEL = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';

function testCase(overrides: Partial<TestCase> = {}): TestCase {
  return {
    id: 'tc-1', name: 'brand filter case', description: '', labels: [], category: 'Test' as any, difficulty: 'Easy' as any,
    currentVersion: 1, versions: [], isPromoted: true, createdAt: '', updatedAt: '', context: [],
    initialPrompt: 'Find running shoes from the requested brand under 120.',
    expectedOutcomes: ['The top 3 results all carry the requested brand'],
    ...overrides,
  } as TestCase;
}
function report(overrides: Partial<TestCaseRun> = {}): TestCaseRun {
  return {
    id: 'report-1', timestamp: '', testCaseId: 'tc-1', agentName: 'Example search agent', modelName: 'demo-model',
    status: 'completed', metricsStatus: 'ready', passFailStatus: 'failed', score: 0.3,
    trajectory: [
      { id: 's1', type: 'action', toolName: 'search', toolArgs: { q: 'running shoes' }, timestamp: 1 } as any,
      { id: 's2', type: 'response', content: 'Here are three running shoes under 120.', timestamp: 2 } as any,
    ],
    metrics: {} as any,
    llmJudgeReasoning: 'Two of the three top results are from a different brand, so the brand condition is not met.',
    judgeModel: MODEL, judgeModelId: MODEL, evaluatorId: 'ev-1',
    ...overrides,
  } as TestCaseRun;
}
const CHECKS_ONLY: Partial<TestCaseRun> = {
  llmJudgeReasoning: '', judgeProvider: 'none', judgeModel: undefined, judgeModelId: undefined, evaluatorId: undefined, score: undefined,
  matcherResults: [
    { description: '[ Array(3) ] to have a length of 3', pass: true, method: 'code-assertion' },
    { description: 'false to equal true', pass: false, method: 'code-assertion', errorMessage: 'top-3 results must all carry the requested brand: brand_matches=1 (need ≥ 3), documents=3 (request 7f1a): expected false to equal true' },
  ] as any,
};
const llmSummary = (over: Partial<CaseSummary> = {}): CaseSummary => ({
  source: 'llm',
  parts: { asked: 'ignored', agent: 'ignored', verdict: 'Judge verdict: FAILED (score 30%) — the expected product was not in the top 3.' },
  reason: 'the expected product was not in the top 3',
  model: MODEL, generatedAt: '2026-11-05T12:00:00.000Z', inputsHash: 'abc',
  ...over,
});

// jsdom ships no fetch: install one on the global the client module calls, so
// the REAL fetchCaseSummary runs and every HTTP request is counted.
const fetchSpy = jest.fn();
const jsonResponse = (body: unknown, status = 200) => Promise.resolve({ ok: status < 400, status, json: async () => body } as Response);

beforeEach(() => {
  fetchSpy.mockReset().mockImplementation(() => jsonResponse({ summary: llmSummary(), cached: false }));
  (globalThis as any).fetch = fetchSpy;
});
afterEach(() => { delete (globalThis as any).fetch; });

const render_ = (r: TestCaseRun, tc: TestCase | null = testCase(), status: any = 'failed') =>
  render(React.createElement(CaseTldrCard, { report: r, testCase: tc, status }));

describe('CaseTldrCard — #618 no model call on view', () => {
  it('LLM-judged report with no persisted summary: deterministic verdict, Summarize button, ZERO requests on mount', async () => {
    render_(report());
    const card = screen.getByTestId('case-tldr');
    expect(card.getAttribute('data-state')).toBe('idle');
    expect(card.getAttribute('data-source')).toBe('deterministic');
    expect(card.getAttribute('data-summarizable')).toBe('true');
    expect(screen.getByTestId('case-tldr-verdict').textContent).toBe('Judge verdict: FAILED (score 30%) — Two of the three top results are from a different brand, so the brand condition is not met.');
    expect(screen.getByTestId('case-tldr-summarize').textContent).toContain('Summarize');
    expect(screen.queryByTestId('case-tldr-model-summary')).toBeNull();
    expect(screen.queryByTestId('case-tldr-source')).toBeNull();
    // Give any effect a chance to fire — nothing may leave the browser.
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('click Summarize → exactly one POST (force:false); the AI summary is its own labelled row with the full model id; Regenerate → force:true', async () => {
    render_(report());
    fireEvent.click(screen.getByTestId('case-tldr-summarize'));
    expect(screen.getByTestId('case-tldr').getAttribute('data-state')).toBe('loading');
    expect(screen.getByTestId('case-tldr-skeleton').textContent).toContain('summarizing');
    await waitFor(() => expect(screen.getByTestId('case-tldr').getAttribute('data-state')).toBe('ready'));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe('/api/storage/runs/report-1/summary');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ generate: true, force: false });

    // The verdict row is untouched (the judge's own reason), the model's text is a separate row.
    expect(screen.getByTestId('case-tldr-verdict').textContent).toContain('Two of the three top results are from a different brand');
    expect(screen.getByTestId('case-tldr-model-label').textContent).toContain('AI summary');
    expect(screen.getByTestId('case-tldr-model-summary').textContent).toContain('the expected product was not in the top 3');
    const attribution = screen.getByTestId('case-tldr-model-attribution').textContent!;
    expect(attribution).toContain(`Model-generated summary by ${MODEL}`);
    expect(attribution).toContain("not the judge's verdict");
    expect(attribution).not.toContain('cached');
    expect(screen.getByTestId('case-tldr-source').textContent).toContain('Model summary · claude-sonnet-4-5');
    expect(screen.getByTestId('case-tldr').getAttribute('data-source')).toBe('llm');
    expect(screen.queryByTestId('case-tldr-summarize')).toBeNull();

    fetchSpy.mockImplementationOnce(() => jsonResponse({ summary: llmSummary({ reason: 'second opinion' }), cached: false }));
    fireEvent.click(screen.getByTestId('case-tldr-regenerate'));
    await waitFor(() => expect(screen.getByTestId('case-tldr-model-summary').textContent).toContain('second opinion'));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchSpy.mock.calls[1][1].body)).toEqual({ generate: true, force: true });
  });

  it('a summary persisted on the report is shown at mount, marked cached, with ZERO requests', async () => {
    render_(report({ caseSummary: llmSummary() }));
    const card = screen.getByTestId('case-tldr');
    expect(card.getAttribute('data-state')).toBe('ready');
    expect(card.getAttribute('data-source')).toBe('llm');
    expect(screen.getByTestId('case-tldr-model-summary').textContent).toContain('the expected product was not in the top 3');
    expect(screen.getByTestId('case-tldr-model-attribution').textContent).toContain('· cached');
    expect(screen.getByTestId('case-tldr-model-attribution').textContent).toContain(MODEL);
    expect(screen.queryByTestId('case-tldr-summarize')).toBeNull();
    expect(screen.getByTestId('case-tldr-regenerate')).toBeTruthy();
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a persisted summary written BEFORE a re-judge is stale: not shown, Summarize offered, still no request', async () => {
    render_(report({ caseSummary: llmSummary(), judgementRetriedAt: '2026-11-06T09:00:00.000Z', judgementRetryCount: 1 }));
    expect(screen.getByTestId('case-tldr').getAttribute('data-state')).toBe('idle');
    expect(screen.queryByTestId('case-tldr-model-summary')).toBeNull();
    expect(screen.getByTestId('case-tldr-summarize')).toBeTruthy();
    // Old summaries (pre-`reason`) still render from the verdict sentence once current.
    const { unmount } = render_(report({ id: 'report-old', caseSummary: llmSummary({ reason: undefined }) }));
    expect(screen.getAllByTestId('case-tldr-model-summary')[0].textContent).toContain('the expected product was not in the top 3.');
    unmount();
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('deterministic-only (code checks, no LLM judge): NO button, verdict from the failing check\'s errorMessage, ZERO requests', async () => {
    render_(report(CHECKS_ONLY));
    const card = screen.getByTestId('case-tldr');
    expect(card.getAttribute('data-summarizable')).toBe('false');
    expect(card.getAttribute('data-source')).toBe('deterministic');
    expect(screen.queryByTestId('case-tldr-summarize')).toBeNull();
    expect(screen.queryByTestId('case-tldr-regenerate')).toBeNull();
    expect(screen.queryByTestId('case-tldr-source')).toBeNull();
    expect(screen.getByTestId('case-tldr-verdict').textContent).toBe('Verdict: FAILED — 1 of 2 checks failed — top-3 results must all carry the requested brand: brand_matches 1 vs ≥ 3.');
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a stray persisted model summary on a deterministic-only report is NOT shown (the checks are the reason)', () => {
    render_(report({ ...CHECKS_ONLY, caseSummary: llmSummary({ parts: { asked: '', agent: '', verdict: 'Verdict: FAILED — the expected product was not in the top 3.' } }) }));
    expect(screen.queryByTestId('case-tldr-model-summary')).toBeNull();
    expect(screen.getByTestId('case-tldr').getAttribute('data-source')).toBe('deterministic');
  });

  it('unjudged (agent error): no button, "Not judged" verdict, ZERO requests', async () => {
    render_(report({ status: 'failed', metricsStatus: 'error', failureStage: 'agent', passFailStatus: undefined, score: undefined, trajectory: [], error: 'Agent request timed out after 30012ms', llmJudgeReasoning: '' }), testCase(), 'errored');
    expect(screen.getByTestId('case-tldr').getAttribute('data-summarizable')).toBe('false');
    expect(screen.queryByTestId('case-tldr-summarize')).toBeNull();
    expect(screen.getByTestId('case-tldr-verdict').textContent).toBe('Not judged: the agent request failed — Agent request timed out after 30012ms.');
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('request failure → honest note + Retry summary; the deterministic verdict stays; model unavailable (fallback) reads the same way', async () => {
    fetchSpy.mockImplementationOnce(() => jsonResponse({ error: 'storage exploded' }, 500));
    render_(report());
    fireEvent.click(screen.getByTestId('case-tldr-summarize'));
    await waitFor(() => expect(screen.getByTestId('case-tldr').getAttribute('data-state')).toBe('error'));
    expect(screen.getByTestId('case-tldr-fallback-note').textContent).toContain('Model summary unavailable (storage exploded)');
    expect(screen.getByTestId('case-tldr-verdict').textContent).toContain('Judge verdict: FAILED (score 30%) — Two of the three top results');
    expect(screen.getByTestId('case-tldr-summarize').textContent).toContain('Retry summary');
    expect(screen.queryByTestId('case-tldr-model-summary')).toBeNull();

    fetchSpy.mockImplementationOnce(() => jsonResponse({ summary: { ...llmSummary(), source: 'fallback', reason: undefined, model: undefined, error: 'summary model did not answer within 20 s' }, cached: false }));
    fireEvent.click(screen.getByTestId('case-tldr-summarize'));
    await waitFor(() => expect(screen.getByTestId('case-tldr-fallback-note').textContent).toContain('did not answer within 20 s'));
    expect(screen.getByTestId('case-tldr').getAttribute('data-source')).toBe('deterministic');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('switching to another report never shows the previous report\'s summary', async () => {
    const { rerender } = render_(report());
    fireEvent.click(screen.getByTestId('case-tldr-summarize'));
    await waitFor(() => expect(screen.getByTestId('case-tldr').getAttribute('data-state')).toBe('ready'));
    rerender(React.createElement(CaseTldrCard, { report: report({ id: 'report-2', llmJudgeReasoning: 'Different case, different judge text.' }), testCase: testCase(), status: 'failed' }));
    expect(screen.getByTestId('case-tldr').getAttribute('data-state')).toBe('idle');
    expect(screen.queryByTestId('case-tldr-model-summary')).toBeNull();
    expect(screen.getByTestId('case-tldr-verdict').textContent).toContain('Different case, different judge text.');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
