/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Render tests for MetricCell's per-case accuracy chip — the fabricated-0%
 * regression found on a real STaRK-retail comparison (two runs scored by a
 * custom evaluator whose reports carry ONLY custom metric keys like
 * fact_precision / provenance_verifiability and no `metrics.accuracy`).
 * The old `result.accuracy ?? 0` fallback rendered "Passed 0%" / "Failed 0%"
 * in EVERY table cell of such comparisons.
 *
 *  - no numeric accuracy  -> NO accuracy chip at all (status label only)
 *  - accuracy === 0       -> real "0%" (a genuine zero score still shows)
 *  - accuracy present     -> value + delta vs baseline
 *  - accuracy missing     -> no delta chip even when a baseline exists
 */

import * as React from 'react';
import { render, screen } from '@testing-library/react';
import { MetricCell } from '@/components/comparison/MetricCell';
import type { TestCaseRunResult } from '@/types';

function makeResult(overrides: Partial<TestCaseRunResult> = {}): TestCaseRunResult {
  return {
    reportId: 'report-1',
    status: 'completed',
    passFailStatus: 'passed',
    ...overrides,
  } as TestCaseRunResult;
}

function renderCell(props: { result: TestCaseRunResult; baselineAccuracy?: number }) {
  return render(React.createElement(MetricCell, props));
}

describe('MetricCell accuracy chip (fabricated-0% regression)', () => {
  it('omits the accuracy chip entirely when the report carries no numeric accuracy (custom-evaluator shape)', () => {
    renderCell({ result: makeResult({ accuracy: undefined }) });
    expect(screen.getByText('Passed')).toBeTruthy();
    expect(screen.queryByTestId('metric-cell-accuracy')).toBeNull();
    // The pre-fix symptom: a literal "0%" chip.
    expect(screen.queryByText('0%')).toBeNull();
  });

  it('renders a real accuracy of 0 as "0%" (zero is a score, not "missing")', () => {
    renderCell({ result: makeResult({ accuracy: 0, passFailStatus: 'failed' }) });
    const chip = screen.getByTestId('metric-cell-accuracy');
    expect(chip.textContent).toBe('0%');
  });

  it('renders the accuracy value and a delta against the baseline', () => {
    renderCell({ result: makeResult({ accuracy: 95.5 }), baselineAccuracy: 90 });
    expect(screen.getByTestId('metric-cell-accuracy').textContent).toBe('95.5%');
    expect(screen.getByText('+5.5')).toBeTruthy();
  });

  it('suppresses the delta when accuracy is missing even if a baseline exists', () => {
    renderCell({ result: makeResult({ accuracy: undefined }), baselineAccuracy: 90 });
    expect(screen.queryByTestId('metric-cell-accuracy')).toBeNull();
    // No "-90" fabricated delta.
    expect(screen.queryByText(/-90/)).toBeNull();
  });

  it('never renders an accuracy chip for the errored bucket (metricsStatus error)', () => {
    renderCell({ result: makeResult({ errored: true, accuracy: 0 }) });
    expect(screen.getByText('Errored')).toBeTruthy();
    expect(screen.queryByTestId('metric-cell-accuracy')).toBeNull();
  });
});

/**
 * Render tests for MetricCell's per-case number when a report carries no
 * `metrics.accuracy`:
 *   - snapshot-scored report → the weighted `score` chip;
 *   - legacy report → rubric values BY NAME (stored order), never one of them
 *     picked (alphabetically or otherwise) and relabelled as the score.
 */
describe('MetricCell score / rubric-by-name chips', () => {
  it('shows the snapshot score chip when the result carries a per-case score', () => {
    renderCell({ result: makeResult({ accuracy: undefined, score: 69.6, rubricValues: { fact_precision: 60, abstention_integrity: 92 } }) });
    const chip = screen.getByTestId('metric-cell-score');
    expect(chip.textContent).toBe('score69.6%');
    expect(screen.queryByTestId('metric-cell-rubrics')).toBeNull();
    expect(screen.queryByTestId('metric-cell-accuracy')).toBeNull();
  });

  it('legacy: shows rubric values by name in stored order (first two inline, rest counted) — no "primary rubric"', () => {
    renderCell({ result: makeResult({ accuracy: undefined, rubricValues: { fact_precision: 72, abstention_integrity: 90, payload_economy: 50 } }) });
    const chip = screen.getByTestId('metric-cell-rubrics');
    expect(chip.textContent).toBe('fact_precision72%abstention_integrity90%+1');
    expect(chip.title).toContain('Legacy scoring');
    expect(chip.title).toContain('payload_economy 50%');
    expect(screen.queryByTestId('metric-cell-primary-rubric')).toBeNull();
    expect(screen.queryByTestId('metric-cell-accuracy')).toBeNull();
  });

  it('renders nothing extra when neither accuracy, score nor rubric values are present', () => {
    renderCell({ result: makeResult({ accuracy: undefined }) });
    expect(screen.queryByTestId('metric-cell-rubrics')).toBeNull();
    expect(screen.queryByTestId('metric-cell-score')).toBeNull();
    expect(screen.queryByTestId('metric-cell-accuracy')).toBeNull();
  });

  it('does NOT render the rubric chips when accuracy IS present (accuracy shown under its own name)', () => {
    renderCell({ result: makeResult({ accuracy: 88, rubricValues: { accuracy: 88, fact_precision: 72 } }) });
    expect(screen.getByTestId('metric-cell-accuracy').textContent).toBe('88%');
    expect(screen.queryByTestId('metric-cell-rubrics')).toBeNull();
  });

  it('never renders score / rubric chips for the errored bucket', () => {
    renderCell({ result: makeResult({ errored: true, accuracy: undefined, score: 50, rubricValues: { fact_precision: 72 } }) });
    expect(screen.getByText('Errored')).toBeTruthy();
    expect(screen.queryByTestId('metric-cell-rubrics')).toBeNull();
    expect(screen.queryByTestId('metric-cell-score')).toBeNull();
  });

  it('rounds rubric values to one decimal like accuracy', () => {
    renderCell({ result: makeResult({ accuracy: undefined, rubricValues: { abstention_integrity: 72.04 } }) });
    expect(screen.getByTestId('metric-cell-rubrics').textContent).toBe('abstention_integrity72%');
  });
});
