/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MatcherResultsPanel — judge-row redesign regression tests.
 *
 * Locks the three user-facing fixes from the judge-tab redesign:
 *   1. No "score 0%" fabricated headline (the accuracy-default bug) — the
 *      per-dimension judgeMetrics chips are the scannable verdict instead.
 *   2. Judge reasoning renders ONCE (pre-fix it was mirrored into
 *      errorMessage and both were shown).
 *   3. Failed judge rows answer "why did it fail" + "how do I fix it"
 *      up front: Why panel (from prose parse or structured extraFields)
 *      and Fix panel (from improvementStrategies).
 */

import * as React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MatcherResultsPanel } from '@/components/MatcherResultsPanel';
import type { MatcherResult } from '@/lib/matchers/types';

// react-markdown is ESM-only; mock like the other component suites do.
jest.mock('@/components/ui/markdown', () => ({
  Markdown: ({ children }: any) => React.createElement('div', { 'data-testid': 'markdown' }, children),
  hasRealMarkdown: () => false,
}));

/** JSX-free render helper (repo tests are .ts, not .tsx). */
const panel = (results: MatcherResult[]) =>
  render(React.createElement(MatcherResultsPanel, { results }));

// Verbatim reasoning shape from a real persisted run of a custom evaluator.
const REAL_REASONING = `The expected source document is article 49d9e88fadbf11fa4e685c847590078ff9394c2fe7566094f504f53ca4aca465. However, the agent retrieved a different article (b6c9353c0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5). Required facts evaluation: 1. 'You can start accepting payments almost immediately' — PARTIALLY stated. The agent frames it around a status with caveats. 2. 'Identity verification needed before full activation' — PARTIALLY stated. Not clearly stated.`;

function failedJudgeMatcher(overrides: Partial<MatcherResult> = {}): MatcherResult {
  return {
    description: 'judge: 2 claims',
    pass: false,
    method: 'llm-judge',
    role: 'gate',
    durationMs: 21906,
    score: 0, // the pre-fix fabricated zero — must NOT render as "score 0%"
    reasoning: REAL_REASONING,
    judgeMetrics: { answer_correctness: 55, trust_honesty: 45, readability: 75 },
    improvementStrategies: [
      {
        category: 'Correctness',
        issue: 'Wrong article retrieved',
        recommendation: 'Use targeted queries to surface the expected article.',
        priority: 'high',
      },
    ],
    ...overrides,
  };
}

describe('MatcherResultsPanel — failed judge row', () => {
  it('suppresses the fabricated score-0 headline but keeps dimension chips scannable', () => {
    panel([failedJudgeMatcher()]);
    expect(screen.queryByText(/score 0%/)).toBeNull();
    expect(screen.getByText(/answer correctness 55/)).toBeTruthy();
    expect(screen.getByText(/trust honesty 45/)).toBeTruthy();
    expect(screen.getByText(/readability 75/)).toBeTruthy();
  });

  it('still shows a real headline score when one exists', () => {
    panel([failedJudgeMatcher({ score: 0.55 })]);
    expect(screen.getByText(/score 55%/)).toBeTruthy();
  });

  it('renders Why-it-failed (source mismatch + fact counts from prose) and How-to-fix (strategies)', () => {
    panel([failedJudgeMatcher()]);
    expect(screen.getByText(/Why it failed/i)).toBeTruthy();
    expect(screen.getByText(/Wrong source cited/)).toBeTruthy();
    // Shortened ids from the parsed mismatch.
    expect(screen.getByText(/b6c9353c…/)).toBeTruthy();
    expect(screen.getByText(/49d9e88f…/)).toBeTruthy();
    expect(screen.getByText(/How to fix it/i)).toBeTruthy();
    expect(screen.getByText('Wrong article retrieved')).toBeTruthy();
    expect(screen.getByText(/targeted queries/)).toBeTruthy();
  });

  it('renders the per-fact checklist with verdict chips', () => {
    panel([failedJudgeMatcher()]);
    const partials = screen.getAllByText('PARTIAL');
    expect(partials.length).toBe(2);
    expect(screen.getByText(/“You can start accepting payments almost immediately”/)).toBeTruthy();
  });

  it('renders the reasoning exactly once even for old data where errorMessage mirrors it', () => {
    // Old persisted rows carry errorMessage === reasoning (the write-path
    // mirror this change removed). The panel must not render it twice.
    const { container } = panel([failedJudgeMatcher({ errorMessage: REAL_REASONING })]);
    // Reasoning lives in a collapsed <details>; open it.
    fireEvent.click(screen.getByText(/Full judge reasoning/));
    const occurrences = container.textContent!.split('However, the agent retrieved a different article').length - 1;
    expect(occurrences).toBe(1);
    // And no red error: line for the mirrored copy.
    expect(screen.queryByText(/^error:$/)).toBeNull();
  });

  it('shows a DISTINCT errorMessage (real endpoint errors) in red', () => {
    panel([
          failedJudgeMatcher({
            errorMessage: 'Judge request failed after 3 attempts: fetch failed',
            reasoning: '',
            judgeMetrics: undefined,
            improvementStrategies: undefined,
          }),
        ]);
    expect(screen.getByText(/Judge request failed after 3 attempts/)).toBeTruthy();
  });

  it('prefers structured judgeExtraFields (facts + failure_causes) over the prose parse', () => {
    panel([
          failedJudgeMatcher({
            judgeExtraFields: {
              failure_causes: [{ cause: 'Structured cause wins', detail: 'from the judge JSON' }],
              facts: [{ fact: 'structured fact', verdict: 'missing', rationale: 'never mentioned' }],
            },
          }),
        ]);
    expect(screen.getByText('Structured cause wins')).toBeTruthy();
    expect(screen.getByText(/“structured fact”/)).toBeTruthy();
    expect(screen.getByText('MISSING')).toBeTruthy();
    // Prose-parsed facts must NOT also render (structured wins).
    expect(screen.queryByText(/“You can start accepting payments almost immediately”/)).toBeNull();
  });
});

describe('MatcherResultsPanel — passed judge row', () => {
  it('is collapsed by default and reveals suggestions on expand', () => {
    const passed = failedJudgeMatcher({
      pass: true,
      score: 1,
      judgeMetrics: { answer_correctness: 100, trust_honesty: 90, readability: 92 },
      improvementStrategies: [
        { category: 'Readability', issue: 'Raw IDs in citations', recommendation: 'Use titles.', priority: 'low' },
      ],
    });
    panel([passed]);
    // Collapsed: no Why/Fix/suggestions visible.
    expect(screen.queryByText(/suggestion/)).toBeNull();
    // Chips still scannable from the header.
    expect(screen.getByText(/answer correctness 100/)).toBeTruthy();
    // Expand.
    fireEvent.click(screen.getByText('judge: 2 claims'));
    expect(screen.getByText(/1 suggestion from the judge/)).toBeTruthy();
  });
});

describe('MatcherResultsPanel — non-judge rows unchanged', () => {
  it('renders code-assertion pass/fail with expected/actual', () => {
    const results: MatcherResult[] = [
      { description: 'true to equal true', pass: true, method: 'code-assertion' },
      {
        description: 'to be lessThan 30000',
        pass: false,
        method: 'code-assertion',
        expected: 30000,
        actual: 47320,
        errorMessage: 'expected 47320 to be below 30000',
      },
    ];
    panel(results);
    expect(screen.getByText('true to equal true')).toBeTruthy();
    expect(screen.getByText(/expected 47320 to be below 30000/)).toBeTruthy();
    expect(screen.getByText('47320')).toBeTruthy();
  });

  it('renders nothing for an empty result set', () => {
    const { container } = panel([]);
    expect(container.textContent).toBe('');
  });
});

describe('MatcherResultsPanel — genuine zero scores stay visible', () => {
  it('shows score 0% when the dimensions are consistently zero (real total failure, not the bug)', () => {
    panel([
      failedJudgeMatcher({
        score: 0,
        judgeMetrics: { answer_correctness: 0, trust_honesty: 0 },
        reasoning: 'Complete fabrication; every fact contradicted.',
        improvementStrategies: undefined,
      }),
    ]);
    expect(screen.getByText(/score 0%/)).toBeTruthy();
  });
});

describe('MatcherResultsPanel — row interaction and value formatting', () => {
  it('toggles a code-assertion row open/closed with the keyboard', () => {
    panel([
      {
        description: 'to deep equal',
        pass: true,
        method: 'code-assertion',
        expected: { a: 1, list: [1, 2, 3] },
        actual: { a: 2, list: null },
      },
    ]);
    // Collapsed (passed rows start closed) — no expected/actual visible.
    expect(screen.queryByText(/expected:/)).toBeNull();
    const row = screen.getByRole('button');
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(screen.getByText(/expected:/)).toBeTruthy();
    // Objects are JSON-formatted.
    expect(screen.getByText(/"list": \[/)).toBeTruthy();
    fireEvent.keyDown(row, { key: ' ' });
    expect(screen.queryByText(/expected:/)).toBeNull();
  });

  it('truncates long string values and renders null/undefined/boolean actuals', () => {
    const long = 'x'.repeat(250);
    panel([
      {
        description: 'long string',
        pass: false,
        method: 'code-assertion',
        expected: long,
        actual: null,
      },
    ]);
    // Failed rows start open; long strings truncate with an ellipsis.
    expect(screen.getByText(new RegExp(`"x{50}`))).toBeTruthy();
    expect(screen.getByText('null')).toBeTruthy();
  });

  it('toggles a judge row with the keyboard too', () => {
    const passed = failedJudgeMatcher({ pass: true, score: 0.9 });
    panel([passed]);
    expect(screen.queryByText(/Full judge reasoning/)).toBeNull();
    fireEvent.keyDown(screen.getByRole('button'), { key: 'Enter' });
    expect(screen.getByText(/Full judge reasoning/)).toBeTruthy();
  });

  it('renders traces/evaluator method badges via the shared row', () => {
    panel([
      { description: 'traces.totalTokens < 10000', pass: true, method: 'traces' },
      { description: 'custom evaluator ran', pass: true, method: 'evaluator' },
    ]);
    expect(screen.getByText('traces')).toBeTruthy();
    expect(screen.getByText('evaluator')).toBeTruthy();
  });
});

// ─── not-reached rendering (runner-appended marker) ─────────────────────────
//
// A matcher that never executed because an earlier assertion threw used to be
// simply absent from the panel — indistinguishable from "this test had fewer
// claims than expected". The runner appends a synthetic `notReached: true`
// entry (see appendNotReachedMarker in services/evaluation/index.ts); the
// panel must render it distinctly from both a pass and a genuine failure and
// exclude it from the passed/failed header counts (own "N not reached" tally).

const passingCode: MatcherResult = {
  description: 'expected to contain root cause',
  pass: true,
  method: 'code-assertion',
};

const failingGate: MatcherResult = {
  description: 'expected totalTokens to be below 10000',
  pass: false,
  method: 'traces',
  actual: 47320,
  expected: 10000,
  errorMessage: 'expected 47320 to be below 10000',
};

const notReachedMarker: MatcherResult = {
  description:
    'Test body did not complete: a prior assertion threw, so any ' +
    'expect()/judge()/evaluate() calls after it were never executed.',
  pass: false,
  method: 'code-assertion',
  notReached: true,
  errorMessage: 'expected 47320 to be below 10000',
};

describe('MatcherResultsPanel — not-reached rendering', () => {
  it('shows a distinct "not reached" label for a notReached entry', () => {
    panel([passingCode, failingGate, notReachedMarker]);
    expect(screen.getByText('not reached')).toBeTruthy();
  });

  it('excludes notReached entries from the passed/failed header counts and gives them their own tally', () => {
    panel([passingCode, failingGate, notReachedMarker]);
    // 1 passed / 2 reached (passingCode + failingGate); failingGate is the 1
    // failure; notReachedMarker must NOT be folded into either bucket.
    expect(screen.getByText('(1/2 passed, 1 failed, 1 not reached)')).toBeTruthy();
  });

  it('omits the "not reached" segment entirely when nothing was left unreached', () => {
    panel([passingCode, failingGate]);
    expect(screen.getByText('(1/2 passed, 1 failed)')).toBeTruthy();
    expect(screen.queryByText(/not reached/)).toBeNull();
  });

  it('renders the notReached row description and error detail (expanded by default)', () => {
    panel([notReachedMarker]);
    expect(screen.getAllByText(/Test body did not complete/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/expected 47320 to be below 10000/)).toBeTruthy();
  });

  it('renders a notReached llm-judge marker through the plain row, not the WHY/FIX judge row', () => {
    panel([{ ...notReachedMarker, method: 'llm-judge' }]);
    expect(screen.getByText('not reached')).toBeTruthy();
    expect(screen.queryByText('Why it failed')).toBeNull();
    expect(screen.queryByText('Full judge reasoning')).toBeNull();
  });
});
