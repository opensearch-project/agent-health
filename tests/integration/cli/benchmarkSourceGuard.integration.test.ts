/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * #620 — `benchmark -f other.eval.js -n "<existing name>"` must not silently
 * merge a second eval file's test cases into an existing benchmark.
 *
 * Real CLI processes against the backend the test config points at (file
 * storage in the integration job; built-in `demo` agent + mock judge):
 *
 *   1. `-f a.eval.js -n shop`           → creates "shop" from a (baseline).
 *   2. `-f a.eval.js -n shop` again     → same file: allowed, second run.
 *   3. `-f b.eval.js -n shop`           → REFUSED, exit 1, message names both
 *                                         files + suggests another -n / --force;
 *                                         the benchmark is untouched (no run,
 *                                         no extra ids, description unchanged).
 *   4. `-f b.eval.js -n shop --force`   → allowed; prints the warning and
 *                                         "Added N test cases …" naming b's
 *                                         cases; the description records the
 *                                         addition.
 *   5. `-f a.eval.js -n shop`           → now a SUBSET of what shop holds →
 *                                         refused ("leaves out b.eval.js");
 *      `-f a.eval.js -f b.eval.js -n shop` → exactly the set → allowed.
 *
 * Red on the old code: step 3 exits 0 with "Evaluation run completed", the
 * version's test-case list doubles and the description still names a.eval.js.
 */

import { rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getTestBackendUrl } from '../testConfig';
import { createTestDataTracker, uniqueTestName } from '../../helpers/testDataTracker';
import {
  ensureCliBundle,
  backendReadyOrSkip,
  runCli,
  plain,
  makeTempDir,
  trackBenchmarkByName,
  httpJson,
  listEvaluationRunsOf,
} from '../../helpers/cliProcess';

const TEST_TIMEOUT = 180_000;
const BASE_URL = getTestBackendUrl();
const JUDGE = ['--judge-model', 'demo-model'];

const evalFile = (names: string[]) => `
const { test, expect } = require('@opensearch-project/agent-health');
${names.map(n => `
test(${JSON.stringify(n)}, { prompt: 'running shoes under $100' }, async ({ agent }) => {
  const result = await agent.run();
  expect(result.trajectory.length).to.be.greaterThan(0);
});`).join('\n')}
`;

describe('CLI benchmark: -n <existing> with a different eval file is refused unless --force (#620)', () => {
  const tracker = createTestDataTracker();
  let ready = false;
  let tmp: string;
  let fileA: string;
  let fileB: string;
  const namesA = [uniqueTestName('src-guard-a1'), uniqueTestName('src-guard-a2')];
  const namesB = [uniqueTestName('src-guard-b1'), uniqueTestName('src-guard-b2'), uniqueTestName('src-guard-b3')];
  const benchmarkName = uniqueTestName('src-guard-shop');
  let benchmarkId = '';

  beforeAll(async () => {
    ready = await backendReadyOrSkip('cli-source-guard', BASE_URL);
    if (!ready) return;
    ensureCliBundle();
    tmp = makeTempDir('ah-cli-source-guard');
    fileA = join(tmp, 'a.eval.js');
    fileB = join(tmp, 'b.eval.js');
    writeFileSync(fileA, evalFile(namesA), 'utf-8');
    writeFileSync(fileB, evalFile(namesB), 'utf-8');
  }, TEST_TIMEOUT);

  afterAll(async () => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    await tracker.cleanup();
  }, 120_000);

  const getBenchmark = async () => (await httpJson<any>(`${BASE_URL}/api/storage/benchmarks/${benchmarkId}`)).body;

  it('baseline: -f a.eval.js -n shop creates the benchmark from a', async () => {
    if (!ready) return;
    const res = runCli(['benchmark', '-f', fileA, '-a', 'demo', '-n', benchmarkName, ...JUDGE], { timeoutMs: TEST_TIMEOUT - 20_000 });
    const bm = await trackBenchmarkByName(tracker, benchmarkName);
    expect(res.status).toBe(0);
    expect(plain(res.output)).toMatch(/Evaluation run completed \(2\/2 test cases\)/);
    expect(bm).not.toBeNull();
    benchmarkId = bm!.id;
    const doc = await getBenchmark();
    expect(doc.description).toContain('a.eval.js');
    expect(doc.testCaseIds).toHaveLength(2);
    expect(doc.versions[0].testCaseIds).toHaveLength(2);
  }, TEST_TIMEOUT);

  it('re-running the SAME file under the same name is allowed (a second run, no refusal)', async () => {
    if (!ready) return;
    // Spelled differently (a redundant `./` segment) to prove spelling does not matter.
    const res = runCli(['benchmark', '-f', `${tmp}/./a.eval.js`, '-a', 'demo', '-n', benchmarkName, ...JUDGE], { timeoutMs: TEST_TIMEOUT - 20_000 });
    await trackBenchmarkByName(tracker, benchmarkName);
    const out = plain(res.output);
    expect(res.status).toBe(0);
    expect(out).not.toMatch(/different source file/);
    expect(out).toMatch(/Evaluation run completed \(2\/2 test cases\)/);
    expect(await listEvaluationRunsOf(benchmarkId)).toHaveLength(2);
  }, TEST_TIMEOUT);

  it('-f b.eval.js -n shop is refused: exit 1, both files named, a different -n or --force suggested, benchmark untouched', async () => {
    if (!ready) return;
    const before = await getBenchmark();
    const res = runCli(['benchmark', '-f', fileB, '-a', 'demo', '-n', benchmarkName, ...JUDGE], { timeoutMs: TEST_TIMEOUT - 20_000 });
    await trackBenchmarkByName(tracker, benchmarkName);
    const out = plain(res.output);

    expect(res.status).toBe(1);
    expect(out).toMatch(/Error: benchmark ".*src-guard-shop.*" was created from ".*a\.eval\.js"; ".*b\.eval\.js" is a different source file\./);
    expect(out).toMatch(/Use a different name \(e\.g\. -n ".*-b"\) or pass --force/);
    expect(out).not.toMatch(/Evaluation run completed/);

    const after = await getBenchmark();
    expect(after.testCaseIds).toEqual(before.testCaseIds);
    expect(after.versions).toEqual(before.versions);
    expect(after.description).toBe(before.description);
    expect(await listEvaluationRunsOf(benchmarkId)).toHaveLength(2);
    // b's test cases were never created either (the server was not asked to import them).
    const tcs = await httpJson<any>(`${BASE_URL}/api/storage/test-cases?size=1000`);
    const bNames = new Set(namesB);
    expect((tcs.body.testCases ?? []).filter((tc: any) => bNames.has(tc.name))).toHaveLength(0);
  }, TEST_TIMEOUT);

  it('--force adds b.eval.js: warning + "Added 3 test cases" naming them, run completes, description records the addition', async () => {
    if (!ready) return;
    const res = runCli(['benchmark', '-f', fileB, '-a', 'demo', '-n', benchmarkName, '--force', ...JUDGE], { timeoutMs: TEST_TIMEOUT - 20_000 });
    await trackBenchmarkByName(tracker, benchmarkName);
    const out = plain(res.output);

    expect(res.status).toBe(0);
    expect(out).toMatch(/Warning: --force — adding the test cases of ".*b\.eval\.js" to benchmark ".*src-guard-shop.*", which was created from ".*a\.eval\.js"; running ".*" without ".*a\.eval\.js"\./);
    expect(out).toMatch(/Evaluation run completed \(3\/3 test cases\)/);
    const added = /Added 3 test cases to ".*": (.*)/.exec(out);
    expect(added).not.toBeNull();
    for (const n of namesB) expect(added![1]).toContain(n);

    const doc = await getBenchmark();
    expect(doc.description).toMatch(/b\.eval\.js added with --force/);
    expect(doc.versions[doc.versions.length - 1].testCaseIds).toHaveLength(5);
    expect(await listEvaluationRunsOf(benchmarkId)).toHaveLength(3);
  }, TEST_TIMEOUT);

  it('the benchmark now holds a + b: running only a.eval.js again is refused as a subset ("leaves out b.eval.js"); both files together are allowed', async () => {
    if (!ready) return;
    const subset = runCli(['benchmark', '-f', fileA, '-a', 'demo', '-n', benchmarkName, ...JUDGE], { timeoutMs: TEST_TIMEOUT - 20_000 });
    const out = plain(subset.output);
    expect(subset.status).toBe(1);
    expect(out).toMatch(/Error: benchmark ".*src-guard-shop.*" holds test cases from ".*\.eval\.js", ".*\.eval\.js"; this run leaves out ".*b\.eval\.js"\./);
    expect(out).toMatch(/holds test cases from [^;]*a\.eval\.js[^;]*;/);
    expect(out).toMatch(/holds test cases from [^;]*b\.eval\.js[^;]*;/);
    expect(out).toMatch(/pass --force to run this subset under/);
    expect(await listEvaluationRunsOf(benchmarkId)).toHaveLength(3);

    const both = runCli(['benchmark', '-f', fileA, '-f', fileB, '-a', 'demo', '-n', benchmarkName, ...JUDGE], { timeoutMs: TEST_TIMEOUT - 20_000 });
    await trackBenchmarkByName(tracker, benchmarkName);
    expect(both.status).toBe(0);
    expect(plain(both.output)).not.toMatch(/Error: benchmark|Warning: --force/);
    expect(plain(both.output)).toMatch(/Evaluation run completed \(5\/5 test cases\)/);
    expect(await listEvaluationRunsOf(benchmarkId)).toHaveLength(4);
  }, TEST_TIMEOUT);
});
