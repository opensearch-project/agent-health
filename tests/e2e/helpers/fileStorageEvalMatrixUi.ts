/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * E6 of the file-storage eval matrix, rendered: a run the REAL CLI started
 * (`agent-health benchmark -f ./evals/retrieval.eval.ts …`, which auto-starts
 * the project's server on FILE storage) is viewed and RE-RUN in the UI —
 * run inspector telemetry strip, the case's Traces tab, the Re-run dialog
 * with a real `POST …/rerun` executed by the server — with the agent's spans
 * read from ONE observability source (OpenSearch or CloudWatch). Shared by
 * tests/e2e/file-storage-eval-matrix-{opensearch,cloudwatch}.spec.ts.
 *
 * Nothing is mocked in the browser: `/api/traces`, `/api/metrics/batch` and
 * `/api/storage/evaluation-runs/:id/rerun` are answered by the real server
 * from real spans. The spec talks to its own server by absolute URL (the
 * shared e2e backend has no observability source) and cleans up exactly what
 * it started (the adopted server PID, the peers, the span index, the project).
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/test-fixtures';
import { withCliCoverage } from '../../helpers/cliCoverage';
import {
  createFileStorageEvalProject,
  httpJson,
  CLI_BUNDLE,
  DEMO_AGENT_KEY,
  DEMO_AGENT_SERVICE_NAME,
  EVAL_FILE_RELATIVE,
  MATRIX_CASES,
  MATRIX_CASE_COUNT,
  MOCK_JUDGE_MODEL,
  type FileStorageEvalProject,
  type ObservabilitySource,
} from '../../helpers/fileStorageEvalProject';
import { DEMO_AGENT_SPANS, DEMO_AGENT_TOKENS, DEMO_AGENT_TOOL } from '../../helpers/demoRetrievalAgentStub';

const TOTAL_TOKENS = DEMO_AGENT_TOKENS.input + DEMO_AGENT_TOKENS.output; // 4 050 per traced case
const TRACED = 5; // 6 cases, one is an agent outage with no spans
const SLACK_MS = 60_000; // RunDetailsContent's window slack
const RUN_URL = /\/evaluations\/benchmarks\/(bench-[A-Za-z0-9-]+)\/runs\/((?:eval-)?run-[A-Za-z0-9-]+)/;

/** The exact `/api/traces` request the run inspector sends for a report (components/RunDetailsContent.tsx, fetchTracesForReport). */
function inspectorTracesRequest(report: any) {
  const endedAt = Date.parse(report.timestamp);
  const durationMs = report.performanceMetrics?.durationMs ?? 0;
  const lookbackMs = durationMs > 0 ? durationMs + SLACK_MS : 30 * 60_000;
  return { size: 1000, runIds: [report.runId], agents: [{ serviceName: DEMO_AGENT_SERVICE_NAME, startedAt: endedAt - lookbackMs, endedAt: endedAt + SLACK_MS, sessionId: report.sessionId }] };
}

/** When set, screenshots of the rendered pages land here (proof pack); never in CI. */
const SHOTS_DIR = process.env.AH_E2E_SHOTS_DIR || '';
async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS_DIR) return;
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.mouse.move(1200, 600); // let the hover-open sidebar collapse
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(SHOTS_DIR, `${name}.png`) });
}

function runCli(project: FileStorageEvalProject, args: string[], timeoutMs = 150_000) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [project.cli, ...args], { cwd: project.dir, env: withCliCoverage(project.env), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ status: signal ? null : code, stdout: stdout.replace(/\u001b\[[0-9;]*m/g, ''), stderr }); });
  });
}

async function loadRun(baseUrl: string, runId: string) {
  const doc = await httpJson(`${baseUrl}/api/storage/evaluation-runs/${encodeURIComponent(runId)}`);
  const run = doc.body.evaluationRun ?? doc.body;
  const reportByCase = new Map<string, any>();
  for (const [tcId, result] of Object.entries<any>(run.results ?? {})) {
    const name = (run.testCaseSnapshots ?? []).find((s: any) => s.id === tcId)?.name;
    if (!result.reportId || !name) continue;
    const rep = await httpJson(`${baseUrl}/api/storage/runs/${encodeURIComponent(result.reportId)}`);
    reportByCase.set(name, rep.body.report ?? rep.body.run ?? rep.body);
  }
  return { run, reportByCase };
}

async function waitForTerminal(baseUrl: string, runId: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let last: any;
  while (Date.now() < deadline) {
    const doc = await httpJson(`${baseUrl}/api/storage/evaluation-runs/${encodeURIComponent(runId)}`);
    last = doc.body.evaluationRun ?? doc.body;
    if (['completed', 'failed', 'cancelled'].includes(last?.status)) return last;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`run ${runId} not terminal within ${timeoutMs} ms (last status ${last?.status})`);
}

export function describeFileStorageEvalMatrixUi(label: string, options: { source: ObservabilitySource; openSearchEndpoint?: string }): void {
  const { source } = options;

  test.describe(label, () => {
    // One worker, one server, one CLI run: every test reads the same project.
    test.describe.configure({ mode: 'serial' });
    let project: FileStorageEvalProject;
    let benchmarkId: string;
    let evalRunId: string;
    let reportByCase: Map<string, any>;

    test.beforeAll(async () => {
      test.setTimeout(300_000); // staging + the CLI run (auto-starts the server) ≤ 150 s; the default hook budget is 30 s
      // Fail, never skip: a missing build must not turn this coverage into a green no-op.
      if (!existsSync(CLI_BUNDLE)) throw new Error(`${CLI_BUNDLE} missing — run npm run build:all`);
      project = await createFileStorageEvalProject({ source, prefix: `e2e-matrix-${source}`, openSearchEndpoint: options.openSearchEndpoint });

      // E1 through the real CLI: nothing listens on AH_PORT → the CLI auto-starts the project's server and leaves it running.
      const cli = await runCli(project, ['benchmark', '-f', `./${EVAL_FILE_RELATIVE}`, '-a', DEMO_AGENT_KEY, '-n', `Retrieval evals (${source}, e2e)`, '--judge-model', MOCK_JUDGE_MODEL]);
      const m = RUN_URL.exec(cli.stdout);
      if (!m) throw new Error(`CLI did not print a run URL (exit ${cli.status}):\n${cli.stdout}\n${cli.stderr}`);
      [, benchmarkId, evalRunId] = m;
      await project.adoptServer();
      ({ reportByCase } = await loadRun(project.baseUrl, evalRunId));
      expect(reportByCase.size).toBe(MATRIX_CASE_COUNT);
      // File-adapter shape, the one #640 is about.
      expect(reportByCase.get(MATRIX_CASES.ok.name).createdAt).toBeUndefined();
      expect(typeof reportByCase.get(MATRIX_CASES.ok.name).timestamp).toBe('string');
    });

    test.afterAll(async () => {
      await project?.cleanup(); // kills only the adopted server PID; the project dir (file storage) and the span index go with it
    });

    test(`the CLI-created run in the inspector: metrics strip reads every traced case from ${source}; the case's Traces tab renders the span tree`, async ({ page }) => {
      const ok = reportByCase.get(MATRIX_CASES.ok.name);
      const traceRequests: any[] = [];
      page.on('request', (req) => {
        if (req.url().endsWith('/api/traces') && req.method() === 'POST') traceRequests.push(JSON.parse(req.postData() || '{}'));
      });

      await page.goto(`${project.baseUrl}/evaluations/benchmarks/${benchmarkId}/runs/${evalRunId}/inspect?reportId=${ok.id}`);

      // Run-level telemetry: tokens / cost / LLM calls / tool calls / spans N/M — never "Metrics unavailable".
      const strip = page.getByTestId('run-telemetry-strip');
      await expect(strip).toHaveAttribute('data-state', 'value', { timeout: 30_000 });
      await expect(page.getByTestId('strip-tokens')).toHaveAttribute('title', `${(TRACED * TOTAL_TOKENS).toLocaleString()} tokens`);
      await expect(page.getByTestId('strip-spans')).toContainText(`spans: ${TRACED}/${MATRIX_CASE_COUNT} cases`);
      await expect(page.getByTestId('strip-spans')).not.toHaveAttribute('title', 'Metrics unavailable');
      await expect(page.getByTestId('inspector-status-badge')).toHaveText('PASSED', { timeout: 30_000 });

      // The case's Traces tab: spans by the run's exact ids. The badge must equal what the server answers for the
      // inspector's own request (≥ this case's 4 spans; siblings of the same agent in the window ride along).
      const expected = await httpJson(`${project.baseUrl}/api/traces`, { method: 'POST', body: inspectorTracesRequest(ok) });
      expect(expected.body.backend).toBe(source);
      expect(expected.body.total).toBeGreaterThanOrEqual(DEMO_AGENT_SPANS.normal);
      const ownRoots = expected.body.spans.filter((s: any) => s.name === 'POST /invoke').length;
      await page.getByRole('tab', { name: /^Traces/ }).click();
      await expect(page.getByRole('tab', { name: /^Traces/ })).toHaveText(`Traces${expected.body.total}`, { timeout: 30_000 });
      await expect(page.getByText('No traces available')).toHaveCount(0);
      await expect(page.getByText('No traces found')).toHaveCount(0);
      // The default Timeline view draws on a canvas; the Trace Tree view renders span names as text.
      await page.getByRole('button', { name: 'Trace Tree' }).click();
      await expect(page.getByText('POST /invoke')).toHaveCount(ownRoots);
      await expect(page.getByText(`execute_tool ${DEMO_AGENT_TOOL}`).first()).toBeVisible();
      await expect(page.getByText(/^chat demo-provider\.demo-model-v1$/).first()).toBeVisible();
      await shot(page, `inspector-traces-${source}`);

      // The request the inspector sent carries the exact ids and a window built around the RUN (file storage: from `timestamp`).
      expect(traceRequests.length).toBeGreaterThanOrEqual(1);
      expect(traceRequests[0].runIds).toEqual([ok.runId]);
      expect(traceRequests[0].agents?.[0]?.sessionId).toBe(ok.sessionId);
      expect(traceRequests[0].agents?.[0]?.endedAt).toBe(Date.parse(ok.timestamp) + SLACK_MS);
    });

    test('verdict rendering: the errored case is AGENT ERROR (not FAILED), the soft case FAILED with every check listed, the tool-error case PASSED with per-case tokens (#599)', async ({ page }) => {
      const outage = reportByCase.get(MATRIX_CASES.outage.name);
      await page.goto(`${project.baseUrl}/evaluations/benchmarks/${benchmarkId}/runs/${evalRunId}/inspect?reportId=${outage.id}`);
      await expect(page.getByTestId('inspector-status-badge')).toHaveText('AGENT ERROR', { timeout: 30_000 });
      await expect(page.getByTestId('inspector-status-badge')).toHaveAttribute('data-stage', 'agent');

      const soft = reportByCase.get(MATRIX_CASES.soft.name);
      await page.goto(`${project.baseUrl}/evaluations/benchmarks/${benchmarkId}/runs/${evalRunId}/inspect?reportId=${soft.id}`);
      await expect(page.getByTestId('inspector-status-badge')).toHaveText('FAILED', { timeout: 30_000 });
      // The TL;DR counts every check (the two soft ones AND the hard one that still ran); the Judge Evaluation tab lists them.
      await expect(page.getByText(/1 of 3 checks failed/).first()).toBeVisible({ timeout: 15_000 });
      await page.getByRole('tab', { name: /^Judge Evaluation/ }).click();
      await expect(page.getByTestId('checks-heading')).toContainText('(2/3 passed, 1 failed)', { timeout: 15_000 });
      const checks = page.getByTestId('check-title');
      await expect(checks).toHaveCount(3);
      await expect(checks.filter({ hasText: "to include 'purchase order'" })).toHaveCount(1);
      await expect(checks.filter({ hasText: "to include 'Billing FAQ'" })).toHaveCount(1);
      await expect(checks.filter({ hasText: /completed within/i })).toHaveCount(1);
      await expect(page.getByText('mentions purchase orders: expected').first()).toBeVisible(); // the soft check's own message, on its error line
      await expect(page.getByTestId('sdk-judge-none')).toBeVisible();
      await shot(page, `inspector-soft-${source}`);

      const toolError = reportByCase.get(MATRIX_CASES.toolError.name);
      await page.goto(`${project.baseUrl}/runs/${toolError.id}`);
      // The report page shows the per-case trace metrics (GET /api/metrics/:runId): 4 050 tokens → "4.0K"/"4.1K", never "—".
      await expect(page.getByText('Total Tokens', { exact: true }).locator('..')).toHaveText(/^Total Tokens4\.[01]K$/, { timeout: 30_000 });
      await expect(page.getByText('LLM Calls', { exact: true }).locator('..')).toHaveText(/^LLM Calls2$/);
      await page.getByRole('tab', { name: /^Traces/ }).click();
      const expected = await httpJson(`${project.baseUrl}/api/traces`, { method: 'POST', body: inspectorTracesRequest(toolError) });
      expect(expected.body.total).toBeGreaterThanOrEqual(DEMO_AGENT_SPANS.withToolError);
      await expect(page.getByRole('tab', { name: /^Traces/ })).toHaveText(`Traces${expected.body.total}`, { timeout: 30_000 });
    });

    test('Re-run from the report page: the dialog is prefilled from the CLI run, the real POST creates a run the server executes, and the new run has its own traces', async ({ page }) => {
      const invocationsBefore = project.agent.invocations.length;
      await page.goto(`${project.baseUrl}/evaluations/runs/${evalRunId}`);
      await page.waitForSelector('[data-testid="sidebar"]', { timeout: 30_000 });
      await page.locator(`[data-testid="run-actions-menu-trigger-${evalRunId}"]`).click();
      await page.locator(`[data-testid="run-action-rerun-${evalRunId}"]`).click();
      const dialog = page.locator('[data-testid="run-config-dialog"]');
      await expect(dialog).toBeVisible({ timeout: 10_000 });
      await expect(page.locator('[data-testid="run-config-name-input"]')).toHaveValue(/\(re-run\)$/);
      await expect(dialog).toContainText('Demo Retrieval Agent');
      await expect(dialog).toContainText('Demo Model'); // the mock judge the CLI run was started with (--judge-model demo-model)
      await shot(page, `rerun-dialog-${source}`);

      const rerunResponse = page.waitForResponse((r) => r.url().endsWith(`/api/storage/evaluation-runs/${evalRunId}/rerun`) && r.request().method() === 'POST');
      await page.locator('[data-testid="run-config-submit-btn"]').click();
      const res = await rerunResponse;
      expect(res.status()).toBe(201);
      const { runId: newRunId } = await res.json();
      expect(newRunId).toBeTruthy();
      expect(newRunId).not.toBe(evalRunId);
      await expect(page).toHaveURL(new RegExp(`/evaluations/runs/${newRunId}$`), { timeout: 15_000 });

      // The server executed the re-run: the agent was called 6 more times; the run is terminal with the same verdict split.
      const rerun = await waitForTerminal(project.baseUrl, newRunId, 120_000);
      expect(rerun.status).toBe('completed');
      expect(rerun.rerunOf).toBe(evalRunId);
      expect(project.agent.invocations.length).toBe(invocationsBefore + MATRIX_CASE_COUNT);
      const { reportByCase: rerunReports } = await loadRun(project.baseUrl, newRunId);
      expect(rerunReports.get(MATRIX_CASES.ok.name)).toMatchObject({ passFailStatus: 'passed' });
      expect(rerunReports.get(MATRIX_CASES.judged.name)).toMatchObject({ passFailStatus: 'passed', judgeProvider: 'demo' });
      expect(rerunReports.get(MATRIX_CASES.soft.name)).toMatchObject({ passFailStatus: 'failed' });
      expect(rerunReports.get(MATRIX_CASES.outage.name).failureStage).toBe('agent');
      // Fresh traces: new ids, and the source's span count in the observability source doubled (minus the outage).
      const rerunOk = rerunReports.get(MATRIX_CASES.ok.name);
      expect(rerunOk.traceId).not.toBe(reportByCase.get(MATRIX_CASES.ok.name).traceId);
      expect(rerunOk.spans).toHaveLength(DEMO_AGENT_SPANS.normal);
      expect(project.sink.size()).toBe(2 * (4 * DEMO_AGENT_SPANS.normal + DEMO_AGENT_SPANS.withToolError));

      // …and the UI shows the re-run as such: provenance chip, the same verdict split, and in its inspector its own metrics from its own spans.
      await page.reload();
      const chip = page.locator('[data-testid="rerun-provenance-chip"]');
      await expect(chip).toBeVisible({ timeout: 30_000 });
      await expect(chip).toContainText('re-run of');
      await expect(page.getByText('Passed', { exact: true }).locator('..')).toContainText('3');
      await expect(page.getByText('Errored', { exact: true }).locator('..')).toContainText('1');
      await shot(page, `rerun-report-${source}`);
      await page.goto(`${project.baseUrl}/evaluations/benchmarks/${rerun.benchmarkId ?? benchmarkId}/runs/${newRunId}/inspect?reportId=${rerunOk.id}`);
      await expect(page.getByTestId('run-telemetry-strip')).toHaveAttribute('data-state', 'value', { timeout: 30_000 });
      await expect(page.getByTestId('strip-spans')).toContainText(`spans: ${TRACED}/${MATRIX_CASE_COUNT} cases`);
      await expect(page.getByTestId('strip-tokens')).toHaveAttribute('title', `${(TRACED * TOTAL_TOKENS).toLocaleString()} tokens`);
      await page.getByRole('tab', { name: /^Traces/ }).click();
      await expect(page.getByText('No traces available')).toHaveCount(0);
      await expect(page.getByText('No traces found')).toHaveCount(0);
      await shot(page, `rerun-inspector-${source}`);

      const byTrace = await httpJson(`${project.baseUrl}/api/traces`, { method: 'POST', body: { size: 1000, traceId: rerunOk.traceId } });
      expect(byTrace.body.total).toBe(DEMO_AGENT_SPANS.normal);
    });
  });
}
