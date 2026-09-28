/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Surface matrix · CLI · `run -t <test case> -a <agent>` (single case)
 *
 * The single-test-case runner. `run` resolves agents from the LOCAL config
 * (built-ins + agent-health.config.ts), so the matrix pins it with the
 * built-in `demo` agent (mock endpoint, works out of the box) — UI-registered
 * custom agents are not addressable from `run` on this branch (pinned below).
 * Pinned:
 *   - `run -t <id> -a demo` exits 0, prints "Test Case: <name> (<id>)",
 *     "PASSED" (or FAILED — never an error) and the results table with a
 *     Report ID; the report is persisted via `/api/storage/runs/:id` with
 *     `status: completed` and a verdict;
 *   - `-t <name>` resolves the case by name too;
 *   - `-o json` prints `[{ agent, report }]` with the report id;
 *   - `-t <unknown>` exits 1 with "Test case not found";
 *   - `-a <unknown>` exits 1 with "Agent not found".
 */

import { createTestDataTracker, uniqueTestName } from '../../helpers/testDataTracker';
import {
  BASE_URL, api, backendReady, caseInput, createTestCase, getReport, runCli, settleStorage,
} from '../../helpers/surfaceMatrix';

const TEST_TIMEOUT = 240_000;

describe('surface-matrix · CLI · run -t <case> -a demo', () => {
  const tracker = createTestDataTracker();
  let ready = false;
  let tc: { id: string; name: string };

  beforeAll(async () => {
    ready = await backendReady();
    if (!ready) { console.warn(`[surface-matrix] backend not reachable at ${BASE_URL}; skipping`); return; }
    tc = await createTestCase(caseInput('cli-run', 1, { initialPrompt: 'What is causing the high CPU usage on the web server?' }));
    tracker.testCase(tc.id);
  }, TEST_TIMEOUT);

  afterAll(async () => {
    await tracker.cleanup();
  }, 60_000);

  /** Track every report the single-case runner persisted for our case. */
  async function trackReports(): Promise<any[]> {
    await settleStorage(); // list views lag one refresh on OpenSearch
    const body = await api<{ runs: any[] }>('GET', `/api/storage/runs/by-test-case/${encodeURIComponent(tc.id)}`);
    for (const r of body.runs || []) tracker.run(r.id);
    return body.runs || [];
  }

  it('`run -t <id> -a demo` prints a verdict + report id and persists the report', async () => {
    if (!ready) return;
    const result = await runCli(['run', '-t', tc.id, '-a', 'demo']);
    const reports = await trackReports();

    expect(result.code).toBe(0);
    expect(result.out).toContain(`Test Case: ${tc.name} (${tc.id})`);
    expect(result.out).toContain('Agents: Demo Agent');
    expect(result.out).toMatch(/Demo Agent: (PASSED|FAILED)/);
    expect(result.out).not.toMatch(/Demo Agent: (ERROR|NO VERDICT|PENDING)/);
    // Results table header + the report id column.
    for (const col of ['Agent', 'Status', 'Accuracy', 'Steps', 'Report ID']) expect(result.out).toContain(col);
    expect(result.out).toMatch(/report-\d+-[a-z0-9]+/);

    expect(reports.length).toBeGreaterThanOrEqual(1);
    const report = await getReport(reports[0].id);
    expect(report.status).toBe('completed');
    expect(['passed', 'failed']).toContain(report.passFailStatus);
    expect(report.testCaseId).toBe(tc.id);
    expect(report.agentKey).toBe('demo');
    expect(report.trajectory.length).toBeGreaterThan(0);
  }, TEST_TIMEOUT);

  it('`run -t <name> -a demo -o json` resolves the case by name and prints JSON', async () => {
    if (!ready) return;
    const result = await runCli(['run', '-t', tc.name, '-a', 'demo', '-o', 'json']);
    await trackReports();

    expect(result.code).toBe(0);
    const start = result.stdout.search(/^\[\s*$/m);
    expect(start).toBeGreaterThan(-1);
    const parsed = JSON.parse(result.stdout.slice(start));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].agent).toEqual({ key: 'demo', name: 'Demo Agent' });
    expect(parsed[0].report.status).toBe('completed');
    expect(['passed', 'failed']).toContain(parsed[0].report.passFailStatus);
    expect(typeof parsed[0].report.id).toBe('string');
  }, TEST_TIMEOUT);

  it('`run -t <unknown>` exits 1 with "Test case not found"', async () => {
    if (!ready) return;
    const result = await runCli(['run', '-t', uniqueTestName('no-such-case'), '-a', 'demo'], { timeoutMs: 60_000 });
    expect(result.code).toBe(1);
    expect(result.out).toContain('Test case not found');
  }, TEST_TIMEOUT);

  it('`run -a <unknown agent>` exits 1 with "Agent not found"', async () => {
    if (!ready) return;
    const result = await runCli(['run', '-t', tc.id, '-a', uniqueTestName('no-such-agent')], { timeoutMs: 60_000 });
    expect(result.code).toBe(1);
    expect(result.out).toContain('Agent not found');
  }, TEST_TIMEOUT);
});
