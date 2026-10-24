/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test for the shared test-data cleanup harness.
 *
 * The unit test proves the tracker issues the right DELETEs against a mock. This
 * one proves the DELETEs actually work against the REAL storage API: entities are
 * created through the same endpoints the test suites use, cleaned up via the
 * tracker, and then verified GONE.
 *
 * That "verified gone" assertion is the regression guard for the whole effort —
 * if a storage route changes its delete path or starts soft-deleting, this fails
 * instead of silently leaking into the shared OpenSearch cluster.
 */

import { createTestDataTracker, uniqueTestName } from '../../helpers/testDataTracker';
import { getTestBackendUrl } from '../testConfig';

const BASE_URL = getTestBackendUrl();

let backendAvailable = false;

/** Entities created directly by this spec, cleaned up defensively in afterAll. */
const safetyNet = createTestDataTracker(BASE_URL);

beforeAll(async () => {
  try {
    const response = await fetch(`${BASE_URL}/health`);
    backendAvailable = response.ok;
  } catch {
    backendAvailable = false;
  }
  if (!backendAvailable) {
    // eslint-disable-next-line no-console
    console.warn(`[skip] backend not reachable at ${BASE_URL}`);
  }
});

afterAll(async () => {
  if (backendAvailable) await safetyNet.cleanup();
});

async function createTestCase(): Promise<{ id: string; name: string }> {
  const name = uniqueTestName('cleanup-tc');
  const response = await fetch(`${BASE_URL}/api/storage/test-cases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      category: 'RCA',
      difficulty: 'Easy',
      initialPrompt: 'cleanup harness probe',
      expectedOutcomes: ['probe'],
    }),
  });
  if (!response.ok) throw new Error(`create test-case -> HTTP ${response.status}`);
  const body = await response.json();
  const id = body.testCase?.id ?? body.id;
  return { id, name };
}

async function createBenchmark(): Promise<{ id: string; name: string }> {
  const name = uniqueTestName('cleanup-bench');
  const response = await fetch(`${BASE_URL}/api/storage/benchmarks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, description: 'cleanup harness probe' }),
  });
  if (!response.ok) throw new Error(`create benchmark -> HTTP ${response.status}`);
  const body = await response.json();
  const id = body.benchmark?.id ?? body.id;
  return { id, name };
}

/** Create a report doc through the same storage route real runs persist through. */
async function createReport(
  experimentId?: string,
  experimentRunId?: string,
  testCaseId?: string
): Promise<string> {
  const response = await fetch(`${BASE_URL}/api/storage/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      testCaseId: testCaseId ?? `ahtest-cleanup-tc-ref-${Date.now()}`,
      testCaseName: uniqueTestName('cleanup-report'),
      status: 'completed',
      timestamp: new Date().toISOString(),
      trajectory: [],
      ...(experimentId ? { experimentId } : {}),
      ...(experimentRunId ? { experimentRunId } : {}),
    }),
  });
  if (!response.ok) throw new Error(`create run/report -> HTTP ${response.status}`);
  const body = await response.json();
  return body.run?.id ?? body.id;
}

async function exists(
  kind: 'test-cases' | 'benchmarks' | 'runs' | 'evaluation-runs' | 'evaluators' | 'images',
  id: string
): Promise<boolean> {
  const response = await fetch(`${BASE_URL}/api/storage/${kind}/${encodeURIComponent(id)}`);
  return response.ok;
}

/** Poll until a report doc is visible to POST /runs/search (index refresh ~1s). */
async function waitUntilSearchable(testCaseId: string, reportId: string): Promise<boolean> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const response = await fetch(`${BASE_URL}/api/storage/runs/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ testCaseId, size: 100 }),
    });
    if (response.ok) {
      const body = await response.json();
      if ((body.runs ?? []).some((r: { id?: string }) => r.id === reportId)) return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

describe('test-data cleanup harness (integration)', () => {
  it('deletes a tracked test case from real storage', async () => {
    if (!backendAvailable) return;

    const tracker = createTestDataTracker(BASE_URL);
    const tc = await createTestCase();
    tracker.testCase(tc.id);
    safetyNet.testCase(tc.id);

    expect(await exists('test-cases', tc.id)).toBe(true);

    const result = await tracker.cleanup();

    expect(result.failed).toEqual([]);
    expect(result.deleted).toBe(1);
    expect(await exists('test-cases', tc.id)).toBe(false);
  });

  it('reconciles an UNTRACKED report referencing a tracked test case (late-written report regression)', async () => {
    if (!backendAvailable) return;

    // The measured leak: a background evaluation persists its report doc
    // after afterAll harvested every id it could see — the tracker never
    // learns the report id. Reproduce the state (report exists, tracker only
    // knows the test case) and assert cleanup()'s id-scoped reconciliation
    // finds and deletes it.
    const tracker = createTestDataTracker(BASE_URL);
    const tc = await createTestCase();
    tracker.testCase(tc.id);
    safetyNet.testCase(tc.id);

    const lateReport = await createReport(undefined, undefined, tc.id);
    safetyNet.run(lateReport); // belt & braces if reconciliation fails
    // NOT tracked in `tracker` — that is the point.

    // Make sure the report is searchable before cleanup so this asserts
    // reconciliation, not the backend's index-refresh timing.
    expect(await waitUntilSearchable(tc.id, lateReport)).toBe(true);

    const result = await tracker.cleanup();

    expect(result.failed).toEqual([]);
    expect(result.reconcileFailed).toEqual([]);
    expect(result.reconciled).toContain(lateReport);
    expect(await exists('runs', lateReport)).toBe(false);
    expect(await exists('test-cases', tc.id)).toBe(false);
  }, 60_000);

  it('deletes a mixed batch of test cases and benchmarks in one cleanup', async () => {
    if (!backendAvailable) return;

    const tracker = createTestDataTracker(BASE_URL);
    const [tcA, tcB, bench] = await Promise.all([
      createTestCase(),
      createTestCase(),
      createBenchmark(),
    ]);
    tracker.testCases([tcA.id, tcB.id]);
    tracker.benchmark(bench.id);
    safetyNet.testCases([tcA.id, tcB.id]);
    safetyNet.benchmark(bench.id);

    const result = await tracker.cleanup();

    expect(result.failed).toEqual([]);
    expect(result.deleted).toBe(3);
    expect(await exists('test-cases', tcA.id)).toBe(false);
    expect(await exists('test-cases', tcB.id)).toBe(false);
    expect(await exists('benchmarks', bench.id)).toBe(false);
  });

  it('leaves no ahtest-* residue behind after cleanup', async () => {
    if (!backendAvailable) return;

    const tracker = createTestDataTracker(BASE_URL);
    const tc = await createTestCase();
    const bench = await createBenchmark();
    tracker.testCase(tc.id);
    tracker.benchmark(bench.id);
    safetyNet.testCase(tc.id);
    safetyNet.benchmark(bench.id);

    await tracker.cleanup();

    // Nothing this spec created may survive under its unique names.
    const benchList = await fetch(`${BASE_URL}/api/storage/benchmarks?size=1000`).then((r) => r.json());
    const names: string[] = (benchList.benchmarks ?? benchList.items ?? []).map(
      (b: { name: string }) => b.name
    );
    expect(names).not.toContain(bench.name);
  });

  it('is safe to call when the tracker recorded an already-deleted entity', async () => {
    if (!backendAvailable) return;

    const tracker = createTestDataTracker(BASE_URL);
    const tc = await createTestCase();
    tracker.testCase(tc.id);

    // Delete out-of-band, then let the tracker try again: 404 must count as success.
    await fetch(`${BASE_URL}/api/storage/test-cases/${encodeURIComponent(tc.id)}`, {
      method: 'DELETE',
    });

    const result = await tracker.cleanup();

    expect(result.failed).toEqual([]);
    expect(result.deleted).toBe(1);
  });

  // ── Per-kind deletion proof against the real backend ────────────────────
  // Reports are the kind that leaks the most (deleting a benchmark or an
  // evaluation run does NOT cascade to its report docs), so each of these
  // proves create -> track -> cleanup -> GET 404 through the real storage API.

  it('deletes tracked report docs and leaves no orphan behind (run kind)', async () => {
    if (!backendAvailable) return;

    const tracker = createTestDataTracker(BASE_URL);
    const bench = await createBenchmark();
    // Reports created exactly like real runs persist them: children of a benchmark.
    const reportA = await createReport(bench.id, 'brun-cleanup-probe');
    const reportB = await createReport(bench.id, 'brun-cleanup-probe');
    tracker.run(reportA);
    tracker.run(reportB);
    tracker.benchmark(bench.id);
    safetyNet.run(reportA);
    safetyNet.run(reportB);
    safetyNet.benchmark(bench.id);

    expect(await exists('runs', reportA)).toBe(true);
    expect(await exists('runs', reportB)).toBe(true);

    const result = await tracker.cleanup();

    expect(result.failed).toEqual([]);
    expect(result.deleted).toBe(3);
    // Both report docs gone AND the parent gone: nothing dangles, nothing orphans.
    expect(await exists('runs', reportA)).toBe(false);
    expect(await exists('runs', reportB)).toBe(false);
    expect(await exists('benchmarks', bench.id)).toBe(false);
  }, 30_000);

  it('deletes a real evaluation-run document and the reports it references', async () => {
    if (!backendAvailable) return;

    // Drive the REAL execution route (SSE): it persists the evaluation-run doc
    // before resolving the agent, so a nonexistent agent key yields a real,
    // quickly-terminal (failed) run document without invoking any agent or
    // judge. Executing a run that PASSES end-to-end needs a live agent +
    // Bedrock credentials, which this environment does not have — so report
    // docs are attached via the same storage route the runner itself uses.
    const tracker = createTestDataTracker(BASE_URL);
    const tc = await createTestCase();
    safetyNet.testCase(tc.id);

    const sse = await fetch(`${BASE_URL}/api/storage/evaluation-runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sources: [{ type: 'test-case-ids', ids: [tc.id] }],
        agentKey: 'ahtest-no-such-agent',
        name: uniqueTestName('cleanup-eval-run'),
      }),
    });
    expect(sse.ok).toBe(true);
    const sseText = await sse.text(); // stream closes fast on the unknown-agent error
    const runIdMatch = sseText.match(/"runId"\s*:\s*"([^"]+)"/);
    expect(runIdMatch).not.toBeNull();
    const evalRunId = runIdMatch![1];
    tracker.evaluationRun(evalRunId);
    safetyNet.evaluationRun(evalRunId);

    // The run document really persisted — and reached a terminal state.
    const runDoc = await fetch(
      `${BASE_URL}/api/storage/evaluation-runs/${encodeURIComponent(evalRunId)}`
    ).then((r) => r.json());
    const evalRun = runDoc.evaluationRun ?? runDoc;
    expect(['failed', 'completed', 'cancelled']).toContain(evalRun.status);

    // The execute route also stamps a content-addressed image for the run's
    // conditions. Our test case has a unique name, so the digest is unique to
    // this test and safe to delete.
    if (evalRun.imageDigest) {
      tracker.image(evalRun.imageDigest);
      safetyNet.image(evalRun.imageDigest);
    }

    // Walk results[*].reportId exactly like the AGENTS.md cleanup recipe. (With
    // an unknown agent there are none — attach one through the storage route to
    // prove the delete path regardless.)
    for (const result of Object.values<{ reportId?: string }>(evalRun.results ?? {})) {
      tracker.run(result?.reportId);
    }
    const attachedReport = await createReport(undefined, evalRunId);
    tracker.run(attachedReport);
    safetyNet.run(attachedReport);

    tracker.testCase(tc.id);
    const result = await tracker.cleanup();

    expect(result.failed).toEqual([]);
    expect(await exists('evaluation-runs', evalRunId)).toBe(false);
    expect(await exists('runs', attachedReport)).toBe(false);
    if (evalRun.imageDigest) {
      expect(await exists('images', evalRun.imageDigest)).toBe(false);
    }
    expect(await exists('test-cases', tc.id)).toBe(false);
  }, 60_000);

  it('deletes a nested benchmark-run from its parent benchmark', async () => {
    if (!backendAvailable) return;

    const tracker = createTestDataTracker(BASE_URL);
    const bench = await createBenchmark();
    safetyNet.benchmark(bench.id);

    // Benchmark runs are embedded subdocuments; PUT with a runs array creates one.
    const putResponse = await fetch(
      `${BASE_URL}/api/storage/benchmarks/${encodeURIComponent(bench.id)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runs: [{ name: uniqueTestName('cleanup-brun'), status: 'completed', results: {} }],
        }),
      }
    );
    expect(putResponse.ok).toBe(true);
    const updated = await putResponse.json();
    const runId: string = (updated.benchmark ?? updated).runs?.[0]?.id;
    expect(runId).toBeTruthy();

    tracker.benchmarkRun(bench.id, runId);
    const result = await tracker.cleanup();
    expect(result.failed).toEqual([]);

    // Verify inside the parent doc: the embedded run must be gone.
    const after = await fetch(
      `${BASE_URL}/api/storage/benchmarks/${encodeURIComponent(bench.id)}`
    ).then((r) => r.json());
    const runs = (after.benchmark ?? after).runs ?? [];
    expect(runs.map((r: { id: string }) => r.id)).not.toContain(runId);

    tracker.benchmark(bench.id);
    await tracker.cleanup();
    expect(await exists('benchmarks', bench.id)).toBe(false);
  }, 30_000);

  it('deletes a tracked evaluator', async () => {
    if (!backendAvailable) return;

    const tracker = createTestDataTracker(BASE_URL);
    const response = await fetch(`${BASE_URL}/api/storage/evaluators`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: uniqueTestName('cleanup-evaluator'),
        systemPrompt: 'cleanup harness probe',
        // A valid scoring config: POST validates metrics (lib/scoring/validateScoringConfig).
        scoringConfig: { metrics: [{ name: 'accuracy', description: 'probe', weight: 1, scale: 100 }], passThreshold: 50, scale: 100 },
      }),
    });
    expect(response.ok).toBe(true);
    const evaluatorId = (await response.json()).id;
    tracker.evaluator(evaluatorId);
    safetyNet.evaluator(evaluatorId);

    expect(await exists('evaluators', evaluatorId)).toBe(true);
    const result = await tracker.cleanup();
    expect(result.failed).toEqual([]);
    expect(await exists('evaluators', evaluatorId)).toBe(false);
  }, 30_000);

  it('deletes a tracked image (content-addressed, unique to this test)', async () => {
    if (!backendAvailable) return;

    // The images API (POST/DELETE /api/storage/images) ships with the
    // benchmark-image-dedup work and does not exist on every backend yet
    // (upstream main lacks it at the time of writing). The tracker's `image`
    // kind is forward-compatible either way — DELETE on a missing route 404s
    // and 404 counts as success — so when the route is absent we skip the
    // round-trip rather than fail against a backend that cannot create
    // images at all. This is a real capability probe, not a vacuous guard:
    // any response other than "route missing" keeps the full test running.
    const probe = await fetch(`${BASE_URL}/api/storage/images`);
    if (probe.status === 404) {
      console.warn('images API not available on this backend — skipping image cleanup round-trip');
      return;
    }

    const tracker = createTestDataTracker(BASE_URL);
    // Images are content-addressed over their test cases; a unique test-case
    // name gives a digest no other data shares, so deleting it is safe.
    const tc = await createTestCase();
    safetyNet.testCase(tc.id);
    const response = await fetch(`${BASE_URL}/api/storage/images`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ testCaseIds: [tc.id] }),
    });
    expect(response.ok).toBe(true);
    const digest: string = (await response.json()).image?.digest;
    expect(digest).toBeTruthy();
    tracker.image(digest);
    safetyNet.image(digest);

    expect(await exists('images', digest)).toBe(true);
    tracker.testCase(tc.id);
    const result = await tracker.cleanup();
    expect(result.failed).toEqual([]);
    expect(await exists('images', digest)).toBe(false);
    expect(await exists('test-cases', tc.id)).toBe(false);
  }, 30_000);
});
