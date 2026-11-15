/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A run started by the REAL CLI (`agent-health benchmark -d …`, executing in
 * the CLI process and persisting through the run-ingestion API — #612 step 3)
 * shows up on the Evaluation Runs page while it is still running, and its
 * row fills with the verdict counts once the CLI finalizes it.
 *
 * Real everything: the real CLI bundle spawned from a temp project (a REST
 * agent stub answering slowly so the run is observably in flight), the real
 * backend this Playwright run points at (file-storage test server), the real
 * page polling (every 5 s). No mocking.
 */

import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { createServer, type Server } from 'http';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { test, expect } from './fixtures/test-fixtures';

const REPO_ROOT = process.cwd(); // playwright runs from the repo root (playwright.config.ts)
const CLI_BUNDLE = path.join(REPO_ROOT, 'cli', 'dist', 'index.js');
const STAMP = Date.now();
const AGENT_KEY = `e2e-cli-agent-${STAMP}`;
const AGENT_NAME = `E2E CLI Agent ${STAMP}`;
const BENCHMARK_NAME = `E2E CLI benchmark ${STAMP}`;
const CASES = [1, 2, 3].map((i) => `e2e-cli-case-${i}-${STAMP}`);

let stub: Server;
let project: string;
let cli: ChildProcess | undefined;
let cliOutput = '';
let cliExit: Promise<number | null>;

test.describe('Evaluation Runs page — a CLI-started run appears while running and fills when done (#612)', () => {
  test.beforeAll(async () => {
    if (!existsSync(CLI_BUNDLE)) {
      const b = spawnSync('npm', ['run', 'build:cli'], { cwd: REPO_ROOT, encoding: 'utf-8' });
      if (b.status !== 0) throw new Error(`build:cli failed: ${b.stderr}`);
    }
    // REST agent stub: answers after 4 s so three sequential cases take ~12 s.
    stub = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ response: 'answer from the e2e stub' }));
      }, 4000));
    });
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', () => r()));
    const endpoint = `http://127.0.0.1:${(stub.address() as { port: number }).port}/ask`;

    project = mkdtempSync(path.join(tmpdir(), 'ah-e2e-cli-run-'));
    mkdirSync(path.join(project, 'cases'));
    writeFileSync(path.join(project, 'agent-health.config.mjs'), `export default {
  agents: [{ key: ${JSON.stringify(AGENT_KEY)}, name: ${JSON.stringify(AGENT_NAME)}, connectorType: 'rest', endpoint: ${JSON.stringify(endpoint)}, useTraces: false }],
};
`);
    writeFileSync(path.join(project, 'cases', 'cases.json'), JSON.stringify(CASES.map((name, i) => ({
      name, category: 'General', difficulty: 'Easy', initialPrompt: `question ${i + 1}`, expectedOutcomes: ['answers'],
    }))));
  });

  test.afterAll(async () => {
    if (cli?.pid && cli.exitCode === null) { try { cli.kill('SIGKILL'); } catch { /* gone */ } }
    if (stub) await new Promise<void>((r) => { stub.closeAllConnections?.(); stub.close(() => r()); });
    if (project) rmSync(project, { recursive: true, force: true });
  });

  test('the run row shows Running within the page poll, then 3 / 0 / 3 once the CLI has finalized', async ({ page, request, testData, baseURL }) => {
    const backendPort = new URL(baseURL!).port === String(process.env.AH_DEV_PORT || '4000')
      ? (process.env.AH_PORT || process.env.AGENT_HEALTH_PORT || '4001')
      : new URL(baseURL!).port;

    await page.goto('/evaluations/runs');
    await page.click('[data-testid="viewmode-flat"]');

    // Start the CLI exactly as a user would, from its own project directory.
    const env: Record<string, string> = {
      PATH: process.env.PATH!, HOME: process.env.HOME!, ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
      AH_PORT: backendPort, AH_REUSE_FOREIGN_SERVER: '1', AH_SUPPRESS_EXPERIMENTAL: '1', AH_QUIET_DEPRECATIONS: '1', NO_COLOR: '1',
      AWS_EC2_METADATA_DISABLED: 'true',
    };
    const startedAt = Date.now();
    cli = spawn(process.execPath, [CLI_BUNDLE, 'benchmark', '-d', './cases', '-a', AGENT_KEY, '--judge-model', 'demo-model', '-n', BENCHMARK_NAME], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
    cli.stdout!.on('data', (c) => { cliOutput += c; });
    cli.stderr!.on('data', (c) => { cliOutput += c; });
    cliExit = new Promise((resolve) => cli!.on('exit', (code) => resolve(code)));

    // The run appears on the page while the CLI is still executing (the page polls every 5 s).
    // The server's config does not know this agent, so the row shows the key.
    const row = page.locator('[data-testid="run-row"]', { hasText: AGENT_KEY }).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    const appearedAfterMs = Date.now() - startedAt;
    await expect(row.locator('[data-testid="run-row-status-running"]')).toBeVisible({ timeout: 5_000 });

    // Track everything for cleanup now that the run exists.
    const list = await (await request.get(`/api/storage/evaluation-runs?agentKey=${encodeURIComponent(AGENT_KEY)}&size=10`)).json();
    const run = list.evaluationRuns[0];
    expect(run).toBeTruthy();
    expect(run.executor.kind).toBe('cli');
    expect(run.trigger).toBe('cli');
    testData.evaluationRun(run.id);
    if (run.benchmarkId) testData.benchmark(run.benchmarkId);
    for (const s of run.testCaseSnapshots ?? []) testData.testCase(s.id);

    // The CLI finalizes; the row fills: 3 passed / 0 failed / 3 total, no Running badge, no "not run".
    const code = await cliExit;
    expect(code, cliOutput).toBe(0);
    expect(cliOutput).toMatch(/Evaluation run completed \(3\/3 test cases\)/);
    const done = await (await request.get(`/api/storage/evaluation-runs/${run.id}`)).json();
    const doc = done.evaluationRun ?? done;
    for (const r of Object.values(doc.results ?? {}) as any[]) if (r.reportId) testData.run(r.reportId);
    expect(doc.status).toBe('completed');

    await expect(row.locator('[data-testid="run-row-status-running"]')).toHaveCount(0, { timeout: 15_000 });
    const counts = row.locator('td').nth(-3);
    await expect(counts).toContainText('3');
    await expect(counts.locator('.text-green-500')).toHaveText('3');
    await expect(counts.locator('.text-red-500')).toHaveText('0');
    await expect(row.locator('[data-testid="run-row-not-run"]')).toHaveCount(0);
    await expect(row.locator('[data-testid="run-row-errored-badge"]')).toHaveCount(0);

    // Appeared within one poll period plus CLI start-up.
    expect(appearedAfterMs).toBeLessThan(15_000);
  });
});
