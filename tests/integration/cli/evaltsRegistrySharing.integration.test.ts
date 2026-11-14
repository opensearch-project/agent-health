/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * End-to-end CLI + server integration test for the ".eval.ts can't
 * execute" bug.
 *
 * Why this test exists
 * ─────────────────────
 * `agent-health benchmark -f foo.eval.ts` failed with `Module ... has no
 * test cases`, even though the docs advertise `.eval.ts` support and the
 * CJS `.eval.js` path worked fine. Root cause: `lib/testCases/loader.ts`
 * `eval()`'s `.js` files in a synthetic CJS context where
 * `require('@opensearch-project/agent-health')` is intercepted and handed
 * `define.js`'s own exports directly — guaranteeing the SAME module
 * instance backs both the loader and the fixture. `.ts`/`.mjs` files go
 * through a plain native `import(fileUrl)` with no interception: the bare
 * specifier `@opensearch-project/agent-health` resolves through Node's
 * normal algorithm (walking up from the fixture file's own directory to
 * find `node_modules/@opensearch-project/agent-health`, then following
 * the package's `exports` map). When the host process itself runs the
 * loader from a *different physical file* than what that resolution
 * lands on — e.g. a project-local `node_modules/@opensearch-project/
 * agent-health` symlinked straight at this repo (the exact setup of the
 * real-world repro this test is modeled on) — the `.eval.ts` file's
 * `test()` calls register into an orphaned module instance the loader
 * never reads from.
 *
 * This test reproduces that setup exactly: a fixture directory OUTSIDE
 * the repo with its own `node_modules/@opensearch-project/agent-health`
 * symlink pointing back at this checkout (mirroring how a real project
 * consumes agent-health via a local/linked dependency), then spawns the
 * real CLI binary against a `.eval.ts` fixture and asserts the test cases
 * actually registered AND ran (not just "didn't throw").
 *
 * Prerequisites
 * ─────────────
 *   • Backend running (npm run dev:server, or `node server/dist/index.js`)
 *     reachable at AH_PORT. Test self-skips otherwise.
 *   • `lib/dist` built (npm run build:lib) — the symlinked package resolves
 *     `exports["."]` to `lib/dist/lib/index.js`; without a build this test
 *     cannot even reach the bug it's proving fixed. Rebuilt here if missing.
 *   • CLI bundle built (npm run build:cli). Rebuilt here if missing.
 */

import { spawnSync } from 'child_process';
import { withCliCoverage } from '../../helpers/cliCoverage';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  copyFileSync,
  symlinkSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { request as httpRequest } from 'http';
import { getTestBackendUrl } from '@/tests/integration/testConfig';
import { createTestDataTracker } from '../../helpers/testDataTracker';

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
const LIB_DIST_ENTRY = join(REPO_ROOT, 'lib/dist/lib/index.js');
const FIXTURE_SOURCE = join(REPO_ROOT, 'tests/fixtures/evalts-registry.min.eval.ts');

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

describe('Code SDK — .eval.ts CLI subprocess integration (module-instance regression)', () => {
  let backendAvailable = false;
  let projectDir: string; // fixture "project" root — OUTSIDE the repo, like a real consumer.
  let fixturePath: string;
  const reportIds = new Map<string, any>();
  const testCasesByName = new Map<string, any>();
  let benchmarkId = '';
  // What the spawned CLI persists (benchmark, evaluation runs, their per-case
  // reports, the imported test cases) is tracked BY ID as soon as each id is
  // known — benchmark/run ids straight from the CLI's stdout, even when it
  // times out; test-case/report ids from the run docs — and deleted in
  // afterAll via the shared tracker. This suite used to leave all of it
  // behind on every run (two test cases + a benchmark + runs + reports).
  const tracker = createTestDataTracker(BASE_URL);
  // Run ids the CLI printed (tracked as soon as they are known). Used by
  // harvestRunChildren() so the test cases / reports those runs own are
  // tracked too — on the happy path AND on every failure path (CLI timeout,
  // failed collection read, thrown assertion in beforeAll).
  const knownRunIds = new Set<string>();

  /**
   * Track the children of every known run: `testCaseSnapshots[].id` (the
   * test cases the import created — the tracker's reconciliation pass finds
   * that case's reports through them) and `results[].reportId`. Idempotent,
   * best-effort, and independent of any other collection read: a run doc
   * that cannot be fetched is simply skipped here (its id stays tracked and
   * is deleted by cleanup()).
   */
  async function harvestRunChildren(): Promise<any[]> {
    const runs: any[] = [];
    for (const rid of knownRunIds) {
      let runRes: { status: number; body: any };
      try {
        runRes = await httpGet<any>(`${BASE_URL}/api/storage/evaluation-runs/${rid}`);
      } catch {
        continue;
      }
      if (runRes.status !== 200) continue;
      const run = runRes.body;
      for (const snapshot of (run.testCaseSnapshots || []) as Array<{ id?: string }>) tracker.testCase(snapshot.id);
      for (const [tcId, result] of Object.entries((run.results || {}) as Record<string, any>)) {
        tracker.testCase(tcId);
        tracker.run((result as any)?.reportId);
      }
      runs.push(run);
    }
    return runs;
  }
  let cliStdout = '';
  let cliStderr = '';
  let cliStatus: number | null = null;

  beforeAll(async () => {
    backendAvailable = await checkBackend();
    if (!backendAvailable) {
      // eslint-disable-next-line no-console
      console.warn(`[evalts-cli] Backend not reachable at ${BASE_URL} — skipping. Start with: npm run dev:server`);
      return;
    }

    if (!existsSync(CLI_BUNDLE)) {
      // eslint-disable-next-line no-console
      console.log('[evalts-cli] CLI bundle missing; building once before tests…');
      const build = spawnSync('npm', ['run', 'build:cli'], { cwd: REPO_ROOT, encoding: 'utf-8' });
      if (build.status !== 0) throw new Error(`CLI build failed: ${build.stderr}`);
    }
    if (!existsSync(LIB_DIST_ENTRY)) {
      // eslint-disable-next-line no-console
      console.log('[evalts-cli] lib/dist missing; building once before tests…');
      const build = spawnSync('npm', ['run', 'build:lib'], { cwd: REPO_ROOT, encoding: 'utf-8' });
      if (build.status !== 0) throw new Error(`lib build failed: ${build.stderr}`);
    }

    // Build the "project" that consumes agent-health as a linked package —
    // exactly the shape of the real-world repro (a sibling project whose
    // node_modules/@opensearch-project/agent-health is a symlink to this
    // repo checkout, so `import()` of the .eval.ts resolves the SDK to
    // lib/dist/lib/index.js, a DIFFERENT physical module than the one this
    // repo's own CLI/server import internally from TS source).
    projectDir = mkdtempSync(join(tmpdir(), 'evalts-cli-int-'));
    const scopeDir = join(projectDir, 'node_modules', '@opensearch-project');
    mkdirSync(scopeDir, { recursive: true });
    symlinkSync(REPO_ROOT, join(scopeDir, 'agent-health'), 'dir');

    fixturePath = join(projectDir, 'evalts-registry.eval.ts');
    copyFileSync(FIXTURE_SOURCE, fixturePath);

    const port = new URL(BASE_URL).port || '4001';
    const benchmarkName = `evalts-cli-regression-${Date.now()}`;
    const cleanEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v !== 'string') continue;
      if (k === 'PATH' || k === 'HOME' || k === 'USER' || k === 'AWS_REGION' ||
          k.startsWith('AWS_') || k === 'TMPDIR') {
        cleanEnv[k] = v;
      }
    }
    cleanEnv.AH_PORT = port;
    cleanEnv.AH_SUPPRESS_EXPERIMENTAL = '1';
    cleanEnv.AH_QUIET_DEPRECATIONS = '1';

    const cli = spawnSync(
      'node',
      [CLI_BUNDLE, 'benchmark', '-f', fixturePath, '-a', 'demo', '-n', benchmarkName],
      { cwd: REPO_ROOT, env: withCliCoverage(cleanEnv), encoding: 'utf-8', timeout: TEST_TIMEOUT - 10_000 },
    );

    cliStdout = (cli.stdout || '').replace(/\u001b\[[0-9;]*m/g, '');
    cliStderr = cli.stderr || '';
    cliStatus = cli.status;

    // Track the benchmark + run ids the CLI printed BEFORE any throw below,
    // so a timed-out / killed CLI (which may already have persisted them)
    // still gets cleaned up by id.
    const urlRe = /\/evaluations\/benchmarks\/(bench-[A-Za-z0-9-]+)\/runs\/((?:eval-)?run-[A-Za-z0-9-]+)/g;
    const benchRunPairs: Array<{ bid: string; rid: string }> = [];
    let m: RegExpExecArray | null;
    while ((m = urlRe.exec(cliStdout)) !== null) {
      benchRunPairs.push({ bid: m[1], rid: m[2] });
      tracker.benchmark(m[1]);
      tracker.evaluationRun(m[2]);
      knownRunIds.add(m[2]);
    }

    if (cli.status === null) {
      throw new Error(`CLI subprocess timed out or was killed.\nSTDOUT:\n${cliStdout}\nSTDERR:\n${cliStderr}`);
    }

    // If the bug regresses, the CLI exits non-zero with "has no test
    // cases" and prints no run URLs — don't throw here so the dedicated
    // "did not regress" assertion below can report the real failure
    // message instead of a generic parse error.
    if (benchRunPairs.length === 0) return;

    benchmarkId = benchRunPairs[0].bid;

    // Children (test cases, reports) are tracked here — BEFORE the unrelated
    // collection read below, which is not on the cleanup-critical path.
    const allRuns = await harvestRunChildren();

    const tcAll = (await httpGet<any>(`${BASE_URL}/api/storage/test-cases?size=500`)).body;
    for (const tc of tcAll.testCases || tcAll.items || []) {
      if ((tc.sourceFile || '').includes('evalts-registry.eval.ts')) {
        testCasesByName.set(tc.name, tc);
      }
    }

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

  afterAll(async () => {
    if (projectDir) rmSync(projectDir, { recursive: true, force: true });
    // Failure paths in beforeAll (CLI timeout, a thrown collection read)
    // may have exited before the run docs were read — harvest the children
    // of every known run now, before cleanup() deletes their parents.
    await harvestRunChildren();
    await tracker.cleanup();
  }, 60_000);

  it('requires a running backend (skip otherwise)', () => {
    if (!backendAvailable) {
      // eslint-disable-next-line jest/no-conditional-expect
      expect(true).toBe(true);
      return;
    }
    expect(cliStatus).toBe(0);
  });

  it('regression guard: the CLI did NOT fail with "has no test cases" for the symlinked .eval.ts fixture', () => {
    if (!backendAvailable) return;
    expect(cliStderr + cliStdout).not.toMatch(/has no test cases/);
    expect(benchmarkId).toMatch(/^bench-/);
  });

  it('registers + runs the top-level .eval.ts test case (no describe block)', () => {
    if (!backendAvailable) return;
    const tc = testCasesByName.get('evalts-top-level-case');
    expect(tc).toBeDefined();
    expect(tc.sourceFile).toMatch(/evalts-registry\.eval\.ts$/);

    const report = reportIds.get('evalts-top-level-case');
    expect(report).toBeDefined();
    expect(report.passFailStatus).toBe('passed');
  });

  it('registers + runs the describe()-scoped .eval.ts test case with the correct benchmarkPath', () => {
    if (!backendAvailable) return;
    const tc = testCasesByName.get('evalts-describe-case');
    expect(tc).toBeDefined();
    expect(tc.sourceFile).toMatch(/evalts-registry\.eval\.ts$/);

    const report = reportIds.get('evalts-describe-case');
    expect(report).toBeDefined();
    expect(report.passFailStatus).toBe('passed');
  });

  it('both .eval.ts test cases were persisted (registry was not orphaned)', () => {
    if (!backendAvailable) return;
    expect(testCasesByName.size).toBe(2);
  });
});
