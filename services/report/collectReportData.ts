/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Benchmark, BenchmarkRun, EvaluationReport, TestCase } from '@/types';
import type { ReportData, ReportRunData } from '@/services/report/types';
import {
  calculateRunAggregates,
  buildTestCaseComparisonRows,
  getRealTestCaseMeta,
} from '@/services/comparisonService';

/**
 * Assemble ReportData from benchmark, runs, and reports.
 * This is a pure function with no API calls or side effects.
 * Formatters receive the assembled data and only do transformation.
 *
 * @param benchmark - The benchmark entity
 * @param selectedRuns - Runs to include in the report
 * @param reports - Map of reportId to EvaluationReport
 * @param testCaseMap - Optional map of test case ID to TestCase for metadata
 * @param source - Source identifier for the report (e.g., 'cli', 'api', 'ui')
 */
export function collectReportData(
  benchmark: Benchmark,
  selectedRuns: BenchmarkRun[],
  reports: Record<string, EvaluationReport>,
  testCaseMap?: Map<string, TestCase>,
  source: string = 'api'
): ReportData {
  // Build test case metadata resolver
  const getTestCaseMeta = testCaseMap
    ? (id: string) => {
        const tc = testCaseMap.get(id);
        if (!tc) return getRealTestCaseMeta(id);
        return {
          id: tc.id,
          name: tc.name,
          category: tc.category,
          difficulty: tc.difficulty,
          version: `v${tc.currentVersion}`,
          labels: tc.labels,
        };
      }
    : getRealTestCaseMeta;

  // Calculate aggregates for each run
  const runs: ReportRunData[] = selectedRuns.map((run) => ({
    id: run.id,
    name: run.name,
    description: run.description,
    createdAt: run.createdAt,
    agentKey: run.agentKey,
    // Observed `<provider> · <model>` when the run's model came from the agent's
    // traces, else the id; '' for an agent-owned model with no spans yet
    // (escapeHtml in the HTML template takes a string).
    modelId: (run.modelSource === 'observed' && run.modelName) || run.modelId || '',
    status: run.status,
    aggregates: calculateRunAggregates(run, reports),
  }));

  // Build comparison rows
  const comparisonRows = buildTestCaseComparisonRows(
    selectedRuns,
    reports,
    getTestCaseMeta
  );

  return {
    benchmark: {
      id: benchmark.id,
      name: benchmark.name,
      description: benchmark.description,
      testCaseCount: benchmark.testCaseIds.length,
    },
    runs,
    comparisonRows,
    reports,
    generatedAt: new Date().toISOString(),
    generatedBy: source,
  };
}
