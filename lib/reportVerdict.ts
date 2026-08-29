/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { EvaluationReport } from '@/types';

export interface JudgeVerdict {
  status: 'passed' | 'failed';
  /** Judge score on the UI's 0–100 scale, when the judge supplied one. */
  score: number | null;
  source: 'matcherResults' | 'passFailStatus';
}

export interface TraceNotice {
  tone: 'info' | 'warning';
  title: string;
  description: string;
}

/**
 * Minimal report shape needed to derive a verdict. Keeping this narrower than
 * EvaluationReport lets server migrations and comparison summaries use the
 * exact same derivation logic without manufacturing unrelated run fields.
 */
export type VerdictReport = Pick<
  EvaluationReport,
  'matcherResults' | 'passFailStatus' | 'metrics' | 'metricsStatus' | 'traceStatus' | 'traceError'
> & Partial<Pick<EvaluationReport, 'llmJudgeReasoning'>>;

function matcherScoreToPercent(value: number): number {
  // MatcherResult.score is defined on [0, 1]. Be tolerant of older callers
  // that persisted an already-scaled percentage without changing the metric
  // path below, where a legitimate 1 means 1% (not 100%).
  return Math.max(0, Math.min(100, value <= 1 ? value * 100 : value));
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function scoreFromMetrics(metrics: Record<string, number | undefined> | undefined): number | null {
  if (!metrics) return null;
  // Legacy RCA reports define accuracy as their canonical overall score. For
  // pluggable evaluators that do not emit accuracy, fall back to the mean of
  // their finite metric values.
  if (typeof metrics.accuracy === 'number' && Number.isFinite(metrics.accuracy)) {
    return clampPercent(metrics.accuracy);
  }
  const values = Object.values(metrics).filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value),
  );
  return mean(values.map(clampPercent));
}

/**
 * Return the report's authoritative judge verdict.
 *
 * `matcherResults` wins over the legacy surface fields because it preserves
 * the verdict even when a later trace timeout accidentally cleared
 * `passFailStatus` and reset `metrics`. Observe-only matcher entries do not
 * gate the verdict. Legacy reports fall back to `passFailStatus` + `metrics`.
 */
export function getJudgeVerdict(report: VerdictReport | null | undefined): JudgeVerdict | null {
  if (!report) return null;

  // Use persisted matcher entries directly. The general judge accessor also
  // synthesizes an entry from llmJudgeReasoning for very old reports; doing
  // that here would misread the evaluator-error prose as a failed verdict.
  const judgeResults = (report.matcherResults ?? []).filter(
    result => result.method === 'llm-judge' && !result.errored,
  );
  const gatingResults = judgeResults.filter(result => result.role !== 'observe');

  if (gatingResults.length > 0) {
    const matcherScores = gatingResults
      .map(result => {
        if (typeof result.score === 'number' && Number.isFinite(result.score)) {
          return matcherScoreToPercent(result.score);
        }
        const accuracy = result.judgeMetrics?.accuracy;
        return typeof accuracy === 'number' && Number.isFinite(accuracy)
          ? clampPercent(accuracy)
          : null;
      })
      .filter((score): score is number => score !== null);

    return {
      status: gatingResults.every(result => result.pass) ? 'passed' : 'failed',
      score: mean(matcherScores),
      source: 'matcherResults',
    };
  }

  if (report.passFailStatus === 'passed' || report.passFailStatus === 'failed') {
    return {
      status: report.passFailStatus,
      score: scoreFromMetrics(report.metrics as Record<string, number | undefined>),
      source: 'passFailStatus',
    };
  }

  return null;
}

/**
 * Convert trace availability into secondary diagnostic copy. Trace failures
 * never participate in verdict derivation; callers render this notice next to
 * (not instead of) the judge outcome.
 */
export function getTraceNotice(
  report: VerdictReport | null | undefined,
  options: { traceExpected?: boolean } = {},
): TraceNotice | null {
  if (!report) return null;

  if (report.traceStatus === 'not_configured') {
    return {
      tone: 'info',
      title: 'Traces not configured',
      description: 'This agent was evaluated from its captured output, so trace data is not expected for this run.',
    };
  }

  const traceError = report.traceError?.trim();
  const traceUnavailable = report.traceStatus === 'unavailable' ||
    Boolean(traceError && /kind=trace_(?:timeout|incomplete|fetch_failed)/.test(traceError));

  // Historical trace-timeout stamping set metricsStatus=error and zeroed the
  // report even after matcherResults had recorded a real verdict. Until the
  // cold-start migration heals such a document, expose that stale error only
  // as an explained diagnostic — never as the run outcome.
  if (!traceUnavailable && report.metricsStatus === 'error' && getJudgeVerdict(report)) {
    return {
      tone: 'warning',
      title: 'Metrics diagnostics: trace collection failed',
      description: 'Trace collection failed after judging completed. This does not affect the judge verdict.',
    };
  }

  if (!traceUnavailable) return null;

  if (options.traceExpected) {
    return {
      tone: 'warning',
      title: 'Traces unavailable',
      description: 'Trace collection was configured but no trace data arrived. The judge verdict remains authoritative.',
    };
  }

  return {
    tone: 'info',
    title: 'No trace data for this run',
    description: 'Trace data is diagnostic only and does not change the judge verdict.',
  };
}
