/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Surface matrix · CLI · `benchmark -d <dir> -a <agent>`
 *
 * Directory import: every `*.json` file in the directory is imported and run
 * as one evaluation run. Pinned:
 *   - exit 0, "Sources: 1 source(s)", "Evaluation run completed (N/N test
 *     cases)" where N is the total across all files;
 *   - ad hoc without `-n` (run doc: `directory-import` source, no benchmark);
 *   - a directory with no JSON files exits 1 with "No JSON files found";
 *   - a missing directory exits 1 with "Directory not found".
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createTestDataTracker, uniqueTestName } from '../../helpers/testDataTracker';
import { startTraceparentRestAgent, type TraceparentRestAgent } from '../../helpers/traceparentRestAgent';
import {
  BASE_URL, backendReady, caseInput, describeResolvedReports, getEvaluationRun, registerRestAgent, reportIdsOf,
  runCli, waitForReportsResolved,
} from '../../helpers/surfaceMatrix';

const TEST_TIMEOUT = 240_000;

describe('surface-matrix · CLI · benchmark -d <dir>', () => {
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-surface-cli-dir-'));
  }, TEST_TIMEOUT);

  afterAll(async () => {
    if (agent) await agent.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    await tracker.cleanup();
  }, 60_000);

  it('imports every JSON file in the directory and runs all cases ad hoc', async () => {
    if (!ready) return;
    const dir = path.join(tmpDir, uniqueTestName('cases-dir'));
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify([caseInput('cli-dir-a', 1), caseInput('cli-dir-a', 2)]));
    fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify([caseInput('cli-dir-b', 1)]));
    fs.writeFileSync(path.join(dir, 'README.md'), 'not a test file');

    const result = await runCli(['benchmark', '-d', dir, '-a', agentKey]);
    const runId = /ad-hoc run \(ID: (eval-run-[^)]+)\)/.exec(result.out)?.[1];
    if (runId) tracker.evaluationRun(runId);
    const run = runId ? await getEvaluationRun(runId) : undefined;
    if (run) {
      for (const id of reportIdsOf(run)) tracker.run(id);
      for (const s of run.testCaseSnapshots || []) tracker.testCase(s.id);
    }

    expect(result.code).toBe(0);
    expect(result.out).toContain('Sources: 1 source(s)');
    expect(result.out).toContain('Mode: Ad-hoc (no benchmark association)');
    expect(result.out).toContain('Evaluation run completed (3/3 test cases)');
    expect(result.out).toMatch(/Passed:\s+3/);
    expect(run).toBeDefined();
    expect(run.status).toBe('completed');
    expect(run.benchmarkId).toBeFalsy();
    expect(run.sources.map((s: any) => s.type)).toEqual(['directory-import']);
    expect(run.testCaseSnapshots).toHaveLength(3);
    expect(describeResolvedReports(await waitForReportsResolved(reportIdsOf(run)), agent)).toEqual([]);
    expect(agent.invocations).toHaveLength(3);
  }, TEST_TIMEOUT);

  it('a directory without JSON files exits 1 with "No JSON files found"', async () => {
    if (!ready) return;
    const dir = path.join(tmpDir, 'empty');
    fs.mkdirSync(dir);
    const result = await runCli(['benchmark', '-d', dir, '-a', agentKey], { timeoutMs: 60_000 });
    expect(result.code).toBe(1);
    expect(result.out).toContain('No JSON files found');
  }, TEST_TIMEOUT);

  it('a missing directory exits 1 with "Directory not found"', async () => {
    if (!ready) return;
    const result = await runCli(['benchmark', '-d', path.join(tmpDir, 'does-not-exist'), '-a', agentKey], { timeoutMs: 60_000 });
    expect(result.code).toBe(1);
    expect(result.out).toContain('Directory not found');
  }, TEST_TIMEOUT);
});
