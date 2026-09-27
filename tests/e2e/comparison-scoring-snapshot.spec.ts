/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Acceptance e2e for the "compare honesty" work (R1 — snapshot-aware
 * scoring). Reproduces the headline confusion with generic fixtures: two runs
 * on one benchmark whose reports carry a rubric at ≈92 next to a 45% pass
 * rate. Before this change the scoreboard's "Avg Score" showed that rubric
 * (the alphabetically-first metric key) as the score, the judge caption named
 * the AGENT model, and identical case-ID sets were called "fully comparable".
 *
 * Asserts, on the real rendered compare page:
 *   (i)   "Avg score" for the snapshot run is the WEIGHTED value (70%, not
 *         92%) and its hover names evaluator / version / weights / scored X/Y;
 *   (ii)  the legacy run shows "—" + "legacy scoring";
 *   (iii) the judge caption names the judge model, not the agent model;
 *   (iv)  pass rate reads "passed / evaluated (errored N)" with the policy;
 *   (v)   two runs with different snapshot hashes → Δ row disabled with
 *         "Not comparable — different scoring"; "Compare anyway" enables it;
 *   (vi)  the coverage cell says "same case IDs" (not "fully comparable");
 *   (vii) the "verdict changes" count equals the insights band's "Split".
 */

import { test, expect, type APIRequestContext } from './fixtures/test-fixtures';
import type { TestDataTracker } from '../helpers/testDataTracker';
import { uniqueTestName } from '../helpers/testDataTracker';

const CASES = 12; // 11 judged + 1 evaluator-errored (on run A)
const AGENT_MODEL = 'demo-agent-model';
const JUDGE_MODEL = 'demo-judge-model';

const snapshotA = {
  evaluatorId: 'evaluator-demo-retrieval',
  evaluatorName: 'Demo retrieval evaluator',
  evaluatorVersion: 2,
  contentHash: 'sha256:demo-hash-a',
  weights: { fact_precision: 0.7, abstention_integrity: 0.3 },
  scale: { hit_at_1: { min: 0, max: 1 } },
  passPolicy: { kind: 'threshold', minScore: 0.7 },
  primaryMetrics: ['hit_at_1'],
};
const snapshotC = {
  ...snapshotA,
  evaluatorVersion: 3,
  contentHash: 'sha256:demo-hash-c',
  weights: { fact_precision: 0.5, abstention_integrity: 0.5 },
};

interface Seeded {
  benchmarkId: string;
  runA: string;
  runB: string;
  runC: string;
}

async function seed(request: APIRequestContext, testData: TestDataTracker): Promise<Seeded | null> {
  const post = async (path: string, data: unknown) => {
    const r = await request.post(path, { data });
    if (!r.ok()) return null;
    return r.json();
  };

  const testCaseIds: string[] = [];
  for (let i = 0; i < CASES; i++) {
    const tc = await post('/api/storage/test-cases', {
      name: uniqueTestName(`compare-honesty-case-${i}`),
      category: 'Test',
      difficulty: 'Easy',
      initialPrompt: 'p',
      expectedOutcomes: ['o'],
    });
    if (!tc) return null;
    const id = tc.id || tc.testCase?.id;
    testData.testCase(id);
    testCaseIds.push(id);
  }

  const mkReport = async (data: Record<string, unknown>): Promise<string | null> => {
    const created = await post('/api/storage/runs', {
      agentId: 'demo',
      modelId: AGENT_MODEL,
      judgeModelId: JUDGE_MODEL,
      llmJudgeResponse: { modelId: JUDGE_MODEL, timestamp: new Date().toISOString(), promptTokens: 1, completionTokens: 1, latencyMs: 1, rawResponse: '{}' },
      status: 'completed',
      metricsStatus: 'ready',
      trajectory: [],
      llmJudgeReasoning: 'seeded',
      ...data,
    });
    if (!created) return null;
    testData.run(created.id);
    return created.id;
  };

  // Every judged report: fact_precision 60, abstention_integrity 92.
  //   weighted (A: 0.7/0.3)  = 0.696 → 70%   |  weighted (C: 0.5/0.5) = 0.76 → 76%
  const metrics = { fact_precision: 60, abstention_integrity: 92, hit_at_1: 1 };
  const verdictsA: Array<'passed' | 'failed' | null> = testCaseIds.map((_, i) => (i === 11 ? null : i < 5 ? 'passed' : 'failed')); // 5/11 = 45%
  const verdictsB: Array<'passed' | 'failed' | null> = testCaseIds.map((_, i) => (i < 8 ? 'passed' : 'failed'));              // split vs A on 5,6,7
  const verdictsC = verdictsA;

  const seedRun = async (verdicts: Array<'passed' | 'failed' | null>, snapshot?: Record<string, unknown>) => {
    const ids: Array<string | null> = [];
    for (let i = 0; i < CASES; i++) {
      const v = verdicts[i];
      ids.push(await mkReport({
        testCaseId: testCaseIds[i],
        testCaseVersionId: `${testCaseIds[i]}-v1`,
        ...(v
          ? { passFailStatus: v, metrics, ...(snapshot ? { scoringSnapshot: snapshot } : {}) }
          : { passFailStatus: null, metricsStatus: 'error', traceError: 'Judge evaluation failed: seeded', metrics: { fact_precision: 0, abstention_integrity: 0 }, ...(snapshot ? { scoringSnapshot: snapshot } : {}) }),
      }));
    }
    if (ids.some(id => !id)) return null;
    return ids as string[];
  };

  const reportsA = await seedRun(verdictsA, snapshotA);
  const reportsB = await seedRun(verdictsB);
  const reportsC = await seedRun(verdictsC, snapshotC);
  if (!reportsA || !reportsB || !reportsC) return null;

  const stamp = Date.now();
  const mkRun = (id: string, name: string, createdAt: string, reportIds: string[], verdicts: Array<'passed' | 'failed' | null>) => ({
    id, name, agentKey: 'demo', modelId: AGENT_MODEL, judgeModelId: JUDGE_MODEL, createdAt,
    status: 'completed', benchmarkVersion: 1, testCaseSnapshots: [],
    results: Object.fromEntries(testCaseIds.map((tcId, i) => [tcId, {
      reportId: reportIds[i], status: 'completed', ...(verdicts[i] ? { passFailStatus: verdicts[i] } : {}),
    }])),
  });
  const runA = `run-honesty-a-${stamp}`;
  const runB = `run-honesty-b-${stamp}`;
  const runC = `run-honesty-c-${stamp}`;
  const bm = await post('/api/storage/benchmarks', {
    name: uniqueTestName('compare-honesty-benchmark'),
    description: 'compare honesty e2e',
    testCaseIds,
    runs: [
      mkRun(runA, 'Snapshot run A', new Date(stamp - 3000).toISOString(), reportsA, verdictsA),
      mkRun(runB, 'Legacy run B', new Date(stamp - 2000).toISOString(), reportsB, verdictsB),
      mkRun(runC, 'Snapshot run C', new Date(stamp - 1000).toISOString(), reportsC, verdictsC),
    ],
    currentVersion: 1,
    versions: [{ version: 1, createdAt: new Date().toISOString(), testCaseIds }],
  });
  if (!bm) return null;
  testData.benchmark(bm.id);
  return { benchmarkId: bm.id, runA, runB, runC };
}

test.describe('Comparison — snapshot-aware "Avg score", judge caption, policy-labelled pass rate', () => {
  test('snapshot run vs legacy run: weighted Avg score, legacy dash, judge caption, pass-rate denominators, banner, differences == split', async ({ page, request, testData }) => {
    const seeded = await seed(request, testData);
    test.skip(!seeded, 'Could not seed benchmark/runs/reports (storage not configured?)');
    const { benchmarkId, runA, runB } = seeded!;

    await page.goto(`/compare/${benchmarkId}?runs=${runA},${runB}`);
    await page.waitForSelector('[data-testid="comparison-scoreboard"]', { timeout: 30000 });

    // (i) Avg score = weighted mean (70%), NOT the ≈92 rubric.
    const avgA = page.locator(`[data-testid="run-avgscore-${runA}"]`);
    await expect(avgA).toHaveText('70%', { timeout: 20000 });
    await expect(avgA).not.toContainText('92');
    await avgA.hover();
    const hover = await avgA.getAttribute('title');
    expect(hover).toContain('Evaluator Demo retrieval evaluator v2');
    expect(hover).toContain('weights: fact_precision 0.7, abstention_integrity 0.3');
    expect(hover).toMatch(/scored 22 \/ 22 rubrics over 11 cases/);

    // No accuracy-only column anywhere.
    await expect(page.locator('[data-testid="scoreboard-col-avgAccuracy"]')).toHaveCount(0);
    // Primary metric declared by the snapshot renders as its own column, by name.
    await expect(page.locator('[data-testid="scoreboard-col-primary:hit_at_1"]')).toHaveText('hit_at_1');
    await expect(page.locator(`[data-testid="run-primary-hit_at_1-${runA}"]`)).toHaveText('1.00');
    await expect(page.locator(`[data-testid="run-primary-hit_at_1-${runB}"]`)).toHaveText('—');

    // (ii) Legacy run: "—" + "legacy scoring", explained on hover.
    const avgB = page.locator(`[data-testid="run-avgscore-${runB}"]`);
    await expect(avgB).toContainText('—');
    await expect(page.locator(`[data-testid="run-avgscore-legacy-${runB}"]`)).toHaveText('legacy scoring');
    expect(await avgB.getAttribute('title')).toContain('judged before scoring snapshots existed');

    // (iii) Judge caption names the judge, never the agent model.
    const judgeLine = page.locator('[data-testid="scoreboard-judge-line"]');
    await expect(judgeLine).toContainText(`Judge: ${JUDGE_MODEL}`);
    await expect(judgeLine).not.toContainText(AGENT_MODEL);

    // (iv) Pass rate: policy label in the header (mixed: threshold vs judge verdict), passed / evaluated (errored N).
    await expect(page.locator('[data-testid="scoreboard-col-passRate"]')).toHaveText('Pass rate (mixed policies)');
    await expect(page.locator(`[data-testid="run-passrate-${runA}"]`)).toHaveText('45%');
    await expect(page.locator(`[data-testid="run-passrate-detail-${runA}"]`)).toHaveText('5 / 11 (errored 1)');
    await expect(page.locator(`[data-testid="run-passrate-detail-${runB}"]`)).toHaveText('8 / 12');

    // (vi) Coverage cell: identical case IDs are just "same case IDs".
    const banner = page.locator('[data-testid="comparison-overlap-banner"]');
    await expect(banner).toHaveAttribute('data-overlap', 'full');
    await expect(banner).toContainText('same case IDs');
    await expect(banner).not.toContainText('fully comparable');

    // Snapshot vs legacy is not comparable → Δ row blocked (no Δ cells).
    await expect(page.locator('[data-testid="scoreboard-delta-blocked"]')).toHaveText('Not comparable — different scoring');
    await expect(page.locator('[data-testid="scoreboard-delta-passrate"]')).toHaveCount(0);

    // (vii) "N verdict changes" equals the insights band's Split count (3: cases 5,6,7).
    await expect(page.locator('[data-testid="verdict-differences-count"]')).toHaveText('3');
    await expect(page.locator('[data-testid="agreement-chip-split"]')).toContainText('3');
    await expect(page.locator('[data-testid="score-only-differences-count"]')).toHaveCount(0);
  });

  test('two snapshot runs with different content hashes: Δ row disabled until "Compare anyway"', async ({ page, request, testData }) => {
    const seeded = await seed(request, testData);
    test.skip(!seeded, 'Could not seed benchmark/runs/reports (storage not configured?)');
    const { benchmarkId, runA, runC } = seeded!;

    await page.goto(`/compare/${benchmarkId}?runs=${runA},${runC}`);
    await page.waitForSelector('[data-testid="comparison-scoreboard"]', { timeout: 30000 });

    await expect(page.locator(`[data-testid="run-avgscore-${runA}"]`)).toHaveText('70%', { timeout: 20000 });
    await expect(page.locator(`[data-testid="run-avgscore-${runC}"]`)).toHaveText('76%');
    // Same policy on both → header carries it.
    await expect(page.locator('[data-testid="scoreboard-col-passRate"]')).toHaveText('Pass rate (score ≥ 0.7)');

    // (v) Different snapshot hashes → Δ blocked, tooltip names both evaluator versions.
    const blocked = page.locator('[data-testid="scoreboard-delta-blocked"]');
    await expect(blocked).toHaveText('Not comparable — different scoring');
    const reason = (await blocked.getAttribute('title')) ?? '';
    expect(reason).toMatch(/different scoring snapshots \(/);
    expect(reason).toContain('Snapshot run A: Demo retrieval evaluator v2');
    expect(reason).toContain('Snapshot run C: Demo retrieval evaluator v3');
    await expect(page.locator('[data-testid="scoreboard-delta-avgscore"]')).toHaveCount(0);
    // Same case IDs, but NOT "same cases, same scoring".
    await expect(page.locator('[data-testid="comparison-overlap-banner"]')).toContainText('same case IDs');

    // Override: "Compare anyway" reveals the Δ row (|70 − 76| = 6).
    await page.locator('[data-testid="scoreboard-compare-anyway"]').click();
    await expect(blocked).toHaveCount(0);
    await expect(page.locator('[data-testid="scoreboard-delta-avgscore"]')).toHaveText(/^[+-]6$/); // |70 − 76|, sign depends on A/B order
    await expect(page.locator('[data-testid="scoreboard-delta-passrate"]')).toBeVisible();

    // Session-scoped: a reload keeps the override for this run set.
    await page.reload();
    await page.waitForSelector('[data-testid="comparison-scoreboard"]', { timeout: 30000 });
    await expect(page.locator(`[data-testid="run-avgscore-${runA}"]`)).toHaveText('70%', { timeout: 20000 });
    await expect(page.locator('[data-testid="scoreboard-delta-blocked"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="scoreboard-delta-avgscore"]')).toHaveText(/^[+-]6$/); // |70 − 76|, sign depends on A/B order
  });
});
