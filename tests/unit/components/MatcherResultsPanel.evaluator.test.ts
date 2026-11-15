/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MatcherResultsPanel — the judge row names the evaluator (rubric) that
 * produced the verdict (#619). Before, an SDK `judge()` call silently judged
 * by the RCA rubric looked identical to one judged by any other evaluator;
 * the frozen `scoringSnapshot` on the matcher is the one place the evaluator
 * actually used is recorded, and the panel now prints it.
 */

import * as React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MatcherResultsPanel } from '@/components/MatcherResultsPanel';
import type { MatcherResult } from '@/lib/matchers/types';

jest.mock('@/components/ui/markdown', () => ({
  Markdown: ({ children }: any) => React.createElement('div', { 'data-testid': 'markdown' }, children),
  hasRealMarkdown: () => false,
}));

const panel = (results: MatcherResult[]) =>
  render(React.createElement(MatcherResultsPanel, { results }));

function judgeMatcher(overrides: Partial<MatcherResult> = {}): MatcherResult {
  return {
    description: 'judge: every returned item is a running shoe under $100',
    pass: true,
    method: 'llm-judge',
    role: 'gate',
    durationMs: 1200,
    score: 1,
    reasoning: 'Claim 1 — satisfied: all three items are running shoes priced $79–$95.',
    model: 'demo-model',
    ...overrides,
  };
}

const claimSnapshot = {
  evaluatorId: 'system-claim',
  evaluatorVersion: 1,
  contentHash: 'abc',
  evaluatorName: 'Claim',
  weights: { accuracy: 1 },
  passPolicy: { kind: 'llm-verdict' as const },
};

describe('MatcherResultsPanel — evaluator provenance on judge rows (#619)', () => {
  it('shows the evaluator name from the frozen scoringSnapshot (passing row, expanded by click)', () => {
    panel([judgeMatcher({ scoringSnapshot: claimSnapshot as any })]);
    // Passing rows start collapsed.
    expect(screen.queryByTestId('matcher-evaluator')).toBeNull();
    fireEvent.click(screen.getByText(/judge: every returned item/));
    const el = screen.getByTestId('matcher-evaluator');
    expect(el.textContent).toBe('Claim');
    expect(el.getAttribute('title')).toBe('system-claim');
    expect(screen.getByText('evaluator:')).toBeTruthy();
  });

  it('falls back to the evaluator id when the snapshot carries no name', () => {
    panel([judgeMatcher({ pass: false, scoringSnapshot: { ...claimSnapshot, evaluatorName: undefined, evaluatorId: 'user-eval-42' } as any })]);
    // Failing rows are open by default.
    expect(screen.getByTestId('matcher-evaluator').textContent).toBe('user-eval-42');
  });

  it('renders no evaluator line for legacy rows without a snapshot', () => {
    panel([judgeMatcher({ pass: false })]);
    expect(screen.queryByTestId('matcher-evaluator')).toBeNull();
    expect(screen.queryByText('evaluator:')).toBeNull();
  });
});
