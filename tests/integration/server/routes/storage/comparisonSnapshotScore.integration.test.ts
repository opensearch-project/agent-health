/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test — snapshot-aware comparison aggregates over the REAL
 * storage API (file backend or OpenSearch, whatever AH_PORT points at).
 *
 * Two runs on one benchmark are persisted through `POST /api/storage/runs`
 * and `POST /api/storage/benchmarks`, read back through the same client path
 * the compare page uses (`asyncRunStorage.getReportsByIds`), and fed into
 * `calculateRunAggregates`:
 *   - run A: every report carries a ScoringSnapshot (fact_precision 0.7 /
 *     abstention_integrity 0.3, 0–100 scales) + one evaluator-errored case;
 *   - run B: legacy reports (same rubric names, no snapshot).
 * Asserts the weighted "Avg score" for A, `undefined` + legacy flag for B,
 * primary metrics passed through, pass-rate denominators excluding the errored
 * case, and that the snapshot round-trips byte-for-byte through the report
 * storage API (create → get, batch get, `fields=` projection, client mapper).
 *
 * These tests require the backend server to be running:
 *   npm run dev:server
 * Run:
 *   npm run test:integration -- --testPathPattern=comparisonSnapshotScore
 */

import { asyncRunStorage } from '@/services/storage/asyncRunStorage';
import { calculateRunAggregates } from '@/services/comparisonService';
import { assessScoringComparability } from '@/lib/comparison/scoringDisplay';
import { getTestBackendUrl } from '@/tests/integration/testConfig';
import { createTestDataTracker, uniqueTestName } from '../../../../helpers/testDataTracker';
import type { BenchmarkRun, EvaluationReport, ScoringSnapshot } from '@/types';

const BASE_URL = getTestBackendUrl();

const checkBackend = async (): Promise<boolean> => {
  try {
    const response = await fetch(`${BASE_URL}/api/storage/health`);
    const data = await response.json();
    return data.status === 'connected' || data.status === 'ok';
  } catch {
    return false;
  }
};

const SNAPSHOT: ScoringSnapshot = {
  evaluatorId: 'evaluator-demo-retrieval',
  evaluatorName: 'Demo retrieval evaluator',
  evaluatorVersion: 2,
  contentHash: 'sha256:demo-content-hash-a',
  weights: { fact_precision: 0.7, abstention_integrity: 0.3 },
  scale: { fact_precision: { min: 0, max: 100 }, abstention_integrity: { min: 0, max: 100 } },
  passPolicy: { kind: 'threshold', minScore: 0.7 },
  primaryMetrics: ['hit_at_1', 'recall_at_20'],
  judgeModelId: 'demo-judge-model',
  unevaluable: [],
};

describe('Comparison aggregates read scoring snapshots through the storage API', () => {
  let backendAvailable = false;
  const tracker = createTestDataTracker(BASE_URL);

  const testCaseIds: string[] = [];
  const reportIds = { a: [] as string[], b: [] as string[] };
  let benchmarkId: string | null = null;
  let runA: BenchmarkRun | null = null;
  let runB: BenchmarkRun | null = null;

  const postJson = async (path: string, body: unknown) => {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
    return res.json();
  };

  const createReport = async (data: Record<string, unknown>): Promise<string> => {
    const created = await postJson('/api/storage/runs', {
      agentId: 'demo',
      modelId: 'demo-agent-model',
      judgeModelId: 'demo-judge-model',
      status: 'completed',
      metricsStatus: 'ready',
      trajectory: [],
      llmJudgeReasoning: 'seeded',
      ...data,
    });
    tracker.run(created.id);
    return created.id as string;
  };

  beforeAll(async () => {
    backendAvailable = await checkBackend();
    if (!backendAvailable) return;

    for (let i = 0; i < 3; i++) {
      const tc = await postJson('/api/storage/test-cases', {
        name: uniqueTestName(`compare-snapshot-tc-${i}`),
        category: 'Test',
        difficulty: 'Easy',
        initialPrompt: 'p',
        expectedOutcomes: ['o'],
      });
      const id = tc.id || tc.testCase?.id;
      tracker.testCase(id);
      testCaseIds.push(id);
    }

    // Run A — snapshot-scored. Per-report weighted scores:
    //   tc0: 0.7*0.60 + 0.3*0.92 = 0.696 ; tc1: 0.7*0.80 + 0.3*1.00 = 0.86 → mean 0.778 → 78
    //   tc2: evaluator errored → excluded from score AND pass-rate denominator.
    reportIds.a.push(await createReport({
      testCaseId: testCaseIds[0], testCaseVersionId: `${testCaseIds[0]}-v1`,
      passFailStatus: 'failed',
      metrics: { fact_precision: 60, abstention_integrity: 92, hit_at_1: 0, recall_at_20: 0.5 },
      scoringSnapshot: SNAPSHOT,
    }));
    reportIds.a.push(await createReport({
      testCaseId: testCaseIds[1], testCaseVersionId: `${testCaseIds[1]}-v1`,
      passFailStatus: 'passed',
      metrics: { fact_precision: 80, abstention_integrity: 100, hit_at_1: 1, recall_at_20: 1 },
      scoringSnapshot: SNAPSHOT,
    }));
    reportIds.a.push(await createReport({
      testCaseId: testCaseIds[2], testCaseVersionId: `${testCaseIds[2]}-v1`,
      passFailStatus: null,
      metricsStatus: 'error',
      traceError: 'Judge evaluation failed: seeded for integration test',
      metrics: { fact_precision: 0, abstention_integrity: 0 },
      scoringSnapshot: SNAPSHOT,
    }));

    // Run B — legacy (no snapshot), same rubric names, abstention ≈ 92 everywhere.
    for (let i = 0; i < 3; i++) {
      reportIds.b.push(await createReport({
        testCaseId: testCaseIds[i], testCaseVersionId: `${testCaseIds[i]}-v1`,
        passFailStatus: i === 0 ? 'passed' : 'failed',
        metrics: { fact_precision: 50 + i, abstention_integrity: 92, provenance_verifiability: 40 },
      }));
    }

    const now = new Date().toISOString();
    const mkRun = (id: string, name: string, ids: string[], verdicts: Array<'passed' | 'failed' | null>): BenchmarkRun => ({
      id, name, agentKey: 'demo', modelId: 'demo-agent-model', judgeModelId: 'demo-judge-model',
      createdAt: now, status: 'completed', benchmarkVersion: 1, testCaseSnapshots: [],
      results: Object.fromEntries(testCaseIds.map((tcId, i) => [tcId, {
        reportId: ids[i], status: 'completed' as const,
        ...(verdicts[i] ? { passFailStatus: verdicts[i] } : {}),
      }])),
    } as unknown as BenchmarkRun);
    runA = mkRun(`run-snap-a-${Date.now()}`, 'Snapshot run A', reportIds.a, ['failed', 'passed', null]);
    runB = mkRun(`run-legacy-b-${Date.now()}`, 'Legacy run B', reportIds.b, ['passed', 'failed', 'failed']);

    const bm = await postJson('/api/storage/benchmarks', {
      name: uniqueTestName('compare-snapshot-benchmark'),
      description: 'comparison snapshot integration',
      testCaseIds,
      runs: [runA, runB],
      currentVersion: 1,
      versions: [{ version: 1, createdAt: now, testCaseIds }],
    });
    benchmarkId = bm.id;
    tracker.benchmark(bm.id);
  });

  afterAll(async () => {
    await tracker.cleanup();
  });

  it('round-trips the ScoringSnapshot byte-for-byte through create → GET /api/storage/runs/:id', async () => {
    if (!backendAvailable) return console.warn('Backend not available, skipping');
    const res = await fetch(`${BASE_URL}/api/storage/runs/${encodeURIComponent(reportIds.a[0])}`);
    expect(res.ok).toBe(true);
    const doc = await res.json();
    expect(JSON.stringify(doc.scoringSnapshot)).toBe(JSON.stringify(SNAPSHOT));
  });

  it('round-trips the snapshot through the batch GET and the fields= summary projection', async () => {
    if (!backendAvailable) return console.warn('Backend not available, skipping');
    const batch = await fetch(`${BASE_URL}/api/storage/runs?ids=${reportIds.a.map(encodeURIComponent).join(',')}`);
    const batchJson = await batch.json();
    const docs: Array<{ id: string; scoringSnapshot?: ScoringSnapshot }> = batchJson.runs ?? batchJson;
    for (const d of docs) expect(d.scoringSnapshot).toEqual(SNAPSHOT);

    const projected = await fetch(`${BASE_URL}/api/storage/runs?ids=${encodeURIComponent(reportIds.a[1])}&fields=metrics,scoringSnapshot`);
    const projectedJson = await projected.json();
    const pdoc = (projectedJson.runs ?? projectedJson)[0];
    expect(pdoc.scoringSnapshot).toEqual(SNAPSHOT);
    expect(pdoc.trajectory).toBeUndefined();

    // Legacy report: no snapshot is ever fabricated.
    const legacy = await (await fetch(`${BASE_URL}/api/storage/runs/${encodeURIComponent(reportIds.b[0])}`)).json();
    expect(legacy.scoringSnapshot).toBeUndefined();
  });

  it('client mapper (asyncRunStorage.saveReport / getReportById) preserves the snapshot too', async () => {
    if (!backendAvailable) return console.warn('Backend not available, skipping');
    const saved = await asyncRunStorage.saveReport({
      id: 'ignored',
      timestamp: new Date().toISOString(),
      testCaseId: testCaseIds[0],
      testCaseVersion: 1,
      agentName: 'demo',
      agentKey: 'demo',
      modelName: 'demo-agent-model',
      modelId: 'demo-agent-model',
      status: 'completed',
      passFailStatus: 'passed',
      trajectory: [],
      metrics: { fact_precision: 70, abstention_integrity: 90 },
      llmJudgeReasoning: 'mapper round-trip',
      metricsStatus: 'ready',
      scoringSnapshot: SNAPSHOT,
    } as EvaluationReport);
    tracker.run(saved.id);
    expect(saved.scoringSnapshot).toEqual(SNAPSHOT);
    const fetched = await asyncRunStorage.getReportById(saved.id);
    expect(fetched?.scoringSnapshot).toEqual(SNAPSHOT);
    const summaries = await asyncRunStorage.getReportSummariesByIds([saved.id]);
    expect(summaries[saved.id]?.scoringSnapshot).toEqual(SNAPSHOT);
  });

  it('computes the comparison payload: weighted Avg score for the snapshot run, legacy for the other', async () => {
    if (!backendAvailable) return console.warn('Backend not available, skipping');
    if (!runA || !runB || !benchmarkId) throw new Error('fixture not seeded');

    // Read the runs back off the persisted benchmark (what the compare page loads).
    const bm = await (await fetch(`${BASE_URL}/api/storage/benchmarks/${encodeURIComponent(benchmarkId)}`)).json();
    const bmDoc = bm.benchmark ?? bm;
    const persistedA = (bmDoc.runs as BenchmarkRun[]).find(r => r.id === runA!.id)!;
    const persistedB = (bmDoc.runs as BenchmarkRun[]).find(r => r.id === runB!.id)!;
    expect(persistedA).toBeTruthy();
    expect(persistedB).toBeTruthy();

    const reports = await asyncRunStorage.getReportsByIds([...reportIds.a, ...reportIds.b]);
    expect(Object.keys(reports)).toHaveLength(6);

    const aggA = calculateRunAggregates(persistedA, reports);
    const aggB = calculateRunAggregates(persistedB, reports);

    // A: weighted mean over the two evaluated reports = (0.696 + 0.86) / 2 = 0.778 → 78 (NOT 96 = mean abstention).
    expect(aggA.avgScore).toBe(78);
    expect(aggA.scoring).toMatchObject({
      source: 'snapshot',
      evaluatorId: SNAPSHOT.evaluatorId,
      evaluatorName: SNAPSHOT.evaluatorName,
      evaluatorVersion: 2,
      contentHashes: [SNAPSHOT.contentHash],
      weights: SNAPSHOT.weights,
      passPolicy: { kind: 'threshold', minScore: 0.7 },
      scoredReports: 2,
      scoredRubrics: 4,
      totalRubrics: 4,
    });
    // Primary metrics passed through by name with run-level means (raw scale).
    const primary = (aggA.scoring as { primaryMetrics: Array<{ name: string; mean?: number }> }).primaryMetrics;
    expect(primary.map(p => p.name)).toEqual(['hit_at_1', 'recall_at_20']);
    expect(primary[0].mean).toBeCloseTo(0.5, 10);
    expect(primary[1].mean).toBeCloseTo(0.75, 10);
    // Pass-rate denominators exclude the errored case: 1 passed / 2 evaluated (errored 1).
    expect(aggA.passedCount).toBe(1);
    expect(aggA.erroredCount).toBe(1);
    expect(aggA.evaluatedCount).toBe(2);
    expect(aggA.passRatePercent).toBe(50);
    // Judge caption resolves the judge, not the agent model.
    expect(aggA.judgeModelId).toBe('demo-judge-model');
    expect(aggA.judgeModelId).not.toBe('demo-agent-model');

    // B: legacy — no score is reconstructed from abstention_integrity (92) or any other rubric.
    expect(aggB.avgScore).toBeUndefined();
    expect(aggB.scoring).toEqual({ source: 'legacy' });
    expect(aggB.avgAccuracy).toBeUndefined();
    expect(aggB.passedCount).toBe(1);
    expect(aggB.evaluatedCount).toBe(3);

    // Coverage gate: snapshot vs legacy is not comparable.
    const gate = assessScoringComparability([aggA, aggB]);
    expect(gate.comparable).toBe(false);
    expect(gate.reasons.join(' ')).toMatch(/legacy scoring on Legacy run B/);
  });
});
