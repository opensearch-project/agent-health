/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  assessScoringComparability,
  avgScoreTooltip,
  compareAnywayKey,
  countVersionMismatches,
  formatMetricInScale,
  countVersionUnknown,
  formatPassRateDetail,
  judgeCaption,
  passPolicyLabel,
  passRateHeaderLabel,
  readCompareAnyway,
  resolveJudgeModelId,
  runPassPolicyLabel,
  writeCompareAnyway,
} from '@/lib/comparison/scoringDisplay';
import type { EvaluationReport, RunScoringSummary } from '@/types';

const snapshotScoring = (over: Partial<Extract<RunScoringSummary, { source: 'snapshot' }>> = {}): RunScoringSummary => ({
  source: 'snapshot',
  evaluatorId: 'eval-demo',
  evaluatorName: 'Demo evaluator',
  evaluatorVersion: 2,
  contentHashes: ['h1'],
  weights: { fact_precision: 0.7, abstention_integrity: 0.3 },
  passPolicy: { kind: 'threshold', minScore: 0.7 },
  scoredReports: 10,
  scoredRubrics: 20,
  totalRubrics: 20,
  primaryMetrics: [],
  ...over,
});

describe('resolveJudgeModelId — precedence, never the agent model', () => {
  const run = { judgeModelId: 'run-judge', modelId: 'AGENT-MODEL' };
  it('prefers report.judgeModel (PR #494 field, feature-detected)', () => {
    const report = { judgeModel: 'resolved-llm', llmJudgeResponse: { modelId: 'resp-judge' }, judgeModelId: 'report-judge' } as unknown as EvaluationReport;
    expect(resolveJudgeModelId(report, run)).toBe('resolved-llm');
  });
  it('then llmJudgeResponse.modelId', () => {
    const report = { llmJudgeResponse: { modelId: 'resp-judge' }, judgeModelId: 'report-judge' } as unknown as EvaluationReport;
    expect(resolveJudgeModelId(report, run)).toBe('resp-judge');
  });
  it('then report.judgeModelId, then run.judgeModelId', () => {
    expect(resolveJudgeModelId({ judgeModelId: 'report-judge' } as EvaluationReport, run)).toBe('report-judge');
    expect(resolveJudgeModelId({} as EvaluationReport, run)).toBe('run-judge');
    expect(resolveJudgeModelId(undefined, run)).toBe('run-judge');
  });
  it('returns undefined rather than falling back to the agent model', () => {
    expect(resolveJudgeModelId({ modelId: 'AGENT-MODEL' } as EvaluationReport, { modelId: 'AGENT-MODEL' } as { judgeModelId?: string })).toBeUndefined();
    expect(resolveJudgeModelId({ judgeModel: '  ', llmJudgeResponse: { modelId: '' } } as unknown as EvaluationReport, {})).toBeUndefined();
  });
});

describe('pass-rate policy labels + denominators', () => {
  it('labels each policy kind; legacy/undefined is the judge verdict', () => {
    expect(passPolicyLabel(undefined)).toBe('judge verdict');
    expect(passPolicyLabel({ kind: 'llm-verdict' })).toBe('judge verdict');
    expect(passPolicyLabel({ kind: 'threshold', minScore: 0.7 })).toBe('score ≥ 0.7');
    expect(passPolicyLabel({ kind: 'threshold', minScore: 0.755 })).toBe('score ≥ 0.76');
    expect(passPolicyLabel({ kind: 'gates', gates: [{ metric: 'a', min: 80 }] })).toBe('gates');
    expect(runPassPolicyLabel({ source: 'legacy' })).toBe('judge verdict');
    expect(runPassPolicyLabel(snapshotScoring())).toBe('score ≥ 0.7');
  });

  it('header carries one shared policy, or "mixed policies"', () => {
    expect(passRateHeaderLabel([])).toBe('Pass rate (judge verdict)');
    expect(passRateHeaderLabel([{ scoring: { source: 'legacy' } }, { scoring: { source: 'legacy' } }])).toBe('Pass rate (judge verdict)');
    expect(passRateHeaderLabel([{ scoring: snapshotScoring() }, { scoring: snapshotScoring() }])).toBe('Pass rate (score ≥ 0.7)');
    expect(passRateHeaderLabel([{ scoring: snapshotScoring() }, { scoring: { source: 'legacy' } }])).toBe('Pass rate (mixed policies)');
  });

  it('detail reads "passed / evaluated" with errored AND pending excluded from the denominator and called out', () => {
    expect(formatPassRateDetail({ passedCount: 32, failedCount: 39, evaluatedCount: 71, erroredCount: 1 })).toBe('32 / 71 (errored 1)');
    expect(formatPassRateDetail({ passedCount: 36, failedCount: 36, evaluatedCount: 72, erroredCount: 0 })).toBe('36 / 72');
    // One passed + one still running is "1 / 1 (pending 1)", never "1 / 2".
    expect(formatPassRateDetail({ passedCount: 1, failedCount: 0, evaluatedCount: 1, erroredCount: 0, pendingCount: 1 })).toBe('1 / 1 (pending 1)');
    expect(formatPassRateDetail({ passedCount: 1, failedCount: 1, evaluatedCount: 2, erroredCount: 2, pendingCount: 3 })).toBe('1 / 2 (errored 2, pending 3)');
    // Fixtures without evaluatedCount: the judged set is passed + failed.
    expect(formatPassRateDetail({ passedCount: 5, failedCount: 0 })).toBe('5 / 5');
  });

  it('judgeCaption: single judge by name, several → "mixed", none → "not recorded"', () => {
    expect(judgeCaption({ judgeModelId: 'j1', judgeModelIds: ['j1'] })).toBe('j1');
    expect(judgeCaption({ judgeModelIds: ['j1', 'j2'] }, id => id.toUpperCase())).toBe('mixed (J1 · J2)');
    expect(judgeCaption({ judgeModelIds: [] })).toBe('not recorded');
    expect(judgeCaption({})).toBe('not recorded');
    // Older fixtures with only judgeModelId still resolve.
    expect(judgeCaption({ judgeModelId: 'only' })).toBe('only');
  });
});

describe('avgScoreTooltip', () => {
  it('explains legacy scoring', () => {
    expect(avgScoreTooltip({ source: 'legacy' })).toMatch(/judged before scoring snapshots existed/);
    expect(avgScoreTooltip(undefined)).toMatch(/legacy|before scoring snapshots/i);
  });
  it('lists evaluator name + version, weights and scored X / Y rubrics', () => {
    const t = avgScoreTooltip(snapshotScoring());
    expect(t).toContain('Evaluator Demo evaluator v2');
    expect(t).toContain('weights: fact_precision 0.7, abstention_integrity 0.3');
    expect(t).toContain('scored 20 / 20 rubrics over 10 cases');
  });
  it('falls back to the evaluator id when no name was snapshotted', () => {
    expect(avgScoreTooltip(snapshotScoring({ evaluatorName: undefined }))).toContain('Evaluator eval-demo v2');
  });
});

describe('coverage gate — assessScoringComparability', () => {
  const base = (over: Record<string, unknown>) => ({ runId: 'r', runName: 'R', scoring: { source: 'legacy' } as RunScoringSummary, testCaseVersions: {}, ...over });

  it('single run / two legacy runs with matching versions are comparable', () => {
    expect(assessScoringComparability([base({})])).toEqual({ comparable: true, reasons: [] });
    expect(assessScoringComparability([
      base({ runId: 'a', runName: 'A', testCaseVersions: { tc1: 1 } }),
      base({ runId: 'b', runName: 'B', testCaseVersions: { tc1: 1 } }),
    ])).toEqual({ comparable: true, reasons: [] });
  });

  it('same snapshot hash + same versions → comparable', () => {
    expect(assessScoringComparability([
      base({ runId: 'a', scoring: snapshotScoring(), testCaseVersions: { tc1: 1 } }),
      base({ runId: 'b', scoring: snapshotScoring(), testCaseVersions: { tc1: 1 } }),
    ]).comparable).toBe(true);
  });

  it('different snapshot hashes → not comparable, reason names both evaluators', () => {
    const r = assessScoringComparability([
      base({ runId: 'a', runName: 'A', scoring: snapshotScoring() }),
      base({ runId: 'b', runName: 'B', scoring: snapshotScoring({ contentHashes: ['h2'], evaluatorVersion: 3 }) }),
    ]);
    expect(r.comparable).toBe(false);
    expect(r.reasons).toEqual(['different scoring snapshots (A: Demo evaluator v2 vs B: Demo evaluator v3)']);
  });

  it('snapshot vs legacy → not comparable', () => {
    const r = assessScoringComparability([
      base({ runId: 'a', runName: 'A', scoring: snapshotScoring() }),
      base({ runId: 'b', runName: 'B' }),
    ]);
    expect(r.comparable).toBe(false);
    expect(r.reasons[0]).toMatch(/legacy scoring on B/);
  });

  it('a run mixing snapshots internally is flagged', () => {
    const r = assessScoringComparability([
      base({ runId: 'a', runName: 'A', scoring: snapshotScoring({ contentHashes: ['h1', 'h2'] }) }),
      base({ runId: 'b', runName: 'B', scoring: snapshotScoring() }),
    ]);
    expect(r.comparable).toBe(false);
    expect(r.reasons).toContain('A mixes 2 scoring snapshots');
  });

  it('shared test cases at different versions → not comparable', () => {
    const r = assessScoringComparability([
      base({ runId: 'a', testCaseVersions: { tc1: 1, tc2: 1, only_a: 1 } }),
      base({ runId: 'b', testCaseVersions: { tc1: 2, tc2: 1, only_b: 9 } }),
    ]);
    expect(r.comparable).toBe(false);
    expect(r.reasons).toEqual(['1 shared test case ran at different versions']);
    expect(countVersionMismatches([{ tc1: 1 }, { tc1: 2 }, { tc1: 1 }])).toBe(1);
    expect(countVersionMismatches([{ tc1: 1 }])).toBe(0);
    expect(countVersionMismatches([undefined, { tc1: 1 }])).toBe(0);
  });

  it('snapshot runs with a shared case lacking a recorded version on one side → not comparable (unknown ≠ matching)', () => {
    const r = assessScoringComparability([
      base({ runId: 'a', scoring: snapshotScoring(), testCaseVersions: { tc1: 1, tc2: 1 } }),
      base({ runId: 'b', scoring: snapshotScoring(), testCaseVersions: { tc1: 1 } }),
    ]);
    expect(r.comparable).toBe(false);
    expect(r.reasons).toEqual(['1 shared test case has no recorded version on one side']);
    expect(countVersionUnknown([{ tc1: 1, tc2: 1 }, { tc1: 1 }])).toBe(1);
    expect(countVersionUnknown([{ tc1: 1 }, {}])).toBe(1);
    expect(countVersionUnknown([{ tc1: 1 }])).toBe(0);
    // Legacy runs are not held to version provenance (missing versions are what legacy means).
    expect(assessScoringComparability([
      base({ runId: 'a', testCaseVersions: { tc1: 1 } }),
      base({ runId: 'b', testCaseVersions: {} }),
    ]).comparable).toBe(true);
  });

  it('tolerates aggregates built without scoring/testCaseVersions (treated as legacy)', () => {
    expect(assessScoringComparability([{ runId: 'a', runName: 'A' }, { runId: 'b', runName: 'B' }]).comparable).toBe(true);
  });
});

describe('Compare anyway override (session-scoped, keyed by run set)', () => {
  beforeEach(() => sessionStorage.clear());

  it('is keyed by the sorted run ids', () => {
    expect(compareAnywayKey(['b', 'a'])).toBe(compareAnywayKey(['a', 'b']));
    expect(compareAnywayKey(['a', 'c'])).not.toBe(compareAnywayKey(['a', 'b']));
  });

  it('round-trips through sessionStorage and can be cleared', () => {
    expect(readCompareAnyway(['a', 'b'])).toBe(false);
    writeCompareAnyway(['b', 'a'], true);
    expect(readCompareAnyway(['a', 'b'])).toBe(true);
    expect(readCompareAnyway(['a', 'c'])).toBe(false);
    writeCompareAnyway(['a', 'b'], false);
    expect(readCompareAnyway(['a', 'b'])).toBe(false);
  });
});

describe('formatMetricInScale', () => {
  it('formats by scale: fraction, percent, plain', () => {
    expect(formatMetricInScale(0.4567, { min: 0, max: 1 })).toBe('0.46');
    expect(formatMetricInScale(45.67, { min: 0, max: 100 })).toBe('46%');
    expect(formatMetricInScale(4.56, { min: 0, max: 10 })).toBe('4.6');
    expect(formatMetricInScale(undefined, { min: 0, max: 1 })).toBe('—');
    expect(formatMetricInScale(NaN, { min: 0, max: 1 })).toBe('—');
  });
});
