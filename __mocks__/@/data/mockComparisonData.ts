/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { ExperimentRun, EvaluationReport, Category, ToolCallStatus } from '@/types';

export interface MockTestCaseMeta {
  id: string;
  name: string;
  labels?: string[];
  category: Category;
  difficulty: 'Easy' | 'Medium' | 'Hard';
  version?: string;
}

export const MOCK_TEST_CASES: MockTestCaseMeta[] = [
  { id: 'tc-1', name: 'Test Case 1', category: 'RCA', difficulty: 'Medium', version: 'v1' },
  { id: 'tc-2', name: 'Test Case 2', category: 'Alerts', difficulty: 'Easy', version: 'v1' },
];

export const MOCK_TEST_CASE_VERSIONS: Record<string, Record<string, string>> = {
  'tc-1': { 'run-1': 'v1', 'run-2': 'v2' },
  'tc-2': { 'run-1': 'v1', 'run-2': 'v1' },
};

export const MOCK_RUNS: ExperimentRun[] = [
  {
    id: 'run-1',
    name: 'Test Run 1',
    createdAt: '2024-01-01T00:00:00Z',
    agentKey: 'agent-1',
    modelId: 'model-1',
    status: 'completed',
    results: {
      'tc-1': { reportId: 'report-1', status: 'completed' },
      'tc-2': { reportId: 'report-2', status: 'completed' },
    },
  },
];

export const MOCK_REPORTS: Record<string, EvaluationReport> = {
  'report-1': {
    id: 'report-1',
    testCaseId: 'tc-1',
    passFailStatus: 'passed',
    metrics: { accuracy: 90, faithfulness: 85, trajectory_alignment_score: 80, latency_score: 75 },
    trajectory: [],
    status: 'completed',
  } as EvaluationReport,
  'report-2': {
    id: 'report-2',
    testCaseId: 'tc-2',
    passFailStatus: 'passed',
    metrics: { accuracy: 80, faithfulness: 75, trajectory_alignment_score: 70, latency_score: 65 },
    trajectory: [],
    status: 'completed',
  } as EvaluationReport,
};

export function getMockRuns(): ExperimentRun[] {
  return MOCK_RUNS;
}

export function getMockReportsByIds(reportIds: string[]): EvaluationReport[] {
  return reportIds.map(id => MOCK_REPORTS[id]).filter((r): r is EvaluationReport => r !== undefined);
}

export function getMockTestCaseMeta(testCaseId: string): MockTestCaseMeta | undefined {
  return MOCK_TEST_CASES.find(tc => tc.id === testCaseId);
}

export function getMockTestCaseVersion(testCaseId: string, runId: string): string | undefined {
  return MOCK_TEST_CASE_VERSIONS[testCaseId]?.[runId];
}

export function calculateTotalLatency(trajectory: { latencyMs?: number }[]): number {
  return trajectory.reduce((sum, step) => sum + (step.latencyMs || 0), 0);
}
