/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Surface matrix · CLI · `export -b <benchmark> -o <file>` → `benchmark -f <file>` round-trip
 *
 * The documented "export produces import-compatible JSON" contract. Pinned:
 *   - `export -b <name-or-id> -o file` exits 0, prints "Exported N test
 *     case(s) to <file>" and writes an array of N import-compatible test
 *     cases (name / category / difficulty / initialPrompt / expectedOutcomes);
 *   - `export --stdout` prints the same JSON to stdout, nothing else;
 *   - feeding that file back through `benchmark -f <file> -n <new> -a <agent>`
 *     imports N cases and runs them N/N (the round trip);
 *   - `GET /api/storage/benchmarks/:id/export` — the API the CLI uses — returns
 *     the same array with a `Content-Disposition: attachment` header;
 *   - `export -b <unknown>` exits 1 with "Benchmark not found".
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createTestDataTracker, uniqueTestName } from '../../helpers/testDataTracker';
import { startTraceparentRestAgent, type TraceparentRestAgent } from '../../helpers/traceparentRestAgent';
import {
  BASE_URL, backendReady, caseInput, createBenchmark, createTestCase, describeResolvedReports,
  findBenchmarkByName, httpRequest, listTerminalRunsForBenchmark, registerRestAgent, reportIdsOf, runCli, waitForReportsResolved,
} from '../../helpers/surfaceMatrix';

const TEST_TIMEOUT = 240_000;
const CASES = 2;

describe('surface-matrix · CLI · export -b … -o file → benchmark -f file (round trip)', () => {
  const tracker = createTestDataTracker();
  let ready = false;
  let agent: TraceparentRestAgent;
  let agentKey: string;
  let tmpDir: string;
  let benchmarkId: string;
  let benchmarkName: string;
  const caseNames: string[] = [];

  beforeAll(async () => {
    ready = await backendReady();
    if (!ready) { console.warn(`[surface-matrix] backend not reachable at ${BASE_URL}; skipping`); return; }
    agent = await startTraceparentRestAgent({ otlpEndpoint: `${BASE_URL}/v1/traces` });
    agentKey = await registerRestAgent(agent, { useTraces: true });
    tracker.customAgent(agentKey);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-surface-cli-export-'));
    const ids: string[] = [];
    for (let i = 1; i <= CASES; i++) {
      const tc = await createTestCase(caseInput('cli-export', i));
      tracker.testCase(tc.id);
      ids.push(tc.id);
      caseNames.push(tc.name);
    }
    benchmarkName = uniqueTestName('cli-export-bench');
    const bm = await createBenchmark(benchmarkName, ids);
    benchmarkId = bm.id;
    tracker.benchmark(benchmarkId);
  }, TEST_TIMEOUT);

  afterAll(async () => {
    if (agent) await agent.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    await tracker.cleanup();
  }, 60_000);

  const IMPORT_FIELDS = ['name', 'category', 'difficulty', 'initialPrompt', 'expectedOutcomes'];

  it('`export -b <name> -o file` writes N import-compatible test cases', async () => {
    if (!ready) return;
    const file = path.join(tmpDir, 'exported.json');
    const result = await runCli(['export', '-b', benchmarkName, '-o', file], { timeoutMs: 60_000 });
    expect(result.code).toBe(0);
    expect(result.out).toContain(`Exported ${CASES} test case(s) to ${file}`);
    expect(result.out).toContain(`Benchmark: ${benchmarkName} (${benchmarkId})`);

    const exported = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(Array.isArray(exported)).toBe(true);
    expect(exported).toHaveLength(CASES);
    for (const tc of exported) for (const f of IMPORT_FIELDS) expect(tc).toHaveProperty(f);
    expect(exported.map((tc: any) => tc.name).sort()).toEqual([...caseNames].sort());
  }, TEST_TIMEOUT);

  it('`export -b <id> --stdout` prints only the JSON array', async () => {
    if (!ready) return;
    const result = await runCli(['export', '-b', benchmarkId, '--stdout'], { timeoutMs: 60_000 });
    expect(result.code).toBe(0);
    // stdout carries the JSON array (the ServerLifecycle reuse notice precedes
    // it on stdout as well — pinned as-is; the array itself starts at the first
    // `[` that opens a line).
    const start = result.stdout.search(/^\[\s*$/m);
    expect(start).toBeGreaterThan(-1);
    const parsed = JSON.parse(result.stdout.slice(start));
    expect(parsed).toHaveLength(CASES);
  }, TEST_TIMEOUT);

  it('the exported file imports and runs N/N through `benchmark -f <file> -n <new> -a <agent>`', async () => {
    if (!ready) return;
    const file = path.join(tmpDir, 'roundtrip.json');
    const exp = await runCli(['export', '-b', benchmarkId, '-o', file], { timeoutMs: 60_000 });
    expect(exp.code).toBe(0);

    const newName = uniqueTestName('cli-export-roundtrip');
    const result = await runCli(['benchmark', '-f', file, '-n', newName, '-a', agentKey]);
    const bench = await findBenchmarkByName(newName);
    if (bench) {
      tracker.benchmark(bench.id);
      // Re-importing an exported case upserts by name — the ids may be the
      // originals (already tracked) or fresh ones; track whatever is linked.
      for (const id of bench.testCaseIds || []) tracker.testCase(id);
    }
    expect(result.code).toBe(0);
    expect(result.out).toContain(`${CASES}/${CASES} passed`);
    expect(bench).toBeDefined();
    expect(bench.testCaseIds).toHaveLength(CASES);

    const evaluationRuns = await listTerminalRunsForBenchmark(bench.id);
    expect(evaluationRuns).toHaveLength(1);
    tracker.evaluationRun(evaluationRuns[0].id);
    const reportIds = reportIdsOf(evaluationRuns[0]);
    for (const id of reportIds) tracker.run(id);
    expect(reportIds).toHaveLength(CASES);
    expect(describeResolvedReports(await waitForReportsResolved(reportIds), agent)).toEqual([]);
  }, TEST_TIMEOUT);

  it('`GET /api/storage/benchmarks/:id/export` (what the CLI calls) is an attachment with the same array', async () => {
    if (!ready) return;
    const res = await httpRequest('GET', `/api/storage/benchmarks/${encodeURIComponent(benchmarkId)}/export`);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename=".+\.json"$/);
    expect(res.body).toHaveLength(CASES);
  });

  it('`export -b <unknown>` exits 1 with "Benchmark not found"', async () => {
    if (!ready) return;
    const result = await runCli(['export', '-b', uniqueTestName('nope'), '--stdout'], { timeoutMs: 60_000 });
    expect(result.code).toBe(1);
    expect(result.out).toContain('Benchmark not found');
  }, TEST_TIMEOUT);
});
