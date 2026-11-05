/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `agent-health benchmark` — every customer-visible mode, driven through the
 * REAL CLI bundle against a running backend with the built-in `demo` agent and
 * the mock `demo-model` judge (no credentials, no network beyond localhost).
 *
 * What a user sees is what is asserted: exit codes, the printed summary, the
 * "View results" link, and the benchmark / evaluation-run documents the server
 * holds afterwards. Nothing in the CLI is mocked or imported in-process.
 *
 * Modes covered
 *   • unified (evaluation-runs API): several `-f` files, `-d` directory,
 *     `-t` ids (ad-hoc, no benchmark), `-c` concurrency, `-n` reuse of an
 *     existing benchmark; `-f`/`-d` path errors; unknown agent.
 *   • legacy single-file / by-name (per-benchmark `/execute` route): the
 *     "name required when a server is running" and "benchmark not found"
 *     errors; the re-run by name — which succeeds only on an OpenSearch
 *     backend (CI's integration job) and fails with a clear message on the
 *     file backend, both asserted.
 *   • `benchmark repair-links`: a benchmark whose `testCaseIds` were emptied
 *     behind the runs' back is reported (dry run) and repaired (`--apply`).
 */

import { rmSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { getTestBackendUrl } from '../testConfig';
import { createTestDataTracker, uniqueTestName } from '../../helpers/testDataTracker';
import {
  ensureCliBundle,
  backendReadyOrSkip,
  runCli,
  plain,
  makeTempDir,
  writeCasesFile,
  trackBenchmarkByName,
  trackEvaluationRun,
  trackTestCasesByName,
  httpJson,
  storageBackend as readStorageBackend,
  getEvaluationRun,
  listEvaluationRunsOf,
  jsonTail,
} from '../../helpers/cliProcess';

const TEST_TIMEOUT = 180_000;
const BASE_URL = getTestBackendUrl();
const JUDGE = ['--judge-model', 'demo-model'];

describe('CLI benchmark — modes, errors and repair (real CLI processes)', () => {
  const tracker = createTestDataTracker();
  let ready = false;
  let storageBackend = 'file';
  let tmp: string;
  let fileA: string;
  let fileB: string;
  let dir: string;
  let namesA: string[];
  let namesB: string[];
  let namesDir: string[];

  beforeAll(async () => {
    ready = await backendReadyOrSkip('cli-benchmark', BASE_URL);
    if (!ready) return;
    storageBackend = await readStorageBackend(BASE_URL);
    ensureCliBundle();
    tmp = makeTempDir('ah-cli-benchmark');
    fileA = join(tmp, 'cases-a.json');
    fileB = join(tmp, 'cases-b.json');
    dir = join(tmp, 'cases-dir');
    namesA = writeCasesFile(tmp, 'cases-a.json', 2, 'cli-bm-a');
    namesB = writeCasesFile(tmp, 'cases-b.json', 1, 'cli-bm-b');
    mkdirSync(dir);
    namesDir = [...writeCasesFile(dir, 'one.json', 2, 'cli-bm-dir1'), ...writeCasesFile(dir, 'two.json', 1, 'cli-bm-dir2')];
  }, TEST_TIMEOUT);

  afterAll(async () => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    await tracker.cleanup();
  }, 120_000);

  it('requires a running backend (skip otherwise)', () => {
    if (!ready) return;
    expect(ready).toBe(true);
  });

  describe('unified mode (evaluation-runs API)', () => {
    const benchmarkName = uniqueTestName('cli-bm-unified');

    it('-f a.json -f b.json -n <new name> creates the benchmark, runs every case and links the run', async () => {
      if (!ready) return;
      const res = runCli(['benchmark', '-f', fileA, '-f', fileB, '-a', 'demo', '-n', benchmarkName, ...JUDGE], { timeoutMs: TEST_TIMEOUT - 20_000 });
      const bm = await trackBenchmarkByName(tracker, benchmarkName);
      const out = plain(res.output);

      expect(res.status).toBe(0);
      expect(out).toMatch(/Evaluation run completed \(3\/3 test cases\)/);
      expect(out).toMatch(/Passed: 3/);
      expect(out).toMatch(/Failed: 0/);
      expect(out).toMatch(/Benchmark: /);
      expect(bm).not.toBeNull();
      // The "View results" link names the benchmark the server created.
      expect(out).toContain(`/evaluations/benchmarks/${bm!.id}/runs/`);
      expect(bm!.testCaseIds).toHaveLength(3);
      const runs = await listEvaluationRunsOf(bm!.id);
      expect(runs).toHaveLength(1);
      const run = runs[0];
      expect(run.status).toBe('completed');
      expect(run.trigger).toBe('cli');
      expect(run.agentKey).toBe('demo');
      expect(run.judgeModelId).toBe('demo-model');
      expect(Object.values(run.results ?? {}).every(r => r.status === 'completed')).toBe(true);
    }, TEST_TIMEOUT);

    it('-d <dir> -n <existing name> -c 2 reuses the benchmark and adds a second run', async () => {
      if (!ready) return;
      const res = runCli(['benchmark', '-d', dir, '-a', 'demo', '-n', benchmarkName, '-c', '2', '-v', ...JUDGE], { timeoutMs: TEST_TIMEOUT - 20_000 });
      const bm = await trackBenchmarkByName(tracker, benchmarkName);
      const out = plain(res.output);

      expect(res.status).toBe(0);
      expect(out).toMatch(/Concurrency: 2/);
      expect(out).toMatch(/Evaluation run completed \(3\/3 test cases\)/);
      expect(bm).not.toBeNull();
      // Same benchmark (found by name), now with two runs.
      expect(await listEvaluationRunsOf(bm!.id)).toHaveLength(2);
      await trackTestCasesByName(tracker, namesDir);
    }, TEST_TIMEOUT);

    it('-t <id> -t <id> without -n is an ad-hoc run that tells the user how to promote it', async () => {
      if (!ready) return;
      const ids = await trackTestCasesByName(tracker, [...namesA, ...namesB]);
      const [id1, id2] = [ids.get(namesA[0])!, ids.get(namesB[0])!];
      expect(id1).toBeTruthy();
      expect(id2).toBeTruthy();

      const res = runCli(['benchmark', '-t', id1, '-t', id2, '-a', 'demo', ...JUDGE], { timeoutMs: TEST_TIMEOUT - 20_000 });
      const out = plain(res.output);
      const runId = /ad-hoc run \(ID: ([^)]+)\)/.exec(out)?.[1];
      if (runId) await trackEvaluationRun(tracker, runId);

      expect(res.status).toBe(0);
      expect(out).toMatch(/Mode: Ad-hoc \(no benchmark association\)/);
      expect(out).toMatch(/Evaluation run completed \(2\/2 test cases\)/);
      expect(out).toMatch(/Promote to benchmark with: -n/);
      expect(runId).toBeTruthy();
      const doc = await getEvaluationRun(runId!);
      expect(doc?.status).toBe('completed');
      expect(doc?.benchmarkId).toBeUndefined();
    }, TEST_TIMEOUT);

    it('a missing -f file or -d directory is refused before anything is created', () => {
      if (!ready) return;
      const missing = join(tmp, 'does-not-exist.json');
      const f = runCli(['benchmark', '-f', missing, '-f', fileA, '-a', 'demo', '-n', uniqueTestName('cli-bm-never')]);
      expect(f.status).toBe(1);
      expect(plain(f.output)).toMatch(/File not found: .*does-not-exist\.json/);

      const d = runCli(['benchmark', '-d', join(tmp, 'no-such-dir'), '-a', 'demo', '-n', uniqueTestName('cli-bm-never')]);
      expect(d.status).toBe(1);
      expect(plain(d.output)).toMatch(/Directory not found: .*no-such-dir/);
    }, TEST_TIMEOUT);

    it('an unknown agent key fails the run with the server error, exit 1', async () => {
      if (!ready) return;
      const name = uniqueTestName('cli-bm-badagent');
      const res = runCli(['benchmark', '-f', fileA, '-f', fileB, '-a', 'no-such-agent-key', '-n', name, ...JUDGE]);
      await trackBenchmarkByName(tracker, name);
      expect(res.status).toBe(1);
      expect(plain(res.output)).toMatch(/Evaluation run (failed|error)|Run failed/);
    }, TEST_TIMEOUT);
  });

  describe('legacy single-file / by-name mode', () => {
    it('`benchmark -a demo` with a server already running demands a name (exit 1, with the four options)', () => {
      if (!ready) return;
      const res = runCli(['benchmark', '-a', 'demo']);
      const out = plain(res.output);
      expect(res.status).toBe(1);
      expect(out).toMatch(/Benchmark name required when server is already running/);
      expect(out).toMatch(/Specify a benchmark/);
      expect(out).toMatch(/Import from file/);
      expect(out).toMatch(/list benchmarks/);
    }, TEST_TIMEOUT);

    it('`benchmark -n <unknown>` exits 1 and points at `list benchmarks`', () => {
      if (!ready) return;
      const res = runCli(['benchmark', '-n', uniqueTestName('cli-bm-nonexistent'), '-a', 'demo']);
      const out = plain(res.output);
      expect(res.status).toBe(1);
      expect(out).toMatch(/Benchmark not found/);
      expect(out).toMatch(/list benchmarks/);
    }, TEST_TIMEOUT);

    it('re-running an existing benchmark by name (-n) with --export: scored on OpenSearch, clear failure on file storage', async () => {
      if (!ready) return;
      // Seed a benchmark the unified way (works on every backend), then re-run it by name.
      const name = uniqueTestName('cli-bm-legacy-rerun');
      const seed = runCli(['benchmark', '-f', fileA, '-f', fileB, '-a', 'demo', '-n', name, ...JUDGE], { timeoutMs: TEST_TIMEOUT - 30_000 });
      expect(seed.status).toBe(0);

      const exportPath = join(tmp, 'legacy-export.json');
      const res = runCli(['benchmark', '-n', name, '-a', 'demo', ...JUDGE, '--export', exportPath, '-o', 'json'], { timeoutMs: TEST_TIMEOUT - 30_000 });
      const bm = await trackBenchmarkByName(tracker, name);
      const out = plain(res.output);

      expect(bm).not.toBeNull();
      expect(res.status).toBe(0);
      expect(out).toMatch(/Results exported to: .*legacy-export\.json/);
      expect(existsSync(exportPath)).toBe(true);
      const exported = JSON.parse(readFileSync(exportPath, 'utf-8')) as {
        benchmark: { id: string; name: string; testCaseCount: number };
        runs: Array<{ agent: { key: string }; passed: number; failed: number; runId?: string }>;
      };
      expect(exported.benchmark).toEqual({ id: bm!.id, name, testCaseCount: 3 });
      expect(exported.runs).toHaveLength(1);
      expect(exported.runs[0].agent.key).toBe('demo');

      if (storageBackend === 'file') {
        // The per-benchmark /execute route needs OpenSearch; the CLI must say so
        // instead of hanging or crashing.
        expect(out).toMatch(/Demo Agent: Failed - .*OpenSearch not configured/);
        expect(exported.runs[0].passed).toBe(0);
      } else {
        expect(out).toMatch(/Demo Agent: 3\/3 passed \(100% pass rate\)/);
        expect(exported.runs[0].passed).toBe(3);
        expect(exported.runs[0].runId).toBeTruthy();
        // -o json prints the per-agent summary as JSON too.
        expect(out).toMatch(/"passed": 3/);
      }
    }, TEST_TIMEOUT);
  });

  describe('benchmark doctor (read-only here: --apply deletes benchmarks cluster-wide, never in a shared suite)', () => {
    it('dry-run plan, --json plan, --migrate-images preview, and the --dry-run/--apply conflict', async () => {
      if (!ready) return;
      const name = uniqueTestName('cli-bm-doctor');
      const seed = runCli(['benchmark', '-f', fileA, '-f', fileB, '-a', 'demo', '-n', name, ...JUDGE], { timeoutMs: TEST_TIMEOUT - 30_000 });
      expect(seed.status).toBe(0);
      const bm = await trackBenchmarkByName(tracker, name);
      expect(bm).not.toBeNull();

      const plan = runCli(['benchmark', 'doctor']);
      const planOut = plain(plan.output);
      expect(plan.status).toBe(0);
      expect(planOut).toMatch(/Benchmark Doctor — plan/);
      expect(planOut).toMatch(/Benchmarks scanned: [1-9]\d*/);
      // A freshly created, uniquely named benchmark with real cases is never debris.
      expect(planOut).not.toContain(`${name} (${bm!.id})`);

      const json = runCli(['benchmark', 'doctor', '--json']);
      expect(json.status).toBe(0);
      const parsed = jsonTail(json.stdout) as { plan: { debrisDeletions: Array<{ id: string }>; contentDupGroups: unknown[]; summary: { totalBenchmarks: number } } };
      expect(parsed.plan.summary.totalBenchmarks).toBeGreaterThanOrEqual(1);
      expect(parsed.plan.debrisDeletions.map(d => d.id)).not.toContain(bm!.id);

      const images = runCli(['benchmark', 'doctor', '--migrate-images']);
      const imagesOut = plain(images.output);
      expect(images.status).toBe(0);
      expect(imagesOut).toMatch(/Image migration plan \(dry-run\):/);
      expect(imagesOut).toMatch(new RegExp(`(\\+ would create|= already an image[^\\n]*) ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} → [0-9a-f]{12}`));
      expect(imagesOut).toMatch(/Dry-run only\. Re-run with --migrate-images --apply to execute\./);

      const conflict = runCli(['benchmark', 'doctor', '--dry-run', '--apply']);
      expect(conflict.status).toBe(1);
      expect(plain(conflict.output)).toMatch(/--dry-run and --apply are mutually exclusive/);
    }, TEST_TIMEOUT);
  });

  describe('benchmark repair-links', () => {
    it('reports a benchmark whose testCaseIds were emptied behind its runs, then repairs it with --apply', async () => {
      if (!ready) return;
      const name = uniqueTestName('cli-bm-repair');
      const seed = runCli(['benchmark', '-f', fileA, '-f', fileB, '-a', 'demo', '-n', name, ...JUDGE], { timeoutMs: TEST_TIMEOUT - 30_000 });
      expect(seed.status).toBe(0);
      const bm = await trackBenchmarkByName(tracker, name);
      expect(bm).not.toBeNull();
      expect(bm!.testCaseIds).toHaveLength(3);

      // Break the link the way the pre-fix bulk endpoint used to: runs
      // reference three ids, the benchmark shell lists none of them.
      const put = await httpJson(`${BASE_URL}/api/storage/benchmarks/${bm!.id}`, { method: 'PUT', body: { testCaseIds: [] } });
      expect(put.ok).toBe(true);

      const dry = runCli(['benchmark', 'repair-links']);
      const dryOut = plain(dry.output);
      expect(dry.status).toBe(0);
      expect(dryOut).toContain(`Stale shell: ${name} (${bm!.id})`);
      expect(dryOut).toMatch(/3 test case id\(s\) missing from testCaseIds, referenced by 1 run\(s\)/);
      expect(dryOut).toMatch(/Re-run with --apply to fix/);

      const apply = runCli(['benchmark', 'repair-links', '--apply']);
      const applyOut = plain(apply.output);
      expect(apply.status).toBe(0);
      expect(applyOut).toContain(`Stale shell: ${name} (${bm!.id})`);
      expect(applyOut).toMatch(/Repaired: testCaseIds now has 3 id\(s\)/);

      const after = await httpJson<{ benchmark?: { testCaseIds: string[] }; testCaseIds?: string[] }>(`${BASE_URL}/api/storage/benchmarks/${bm!.id}`);
      const ids = after.body.benchmark?.testCaseIds ?? after.body.testCaseIds ?? [];
      expect(ids).toHaveLength(3);

      // A second dry run finds nothing left to repair for this benchmark.
      const again = runCli(['benchmark', 'repair-links']);
      expect(again.status).toBe(0);
      expect(plain(again.output)).not.toContain(`Stale shell: ${name}`);
    }, TEST_TIMEOUT);
  });
});
