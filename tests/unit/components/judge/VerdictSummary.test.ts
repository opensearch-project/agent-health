/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { VerdictSummary } from '@/components/judge/VerdictSummary';
import type { ScoringSnapshot } from '@/types';

const snapshot = (passPolicy: ScoringSnapshot['passPolicy'], extra: Partial<ScoringSnapshot> = {}): ScoringSnapshot => ({
  evaluatorId: 'eval-demo',
  evaluatorVersion: 3,
  contentHash: 'sha256:abc',
  evaluatorName: 'Demo evaluator',
  weights: { relevance: 0.5, grounding: 0.5 },
  passPolicy,
  ...extra,
});

const render = (report: any) => renderToStaticMarkup(React.createElement(VerdictSummary, { report }));

describe('<VerdictSummary>', () => {
  it('renders nothing for a legacy (snapshot-less) report', () => {
    expect(render({ metrics: { accuracy: 80 }, passFailStatus: 'passed' })).toBe('');
  });

  it('shows the computed verdict with its policy, the LLM verdict and a conflict marker', () => {
    const html = render({
      scoringSnapshot: snapshot({ kind: 'threshold', minScore: 0.7 }),
      passFailStatus: 'failed',
      llmVerdict: 'passed',
      verdictConflict: true,
      metrics: { relevance: 60, grounding: 60 },
    });
    expect(html).toContain('data-verdict-state="conflict"');
    expect(html).toMatch(/Verdict:.*failed.*\(policy: score ≥ 0\.7\).*LLM said:.*passed/s);
    expect(html).toContain('data-testid="verdict-conflict"');
    expect(html).toContain('60%');
    expect(html).toContain('scored 2 / 2 rubrics');
    expect(html).toContain('Demo evaluator v3');
  });

  it('lists unevaluable rubrics as "not evaluable" (never 0) and hides the LLM clause under llm-verdict', () => {
    const html = render({
      scoringSnapshot: snapshot({ kind: 'llm-verdict' }),
      passFailStatus: 'passed',
      llmVerdict: 'passed',
      verdictConflict: false,
      metrics: { relevance: 90 },
    });
    expect(html).toContain('data-verdict-state="agree"');
    expect(html).toContain('(policy: judge verdict)');
    expect(html).not.toContain('LLM said');
    expect(html).toContain('grounding: not evaluable');
    expect(html).toContain('scored 1 / 2 rubrics');
    expect(html).toContain('90%');
    expect(html).not.toMatch(/[^0-9]0%/);
  });

  it('renders the explicit no-metrics state for a judge error instead of zeros', () => {
    const html = render({ metricsStatus: 'error', metrics: {}, scoringSnapshot: null });
    expect(html).toContain('data-verdict-state="no-metrics"');
    expect(html).toContain('No verdict');
    expect(html).toMatch(/metrics were recorded/);
    expect(html).toMatch(/counts as .*errored/);
    expect(html).not.toMatch(/\b0%/);
  });
});
