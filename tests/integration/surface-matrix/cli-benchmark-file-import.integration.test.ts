/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Surface matrix · CLI · `benchmark -f <cases.json> [-n <name>] -a <agent>`
 *
 * "Import and run" — the documented one-step path for a JSON test-case file.
 * Pinned:
 *   - `-f cases.json -a <agent>` exits 0, prints "Running in file mode" and
 *     "Imported N test cases", creates a benchmark NAMED AFTER THE FILE
 *     (basename without extension) holding exactly the imported cases, and
 *     runs it N/N;
 *   - `-n <name> -f cases.json` names the benchmark `<name>` instead;
 *   - the run is discoverable via the API (cli-triggered, benchmark-associated,
 *     judged with resolved traces);
 *   - a file that fails schema validation exits 1 with "Validation failed".
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createTestDataTracker, uniqueTestName } from '../../helpers/testDataTracker';
import { startTraceparentRestAgent, type TraceparentRestAgent } from '../../helpers/traceparentRestAgent';
import {
  BASE_URL, backendReady, caseInput, describeResolvedReports, findBenchmarkByName, listTerminalRunsForBenchmark,
  registerRestAgent, reportIdsOf, runCli, waitForReportsResolved,
} from '../../helpers/surfaceMatrix';

const TEST_TIMEOUT = 240_000;
const CASES = 2;

describe('surface-matrix · CLI · benchmark -f <cases.json> [-n <name>]', () => {
  const tracker = createTestDataTracker();
  let ready = false;
  let agent: TraceparentRestAgent;
  let agentKey: string;
  let tmpDir: string;

  beforeAll(async () => {
    ready = await backendReady();
    if (!ready) { console.warn(`[surface-matrix] backend not reachable at ${BASE_URL}; skipping`); return; }
    agent = await startTraceparentRestAgent({ otlpEndpoint: `${BASE_URL}/v1/traces` });
    agentKey = await registerRestAgent(agent, { useTraces: true });
    tracker.customAgent(agentKey);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-surface-cli-file-'));
  }, TEST_TIMEOUT);

  afterAll(async () => {
    if (agent) await agent.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    await tracker.cleanup();
  }, 60_000);

  /** Track whatever the import created (benchmark + its cases), by the unique name we chose. */
  async function trackImported(benchName: string): Promise<any> {
    const bench = await findBenchmarkByName(benchName);
    if (bench) {
      tracker.benchmark(bench.id);
      for (const id of bench.testCaseIds || []) tracker.testCase(id);
      const evaluationRuns = await listTerminalRunsForBenchmark(bench.id, 0, 0);
      for (const run of evaluationRuns) {
        tracker.evaluationRun(run.id);
        for (const id of reportIdsOf(run)) tracker.run(id);
      }
    }
    return bench;
  }

  async function assertRunForBenchmark(bench: any, expectedCases: number): Promise<any> {
    const evaluationRuns = await listTerminalRunsForBenchmark(bench.id);
    expect(evaluationRuns).toHaveLength(1);
    const run = evaluationRuns[0];
    expect(run.trigger).toBe('cli');
    expect(run.status).toBe('completed');
    expect(Object.keys(run.results)).toHaveLength(expectedCases);
    const reports = await waitForReportsResolved(reportIdsOf(run));
    expect(describeResolvedReports(reports, agent)).toEqual([]);
    return run;
  }

  it('`-f cases.json -a <agent>` imports, creates a benchmark named after the file, and runs it N/N', async () => {
    if (!ready) return;
    // The benchmark takes the file's basename → make the basename run-unique.
    const benchName = uniqueTestName('cli-file-basename');
    const file = path.join(tmpDir, `${benchName}.json`);
    fs.writeFileSync(file, JSON.stringify(Array.from({ length: CASES }, (_, i) => caseInput('cli-file', i + 1)), null, 2));

    const result = await runCli(['benchmark', '-f', file, '-a', agentKey]);
    const bench = await trackImported(benchName);

    expect(result.code).toBe(0);
    expect(result.out).toContain(`Running in file mode (importing test cases from ${file})`);
    expect(result.out).toContain(`Imported ${CASES} test cases`);
    expect(result.out).toContain(`${CASES}/${CASES} passed`);
    expect(result.out).not.toContain('errored — evaluator could not run');
    expect(bench).toBeDefined();
    expect(bench.testCaseIds).toHaveLength(CASES);
    const run = await assertRunForBenchmark(bench, CASES);
    expect(result.out).toContain(`/evaluations/benchmarks/${bench.id}/runs/${run.id}`);
  }, TEST_TIMEOUT);

  it('`-n <name> -f cases.json -a <agent>` names the created benchmark <name>', async () => {
    if (!ready) return;
    const benchName = uniqueTestName('cli-file-named');
    const file = path.join(tmpDir, 'cases.json');
    fs.writeFileSync(file, JSON.stringify(Array.from({ length: CASES }, (_, i) => caseInput('cli-file-named', i + 1)), null, 2));

    const result = await runCli(['benchmark', '-n', benchName, '-f', file, '-a', agentKey]);
    const bench = await trackImported(benchName);

    expect(result.code).toBe(0);
    expect(bench).toBeDefined();
    expect(result.out).toContain(`Benchmark: ${benchName} (${bench.id}) — ${CASES} test cases`);
    expect(bench.testCaseIds).toHaveLength(CASES);
    await assertRunForBenchmark(bench, CASES);
  }, TEST_TIMEOUT);

  it('a file that fails validation exits 1 with "Validation failed" and creates nothing', async () => {
    if (!ready) return;
    const benchName = uniqueTestName('cli-file-invalid');
    const file = path.join(tmpDir, `${benchName}.json`);
    fs.writeFileSync(file, JSON.stringify([{ title: 'wrong field names', priority: 'High' }]));

    const result = await runCli(['benchmark', '-f', file, '-a', agentKey], { timeoutMs: 60_000 });
    expect(result.code).toBe(1);
    expect(result.out).toContain('Validation failed');
    expect(await findBenchmarkByName(benchName, 0)).toBeUndefined();
  }, TEST_TIMEOUT);
});
