/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { projectEvaluationRunToBenchmarkRun } from '@/lib/benchmarkRunProjection';
import type { EvaluationRun } from '@/types';

const base = {
  id: 'eval-run-1',
  docType: 'evaluation-run',
  name: 'CLI Run - Agent',
  createdAt: '2024-01-01T00:00:00Z',
  status: 'completed',
  agentKey: 'rest-agent',
  modelId: 'model-1',
  sources: [{ type: 'benchmark', benchmarkId: 'bench-1' }],
  trigger: 'cli',
  testCaseSnapshots: [{ id: 'tc-1', version: 1, name: 'One' }],
  results: { 'tc-1': { reportId: 'rep-1', status: 'completed' } },
} as unknown as EvaluationRun;

describe('projectEvaluationRunToBenchmarkRun', () => {
  it('keeps the run id/results and drops evaluation-run-only fields', () => {
    const run = projectEvaluationRunToBenchmarkRun(base);
    expect(run).toEqual({
      id: 'eval-run-1',
      name: 'CLI Run - Agent',
      createdAt: '2024-01-01T00:00:00Z',
      status: 'completed',
      agentKey: 'rest-agent',
      modelId: 'model-1',
      results: base.results,
      testCaseSnapshots: base.testCaseSnapshots,
    });
    expect((run as any).sources).toBeUndefined();
    expect((run as any).trigger).toBeUndefined();
    expect((run as any).docType).toBeUndefined();
  });

  it('carries every optional field the benchmark projection has when present', () => {
    const run = projectEvaluationRunToBenchmarkRun({
      ...base,
      completedAt: 't1',
      error: 'boom',
      description: 'desc',
      judgeModelId: 'judge-1',
      evaluatorId: 'eval-1',
      headers: { 'x-a': 'b' },
      concurrency: 4,
      stats: { total: 1, passed: 1, failed: 0, errored: 0, notRun: 0, passRate: 100 } as any,
      judgeFailureSummary: 'none',
      benchmarkVersion: 2,
    } as EvaluationRun);
    expect(run).toMatchObject({
      completedAt: 't1', error: 'boom', description: 'desc', judgeModelId: 'judge-1', evaluatorId: 'eval-1',
      headers: { 'x-a': 'b' }, concurrency: 4, judgeFailureSummary: 'none', benchmarkVersion: 2,
    });
    expect(run.stats?.passRate).toBe(100);
  });

  it('defaults results to an empty map', () => {
    const run = projectEvaluationRunToBenchmarkRun({ ...base, results: undefined } as unknown as EvaluationRun);
    expect(run.results).toEqual({});
  });
});
