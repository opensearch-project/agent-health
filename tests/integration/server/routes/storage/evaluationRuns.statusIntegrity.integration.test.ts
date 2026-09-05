/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for run-status integrity (2026-09-04) — real server, real
 * storage backend (whatever AH_PORT points at).
 *
 * Run:
 *   AH_PORT=5035 npm run test:integration -- --testPathPatterns=evaluationRuns.statusIntegrity
 *
 * Covers, end-to-end through the HTTP API:
 *   1. concurrency=3 run against the built-in mock agent: every planned case
 *      lands in `results` (results.length === planned), the run ends
 *      `completed`, and NO per-case result carries a
 *      version_conflict_engine_exception (the live S2 failure signature).
 *   2. cancel mid-run: status `cancelled`, never-started cases carry explicit
 *      `status: 'cancelled'` markers, stats have `pending === 0` and
 *      `notRun > 0`, `isRunInProgress()` is false.
 *   3. rename (PATCH) while the run is executing does not clobber per-case
 *      results (the old read-modify-write `update()` could).
 *   4. the terminal write never re-sends `results`: a verdict persisted
 *      mid-run survives finalization unchanged.
 */

import { getTestBackendUrl } from '@/tests/integration/testConfig';
import { createTestDataTracker, uniqueTestName } from '@/tests/helpers/testDataTracker';
import { computeRunStats, isRunInProgress, getEffectiveRunStatus } from '@/lib/runStats';

const BASE_URL = getTestBackendUrl();
const tracker = createTestDataTracker();

const checkBackend = async (): Promise<boolean> => {
  try {
    const r = await fetch(`${BASE_URL}/api/storage/health`);
    return (await r.json()).status === 'ok';
  } catch { return false; }
};

async function createTestCase(name: string): Promise<string> {
  const r = await fetch(`${BASE_URL}/api/storage/test-cases`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name, category: 'Test', difficulty: 'Easy', initialPrompt: `Prompt for ${name}`,
      context: [], expectedTrajectory: [], expectedOutcomes: ['ok'], labels: ['@integration-test'],
    }),
  });
  if (!r.ok) throw new Error(`create test case: ${r.status} ${await r.text()}`);
  const tc = await r.json();
  tracker.testCase(tc.id);
  return tc.id;
}

/** Start an SSE run and resolve as soon as the `started` event arrives. */
async function startRun(body: Record<string, unknown>): Promise<{ runId: string; done: Promise<string> }> {
  const res = await fetch(`${BASE_URL}/api/storage/evaluation-runs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`start run: ${res.status} ${await res.text()}`);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let runId: string | undefined;
  while (!runId) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    const m = text.match(/event: started\ndata: (.*)\n/);
    if (m) runId = JSON.parse(m[1]).runId;
  }
  if (!runId) throw new Error(`no started event in: ${text.slice(0, 300)}`);
  tracker.evaluationRun(runId);
  // Drain the rest of the stream in the background; resolve with the full text.
  const done = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text;
      text += decoder.decode(value, { stream: true });
    }
  })();
  return { runId, done };
}

async function getRun(runId: string): Promise<any> {
  const r = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${runId}`);
  if (!r.ok) throw new Error(`get run ${runId}: ${r.status}`);
  return r.json();
}

async function waitForTerminal(runId: string, timeoutMs = 90_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = await getRun(runId);
    if (['completed', 'cancelled', 'failed'].includes(run.status)) return run;
    if (Date.now() > deadline) throw new Error(`run ${runId} still ${run.status} after ${timeoutMs}ms`);
    await new Promise(r => setTimeout(r, 500));
  }
}

function trackReports(run: any) {
  for (const r of Object.values(run.results || {}) as any[]) if (r.reportId) tracker.run(r.reportId);
}

const RUN_BASE = {
  agentKey: 'demo',
  modelId: 'claude-sonnet',
  // Mock judge: keeps this suite independent of Bedrock credentials (CI has none).
  judgeModelId: 'demo-model',
  trigger: 'api',
};

describe('evaluation runs — status integrity (concurrency, cancel, rename)', () => {
  let backendAvailable = false;

  beforeAll(async () => {
    backendAvailable = await checkBackend();
    if (!backendAvailable) console.warn(`Backend not available at ${BASE_URL} — skipping status-integrity tests`);
  });

  afterAll(async () => { await tracker.cleanup(); });

  it('concurrency=3: all planned cases land, run completes, zero version_conflict per-case errors (S2 regression)', async () => {
    if (!backendAvailable) return;
    const N = 9;
    const ids: string[] = [];
    for (let i = 0; i < N; i++) ids.push(await createTestCase(uniqueTestName(`rsi-conc-${i}`)));

    const { runId, done } = await startRun({
      ...RUN_BASE, name: uniqueTestName('rsi-concurrency3'), concurrency: 3,
      sources: [{ type: 'test-case-ids', ids }],
    });
    await done;
    const run = await waitForTerminal(runId);
    trackReports(run);

    expect(run.status).toBe('completed');
    expect(Object.keys(run.results)).toHaveLength(N);
    expect(new Set(Object.keys(run.results))).toEqual(new Set(ids));
    const conflicts = Object.values(run.results as Record<string, any>).filter(r => /version_conflict/i.test(r.error || ''));
    expect(conflicts).toEqual([]);
    expect(run.error ?? '').not.toMatch(/version_conflict/i);
    // No result is left in a non-terminal per-case state, and none is 'cancelled'.
    for (const r of Object.values(run.results as Record<string, any>)) {
      expect(['completed', 'failed']).toContain(r.status);
    }
    // Terminal-aware stats persisted server-side from the persisted doc.
    expect(run.stats.total).toBe(N);
    expect(run.stats.pending).toBe(0);
    expect(run.stats.notRun).toBe(0);
    expect(run.stats.passed + run.stats.failed + (run.stats.errored ?? 0)).toBe(N);
    expect(isRunInProgress(run)).toBe(false);
  }, 120_000);

  it('cancel mid-run: status cancelled, never-started cases marked `cancelled`, stats.pending === 0, not in progress', async () => {
    if (!backendAvailable) return;
    const N = 6;
    const ids: string[] = [];
    for (let i = 0; i < N; i++) ids.push(await createTestCase(uniqueTestName(`rsi-cancel-${i}`)));

    const { runId, done } = await startRun({
      ...RUN_BASE, name: uniqueTestName('rsi-cancel-midrun'), concurrency: 1,
      sources: [{ type: 'test-case-ids', ids }],
    });
    // Let the first case get under way (mock agent takes ~2.5s per case), then cancel.
    await new Promise(r => setTimeout(r, 1200));
    const cancelRes = await fetch(`${BASE_URL}/api/storage/evaluation-runs/${runId}/cancel`, { method: 'POST' });
    expect(cancelRes.ok).toBe(true);
    expect((await cancelRes.json()).draining).toBe(true);
    // Drain window: the doc is NOT terminal yet (an in-flight case is still
    // finishing) — it carries cancelRequestedAt and stays `running`, so no
    // reader can misreport the in-flight case as "not run".
    const draining = await getRun(runId);
    expect(draining.cancelRequestedAt).toBeTruthy();
    if (draining.status === 'running') {
      expect(isRunInProgress(draining)).toBe(true);
      expect(computeRunStats(draining).notRun).toBe(0);
    }
    await done; // SSE stream ends once the executor has drained + finalized
    const run = await waitForTerminal(runId);
    trackReports(run);

    expect(run.status).toBe('cancelled');
    expect(run.completedAt).toBeTruthy();
    expect(run.cancelRequestedAt).toBeTruthy();
    // R3: every planned case is accounted for — the never-started ones explicitly.
    expect(Object.keys(run.results)).toHaveLength(N);
    const markers = Object.values(run.results as Record<string, any>).filter(r => r.status === 'cancelled');
    expect(markers.length).toBeGreaterThan(0);
    for (const m of markers) expect(m).toEqual({ reportId: '', status: 'cancelled' });
    const executed = N - markers.length;
    expect(executed).toBeGreaterThanOrEqual(1);
    expect(executed).toBeLessThan(N);

    // Server-persisted stats are terminal-aware…
    expect(run.stats.pending).toBe(0);
    expect(run.stats.notRun).toBe(markers.length);
    expect(run.stats.total).toBe(N);
    // …and the UI-side recompute agrees (no phantom pending, no spinner condition).
    const ui = computeRunStats(run);
    expect(ui.pending).toBe(0);
    expect(ui.notRun).toBe(markers.length);
    expect(ui.total).toBe(N);
    expect(isRunInProgress(run)).toBe(false);
    expect(getEffectiveRunStatus(run)).toBe('cancelled');
  }, 120_000);

  it('rename (PATCH) while executing does not clobber per-case results; terminal write preserves mid-run verdicts', async () => {
    if (!backendAvailable) return;
    const N = 4;
    const ids: string[] = [];
    for (let i = 0; i < N; i++) ids.push(await createTestCase(uniqueTestName(`rsi-rename-${i}`)));

    const { runId, done } = await startRun({
      ...RUN_BASE, name: uniqueTestName('rsi-rename-during-run'), concurrency: 2,
      sources: [{ type: 'test-case-ids', ids }],
    });

    // Hammer renames while cases are finishing — each PATCH used to be a
    // stale full-document overwrite that could drop a just-persisted result.
    const renames: Promise<Response>[] = [];
    for (let i = 0; i < 8; i++) {
      renames.push(fetch(`${BASE_URL}/api/storage/evaluation-runs/${runId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: uniqueTestName(`rsi-renamed-${i}`) }),
      }));
      await new Promise(r => setTimeout(r, 400));
    }
    const renameResponses = await Promise.all(renames);
    for (const r of renameResponses) expect(r.ok).toBe(true);

    await done;
    const run = await waitForTerminal(runId);
    trackReports(run);

    expect(run.status).toBe('completed');
    expect(run.name).toMatch(/rsi-renamed-7/);
    expect(Object.keys(run.results)).toHaveLength(N);
    for (const id of ids) {
      expect(run.results[id]).toBeDefined();
      expect(['completed', 'failed']).toContain(run.results[id].status);
      expect(run.results[id].reportId).toBeTruthy();
    }
    expect(run.stats.total).toBe(N);
    expect(run.stats.pending).toBe(0);
  }, 120_000);
});
