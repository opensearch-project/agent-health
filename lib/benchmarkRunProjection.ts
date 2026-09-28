/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Project an `EvaluationRun` (the unified runner's document) onto the
 * `BenchmarkRun` shape the CLI's summary/export helpers were written against.
 * Mirrors the projection the server links into `benchmark.runs[]` when an
 * evaluation run completes with a `benchmarkId` (see
 * server/routes/storage/evaluationRuns.ts), so a CLI caller sees the same run
 * whether it reads it from the SSE `completed` event or later from the
 * benchmark document.
 */

import type { BenchmarkRun, EvaluationRun } from '@/types/index.js';

export function projectEvaluationRunToBenchmarkRun(run: EvaluationRun): BenchmarkRun {
  return {
    id: run.id,
    name: run.name,
    createdAt: run.createdAt,
    status: run.status,
    agentKey: run.agentKey,
    modelId: run.modelId,
    results: run.results ?? {},
    ...(run.completedAt ? { completedAt: run.completedAt } : {}),
    ...(run.error ? { error: run.error } : {}),
    ...(run.description ? { description: run.description } : {}),
    ...(run.judgeModelId ? { judgeModelId: run.judgeModelId } : {}),
    ...(run.evaluatorId ? { evaluatorId: run.evaluatorId } : {}),
    ...(run.headers ? { headers: run.headers } : {}),
    ...(run.concurrency ? { concurrency: run.concurrency } : {}),
    ...(run.stats ? { stats: run.stats } : {}),
    ...(run.judgeFailureSummary ? { judgeFailureSummary: run.judgeFailureSummary } : {}),
    ...(run.testCaseSnapshots ? { testCaseSnapshots: run.testCaseSnapshots } : {}),
    ...(run.benchmarkVersion !== undefined ? { benchmarkVersion: run.benchmarkVersion } : {}),
  };
}
