/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for asyncRunStorage
 *
 * These tests require the backend server to be running:
 *   npm run dev:server
 *
 * Run tests:
 *   npm test -- --testPathPattern=runStorage.integration
 */

import { asyncRunStorage } from '@/services/storage/asyncRunStorage';
import { storageAdmin } from '@/services/storage/opensearchClient';
import type { EvaluationReport } from '@/types';

const checkBackend = async (): Promise<boolean> => {
  try {
    const health = await storageAdmin.health();
    return health.status === 'connected';
  } catch {
    return false;
  }
};

/** Build a minimal valid report for testing */
function buildReport(overrides: Partial<EvaluationReport> = {}): EvaluationReport {
  const id = `report-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  return {
    id,
    timestamp: new Date().toISOString(),
    testCaseId: overrides.testCaseId ?? 'tc-integration-test',
    testCaseVersion: 1,
    agentName: 'integration-test-agent',
    agentKey: 'integration-test-agent',
    modelName: 'test-model',
    modelId: 'test-model',
    status: 'completed',
    passFailStatus: 'passed',
    trajectory: [],
    metrics: { accuracy: 85 },
    llmJudgeReasoning: 'Integration test reasoning',
    ...overrides,
  };
}

describe('Run Storage Integration Tests', () => {
  let backendAvailable = false;
  const createdReportIds: string[] = [];

  beforeAll(async () => {
    backendAvailable = await checkBackend();
    if (!backendAvailable) {
      console.warn('Backend not available - skipping run storage integration tests');
    }
  });

  afterAll(async () => {
    if (!backendAvailable) return;
    // Cleanup all created reports
    for (const id of createdReportIds) {
      try {
        await asyncRunStorage.deleteReport(id);
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  describe('report save & retrieve', () => {
    it('should save a report and return a valid ID', async () => {
      if (!backendAvailable) return;

      const report = buildReport();
      const saved = await asyncRunStorage.saveReport(report);

      expect(saved).toBeDefined();
      expect(saved.id).toBeDefined();
      expect(typeof saved.id).toBe('string');
      createdReportIds.push(saved.id);
    });

    it('should retrieve a saved report by ID', async () => {
      if (!backendAvailable) return;

      const report = buildReport();
      const saved = await asyncRunStorage.saveReport(report);
      createdReportIds.push(saved.id);

      const retrieved = await asyncRunStorage.getReportById(saved.id);
      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(saved.id);
      expect(retrieved?.testCaseId).toBe(report.testCaseId);
      expect(retrieved?.agentName).toBe(report.agentName);
      expect(retrieved?.metrics.accuracy).toBe(85);
    });
  });

  describe('report with benchmark context', () => {
    it('should save a report with experimentId and experimentRunId', async () => {
      if (!backendAvailable) return;

      const report = buildReport();
      const saved = await asyncRunStorage.saveReport(report, {
        experimentId: 'bench-integration-test',
        experimentRunId: 'run-integration-test',
      });
      createdReportIds.push(saved.id);

      const retrieved = await asyncRunStorage.getReportById(saved.id);
      expect(retrieved).toBeDefined();
      expect(retrieved?.experimentId).toBe('bench-integration-test');
      expect(retrieved?.experimentRunId).toBe('run-integration-test');
    });
  });

  describe('reports by test case', () => {
    const testCaseIdA = `tc-integ-a-${Date.now()}`;
    const testCaseIdB = `tc-integ-b-${Date.now()}`;

    it('should filter reports by test case ID', async () => {
      if (!backendAvailable) return;

      // Save two reports for testCaseIdA
      const reportA1 = buildReport({ testCaseId: testCaseIdA });
      const savedA1 = await asyncRunStorage.saveReport(reportA1);
      createdReportIds.push(savedA1.id);

      const reportA2 = buildReport({ testCaseId: testCaseIdA });
      const savedA2 = await asyncRunStorage.saveReport(reportA2);
      createdReportIds.push(savedA2.id);

      // Save one report for testCaseIdB
      const reportB = buildReport({ testCaseId: testCaseIdB });
      const savedB = await asyncRunStorage.saveReport(reportB);
      createdReportIds.push(savedB.id);

      const resultA = await asyncRunStorage.getReportsByTestCase(testCaseIdA);
      expect(resultA.reports.length).toBeGreaterThanOrEqual(2);
      expect(resultA.reports.every(r => r.testCaseId === testCaseIdA)).toBe(true);

      const resultB = await asyncRunStorage.getReportsByTestCase(testCaseIdB);
      expect(resultB.reports.length).toBeGreaterThanOrEqual(1);
      expect(resultB.reports.every(r => r.testCaseId === testCaseIdB)).toBe(true);
    });
  });

  describe('report pagination', () => {
    it('should paginate with limit and offset', async () => {
      if (!backendAvailable) return;

      const reports = await asyncRunStorage.getAllReports({ limit: 2, offset: 0 });
      expect(Array.isArray(reports)).toBe(true);
      expect(reports.length).toBeLessThanOrEqual(2);
    });
  });

  describe('report update', () => {
    it('should update report fields and verify on re-fetch', async () => {
      if (!backendAvailable) return;

      const report = buildReport({ passFailStatus: 'passed' });
      const saved = await asyncRunStorage.saveReport(report);
      createdReportIds.push(saved.id);

      await asyncRunStorage.updateReport(saved.id, {
        passFailStatus: 'failed',
        llmJudgeReasoning: 'Updated reasoning after re-evaluation',
        metrics: { accuracy: 42 },
      });

      const updated = await asyncRunStorage.getReportById(saved.id);
      expect(updated).toBeDefined();
      expect(updated?.passFailStatus).toBe('failed');
      expect(updated?.llmJudgeReasoning).toBe('Updated reasoning after re-evaluation');
      expect(updated?.metrics.accuracy).toBe(42);
    });
  });

  describe('report deletion', () => {
    it('should delete a report and return null on subsequent fetch', async () => {
      if (!backendAvailable) return;

      const report = buildReport();
      const saved = await asyncRunStorage.saveReport(report);

      const deleted = await asyncRunStorage.deleteReport(saved.id);
      expect(deleted).toBe(true);

      const retrieved = await asyncRunStorage.getReportById(saved.id);
      expect(retrieved).toBeNull();
    });
  });

  // ===========================================================================
  // Run name + dynamic metrics round-trip
  //
  // Locks down the storage-layer fixes from PR #206:
  //   - `name`, `description`, `evaluatorId` round-trip through the read mapper
  //     (`toTestCaseRun`) so the runs list shows the user-supplied name instead
  //     of falling back to `Run <short-id>`.
  //   - Dynamic metric names (e.g. `tool_selection_accuracy`,
  //     `reasoning_coherence`, `bias_detection`) are preserved on read,
  //     not stripped by the previous 4-key whitelist.
  //   - Missing metrics stay missing (read mapper used to fabricate `0` for
  //     undefined values, which made every non-RCA-Default run render as `0%`).
  //
  // Each test exercises the full HTTP round-trip via asyncRunStorage → backend
  // → storage adapter → backend → asyncRunStorage so it catches type-mapper bugs
  // that unit tests with mocks would miss.
  // ===========================================================================
  describe('run name, description, evaluatorId round-trip (PR #206)', () => {
    it('preserves user-supplied name and description through save → fetch', async () => {
      if (!backendAvailable) return;

      const report = buildReport({
        name: 'Baseline (integration test)',
        description: 'Smoke check for runName persistence',
      } as Partial<EvaluationReport>);
      const saved = await asyncRunStorage.saveReport(report);
      createdReportIds.push(saved.id);

      const fetched = await asyncRunStorage.getReportById(saved.id);
      expect(fetched).toBeDefined();
      expect(fetched!.name).toBe('Baseline (integration test)');
      expect(fetched!.description).toBe('Smoke check for runName persistence');
    });

    it('preserves evaluatorId so the runs list can label the evaluator', async () => {
      if (!backendAvailable) return;

      const report = buildReport({
        evaluatorId: 'system-rca',
      } as Partial<EvaluationReport>);
      const saved = await asyncRunStorage.saveReport(report);
      createdReportIds.push(saved.id);

      const fetched = await asyncRunStorage.getReportById(saved.id);
      expect(fetched).toBeDefined();
      expect(fetched!.evaluatorId).toBe('system-rca');
    });

    it('leaves name / description undefined for runs that omit them (no fabrication)', async () => {
      if (!backendAvailable) return;

      // No name/description in the report — the read mapper must not invent
      // values; `getRunDisplayName` on the UI side handles missing names
      // by synthesising `Run <short-id>` at render time.
      const report = buildReport();
      const saved = await asyncRunStorage.saveReport(report);
      createdReportIds.push(saved.id);

      const fetched = await asyncRunStorage.getReportById(saved.id);
      expect(fetched).toBeDefined();
      expect(fetched!.name).toBeUndefined();
      expect(fetched!.description).toBeUndefined();
    });
  });

  describe('dynamic metrics preservation (PR #206)', () => {
    it('round-trips arbitrary metric names emitted by non-RCA evaluators', async () => {
      if (!backendAvailable) return;

      // Tool-Use evaluator emits these three metrics; previously only the
      // four legacy keys (accuracy/faithfulness/latency_score/
      // trajectory_alignment_score) were preserved on read, so these would
      // disappear and the UI would show `0%` for the run.
      const report = buildReport({
        metrics: {
          tool_selection_accuracy: 80,
          redundant_calls: 95,
          tool_ordering: 70,
        },
      } as Partial<EvaluationReport>);
      const saved = await asyncRunStorage.saveReport(report);
      createdReportIds.push(saved.id);

      const fetched = await asyncRunStorage.getReportById(saved.id);
      expect(fetched).toBeDefined();
      expect(fetched!.metrics.tool_selection_accuracy).toBe(80);
      expect(fetched!.metrics.redundant_calls).toBe(95);
      expect(fetched!.metrics.tool_ordering).toBe(70);
    });

    it('does not fabricate `0` for missing legacy metric keys', async () => {
      if (!backendAvailable) return;

      // Critical regression check. Old `toTestCaseRun` defaulted every
      // missing metric to `0` via `|| 0`. After the fix, missing keys are
      // simply absent so `getRunOverallScore` can return `null` (rendered
      // as `—`) instead of fabricating a misleading `0%`.
      const report = buildReport({
        metrics: { tool_selection_accuracy: 80 },
      } as Partial<EvaluationReport>);
      const saved = await asyncRunStorage.saveReport(report);
      createdReportIds.push(saved.id);

      const fetched = await asyncRunStorage.getReportById(saved.id);
      expect(fetched).toBeDefined();
      expect(fetched!.metrics.tool_selection_accuracy).toBe(80);
      // The four legacy keys must NOT have been auto-populated to 0.
      expect(fetched!.metrics.accuracy).toBeUndefined();
      expect(fetched!.metrics.faithfulness).toBeUndefined();
      expect(fetched!.metrics.latency_score).toBeUndefined();
      expect(fetched!.metrics.trajectory_alignment_score).toBeUndefined();
    });

    it('preserves a legitimate zero metric value (does not collapse it to undefined)', async () => {
      if (!backendAvailable) return;

      // 0% is a real outcome (e.g. `safety_score: 0` for a run that scored
      // zero on safety). The mapper must distinguish missing-vs-zero so
      // the tooltip in the UI can show the real score.
      const report = buildReport({
        metrics: { safety_score: 0, bias_detection: 100 },
      } as Partial<EvaluationReport>);
      const saved = await asyncRunStorage.saveReport(report);
      createdReportIds.push(saved.id);

      const fetched = await asyncRunStorage.getReportById(saved.id);
      expect(fetched).toBeDefined();
      expect(fetched!.metrics.safety_score).toBe(0);
      expect(fetched!.metrics.bias_detection).toBe(100);
    });
  });
});
