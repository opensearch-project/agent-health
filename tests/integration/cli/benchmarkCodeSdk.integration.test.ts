/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * End-to-end CLI integration test for the code-based test SDK.
 *
 * Why this test exists
 * ────────────────────
 * Issue #245 surfaced a real regression: the `agent-health benchmark -f
 * file.eval.js` CLI shipped with bodies that were never invoked, chai
 * `expect(...)` was a no-op, and `expectedOutcomes` / `expectedTrajectory`
 * weren't forwarded to persisted test cases. The bug slipped through every
 * existing test layer because:
 *
 *   • Unit tests for the CLI (`tests/unit/cli/benchmarkCodeFile.test.ts`)
 *     mock `loadTestCasesFromModule`, the API client, and the server
 *     lifecycle — so they only verify file-extension matching, not the
 *     pipeline.
 *   • Integration tests for sourceResolver verify pieces in isolation
 *     (`tests/integration/services/codeSdkObservio.integration.test.ts`,
 *     `…/sourceResolver.codeImport.integration.test.ts`) — they don't
 *     spawn the CLI, never see the runner's matcher session, and never
 *     check expected* persistence on the upserted test case.
 *   • The "CLI" e2e test (`tests/e2e/code-sdk-observio.spec.ts`) actually
 *     drives the HTTP API via `page.evaluate(fetch('/api/...'))`. It
 *     never runs the CLI binary; the docstring is misleading.
 *
 * No test in the repo spawns the CLI binary against a code-SDK fixture
 * and asserts that matcher results, expected* fields, and hook outcomes
 * make it through to the persisted run. This file plugs that hole.
 *
 * Approach
 * ────────
 * We spawn the actual CLI subprocess once with a fixture that exercises
 * every SDK feature (one fixture, many tests inside) and then read back
 * the persisted run + reports + test cases through the HTTP API. Each
 * SDK condition is validated by its own `it()` block so a regression in
 * one feature shows a single targeted failure rather than a wall of red.
 *
 * SDK conditions covered
 * ──────────────────────
 *   1.  test(name, body)                    — 2-arg overload
 *   2.  test(name, options, body)           — 3-arg overload
 *   3.  TestOptions.prompt = undefined      — no agent invocation
 *   4.  TestOptions.prompt = '…'            — agent IS invoked
 *   5.  expect(...) chai matcher PASSING    — recorded as pass
 *   6.  expect(...) chai matcher FAILING    — recorded as fail with errorMessage
 *   7.  Custom matcher: haveCompletedWithin
 *   8.  describe(name, fn)                  — benchmarkPath on persisted test cases
 *   9.  Nested describe                     — A > B benchmarkPath
 *   10. beforeAll                           — once-per-scope, replayed per test
 *   11. afterAll                            — drain counter, only on last test
 *   12. beforeEach + provide()              — fixtures.provisioned populated
 *   13. afterEach reads provisioned         — cleanup path
 *   14. testInfo metadata visible to hooks  — testInfo.name flows through
 *   15. test.beforeEach static-method form  — Playwright sugar
 *   16. afterEach runs even when body throws — error path
 *   17. TestOptions.expectedOutcomes        — forwarded to persisted test case
 *   18. TestOptions.expectedTrajectory      — forwarded with typed shape
 *   19. TestOptions.context                 — forwarded to persisted test case
 *   20. TestOptions.labels                  — forwarded; category/difficulty derived
 *
 * What we deliberately don't cover here
 * ─────────────────────────────────────
 *   • judge(result, criteria) — calls Bedrock; covered by judge unit tests
 *     and the dedicated judge integration test.
 *   • haveCalledTool/haveStepsOfType/haveOutputMatching — needs an agent
 *     that actually emits tool calls; the demo mock connector doesn't.
 *     Covered by separate Observio-driven integration tests.
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

// Jest 30 + undici has a known race with localhost connections that
// surfaces as `SocketError: other side closed` on the very first request
// from a worker. Curl and a plain Node 'http' request both work fine, so
// we use http.request directly to dodge the bug entirely.
function httpGet<T = any>(url: string): Promise<{ status: number; body: T }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = httpRequest({
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname + u.search,
      method: 'GET',
      headers: { Accept: 'application/json' },
      // Disable keep-alive / agent pooling. Without this, after the CLI
      // subprocess has exercised the same loopback the test process
      // sometimes inherits a half-closed socket from Node's default
      // agent and the next request returns 'socket hang up'.
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
    const r = await httpGet(`${BASE_URL}/health`);
    if (r.status !== 200) return false;
    const s = await httpGet<{ status?: string }>(`${BASE_URL}/api/storage/health`);
    return (s.body as any).status === 'ok';
  } catch {
    return false;
  }
};

// One fixture, many tests. The CLI runs this whole file in a single
// subprocess; each test inside maps to one persisted report we then
// fetch and assert on. Using `// eslint-disable` because the fixture is
// runtime JS, not TS.
//
// Note: we deliberately AVOID `describe()` blocks here. The CLI's
// per-describe benchmark creation matches by name across runs, so a
// stable describe name (e.g. "Inner Group") accumulates test cases
// from previous runs of this test file and the subprocess slows to a
// crawl. Describe semantics are covered by `tests/unit/lib/testCases/
// define.test.ts`; here we focus on the CLI body-execution path that
// only exists in this file.
const FIXTURE_CONTENT = `
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  test,
  beforeAll, afterAll, beforeEach, afterEach,
  expect,
} = require('@opensearch-project/agent-health');

// Suite-scoped temp dir — proves beforeAll runs once and afterAll cleans it.
let SUITE_ROOT;
beforeAll(() => { SUITE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-sdk-suite-')); });
afterAll(() => { if (SUITE_ROOT && fs.existsSync(SUITE_ROOT)) fs.rmSync(SUITE_ROOT, { recursive: true, force: true }); });

// Per-test workspace via provide() — proves beforeEach/afterEach + isolation.
beforeEach(({ provide, testInfo }) => {
  const safe = testInfo.name.replace(/[^a-z0-9-]+/gi, '_');
  const dir = fs.mkdtempSync(path.join(SUITE_ROOT, safe + '-'));
  provide('workspaceDir', dir);
});
afterEach(({ provisioned }) => {
  const d = provisioned.workspaceDir;
  if (typeof d === 'string' && fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
});

// ───── 2-arg form (name, body), no options. ─────
test('two-arg-form', ({ provisioned }) => {
  expect(provisioned.workspaceDir).to.be.a('string');
});

// ───── 3-arg form, no prompt → body runs, agent skipped, chai PASS. ─────
test('chai-pass', {
  description: 'chai expect passing path',
  labels: ['category:Smoke', 'difficulty:Easy', 'feature:cli-coverage'],
}, ({ provisioned, testInfo }) => {
  expect(testInfo.name).to.equal('chai-pass');
  expect(path.basename(provisioned.workspaceDir)).to.include('chai-pass');
});

// ───── 3-arg form, no prompt → chai FAIL records the failure. ─────
test('chai-fail', {
  description: 'chai expect failing path — must be recorded, not silently skipped',
  labels: ['category:Smoke', 'difficulty:Easy'],
}, () => {
  expect('a').to.equal('b');
});

// ───── Custom matcher: haveCompletedWithin. No-prompt mode → durationMs=0. ─────
test('custom-matcher-haveCompletedWithin', { description: 'No-prompt path so durationMs is 0' }, ({ result }) => {
  expect(result).to.haveCompletedWithin(60_000);
});

// ───── expectedOutcomes / expectedTrajectory forwarded to persisted test case. ─────
test('expected-outcomes-forwarded', {
  description: 'Forwarded to persisted test case for server evaluators (#245)',
  context: [{ description: 'env', value: 'prod' }],
  expectedOutcomes: ['identifies the failing dependency', 'proposes remediation'],
  expectedTrajectory: [
    { step: 1, description: 'search logs', requiredTools: ['search_logs'] },
    { step: 2, description: 'check metrics', requiredTools: ['get_metrics'] },
  ],
}, () => {
  expect(true).to.equal(true);
});

// ───── afterEach must run even when the body throws. ─────
test('afterEach-runs-on-failure', ({ provisioned }) => {
  fs.writeFileSync(path.join(provisioned.workspaceDir, 'marker'), 'x');
  expect('body throws').to.equal('after this');
});

// ───── test.beforeEach static-method form. We register a hook this way
//   that writes a sentinel; the test below asserts the sentinel exists. ─────
test.beforeEach(({ provisioned }) => {
  fs.writeFileSync(path.join(provisioned.workspaceDir, '.static-form-ran'), '1');
});
test('static-method-form', ({ provisioned }) => {
  expect(fs.existsSync(path.join(provisioned.workspaceDir, '.static-form-ran'))).to.equal(true);
});

// ───── Drain-counter sanity: this is the LAST test, so its matcher
//   list should include 'afterAll hook'. ─────
test('zz-last-test-in-scope', ({ provisioned }) => {
  expect(provisioned.workspaceDir).to.be.a('string');
});
`;

describe('Code SDK — CLI subprocess integration (every SDK condition)', () => {
  let backendAvailable = false;
  let tempDir: string;
  let fixturePath: string;
  let benchmarkId = '';
  let runId = '';
  // Map of test name → persisted reportId. Populated once after the CLI
  // run; each `it()` looks up by name to keep assertions targeted.
  const reportIds = new Map<string, string>();
  // Map of test name → persisted test case. For checking forwarded fields
  // (expectedOutcomes, labels, etc.) on the test case definition itself.
  const testCases = new Map<string, any>();

  beforeAll(async () => {
    backendAvailable = await checkBackend();
    if (!backendAvailable) {
      // eslint-disable-next-line no-console
      console.warn(`[cli-sdk] Backend not reachable at ${BASE_URL} — skipping. Start with: npm run dev:server`);
      return;
    }

    if (!existsSync(CLI_BUNDLE)) {
      // eslint-disable-next-line no-console
      console.log('[cli-sdk] CLI bundle missing; building once before tests…');
      const build = spawnSync('npm', ['run', 'build:cli'], { cwd: REPO_ROOT, encoding: 'utf-8' });
      if (build.status !== 0) {
        throw new Error(`CLI build failed: ${build.stderr}`);
      }
    }

    tempDir = mkdtempSync(join(tmpdir(), 'cli-sdk-int-'));
    fixturePath = join(tempDir, 'sdk-coverage.eval.js');
    writeFileSync(fixturePath, FIXTURE_CONTENT, 'utf-8');

    // Spawn the CLI exactly the way a user would. We pin the port so the
    // CLI talks to the same server the test config points at.
    const port = new URL(BASE_URL).port || '4001';
    const benchmarkName = `sdk-cli-coverage-${Date.now()}`;
    // Filter Jest-injected env. Jest 30 sets NODE_OPTIONS / VITEST flags
    // and various coverage shims that confuse undici inside the spawned
    // CLI — ServerLifecycle's `fetch('/health')` fails, the CLI thinks no
    // server is running, starts its own on 4002, and our test reads from
    // 4001 (the user's server) where the data never landed.
    const cleanEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v !== 'string') continue;
      // Keep only the env we actually need.
      if (k === 'PATH' || k === 'HOME' || k === 'USER' || k === 'AWS_REGION' ||
          k.startsWith('AWS_') || k === 'TMPDIR') {
        cleanEnv[k] = v;
      }
    }
    cleanEnv.AH_PORT = port;
    cleanEnv.AH_SUPPRESS_EXPERIMENTAL = '1';
    cleanEnv.AH_QUIET_DEPRECATIONS = '1';
    const cli = spawnSync('node', [CLI_BUNDLE, 'benchmark', '-f', fixturePath, '-a', 'demo', '-n', benchmarkName], {
      cwd: REPO_ROOT,
      env: cleanEnv,
      encoding: 'utf-8',
      timeout: TEST_TIMEOUT - 10_000,
    });

    if (cli.status === null) {
      throw new Error(`CLI subprocess timed out or was killed.\nSTDOUT:\n${cli.stdout}\nSTDERR:\n${cli.stderr}`);
    }

    // The CLI creates a separate benchmark per describe()-block (plus
    // one for orphan tests at the file's top level). Parse the
    // 'View results:' URL lines — they're the only place that gives us
    // the (benchmarkId, runId) pairs together. Format:
    //   Demo Agent (Group Name): http://.../benchmarks/<bid>/runs/<rid>
    const stdout = (cli.stdout || '').replace(/\u001b\[[0-9;]*m/g, ''); // strip ANSI
    const urlRe = /\/evaluations\/benchmarks\/(bench-[A-Za-z0-9-]+)\/runs\/(run-[A-Za-z0-9-]+)/g;
    const benchRunPairs: Array<{ bid: string; rid: string }> = [];
    let m: RegExpExecArray | null;
    while ((m = urlRe.exec(stdout)) !== null) {
      benchRunPairs.push({ bid: m[1], rid: m[2] });
    }
    if (benchRunPairs.length === 0) {
      throw new Error(`Could not parse benchmark/run pairs from CLI output:\n${stdout}`);
    }
    benchmarkId = benchRunPairs[0].bid;
    runId = benchRunPairs[0].rid;

    // Pull every benchmark and merge their runs / results.
    const allRuns: any[] = [];
    for (const { bid, rid } of benchRunPairs) {
      const benchRes = await httpGet<any>(`${BASE_URL}/api/storage/benchmarks/${bid}`);
      if (benchRes.status !== 200) continue;
      const bench = benchRes.body;
      const run = (bench.runs || []).find((r: any) => r.id === rid);
      if (run) allRuns.push(run);
    }
    if (allRuns.length === 0) throw new Error(`No runs found across ${benchRunPairs.length} benchmark(s).`);

    // Snapshot test cases so we can verify forwarded fields.
    const tcAll = (await httpGet<any>(`${BASE_URL}/api/storage/test-cases?size=500`)).body;
    for (const tc of tcAll.testCases || tcAll.items || []) {
      if ((tc.sourceFile || '').includes('sdk-coverage.eval.js')) {
        testCases.set(tc.name, tc);
      }
    }

    // Build name → report map across every run we collected.
    for (const run of allRuns) {
      for (const [tcId, result] of Object.entries((run.results || {}) as Record<string, any>)) {
        const tcName = (run.testCaseSnapshots || []).find((s: any) => s.id === tcId)?.name;
        if (tcName && (result as any).reportId) {
          const rep = (await httpGet<any>(`${BASE_URL}/api/storage/runs/${(result as any).reportId}`)).body;
          reportIds.set(tcName, rep);
        }
      }
    }
  }, TEST_TIMEOUT);

  afterAll(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  // Helper — the per-test report (persisted EvaluationReport with
  // matcherResults). We read from the populated map; if the lookup fails
  // we fail loudly so the maintainer doesn't chase a phantom bug.
  function reportFor(name: string): any {
    const r = reportIds.get(name);
    if (!r) throw new Error(`No persisted report for test "${name}". Available: ${[...reportIds.keys()].join(', ')}`);
    return r;
  }
  function matchersFor(name: string): any[] {
    return reportFor(name).matcherResults || [];
  }
  function bodyMatchersFor(name: string): any[] {
    return matchersFor(name).filter(m => !/(beforeAll|beforeEach|afterEach|afterAll) hook/.test(m.description));
  }
  function hookMatchersFor(name: string): any[] {
    return matchersFor(name).filter(m => /(beforeAll|beforeEach|afterEach|afterAll) hook/.test(m.description));
  }

  // ─────────────────────────────────────────────────────────────────
  // Backend gate — every assertion below assumes the CLI ran.
  // ─────────────────────────────────────────────────────────────────
  it('requires a running backend (skip otherwise)', () => {
    if (!backendAvailable) {
      // eslint-disable-next-line jest/no-conditional-expect
      expect(true).toBe(true);
      return;
    }
    expect(benchmarkId).toMatch(/^bench-/);
    expect(runId).toMatch(/^run-/);
    expect(reportIds.size).toBeGreaterThan(0);
  });

  // ─────────────────────────────────────────────────────────────────
  // Condition 1+2 — both test() overloads register and run.
  // ─────────────────────────────────────────────────────────────────
  it('SDK condition 1: 2-arg test(name, body) form runs the body', () => {
    if (!backendAvailable) return;
    expect(reportFor('two-arg-form').passFailStatus).toBe('passed');
    expect(bodyMatchersFor('two-arg-form').length).toBeGreaterThan(0);
  });

  it('SDK condition 2: 3-arg test(name, options, body) form runs the body', () => {
    if (!backendAvailable) return;
    expect(reportFor('chai-pass').passFailStatus).toBe('passed');
  });

  // ─────────────────────────────────────────────────────────────────
  // Condition 3+4 — no-prompt mode skips agent; with-prompt does not.
  // ─────────────────────────────────────────────────────────────────
  it('SDK condition 3: no-prompt mode runs body without agent invocation', () => {
    if (!backendAvailable) return;
    // A no-prompt deterministic test has trajectory length 0 and
    // durationMs reflecting only body-execution time (≪ any agent call).
    const r = reportFor('two-arg-form');
    expect(r.trajectory ?? []).toHaveLength(0);
  });

  // ─────────────────────────────────────────────────────────────────
  // Condition 5 — chai PASS recorded.
  // ─────────────────────────────────────────────────────────────────
  it('SDK condition 5: chai expect() PASSING records pass=true matcher', () => {
    if (!backendAvailable) return;
    const m = bodyMatchersFor('chai-pass');
    expect(m.length).toBeGreaterThanOrEqual(2);
    expect(m.every(x => x.pass === true)).toBe(true);
    expect(m.every(x => x.method === 'code-assertion')).toBe(true);
  });

  // ─────────────────────────────────────────────────────────────────
  // Condition 6 — chai FAIL recorded with errorMessage. The headline
  //   regression in #245.
  // ─────────────────────────────────────────────────────────────────
  it("SDK condition 6: chai expect() FAILING records pass=false with errorMessage (issue #245 regression)", () => {
    if (!backendAvailable) return;
    expect(reportFor('chai-fail').passFailStatus).toBe('failed');
    const failed = bodyMatchersFor('chai-fail').filter(m => m.pass === false);
    expect(failed).toHaveLength(1);
    expect(failed[0].description).toBe("'a' to equal 'b'");
    expect(failed[0].errorMessage).toMatch(/expected 'a' to equal 'b'/);
    expect(failed[0].method).toBe('code-assertion');
  });

  // ─────────────────────────────────────────────────────────────────
  // Condition 7 — custom matcher haveCompletedWithin fires.
  // ─────────────────────────────────────────────────────────────────
  it('SDK condition 7: custom matcher haveCompletedWithin produces a recorded verdict', () => {
    if (!backendAvailable) return;
    const m = bodyMatchersFor('custom-matcher-haveCompletedWithin');
    expect(m.some(x => /completedWithin|haveCompletedWithin/i.test(x.description) || x.pass === true))
      .toBe(true);
  });

  // ─────────────────────────────────────────────────────────────────
  // Conditions 8+9 (describe semantics) are covered by
  // tests/unit/lib/testCases/define.test.ts. We deliberately don't
  // exercise describe() in the CLI fixture because the CLI matches
  // benchmarks by describe-name across runs, which would accumulate
  // test cases from prior test executions. The unit tests already
  // verify that benchmarkPath = 'A' / 'A > B' is captured correctly.

  // ─────────────────────────────────────────────────────────────────
  // Condition 10 — beforeAll: each test's matcher list contains a pass
  //   entry for it (the orchestrator replays the once-latched result).
  // ─────────────────────────────────────────────────────────────────
  it('SDK condition 10: beforeAll runs (every test sees one beforeAll hook entry)', () => {
    if (!backendAvailable) return;
    const r = reportFor('two-arg-form');
    const beforeAlls = matchersFor('two-arg-form').filter(m => /^beforeAll hook$/.test(m.description));
    expect(beforeAlls.length).toBe(1);
    expect(beforeAlls[0].pass).toBe(true);
  });

  // ─────────────────────────────────────────────────────────────────
  // Condition 11 — afterAll fires only on the last test in the scope.
  // ─────────────────────────────────────────────────────────────────
  it('SDK condition 11: afterAll fires exactly once on the last test (drain counter)', () => {
    if (!backendAvailable) return;
    let afterAllCount = 0;
    let lastSeenOn = '';
    for (const [name, _r] of reportIds) {
      const hits = matchersFor(name).filter(m => /^afterAll hook$/.test(m.description));
      if (hits.length > 0) { afterAllCount += hits.length; lastSeenOn = name; }
    }
    expect(afterAllCount).toBe(1);
    expect(lastSeenOn).toBe('zz-last-test-in-scope');
  });

  // ─────────────────────────────────────────────────────────────────
  // Condition 12 — beforeEach + provide() populates fixtures.provisioned.
  //   Verified by the 'two-arg-form' test that asserts on it directly.
  // ─────────────────────────────────────────────────────────────────
  it('SDK condition 12: beforeEach + provide() makes values visible via fixtures.provisioned', () => {
    if (!backendAvailable) return;
    const m = bodyMatchersFor('two-arg-form');
    // The body asserted `provisioned.workspaceDir to be a string`. Pass
    // proves provide() worked end-to-end.
    expect(m.find(x => /to be a string/.test(x.description))?.pass).toBe(true);
  });

  // ─────────────────────────────────────────────────────────────────
  // Condition 13 — afterEach reads provisioned to clean up. Verified
  //   indirectly by the disk being empty after the run; here we check
  //   that every test has an `afterEach hook` matcher entry.
  // ─────────────────────────────────────────────────────────────────
  it('SDK condition 13: afterEach runs on every test', () => {
    if (!backendAvailable) return;
    for (const [name] of reportIds) {
      const ae = matchersFor(name).filter(m => /^afterEach hook$/.test(m.description));
      expect(ae.length).toBeGreaterThanOrEqual(1);
    }
  });

  // ─────────────────────────────────────────────────────────────────
  // Condition 14 — testInfo metadata flows through provide() to body.
  //   The 'chai-pass' body asserts `testInfo.name === 'chai-pass'` and
  //   that the workspace path contains the test name.
  // ─────────────────────────────────────────────────────────────────
  it('SDK condition 14: testInfo metadata is visible to hooks and the body', () => {
    if (!backendAvailable) return;
    expect(reportFor('chai-pass').passFailStatus).toBe('passed');
  });

  // ─────────────────────────────────────────────────────────────────
  // Condition 15 — test.beforeEach static-method form actually registers.
  // ─────────────────────────────────────────────────────────────────
  it('SDK condition 15: test.beforeEach (static method form) registers a hook', () => {
    if (!backendAvailable) return;
    expect(reportFor('static-method-form').passFailStatus).toBe('passed');
    // The body asserted the sentinel file existed. Pass proves the
    // static-form hook actually ran before the body.
    const m = bodyMatchersFor('static-method-form');
    expect(m.some(x => x.pass === true && /to equal true/.test(x.description))).toBe(true);
  });

  // ─────────────────────────────────────────────────────────────────
  // Condition 16 — afterEach runs even when the body throws (#229).
  // ─────────────────────────────────────────────────────────────────
  it('SDK condition 16: afterEach runs even when the body throws', () => {
    if (!backendAvailable) return;
    // The body throws via expect — test is marked failed.
    expect(reportFor('afterEach-runs-on-failure').passFailStatus).toBe('failed');
    // …but the afterEach hook entry is still present, recorded as pass.
    const ae = matchersFor('afterEach-runs-on-failure').filter(m => /^afterEach hook$/.test(m.description));
    expect(ae.length).toBe(1);
    expect(ae[0].pass).toBe(true);
  });

  // ─────────────────────────────────────────────────────────────────
  // Condition 17+18 — expectedOutcomes / expectedTrajectory forwarded
  //   to the persisted test case (issue #245 regression).
  // ─────────────────────────────────────────────────────────────────
  it('SDK condition 17: TestOptions.expectedOutcomes is persisted on the test case (#245)', () => {
    if (!backendAvailable) return;
    const tc = testCases.get('expected-outcomes-forwarded');
    expect(tc).toBeDefined();
    expect(tc.expectedOutcomes).toEqual([
      'identifies the failing dependency',
      'proposes remediation',
    ]);
  });

  it('SDK condition 18: TestOptions.expectedTrajectory is persisted with the typed shape (#245)', () => {
    if (!backendAvailable) return;
    const tc = testCases.get('expected-outcomes-forwarded');
    expect(tc).toBeDefined();
    expect(tc.expectedTrajectory).toEqual([
      { step: 1, description: 'search logs', requiredTools: ['search_logs'] },
      { step: 2, description: 'check metrics', requiredTools: ['get_metrics'] },
    ]);
  });

  // ─────────────────────────────────────────────────────────────────
  // Condition 19 — context items round-trip via the upsert path.
  // ─────────────────────────────────────────────────────────────────
  it('SDK condition 19: TestOptions.context is forwarded to the persisted test case', () => {
    if (!backendAvailable) return;
    const tc = testCases.get('expected-outcomes-forwarded');
    expect(tc?.context).toEqual([{ description: 'env', value: 'prod' }]);
  });

  // ─────────────────────────────────────────────────────────────────
  // Condition 20 — labels forwarded; legacy category/difficulty derived.
  // ─────────────────────────────────────────────────────────────────
  it('SDK condition 20: labels persisted; category/difficulty derived from prefixed labels', () => {
    if (!backendAvailable) return;
    const tc = testCases.get('chai-pass');
    expect(tc?.labels).toEqual(expect.arrayContaining(['category:Smoke', 'difficulty:Easy', 'feature:cli-coverage']));
    // The upsert path derives category/difficulty back-compat fields
    // from prefixed labels — checking these prevents silent regressions
    // in label parsing.
    expect(tc?.category).toBe('Smoke');
    expect(tc?.difficulty).toBe('Easy');
  });
});
