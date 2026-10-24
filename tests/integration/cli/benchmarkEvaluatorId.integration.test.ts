/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * End-to-end CLI integration test for run-level evaluatorId binding.
 *
 * Why this test exists
 * ────────────────────
 * The "SDK and CLI behave identically" claim is only true for code that
 * lives in the shared server-side runner (`executeRun` /
 * `executeEvaluationRun`). The CLI binary has its own preparation path
 * before it hits the runner — `cli/commands/benchmark.ts` walks the
 * SDK file itself and POSTs both the upserted test cases and the
 * `evaluatorId` to the server. Issue #245 (PR c5ab413b) was the worked
 * example of this asymmetry: the CLI silently dropped
 * `expectedOutcomes` on import while the HTTP API path got it right.
 *
 * For this PR (run-level `evaluatorId` binding) the runner-side change
 * is shared by both paths, but per the lesson from #245 we do not trust
 * "logically equivalent" — we spawn the actual CLI binary and assert
 * that the persisted matcherResults reflect the bound evaluator ID,
 * including the precedence rules:
 *
 *   • The run-level `-e` selection is AUTHORITATIVE: a per-call
 *     `judge(result, claim, { evaluatorId })` pin in the body does NOT
 *     override it — the run's evaluator rides the request and the pin is
 *     recorded on the report as a `judgeSelectionConflicts` entry.
 *   • A `judge(result, claim)` call with NO per-call options inherits
 *     the run-level value.
 *
 * The asymmetry the smoke test exploits: a bogus run-level evaluator id
 * causes /api/judge to return 400 ("Evaluator not found: <id>"), which
 * appears verbatim in the persisted matcherResult's errorMessage. If
 * the binding silently dropped the id, the call would use the server
 * default and pass — making the test fail in a way that points at the
 * regression rather than at a generic flake.
 *
 * Approach
 * ────────
 *   1. Materialize a tiny SDK fixture with two `judge()` calls — one
 *      with a per-call override, one without.
 *   2. Spawn `node cli/dist/index.js benchmark -f <fixture>.eval.js
 *      -a demo -m demo-model -e definitely-does-not-exist`.
 *   3. Read back the persisted run + matcherResults via the HTTP API.
 *   4. Assert: BOTH matchers fail with the exact 'Evaluator not found'
 *      string (the run-level binding rode on every request, including the
 *      one whose body pinned a different evaluator), and the report's
 *      `judgeSelectionConflicts` names the overridden pin.
 *
 * Why the demo provider
 * ─────────────────────
 * The mock-judge provider returns a synthetic verdict for any non-empty
 * (trajectory, claim) pair. We use it because:
 *   • No Bedrock credentials needed in CI.
 *   • The mock provider still goes through the full /api/judge resolution
 *     path — `evaluatorId` is looked up via getSystemEvaluatorById /
 *     storage.evaluators.getById BEFORE provider routing. A bogus id is
 *     rejected with HTTP 400 regardless of provider.
 *   • The bogus-id 400 is the exact signal we want; the provider never
 *     gets a chance to mask the binding regression.
 *
 * Prerequisites
 * ─────────────
 *   • Backend running (npm run dev:server). Test self-skips otherwise.
 *   • CLI bundle built (npm run build:cli). The test rebuilds if missing.
 */

import { spawnSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { request as httpRequest } from 'http';
import { getTestBackendUrl } from '@/tests/integration/testConfig';
import { createTestDataTracker, uniqueTestName } from '../../helpers/testDataTracker';

// Same dodge as benchmarkCodeSdk.integration.test.ts — Jest 30 + undici
// has a known race with localhost connections that surfaces as
// 'SocketError: other side closed' on the first request from a worker.
// Plain Node http with agent:false sidesteps it.
function httpGet<T = any>(url: string): Promise<{ status: number; body: T }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = httpRequest({
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname + u.search,
      method: 'GET',
      headers: { Accept: 'application/json' },
      agent: false,
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        try {
          resolve({ status: res.statusCode || 0, body: text ? JSON.parse(text) : ({} as T) });
        } catch {
          resolve({ status: res.statusCode || 0, body: text as any });
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const TEST_TIMEOUT = 90_000;
const BASE_URL = getTestBackendUrl();
const REPO_ROOT = process.cwd();
const CLI_BUNDLE = join(REPO_ROOT, 'cli/dist/index.js');

const checkBackend = async (): Promise<boolean> => {
  try {
    const r = await httpGet(`${BASE_URL}/api/agents`);
    if (r.status !== 200) return false;
    const s = await httpGet<{ status?: string }>(`${BASE_URL}/api/storage/health`);
    return (s.body as any).status === 'ok';
  } catch {
    return false;
  }
};

// One fixture — two judge() calls in a single test.
//   • Call #1: explicit per-call evaluatorId = system-rca-default (valid)
//   • Call #2: no per-call options — must inherit run-level binding
//
// We use 'system-rca-default' for the override because every system
// evaluator is guaranteed present in any agent-health server (built-in
// templates in lib/server/prompts/evaluatorTemplates.ts).
//
// The trajectory is synthetic — the mock-judge provider doesn't care
// about content as long as the pair (trajectory, claim) is non-empty.
const FIXTURE_CONTENT = `
const { test, expect } = require('@opensearch-project/agent-health');

test('evaluator-id-cli-binding', {
  description: 'CLI subprocess: run-level evaluatorId binding precedence rules',
  labels: ['category:Smoke', 'feature:sdk-evaluator-id', 'kind:cli-coverage'],
  timeout: 30_000,
}, async function ({ judge }) {
  const fakeResult = {
    trajectory: [
      { type: 'action', toolName: 'fake_tool', content: '{"q":"x"}' },
      { type: 'response', content: 'I checked, looks good.' },
    ],
  };
  // Per-call pin — the run-level selection is authoritative, so this rides
  // the bogus run-level id too (and is recorded as a conflict).
  await judge(fakeResult, 'per-call override', { evaluatorId: 'system-rca-default' });
  // No per-call — must use the bound run-level evaluator and fail.
  await judge(fakeResult, 'bound run-level claim');
  expect(true, 'reached completion').to.equal(true);
});
`;

describe('CLI: run-level evaluatorId binding (precedence rules end-to-end)', () => {
  let backendAvailable = false;
  let tempDir: string;
  let fixturePath: string;
  let report: any;
  // Tracks every benchmark/evaluation-run/test-case/report this suite
  // creates so afterAll can delete all of it (see
  // tests/helpers/testDataTracker.ts). DELETE benchmark/evaluation-run does
  // NOT cascade to test cases or their per-test-case report doc.
  const tracker = createTestDataTracker();

  beforeAll(async () => {
    backendAvailable = await checkBackend();
    if (!backendAvailable) {
      // eslint-disable-next-line no-console
      console.warn(`[cli-eval-id] Backend not reachable at ${BASE_URL} — skipping. Start with: npm run dev:server`);
      return;
    }

    if (!existsSync(CLI_BUNDLE)) {
      // eslint-disable-next-line no-console
      console.log('[cli-eval-id] CLI bundle missing; building once before tests…');
      const build = spawnSync('npm', ['run', 'build:cli'], { cwd: REPO_ROOT, encoding: 'utf-8' });
      if (build.status !== 0) {
        throw new Error(`CLI build failed: ${build.stderr}`);
      }
    }

    tempDir = mkdtempSync(join(tmpdir(), 'cli-eval-id-'));
    fixturePath = join(tempDir, 'evaluator-id.eval.js');
    writeFileSync(fixturePath, FIXTURE_CONTENT, 'utf-8');

    // Spawn the CLI exactly the way a user would. Pin the port so the
    // CLI talks to the same server the test config points at; clean env
    // so Jest-injected coverage shims don't confuse undici inside the
    // spawned CLI's ServerLifecycle health check (see
    // benchmarkCodeSdk.integration.test.ts for the worked rationale).
    const port = new URL(BASE_URL).port || '4001';
    const benchmarkName = uniqueTestName('cli-eval-id-binding');
    const cleanEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v !== 'string') continue;
      if (k === 'PATH' || k === 'HOME' || k === 'USER' || k === 'TMPDIR' || k.startsWith('AWS_')) {
        cleanEnv[k] = v;
      }
    }
    cleanEnv.AGENT_HEALTH_PORT = port;
    cleanEnv.AGENT_HEALTH_SUPPRESS_EXPERIMENTAL = '1';

    // The KEY argument here: -e definitely-does-not-exist.
    // If bindJudge works, this id rides through to /api/judge on the
    // bound (no-per-call) judge call and gets rejected with HTTP 400.
    // If bindJudge silently dropped the id, the bound call would pass
    // against the server-default evaluator and the test would fail.
    const cli = spawnSync('node', [
      CLI_BUNDLE, 'benchmark',
      '-f', fixturePath,
      '-a', 'demo',
      // Pin the JUDGE model to the mock `demo` provider so matcher #1 (valid
      // evaluator) passes deterministically regardless of content/credentials
      // — this suite proves evaluatorId *binding precedence*, not judge scoring,
      // and must run without Bedrock in CI. A real judge would score the
      // synthetic trajectory non-deterministically (and need AWS creds).
      '--judge-model', 'demo-model',
      '-e', 'definitely-does-not-exist',
      '-n', benchmarkName,
    ], {
      cwd: REPO_ROOT,
      env: cleanEnv,
      encoding: 'utf-8',
      timeout: TEST_TIMEOUT - 10_000,
    });

    // Track the benchmark shell by its (unique, known) name regardless of
    // whether the run itself succeeded (see benchmarkCodeSdk.integration.test.ts
    // for the worked rationale: the CLI creates the benchmark BEFORE starting
    // the run, so a downstream failure would otherwise leave an untracked
    // shell). Best-effort: never throws.
    try {
      const listRes = await httpGet<any>(`${BASE_URL}/api/storage/benchmarks?size=1000`);
      const found = (listRes.body?.benchmarks || []).find((b: any) => b.name === benchmarkName);
      if (found) {
        tracker.benchmark(found.id);
        tracker.testCases(found.testCaseIds);
        // Also track every evaluation-run linked to this benchmark: a run
        // that fails before the CLI ever prints its "View results" URL is
        // otherwise undiscoverable (confirmed empirically — it is NOT
        // reachable from benchmark.testCaseIds), plus every report each of
        // those runs points at (DELETE evaluation-run does not cascade).
        const runsRes = await httpGet<any>(
          `${BASE_URL}/api/storage/evaluation-runs?benchmarkId=${encodeURIComponent(found.id)}&size=500`
        );
        for (const r of runsRes.body?.evaluationRuns || []) {
          tracker.evaluationRun(r.id);
          for (const result of Object.values(r.results || {})) {
            tracker.run((result as any)?.reportId);
          }
        }
      }
    } catch {
      /* best effort */
    }

    if (cli.status === null) {
      throw new Error(`CLI subprocess timed out or was killed.\nSTDOUT:\n${cli.stdout}\nSTDERR:\n${cli.stderr}`);
    }

    // Parse the 'View results:' URL line for (benchmarkId, runId).
    const stdout = (cli.stdout || '').replace(/\u001b\[[0-9;]*m/g, '');
    const urlRe = /\/evaluations\/benchmarks\/(bench-[A-Za-z0-9-]+)\/runs\/((?:eval-)?run-[A-Za-z0-9-]+)/;
    const m = urlRe.exec(stdout);
    if (!m) {
      throw new Error(`Could not parse benchmark/run from CLI stdout:\n${stdout}\nSTDERR:\n${cli.stderr}`);
    }
    const [, benchmarkId, runId] = m;
    // Track for cleanup up front, before any assertion below can throw:
    // DELETE benchmark/evaluation-run does NOT cascade to test cases or
    // reports (see tests/helpers/testDataTracker.ts), so all four are
    // tracked explicitly.
    tracker.benchmark(benchmarkId);
    tracker.evaluationRun(runId);
    const benchRes = await httpGet<any>(`${BASE_URL}/api/storage/benchmarks/${benchmarkId}`);
    if (benchRes.status === 200) tracker.testCases(benchRes.body?.testCaseIds);

    // Pull the run + the single test case's persisted report. The code-import
    // (unified) path persists an `eval-run-…` document; fetch it directly from
    // the evaluation-runs endpoint rather than via benchmark.runs.
    const runRes = await httpGet<any>(`${BASE_URL}/api/storage/evaluation-runs/${runId}`);
    if (runRes.status !== 200) {
      throw new Error(`GET evaluation-run failed: ${runRes.status} for ${runId}`);
    }
    const run = runRes.body;

    const reportEntries = Object.values(run.results || {}) as Array<{ reportId?: string }>;
    if (reportEntries.length !== 1 || !reportEntries[0].reportId) {
      throw new Error(`Expected exactly one report, got ${reportEntries.length}: ${JSON.stringify(run.results)}`);
    }
    tracker.run(reportEntries[0].reportId);
    const reportRes = await httpGet<any>(`${BASE_URL}/api/storage/runs/${reportEntries[0].reportId}`);
    if (reportRes.status !== 200) {
      throw new Error(`GET report failed: ${reportRes.status}`);
    }
    report = reportRes.body;
  }, TEST_TIMEOUT);

  afterAll(async () => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    await tracker.cleanup();
  });

  // ─────────────────────────────────────────────────────────────────
  // Backend gate — every assertion below assumes the CLI ran.
  // ─────────────────────────────────────────────────────────────────
  it('requires a running backend (skip otherwise)', () => {
    if (!backendAvailable) {
      // eslint-disable-next-line jest/no-conditional-expect
      expect(true).toBe(true);
      return;
    }
    // eslint-disable-next-line jest/no-conditional-expect
    expect(report).toBeDefined();
  });

  it('the run is marked errored (null pass/fail) — the bogus run-level evaluator could not be loaded', () => {
    if (!backendAvailable) return;
    // matcher #2's judge() hit an unloadable evaluator ("Evaluator not found"),
    // which is an evaluator *error*, not a clean pass/fail judgment about the
    // agent — so the run's overall pass/fail is null (errored state), never
    // 'passed'. (buildEvaluatorErrorPatch / #242 deliberately nulls it.)
    // eslint-disable-next-line jest/no-conditional-expect
    expect(report.passFailStatus == null).toBe(true);
    // eslint-disable-next-line jest/no-conditional-expect
    expect(report.passFailStatus).not.toBe('passed');
  });

  it('records exactly two judge matcherResults — one per judge() call', () => {
    if (!backendAvailable) return;
    const judges = (report.matcherResults || []).filter((m: any) => m.method === 'llm-judge');
    // eslint-disable-next-line jest/no-conditional-expect
    expect(judges).toHaveLength(2);
  });

  it('run-level -e is authoritative: matcher #1 (body pinned system-rca-default) STILL fails with the bogus run-level id, and the pin is recorded as a conflict', () => {
    if (!backendAvailable) return;
    const judges = (report.matcherResults || []).filter((m: any) => m.method === 'llm-judge');
    const override = judges.find((m: any) => /per-call override/.test(m.description));
    // eslint-disable-next-line jest/no-conditional-expect
    expect(override).toBeDefined();
    // The body asked for a valid evaluator, but the person who launched the
    // run picked `-e definitely-does-not-exist` — that wins. Pre-fix this
    // matcher passed (body pin applied) while the report was labelled with
    // the run's evaluator: verdict from one judge, label from another.
    // eslint-disable-next-line jest/no-conditional-expect
    expect(override.pass).toBe(false);
    // eslint-disable-next-line jest/no-conditional-expect
    expect(override.errorMessage || '').toMatch(/Evaluator not found:\s*definitely-does-not-exist/);
    // eslint-disable-next-line jest/no-conditional-expect
    expect(override.evaluatorId).toBe('definitely-does-not-exist');
    // The disagreement is on the report, not swallowed.
    // eslint-disable-next-line jest/no-conditional-expect
    expect(report.judgeSelectionConflicts).toEqual([
      { field: 'evaluatorId', runValue: 'definitely-does-not-exist', bodyValue: 'system-rca-default' },
    ]);
    // eslint-disable-next-line jest/no-conditional-expect
    expect(report.judgeApplied?.evaluatorId).toBe('definitely-does-not-exist');
    // eslint-disable-next-line jest/no-conditional-expect
    expect(report.judgeApplied?.evaluatorIdSource).toBe('run');
  });

  it('run-level binding rode through: matcher #2 FAILS with exact "Evaluator not found" error from /api/judge', () => {
    if (!backendAvailable) return;
    const judges = (report.matcherResults || []).filter((m: any) => m.method === 'llm-judge');
    const bound = judges.find((m: any) => /bound run-level/.test(m.description));
    // eslint-disable-next-line jest/no-conditional-expect
    expect(bound).toBeDefined();
    // eslint-disable-next-line jest/no-conditional-expect
    expect(bound.pass).toBe(false);

    // The whole point of this test: if bindJudge silently dropped
    // run.evaluatorId, this errorMessage would NOT contain the
    // bogus id — the request would have hit the server with no
    // evaluatorId set, the server would have used the default, and
    // the call would have passed. The exact id appearing here is
    // unambiguous proof that it rode through the request body.
    // eslint-disable-next-line jest/no-conditional-expect
    expect(bound.errorMessage || '').toMatch(/Evaluator not found:\s*definitely-does-not-exist/);
  });

  it('CLI -e flag is the only place the bogus id could have come from (round-trip sanity check)', () => {
    if (!backendAvailable) return;
    // The fixture content is checked into this file; grep it for the
    // bogus id to guarantee a maintainer who edits FIXTURE_CONTENT
    // can't accidentally hide the id inside the test body itself.
    // If this assertion fails, the test no longer proves what its
    // name claims to prove.
    // eslint-disable-next-line jest/no-conditional-expect
    expect(FIXTURE_CONTENT).not.toContain('definitely-does-not-exist');
  });
});
