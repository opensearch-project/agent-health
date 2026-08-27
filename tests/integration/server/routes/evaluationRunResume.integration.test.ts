/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test: POST /api/storage/evaluation-runs/:id/resume
 *
 * Checkpoint-resume (RedKite-inspired): resuming an interrupted evaluation
 * run must
 *   1. re-execute ONLY the test cases without a persisted report,
 *   2. preserve completed results (their reportIds untouched),
 *   3. finish the run with status=completed and full-size stats,
 *   4. reject a second resume with 400 (nothing left to resume),
 *   5. 404 for unknown run ids.
 *
 * Uses the built-in `demo` agent (mock://demo) + `demo-model` judge so no
 * AWS credentials are needed. Runs against a live backend (npm run
 * dev:server) — self-skips when unreachable.
 */

import { request as httpRequest } from 'http';
import { getTestBackendUrl } from '@/tests/integration/testConfig';

const TEST_TIMEOUT = 120_000;
const BASE_URL = getTestBackendUrl();

function httpJson<T = any>(
  method: string,
  url: string,
  body?: unknown
): Promise<{ status: number; body: T; raw: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest(
      {
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname + u.search,
        method,
        headers: {
          Accept: 'application/json',
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          try {
            resolve({ status: res.statusCode || 0, body: text ? JSON.parse(text) : ({} as T), raw: text });
          } catch {
            resolve({ status: res.statusCode || 0, body: text as any, raw: text });
          }
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Parse a named-event SSE stream ("event: X\ndata: {...}") into [{event, data}]. */
function parseSSE(raw: string): Array<{ event: string; data: any }> {
  return raw
    .split('\n\n')
    .map((block) => {
      let event = '';
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7).trim();
        else if (line.startsWith('data: ')) data = line.slice(6);
      }
      if (!event || !data) return null;
      try { return { event, data: JSON.parse(data) }; } catch { return null; }
    })
    .filter((e): e is { event: string; data: any } => !!e);
}

describe('POST /api/storage/evaluation-runs/:id/resume — checkpoint resume', () => {
  let backendAvailable = false;
  const createdTestCaseIds: string[] = [];
  const createdReportIds: string[] = [];
  let runId: string | undefined;

  beforeAll(async () => {
    try {
      const health = await httpJson('GET', `${BASE_URL}/api/agents`);
      backendAvailable = health.status === 200;
    } catch {
      backendAvailable = false;
    }
    if (!backendAvailable) {
      console.warn('[evaluationRunResume] Backend not reachable — skipping');
    }
  }, TEST_TIMEOUT);

  afterAll(async () => {
    for (const id of createdReportIds) {
      await httpJson('DELETE', `${BASE_URL}/api/storage/runs/${encodeURIComponent(id)}`).catch(() => {});
    }
    if (runId) {
      await httpJson('DELETE', `${BASE_URL}/api/storage/evaluation-runs/${encodeURIComponent(runId)}`).catch(() => {});
    }
    for (const id of createdTestCaseIds) {
      await httpJson('DELETE', `${BASE_URL}/api/storage/test-cases/${encodeURIComponent(id)}`).catch(() => {});
    }
  }, TEST_TIMEOUT);

  it(
    'resumes only unfinished test cases, preserves completed reports, then 400s when nothing is left',
    async () => {
      if (!backendAvailable) return;

      // 1. Three minimal test cases.
      for (let i = 1; i <= 3; i++) {
        const tc = await httpJson<any>('POST', `${BASE_URL}/api/storage/test-cases`, {
          name: `resume-int-tc${i}`,
          category: 'Diagnostics',
          difficulty: 'Easy',
          initialPrompt: `Say hello (${i})`,
          expectedOutcomes: ['Agent responds'],
          labels: [],
        });
        expect(tc.status).toBeLessThan(300);
        createdTestCaseIds.push(tc.body.id);
      }
      const [tc1, tc2, tc3] = createdTestCaseIds;

      // 2. Seed an "interrupted" run via the no-execution upsert:
      //    tc1 done (has a report id), tc2 pending, tc3 never scheduled.
      runId = `eval-run-resume-int-${Date.now()}`;
      const now = new Date().toISOString();
      const seeded = await httpJson<any>('PUT', `${BASE_URL}/api/storage/evaluation-runs/${runId}`, {
        name: 'resume-int-run',
        sources: [{ type: 'test-case-ids', ids: createdTestCaseIds }],
        agentKey: 'demo',
        modelId: 'demo-model',
        judgeModelId: 'demo-model',
        trigger: 'api',
        status: 'failed',
        error: 'simulated crash',
        createdAt: now,
        testCaseSnapshots: createdTestCaseIds.map((id, i) => ({ id, version: 1, name: `resume-int-tc${i + 1}` })),
        results: {
          [tc1]: { reportId: 'preserved-report-tc1', status: 'completed' },
          [tc2]: { reportId: '', status: 'pending' },
          // tc3 deliberately missing — crashed before it was scheduled
        },
      });
      expect(seeded.status).toBeLessThan(300);

      // 3. Resume — SSE stream until the run completes.
      const resume = await httpJson<any>('POST', `${BASE_URL}/api/storage/evaluation-runs/${runId}/resume`);
      expect(resume.status).toBe(200);
      const events = parseSSE(resume.raw);

      const started = events.find((e) => e.event === 'started');
      expect(started).toBeDefined();
      expect(started!.data.resumed).toBe(true);
      expect(started!.data.pendingCount).toBe(2); // tc2 + tc3, NOT tc1

      const completed = events.find((e) => e.event === 'completed');
      expect(completed).toBeDefined();
      const finalRun = completed!.data;

      // 4. Completed checkpoint preserved byte-for-byte; unfinished re-executed.
      expect(finalRun.status).toBe('completed');
      expect(finalRun.resumedAt).toBeTruthy();
      expect(finalRun.results[tc1].reportId).toBe('preserved-report-tc1');
      expect(finalRun.results[tc2].reportId).toBeTruthy();
      expect(finalRun.results[tc2].reportId).not.toBe('preserved-report-tc1');
      expect(finalRun.results[tc3].reportId).toBeTruthy();
      for (const tcId of [tc2, tc3]) {
        createdReportIds.push(finalRun.results[tcId].reportId);
        expect(finalRun.results[tcId].status).toBe('completed');
      }

      // 5. Stats cover the FULL run (3), not just the resumed subset (2).
      expect(finalRun.stats?.total).toBe(3);

      // 6. Second resume: nothing left → 400.
      const again = await httpJson<any>('POST', `${BASE_URL}/api/storage/evaluation-runs/${runId}/resume`);
      expect(again.status).toBe(400);
      expect(again.body.error).toMatch(/nothing to resume/i);
    },
    TEST_TIMEOUT
  );

  it('404s for an unknown run id', async () => {
    if (!backendAvailable) return;
    const res = await httpJson('POST', `${BASE_URL}/api/storage/evaluation-runs/does-not-exist-xyz/resume`);
    expect(res.status).toBe(404);
  }, TEST_TIMEOUT);

  it('409s a second resume while the first is still executing (codex #2 — double-resume guard)', async () => {
    if (!backendAvailable) return;

    // Seed a second interrupted run over the same test cases.
    const raceRunId = `eval-run-resume-race-${Date.now()}`;
    const seeded = await httpJson<any>('PUT', `${BASE_URL}/api/storage/evaluation-runs/${raceRunId}`, {
      name: 'resume-race-run',
      sources: [{ type: 'test-case-ids', ids: createdTestCaseIds }],
      agentKey: 'demo',
      modelId: 'demo-model',
      judgeModelId: 'demo-model',
      trigger: 'api',
      status: 'failed',
      createdAt: new Date().toISOString(),
      testCaseSnapshots: createdTestCaseIds.map((id, i) => ({ id, version: 1, name: `race-tc${i + 1}` })),
      results: {},
    });
    expect(seeded.status).toBeLessThan(300);

    // Fire the first resume WITHOUT awaiting completion, then a second one.
    const first = httpJson<any>('POST', `${BASE_URL}/api/storage/evaluation-runs/${raceRunId}/resume`);
    await new Promise((r) => setTimeout(r, 1500)); // let the first claim + start
    const second = await httpJson<any>(`POST`, `${BASE_URL}/api/storage/evaluation-runs/${raceRunId}/resume`);
    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/currently executing/i);

    // First resume runs to completion; collect its reports for cleanup.
    const firstRes = await first;
    expect(firstRes.status).toBe(200);
    const completed = parseSSE(firstRes.raw).find((e) => e.event === 'completed');
    expect(completed).toBeDefined();
    for (const v of Object.values<any>(completed!.data.results || {})) {
      if (v.reportId) createdReportIds.push(v.reportId);
    }
    await httpJson('DELETE', `${BASE_URL}/api/storage/evaluation-runs/${raceRunId}`).catch(() => {});
  }, TEST_TIMEOUT);
});

/**
 * Integration test: resumed runs must appear in `benchmark.runs`.
 *
 * Bug (production, hit twice): the create route's success path links a
 * completed run into the benchmark's embedded `runs` array via
 * `storage.benchmarks.addRun`. The resume route's completion path never did
 * this — so a run whose *original* create-route execution crashed BEFORE
 * reaching that success branch stayed invisible in `benchmark.runs` forever,
 * even after a later resume finished it successfully. `GET
 * .../evaluation-runs/:id` looked fine (it reads the evaluation-run document
 * directly); only benchmark-scoped views (benchmark detail page, scoped
 * comparison pool) were missing the run.
 */
describe('POST .../resume — benchmark.runs linking (production bug regression)', () => {
  let backendAvailable = false;
  const createdTestCaseIds: string[] = [];
  const createdReportIds: string[] = [];
  let benchmarkId: string | undefined;
  let runId: string | undefined;

  beforeAll(async () => {
    try {
      const health = await httpJson('GET', `${BASE_URL}/api/agents`);
      backendAvailable = health.status === 200;
    } catch {
      backendAvailable = false;
    }
    if (!backendAvailable) {
      console.warn('[evaluationRunResume:benchmarkLink] Backend not reachable — skipping');
    }
  }, TEST_TIMEOUT);

  afterAll(async () => {
    for (const id of createdReportIds) {
      await httpJson('DELETE', `${BASE_URL}/api/storage/runs/${encodeURIComponent(id)}`).catch(() => {});
    }
    if (runId) {
      await httpJson('DELETE', `${BASE_URL}/api/storage/evaluation-runs/${encodeURIComponent(runId)}`).catch(() => {});
    }
    if (benchmarkId) {
      await httpJson('DELETE', `${BASE_URL}/api/storage/benchmarks/${encodeURIComponent(benchmarkId)}`).catch(() => {});
    }
    for (const id of createdTestCaseIds) {
      await httpJson('DELETE', `${BASE_URL}/api/storage/test-cases/${encodeURIComponent(id)}`).catch(() => {});
    }
  }, TEST_TIMEOUT);

  it(
    'links a resumed run into benchmark.runs exactly once, even though its create-route execution never reached addRun',
    async () => {
      if (!backendAvailable) return;

      // 1. A benchmark with two test cases.
      for (let i = 1; i <= 2; i++) {
        const tc = await httpJson<any>('POST', `${BASE_URL}/api/storage/test-cases`, {
          name: `resume-link-tc${i}`,
          category: 'Diagnostics',
          difficulty: 'Easy',
          initialPrompt: `Say hello (${i})`,
          expectedOutcomes: ['Agent responds'],
          labels: [],
        });
        expect(tc.status).toBeLessThan(300);
        createdTestCaseIds.push(tc.body.id);
      }
      const benchmark = await httpJson<any>('POST', `${BASE_URL}/api/storage/benchmarks`, {
        name: 'resume-link-benchmark',
        description: 'Regression test: resumed runs must appear in benchmark.runs',
        testCaseIds: createdTestCaseIds,
        runs: [],
        currentVersion: 1,
        versions: [{ version: 1, createdAt: new Date().toISOString(), testCaseIds: createdTestCaseIds }],
      });
      expect(benchmark.status).toBeLessThan(300);
      benchmarkId = benchmark.body.id;

      // 2. Seed an evaluation run whose original create-route execution
      //    crashed BEFORE its success branch ever ran `addRun` — i.e. it is
      //    associated with the benchmark (`benchmarkId` set) but the
      //    benchmark's `runs` array has nothing for it. One test case has a
      //    persisted report (a completed test case before the crash), the
      //    other has none.
      const [tc1, tc2] = createdTestCaseIds;
      runId = `eval-run-resume-link-${Date.now()}`;
      const now = new Date().toISOString();
      const seeded = await httpJson<any>('PUT', `${BASE_URL}/api/storage/evaluation-runs/${runId}`, {
        name: 'resume-link-run',
        sources: [{ type: 'test-case-ids', ids: createdTestCaseIds }],
        agentKey: 'demo',
        modelId: 'demo-model',
        judgeModelId: 'demo-model',
        trigger: 'api',
        benchmarkId,
        status: 'failed',
        error: 'simulated crash before create route reached addRun',
        createdAt: now,
        testCaseSnapshots: createdTestCaseIds.map((id, i) => ({ id, version: 1, name: `resume-link-tc${i + 1}` })),
        results: {
          [tc1]: { reportId: 'preserved-report-link-tc1', status: 'completed' },
          [tc2]: { reportId: '', status: 'pending' },
        },
      });
      expect(seeded.status).toBeLessThan(300);

      // Sanity check: before the resume, the benchmark has NO runs — this is
      // exactly the "invisible on the benchmark detail page" symptom.
      const beforeResume = await httpJson<any>('GET', `${BASE_URL}/api/storage/benchmarks/${benchmarkId}`);
      expect(beforeResume.status).toBe(200);
      expect(beforeResume.body.runs || []).toHaveLength(0);

      // 3. Resume to completion.
      const resume = await httpJson<any>('POST', `${BASE_URL}/api/storage/evaluation-runs/${runId}/resume`);
      expect(resume.status).toBe(200);
      const events = parseSSE(resume.raw);
      const completed = events.find((e) => e.event === 'completed');
      expect(completed).toBeDefined();
      expect(completed!.data.status).toBe('completed');
      for (const v of Object.values<any>(completed!.data.results || {})) {
        if (v.reportId && v.reportId !== 'preserved-report-link-tc1') createdReportIds.push(v.reportId);
      }

      // 4. THE BUG: the completed run must now show up in benchmark.runs,
      //    exactly once, with matching id/status/results.
      const afterResume = await httpJson<any>('GET', `${BASE_URL}/api/storage/benchmarks/${benchmarkId}`);
      expect(afterResume.status).toBe(200);
      const linkedRuns = (afterResume.body.runs || []).filter((r: any) => r.id === runId);
      expect(linkedRuns).toHaveLength(1);
      expect(linkedRuns[0].status).toBe('completed');
      expect(linkedRuns[0].results[tc1].reportId).toBe('preserved-report-link-tc1');
      expect(linkedRuns[0].results[tc2].reportId).toBeTruthy();
      expect(linkedRuns[0].completedAt).toBeTruthy();

      // 5. Idempotency: put the SAME run back into a resumable state and
      //    resume it again — must REPLACE the existing benchmark.runs entry,
      //    never duplicate it.
      const reseed = await httpJson<any>('PUT', `${BASE_URL}/api/storage/evaluation-runs/${runId}`, {
        ...completed!.data,
        results: {
          ...completed!.data.results,
          [tc2]: { reportId: '', status: 'pending' },
        },
        status: 'failed',
      });
      expect(reseed.status).toBeLessThan(300);

      const resume2 = await httpJson<any>('POST', `${BASE_URL}/api/storage/evaluation-runs/${runId}/resume`);
      expect(resume2.status).toBe(200);
      const completed2 = parseSSE(resume2.raw).find((e) => e.event === 'completed');
      expect(completed2).toBeDefined();
      for (const v of Object.values<any>(completed2!.data.results || {})) {
        if (v.reportId && v.reportId !== 'preserved-report-link-tc1' && !createdReportIds.includes(v.reportId)) {
          createdReportIds.push(v.reportId);
        }
      }

      const afterSecondResume = await httpJson<any>('GET', `${BASE_URL}/api/storage/benchmarks/${benchmarkId}`);
      const linkedRunsAfterSecond = (afterSecondResume.body.runs || []).filter((r: any) => r.id === runId);
      expect(linkedRunsAfterSecond).toHaveLength(1); // still exactly one — never duplicated
    },
    TEST_TIMEOUT
  );

  it(
    'a benchmark-linking failure never corrupts the canonical run status (codex_review finding)',
    async () => {
      if (!backendAvailable) return;

      // A run whose test cases will genuinely complete, but whose
      // `benchmarkId` points at a benchmark that does not exist —
      // deterministically forces linkCompletedRunToBenchmark's "not found"
      // path on the resume completion path.
      const orphanRunId = `eval-run-resume-link-orphan-${Date.now()}`;
      const tc = await httpJson<any>('POST', `${BASE_URL}/api/storage/test-cases`, {
        name: `resume-link-orphan-tc-${Date.now()}`,
        category: 'Diagnostics',
        difficulty: 'Easy',
        initialPrompt: 'Say hello',
        expectedOutcomes: ['Agent responds'],
        labels: [],
      });
      expect(tc.status).toBeLessThan(300);
      const orphanTcId = tc.body.id;

      const seeded = await httpJson<any>('PUT', `${BASE_URL}/api/storage/evaluation-runs/${orphanRunId}`, {
        name: 'resume-link-orphan-run',
        sources: [{ type: 'test-case-ids', ids: [orphanTcId] }],
        agentKey: 'demo',
        modelId: 'demo-model',
        judgeModelId: 'demo-model',
        trigger: 'api',
        benchmarkId: 'benchmark-does-not-exist-orphan',
        status: 'failed',
        error: 'simulated crash',
        createdAt: new Date().toISOString(),
        testCaseSnapshots: [{ id: orphanTcId, version: 1, name: 'resume-link-orphan-tc' }],
        results: { [orphanTcId]: { reportId: '', status: 'pending' } },
      });
      expect(seeded.status).toBeLessThan(300);

      const resume = await httpJson<any>('POST', `${BASE_URL}/api/storage/evaluation-runs/${orphanRunId}/resume`);
      expect(resume.status).toBe(200);
      const completed = parseSSE(resume.raw).find((e) => e.event === 'completed');
      expect(completed).toBeDefined();

      // THE FIX: even though linking into the (nonexistent) benchmark threw,
      // the run itself — whose test case genuinely completed — is still
      // reported 'completed', never falsely flipped to 'failed'.
      expect(completed!.data.status).toBe('completed');
      const persisted = await httpJson<any>('GET', `${BASE_URL}/api/storage/evaluation-runs/${orphanRunId}`);
      expect(persisted.body.status).toBe('completed');

      const reportId = completed!.data.results?.[orphanTcId]?.reportId;
      if (reportId) await httpJson('DELETE', `${BASE_URL}/api/storage/runs/${encodeURIComponent(reportId)}`).catch(() => {});
      await httpJson('DELETE', `${BASE_URL}/api/storage/evaluation-runs/${orphanRunId}`).catch(() => {});
      await httpJson('DELETE', `${BASE_URL}/api/storage/test-cases/${orphanTcId}`).catch(() => {});
    },
    TEST_TIMEOUT
  );
});
