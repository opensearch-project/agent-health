/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Surface matrix · CLI · `benchmark -t <id> [-t <id>…]` and `benchmark --label <l>`
 *
 * Ad-hoc source selection from cases that already exist in storage. Pinned:
 *   - `-t <id> -t <id>` runs exactly those cases (`test-case-ids` source);
 *   - `--label <l>` runs exactly the cases carrying the label (`label-filter`
 *     source) — a case without the label is NOT run;
 *   - both are ad hoc unless `-n` is given; both exit 0 and print
 *     "Evaluation run completed (N/N test cases)";
 *   - `-c N` is echoed as "Concurrency: N" in this mode too;
 *   - `-t <unknown-id>` fails the run cleanly (exit 1, "Run failed" with the
 *     "Test case not found" reason) instead of hanging.
 */

import { createTestDataTracker, uniqueTestName } from '../../helpers/testDataTracker';
import { startTraceparentRestAgent, type TraceparentRestAgent } from '../../helpers/traceparentRestAgent';
import {
  BASE_URL, backendReady, caseInput, createTestCase, describeResolvedReports, getEvaluationRun, registerRestAgent,
  reportIdsOf, runCli, settleStorage, waitForReportsResolved,
} from '../../helpers/surfaceMatrix';

const TEST_TIMEOUT = 240_000;

describe('surface-matrix · CLI · benchmark -t <id> / --label <l>', () => {
  const tracker = createTestDataTracker();
  let ready = false;
  let agent: TraceparentRestAgent;
  let agentKey: string;
  let label: string;
  let labelled: string[] = [];
  let unlabelled: string;

  beforeAll(async () => {
    ready = await backendReady();
    if (!ready) { console.warn(`[surface-matrix] backend not reachable at ${BASE_URL}; skipping`); return; }
    agent = await startTraceparentRestAgent({ otlpEndpoint: `${BASE_URL}/v1/traces` });
    agentKey = await registerRestAgent(agent, { useTraces: true });
    tracker.customAgent(agentKey);
    label = uniqueTestName('surface-label');
    for (let i = 1; i <= 2; i++) {
      const tc = await createTestCase(caseInput('cli-label', i, { labels: [label, 'category:RCA', 'difficulty:Easy'] }));
      tracker.testCase(tc.id);
      labelled.push(tc.id);
    }
    const other = await createTestCase(caseInput('cli-unlabelled', 1));
    tracker.testCase(other.id);
    unlabelled = other.id;
    await settleStorage(); // label search is a query, not a get-by-id
  }, TEST_TIMEOUT);

  afterAll(async () => {
    if (agent) await agent.close();
    await tracker.cleanup();
  }, 60_000);

  async function runAndTrack(args: string[]) {
    const result = await runCli(args);
    const runId = /ad-hoc run \(ID: (eval-run-[^)]+)\)/.exec(result.out)?.[1];
    if (runId) tracker.evaluationRun(runId);
    const run = runId ? await getEvaluationRun(runId) : undefined;
    if (run) for (const id of reportIdsOf(run)) tracker.run(id);
    return { result, run };
  }

  it('`-t <id> -t <id> -c 2` runs exactly the given cases', async () => {
    if (!ready) return;
    const before = agent.invocations.length;
    const { result, run } = await runAndTrack(['benchmark', '-t', labelled[0], '-t', unlabelled, '-c', '2', '-a', agentKey]);

    expect(result.code).toBe(0);
    expect(result.out).toContain('Concurrency: 2');
    expect(result.out).toContain('Evaluation run completed (2/2 test cases)');
    expect(run).toBeDefined();
    expect(run.status).toBe('completed');
    expect(run.benchmarkId).toBeFalsy();
    expect(run.sources).toEqual([{ type: 'test-case-ids', ids: [labelled[0], unlabelled] }]);
    expect(Object.keys(run.results).sort()).toEqual([labelled[0], unlabelled].sort());
    expect(describeResolvedReports(await waitForReportsResolved(reportIdsOf(run)), agent)).toEqual([]);
    expect(agent.invocations.length - before).toBe(2);
  }, TEST_TIMEOUT);

  it('`--label <l>` runs exactly the cases carrying the label', async () => {
    if (!ready) return;
    const before = agent.invocations.length;
    const { result, run } = await runAndTrack(['benchmark', '--label', label, '-a', agentKey]);

    expect(result.code).toBe(0);
    expect(result.out).toContain('Evaluation run completed (2/2 test cases)');
    expect(run).toBeDefined();
    expect(run.status).toBe('completed');
    expect(run.sources[0]).toMatchObject({ type: 'label-filter', labels: [label] });
    expect(Object.keys(run.results).sort()).toEqual([...labelled].sort());
    expect(run.results[unlabelled]).toBeUndefined();
    expect(describeResolvedReports(await waitForReportsResolved(reportIdsOf(run)), agent)).toEqual([]);
    expect(agent.invocations.length - before).toBe(2);
  }, TEST_TIMEOUT);

  it('`-t <unknown-id>` exits 1 with the "Test case not found" reason', async () => {
    if (!ready) return;
    const result = await runCli(['benchmark', '-t', `tc-${uniqueTestName('missing')}`, '-a', agentKey], { timeoutMs: 60_000 });
    expect(result.code).toBe(1);
    expect(result.out).toContain('Test case not found');
  }, TEST_TIMEOUT);
});
