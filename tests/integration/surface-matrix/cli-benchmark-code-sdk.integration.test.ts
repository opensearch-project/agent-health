/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Surface matrix · CLI · `benchmark -f <file>.eval.js -a <agent>` (code SDK)
 *
 * The experimental code-based test SDK: a `.eval.js` file whose bodies must
 * actually EXECUTE (chai matchers on the real agent result). Pinned:
 *   - `-f suite.eval.js -a <agent>` exits 0 and prints
 *     "Evaluation run completed (N/N test cases)" with the Passed/Failed
 *     breakdown; without `-n` it is an AD-HOC run ("no benchmark association"
 *     printed, run doc has no `benchmarkId`) and the promote hint is shown;
 *   - the agent is invoked once per prompt-bearing test (a prompt-less,
 *     purely deterministic test never calls the agent);
 *   - a failing matcher lands as a `failed` result (not a silently passed one);
 *   - `-f suite.eval.js -n <name>` groups the run under a benchmark named
 *     `<name>` (created when new) and prints the results link.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createTestDataTracker, uniqueTestName } from '../../helpers/testDataTracker';
import { startTraceparentRestAgent, type TraceparentRestAgent } from '../../helpers/traceparentRestAgent';
import {
  BASE_URL, backendReady, findBenchmarkByName, getBenchmark, getEvaluationRun, registerRestAgent, reportIdsOf, runCli,
} from '../../helpers/surfaceMatrix';

const TEST_TIMEOUT = 240_000;

/** Run-unique test names so repeated runs never collide on the name-keyed upsert. */
function evalFile(stamp: string): string {
  return `
const { test, expect } = require('@opensearch-project/agent-health');

// Calls the agent (documented \`await agent.run()\` form); deterministic matchers on the real result.
test('${stamp}-agent-answers', {
  prompt: 'search products ${stamp}',
  labels: ['category:Smoke', 'difficulty:Easy'],
  expectedOutcomes: ['returns a product'],
}, async ({ agent }) => {
  const result = await agent.run();
  expect(result.agentOutput).to.include('answer for: search products ${stamp}');
  expect(result.trajectory).to.haveCalledTool('search_products');
  expect(result).to.haveCompletedWithin(60_000);
});

// No prompt → the agent is never invoked; the body still runs.
test('${stamp}-deterministic-only', {
  labels: ['category:Smoke', 'difficulty:Easy'],
}, () => {
  expect(2 + 2).to.equal(4);
});

// A failing matcher must be recorded as a failure, not swallowed.
test('${stamp}-fails-on-purpose', {
  labels: ['category:Smoke', 'difficulty:Easy'],
}, () => {
  expect('a').to.equal('b');
});
`;
}

describe('surface-matrix · CLI · benchmark -f <suite>.eval.js (code SDK)', () => {
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-surface-cli-sdk-'));
  }, TEST_TIMEOUT);

  afterAll(async () => {
    if (agent) await agent.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    await tracker.cleanup();
  }, 60_000);

  function parseRunId(out: string): string | undefined {
    return /ad-hoc run \(ID: (eval-run-[^)]+)\)/.exec(out)?.[1] ?? /\/runs\/(eval-run-[^\s/]+)/.exec(out)?.[1];
  }

  async function trackRun(runId: string | undefined): Promise<any | undefined> {
    if (!runId) return undefined;
    tracker.evaluationRun(runId);
    const run = await getEvaluationRun(runId).catch(() => undefined);
    if (run) {
      for (const id of reportIdsOf(run)) tracker.run(id);
      for (const s of run.testCaseSnapshots || []) tracker.testCase(s.id);
    }
    return run;
  }

  it('runs the SDK bodies ad hoc: 3 tests → 2 passed, 1 failed, agent called exactly once', async () => {
    if (!ready) return;
    const stamp = uniqueTestName('sdk');
    const file = path.join(tmpDir, `${stamp}.eval.js`);
    fs.writeFileSync(file, evalFile(stamp));
    const before = agent.invocations.length;

    const result = await runCli(['benchmark', '-f', file, '-a', agentKey]);
    const run = await trackRun(parseRunId(result.out));

    expect(result.code).toBe(0);
    expect(result.out).toContain('Mode: Ad-hoc (no benchmark association)');
    expect(result.out).toContain('Evaluation run completed (3/3 test cases)');
    expect(result.out).toMatch(/Passed:\s+2/);
    expect(result.out).toMatch(/Failed:\s+1/);
    expect(result.out).toContain('Promote to benchmark with: -n "Benchmark Name"');
    expect(run).toBeDefined();
    expect(run.status).toBe('completed');
    expect(run.trigger).toBe('cli');
    expect(run.benchmarkId).toBeFalsy();
    expect(run.sources.map((s: any) => s.type)).toEqual(['code-import']);
    const statuses = Object.values(run.results as Record<string, any>).map((r) => r.status).sort();
    expect(statuses).toEqual(['completed', 'completed', 'failed']);
    // Only the prompt-bearing test invoked the agent.
    expect(agent.invocations.length - before).toBe(1);
    expect(agent.invocations.at(-1)!.prompt).toBe(`search products ${stamp}`);
  }, TEST_TIMEOUT);

  it('`-n <name>` groups the code-SDK run under a (new) benchmark and prints its results link', async () => {
    if (!ready) return;
    const stamp = uniqueTestName('sdk-named');
    const file = path.join(tmpDir, `${stamp}.eval.js`);
    fs.writeFileSync(file, evalFile(stamp));
    const benchName = uniqueTestName('cli-sdk-bench');

    const result = await runCli(['benchmark', '-f', file, '-n', benchName, '-a', agentKey]);
    const bench = await findBenchmarkByName(benchName);
    if (bench) tracker.benchmark(bench.id);
    const run = await trackRun(parseRunId(result.out));

    expect(result.code).toBe(0);
    expect(bench).toBeDefined();
    expect(result.out).toContain(`Benchmark: ${benchName}`);
    expect(result.out).toContain(`/evaluations/benchmarks/${bench.id}/runs/${run.id}`);
    expect(run.benchmarkId).toBe(bench.id);
    // The benchmark now holds the three imported cases and lists the run.
    const b = await getBenchmark(bench.id);
    expect(b.testCaseIds).toHaveLength(3);
    expect((b.runs || []).map((r: any) => r.id)).toContain(run.id);
  }, TEST_TIMEOUT);
});
