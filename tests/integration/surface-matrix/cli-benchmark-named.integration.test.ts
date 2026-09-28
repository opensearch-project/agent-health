/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Surface matrix · CLI · `benchmark -n <existing> -a <agent>`
 *
 * The most common customer command: re-run an existing benchmark against an
 * agent. Pinned (all externally observable):
 *   - exit code 0; the printed "Benchmark: <name> (<id>)" line, the
 *     "Benchmark Summary" table with N passed / 0 errored, and a "View results"
 *     link that points at the run;
 *   - `-c N` is accepted and echoed;
 *   - `--export <file>` writes the JSON results file with `benchmark` + `runs[]`;
 *   - `-o json` prints a machine-readable array with `runId` / `passed` / `failed`;
 *   - the run is discoverable afterwards through the storage API: exactly one
 *     evaluation-run (`trigger: 'cli'`, `status: 'completed'`, benchmark
 *     association, N results), the benchmark's own `runs[]` projection lists
 *     it, and every report is judged with resolved trace metrics.
 *   - an unknown benchmark name exits 1 with a "Benchmark not found" message.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createTestDataTracker, uniqueTestName } from '../../helpers/testDataTracker';
import { startTraceparentRestAgent, type TraceparentRestAgent } from '../../helpers/traceparentRestAgent';
import {
  BASE_URL, backendReady, caseInput, createBenchmark, createTestCase, describeResolvedReports,
  getBenchmark, listTerminalRunsForBenchmark, registerRestAgent, reportIdsOf, runCli, waitForReportsResolved,
} from '../../helpers/surfaceMatrix';

const TEST_TIMEOUT = 240_000;
const CASES = 2;

describe('surface-matrix · CLI · benchmark -n <existing> -a <agent>', () => {
  const tracker = createTestDataTracker();
  let ready = false;
  let agent: TraceparentRestAgent;
  let agentKey: string;
  let benchmarkId: string;
  let benchmarkName: string;
  let tmpDir: string;

  beforeAll(async () => {
    ready = await backendReady();
    if (!ready) { console.warn(`[surface-matrix] backend not reachable at ${BASE_URL}; skipping`); return; }
    agent = await startTraceparentRestAgent({ otlpEndpoint: `${BASE_URL}/v1/traces` });
    agentKey = await registerRestAgent(agent, { useTraces: true });
    tracker.customAgent(agentKey);
    const ids: string[] = [];
    for (let i = 1; i <= CASES; i++) {
      const tc = await createTestCase(caseInput('cli-named', i));
      tracker.testCase(tc.id);
      ids.push(tc.id);
    }
    benchmarkName = uniqueTestName('cli-named-bench');
    const bm = await createBenchmark(benchmarkName, ids);
    benchmarkId = bm.id;
    tracker.benchmark(benchmarkId);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-surface-cli-named-'));
  }, TEST_TIMEOUT);

  afterAll(async () => {
    if (agent) await agent.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    await tracker.cleanup();
  }, 60_000);

  it('runs N/N cases, prints the summary + results link, exports JSON, and the run is discoverable via the API', async () => {
    if (!ready) return;
    const exportFile = path.join(tmpDir, 'results.json');
    const result = await runCli(['benchmark', '-n', benchmarkName, '-a', agentKey, '-c', String(CASES), '--export', exportFile]);

    expect(result.code).toBe(0);
    expect(result.out).toContain(`Benchmark: ${benchmarkName} (${benchmarkId}) — ${CASES} test cases`);
    expect(result.out).toContain(`Concurrency: ${CASES}`);
    expect(result.out).toContain('Benchmark Summary');
    expect(result.out).toContain(`${CASES}/${CASES} passed`);
    expect(result.out).not.toContain('errored — evaluator could not run');
    expect(result.out).toContain('View results:');

    // Discoverable through the storage API — one run, cli-triggered, benchmark-associated.
    const evaluationRuns = await listTerminalRunsForBenchmark(benchmarkId);
    expect(evaluationRuns).toHaveLength(1);
    const run = evaluationRuns[0];
    tracker.evaluationRun(run.id);
    expect(run.trigger).toBe('cli');
    expect(run.status).toBe('completed');
    expect(run.benchmarkId).toBe(benchmarkId);
    expect(run.agentKey).toBe(agentKey);
    expect(Object.keys(run.results)).toHaveLength(CASES);
    expect(result.out).toContain(run.id);
    expect(result.out).toContain(`/evaluations/benchmarks/${benchmarkId}/runs/${run.id}`);

    // The benchmark page's run list (benchmark.runs[] projection) shows it too.
    const bench = await getBenchmark(benchmarkId);
    expect((bench.runs || []).map((r: any) => r.id)).toContain(run.id);

    // Every report judged, traces resolved, one agent call per case.
    const reportIds = reportIdsOf(run);
    for (const id of reportIds) tracker.run(id);
    const reports = await waitForReportsResolved(reportIds);
    expect(describeResolvedReports(reports, agent)).toEqual([]);
    expect(agent.invocations).toHaveLength(CASES);

    // --export wrote the documented JSON shape.
    const exported = JSON.parse(fs.readFileSync(exportFile, 'utf8'));
    expect(exported.benchmark).toMatchObject({ id: benchmarkId, name: benchmarkName, testCaseCount: CASES });
    expect(exported.runs).toHaveLength(1);
    expect(exported.runs[0]).toMatchObject({ runId: run.id, passed: CASES, failed: 0, status: 'completed' });
    expect(exported.runs[0].reports).toHaveLength(CASES);
    expect(result.out).toContain(`Results exported to: ${exportFile}`);
  }, TEST_TIMEOUT);

  it('`-o json` prints a machine-readable summary array', async () => {
    if (!ready) return;
    const result = await runCli(['benchmark', '-n', benchmarkId, '-a', agentKey, '-o', 'json']);
    expect(result.code).toBe(0);
    // The JSON array is the last thing printed before the "View results" footer.
    const start = result.stdout.indexOf('[\n');
    const end = result.stdout.lastIndexOf('\n]');
    expect(start).toBeGreaterThan(-1);
    const parsed = JSON.parse(result.stdout.slice(start, end + 2));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ agent: { key: agentKey }, passed: CASES, failed: 0, passRate: 100 });
    expect(typeof parsed[0].runId).toBe('string');
    tracker.evaluationRun(parsed[0].runId);
    for (const r of Object.values(parsed[0].results || {}) as any[]) tracker.run(r.reportId);
  }, TEST_TIMEOUT);

  it('an unknown benchmark exits 1 with "Benchmark not found" and a hint to list benchmarks', async () => {
    if (!ready) return;
    const result = await runCli(['benchmark', '-n', uniqueTestName('does-not-exist'), '-a', agentKey], { timeoutMs: 60_000 });
    expect(result.code).toBe(1);
    expect(result.out).toContain('Benchmark not found');
    expect(result.out).toContain('list benchmarks');
  }, TEST_TIMEOUT);
});
