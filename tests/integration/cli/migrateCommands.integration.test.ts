/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `agent-health migrate` (and its `evaluation-runs` / `sdk-v2` subcommands) as
 * REAL CLI processes against a running backend.
 *
 * A benchmark with one run is created through the CLI first; the migrations
 * are then asserted on the printed per-benchmark progress and summary, in dry
 * run and for real, and the `sdk-v2` codemod on a throwaway `.eval.js` file —
 * the diff it prints, and the file it does / does not rewrite.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
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
} from '../../helpers/cliProcess';

const TEST_TIMEOUT = 180_000;
const BASE_URL = getTestBackendUrl();

// v1-shape SDK eval file: the body receives `result`, which the v2 shape
// replaces with an explicit `agent.run()`.
const V1_EVAL = `const { test, expect } = require('@opensearch-project/agent-health');

test('legacy-shape case', { prompt: 'Why is the queue backing up?' }, async ({ result }) => {
  expect(result.trajectory).to.haveCalledTool('search_logs');
});
`;

describe('CLI migrate (real CLI processes)', () => {
  const tracker = createTestDataTracker();
  let ready = false;
  let tmp: string;
  let benchmarkName: string;

  beforeAll(async () => {
    ready = await backendReadyOrSkip('cli-migrate', BASE_URL);
    if (!ready) return;
    ensureCliBundle();
    tmp = makeTempDir('ah-cli-migrate');
    writeCasesFile(tmp, 'a.json', 1, 'cli-migrate-a');
    writeCasesFile(tmp, 'b.json', 1, 'cli-migrate-b');
    benchmarkName = uniqueTestName('cli-migrate-bm');
    const seed = runCli(['benchmark', '-f', join(tmp, 'a.json'), '-f', join(tmp, 'b.json'), '-a', 'demo', '-n', benchmarkName, '--judge-model', 'demo-model'], { timeoutMs: 150_000 });
    const bm = await trackBenchmarkByName(tracker, benchmarkName);
    if (seed.status !== 0 || !bm) throw new Error(`seed benchmark failed (exit ${seed.status}):\n${seed.output}`);
  }, TEST_TIMEOUT);

  afterAll(async () => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    await tracker.cleanup();
  }, 120_000);

  it('requires a running backend (skip otherwise)', () => {
    if (!ready) return;
    expect(benchmarkName).toBeTruthy();
  });

  it('migrate --dry-run -v lists the benchmark, its run and a summary, and changes nothing', () => {
    if (!ready) return;
    const res = runCli(['migrate', '--dry-run', '-v']);
    const out = plain(res.output);
    expect(res.status).toBe(0);
    expect(out).toMatch(/Benchmark Stats Migration/);
    expect(out).toMatch(/Found \d+ benchmarks/);
    expect(out).toContain(`Processing: ${benchmarkName} (1 runs)`);
    // A run the CLI just created already carries stats.
    expect(out).toMatch(/CLI Run - demo - .* - already has stats/);
    expect(out).toContain(`[DRY RUN] ${benchmarkName} - 1 runs would be processed`);
    expect(out).toMatch(/Migration Summary/);
    expect(out).toMatch(/Total runs:\s+\d+/);
    expect(out).toMatch(/This was a dry run\. No changes were made\./);
  }, TEST_TIMEOUT);

  it('migrate (for real) reports "Migration complete" with the already-done count', () => {
    if (!ready) return;
    const res = runCli(['migrate']);
    const out = plain(res.output);
    expect(res.status).toBe(0);
    expect(out).toContain(`✓ ${benchmarkName} - 1 runs`);
    expect(out).toMatch(/Already done:\s+[1-9]\d*/);
    expect(out).toMatch(/Migration complete!/);
  }, TEST_TIMEOUT);

  it('migrate evaluation-runs --dry-run -v: runs that already exist as top-level docs are skipped', () => {
    if (!ready) return;
    const res = runCli(['migrate', 'evaluation-runs', '--dry-run', '-v']);
    const out = plain(res.output);
    expect(res.status).toBe(0);
    expect(out).toMatch(/Evaluation Runs Migration/);
    expect(out).toContain(`✓ ${benchmarkName}: 1 runs`);
    expect(out).toMatch(/Total embedded runs:\s+[1-9]\d*/);
    expect(out).toMatch(/Already done:\s+[1-9]\d*/);
  }, TEST_TIMEOUT);

  describe('migrate sdk-v2 (codemod)', () => {
    it('--dry-run prints what would change and leaves the file untouched; a real run rewrites it to agent.run()', () => {
      if (!ready) return;
      const dir = join(tmp, 'evals');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, 'legacy.eval.js');
      writeFileSync(file, V1_EVAL, 'utf-8');

      const dry = runCli(['migrate', 'sdk-v2', file, '--dry-run', '-v'], { cwd: dir });
      const dryOut = plain(dry.output);
      expect(dry.status).toBe(0);
      expect(dryOut).toMatch(/Code-SDK v2 migration/);
      expect(dryOut).toMatch(/would update .*legacy\.eval\.js \(1 test\)/);
      expect(dryOut).toMatch(/Files scanned:\s+1/);
      expect(dryOut).toMatch(/Files to change:\s+1/);
      expect(dryOut).toMatch(/Dry run — no files written/);
      expect(readFileSync(file, 'utf-8')).toBe(V1_EVAL);

      const apply = runCli(['migrate', 'sdk-v2', file], { cwd: dir });
      const applyOut = plain(apply.output);
      expect(apply.status).toBe(0);
      expect(applyOut).toMatch(/updated .*legacy\.eval\.js \(1 test\)/);
      expect(applyOut).toMatch(/Files changed:\s+1/);
      expect(applyOut).toMatch(/Tests migrated:\s+1/);
      const migrated = readFileSync(file, 'utf-8');
      expect(migrated).not.toBe(V1_EVAL);
      expect(migrated).toMatch(/agent\.run\(\)/);

      // Second pass: nothing left to migrate.
      const again = runCli(['migrate', 'sdk-v2', file, '-v'], { cwd: dir });
      expect(again.status).toBe(0);
      expect(plain(again.output)).toMatch(/unchanged .*legacy\.eval\.js/);
      expect(plain(again.output)).toMatch(/Files changed:\s+0/);
    }, TEST_TIMEOUT);

    it('with no matching .eval files it says so and exits 0', () => {
      if (!ready) return;
      const empty = join(tmp, 'empty');
      mkdirSync(empty, { recursive: true });
      const res = runCli(['migrate', 'sdk-v2'], { cwd: empty });
      expect(res.status).toBe(0);
      expect(plain(res.output)).toMatch(/No matching \.eval files found/);
    }, TEST_TIMEOUT);
  });
});
